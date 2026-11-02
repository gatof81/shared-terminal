/**
 * api.auth-race.test.ts — the auth transitions against each other, on the
 * in-page lock (jsdom has no Web Locks; e2e/auth-cookie.spec.ts drives the
 * real browser, its Web Locks and its cookie jar):
 *
 * - B: a logout in flight holds the next login's REQUEST back until its
 *   answer (its cookie delete) has landed; the mirror is cleared at once.
 * - a 401 for an earlier account never ends a later one; a current 401
 *   still does, once per burst.
 * - a stale /auth/status never overwrites the new identity.
 * - a login a logout overtook is refused, not applied.
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

const STATUS_A = { needsSetup: false, authenticated: true, isAdmin: true, isLead: false };
const BOB = { userId: "u-bob", isAdmin: false, isLead: true };

let fetchSpy: ReturnType<typeof vi.fn>;
let expired: number;
const onExpired = () => {
	expired++;
};
beforeEach(() => {
	fetchSpy = vi.fn();
	globalThis.fetch = fetchSpy as unknown as typeof fetch;
	expired = 0;
	window.addEventListener("st:session-expired", onExpired);
});
afterEach(() => {
	window.removeEventListener("st:session-expired", onExpired);
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const paths = () => fetchSpy.mock.calls.map((c) => new URL(String(c[0])).pathname);

/** Lets every queued microtask/lock hand-off run. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function signedInAsAlice(api: Api): Promise<void> {
	fetchSpy.mockResolvedValueOnce(mockFetchResponse({ json: STATUS_A }));
	await api.checkAuthStatus();
	expect(api.isLoggedIn()).toBe(true);
}

describe("B: a logout in flight vs. the next login", () => {
	it("clears the mirror at once and sends the login only after the logout answered", async () => {
		const api = await loadApi();
		await signedInAsAlice(api);

		const logoutRes = deferred<Response>();
		fetchSpy.mockReturnValueOnce(logoutRes.promise);
		const pendingLogout = api.logout();
		expect(api.isLoggedIn(), "cleared before the request answers").toBe(false);
		expect(api.isAdmin()).toBe(false);

		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ json: BOB }));
		const loginP = api.login("bob", "pw");
		await settle();
		expect(paths(), "the login request waits for the logout's answer").toEqual([
			"/api/auth/status",
			"/api/auth/logout",
		]);

		logoutRes.resolve(mockFetchResponse({ status: 204 }));
		await pendingLogout;
		await loginP;
		expect(paths().slice(-2)).toEqual(["/api/auth/logout", "/api/auth/login"]);
		expect(api.isLoggedIn()).toBe(true);
		expect(api.isAdmin()).toBe(false);
		expect(api.isLead()).toBe(true);
	});

	it("a login that cannot get its turn in time fails without sending anything", async () => {
		vi.useFakeTimers();
		const api = await loadApi();
		await signedInAsAlice(api);

		const never = deferred<Response>();
		fetchSpy.mockReturnValueOnce(never.promise);
		void api.logout();

		const loginP = api.login("bob", "pw");
		const failed = expect(loginP).rejects.toBeInstanceOf(api.AuthBusyError);
		await vi.advanceTimersByTimeAsync(api.AUTH_WAIT_MS + 1);
		await failed;
		expect(paths(), "no login request left").not.toContain("/api/auth/login");
		expect(api.isLoggedIn()).toBe(false);

		// Once the logout answers, a new attempt goes through.
		never.resolve(mockFetchResponse({ status: 204 }));
		await vi.advanceTimersByTimeAsync(0);
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ json: BOB }));
		await api.login("bob", "pw");
		expect(api.isLoggedIn()).toBe(true);
	});

	it("a logout started while a login is in flight wins: the login is refused and the logout is sent after it", async () => {
		const api = await loadApi();
		const loginRes = deferred<Response>();
		fetchSpy.mockReturnValueOnce(loginRes.promise);
		const loginP = api.login("bob", "pw");
		const refused = expect(loginP).rejects.toBeInstanceOf(api.AuthSupersededError);
		await settle();

		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ status: 204 }));
		const logoutP = api.logout();
		await settle();
		expect(paths(), "the logout waits for the login's answer").toEqual(["/api/auth/login"]);

		loginRes.resolve(mockFetchResponse({ json: BOB }));
		await refused;
		await logoutP;
		expect(paths()).toEqual(["/api/auth/login", "/api/auth/logout"]);
		expect(api.isLoggedIn()).toBe(false);
	});
});

describe("401s and the auth generation", () => {
	it("a 401 answering for the previous account does not end the new one", async () => {
		const api = await loadApi();
		await signedInAsAlice(api);

		const aliceList = deferred<Response>();
		fetchSpy.mockReturnValueOnce(aliceList.promise);
		const listP = api.listSessions().catch(() => null);

		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ status: 204 }));
		await api.logout();
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ json: BOB }));
		await api.login("bob", "pw");
		expect(api.isLoggedIn()).toBe(true);

		aliceList.resolve(mockFetchResponse({ status: 401, json: { error: "Unauthorized" } }));
		await listP;
		expect(expired, "Alice's 401 fired the session-expired path for Bob").toBe(0);
		expect(api.isLoggedIn()).toBe(true);
		expect(api.isLead()).toBe(true);
	});

	it("a 401 for the current account still signs it out", async () => {
		const api = await loadApi();
		await signedInAsAlice(api);
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ status: 401, json: {} }));
		await api.listSessions().catch(() => null);
		expect(expired).toBe(1);
		expect(api.isLoggedIn()).toBe(false);
		expect(api.isAdmin()).toBe(false);
	});

	it("several simultaneous 401s of the current account end it once", async () => {
		const api = await loadApi();
		await signedInAsAlice(api);
		const answers = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
		for (const a of answers) fetchSpy.mockReturnValueOnce(a.promise);
		const calls = answers.map(() => api.listSessions().catch(() => null));
		for (const a of answers) a.resolve(mockFetchResponse({ status: 401, json: {} }));
		await Promise.all(calls);
		expect(expired).toBe(1);
		expect(api.isLoggedIn()).toBe(false);
	});

	it("a 401 after the session-expired logout and a new login does not end the new login", async () => {
		const api = await loadApi();
		await signedInAsAlice(api);
		const late = deferred<Response>();
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ status: 401, json: {} }));
		fetchSpy.mockReturnValueOnce(late.promise);
		await api.listSessions().catch(() => null);
		const lateP = api.listSessions().catch(() => null);
		expect(expired).toBe(1);
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ status: 204 }));
		await api.logout();
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ json: BOB }));
		await api.login("bob", "pw");
		late.resolve(mockFetchResponse({ status: 401, json: {} }));
		await lateP;
		expect(expired).toBe(1);
		expect(api.isLoggedIn()).toBe(true);
	});
});

describe("a stale /auth/status", () => {
	it("an answer for the previous account does not overwrite the new identity", async () => {
		const api = await loadApi();
		await signedInAsAlice(api);

		const status = deferred<Response>();
		fetchSpy.mockReturnValueOnce(status.promise);
		const statusP = api.checkAuthStatus();
		await settle();

		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ status: 204 }));
		const logoutP = api.logout();
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ json: BOB }));
		const loginP = api.login("bob", "pw");
		await settle();
		expect(
			paths().slice(-1),
			"the logout waits for the status probe that holds the shared lock",
		).toEqual(["/api/auth/status"]);

		status.resolve(mockFetchResponse({ json: STATUS_A }));
		const stale = await statusP;
		expect(stale.authenticated, "callers get the current identity, not the stale one").toBe(false);
		expect(stale.isAdmin).toBe(false);
		await logoutP;
		await loginP;
		expect(api.isLoggedIn()).toBe(true);
		expect(api.isAdmin(), "Alice's admin bit leaked into Bob's session").toBe(false);
		expect(api.isLead()).toBe(true);
	});

	it("a status probe started during a logout is sent only after it answered", async () => {
		const api = await loadApi();
		await signedInAsAlice(api);
		const logoutRes = deferred<Response>();
		fetchSpy.mockReturnValueOnce(logoutRes.promise);
		const logoutP = api.logout();
		fetchSpy.mockResolvedValueOnce(
			mockFetchResponse({ json: { ...STATUS_A, authenticated: false, isAdmin: false } }),
		);
		const statusP = api.checkAuthStatus();
		await settle();
		expect(paths().slice(-1)).toEqual(["/api/auth/logout"]);
		logoutRes.resolve(mockFetchResponse({ status: 204 }));
		await logoutP;
		expect((await statusP).authenticated).toBe(false);
		expect(paths().slice(-2)).toEqual(["/api/auth/logout", "/api/auth/status"]);
	});
});
