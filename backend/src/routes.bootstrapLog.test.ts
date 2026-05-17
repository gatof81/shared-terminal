/**
 * routes.bootstrapLog.test.ts — REST integration for #274's
 * `GET /api/sessions/:id/bootstrap-log` endpoint.
 *
 * Pins owner-gating (assertOwnership), the wire shape (`{ log }` with
 * null vs. string), and 404 on a missing session. The persistence
 * side (the runner writing to the column) is covered in
 * `bootstrap.test.ts`; this file covers the route layer.
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

import type { BootstrapBroadcaster } from "./bootstrap.js";
import type { DockerManager } from "./dockerManager.js";
import { buildRouter } from "./routes.js";
import { NotFoundError, type SessionManager } from "./sessionManager.js";

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

async function spinUp(
	assertOwnership: ReturnType<typeof vi.fn>,
	getBootstrapLog: ReturnType<typeof vi.fn>,
) {
	const sessions = {
		assertOwnership,
		getBootstrapLog,
	} as unknown as SessionManager;
	const docker = {
		getUploadTmpDir: () => "/tmp/shared-terminal-test-uploads",
		getReconcileStats: () => ({
			lastRunAt: null,
			sessionsCheckedSinceBoot: 0,
			errorsSinceBoot: 0,
		}),
		gatherStats: vi.fn(async () => new Map()),
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

describe("GET /sessions/:id/bootstrap-log (#274)", () => {
	beforeEach(() => {
		dbStubs.d1Query.mockReset();
	});

	it("returns 200 with { log: string } when a log was captured", async () => {
		const assertOwnership = vi.fn(async () => ({}) as unknown);
		const getBootstrapLog = vi.fn(async () => "Cloning into target...\nFATAL: clone failed\n");
		await spinUp(assertOwnership, getBootstrapLog);

		const res = await fetch(`${baseUrl}/api/sessions/s1/bootstrap-log`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { log: string | null };
		expect(body.log).toContain("FATAL");
		// Owner-gated path: assertOwnership ran with the authed user
		// id from the requireAuth stub. A regression that skipped this
		// would be a cross-user data leak.
		expect(assertOwnership).toHaveBeenCalledWith("s1", "u1");
	});

	it("returns 200 with { log: null } when no bootstrap output is recorded", async () => {
		// Pre-#274 sessions (column NULL) and bare-create sessions with
		// no hooks both surface as null. Frontend renders a "no captured
		// output" placeholder.
		const assertOwnership = vi.fn(async () => ({}) as unknown);
		const getBootstrapLog = vi.fn(async () => null);
		await spinUp(assertOwnership, getBootstrapLog);

		const res = await fetch(`${baseUrl}/api/sessions/s1/bootstrap-log`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { log: string | null };
		expect(body.log).toBeNull();
	});

	it("returns 404 when assertOwnership throws NotFoundError (foreign or missing session)", async () => {
		// `assertOwnership` collapses missing + foreign-owned into 404
		// (probe-attacker enumeration via status-code timing — same
		// shape as templates / observeLog / the rest of the per-session
		// reads). The bootstrap-log endpoint MUST inherit that gate.
		const assertOwnership = vi.fn(async () => {
			throw new NotFoundError("Session not found");
		});
		const getBootstrapLog = vi.fn(async () => null);
		await spinUp(assertOwnership, getBootstrapLog);

		const res = await fetch(`${baseUrl}/api/sessions/missing/bootstrap-log`);
		expect(res.status).toBe(404);
		// CRITICAL: getBootstrapLog must NOT fire for a non-owned
		// session id. A regression that reached the column read would
		// leak the foreign owner's log content via the response body.
		expect(getBootstrapLog).not.toHaveBeenCalled();
	});
});
