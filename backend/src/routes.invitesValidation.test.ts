/**
 * routes.invitesValidation.test.ts — route-level validation + error
 * mapping for the /invites surface (#353).
 *
 * Pins three route-owned behaviours that no module test covers:
 *   - DELETE /invites/:hash rejects a non-64-lowercase-hex hash with
 *     400 BEFORE any db call (the guard exists so probes never reach
 *     D1 — a regression here silently re-opens that round-trip);
 *   - POST /invites maps InviteQuotaExceededError to 429;
 *   - DELETE maps revokeInvite() === false to a deliberately vague 404
 *     (missing vs already-used must stay indistinguishable on the wire).
 *
 * Scaffolding mirrors routes.start.test.ts: stub `./auth.js` and
 * `./db.js`, exercise the express app over a real ephemeral-port
 * server. createInvite/revokeInvite are the functions under the routes
 * being tested — controllable vi.fn()s in the hoisted stub object.
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
	InviteQuotaExceededError: class extends Error {
		constructor() {
			super("Invite quota exceeded (20 outstanding codes)");
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

const VALID_HASH = "a".repeat(64);

beforeEach(() => {
	authStubs.createInvite.mockReset();
	authStubs.revokeInvite.mockReset();
});

describe("DELETE /invites/:hash — hash shape guard", () => {
	it("400s a short non-hex hash without touching revokeInvite", async () => {
		await spinUp();
		const res = await fetch(`${baseUrl}/api/invites/nothex`, { method: "DELETE" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("hash must be a 64-char lowercase hex SHA-256 digest");
		expect(authStubs.revokeInvite).not.toHaveBeenCalled();
	});

	it("400s a 64-char UPPERCASE hex hash (lowercase-only contract)", async () => {
		await spinUp();
		const res = await fetch(`${baseUrl}/api/invites/${"A".repeat(64)}`, { method: "DELETE" });
		expect(res.status).toBe(400);
		expect(authStubs.revokeInvite).not.toHaveBeenCalled();
	});

	it("404s when revokeInvite reports nothing removed, with a non-enumerating message", async () => {
		await spinUp();
		authStubs.revokeInvite.mockResolvedValue(false);
		const res = await fetch(`${baseUrl}/api/invites/${VALID_HASH}`, { method: "DELETE" });
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string };
		// "or already used" is load-bearing — missing vs consumed must not
		// be distinguishable from the wire.
		expect(body.error).toBe("Invite not found or already used");
		expect(authStubs.revokeInvite).toHaveBeenCalledWith(VALID_HASH);
	});

	it("204s when revokeInvite removes the row", async () => {
		await spinUp();
		authStubs.revokeInvite.mockResolvedValue(true);
		const res = await fetch(`${baseUrl}/api/invites/${VALID_HASH}`, { method: "DELETE" });
		expect(res.status).toBe(204);
	});
});

describe("POST /invites — error mapping", () => {
	it("maps InviteQuotaExceededError to 429", async () => {
		await spinUp();
		authStubs.createInvite.mockRejectedValue(new authStubs.InviteQuotaExceededError());
		const res = await fetch(`${baseUrl}/api/invites`, { method: "POST" });
		expect(res.status).toBe(429);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/quota/i);
	});

	it("201s with the minted invite on success", async () => {
		await spinUp();
		authStubs.createInvite.mockResolvedValue({ code: "abcd1234abcd1234" });
		const res = await fetch(`${baseUrl}/api/invites`, { method: "POST" });
		expect(res.status).toBe(201);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("abcd1234abcd1234");
		expect(authStubs.createInvite).toHaveBeenCalledWith("u1");
	});

	it("maps an unexpected createInvite throw to a generic 500", async () => {
		await spinUp();
		authStubs.createInvite.mockRejectedValue(new Error("D1 detail"));
		const res = await fetch(`${baseUrl}/api/invites`, { method: "POST" });
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Internal server error");
	});
});
