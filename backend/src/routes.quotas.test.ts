/**
 * routes.quotas.test.ts — per-user quota enforcement + admin surface (#202).
 *
 * Pins: the CPU/RAM budget 429 on POST /sessions (cap named in the body),
 * the per-user max_sessions override reaching sessions.create's atomic
 * guard, and the PATCH /admin/users/:id/quotas validation/404/204 shapes.
 * Harness follows routes.create.test.ts (auth + db stubbed, real HTTP
 * server on an ephemeral port).
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

const emptyD1 = {
	results: [] as unknown[],
	success: true as const,
	meta: { changes: 0, duration: 0, last_row_id: 0 },
};
const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({
		results: [] as unknown[],
		success: true as const,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	})),
}));
vi.mock("./db.js", () => dbStubs);

import type { BootstrapBroadcaster } from "./bootstrap.js";
import type { DockerManager } from "./dockerManager.js";
import { buildRouter } from "./routes.js";
import type { SessionManager } from "./sessionManager.js";
import type { SessionMeta } from "./types.js";

function makeMeta(): SessionMeta {
	return {
		sessionId: "sess-new",
		userId: "u1",
		name: "test",
		status: "running",
		containerId: "container-abc",
		containerName: "st-test",
		cols: 80,
		rows: 24,
		envVars: {},
		createdAt: new Date(),
		lastConnectedAt: null,
	};
}

function makeFakes(runningSessions: Array<{ sessionId: string; status: string }> = []) {
	const meta = makeMeta();
	const create = vi.fn(async () => meta);
	const sessions = {
		create,
		deleteRow: vi.fn(async () => undefined),
		updateStatus: vi.fn(async () => undefined),
		get: vi.fn(async () => meta),
		listForUser: vi.fn(async () => runningSessions),
		listAll: vi.fn(async () => [] as unknown[]),
	} as unknown as SessionManager;
	const spawn = vi.fn(async () => "container-abc");
	const docker = {
		getUploadTmpDir: () => "/tmp/shared-terminal-test-uploads",
		spawn,
		kill: vi.fn(async () => undefined),
		runPostStart: vi.fn(async () => undefined),
	} as unknown as DockerManager;
	return { sessions, docker, create, spawn };
}

/** Route d1Query by SQL shape so call ordering can't break the mocks. */
function mockD1(handlers: {
	quotaRow?: {
		max_sessions: number | null;
		max_total_cpu: number | null;
		max_total_mem: number | null;
	};
	capsRows?: Array<{ session_id: string; cpu_limit: number | null; mem_limit: number | null }>;
	usersList?: unknown[];
	updateChanges?: number;
}) {
	dbStubs.d1Query.mockImplementation((async (sql: string) => {
		if (sql.includes("FROM users WHERE id"))
			return { ...emptyD1, results: handlers.quotaRow ? [handlers.quotaRow] : [] };
		if (sql.includes("FROM session_configs"))
			return { ...emptyD1, results: handlers.capsRows ?? [] };
		if (sql.includes("FROM users ORDER BY"))
			return { ...emptyD1, results: handlers.usersList ?? [] };
		if (sql.startsWith("UPDATE users SET"))
			return { ...emptyD1, meta: { ...emptyD1.meta, changes: handlers.updateChanges ?? 0 } };
		return emptyD1;
	}) as never);
}

let server: http.Server | null = null;
let baseUrl = "";
const broadcaster = {} as BootstrapBroadcaster;

beforeEach(() => {
	dbStubs.d1Query.mockReset();
	dbStubs.d1Query.mockResolvedValue(emptyD1);
});

afterEach(async () => {
	if (server) {
		await new Promise<void>((resolve, reject) => {
			server?.close((e) => (e ? reject(e) : resolve()));
		});
		server = null;
	}
});

