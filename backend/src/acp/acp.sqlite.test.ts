/**
 * acp/acp.sqlite.test.ts — the ACP message API against a REAL SQLite (D1 is
 * SQLite): `fetch` to the D1 endpoint is answered by an in-memory database,
 * so the real migrations (v1…v25), the v25 reply trigger and indexes and the
 * real router run. Docker is a stub; the caller is `x-test-user` (person) or
 * a real `acp1.` agent token.
 *
 * What it pins: a message's scope (direct vs Project Chat) and who decides
 * it, the reply's correlation and scope, the agent → agent loop guard,
 * idempotent sends, and what each feed shows.
 */

import type http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { d1LimitViolations } from "../d1Limits.js";

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

let db: DatabaseSyncT;

// The agent containers, for works (acp/works.ts runs three fixed scripts in
// them): what is on disk per session — directories, old ACP sessions, branches
// — and how the next exec behaves. Recognised by what each script does.
type Disk = { dirs: Set<string>; sessions: Set<string>; branches: Set<string> };
const disks = new Map<string, Disk>();
const diskOf = (sid: string) => {
	let d = disks.get(sid);
	if (!d) {
		d = { dirs: new Set(), sessions: new Set(), branches: new Set() };
		disks.set(sid, d);
	}
	return d;
};
const fx = {
	running: true,
	freeKb: 50 * 1024 * 1024,
	repo: true,
	/** The worktree add: "ok", fails ("fail": nothing made), "throw" after making it, "cut" making nothing, "half" (branch only). */
	create: "ok" as "ok" | "fail" | "throw" | "cut" | "half",
	calls: [] as string[],
	/** What the cleaning script reports (its reason lines, or removed / absent). */
	clean: ["removed"] as string[],
};
const out = (s: string, exitCode = 0) => ({
	stdout: Buffer.from(s),
	stderr: Buffer.alloc(0),
	exitCode,
	truncated: false,
	timedOut: false,
});
const container = {
	runningContainerId: async (name: string) => (fx.running ? `cid-${name}` : null),
	execCapture: async (sid: string, cmd: string[]) => {
		const [script, , id, arg] = cmd.slice(2);
		const d = diskOf(sid);
		if (script.includes("free_kb")) {
			fx.calls.push(`preflight ${id} ${arg}`);
			if (!fx.repo) return out("not-a-repo\n");
			const lines = [`free_kb=${fx.freeKb}`];
			if (d.dirs.has(id)) lines.push("exists=directory");
			if (d.sessions.has(id)) lines.push("exists=session");
			if (d.branches.has(id)) lines.push("exists=branch");
			if (arg === "no-such-ref") lines.push(`bad-base=${arg}`);
			else
				lines.push(
					`base=${arg || "origin/main"}`,
					`sha=${arg === "v1" ? "1".repeat(40) : "b".repeat(40)}`,
				);
			return out(`${lines.join("\n")}\n`);
		}
		if (script.includes("worktree remove")) {
			fx.calls.push(`clean ${id} ${cmd[6]}`);
			const said = fx.clean;
			fx.clean = ["removed"];
			// "check" mode never removes, so it never says so.
			return out(`${said.filter((l) => cmd[6] === "remove" || l !== "removed").join("\n")}\n`);
		}
		if (script.includes("worktree add")) {
			fx.calls.push(`create ${id} ${arg}`);
			const mode = fx.create;
			fx.create = "ok";
			if (mode === "fail" || mode === "cut") {
				if (mode === "cut") throw new Error("exec stream cut");
				return out("", 6);
			}
			if (mode === "half") {
				d.branches.add(id);
				return out("", 6);
			}
			d.dirs.add(id);
			d.branches.add(id);
			if (mode === "throw") throw new Error("exec stream cut");
			return out("created\n");
		}
		fx.calls.push(`inspect ${id}`);
		if (d.dirs.has(id))
			return out(d.branches.has(id) ? `state=ok\nsha=${"b".repeat(40)}\n` : "state=other\n");
		return out(d.branches.has(id) ? "state=branch-only\n" : "state=none\n");
	},
};
const realFetch = globalThis.fetch;
/** While set, every single-statement SELECT or DELETE sent to D1 (its SQL and params). */
let captured: Array<{ sql: string; params: unknown[] }> | null = null;
/** The next statement matching it fails as a lost D1 call would (then it clears). */
let failOnce: RegExp | null = null;

const bindOf = (params: unknown[]) =>
	params.map((p) => (typeof p === "boolean" ? Number(p) : p)) as Array<string | number | null>;

