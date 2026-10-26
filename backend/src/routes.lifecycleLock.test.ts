/**
 * routes.lifecycleLock.test.ts — the per-session lifecycle lock on the
 * REST surface (CONVERSATION.md §2.7.2, precondition 1; 3.0d). Start,
 * stop, delete (soft/hard) and the admin force-stop/delete serialise on
 * one session, each re-reading the session under the lock and acting on
 * the state the previous holder left; nothing purges a workspace while a
 * container is starting on it. Same scaffolding as
 * routes.sessionsValidation.test.ts, with a stateful fake so the order of
 * side effects is observable.
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
import { SessionBusyError, sessionLifecycleLock } from "./sessionLifecycleLock.js";
import type { SessionManager } from "./sessionManager.js";
// Real error class, NOT a stub: handleSessionError in routes/shared.ts
// matches via `instanceof NotFoundError` against this exact import.
import type { SessionMeta, SessionStatus } from "./types.js";

function makeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
	return {
		sessionId: "sess-1",
		userId: "u1",
		name: "test",
		status: "running",
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** A session whose row and container state the fakes mutate in place. */
function makeWorld(status: SessionStatus = "stopped") {
	const events: string[] = [];
	let row: SessionMeta | null = makeMeta({ status });
	const startGate = { current: null as null | Promise<void> };
	const sessions = {
		assertOwnership: vi.fn(async () => {
			if (!row) throw new Error("unexpected");
			return row;
		}),
		assertOwnedBy: vi.fn(async () => undefined),
		assertCanOperate: vi.fn(async () => {
			if (!row) throw new Error("unexpected");
			return row;
		}),
		get: vi.fn(async () => (row ? { ...row } : null)),
		terminate: vi.fn(async () => {
			events.push("terminate");
			if (row) row = { ...row, status: "terminated" };
		}),
		deleteRow: vi.fn(async () => {
			events.push("deleteRow");
			row = null;
		}),
	} as unknown as SessionManager;
	const docker = {
		getUploadTmpDir: () => "/tmp/shared-terminal-test-uploads",
		startContainer: vi.fn(async () => {
			events.push("start:begin");
			if (startGate.current) await startGate.current;
			if (row) row = { ...row, status: "running" };
			events.push("start:end");
		}),
		stopContainer: vi.fn(async () => {
			events.push("stop");
			if (row) row = { ...row, status: "stopped" };
		}),
		kill: vi.fn(async () => {
			events.push("kill");
		}),
		purgeWorkspace: vi.fn(async () => {
			events.push("purge");
		}),
	} as unknown as DockerManager;
	return { sessions, docker, events, startGate, rowOf: () => row };
}

async function until(cond: () => boolean, ms = 2000) {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
		await new Promise((r) => setTimeout(r, 5));
	}
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

/**
 * A fake world for POST /sessions: `create` inserts the row with the id
 * the route chose, `spawn` is gated and records when it would (re)create
 * the workspace directory, delete-side effects are recorded in order.
 */
function makeCreateWorld(opts: { spawnFails?: boolean } = {}) {
	const events: string[] = [];
	let row: SessionMeta | null = null;
	let createdId: string | null = null;
	const spawnGate = deferred();
	const sessions = {
		create: vi.fn(async (o: { sessionId?: string; userId: string; name: string }) => {
			createdId = o.sessionId ?? "unset";
			row = makeMeta({ sessionId: createdId, userId: o.userId, name: o.name, status: "running" });
			events.push("insert");
			return row;
		}),
		assertOwnership: vi.fn(async () => {
			if (!row) throw new Error("unexpected");
			return row;
		}),
		get: vi.fn(async () => (row ? { ...row } : null)),
		terminate: vi.fn(async () => {
			events.push("terminate");
			if (row) row = { ...row, status: "terminated" };
		}),
		deleteRow: vi.fn(async () => {
			events.push("deleteRow");
			row = null;
		}),
	} as unknown as SessionManager;
	const docker = {
		getUploadTmpDir: () => "/tmp/shared-terminal-test-uploads",
		spawn: vi.fn(async () => {
			events.push("spawn:begin");
			await spawnGate.promise;
			// spawnWithConfig mkdirs the workspace and creates the container
			// at the end; after a purge this would recreate both.
			events.push("workspace-mkdir");
			if (opts.spawnFails) throw new Error("image missing");
			events.push("container-created");
		}),
		kill: vi.fn(async () => {
			events.push("kill");
		}),
		purgeWorkspace: vi.fn(async () => {
			events.push("purge");
		}),
	} as unknown as DockerManager;
	return { sessions, docker, events, spawnGate, id: () => createdId, rowOf: () => row };
}

