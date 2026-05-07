import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Test harness ────────────────────────────────────────────────────────────
//
// Auth state lives in module-level memory now (#18). Tests that need to start
// from a known state load a fresh module via vi.resetModules() + dynamic
// import — `loadApi()` handles both.

interface Api {
	isLoggedIn: typeof import("./api.js").isLoggedIn;
	isAdmin: typeof import("./api.js").isAdmin;
	checkAuthStatus: typeof import("./api.js").checkAuthStatus;
	register: typeof import("./api.js").register;
	login: typeof import("./api.js").login;
	logout: typeof import("./api.js").logout;
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
	fetchSpy = vi.fn();
	globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ── Login state mirror ─────────────────────────────────────────────────────

describe("login state", () => {
	it("isLoggedIn defaults to false on a fresh load (cookie not yet observed)", async () => {
		const api = await loadApi();
		expect(api.isLoggedIn()).toBe(false);
	});

	it("checkAuthStatus mirrors the server's `authenticated` field into module state", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(
			mockFetchResponse({ json: { needsSetup: false, authenticated: true, isAdmin: false } }),
		);

		const status = await api.checkAuthStatus();
		expect(status.authenticated).toBe(true);
		expect(api.isLoggedIn()).toBe(true);
	});

	it("checkAuthStatus authenticated=false leaves isLoggedIn() false", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(
			mockFetchResponse({ json: { needsSetup: false, authenticated: false, isAdmin: false } }),
		);

		await api.checkAuthStatus();
		expect(api.isLoggedIn()).toBe(false);
	});

	it("login flips isLoggedIn to true on success", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ json: { userId: "u1", isAdmin: false } }));

		await api.login("alice", "secret");
		expect(api.isLoggedIn()).toBe(true);
	});

	it("logout POSTs /auth/logout and flips isLoggedIn to false even if the call fails", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ json: { userId: "u1", isAdmin: false } }));
		await api.login("alice", "secret");
		expect(api.isLoggedIn()).toBe(true);

		// Even an outright network rejection must not leave the UI thinking
		// it's still logged in — fail-closed.
		fetchSpy.mockRejectedValueOnce(new Error("offline"));
		await api.logout();
		expect(api.isLoggedIn()).toBe(false);

		// Confirm the logout endpoint was hit (last call before the test ends).
		const calls = fetchSpy.mock.calls;
		const last = calls[calls.length - 1];
		expect(last[0]).toBe("http://localhost:3001/api/auth/logout");
		expect(last[1].method).toBe("POST");
	});
});

// ── apiFetch wrapper ───────────────────────────────────────────────────────

describe("apiFetch — credentials and headers (#18)", () => {
	it("sends `credentials: include` on every request so the auth cookie travels cross-origin", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ json: [] }));

		await api.listSessions();

		const [, init] = fetchSpy.mock.calls[0];
		expect(init.credentials).toBe("include");
	});

	it("never sends an Authorization header (cookie-based auth, post-#18)", async () => {
		const api = await loadApi();
		// Simulate a logged-in session.
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ json: { userId: "u1", isAdmin: false } }));
		await api.login("alice", "secret");

		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ json: [] }));
		await api.listSessions();

		const [, init] = fetchSpy.mock.calls[1];
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
		expect(headers["Content-Type"]).toBe("application/json");
	});

	it("does NOT set Content-Type when the body is FormData (boundary clobber)", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ json: { paths: [] } }));

		const file = new File(["hi"], "a.txt", { type: "text/plain" });
		await api.uploadSessionFiles("session-1", [file]);

		const [, init] = fetchSpy.mock.calls[0];
		const headers = init.headers as Record<string, string>;
		expect(headers["Content-Type"]).toBeUndefined();
		expect(init.credentials).toBe("include");
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

// ── 401 stale-session handling ─────────────────────────────────────────────

describe("apiFetch — 401 stale-session semantics (issue #95)", () => {
	it("authed 401 flips isLoggedIn to false AND dispatches SESSION_EXPIRED_EVENT exactly once", async () => {
		const api = await loadApi();
		// Establish a logged-in state so the 401 is classified as "stale".
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ json: { userId: "u1", isAdmin: false } }));
		await api.login("alice", "secret");

		const handler = vi.fn();
		window.addEventListener(api.SESSION_EXPIRED_EVENT, handler);
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ status: 401 }));

		await api.listSessions().catch(() => {
			/* listSessions throws on !ok; we only care about side-effects here */
		});

		expect(api.isLoggedIn()).toBe(false);
		expect(handler).toHaveBeenCalledTimes(1);

		window.removeEventListener(api.SESSION_EXPIRED_EVENT, handler);
	});

	it("unauthed 401 (e.g. wrong-password /auth/login) does NOT dispatch the event", async () => {
		const api = await loadApi();
		// Logged-out state — login attempt with bad creds returns 401.
		expect(api.isLoggedIn()).toBe(false);

		const handler = vi.fn();
		window.addEventListener(api.SESSION_EXPIRED_EVENT, handler);
		fetchSpy.mockResolvedValueOnce(
			mockFetchResponse({ status: 401, json: { error: "bad creds" } }),
		);

		await api.login("user", "wrong").catch(() => {
			/* login throws on !ok */
		});

		expect(api.isLoggedIn()).toBe(false);
		expect(handler).not.toHaveBeenCalled();
		window.removeEventListener(api.SESSION_EXPIRED_EVENT, handler);
	});

	it("dedups concurrent 401 bursts so only one event fires per stale-session window", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ json: { userId: "u1", isAdmin: false } }));
		await api.login("alice", "secret");

		const handler = vi.fn();
		window.addEventListener(api.SESSION_EXPIRED_EVENT, handler);
		// Two concurrent authed 401s — the dedup gate is `_loggedIn`,
		// so the first response flips it false and the second sees false.
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

	it("403 does NOT flip isLoggedIn (policy, not stale)", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ json: { userId: "u1", isAdmin: false } }));
		await api.login("alice", "secret");

		fetchSpy.mockResolvedValueOnce(
			mockFetchResponse({ status: 403, json: { error: "forbidden" } }),
		);

		await api.createSession("name").catch(() => {
			/* createSession throws on !ok */
		});

		expect(api.isLoggedIn()).toBe(true);
	});
});

