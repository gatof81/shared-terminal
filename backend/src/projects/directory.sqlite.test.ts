/**
 * projects/directory.sqlite.test.ts — P3a (docs/PROJECTS.md) end to end
 * against a REAL SQLite (node:sqlite; D1 is SQLite): `fetch` to the D1 REST
 * endpoint is answered by an in-memory database, so the real `migrateDb()`
 * (v1…v19), the real triggers and partial unique indexes, the real
 * SessionManager and the real router run. Only Docker and the JWT are fakes.
 *
 * The D1 fake can be told, per statement, to fail like D1 does (an answer
 * with `success: false` ⇒ D1StatementError, "not applied") or like the
 * network does (a timeout whose statement did or did not run, or runs
 * LATE) — the cases PROJECTS.md §3 has to survive.
 */

import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Loaded through require: Vite's resolver (vitest 2) does not know `node:sqlite` as a builtin.
const { DatabaseSync } = createRequire(import.meta.url)(
	"node:sqlite",
) as typeof import("node:sqlite");

// ── Auth: the caller is the `x-test-user` header; the JWT is a fake ─────────
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
			if (!u) {
				res.status(401).json({ error: "unauthenticated" });
				return;
			}
			req.userId = u;
			next();
		},
		requireAdmin: (
			req: { userId?: string },
			res: { status: (n: number) => { json: (b: unknown) => void } },
			next: () => void,
		) => (req.userId === "u-admin" ? next() : res.status(403).json({ error: "admin only" })),
		extractTokenFromCookieHeader: (h: string | undefined) => h?.replace(/^st_token=/, "") ?? null,
		verifyJwt: (t: string | undefined) => (t ? { sub: t } : null),
		hasAnyUsers: async () => true,
	};
});

// ── The D1 fake ────────────────────────────────────────────────────────────

let db: DatabaseSyncT;
const realFetch = globalThis.fetch;
type Fault =
	| { kind: "d1-error"; message: string; status?: number }
	/** The statement runs, then D1 answers with its error envelope anyway (a transient write error). */
	| { kind: "applied-then-d1-error"; message: string; status?: number }
	/** The statement runs, then the answer is lost (client-side timeout). */
	| { kind: "applied-then-timeout" }
	/** Nothing runs before the timeout; the statement lands later, when `release()` is called. */
	| { kind: "late"; release?: () => void }
	/** Timeout, never applied. */
	| { kind: "timeout" };
const faults: Array<{ match: RegExp; fault: Fault; times: number }> = [];
const statements: string[] = [];
/** Optional jitter (ms) before each statement: interleaves concurrent requests. */
let jitterMs = 0;
/** HTTP status of a refused statement's answer: real D1 may use a 4xx with the same envelope. */
let refusalStatus = 200;
/** Called by the Docker fake's kill() / purgeWorkspace(): lets a test land a write mid-delete. */
let onKill: ((sid: string) => void | Promise<void>) | null = null;
let onPurge: ((sid: string) => void | Promise<void>) | null = null;

function run(sql: string, params: unknown[]) {
	try {
		const st = db.prepare(sql);
		const bind = params.map((p) => (typeof p === "boolean" ? Number(p) : p)) as Array<
			string | number | null
		>;
		const returnsRows = /^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
		if (returnsRows) {
			return {
				success: true,
				errors: [],
				result: [
					{
						results: st.all(...bind),
						success: true,
						meta: { changes: 0, duration: 0, last_row_id: 0 },
					},
				],
			};
		}
		const info = st.run(...bind);
		return {
			success: true,
			errors: [],
			result: [
				{
					results: [],
					success: true,
					meta: {
						changes: Number(info.changes),
						duration: 0,
						last_row_id: Number(info.lastInsertRowid),
					},
				},
			],
		};
	} catch (err) {
		return { success: false, errors: [{ message: (err as Error).message }], result: [] };
	}
}

function timeoutError(): DOMException {
	return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

beforeAll(() => {
	vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
	vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
	vi.stubEnv("D1_DATABASE_ID", "dbid");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL, init?: RequestInit) => {
			if (!String(url).includes("/d1/database/")) return realFetch(url, init);
			const { sql, params } = JSON.parse(String(init?.body)) as { sql: string; params: unknown[] };
			statements.push(sql);
			if (jitterMs > 0) await new Promise((r) => setTimeout(r, Math.random() * jitterMs));
			const i = faults.findIndex((f) => f.match.test(sql));
			if (i !== -1) {
				const f = faults[i];
				if (--f.times <= 0) faults.splice(i, 1);
				switch (f.fault.kind) {
					case "d1-error":
						return new Response(
							JSON.stringify({
								success: false,
								errors: [{ message: f.fault.message }],
								result: [],
							}),
							{ status: f.fault.status ?? refusalStatus },
						);
					case "applied-then-d1-error":
						run(sql, params ?? []);
						return new Response(
							JSON.stringify({
								success: false,
								errors: [{ message: f.fault.message }],
								result: [],
							}),
							{ status: f.fault.status ?? refusalStatus },
						);
					case "applied-then-timeout":
						run(sql, params ?? []);
						throw timeoutError();
					case "late": {
						const fault = f.fault;
						fault.release = () => run(sql, params ?? []);
						throw timeoutError();
					}
					case "timeout":
						throw timeoutError();
				}
			}
			const answer = run(sql, params ?? []);
			return new Response(JSON.stringify(answer), { status: answer.success ? 200 : refusalStatus });
		}),
	);
});
afterAll(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

// Imported after the env stubs: db.ts reads the D1 config at module load.
const load = async () => {
	const dbm = await import("../db.js");
	const { buildRouter } = await import("../routes.js");
	const { SessionManager } = await import("../sessionManager.js");
	const { ProjectDirectory } = await import("./directory.js");
	return { dbm, buildRouter, SessionManager, ProjectDirectory };
};

// ── Fixture: the Educación HZ owner, a second user, an admin ───────────────

const OWNER = "u-owner";
const OTHER = "u-other";
const ADMIN = "u-admin";
const S = {
	architect: "3f2a0c1e-1111-4aaa-8aaa-000000000001",
	dev: "a7240c1e-2222-4bbb-9bbb-000000000002",
	qa: "9c0d0c1e-3333-4ccc-accc-000000000003",
	stopped: "d5e60c1e-4444-4ddd-bddd-000000000004",
	terminated: "7e110c1e-5555-4eee-8eee-000000000005",
	foreign: "f0f00c1e-6666-4fff-9fff-000000000006",
};

let server: http.Server | null = null;
let base = "";
const dockerCalls: string[] = [];

async function freshDb() {
	db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys = ON");
	const { dbm } = await load();
	await dbm.migrateDb();
	db.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, 'owner', 'x')").run(OWNER);
	db.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, 'other', 'x')").run(OTHER);
	db.prepare(
		"INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, 'admin', 'x', 1)",
	).run(ADMIN);
	const sess = db.prepare(
		"INSERT INTO sessions (session_id, user_id, name, container_name, status) VALUES (?, ?, ?, ?, ?)",
	);
	sess.run(S.architect, OWNER, "hz-architect", "st-3f2a0c1e-111", "running");
	sess.run(S.dev, OWNER, "hz-dev", "st-a7240c1e-222", "running");
	sess.run(S.qa, OWNER, "hz-qa", "st-9c0d0c1e-333", "running");
	sess.run(S.stopped, OWNER, "hz-design", "st-d5e60c1e-444", "stopped");
	sess.run(S.terminated, OWNER, "hz-old", "st-7e110c1e-555", "terminated");
	sess.run(S.foreign, OTHER, "theirs", "st-f0f00c1e-666", "running");
}

