/**
 * routes.conversations.test.ts — `GET /api/sessions/:id/conversations`
 * (docs/CONVERSATION.md §6): owner-only with the foreign→404 collapse,
 * the response shape, `canSendInput: false`, and the honest empty shape
 * when the subsystem is not wired.
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
	InvalidCredentialsError: class extends Error {},
	UsernameTakenError: class extends Error {},
	InviteRequiredError: class extends Error {},
	InviteQuotaExceededError: class extends Error {},
}));
vi.mock("./auth.js", () => authStubs);

const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({ results: [] as unknown[], success: true as const, meta: {} })),
	getD1CallsSinceBoot: vi.fn(() => 0),
	__resetD1CallsForTests: vi.fn(),
}));
vi.mock("./db.js", () => dbStubs);

import type { BootstrapBroadcaster } from "./bootstrap.js";
import type { ConversationService } from "./conversation/service.js";
import type { DockerManager } from "./dockerManager.js";
import { buildRouter } from "./routes.js";
import { ForbiddenError, NotFoundError, type SessionManager } from "./sessionManager.js";

let server: http.Server;
let base: string;

function start(conversation?: ConversationService) {
	const sessions = {
		assertOwnedBy: vi.fn(async (id: string, userId: string) => {
			if (id === "missing") throw new NotFoundError();
			if (id === "foreign" || userId !== "u1") throw new ForbiddenError();
		}),
	} as unknown as SessionManager;
	const docker = {
		getUploadTmpDir: () => "/tmp/shared-terminal-test-uploads",
		getReconcileStats: () => ({ lastRunAt: null, sessionsCheckedSinceBoot: 0, errorsSinceBoot: 0 }),
	} as unknown as DockerManager;
	const app = express();
	app.use(express.json());
	app.use(
		"/api",
		buildRouter(sessions, docker, {} as BootstrapBroadcaster, undefined, undefined, conversation),
	);
	server = http.createServer(app);
	return new Promise<void>((r) =>
		server.listen(0, () => {
			base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			r();
		}),
	);
}

beforeEach(() => {
	dbStubs.d1Query.mockClear();
});
afterEach(async () => {
	await new Promise<void>((r) => server.close(() => r()));
});

describe("GET /api/sessions/:id/conversations", () => {
	it("returns the service's list for the owner, with no-store caching", async () => {
		const list = vi.fn(async () => ({
			capture: { requested: true, effective: true, effectiveAfterRestart: false },
			conversations: [
				{ sessionId: "c1", kind: "interactive", status: "waiting_input", canSendInput: false },
			],
		}));
		await start({ list } as unknown as ConversationService);
		const res = await fetch(`${base}/api/sessions/s1/conversations`);
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		const body = await res.json();
		expect(body.capture.effective).toBe(true);
		expect(body.conversations[0]).toMatchObject({ sessionId: "c1", canSendInput: false });
		expect(list).toHaveBeenCalledWith("s1");
	});
	it("a foreign session answers 404 exactly like a missing one", async () => {
		const list = vi.fn();
		await start({ list } as unknown as ConversationService);
		const foreign = await fetch(`${base}/api/sessions/foreign/conversations`);
		const missing = await fetch(`${base}/api/sessions/missing/conversations`);
		expect(foreign.status).toBe(404);
		expect(missing.status).toBe(404);
		expect(await foreign.json()).toEqual(await missing.json());
		expect(list).not.toHaveBeenCalled();
	});
	it("without the subsystem wired, answers an honest empty capture shape", async () => {
		await start(undefined);
		const res = await fetch(`${base}/api/sessions/s1/conversations`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			capture: { requested: false, effective: false, effectiveAfterRestart: false },
			conversations: [],
		});
	});
});
