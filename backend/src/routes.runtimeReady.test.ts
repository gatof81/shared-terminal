/**
 * routes.runtimeReady.test.ts — `runtimeReady` field on GET /sessions/:id
 * (#393).
 *
 * The field is the API-visible half of the runtime-readiness signal:
 * true once the entrypoint sentinel is present, false while the
 * container is still provisioning (or predates the sentinel image),
 * null when not determinable (session not running, or the probe
 * errored). Pinned here so a serializer refactor can't silently drop
 * the field or change the null semantics API clients (agenthub) poll
 * against.
 *
 * Scaffolding mirrors routes.start.test.ts: stub `./auth.js` and
 * `./db.js`, exercise the express app over a real ephemeral-port
 * server.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

const authStubs = vi.hoisted(() => ({
	requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
		req.userId = "u1";
		next();
	},
	requireAdmin: (req: { userId?: string }, _res: unknown, next: () => void) => {
		req.userId = "u1";
		next();
	},
	AUTH_COOKIE_NAME: "st_token",
	setAuthCookie: vi.fn(),
	clearAuthCookie: vi.fn(),
	extractTokenFromCookieHeader: vi.fn(() => null),
	verifyJwt: vi.fn(() => null),
	hasAnyUsers: vi.fn(async () => true),
	registerUser: vi.fn(),
	loginUser: vi.fn(),
	listInvites: vi.fn(async () => [] as unknown[]),
	createInvite: vi.fn(),
	revokeInvite: vi.fn(),
	InvalidCredentialsError: class extends Error {},
	UsernameTakenError: class extends Error {},
	InviteRequiredError: class extends Error {},
	InviteQuotaExceededError: class extends Error {},
}));
vi.mock("./auth.js", () => authStubs);

const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({
		results: [],
		success: true as const,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	})),
}));
vi.mock("./db.js", () => dbStubs);

import type { BootstrapBroadcaster } from "./bootstrap.js";
import type { DockerManager } from "./dockerManager.js";
import { buildRouter } from "./routes.js";
import type { SessionManager } from "./sessionManager.js";
import type { SessionMeta, SessionStatus } from "./types.js";

function makeMeta(status: SessionStatus): SessionMeta {
	return {
		sessionId: "sess-1",
		userId: "u1",
		name: "test",
		status,
		containerId: "c1",
		containerName: "st-test",
		cols: 80,
		rows: 24,
		envVars: {},
		createdAt: new Date(),
		lastConnectedAt: null,
	};
}

function makeFakeSessions(status: SessionStatus): SessionManager {
	const meta = makeMeta(status);
	return {
		// #admin-operate: GET /sessions/:id now gates on assertCanOperate.
		assertCanOperate: vi.fn(async () => meta),
	} as unknown as SessionManager;
}

function makeFakeDocker(isRuntimeReady: () => Promise<boolean>): {
	docker: DockerManager;
	probeSpy: ReturnType<typeof vi.fn>;
} {
	const probeSpy = vi.fn(isRuntimeReady);
	const docker = {
		// buildRouter wires multer's disk storage at mount time.
		getUploadTmpDir: () => "/tmp/shared-terminal-test-uploads",
		isRuntimeReady: probeSpy,
	} as unknown as DockerManager;
	return { docker, probeSpy };
}

let server: http.Server | null = null;
let baseUrl = "";

afterEach(async () => {
	if (server) {
		await new Promise<void>((resolve, reject) => {
			server?.close((e) => (e ? reject(e) : resolve()));
		});
		server = null;
	}
});

async function spinUp(sessions: SessionManager, docker: DockerManager) {
	const broadcaster = {} as BootstrapBroadcaster;
	const router = buildRouter(sessions, docker, broadcaster, {
		login: { ipMax: 1000, ipWindowMs: 60_000, usernameMax: 1000, usernameWindowMs: 60_000 },
		register: { ipMax: 1000, ipWindowMs: 60_000 },
		invitesCreate: { ipMax: 1000, ipWindowMs: 60_000 },
		invitesList: { ipMax: 1000, ipWindowMs: 60_000 },
		invitesRevoke: { ipMax: 1000, ipWindowMs: 60_000 },
		fileUpload: { ipMax: 1000, ipWindowMs: 60_000 },
		logout: { ipMax: 1000, ipWindowMs: 60_000 },
		authStatus: { ipMax: 1000, ipWindowMs: 60_000 },
		adminStats: { ipMax: 1000, ipWindowMs: 60_000 },
		adminAction: { ipMax: 1000, ipWindowMs: 60_000 },
		exec: { ipMax: 1000, ipWindowMs: 60_000 },
	});
	const app = express();
	app.use(express.json());
	app.use("/api", router);
	const s = http.createServer(app);
	server = s;
	await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
	const { port } = s.address() as AddressInfo;
	baseUrl = `http://127.0.0.1:${port}`;
}

describe("GET /sessions/:id runtimeReady (#393)", () => {
	it("reports true for a running session whose probe succeeds", async () => {
		const { docker, probeSpy } = makeFakeDocker(async () => true);
		await spinUp(makeFakeSessions("running"), docker);
		const res = await fetch(`${baseUrl}/api/sessions/sess-1`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { runtimeReady: boolean | null };
		expect(body.runtimeReady).toBe(true);
		// The route passes the meta assertOwnership already fetched so the
		// probe skips its own D1 read (PR #399 review SHOULD-FIX).
		expect(probeSpy).toHaveBeenCalledWith("sess-1", expect.objectContaining({ status: "running" }));
	});

	it("reports false while the sentinel hasn't appeared yet", async () => {
		const { docker } = makeFakeDocker(async () => false);
		await spinUp(makeFakeSessions("running"), docker);
		const res = await fetch(`${baseUrl}/api/sessions/sess-1`);
		const body = (await res.json()) as { runtimeReady: boolean | null };
		expect(body.runtimeReady).toBe(false);
	});

	it("reports null without probing when the session is not running", async () => {
		const { docker, probeSpy } = makeFakeDocker(async () => true);
		await spinUp(makeFakeSessions("stopped"), docker);
		const res = await fetch(`${baseUrl}/api/sessions/sess-1`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { runtimeReady: boolean | null };
		expect(body.runtimeReady).toBeNull();
		expect(probeSpy).not.toHaveBeenCalled();
	});

	it("reports null (not 500) when the probe itself errors", async () => {
		// Container mid-teardown / daemon hiccup: "unknown" is the honest
		// answer for a status-shaped field — a 500 would make pollers
		// treat a transient docker error as a session failure.
		const { docker } = makeFakeDocker(async () => {
			throw new Error("docker daemon unreachable");
		});
		await spinUp(makeFakeSessions("running"), docker);
		const res = await fetch(`${baseUrl}/api/sessions/sess-1`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { runtimeReady: boolean | null };
		expect(body.runtimeReady).toBeNull();
	});
});