async function startServer(withDirectory: boolean, extras: Record<string, unknown> = {}) {
	const { buildRouter, SessionManager, ProjectDirectory } = await load();
	const docker = {
		getUploadTmpDir: () => "/tmp",
		gatherStats: async () => new Map(),
		kill: async (sid: string) => {
			dockerCalls.push(`kill ${sid}`);
			await onKill?.(sid);
		},
		purgeWorkspace: async (sid: string) => {
			dockerCalls.push(`purge ${sid}`);
			await onPurge?.(sid);
		},
	};
	const app = express();
	app.use(express.json());
	app.use(
		"/api",
		buildRouter(
			new SessionManager(),
			docker as never,
			{} as never,
			undefined,
			undefined,
			undefined,
			withDirectory ? { projects: new ProjectDirectory(), ...extras } : {},
		),
	);
	await stopServer();
	server = http.createServer(app);
	await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(server?.address() as AddressInfo).port}/api`;
}

async function stopServer() {
	if (!server) return;
	await new Promise<void>((r) => server?.close(() => r()));
	server = null;
}

async function api(method: string, path: string, user: string | null, body?: unknown) {
	const headers: Record<string, string> = {};
	if (user) {
		headers["x-test-user"] = user;
		headers.cookie = `st_token=${user}`;
	}
	if (body !== undefined) headers["content-type"] = "application/json";
	const res = await realFetch(`${base}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let json: unknown = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = text;
	}
	return { status: res.status, json: json as Record<string, any>, text };
}

const uuid = () => crypto.randomUUID();
const count = (sql: string, ...p: Array<string | number>) =>
	(db.prepare(sql).get(...p) as { n: number }).n;

async function project(name = "Educación HZ", user = OWNER) {
	const r = await api("POST", "/projects", user, { name, clientRequestId: uuid() });
	expect(r.status).toBe(201);
	return r.json.projectId as string;
}

function agentBody(handle: string, sessionId: string, extra: Record<string, unknown> = {}) {
	return { handle, sessionId, role: "Developer", clientRequestId: uuid(), ...extra };
}

beforeEach(async () => {
	faults.length = 0;
	statements.length = 0;
	dockerCalls.length = 0;
	jitterMs = 0;
	refusalStatus = 200;
	onKill = null;
	onPurge = null;
	await freshDb();
});
afterEach(async () => {
	await stopServer();
});

// ── Migration v19 ──────────────────────────────────────────────────────────

