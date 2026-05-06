import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Test harness ────────────────────────────────────────────────────────────
//
// api.ts caches the token in module state and reads `localStorage` *once* at
// import time. Most tests can manipulate state via `setToken`, but anything
// that depends on the load-time read (the `_token` initialiser at the top of
// api.ts) needs `vi.resetModules()` + a fresh import. The helper below makes
// that explicit so individual tests don't have to reach for vi.resetModules
// themselves.

interface Api {
	getToken: typeof import("./api.js").getToken;
	setToken: typeof import("./api.js").setToken;
	isLoggedIn: typeof import("./api.js").isLoggedIn;
	logout: typeof import("./api.js").logout;
	register: typeof import("./api.js").register;
	login: typeof import("./api.js").login;
	createSession: typeof import("./api.js").createSession;
	listSessions: typeof import("./api.js").listSessions;
	deleteTab: typeof import("./api.js").deleteTab;
	createInvite: typeof import("./api.js").createInvite;
	listInvites: typeof import("./api.js").listInvites;
	revokeInvite: typeof import("./api.js").revokeInvite;
	uploadSessionFiles: typeof import("./api.js").uploadSessionFiles;
	InviteRequiredError: typeof import("./api.js").InviteRequiredError;
	TabNotFoundError: typeof import("./api.js").TabNotFoundError;
	SESSION_EXPIRED_EVENT: typeof import("./api.js").SESSION_EXPIRED_EVENT;
}

async function loadApi(): Promise<Api> {
	vi.resetModules();
	return (await import("./api.js")) as Api;
}

function mockFetchResponse(init: { status?: number; ok?: boolean; json?: unknown }): Response {
	const status = init.status ?? 200;
	const body = init.json ?? {};
	return {
		status,
		ok: init.ok ?? (status >= 200 && status < 300),
		json: vi.fn(async () => body),
	} as unknown as Response;
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
	localStorage.clear();
	fetchSpy = vi.fn();
	globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ── Token management ───────────────────────────────────────────────────────

describe("token management", () => {
	it("setToken persists to localStorage; getToken / isLoggedIn reflect the cached value", async () => {
		const api = await loadApi();
		expect(api.getToken()).toBeNull();
		expect(api.isLoggedIn()).toBe(false);

		api.setToken("abc.def.ghi");
		expect(api.getToken()).toBe("abc.def.ghi");
		expect(api.isLoggedIn()).toBe(true);
		expect(localStorage.getItem("st_token")).toBe("abc.def.ghi");
	});

	it("setToken(null) clears localStorage; logout is sugar for it", async () => {
		const api = await loadApi();
		api.setToken("abc");
		api.logout();
		expect(api.getToken()).toBeNull();
		expect(api.isLoggedIn()).toBe(false);
		expect(localStorage.getItem("st_token")).toBeNull();
	});

	it("module load picks up an existing token from localStorage", async () => {
		// The load-time read in `let _token = localStorage.getItem(...)` is the
		// only way returning users stay logged in across tab reopens. Pin it.
		localStorage.setItem("st_token", "from-disk");
		const api = await loadApi();
		expect(api.getToken()).toBe("from-disk");
		expect(api.isLoggedIn()).toBe(true);
	});
});

// ── apiFetch wrapper ───────────────────────────────────────────────────────
//
// apiFetch is private but we exercise it indirectly via every public route.
// Pinned behaviours: Authorization header gating, Content-Type vs FormData
// and the 401 stale-token logout.

describe("apiFetch — Authorization + Content-Type", () => {
	it("omits Authorization when no token is set", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ json: [] }));

		await api.listSessions();

		const [, init] = fetchSpy.mock.calls[0];
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
		expect(headers["Content-Type"]).toBe("application/json");
	});

	it("sets `Authorization: Bearer <token>` when a token is present", async () => {
		const api = await loadApi();
		api.setToken("tok-123");
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ json: [] }));

		await api.listSessions();

		const [, init] = fetchSpy.mock.calls[0];
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
	});

	it("does NOT set Content-Type when the body is FormData (boundary clobber)", async () => {
		const api = await loadApi();
		api.setToken("tok");
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ json: { paths: [] } }));

		const file = new File(["hi"], "a.txt", { type: "text/plain" });
		await api.uploadSessionFiles("session-1", [file]);

		const [, init] = fetchSpy.mock.calls[0];
		const headers = init.headers as Record<string, string>;
		expect(headers["Content-Type"]).toBeUndefined();
		// Authorization still gets through — only Content-Type is suppressed.
		expect(headers.Authorization).toBe("Bearer tok");
		expect(init.body).toBeInstanceOf(FormData);
	});

	it("hits the URL composed from VITE_API_URL + /api + path", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ json: [] }));

		await api.listSessions();

		const [url] = fetchSpy.mock.calls[0];
		// VITE_API_URL is unset in the test env, so the fallback applies.
		expect(url).toBe("http://localhost:3001/api/sessions");
	});
});