function run(sql: string, params: unknown[]) {
	// What real D1 would refuse fails here too, whatever SQLite accepts.
	const overLimit = d1LimitViolations(sql, params.length);
	if (overLimit.length)
		return {
			success: false,
			errors: [{ code: 7500, message: `D1 limits: ${overLimit.join("; ")}` }],
			result: [],
		};
	try {
		const st = db.prepare(sql);
		const bind = bindOf(params);
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

const OWNER = "u-owner";
const OTHER = "u-other";
const SID = {
	arq: "11111111-1111-4111-8111-111111111111",
	dev: "22222222-2222-4222-8222-222222222222",
	solo: "33333333-3333-4333-8333-333333333333",
	alien: "44444444-4444-4444-8444-444444444444",
};
let base = "";
let server: http.Server;
let acp: import("./agents.js").AcpAgents;
const events: Array<{ owner: string; type: string; id?: number }> = [];
const tokens: Record<string, string> = {};

beforeAll(async () => {
	vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
	vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
	vi.stubEnv("D1_DATABASE_ID", "dbid");
	vi.stubEnv("SECRETS_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
	db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys = ON");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL, init?: RequestInit) => {
			if (!String(url).includes("/d1/database/")) return realFetch(url, init);
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
			if (captured && /^\s*(SELECT|DELETE)\b/i.test(body.sql))
				captured.push({ sql: body.sql, params: body.params ?? [] });
			if (failOnce?.test(body.sql)) {
				failOnce = null;
				return new Response("upstream lost", { status: 502 });
			}
			const answer = run(body.sql, body.params ?? []);
			return new Response(JSON.stringify(answer));
		}),
	);
	const { migrateDb } = await import("../db.js");
	await migrateDb();
	db.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, 'owner', 'x')").run(OWNER);
	db.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, 'other', 'x')").run(OTHER);
	for (const [k, sid] of Object.entries(SID))
		db.prepare(
			"INSERT INTO sessions (session_id, user_id, name, container_name, status) VALUES (?, ?, ?, ?, 'running')",
		).run(sid, k === "alien" ? OTHER : OWNER, k, `st-${sid.slice(0, 12)}`);
	for (const [pid, owner] of [
		["p-1", OWNER],
		["p-2", OWNER],
		["p-x", OTHER],
	])
		db.prepare(
			"INSERT INTO projects (project_id, owner_user_id, name, client_request_id, request_hash) VALUES (?, ?, ?, ?, 'h')",
		).run(pid, owner, `Proyecto ${pid}`, `c-${pid}`);

	const { AcpAgents, acpConfigFromEnv } = await import("./agents.js");
	const { buildAcpRouter } = await import("../routes/acp.js");
	acp = new AcpAgents({ ...acpConfigFromEnv("/nonexistent", 3001), maxDepth: 2 }, {} as never);
	const { AcpWorks } = await import("./works.js");
	const works = new AcpWorks(acp.config, container as never);
	acp.onEvent((owner, ev) =>
		events.push({ owner, type: ev.type, ...(ev.type === "message" ? { id: ev.message.id } : {}) }),
	);
	const arq = await acp.create(SID.arq, OWNER, "arquitecto", { projectId: "p-1" });
	const dev = await acp.create(SID.dev, OWNER, "developer", { projectId: "p-1" });
	const solo = await acp.create(SID.solo, OWNER, "solo");
	const alien = await acp.create(SID.alien, OTHER, "ajeno");
	for (const a of [arq, dev, solo, alien]) tokens[a.name] = acp.tokenFor(a.agent_id);
	const app = express();
	app.use("/api/acp", buildAcpRouter(acp, works));
	server = app.listen(0);
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/acp`;
});

afterAll(() => {
	server?.close();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

type Who = { user: string } | { agent: string };
async function call(who: Who, method: string, path: string, body?: unknown) {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if ("user" in who) headers["x-test-user"] = who.user;
	else headers.authorization = `Bearer ${tokens[who.agent]}`;
	const res = await realFetch(base + path, {
		method,
		headers,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await res.text();
	return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
const owner: Who = { user: OWNER };
const as = (agent: string): Who => ({ agent });
/** The real `st` CLI, as an agent runs it in its container. */
async function stCli(agent: string, ...args: string[]) {
	const { execFile } = await import("node:child_process");
	const bin = new URL("../../../acp-runtime/bin/st", import.meta.url).pathname;
	return new Promise<{ code: number; out: string; err: string }>((resolve) =>
		execFile(
			process.execPath,
			[bin, ...args],
			{
				env: {
					...process.env,
					ST_URL: base.replace(/\/api\/acp$/, ""),
					ST_TOKEN: tokens[agent],
					ST_AGENT: agent,
				},
			},
			(e, out, err) => resolve({ code: e ? Number(e.code ?? 1) : 0, out, err }),
		),
	);
}

/** Runs one message of `agent` to completion as its runner would. */
async function work(agent: string, text = "ok") {
	const c = await call(as(agent), "POST", "/runner/claim");
	expect(c.status).toBe(200);
	const r = await call(as(agent), "POST", `/runner/messages/${c.body.id}/result`, {
		state: "done",
		text,
	});
	expect(r.status).toBe(200);
	return c.body;
}

describe("ACP messages: scope, replies, loop guard (v22)", () => {
	it("v22 is recorded and the agents carry their project", async () => {
		const v = db.prepare("SELECT version FROM schema_migrations WHERE version = 22").all();
		expect(v).toHaveLength(1);
		const r = await call(owner, "GET", "/agents");
		expect(
			r.body.map((a: { name: string; projectId: string | null }) => [a.name, a.projectId]),
		).toEqual([
			["arquitecto", "p-1"],
			["developer", "p-1"],
			["solo", null],
		]);
	});

	it("a person's message is direct unless posted in a project the agent is in", async () => {
		const direct = await call(owner, "POST", "/messages", { to: "@solo", body: "hola" });
		expect(direct.status).toBe(201);
		expect(direct.body.project_id).toBeNull();
		expect(
			(await call(owner, "POST", "/messages", { to: "solo", body: "x", projectId: "p-1" })).body
				.error,
		).toBe("not-in-project");
		expect(
			(await call(owner, "POST", "/messages", { to: "arquitecto", body: "x", projectId: "p-x" }))
				.status,
		).toBe(404);
		const posted = await call(owner, "POST", "/messages", {
			to: "arquitecto",
			body: "diseñá X\n```\ncódigo\n```",
			projectId: "p-1",
		});
		expect(posted.status).toBe(201);
		expect(posted.body).toMatchObject({
			project_id: "p-1",
			depth: 0,
			from_id: "owner",
			body: "diseñá X\n```\ncódigo\n```",
		});
		await work("solo");
	});

	it("an agent's consult inherits the project scope; the reply comes back correlated in the same scope", async () => {
		const claimed = await call(as("arquitecto"), "POST", "/runner/claim");
		expect(claimed.body.project).toEqual({
			id: "p-1",
			name: "Proyecto p-1",
			agents: ["arquitecto", "developer"],
		});
		const consult = await call(as("arquitecto"), "POST", "/messages", {
			to: "@developer",
			body: "¿cuánto tarda?",
		});
		expect(consult.status).toBe(201);
		expect(consult.body).toMatchObject({ from_id: "arquitecto", project_id: "p-1", depth: 1 });
		// The same agent asking someone outside the project: direct, not posted in the project.
		const outside = await call(as("arquitecto"), "POST", "/messages", {
			to: "@solo",
			body: "privado",
		});
		expect(outside.body.project_id).toBeNull();
		await call(as("arquitecto"), "POST", `/runner/messages/${claimed.body.id}/result`, {
			state: "done",
			text: "pedido",
		});
		// The person's request produced no reply (only an agent's does).
		expect(
			db
				.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE reply_to = ?")
				.get(claimed.body.id),
		).toEqual({ n: 0 });
		const dev = await work("developer", "dos días");
		expect(dev.id).toBe(consult.body.id);
		const reply = db
			.prepare("SELECT * FROM agent_messages WHERE reply_to = ?")
			.get(consult.body.id) as Record<string, unknown>;
		expect(reply).toMatchObject({
			kind: "reply",
			from_id: "developer",
			to_id: "arquitecto",
			project_id: "p-1",
			depth: 0, // v25: the reply returns the asker to its own depth (request − 1)
			state: "pending",
		});
		expect(String(reply.body)).toContain("dos días");
		// The reply was pushed live like any row.
		expect(events.some((e) => e.type === "message" && e.id === reply.id)).toBe(true);
		// Finishing the reply ends the chain: no reply to a reply.
		const r = await work("arquitecto", "listo");
		expect(r.kind).toBe("reply");
		expect(
			db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE reply_to = ?").get(r.id),
		).toEqual({ n: 0 });
		await work("solo");
		// The private consult's reply stays private.
		const priv = await work("arquitecto");
		expect(priv).toMatchObject({
			kind: "reply",
			from_id: "solo",
			reply_to: outside.body.id,
			project_id: null,
		});
	});

	it("agent → agent chains stop at ACP_MAX_DEPTH, and an agent cannot message itself", async () => {
		await call(owner, "POST", "/messages", { to: "arquitecto", body: "empezá", projectId: "p-1" });
		const a = await call(as("arquitecto"), "POST", "/runner/claim");
		expect(
			(await call(as("arquitecto"), "POST", "/messages", { to: "arquitecto", body: "yo" })).body
				.error,
		).toBe("self");
		const d1 = await call(as("arquitecto"), "POST", "/messages", {
			to: "developer",
			body: "nivel 1",
		});
		expect(d1.body.depth).toBe(1);
		await call(as("arquitecto"), "POST", `/runner/messages/${a.body.id}/result`, {
			state: "done",
			text: ".",
		});
		const b = await call(as("developer"), "POST", "/runner/claim");
		const d2 = await call(as("developer"), "POST", "/messages", {
			to: "arquitecto",
			body: "nivel 2",
		});
		expect(d2.body.depth).toBe(2);
		await call(as("developer"), "POST", `/runner/messages/${b.body.id}/result`, {
			state: "done",
			text: ".",
		});
		// d2 was queued before the reply to d1 (which is written when d1 finishes).
		const c = await call(as("arquitecto"), "POST", "/runner/claim");
		expect(c.body.depth).toBe(2);
		const d3 = await call(as("arquitecto"), "POST", "/messages", {
			to: "developer",
			body: "nivel 3",
		});
		expect(d3.status).toBe(409);
		expect(d3.body.error).toBe("depth-limit");
		await call(as("arquitecto"), "POST", `/runner/messages/${c.body.id}/result`, {
			state: "done",
			text: ".",
		});
		// drain
		for (const n of ["arquitecto", "developer", "arquitecto", "developer"]) {
			const x = await call(as(n), "POST", "/runner/claim");
			if (x.status === 200)
				await call(as(n), "POST", `/runner/messages/${x.body.id}/result`, {
					state: "done",
					text: ".",
				});
		}
	});

	it("a retried send with the same clientId is the same row, per recipient", async () => {
		const body = {
			body: "@arquitecto @developer revisen",
			projectId: "p-1",
			clientId: "cid-0001-abcdef",
		};
		const a1 = await call(owner, "POST", "/messages", { ...body, to: "arquitecto" });
		const a2 = await call(owner, "POST", "/messages", { ...body, to: "arquitecto" });
		const d1 = await call(owner, "POST", "/messages", { ...body, to: "developer" });
		expect(a1.status).toBe(201);
		expect(a2.status).toBe(200);
		expect(a2.body.replayed).toBe(true);
		expect(a2.body.id).toBe(a1.body.id);
		expect(d1.body.id).not.toBe(a1.body.id);
		expect(
			(await call(owner, "POST", "/messages", { ...body, to: "arquitecto", clientId: "x" })).body
				.error,
		).toBe("bad-client-id");
	});

	it("Project Chat shows only what was posted there; the individual chat shows the agent's whole inbox", async () => {
		const pf = await call(owner, "GET", "/projects/p-1/feed");
		expect(pf.status).toBe(200);
		expect(pf.body.agents.map((a: { name: string }) => a.name)).toEqual([
			"arquitecto",
			"developer",
		]);
		expect(pf.body.messages.every((m: { project_id: string }) => m.project_id === "p-1")).toBe(
			true,
		);
		expect(pf.body.messages.some((m: { body: string }) => m.body === "privado")).toBe(false);
		const af = await call(owner, "GET", "/agents/arquitecto/feed");
		expect(af.body.messages.some((m: { body: string }) => m.body === "privado")).toBe(true);
		expect(
			af.body.messages.some((m: { project_id: string | null }) => m.project_id === "p-1"),
		).toBe(true);
		expect(af.body.agent).toMatchObject({ name: "arquitecto", projectId: "p-1", running: [] });
		expect(af.body.agent.pending).toBe(
			db
				.prepare(
					"SELECT COUNT(*) AS n FROM agent_messages WHERE to_id = 'arquitecto' AND state = 'pending'",
				)
				.get()?.n,
		);
		// Another owner's project is the same 404 as a missing one; agents never read feeds.
		expect((await call(owner, "GET", "/projects/p-x/feed")).status).toBe(404);
		expect((await call(as("arquitecto"), "GET", "/projects/p-1/feed")).status).toBe(403);
		// …nor another owner's agent's messages.
		const other = await call({ user: OTHER }, "GET", "/messages");
		expect(other.body.every((m: { owner_user_id: string }) => m.owner_user_id === OTHER)).toBe(
			true,
		);
	});

	it("joining and leaving a project; a foreign project is refused", async () => {
		expect((await call(owner, "PATCH", "/agents/solo", { projectId: "p-x" })).status).toBe(404);
		const j = await call(owner, "PATCH", "/agents/solo", { projectId: "p-2" });
		expect(j.body).toMatchObject({ name: "solo", projectId: "p-2" });
		expect(events.at(-1)?.type).toBe("agents");
		const l = await call(owner, "PATCH", "/agents/solo", { projectId: null });
		expect(l.body.projectId).toBeNull();
		expect((await call(as("solo"), "PATCH", "/agents/solo", { projectId: "p-2" })).status).toBe(
			403,
		);
	});

	it("a name freed by a hard delete and taken again names the NEW agent", async () => {
		const fresh = "55555555-5555-4555-8555-555555555555";
		db.prepare(
			"INSERT INTO sessions (session_id, user_id, name, container_name, status) VALUES (?, ?, 'solo2', ?, 'running')",
		).run(fresh, OWNER, `st-${fresh.slice(0, 12)}`);
		await call(owner, "GET", "/agents"); // warms the cache with the old @solo
		const left = await call(owner, "POST", "/messages", { to: "solo", body: "quedó sin hacer" });
		db.prepare("DELETE FROM sessions WHERE session_id = ?").run(SID.solo); // cascade: the agent row goes
		await acp.create(fresh, OWNER, "solo");
		// What the deleted agent left pending is not inherited by the new one.
		expect((await call(owner, "GET", `/messages/${left.body.id}`)).body.state).toBe("failed");
		const sent = await call(owner, "POST", "/messages", { to: "solo", body: "¿quién sos?" });
		expect(sent.status).toBe(201);
		expect((await acp.byName(OWNER, "solo"))?.session_id).toBe(fresh);
		expect(await acp.bySession(SID.solo)).toBeNull();
	});

	it("questions: asked by the runner, answered once by the person only, delivered once; a restart orphans, never answers", async () => {
		await call(owner, "POST", "/messages", {
			to: "developer",
			body: "decidí vos",
			projectId: "p-1",
		});
		const m = await call(as("developer"), "POST", "/runner/claim");
		const form = {
			mode: "form",
			message: "¿Base de datos?",
			requestedSchema: { type: "object", properties: {} },
		};
		const q = await call(as("developer"), "POST", "/runner/questions", {
			messageId: m.body.id,
			request: form,
		});
		expect(q.status).toBe(201);
		expect(q.body).toMatchObject({ state: "open", agent: "developer", message_id: m.body.id });
		// Visible where the message is: Project Chat, and the agent shows as waiting.
		const pf = await call(owner, "GET", "/projects/p-1/feed");
		expect(pf.body.questions.map((x: { id: number }) => x.id)).toContain(q.body.id);
		expect(pf.body.agents.find((a: { name: string }) => a.name === "developer").waitingInput).toBe(
			true,
		);
		// Another agent cannot answer the person's question.
		expect(
			(
				await call(as("arquitecto"), "POST", `/questions/${q.body.id}/answer`, {
					action: "decline",
				})
			).status,
		).toBe(403);
		expect(
			(await call({ user: OTHER }, "POST", `/questions/${q.body.id}/answer`, { action: "decline" }))
				.status,
		).toBe(404);
		const a1 = await call(owner, "POST", `/questions/${q.body.id}/answer`, {
			action: "accept",
			content: { question_0: "SQLite" },
		});
		expect(a1.body.state).toBe("answered");
		const a2 = await call(owner, "POST", `/questions/${q.body.id}/answer`, {
			action: "accept",
			content: {},
		});
		expect(a2.status).toBe(409);
		const seen = await call(as("developer"), "GET", `/runner/questions/${q.body.id}`);
		expect(JSON.parse(seen.body.answer)).toEqual({
			action: "accept",
			content: { question_0: "SQLite" },
		});
		expect(
			(await call(as("developer"), "POST", `/runner/questions/${q.body.id}/delivered`)).body.state,
		).toBe("delivered");
		expect(
			(await call(as("developer"), "POST", `/runner/questions/${q.body.id}/delivered`)).status,
		).toBe(409);
		// A second question left open when the runner restarts: orphaned, not answered.
		const q2 = await call(as("developer"), "POST", "/runner/questions", {
			messageId: m.body.id,
			request: form,
		});
		const orphaned = await call(as("developer"), "POST", "/runner/questions-orphan", {
			note: "reinicio",
		});
		expect(orphaned.body.map((x: { id: number; state: string }) => [x.id, x.state])).toEqual([
			[q2.body.id, "orphaned"],
		]);
		expect(
			(await call(owner, "POST", `/questions/${q2.body.id}/answer`, { action: "decline" })).body,
		).toMatchObject({
			error: "not-open",
			state: "orphaned",
		});
		expect(events.some((e) => e.type === "question")).toBe(true);
		await call(as("developer"), "POST", `/runner/messages/${m.body.id}/result`, {
			state: "done",
			text: ".",
		});
	});

	it("Conectar cuenta: only the adapter's safe terminal-auth commands, run in a tab of the agent's session", async () => {
		const ADAPTER_SCRIPT =
			"/opt/st-acp/claude-acp-0.108.0/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";
		const createTab = vi.fn(async (_sid: string, _label?: string, _cmd?: string) => ({
			tabId: "tab-login",
		}));
		(acp as unknown as { docker: unknown }).docker = { createTab };
		const reported = await call(as("arquitecto"), "POST", "/runner/auth-methods", {
			methods: [
				// What claude-agent-acp 0.108.0 really advertises (dist/auth-methods.js:
				// `[process.execPath, script, ...method.args]`); its script path sits
				// under the scoped package, so it carries an "@".
				{
					id: "claude-ai-login",
					name: "Claude Subscription",
					terminal: {
						command: "/usr/bin/node",
						args: [ADAPTER_SCRIPT, "--cli", "auth", "login", "--claudeai"],
						label: "Claude Login",
					},
				},
				{
					id: "console-login",
					name: "Anthropic Console",
					terminal: {
						command: "/usr/bin/node",
						args: [ADAPTER_SCRIPT, "--cli", "auth", "login", "--console"],
						label: "Anthropic Console Login",
					},
				},
				{
					id: "evil",
					name: "x",
					terminal: { command: "/usr/bin/sh", args: ["-c", "rm -rf ~; echo"] },
				},
				{ id: "bad-path", name: "x", terminal: { command: "/tmp/x", args: [] } },
			],
		});
		expect(reported.status).toBe(204);
		const ag = (await call(owner, "GET", "/agents")).body.find(
			(a: { name: string }) => a.name === "arquitecto",
		);
		expect(ag.loginMethods).toEqual([
			{ id: "claude-ai-login", name: "Claude Subscription", description: "" },
			{ id: "console-login", name: "Anthropic Console", description: "" },
		]);
		expect(
			(await call(owner, "POST", "/agents/arquitecto/login", { methodId: "evil" })).status,
		).toBe(404);
		expect(
			(
				await call(as("arquitecto"), "POST", "/agents/arquitecto/login", {
					methodId: "claude-ai-login",
				})
			).status,
		).toBe(403);
		const r = await call(owner, "POST", "/agents/arquitecto/login", {
			methodId: "claude-ai-login",
		});
		expect(r.status).toBe(201);
		expect(r.body).toEqual({ sessionId: SID.arq, tabId: "tab-login" });
		const [sid, label, line] = createTab.mock.calls[0]!;
		expect([sid, label]).toEqual([SID.arq, "Conectar cuenta"]);
		expect(
			line?.startsWith(`'/usr/bin/node' '${ADAPTER_SCRIPT}' '--cli' 'auth' 'login' '--claudeai'; `),
		).toBe(true);
	});

	/** Claims and finishes everything queued for these agents (replies included). */
	async function drain(...agents: string[]) {
		for (let progress = true; progress; ) {
			progress = false;
			for (const n of agents) {
				const x = await call(as(n), "POST", "/runner/claim");
				if (x.status !== 200) continue;
				progress = true;
				await call(as(n), "POST", `/runner/messages/${x.body.id}/result`, {
					state: "done",
					text: ".",
				});
			}
		}
	}
	const repliesTo = (id: number) =>
		db.prepare("SELECT * FROM agent_messages WHERE reply_to = ? ORDER BY id").all(id) as Array<
			Record<string, unknown>
		>;

	it("an agent's request that fails or is interrupted still answers its sender, once, correlated", async () => {
		await drain("arquitecto", "developer");
		await call(owner, "POST", "/messages", {
			to: "arquitecto",
			body: "coordiná",
			projectId: "p-1",
		});
		const a = await call(as("arquitecto"), "POST", "/runner/claim");
		const failing = await call(as("arquitecto"), "POST", "/messages", {
			to: "developer",
			body: "esto va a fallar",
		});
		const interrupted = await call(as("arquitecto"), "POST", "/messages", {
			to: "developer",
			body: "esto se interrumpe",
		});
		await call(as("arquitecto"), "POST", `/runner/messages/${a.body.id}/result`, {
			state: "done",
			text: ".",
		});
		const f = await call(as("developer"), "POST", "/runner/claim");
		expect(f.body.id).toBe(failing.body.id);
		const failed = { state: "failed", note: "prompt error: boom" };
		expect(
			(await call(as("developer"), "POST", `/runner/messages/${f.body.id}/result`, failed)).status,
		).toBe(200);
		// A runner that lost the answer posts the same result again: 409, no second notice.
		expect(
			(await call(as("developer"), "POST", `/runner/messages/${f.body.id}/result`, failed)).status,
		).toBe(409);
		const fr = repliesTo(failing.body.id);
		expect(fr).toHaveLength(1);
		expect(fr[0]).toMatchObject({
			kind: "reply",
			from_id: "developer",
			to_id: "arquitecto",
			state: "pending",
			project_id: "p-1",
			depth: 0,
		});
		expect(String(fr[0]!.body)).toContain("falló");
		expect(String(fr[0]!.body)).toContain("boom");
		expect(events.some((e) => e.type === "message" && e.id === fr[0]!.id)).toBe(true);

		const u = await call(as("developer"), "POST", "/runner/claim");
		expect(u.body.id).toBe(interrupted.body.id);
		await call(as("developer"), "POST", `/runner/messages/${u.body.id}/result`, {
			state: "uncertain",
			note: "runner restarted",
		});
		const notice = repliesTo(interrupted.body.id);
		expect(notice).toHaveLength(1);
		// Informing is not retrying: the notice tells the requester not to repeat
		// the request, and nothing re-sends it (still one request, still uncertain).
		expect(String(notice[0]!.body)).toContain("No lo repitas ni lo reenvíes");
		expect(
			db
				.prepare(
					"SELECT COUNT(*) AS n FROM agent_messages WHERE from_id = 'arquitecto' AND to_id = 'developer' AND body = 'esto se interrumpe'",
				)
				.get(),
		).toEqual({ n: 1 });
		expect((await call(owner, "GET", `/messages/${interrupted.body.id}`)).body.state).toBe(
			"uncertain",
		);
		// The person requeues it and it ends done: the real reply follows the notice.
		expect((await call(owner, "POST", `/messages/${u.body.id}/requeue`)).status).toBe(200);
		const again = await call(as("developer"), "POST", "/runner/claim");
		expect(again.body.id).toBe(interrupted.body.id);
		await call(as("developer"), "POST", `/runner/messages/${u.body.id}/result`, {
			state: "done",
			text: "hecho al fin",
		});
		const ur = repliesTo(interrupted.body.id);
		expect(ur.map((r) => r.note)).toEqual(["unfinished:uncertain", null]);
		expect(String(ur[1]!.body)).toContain("hecho al fin");
		await drain("arquitecto", "developer");
	});

	it("a person's message that fails gets no reply row (the person sees its state)", async () => {
		const m = await call(owner, "POST", "/messages", { to: "developer", body: "x" });
		const c = await call(as("developer"), "POST", "/runner/claim");
		expect(c.body.id).toBe(m.body.id);
		await call(as("developer"), "POST", `/runner/messages/${c.body.id}/result`, {
			state: "failed",
		});
		expect(repliesTo(m.body.id)).toHaveLength(0);
	});

	it("a question names a message only if it is the asking agent's running one", async () => {
		const posted = await call(owner, "POST", "/messages", {
			to: "developer",
			body: "trabajo del proyecto",
			projectId: "p-1",
		});
		// @solo (re-created above) is not in p-1 and is not running that message.
		tokens.solo = acp.tokenFor((await acp.byName(OWNER, "solo"))!.agent_id);
		const q = await call(as("solo"), "POST", "/runner/questions", {
			messageId: posted.body.id,
			request: { mode: "form", message: "¿colado?", requestedSchema: { type: "object" } },
		});
		expect(q.status).toBe(201);
		expect(q.body.message_id).toBeNull();
		const pf = await call(owner, "GET", "/projects/p-1/feed");
		expect(pf.body.questions.map((x: { id: number }) => x.id)).not.toContain(q.body.id);
		// Still shown where it belongs: the asking agent's own chat.
		const sf = await call(owner, "GET", "/agents/solo/feed");
		expect(sf.body.questions.map((x: { id: number }) => x.id)).toContain(q.body.id);
		await call(as("solo"), "POST", `/runner/questions/${q.body.id}/withdrawn`);
		await drain("developer");
	});

	it("a hard delete closes the agent's queue, tells agent senders, orphans its questions and drops its token", async () => {
		const sid = "66666666-6666-4666-8666-666666666666";
		db.prepare(
			"INSERT INTO sessions (session_id, user_id, name, container_name, status) VALUES (?, ?, 'temp', ?, 'running')",
		).run(sid, OWNER, `st-${sid.slice(0, 12)}`);
		const temp = await acp.create(sid, OWNER, "temporal", { projectId: "p-1" });
		tokens.temporal = acp.tokenFor(temp.agent_id);
		const fromPerson = await call(owner, "POST", "/messages", { to: "temporal", body: "uno" });
		await call(owner, "POST", "/messages", { to: "arquitecto", body: "pedile", projectId: "p-1" });
		const a = await call(as("arquitecto"), "POST", "/runner/claim");
		const fromAgent = await call(as("arquitecto"), "POST", "/messages", {
			to: "temporal",
			body: "dos",
		});
		await call(as("arquitecto"), "POST", `/runner/messages/${a.body.id}/result`, {
			state: "done",
			text: ".",
		});
		const running = await call(as("temporal"), "POST", "/runner/claim");
		expect(running.body.id).toBe(fromPerson.body.id);
		const q = await call(as("temporal"), "POST", "/runner/questions", {
			messageId: running.body.id,
			request: { mode: "form", message: "?", requestedSchema: { type: "object" } },
		});
		expect((await call(as("temporal"), "GET", "/agents")).status).toBe(200); // token cached

		await acp.onPurged(sid);
		db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sid);

		const state = (id: number) =>
			(db.prepare("SELECT state FROM agent_messages WHERE id = ?").get(id) as { state: string })
				.state;
		expect(state(fromPerson.body.id)).toBe("failed");
		expect(state(fromAgent.body.id)).toBe("failed");
		expect(repliesTo(fromPerson.body.id)).toHaveLength(0);
		expect(repliesTo(fromAgent.body.id)).toMatchObject([
			{ to_id: "arquitecto", kind: "reply", note: "unfinished:failed", project_id: "p-1" },
		]);
		expect((await call(owner, "GET", "/agents/temporal/feed")).status).toBe(404);
		expect(
			(
				db.prepare("SELECT state FROM agent_questions WHERE id = ?").get(q.body.id) as {
					state: string;
				}
			).state,
		).toBe("orphaned");
		expect((await call(as("temporal"), "GET", "/agents")).status).toBe(401);
		await drain("arquitecto");
	});

	it("recipients: only the caller owner's agents, in the project when posted there", async () => {
		const unknown = await call(owner, "POST", "/messages", { to: "@nadie", body: "x" });
		expect(unknown.status).toBe(400);
		expect(unknown.body.error).toBe("unknown-recipient");
		expect(unknown.body.agents).not.toContain("ajeno");
		// Another owner's agent, the person and Shared Terminal are not recipients.
		for (const to of ["ajeno", "owner", "system"]) {
			expect((await call(owner, "POST", "/messages", { to, body: "x" })).status).toBe(400);
			expect((await call(as("arquitecto"), "POST", "/messages", { to, body: "x" })).status).toBe(
				400,
			);
		}
		expect(
			(await call(owner, "POST", "/messages", { to: "solo", body: "x", projectId: "p-1" })).body
				.error,
		).toBe("not-in-project");
		expect(
			(await call(owner, "POST", "/messages", { to: "developer", body: "x", projectId: "p-x" }))
				.status,
		).toBe(404);
	});

	it("clientId: concurrent retries are one row; a reused id with another sender, text or scope is 409, never someone else's row", async () => {
		const send = {
			to: "developer",
			body: "una vez",
			projectId: "p-1",
			clientId: "cid-race-000001",
		};
		const all = await Promise.all([1, 2, 3].map(() => call(owner, "POST", "/messages", send)));
		expect(all.map((r) => r.status).sort()).toEqual([200, 200, 201]);
		expect(new Set(all.map((r) => r.body.id)).size).toBe(1);
		const count = () =>
			(
				db
					.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE client_id = ?")
					.get(send.clientId) as { n: number }
			).n;
		expect(count()).toBe(1);
		const otherText = await call(owner, "POST", "/messages", { ...send, body: "otra cosa" });
		expect(otherText.status).toBe(409);
		expect(otherText.body).toEqual({ error: "client-id-reused", id: all[0]!.body.id });
		expect((await call(owner, "POST", "/messages", { ...send, projectId: undefined })).status).toBe(
			409,
		);
		// An agent of the same owner reusing the person's id gets no replay of the person's row.
		await call(owner, "POST", "/messages", { to: "arquitecto", body: "trabajá", projectId: "p-1" });
		await drain("developer");
		const a = await call(as("arquitecto"), "POST", "/runner/claim");
		const byAgent = await call(as("arquitecto"), "POST", "/messages", {
			to: "developer",
			body: "una vez",
			clientId: send.clientId,
		});
		expect(byAgent.status).toBe(409);
		expect(count()).toBe(1);
		await call(as("arquitecto"), "POST", `/runner/messages/${a.body.id}/result`, {
			state: "done",
			text: ".",
		});
		await drain("arquitecto", "developer");
	});

	it("model: the owner changes it; the runner gets it with every claim and reports what the adapter applied", async () => {
		const devOf = async () =>
			((await call(owner, "GET", "/agents")).body as Array<Record<string, unknown>>).find(
				(a) => a.name === "developer",
			)!;
		const before = await devOf();
		expect((await call(owner, "PATCH", "/agents/developer", { model: "Opus 5" })).status).toBe(400);
		expect((await call(owner, "PATCH", "/agents/developer", {})).status).toBe(400);
		expect(
			(await call(as("developer"), "PATCH", "/agents/developer", { model: "claude-opus-5-5" }))
				.status,
		).toBe(403);
		const p = await call(owner, "PATCH", "/agents/developer", { model: "claude-opus-5-5" });
		expect(p.status).toBe(200);
		// Only the model changed: the project membership is kept.
		expect(p.body).toMatchObject({ model: "claude-opus-5-5", projectId: before.projectId });
		const c = await call(as("developer"), "POST", "/runner/claim");
		expect(c.headers.get("x-st-model")).toBe("claude-opus-5-5");
		if (c.status === 200)
			await call(as("developer"), "POST", `/runner/messages/${c.body.id}/result`, {
				state: "done",
				text: ".",
			});
		expect(
			(
				await call(as("developer"), "POST", "/runner/model", {
					requested: "claude-opus-5-5",
					current: "claude-opus-5-5",
				})
			).status,
		).toBe(204);
		expect((await devOf()).modelApplied).toMatchObject({
			requested: "claude-opus-5-5",
			current: "claude-opus-5-5",
			error: null,
		});
		expect(events.some((e) => e.type === "agents")).toBe(true);
	});

	it("effort: stored per agent (default = NULL), sent with every claim, the adapter's report kept as sent", async () => {
		const sid = "77777777-7777-4777-8777-777777777777";
		db.prepare(
			"INSERT INTO sessions (session_id, user_id, name, container_name, status) VALUES (?, ?, 'ef', ?, 'running')",
		).run(sid, OWNER, `st-${sid.slice(0, 12)}`);
		// At create: "default" is no pin (NULL), like leaving it out.
		const created = await acp.create(sid, OWNER, "esfuerzo", { effort: null });
		expect(created.effort).toBeNull();
		tokens.esfuerzo = acp.tokenFor(created.agent_id);
		const agentOf = async () =>
			((await call(owner, "GET", "/agents")).body as Array<Record<string, unknown>>).find(
				(a) => a.name === "esfuerzo",
			)!;
		const before = await agentOf();
		expect(before).toMatchObject({ effort: null, effortApplied: null });
		const claim = async () => {
			const c = await call(as("esfuerzo"), "POST", "/runner/claim");
			if (c.status === 200)
				await call(as("esfuerzo"), "POST", `/runner/messages/${c.body.id}/result`, {
					state: "done",
					text: ".",
				});
			return c.headers.get("x-st-effort");
		};
		expect(await claim()).toBe("default");
		for (const bad of ["High", "", 3, "x".repeat(33)])
			expect((await call(owner, "PATCH", "/agents/esfuerzo", { effort: bad })).status).toBe(400);
		expect(
			(await call(as("esfuerzo"), "PATCH", "/agents/esfuerzo", { effort: "high" })).status,
		).toBe(403);
		const p = await call(owner, "PATCH", "/agents/esfuerzo", { effort: "xhigh" });
		expect(p.status).toBe(200);
		// Only the effort changed: model and project are kept. The backend does not
		// judge the level: whether it exists for the model is the adapter's answer.
		expect(p.body).toMatchObject({
			effort: "xhigh",
			model: before.model,
			projectId: before.projectId,
		});
		expect(await claim()).toBe("xhigh");
		const report = {
			model: "claude-sonnet-5-5",
			requested: "xhigh",
			current: "high",
			levels: ["default", "low", "medium", "high"],
			error: "el adaptador no ofrece el nivel xhigh para este modelo",
		};
		expect((await call(as("esfuerzo"), "POST", "/runner/effort", report)).status).toBe(204);
		expect((await agentOf()).effortApplied).toMatchObject(report);
		// A report without `requested` is ignored; malformed levels become [].
		await call(as("esfuerzo"), "POST", "/runner/effort", { current: "low" });
		expect((await agentOf()).effortApplied).toMatchObject({ requested: "xhigh" });
		await call(as("esfuerzo"), "POST", "/runner/effort", { requested: "xhigh", levels: [1, 2] });
		expect((await agentOf()).effortApplied).toMatchObject({
			model: null,
			current: null,
			levels: [],
			error: null,
		});
		// "default" and null both clear the pin.
		expect(
			(await call(owner, "PATCH", "/agents/esfuerzo", { effort: "default" })).body,
		).toMatchObject({
			effort: null,
		});
		await call(owner, "PATCH", "/agents/esfuerzo", { effort: "low" });
		expect((await call(owner, "PATCH", "/agents/esfuerzo", { effort: null })).body).toMatchObject({
			effort: null,
		});
		expect(await claim()).toBe("default");
	});

	it("effort at create: the agent row starts with it", async () => {
		const sid = "88888888-8888-4888-8888-888888888888";
		db.prepare(
			"INSERT INTO sessions (session_id, user_id, name, container_name, status) VALUES (?, ?, 'ef2', ?, 'running')",
		).run(sid, OWNER, `st-${sid.slice(0, 12)}`);
		expect((await acp.create(sid, OWNER, "con-effort", { effort: "max" })).effort).toBe("max");
	});

	it("/agents lists every message an agent is running, oldest first", async () => {
		const ids = [1, 2].map(
			(n) =>
				(
					db
						.prepare(
							"INSERT INTO agent_messages (owner_user_id, from_id, to_id, kind, body, state) VALUES (?, 'owner', 'solo', 'request', ?, 'running') RETURNING id",
						)
						.get(OWNER, `a la vez ${n}`) as { id: number }
				).id,
		);
		const solo = (await call(owner, "GET", "/agents")).body.find(
			(a: { name: string }) => a.name === "solo",
		);
		expect(solo.running).toEqual(ids);
		db.prepare(`UPDATE agent_messages SET state = 'done' WHERE id IN (${ids.join(",")})`).run();
	});

	it("events go only to the owner of the row", () => {
		expect(events.filter((e) => e.type === "message").every((e) => e.owner === OWNER)).toBe(true);
	});
});

// v24: an agent runs up to max_concurrency messages at once, one per slot. The
// claim is the whole distribution; a credential names the context it runs in.
describe("ACP slots: contexts, caps and attribution (v24)", () => {
	const SIDM = "99999999-9999-4999-8999-999999999999";
	let multi: import("./agents.js").AgentRow;
	const claim = (slot: number, context?: string) =>
		call(as("multi"), "POST", "/runner/claim", { slot, ...(context ? { context } : {}) });
	const settle = (id: number, text = ".") =>
		call(as("multi"), "POST", `/runner/messages/${id}/result`, { state: "done", text });
	const sendTo = (work?: string, body = "x") =>
		call(owner, "POST", "/messages", { to: "multi", body, ...(work ? { work } : {}) });

	beforeAll(async () => {
		db.prepare(
			"INSERT INTO sessions (session_id, user_id, name, container_name, status) VALUES (?, ?, 'multi', ?, 'running')",
		).run(SIDM, OWNER, `st-${SIDM.slice(0, 12)}`);
		multi = await acp.create(SIDM, OWNER, "multi", { projectId: "p-1" });
		tokens.multi = acp.tokenFor(multi.agent_id);
		tokens["multi@a"] = acp.tokenFor(multi.agent_id, "a");
		tokens["multi@b"] = acp.tokenFor(multi.agent_id, "b");
		// Named contexts are works (v26): these two are active, as if created.
		for (const [id, port] of [
			["a", 20000],
			["b", 20100],
		])
			db.prepare(
				"INSERT INTO agent_works (owner_user_id, id, agent_id, project_id, branch, base_sha, port_base, state, created_by) VALUES (?, ?, ?, 'p-1', ?, 'abc', ?, 'active', 'owner')",
			).run(OWNER, id, multi.agent_id, `work/${id}`, port);
	});

	it("v24 is recorded; an agent starts with one slot and a named context needs more", async () => {
		expect(db.prepare("SELECT 1 FROM schema_migrations WHERE version = 24").get()).toBeTruthy();
		expect(multi.max_concurrency).toBe(1);
		expect((await sendTo("a")).body.error).toBe("context-needs-slots");
		expect((await sendTo("Mal_Nombre")).body.error).toBe("bad-work-id");
		expect((await call(owner, "PATCH", "/agents/multi", { maxConcurrency: 9 })).status).toBe(400);
		expect((await call(owner, "PATCH", "/agents/multi", { maxConcurrency: "2" })).status).toBe(400);
		const p = await call(owner, "PATCH", "/agents/multi", { maxConcurrency: 2 });
		expect(p.body.maxConcurrency).toBe(2);
		// A work is its agent's: another one cannot be sent into it.
		await sendTo(undefined, "para que multi trabaje");
		const r = await call(as("multi"), "POST", "/runner/claim");
		expect(
			(await call(as("multi"), "POST", "/messages", { to: "developer", body: "y", work: "a" })).body
				.error,
		).toBe("work-not-yours");
		await settle(r.body.id);
	});

	it("slot 1 takes only the default context, slots ≥ 2 only named ones, one running per context, caps in the claim", async () => {
		const m1 = (await sendTo(undefined, "default")).body;
		const m2 = (await sendTo("a", "a-1")).body;
		const m3 = (await sendTo("a", "a-2")).body;
		const m4 = (await sendTo("b", "b-1")).body;
		const c2 = await claim(2);
		expect(c2.body).toMatchObject({ id: m2.id, slot: 2, context: "a" });
		expect(c2.body.contextToken).toBe(tokens["multi@a"]);
		expect(c2.body.work).toEqual({
			id: "a",
			branch: "work/a",
			dir: "/home/developer/workspace/.st/ctx/a",
			portBase: 20000,
		});
		const c1 = await claim(1);
		expect(c1.body).toMatchObject({
			id: m1.id,
			slot: 1,
			context: null,
			contextToken: null,
			work: null,
		});
		// slot 2 busy: 409; slot 3 does not exist with max 2: nothing.
		expect((await claim(2)).status).toBe(409);
		expect((await claim(3)).status).toBe(204);
		// A third slot: m3 waits (context a is running), m4 goes.
		await call(owner, "PATCH", "/agents/multi", { maxConcurrency: 3 });
		const c3 = await claim(3);
		expect(c3.body).toMatchObject({ id: m4.id, slot: 3, context: "b" });
		expect((await call(as("multi"), "GET", "/runner/running?slot=2")).body.id).toBe(m2.id);
		await settle(m2.id);
		// A slot holding context b's session open takes only b: m3 (context a) is not for it.
		await settle(m4.id);
		expect((await claim(3, "b")).status).toBe(204);
		// …nor any other: context a stays with slot 2, which may still hold its session.
		expect((await claim(3)).status).toBe(204);
		expect((await claim(2)).body.id).toBe(m3.id);
		await settle(m3.id);
		await settle(m1.id);
		await call(owner, "PATCH", "/agents/multi", { maxConcurrency: 2 });
	});

	it("the global cap (ACP_MAX_RUNNING) holds under concurrent claims", async () => {
		const prev = acp.config.maxRunning;
		acp.config.maxRunning = 1;
		try {
			await sendTo(undefined, "g1");
			await sendTo("a", "g2");
			const rs = await Promise.all([claim(1), claim(2), claim(1), claim(2)]);
			const got = rs.filter((r) => r.status === 200);
			expect(got).toHaveLength(1);
			acp.config.maxRunning = 6;
			const more = await Promise.all([claim(1), claim(2)]);
			expect([...got, ...more].filter((r) => r.status === 200)).toHaveLength(2);
			for (const r of [...got, ...more].filter((x) => x.status === 200)) await settle(r.body.id);
		} finally {
			acp.config.maxRunning = prev;
		}
	});

	it("st send is attributed by its credential: its context's running message, the reply goes back to it; an ended execution is refused", async () => {
		const md = (await sendTo(undefined, "default")).body;
		const ma = (await sendTo("a", "contexto a")).body;
		await claim(1);
		await claim(2);
		const fromA = await call(as("multi@a"), "POST", "/messages", {
			to: "developer",
			body: "desde a",
		});
		expect(fromA.status).toBe(201);
		expect(fromA.body).toMatchObject({
			from_id: "multi",
			from_context: "a",
			context: null,
			depth: 1,
		});
		expect(fromA.body.project_id).toBeNull(); // ma is a direct message: the consult stays direct
		const fromD = await call(as("multi"), "POST", "/messages", {
			to: "developer",
			body: "desde default",
		});
		expect(fromD.body).toMatchObject({ from_context: null });
		// A context credential never reaches the runner routes.
		expect((await call(as("multi@a"), "POST", "/runner/claim", { slot: 2 })).body.error).toBe(
			"runner-only",
		);
		// The developer answers the one from context a: the reply lands in context a.
		for (;;) {
			const d = await call(as("developer"), "POST", "/runner/claim");
			expect(d.status).toBe(200);
			await call(as("developer"), "POST", `/runner/messages/${d.body.id}/result`, {
				state: "done",
				text: "listo",
			});
			if (d.body.id === fromA.body.id) break;
		}
		const reply = db
			.prepare("SELECT context, to_id, kind FROM agent_messages WHERE reply_to = ?")
			.get(fromA.body.id) as { context: string; to_id: string; kind: string };
		expect(reply).toEqual({ context: "a", to_id: "multi", kind: "reply" });
		// Context a's execution ends: a process it left behind cannot send any more.
		await settle(ma.id);
		const late = await call(as("multi@a"), "POST", "/messages", { to: "developer", body: "tarde" });
		expect(late.status).toBe(409);
		expect(late.body.error).toBe("execution-ended");
		// …nor be taken for the next message of another context (b is not a).
		const mb = (await sendTo("b", "contexto b")).body;
		expect((await claim(2, "b")).body.id).toBe(mb.id);
		expect(
			(await call(as("multi@a"), "POST", "/messages", { to: "developer", body: "tarde 2" })).body
				.error,
		).toBe("execution-ended");
		await settle(mb.id);
		await settle(md.id);
		// The reply waiting in context a is taken by a named-context slot.
		const back = await claim(2);
		expect(back.body).toMatchObject({ kind: "reply", context: "a", reply_to: fromA.body.id });
		await settle(back.body.id);
	});

	it("a slot's restart orphans only its own questions; recovery runs in the interrupted message's slot and context", async () => {
		const m1 = (await sendTo(undefined, "q1")).body;
		const m2 = (await sendTo("a", "q2")).body;
		await claim(1);
		await claim(2);
		const q1 = await call(as("multi"), "POST", "/runner/questions", {
			messageId: m1.id,
			request: { message: "?" },
		});
		const q2 = await call(as("multi"), "POST", "/runner/questions", {
			messageId: m2.id,
			request: { message: "?" },
		});
		expect([q1.body.message_id, q2.body.message_id]).toEqual([m1.id, m2.id]);
		const o = await call(as("multi"), "POST", "/runner/questions-orphan", {
			slot: 2,
			note: "slot 2 reinició",
		});
		expect(o.body.map((q: { id: number }) => q.id)).toEqual([q2.body.id]);
		// Slot 2 judges ITS message uncertain; slot 1's keeps running.
		await call(as("multi"), "POST", `/runner/messages/${m2.id}/result`, {
			state: "uncertain",
			note: "x",
		});
		expect((await call(as("multi"), "GET", "/runner/running?slot=1")).body.id).toBe(m1.id);
		const sys = await call(as("multi"), "POST", "/runner/system-message", {
			slot: 2,
			context: "a",
			body: "[st-recovery] …",
		});
		expect(sys.body).toMatchObject({
			slot: 2,
			context: "a",
			contextToken: tokens["multi@a"],
			state: "running",
		});
		// Never a second running message in a context or a slot.
		expect(
			(
				await call(as("multi"), "POST", "/runner/system-message", {
					slot: 3,
					context: "a",
					body: "x",
				})
			).status,
		).toBe(409);
		await settle(sys.body.id);
		await settle(m1.id);
		await call(owner, "POST", `/questions/${q1.body.id}/answer`, { action: "cancel" });
	});
});

// v25: depth measures nesting only (a reply returns the asker to its depth);
// rounds are bounded per person's message (root_id, ACP_MAX_CHAIN).
describe("ACP chains: depth is nesting, rounds have a budget (v25)", () => {
	// Two agents of their own: earlier suites leave messages queued for theirs.
	beforeAll(async () => {
		for (const [name, sid] of [
			["ida", "aaaaaaaa-0000-4000-8000-00000000000a"],
			["vuelta", "bbbbbbbb-0000-4000-8000-00000000000b"],
		]) {
			db.prepare(
				"INSERT INTO sessions (session_id, user_id, name, container_name, status) VALUES (?, ?, ?, ?, 'running')",
			).run(sid, OWNER, name, `st-${sid.slice(0, 12)}`);
			tokens[name] = acp.tokenFor((await acp.create(sid, OWNER, name)).agent_id);
		}
	});
	/** ida consults vuelta `rounds` times within one person's message. */
	async function rounds(n: number) {
		const root = (await call(owner, "POST", "/messages", { to: "ida", body: "coordiná" })).body;
		let cur = (await call(as("ida"), "POST", "/runner/claim")).body;
		expect(cur.id).toBe(root.id);
		const sent: Array<{ status: number; body: Record<string, unknown> }> = [];
		for (let i = 0; i < n; i++) {
			const ask = await call(as("ida"), "POST", "/messages", {
				to: "vuelta",
				body: `ronda ${i}`,
			});
			sent.push(ask);
			await call(as("ida"), "POST", `/runner/messages/${cur.id}/result`, {
				state: "done",
				text: ".",
			});
			if (ask.status !== 201) break;
			const d = await call(as("vuelta"), "POST", "/runner/claim");
			expect(d.body.id).toBe(ask.body.id);
			await call(as("vuelta"), "POST", `/runner/messages/${d.body.id}/result`, {
				state: "done",
				text: "ok",
			});
			cur = (await call(as("ida"), "POST", "/runner/claim")).body; // the reply
			expect(cur).toMatchObject({ kind: "reply", reply_to: ask.body.id, root_id: root.id });
		}
		if (sent.at(-1)?.status === 201)
			await call(as("ida"), "POST", `/runner/messages/${cur.id}/result`, {
				state: "done",
				text: ".",
			});
		return { root, sent, last: cur };
	}

	it("v25 is recorded", () => {
		expect(db.prepare("SELECT 1 FROM schema_migrations WHERE version = 25").get()).toBeTruthy();
	});

	it("a long run of consult/answer rounds keeps depth 1 and never meets the depth cap", async () => {
		// maxDepth is 2 in this suite: 8 rounds would have reached 16 before.
		const { root, sent, last } = await rounds(8);
		expect(sent.map((s) => s.status)).toEqual(Array(8).fill(201));
		expect(sent.map((s) => s.body.depth)).toEqual(Array(8).fill(1));
		expect(sent.every((s) => s.body.root_id === root.id)).toBe(true);
		expect(last.depth).toBe(0);
	});

	it("past ACP_MAX_CHAIN requests under one person's message, a send is refused; the person's next message is a new budget", async () => {
		const prev = acp.config.maxChain;
		acp.config.maxChain = 3;
		try {
			const { sent } = await rounds(4);
			expect(sent.map((s) => s.status)).toEqual([201, 201, 201, 409]);
			expect(sent[3].body.error).toBe("chain-budget");
			expect(String(sent[3].body.message)).toMatch(/esperá a la persona/);
			const again = await rounds(1);
			expect(again.sent[0].status).toBe(201);
		} finally {
			acp.config.maxChain = prev;
		}
	});
});

// v26: a named context exists only as a work, created by the backend (in the
// agent's container) before its first message.
describe("ACP works: creation, delegation (v26)", () => {
	const SIDW = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const SIDV = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
	const create = (who: Who, id: string, extra: Record<string, unknown> = {}, agent = "obrero") =>
		call(who, "POST", "/works", { agent, id, ...extra });
	const row = (id: string) =>
		db.prepare("SELECT * FROM agent_works WHERE owner_user_id = ? AND id = ?").get(OWNER, id) as
			| { state: string; note: string | null; port_base: number; base_sha: string | null }
			| undefined;

	beforeAll(async () => {
		for (const [sid, name] of [
			[SIDW, "obrero"],
			[SIDV, "vecino"],
		]) {
			db.prepare(
				"INSERT INTO sessions (session_id, user_id, name, container_name, status) VALUES (?, ?, ?, ?, 'running')",
			).run(sid, OWNER, name, `st-${sid.slice(0, 12)}`);
			const a = await acp.create(sid, OWNER, name, { projectId: "p-1" });
			tokens[name] = acp.tokenFor(a.agent_id);
			await acp.setMaxConcurrency(OWNER, name, 3);
		}
	});

	it("v26 is recorded; the person creates a work: worktree on work/<id>, ports, active", async () => {
		expect(db.prepare("SELECT 1 FROM schema_migrations WHERE version = 26").get()).toBeTruthy();
		const r = await create(owner, "st-42");
		expect(r.status).toBe(201);
		expect(r.body).toMatchObject({
			id: "st-42",
			agent: "obrero",
			projectId: "p-1",
			branch: "work/st-42",
			dir: "/home/developer/workspace/.st/ctx/st-42",
			baseSha: "b".repeat(40),
			portBase: 20000,
			state: "active",
			createdBy: "owner",
		});
		expect(fx.calls.slice(-2)).toEqual(["preflight st-42 ", `create st-42 ${"b".repeat(40)}`]);
		expect(r.body.base).toBe("origin/main");
		// The same POST again: the same work, nothing run in the container.
		fx.calls = [];
		const again = await create(owner, "st-42");
		expect(again.status).toBe(200);
		expect(again.body.portBase).toBe(20000);
		expect(fx.calls).toEqual([]);
		// The base, when given, is what the worktree starts from.
		expect((await create(owner, "st-43", { base: "v1" })).body.baseSha).toBe("1".repeat(40));
	});

	it("who may create: the person, or an agent of the recipient's project; caps and session first", async () => {
		const byAgent = await create(as("arquitecto"), "por-arq");
		expect(byAgent.status).toBe(201);
		expect(byAgent.body.createdBy).toBe("arquitecto");
		expect((await create(as("solo"), "por-solo")).body.error).toBe("work-other-project");
		expect((await create(as("ajeno"), "x-1")).body.error).toBe("unknown-recipient");
		expect((await create(owner, "dev-1", {}, "developer")).body.error).toBe("context-needs-slots");
		fx.running = false;
		try {
			expect((await create(owner, "parado")).status).toBe(409);
			expect((await create(owner, "parado")).body.error).toBe("session-not-running");
		} finally {
			fx.running = true;
		}
		expect(row("parado")).toBeUndefined();
		for (const [id, base] of [
			["Mal", undefined],
			["ok-1", "-x"],
			["ok-1", "a..b"],
			["ok-1", "main@{1}"],
		])
			expect((await create(owner, id as string, base ? { base } : {})).status).toBe(400);
		expect((await create(owner, "ok-1", { base: "no-such-ref" })).body.error).toBe("bad-base");
		// A work id is the owner's, for one agent, never reused.
		const other = await create(owner, "st-42", {}, "vecino");
		expect(other.status).toBe(409);
		expect(other.body).toMatchObject({ error: "work-exists" });
	});

	it("never over what is there; disk and repo are checked first — nothing is written", async () => {
		const d = diskOf(SIDW);
		d.sessions.add("e2p-a");
		d.dirs.add("e2p-b");
		d.branches.add("e2p-c");
		for (const [id, found] of [
			["e2p-a", "session"],
			["e2p-b", "directory"],
			["e2p-c", "branch"],
		]) {
			const r = await create(owner, id);
			expect(r.status).toBe(409);
			expect(r.body).toMatchObject({ error: "work-path-exists", found: [found] });
			expect(row(id)).toBeUndefined();
		}
		fx.freeKb = 1024 * 1024;
		try {
			const r = await create(owner, "lleno");
			expect(r.body).toMatchObject({ error: "low-disk", freeMb: 1024, minFreeMb: 20480 });
		} finally {
			fx.freeKb = 50 * 1024 * 1024;
		}
		fx.repo = false;
		try {
			expect((await create(owner, "sin-repo")).body.error).toBe("not-a-repo");
		} finally {
			fx.repo = true;
		}
		expect(row("lleno")).toBeUndefined();
	});

	it("an error or unknown outcome of the worktree add: the real state decides", async () => {
		// Made, but the answer was lost: active.
		fx.create = "throw";
		const lost = await create(owner, "perdido");
		expect(lost.status).toBe(201);
		expect(row("perdido")?.state).toBe("active");
		// Nothing made: stays creating, and the same POST creates it.
		fx.create = "cut";
		const cut = await create(owner, "cortado");
		expect(cut.status).toBe(409);
		expect(cut.body).toMatchObject({ error: "work-incomplete", found: "none" });
		await vi.waitFor(() => expect(row("cortado")?.note).toMatch(/repetí el pedido/));
		expect(row("cortado")?.state).toBe("creating");
		const retry = await create(owner, "cortado");
		expect(retry.status).toBe(201);
		expect(row("cortado")).toMatchObject({ state: "active", note: null });
		// Something else (a branch without its worktree): left as is, said, never replaced.
		fx.create = "half";
		const half = await create(owner, "a-medias");
		expect(half.body).toMatchObject({ error: "work-incomplete", found: "branch-only" });
		fx.calls = [];
		const again = await create(owner, "a-medias");
		expect(again.body).toMatchObject({ error: "work-incomplete", found: "branch-only" });
		expect(fx.calls).toEqual(["inspect a-medias"]);
		expect(row("a-medias")?.state).toBe("creating");
	});

	it("port blocks: the lowest free among the agent's works not cleaned, unique under concurrency", async () => {
		const ports = (
			db
				.prepare(
					"SELECT port_base FROM agent_works w JOIN acp_agents a ON a.agent_id = w.agent_id WHERE a.name = 'obrero' AND state != 'cleaned' ORDER BY port_base",
				)
				.all() as Array<{ port_base: number }>
		).map((r) => r.port_base);
		expect(new Set(ports).size).toBe(ports.length);
		expect(ports).toEqual(ports.map((_, i) => 20000 + 100 * i));
		// Concurrent creations never share a block.
		const rs = await Promise.all(["c-1", "c-2", "c-3"].map((id) => create(owner, id)));
		const got = rs.map((r) => r.body.portBase);
		expect(new Set(got).size).toBe(3);
		// A cleaned work frees its block; its id stays taken.
		db.prepare(
			"UPDATE agent_works SET state = 'cleaned' WHERE owner_user_id = ? AND id = 'st-42'",
		).run(OWNER);
		const reuse = await create(owner, "reusa");
		expect(reuse.body.portBase).toBe(20000);
		expect((await create(owner, "st-42")).body).toMatchObject({
			error: "work-exists",
			state: "cleaned",
		});
		// A ceiling: no block past 60000.
		const full = db.prepare(
			"INSERT INTO agent_works (owner_user_id, id, agent_id, branch, port_base, state, created_by) SELECT ?, ?, agent_id, 'work/x', ?, 'closed', 'owner' FROM acp_agents WHERE name = 'vecino'",
		);
		for (let k = 0; k <= 399; k++) full.run(OWNER, `relleno-${k}`, 20000 + 100 * k);
		const none = await create(owner, "sin-puertos", {}, "vecino");
		expect(none.status).toBe(409);
		expect(none.body.error).toBe("no-free-ports");
		db.prepare("DELETE FROM agent_works WHERE id LIKE 'relleno-%'").run();
		// Another agent's blocks are its own.
		expect((await create(owner, "del-vecino", {}, "vecino")).body.portBase).toBe(20000);
	});

	it("delegation: --work runs in that work's context; only an active work of the recipient, of the sender's project", async () => {
		const send = (who: Who, work: string, to = "obrero") =>
			call(who, "POST", "/messages", { to, body: `en ${work}`, work });
		expect((await send(owner, "no-existe")).body.error).toBe("work-not-found");
		expect((await send(owner, "del-vecino")).body.error).toBe("work-not-yours");
		expect((await send(owner, "a-medias")).body).toMatchObject({
			error: "work-not-active",
			state: "creating",
		});
		expect((await send(owner, "st-42")).body.error).toBe("work-not-active");
		const ok = await send(owner, "por-arq");
		expect(ok.status).toBe(201);
		expect(ok.body.context).toBe("por-arq");
		// An agent: from a running message, into a work of its project.
		const m = (await call(owner, "POST", "/messages", { to: "arquitecto", body: "delegá" })).body;
		const c = await call(as("arquitecto"), "POST", "/runner/claim");
		expect(c.body.id).toBe(m.id);
		const del = await send(as("arquitecto"), "perdido");
		expect(del.status).toBe(201);
		expect(del.body).toMatchObject({ context: "perdido", from_id: "arquitecto", depth: 1 });
		// solo is in no project: never into a work.
		expect((await send(as("solo"), "perdido")).body.error).toBe("work-other-project");
		// The recipient moved to another project: its old project no longer delegates to it.
		db.prepare("UPDATE acp_agents SET project_id = 'p-2' WHERE name = 'obrero'").run();
		const moved = await send(as("arquitecto"), "perdido");
		db.prepare("UPDATE acp_agents SET project_id = 'p-1' WHERE name = 'obrero'").run();
		expect(moved.body.error).toBe("work-other-project");
		await call(as("arquitecto"), "POST", `/runner/messages/${c.body.id}/result`, {
			state: "done",
			text: ".",
		});
		// The free `context` field is gone: refused, never run in the default context.
		const free = await call(owner, "POST", "/messages", {
			to: "obrero",
			body: "x",
			context: "libre",
		});
		expect(free.status).toBe(400);
		expect(free.body.error).toBe("context-removed");
	});

	it("GET /works: the person sees all; an agent its own and its project's", async () => {
		const all = (await call(owner, "GET", "/works")).body as Array<{ id: string; agent: string }>;
		expect(all.map((w) => w.id)).toEqual(expect.arrayContaining(["a", "st-42", "del-vecino"]));
		const solo = (await call(as("solo"), "GET", "/works")).body;
		expect(solo).toEqual([]);
		const arq = (await call(as("arquitecto"), "GET", "/works")).body as Array<{ id: string }>;
		expect(arq.map((w) => w.id)).toContain("st-42");
	});
});

describe("ACP works: close, clean, the slot's session (v26)", () => {
	const SIDC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
	let w = "";
	const mk = async (id: string) => {
		const r = await call(owner, "POST", "/works", { agent: "cerrador", id });
		expect(r.status).toBe(201);
		return r.body;
	};
	const act = (who: Who, id: string, verb: "close" | "clean") =>
		call(who, "POST", `/works/${id}/${verb}`);
	const state = (id: string) =>
		db
			.prepare("SELECT state, note, closed_at, cleaned_at FROM agent_works WHERE id = ?")
			.get(id) as {
			state: string;
			note: string | null;
			closed_at: string | null;
			cleaned_at: string | null;
		};

	beforeAll(async () => {
		db.prepare(
			"INSERT INTO sessions (session_id, user_id, name, container_name, status) VALUES (?, ?, 'cerrador', ?, 'running')",
		).run(SIDC, OWNER, `st-${SIDC.slice(0, 12)}`);
		const a = await acp.create(SIDC, OWNER, "cerrador", { projectId: "p-1" });
		tokens.cerrador = acp.tokenFor(a.agent_id);
		await acp.setMaxConcurrency(OWNER, "cerrador", 2);
		w = (await mk("cierre")).id;
	});

	it("close: refused while a message of it is pending or running; then closed, and --work refuses it", async () => {
		const m = (await call(owner, "POST", "/messages", { to: "cerrador", body: "x", work: w })).body;
		expect((await act(owner, w, "close")).body).toMatchObject({
			error: "work-busy",
			messages: [m.id],
		});
		const c = await call(as("cerrador"), "POST", "/runner/claim", { slot: 2 });
		expect(c.body.id).toBe(m.id);
		expect((await act(owner, w, "close")).body.error).toBe("work-busy");
		await call(as("cerrador"), "POST", `/runner/messages/${m.id}/result`, {
			state: "done",
			text: ".",
		});
		expect((await act(as("solo"), w, "close")).body.error).toBe("work-other-project");
		// An agent of the work's project may close it.
		const closed = await act(as("arquitecto"), w, "close");
		expect(closed.status).toBe(200);
		expect(closed.body.state).toBe("closed");
		expect(state(w).closed_at).toBeTruthy();
		expect((await act(owner, w, "close")).body).toMatchObject({
			error: "work-not-active",
			state: "closed",
		});
		expect(
			(await call(owner, "POST", "/messages", { to: "cerrador", body: "y", work: w })).body,
		).toMatchObject({ error: "work-not-active", state: "closed" });
		expect((await act(owner, "no-existe", "close")).status).toBe(404);
	});

	it("the claim tells a slot holding a work that is no longer active to release its session", async () => {
		const open = (id: string) =>
			call(as("cerrador"), "POST", "/runner/claim", { slot: 2, open: id });
		expect((await open(w)).headers.get("x-st-release")).toBe(w);
		const live = (await mk("sigue")).id;
		expect((await open(live)).headers.get("x-st-release")).toBeNull();
		expect(
			(await call(as("cerrador"), "POST", "/runner/claim", { slot: 2 })).headers.get(
				"x-st-release",
			),
		).toBeNull();
	});

	it("clean: only from closed; every doubt leaves it cleanup-pending with all the reasons; then cleaned", async () => {
		expect((await act(owner, "sigue", "clean")).body).toMatchObject({
			error: "work-not-closed",
			state: "active",
		});
		fx.clean = [
			"reason=cambios sin commitear: ?? a.txt",
			"reason=proceso 42 (vite) con cwd en el trabajo",
		];
		const held = await act(owner, w, "clean");
		expect(held.status).toBe(409);
		expect(held.body).toEqual({
			error: "cleanup-pending",
			reasons: ["cambios sin commitear: ?? a.txt", "proceso 42 (vite) con cwd en el trabajo"],
		});
		expect(state(w)).toMatchObject({
			state: "cleanup-pending",
			note: "cambios sin commitear: ?? a.txt; proceso 42 (vite) con cwd en el trabajo",
		});
		// A stopped session cannot be checked: a doubt, nothing removed.
		fx.running = false;
		try {
			expect((await act(owner, w, "clean")).body.reasons).toEqual([
				"la sesión del agente no está corriendo: no se puede comprobar",
			]);
		} finally {
			fx.running = true;
		}
		// A message of it still pending (sent before the close): a doubt, checked without removing.
		db.prepare(
			"INSERT INTO agent_messages (owner_user_id, from_id, to_id, kind, body, state, context) VALUES (?, 'owner', 'cerrador', 'request', 'tarde', 'pending', ?)",
		).run(OWNER, w);
		fx.calls = [];
		const late = await act(owner, w, "clean");
		expect(late.body.reasons[0]).toMatch(/^mensajes pendientes o en curso: #\d+$/);
		expect(fx.calls).toEqual([`clean ${w} check`]);
		db.prepare("UPDATE agent_messages SET state = 'failed' WHERE body = 'tarde'").run();
		// Nothing in the way: removed, cleaned; the id stays taken.
		const ok = await act(as("arquitecto"), w, "clean");
		expect(ok.status).toBe(200);
		expect(ok.body).toMatchObject({ state: "cleaned", note: null });
		expect(state(w).cleaned_at).toBeTruthy();
		expect((await act(owner, w, "clean")).body).toMatchObject({
			error: "work-not-closed",
			state: "cleaned",
		});
		expect((await call(owner, "POST", "/works", { agent: "cerrador", id: w })).body.error).toBe(
			"work-exists",
		);
	});

	it("a cleaning whose removal was done but not confirmed finishes on the next try (absent)", async () => {
		const id = (await mk("ausente")).id;
		await act(owner, id, "close");
		fx.clean = ["reason=no se pudo comprobar"];
		expect((await act(owner, id, "clean")).status).toBe(409);
		fx.clean = ["absent"];
		expect((await act(owner, id, "clean")).body.state).toBe("cleaned");
	});
});

// A context's ACP session stays open in the slot that last ran it: its next
// message goes to that slot, never to a second one that would open it again.
describe("ACP slots: context affinity", () => {
	const SIDA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
	const claim = (slot: number) => call(as("afin"), "POST", "/runner/claim", { slot });
	const done = (id: number) =>
		call(as("afin"), "POST", `/runner/messages/${id}/result`, { state: "done", text: "." });
	const to = (work: string) =>
		call(owner, "POST", "/messages", { to: "afin", body: work, work }).then((r) => r.body);

	beforeAll(async () => {
		db.prepare(
			"INSERT INTO sessions (session_id, user_id, name, container_name, status) VALUES (?, ?, 'afin', ?, 'running')",
		).run(SIDA, OWNER, `st-${SIDA.slice(0, 12)}`);
		const a = await acp.create(SIDA, OWNER, "afin", { projectId: "p-1" });
		tokens.afin = acp.tokenFor(a.agent_id);
		await acp.setMaxConcurrency(OWNER, "afin", 3);
		for (const [k, id] of ["af-c", "af-d", "af-e", "af-f"].entries())
			db.prepare(
				"INSERT INTO agent_works (owner_user_id, id, agent_id, project_id, branch, port_base, state, created_by) VALUES (?, ?, ?, 'p-1', ?, ?, 'active', 'owner')",
			).run(OWNER, id, a.agent_id, `work/${id}`, 20000 + 100 * k);
	});

	it("a context that never ran goes to any slot; once run, it stays with that slot while it is free", async () => {
		const c1 = await to("af-c");
		expect((await claim(2)).body.id).toBe(c1.id);
		await done(c1.id);
		const c2 = await to("af-c");
		expect((await claim(3)).status).toBe(204);
		expect((await claim(2)).body.id).toBe(c2.id);
		await done(c2.id);
	});

	it("a slot that moved on to another context released it: another slot may take it", async () => {
		const d1 = await to("af-d");
		expect((await claim(2)).body.id).toBe(d1.id); // slot 2: c, then d
		await done(d1.id);
		const c3 = await to("af-c");
		expect((await claim(3)).body.id).toBe(c3.id);
		await done(c3.id);
		// The context it skips does not block the next one: slot 3 holds c, a new e is anyone's.
		const c4 = await to("af-c");
		const e1 = await to("af-e");
		expect((await claim(2)).body.id).toBe(e1.id);
		expect((await claim(3)).body.id).toBe(c4.id);
		await done(e1.id);
		await done(c4.id);
	});

	it("a slot past a lowered cap claims nothing more: its context goes to another slot", async () => {
		const f1 = await to("af-f");
		expect((await claim(3)).body.id).toBe(f1.id);
		await done(f1.id);
		await acp.setMaxConcurrency(OWNER, "afin", 2);
		const f2 = await to("af-f");
		expect((await claim(2)).body.id).toBe(f2.id);
		await done(f2.id);
	});
});

// v27: conversations — a project's topics. Agents of their own, in a project
// of its own, so nothing earlier suites left queued gets in the way.
describe("ACP conversations (v27)", () => {
	const PC = "p-c";
	const SIDS: Record<string, string> = {
		ana: "a0000000-0000-4000-8000-000000000001",
		beto: "a0000000-0000-4000-8000-000000000002",
		caro: "a0000000-0000-4000-8000-000000000003",
		fuera: "a0000000-0000-4000-8000-000000000004",
	};
	const crid = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
	const newConv = (n: number, title = `Tema ${n}`, projectId = PC) =>
		call(owner, "POST", "/conversations", { projectId, title, clientRequestId: crid(n) });
	const row = (id: number) =>
		db.prepare("SELECT * FROM agent_messages WHERE id = ?").get(id) as Record<string, unknown>;
	let c1: string;
	let c2: string;

	beforeAll(async () => {
		db.prepare(
			"INSERT INTO projects (project_id, owner_user_id, name, client_request_id, request_hash) VALUES (?, ?, 'Conversaciones', 'c-pc', 'h')",
		).run(PC, OWNER);
		for (const [name, sid] of Object.entries(SIDS)) {
			db.prepare(
				"INSERT INTO sessions (session_id, user_id, name, container_name, status) VALUES (?, ?, ?, ?, 'running')",
			).run(sid, OWNER, name, `st-${sid.slice(0, 12)}`);
			const a = await acp.create(sid, OWNER, name, { projectId: name === "fuera" ? "p-2" : PC });
			tokens[name] = acp.tokenFor(a.agent_id);
		}
	});

	it("v27 is recorded; a conversation is created once per clientRequestId, in a live project of the owner", async () => {
		expect(db.prepare("SELECT 1 FROM schema_migrations WHERE version = 27").get()).toBeTruthy();
		const a = await newConv(1, "Optimización de CI");
		expect(a.status).toBe(201);
		expect(a.body).toMatchObject({
			projectId: PC,
			title: "Optimización de CI",
			replayed: false,
			unread: 0,
			needsAction: false,
			recipients: null,
			archivedAt: null,
			readAt: null,
		});
		c1 = a.body.id;
		const again = await newConv(1, "Optimización de CI");
		expect(again.status).toBe(200);
		expect(again.body).toMatchObject({ id: c1, replayed: true });
		expect((await newConv(1, "Otro título")).body.error).toBe("idempotency-conflict");
		expect((await newConv(9, "x", "p-x")).status).toBe(404);
		expect((await newConv(9, "  ")).body.error).toBe("invalid-title");
		expect(
			(
				await call(owner, "POST", "/conversations", {
					projectId: PC,
					title: "x",
					clientRequestId: "no",
				})
			).body.error,
		).toBe("invalid-client-request-id");
		expect(
			(
				await call(as("ana"), "POST", "/conversations", {
					projectId: PC,
					title: "x",
					clientRequestId: crid(8),
				})
			).status,
		).toBe(403);
		c2 = (await newConv(2, "Diseño")).body.id;
		expect(events.some((e) => e.type === "conversation")).toBe(true);
	});

	it("a post to several agents: one row each under one clientId, in the conversation and its project; a retry is the same rows", async () => {
		const send = () =>
			call(owner, "POST", "/messages", {
				to: ["@ana", "beto"],
				body: "revisen el pipeline",
				conversationId: c1,
				clientId: "multi-0001",
			});
		const r = await send();
		expect(r.status).toBe(201);
		expect(
			r.body.messages.map((m: MessageRowT) => [m.to_id, m.conversation_id, m.project_id, m.team]),
		).toEqual([
			["ana", c1, PC, 0],
			["beto", c1, PC, 0],
		]);
		const again = await send();
		expect(again.status).toBe(200);
		expect(again.body.replayed).toBe(true);
		expect(again.body.messages.map((m: MessageRowT) => m.id)).toEqual(
			r.body.messages.map((m: MessageRowT) => m.id),
		);
		// Recipients must be of the conversation's project; several need a clientId.
		expect(
			(
				await call(owner, "POST", "/messages", {
					to: ["fuera"],
					body: "x",
					conversationId: c1,
					clientId: "multi-0002",
				})
			).body.error,
		).toBe("not-in-project");
		expect(
			(
				await call(owner, "POST", "/messages", {
					to: ["ana", "beto"],
					body: "x",
					conversationId: c1,
				})
			).body.error,
		).toBe("client-id-required");
		expect((await call(owner, "POST", "/messages", { to: ["ana"], body: "x" })).body.error).toBe(
			"conversation-required",
		);
		expect(
			(
				await call(owner, "POST", "/messages", {
					to: "ana",
					body: "x",
					conversationId: c1,
					projectId: "p-1",
				})
			).body.error,
		).toBe("project-mismatch");
		expect(
			(await call(owner, "POST", "/messages", { to: "ana", body: "x", conversationId: crid(77) }))
				.status,
		).toBe(404);
		const list = await call(owner, "GET", `/projects/${PC}/conversations`);
		expect(list.body.find((c: { id: string }) => c.id === c1).recipients).toEqual({
			agents: ["ana", "beto"],
		});
	});

	it("the whole team: resolved at send into one row per agent of the project, each marked team", async () => {
		const r = await call(owner, "POST", "/messages", {
			team: true,
			body: "a todos",
			conversationId: c2,
			clientId: "team-0001",
		});
		expect(r.status).toBe(201);
		expect(r.body.messages.map((m: MessageRowT) => [m.to_id, m.team])).toEqual([
			["ana", 1],
			["beto", 1],
			["caro", 1],
		]);
		expect(
			(
				await call(owner, "POST", "/messages", {
					team: true,
					to: "ana",
					body: "x",
					conversationId: c2,
					clientId: "team-0002",
				})
			).body.error,
		).toBe("team-and-to");
		const conv = (await call(owner, "GET", `/conversations/${c2}/feed`)).body.conversation;
		expect(conv.recipients).toEqual({ team: true });
	});

	it("an agent's consult inherits the conversation; the reply stays in it; outside the project it is refused", async () => {
		const m = (await call(as("ana"), "POST", "/runner/claim")).body;
		expect(m).toMatchObject({
			conversation_id: c1,
			conversation: { id: c1, title: "Optimización de CI" },
		});
		const consult = await call(as("ana"), "POST", "/messages", { to: "caro", body: "¿cache?" });
		expect(consult.body).toMatchObject({ conversation_id: c1, project_id: PC, depth: 1 });
		// A recipient of another project: refused, nothing written (never a direct message).
		const count = () =>
			(db.prepare("SELECT COUNT(*) AS n FROM agent_messages").get() as { n: number }).n;
		const before = count();
		const outside = await call(as("ana"), "POST", "/messages", { to: "fuera", body: "privado" });
		expect(outside.status).toBe(409);
		expect(outside.body).toMatchObject({ error: "recipient-other-project", agent: "fuera" });
		expect(outside.body.message).toContain("@fuera no es de este proyecto");
		expect(count()).toBe(before);
		// An agent picks no conversation, team or list.
		expect(
			(await call(as("ana"), "POST", "/messages", { to: "caro", body: "x", conversationId: c2 }))
				.body.error,
		).toBe("conversation-inherited");
		await call(as("ana"), "POST", `/runner/messages/${m.id}/result`, {
			state: "done",
			text: "listo",
		});
		// caro takes the consult (c2's team message is older: it goes first).
		await work("caro");
		const cc = (await call(as("caro"), "POST", "/runner/claim")).body;
		expect(cc.id).toBe(consult.body.id);
		await call(as("caro"), "POST", `/runner/messages/${cc.id}/result`, {
			state: "done",
			text: "sí",
		});
		const reply = db
			.prepare("SELECT * FROM agent_messages WHERE reply_to = ? AND kind = 'reply'")
			.get(cc.id) as Record<string, unknown>;
		expect(reply).toMatchObject({ conversation_id: c1, project_id: PC, to_id: "ana" });
		// Drain ana's queue (c2's team row, caro's reply) for the next tests.
		await work("ana");
		await work("ana");
	});

	it("an interrupted run in a conversation: its notice and its recovery report stay there, linked; review and requeue", async () => {
		const sent = await call(owner, "POST", "/messages", {
			to: "beto",
			body: "deploy",
			conversationId: c1,
		});
		// beto has the c1 multi-post and c2's team message before it.
		await work("beto");
		await work("beto");
		const m = (await call(as("beto"), "POST", "/runner/claim")).body;
		expect(m.id).toBe(sent.body.id);
		await call(as("beto"), "POST", `/runner/messages/${m.id}/result`, {
			state: "uncertain",
			note: "runner restarted",
		});
		const sys = await call(as("beto"), "POST", "/runner/system-message", {
			body: "[st-recovery] …",
			recoveryOf: m.id,
		});
		expect(sys.body).toMatchObject({
			from_id: "system",
			recovery_of: m.id,
			conversation_id: c1,
			project_id: PC,
		});
		await call(as("beto"), "POST", `/runner/messages/${sys.body.id}/result`, {
			state: "done",
			text: "informe: nada hecho",
		});
		// Another agent's message id is not linked: no link, no conversation.
		const foreign = await call(as("beto"), "POST", "/runner/system-message", {
			body: "[st-recovery] …",
			recoveryOf: (
				db
					.prepare(
						"SELECT id FROM agent_messages WHERE to_id = 'ana' AND conversation_id IS NOT NULL",
					)
					.get() as {
					id: number;
				}
			).id,
		});
		expect(foreign.body).toMatchObject({ recovery_of: null, conversation_id: null });
		await call(as("beto"), "POST", `/runner/messages/${foreign.body.id}/result`, {
			state: "done",
			text: ".",
		});
		const inbox = await call(owner, "GET", "/inbox");
		expect(inbox.body.action.interrupted.map((x: MessageRowT) => x.id)).toContain(m.id);
		expect(inbox.body.reports.find((x: MessageRowT) => x.recovery_of === m.id).result_text).toBe(
			"informe: nada hecho",
		);
		const before = inbox.body.count;
		const conv = (await call(owner, "GET", `/projects/${PC}/conversations`)).body.find(
			(c: { id: string }) => c.id === c1,
		);
		expect(conv.needsAction).toBe(true);
		// Reviewed: out of the inbox, still uncertain, nothing new written.
		const rows = (db.prepare("SELECT COUNT(*) AS n FROM agent_messages").get() as { n: number }).n;
		const rv = await call(owner, "POST", `/messages/${m.id}/review`);
		expect(rv.body).toMatchObject({ state: "uncertain" });
		expect(rv.body.reviewed_at).toBeTruthy();
		expect((db.prepare("SELECT COUNT(*) AS n FROM agent_messages").get() as { n: number }).n).toBe(
			rows,
		);
		expect((await call(owner, "GET", "/inbox")).body.count).toBe(before - 1);
		expect((await call(owner, "POST", `/messages/${sys.body.id}/review`)).status).toBe(409);
		expect((await call(as("beto"), "POST", `/messages/${m.id}/review`)).status).toBe(403);
		// A requeue clears the review: interrupted again, it needs a new one.
		await call(owner, "POST", `/messages/${m.id}/requeue`);
		expect(row(m.id).reviewed_at).toBeNull();
		const again = (await call(as("beto"), "POST", "/runner/claim")).body;
		expect(again.id).toBe(m.id);
		await call(as("beto"), "POST", `/runner/messages/${m.id}/result`, {
			state: "uncertain",
			note: "otra vez",
		});
		expect(
			(await call(owner, "GET", "/inbox")).body.action.interrupted.map((x: MessageRowT) => x.id),
		).toContain(m.id);
		await call(owner, "POST", `/messages/${m.id}/review`);
	});

	it("a question to the person is in the conversation of its message, in the inbox, and in the agent's state", async () => {
		const sent = await call(owner, "POST", "/messages", {
			to: "caro",
			body: "elegí",
			conversationId: c2,
		});
		// caro: c2 team message was done by work(); this one is next.
		const m = (await call(as("caro"), "POST", "/runner/claim")).body;
		expect(m.id).toBe(sent.body.id);
		const q = await call(as("caro"), "POST", "/runner/questions", {
			messageId: m.id,
			request: { message: "¿A o B?" },
		});
		const feed = await call(owner, "GET", `/conversations/${c2}/feed`);
		expect(feed.body.questions.map((x: { id: number }) => x.id)).toContain(q.body.id);
		expect((await call(owner, "GET", `/conversations/${c1}/feed`)).body.questions).toEqual([]);
		const inbox = await call(owner, "GET", "/inbox");
		expect(
			inbox.body.action.questions.find((x: { id: number }) => x.id === q.body.id),
		).toMatchObject({
			conversation_id: c2,
			project_id: PC,
		});
		const caro = feed.body.agents.find((a: { name: string }) => a.name === "caro");
		expect(caro).toMatchObject({
			waitingInput: true,
			question: { id: q.body.id, messageId: m.id, conversationId: c2 },
			runningIn: [{ id: m.id, conversationId: c2, work: null }],
		});
		await call(owner, "POST", `/questions/${q.body.id}/answer`, {
			action: "accept",
			content: { x: "A" },
		});
		await call(as("caro"), "POST", `/runner/questions/${q.body.id}/delivered`);
		await call(as("caro"), "POST", `/runner/messages/${m.id}/result`, { state: "done", text: "A" });
	});

	it("agents' state: queue with conversation, and the requests it waits on", async () => {
		const busy = await call(owner, "POST", "/messages", {
			to: "beto",
			body: "largo",
			conversationId: c1,
		});
		const queued = await call(owner, "POST", "/messages", {
			to: "beto",
			body: "después",
			conversationId: c2,
		});
		const m = (await call(as("beto"), "POST", "/runner/claim")).body;
		expect(m.id).toBe(busy.body.id);
		const ask = await call(as("beto"), "POST", "/messages", { to: "ana", body: "¿dato?" });
		const agents = (await call(owner, "GET", "/agents")).body as Array<Record<string, unknown>>;
		expect(agents.find((a) => a.name === "beto")).toMatchObject({
			runningIn: [{ id: busy.body.id, conversationId: c1, work: null }],
			queue: [{ id: queued.body.id, conversationId: c2, work: null }],
			pending: 1,
			waitingFor: [{ id: ask.body.id, agent: "ana", conversationId: c1, work: null }],
		});
		await call(as("beto"), "POST", `/runner/messages/${m.id}/result`, {
			state: "done",
			text: "ok",
		});
		await work("ana");
		expect(
			(await call(owner, "GET", "/agents")).body.find((a: { name: string }) => a.name === "beto")
				.waitingFor,
		).toEqual([]);
		await work("beto"); // the reply
		await work("beto"); // the queued one
	});

	it("isolation: a conversation's feed shows only it; the Archive feeds show no conversation", async () => {
		const legacy = await call(owner, "POST", "/messages", {
			to: "ana",
			body: "viejo chat",
			projectId: PC,
		});
		expect(legacy.body.conversation_id).toBeNull();
		const f1 = (await call(owner, "GET", `/conversations/${c1}/feed`)).body
			.messages as MessageRowT[];
		const f2 = (await call(owner, "GET", `/conversations/${c2}/feed`)).body
			.messages as MessageRowT[];
		expect(f1.length).toBeGreaterThan(0);
		expect(f1.every((m) => m.conversation_id === c1)).toBe(true);
		expect(f2.every((m) => m.conversation_id === c2)).toBe(true);
		const pf = (await call(owner, "GET", `/projects/${PC}/feed`)).body.messages as MessageRowT[];
		expect(pf.map((m) => m.id)).toEqual([legacy.body.id]);
		const af = (await call(owner, "GET", "/agents/ana/feed")).body.messages as MessageRowT[];
		expect(af.every((m) => m.conversation_id === null)).toBe(true);
		expect(af.map((m) => m.id)).toContain(legacy.body.id);
		// Another owner sees nothing of it.
		expect((await call({ user: OTHER }, "GET", `/conversations/${c1}/feed`)).status).toBe(404);
		expect((await call({ user: OTHER }, "GET", `/projects/${PC}/conversations`)).status).toBe(404);
		expect(
			(
				await call({ user: OTHER }, "POST", `/conversations/${c1}/read`, {
					at: new Date().toISOString(),
				})
			).status,
		).toBe(404);
		await work("ana");
	});

	it("read state: unseen = others' rows and the person's results after read_at; it only advances; results are listed until seen", async () => {
		const c3 = (await newConv(3, "Lectura")).body.id as string;
		const sent = await call(owner, "POST", "/messages", {
			to: "caro",
			body: "calculá",
			conversationId: c3,
		});
		const listed = async () =>
			(await call(owner, "GET", `/projects/${PC}/conversations`)).body.find(
				(c: { id: string }) => c.id === c3,
			);
		expect((await listed()).unread).toBe(0);
		// The person reads (their own message) BEFORE the result exists.
		const t0 = new Date().toISOString();
		expect((await call(owner, "POST", `/conversations/${c3}/read`, { at: t0 })).body.readAt).toBe(
			t0,
		);
		await new Promise((ok) => setTimeout(ok, 5));
		const m = (await call(as("caro"), "POST", "/runner/claim")).body;
		await call(as("caro"), "POST", `/runner/messages/${m.id}/result`, {
			state: "done",
			text: "42",
		});
		expect(m.id).toBe(sent.body.id);
		// The result is unseen although its row is older than the read mark.
		expect((await listed()).unread).toBe(1);
		const inbox = await call(owner, "GET", "/inbox");
		expect(inbox.body.results.map((x: MessageRowT) => x.id)).toContain(m.id);
		const fin = row(m.id).finished_at as string;
		await call(owner, "POST", `/conversations/${c3}/read`, { at: fin });
		expect((await listed()).unread).toBe(0);
		expect(
			(await call(owner, "GET", "/inbox")).body.results.map((x: MessageRowT) => x.id),
		).not.toContain(m.id);
		// Never backwards; a bad time is refused.
		expect((await call(owner, "POST", `/conversations/${c3}/read`, { at: t0 })).body.readAt).toBe(
			fin,
		);
		expect(
			(await call(owner, "POST", `/conversations/${c3}/read`, { at: "ayer" })).body.error,
		).toBe("invalid-at");
		// last_activity_at moved with the result.
		expect((await listed()).lastActivityAt).toBe(fin);
	});

	it("rename, archive: an archived conversation leaves the list and takes no post; works record their conversation", async () => {
		expect(
			(await call(owner, "PATCH", `/conversations/${c2}`, { title: "Diseño v2" })).body.title,
		).toBe("Diseño v2");
		const a = await call(owner, "POST", `/conversations/${c2}/archive`);
		expect(a.body.archivedAt).toBeTruthy();
		const live = (await call(owner, "GET", `/projects/${PC}/conversations`)).body.map(
			(c: { id: string }) => c.id,
		);
		expect(live).not.toContain(c2);
		const arch = (await call(owner, "GET", `/projects/${PC}/conversations?archived=1`)).body.map(
			(c: { id: string }) => c.id,
		);
		expect(arch).toEqual([c2]);
		expect(
			(await call(owner, "POST", "/messages", { to: "ana", body: "x", conversationId: c2 })).body
				.error,
		).toBe("conversation-archived");
		// A work created by the person from a conversation.
		await call(owner, "PATCH", "/agents/ana", { maxConcurrency: 2 });
		const w = await call(owner, "POST", "/works", {
			agent: "ana",
			id: "conv-work",
			conversationId: c1,
		});
		expect(w.status).toBe(201);
		expect(w.body.conversationId).toBe(c1);
		expect(
			(await call(owner, "POST", "/works", { agent: "fuera", id: "conv-w2", conversationId: c1 }))
				.body.error,
		).toBe("not-in-project");
		// A work and a conversation on one message: both are kept.
		const both = await call(owner, "POST", "/messages", {
			to: "ana",
			body: "en el trabajo",
			conversationId: c1,
			work: "conv-work",
		});
		expect(both.body).toMatchObject({ conversation_id: c1, context: "conv-work" });
	});

	it("a run with no conversation keeps the old rule: a recipient of another project gets it direct", async () => {
		const sent = await call(owner, "POST", "/messages", {
			to: "ana",
			body: "archivo",
			projectId: PC,
		});
		expect(sent.body).toMatchObject({ conversation_id: null, project_id: PC });
		const m = (await call(as("ana"), "POST", "/runner/claim")).body;
		expect(m.id).toBe(sent.body.id);
		const inside = await call(as("ana"), "POST", "/messages", { to: "caro", body: "x" });
		expect(inside.body).toMatchObject({ conversation_id: null, project_id: PC });
		const outside = await call(as("ana"), "POST", "/messages", { to: "fuera", body: "privado" });
		expect(outside.status).toBe(201);
		expect(outside.body).toMatchObject({ conversation_id: null, project_id: null });
		await call(as("ana"), "POST", `/runner/messages/${m.id}/result`, { state: "done", text: "." });
	});

	it("a consult inside the project whose run is interrupted: the unfinished notice stays in the conversation", async () => {
		const sent = await call(owner, "POST", "/messages", {
			to: "ana",
			body: "revisá con beto",
			conversationId: c1,
		});
		const m = (await call(as("ana"), "POST", "/runner/claim")).body;
		expect(m.id).toBe(sent.body.id);
		const consult = await call(as("ana"), "POST", "/messages", { to: "beto", body: "¿estado?" });
		expect(consult.body).toMatchObject({ conversation_id: c1, project_id: PC });
		// beto may have older messages queued: run them first.
		let b = (await call(as("beto"), "POST", "/runner/claim")).body;
		while (b.id !== consult.body.id) {
			await call(as("beto"), "POST", `/runner/messages/${b.id}/result`, {
				state: "done",
				text: ".",
			});
			b = (await call(as("beto"), "POST", "/runner/claim")).body;
		}
		await call(as("beto"), "POST", `/runner/messages/${b.id}/result`, {
			state: "uncertain",
			note: "corte",
		});
		const notice = db
			.prepare("SELECT * FROM agent_messages WHERE reply_to = ? AND note = 'unfinished:uncertain'")
			.get(consult.body.id) as Record<string, unknown>;
		expect(notice).toMatchObject({ conversation_id: c1, project_id: PC, to_id: "ana" });
		await call(as("ana"), "POST", `/runner/messages/${m.id}/result`, { state: "done", text: "." });
	});
});

describe("D1 reads: the hot reads go by index, never through the owner's whole history (v28)", () => {
	// Enough rows that the plan is not the one of a near-empty table, and
	// ANALYZE so the planner has the statistics D1 would have.
	const PD = "p-d1";
	const convs: string[] = [];
	const cid = (n: number) => `d1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

	beforeAll(() => {
		db.prepare(
			"INSERT INTO projects (project_id, owner_user_id, name, client_request_id, request_hash) VALUES (?, ?, 'D1', 'c-d1', 'h')",
		).run(PD, OWNER);
		const conv = db.prepare(
			"INSERT INTO conversations (id, owner_user_id, project_id, title, client_request_id, request_hash, read_at) VALUES (?, ?, ?, ?, ?, 'h', ?)",
		);
		const msg = db.prepare(
			`INSERT INTO agent_messages (owner_user_id, from_id, to_id, kind, body, state, project_id, conversation_id,
				created_at, finished_at, result_text, reviewed_at)
			 VALUES (?, ?, ?, 'request', 'x', ?, ?, ?, ?, ?, ?, ?)`,
		);
		const q = db.prepare(
			"INSERT INTO agent_questions (owner_user_id, agent, message_id, request, state) VALUES (?, 'ana', ?, '{}', ?)",
		);
		const t = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
		const QSTATES = ["delivered", "orphaned", "withdrawn", "delivered", "answered", "delivered"];
		let i = 0;
		for (let n = 1; n <= 30; n++) {
			const id = cid(n);
			convs.push(id);
			// Most topics read up to their end; a few never read.
			conv.run(id, OWNER, PD, `T${n}`, `cr-d1-${n}`, n % 10 === 0 ? null : t(1_000_000));
			for (let k = 0; k < 40; k++, i++) {
				const mine = k % 2 === 0;
				const state = k === 7 ? "uncertain" : "done";
				const r = msg.run(
					OWNER,
					mine ? "owner" : "ana",
					mine ? "ana" : "beto",
					state,
					PD,
					id,
					t(i),
					t(i + 1),
					mine ? "r" : null,
					state === "uncertain" ? t(i + 2) : null,
				);
				// Questions as they accumulate: almost all closed, in every closed state.
				if (k % 8 === 1) q.run(OWNER, Number(r.lastInsertRowid), QSTATES[(n + k) % QSTATES.length]);
			}
		}
		const anyMsg = (db.prepare("SELECT MAX(id) AS id FROM agent_messages").get() as { id: number })
			.id;
		q.run(OWNER, anyMsg, "open");
		// The Archive: project posts and direct messages outside any conversation.
		for (let k = 0; k < 300; k++, i++)
			msg.run(OWNER, "owner", "solo", "done", k % 2 ? PD : null, null, t(i), t(i + 1), "r", null);
	});

	type Plan = { sql: string; plan: string[] };
	async function plansOf(fn: () => Promise<unknown>): Promise<Plan[]> {
		const got: Array<{ sql: string; params: unknown[] }> = [];
		captured = got;
		try {
			await fn();
		} finally {
			captured = null;
		}
		const plans = got.map((s) => ({
			sql: s.sql.replace(/\s+/g, " ").trim(),
			plan: (
				db.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).all(...bindOf(s.params)) as Array<{
					detail: string;
				}>
			).map((r) => r.detail),
		}));
		// D1_PLAN_DUMP=1 prints every plan (what the PR shows before/after).
		if (process.env.D1_PLAN_DUMP)
			for (const p of plans) console.log(`${p.sql}\n  ${p.plan.join("\n  ")}\n`);
		return plans;
	}
	// A whole-table read of the messages or questions, one bounded only by the
	// owner — what grows with every message the owner ever sent — or a whole
	// topic's history (owner + conversation and nothing else). The partial
	// index of unreviewed runs is bounded by its own predicate; a scan of the
	// conversations (`c`) is bounded by the topics, not by the messages.
	const OWNER_ONLY =
		/^SEARCH \w+ USING (?:COVERING )?INDEX idx_agent_(?:messages|questions)_(?!unreviewed)\w+ \(owner_user_id=\?\)$/;
	const WHOLE_TOPIC =
		/USING (?:COVERING )?INDEX idx_agent_messages_(?!unreviewed)\w+ \(owner_user_id=\? AND conversation_id=\?\)$/;
	const SCAN = /^SCAN (?!json_each\b|\(subquery-|c$)/;
	function expectBounded(plans: Plan[]) {
		expect(plans.length).toBeGreaterThan(0);
		const bad = plans.flatMap((p) =>
			p.plan
				.filter((l) => OWNER_ONLY.test(l) || WHOLE_TOPIC.test(l) || SCAN.test(l))
				.map((l) => `${l}  ←  ${p.sql}`),
		);
		expect(bad).toEqual([]);
	}

	it("v28 is recorded", () => {
		expect(db.prepare("SELECT 1 FROM schema_migrations WHERE version = 28").get()).toBeTruthy();
	});

	it("GET /messages (st): everything to or from the calling agent, any scope", async () => {
		const r = await call(as("solo"), "GET", "/messages");
		expect(r.body.length).toBeGreaterThan(0);
		expect(r.body.every((m: MessageRowT) => m.to_id === "solo" || m.from_id === "solo")).toBe(true);
		const older = await call(as("solo"), "GET", `/messages?before=${r.body[0].id}`);
		expect(older.body.every((m: MessageRowT) => m.id < r.body[0].id)).toBe(true);
	});

	it("the three feeds answer their page ascending, cut at the newest 100 before `before`", async () => {
		const ids = (where: string, params: unknown[], before: number) =>
			(
				db
					.prepare(
						`SELECT id FROM agent_messages WHERE owner_user_id = ? AND ${where} AND id < ? ORDER BY id DESC LIMIT 100`,
					)
					.all(OWNER, ...bindOf(params), before) as Array<{ id: number }>
			)
				.map((r) => r.id)
				.reverse();
		const feeds = [
			[`/conversations/${convs[3]}/feed`, "conversation_id = ?", [convs[3]]],
			[`/projects/${PD}/feed`, "conversation_id IS NULL AND project_id = ?", [PD]],
			[
				"/agents/solo/feed",
				"conversation_id IS NULL AND (to_id = ? OR from_id = ?)",
				["solo", "solo"],
			],
		] as const;
		for (const [path, where, params] of feeds) {
			const first = ids(where, params, Number.MAX_SAFE_INTEGER);
			const got = (await call(owner, "GET", path)).body.messages.map((m: MessageRowT) => m.id);
			expect(got).toEqual(first);
			const before = first[Math.floor(first.length / 2)];
			const older = (await call(owner, "GET", `${path}?before=${before}`)).body.messages;
			expect(older.map((m: MessageRowT) => m.id)).toEqual(ids(where, params, before));
		}
	});

	it("a conversation's feed keeps to its page the questions read by the page's id range", async () => {
		const [mine, other] = [cid(901), cid(902)];
		for (const [id, n] of [
			[mine, 901],
			[other, 902],
		] as const)
			db.prepare(
				"INSERT INTO conversations (id, owner_user_id, project_id, title, client_request_id, request_hash) VALUES (?, ?, ?, 'Q', ?, 'h')",
			).run(id, OWNER, PD, `cr-d1-${n}`);
		const post = (conv: string) =>
			Number(
				db
					.prepare(
						"INSERT INTO agent_messages (owner_user_id, from_id, to_id, kind, body, state, project_id, conversation_id) VALUES (?, 'owner', 'ana', 'request', 'x', 'done', ?, ?)",
					)
					.run(OWNER, PD, conv).lastInsertRowid,
			);
		const ask = (messageId: number) =>
			Number(
				db
					.prepare(
						"INSERT INTO agent_questions (owner_user_id, agent, message_id, request, state) VALUES (?, 'ana', ?, '{}', 'delivered')",
					)
					.run(OWNER, messageId).lastInsertRowid,
			);
		const first = post(mine);
		const foreign = ask(post(other)); // inside [first, last] of the page
		const own = ask(post(mine));
		const r = await call(owner, "GET", `/conversations/${mine}/feed`);
		expect(r.body.messages.map((m: MessageRowT) => m.id)[0]).toBe(first);
		const got = r.body.questions.map((q: { id: number }) => q.id);
		expect(got).not.toContain(foreign);
		expect(got).toEqual([own]);
	});

	// The same plans with no statistics (D1 as deployed: nobody runs ANALYZE)
	// and with them (were D1 to run PRAGMA optimize): neither may change them.
	describe.each([
		["without statistics", false],
		["after ANALYZE", true],
	])("%s", (_label, analyze) => {
		beforeAll(() => {
			if (analyze) db.exec("ANALYZE");
			else
				expect(
					db.prepare("SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'").get(),
				).toBeUndefined();
		});

		it("a conversation's feed reads its messages by idx_agent_messages_conversation, with and without ?before=", async () => {
			for (const q of ["", "?before=500"]) {
				const plans = await plansOf(async () => {
					const r = await call(owner, "GET", `/conversations/${convs[3]}/feed${q}`);
					expect(r.status).toBe(200);
					expect(r.body.messages.length).toBeGreaterThan(0);
				});
				const page = plans.find((p) =>
					/^SELECT \* FROM agent_messages INDEXED BY idx_agent_messages_conversation/.test(p.sql),
				);
				expect(page?.plan.join("\n")).toMatch(
					/SEARCH agent_messages USING INDEX idx_agent_messages_conversation \(owner_user_id=\? AND conversation_id=\? AND id<\?\)/,
				);
				expectBounded(plans);
			}
		});

		it("the Archive feeds read only what belongs to no conversation", async () => {
			for (const path of [`/projects/${PD}/feed`, "/agents/solo/feed"]) {
				const plans = await plansOf(async () => {
					expect((await call(owner, "GET", path)).status).toBe(200);
				});
				const page = plans.find((p) =>
					/^SELECT \* FROM agent_messages INDEXED BY idx_agent_messages_conversation/.test(p.sql),
				);
				expect(page?.plan.join("\n")).toMatch(
					/idx_agent_messages_conversation \(owner_user_id=\? AND conversation_id=\? AND id<\?\)/,
				);
			}
		});

		it("an agent's page (st list, GET /messages?agent=) is two ranges bounded by the page, by to_id and by from_id", async () => {
			for (const who of [as("solo"), owner]) {
				for (const q of ["", "?before=500"]) {
					const path = "user" in who ? `/messages?agent=ana${q}` : `/messages${q}`;
					const plans = await plansOf(async () => {
						expect((await call(who, "GET", path)).status).toBe(200);
					});
					const page = plans.find((p) => /UNION/.test(p.sql));
					const lines = page?.plan.join("\n") ?? "";
					expect(lines).toMatch(
						/idx_agent_messages_to \(owner_user_id=\? AND to_id=\? AND id<\?\)/,
					);
					expect(lines).toMatch(
						/idx_agent_messages_from \(owner_user_id=\? AND from_id=\? AND id<\?\)/,
					);
					expectBounded(plans);
				}
			}
		});

		it("a request's reply is found by reply_to, not through the owner's history", () => {
			for (const sql of [
				"SELECT * FROM agent_messages WHERE owner_user_id = ? AND reply_to = ? AND kind = 'reply'",
				`SELECT 1 FROM agent_messages m WHERE m.owner_user_id = ? AND m.id = ? AND NOT EXISTS (SELECT 1 FROM agent_messages x
					WHERE x.owner_user_id = m.owner_user_id AND x.reply_to = m.id AND x.kind = 'reply' AND x.note = 'unfinished:' || m.state)`,
			]) {
				const plan = (
					db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(OWNER, 1) as Array<{ detail: string }>
				).map((r) => r.detail);
				expect(plan.join("\n")).toMatch(
					/idx_agent_messages_reply \(owner_user_id=\? AND reply_to=\?\)/,
				);
			}
		});

		it("the topic list, the inbox and /agents read no owner-wide range of messages or questions", async () => {
			for (const path of [`/projects/${PD}/conversations`, "/inbox", "/agents"]) {
				const plans = await plansOf(async () => {
					expect((await call(owner, "GET", path)).status).toBe(200);
				});
				expectBounded(plans);
			}
		});
	});

	it("definitive deletion (#13): a topic and the Archive are deleted by index, never by a scan", async () => {
		const topic = convs[0];
		db.prepare(
			"UPDATE agent_questions SET state = 'delivered' WHERE message_id IN (SELECT id FROM agent_messages WHERE conversation_id = ?)",
		).run(topic);
		db.prepare(
			"UPDATE conversations SET archived_at = '2026-01-02T00:00:00.000Z' WHERE id = ?",
		).run(topic);
		for (const [path, status] of [
			[`/conversations/${topic}`, 204],
			[`/projects/${PD}/archive`, 200],
			["/agents/solo/archive", 200],
		] as const) {
			const plans = await plansOf(async () => {
				expect((await call(owner, "DELETE", path)).status).toBe(status);
			});
			expect(plans.some((p) => /^DELETE/.test(p.sql))).toBe(true);
			const all = plans.flatMap((p) => p.plan).join("\n");
			if (path.endsWith(`${PD}/archive`)) expect(all).toMatch(/idx_agent_messages_project/);
			if (path.startsWith("/agents/")) {
				expect(all).toMatch(/idx_agent_messages_to \(owner_user_id=\? AND to_id=\?\)/);
				expect(all).toMatch(/idx_agent_messages_from \(owner_user_id=\? AND from_id=\?\)/);
			}
			// Deleting a topic walks that topic (that is the point), nothing wider.
			// The works (`w`: a few rows per agent, never messages) may be scanned.
			const bad = plans.flatMap((p) =>
				p.plan
					.filter(
						(l) =>
							OWNER_ONLY.test(l) || (SCAN.test(l) && l !== "SCAN CONSTANT ROW" && l !== "SCAN w"),
					)
					.map((l) => `${l}  ←  ${p.sql}`),
			);
			expect(bad).toEqual([]);
		}
		expect(
			db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE conversation_id = ?").get(topic),
		).toEqual({ n: 0 });
	});
});