describe("migration v19", () => {
	it("creates the four tables, the live-binding indexes and both triggers; re-running is a no-op", async () => {
		const names = (type: string) =>
			(
				db
					.prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name")
					.all(type) as Array<{ name: string }>
			).map((r) => r.name);
		expect(names("table")).toEqual(
			expect.arrayContaining([
				"projects",
				"project_agents",
				"agent_bindings",
				"project_agent_creations",
			]),
		);
		expect(names("index")).toEqual(
			expect.arrayContaining([
				"idx_agent_bindings_live_agent",
				"idx_agent_bindings_live_session",
				"idx_projects_request",
			]),
		);
		expect(names("trigger")).toEqual(["trg_project_agent_creation", "trg_project_agent_removed"]);
		const v = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number };
		expect(v.v).toBe(19);
		const { dbm } = await load();
		await dbm.migrateDb();
		// Every statement re-applied directly (a crash before the ledger INSERT).
		for (const sql of dbm.PROJECT_DIRECTORY_DDL) db.exec(sql);
		expect(names("trigger")).toHaveLength(2);
	});

	it("a boot that died part-way through v19 converges on the next boot", async () => {
		db = new DatabaseSync(":memory:");
		db.exec("PRAGMA foreign_keys = ON");
		const { dbm } = await load();
		// The 6th statement (the creation-record table) fails once: the boot dies.
		faults.push({
			match: /CREATE TABLE IF NOT EXISTS project_agent_creations/,
			fault: { kind: "d1-error", message: "D1 down" },
			times: 1,
		});
		await expect(dbm.migrateDb()).rejects.toThrow();
		expect(count("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 19")).toBe(0);
		expect(count("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'agent_bindings'")).toBe(1);
		await dbm.migrateDb();
		expect(count("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 19")).toBe(1);
		expect(count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'")).toBe(2);
	});

	it("is additive: no existing table gains or loses a column", async () => {
		const cols = (t: string) =>
			(db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
		const before = {
			sessions: cols("sessions"),
			users: cols("users"),
			claude_conversations: cols("claude_conversations"),
		};
		// Rebuild the same DB WITHOUT v19 and compare.
		db = new DatabaseSync(":memory:");
		db.exec("PRAGMA foreign_keys = ON");
		const { dbm } = await load();
		const all = dbm.MIGRATIONS;
		for (const m of all) if (m.version < 19) await m.apply();
		expect({
			sessions: cols("sessions"),
			users: cols("users"),
			claude_conversations: cols("claude_conversations"),
		}).toEqual(before);
	});

	it("rollback: with v19 applied and agents bound, the previous backend's session SQL still works (no FK to sessions)", async () => {
		await startServer(true);
		const pid = await project();
		expect(
			(await api("POST", `/projects/${pid}/agents`, OWNER, agentBody("developer-hz", S.dev)))
				.status,
		).toBe(201);
		// What the pre-P3a backend does on a hard delete, verbatim shape: the
		// row goes, whatever agent_bindings holds.
		db.prepare("DELETE FROM sessions WHERE session_id = ?").run(S.dev);
		expect(count("SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?", S.dev)).toBe(0);
		// The history survives.
		expect(count("SELECT COUNT(*) AS n FROM agent_bindings WHERE st_session_id = ?", S.dev)).toBe(
			1,
		);
	});
});

// ── Flag off ───────────────────────────────────────────────────────────────

describe("PROJECT_CHAT_ENABLED off", () => {
	beforeEach(async () => {
		await startServer(false);
	});

	it("the routes do not exist: the same 404 as any unknown path, even unauthenticated", async () => {
		const unknown = await api("GET", "/no-such-surface", OWNER);
		for (const [m, p] of [
			["GET", "/projects"],
			["POST", "/projects"],
			["GET", `/projects/${uuid()}/agents`],
			["POST", `/projects/${uuid()}/agents`],
			["GET", `/projects/${uuid()}/agents/${uuid()}`],
			["DELETE", `/projects/${uuid()}/agents/${uuid()}`],
		] as const) {
			for (const user of [OWNER, null]) {
				const r = await api(m, p, user, m === "POST" ? {} : undefined);
				expect({ m, p, status: r.status }).toEqual({ m, p, status: unknown.status });
				expect(r.status).toBe(404);
			}
		}
	});

	it("GET /api/auth/status has exactly the pre-P3a keys", async () => {
		const r = await api("GET", "/auth/status", OWNER);
		expect(Object.keys(r.json)).toEqual([
			"needsSetup",
			"authenticated",
			"isAdmin",
			"isLead",
			"resourceCaps",
			"uiShell",
		]);
	});

	it("GET /api/sessions rows carry no `binding` and read nothing from the directory", async () => {
		db.prepare(
			"INSERT INTO projects (project_id, owner_user_id, name, client_request_id, request_hash) VALUES ('p', ?, 'x', 'c', 'h')",
		).run(OWNER);
		db.prepare(
			"INSERT INTO project_agents (agent_id, project_id, handle) VALUES ('a', 'p', 'dev')",
		).run();
		db.prepare(
			"INSERT INTO agent_bindings (binding_id, agent_id, epoch, st_session_id, state) VALUES ('b', 'a', 1, ?, 'active')",
		).run(S.dev);
		statements.length = 0;
		const r = await api("GET", "/sessions", OWNER);
		expect(r.status).toBe(200);
		expect(
			(r.json as unknown as Array<Record<string, unknown>>).every((row) => !("binding" in row)),
		).toBe(true);
		expect(statements.length).toBeGreaterThan(0);
		expect(statements.some((s) => /agent_bindings|project_agents|projects\b/.test(s))).toBe(false);
	});

	it("a hard delete is still guarded: bindings left by a flag-on run outlive the flag (PROJECTS.md §6)", async () => {
		db.prepare(
			"INSERT INTO projects (project_id, owner_user_id, name, client_request_id, request_hash) VALUES ('p', ?, 'x', 'c', 'h')",
		).run(OWNER);
		db.prepare(
			"INSERT INTO project_agents (agent_id, project_id, handle) VALUES ('a', 'p', 'dev')",
		).run();
		db.prepare(
			"INSERT INTO agent_bindings (binding_id, agent_id, epoch, st_session_id, state) VALUES ('b', 'a', 1, ?, 'active')",
		).run(S.dev);
		const bound = await api("DELETE", `/sessions/${S.dev}?hard=true`, OWNER);
		expect({ status: bound.status, code: bound.json.error }).toEqual({
			status: 409,
			code: "agent-active",
		});
		expect(dockerCalls).toEqual([]);
		const admin = await api("DELETE", `/admin/sessions/${S.dev}?hard=true`, ADMIN);
		expect(admin.status).toBe(409);
		// An unbound session: the pre-P3a delete, plus the one guard read before and after.
		statements.length = 0;
		const free = await api("DELETE", `/sessions/${S.qa}?hard=true`, OWNER);
		expect(free.status).toBe(204);
		expect(dockerCalls).toEqual([`kill ${S.qa}`, `purge ${S.qa}`]);
		expect(statements.filter((q) => /agent_bindings/.test(q))).toHaveLength(2);
		expect(statements.some((q) => /project_agents|projects\b/.test(q))).toBe(false);
		// A soft delete reads nothing from the directory.
		statements.length = 0;
		expect((await api("DELETE", `/sessions/${S.architect}`, OWNER)).status).toBe(204);
		expect(statements.some((q) => /agent_bindings/.test(q))).toBe(false);
	});
});

// ── Projects ───────────────────────────────────────────────────────────────

describe("projects", () => {
	beforeEach(async () => {
		await startServer(true);
	});

	it("create, list, and an idempotent retry", async () => {
		const crid = uuid();
		const a = await api("POST", "/projects", OWNER, {
			name: "  Educación HZ ",
			clientRequestId: crid,
		});
		expect(a.status).toBe(201);
		expect(a.json).toMatchObject({ name: "Educación HZ", agentCount: 0, replayed: false });
		const b = await api("POST", "/projects", OWNER, {
			name: "Educación HZ",
			clientRequestId: crid,
		});
		expect(b.status).toBe(201);
		expect(b.json).toMatchObject({
			projectId: a.json.projectId,
			replayed: true,
			createdAt: a.json.createdAt,
		});
		const c = await api("POST", "/projects", OWNER, { name: "Otro", clientRequestId: crid });
		expect(c.status).toBe(409);
		expect(c.json.error).toBe("idempotency-conflict");
		const l = await api("GET", "/projects", OWNER);
		expect(l.json.projects).toHaveLength(1);
		expect(l.json.can).toEqual({ createProject: { allowed: true } });
		expect((await api("GET", "/projects", OTHER)).json.projects).toEqual([]);
	});

	it("validates the body", async () => {
		for (const body of [
			{ name: "x" },
			{ name: "x", clientRequestId: "not-a-uuid" },
			{ name: "", clientRequestId: uuid() },
			{ name: "a".repeat(81), clientRequestId: uuid() },
			{ name: "bad\u0007name", clientRequestId: uuid() },
			{ name: "rtl‮override", clientRequestId: uuid() },
		]) {
			expect((await api("POST", "/projects", OWNER, body)).status).toBe(400);
		}
		expect(count("SELECT COUNT(*) AS n FROM projects")).toBe(0);
	});

	it("the 50-project limit is one statement; a replay of an earlier request still replays at the limit", async () => {
		const first = uuid();
		await api("POST", "/projects", OWNER, { name: "p0", clientRequestId: first });
		for (let i = 1; i < 50; i++) await project(`p${i}`);
		const over = await api("POST", "/projects", OWNER, { name: "p50", clientRequestId: uuid() });
		expect(over.status).toBe(409);
		expect(over.json.error).toBe("project-limit");
		const replay = await api("POST", "/projects", OWNER, { name: "p0", clientRequestId: first });
		expect(replay.status).toBe(201);
		expect(replay.json.replayed).toBe(true);
	});

	it("a timeout whose INSERT landed answers the created project; one that did not land answers 503 and the retry creates it once", async () => {
		const crid = uuid();
		faults.push({
			match: /INSERT INTO projects/,
			fault: { kind: "applied-then-timeout" },
			times: 1,
		});
		const a = await api("POST", "/projects", OWNER, { name: "HZ", clientRequestId: crid });
		expect(a.status).toBe(201);
		expect(a.json.replayed).toBe(true);
		const crid2 = uuid();
		faults.push({ match: /INSERT INTO projects/, fault: { kind: "timeout" }, times: 1 });
		const b = await api("POST", "/projects", OWNER, { name: "HZ2", clientRequestId: crid2 });
		expect(b.status).toBe(503);
		expect(b.json.error).toBe("outcome-unknown");
		const c = await api("POST", "/projects", OWNER, { name: "HZ2", clientRequestId: crid2 });
		expect(c.status).toBe(201);
		expect(count("SELECT COUNT(*) AS n FROM projects")).toBe(2);
	});
});

// ── Agents ─────────────────────────────────────────────────────────────────

describe("agents: creation", () => {
	let pid: string;
	beforeEach(async () => {
		await startServer(true);
		pid = await project();
	});

	it("creates the agent and its epoch-1 binding in one statement", async () => {
		const before = statements.length;
		const r = await api("POST", `/projects/${pid}/agents`, OWNER, agentBody("developer-hz", S.dev));
		expect(r.status).toBe(201);
		expect(r.json).toMatchObject({
			projectId: pid,
			handle: "developer-hz",
			role: "Developer",
			provider: "claude-code",
			template: null,
			removedAt: null,
			replayed: false,
			binding: { epoch: 1, sessionId: S.dev, state: "active" },
		});
		expect(statements.slice(before)).toHaveLength(1);
		const row = db.prepare("SELECT * FROM agent_bindings").get() as Record<string, unknown>;
		expect(row).toMatchObject({
			agent_id: r.json.agentId,
			binding_id: r.json.binding.bindingId,
			epoch: 1,
			state: "active",
		});
		const agent = db.prepare("SELECT created_at FROM project_agents").get() as {
			created_at: string;
		};
		expect(agent.created_at).toBe(row.created_at);
	});

	it("refuses with stable codes, and creates nothing", async () => {
		const ok = await api(
			"POST",
			`/projects/${pid}/agents`,
			OWNER,
			agentBody("developer-hz", S.dev),
		);
		expect(ok.status).toBe(201);
		const cases: Array<[unknown, number, string]> = [
			[agentBody("developer-hz", S.qa), 409, "handle-taken"],
			[agentBody("qa-hz", S.dev), 409, "session-taken"],
			[agentBody("qa-hz", S.foreign), 404, "session-not-found"],
			[agentBody("qa-hz", S.terminated), 404, "session-not-found"],
			[agentBody("qa-hz", "3f2a0c1e-1111-4aaa-8aaa-999999999999"), 404, "session-not-found"],
			[agentBody("QA", S.qa), 400, "invalid-handle"],
			[agentBody("q", S.qa), 400, "invalid-handle"],
			[agentBody("qa-hz", "not-a-session"), 400, "invalid-session-id"],
			[agentBody("qa-hz", S.qa, { role: "x".repeat(61) }), 400, "invalid-role"],
			[agentBody("qa-hz", S.qa, { clientRequestId: undefined }), 400, "invalid-client-request-id"],
			[[], 400, "invalid-body"],
		];
		for (const [body, status, code] of cases) {
			const r = await api("POST", `/projects/${pid}/agents`, OWNER, body);
			expect({ status: r.status, code: r.json.error }).toEqual({ status, code });
		}
		expect(count("SELECT COUNT(*) AS n FROM project_agents")).toBe(1);
		expect(count("SELECT COUNT(*) AS n FROM agent_bindings")).toBe(1);
		expect(count("SELECT COUNT(*) AS n FROM project_agent_creations")).toBe(1);
	});

	it("a stopped session can be bound (it is the owner's and not deleted); role is optional", async () => {
		const r = await api(
			"POST",
			`/projects/${pid}/agents`,
			OWNER,
			agentBody("designer-hz", S.stopped, { role: undefined }),
		);
		expect(r.status).toBe(201);
		expect(r.json.role).toBeNull();
	});

	it("another owner's project, or a project id that cannot be one, is 404 project-not-found", async () => {
		const theirs = await project("Theirs", OTHER);
		for (const p of [theirs, uuid(), "nope"]) {
			const r = await api("POST", `/projects/${p}/agents`, OWNER, agentBody("qa-hz", S.qa));
			expect({ p, status: r.status, code: r.json.error }).toEqual({
				p,
				status: 404,
				code: "project-not-found",
			});
		}
		// …and the other owner cannot bind MY session into their project.
		const r = await api("POST", `/projects/${theirs}/agents`, OTHER, agentBody("qa-hz", S.qa));
		expect(r.json.error).toBe("session-not-found");
		expect(count("SELECT COUNT(*) AS n FROM project_agents")).toBe(0);
	});

	it("the 32-agent limit is enforced inside the statement", async () => {
		for (let i = 0; i < 32; i++) {
			const sid = crypto.randomUUID();
			db.prepare(
				"INSERT INTO sessions (session_id, user_id, name, container_name) VALUES (?, ?, ?, ?)",
			).run(sid, OWNER, `s${i}`, `st-${i}`);
			expect(
				(await api("POST", `/projects/${pid}/agents`, OWNER, agentBody(`agent-${i}`, sid))).status,
			).toBe(201);
		}
		const list = await api("GET", `/projects/${pid}/agents`, OWNER);
		expect(list.json.can.createAgent).toEqual({ allowed: false, reason: "agent-limit" });
		const r = await api("POST", `/projects/${pid}/agents`, OWNER, agentBody("one-more", S.qa));
		expect({ status: r.status, code: r.json.error }).toEqual({ status: 409, code: "agent-limit" });
	});
});

describe("agents: concurrency and idempotency (PROJECTS.md §3)", () => {
	let pid: string;
	beforeEach(async () => {
		await startServer(true);
		pid = await project();
	});

	it("20 concurrent creations on ONE session: exactly one wins, the rest are session-taken", async () => {
		jitterMs = 15;
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				api("POST", `/projects/${pid}/agents`, OWNER, agentBody(`dev-${i}`, S.dev)),
			),
		);
		expect(results.filter((r) => r.status === 201)).toHaveLength(1);
		expect(
			results.filter((r) => r.status === 409 && r.json.error === "session-taken"),
		).toHaveLength(19);
		expect(
			count(
				"SELECT COUNT(*) AS n FROM agent_bindings WHERE st_session_id = ? AND state IN ('active','draining')",
				S.dev,
			),
		).toBe(1);
		expect(count("SELECT COUNT(*) AS n FROM project_agents")).toBe(1);
	});

	it("two projects racing for one session: one wins (one live binding per session across projects)", async () => {
		const pid2 = await project("Otro proyecto");
		jitterMs = 15;
		const [a, b] = await Promise.all([
			api("POST", `/projects/${pid}/agents`, OWNER, agentBody("dev-a", S.dev)),
			api("POST", `/projects/${pid2}/agents`, OWNER, agentBody("dev-b", S.dev)),
		]);
		expect([a.status, b.status].sort()).toEqual([201, 409]);
		expect(count("SELECT COUNT(*) AS n FROM agent_bindings")).toBe(1);
	});

	it("10 concurrent retries with the SAME clientRequestId: one agent, every answer names it", async () => {
		jitterMs = 15;
		const body = agentBody("developer-hz", S.dev);
		const results = await Promise.all(
			Array.from({ length: 10 }, () => api("POST", `/projects/${pid}/agents`, OWNER, body)),
		);
		expect(results.every((r) => r.status === 201)).toBe(true);
		expect(new Set(results.map((r) => r.json.agentId)).size).toBe(1);
		expect(results.filter((r) => r.json.replayed === false)).toHaveLength(1);
		expect(count("SELECT COUNT(*) AS n FROM project_agents")).toBe(1);
	});

	it("same clientRequestId with another body is 409 idempotency-conflict and changes nothing", async () => {
		const body = agentBody("developer-hz", S.dev);
		await api("POST", `/projects/${pid}/agents`, OWNER, body);
		const r = await api("POST", `/projects/${pid}/agents`, OWNER, { ...body, sessionId: S.qa });
		expect({ status: r.status, code: r.json.error }).toEqual({
			status: 409,
			code: "idempotency-conflict",
		});
		expect(count("SELECT COUNT(*) AS n FROM agent_bindings WHERE st_session_id = ?", S.qa)).toBe(0);
	});

	it("timeout AFTER the write landed: the read-back answers the created agent (201), one agent", async () => {
		faults.push({
			match: /INSERT INTO project_agent_creations/,
			fault: { kind: "applied-then-timeout" },
			times: 1,
		});
		const r = await api("POST", `/projects/${pid}/agents`, OWNER, agentBody("developer-hz", S.dev));
		expect(r.status).toBe(201);
		expect(r.json).toMatchObject({ replayed: true, binding: { state: "active", epoch: 1 } });
		expect(count("SELECT COUNT(*) AS n FROM project_agents")).toBe(1);
	});

	it("timeout whose write lands LATE: 503 outcome-unknown, then the retry names the late agent — never a second one", async () => {
		const late: Fault = { kind: "late" };
		faults.push({ match: /INSERT INTO project_agent_creations/, fault: late, times: 1 });
		const body = agentBody("developer-hz", S.dev);
		const first = await api("POST", `/projects/${pid}/agents`, OWNER, body);
		expect({ status: first.status, code: first.json.error }).toEqual({
			status: 503,
			code: "outcome-unknown",
		});
		expect(count("SELECT COUNT(*) AS n FROM project_agents")).toBe(0);
		(late as { release: () => void }).release(); // the lost write lands now
		const retry = await api("POST", `/projects/${pid}/agents`, OWNER, body);
		expect(retry.status).toBe(201);
		expect(retry.json.replayed).toBe(true);
		const row = db.prepare("SELECT agent_id FROM project_agents").get() as { agent_id: string };
		expect(retry.json.agentId).toBe(row.agent_id);
		expect(count("SELECT COUNT(*) AS n FROM project_agents")).toBe(1);
		expect(count("SELECT COUNT(*) AS n FROM agent_bindings")).toBe(1);
	});

	it("timeout AND a failed read-back: 503, nothing invented; the retry creates exactly one", async () => {
		faults.push({
			match: /INSERT INTO project_agent_creations/,
			fault: { kind: "timeout" },
			times: 1,
		});
		faults.push({ match: /FROM project_agent_creations c/, fault: { kind: "timeout" }, times: 1 });
		const body = agentBody("developer-hz", S.dev);
		expect((await api("POST", `/projects/${pid}/agents`, OWNER, body)).status).toBe(503);
		const retry = await api("POST", `/projects/${pid}/agents`, OWNER, body);
		expect(retry.status).toBe(201);
		expect(retry.json.replayed).toBe(false);
		expect(count("SELECT COUNT(*) AS n FROM project_agents")).toBe(1);
	});

	it("a failure BETWEEN the agent and its binding leaves neither (the statement is all-or-nothing)", async () => {
		db.exec(
			"CREATE TRIGGER test_fail_binding BEFORE INSERT ON agent_bindings BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
		);
		const body = agentBody("developer-hz", S.dev);
		const r = await api("POST", `/projects/${pid}/agents`, OWNER, body);
		// Not a refusal the classifier knows ⇒ not provably "not applied" ⇒ 503.
		expect({ status: r.status, code: r.json.error }).toEqual({
			status: 503,
			code: "outcome-unknown",
		});
		expect(count("SELECT COUNT(*) AS n FROM project_agents")).toBe(0);
		expect(count("SELECT COUNT(*) AS n FROM project_agent_creations")).toBe(0);
		expect(count("SELECT COUNT(*) AS n FROM agent_bindings")).toBe(0);
		db.exec("DROP TRIGGER test_fail_binding");
		// The same request again: the handle and the session are free.
		const retry = await api("POST", `/projects/${pid}/agents`, OWNER, body);
		expect(retry.status).toBe(201);
	});

	it("D1 answering its refusals with HTTP 400 (same envelope): still classified, never 503", async () => {
		refusalStatus = 400;
		expect(
			(await api("POST", `/projects/${pid}/agents`, OWNER, agentBody("developer-hz", S.dev)))
				.status,
		).toBe(201);
		for (const [body, status, code] of [
			[agentBody("developer-hz", S.qa), 409, "handle-taken"],
			[agentBody("qa-hz", S.dev), 409, "session-taken"],
			[agentBody("qa-hz", S.foreign), 404, "session-not-found"],
		] as const) {
			const r = await api("POST", `/projects/${pid}/agents`, OWNER, body);
			expect({ status: r.status, code: r.json.error }).toEqual({ status, code });
		}
		const other = await project("Theirs", OTHER);
		const r = await api("POST", `/projects/${other}/agents`, OWNER, agentBody("qa-hz", S.qa));
		expect({ status: r.status, code: r.json.error }).toEqual({
			status: 404,
			code: "project-not-found",
		});
		// An envelope the classifier does not recognise proves nothing (D1's transient
		// write errors use it): ambiguous, 503 — never "nothing was created".
		faults.push({
			match: /INSERT INTO project_agent_creations/,
			fault: { kind: "d1-error", message: "new", status: 400 },
			times: 1,
		});
		expect(
			(await api("POST", `/projects/${pid}/agents`, OWNER, agentBody("qa-hz", S.qa))).json.error,
		).toBe("outcome-unknown");
		// A 5xx with the envelope proves nothing: ambiguous.
		faults.push({
			match: /INSERT INTO project_agent_creations/,
			fault: { kind: "d1-error", message: "x", status: 502 },
			times: 1,
		});
		expect(
			(await api("POST", `/projects/${pid}/agents`, OWNER, agentBody("qa-hz", S.qa))).json.error,
		).toBe("outcome-unknown");
		expect(count("SELECT COUNT(*) AS n FROM project_agents")).toBe(1);
	});

	it("a transient D1 error in the refusal envelope whose write DID land: the read-back answers 201, never a false 500", async () => {
		// D1 "Network connection lost" / storage reset arrive as success:false; the
		// statement may still have committed.
		faults.push({
			match: /INSERT INTO project_agent_creations/,
			fault: { kind: "applied-then-d1-error", message: "Network connection lost.", status: 400 },
			times: 1,
		});
		const body = agentBody("developer-hz", S.dev);
		const r = await api("POST", `/projects/${pid}/agents`, OWNER, body);
		expect(r.status).toBe(201);
		expect(r.json.replayed).toBe(true);
		// …and when it did NOT land: 503, and the same-id retry creates it once.
		faults.push({
			match: /INSERT INTO project_agent_creations/,
			fault: { kind: "d1-error", message: "Network connection lost.", status: 400 },
			times: 1,
		});
		const body2 = agentBody("qa-hz", S.qa);
		const r2 = await api("POST", `/projects/${pid}/agents`, OWNER, body2);
		expect(r2.json.error).toBe("outcome-unknown");
		expect((await api("POST", `/projects/${pid}/agents`, OWNER, body2)).status).toBe(201);
		expect(count("SELECT COUNT(*) AS n FROM project_agents")).toBe(2);
	});

	it("a removal whose UPDATE comes back with an unrecognised D1 refusal is decided by the read-back", async () => {
		const qa = (await api("POST", `/projects/${pid}/agents`, OWNER, agentBody("qa-hz", S.qa))).json;
		faults.push({
			match: /UPDATE project_agents SET removed_at/,
			fault: { kind: "d1-error", message: "Network connection lost.", status: 400 },
			times: 1,
		});
		const r = await api("DELETE", `/projects/${pid}/agents/${qa.agentId}`, OWNER);
		expect(r.json.error).toBe("outcome-unknown");
		expect((await api("DELETE", `/projects/${pid}/agents/${qa.agentId}`, OWNER)).status).toBe(204);
	});

	it("after a restart (new process: new directory, empty caches) a retry replays, the state is the same", async () => {
		const body = agentBody("developer-hz", S.dev);
		const created = await api("POST", `/projects/${pid}/agents`, OWNER, body);
		await startServer(true); // a new ProjectDirectory and router over the same D1
		const replay = await api("POST", `/projects/${pid}/agents`, OWNER, body);
		expect(replay.json).toMatchObject({ agentId: created.json.agentId, replayed: true });
		const list = await api("GET", `/projects/${pid}/agents`, OWNER);
		expect(list.json.agents.map((a: { agentId: string }) => a.agentId)).toEqual([
			created.json.agentId,
		]);
		const sessions = await api("GET", "/sessions", OWNER);
		const dev = (sessions.json as unknown as Array<Record<string, any>>).find(
			(s) => s.sessionId === S.dev,
		);
		expect(dev?.binding).toMatchObject({ agentId: created.json.agentId, epoch: 1 });
	});
});

