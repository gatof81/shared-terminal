/**
 * routes.authValidation.test.ts — route-level validation + error mapping
 * for POST /auth/register and POST /auth/login (#353).
 *
 * The username/invite-code boundary checks and the typed-error → HTTP
 * status mapping live in the ROUTE wrappers (routes/auth.ts), not in
 * auth.ts — auth.test.ts covers the module logic, nothing pinned the
 * wire contract. These tests do: a refactor that drops the trim guard,
 * loosens a length cap, or swaps a 403 for a 401 must fail here.
 *
 * Scaffolding mirrors routes.start.test.ts: stub `./auth.js` and
 * `./db.js`, exercise the express app over a real ephemeral-port
 * server. Unlike that file, registerUser/loginUser are the functions
 * UNDER the routes being tested — they stay controllable vi.fn()s in
 * the same hoisted stub object so each test scripts success/throw.
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
	// The routes match errors via `instanceof`; both the route module and
	// this test resolve the same mocked ./auth.js, so throwing these stub
	// classes from registerUser/loginUser exercises the real mapping arms.
	InvalidCredentialsError: class extends Error {
		constructor() {
			super("Invalid username or password");
		}
	},
	UsernameTakenError: class extends Error {
		constructor() {
			super("Username already taken");
		}
	},
	InviteRequiredError: class extends Error {
		constructor() {
			super("Invite code is invalid, expired, or already used");
		}
	},
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
});

async function spinUp() {
	// Only /auth/* is exercised — sessions can stay an empty stub; docker
	// needs getUploadTmpDir because registerSessionRoutes wires multer's
	// disk storage at mount time.
	const sessions = {} as SessionManager;
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

async function post(path: string, body: unknown): Promise<Response> {
	return fetch(`${baseUrl}/api${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	authStubs.registerUser.mockReset();
	authStubs.loginUser.mockReset();
	authStubs.setAuthCookie.mockClear();
});

describe("POST /auth/register — input validation", () => {
	it("400s a missing password and never calls registerUser", async () => {
		await spinUp();
		const res = await post("/auth/register", { username: "alice" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("username and password (min 6 chars) required");
		expect(authStubs.registerUser).not.toHaveBeenCalled();
	});

	it("400s a password shorter than 6 chars", async () => {
		await spinUp();
		const res = await post("/auth/register", { username: "alice", password: "12345" });
		expect(res.status).toBe(400);
		expect(authStubs.registerUser).not.toHaveBeenCalled();
	});

	it("400s a whitespace-only username (truthy, so it survives the presence check)", async () => {
		await spinUp();
		const res = await post("/auth/register", { username: "   ", password: "secret123" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("username and password (min 6 chars) required");
		expect(authStubs.registerUser).not.toHaveBeenCalled();
	});

	it("400s a username over 64 characters (post-trim length)", async () => {
		await spinUp();
		const res = await post("/auth/register", {
			username: "a".repeat(65),
			password: "secret123",
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("username must be at most 64 characters");
		expect(authStubs.registerUser).not.toHaveBeenCalled();
	});

	it("400s a non-string inviteCode instead of crashing on .trim()", async () => {
		await spinUp();
		const res = await post("/auth/register", {
			username: "alice",
			password: "secret123",
			inviteCode: 123,
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("inviteCode must be a string");
		expect(authStubs.registerUser).not.toHaveBeenCalled();
	});

	it("400s an inviteCode over 64 characters", async () => {
		await spinUp();
		const res = await post("/auth/register", {
			username: "alice",
			password: "secret123",
			inviteCode: "f".repeat(65),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("inviteCode must be at most 64 characters");
		expect(authStubs.registerUser).not.toHaveBeenCalled();
	});

	it("403s a whitespace-only inviteCode as invalid (not 'absent')", async () => {
		// The route deliberately distinguishes "field absent" from "field
		// present but whitespace-only" — `"   "` must land as an invalid
		// code, never coerce to undefined and read as no-invite-supplied.
		await spinUp();
		const res = await post("/auth/register", {
			username: "alice",
			password: "secret123",
			inviteCode: "   ",
		});
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/invalid, expired, or already used/i);
		expect(authStubs.registerUser).not.toHaveBeenCalled();
	});

	it("trims the username before handing it to registerUser and 201s on success", async () => {
		await spinUp();
		authStubs.registerUser.mockResolvedValue({
			userId: "u-new",
			token: "tok",
			isAdmin: false,
			isLead: false,
		});
		const res = await post("/auth/register", { username: "  alice  ", password: "secret123" });
		expect(res.status).toBe(201);
		const body = (await res.json()) as { userId: string; isAdmin: boolean };
		expect(body.userId).toBe("u-new");
		expect(authStubs.registerUser).toHaveBeenCalledWith("alice", "secret123", undefined);
		// Token rides the httpOnly cookie, never the body.
		expect(authStubs.setAuthCookie).toHaveBeenCalledWith(expect.anything(), "tok");
		expect(body).not.toHaveProperty("token");
	});
});

describe("POST /auth/register — error mapping", () => {
	it("maps InviteRequiredError to 403", async () => {
		await spinUp();
		authStubs.registerUser.mockRejectedValue(new authStubs.InviteRequiredError());
		const res = await post("/auth/register", { username: "alice", password: "secret123" });
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/invite/i);
	});

	it("maps UsernameTakenError to 409", async () => {
		await spinUp();
		authStubs.registerUser.mockRejectedValue(new authStubs.UsernameTakenError());
		const res = await post("/auth/register", { username: "alice", password: "secret123" });
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/taken/i);
	});

	it("maps an unexpected throw to a generic 500 (no internal message leak)", async () => {
		await spinUp();
		authStubs.registerUser.mockRejectedValue(new Error("D1 exploded: secret detail"));
		const res = await post("/auth/register", { username: "alice", password: "secret123" });
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Internal server error");
	});
});

describe("POST /auth/login — input validation + error mapping", () => {
	it("400s a missing password and never calls loginUser", async () => {
		await spinUp();
		const res = await post("/auth/login", { username: "alice" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("username and password required");
		expect(authStubs.loginUser).not.toHaveBeenCalled();
	});

	it("400s a whitespace-only username", async () => {
		await spinUp();
		const res = await post("/auth/login", { username: "  ", password: "secret123" });
		expect(res.status).toBe(400);
		expect(authStubs.loginUser).not.toHaveBeenCalled();
	});

	it("400s a username over 64 characters", async () => {
		await spinUp();
		const res = await post("/auth/login", { username: "b".repeat(65), password: "secret123" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("username must be at most 64 characters");
		expect(authStubs.loginUser).not.toHaveBeenCalled();
	});

	it("maps InvalidCredentialsError to 401", async () => {
		await spinUp();
		authStubs.loginUser.mockRejectedValue(new authStubs.InvalidCredentialsError());
		const res = await post("/auth/login", { username: "alice", password: "wrongpass" });
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/invalid username or password/i);
	});

	it("maps an unexpected loginUser throw to a generic 500", async () => {
		await spinUp();
		authStubs.loginUser.mockRejectedValue(new Error("bcrypt melted"));
		const res = await post("/auth/login", { username: "alice", password: "secret123" });
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Internal server error");
	});

	it("trims the username, 200s on success, and keeps the token out of the body", async () => {
		await spinUp();
		authStubs.loginUser.mockResolvedValue({
			userId: "u1",
			token: "tok",
			isAdmin: true,
			isLead: false,
		});
		const res = await post("/auth/login", { username: " alice ", password: "secret123" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { userId: string; isAdmin: boolean };
		expect(body.userId).toBe("u1");
		expect(body.isAdmin).toBe(true);
		expect(body).not.toHaveProperty("token");
		expect(authStubs.loginUser).toHaveBeenCalledWith("alice", "secret123");
		expect(authStubs.setAuthCookie).toHaveBeenCalledWith(expect.anything(), "tok");
	});
});