// ── Auth + invite-required path ───────────────────────────────────────────

describe("auth API", () => {
	it("register success returns the userId and flips isLoggedIn", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(
			mockFetchResponse({ status: 201, json: { userId: "u1", isAdmin: false } }),
		);

		const data = await api.register("alice", "secret");
		expect(data).toEqual({ userId: "u1", isAdmin: false });
		expect(api.isLoggedIn()).toBe(true);
	});

	it("register 403 throws InviteRequiredError carrying the server message", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValue(
			mockFetchResponse({ status: 403, json: { error: "Invite code required" } }),
		);

		await expect(api.register("u", "p")).rejects.toThrow(api.InviteRequiredError);
		await expect(api.register("u", "p")).rejects.toThrow("Invite code required");
		expect(api.isLoggedIn()).toBe(false);
	});

	it("register on other errors throws a generic Error with the body message", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(
			mockFetchResponse({ status: 409, json: { error: "Username taken" } }),
		);

		await expect(api.register("u", "p")).rejects.toThrow("Username taken");
		expect(api.isLoggedIn()).toBe(false);
	});

	it("login success returns the userId", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ json: { userId: "u1", isAdmin: false } }));

		const data = await api.login("u", "p");
		expect(data).toEqual({ userId: "u1", isAdmin: false });
	});
});

// ── 404-as-success cases ──────────────────────────────────────────────────

describe("idempotent-delete semantics", () => {
	it("deleteTab on a 404 throws TabNotFoundError so callers can drop the chip", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ status: 404 }));

		await expect(api.deleteTab("session-1", "tab-1")).rejects.toThrow(api.TabNotFoundError);
	});

	it("revokeInvite on a 404 resolves silently (concurrent revoke / redemption)", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ status: 404 }));

		// Post-#49 the argument is the SHA-256 hex hash, not the plaintext.
		const hash = "a".repeat(64);
		await expect(api.revokeInvite(hash)).resolves.toBeUndefined();
	});

	it("revokeInvite targets /invites/<hash> (post-#49 — plaintext is gone)", async () => {
		const api = await loadApi();
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
		expect((list[0] as unknown as Record<string, unknown>).code).toBeUndefined();
	});
});

// ── Admin mirror (#50) ──────────────────────────────────────────────────────

describe("admin state mirror", () => {
	it("isAdmin defaults to false on a fresh load", async () => {
		const api = await loadApi();
		expect(api.isAdmin()).toBe(false);
	});

	it("checkAuthStatus mirrors isAdmin: true into the module state", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(
			mockFetchResponse({ json: { needsSetup: false, authenticated: true, isAdmin: true } }),
		);
		await api.checkAuthStatus();
		expect(api.isAdmin()).toBe(true);
	});

	it("login response sets isAdmin from the server payload", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ json: { userId: "u1", isAdmin: true } }));
		await api.login("admin", "secret");
		expect(api.isAdmin()).toBe(true);
	});

	it("register response sets isAdmin from the server payload (bootstrap path)", async () => {
		const api = await loadApi();
		// Bootstrap-register returns isAdmin: true so the new user sees
		// the invite UI without waiting for the next /auth/status call.
		fetchSpy.mockResolvedValueOnce(
			mockFetchResponse({ status: 201, json: { userId: "u1", isAdmin: true } }),
		);
		await api.register("alice", "secret");
		expect(api.isAdmin()).toBe(true);
	});

	it("logout flips isAdmin back to false", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ json: { userId: "u1", isAdmin: true } }));
		await api.login("admin", "secret");
		expect(api.isAdmin()).toBe(true);

		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ status: 204 }));
		await api.logout();
		expect(api.isAdmin()).toBe(false);
	});

	it("authed 401 flips isAdmin back to false alongside isLoggedIn", async () => {
		const api = await loadApi();
		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ json: { userId: "u1", isAdmin: true } }));
		await api.login("admin", "secret");
		expect(api.isAdmin()).toBe(true);

		fetchSpy.mockResolvedValueOnce(mockFetchResponse({ status: 401 }));
		await api.listSessions().catch(() => {
			/* drop */
		});

		expect(api.isAdmin()).toBe(false);
		expect(api.isLoggedIn()).toBe(false);
	});
});