describe("agents: reads, boundary and removal", () => {
	let pid: string;
	let dev: Record<string, any>;
	beforeEach(async () => {
		await startServer(true);
		pid = await project();
		dev = (await api("POST", `/projects/${pid}/agents`, OWNER, agentBody("developer-hz", S.dev)))
			.json;
	});

	it("list ≤ 2 D1 reads, detail with the binding history", async () => {
		await api(
			"POST",
			`/projects/${pid}/agents`,
			OWNER,
			agentBody("qa-hz", S.qa, { role: "QA & Release" }),
		);
		const before = statements.length;
		const list = await api("GET", `/projects/${pid}/agents`, OWNER);
		expect(statements.length - before).toBeLessThanOrEqual(2);
		expect(list.status).toBe(200);
		expect(list.json.agents.map((a: { handle: string }) => a.handle)).toEqual([
			"developer-hz",
			"qa-hz",
		]);
		expect(list.json.can).toEqual({ createAgent: { allowed: true } });
		const d = await api("GET", `/projects/${pid}/agents/${dev.agentId}`, OWNER);
		expect(d.json).toMatchObject({
			agentId: dev.agentId,
			projectId: pid,
			capabilities: { capture: true, channels: false, directControl: true },
			binding: { bindingId: dev.binding.bindingId, epoch: 1, sessionId: S.dev, state: "active" },
			bindings: [{ bindingId: dev.binding.bindingId, retiredAt: null, retireReason: null }],
			can: { remove: { allowed: true } },
		});
	});

	it("presence from the capture's rows: the deciding conversation is the newest with a bound pane", async () => {
		const now = new Date().toISOString();
		const old = new Date(Date.now() - 60_000).toISOString();
		const ins = db.prepare(
			`INSERT INTO claude_conversations (session_id, st_session_id, kind, status, status_evidence, status_at, started_at, last_event_at, pane_id)
			 VALUES (?, ?, 'interactive', ?, ?, ?, ?, ?, ?)`,
		);
		ins.run("c-old", S.dev, "ended", "hook:SessionEnd", now, old, now, null); // pane released: never decides
		ins.run("c-live", S.dev, "waiting_permission", "hook:Notification", old, old, old, "%1");
		const list = await api("GET", `/projects/${pid}/agents`, OWNER);
		expect(list.json.agents[0].presence).toEqual({
			value: "needs_attention",
			detail: "waiting_permission",
			source: "hook",
			at: old,
		});
		// A stopped session is `disconnected` from the session row, whatever the capture says.
		db.prepare("UPDATE sessions SET status = 'stopped' WHERE session_id = ?").run(S.dev);
		const after = await api("GET", `/projects/${pid}/agents/${dev.agentId}`, OWNER);
		expect(after.json.presence).toMatchObject({
			value: "disconnected",
			detail: "session-stopped",
			source: "session",
		});
	});

	it("a failed capture read degrades presence to unknown, never fails the directory", async () => {
		faults.push({
			match: /FROM claude_conversations/,
			fault: { kind: "d1-error", message: "D1 down" },
			times: 1,
		});
		const list = await api("GET", `/projects/${pid}/agents`, OWNER);
		expect(list.status).toBe(200);
		expect(list.json.agents[0].presence).toEqual({
			value: "unknown",
			detail: "capture-unreadable",
			source: "capture",
			at: null,
		});
	});

	it("owner-only: another user, an admin, a wrong project id — all the same 404", async () => {
		const other = await project("Otro");
		for (const [user, path] of [
			[OTHER, `/projects/${pid}/agents`],
			[ADMIN, `/projects/${pid}/agents`],
			[OTHER, `/projects/${pid}/agents/${dev.agentId}`],
			[ADMIN, `/projects/${pid}/agents/${dev.agentId}`],
			[OWNER, `/projects/${other}/agents/${dev.agentId}`], // an agent is reachable only through ITS project
			[OWNER, `/projects/${pid}/agents/${uuid()}`],
			[OWNER, `/projects/${pid}/agents/nope`],
		] as const) {
			const r = await api("GET", path, user);
			expect({ user, path, status: r.status }).toEqual({ user, path, status: 404 });
		}
		for (const user of [OTHER, ADMIN]) {
			expect((await api("DELETE", `/projects/${pid}/agents/${dev.agentId}`, user)).status).toBe(
				404,
			);
			expect((await api("DELETE", `/projects/${other}/agents/${dev.agentId}`, OWNER)).status).toBe(
				404,
			);
		}
		expect(count("SELECT COUNT(*) AS n FROM project_agents WHERE removed_at IS NULL")).toBe(1);
		expect((await api("GET", "/projects", null)).status).toBe(401);
	});

	it("removal retires the binding in the same statement, keeps the history, frees the session; idempotent", async () => {
		const before = statements.length;
		const r = await api("DELETE", `/projects/${pid}/agents/${dev.agentId}`, OWNER);
		expect(r.status).toBe(204);
		expect(statements.slice(before).filter((s) => /^\s*UPDATE/.test(s))).toHaveLength(1);
		const b = db
			.prepare("SELECT state, retired_at, retire_reason FROM agent_bindings")
			.get() as Record<string, unknown>;
		expect(b).toMatchObject({ state: "retired", retire_reason: "agent-removed" });
		expect(b.retired_at).not.toBeNull();
		expect((await api("DELETE", `/projects/${pid}/agents/${dev.agentId}`, OWNER)).status).toBe(204);
		const d = await api("GET", `/projects/${pid}/agents/${dev.agentId}`, OWNER);
		expect(d.json).toMatchObject({
			binding: null,
			bindings: [
				{
					bindingId: dev.binding.bindingId,
					state: "retired",
					retireReason: "agent-removed",
					sessionId: S.dev,
				},
			],
			presence: { value: "disconnected", detail: "agent-removed" },
			can: { remove: { allowed: false, reason: "agent-removed" } },
		});
		expect(d.json.removedAt).not.toBeNull();
		expect((await api("GET", `/projects/${pid}/agents`, OWNER)).json.agents).toEqual([]);
		// The handle stays reserved (03: UNIQUE(project, handle)); the session is free.
		expect(
			(await api("POST", `/projects/${pid}/agents`, OWNER, agentBody("developer-hz", S.dev))).json
				.error,
		).toBe("handle-taken");
		const again = await api(
			"POST",
			`/projects/${pid}/agents`,
			OWNER,
			agentBody("developer-hz-2", S.dev),
		);
		expect(again.status).toBe(201);
		expect(again.json.binding.epoch).toBe(1);
	});

	it("removal whose answer is lost: the read-back decides (204 when it landed, 503 when it did not)", async () => {
		faults.push({
			match: /UPDATE project_agents SET removed_at/,
			fault: { kind: "applied-then-timeout" },
			times: 1,
		});
		expect((await api("DELETE", `/projects/${pid}/agents/${dev.agentId}`, OWNER)).status).toBe(204);
		const qa = (await api("POST", `/projects/${pid}/agents`, OWNER, agentBody("qa-hz", S.qa))).json;
		faults.push({
			match: /UPDATE project_agents SET removed_at/,
			fault: { kind: "timeout" },
			times: 1,
		});
		const r = await api("DELETE", `/projects/${pid}/agents/${qa.agentId}`, OWNER);
		expect({ status: r.status, code: r.json.error }).toEqual({
			status: 503,
			code: "outcome-unknown",
		});
		expect(count("SELECT COUNT(*) AS n FROM agent_bindings WHERE state = 'active'")).toBe(1);
	});

	it("GET /api/sessions: `binding` per row from one cached read, invalidated by the directory's writes", async () => {
		const first = await api("GET", "/sessions", OWNER);
		const rows = first.json as unknown as Array<Record<string, any>>;
		expect(rows.find((s) => s.sessionId === S.dev)?.binding).toEqual({
			projectId: pid,
			agentId: dev.agentId,
			handle: "developer-hz",
			bindingId: dev.binding.bindingId,
			epoch: 1,
		});
		expect(rows.find((s) => s.sessionId === S.qa)?.binding).toBeNull();
		const before = statements.filter((s) => /FROM agent_bindings b/.test(s)).length;
		await api("GET", "/sessions", OWNER);
		expect(statements.filter((s) => /FROM agent_bindings b/.test(s)).length).toBe(before); // cached
		await api("POST", `/projects/${pid}/agents`, OWNER, agentBody("qa-hz", S.qa));
		const after = (await api("GET", "/sessions", OWNER)).json as unknown as Array<
			Record<string, any>
		>;
		expect(after.find((s) => s.sessionId === S.qa)?.binding?.handle).toBe("qa-hz");
		// Another owner's list never shows my bindings.
		const theirs = (await api("GET", "/sessions", OTHER)).json as unknown as Array<
			Record<string, any>
		>;
		expect(theirs.map((s) => s.binding)).toEqual([null]);
	});

	it("a failed bindings read leaves `binding` out (unknown), never null, and the list still answers", async () => {
		faults.push({
			match: /FROM agent_bindings b/,
			fault: { kind: "d1-error", message: "D1 down" },
			times: 1,
		});
		const r = await api("GET", "/sessions", OWNER);
		expect(r.status).toBe(200);
		expect(
			(r.json as unknown as Array<Record<string, unknown>>).every((row) => !("binding" in row)),
		).toBe(true);
	});

	it("GET /api/auth/status says features.projectChat", async () => {
		const r = await api("GET", "/auth/status", OWNER);
		expect(r.json.features).toEqual({ projectChat: true });
	});

	it("D1 off (T23): the project conversation routes do not exist and status has no projectConversation", async () => {
		const unknown = await api("GET", "/no-such-surface", OWNER);
		for (const [m, p] of [
			["POST", `/projects/${uuid()}/conversation/messages`],
			["GET", `/projects/${uuid()}/conversation/events`],
			["GET", `/projects/${uuid()}/conversation/messages/${uuid()}`],
			["POST", `/projects/${uuid()}/conversation/acks`],
		] as const) {
			const r = await api(m, p, OWNER, m === "POST" ? {} : undefined);
			expect({ m, p, status: r.status }).toEqual({ m, p, status: unknown.status });
		}
		expect((await api("GET", "/auth/status", OWNER)).json.features).toEqual({ projectChat: true });
	});

	it("D1 on: features.projectConversation, and 503 project-writer-unavailable until the store has its lock", async () => {
		await startServer(true, { projectConversation: { api: null } });
		expect((await api("GET", "/auth/status", OWNER)).json.features).toEqual({
			projectChat: true,
			projectConversation: true,
		});
		const r = await api("POST", `/projects/${uuid()}/conversation/messages`, OWNER, {});
		expect(r.status).toBe(503);
		expect(r.json).toEqual({ error: "project-writer-unavailable" });
		expect((await api("POST", `/projects/${uuid()}/conversation/messages`, null, {})).status).toBe(
			401,
		);
	});

	it("hard delete of a bound session: 409 agent-active BEFORE any effect; after removing the agent it proceeds", async () => {
		const r = await api("DELETE", `/sessions/${S.dev}?hard=true`, OWNER);
		expect({ status: r.status, code: r.json.error }).toEqual({ status: 409, code: "agent-active" });
		expect(dockerCalls).toEqual([]);
		expect(count("SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?", S.dev)).toBe(1);
		// A soft delete is not refused: the row stays, the binding stays readable.
		await api("DELETE", `/projects/${pid}/agents/${dev.agentId}`, OWNER);
		const ok = await api("DELETE", `/sessions/${S.dev}?hard=true`, OWNER);
		expect(ok.status).toBe(204);
		expect(dockerCalls).toEqual([`kill ${S.dev}`, `purge ${S.dev}`]);
		// The agent's history still names the session.
		const d = await api("GET", `/projects/${pid}/agents/${dev.agentId}`, OWNER);
		expect(d.json.bindings[0].sessionId).toBe(S.dev);
	});

	it("the agent page carries generatedAt like the list (§4.5, #569): the clock its presence was read at", async () => {
		const before = Date.now();
		const d = await api("GET", `/projects/${pid}/agents/${dev.agentId}`, OWNER);
		const l = await api("GET", `/projects/${pid}/agents`, OWNER);
		expect(d.status).toBe(200);
		expect(typeof d.json.generatedAt).toBe("string");
		const t = Date.parse(d.json.generatedAt);
		expect(t).toBeGreaterThanOrEqual(before - 1000);
		expect(t).toBeLessThanOrEqual(Date.parse(l.json.generatedAt));
		expect(Object.keys(l.json)).toContain("generatedAt");
	});

	it("an agent bound WHILE the hard delete runs (after the first check) is caught before the purge", async () => {
		onKill = () => {
			db.prepare(
				`INSERT INTO project_agent_creations (owner_user_id, client_request_id, request_hash, project_id, agent_id, binding_id, st_session_id, handle, created_at)
				 VALUES (?, ?, 'h', ?, ?, ?, ?, 'qa-hz', '2026-11-10 13:00:00')`,
			).run(OWNER, uuid(), pid, uuid(), uuid(), S.qa);
		};
		const r = await api("DELETE", `/sessions/${S.qa}?hard=true`, OWNER);
		expect({ status: r.status, code: r.json.error }).toEqual({ status: 409, code: "agent-active" });
		expect(dockerCalls).toEqual([`kill ${S.qa}`]); // never purged
		const row = db.prepare("SELECT status FROM sessions WHERE session_id = ?").get(S.qa) as {
			status: string;
		};
		expect(row.status).toBe("terminated"); // an ordinary soft delete
		// …and once terminated, no creation can bind it any more.
		const late = await api("POST", `/projects/${pid}/agents`, OWNER, agentBody("late-hz", S.qa));
		expect(late.json.error).toBe("session-not-found");
	});

	it("the admin force hard delete re-checks after the terminate too", async () => {
		onKill = () => {
			db.prepare(
				`INSERT INTO project_agent_creations (owner_user_id, client_request_id, request_hash, project_id, agent_id, binding_id, st_session_id, handle, created_at)
				 VALUES (?, ?, 'h', ?, ?, ?, ?, 'qa-hz', '2026-11-10 13:00:00')`,
			).run(OWNER, uuid(), pid, uuid(), uuid(), S.qa);
		};
		const r = await api("DELETE", `/admin/sessions/${S.qa}?hard=true`, ADMIN);
		expect({ status: r.status, code: r.json.error }).toEqual({ status: 409, code: "agent-active" });
		expect(dockerCalls).toEqual([`kill ${S.qa}`]);
		expect(count("SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?", S.qa)).toBe(1);
	});

	it("the admin force hard delete has the same guard", async () => {
		const r = await api("DELETE", `/admin/sessions/${S.dev}?hard=true`, ADMIN);
		expect({ status: r.status, code: r.json.error }).toEqual({ status: 409, code: "agent-active" });
		expect(dockerCalls).toEqual([]);
	});

	it("the hard-delete guard is fail-closed: a failed check refuses the delete", async () => {
		faults.push({
			match: /SELECT 1 AS live FROM agent_bindings/,
			fault: { kind: "d1-error", message: "D1 down" },
			times: 1,
		});
		const r = await api("DELETE", `/sessions/${S.qa}?hard=true`, OWNER);
		expect(r.status).toBe(500);
		expect(dockerCalls).toEqual([]);
	});

	it("a binding whose session row is gone (deleted while the flag was off) reads disconnected · session-gone", async () => {
		db.prepare("DELETE FROM sessions WHERE session_id = ?").run(S.dev);
		const d = await api("GET", `/projects/${pid}/agents/${dev.agentId}`, OWNER);
		expect(d.json.presence).toMatchObject({ value: "disconnected", detail: "session-gone" });
		expect(d.json.can.remove).toEqual({ allowed: true });
	});

	it("binding a session changes nothing about it", async () => {
		const row = (sid: string) => db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sid);
		const before = row(S.qa);
		await api("POST", `/projects/${pid}/agents`, OWNER, agentBody("qa-hz", S.qa));
		expect(row(S.qa)).toEqual(before);
	});
});