async function spinUp(sessions: SessionManager, docker: DockerManager) {
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

function createSession(body: unknown): Promise<Response> {
	return fetch(`${baseUrl}/api/sessions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("POST /sessions — per-user budgets", () => {
	it("429s naming the cpu cap when the new session would bust the budget", async () => {
		const { sessions, docker, spawn } = makeFakes([{ sessionId: "s1", status: "running" }]);
		mockD1({
			quotaRow: { max_sessions: null, max_total_cpu: 3_000_000_000, max_total_mem: null },
			capsRows: [{ session_id: "s1", cpu_limit: 2_000_000_000, mem_limit: 2 ** 30 }],
		});
		await spinUp(sessions, docker);

		const res = await createSession({
			name: "big",
			config: { cpuLimit: 2_000_000_000 },
		});
		expect(res.status).toBe(429);
		const body = (await res.json()) as { error: string; cap: string };
		expect(body.cap).toBe("cpu");
		expect(body.error).toContain("CPU budget");
		// Rejected before any row or container exists.
		expect(spawn).not.toHaveBeenCalled();
	});

	it("429s naming the mem cap when the memory budget busts", async () => {
		const { sessions, docker } = makeFakes([{ sessionId: "s1", status: "running" }]);
		mockD1({
			quotaRow: { max_sessions: null, max_total_cpu: null, max_total_mem: 2 * 2 ** 30 },
			capsRows: [{ session_id: "s1", cpu_limit: null, mem_limit: 2 ** 30 }],
		});
		await spinUp(sessions, docker);

		const res = await createSession({ name: "big", config: { memLimit: 2 * 2 ** 30 } });
		expect(res.status).toBe(429);
		expect(((await res.json()) as { cap: string }).cap).toBe("mem");
	});

	it("allows the create when within budget and threads the per-user session cap into create()", async () => {
		const { sessions, docker, create } = makeFakes([{ sessionId: "s1", status: "running" }]);
		mockD1({
			quotaRow: { max_sessions: 5, max_total_cpu: 8_000_000_000, max_total_mem: null },
			capsRows: [{ session_id: "s1", cpu_limit: 2_000_000_000, mem_limit: 2 ** 30 }],
		});
		await spinUp(sessions, docker);

		const res = await createSession({ name: "ok", config: { cpuLimit: 2_000_000_000 } });
		expect(res.status).toBe(201);
		expect(create).toHaveBeenCalledWith(expect.objectContaining({ maxActiveSessions: 5 }));
	});

	it("skips the budget round-trips entirely for unlimited users (no override, no env default)", async () => {
		const { sessions, docker } = makeFakes();
		mockD1({ quotaRow: { max_sessions: null, max_total_cpu: null, max_total_mem: null } });
		await spinUp(sessions, docker);

		const res = await createSession({ name: "plain" });
		expect(res.status).toBe(201);
		// listForUser is the budget path's first step; unlimited users
		// must not pay it.
		expect(
			(sessions as unknown as { listForUser: ReturnType<typeof vi.fn> }).listForUser,
		).not.toHaveBeenCalled();
	});
});

describe("GET /quotas (own headroom, 202b)", () => {
	it("returns the caller's effective quotas and usage, reusing one session-list read", async () => {
		const { sessions, docker } = makeFakes([
			{ sessionId: "s1", status: "running" },
			{ sessionId: "s2", status: "stopped" },
			{ sessionId: "s3", status: "terminated" },
		]);
		mockD1({
			quotaRow: { max_sessions: 5, max_total_cpu: 8_000_000_000, max_total_mem: null },
			capsRows: [{ session_id: "s1", cpu_limit: 2_000_000_000, mem_limit: 2 ** 30 }],
		});
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/quotas`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			effective: { maxSessions: 5, maxTotalCpu: 8_000_000_000, maxTotalMem: null },
			usage: {
				activeSessions: 2, // running + stopped; terminated freed its slot
				runningSessions: 1,
				cpuNanos: 2_000_000_000,
				memBytes: 2 ** 30,
			},
		});
		// The preloaded-list optimisation: active count + budget sum share
		// one listForUser round-trip.
		expect(
			(sessions as unknown as { listForUser: ReturnType<typeof vi.fn> }).listForUser,
		).toHaveBeenCalledTimes(1);
	});
});

describe("PATCH /admin/users/:id/quotas", () => {
	function patchQuotas(userId: string, body: unknown): Promise<Response> {
		return fetch(`${baseUrl}/api/admin/users/${userId}/quotas`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("204s on success", async () => {
		const { sessions, docker } = makeFakes();
		mockD1({ updateChanges: 1 });
		await spinUp(sessions, docker);
		const res = await patchQuotas("u2", { maxSessions: 10, maxTotalCpu: null });
		expect(res.status).toBe(204);
	});

	it("404s an unknown user", async () => {
		const { sessions, docker } = makeFakes();
		mockD1({ updateChanges: 0 });
		await spinUp(sessions, docker);
		expect((await patchQuotas("ghost", { maxSessions: 10 })).status).toBe(404);
	});

	it("400s an empty body and out-of-bounds values", async () => {
		const { sessions, docker } = makeFakes();
		await spinUp(sessions, docker);
		expect((await patchQuotas("u2", {})).status).toBe(400);
		expect((await patchQuotas("u2", { maxSessions: 0 })).status).toBe(400);
		expect((await patchQuotas("u2", { maxTotalCpu: 1 })).status).toBe(400);
		expect((await patchQuotas("u2", { bogus: 1 })).status).toBe(400);
	});
});

describe("GET /admin/users", () => {
	it("returns overrides, effective quotas, and per-user usage", async () => {
		const { sessions, docker } = makeFakes();
		(sessions as unknown as { listAll: ReturnType<typeof vi.fn> }).listAll.mockResolvedValue([
			{ sessionId: "s1", userId: "u2", status: "running" },
			{ sessionId: "s2", userId: "u2", status: "stopped" },
			{ sessionId: "s3", userId: "u2", status: "terminated" },
		]);
		mockD1({
			usersList: [
				{
					id: "u2",
					username: "bob",
					is_admin: 0,
					created_at: "2026-01-01 00:00:00",
					max_sessions: 3,
					max_total_cpu: null,
					max_total_mem: null,
				},
			],
			capsRows: [{ session_id: "s1", cpu_limit: 2_000_000_000, mem_limit: 2 ** 30 }],
		});
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/admin/users`);
		expect(res.status).toBe(200);
		const [row] = (await res.json()) as Array<Record<string, unknown>>;
		expect(row).toMatchObject({
			userId: "u2",
			username: "bob",
			isAdmin: false,
			quotas: { maxSessions: 3, maxTotalCpu: null, maxTotalMem: null },
			usage: {
				activeSessions: 2, // running + stopped; terminated freed its slot
				runningSessions: 1,
				cpuNanos: 2_000_000_000,
				memBytes: 2 ** 30,
			},
		});
		expect((row.effective as { maxSessions: number }).maxSessions).toBe(3);
	});
});
