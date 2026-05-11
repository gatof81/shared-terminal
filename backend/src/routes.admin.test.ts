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
	const sessions = {
		countByStatus,
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
});