describe("lifecycle lock on the initial create (POST /sessions)", () => {
	for (const [who, path] of [
		["owner", (id: string) => `/api/sessions/${id}?hard=true`],
		["admin", (id: string) => `/api/admin/sessions/${id}?hard=true`],
	] as const) {
		it(`${who} hard delete during a pending spawn waits; nothing is recreated after the purge`, async () => {
			const w = makeCreateWorld();
			await spinUp(w.sessions, w.docker);

			const create = fetch(`${baseUrl}/api/sessions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "s" }),
			});
			await until(() => w.events.includes("spawn:begin"));
			const id = w.id() as string;
			// The lock is held from before the row existed.
			expect(sessionLifecycleLock.heldBy(id)).toBe("create");
			const del = fetch(`${baseUrl}${path(id)}`, { method: "DELETE" });
			await until(() => sessionLifecycleLock.queued(id) === 1);
			expect(w.events).toEqual(["insert", "spawn:begin"]);

			w.spawnGate.resolve();
			expect((await create).status).toBe(201);
			expect((await del).status).toBe(204);
			expect(w.events).toEqual([
				"insert",
				"spawn:begin",
				"workspace-mkdir",
				"container-created",
				"kill",
				"terminate",
				"purge",
				"deleteRow",
			]);
			// Nothing after the purge recreates the workspace or a container.
			const purgeAt = w.events.indexOf("purge");
			expect(
				w.events.slice(purgeAt).some((e) => e === "workspace-mkdir" || e === "container-created"),
			).toBe(false);
			expect(w.rowOf()).toBeNull();
			expect(sessionLifecycleLock.heldBy(id)).toBeNull();
		});
	}

	it("failed spawn: the rollback runs inside the create's hold (no deadlock), and a queued hard delete then finds nothing", async () => {
		const w = makeCreateWorld({ spawnFails: true });
		await spinUp(w.sessions, w.docker);

		const create = fetch(`${baseUrl}/api/sessions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "s" }),
		});
		await until(() => w.events.includes("spawn:begin"));
		const id = w.id() as string;
		const del = fetch(`${baseUrl}/api/sessions/${id}?hard=true`, { method: "DELETE" });
		await until(() => sessionLifecycleLock.queued(id) === 1);

		w.spawnGate.resolve();
		expect((await create).status).toBe(500);
		expect((await del).status).toBe(404);
		// Rollback = kill + row drop, serialised before the delete; the
		// delete never purges a session that no longer exists.
		expect(w.events).toEqual(["insert", "spawn:begin", "workspace-mkdir", "kill", "deleteRow"]);
		expect(w.docker.purgeWorkspace).not.toHaveBeenCalled();
		expect(sessionLifecycleLock.heldBy(id)).toBeNull();
	});

	it("the id passed to sessions.create is the one the lock was taken on", async () => {
		const w = makeCreateWorld();
		w.spawnGate.resolve();
		await spinUp(w.sessions, w.docker);
		const res = await fetch(`${baseUrl}/api/sessions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "s" }),
		});
		expect(res.status).toBe(201);
		expect(((await res.json()) as { sessionId: string }).sessionId).toBe(w.id());
		expect(w.id()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});
});

describe("lifecycle lock on the REST routes", () => {
	it("DELETE ?hard=true during a start waits, then purges only after the start has finished", async () => {
		const w = makeWorld("stopped");
		const gate = deferred();
		w.startGate.current = gate.promise;
		await spinUp(w.sessions, w.docker);

		const start = fetch(`${baseUrl}/api/sessions/sess-1/start`, { method: "POST" });
		await until(() => w.events.includes("start:begin"));
		const del = fetch(`${baseUrl}/api/sessions/sess-1?hard=true`, { method: "DELETE" });
		await until(() => sessionLifecycleLock.queued("sess-1") === 1);
		// The delete is queued behind the start: nothing torn down yet.
		expect(w.events).toEqual(["start:begin"]);

		gate.resolve();
		expect((await start).status).toBe(200);
		expect((await del).status).toBe(204);
		expect(w.events).toEqual([
			"start:begin",
			"start:end",
			"kill",
			"terminate",
			"purge",
			"deleteRow",
		]);
		expect(sessionLifecycleLock.heldBy("sess-1")).toBeNull();
	});

	it("a start queued behind a hard delete acts on the final state: 404, never starts", async () => {
		const w = makeWorld("running");
		const killGate = deferred();
		(w.docker.kill as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			w.events.push("kill");
			await killGate.promise;
		});
		await spinUp(w.sessions, w.docker);

		const del = fetch(`${baseUrl}/api/sessions/sess-1?hard=true`, { method: "DELETE" });
		await until(() => w.events.includes("kill"));
		const start = fetch(`${baseUrl}/api/sessions/sess-1/start`, { method: "POST" });
		await until(() => sessionLifecycleLock.queued("sess-1") === 1);

		killGate.resolve();
		expect((await del).status).toBe(204);
		expect((await start).status).toBe(404);
		expect(w.docker.startContainer).not.toHaveBeenCalled();
		expect(w.rowOf()).toBeNull();
	});

	it("a stop queued behind a start runs after it, on the started container", async () => {
		const w = makeWorld("stopped");
		const gate = deferred();
		w.startGate.current = gate.promise;
		await spinUp(w.sessions, w.docker);

		const start = fetch(`${baseUrl}/api/sessions/sess-1/start`, { method: "POST" });
		await until(() => w.events.includes("start:begin"));
		const stop = fetch(`${baseUrl}/api/sessions/sess-1/stop`, { method: "POST" });
		await until(() => sessionLifecycleLock.queued("sess-1") === 1);
		expect(w.docker.stopContainer).not.toHaveBeenCalled();

		gate.resolve();
		expect((await start).status).toBe(200);
		expect((await stop).status).toBe(200);
		expect(w.events).toEqual(["start:begin", "start:end", "stop"]);
		expect(w.rowOf()?.status).toBe("stopped");
	});

	it("admin force-delete serialises with an owner start too", async () => {
		const w = makeWorld("stopped");
		const gate = deferred();
		w.startGate.current = gate.promise;
		await spinUp(w.sessions, w.docker);

		const start = fetch(`${baseUrl}/api/sessions/sess-1/start`, { method: "POST" });
		await until(() => w.events.includes("start:begin"));
		const del = fetch(`${baseUrl}/api/admin/sessions/sess-1?hard=true`, { method: "DELETE" });
		await until(() => sessionLifecycleLock.queued("sess-1") === 1);
		expect(w.events).toEqual(["start:begin"]);

		gate.resolve();
		expect((await start).status).toBe(200);
		expect((await del).status).toBe(204);
		expect(w.events).toEqual([
			"start:begin",
			"start:end",
			"kill",
			"terminate",
			"purge",
			"deleteRow",
		]);
	});

	it("busy (wait cap reached) is 409 with nothing done, on owner and admin routes", async () => {
		const w = makeWorld("running");
		await spinUp(w.sessions, w.docker);
		const spy = vi
			.spyOn(sessionLifecycleLock, "run")
			.mockRejectedValue(new SessionBusyError("sess-1", "delete", "recreate"));
		try {
			for (const [method, path] of [
				["DELETE", "/api/sessions/sess-1?hard=true"],
				["POST", "/api/sessions/sess-1/stop"],
				["POST", "/api/sessions/sess-1/start"],
				["POST", "/api/admin/sessions/sess-1/stop"],
				["DELETE", "/api/admin/sessions/sess-1?hard=true"],
			] as const) {
				const res = await fetch(`${baseUrl}${path}`, { method });
				expect([path, res.status, await res.json()]).toEqual([path, 409, { error: "busy" }]);
			}
		} finally {
			spy.mockRestore();
		}
		expect(w.events).toEqual([]);
	});
});
