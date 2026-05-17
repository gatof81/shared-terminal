/**
 * routes.admin.test.ts — GET /api/admin/stats route tests for #241.
 *
 * Pins the wire shape (`bootedAt`, `uptimeSeconds`, `sessions.byStatus`)
 * and the admin gate. The actual `countByStatus` SQL shape is pinned
 * in `sessionManager.test.ts`; this file is the integration glue
 * (rate limiter wiring, requireAdmin wiring, JSON shape contract).
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
	// vi.fn so tests can flip the admin gate per-case (the 403 path
	// switches the impl to deny). Default is passthrough.
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
	// Counter accessor added in #241b. Constant zero is fine — this
	// test pins JSON shape, not specific counter values; per-call
	// counter behaviour is exercised in `db.test.ts`.
	getD1CallsSinceBoot: vi.fn(() => 0),
	__resetD1CallsForTests: vi.fn(),
}));
vi.mock("./db.js", () => dbStubs);

import type { BootstrapBroadcaster } from "./bootstrap.js";
import type { DockerManager } from "./dockerManager.js";
import { __resetDispatcherStatsForTests } from "./portDispatcher.js";
import { buildRouter } from "./routes.js";
import type { SessionManager } from "./sessionManager.js";

let server: http.Server | null = null;
let baseUrl = "";

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
});

interface AdminSpinUp {
	sessions?: Partial<SessionManager>;
	docker?: Partial<DockerManager>;
}

async function spinUp(countByStatus: ReturnType<typeof vi.fn>, overrides: AdminSpinUp = {}) {
	// Restore a benign default after the per-suite `mockReset()` so the
	// `/admin/sessions` route's batched `listResourceCaps` D1 read (#270)
	// always has SOMETHING to await — without this the call returns
	// `undefined` and the route 500s on the `result.results` access.
	// Tests that need specific D1 behaviour call `mockResolvedValueOnce`
	// / `mockImplementation` AFTER spinUp to override, so this default
	// only fires for tests that don't pin per-case behaviour.
	dbStubs.d1Query.mockResolvedValue({
		results: [],
		success: true,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	});
	const sessions = {
		countByStatus,
		// Resource-snapshot helper for `/admin/stats` (#270) calls listAll
		// directly. Default to an empty list so tests that only care about
		// the legacy stats shape don't have to wire it; cases that exercise
		// the `resources` block override.
		listAll: vi.fn(async () => []),
		// Guard: any other SessionManager method called by this route's
		// path that's not overridden is undefined — calling it surfaces
		// as a 500 with a clear "is not a function" message rather than
		// silent test pass.
		...overrides.sessions,
	} as unknown as SessionManager;
	const docker = {
		getUploadTmpDir: () => "/tmp/shared-terminal-test-uploads",
		// Reconcile counters added in #241b. Constant test stub —
		// individual cases that care about specific values can
		// override via the `as unknown as DockerManager` cast.
		getReconcileStats: () => ({
			lastRunAt: null,
			sessionsCheckedSinceBoot: 0,
			errorsSinceBoot: 0,
		}),
		// #270 — `/admin/stats` snapshot + `/admin/sessions` list both
		// call gatherStats. Default to an empty Map so tests that don't
		// care about live usage stay quiet; specific tests override.
		gatherStats: vi.fn(async () => new Map()),
		...overrides.docker,
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

describe("GET /api/admin/stats (#241a)", () => {
	beforeEach(() => {
		dbStubs.d1Query.mockReset();
		// Dispatcher counters live as module-level state in
		// `portDispatcher.ts`; reset between cases so a count
		// from a previous test (or another file in the same
		// vitest run) doesn't leak into the wire-shape assertion.
		__resetDispatcherStatsForTests();
	});

	it("returns the typed stats shape with bootedAt / uptimeSeconds / sessions.byStatus + subsystem counters (#241b)", async () => {
		const countByStatus = vi.fn(async () => ({
			running: 3,
			stopped: 2,
			terminated: 1,
			failed: 0,
		}));
		await spinUp(countByStatus);

		const res = await fetch(`${baseUrl}/api/admin/stats`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			bootedAt: string;
			uptimeSeconds: number;
			sessions: { byStatus: Record<string, number> };
			idleSweeper: unknown;
			reconcile: {
				lastRunAt: number | null;
				sessionsCheckedSinceBoot: number;
				errorsSinceBoot: number;
			};
			dispatcher: {
				requestsSinceBoot: number;
				responses2xxSinceBoot: number;
				responses3xxSinceBoot: number;
				responses4xxSinceBoot: number;
				responses5xxSinceBoot: number;
			};
			d1: { callsSinceBoot: number };
			resources: {
				runningCount: number;
				statsAvailable: number;
				totalCpuPercent: number;
				totalMemBytes: number;
				totalCpuLimitNanos: number;
				totalMemLimitBytes: number;
				limits: {
					minCpuNanos: number;
					maxCpuNanos: number;
					minMemBytes: number;
					maxMemBytes: number;
					defaultCpuNanos: number;
					defaultMemBytes: number;
				};
			};
		};
		// `bootedAt` is derived from process.uptime() — must be a parseable
		// ISO string. The exact value depends on test-run timing, so we
		// pin the type/parseability rather than a literal value.
		expect(typeof body.bootedAt).toBe("string");
		expect(Number.isNaN(Date.parse(body.bootedAt))).toBe(false);
		// uptimeSeconds is a non-negative integer (rounded server-side).
		expect(Number.isInteger(body.uptimeSeconds)).toBe(true);
		expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
		// Counts pass through verbatim.
		expect(body.sessions.byStatus).toEqual({
			running: 3,
			stopped: 2,
			terminated: 1,
			failed: 0,
		});
		expect(countByStatus).toHaveBeenCalledTimes(1);
		// #241b: subsystem counters present on the wire. `idleSweeper` is
		// null because spinUp's stub doesn't pass a sweeper — the route
		// must serialise null rather than crash on the optional accessor.
		expect(body.idleSweeper).toBeNull();
		expect(body.reconcile).toEqual({
			lastRunAt: null,
			sessionsCheckedSinceBoot: 0,
			errorsSinceBoot: 0,
		});
		// #241c: dispatcher counters present on the wire. All zero
		// because this test fixture doesn't exercise the dispatcher
		// middleware (the router is built but no request flows
		// through it during `/admin/stats` handling).
		expect(body.dispatcher).toEqual({
			requestsSinceBoot: 0,
			responses2xxSinceBoot: 0,
			responses3xxSinceBoot: 0,
			responses4xxSinceBoot: 0,
			responses5xxSinceBoot: 0,
		});
		expect(body.d1).toEqual({ callsSinceBoot: 0 });
		// #270: resources block is always present. Empty list of running
		// sessions → all totals zero, but the `limits` block still
		// surfaces the per-session min/max/default the form needs.
		expect(body.resources.runningCount).toBe(0);
		expect(body.resources.statsAvailable).toBe(0);
		expect(body.resources.totalCpuPercent).toBe(0);
		expect(body.resources.totalMemBytes).toBe(0);
		expect(body.resources.limits.maxCpuNanos).toBeGreaterThan(0);
		expect(body.resources.limits.maxMemBytes).toBeGreaterThan(0);
		expect(body.resources.limits.defaultCpuNanos).toBeGreaterThan(0);
		expect(body.resources.limits.defaultMemBytes).toBeGreaterThan(0);
	});

	it("returns 403 when requireAdmin denies the request (non-admin user)", async () => {
		// Flip the admin gate to deny — mirrors the real `requireAdmin`
		// behaviour for non-admin users.
		authStubs.requireAdmin.mockImplementation((_req, res, _next) => {
			(res as { status: (n: number) => { json: (body: unknown) => void } })
				.status(403)
				.json({ error: "Forbidden" });
		});
		const countByStatus = vi.fn(async () => ({
			running: 0,
			stopped: 0,
			terminated: 0,
			failed: 0,
		}));
		await spinUp(countByStatus);

		const res = await fetch(`${baseUrl}/api/admin/stats`);
		expect(res.status).toBe(403);
		// Critical: countByStatus must NOT be invoked when the admin
		// gate denies. A regression that ran the handler regardless
		// would surface to a non-admin user as cross-user data leak.
		expect(countByStatus).not.toHaveBeenCalled();
	});

	it("returns 500 with a generic error body when countByStatus throws", async () => {
		// D1 transient error path. Don't leak the exception message
		// (could include schema details) — generic body, full
		// detail goes to logger.error.
		const countByStatus = vi.fn(async () => {
			throw new Error("D1 transient: connection reset");
		});
		await spinUp(countByStatus);

		const res = await fetch(`${baseUrl}/api/admin/stats`);
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Internal server error");
		expect(body.error).not.toContain("D1 transient");
	});
});

// ── Cross-user sessions list + force-actions (#241d) ─────────────────────

describe("GET /api/admin/sessions (#241d)", () => {
	beforeEach(() => {
		dbStubs.d1Query.mockReset();
		__resetDispatcherStatsForTests();
	});

	function fakeSession(sessionId: string, userId: string, ownerUsername: string) {
		return {
			sessionId,
			userId,
			name: sessionId,
			status: "running" as const,
			containerId: null,
			containerName: `st-${sessionId}`,
			cols: 80,
			rows: 24,
			envVars: {},
			createdAt: new Date("2026-05-09T02:00:00Z"),
			lastConnectedAt: null,
			ownerUsername,
		};
	}

	it("returns rows across users with ownerUsername attached", async () => {
		const listAll = vi.fn(async () => [
			fakeSession("s1", "u1", "alice"),
			fakeSession("s2", "u2", "bob"),
		]);
		await spinUp(vi.fn(), { sessions: { listAll } as unknown as Partial<SessionManager> });

		const res = await fetch(`${baseUrl}/api/admin/sessions`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{
			sessionId: string;
			userId: string;
			ownerUsername: string;
		}>;
		expect(body).toHaveLength(2);
		expect(body[0]?.ownerUsername).toBe("alice");
		expect(body[1]?.userId).toBe("u2");
		expect(listAll).toHaveBeenCalledTimes(1);
	});

	it("returns 403 when requireAdmin denies (non-admin user) without calling listAll", async () => {
		authStubs.requireAdmin.mockImplementation((_req, res, _next) => {
			(res as { status: (n: number) => { json: (b: unknown) => void } })
				.status(403)
				.json({ error: "Forbidden" });
		});
		const listAll = vi.fn(async () => [] as never[]);
		await spinUp(vi.fn(), { sessions: { listAll } as unknown as Partial<SessionManager> });

		const res = await fetch(`${baseUrl}/api/admin/sessions`);
		expect(res.status).toBe(403);
		// CRITICAL: a regression that ran the handler regardless of the
		// admin gate would be a cross-user data leak.
		expect(listAll).not.toHaveBeenCalled();
	});

	it("returns 500 with a generic body when listAll throws (no detail leak)", async () => {
		const listAll = vi.fn(async () => {
			throw new Error("D1 transient: connection reset");
		});
		await spinUp(vi.fn(), { sessions: { listAll } as unknown as Partial<SessionManager> });

		const res = await fetch(`${baseUrl}/api/admin/sessions`);
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Internal server error");
		expect(body.error).not.toContain("D1 transient");
	});
});

describe("POST /api/admin/sessions/:id/stop (#241d)", () => {
	beforeEach(() => {
		dbStubs.d1Query.mockReset();
		__resetDispatcherStatsForTests();
	});

	function meta() {
		return {
			sessionId: "s-any",
			userId: "u-foreign", // NOT the admin's id — proves no ownership check
			name: "s-any",
			status: "running" as const,
			containerId: "c1",
			containerName: "st-s-any",
			cols: 80,
			rows: 24,
			envVars: {},
			createdAt: new Date(),
			lastConnectedAt: null,
		};
	}

	it("force-stops any session (no ownership check) and returns 204", async () => {
		const get = vi.fn(async () => meta());
		const stopContainer = vi.fn(async () => undefined);
		await spinUp(vi.fn(), {
			sessions: { get } as unknown as Partial<SessionManager>,
			docker: { stopContainer } as unknown as Partial<DockerManager>,
		});

		const res = await fetch(`${baseUrl}/api/admin/sessions/s-any/stop`, { method: "POST" });
		expect(res.status).toBe(204);
		expect(stopContainer).toHaveBeenCalledWith("s-any");
	});

	it("returns 404 when the session id doesn't exist", async () => {
		const get = vi.fn(async () => null);
		const stopContainer = vi.fn(async () => undefined);
		await spinUp(vi.fn(), {
			sessions: { get } as unknown as Partial<SessionManager>,
			docker: { stopContainer } as unknown as Partial<DockerManager>,
		});

		const res = await fetch(`${baseUrl}/api/admin/sessions/missing/stop`, { method: "POST" });
		expect(res.status).toBe(404);
		// stopContainer must NOT fire for a missing session — otherwise
		// Docker surfaces a confusing "no such container" 500.
		expect(stopContainer).not.toHaveBeenCalled();
	});

	it("returns 403 when requireAdmin denies", async () => {
		authStubs.requireAdmin.mockImplementation((_req, res, _next) => {
			(res as { status: (n: number) => { json: (b: unknown) => void } })
				.status(403)
				.json({ error: "Forbidden" });
		});
		const get = vi.fn(async () => meta());
		const stopContainer = vi.fn(async () => undefined);
		await spinUp(vi.fn(), {
			sessions: { get } as unknown as Partial<SessionManager>,
			docker: { stopContainer } as unknown as Partial<DockerManager>,
		});

		const res = await fetch(`${baseUrl}/api/admin/sessions/s-any/stop`, { method: "POST" });
		expect(res.status).toBe(403);
		expect(get).not.toHaveBeenCalled();
		expect(stopContainer).not.toHaveBeenCalled();
	});

	it("returns 500 with a generic body when stopContainer throws", async () => {
		const get = vi.fn(async () => meta());
		const stopContainer = vi.fn(async () => {
			throw new Error("docker daemon unreachable");
		});
		await spinUp(vi.fn(), {
			sessions: { get } as unknown as Partial<SessionManager>,
			docker: { stopContainer } as unknown as Partial<DockerManager>,
		});

		const res = await fetch(`${baseUrl}/api/admin/sessions/s-any/stop`, { method: "POST" });
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Internal server error");
		expect(body.error).not.toContain("docker daemon");
	});
});

describe("DELETE /api/admin/sessions/:id (#241d)", () => {
	beforeEach(() => {
		dbStubs.d1Query.mockReset();
		__resetDispatcherStatsForTests();
	});

	function meta(status: "running" | "terminated" = "running") {
		return {
			sessionId: "s-any",
			userId: "u-foreign",
			name: "s-any",
			status,
			containerId: "c1",
			containerName: "st-s-any",
			cols: 80,
			rows: 24,
			envVars: {},
			createdAt: new Date(),
			lastConnectedAt: null,
		};
	}

	it("soft-deletes (kill + terminate, workspace preserved) by default", async () => {
		const get = vi.fn(async () => meta());
		const terminate = vi.fn(async () => undefined);
		const deleteRow = vi.fn(async () => undefined);
		const kill = vi.fn(async () => undefined);
		const purgeWorkspace = vi.fn(async () => undefined);
		await spinUp(vi.fn(), {
			sessions: { get, terminate, deleteRow } as unknown as Partial<SessionManager>,
			docker: { kill, purgeWorkspace } as unknown as Partial<DockerManager>,
		});

		const res = await fetch(`${baseUrl}/api/admin/sessions/s-any`, { method: "DELETE" });
		expect(res.status).toBe(204);
		expect(kill).toHaveBeenCalledWith("s-any");
		expect(terminate).toHaveBeenCalledWith("s-any");
		// Soft-delete does NOT purge workspace or drop the row.
		expect(purgeWorkspace).not.toHaveBeenCalled();
		expect(deleteRow).not.toHaveBeenCalled();
	});

	it("hard-deletes (kill + terminate + purgeWorkspace + deleteRow) when ?hard=true", async () => {
		const get = vi.fn(async () => meta());
		const terminate = vi.fn(async () => undefined);
		const deleteRow = vi.fn(async () => undefined);
		const kill = vi.fn(async () => undefined);
		const purgeWorkspace = vi.fn(async () => undefined);
		await spinUp(vi.fn(), {
			sessions: { get, terminate, deleteRow } as unknown as Partial<SessionManager>,
			docker: { kill, purgeWorkspace } as unknown as Partial<DockerManager>,
		});

		const res = await fetch(`${baseUrl}/api/admin/sessions/s-any?hard=true`, { method: "DELETE" });
		expect(res.status).toBe(204);
		expect(kill).toHaveBeenCalledWith("s-any");
		expect(terminate).toHaveBeenCalledWith("s-any");
		expect(purgeWorkspace).toHaveBeenCalledWith("s-any");
		expect(deleteRow).toHaveBeenCalledWith("s-any");
	});

	it("hard-delete on an already-terminated session skips kill+terminate but still purges + drops the row", async () => {
		// Idempotent shape: the soft-delete branch is the only one that
		// invokes kill/terminate; the hard-delete branch is independent
		// so an admin can hard-purge a soft-deleted session via
		// ?hard=true even though the container is already gone.
		const get = vi.fn(async () => meta("terminated"));
		const terminate = vi.fn(async () => undefined);
		const deleteRow = vi.fn(async () => undefined);
		const kill = vi.fn(async () => undefined);
		const purgeWorkspace = vi.fn(async () => undefined);
		await spinUp(vi.fn(), {
			sessions: { get, terminate, deleteRow } as unknown as Partial<SessionManager>,
			docker: { kill, purgeWorkspace } as unknown as Partial<DockerManager>,
		});

		const res = await fetch(`${baseUrl}/api/admin/sessions/s-any?hard=true`, { method: "DELETE" });
		expect(res.status).toBe(204);
		expect(kill).not.toHaveBeenCalled();
		expect(terminate).not.toHaveBeenCalled();
		expect(purgeWorkspace).toHaveBeenCalledWith("s-any");
		expect(deleteRow).toHaveBeenCalledWith("s-any");
	});

	it("returns 404 when the session id doesn't exist", async () => {
		const get = vi.fn(async () => null);
		const kill = vi.fn(async () => undefined);
		await spinUp(vi.fn(), {
			sessions: { get } as unknown as Partial<SessionManager>,
			docker: { kill } as unknown as Partial<DockerManager>,
		});

		const res = await fetch(`${baseUrl}/api/admin/sessions/missing`, { method: "DELETE" });
		expect(res.status).toBe(404);
		expect(kill).not.toHaveBeenCalled();
	});

	it("returns 403 when requireAdmin denies (no force-delete bypass for non-admins)", async () => {
		authStubs.requireAdmin.mockImplementation((_req, res, _next) => {
			(res as { status: (n: number) => { json: (b: unknown) => void } })
				.status(403)
				.json({ error: "Forbidden" });
		});
		const get = vi.fn(async () => meta());
		const kill = vi.fn(async () => undefined);
		await spinUp(vi.fn(), {
			sessions: { get } as unknown as Partial<SessionManager>,
			docker: { kill } as unknown as Partial<DockerManager>,
		});

		const res = await fetch(`${baseUrl}/api/admin/sessions/s-any?hard=true`, { method: "DELETE" });
		expect(res.status).toBe(403);
		expect(get).not.toHaveBeenCalled();
		expect(kill).not.toHaveBeenCalled();
	});

	it("returns 500 with a generic body when kill throws", async () => {
		// purgeWorkspace's own failure is logged-and-swallowed inside the
		// handler (the row removal still happens), so the failure path
		// we surface here is the kill() throw — pre-terminate, pre-row-
		// drop, the part the catch block actually owns.
		const get = vi.fn(async () => meta());
		const kill = vi.fn(async () => {
			throw new Error("docker daemon unreachable");
		});
		const terminate = vi.fn(async () => undefined);
		await spinUp(vi.fn(), {
			sessions: { get, terminate } as unknown as Partial<SessionManager>,
			docker: { kill } as unknown as Partial<DockerManager>,
		});

		const res = await fetch(`${baseUrl}/api/admin/sessions/s-any`, { method: "DELETE" });
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Internal server error");
		expect(body.error).not.toContain("docker daemon");
	});
});

// ── #270 resource snapshot + per-row caps + live edit ───────────────────────

describe("GET /admin/stats resources aggregation (#270)", () => {
	beforeEach(() => {
		dbStubs.d1Query.mockReset();
		__resetDispatcherStatsForTests();
	});

	function fakeRunning(sessionId: string, containerId: string | null, ownerUsername: string) {
		return {
			sessionId,
			userId: "u1",
			name: sessionId,
			status: "running" as const,
			containerId,
			containerName: `st-${sessionId}`,
			cols: 80,
			rows: 24,
			envVars: {},
			createdAt: new Date("2026-05-09T02:00:00Z"),
			lastConnectedAt: null,
			ownerUsername,
		};
	}

	it("sums effective caps (NULL row → spawn default) and aggregates usage across running sessions only", async () => {
		// Three sessions: A running with explicit caps, B running with
		// NULL caps (must contribute the spawn default), C stopped (must
		// be excluded entirely). Stats fetch succeeds for A but fails
		// for B — the snapshot must report 1 of 2 reported and aggregate
		// only A's usage numbers.
		const listAll = vi.fn(async () => [
			fakeRunning("sA", "cA", "alice"),
			fakeRunning("sB", "cB", "alice"),
			{ ...fakeRunning("sC", "cC", "alice"), status: "stopped" as const },
		]);
		const gatherStats = vi.fn(
			async () =>
				new Map<
					string,
					{ cpuPercent: number; memBytes: number; memLimitBytes: number; memPercent: number } | null
				>([
					[
						"sA",
						{
							cpuPercent: 50,
							memBytes: 1024 * 1024 * 1024,
							memLimitBytes: 4 * 1024 * 1024 * 1024,
							memPercent: 25,
						},
					],
					["sB", null],
				]),
		);
		const countByStatus = vi.fn(async () => ({
			running: 2,
			stopped: 1,
			terminated: 0,
			failed: 0,
		}));
		await spinUp(countByStatus, {
			sessions: { listAll } as unknown as Partial<SessionManager>,
			docker: { gatherStats } as unknown as Partial<DockerManager>,
		});
		// listResourceCaps batched query — return only sA's caps; B has
		// no session_configs row at all (typical bare-create shape).
		// MUST be set AFTER spinUp; spinUp installs a benign empty-result
		// default that would otherwise clobber this impl.
		dbStubs.d1Query.mockImplementation(async (sql: string) => {
			if (/FROM session_configs/i.test(sql)) {
				return {
					results: [
						{ session_id: "sA", cpu_limit: 4_000_000_000, mem_limit: 4 * 1024 * 1024 * 1024 },
					],
					success: true,
					meta: { changes: 0, duration: 0, last_row_id: 0 },
				};
			}
			return {
				results: [],
				success: true,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			};
		});

		const res = await fetch(`${baseUrl}/api/admin/stats`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			resources: {
				runningCount: number;
				statsAvailable: number;
				totalCpuPercent: number;
				totalMemBytes: number;
				totalCpuLimitNanos: number;
				totalMemLimitBytes: number;
				limits: { defaultCpuNanos: number; defaultMemBytes: number };
			};
		};
		// Two running sessions (sC excluded by status filter).
		expect(body.resources.runningCount).toBe(2);
		// Only sA reported usage; sB's stats fetch returned null.
		expect(body.resources.statsAvailable).toBe(1);
		expect(body.resources.totalCpuPercent).toBe(50);
		expect(body.resources.totalMemBytes).toBe(1024 * 1024 * 1024);
		// totalCpuLimitNanos = sA explicit (4e9) + sB spawn default.
		// We don't know the test-env default literal, so cross-check
		// against the limits block the response itself surfaces.
		expect(body.resources.totalCpuLimitNanos).toBe(
			4_000_000_000 + body.resources.limits.defaultCpuNanos,
		);
		expect(body.resources.totalMemLimitBytes).toBe(
			4 * 1024 * 1024 * 1024 + body.resources.limits.defaultMemBytes,
		);
		// Critical: gatherStats called with the RUNNING sessions only
		// (stopped sC excluded). A regression that passed the unfiltered
		// list would double-bill the host and confuse the totals card.
		expect(gatherStats).toHaveBeenCalledWith([
			{ sessionId: "sA", containerId: "cA" },
			{ sessionId: "sB", containerId: "cB" },
		]);
	});
});

describe("GET /admin/sessions per-row caps + usage (#270)", () => {
	beforeEach(() => {
		dbStubs.d1Query.mockReset();
		__resetDispatcherStatsForTests();
	});

	function fakeSess(sessionId: string, status: "running" | "stopped", containerId: string | null) {
		return {
			sessionId,
			userId: "u1",
			name: sessionId,
			status,
			containerId,
			containerName: `st-${sessionId}`,
			cols: 80,
			rows: 24,
			envVars: {},
			createdAt: new Date("2026-05-09T02:00:00Z"),
			lastConnectedAt: null,
			ownerUsername: "alice",
		};
	}

	it("emits per-row cpuLimit/memLimit and usage (null for non-running rows)", async () => {
		const listAll = vi.fn(async () => [
			fakeSess("sA", "running", "cA"),
			fakeSess("sB", "stopped", null),
		]);
		const gatherStats = vi.fn(
			async () =>
				new Map([
					[
						"sA",
						{
							cpuPercent: 12.345,
							memBytes: 100,
							memLimitBytes: 512 * 1024 * 1024,
							memPercent: 0.5,
						},
					],
				]),
		);
		await spinUp(vi.fn(), {
			sessions: { listAll } as unknown as Partial<SessionManager>,
			docker: { gatherStats } as unknown as Partial<DockerManager>,
		});
		// Per-test D1 impl AFTER spinUp — spinUp's default would clobber.
		dbStubs.d1Query.mockImplementation(async (sql: string) => ({
			results: /FROM session_configs/i.test(sql)
				? [
						{ session_id: "sA", cpu_limit: 1_000_000_000, mem_limit: 512 * 1024 * 1024 },
						// sB has no session_configs row at all
					]
				: [],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));

		const res = await fetch(`${baseUrl}/api/admin/sessions`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{
			sessionId: string;
			cpuLimit: number | null;
			memLimit: number | null;
			usage: { cpuPercent: number; memBytes: number; memPercent: number } | null;
		}>;
		const a = body.find((r) => r.sessionId === "sA");
		const b = body.find((r) => r.sessionId === "sB");
		expect(a?.cpuLimit).toBe(1_000_000_000);
		expect(a?.memLimit).toBe(512 * 1024 * 1024);
		// Rounded to 1 decimal place by serializeUsage — the cgroup
		// samples are too noisy for finer precision to be honest.
		expect(a?.usage?.cpuPercent).toBe(12.3);
		expect(a?.usage?.memBytes).toBe(100);
		// Non-running row: no caps configured, no live usage. Both null.
		expect(b?.cpuLimit).toBeNull();
		expect(b?.memLimit).toBeNull();
		expect(b?.usage).toBeNull();
		// gatherStats was called with the RUNNING subset only — sB
		// (stopped) must not have been sampled.
		expect(gatherStats).toHaveBeenCalledWith([{ sessionId: "sA", containerId: "cA" }]);
	});
});

describe("PATCH /admin/sessions/:id/resources (#270)", () => {
	beforeEach(() => {
		dbStubs.d1Query.mockReset();
		__resetDispatcherStatsForTests();
	});

	function meta(status: "running" | "stopped" = "running", containerId: string | null = "c1") {
		return {
			sessionId: "s-any",
			userId: "u-foreign",
			name: "s-any",
			status,
			containerId,
			containerName: "st-s-any",
			cols: 80,
			rows: 24,
			envVars: {},
			createdAt: new Date(),
			lastConnectedAt: null,
		};
	}

	async function call(
		body: unknown,
	): Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string> }> {
		return fetch(`${baseUrl}/api/admin/sessions/s-any/resources`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("persists + applies live to the running container, returns 204", async () => {
		const get = vi.fn(async () => meta());
		const updateResources = vi.fn(async () => undefined);
		dbStubs.d1Query.mockResolvedValue({
			results: [],
			success: true,
			meta: { changes: 1, duration: 0, last_row_id: 0 },
		});
		await spinUp(vi.fn(), {
			sessions: { get } as unknown as Partial<SessionManager>,
			docker: { updateResources } as unknown as Partial<DockerManager>,
		});

		const res = await call({ cpuLimit: 1_000_000_000, memLimit: 1024 * 1024 * 1024 });
		expect(res.status).toBe(204);
		// Live update fires for a running container with both fields.
		expect(updateResources).toHaveBeenCalledWith("c1", {
			cpuLimit: 1_000_000_000,
			memLimit: 1024 * 1024 * 1024,
		});
	});

	it("does NOT call docker.updateResources for a stopped session (persist-only)", async () => {
		const get = vi.fn(async () => meta("stopped", null));
		const updateResources = vi.fn(async () => undefined);
		dbStubs.d1Query.mockResolvedValue({
			results: [],
			success: true,
			meta: { changes: 1, duration: 0, last_row_id: 0 },
		});
		await spinUp(vi.fn(), {
			sessions: { get } as unknown as Partial<SessionManager>,
			docker: { updateResources } as unknown as Partial<DockerManager>,
		});

		const res = await call({ cpuLimit: 1_000_000_000 });
		expect(res.status).toBe(204);
		// Critical: docker call must be skipped — a stopped session has
		// no live cgroup to update, and the daemon would return
		// "container not running" otherwise.
		expect(updateResources).not.toHaveBeenCalled();
	});

	it("returns 400 with field path when validation fails (e.g. cpu below floor)", async () => {
		await spinUp(vi.fn());
		const res = await call({ cpuLimit: 1 });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("cpuLimit");
	});

	it("returns 400 when the body has no fields (must specify at least one)", async () => {
		await spinUp(vi.fn());
		const res = await call({});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/at least one/i);
	});

	it("returns 400 on unknown keys (strict schema)", async () => {
		await spinUp(vi.fn());
		const res = await call({ cpuLimit: 1_000_000_000, foo: "bar" });
		expect(res.status).toBe(400);
	});

	it("returns 404 when the session does not exist", async () => {
		const get = vi.fn(async () => null);
		const updateResources = vi.fn(async () => undefined);
		await spinUp(vi.fn(), {
			sessions: { get } as unknown as Partial<SessionManager>,
			docker: { updateResources } as unknown as Partial<DockerManager>,
		});

		const res = await call({ cpuLimit: 1_000_000_000 });
		expect(res.status).toBe(404);
		expect(updateResources).not.toHaveBeenCalled();
	});

	it("returns 409 when docker rejects the memory drop with 'lower than current usage'", async () => {
		const get = vi.fn(async () => meta());
		const updateResources = vi.fn(async () => {
			// Docker daemon error string when memLimit < current
			// memory.usage on cgroup-v2.
			throw new Error(
				"Minimum memory limit can not be less than memory reservation limit, see usage. cannot lower memory cap.",
			);
		});
		dbStubs.d1Query.mockResolvedValue({
			results: [],
			success: true,
			meta: { changes: 1, duration: 0, last_row_id: 0 },
		});
		await spinUp(vi.fn(), {
			sessions: { get } as unknown as Partial<SessionManager>,
			docker: { updateResources } as unknown as Partial<DockerManager>,
		});

		const res = await call({ memLimit: 256 * 1024 * 1024 });
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/free memory/i);
	});

	it("returns 403 when requireAdmin denies (no admin-only bypass for non-admins)", async () => {
		authStubs.requireAdmin.mockImplementation((_req, res, _next) => {
			(res as { status: (n: number) => { json: (b: unknown) => void } })
				.status(403)
				.json({ error: "Forbidden" });
		});
		const get = vi.fn(async () => meta());
		const updateResources = vi.fn(async () => undefined);
		await spinUp(vi.fn(), {
			sessions: { get } as unknown as Partial<SessionManager>,
			docker: { updateResources } as unknown as Partial<DockerManager>,
		});

		const res = await call({ cpuLimit: 1_000_000_000 });
		expect(res.status).toBe(403);
		expect(get).not.toHaveBeenCalled();
		expect(updateResources).not.toHaveBeenCalled();
	});
});
