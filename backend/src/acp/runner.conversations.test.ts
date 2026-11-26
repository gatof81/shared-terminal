/**
 * acp/runner.conversations.test.ts — the REAL runner (acp-runtime/runner.mjs)
 * driving the deterministic test adapter (acp-runtime/test-agent.mjs) against
 * the REAL /api/acp router on an in-memory SQLite (D1 is SQLite), with no
 * Docker: two runner processes on the host, their state in a temp dir.
 *
 * What it pins (B2, v27): slot 1 keeps one ACP session per conversation —
 * resumed on demand, its own count when alternating —, opens nothing at
 * start, never closes a session with an open task (the next conversation
 * waits), a message to an agent busy in another topic waits `pending` and
 * runs after, and after a restart the interrupted message is reported on in
 * its own conversation's session. And two defects of the runner (#757): a
 * prompt refused because the adapter lost the session (-32002) goes back to
 * pending and runs after a reopen; a `turn` task the adapter opens with no
 * message running holds nothing and is dropped when the slot changes session.
 * And the shared skills (4A): installed into ~/.claude/skills at start
 * without touching another skill, reported in /agents; a resumed session
 * whose file names another protocol gets the current one once.
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import type http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { DatabaseSync } = createRequire(import.meta.url)(
	"node:sqlite",
) as typeof import("node:sqlite");

vi.mock("../auth.js", async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return {
		...real,
		requireAuth: (
			req: { headers: Record<string, string | undefined>; userId?: string },
			res: { status: (n: number) => { json: (b: unknown) => void } },
			next: () => void,
		) => {
			const u = req.headers["x-test-user"];
			if (!u) return void res.status(401).json({ error: "unauthenticated" });
			req.userId = u;
			next();
		},
	};
});

const RUNTIME = path.resolve(__dirname, "../../../acp-runtime");
const OWNER = "u-owner";
const PID = "p-r";
const realFetch = globalThis.fetch;
let db: DatabaseSyncT;
let server: http.Server;
let url = "";
let tmp = "";
const tokens: Record<string, string> = {};
const runners = new Map<string, ChildProcess>();
const logs = new Map<string, string>();

function run(sql: string, params: unknown[]) {
	try {
		const st = db.prepare(sql);
		const bind = params.map((p) => (typeof p === "boolean" ? Number(p) : p)) as Array<
			string | number | null
		>;
		if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql))
			return {
				success: true,
				errors: [],
				result: [{ results: st.all(...bind), success: true, meta: {} }],
			};
		const info = st.run(...bind);
		return {
			success: true,
			errors: [],
			result: [{ results: [], success: true, meta: { changes: Number(info.changes) } }],
		};
	} catch (err) {
		return { success: false, errors: [{ message: (err as Error).message }], result: [] };
	}
}

const stateOf = (name: string) => path.join(tmp, name, "state");

/** One agent's slot-1 runner, as `ensureRunner` launches it (without the restart loop). */
function startRunner(name: string, slot = 1, home = path.join(tmp, name, "home")) {
	const ws = path.join(tmp, name, "workspace");
	const argv = [
		"--no-warnings",
		path.join(RUNTIME, "runner.mjs"),
		...(slot === 1 ? [] : [String(slot)]),
	];
	const p = spawn(process.execPath, argv, {
		env: {
			...process.env,
			HOME: home,
			ST_URL: url,
			ST_TOKEN: tokens[name],
			ST_AGENT: name,
			ACP_AGENT_CMD: path.join(tmp, "agent"),
			AGENT_CWD: ws,
			RUNNER_STATE: stateOf(name),
			PATH: `${path.join(RUNTIME, "bin")}:${process.env.PATH}`,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const keep = (b: Buffer) => logs.set(name, (logs.get(name) ?? "") + b.toString());
	p.stdout?.on("data", keep);
	p.stderr?.on("data", keep);
	runners.set(slot === 1 ? name : `${name}#${slot}`, p);
	return p;
}

async function call(method: string, p: string, body?: unknown) {
	const res = await realFetch(`${url}/api/acp${p}`, {
		method,
		headers: { "content-type": "application/json", "x-test-user": OWNER },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await res.text();
	return { status: res.status, body: text ? JSON.parse(text) : null };
}
type Msg = import("./agents.js").MessageRow;
const msg = (id: number) =>
	db.prepare("SELECT * FROM agent_messages WHERE id = ?").get(id) as unknown as Msg;
async function until<T>(
	what: string,
	fn: () => T | null | undefined | false,
	ms = 30_000,
): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = fn();
		if (v) return v;
		if (Date.now() > end)
			throw new Error(`timed out waiting for ${what}\n${[...logs.values()].join("\n")}`);
		await new Promise((ok) => setTimeout(ok, 200));
	}
}
const settled = (id: number, ms?: number) =>
	until(
		`#${id} settled`,
		() => {
			const m = msg(id);
			return ["done", "failed", "uncertain"].includes(m.state) ? m : null;
		},
		ms,
	);
// The LAST one: a reply's answer quotes the other agent's, count included.
const count = (m: Msg) =>
	Number([...(m.result_text ?? "").matchAll(/sesión ACP: (\d+)/g)].at(-1)?.[1] ?? Number.NaN);
const post = async (to: string, body: string, conversationId: string) =>
	(await call("POST", "/messages", { to, body, conversationId })).body as Msg;

let A = "";
let B = "";

beforeAll(async () => {
	vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
	vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
	vi.stubEnv("D1_DATABASE_ID", "dbid");
	vi.stubEnv("SECRETS_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
	db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys = ON");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (u: string | URL, init?: RequestInit) => {
			if (!String(u).includes("/d1/database/")) return realFetch(u, init);
			const body = JSON.parse(String(init?.body)) as
				| { sql: string; params?: unknown[] }
				| Array<{ sql: string; params?: unknown[] }>;
			if (Array.isArray(body)) {
				const results = body.map((b) => run(b.sql, b.params ?? []));
				const bad = results.find((r) => !r.success);
				return new Response(
					JSON.stringify(
						bad ?? { success: true, errors: [], result: results.flatMap((r) => r.result) },
					),
				);
			}
			return new Response(JSON.stringify(run(body.sql, body.params ?? [])));
		}),
	);
	const { migrateDb } = await import("../db.js");
	await migrateDb();
	db.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, 'owner', 'x')").run(OWNER);
	db.prepare(
		"INSERT INTO projects (project_id, owner_user_id, name, client_request_id, request_hash) VALUES (?, ?, 'Runner', 'c-r', 'h')",
	).run(PID, OWNER);
	const { AcpAgents, acpConfigFromEnv } = await import("./agents.js");
	const { AcpWorks } = await import("./works.js");
	const { buildAcpRouter } = await import("../routes/acp.js");
	const acp = new AcpAgents(acpConfigFromEnv("/nonexistent", 3001), {} as never);
	tmp = mkdtempSync(path.join(tmpdir(), "st-runner-conv-"));
	writeFileSync(
		path.join(tmp, "agent"),
		`#!/bin/sh\nexec "${process.execPath}" "${path.join(RUNTIME, "test-agent.mjs")}" "$@"\n`,
		{ mode: 0o755 },
	);
	for (const [i, name] of ["rc", "rd"].entries()) {
		const sid = `b0000000-0000-4000-8000-00000000000${i}`;
		db.prepare(
			"INSERT INTO sessions (session_id, user_id, name, container_name, status) VALUES (?, ?, ?, ?, 'running')",
		).run(sid, OWNER, name, `st-${sid.slice(0, 12)}`);
		const a = await acp.create(sid, OWNER, name, { projectId: PID, runtime: "st-test-agent" });
		tokens[name] = acp.tokenFor(a.agent_id);
	}
	const app = express();
	app.use("/api/acp", buildAcpRouter(acp, new AcpWorks(acp.config, {} as never)));
	server = app.listen(0, "127.0.0.1");
	await new Promise((ok) => server.once("listening", ok));
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const conv = async (n: number, title: string) =>
		(
			await call("POST", "/conversations", {
				projectId: PID,
				title,
				clientRequestId: `d0000000-0000-4000-8000-00000000000${n}`,
			})
		).body.id as string;
	A = await conv(1, "Tema A");
	B = await conv(2, "Tema B");
	// rc's ~/.claude/skills before its runner: a skill of its own (never
	// touched) and one a
	// previous runner installed that left the package (removed).
	const skills = path.join(tmp, "rc", "home", ".claude", "skills");
	mkdirSync(path.join(skills, "propia"), { recursive: true });
	writeFileSync(path.join(skills, "propia", "SKILL.md"), "mía\n");
	mkdirSync(path.join(skills, "retirada"), { recursive: true });
	writeFileSync(path.join(skills, "retirada", "SKILL.md"), "vieja\n");
	writeFileSync(path.join(skills, "retirada", ".st-managed"), "");
	startRunner("rc");
	startRunner("rd");
}, 30_000);

