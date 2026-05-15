/**
 * routes.observeLog.test.ts — REST integration for the two observe-log
 * routes (#201d):
 *   - `GET /api/sessions/:id/observe-log` (auth + `assertCanObserve`)
 *   - `GET /api/admin/observe-log` (admin-only)
 *
 * Pins the wire shape (Date → ISO, includes/excludes ownerUsername),
 * the auth gates, and the error-mapping. Mocks `observeLog.ts` at
 * the module boundary so the route's serializer + auth wiring is
 * exercised without driving D1 (unit-level D1 call shapes live in
 * `observeLog.test.ts`).
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authStubs = vi.hoisted(() => ({
	requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
		req.userId = "u1";
		next();
	},
	requireAdmin: vi.fn((req: { userId?: string }, _res: unknown, next: () => void) => {
		req.userId = "u1";
		next();
	}),
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
		results: [] as unknown[],
		success: true as const,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	})),
	getD1CallsSinceBoot: vi.fn(() => 0),
	__resetD1CallsForTests: vi.fn(),
}));
vi.mock("./db.js", () => dbStubs);

// Mock the observeLog module so we drive route assertions on the
// serializer + auth-gate logic without going through D1.
const observeLogStubs = vi.hoisted(() => ({
	listForSession: vi.fn(async () => [] as unknown[]),
	listAll: vi.fn(async () => [] as unknown[]),
	recordObserveStart: vi.fn(async () => "log-uuid"),
	recordObserveEnd: vi.fn(async () => undefined),
	OBSERVE_LOG_LIMIT: 500,
}));
vi.mock("./observeLog.js", () => observeLogStubs);

import type { BootstrapBroadcaster } from "./bootstrap.js";
import type { DockerManager } from "./dockerManager.js";
import { __resetDispatcherStatsForTests } from "./portDispatcher.js";
import { buildRouter } from "./routes.js";
import { ForbiddenError, NotFoundError, type SessionManager } from "./sessionManager.js";

let server: http.Server | null = null;
let baseUrl = "";

const fakeAssertCanObserve = vi.fn();

afterEach(async () => {
	if (server) {
		await new Promise<void>((resolve, reject) => {
			server?.close((e) => (e ? reject(e) : resolve()));
		});
		server = null;
	}
	authStubs.requireAdmin.mockReset();
	authStubs.requireAdmin.mockImplementation((req, _res, next) => {
		(req as { userId?: string }).userId = "u1";
		next();
	});
	fakeAssertCanObserve.mockReset();
});

async function spinUp(): Promise<void> {
	const sessions = {
		assertCanObserve: fakeAssertCanObserve,
		countByStatus: vi.fn(async () => ({ running: 0, stopped: 0, terminated: 0, failed: 0 })),
	} as unknown as SessionManager;
	const docker = {
		getUploadTmpDir: () => "/tmp/shared-terminal-test-uploads",
		getReconcileStats: () => ({
			lastRunAt: null,
			sessionsCheckedSinceBoot: 0,
			errorsSinceBoot: 0,
		}),
	} as unknown as DockerManager;
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

// ── GET /api/sessions/:id/observe-log ───────────────────────────────────────

describe("GET /api/sessions/:id/observe-log", () => {
	beforeEach(() => {
		__resetDispatcherStatsForTests();
		observeLogStubs.listForSession.mockReset();
		observeLogStubs.listForSession.mockResolvedValue([]);
	});

	it("returns the serialised log when assertCanObserve passes (owner/admin/lead)", async () => {
		fakeAssertCanObserve.mockResolvedValueOnce({
			sessionId: "s-1",
			userId: "u-owner",
			status: "running",
		});
		observeLogStubs.listForSession.mockResolvedValueOnce([
			{
				id: "log-1",
				observerUserId: "u-lead",
				observerUsername: "alice",
				sessionId: "s-1",
				ownerUserId: "u-owner",
				startedAt: new Date("2026-05-12T10:00:00Z"),
				endedAt: new Date("2026-05-12T10:05:00Z"),
			},
			{
				id: "log-2",
				observerUserId: "u-lead",
				observerUsername: "alice",
				sessionId: "s-1",
				ownerUserId: "u-owner",
				startedAt: new Date("2026-05-12T09:00:00Z"),
				endedAt: null,
			},
		]);
		await spinUp();
		const res = await fetch(`${baseUrl}/api/sessions/s-1/observe-log`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{
			id: string;
			observerUsername: string;
			startedAt: string;
			endedAt: string | null;
		}>;
		expect(body).toHaveLength(2);
		expect(body[0]?.id).toBe("log-1");
		expect(body[0]?.observerUsername).toBe("alice");
		expect(body[0]?.startedAt).toBe("2026-05-12T10:00:00.000Z");
		expect(body[0]?.endedAt).toBe("2026-05-12T10:05:00.000Z");
		// In-progress observers surface endedAt: null so the owner's UI
		// can render "still watching." This is the live-view contract
		// the audit trail was added for in the first place.
		expect(body[1]?.endedAt).toBeNull();
	});

	it("returns 404 when assertCanObserve throws NotFoundError", async () => {
		fakeAssertCanObserve.mockRejectedValueOnce(new NotFoundError());
		await spinUp();
		const res = await fetch(`${baseUrl}/api/sessions/s-missing/observe-log`);
		expect(res.status).toBe(404);
		// listForSession should NOT have been called — auth fired first.
		expect(observeLogStubs.listForSession).not.toHaveBeenCalled();
	});

	it("returns 403 when assertCanObserve throws ForbiddenError", async () => {
		// A user who's neither owner, admin, nor lead of any group
		// containing the owner — auth must reject BEFORE the log is
		// fetched, otherwise the route would leak existence via
		// "session exists but you can't observe it" vs "session doesn't
		// exist." The 403/404 split mirrors `assertCanObserve`'s
		// existing shape; both are the right answer at the route layer.
		fakeAssertCanObserve.mockRejectedValueOnce(new ForbiddenError());
		await spinUp();
		const res = await fetch(`${baseUrl}/api/sessions/s-1/observe-log`);
		expect(res.status).toBe(403);
		expect(observeLogStubs.listForSession).not.toHaveBeenCalled();
	});

	it("returns 500 when the log fetch throws after a successful auth", async () => {
		fakeAssertCanObserve.mockResolvedValueOnce({
			sessionId: "s-1",
			userId: "u-owner",
			status: "running",
		});
		observeLogStubs.listForSession.mockRejectedValueOnce(new Error("D1 transient"));
		await spinUp();
		const res = await fetch(`${baseUrl}/api/sessions/s-1/observe-log`);
		expect(res.status).toBe(500);
	});

	it("returns an empty array for a session that's never been observed", async () => {
		fakeAssertCanObserve.mockResolvedValueOnce({
			sessionId: "s-1",
			userId: "u-owner",
			status: "running",
		});
		// listForSession default mock returns [].
		await spinUp();
		const res = await fetch(`${baseUrl}/api/sessions/s-1/observe-log`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});
});

// ── GET /api/admin/observe-log ──────────────────────────────────────────────

describe("GET /api/admin/observe-log", () => {
	beforeEach(() => {
		__resetDispatcherStatsForTests();
		observeLogStubs.listAll.mockReset();
		observeLogStubs.listAll.mockResolvedValue([]);
	});

	it("returns the admin-shape log with ownerUsername + observerUsername inlined", async () => {
		observeLogStubs.listAll.mockResolvedValueOnce([
			{
				id: "log-1",
				observerUserId: "u-lead",
				observerUsername: "alice",
				sessionId: "s-1",
				ownerUserId: "u-owner",
				ownerUsername: "bob",
				startedAt: new Date("2026-05-12T10:00:00Z"),
				endedAt: null,
			},
		]);
		await spinUp();
		const res = await fetch(`${baseUrl}/api/admin/observe-log`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{
			ownerUsername: string;
			observerUsername: string;
			endedAt: string | null;
		}>;
		expect(body).toHaveLength(1);
		expect(body[0]?.observerUsername).toBe("alice");
		expect(body[0]?.ownerUsername).toBe("bob");
		expect(body[0]?.endedAt).toBeNull();
	});

	it("returns 403 when requireAdmin denies the caller", async () => {
		authStubs.requireAdmin.mockImplementationOnce(
			(_req: unknown, res: { status: (code: number) => { json: (b: unknown) => void } }) => {
				res.status(403).json({ error: "Admin privileges required" });
			},
		);
		await spinUp();
		const res = await fetch(`${baseUrl}/api/admin/observe-log`);
		expect(res.status).toBe(403);
		// listAll should NOT have been called — admin gate fired first.
		expect(observeLogStubs.listAll).not.toHaveBeenCalled();
	});

	it("returns 500 when the underlying helper throws", async () => {
		observeLogStubs.listAll.mockRejectedValueOnce(new Error("D1 transient"));
		await spinUp();
		const res = await fetch(`${baseUrl}/api/admin/observe-log`);
		expect(res.status).toBe(500);
	});
});