describe("ACP tasks (v29)", () => {
	const PT = "p-t";
	const SIDS: Record<string, string> = {
		coord: "e0000000-0000-4000-8000-000000000001",
		dev2: "e0000000-0000-4000-8000-000000000002",
		qa2: "e0000000-0000-4000-8000-000000000003",
		lejos: "e0000000-0000-4000-8000-000000000004",
	};
	let conv: string;
	const task = (who: Who, id: number) => call(who, "GET", `/tasks/${id}`);
	const patch = (who: Who, id: number, body: Record<string, unknown>) =>
		call(who, "PATCH", `/tasks/${id}`, body);
	const version = async (id: number) => (await task(owner, id)).body.task.version as number;
	/** The person posts to the whole team of PT; every agent named claims its row. */
	async function teamRequest(clientId: string, claimers: string[]) {
		// Whatever earlier cases left in their queues first: the claim takes the oldest.
		// (Finishing a consult queues its reply to the asker: until all are empty.)
		for (let busy = true; busy; ) {
			busy = false;
			for (const a of Object.keys(SIDS)) {
				await finish(a);
				while ((await call(as(a), "POST", "/runner/claim")).status === 200) {
					busy = true;
					await finish(a);
				}
			}
		}
		const r = await call(owner, "POST", "/messages", {
			team: true,
			body: "armen el plan",
			conversationId: conv,
			clientId,
		});
		expect(r.status).toBe(201);
		for (const a of claimers) expect((await call(as(a), "POST", "/runner/claim")).status).toBe(200);
		return r.body.messages as MessageRowT[];
	}
	async function finish(agent: string) {
		const run = await call(as(agent), "GET", "/runner/running");
		if (run.status === 200)
			await call(as(agent), "POST", `/runner/messages/${run.body.id}/result`, {
				state: "done",
				text: "ok",
			});
	}

	beforeAll(async () => {
		db.prepare(
			"INSERT INTO projects (project_id, owner_user_id, name, client_request_id, request_hash) VALUES (?, ?, 'Tareas', 'c-pt', 'h')",
		).run(PT, OWNER);
		for (const [name, sid] of Object.entries(SIDS)) {
			db.prepare(
				"INSERT INTO sessions (session_id, user_id, name, container_name, status) VALUES (?, ?, ?, ?, 'running')",
			).run(sid, OWNER, name, `st-${sid.slice(0, 12)}`);
			const a = await acp.create(sid, OWNER, name, { projectId: name === "lejos" ? "p-2" : PT });
			tokens[name] = acp.tokenFor(a.agent_id);
		}
		conv = (
			await call(owner, "POST", "/conversations", {
				projectId: PT,
				title: "Plan",
				clientRequestId: "f0000000-0000-4000-8000-000000000001",
			})
		).body.id;
	});

	it("v29 is recorded; two agents given the same team request get ONE goal, coordinated by the first", async () => {
		expect(db.prepare("SELECT 1 FROM schema_migrations WHERE version = 29").get()).toBeTruthy();
		await teamRequest("team-goal-0001", ["coord", "dev2"]);
		const first = await call(as("coord"), "POST", "/tasks", { goal: true, title: "Optimizar CI" });
		expect(first.status).toBe(201);
		expect(first.body).toMatchObject({
			parentId: null,
			coordinator: "coord",
			projectId: PT,
			conversationId: conv,
			originKey: "c:team-goal-0001",
			status: "todo",
			version: 1,
			existing: false,
			budget: { limit: 150, used: 0 },
		});
		const second = await call(as("dev2"), "POST", "/tasks", { goal: true, title: "Otro título" });
		expect(second.status).toBe(200);
		expect(second.body).toMatchObject({ id: first.body.id, coordinator: "coord", existing: true });
		// The person naming one of the request's rows reaches the same goal.
		const row = db
			.prepare("SELECT id FROM agent_messages WHERE client_id = 'team-goal-0001' AND to_id = 'qa2'")
			.get() as { id: number };
		const mine = await call(owner, "POST", "/tasks", {
			projectId: PT,
			title: "x",
			originMessageId: row.id,
		});
		expect(mine.body).toMatchObject({ id: first.body.id, existing: true });
		expect(
			(
				db
					.prepare("SELECT COUNT(*) AS n FROM tasks WHERE origin_key = 'c:team-goal-0001'")
					.get() as { n: number }
			).n,
		).toBe(1);
		await finish("coord");
		await finish("dev2");
	});

	it("concurrent goal creations for one request: one created, the other gets it", async () => {
		await teamRequest("team-goal-0002", ["coord", "dev2"]);
		const both = await Promise.all(
			["coord", "dev2"].map((a) => call(as(a), "POST", "/tasks", { goal: true, title: `de ${a}` })),
		);
		expect(both.map((r) => r.status).sort()).toEqual([200, 201]);
		expect(new Set(both.map((r) => r.body.id)).size).toBe(1);
		await finish("coord");
		await finish("dev2");
	});

	it("an agent's goal needs a running message; the origin is never an argument", async () => {
		const r = await call(as("coord"), "POST", "/tasks", { goal: true, title: "sin mensaje" });
		expect(r.status).toBe(409);
		expect(r.body.error).toBe("execution-ended");
		expect(
			(await call(as("coord"), "POST", "/tasks", { title: "t", originMessageId: 1 })).body.error,
		).toBe("computed-by-backend");
		for (const [m, path, body] of [
			["POST", "/tasks", { title: "t" }],
			["GET", "/tasks", undefined],
			["GET", "/tasks/1", undefined],
			["PATCH", "/tasks/1", { version: 1, status: "doing" }],
		] as const) {
			const r = await call(as("solo"), m, path, body);
			expect([r.status, r.body.error]).toEqual([409, "no-project"]);
		}
	});

	let goal: number;
	let child: number;
	it("children: one level, created by the coordinator or the person", async () => {
		goal = (await call(as("coord"), "POST", "/tasks", { title: "Objetivo suelto" })).body.id;
		const c = await call(as("coord"), "POST", "/tasks", {
			parentId: goal,
			title: "Medir tiempos",
			assignee: "@dev2",
			reviewer: "qa2",
			priority: "high",
		});
		expect(c.status).toBe(201);
		expect(c.body).toMatchObject({
			parentId: goal,
			assignee: "dev2",
			reviewer: "qa2",
			coordinator: null,
			budget: null,
		});
		child = c.body.id;
		expect(
			(await call(as("dev2"), "POST", "/tasks", { parentId: goal, title: "x" })).body.error,
		).toBe("not-coordinator");
		const grand = await call(as("coord"), "POST", "/tasks", { parentId: child, title: "nieta" });
		expect(grand.status).toBe(400);
		expect(grand.body.error).toBe("one-level");
		expect(
			(await call(owner, "POST", "/tasks", { parentId: goal, title: "de la persona" })).status,
		).toBe(201);
		expect(
			(await call(as("coord"), "POST", "/tasks", { parentId: goal, title: "x", assignee: "lejos" }))
				.body,
		).toMatchObject({
			error: "not-in-project",
		});
		// The statement itself refuses a grandchild, whatever the caller checked.
		expect(() =>
			db
				.prepare(
					"INSERT INTO tasks (owner_user_id, project_id, parent_id, title, created_by, updated_by, coordinator) VALUES (?, ?, ?, 't', 'x', 'x', 'x')",
				)
				.run(OWNER, PT, child),
		).toThrow(/CHECK/);
	});

	it("the matrix: the assignee moves and blocks its task, the coordinator assigns; nobody else", async () => {
		let v = await version(child);
		const moved = await patch(as("dev2"), child, { version: v, status: "doing" });
		expect(moved.status).toBe(200);
		expect(moved.body).toMatchObject({ status: "doing", version: v + 1, updatedBy: "dev2" });
		v++;
		expect((await patch(as("coord"), child, { version: v, status: "review" })).body).toMatchObject({
			error: "not-allowed",
			need: "assignee",
		});
		expect((await patch(as("dev2"), child, { version: v, priority: "low" })).body).toMatchObject({
			error: "not-allowed",
			need: "coordinator",
		});
		expect((await patch(as("qa2"), child, { version: v, blockedReason: "x" })).status).toBe(403);
		expect(
			(await patch(as("dev2"), child, { version: v, blockedReason: "espera el runner" })).status,
		).toBe(200);
		v++;
		expect(
			(await patch(as("dev2"), child, { version: v, blockedReason: null })).body.blockedReason,
		).toBeNull();
		v++;
		expect((await patch(as("coord"), child, { version: v, priority: "normal" })).status).toBe(200);
		expect((await patch(as("dev2"), child, { version: v + 1 })).body.error).toBe(
			"nothing-to-change",
		);
		expect((await patch(as("dev2"), child, { status: "todo" })).body.error).toBe(
			"version-required",
		);
	});

	it("done: never the assignee; the reviewer, the coordinator (not assignee) or the person", async () => {
		let v = await version(child);
		expect((await patch(as("dev2"), child, { version: v, status: "review" })).status).toBe(200);
		v++;
		const self = await patch(as("dev2"), child, { version: v, status: "done" });
		expect(self.status).toBe(403);
		expect(self.body.error).toBe("self-approval");
		const ok = await patch(as("qa2"), child, { version: v, status: "done" });
		expect(ok.status).toBe(200);
		expect(ok.body).toMatchObject({ status: "done", doneBy: "qa2" });
		expect(ok.body.doneAt).toBeTruthy();
		v++;
		// Reopening is an approver's too; the assignee cannot undo it.
		expect((await patch(as("dev2"), child, { version: v, status: "doing" })).body.error).toBe(
			"self-approval",
		);
		const reopened = await patch(as("coord"), child, { version: v, status: "doing" });
		expect(reopened.body).toMatchObject({ status: "doing", doneAt: null, doneBy: null });
		v++;
		// The coordinator assigned to its own task cannot approve it.
		const own = (
			await call(as("coord"), "POST", "/tasks", { parentId: goal, title: "mía", assignee: "coord" })
		).body;
		expect(
			(await patch(as("coord"), own.id, { version: own.version, status: "done" })).body.error,
		).toBe("self-approval");
		// Nor by reassigning it away in the same write.
		expect(
			(await patch(as("coord"), own.id, { version: own.version, status: "done", assignee: "dev2" }))
				.body.error,
		).toBe("self-approval");
		// Nor by reassigning it away first and approving it in a later write.
		const away = await patch(as("coord"), own.id, { version: own.version, assignee: "dev2" });
		expect(away.status).toBe(200);
		expect(
			(await patch(as("coord"), own.id, { version: away.body.version, status: "done" })).body.error,
		).toBe("self-approval");
		expect(
			(await patch(owner, own.id, { version: away.body.version, status: "done" })).body.doneBy,
		).toBe("owner");
	});

	it("concurrency: a write decided on an old version is refused with the current row", async () => {
		const v = await version(child);
		const [a, b] = await Promise.all([
			patch(as("coord"), child, { version: v, priority: "high" }),
			patch(as("coord"), child, { version: v, priority: "low" }),
		]);
		const statuses = [a.status, b.status].sort();
		expect(statuses).toEqual([200, 409]);
		const lost = a.status === 409 ? a : b;
		const won = a.status === 200 ? a : b;
		expect(lost.body.error).toBe("stale");
		expect(lost.body.task).toMatchObject({ version: v + 1, priority: won.body.priority });
		expect((await patch(as("coord"), child, { version: v, title: "viejo" })).status).toBe(409);
	});

	it("another project's task is the same 404 as a missing one, on every route", async () => {
		for (const id of [child, 999_999]) {
			expect((await task(as("lejos"), id)).body).toEqual({ error: "task-not-found" });
			expect((await patch(as("lejos"), id, { version: 1, status: "doing" })).body).toEqual({
				error: "task-not-found",
			});
			expect(
				(
					await call(as("lejos"), "POST", `/tasks/${id}/links`, {
						version: 1,
						kind: "pr",
						ref: "1",
					})
				).body,
			).toEqual({ error: "task-not-found" });
		}
		expect((await call(as("lejos"), "GET", `/tasks?projectId=${PT}`)).status).toBe(404);
		expect((await call(as("lejos"), "POST", "/tasks", { parentId: goal, title: "x" })).status).toBe(
			404,
		);
		expect((await call({ user: OTHER }, "GET", `/tasks/${child}`)).status).toBe(404);
		expect((await call({ user: OTHER }, "GET", `/tasks?projectId=${PT}`)).status).toBe(404);
	});

	it("links: dependencies by the coordinator, work/pr/external by the assignee; versioned; one per ref", async () => {
		let v = await version(child);
		const pr = await call(as("dev2"), "POST", `/tasks/${child}/links`, {
			version: v,
			kind: "pr",
			ref: "812",
		});
		expect(pr.status).toBe(200);
		expect(pr.body.version).toBe(v + 1);
		expect(pr.body.links).toEqual([
			expect.objectContaining({ kind: "pr", ref: "812", createdBy: "dev2" }),
		]);
		v++;
		expect(
			(
				await call(as("dev2"), "POST", `/tasks/${child}/links`, {
					version: v - 1,
					kind: "external",
					ref: "x",
				})
			).body.error,
		).toBe("stale");
		expect(
			(
				await call(as("dev2"), "POST", `/tasks/${child}/links`, {
					version: v,
					kind: "dep",
					ref: goal,
				})
			).body,
		).toMatchObject({
			error: "not-allowed",
			need: "coordinator",
		});
		expect(
			(
				await call(as("coord"), "POST", `/tasks/${child}/links`, {
					version: v,
					kind: "dep",
					ref: child,
				})
			).body.error,
		).toBe("self-dependency");
		const sibling = (await call(as("coord"), "POST", "/tasks", { parentId: goal, title: "antes" }))
			.body.id;
		expect(
			(
				await call(as("coord"), "POST", `/tasks/${child}/links`, {
					version: v,
					kind: "dep",
					ref: sibling,
				})
			).status,
		).toBe(200);
		v++;
		expect(
			(
				await call(as("dev2"), "POST", `/tasks/${child}/links`, {
					version: v,
					kind: "work",
					ref: "no-existe",
				})
			).body.error,
		).toBe("work-not-found");
		expect(
			(
				await call(as("dev2"), "POST", `/tasks/${child}/links`, {
					version: v,
					kind: "pr",
					ref: "rm -rf",
				})
			).body.error,
		).toBe("bad-pr");
		// The same link again: nothing changes, not even the version.
		const again = await call(as("dev2"), "POST", `/tasks/${child}/links`, {
			version: v,
			kind: "pr",
			ref: "812",
		});
		expect(again.status).toBe(200);
		expect(again.body.version).toBe(v);
		expect(
			(await call(as("qa2"), "POST", `/tasks/${child}/links`, { version: v, kind: "pr", ref: "9" }))
				.status,
		).toBe(403);
	});

	it("handoff: the coordinator or the person hands the goal over; the old one loses its authority; all of it is history", async () => {
		const g = await task(owner, goal);
		expect(
			(await patch(as("dev2"), goal, { version: g.body.task.version, coordinator: "dev2" })).status,
		).toBe(403);
		const h = await patch(as("coord"), goal, { version: g.body.task.version, coordinator: "@qa2" });
		expect(h.body).toMatchObject({ coordinator: "qa2" });
		expect(
			(await call(as("coord"), "POST", "/tasks", { parentId: goal, title: "x" })).body.error,
		).toBe("not-coordinator");
		expect(
			(await patch(as("coord"), child, { version: await version(child), priority: "low" })).status,
		).toBe(403);
		expect(
			(await patch(as("qa2"), child, { version: await version(child), priority: "low" })).status,
		).toBe(200);
		expect((await patch(as("qa2"), child, { version: 1, coordinator: "dev2" })).body.error).toBe(
			"not-a-root",
		);
		expect(
			(await patch(as("qa2"), goal, { version: h.body.version, coordinator: null })).body.error,
		).toBe("coordinator-required");

		const shown = await task(as("dev2"), child);
		expect(shown.body.parent).toMatchObject({ id: goal, coordinator: "qa2" });
		const kinds = shown.body.events.map((e: { kind: string }) => e.kind);
		expect(kinds[0]).toBe("created");
		expect(kinds).toEqual(
			expect.arrayContaining([
				"status",
				"blocked",
				"unblocked",
				"approved",
				"reopened",
				"link",
				"updated",
			]),
		);
		const approved = shown.body.events.find((e: { kind: string }) => e.kind === "approved");
		expect(approved).toMatchObject({ actor: "qa2", data: { status: ["review", "done"] } });
		const goalEvents = (await task(owner, goal)).body.events;
		expect(goalEvents.at(-1)).toMatchObject({
			kind: "coordinator",
			actor: "coord",
			data: { coordinator: ["coord", "qa2"] },
		});
		expect((await task(owner, goal)).body.children.map((c: { id: number }) => c.id)).toContain(
			child,
		);
	});

	it("st send --task: the task travels on the message; another project's is refused; live `task` events reach the owner only", async () => {
		const before = events.length;
		await teamRequest("team-goal-0003", ["coord"]);
		const sent = await call(as("coord"), "POST", "/messages", {
			to: "dev2",
			body: "medí",
			task: child,
		});
		expect(sent.status).toBe(201);
		expect(sent.body.task_id).toBe(child);
		// An agent's request in a task counts against it and its root, in the INSERT;
		// the reply (by trigger) and the person's messages count nothing.
		const counts = () =>
			[child, goal].map(
				(id) =>
					db
						.prepare("SELECT requests_used AS r, budget_used AS b FROM tasks WHERE id = ?")
						.get(id) as { r: number; b: number },
			);
		expect(counts()).toEqual([
			{ r: 1, b: 0 },
			{ r: 0, b: 1 },
		]);
		await call(owner, "POST", "/messages", { to: "dev2", body: "y esto", task: child });
		expect(counts()[0].r).toBe(1);
		while ((await call(as("dev2"), "POST", "/runner/claim")).status === 200) await finish("dev2");
		const reply = db
			.prepare("SELECT task_id, kind FROM agent_messages WHERE reply_to = ?")
			.get(sent.body.id) as { task_id: number; kind: string };
		expect(reply).toEqual({ task_id: child, kind: "reply" });
		expect(counts()[1].b).toBe(1);
		expect(
			(await call(as("coord"), "POST", "/messages", { to: "dev2", body: "x", task: 999_999 })).body
				.error,
		).toBe("task-not-found");
		expect(
			(await call(owner, "POST", "/messages", { to: "lejos", body: "x", task: child })).body.error,
		).toBe("task-other-project");
		await finish("coord");
		await patch(owner, child, { version: await version(child), title: "Medir tiempos de CI" });
		const ev = events.slice(before).filter((e) => e.type === "task");
		expect(ev.length).toBeGreaterThan(0);
		expect(ev.every((e) => e.owner === OWNER)).toBe(true);
	});

	it("st task: the CLI speaks the same API, with the token as the caller", async () => {
		const { execFile } = await import("node:child_process");
		const bin = new URL("../../../acp-runtime/bin/st", import.meta.url).pathname;
		const st = (agent: string, ...args: string[]) =>
			new Promise<{ code: number; out: string; err: string }>((resolve) =>
				execFile(
					process.execPath,
					[bin, ...args],
					{
						env: {
							...process.env,
							ST_URL: base.replace(/\/api\/acp$/, ""),
							ST_TOKEN: tokens[agent],
							ST_AGENT: agent,
						},
					},
					(e, out, err) => resolve({ code: e ? Number(e.code ?? 1) : 0, out, err }),
				),
			);
		await teamRequest("team-goal-cli1", ["coord", "dev2"]);
		const g = await st("coord", "task", "goal", "Bajar", "el", "tiempo");
		expect(g.out).toMatch(/^creada #(\d+) \[todo\] Bajar el tiempo · coordina @coord · v1/);
		const gid = /#(\d+)/.exec(g.out)?.[1] as string;
		expect((await st("dev2", "task", "goal", "otro")).out).toMatch(
			new RegExp(`ya existe el objetivo de esta solicitud: #${gid} .*coordina @coord`),
		);
		const c = await st(
			"coord",
			"task",
			"new",
			"Medir",
			"--parent",
			gid,
			"--assign",
			"@dev2",
			"--review",
			"@qa2",
			"--prio",
			"high",
		);
		const cid = /#(\d+)/.exec(c.out)?.[1] as string;
		expect(c.out).toMatch(`(de #${gid}) [todo] high · Medir · @dev2 · revisa @qa2`);
		expect((await st("dev2", "task", "move", cid, "doing")).out).toMatch("[doing]");
		expect((await st("dev2", "task", "link", cid, "pr", "812")).out).toMatch("v3");
		const self = await st("dev2", "task", "done", cid);
		expect(self.code).toBe(1);
		expect(self.err).toMatch(/el responsable de una tarea no la aprueba.*self-approval/);
		const old = await st("qa2", "task", "done", cid, "--version", "1");
		expect(old.err).toMatch(
			/cambió desde que la leíste.*\(stale\)\n {2}ahora: #\d+ .*\[doing\].* v3/,
		);
		expect((await st("qa2", "task", "done", cid)).out).toMatch("[done]");
		const show = await st("dev2", "task", "show", cid);
		expect(show.out).toMatch(`objetivo: #${gid}`);
		expect(show.out).toMatch("enlace pr: 812");
		expect(show.out).toMatch(/@qa2 approved/);
		expect((await st("dev2", "task", "list")).out).toMatch(/— terminadas recientes —[\s\S]*Medir/);
		const sent = await st("coord", "send", "@dev2", "--task", cid, "mirá", "esto");
		expect(sent.code).toBe(0);
		const last = db
			.prepare("SELECT task_id FROM agent_messages WHERE body = 'mirá esto'")
			.get() as { task_id: number };
		expect(last.task_id).toBe(Number(cid));
		expect((await st("lejos", "task", "show", cid)).err).toMatch(
			/no existe esa tarea en tu proyecto/,
		);
		await finish("coord");
		await finish("dev2");
	});

	it("scope approval: the coordinator records the person's accept to its own question on the goal's request; versioned, once per question", async () => {
		await teamRequest("team-scope-0001", ["coord"]);
		const g = (await call(as("coord"), "POST", "/tasks", { goal: true, title: "Con alcance" }))
			.body;
		const run = (await call(as("coord"), "GET", "/runner/running")).body;
		const ask = (message: string) =>
			call(as("coord"), "POST", "/runner/questions", { messageId: run.id, request: { message } });
		const q = (await ask("¿Apruebo el alcance?")).body;
		const approve = (who: Who, body: Record<string, unknown>) =>
			call(who, "POST", `/tasks/${g.id}/scope-approved`, body);
		expect((await approve(as("coord"), { version: g.version, questionId: q.id })).body.error).toBe(
			"question-not-accepted",
		);
		await call(owner, "POST", `/questions/${q.id}/answer`, {
			action: "accept",
			content: { ok: true },
		});
		expect((await approve(as("dev2"), { version: g.version })).body.error).toBe("not-coordinator");
		expect((await approve(as("coord"), {})).body.error).toBe("version-required");
		expect((await approve(as("coord"), { version: g.version - 1 })).body).toMatchObject({
			error: "stale",
			task: { id: g.id },
		});
		const rec = await approve(as("coord"), { version: g.version });
		expect(rec.status).toBe(201);
		expect(rec.body).toMatchObject({ recorded: true, question: q.id });
		// The verb the coordinar skill names; the same question again records nothing.
		const { execFile } = await import("node:child_process");
		const cli = await new Promise<string>((resolve) =>
			execFile(
				process.execPath,
				[
					new URL("../../../acp-runtime/bin/st", import.meta.url).pathname,
					...["task", "approve", String(g.id), "--question", String(q.id)],
				],
				{
					env: { ...process.env, ST_URL: base.replace(/\/api\/acp$/, ""), ST_TOKEN: tokens.coord },
				},
				(_e, out, err) => resolve(`${out}${err}`),
			),
		);
		expect(cli).toMatch(
			`ya estaba registrado: alcance aprobado del objetivo #${g.id} (pregunta #${q.id})`,
		);
		const ev = (await call(owner, "GET", `/tasks/${g.id}`)).body.events.filter(
			(e: { kind: string }) => e.kind === "scope-approved",
		);
		// The event keeps what the person answered: the backend checks that they
		// answered (the form was submitted), the coordinator declares the approval.
		expect(ev).toEqual([
			expect.objectContaining({ actor: "coord", data: { question: q.id, answer: '{"ok":true}' } }),
		]);
		// A declined answer approves nothing.
		const q2 = (await ask("¿Y esto?")).body;
		await call(owner, "POST", `/questions/${q2.id}/answer`, { action: "decline" });
		expect((await approve(as("coord"), { version: g.version, questionId: q2.id })).body.error).toBe(
			"question-not-accepted",
		);
		await finish("coord");
		// A question of ANOTHER request of the person is not this goal's.
		await teamRequest("team-scope-0002", ["coord"]);
		const run2 = (await call(as("coord"), "GET", "/runner/running")).body;
		const q3 = (
			await call(as("coord"), "POST", "/runner/questions", {
				messageId: run2.id,
				request: { message: "¿otra?" },
			})
		).body;
		await call(owner, "POST", `/questions/${q3.id}/answer`, { action: "accept", content: {} });
		expect((await approve(as("coord"), { version: g.version, questionId: q3.id })).body.error).toBe(
			"question-other-request",
		);
		await finish("coord");
	});

	it("the board: open tasks and the recent done, paged, with links", async () => {
		const b = await call(as("dev2"), "GET", "/tasks");
		expect(b.status).toBe(200);
		expect(b.body.projectId).toBe(PT);
		expect(b.body.open.every((t: { status: string }) => t.status !== "done")).toBe(true);
		expect(b.body.done.every((t: { status: string }) => t.status === "done")).toBe(true);
		expect(b.body.open.find((t: { id: number }) => t.id === child).links.length).toBe(2);
		expect((await call(owner, "GET", `/tasks?projectId=${PT}&doneBefore=bad`)).body.error).toBe(
			"bad-cursor",
		);
	});
});

describe("ACP tasks: inheritance, budgets, derived state (PR 3)", () => {
	const P3 = "p-t3";
	const SIDS: Record<string, string> = {
		ta: "e3000000-0000-4000-8000-000000000001",
		tb: "e3000000-0000-4000-8000-000000000002",
		tc: "e3000000-0000-4000-8000-000000000003",
	};
	const taskRow = (id: number) =>
		db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<
			string,
			number | string | null
		>;
	const claim = async (a: string) => {
		const c = await call(as(a), "POST", "/runner/claim");
		expect(c.status).toBe(200);
		return c.body as MessageRowT;
	};
	const settle = (a: string, id: number, state = "done") =>
		call(as(a), "POST", `/runner/messages/${id}/result`, { state, text: "ok" });
	async function drain(names = Object.keys(SIDS)) {
		for (let busy = true; busy; ) {
			busy = false;
			for (const a of names) {
				for (
					let c = await call(as(a), "POST", "/runner/claim");
					c.status === 200;
					c = await call(as(a), "POST", "/runner/claim")
				) {
					busy = true;
					await settle(a, c.body.id);
				}
			}
		}
	}

	beforeAll(async () => {
		db.prepare(
			"INSERT INTO projects (project_id, owner_user_id, name, client_request_id, request_hash) VALUES (?, ?, 'PR3', 'c-pt3', 'h')",
		).run(P3, OWNER);
		for (const [name, sid] of Object.entries(SIDS)) {
			db.prepare(
				"INSERT INTO sessions (session_id, user_id, name, container_name, status) VALUES (?, ?, ?, ?, 'running')",
			).run(sid, OWNER, name, `st-${sid.slice(0, 12)}`);
			const a = await acp.create(sid, OWNER, name, { projectId: P3 });
			tokens[name] = acp.tokenFor(a.agent_id);
		}
	});

	it("an agent's request inherits the task of the message it runs; the reply keeps it; each request spends the goal's budget; past it, 409 and one event", async () => {
		const goal = (
			await call(owner, "POST", "/tasks", {
				projectId: P3,
				title: "Rondas",
				coordinator: "ta",
				budgetLimit: 3,
			})
		).body;
		expect(goal).toMatchObject({ budget: { limit: 3, used: 0 } });
		const start = await call(owner, "POST", "/messages", {
			to: "ta",
			body: "empezá",
			task: goal.id,
		});
		expect(start.body.task_id).toBe(goal.id);
		let run = await claim("ta");
		// Three rounds of consult and answer: each request in the goal, each reply too.
		for (let round = 1; round <= 3; round++) {
			const req = await call(as("ta"), "POST", "/messages", { to: "tb", body: `ronda ${round}` });
			expect(req.status).toBe(201);
			expect(req.body.task_id).toBe(goal.id);
			await settle("ta", run.id);
			const got = await claim("tb");
			expect(got.id).toBe(req.body.id);
			await settle("tb", got.id);
			run = await claim("ta");
			expect(run).toMatchObject({ kind: "reply", reply_to: req.body.id, task_id: goal.id });
		}
		expect(taskRow(goal.id)).toMatchObject({ budget_used: 3, requests_used: 3 });
		// The loop is cut: nothing written, the refusal says which budget and the person decides.
		const cut = await call(as("ta"), "POST", "/messages", { to: "tb", body: "ronda 4" });
		expect(cut.status).toBe(409);
		expect(cut.body).toMatchObject({ error: "goal-budget", goal: goal.id, limit: 3, used: 3 });
		expect(
			db
				.prepare(
					"SELECT id, from_id, to_id, task_id, state FROM agent_messages WHERE body = 'ronda 4' AND from_id = 'ta'",
				)
				.all(),
		).toEqual([]);
		await call(as("ta"), "POST", "/messages", { to: "tb", body: "ronda 4 otra vez" });
		const shown = await call(owner, "GET", `/tasks/${goal.id}`);
		expect(
			shown.body.events.filter((e: { kind: string }) => e.kind === "budget-exhausted"),
		).toEqual([
			expect.objectContaining({
				actor: "ta",
				data: { budget: "goal", limit: 3, used: 3, task: goal.id },
			}),
		]);
		expect(shown.body.task.budget).toEqual({ limit: 3, used: 3, exhausted: true });
		// Only the person raises it.
		expect((await call(as("ta"), "POST", `/tasks/${goal.id}/budget`, { add: 2 })).status).toBe(403);
		const raised = await call(owner, "POST", `/tasks/${goal.id}/budget`, { add: 2 });
		expect(raised.body).toMatchObject({ budget: { limit: 5, used: 3 }, version: goal.version });
		expect((await call(owner, "GET", `/tasks/${goal.id}`)).body.events.at(-1)).toMatchObject({
			kind: "budget",
			actor: "owner",
			data: { budgetLimit: [3, 5] },
		});
		expect(
			(await call(as("ta"), "POST", "/messages", { to: "tb", body: "ronda 4, ya ampliado" }))
				.status,
		).toBe(201);
		await settle("ta", run.id);
		await drain();
	});

	it("a task's own budget cuts the back-and-forth on one task; the person raises it for that task", async () => {
		const goal = (
			await call(owner, "POST", "/tasks", { projectId: P3, title: "Grande", coordinator: "ta" })
		).body;
		const child = (
			await call(as("ta"), "POST", "/tasks", { parentId: goal.id, title: "Chica", assignee: "tb" })
		).body;
		const cfg = acp.config as { taskBudget: number };
		const before = cfg.taskBudget;
		cfg.taskBudget = 2;
		try {
			await call(owner, "POST", "/messages", { to: "tb", body: "hacé la chica", task: child.id });
			const run = await claim("tb");
			for (const n of [1, 2])
				expect(
					(await call(as("tb"), "POST", "/messages", { to: "tc", body: `pregunta ${n}` })).body
						.task_id,
				).toBe(child.id);
			const cut = await call(as("tb"), "POST", "/messages", { to: "tc", body: "pregunta 3" });
			expect(cut.body).toMatchObject({
				error: "task-budget",
				task: child.id,
				goal: goal.id,
				limit: 2,
				used: 2,
			});
			// `--task` naming another task is that task's budget, not this one's.
			expect(
				(await call(as("tb"), "POST", "/messages", { to: "tc", body: "otra", task: goal.id }))
					.status,
			).toBe(201);
			expect(taskRow(goal.id)).toMatchObject({ requests_used: 1, budget_used: 3 });
			const raised = await call(owner, "POST", `/tasks/${child.id}/budget`, { add: 1 });
			expect(raised.body.taskBudget).toEqual({ limit: 3, used: 2, exhausted: false });
			expect(
				(await call(owner, "POST", `/tasks/${child.id}/budget`, { add: 1, scope: "goal" })).body
					.error,
			).toBe("not-a-root");
			expect(
				(await call(as("tb"), "POST", "/messages", { to: "tc", body: "pregunta 3" })).status,
			).toBe(201);
			await settle("tb", run.id);
		} finally {
			cfg.taskBudget = before;
		}
		await drain();
	});

	it("a recipient outside the task's project gets no task: its request spends nothing", async () => {
		const goal = (
			await call(owner, "POST", "/tasks", { projectId: P3, title: "Fuera", coordinator: "ta" })
		).body;
		await call(owner, "POST", "/messages", { to: "ta", body: "consultá a solo", task: goal.id });
		const run = await claim("ta");
		const away = await call(as("ta"), "POST", "/messages", { to: "solo", body: "hola" });
		expect(away.status).toBe(201);
		expect(away.body.task_id).toBeNull();
		expect(taskRow(goal.id).budget_used).toBe(0);
		await settle("ta", run.id);
		await drain(["solo", ...Object.keys(SIDS)]);
	});

	it("the board's reading contract: activity[], contradiction, dependencies, budget on the root, the run after a reassignment, stale with the last event", async () => {
		const goal = (
			await call(owner, "POST", "/tasks", { projectId: P3, title: "Estado", coordinator: "ta" })
		).body;
		let t = (
			await call(as("ta"), "POST", "/tasks", { parentId: goal.id, title: "Hacer", assignee: "tb" })
		).body;
		const kinds = (x: { activity: Array<{ kind: string }> }) => x.activity.map((a) => a.kind);
		const read = async () => (await call(owner, "GET", `/tasks/${t.id}`)).body.task;
		const m = await call(owner, "POST", "/messages", { to: "tb", body: "hacelo", task: t.id });
		expect((await read()).activity).toEqual([
			{
				kind: "queued",
				agent: "tb",
				conversationId: null,
				since: m.body.created_at,
				messageId: m.body.id,
			},
		]);
		const run = await claim("tb");
		expect(run.id).toBe(m.body.id);
		// Reassigned while tb runs it: no cancellation, the answer says whose run goes on.
		const re = await call(as("ta"), "PATCH", `/tasks/${t.id}`, {
			version: t.version,
			assignee: "tc",
		});
		expect(re.body.assignee).toBe("tc");
		expect(re.body.activity).toEqual([
			{
				kind: "running",
				agent: "tb",
				conversationId: null,
				since: run.started_at,
				messageId: m.body.id,
			},
		]);
		expect(re.body.previousRunActive).toEqual([{ messageId: m.body.id, agent: "tb" }]);
		// The CLI prints the derived state too (its constants were once read in their TDZ).
		const shown = await stCli("ta", "task", "show", String(t.id));
		expect(shown.err).toBe("");
		expect(shown.code).toBe(0);
		expect(shown.out).toMatch(`en curso: @tb (#${m.body.id})`);
		expect(shown.out).toMatch(`la ejecución anterior sigue activa: @tb (#${m.body.id})`);
		// A write on the old version: the whole current row and who changed what last.
		const old = await call(as("ta"), "PATCH", `/tasks/${t.id}`, {
			version: t.version,
			priority: "high",
		});
		expect(old.status).toBe(409);
		expect(old.body.task).toMatchObject({
			version: re.body.version,
			assignee: "tc",
			previousRunActive: [expect.anything()],
		});
		expect(old.body.lastEvent).toMatchObject({
			actor: "ta",
			kind: "assigned",
			data: { assignee: ["tb", "tc"] },
		});
		// Declared done while it runs: the contradiction is said, the declared status stays.
		const done = await call(owner, "PATCH", `/tasks/${t.id}`, {
			version: re.body.version,
			status: "done",
		});
		expect(done.body.status).toBe("done");
		expect(done.body.contradiction).toBe("done-with-running");
		// A question asked while working on it: waitOwner.
		const q = await call(as("tb"), "POST", "/runner/questions", {
			messageId: m.body.id,
			request: { message: "¿?" },
		});
		const withQ = (await call(as("ta"), "GET", `/tasks/${t.id}`)).body.task;
		expect(withQ.activity).toContainEqual(
			expect.objectContaining({
				kind: "waitOwner",
				agent: "tb",
				messageId: m.body.id,
				questionId: q.body.id,
			}),
		);
		await call(owner, "POST", `/questions/${q.body.id}/answer`, { action: "cancel" });
		// Interrupted: shown until the person reviews it.
		await settle("tb", m.body.id, "uncertain");
		expect(kinds(await read())).toEqual(["uncertain"]);
		const shownU = await stCli("ta", "task", "show", String(t.id));
		expect(shownU.code).toBe(0);
		expect(shownU.out).toMatch(`interrumpido sin revisar: @tb (#${m.body.id})`);
		expect((await read()).contradiction).toBeNull();
		await call(owner, "POST", `/messages/${m.body.id}/review`);
		expect(kinds(await read())).toEqual([]);
		// A linked active work, and a dependency with the other task's status.
		await call(owner, "PATCH", "/agents/tc", { maxConcurrency: 2 });
		expect((await call(owner, "POST", "/works", { agent: "tc", id: "pr3-estado" })).status).toBe(
			201,
		);
		t = await read();
		const linked = await call(as("tc"), "POST", `/tasks/${t.id}/links`, {
			version: t.version,
			kind: "work",
			ref: "pr3-estado",
		});
		expect(linked.body.activity).toEqual([
			expect.objectContaining({ kind: "work", agent: "tc", workId: "pr3-estado" }),
		]);
		expect(linked.body.contradiction).toBe("done-with-active-work");
		const other = (await call(as("ta"), "POST", "/tasks", { parentId: goal.id, title: "Después" }))
			.body;
		await call(as("ta"), "POST", `/tasks/${other.id}/links`, {
			version: other.version,
			kind: "dep",
			ref: t.id,
		});
		// The board: the same reading, from its fixed statements; the goal's budget on the root.
		const board = (await call(as("tc"), "GET", `/tasks?project=${P3}`)).body;
		expect(board.done.find((x: { id: number }) => x.id === t.id).contradiction).toBe(
			"done-with-active-work",
		);
		expect(board.open.find((x: { id: number }) => x.id === other.id).dependencies).toEqual([
			{ taskId: t.id, title: "Hacer", status: "done" },
		]);
		const root = board.open.find((x: { id: number }) => x.id === goal.id);
		expect(root.budget).toEqual({ used: 0, limit: 150, exhausted: false });
		expect(board.open.find((x: { id: number }) => x.id === other.id).budget).toBeNull();
		await drain();
	});

	it("the rail's summary: open, blocked, awaiting the person — not in the inbox", async () => {
		const goal = (
			await call(owner, "POST", "/tasks", { projectId: P3, title: "Resumen", coordinator: "ta" })
		).body;
		const before = (await call(owner, "GET", `/tasks/summary?project=${P3}`)).body;
		const a = (
			await call(as("ta"), "POST", "/tasks", { parentId: goal.id, title: "A", assignee: "tb" })
		).body;
		const b = (
			await call(as("ta"), "POST", "/tasks", { parentId: goal.id, title: "B", assignee: "tb" })
		).body;
		await call(as("tb"), "PATCH", `/tasks/${a.id}`, {
			version: a.version,
			blockedReason: "espera",
		});
		await call(as("tb"), "PATCH", `/tasks/${b.id}`, { version: b.version, status: "review" });
		const inbox = (await call(owner, "GET", "/inbox")).body;
		const after = await call(as("tc"), "GET", "/tasks/summary");
		expect(after.status).toBe(200);
		expect(after.body).toEqual({
			projectId: P3,
			open: before.open + 2,
			blocked: before.blocked + 1,
			awaitingOwner: before.awaitingOwner + 1,
		});
		// «Espera tu aprobación» is the board's, never the inbox's or its counter.
		expect((await call(owner, "GET", "/inbox")).body.count).toBe(inbox.count);
		expect((await call(as("lejos"), "GET", `/tasks/summary?project=${P3}`)).status).toBe(404);
	});
});

describe("D1 reads: the board goes by index (v29)", () => {
	const PB = "p-board";
	beforeAll(() => {
		db.prepare(
			"INSERT INTO projects (project_id, owner_user_id, name, client_request_id, request_hash) VALUES (?, ?, 'Board', 'c-pb', 'h')",
		).run(PB, OWNER);
		const ins = db.prepare(
			`INSERT INTO tasks (owner_user_id, project_id, parent_id, title, status, done_at, coordinator, created_by, updated_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'owner', 'owner')`,
		);
		const link = db.prepare(
			"INSERT INTO task_links (owner_user_id, task_id, kind, ref, created_by) VALUES (?, ?, 'pr', ?, 'owner')",
		);
		const STATUSES = ["todo", "doing", "review", "done", "done", "done"];
		// ~500 tasks per project, most of them done (the board's history grows).
		for (const pid of [PB, "p-2"]) {
			let root = 0;
			for (let i = 0; i < 500; i++) {
				const st = STATUSES[i % STATUSES.length];
				const isRoot = i % 10 === 0;
				const r = ins.run(
					OWNER,
					pid,
					isRoot ? null : root,
					`t${i}`,
					st,
					st === "done" ? new Date(Date.UTC(2026, 5, 1) + i * 1000).toISOString() : null,
					isRoot ? "coord" : null,
				);
				if (isRoot) root = Number(r.lastInsertRowid);
				if (i % 3 === 0) link.run(OWNER, Number(r.lastInsertRowid), String(i));
			}
		}
	});

	const plans = async (path: string) => {
		const got: Array<{ sql: string; params: unknown[] }> = [];
		captured = got;
		try {
			const r = await call(owner, "GET", path);
			expect(r.status).toBe(200);
		} finally {
			captured = null;
		}
		return got
			.filter((s) => /\b(tasks|task_links|task_events|task_id)\b/.test(s.sql))
			.map((s) => ({
				sql: s.sql.replace(/\s+/g, " ").trim(),
				plan: (
					db.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).all(...bindOf(s.params)) as Array<{
						detail: string;
					}>
				).map((r) => r.detail),
			}));
	};
	// No scan of the tasks' tables, no read bounded only by the owner.
	const BAD =
		/^SCAN (tasks|task_links|task_events|agent_messages|agent_questions|m|q)\b|USING (?:COVERING )?INDEX (?!idx_agent_questions_state)\w+ \(owner_user_id=\?\)$/;

	describe.each([
		["without statistics", false],
		["after ANALYZE", true],
	])("%s", (_label, analyze) => {
		beforeAll(() => {
			if (analyze) db.exec("ANALYZE");
		});

		it("open, done (first page and a later one) and their links read by the partial indexes", async () => {
			const first = await call(owner, "GET", `/tasks?projectId=${PB}`);
			expect(first.body.open.length + first.body.done.length).toBe(200);
			expect(first.body.open.length).toBe(150);
			expect(first.body.done.length).toBe(50);
			expect(first.body.nextOpen).toBeTruthy();
			expect(first.body.nextDone).toBeTruthy();
			const next = await call(
				owner,
				"GET",
				`/tasks?projectId=${PB}&openAfter=${first.body.nextOpen}&doneBefore=${encodeURIComponent(first.body.nextDone)}`,
			);
			expect(next.body.done[0].doneAt < first.body.done.at(-1).doneAt).toBe(true);
			expect(next.body.open[0].id).toBeGreaterThan(first.body.nextOpen);
			for (const path of [
				`/tasks?projectId=${PB}`,
				`/tasks?projectId=${PB}&openAfter=${first.body.nextOpen}&doneBefore=${encodeURIComponent(first.body.nextDone)}`,
			]) {
				const ps = await plans(path);
				const open = ps.find((p) => /status != 'done'/.test(p.sql));
				const done = ps.find((p) => /status = 'done'/.test(p.sql));
				expect(open?.plan.join("\n")).toMatch(
					/idx_tasks_open \(owner_user_id=\? AND project_id=\? AND id>\?\)/,
				);
				expect(done?.plan.join("\n")).toMatch(
					/idx_tasks_done \(owner_user_id=\? AND project_id=\?/,
				);
				const bad = ps.flatMap((p) =>
					p.plan.filter((l) => BAD.test(l)).map((l) => `${l} ← ${p.sql}`),
				);
				expect(bad).toEqual([]);
				// The derived state: each read by the task's partial index, questions from the open ones.
				const lines = ps.flatMap((p) => p.plan).join("\n");
				expect(lines).toMatch(/idx_agent_messages_task_active \(owner_user_id=\? AND task_id=\?\)/);
				expect(lines).toMatch(
					/idx_agent_messages_task_unreviewed \(owner_user_id=\? AND task_id=\?\)/,
				);
				expect(lines).toMatch(/idx_agent_questions_state \(owner_user_id=\? AND state=\?\)/);
			}
		});

		it("the rail's summary is one statement by the open-tasks index", async () => {
			const ps = await plans(`/tasks/summary?project=${PB}`);
			expect(ps.length).toBe(1);
			expect(ps[0].plan.join("\n")).toMatch(
				/idx_tasks_open \(owner_user_id=\? AND project_id=\?\)/,
			);
		});

		it("a task's page: children, links and history by the task", async () => {
			const root = (
				db
					.prepare("SELECT id FROM tasks WHERE project_id = ? AND parent_id IS NULL LIMIT 1")
					.get(PB) as { id: number }
			).id;
			const ps = await plans(`/tasks/${root}`);
			const bad = ps.flatMap((p) =>
				p.plan.filter((l) => BAD.test(l)).map((l) => `${l} ← ${p.sql}`),
			);
			expect(bad).toEqual([]);
			expect(ps.some((p) => p.plan.some((l) => /idx_tasks_parent/.test(l)))).toBe(true);
			expect(ps.some((p) => p.plan.some((l) => /idx_task_events_task/.test(l)))).toBe(true);
		});

		it("the request counter trigger updates tasks by key (trg_task_request_counted)", () => {
			// EXPLAIN QUERY PLAN of the INSERT into agent_messages does not show what its
			// triggers run, so the trigger's own statements are planned, read back from the
			// schema (the migrated text, not a copy) with NEW.* bound as parameters.
			const { sql } = db
				.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
				.get("trg_task_request_counted") as { sql: string };
			const body = /\bBEGIN\b([\s\S]*)\bEND\s*$/i.exec(sql)?.[1] ?? "";
			const stmts = body
				.split(";")
				.map((s) => s.trim())
				.filter(Boolean);
			expect(stmts.length).toBe(2);
			const child = (
				db
					.prepare("SELECT id FROM tasks WHERE project_id = ? AND parent_id IS NOT NULL LIMIT 1")
					.get(PB) as { id: number }
			).id;
			for (const s of stmts) {
				const bound = s.replace(/\bNEW\.task_id\b/g, "?1").replace(/\bNEW\.owner_user_id\b/g, "?2");
				expect(bound).not.toMatch(/\bNEW\./);
				const plan = (
					db.prepare(`EXPLAIN QUERY PLAN ${bound}`).all(child, OWNER) as Array<{ detail: string }>
				).map((r) => r.detail);
				expect(plan.filter((l) => /^SCAN\b/.test(l))).toEqual([]);
				expect(plan.join("\n")).toMatch(/SEARCH (tasks|t) USING INTEGER PRIMARY KEY \(rowid=\?\)/);
			}
		});
	});
});

// Last in the file: its final case calls stopWaiting(), which is for good.
describe("ACP idle runners: the claim waits for work (R21)", () => {
	const SID_W = "e4000000-0000-4000-8000-000000000001";
	beforeAll(async () => {
		db.prepare(
			"INSERT INTO sessions (session_id, user_id, name, container_name, status) VALUES (?, ?, 'espera', ?, 'running')",
		).run(SID_W, OWNER, `st-${SID_W.slice(0, 12)}`);
		tokens.espera = acp.tokenFor((await acp.create(SID_W, OWNER, "espera")).agent_id);
	});
	const claimWait = (signal?: AbortSignal) =>
		realFetch(`${base}/runner/claim`, {
			method: "POST",
			headers: { authorization: `Bearer ${tokens.espera}`, "content-type": "application/json" },
			body: JSON.stringify({ wait: true }),
			signal,
		});
	const until = async (cond: () => boolean) => {
		for (let i = 0; i < 100 && !cond(); i++) await new Promise((ok) => setTimeout(ok, 20));
	};

	it("an idle claim is answered when a message arrives, not on the next poll; the runner counts as seen while it waits", async () => {
		const t0 = Date.now();
		const pending = claimWait();
		await until(() => acp.waitingClaims === 1);
		expect(acp.waitingClaims).toBe(1);
		const seen = (await call(owner, "GET", "/agents")).body.find(
			(a: { name: string }) => a.name === "espera",
		);
		expect(Date.now() - Date.parse(seen.runnerSeenAt)).toBeLessThan(1_000);
		const sent = await call(owner, "POST", "/messages", { to: "espera", body: "llegó" });
		const res = await pending;
		expect(res.status).toBe(200);
		expect(res.headers.get("x-st-waited")).toBe("1");
		expect(((await res.json()) as { id: number }).id).toBe(sent.body.id);
		expect(Date.now() - t0).toBeLessThan(5_000);
		expect(acp.waitingClaims).toBe(0);
		// With a message running in the slot it answers 409 at once, as before.
		const busy = await claimWait();
		expect(busy.status).toBe(409);
		await call(as("espera"), "POST", `/runner/messages/${sent.body.id}/result`, {
			state: "done",
			text: "ok",
		});
	});

	it("a model/effort change while the claim waits comes back in that claim's answer", async () => {
		const pending = claimWait();
		await until(() => acp.waitingClaims === 1);
		const p = await call(owner, "PATCH", "/agents/espera", {
			model: "claude-opus-5-5",
			effort: "high",
		});
		expect(p.status).toBe(200);
		const res = await pending;
		expect(res.status).toBe(204);
		expect(res.headers.get("x-st-model")).toBe("claude-opus-5-5");
		expect(res.headers.get("x-st-effort")).toBe("high");
	});

	it("a message queued right after the change is claimed with the new model, never the old one", async () => {
		const pending = claimWait();
		await until(() => acp.waitingClaims === 1);
		const [, sent] = await Promise.all([
			call(owner, "PATCH", "/agents/espera", { model: "claude-fable-5-2" }),
			call(owner, "POST", "/messages", { to: "espera", body: "con el modelo nuevo" }),
		]);
		// The PATCH may end the wait before or after the message is written: an
		// empty answer first is fine, an answer with the old model never is.
		let res = await pending;
		expect(res.headers.get("x-st-model")).toBe("claude-fable-5-2");
		if (res.status === 204) {
			res = await claimWait();
			expect(res.headers.get("x-st-model")).toBe("claude-fable-5-2");
		}
		expect(res.status).toBe(200);
		expect(((await res.json()) as { id: number }).id).toBe(sent.body.id);
		await call(as("espera"), "POST", `/runner/messages/${sent.body.id}/result`, {
			state: "done",
			text: "ok",
		});
	});

	it("a runner that left while waiting gets nothing claimed for it", async () => {
		const ac = new AbortController();
		const pending = claimWait(ac.signal).catch(() => null);
		await until(() => acp.waitingClaims === 1);
		ac.abort();
		await pending;
		await until(() => acp.waitingClaims === 0);
		expect(acp.waitingClaims).toBe(0);
		const sent = await call(owner, "POST", "/messages", { to: "espera", body: "nadie espera" });
		await new Promise((ok) => setTimeout(ok, 100));
		expect((await call(owner, "GET", `/messages/${sent.body.id}`)).body.state).toBe("pending");
		const c = await call(as("espera"), "POST", "/runner/claim");
		await call(as("espera"), "POST", `/runner/messages/${c.body.id}/result`, {
			state: "done",
			text: "ok",
		});
	});

	it("another owner's message does not wake it; at shutdown every waiting claim answers 204", async () => {
		const pending = claimWait();
		await until(() => acp.waitingClaims === 1);
		await call({ user: OTHER }, "POST", "/messages", { to: "ajeno", body: "de otro dueño" });
		await new Promise((ok) => setTimeout(ok, 100));
		expect(acp.waitingClaims).toBe(1);
		acp.stopWaiting();
		const res = await pending;
		expect(res.status).toBe(204);
		expect(acp.waitingClaims).toBe(0);
	});
});

describe("ACP definitive deletion (#13): an archived topic, the Archive", () => {
	const PZ = "p-z";
	const SIDS: Record<string, string> = {
		zeta: "d0000000-0000-4000-8000-000000000001",
		yago: "d0000000-0000-4000-8000-000000000002",
	};
	const crid = (n: number) => `d0000000-0000-4000-8000-1000000000${String(n).padStart(2, "0")}`;
	const msg = db_msg();
	function db_msg() {
		return (m: {
			from?: string;
			to?: string;
			state?: string;
			kind?: string;
			project?: string | null;
			conv?: string | null;
			root?: number | null;
			replyTo?: number | null;
		}) =>
			Number(
				db
					.prepare(
						`INSERT INTO agent_messages (owner_user_id, from_id, to_id, kind, body, state, project_id, conversation_id, root_id, reply_to)
						 VALUES (?, ?, ?, ?, 'x', ?, ?, ?, ?, ?)`,
					)
					.run(
						OWNER,
						m.from ?? "owner",
						m.to ?? "zeta",
						m.kind ?? "request",
						m.state ?? "done",
						m.project === undefined ? PZ : m.project,
						m.conv ?? null,
						m.root ?? null,
						m.replyTo ?? null,
					).lastInsertRowid,
			);
	}
	const question = (messageId: number, state: string) =>
		Number(
			db
				.prepare(
					"INSERT INTO agent_questions (owner_user_id, agent, message_id, request, state) VALUES (?, 'zeta', ?, '{}', ?)",
				)
				.run(OWNER, messageId, state).lastInsertRowid,
		);
	const count = (sql: string, ...p: Array<string | number>) =>
		Number((db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get(...p) as { n: number }).n);
	let topic: string;
	let live: string;
	let taskId: number;

	beforeAll(async () => {
		db.prepare(
			"INSERT INTO projects (project_id, owner_user_id, name, client_request_id, request_hash) VALUES (?, ?, 'Borrado', 'c-pz', 'h')",
		).run(PZ, OWNER);
		for (const [name, sid] of Object.entries(SIDS)) {
			db.prepare(
				"INSERT INTO sessions (session_id, user_id, name, container_name, status) VALUES (?, ?, ?, ?, 'running')",
			).run(sid, OWNER, name, `st-${sid.slice(0, 12)}`);
			const a = await acp.create(sid, OWNER, name, { projectId: PZ });
			tokens[name] = acp.tokenFor(a.agent_id);
		}
		const mk = async (n: number, title: string) =>
			(
				await call(owner, "POST", "/conversations", {
					projectId: PZ,
					title,
					clientRequestId: crid(n),
				})
			).body.id as string;
		topic = await mk(1, "Para borrar");
		live = await mk(2, "Sigue viva");
		// The topic's history: a person's request with a consult and its reply,
		// a closed question, an interrupted run never reviewed.
		const root = msg({ conv: topic });
		const consult = msg({ from: "zeta", to: "yago", conv: topic, root });
		msg({ from: "yago", to: "zeta", kind: "reply", conv: topic, root, replyTo: consult });
		question(root, "delivered");
		msg({ conv: topic, state: "uncertain" });
		msg({ conv: live });
		// A finished task that came from it stays, naming it.
		taskId = Number(
			db
				.prepare(
					`INSERT INTO tasks (owner_user_id, project_id, title, status, conversation_id, origin_message_id, created_by, updated_by)
					 VALUES (?, ?, 'hecha', 'done', ?, ?, 'owner', 'owner')`,
				)
				.run(OWNER, PZ, topic, root).lastInsertRowid,
		);
	});

	it("only the person: an agent's token is 403; a foreign or missing topic is 404; a live one is 409 not-archived", async () => {
		expect((await call(as("zeta"), "DELETE", `/conversations/${topic}`)).status).toBe(403);
		expect((await call(as("zeta"), "DELETE", `/projects/${PZ}/archive`)).status).toBe(403);
		expect((await call(as("zeta"), "DELETE", "/agents/zeta/archive")).status).toBe(403);
		expect((await call({ user: OTHER }, "DELETE", `/conversations/${topic}`)).status).toBe(404);
		expect((await call({ user: OTHER }, "DELETE", `/projects/${PZ}/archive`)).status).toBe(404);
		expect((await call({ user: OTHER }, "DELETE", "/agents/zeta/archive")).status).toBe(404);
		expect(
			(await call(owner, "DELETE", "/conversations/d0000000-0000-4000-8000-999999999999")).status,
		).toBe(404);
		expect((await call(owner, "DELETE", "/conversations/nope")).status).toBe(404);
		const r = await call(owner, "DELETE", `/conversations/${topic}`);
		expect(r.status).toBe(409);
		expect(r.body.error).toBe("not-archived");
		expect(count("agent_messages WHERE conversation_id = ?", topic)).toBe(4);
	});

	it("an archived topic still in use is refused with every reason, and nothing is deleted", async () => {
		expect((await call(owner, "POST", `/conversations/${topic}/archive`)).status).toBe(200);
		const pending = msg({ conv: topic, state: "pending" });
		const asking = msg({ conv: topic, state: "done" });
		const q = question(asking, "open");
		db.prepare(
			`INSERT INTO agent_works (owner_user_id, id, agent_id, project_id, branch, port_base, state, created_by, conversation_id)
			 SELECT ?, 'del-w', agent_id, ?, 'work/del-w', 29900, 'active', 'owner', ? FROM acp_agents WHERE name = 'zeta'`,
		).run(OWNER, PZ, topic);
		const open = Number(
			db
				.prepare(
					`INSERT INTO tasks (owner_user_id, project_id, title, conversation_id, created_by, updated_by)
					 VALUES (?, ?, 'abierta', ?, 'owner', 'owner')`,
				)
				.run(OWNER, PZ, topic).lastInsertRowid,
		);
		const r = await call(owner, "DELETE", `/conversations/${topic}`);
		expect(r.status).toBe(409);
		expect(r.body).toEqual({
			error: "in-use",
			reasons: ["message-active", "question-open", "work-open", "task-open"],
		});
		expect(count("agent_messages WHERE conversation_id = ?", topic)).toBe(6);
		// Release each one.
		db.prepare("DELETE FROM agent_messages WHERE id IN (?, ?)").run(pending, asking);
		db.prepare("DELETE FROM agent_questions WHERE id = ?").run(q);
		db.prepare("UPDATE agent_works SET state = 'cleaned' WHERE id = 'del-w'").run();
		db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(open);
	});

	it("a failure half way leaves the topic to retry, and the same verb finishes it; tasks stay", async () => {
		events.length = 0;
		failOnce = /^DELETE FROM agent_messages/;
		expect((await call(owner, "DELETE", `/conversations/${topic}`)).status).toBe(500);
		// Questions went first; the messages and the row are still there.
		expect(
			count(
				"agent_questions WHERE message_id IN (SELECT id FROM agent_messages WHERE conversation_id = ?)",
				topic,
			),
		).toBe(0);
		expect(count("agent_messages WHERE conversation_id = ?", topic)).toBe(4);
		expect(count("conversations WHERE id = ?", topic)).toBe(1);
		const listed = await call(owner, "GET", `/projects/${PZ}/conversations?archived=1`);
		expect(listed.body.map((c: { id: string }) => c.id)).toEqual([topic]);

		expect((await call(owner, "DELETE", `/conversations/${topic}`)).status).toBe(204);
		expect(count("agent_messages WHERE conversation_id = ?", topic)).toBe(0);
		expect(count("conversations WHERE id = ?", topic)).toBe(0);
		expect(events).toContainEqual({ owner: OWNER, type: "deleted" });
		// Done: 404 from now on; the other topic is untouched.
		expect((await call(owner, "DELETE", `/conversations/${topic}`)).status).toBe(404);
		expect((await call(owner, "GET", `/conversations/${topic}/feed`)).status).toBe(404);
		expect(count("agent_messages WHERE conversation_id = ?", live)).toBe(1);
		// The task that came from it stays and still reads.
		const t = await call(owner, "GET", `/tasks/${taskId}`);
		expect(t.status).toBe(200);
		expect(t.body.task).toMatchObject({ id: taskId, conversationId: topic });
		expect(count("task_events WHERE task_id = ?", taskId)).toBeGreaterThan(0);
		// The inbox no longer has its interruption.
		const inbox = await call(owner, "GET", "/inbox");
		expect(
			inbox.body.action.interrupted.filter((m: MessageRowT) => m.conversation_id === topic),
		).toEqual([]);
	});

	it("the previous Project Chat is emptied, keeping every chain still in course", async () => {
		const doneRoot = msg({});
		const doneReply = msg({ from: "zeta", to: "owner", kind: "reply", root: doneRoot });
		question(doneRoot, "withdrawn");
		const busyRoot = msg({});
		const busyConsult = msg({ from: "zeta", to: "yago", root: busyRoot, state: "running" });
		const askRoot = msg({});
		const askQ = question(askRoot, "open");
		const otherProject = msg({ project: "p-1", to: "arquitecto" });
		const inTopic = msg({ conv: live });

		const r = await call(owner, "DELETE", `/projects/${PZ}/archive`);
		expect(r.status).toBe(200);
		expect(r.body).toEqual({ deleted: 2, kept: 3 });
		const left = (ids: number[]) =>
			(
				db
					.prepare(`SELECT id FROM agent_messages WHERE id IN (${ids.map(() => "?").join(",")})`)
					.all(...ids) as Array<{ id: number }>
			).map((x) => x.id);
		expect(
			left([doneRoot, doneReply, busyRoot, busyConsult, askRoot, otherProject, inTopic]),
		).toEqual([busyRoot, busyConsult, askRoot, otherProject, inTopic]);
		expect(count("agent_questions WHERE message_id = ?", doneRoot)).toBe(0);
		expect(count("agent_questions WHERE id = ?", askQ)).toBe(1);
		// The consult ends: its reply (the trigger's) is now what keeps that chain.
		db.prepare("UPDATE agent_messages SET state = 'done' WHERE id = ?").run(busyConsult);
		db.prepare("UPDATE agent_questions SET state = 'delivered' WHERE id = ?").run(askQ);
		expect((await call(owner, "DELETE", `/projects/${PZ}/archive`)).body).toEqual({
			deleted: 1,
			kept: 3,
		});
		db.prepare(
			"UPDATE agent_messages SET state = 'done' WHERE reply_to = ? AND kind = 'reply'",
		).run(busyConsult);
		expect((await call(owner, "DELETE", `/projects/${PZ}/archive`)).body).toEqual({
			deleted: 3,
			kept: 0,
		});
		expect(left([otherProject, inTopic])).toEqual([otherProject, inTopic]);
	});

	it("an agent's individual chat history: its direct messages, with the person and with other agents", async () => {
		const mine = msg({ project: null, to: "yago" });
		const answer = msg({ project: null, from: "yago", to: "owner", kind: "reply", root: mine });
		const toOther = msg({ project: null, from: "yago", to: "zeta" });
		const notYago = msg({ project: null, to: "zeta" });
		const inProject = msg({ to: "yago" });
		const r = await call(owner, "DELETE", "/agents/yago/archive");
		expect(r.status).toBe(200);
		expect(r.body).toEqual({ deleted: 3, kept: 0 });
		const ids = [mine, answer, toOther, notYago, inProject];
		expect(
			(
				db
					.prepare(`SELECT id FROM agent_messages WHERE id IN (${ids.map(() => "?").join(",")})`)
					.all(...ids) as Array<{ id: number }>
			).map((x) => x.id),
		).toEqual([notYago, inProject]);
		expect((await call(owner, "DELETE", "/agents/nadie/archive")).status).toBe(404);
	});
});

type MessageRowT = import("./agents.js").MessageRow;