// ── 401 stale-token handling ───────────────────────────────────────────────

describe("apiFetch — 401 stale-token semantics (issue #95)", () => {
	it("authed 401 clears the token AND dispatches SESSION_EXPIRED_EVENT exactly once", async () => {
		const api = await loadApi();
		api.setToken("stale");

		const handler = vi.fn();
		window.addEventListener(api.SESSION_EXPIRED_EVENT, handler);
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ status: 401 }));

		await api.listSessions().catch(() => {
			/* listSessions throws on !ok; we only care about side-effects here */
		});

		expect(api.getToken()).toBeNull();
		expect(handler).toHaveBeenCalledTimes(1);

		window.removeEventListener(api.SESSION_EXPIRED_EVENT, handler);
	});

	it("unauthed 401 (e.g. wrong-password /auth/login) does NOT clear token state", async () => {
		const api = await loadApi();
		// Simulate the case where the user is logged out but tries to log in
		// with a bad password — the 401 from /auth/login is policy, not stale.
		expect(api.getToken()).toBeNull();
		fetchSpy.mockResolvedValueOnce(
			mockFetchResponse({ status: 401, json: { error: "bad creds" } }),
		);

		await api.login("user", "wrong").catch(() => {
			/* login throws on !ok */
		});

		// _token must remain null (not actively set, but also not "cleared by
		// the 401 path" — these tests are belt-and-braces).
		expect(api.getToken()).toBeNull();
	});

	it("dedups concurrent 401 bursts so only one event fires per stale-token window", async () => {
		const api = await loadApi();
		api.setToken("stale");

		const handler = vi.fn();
		window.addEventListener(api.SESSION_EXPIRED_EVENT, handler);
		// Two concurrent authed 401s — the dedup gate is `_token !== null`,
		// so the first response clears _token and the second sees null.
		fetchSpy
			.mockResolvedValueOnce(mockFetchResponse({ status: 401 }))
			.mockResolvedValueOnce(mockFetchResponse({ status: 401 }));

		await Promise.all([
			api.listSessions().catch(() => {
				/* drop */
			}),
			api.listSessions().catch(() => {
				/* drop */
			}),
		]);

		expect(handler).toHaveBeenCalledTimes(1);
		window.removeEventListener(api.SESSION_EXPIRED_EVENT, handler);
	});

	it("403 does NOT clear the token (policy, not stale)", async () => {
		const api = await loadApi();
		api.setToken("good");
		fetchSpy.mockResolvedValueOnce(
			mockFetchResponse({ status: 403, json: { error: "forbidden" } }),
		);

		await api.createSession("name").catch(() => {
			/* createSession throws on !ok */
		});

		expect(api.getToken()).toBe("good");
	});
});

// ── Auth + invite-required path ───────────────────────────────────────────

