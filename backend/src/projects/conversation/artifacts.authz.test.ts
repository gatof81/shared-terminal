/**
 * Regression for the review finding on #600 ("GET …/artifacts/:sha serves
 * content without an ownership check"), driven through the REAL routes
 * (routes/projectConversation.ts) behind the REAL requireAuth (JWT cookie),
 * with a real store, a really registered artifact and the real Files opener.
 *
 * The authorization chain the finding missed: both artifact routes enter
 * through `artifactGate()` → `gate()`, which answers 404 `project-not-found`
 * unless `api.owns(userId, pid)` — the same owner check every project
 * conversation route uses — BEFORE `art.content()` / `art.register()` run.
 * A foreign authenticated user who knows the project UUID and the sha256
 * therefore gets 404 and zero bytes of the file, and the artifact code is
 * never reached.
 */

import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import express from "express";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = vi.hoisted(() => {
	const dir = `/tmp/st-art-authz-${process.pid}-${Date.now()}`;
	process.env.WORKSPACE_ROOT = dir;
	process.env.JWT_SECRET ??= "artifacts-authz-test-secret-not-for-production";
	return dir;
});

import { AUTH_COOKIE_NAME, signCliToken, validateJwtSecret } from "../../auth.js";
import { registerProjectConversationRoutes } from "../../routes/projectConversation.js";
import type { RouteContext } from "../../routes/shared.js";
import { openWorkspaceFile } from "../../workspaceFiles.js";
import { ProjectConversationApi } from "./api.js";
import { ProjectArtifacts } from "./artifacts.js";
import type { ProjectBindings, ProjectFanout } from "./fanout.js";
import { ProjectConversationStore } from "./store.js";

const PID = "6b1f0c4e-1d2a-4b3c-8d4e-5f6a7b8c9d0e";
const OWNER = "u-owner";
const OTHER = "u-other";
const DEV = "a0000000-0000-4000-8000-00000000000a";
const SID = "5a000000-0000-4000-8000-0000000000aa";
const SECRET_TEXT = "--- a/secret\n+++ b/secret\n+token-shaped-but-fake\n";

let store: ProjectConversationStore;
let server: ReturnType<express.Express["listen"]>;
let base: string;
let sha: string;
let contentCalls: string[];
let registerCalls: string[];

beforeEach(async () => {
	validateJwtSecret();
	await fs.mkdir(path.join(ROOT, SID), { recursive: true });
	await fs.writeFile(path.join(ROOT, SID, "fix.diff"), SECRET_TEXT);
	store = await ProjectConversationStore.start({
		workspaceRoot: ROOT,
		bootId: "authz",
		acquire: async () => ({
			ok: true,
			lock: { held: () => true, onLost: () => {}, release: () => {} },
		}),
	});
	const art = new ProjectArtifacts({
		store,
		workspaceRoot: ROOT,
		// D1's directory semantics: null ⇔ not this owner's project.
		bindings: async (owner, pid): Promise<ProjectBindings | null> =>
			owner === OWNER && pid === PID
				? new Map([
						[DEV, { removed: false, binding: { bindingId: "b", epoch: 1, sessionId: SID } }],
					])
				: null,
		openSource: (sid, rel, o) => openWorkspaceFile(sid, rel, o),
		assertOwner: async () => {},
	});
	const reg = await art.register(OWNER, PID, { agentId: DEV, path: "fix.diff" });
	expect(reg.status).toBe(201);
	sha = (reg.body as { sha256: string }).sha256;

	contentCalls = [];
	registerCalls = [];
	const spied = Object.assign(Object.create(art) as ProjectArtifacts, {
		content: (pid: string, s: string) => {
			contentCalls.push(pid);
			return art.content(pid, s);
		},
		register: (owner: string, pid: string, body: unknown) => {
			registerCalls.push(owner);
			return art.register(owner, pid, body);
		},
	});
	const api = new ProjectConversationApi({
		store,
		fanout: {} as ProjectFanout,
		ownsProject: async (owner, pid) => owner === OWNER && pid === PID,
	});
	const noLimit: express.RequestHandler = (_q, _s, next) => next();
	const ctx = {
		projects: {} as RouteContext["projects"],
		projectConversation: { api, artifacts: spied },
		limiters: new Proxy({}, { get: () => noLimit }),
	} as unknown as RouteContext;
	const app = express();
	app.use(express.json());
	const router = express.Router();
	registerProjectConversationRoutes(router, ctx);
	app.use("/api", router);
	server = app.listen(0, "127.0.0.1");
	await new Promise<void>((r) => server.once("listening", () => r()));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterEach(async () => {
	await new Promise<void>((r) => server.close(() => r()));
	await store.close();
	await fs.rm(ROOT, { recursive: true, force: true });
});
afterAll(async () => {
	await fs.rm(ROOT, { recursive: true, force: true });
});

const cookie = (user: string) => `${AUTH_COOKIE_NAME}=${signCliToken(user, user)}`;
const get = (p: string, user: string | null) =>
	fetch(`${base}${p}`, { headers: user ? { cookie: cookie(user) } : {} });

describe("artifact routes: owner-only through gate() (review finding on #600)", () => {
	it("a foreign authenticated user with the project UUID and the sha256 gets 404 and zero bytes of the file", async () => {
		const r = await get(`/projects/${PID}/conversation/artifacts/${sha}`, OTHER);
		expect(r.status).toBe(404);
		const body = await r.text();
		expect(JSON.parse(body)).toEqual({ error: "project-not-found" });
		expect(body).not.toContain("secret");
		expect(body).not.toContain("token-shaped");
		expect(r.headers.get("content-disposition")).toBeNull();
		// The artifact code was never reached: the owner check comes first.
		expect(contentCalls).toEqual([]);
	});

	it("the same 404 for a foreign user whatever the sha (registered, unknown, malformed): no oracle", async () => {
		for (const s of [sha, "0".repeat(64), "nope"]) {
			const r = await get(`/projects/${PID}/conversation/artifacts/${s}`, OTHER);
			expect({ s, status: r.status, body: await r.json() }).toEqual({
				s,
				status: 404,
				body: { error: "project-not-found" },
			});
		}
		expect(contentCalls).toEqual([]);
	});

	it("a foreign user cannot register from the owner's project either (404, nothing read)", async () => {
		const r = await fetch(`${base}/projects/${PID}/conversation/artifacts`, {
			method: "POST",
			headers: { cookie: cookie(OTHER), "content-type": "application/json" },
			body: JSON.stringify({ agentId: DEV, path: "fix.diff" }),
		});
		expect(r.status).toBe(404);
		expect(await r.json()).toEqual({ error: "project-not-found" });
		expect(registerCalls).toEqual([]);
	});

	it("without a cookie: 401 before anything", async () => {
		const r = await get(`/projects/${PID}/conversation/artifacts/${sha}`, null);
		expect(r.status).toBe(401);
		expect(contentCalls).toEqual([]);
	});

	it("positive control: the owner gets the bytes, as text/plain attachment with nosniff and a sandbox CSP", async () => {
		const r = await get(`/projects/${PID}/conversation/artifacts/${sha}`, OWNER);
		expect(r.status).toBe(200);
		expect(await r.text()).toBe(SECRET_TEXT);
		expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect(r.headers.get("x-content-type-options")).toBe("nosniff");
		expect(r.headers.get("content-disposition")).toBe('attachment; filename="fix.diff"');
		expect(r.headers.get("content-security-policy")).toContain("sandbox");
		expect(r.headers.get("cache-control")).toBe("no-store");
		expect(contentCalls).toEqual([PID]);
	});
});