describe("hard delete vs a failing bootstrap (PROJECTS.md §6)", () => {
	let pid: string;
	beforeEach(async () => {
		await startServer(true);
		pid = await project();
	});
	const status = (sid: string) =>
		(
			db.prepare("SELECT status FROM sessions WHERE session_id = ?").get(sid) as
				| { status: string }
				| undefined
		)?.status ?? null;
	const liveOn = (sid: string) =>
		count(
			"SELECT COUNT(*) AS n FROM agent_bindings WHERE st_session_id = ? AND state IN ('active','draining')",
			sid,
		);
	const markFailed = async (sid: string) => {
		const { SessionManager } = await load();
		return new SessionManager().markFailed(sid);
	};

	it("markFailed never rewrites terminated; it still flips a live row", async () => {
		expect(await markFailed(S.terminated)).toBe(false);
		expect(status(S.terminated)).toBe("terminated");
		expect(await markFailed(S.qa)).toBe(true);
		expect(status(S.qa)).toBe("failed");
		expect(await markFailed(uuid())).toBe(false); // a row already dropped
	});

	it("the bootstrap's flip landing during the purge leaves the row terminated, and no binding can appear", async () => {
		let attempt: Awaited<ReturnType<typeof api>> | null = null;
		onPurge = async (sid) => {
			expect(await markFailed(sid)).toBe(false);
			attempt = await api("POST", `/projects/${pid}/agents`, OWNER, agentBody("late-hz", sid));
			expect(status(sid)).toBe("terminated");
			expect(liveOn(sid)).toBe(0);
		};
		const r = await api("DELETE", `/sessions/${S.qa}?hard=true`, OWNER);
		expect(r.status).toBe(204);
		expect(attempt).not.toBeNull();
		expect(attempt!.json.error).toBe("session-not-found");
		expect(status(S.qa)).toBeNull();
		expect(count("SELECT COUNT(*) AS n FROM project_agents")).toBe(0);
	});

	it("control: the old unconditional flip WOULD re-open binding during the purge", async () => {
		// What `updateStatus(sid, "failed")` did before markFailed: this is the
		// window the conditional statement closes.
		onPurge = async (sid) => {
			db.prepare("UPDATE sessions SET status = 'failed' WHERE session_id = ?").run(sid);
			const late = await api("POST", `/projects/${pid}/agents`, OWNER, agentBody("late-hz", sid));
			expect(late.status).toBe(201);
		};
		await api("DELETE", `/sessions/${S.qa}?hard=true`, OWNER);
		expect(liveOn(S.qa)).toBe(1); // a live binding to a purged, dropped session
	});

	it("the flip landing before the terminate (during the kill) is overwritten by it; the purge still sees no binding", async () => {
		onKill = async () => {
			expect(await markFailed(S.qa)).toBe(true);
		};
		onPurge = async (sid) => {
			expect(status(sid)).toBe("terminated");
			const late = await api("POST", `/projects/${pid}/agents`, OWNER, agentBody("late-hz", sid));
			expect(late.json.error).toBe("session-not-found");
		};
		expect((await api("DELETE", `/sessions/${S.qa}?hard=true`, OWNER)).status).toBe(204);
		expect(status(S.qa)).toBeNull();
	});

	it("randomised interleavings of hard delete ∥ bootstrap flip ∥ agent creation: a 204 never leaves a live binding, a purge never runs on one", async () => {
		// The racers are aimed at the window that matters: the flip lands after the
		// delete's kill (so around its terminate), the creation either right away
		// (it can win the first check) or after the kill too (so around the second
		// check, the purge and the row drop). With markFailed reverted to the
		// unconditional UPDATE this test fails: a flip after the terminate re-opens
		// binding and a creation then lands between the second check and the drop.
		jitterMs = 3;
		const ins = db.prepare(
			"INSERT INTO sessions (session_id, user_id, name, container_name, status) VALUES (?, ?, ?, ?, 'running')",
		);
		const killed = new Map<string, () => void>();
		onKill = (sid) => killed.get(sid)?.();
		const purgedWithLive: string[] = [];
		const purgedNotTerminated: string[] = [];
		onPurge = async (sid) => {
			// The purge is long: give the racers time to land inside it.
			await new Promise((r) => setTimeout(r, Math.random() * 6));
			if (liveOn(sid) > 0) purgedWithLive.push(sid);
			if (status(sid) !== "terminated") purgedNotTerminated.push(sid);
		};
		const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.random() * ms));
		const outcomes = { deleted: 0, refused: 0 };
		for (let i = 0; i < 60; i++) {
			const sid = uuid();
			ins.run(sid, OWNER, `race-${i}`, `st-${sid.slice(0, 12)}`);
			const afterKill = new Promise<void>((r) => killed.set(sid, r));
			const early = Math.random() < 0.3;
			const [del, , create] = await Promise.all([
				// A delete refused before its kill never fires the hook: release the racers anyway.
				api("DELETE", `/sessions/${sid}?hard=true`, OWNER).finally(() => killed.get(sid)?.()),
				afterKill.then(() => sleep(8)).then(() => markFailed(sid).catch(() => false)),
				(early ? Promise.resolve() : afterKill.then(() => sleep(14))).then(() =>
					api("POST", `/projects/${pid}/agents`, OWNER, agentBody(`race-${i}`, sid)),
				),
			]);
			if (del.status === 204) {
				outcomes.deleted++;
				expect(status(sid)).toBeNull();
				expect(create.status).not.toBe(201);
				expect(liveOn(sid)).toBe(0);
			} else {
				// Refused by the guard: an ordinary soft delete, the agent got it first.
				expect({ status: del.status, code: del.json.error }).toEqual({
					status: 409,
					code: "agent-active",
				});
				expect(create.status).toBe(201);
				expect(liveOn(sid)).toBe(1);
				// Refused at the first check: no effect at all, the row is whatever
				// the bootstrap left. At the second (after the kill): a soft delete.
				const wasKilled = dockerCalls.includes(`kill ${sid}`);
				expect(wasKilled ? ["terminated"] : ["running", "failed"]).toContain(status(sid));
				expect(dockerCalls).not.toContain(`purge ${sid}`);
				outcomes.refused++;
			}
		}
		expect(purgedWithLive).toEqual([]);
		expect(purgedNotTerminated).toEqual([]);
		// Both branches were exercised (a guard that refused everything, or nothing, is not a race).
		expect(outcomes.deleted).toBeGreaterThan(0);
		expect(outcomes.refused).toBeGreaterThan(0);
	});
});

