/**
 * routes.list.test.ts — GET /api/sessions user-scoped list (#271).
 *
 * Pins the wire shape after #271 added per-row `cpuLimit`, `memLimit`,
 * and `usage` so the sidebar can display each session's own caps and
 * live cgroup consumption without going through the admin endpoint.
 *
 * Mocking shape mirrors `routes.admin.test.ts`: stub `./auth.js` so
 * `requireAuth` injects a fixed user id, run the router against an
 * ephemeral express server, assert the JSON payload against a typed
 * narrowing.
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
import type { SessionManager } from "./sessionManager.js";
import type { SessionMeta } from "./types.js";

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

function fakeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
	return {
		sessionId: "s1",
		userId: "u1",
		name: "alpha",
		status: "running",
		containerId: "c1",
		containerName: "st-s1",
		cols: 80,
		rows: 24,
		envVars: {},
		createdAt: new Date("2026-05-09T02:00:00Z"),
		lastConnectedAt: null,
		...overrides,
	};
}

async function spinUp(
	listForUser: ReturnType<typeof vi.fn>,
	gatherStats: ReturnType<typeof vi.fn>,
) {
	dbStubs.d1Query.mockResolvedValue({
		results: [],
		success: true,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	});
	const sessions = {
		listForUser,
		listAllForUser: vi.fn(async () => []),
	} as unknown as SessionManager;
	const docker = {
		getUploadTmpDir: () => "/tmp/shared-terminal-test-uploads",
		getReconcileStats: () => ({
			lastRunAt: null,
			sessionsCheckedSinceBoot: 0,
			errorsSinceBoot: 0,
		}),
		gatherStats,
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

interface ListedSession {
	sessionId: string;
	status: string;
	cpuLimit: number | null;
	memLimit: number | null;
	usage: { cpuPercent: number; memBytes: number; memPercent: number } | null;
}

describe("GET /api/sessions (#271 — per-row caps + live usage)", () => {
	beforeEach(() => {
		dbStubs.d1Query.mockReset();
	});

	it("includes cpuLimit/memLimit/usage for running rows, null usage for stopped rows", async () => {
		const listForUser = vi.fn(async () => [
			fakeMeta({ sessionId: "s1", status: "running", containerId: "c1" }),
			fakeMeta({ sessionId: "s2", status: "stopped", containerId: null }),
		]);
		const gatherStats = vi.fn(
			async () =>
				new Map([
					[
						"s1",
						{
							cpuPercent: 42.7,
							memBytes: 200,
							memLimitBytes: 1024 * 1024 * 1024,
							memPercent: 5.4,
						},
					],
				]),
		);
		await spinUp(listForUser, gatherStats);
		// session_configs row for s1 only — s2's caps come back null.
		dbStubs.d1Query.mockImplementation(async (sql: string) => ({
			results: /FROM session_configs/i.test(sql)
				? [{ session_id: "s1", cpu_limit: 1_000_000_000, mem_limit: 1024 * 1024 * 1024 }]
				: [],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));

		const res = await fetch(`${baseUrl}/api/sessions`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as ListedSession[];
		const s1 = body.find((r) => r.sessionId === "s1");
		const s2 = body.find((r) => r.sessionId === "s2");
		expect(s1?.cpuLimit).toBe(1_000_000_000);
		expect(s1?.memLimit).toBe(1024 * 1024 * 1024);
		// Numbers are rounded to 1 decimal by serializeUsage so a cgroup-
		// sample noise floor doesn't leak through to the wire.
		expect(s1?.usage?.cpuPercent).toBe(42.7);
		expect(s1?.usage?.memBytes).toBe(200);
		expect(s2?.cpuLimit).toBeNull();
		expect(s2?.memLimit).toBeNull();
		// Stopped session: no live usage. usage is null — different
		// from "stats fetch failed" which also presents as null but is
		// distinguishable by status.
		expect(s2?.usage).toBeNull();
		// CRITICAL: gatherStats called with the running subset only.
		// A regression that fan-out-ed against stopped/terminated rows
		// would 404-flood the daemon and slow the dashboard with no
		// benefit (stopped containers have no live process to sample).
		expect(gatherStats).toHaveBeenCalledWith([{ sessionId: "s1", containerId: "c1" }]);
	});

	it("returns an empty array (and never calls Docker) when the user has no sessions", async () => {
		const listForUser = vi.fn(async () => []);
		const gatherStats = vi.fn(async () => new Map());
		await spinUp(listForUser, gatherStats);

		const res = await fetch(`${baseUrl}/api/sessions`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
		// CRITICAL: gatherStats called with [] — the route should NOT
		// short-circuit Docker entirely (gatherStats handles empty
		// input as a no-op), but it MUST not be called with anyone
		// else's sessionIds. Pinning the empty-array call locks the
		// scoping invariant.
		expect(gatherStats).toHaveBeenCalledWith([]);
	});

	it("returns 500 with a generic body when listForUser throws (no detail leak)", async () => {
		// Pre-#271 the body had no async work past listForUser and a
		// missing try/catch was harmless. After #271 it has two more
		// async legs that can throw, and the wrap MUST surface a
		// structured 500 rather than letting Express forward the
		// rejection (which surfaces as a closed connection / network
		// error in the browser with no diagnostic).
		const listForUser = vi.fn(async () => {
			throw new Error("D1 transient: connection reset");
		});
		const gatherStats = vi.fn(async () => new Map());
		await spinUp(listForUser, gatherStats);

		const res = await fetch(`${baseUrl}/api/sessions`);
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Internal server error");
		// Detail does not leak — operator gets it via logger.error,
		// browser gets the generic message.
		expect(body.error).not.toContain("D1 transient");
	});

	it("returns 500 with a generic body when gatherStats throws", async () => {
		// Docker socket can be unreachable transiently; the route must
		// not 200 with half a response or close the connection.
		const listForUser = vi.fn(async () => [fakeMeta()]);
		const gatherStats = vi.fn(async () => {
			throw new Error("dockerode: connect ENOENT /var/run/docker.sock");
		});
		await spinUp(listForUser, gatherStats);

		const res = await fetch(`${baseUrl}/api/sessions`);
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Internal server error");
		expect(body.error).not.toContain("ENOENT");
	});
});
