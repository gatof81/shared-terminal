/**
 * The D3 grant routes (PROJECT_CONVERSATION.md §7.6, M1) through the REAL
 * router and the REAL requireAuth: they exist only when the holder carries
 * the `collab` key (PROJECT_RELAY_ENABLED effective), they are the owner's
 * alone, and `features.projectRelay` follows the same key.
 */

import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	process.env.JWT_SECRET ??= "collab-routes-test-secret-not-for-production";
});

import { AUTH_COOKIE_NAME, signCliToken, validateJwtSecret } from "../../auth.js";
import { registerProjectConversationRoutes } from "../../routes/projectConversation.js";
import type { RouteContext } from "../../routes/shared.js";
import { ProjectConversationApi } from "./api.js";
import { ProjectCollab } from "./collab.js";
import { type ProjectBindings, ProjectFanout } from "./fanout.js";
import { ProjectConversationStore } from "./store.js";

const PID = "6b1f0c4e-1d2a-4b3c-8d4e-5f6a7b8c9d0e";
const OWNER = "u-owner";
const A = "a0000000-0000-4000-8000-00000000000a";
const B = "b0000000-0000-4000-8000-00000000000b";

let root: string;
let store: ProjectConversationStore;
let collab: ProjectCollab;
let server: ReturnType<express.Express["listen"]>;
let base: string;

async function listen(relay: boolean): Promise<void> {
	const bindings = async (): Promise<ProjectBindings> =>
		new Map(
			[A, B].map((a) => [
				a,
				{
					removed: false,
					binding: { bindingId: `bind-${a[0]}`, epoch: 1, sessionId: `s-${a[0]}` },
				},
			]),
		);
	const fanout = new ProjectFanout({
		store,
		relay,
		bindings,
		target: async () => ({ kind: "ok", cid: "cid" }),
		sessionMeta: async () => ({ userId: OWNER }),
		composerSend: async () => ({
			status: 202,
			body: { result: "delivered", promptId: "p", seq: 1 },
		}),
		onDelivered: () => {},
		onUncertain: () => {},
	});
	collab = new ProjectCollab({
		store,
		fanout,
		bindings,
		recipient: async () => ({ kind: "busy", cid: "cid-x" }),
		onCaptureEvent: () => () => {},
	});
	await collab.start([]);
	const api = new ProjectConversationApi({
		store,
		fanout,
		ownsProject: async (owner, pid) => owner === OWNER && pid === PID,
	});
	const noLimit: express.RequestHandler = (_q, _s, next) => next();
	const ctx = {
		projects: {} as RouteContext["projects"],
		projectConversation: { api, ...(relay ? { collab } : {}) },
		limiters: new Proxy({}, { get: () => noLimit }),
	} as unknown as RouteContext;
	const app = express();
	app.use(express.json());
	const router = express.Router();
	registerProjectConversationRoutes(router, ctx);
	app.use("/api", router);
	server = app.listen(0, "127.0.0.1");
	await new Promise<void>((r) => server.once("listening", () => r()));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`;
}

beforeEach(async () => {
	validateJwtSecret();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-collab-routes-"));
	store = await ProjectConversationStore.start({
		workspaceRoot: root,
		bootId: "routes",
		acquire: async () => ({
			ok: true,
			lock: { held: () => true, onLost: () => {}, release: () => {} },
		}),
	});
});
afterEach(async () => {
	collab.stop();
	await new Promise<void>((r) => server.close(() => r()));
	await store.close();
	await fs.rm(root, { recursive: true, force: true });
});

const call = (method: string, p: string, user: string | null, body?: unknown) =>
	fetch(`${base}${p}`, {
		method,
		headers: {
			...(user ? { cookie: `${AUTH_COOKIE_NAME}=${signCliToken(user, user)}` } : {}),
			...(body ? { "content-type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
const task = () =>
	call("POST", `/${PID}/conversation/messages`, OWNER, {
		clientMessageId: crypto.randomUUID(),
		text: "tarea",
		to: [A],
		collab: { mode: "ask", with: B },
	});

describe("grant routes", () => {
	it("M1: with the relay off the routes do not exist and a `collab` is 409 relay-off, nothing written", async () => {
		await listen(false);
		const r = await task();
		expect(r.status).toBe(409);
		expect(await r.json()).toEqual({ error: "relay-off" });
		for (const [m, p] of [
			["GET", ""],
			["POST", "/pause"],
			["POST", "/resume"],
			["POST", "/revoke"],
		] as const) {
			const g = await call(m, `/${PID}/conversation/grants/c-000000000000${p}`, OWNER);
			expect(g.status).toBe(404);
			// Express's own unknown-route answer, not this API's JSON.
			expect(g.headers.get("content-type")).not.toMatch(/json/);
		}
		expect(await fs.readdir(path.join(root, ".projects")).catch(() => [])).not.toContain(PID);
	});

	it("with the relay on: the owner pauses, resumes and revokes; anyone else gets the project's 404", async () => {
		await listen(true);
		const created = (await (await task()).json()) as { grantId: string };
		const g = `/${PID}/conversation/grants/${created.grantId}`;
		expect((await call("GET", g, null)).status).toBe(401);
		for (const [m, p] of [
			["GET", ""],
			["POST", "/pause"],
			["POST", "/revoke"],
		] as const) {
			const foreign = await call(m, `${g}${p}`, "u-other");
			expect(foreign.status).toBe(404);
			expect(await foreign.json()).toEqual({ error: "project-not-found" });
		}
		expect(await (await call("POST", `${g}/pause`, OWNER)).json()).toMatchObject({
			state: "paused",
		});
		expect(await (await call("POST", `${g}/resume`, OWNER)).json()).toMatchObject({
			state: "live",
		});
		expect(await (await call("GET", g, OWNER)).json()).toMatchObject({
			grant: { grantId: created.grantId, state: "live", initiator: A, with: B },
		});
		expect(await (await call("POST", `${g}/revoke`, OWNER)).json()).toMatchObject({
			state: "ended",
			reason: "revoked",
		});
		const again = await call("POST", `${g}/resume`, OWNER);
		expect(again.status).toBe(409);
		expect(await again.json()).toMatchObject({ error: "grant-ended" });
		expect(
			(await call("POST", `/${PID}/conversation/grants/c-ffffffffffff/pause`, OWNER)).status,
		).toBe(404);
		// No verb beyond the three.
		expect((await call("POST", `${g}/extend`, OWNER)).status).toBe(404);
	});
});
