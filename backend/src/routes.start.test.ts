/**
 * routes.start.test.ts — POST /sessions/:id/start route tests for #185 (PR 185b2a).
 *
 * The bootstrap-runner PR adds a `failed` SessionStatus and the docs
 * promise that a `failed` session is unrecoverable via /start (the user
 * must recreate). This file pins that behaviour: a 409 response with
 * the captured-output guidance, never a silent respawn that hides the
 * unbootstrapped state behind a healthy-looking "running" badge.
 *
 * Heavy mocking pattern follows `rateLimit.test.ts`: stub `./auth.js`
 * so routing tests don't touch D1, then exercise the express app via
 * a real HTTP server bound to an ephemeral port.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authStubs = vi.hoisted(() => ({
	requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
		// Inject a userId so routes downstream of `assertOwnership` see
		// "u1" as the caller. Real `requireAuth` reads the JWT cookie.
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
	InvalidCredentialsError: class extends Error {
		constructor() {
			super("invalid");
		}
	},
	UsernameTakenError: class extends Error {
		constructor() {
			super("taken");
		}
	},
	InviteRequiredError: class extends Error {
		constructor() {
			super("invite required");
		}
	},
	InviteQuotaExceededError: class extends Error {
		constructor() {
			super("invite quota");
		}
	},
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

function makeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
	return {
		sessionId: "sess-1",
		userId: "u1",
		name: "test",
		status: "stopped",
		containerId: null,
		containerName: "st-test",
		cols: 80,
		rows: 24,
		envVars: {},
		createdAt: new Date(),
		lastConnectedAt: null,
		...overrides,
	};
}

// `ownerUserId` defaults to "u1" (the stubbed caller) — an owner start,
// no audit. Pass a different id to model a cross-user (admin) operate:
// `assertCanOperate` resolves (owner OR admin) but `meta.userId !== caller`,
// so the route writes the #429 audit row.
function makeFakeSessions(status: SessionStatus, ownerUserId = "u1"): SessionManager {
	const meta = makeMeta({ status, userId: ownerUserId });
	return {
		// #429: the route authorizes via assertCanOperate now, not
		// assertOwnership.
		assertCanOperate: vi.fn(async () => meta),
		get: vi.fn(async () => ({ ...meta, status: "running" as const })),
	} as unknown as SessionManager;
}

function makeFakeDocker(): {
	docker: DockerManager;
	startSpy: ReturnType<typeof vi.fn>;
} {
	const startSpy = vi.fn(async () => undefined);
	const docker = {
		getUploadTmpDir: () => "/tmp/shared-terminal-test-uploads",
		startContainer: startSpy,
	} as unknown as DockerManager;
	return { docker, startSpy };
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
	// /start route doesn't touch the broadcaster — empty stub object
	// satisfies the now-required parameter without dragging the
	// real implementation in.
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

describe("POST /sessions/:id/start", () => {
	beforeEach(() => {
		dbStubs.d1Query.mockReset();
	});

	it("rejects a `failed` session with 409 and never invokes startContainer", async () => {
		const sessions = makeFakeSessions("failed");
		const { docker, startSpy } = makeFakeDocker();
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/sessions/sess-1/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string };
		// Message must point the user at "recreate" — the bot called this
		// out as the central UX promise of the failed status.
		expect(body.error).toMatch(/recreate/i);
		// Critical: startContainer is never called for failed sessions.
		// Letting it through would silently respawn without postCreate.
		expect(startSpy).not.toHaveBeenCalled();
	});

	it("allows a `stopped` session through to startContainer (regression guard)", async () => {
		const sessions = makeFakeSessions("stopped");
		const { docker, startSpy } = makeFakeDocker();
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/sessions/sess-1/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(200);
		expect(startSpy).toHaveBeenCalledWith("sess-1");
	});

	it("allows a `terminated` session through (soft-delete -> respawn is the documented path)", async () => {
		// CLAUDE.md: "soft delete by default... user can later POST /start
		// to respawn". The new failed-status guard MUST NOT regress that.
		const sessions = makeFakeSessions("terminated");
		const { docker, startSpy } = makeFakeDocker();
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/sessions/sess-1/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(200);
		expect(startSpy).toHaveBeenCalledWith("sess-1");
	});

	// ── #429: operate-tier start + cross-user audit ──────────────────────

	const observeLogWrites = () =>
		dbStubs.d1Query.mock.calls.filter((c) => /session_observe_log/i.test(String(c[0])));

	it("owner start writes NO audit row (caller === owner)", async () => {
		const sessions = makeFakeSessions("stopped", "u1"); // owner is the caller
		const { docker, startSpy } = makeFakeDocker();
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/sessions/sess-1/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(200);
		expect(startSpy).toHaveBeenCalledWith("sess-1");
		// No session_observe_log INSERT for an owner start.
		expect(observeLogWrites()).toHaveLength(0);
	});

	it("cross-user (admin) start succeeds and writes an operate audit row", async () => {
		// assertCanOperate resolves for an admin, but the session is owned by
		// someone else → the route writes a `mode='operate'` audit row.
		const sessions = makeFakeSessions("stopped", "owner-2");
		const { docker, startSpy } = makeFakeDocker();
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/sessions/sess-1/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(200);
		expect(startSpy).toHaveBeenCalledWith("sess-1");
		// A row was written (recordObserveStart INSERT, then recordObserveEnd
		// UPDATE — both touch the observe-log table).
		expect(observeLogWrites().length).toBeGreaterThanOrEqual(1);
		const insert = dbStubs.d1Query.mock.calls.find((c) =>
			/insert\s+into\s+session_observe_log/i.test(String(c[0])),
		);
		expect(insert).toBeDefined();
		// The row carries the operate mode (last positional param in the
		// INSERT is `mode`; see observeLog.recordObserveStart).
		expect(JSON.stringify(insert?.[1])).toContain("operate");
	});

	it("aborts the start with 500 (never spawns) when the cross-user audit INSERT fails", async () => {
		// The audit IS the security mitigation for widening admin power, so
		// it's fail-closed: a D1 failure on the observe-log INSERT must abort
		// BEFORE startContainer runs.
		const sessions = makeFakeSessions("stopped", "owner-2");
		const { docker, startSpy } = makeFakeDocker();
		dbStubs.d1Query.mockImplementation(async (sql: string) => {
			if (/insert\s+into\s+session_observe_log/i.test(String(sql))) {
				throw new Error("d1 down");
			}
			return {
				results: [],
				success: true as const,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			};
		});
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/sessions/sess-1/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(500);
		// Critical: the container is never spawned when the audit can't be written.
		expect(startSpy).not.toHaveBeenCalled();
	});

	it("still starts (200) when only the audit END update fails — fire-and-forget close", async () => {
		// PR #430 review SHOULD-FIX: recordObserveEnd is fire-and-forget per
		// its contract. A D1 transient closing the row must NOT abort a start
		// that already committed its audit INSERT — otherwise the route would
		// 500 AND leave a permanently-open `ended_at = NULL` row for a start
		// it aborted.
		const sessions = makeFakeSessions("stopped", "owner-2");
		const { docker, startSpy } = makeFakeDocker();
		dbStubs.d1Query.mockImplementation(async (sql: string) => {
			// INSERT (recordObserveStart) succeeds; UPDATE (recordObserveEnd) fails.
			if (/update\s+session_observe_log/i.test(String(sql))) {
				throw new Error("d1 transient on close");
			}
			return {
				results: [],
				success: true as const,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			};
		});
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/sessions/sess-1/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(200);
		expect(startSpy).toHaveBeenCalledWith("sess-1");
	});
});
