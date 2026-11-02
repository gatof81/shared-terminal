/**
 * routes.sessions.delete.failpath.test.ts — DIAGNOSTIC evidence for the
 * audit of the hard-delete fail path (H1) against main 2ea5700, for both
 * `DELETE /api/sessions/:id?hard=true` (owner) and
 * `DELETE /api/admin/sessions/:id?hard=true` (admin).
 *
 * Pins the fail-closed behaviour the routes SHOULD have: when
 * `purgeWorkspace` rejects, the D1 row must survive (it is the only
 * reference that lets a retry purge the workspace, uploads, `.st-control`
 * and `.conversations` dirs later) and the response must not claim
 * success. A retried hard delete after the purge is repaired must
 * converge (row dropped exactly once).
 *
 * The last two cases run the REAL `DockerManager` over a fake Dockerode
 * whose daemon is unreachable (socket ECONNREFUSED) to show the composed
 * consequence of H1 + H2: a soft or hard delete during a Docker outage
 * answers 204 and rewrites D1 as if the container were gone.
 *
 * Every case here FAILS on main — that is the evidence.
 *
 * Scaffolding mirrors routes.sessionsValidation.test.ts: stub `./auth.js`
 * and `./db.js`, exercise the express app over a real ephemeral-port
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
		results: [] as unknown[],
		success: true as const,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	})),
	getD1CallsSinceBoot: vi.fn(() => 0),
	__resetD1CallsForTests: vi.fn(),
}));
vi.mock("./db.js", () => dbStubs);

import type { BootstrapBroadcaster } from "./bootstrap.js";
import { DockerManager } from "./dockerManager.js";
import { buildRouter } from "./routes.js";
import type { SessionManager } from "./sessionManager.js";
import type { SessionMeta, SessionStatus } from "./types.js";

function makeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
	return {
		sessionId: "sess-1",
		userId: "u1",
		name: "test",
		status: "running",
		containerId: null,
		containerName: "st-sess-1",
		cols: 80,
		rows: 24,
		envVars: {},
		createdAt: new Date(),
		lastConnectedAt: null,
		...overrides,
	};
}

function makeFakeSessions(status: SessionStatus = "running", containerId: string | null = null) {
	const meta = makeMeta({ status, containerId });
	const spies = {
		assertOwnership: vi.fn(async () => meta),
		assertOwnedBy: vi.fn(async () => undefined),
		get: vi.fn(async () => meta),
		getOrThrow: vi.fn(async () => meta),
		terminate: vi.fn(async () => undefined),
		deleteRow: vi.fn(async () => undefined),
		updateStatus: vi.fn(async () => undefined),
		setContainerId: vi.fn(async () => undefined),
		recordContainerGone: vi.fn(async () => undefined),
	};
	return { sessions: spies as unknown as SessionManager, spies };
}

function makeFakeDocker() {
	const spies = {
		kill: vi.fn(async () => undefined),
		purgeWorkspace: vi.fn(async () => undefined),
	};
	const docker = {
		getUploadTmpDir: () => "/tmp/shared-terminal-test-uploads",
		...spies,
	} as unknown as DockerManager;
	return { docker, spies };
}

function eacces(path: string): Error {
	const e = new Error(`EACCES: permission denied, rmdir '${path}'`) as NodeJS.ErrnoException;
	e.code = "EACCES";
	e.syscall = "rmdir";
	e.path = path;
	return e;
}

function socketError(code: string): Error {
	const e = new Error(`connect ${code} /var/run/docker.sock`) as NodeJS.ErrnoException;
	e.code = code;
	e.syscall = "connect";
	return e;
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

describe("DELETE /sessions/:id?hard=true — purge failure (H1, owner route)", () => {
	it("a failing purgeWorkspace must NOT drop the D1 row nor answer success", async () => {
		const { sessions, spies } = makeFakeSessions("terminated");
		const { docker, spies: dockerSpies } = makeFakeDocker();
		dockerSpies.purgeWorkspace.mockRejectedValue(eacces("/var/shared-terminal/workspaces/sess-1"));
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/sessions/sess-1?hard=true`, { method: "DELETE" });
		// The row is the only reference to the workspace, uploads,
		// `.st-control/<sid>` and `.conversations/<sid>` dirs: dropping it
		// after a failed purge orphans all of them.
		expect(spies.deleteRow).not.toHaveBeenCalled();
		expect(res.status).toBeGreaterThanOrEqual(500);
	});

	it("retried hard delete converges once the purge works: row dropped exactly once, 204", async () => {
		const { sessions, spies } = makeFakeSessions("terminated");
		const { docker, spies: dockerSpies } = makeFakeDocker();
		dockerSpies.purgeWorkspace.mockRejectedValueOnce(
			eacces("/var/shared-terminal/workspaces/sess-1"),
		);
		await spinUp(sessions, docker);

		const first = await fetch(`${baseUrl}/api/sessions/sess-1?hard=true`, { method: "DELETE" });
		expect(first.status).not.toBe(204);
		expect(spies.deleteRow).not.toHaveBeenCalled();

		const second = await fetch(`${baseUrl}/api/sessions/sess-1?hard=true`, { method: "DELETE" });
		expect(second.status).toBe(204);
		expect(dockerSpies.purgeWorkspace).toHaveBeenCalledTimes(2);
		expect(spies.deleteRow).toHaveBeenCalledTimes(1);
	});
});

describe("DELETE /admin/sessions/:id?hard=true — purge failure (H1, admin route)", () => {
	it("a failing purgeWorkspace must NOT drop the D1 row nor answer success", async () => {
		const { sessions, spies } = makeFakeSessions("terminated");
		const { docker, spies: dockerSpies } = makeFakeDocker();
		dockerSpies.purgeWorkspace.mockRejectedValue(eacces("/var/shared-terminal/workspaces/sess-1"));
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/admin/sessions/sess-1?hard=true`, {
			method: "DELETE",
		});
		expect(spies.deleteRow).not.toHaveBeenCalled();
		expect(res.status).toBeGreaterThanOrEqual(500);
	});
});

// ── Composed H1 + H2: delete during a Docker outage, real DockerManager ────

function makeRealDockerWithDeadDaemon(sessions: SessionManager) {
	const dm = new DockerManager(sessions);
	const container = {
		stop: vi.fn(async () => {
			throw socketError("ECONNREFUSED");
		}),
		remove: vi.fn(async () => {
			throw socketError("ECONNREFUSED");
		}),
		inspect: vi.fn(async () => {
			throw socketError("ECONNREFUSED");
		}),
	};
	(dm as unknown as { docker: unknown }).docker = {
		getContainer: vi.fn(() => container),
	};
	// Keep the filesystem out of this: the purge itself is not under test
	// here (the fakes above cover it); the kill → terminate → deleteRow
	// chain is.
	const purge = vi.spyOn(dm, "purgeWorkspace").mockResolvedValue(undefined);
	return { dm, container, purge };
}

describe("DELETE /sessions/:id while the Docker daemon is unreachable (H1 + H2 composed)", () => {
	it("soft delete: must not mark the session terminated / drop container_id when the kill could not be confirmed", async () => {
		const { sessions, spies } = makeFakeSessions("running", "c-1");
		const { dm } = makeRealDockerWithDeadDaemon(sessions);
		await spinUp(sessions, dm);

		const res = await fetch(`${baseUrl}/api/sessions/sess-1`, { method: "DELETE" });
		expect(spies.setContainerId).not.toHaveBeenCalled();
		expect(spies.terminate).not.toHaveBeenCalled();
		expect(res.status).not.toBe(204);
	});

	it("hard delete: must not drop the row while a container may still be running under it", async () => {
		const { sessions, spies } = makeFakeSessions("running", "c-1");
		const { dm } = makeRealDockerWithDeadDaemon(sessions);
		await spinUp(sessions, dm);

		const res = await fetch(`${baseUrl}/api/sessions/sess-1?hard=true`, { method: "DELETE" });
		// After this 204 on main: row gone, workspace purged, and a
		// container named st-<sid[:12]> (no labels, see spawn) possibly
		// still running — reachable only by that name, which nothing
		// stores any more.
		expect(spies.deleteRow).not.toHaveBeenCalled();
		expect(spies.setContainerId).not.toHaveBeenCalled();
		expect(res.status).not.toBe(204);
	});
});
