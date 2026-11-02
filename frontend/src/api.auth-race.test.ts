/**
 * api.auth-race.test.ts — hypothesis B: a `logout()` whose POST answers
 * AFTER a new `login()` must neither clear the new login's auth mirror
 * nor be allowed to answer after the login's own request (its answer
 * carries the cookie-deleting Set-Cookie). Controlled promises; the
 * settle budget runs on fake timers. The real cookie jar is covered by
 * e2e/auth-cookie.spec.ts.
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

/** A held answer that, like a real fetch, rejects when its signal aborts. */
function heldFetch(answer: Promise<Response>) {
	return (_url: string, init?: RequestInit) =>
		new Promise<Response>((resolve, reject) => {
			init?.signal?.addEventListener("abort", () =>
				reject(new DOMException("The operation was aborted.", "AbortError")),
			);
			void answer.then(resolve);
		});
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
	vi.useFakeTimers();
	fetchSpy = vi.fn();
	globalThis.fetch = fetchSpy as unknown as typeof fetch;
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("B: slow logout vs. a new login", () => {
	it("the mirror is off the moment logout is called, and the login waits for the logout to settle", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(
			mockFetchResponse({ json: { needsSetup: false, authenticated: true, isAdmin: false } }),
		);
		await api.checkAuthStatus();
		expect(api.isLoggedIn()).toBe(true);

		const logoutRes = deferred<Response>();
		fetchSpy.mockImplementationOnce(heldFetch(logoutRes.promise));
		const pendingLogout = api.logout();
		expect(api.isLoggedIn(), "cleared before the request answers").toBe(false);

		fetchSpy.mockResolvedValueOnce(
			mockFetchResponse({ json: { userId: "u-bob", isAdmin: true, isLead: true } }),
		);
		const loginP = api.login("bob", "pw");
		await vi.advanceTimersByTimeAsync(10);
		expect(fetchSpy, "the login request waits for the logout to settle").toHaveBeenCalledTimes(2);
		logoutRes.resolve(mockFetchResponse({ status: 204 }));
		await pendingLogout;
		await vi.advanceTimersByTimeAsync(10);
		await loginP;
		expect(fetchSpy).toHaveBeenCalledTimes(3);
		expect(api.isLoggedIn()).toBe(true);
		expect(api.isAdmin()).toBe(true);
		expect(api.isLead()).toBe(true);
	});

	it("a logout that does not answer within the budget is aborted before the login request leaves", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(
			mockFetchResponse({ json: { needsSetup: false, authenticated: true, isAdmin: false } }),
		);
		await api.checkAuthStatus();

		const never = deferred<Response>();
		fetchSpy.mockImplementationOnce(heldFetch(never.promise));
		const pendingLogout = api.logout();
		const logoutInit = fetchSpy.mock.calls[1]?.[1] as RequestInit;
		expect(logoutInit.signal).toBeInstanceOf(AbortSignal);

		fetchSpy.mockResolvedValueOnce(
			mockFetchResponse({ json: { userId: "u-bob", isAdmin: false, isLead: false } }),
		);
		const loginP = api.login("bob", "pw");
		await vi.advanceTimersByTimeAsync(api.LOGOUT_SETTLE_MS - 1);
		expect(fetchSpy, "still waiting inside the budget").toHaveBeenCalledTimes(2);
		expect(logoutInit.signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(2);
		expect(logoutInit.signal?.aborted, "past the budget the stale logout is aborted").toBe(true);
		await pendingLogout;
		await loginP;
		const order = fetchSpy.mock.calls.map((c) => String(c[0]));
		expect(order[1]).toContain("/auth/logout");
		expect(order[2]).toContain("/auth/login");
		expect(api.isLoggedIn()).toBe(true);
		never.resolve(mockFetchResponse({ status: 204 }));
		await vi.advanceTimersByTimeAsync(10);
		expect(api.isLoggedIn()).toBe(true);
	});
});