describe("auth API", () => {
	it("register success stores the returned token and resolves to the body", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(
			mockFetchResponse({ status: 201, json: { userId: "u1", token: "t1" } }),
		);

		const data = await api.register("alice", "secret");
		expect(data).toEqual({ userId: "u1", token: "t1" });
		expect(api.getToken()).toBe("t1");
	});

	it("register 403 throws InviteRequiredError carrying the server message", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValue(
			mockFetchResponse({ status: 403, json: { error: "Invite code required" } }),
		);

		await expect(api.register("u", "p")).rejects.toThrow(api.InviteRequiredError);
		await expect(api.register("u", "p")).rejects.toThrow("Invite code required");
		// Token stays null on the failed register.
		expect(api.getToken()).toBeNull();
	});

	it("register on other errors throws a generic Error with the body message", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(
			mockFetchResponse({ status: 409, json: { error: "Username taken" } }),
		);

		await expect(api.register("u", "p")).rejects.toThrow("Username taken");
	});

	it("login success stores the returned token", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ json: { userId: "u1", token: "tok" } }));

		await api.login("u", "p");
		expect(api.getToken()).toBe("tok");
	});
});

// ── 404-as-success cases ──────────────────────────────────────────────────

describe("idempotent-delete semantics", () => {
	it("deleteTab on a 404 throws TabNotFoundError so callers can drop the chip", async () => {
		const api = await loadApi();
		api.setToken("tok");
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ status: 404 }));

		await expect(api.deleteTab("session-1", "tab-1")).rejects.toThrow(api.TabNotFoundError);
	});

	it("revokeInvite on a 404 resolves silently (concurrent revoke / redemption)", async () => {
		const api = await loadApi();
		api.setToken("tok");
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ status: 404 }));

		// Post-#49 the argument is the SHA-256 hex hash, not the plaintext.
		const hash = "a".repeat(64);
		await expect(api.revokeInvite(hash)).resolves.toBeUndefined();
	});

	it("revokeInvite targets /invites/<hash> (post-#49 — plaintext is gone)", async () => {
		const api = await loadApi();
		api.setToken("tok");
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ status: 204 }));

		const hash = "deadbeef".repeat(8); // 64 hex chars
		await api.revokeInvite(hash);

		const [url, init] = fetchSpy.mock.calls[0];
		expect(url).toBe(`http://localhost:3001/api/invites/${hash}`);
		expect(init.method).toBe("DELETE");
	});
});

// ── Invite mint + list shape (#49) ──────────────────────────────────────────

describe("invite hash-at-rest wire shape", () => {
	it("createInvite returns the plaintext code alongside hash and prefix exactly once", async () => {
		const api = await loadApi();
		api.setToken("tok");
		fetchSpy.mockResolvedValueOnce(
			mockFetchResponse({
				status: 201,
				json: {
					code: "ab12cd34ef567890",
					codeHash: "f".repeat(64),
					codePrefix: "ab12",
					createdAt: "2026-05-06 20:00:00",
					usedAt: null,
					expiresAt: "2026-06-05 20:00:00",
				},
			}),
		);

		const minted = await api.createInvite();

		expect(minted.code).toBe("ab12cd34ef567890");
		expect(minted.codeHash).toBe("f".repeat(64));
		expect(minted.codePrefix).toBe("ab12");
	});

	it("listInvites returns hash + prefix and never carries plaintext", async () => {
		const api = await loadApi();
		api.setToken("tok");
		fetchSpy.mockResolvedValueOnce(
			mockFetchResponse({
				json: [
					{
						codeHash: "0".repeat(64),
						codePrefix: "ab12",
						createdAt: "2026-05-06 20:00:00",
						usedAt: null,
						expiresAt: null,
					},
				],
			}),
		);

		const list = await api.listInvites();

		expect(list).toHaveLength(1);
		expect(list[0].codeHash).toBe("0".repeat(64));
		expect(list[0].codePrefix).toBe("ab12");
		// The Invite type explicitly omits plaintext — guard the wire too.
		expect((list[0] as unknown as Record<string, unknown>).code).toBeUndefined();
	});
});
