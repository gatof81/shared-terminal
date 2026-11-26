/**
 * projects/directory.sqlite.test.ts — projects against a REAL SQLite (D1 is
 * SQLite; `fetch` to the D1 endpoint is answered by an in-memory database),
 * through the real migrations and router: create (idempotent by
 * clientRequestId, per-owner limit), list (ACP agent counts, archived hidden),
 * rename, archive (its agents leave it), owner-only.
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
const realFetch = globalThis.fetch;
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
		const bind = params as Array<string | number | null>;
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
let base = "";
let server: http.Server;

beforeAll(async () => {
	vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
	vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
	vi.stubEnv("D1_DATABASE_ID", "dbid");
	db = new DatabaseSync(":memory:");
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
			return new Response(JSON.stringify(run(body.sql, body.params ?? [])));
		}),
	);
	const { migrateDb } = await import("../db.js");
	await migrateDb();
	db.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, 'owner', 'x')").run(OWNER);
	db.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, 'other', 'x')").run(OTHER);
	const { ProjectDirectory } = await import("./directory.js");
	const { registerProjectRoutes } = await import("../routes/projects.js");
	const router = express.Router();
	const pass = (_req: unknown, _res: unknown, next: () => void) => next();
	registerProjectRoutes(router, {
		projects: new ProjectDirectory(),
		limiters: { projectIp: pass },
	} as never);
	const app = express();
	app.use(express.json());
	app.use("/api", router);
	server = app.listen(0);
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(() => {
	server?.close();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

async function call(user: string | null, method: string, path: string, body?: unknown) {
	const res = await realFetch(base + path, {
		method,
		headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}) },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await res.text();
	return { status: res.status, body: text ? JSON.parse(text) : null };
}
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("projects (ACP)", () => {
	it("create is idempotent by clientRequestId; a different name under the same id is a conflict", async () => {
		const a = await call(OWNER, "POST", "/projects", { name: "Web", clientRequestId: id(1) });
		expect(a.status).toBe(201);
		expect(a.body).toMatchObject({ name: "Web", agentCount: 0, replayed: false });
		const b = await call(OWNER, "POST", "/projects", { name: "Web", clientRequestId: id(1) });
		expect(b.body).toMatchObject({ projectId: a.body.projectId, replayed: true });
		expect(
			(await call(OWNER, "POST", "/projects", { name: "Otro", clientRequestId: id(1) })).body.error,
		).toBe("idempotency-conflict");
		expect(
			(await call(OWNER, "POST", "/projects", { name: "", clientRequestId: id(2) })).status,
		).toBe(400);
		expect(
			(await call(null, "POST", "/projects", { name: "x", clientRequestId: id(3) })).status,
		).toBe(401);
	});

	it("list counts the project's ACP agents; archive hides it and its agents leave it; owner-only", async () => {
		const p = (await call(OWNER, "POST", "/projects", { name: "Equipo", clientRequestId: id(10) }))
			.body;
		db.prepare(
			"INSERT INTO sessions (session_id, user_id, name, container_name, status) VALUES ('s-1', ?, 's', 'st-s1', 'running')",
		).run(OWNER);
		db.prepare(
			"INSERT INTO acp_agents (agent_id, session_id, owner_user_id, name, runtime, project_id) VALUES ('a-1', 's-1', ?, 'dev', 'rt', ?)",
		).run(OWNER, p.projectId);
		const list = (await call(OWNER, "GET", "/projects")).body;
		expect(
			list.projects.find((x: { projectId: string }) => x.projectId === p.projectId).agentCount,
		).toBe(1);
		expect((await call(OTHER, "GET", "/projects")).body.projects).toEqual([]);
		expect((await call(OTHER, "DELETE", `/projects/${p.projectId}`)).status).toBe(404);
		expect((await call(OWNER, "DELETE", `/projects/${p.projectId}`)).status).toBe(204);
		expect(
			(await call(OWNER, "GET", "/projects")).body.projects.some(
				(x: { projectId: string }) => x.projectId === p.projectId,
			),
		).toBe(false);
		expect(db.prepare("SELECT project_id FROM acp_agents WHERE agent_id = 'a-1'").get()).toEqual({
			project_id: null,
		});
		expect((await call(OWNER, "DELETE", `/projects/${p.projectId}`)).status).toBe(404);
	});

	it("rename: one live project, same name rules, owner-only; the id, its agents and messages stay", async () => {
		const p = (await call(OWNER, "POST", "/projects", { name: "Viejo", clientRequestId: id(20) }))
			.body;
		db.prepare(
			"INSERT INTO sessions (session_id, user_id, name, container_name, status) VALUES ('s-2', ?, 's', 'st-s2', 'running')",
		).run(OWNER);
		db.prepare(
			"INSERT INTO acp_agents (agent_id, session_id, owner_user_id, name, runtime, project_id) VALUES ('a-2', 's-2', ?, 'arq', 'rt', ?)",
		).run(OWNER, p.projectId);
		db.prepare(
			"INSERT INTO agent_messages (owner_user_id, from_id, to_id, kind, body, state, project_id) VALUES (?, 'owner', 'arq', 'request', 'hola', 'done', ?)",
		).run(OWNER, p.projectId);

		const r = await call(OWNER, "PATCH", `/projects/${p.projectId}`, { name: "  Nuevo  " });
		expect(r.status).toBe(200);
		expect(r.body).toEqual({
			projectId: p.projectId,
			name: "Nuevo",
			createdAt: p.createdAt,
			agentCount: 1,
		});
		expect(
			(await call(OWNER, "GET", "/projects")).body.projects.find(
				(x: { projectId: string }) => x.projectId === p.projectId,
			).name,
		).toBe("Nuevo");
		expect(db.prepare("SELECT project_id FROM acp_agents WHERE agent_id = 'a-2'").get()).toEqual({
			project_id: p.projectId,
		});
		expect(
			db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE project_id = ?").get(p.projectId),
		).toEqual({ n: 1 });
		// Repeating it (a lost answer) changes nothing.
		expect((await call(OWNER, "PATCH", `/projects/${p.projectId}`, { name: "Nuevo" })).status).toBe(
			200,
		);
		// A replay of the creation still finds the project (by request hash, not by name).
		expect(
			(await call(OWNER, "POST", "/projects", { name: "Viejo", clientRequestId: id(20) })).body,
		).toMatchObject({ projectId: p.projectId, replayed: true });

		for (const body of [
			{ name: "" },
			{ name: "   " },
			{ name: 7 },
			{ name: "x".repeat(81) },
			{ name: "a\u0007b" },
			{ name: "ok", archived: true },
			[],
		]) {
			const bad = await call(OWNER, "PATCH", `/projects/${p.projectId}`, body);
			expect(bad.status, JSON.stringify(body)).toBe(400);
		}
		expect((await call(OTHER, "PATCH", `/projects/${p.projectId}`, { name: "ajeno" })).status).toBe(
			404,
		);
		expect((await call(OWNER, "PATCH", "/projects/not-an-id", { name: "x" })).status).toBe(404);
		expect((await call(null, "PATCH", `/projects/${p.projectId}`, { name: "x" })).status).toBe(401);
		expect(db.prepare("SELECT name FROM projects WHERE project_id = ?").get(p.projectId)).toEqual({
			name: "Nuevo",
		});

		expect((await call(OWNER, "DELETE", `/projects/${p.projectId}`)).status).toBe(204);
		expect(
			(await call(OWNER, "PATCH", `/projects/${p.projectId}`, { name: "Archivado" })).status,
		).toBe(404);
	});
});
