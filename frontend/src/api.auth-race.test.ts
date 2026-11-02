/**
 * api.auth-race.test.ts — hypothesis B: a `logout()` whose POST answers
 * AFTER a new `login()` must not clear the new login's auth mirror
 * (`isLoggedIn` / `isAdmin` / `isLead`). Controlled promise, no timing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Api = typeof import("./api.js");

async function loadApi(): Promise<Api> {
	vi.resetModules();
	return import("./api.js");
}

function mockFetchResponse(init: { status?: number; json?: unknown }): Response {
	const status = init.status ?? 200;
	return {
		status,
		ok: status >= 200 && status < 300,
		json: vi.fn(async () => init.json ?? {}),
	} as unknown as Response;
}

function deferred<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
	fetchSpy = vi.fn();
	globalThis.fetch = fetchSpy as unknown as typeof fetch;
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("B: slow logout vs. a new login", () => {
	it("a logout answering after a new login keeps the new login's state", async () => {
		const api = await loadApi();
		// Account A is logged in.
		fetchSpy.mockResolvedValueOnce(
			mockFetchResponse({ json: { needsSetup: false, authenticated: true, isAdmin: false } }),
		);
		await api.checkAuthStatus();
		expect(api.isLoggedIn()).toBe(true);

		// A logs out; the POST /auth/logout is slow (held).
		const logoutRes = deferred<Response>();
		fetchSpy.mockReturnValueOnce(logoutRes.promise);
		const pendingLogout = api.logout();

		// B logs in meanwhile.
		fetchSpy.mockResolvedValueOnce(
			mockFetchResponse({ json: { userId: "u-bob", isAdmin: true, isLead: true } }),
		);
		await api.login("bob", "pw");
		expect(api.isLoggedIn()).toBe(true);
		expect(api.isAdmin()).toBe(true);

		// A's logout answer lands now.
		logoutRes.resolve(mockFetchResponse({ status: 204 }));
		await pendingLogout;

		expect(api.isLoggedIn(), "the late logout flipped the NEW login's isLoggedIn()").toBe(true);
		expect(api.isAdmin(), "the late logout cleared the NEW login's isAdmin()").toBe(true);
		expect(api.isLead(), "the late logout cleared the NEW login's isLead()").toBe(true);
	});
});
