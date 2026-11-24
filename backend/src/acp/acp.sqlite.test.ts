/**
 * acp/acp.sqlite.test.ts — the ACP message API against a REAL SQLite (D1 is
 * SQLite): `fetch` to the D1 endpoint is answered by an in-memory database,
 * so the real migrations (v1…v24), the v24 reply trigger and indexes and the
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
const realFetch = globalThis.fetch;

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
	acp.onEvent((owner, ev) =>
		events.push({ owner, type: ev.type, ...(ev.type === "message" ? { id: ev.message.id } : {}) }),
	);
	const arq = await acp.create(SID.arq, OWNER, "arquitecto", { projectId: "p-1" });
	const dev = await acp.create(SID.dev, OWNER, "developer", { projectId: "p-1" });
	const solo = await acp.create(SID.solo, OWNER, "solo");
	const alien = await acp.create(SID.alien, OTHER, "ajeno");
	for (const a of [arq, dev, solo, alien]) tokens[a.name] = acp.tokenFor(a.agent_id);
	const app = express();
	app.use("/api/acp", buildAcpRouter(acp));
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
			depth: 1,
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
		const createTab = vi.fn(async (_sid: string, _label?: string, _cmd?: string) => ({
			tabId: "tab-login",
		}));
		(acp as unknown as { docker: unknown }).docker = { createTab };
		const reported = await call(as("arquitecto"), "POST", "/runner/auth-methods", {
			methods: [
				{
					id: "claude-ai-login",
					name: "Claude Subscription",
					terminal: {
						command: "/usr/local/bin/node",
						args: [
							"/opt/st-acp/claude-acp-0.108.0/node_modules/x/index.js",
							"--cli",
							"auth",
							"login",
							"--claudeai",
						],
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
		expect(line).toMatch(
			/^'\/usr\/local\/bin\/node' '\/opt\/st-acp\/[^']+' '--cli' 'auth' 'login' '--claudeai'; /,
		);
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
			depth: 1,
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
	const sendTo = (context?: string, body = "x") =>
		call(owner, "POST", "/messages", { to: "multi", body, ...(context ? { context } : {}) });

	beforeAll(async () => {
		db.prepare(
			"INSERT INTO sessions (session_id, user_id, name, container_name, status) VALUES (?, ?, 'multi', ?, 'running')",
		).run(SIDM, OWNER, `st-${SIDM.slice(0, 12)}`);
		multi = await acp.create(SIDM, OWNER, "multi", { projectId: "p-1" });
		tokens.multi = acp.tokenFor(multi.agent_id);
		tokens["multi@a"] = acp.tokenFor(multi.agent_id, "a");
		tokens["multi@b"] = acp.tokenFor(multi.agent_id, "b");
	});

	it("v24 is recorded; an agent starts with one slot and a named context needs more", async () => {
		expect(db.prepare("SELECT 1 FROM schema_migrations WHERE version = 24").get()).toBeTruthy();
		expect(multi.max_concurrency).toBe(1);
		expect((await sendTo("a")).body.error).toBe("context-needs-slots");
		expect((await sendTo("Mal_Nombre")).body.error).toBe("bad-context");
		expect((await call(owner, "PATCH", "/agents/multi", { maxConcurrency: 9 })).status).toBe(400);
		expect((await call(owner, "PATCH", "/agents/multi", { maxConcurrency: "2" })).status).toBe(400);
		const p = await call(owner, "PATCH", "/agents/multi", { maxConcurrency: 2 });
		expect(p.body.maxConcurrency).toBe(2);
		// Only the person places a message in a context.
		await sendTo(undefined, "para que arquitecto trabaje");
		const r = await call(as("multi"), "POST", "/runner/claim");
		expect(
			(await call(as("multi"), "POST", "/messages", { to: "developer", body: "y", context: "a" }))
				.body.error,
		).toBe("context-owner-only");
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
		const c1 = await claim(1);
		expect(c1.body).toMatchObject({ id: m1.id, slot: 1, context: null, contextToken: null });
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
		expect((await claim(3)).body.id).toBe(m3.id);
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