afterAll(async () => {
	for (const p of runners.values()) p.kill("SIGKILL");
	// The adapters die with their stdin; give them a moment before the dir goes.
	await new Promise((ok) => setTimeout(ok, 300));
	server?.close();
	rmSync(tmp, { recursive: true, force: true });
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("runner slot 1: one ACP session per conversation (B2)", () => {
	it("opens nothing at start; alternating two conversations, each keeps its own session and count", async () => {
		// Started and idle: no session file yet (nothing opened just to be closed).
		await until("runner rc claiming", () => (logs.get("rc") ?? "").includes("starting slot 1"));
		await new Promise((ok) => setTimeout(ok, 1_500));
		expect(existsSync(path.join(stateOf("rc"), "session.json"))).toBe(false);
		const a1 = await settled((await post("rc", "uno", A)).id);
		const b1 = await settled((await post("rc", "uno", B)).id);
		const a2 = await settled((await post("rc", "dos", A)).id);
		const b2 = await settled((await post("rc", "dos", B)).id);
		expect([a1, b1, a2, b2].map((m) => m.state)).toEqual(["done", "done", "done", "done"]);
		expect([count(a1), count(b1), count(a2), count(b2)]).toEqual([1, 1, 2, 2]);
		expect(readdirSync(path.join(stateOf("rc"), "conv")).sort()).toEqual(
			[`${A}.json`, `${B}.json`].sort(),
		);
		expect(existsSync(path.join(stateOf("rc"), "session.json"))).toBe(false);
	}, 60_000);

	it("a message to an agent busy in another conversation waits pending and runs after", async () => {
		const busy = await post("rc", "esperá 3", A);
		await until("busy running", () => msg(busy.id).state === "running");
		const next = await post("rc", "después", B);
		await new Promise((ok) => setTimeout(ok, 1_000));
		expect(msg(next.id).state).toBe("pending");
		const agents = (await call("GET", "/agents")).body as Array<Record<string, unknown>>;
		expect(agents.find((a) => a.name === "rc")).toMatchObject({
			runningIn: [{ id: busy.id, conversationId: A }],
			queue: [{ id: next.id, conversationId: B }],
		});
		const [d1, d2] = [await settled(busy.id), await settled(next.id)];
		expect(d2.started_at && d1.finished_at && d2.started_at >= d1.finished_at).toBe(true);
		expect(count(d2)).toBe(3); // B's third, in B's session
	}, 60_000);

	it("never closes a session with an open task: the next conversation waits until it ends", async () => {
		const pers = await settled((await post("rc", "persistente 5: consultá a @rd: tarde", A)).id);
		expect(pers.state).toBe("done");
		const next = await post("rc", "tras el proceso", B);
		await new Promise((ok) => setTimeout(ok, 2_500));
		expect(msg(next.id).state).toBe("pending"); // A's session holds a live task
		// …and /agents says so: held in A by a process («proceso en curso»).
		const held = (await call("GET", "/agents")).body.find(
			(x: { name: string }) => x.name === "rc",
		).heldBy;
		expect(held).toMatchObject([{ conversationId: A, work: null }]);
		const d = await settled(next.id);
		expect(
			Date.parse(d.started_at as string) - Date.parse(pers.finished_at as string),
		).toBeGreaterThanOrEqual(4_000);
		expect(
			(await call("GET", "/agents")).body.find((x: { name: string }) => x.name === "rc").heldBy,
		).toEqual([]);
		// The process outlived its message: its st send was refused, nothing reached @rd.
		expect(
			db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE body = 'tarde'").get(),
		).toEqual({ n: 0 });
	}, 60_000);

	it("a consult and its reply stay in the conversation; the reply runs in that conversation's session", async () => {
		const m = await settled((await post("rc", "consultá a @rd: ¿hola?", B)).id);
		const consult = await until(
			"consult",
			() =>
				db
					.prepare(
						"SELECT * FROM agent_messages WHERE from_id = 'rc' AND to_id = 'rd' AND body = '¿hola?'",
					)
					.get() as Msg | undefined,
		);
		expect(consult.conversation_id).toBe(B);
		await settled(consult.id);
		const reply = await until(
			"reply",
			() =>
				db
					.prepare("SELECT * FROM agent_messages WHERE reply_to = ? AND kind = 'reply'")
					.get(consult.id) as Msg | undefined,
		);
		expect(reply.conversation_id).toBe(B);
		const r = await settled(reply.id);
		expect(count(r)).toBe(count(m) + 1);
	}, 60_000);

	it("after a runner restart the interrupted message is uncertain and its report runs in its conversation's session", async () => {
		const before = count(await settled((await post("rc", "antes", A)).id));
		const long = await post("rc", "esperá 30", A);
		await until("long running", () => msg(long.id).state === "running");
		await new Promise((ok) => setTimeout(ok, 500));
		runners.get("rc")?.kill("SIGKILL");
		await new Promise((ok) => setTimeout(ok, 500));
		startRunner("rc");
		const u = await settled(long.id);
		expect(u.state).toBe("uncertain");
		const report = await until(
			"report",
			() =>
				db.prepare("SELECT * FROM agent_messages WHERE recovery_of = ?").get(long.id) as
					| Msg
					| undefined,
		);
		expect(report).toMatchObject({ from_id: "system", conversation_id: A, project_id: PID });
		const r = await settled(report.id);
		// A's session: the interrupted prompt and the report both counted there.
		expect(count(r)).toBe(before + 2);
		expect(msg(long.id).attempts).toBe(1);
		const b = await settled((await post("rc", "sigo", B)).id);
		expect(count(b)).toBeGreaterThan(3);
	}, 90_000);
});

describe("runner: what the adapter does on its own (#757)", () => {
	it("a prompt refused because the adapter lost the session goes back to pending and runs after a reopen", async () => {
		const died = await settled((await post("rc", "morí", A)).id);
		expect(died.state).toBe("done");
		await new Promise((ok) => setTimeout(ok, 500)); // the session is gone from the adapter
		const next = await settled((await post("rc", "después de morir", A)).id);
		expect(next.state).toBe("done");
		expect(next.attempts).toBe(2); // refused once (nothing ran), then run in the resumed session
		expect(count(next)).toBe(count(died) + 1);
		expect(logs.get("rc")).toContain(`message #${next.id}: back to pending`);
	}, 60_000);

	it("refused again right after the reopen, the message is uncertain with the note", async () => {
		const flag = path.join(stateOf("rc"), "test-agent", "lose-sessions");
		mkdirSync(path.dirname(flag), { recursive: true });
		writeFileSync(flag, "");
		try {
			const m = await settled((await post("rc", "nunca corre", B)).id);
			expect(m.state).toBe("uncertain");
			expect(m.note).toContain("tampoco estaba tras reabrirla");
			expect(m.attempts).toBe(2);
		} finally {
			rmSync(flag);
		}
		expect((await settled((await post("rc", "vuelve", B)).id)).state).toBe("done");
	}, 60_000);

	it("a turn the adapter opens with no message running holds nothing: the next message, of another conversation, closes done", async () => {
		const first = await settled((await post("rc", "turno huérfano", A)).id);
		expect(first.state).toBe("done");
		await until("orphan turn", () =>
			/task turn-\S+ \(turn\) spawned — no current message/.test(logs.get("rc") ?? ""),
		);
		const next = await settled((await post("rc", "otro tema", B)).id, 15_000);
		expect(next.state).toBe("done");
		expect(logs.get("rc")).toMatch(/dropped task\(s\) with no message of the session left: turn-/);
		expect(
			(await call("GET", "/agents")).body.find((x: { name: string }) => x.name === "rc").heldBy,
		).toEqual([]);
	}, 60_000);
});

describe("runner: shared skills and the protocol of a resumed session (4A)", () => {
	const rcAgent = async () =>
		(await call("GET", "/agents")).body.find((x: { name: string }) => x.name === "rc") as {
			skills: { hash: string | null; names: string[]; error: string | null } | null;
		};

	it("installs only the packaged skills into ~/.claude/skills and reports their hash", async () => {
		const skills = path.join(tmp, "rc", "home", ".claude", "skills");
		// rc started (and reported) in beforeAll and has run messages since.
		const { skills: reported } = await rcAgent();
		expect(reported).toMatchObject({ names: ["coordinar"], error: null });
		expect(reported?.hash).toMatch(/^[0-9a-f]{12}$/);
		expect(readFileSync(path.join(skills, "coordinar", "SKILL.md"), "utf8")).toBe(
			readFileSync(path.join(RUNTIME, "skills", "coordinar", "SKILL.md"), "utf8"),
		);
		expect(readFileSync(path.join(skills, "propia", "SKILL.md"), "utf8")).toBe("mía\n");
		expect(existsSync(path.join(skills, "retirada"))).toBe(false);
	});

	it("a slot ≥ 2 installs and reports nothing (the slots share HOME and start together)", async () => {
		const before = (await rcAgent()).skills;
		const home = path.join(tmp, "rc-slot2-home");
		const p = startRunner("rc", 2, home);
		try {
			await until("slot 2 started", () => (logs.get("rc") ?? "").includes("starting slot 2"));
			await new Promise((ok) => setTimeout(ok, 1_000));
			expect(existsSync(path.join(home, ".claude", "skills"))).toBe(false);
			expect((await rcAgent()).skills).toEqual(before);
		} finally {
			p.kill("SIGKILL");
		}
	}, 30_000);

	it("a resumed session whose file names another protocol gets the current one once", async () => {
		const sessionFile = path.join(stateOf("rc"), "conv", `${A}.json`);
		const sessionInfo = () =>
			JSON.parse(readFileSync(sessionFile, "utf8")) as { sessionId: string; protocol?: string };
		const updates = () =>
			(
				JSON.parse(
					readFileSync(
						path.join(stateOf("rc"), "test-agent", `session-${sessionInfo().sessionId}.json`),
						"utf8",
					),
				) as { protocolUpdates?: number }
			).protocolUpdates ?? 0;
		// Every session opened by this runner was given its protocol.
		const current = sessionInfo().protocol;
		expect(current).toMatch(/^[0-9a-f]{12}$/);
		expect(updates()).toBe(0);
		// The slot is in B's session; A's file as a runner before 4A left it.
		expect((await settled((await post("rc", "en B", B)).id)).state).toBe("done");
		const { protocol: _, ...old } = sessionInfo();
		writeFileSync(sessionFile, JSON.stringify(old));
		const a = await settled((await post("rc", "en A", A)).id);
		expect(a.state).toBe("done");
		expect(a.result_text).toContain("en A"); // the update is not part of the message
		expect(updates()).toBe(1);
		expect(sessionInfo().protocol).toBe(current);
		// Given once: leaving and resuming again sends nothing more.
		await settled((await post("rc", "en B otra vez", B)).id);
		await settled((await post("rc", "en A otra vez", A)).id);
		expect(updates()).toBe(1);
	}, 60_000);
});