describe("restore (backup.ts TABLES order)", () => {
	it("replaying the four tables into a fresh schema re-creates nothing (the trigger skips existing agents)", async () => {
		await startServer(true);
		const pid = await project();
		await api("POST", `/projects/${pid}/agents`, OWNER, agentBody("developer-hz", S.dev));
		await api("POST", `/projects/${pid}/agents`, OWNER, agentBody("qa-hz", S.qa));
		const removed = (
			await api("POST", `/projects/${pid}/agents`, OWNER, agentBody("architect-hz", S.architect))
		).json;
		await api("DELETE", `/projects/${pid}/agents/${removed.agentId}`, OWNER);
		const tables = [
			"users",
			"sessions",
			"projects",
			"project_agents",
			"agent_bindings",
			"project_agent_creations",
		];
		const dump = Object.fromEntries(
			tables.map((t) => [
				t,
				db.prepare(`SELECT * FROM ${t}`).all() as Array<Record<string, unknown>>,
			]),
		);
		await stopServer();
		db = new DatabaseSync(":memory:");
		db.exec("PRAGMA foreign_keys = ON");
		const { dbm } = await load();
		await dbm.migrateDb();
		// restore's shape: explicit columns, INSERT OR REPLACE, table by table; twice (a --force re-run).
		for (let pass = 0; pass < 2; pass++) {
			for (const t of tables) {
				for (const r of dump[t]) {
					const cols = Object.keys(r);
					db.prepare(
						`INSERT OR REPLACE INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
					).run(...(Object.values(r) as Array<string | number | null>));
				}
			}
		}
		const canon = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).sort();
		for (const t of tables.slice(2)) {
			expect({ t, rows: canon(db.prepare(`SELECT * FROM ${t}`).all()) }).toEqual({
				t,
				rows: canon(dump[t]),
			});
		}
	});
});
