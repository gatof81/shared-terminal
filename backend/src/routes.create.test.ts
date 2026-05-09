/**
 * routes.create.test.ts — POST /sessions hard-fail path tests for #185 (PR 185b2a).
 *
 * Round-4 review flagged that the 500-response shape on a postCreate
 * hook failure (`{ sessionId, bootstrapOutput, bootstrapExitCode }`)
 * was only exercised at the `DockerManager` unit level. The frontend
 * modal parses these specific fields to render the error panel — a
 * future refactor that drops one of them would silently break the
 * UX with no failing test. This file covers the full HTTP round-trip.
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

// Stub `markBootstrapped` so the success-path test doesn't need a D1
// UPDATE round-trip; the hard-fail path tested below never reaches it.
const bootstrapStubs = vi.hoisted(() => ({
	markBootstrapped: vi.fn(async () => true),
}));
vi.mock("./bootstrap.js", () => bootstrapStubs);

// `persistSessionConfig` writes the session_configs row. Stub so the
// test doesn't need to mock the full d1Query SQL flow for the
// non-bootstrap fields.
vi.mock("./sessionConfig.js", async () => {
	const actual = await vi.importActual<typeof import("./sessionConfig.js")>("./sessionConfig.js");
	return {
		...actual,
		persistSessionConfig: vi.fn(async () => undefined),
	};
});

import type { DockerManager } from "./dockerManager.js";
import { buildRouter } from "./routes.js";
import type { SessionManager } from "./sessionManager.js";
import type { SessionMeta } from "./types.js";

function makeMeta(): SessionMeta {
	return {
		sessionId: "sess-1",
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

interface Spies {
	create: ReturnType<typeof vi.fn>;
	updateStatus: ReturnType<typeof vi.fn>;
	deleteRow: ReturnType<typeof vi.fn>;
	kill: ReturnType<typeof vi.fn>;
	spawn: ReturnType<typeof vi.fn>;
	runPostCreate: ReturnType<typeof vi.fn>;
	runPostStart: ReturnType<typeof vi.fn>;
}

function makeFakes(opts: { postCreateExit: number; postCreateOutput: string }): {
	sessions: SessionManager;
	docker: DockerManager;
	spies: Spies;
} {
	const meta = makeMeta();
	const create = vi.fn(async () => meta);
	const updateStatus = vi.fn(async () => undefined);
	const deleteRow = vi.fn(async () => undefined);
	const sessions = {
		create,
		updateStatus,
		deleteRow,
		get: vi.fn(async () => meta),
	} as unknown as SessionManager;

	const kill = vi.fn(async () => undefined);
	const spawn = vi.fn(async () => "container-abc");
	const runPostCreate = vi.fn(async () => ({
		exitCode: opts.postCreateExit,
		output: opts.postCreateOutput,
	}));
	const runPostStart = vi.fn(async () => undefined);
	const docker = {
		getUploadTmpDir: () => "/tmp/shared-terminal-test-uploads",
		spawn,
		kill,
		runPostCreate,
		runPostStart,
	} as unknown as DockerManager;
	return {
		sessions,
		docker,
		spies: { create, updateStatus, deleteRow, kill, spawn, runPostCreate, runPostStart },
	};
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
	const router = buildRouter(sessions, docker, {
		login: { ipMax: 1000, ipWindowMs: 60_000, usernameMax: 1000, usernameWindowMs: 60_000 },
		register: { ipMax: 1000, ipWindowMs: 60_000 },
		invitesCreate: { ipMax: 1000, ipWindowMs: 60_000 },
		invitesList: { ipMax: 1000, ipWindowMs: 60_000 },
		invitesRevoke: { ipMax: 1000, ipWindowMs: 60_000 },
		fileUpload: { ipMax: 1000, ipWindowMs: 60_000 },
		logout: { ipMax: 1000, ipWindowMs: 60_000 },
		authStatus: { ipMax: 1000, ipWindowMs: 60_000 },
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

describe("POST /sessions — postCreate hard-fail path", () => {
	beforeEach(() => {
		dbStubs.d1Query.mockReset();
		bootstrapStubs.markBootstrapped.mockReset();
		bootstrapStubs.markBootstrapped.mockResolvedValue(true);
	});

	it("returns 500 with bootstrapOutput / bootstrapExitCode / sessionId on non-zero hook exit", async () => {
		// Frontend modal parses exactly these three fields to render the
		// inline failure panel — locking the response shape so a future
		// refactor that drops any of them trips this test.
		const { sessions, docker, spies } = makeFakes({
			postCreateExit: 42,
			postCreateOutput: "bash: bad-cmd: not found\nnpm ERR! exited 42",
		});
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "test",
				config: { postCreateCmd: "bad-cmd" },
			}),
		});
		expect(res.status).toBe(500);
		const body = (await res.json()) as {
			error: string;
			sessionId: string;
			bootstrapOutput: string;
			bootstrapExitCode: number;
		};
		expect(body.error).toMatch(/postCreate hook failed/);
		expect(body.bootstrapExitCode).toBe(42);
		expect(body.bootstrapOutput).toContain("bash: bad-cmd: not found");
		expect(body.sessionId).toBe("sess-1");

		// Container must be killed on hard-fail — leaving it running
		// would leak a container the user can no longer reach (the row
		// is now `failed`, /start refuses).
		expect(spies.kill).toHaveBeenCalledWith("sess-1");
		// Row is FLIPPED to failed, NOT deleted — the captured output
		// has to survive so the user can audit it later.
		expect(spies.updateStatus).toHaveBeenCalledWith("sess-1", "failed");
		expect(spies.deleteRow).not.toHaveBeenCalled();
		// markBootstrapped MUST NOT be called on the failure path — the
		// gate exists to ensure postCreate runs once per session, not
		// once per attempt; flipping it would prevent a future recreate
		// from re-running the corrected hook (the row is failed and
		// can't be reused, but defence in depth).
		expect(bootstrapStubs.markBootstrapped).not.toHaveBeenCalled();
	});

	it("rolls back the row + kills the container if updateStatus throws on hard-fail", async () => {
		// PR #207 round 5 fix (replaces round 3): a thrown updateStatus
		// must propagate so the outer catch tears the half-state row
		// down. The previous behaviour swallowed the throw, leaving the
		// row at (running, null) — which reconcile() would silently
		// promote to (stopped, null), letting /start respawn an
		// unbootstrapped container. Trade-off accepted: on this rare
		// D1-hiccup path the user loses bootstrapOutput in the 500
		// body (the response never reaches `res.json` because the
		// exception jumped out earlier), but they don't get a
		// respawnable orphan. CRITICAL operator log + general 500.
		const { sessions, docker, spies } = makeFakes({
			postCreateExit: 1,
			postCreateOutput: "boom",
		});
		spies.updateStatus.mockRejectedValueOnce(new Error("D1 transient"));
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "test",
				config: { postCreateCmd: "false" },
			}),
		});
		expect(res.status).toBe(500);
		const body = (await res.json()) as { bootstrapOutput?: string };
		// Generic 500 — the bootstrapOutput field is GONE from the
		// response (we never reached the json call inside the if).
		expect(body.bootstrapOutput).toBeUndefined();
		// Outer catch ran: row deleted, container killed (no orphan,
		// no respawnable row).
		expect(spies.deleteRow).toHaveBeenCalledWith("sess-1");
		expect(spies.kill).toHaveBeenCalledWith("sess-1");
	});

	// Round-6 review concern: `sessions.create()` itself throwing (D1
	// transient before any row exists) means `meta` is still null in
	// the outer catch. The rollback block must NOT call
	// `meta.sessionId` outside the `if (meta)` guard. Locking the case
	// so the rollback never crashes with TypeError on this path.
	it("does not crash the rollback when sessions.create itself throws (meta is null)", async () => {
		const { sessions, docker, spies } = makeFakes({
			postCreateExit: 0,
			postCreateOutput: "",
		});
		spies.create.mockRejectedValueOnce(new Error("D1 down"));
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "test" }),
		});
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string };
		// The original D1 error is what surfaces — NOT a TypeError on
		// `meta.sessionId`. If the rollback crashed, Express would
		// return a different error or the test would observe a stale
		// connection.
		expect(body.error).toBe("D1 down");
		// No spawn / kill / deleteRow — `meta` was null, the rollback
		// block was skipped entirely.
		expect(spies.spawn).not.toHaveBeenCalled();
		expect(spies.kill).not.toHaveBeenCalled();
		expect(spies.deleteRow).not.toHaveBeenCalled();
	});

	it("returns 201 + calls markBootstrapped + runPostStart on the success path", async () => {
		// Round-5 NIT: every other test in this file covers a failure
		// shape. Pinning the happy path ensures a future refactor that
		// drops `markBootstrapped` (single-use gate that prevents
		// postCreate re-runs) or that fires `runPostStart` before
		// `markBootstrapped` (would re-run a fresh hook every restart
		// in the wrong order) trips an obvious test.
		const { sessions, docker, spies } = makeFakes({
			postCreateExit: 0,
			postCreateOutput: "installed\n",
		});
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "test",
				config: {
					postCreateCmd: "npm install",
					postStartCmd: "npm run dev",
				},
			}),
		});
		expect(res.status).toBe(201);
		expect(spies.runPostCreate).toHaveBeenCalledWith("sess-1", "npm install");
		expect(bootstrapStubs.markBootstrapped).toHaveBeenCalledWith("sess-1");
		expect(spies.runPostStart).toHaveBeenCalledWith("sess-1", "npm run dev");
		expect(spies.kill).not.toHaveBeenCalled();
		expect(spies.updateStatus).not.toHaveBeenCalled();
	});

	it("kills the container in the outer catch even on a post-spawn / post-runPostCreate failure", async () => {
		// PR #207 round 4 fix: any throw between docker.spawn and the
		// 201 response (markBootstrapped, runPostStart, sessions.get,
		// the synthetic invariant throw) used to deleteRow but leave
		// the container running — orphaned forever. The outer catch now
		// always kills first.
		const { sessions, docker, spies } = makeFakes({
			postCreateExit: 0,
			postCreateOutput: "",
		});
		bootstrapStubs.markBootstrapped.mockRejectedValueOnce(new Error("D1 transient"));
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "test",
				config: { postCreateCmd: "echo ok" },
			}),
		});
		expect(res.status).toBe(500);
		// kill was called by the outer catch — no orphaned container.
		expect(spies.kill).toHaveBeenCalledWith("sess-1");
		// And the row got rolled back (this is the standard "unexpected
		// failure during create" path).
		expect(spies.deleteRow).toHaveBeenCalledWith("sess-1");
	});
});
