/**
 * routes.ports.test.ts — PATCH /sessions/:id/ports route tests (#190 live edit).
 *
 * Pins the owner-gated live edit of the exposed-port set: validation
 * (strict shape, count cap, uniqueness), the privileged-port gate (a < 1024
 * port needs the session to have been created with allowPrivilegedPorts),
 * and the persist-then-apply flow (writes `ports_json`, rewrites
 * `sessions_port_mappings`). Mocking pattern mirrors `routes.start.test.ts`:
 * stub `./auth.js` + `./db.js`, exercise the express app over a real socket.
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
import { ForbiddenError } from "./sessionManager.js";
import type { SessionMeta } from "./types.js";

function makeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
	return {
		sessionId: "sess-1",
		userId: "u1",
		name: "test",
		status: "running",
		containerId: "container-abc",
		containerName: "st-sess-1",
		cols: 80,
		rows: 24,
		envVars: {},
		createdAt: new Date(),
		lastConnectedAt: null,
		...overrides,
	};
}

function makeFakeSessions(opts: { assertOwnedBy?: () => Promise<void> } = {}): {
	sessions: SessionManager;
	assertSpy: ReturnType<typeof vi.fn>;
} {
	const meta = makeMeta();
	const assertSpy = vi.fn(opts.assertOwnedBy ?? (async () => undefined));
	const sessions = {
		assertOwnedBy: assertSpy,
		get: vi.fn(async () => meta),
	} as unknown as SessionManager;
	return { sessions, assertSpy };
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

async function spinUp(sessions: SessionManager) {
	const docker = {
		getUploadTmpDir: () => "/tmp/shared-terminal-test-uploads",
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

function patchPorts(body: unknown): Promise<Response> {
	return fetch(`${baseUrl}/api/sessions/sess-1/ports`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("PATCH /sessions/:id/ports", () => {
	beforeEach(() => {
		dbStubs.d1Query.mockReset();
		dbStubs.d1Query.mockResolvedValue({
			results: [],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
	});

	it("persists ports_json and rewrites the runtime mappings, returning the meta (200)", async () => {
		const { sessions } = makeFakeSessions();
		await spinUp(sessions);

		const res = await patchPorts({
			ports: [
				{ container: 3000, public: false },
				{ container: 8080, public: true },
			],
		});
		expect(res.status).toBe(200);
		const calls = dbStubs.d1Query.mock.calls as Array<[string, unknown[]]>;
		// updatePorts writes ports_json…
		const updatePortsCall = calls.find((c) => /UPDATE session_configs SET ports_json/.test(c[0]));
		expect(updatePortsCall?.[1]?.[0]).toBe(
			JSON.stringify([
				{ container: 3000, public: false },
				{ container: 8080, public: true },
			]),
		);
		// …and setPortMappings rewrites the rows (host_port vestigial = container port).
		const inserts = calls.filter((c) => /^INSERT INTO sessions_port_mappings/.test(c[0]));
		expect(inserts.map((c) => c[1])).toEqual([
			["sess-1", 3000, 3000, 0],
			["sess-1", 8080, 8080, 1],
		]);
	});

	it("closing all ports persists '[]' and clears the mappings (DELETE, no INSERT)", async () => {
		const { sessions } = makeFakeSessions();
		await spinUp(sessions);

		const res = await patchPorts({ ports: [] });
		expect(res.status).toBe(200);
		const calls = dbStubs.d1Query.mock.calls as Array<[string, unknown[]]>;
		const updatePortsCall = calls.find((c) => /UPDATE session_configs SET ports_json/.test(c[0]));
		expect(updatePortsCall?.[1]?.[0]).toBe("[]");
		expect(calls.some((c) => /^DELETE FROM sessions_port_mappings/.test(c[0]))).toBe(true);
		expect(calls.some((c) => /^INSERT INTO sessions_port_mappings/.test(c[0]))).toBe(false);
	});

	it("rejects a privileged port (<1024) when the session lacks allowPrivilegedPorts (400)", async () => {
		// Default d1 stub returns no session_configs row → getSessionConfig
		// is null → allowPrivilegedPorts is not true → privileged port is
		// rejected, and no mapping write happens.
		const { sessions } = makeFakeSessions();
		await spinUp(sessions);

		const res = await patchPorts({ ports: [{ container: 80, public: true }] });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/privileged/i);
		const calls = dbStubs.d1Query.mock.calls as Array<[string, unknown[]]>;
		expect(calls.some((c) => /sessions_port_mappings/.test(c[0]))).toBe(false);
	});

	it("allows a privileged port when the session was created with allowPrivilegedPorts", async () => {
		const { sessions } = makeFakeSessions();
		await spinUp(sessions);
		// getSessionConfig (the SELECT after assertOwnedBy) returns a row
		// with the toggle on. Other queries fall back to the default stub.
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [{ session_id: "sess-1", ports_json: null, allow_privileged_ports: 1 }],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});

		const res = await patchPorts({ ports: [{ container: 80, public: true }] });
		expect(res.status).toBe(200);
		const inserts = (dbStubs.d1Query.mock.calls as Array<[string, unknown[]]>).filter((c) =>
			/^INSERT INTO sessions_port_mappings/.test(c[0]),
		);
		expect(inserts.map((c) => c[1])).toEqual([["sess-1", 80, 80, 1]]);
	});

	it("rejects a duplicate container port (400) before touching the session", async () => {
		const { sessions, assertSpy } = makeFakeSessions();
		await spinUp(sessions);

		const res = await patchPorts({
			ports: [
				{ container: 3000, public: false },
				{ container: 3000, public: true },
			],
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/duplicate/i);
		// Validation runs before the ownership check / any D1 work.
		expect(assertSpy).not.toHaveBeenCalled();
	});

	it("rejects an unknown body key (strict schema, 400)", async () => {
		const { sessions } = makeFakeSessions();
		await spinUp(sessions);
		const res = await patchPorts({ ports: [{ container: 3000, public: false }], extra: 1 });
		expect(res.status).toBe(400);
	});

	it("rejects more than MAX_PORTS entries (400)", async () => {
		const { sessions } = makeFakeSessions();
		await spinUp(sessions);
		const ports = Array.from({ length: 21 }, (_, i) => ({ container: 3000 + i, public: false }));
		const res = await patchPorts({ ports });
		expect(res.status).toBe(400);
	});

	it("returns 403 for a session the caller does not own, with no mapping writes", async () => {
		const { sessions } = makeFakeSessions({
			assertOwnedBy: async () => {
				throw new ForbiddenError("not yours");
			},
		});
		await spinUp(sessions);

		const res = await patchPorts({ ports: [{ container: 3000, public: false }] });
		expect(res.status).toBe(403);
		const calls = dbStubs.d1Query.mock.calls as Array<[string, unknown[]]>;
		expect(calls.some((c) => /sessions_port_mappings/.test(c[0]))).toBe(false);
	});
});

// Reachability of the GET editor endpoint (#190d) — this was previously
// untested (only PATCH was), which is why a route-registration regression
// could ship silently.
describe("GET /sessions/:id/ports (reachability)", () => {
	it("is reachable through the full buildRouter and returns 200 for the owner", async () => {
		const { sessions } = makeFakeSessions();
		await spinUp(sessions);
		const res = await fetch(`${baseUrl}/api/sessions/sess-1/ports`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ports: unknown[]; allowPrivilegedPorts: boolean };
		expect(Array.isArray(body.ports)).toBe(true);
		expect(typeof body.allowPrivilegedPorts).toBe("boolean");
	});
});
