/**
 * routes.push.test.ts — Web Push subscription routes (#355). Scaffolding
 * mirrors routes.start.test.ts (hoisted auth/db stubs + ephemeral server).
 * webPush + pushSubscriptions are mocked so the route wrappers — validation,
 * push-disabled degradation, status codes — are what's under test.
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
		results: [],
		success: true as const,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	})),
}));
vi.mock("./db.js", () => dbStubs);

const pushStubs = vi.hoisted(() => ({
	isPushEnabled: vi.fn(() => true),
	getVapidPublicKey: vi.fn(() => "pubkey"),
}));
vi.mock("./webPush.js", () => pushStubs);

const subStubs = vi.hoisted(() => ({
	upsertSubscription: vi.fn(async () => undefined),
	deleteSubscriptionByEndpoint: vi.fn(async () => true),
	userHasSubscription: vi.fn(async () => false),
}));
vi.mock("./pushSubscriptions.js", () => subStubs);

import type { BootstrapBroadcaster } from "./bootstrap.js";
import type { DockerManager } from "./dockerManager.js";
import { buildRouter } from "./routes.js";
import type { SessionManager } from "./sessionManager.js";

let server: http.Server | null = null;
let baseUrl = "";

beforeEach(() => {
	pushStubs.isPushEnabled.mockReturnValue(true);
	pushStubs.getVapidPublicKey.mockReturnValue("pubkey");
	subStubs.upsertSubscription.mockReset();
	subStubs.upsertSubscription.mockResolvedValue(undefined);
	subStubs.deleteSubscriptionByEndpoint.mockReset();
	subStubs.deleteSubscriptionByEndpoint.mockResolvedValue(true);
	subStubs.userHasSubscription.mockReset();
	subStubs.userHasSubscription.mockResolvedValue(false);
});

afterEach(async () => {
	if (server) {
		await new Promise<void>((resolve, reject) => server?.close((e) => (e ? reject(e) : resolve())));
		server = null;
	}
});

async function spinUp() {
	const sessions = {} as SessionManager;
	const docker = { getUploadTmpDir: () => "/tmp/x" } as unknown as DockerManager;
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
	baseUrl = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

const validSub = {
	endpoint: "https://push.example.com/abc",
	keys: { p256dh: "Bd2...", auth: "aXk..." },
};

describe("GET /push/vapid-key", () => {
	it("returns the key when push is enabled", async () => {
		await spinUp();
		const res = await fetch(`${baseUrl}/api/push/vapid-key`);
		expect(res.status).toBe(200);
		expect((await res.json()) as { key: string }).toEqual({ key: "pubkey" });
	});

	it("404s when push is disabled", async () => {
		pushStubs.getVapidPublicKey.mockReturnValue(null);
		await spinUp();
		const res = await fetch(`${baseUrl}/api/push/vapid-key`);
		expect(res.status).toBe(404);
	});
});

describe("GET /push/status", () => {
	it("reports enabled + subscribed", async () => {
		subStubs.userHasSubscription.mockResolvedValue(true);
		await spinUp();
		const res = await fetch(`${baseUrl}/api/push/status`);
		expect(await res.json()).toEqual({ enabled: true, subscribed: true });
	});

	it("short-circuits subscribed:false without a D1 read when disabled", async () => {
		pushStubs.isPushEnabled.mockReturnValue(false);
		await spinUp();
		const res = await fetch(`${baseUrl}/api/push/status`);
		expect(await res.json()).toEqual({ enabled: false, subscribed: false });
		expect(subStubs.userHasSubscription).not.toHaveBeenCalled();
	});
});

describe("POST /push/subscribe", () => {
	it("204s and upserts a valid subscription scoped to the caller", async () => {
		await spinUp();
		const res = await fetch(`${baseUrl}/api/push/subscribe`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validSub),
		});
		expect(res.status).toBe(204);
		expect(subStubs.upsertSubscription).toHaveBeenCalledWith("u1", {
			endpoint: validSub.endpoint,
			p256dh: validSub.keys.p256dh,
			auth: validSub.keys.auth,
		});
	});

	it("404s (no store) when push is disabled server-side", async () => {
		pushStubs.isPushEnabled.mockReturnValue(false);
		await spinUp();
		const res = await fetch(`${baseUrl}/api/push/subscribe`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validSub),
		});
		expect(res.status).toBe(404);
		expect(subStubs.upsertSubscription).not.toHaveBeenCalled();
	});

	it("400s a non-https endpoint / missing keys before touching D1", async () => {
		await spinUp();
		for (const bad of [
			{ endpoint: "http://insecure", keys: { p256dh: "k", auth: "a" } },
			{ endpoint: "https://x", keys: { p256dh: "k" } },
			{ endpoint: "https://x" },
			{ keys: { p256dh: "k", auth: "a" } },
		]) {
			const res = await fetch(`${baseUrl}/api/push/subscribe`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(bad),
			});
			expect(res.status).toBe(400);
		}
		expect(subStubs.upsertSubscription).not.toHaveBeenCalled();
	});
});

describe("DELETE /push/subscribe", () => {
	it("204s and deletes by endpoint", async () => {
		await spinUp();
		const res = await fetch(`${baseUrl}/api/push/subscribe`, {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ endpoint: "https://push.example.com/abc" }),
		});
		expect(res.status).toBe(204);
		expect(subStubs.deleteSubscriptionByEndpoint).toHaveBeenCalledWith(
			"https://push.example.com/abc",
		);
	});

	it("400s a missing endpoint", async () => {
		await spinUp();
		const res = await fetch(`${baseUrl}/api/push/subscribe`, {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});
});
