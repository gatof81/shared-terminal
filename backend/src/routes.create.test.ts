/**
 * routes.create.test.ts — POST /sessions tests for #185 / PR 185b2b.
 *
 * The bootstrap runner became asynchronous in 185b2b: when a
 * `postCreateCmd` is configured, the route returns 201 immediately
 * with `{ bootstrapping: true }` and kicks off `runAsyncBootstrap`
 * fire-and-forget. The runner itself owns the status flip /
 * container kill / WS-broadcast on the failure path; the route's
 * job is just to hand off cleanly.
 *
 * Heavy mocking pattern follows `rateLimit.test.ts`: stub `./auth.js`
 * + `./db.js` + `./bootstrap.js` so the route can be exercised over a
 * real Express HTTP server without touching D1 or kicking off real
 * async work.
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

// Mock the whole bootstrap module so the route's fire-and-forget call
// to `runAsyncBootstrap` is fully observable + side-effect-free. Keeps
// the runner's own behaviour out of route-level tests; runner is
// exercised in bootstrap.test.ts.
const bootstrapStubs = vi.hoisted(() => ({
	runAsyncBootstrap: vi.fn(async () => undefined),
	BootstrapBroadcaster: class {
		clearForTesting() {
			/* noop */
		}
	},
}));
vi.mock("./bootstrap.js", () => bootstrapStubs);

vi.mock("./sessionConfig.js", async () => {
	const actual = await vi.importActual<typeof import("./sessionConfig.js")>("./sessionConfig.js");
	return {
		...actual,
		persistSessionConfig: vi.fn(async () => undefined),
	};
});

import type { BootstrapBroadcaster } from "./bootstrap.js";
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
	deleteRow: ReturnType<typeof vi.fn>;
	kill: ReturnType<typeof vi.fn>;
	spawn: ReturnType<typeof vi.fn>;
	runPostStart: ReturnType<typeof vi.fn>;
}

function makeFakes(): { sessions: SessionManager; docker: DockerManager; spies: Spies } {
	const meta = makeMeta();
	const create = vi.fn(async () => meta);
	const deleteRow = vi.fn(async () => undefined);
	const sessions = {
		create,
		deleteRow,
		updateStatus: vi.fn(async () => undefined),
		get: vi.fn(async () => meta),
	} as unknown as SessionManager;

	const kill = vi.fn(async () => undefined);
	const spawn = vi.fn(async () => "container-abc");
	const runPostStart = vi.fn(async () => undefined);
	const docker = {
		getUploadTmpDir: () => "/tmp/shared-terminal-test-uploads",
		spawn,
		kill,
		runPostStart,
	} as unknown as DockerManager;
	return { sessions, docker, spies: { create, deleteRow, kill, spawn, runPostStart } };
}

let server: http.Server | null = null;
let baseUrl = "";
const broadcaster = {} as BootstrapBroadcaster;

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

describe("POST /sessions — async bootstrap dispatch (PR 185b2b)", () => {
	beforeEach(() => {
		dbStubs.d1Query.mockReset();
		bootstrapStubs.runAsyncBootstrap.mockReset();
		bootstrapStubs.runAsyncBootstrap.mockResolvedValue(undefined);
	});

	it("returns 201 with bootstrapping=true and kicks off runAsyncBootstrap when postCreateCmd is set", async () => {
		const { sessions, docker, spies } = makeFakes();
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "test",
				config: { postCreateCmd: "npm install", postStartCmd: "npm run dev" },
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { sessionId: string; bootstrapping?: boolean };
		// bootstrapping flag is what tells the client to open the WS
		// live-tail rather than treating the create as immediately
		// complete.
		expect(body.bootstrapping).toBe(true);
		expect(body.sessionId).toBe("sess-1");
		// Async runner was invoked exactly once with the right cfg.
		// runPostStart is NOT called from the route here — the runner
		// fires it on the success branch instead.
		expect(bootstrapStubs.runAsyncBootstrap).toHaveBeenCalledTimes(1);
		expect(bootstrapStubs.runAsyncBootstrap.mock.calls[0]?.[0]).toBe("sess-1");
		expect(bootstrapStubs.runAsyncBootstrap.mock.calls[0]?.[1]).toEqual({
			postCreateCmd: "npm install",
			postStartCmd: "npm run dev",
			// `hasBootstrapConfig` gates the getSessionConfig D1 fetch
			// on postCreate-only sessions (PR #214 round 2 NIT,
			// generalised in #191 PR 191b to cover all four
			// config-driven stages).
			hasBootstrapConfig: false,
		});
		expect(spies.runPostStart).not.toHaveBeenCalled();
	});

	// PR #218 round 2 NIT: pin `hasBootstrapConfig: true` for each of
	// the new config-driven fields so a future route refactor (e.g. a
	// `??` normalisation that maps undefined→null) can't silently
	// break the gate.
	it.each([
		["repo", { url: "https://github.com/o/r", auth: "none" as const }],
		["gitIdentity", { name: "Ada", email: "a@b.com" }],
		["dotfiles", { url: "https://github.com/u/d.git" }],
		["agentSeed", { claudeMd: "# notes" }],
	])("computes hasBootstrapConfig=true when only %s is set", async (field, value) => {
		const { sessions, docker } = makeFakes();
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "test",
				config: { [field]: value },
			}),
		});
		expect(res.status).toBe(201);
		expect(bootstrapStubs.runAsyncBootstrap).toHaveBeenCalledTimes(1);
		const cfgArg = bootstrapStubs.runAsyncBootstrap.mock.calls[0]?.[1] as {
			hasBootstrapConfig?: boolean;
		};
		expect(cfgArg.hasBootstrapConfig).toBe(true);
	});

	it("returns 201 without bootstrapping flag and runs postStart inline when only postStartCmd is set", async () => {
		// No postCreateCmd → no async bootstrap runner. postStart runs
		// synchronously here because there's no hook to wait on, and
		// runPostStart is fire-and-forget at the tmux layer anyway
		// (`tmux new-session -d` returns immediately).
		const { sessions, docker, spies } = makeFakes();
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "test",
				config: { postStartCmd: "code tunnel" },
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { bootstrapping?: boolean };
		expect(body.bootstrapping).toBeUndefined();
		expect(spies.runPostStart).toHaveBeenCalledWith("sess-1", "code tunnel");
		expect(bootstrapStubs.runAsyncBootstrap).not.toHaveBeenCalled();
	});

	it("returns 201 normally for a bare-create session (no config)", async () => {
		const { sessions, docker, spies } = makeFakes();
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "test" }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { bootstrapping?: boolean };
		expect(body.bootstrapping).toBeUndefined();
		expect(spies.runPostStart).not.toHaveBeenCalled();
		expect(bootstrapStubs.runAsyncBootstrap).not.toHaveBeenCalled();
	});

	// Unchanged from PR 185b2a round 6: sessions.create itself failing
	// must NOT crash the rollback even though `meta` is still null.
	it("does not crash the rollback when sessions.create itself throws (meta is null)", async () => {
		const { sessions, docker, spies } = makeFakes();
		spies.create.mockRejectedValueOnce(new Error("D1 down"));
		await spinUp(sessions, docker);

		const res = await fetch(`${baseUrl}/api/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "test" }),
		});
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("D1 down");
		expect(spies.spawn).not.toHaveBeenCalled();
		expect(spies.kill).not.toHaveBeenCalled();
		expect(spies.deleteRow).not.toHaveBeenCalled();
		expect(bootstrapStubs.runAsyncBootstrap).not.toHaveBeenCalled();
	});
});
