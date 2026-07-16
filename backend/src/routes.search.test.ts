/**
 * routes.search.test.ts — POST /sessions/:id/tabs/:tabId/search route tests
 * (#357, tmux copy-mode search).
 *
 * Pins the validation arms (missing/oversized/control-char query, bad
 * action, malformed tabId), the auth graduation (assertOwnedBy — observers
 * must not drive someone else's pane), the action → DockerManager call
 * mapping, and the 404 for a tab whose tmux session is gone. Mocking
 * pattern mirrors `routes.start.test.ts`: stub `./auth.js` + `./db.js`,
 * exercise the express app over a real socket.
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
}));
vi.mock("./db.js", () => dbStubs);

import type { BootstrapBroadcaster } from "./bootstrap.js";
import { type DockerManager, TabNotFoundError } from "./dockerManager.js";
import { buildRouter } from "./routes.js";
import type { SessionManager } from "./sessionManager.js";
import { ForbiddenError, NotFoundError } from "./sessionManager.js";

function makeFakeSessions(opts: { assertOwnedBy?: () => Promise<void> } = {}): {
	sessions: SessionManager;
	assertSpy: ReturnType<typeof vi.fn>;
} {
	const assertSpy = vi.fn(opts.assertOwnedBy ?? (async () => undefined));
	const sessions = {
		assertOwnedBy: assertSpy,
	} as unknown as SessionManager;
	return { sessions, assertSpy };
}

function makeFakeDocker(opts: { searchTabHistory?: () => Promise<void> } = {}): {
	docker: DockerManager;
	searchSpy: ReturnType<typeof vi.fn>;
} {
	const searchSpy = vi.fn(opts.searchTabHistory ?? (async () => undefined));
	const docker = {
		getUploadTmpDir: () => "/tmp/shared-terminal-test-uploads",
		searchTabHistory: searchSpy,
	} as unknown as DockerManager;
	return { docker, searchSpy };
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

function postSearch(body: unknown, tabId = "tab-abc123"): Promise<Response> {
	return fetch(`${baseUrl}/api/sessions/sess-1/tabs/${encodeURIComponent(tabId)}/search`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("POST /sessions/:id/tabs/:tabId/search — validation", () => {
	it("rejects a search with no query (400), before ownership or docker", async () => {
		const { sessions, assertSpy } = makeFakeSessions();
		const { docker, searchSpy } = makeFakeDocker();
		await spinUp(sessions, docker);

		const res = await postSearch({ action: "search" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/query/);
		expect(assertSpy).not.toHaveBeenCalled();
		expect(searchSpy).not.toHaveBeenCalled();
	});

	it("rejects a query over 256 characters (400)", async () => {
		const { sessions } = makeFakeSessions();
		const { docker, searchSpy } = makeFakeDocker();
		await spinUp(sessions, docker);

		const res = await postSearch({ action: "search", query: "x".repeat(257) });
		expect(res.status).toBe(400);
		expect(searchSpy).not.toHaveBeenCalled();
	});

	it("accepts a query of exactly 256 characters (boundary)", async () => {
		const { sessions } = makeFakeSessions();
		const { docker, searchSpy } = makeFakeDocker();
		await spinUp(sessions, docker);

		const res = await postSearch({ action: "search", query: "x".repeat(256) });
		expect(res.status).toBe(204);
		expect(searchSpy).toHaveBeenCalledTimes(1);
	});

	it("rejects control characters in the query (400)", async () => {
		const { sessions } = makeFakeSessions();
		const { docker, searchSpy } = makeFakeDocker();
		await spinUp(sessions, docker);

		for (const query of ["a\nb", "a\tb", "\x1b[A", "a\x7fb"]) {
			const res = await postSearch({ action: "search", query });
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: string };
			expect(body.error).toMatch(/control characters/);
		}
		expect(searchSpy).not.toHaveBeenCalled();
	});

	it("rejects an unknown action (400)", async () => {
		const { sessions } = makeFakeSessions();
		const { docker, searchSpy } = makeFakeDocker();
		await spinUp(sessions, docker);

		for (const action of ["previous", "", 42, undefined]) {
			const res = await postSearch({ action, query: "foo" });
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: string };
			expect(body.error).toMatch(/action/);
		}
		expect(searchSpy).not.toHaveBeenCalled();
	});

	it("rejects a tabId outside the WS-attach charset allowlist (400)", async () => {
		const { sessions } = makeFakeSessions();
		const { docker, searchSpy } = makeFakeDocker();
		await spinUp(sessions, docker);

		// "main:1" is a valid tmux target but not a tabId we ever mint —
		// same defensive allowlist the WS upgrade applies to ?tab=.
		for (const tabId of ["main:1", "tab abc", "t".repeat(65)]) {
			const res = await postSearch({ action: "exit" }, tabId);
			expect(res.status).toBe(400);
		}
		expect(searchSpy).not.toHaveBeenCalled();
	});
});

describe("POST /sessions/:id/tabs/:tabId/search — auth", () => {
	it("returns 403 for a session the caller does not own, without touching docker", async () => {
		const { sessions } = makeFakeSessions({
			assertOwnedBy: async () => {
				throw new ForbiddenError("not yours");
			},
		});
		const { docker, searchSpy } = makeFakeDocker();
		await spinUp(sessions, docker);

		const res = await postSearch({ action: "search", query: "foo" });
		expect(res.status).toBe(403);
		expect(searchSpy).not.toHaveBeenCalled();
	});

	it("returns 404 for a session that does not exist", async () => {
		const { sessions } = makeFakeSessions({
			assertOwnedBy: async () => {
				throw new NotFoundError();
			},
		});
		const { docker, searchSpy } = makeFakeDocker();
		await spinUp(sessions, docker);

		const res = await postSearch({ action: "search", query: "foo" });
		expect(res.status).toBe(404);
		expect(searchSpy).not.toHaveBeenCalled();
	});
});

describe("POST /sessions/:id/tabs/:tabId/search — actions", () => {
	it("search: 204 and forwards (id, tabId, 'search', query) to DockerManager", async () => {
		const { sessions } = makeFakeSessions();
		const { docker, searchSpy } = makeFakeDocker();
		await spinUp(sessions, docker);

		const res = await postSearch({ action: "search", query: "-error: foo" });
		expect(res.status).toBe(204);
		expect(searchSpy).toHaveBeenCalledWith("sess-1", "tab-abc123", "search", "-error: foo");
	});

	it("next / prev / exit: 204 with no query forwarded", async () => {
		const { sessions } = makeFakeSessions();
		const { docker, searchSpy } = makeFakeDocker();
		await spinUp(sessions, docker);

		for (const action of ["next", "prev", "exit"] as const) {
			const res = await postSearch({ action });
			expect(res.status).toBe(204);
			expect(searchSpy).toHaveBeenCalledWith("sess-1", "tab-abc123", action, undefined);
		}
		expect(searchSpy).toHaveBeenCalledTimes(3);
	});

	it("a query on a non-search action is ignored, not forwarded", async () => {
		// The frontend never sends one, but a lenient body shape here must
		// not leak an unvalidated string into the tmux argv.
		const { sessions } = makeFakeSessions();
		const { docker, searchSpy } = makeFakeDocker();
		await spinUp(sessions, docker);

		const res = await postSearch({ action: "next", query: "stale" });
		expect(res.status).toBe(204);
		expect(searchSpy).toHaveBeenCalledWith("sess-1", "tab-abc123", "next", undefined);
	});

	it("maps TabNotFoundError from DockerManager to 404", async () => {
		const { sessions } = makeFakeSessions();
		const { docker } = makeFakeDocker({
			searchTabHistory: async () => {
				throw new TabNotFoundError();
			},
		});
		await spinUp(sessions, docker);

		const res = await postSearch({ action: "search", query: "foo" });
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/tab not found/);
	});
});
