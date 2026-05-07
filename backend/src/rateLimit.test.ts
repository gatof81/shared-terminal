import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DockerManager } from "./dockerManager.js";
import { UsernameRateLimiter } from "./rateLimit.js";
import type { SessionManager } from "./sessionManager.js";

// Stub the auth module so routing tests don't touch D1. Handles captured
// as `authStubs` are reconfigured per-test.
const authStubs = vi.hoisted(() => ({
	registerUser: vi.fn(async (_u: string, _p: string) => ({
		userId: "u1",
		token: "tok",
		isAdmin: false,
	})),
	loginUser: vi.fn(async (_u: string, _p: string) => ({
		userId: "u1",
		token: "tok",
		isAdmin: false,
	})),
	hasAnyUsers: vi.fn(async () => true),
	listInvites: vi.fn(async () => [] as unknown[]),
	createInvite: vi.fn(async (_u: string) => ({
		code: "deadbeefdeadbeef",
		codeHash: "f".repeat(64),
		codePrefix: "dead",
		createdAt: "2026-05-07 00:00:00",
		usedAt: null,
		expiresAt: null,
	})),
	requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
	// vi.fn so individual tests can override (the admin-gate test below
	// flips the default-passthrough behaviour to a 403 to pin the
	// route-level wiring). Default impl is the same passthrough every
	// other test in this file relies on.
	requireAdmin: vi.fn((_req: unknown, _res: unknown, next: () => void) => {
		next();
	}),
	// Cookie-auth helpers (#18). Tests don't read the cookie back, so a
	// no-op for set/clear and a permissive shape-only verify is enough.
	AUTH_COOKIE_NAME: "st_token",
	setAuthCookie: vi.fn(() => {
		/* no-op */
	}),
	clearAuthCookie: vi.fn(() => {
		/* no-op */
	}),
	extractTokenFromCookieHeader: vi.fn(() => null),
	verifyJwt: vi.fn(() => null),
	// The route handler checks `err instanceof InvalidCredentialsError` where
	// `InvalidCredentialsError` is imported from `./auth.js`. Because we
	// `vi.mock` the whole module, both the handler's import and the stub's
	// throw resolve to this same constructor.
	InvalidCredentialsError: class extends Error {
		constructor() {
			super("Invalid credentials");
			this.name = "InvalidCredentialsError";
		}
	},
}));
vi.mock("./auth.js", () => authStubs);

// `buildRouter` is imported AFTER the mock is in place.
import { buildRouter } from "./routes.js";

// Typed placeholders for the route tests — no session/docker routes are
// hit in these scenarios, so an empty-object cast is fine AND preserves
// type-checking if a future route starts calling into sessions/docker.
// getUploadTmpDir IS called eagerly during buildRouter() when configuring
// multer's diskStorage destination, so fakeDocker has to provide a stub
// even though no upload route runs in these tests.
const fakeSessions = {} as unknown as SessionManager;
const fakeDocker = {
	getUploadTmpDir: () => "/tmp/shared-terminal-test-uploads",
} as unknown as DockerManager;

// ── UsernameRateLimiter unit tests ─────────────────────────────────────────

describe("UsernameRateLimiter", () => {
	it("allows attempts up to max; blocks the (max+1)th with retryAfterSeconds", () => {
		const rl = new UsernameRateLimiter(3, 60_000);
		for (let i = 0; i < 3; i++) {
			expect(rl.check("alice").allowed).toBe(true);
			rl.recordFailure("alice");
		}
		const blocked = rl.check("alice");
		expect(blocked.allowed).toBe(false);
		if (!blocked.allowed) {
			expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
			expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
		}
	});

	it("isolates buckets per username", () => {
		const rl = new UsernameRateLimiter(1, 60_000);
		rl.recordFailure("alice");
		expect(rl.check("alice").allowed).toBe(false);
		// bob is untouched.
		expect(rl.check("bob").allowed).toBe(true);
	});

	it("resets the window automatically after windowMs elapses", () => {
		vi.useFakeTimers();
		try {
			const rl = new UsernameRateLimiter(1, 60_000);
			rl.recordFailure("alice");
			expect(rl.check("alice").allowed).toBe(false);
			vi.advanceTimersByTime(60_001);
			expect(rl.check("alice").allowed).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reset(username) clears a single bucket, clearForTesting() clears all", () => {
		const rl = new UsernameRateLimiter(1, 60_000);
		rl.recordFailure("alice");
		rl.recordFailure("bob");
		rl.reset("alice");
		expect(rl.check("alice").allowed).toBe(true);
		expect(rl.check("bob").allowed).toBe(false);

		rl.clearForTesting();
		expect(rl.check("bob").allowed).toBe(true);
	});

	it("recordFailure past the window starts a fresh counter", () => {
		vi.useFakeTimers();
		try {
			const rl = new UsernameRateLimiter(2, 60_000);
			rl.recordFailure("alice");
			rl.recordFailure("alice");
			vi.advanceTimersByTime(60_001);
			rl.recordFailure("alice");
			expect(rl.check("alice").allowed).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	// ── beginAttempt / endAttempt (in-flight accounting) ────────────────

	it("beginAttempt reserves a slot so concurrent attempts share the bound", () => {
		// Pins the concurrency invariant that motivates beginAttempt: with
		// async bcrypt, N parallel requests against the same username could
		// all pass check() before any recordFailure lands. beginAttempt
		// reserves a slot atomically so the (max+1)th in-flight attempt is
		// rejected even without a single failure recorded yet.
		const rl = new UsernameRateLimiter(3, 60_000);
		expect(rl.beginAttempt("alice").allowed).toBe(true);
		expect(rl.beginAttempt("alice").allowed).toBe(true);
		expect(rl.beginAttempt("alice").allowed).toBe(true);
		const overflow = rl.beginAttempt("alice");
		expect(overflow.allowed).toBe(false);
		if (!overflow.allowed) {
			expect(overflow.retryAfterSeconds).toBeGreaterThan(0);
		}
	});

	it("endAttempt releases an in-flight slot so the next attempt can proceed", () => {
		const rl = new UsernameRateLimiter(1, 60_000);
		expect(rl.beginAttempt("alice").allowed).toBe(true);
		expect(rl.beginAttempt("alice").allowed).toBe(false);
		rl.endAttempt("alice");
		expect(rl.beginAttempt("alice").allowed).toBe(true);
	});

	it("endAttempt is idempotent when no slot is held (over-release is safe)", () => {
		// Route handlers call endAttempt in a `finally`; if an earlier error
		// path also released, the second call must not throw or skew the
		// counter below zero.
		const rl = new UsernameRateLimiter(1, 60_000);
		rl.endAttempt("alice"); // nothing held
		rl.endAttempt("alice"); // still nothing held
		expect(rl.beginAttempt("alice").allowed).toBe(true);
	});

	it("in-flight and recorded failures share the same max budget", () => {
		// One in-flight + (max-1) recorded failures = full budget. The next
		// beginAttempt must be rejected. Covers the transient window around
		// recordFailure (which bumps the counter before endAttempt releases
		// the inflight slot) — the overlap is intentionally pessimistic.
		const rl = new UsernameRateLimiter(3, 60_000);
		rl.recordFailure("alice");
		rl.recordFailure("alice");
		expect(rl.beginAttempt("alice").allowed).toBe(true); // 2 failed + 1 inflight = 3
		expect(rl.beginAttempt("alice").allowed).toBe(false);
	});

	it("beginAttempt isolates slot counts per username", () => {
		const rl = new UsernameRateLimiter(1, 60_000);
		expect(rl.beginAttempt("alice").allowed).toBe(true);
		// Alice's slot is held; bob should still be free.
		expect(rl.beginAttempt("bob").allowed).toBe(true);
		expect(rl.beginAttempt("alice").allowed).toBe(false);
	});

	it("caps total tracked usernames and evicts oldest when full (DoS guard)", () => {
		const rl = new UsernameRateLimiter(5, 60_000, 3);
		rl.recordFailure("u0");
		rl.recordFailure("u1");
		rl.recordFailure("u2");
		expect(rl.sizeForTesting()).toBe(3);

		rl.recordFailure("u3");
		expect(rl.sizeForTesting()).toBe(3);

		// u0 was evicted FIFO — check() returns allowed and no bucket remains,
		// and a fresh recordFailure gets a new count-1 bucket rather than
		// resuming u0's prior state.
		expect(rl.check("u0").allowed).toBe(true);
	});

	it("prefers expired entries over live ones when the cap is hit", () => {
		vi.useFakeTimers();
		try {
			const rl = new UsernameRateLimiter(5, 60_000, 3);
			rl.recordFailure("u0"); // resetAt = t + 60_000
			rl.recordFailure("u1"); // resetAt = t + 60_000
			vi.advanceTimersByTime(59_000);
			rl.recordFailure("u2"); // resetAt = t + 119_000 (latest)
			vi.advanceTimersByTime(2_000); // u0/u1 expired; u2 still live

			rl.recordFailure("u3"); // overflow → evictExpired removes u0/u1
			// u2 survives because it hadn't expired; u3 is the new slot.
			expect(rl.sizeForTesting()).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("resetting an expired entry at full capacity doesn't evict a live entry", () => {
		// Regression guard for the eviction path the reviewer called out:
		// map is at capacity, `alice`'s entry has just expired. Re-tracking
		// `alice` should NOT FIFO-evict one of the live entries — alice's
		// stale slot is the one that frees up space.
		vi.useFakeTimers();
		try {
			const rl = new UsernameRateLimiter(5, 60_000, 3);
			rl.recordFailure("alice"); // t=0, resetAt=60_000
			rl.recordFailure("bob"); // t=0, resetAt=60_000
			rl.recordFailure("carol"); // t=0, resetAt=60_000
			expect(rl.sizeForTesting()).toBe(3);

			// Expire alice alone.
			vi.setSystemTime(30_000);
			// Refresh bob and carol so they stay live past alice's resetAt.
			rl.recordFailure("bob"); // live, count=2
			rl.recordFailure("carol"); // live, count=2
			vi.setSystemTime(60_001); // alice expired; bob/carol still live

			rl.recordFailure("alice"); // should reclaim alice's slot, not evict bob/carol

			// Three entries total, bob and carol both intact with their count=2.
			expect(rl.sizeForTesting()).toBe(3);
			rl.recordFailure("bob");
			// bob's count went 2→3 (live), not 1→2 (would indicate it was evicted
			// and re-added). At max=5 still allowed, so check passes.
			expect(rl.check("bob").allowed).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("beginAttempt honours maxTracked: new usernames refused once cap is full", () => {
		// The attempts map is already FIFO-capped in recordFailure, but
		// before this fix beginAttempt could still grow the inflight map
		// without bound — a flood of unique usernames (each within its own
		// per-IP limit) would insert an inflight entry for every first
		// attempt. This test pins that beginAttempt now refuses to add a
		// brand-new username to inflight once the tracked-username cap is
		// full, while already-tracked users remain allowed (they don't
		// grow the unique-key set).
		const rl = new UsernameRateLimiter(5, 60_000, 3);
		rl.recordFailure("u0");
		rl.recordFailure("u1");
		rl.recordFailure("u2");
		expect(rl.sizeForTesting()).toBe(3);

		// Brand-new username, cap is full — refused with 1s retry advisory
		// (the minimum reflecting a single-bcrypt time to free up a slot).
		const fresh = rl.beginAttempt("u3");
		expect(fresh.allowed).toBe(false);
		if (!fresh.allowed) expect(fresh.retryAfterSeconds).toBe(1);

		// Already-tracked username at cap — allowed. Re-entrant attempts
		// for an existing key don't grow the unique-key set, so they
		// shouldn't be penalised by the tracked-username bound.
		expect(rl.beginAttempt("u0").allowed).toBe(true);
		rl.endAttempt("u0");
	});

	it("beginAttempt honours maxTracked even when attempts is empty but inflight is full", () => {
		// Regression for the second-round review gap: the previous fix
		// checked only `attempts.size >= maxTracked`, which missed the
		// case where attempts had expired (or been cleared by successful
		// logins) while inflight still held long-running bcrypts. Brand-
		// new usernames would then keep slipping past the guard and the
		// inflight map would grow without bound.
		const rl = new UsernameRateLimiter(5, 60_000, 3);

		// Fill inflight with 3 distinct usernames, no recorded failures.
		// attempts.size === 0, inflight.size === 3.
		expect(rl.beginAttempt("u0").allowed).toBe(true);
		expect(rl.beginAttempt("u1").allowed).toBe(true);
		expect(rl.beginAttempt("u2").allowed).toBe(true);
		expect(rl.sizeForTesting()).toBe(0); // attempts untouched

		// Brand-new username with inflight at the cap — must be refused.
		// The old single-map check (attempts.size >= maxTracked) would
		// have erroneously allowed this.
		const fresh = rl.beginAttempt("u3");
		expect(fresh.allowed).toBe(false);
		if (!fresh.allowed) expect(fresh.retryAfterSeconds).toBe(1);

		// Releasing one inflight slot frees a unique-key slot — next
		// brand-new username is allowed again.
		rl.endAttempt("u0");
		expect(rl.beginAttempt("u3").allowed).toBe(true);
		rl.endAttempt("u3");
		rl.endAttempt("u1");
		rl.endAttempt("u2");
	});

	it("beginAttempt cap uses sum of attempts + inflight (conservative bound)", () => {
		// The bound computes `attempts.size + inflight.size >= maxTracked`
		// rather than the true union. That's a deliberate over-count to
		// avoid an O(min(|a|,|b|)) per-call scan on the login hot path —
		// documented as "refuse slightly early, never late" in the source.
		// This test pins the over-count behaviour so a future refactor
		// that switches to exact-union semantics is a conscious choice,
		// not an accident.
		const rl = new UsernameRateLimiter(5, 60_000, 3);
		rl.recordFailure("alice"); // attempts={alice}, inflight={}

		// alice is in attempts; beginAttempt("alice") is re-entrant so
		// !attempts.has and !inflight.has are both false → cap check is
		// skipped and the reservation succeeds.
		expect(rl.beginAttempt("alice").allowed).toBe(true);
		// Now attempts={alice}, inflight={alice}. Sum = 2, but true union
		// is 1. Adding bob (brand new) takes sum to 3 = maxTracked, so
		// the next brand-new username is refused even though the true
		// union (alice, bob) would only be 2. Correct: conservative.
		rl.recordFailure("bob");
		const refused = rl.beginAttempt("charlie");
		expect(refused.allowed).toBe(false);
	});

	it("re-tracking an expired entry moves it to the end of FIFO order", () => {
		// After `alice` expires and is re-tracked, she should be the YOUNGEST
		// entry (evicted last), not frozen in her original position.
		vi.useFakeTimers();
		try {
			const rl = new UsernameRateLimiter(5, 60_000, 3);
			rl.recordFailure("alice"); // inserted first
			rl.recordFailure("bob");
			rl.recordFailure("carol");
			vi.advanceTimersByTime(60_001); // everyone expired

			rl.recordFailure("alice"); // fresh bucket — should land at end
			rl.recordFailure("dave"); // new — triggers overflow logic
			rl.recordFailure("eve");

			// Size is capped at 3; bob and carol should have been evicted
			// before alice (she was re-inserted at the end after expiry).
			expect(rl.sizeForTesting()).toBe(3);
			expect(rl.check("alice").allowed).toBe(true); // still present
		} finally {
			vi.useRealTimers();
		}
	});
});

// ── Route-level integration tests ──────────────────────────────────────────

describe("auth route rate limiting", () => {
	let server: http.Server | null = null;
	let baseUrl: string;

	beforeEach(() => {
		authStubs.registerUser.mockClear();
		authStubs.loginUser.mockClear();
		authStubs.createInvite.mockClear();
		authStubs.listInvites.mockClear();
		// Default: loginUser fails as bad creds (typed so the handler counts it).
		authStubs.loginUser.mockImplementation(async () => {
			throw new authStubs.InvalidCredentialsError();
		});
		authStubs.registerUser.mockImplementation(async () => ({
			userId: "u1",
			token: "tok",
			isAdmin: false,
		}));
		// Reset requireAdmin to its passthrough default. Individual tests
		// that exercise the admin-gate path override this with a 403
		// implementation; restoring here means a thrown expect inside such
		// a test can't leak the override into the next test.
		authStubs.requireAdmin.mockImplementation((_req: unknown, _res: unknown, next: () => void) => {
			next();
		});
	});

	afterEach(async () => {
		// Capture into a local so the Promise executor has a narrowed,
		// non-nullable reference — TS doesn't carry the `if (server)`
		// narrowing into the async callback below. Same pattern used
		// everywhere else in this file where we touch `server` inside
		// a Promise executor, so the non-null assertions are gone.
		const s = server;
		if (s) {
			await new Promise<void>((resolve) => s.close(() => resolve()));
			server = null;
		}
	});

	async function spinUp(cfg: {
		login: { ipMax: number; ipWindowMs: number; usernameMax: number; usernameWindowMs: number };
		register: { ipMax: number; ipWindowMs: number };
		invitesCreate?: { ipMax: number; ipWindowMs: number };
		invitesList?: { ipMax: number; ipWindowMs: number };
		invitesRevoke?: { ipMax: number; ipWindowMs: number };
		fileUpload?: { ipMax: number; ipWindowMs: number };
		logout?: { ipMax: number; ipWindowMs: number };
		authStatus?: { ipMax: number; ipWindowMs: number };
	}): Promise<void> {
		// Invite + upload + logout + authStatus limiters were added later;
		// default each to a permissive setting so tests that only exercise
		// login/register don't trip them.
		const fullCfg = {
			invitesCreate: { ipMax: 1000, ipWindowMs: 60_000 },
			invitesList: { ipMax: 1000, ipWindowMs: 60_000 },
			invitesRevoke: { ipMax: 1000, ipWindowMs: 60_000 },
			fileUpload: { ipMax: 1000, ipWindowMs: 60_000 },
			logout: { ipMax: 1000, ipWindowMs: 60_000 },
			authStatus: { ipMax: 1000, ipWindowMs: 60_000 },
			...cfg,
		};
		const router = buildRouter(fakeSessions, fakeDocker, fullCfg);
		const app = express();
		app.use(express.json());
		app.use("/api", router);

		const s = http.createServer(app);
		server = s;
		await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
		const { port } = s.address() as AddressInfo;
		baseUrl = `http://127.0.0.1:${port}`;
	}

	async function postLogin(body: { username?: string; password?: string }): Promise<Response> {
		return fetch(`${baseUrl}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}
	async function postRegister(body: { username?: string; password?: string }): Promise<Response> {
		return fetch(`${baseUrl}/api/auth/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("login returns 429 after ipMax from one IP — 4th request is blocked", async () => {
		await spinUp({
			login: { ipMax: 3, ipWindowMs: 60_000, usernameMax: 1_000, usernameWindowMs: 60_000 },
			register: { ipMax: 100, ipWindowMs: 60_000 },
		});

		const r1 = await postLogin({ username: "u1", password: "bad" });
		const r2 = await postLogin({ username: "u2", password: "bad" });
		const r3 = await postLogin({ username: "u3", password: "bad" });
		const r4 = await postLogin({ username: "u4", password: "bad" });

		expect(r1.status).toBe(401);
		expect(r2.status).toBe(401);
		expect(r3.status).toBe(401);
		expect(r4.status).toBe(429);
		expect(r4.headers.get("retry-after")).not.toBeNull();
	});

	it("successful logins don't consume the login IP budget (skipSuccessfulRequests)", async () => {
		// ipMax=2. Three successes shouldn't move the budget; two subsequent
		// failures exhaust it and the third is 429.
		await spinUp({
			login: { ipMax: 2, ipWindowMs: 60_000, usernameMax: 1_000, usernameWindowMs: 60_000 },
			register: { ipMax: 100, ipWindowMs: 60_000 },
		});

		authStubs.loginUser.mockImplementation(async () => ({
			userId: "u1",
			token: "tok",
			isAdmin: false,
		}));
		for (let i = 0; i < 3; i++) {
			const ok = await postLogin({ username: `u${i}`, password: "good" });
			expect(ok.status).toBe(200);
		}

		authStubs.loginUser.mockImplementation(async () => {
			throw new authStubs.InvalidCredentialsError();
		});
		const f1 = await postLogin({ username: "x", password: "bad" });
		const f2 = await postLogin({ username: "y", password: "bad" });
		const f3 = await postLogin({ username: "z", password: "bad" });
		expect(f1.status).toBe(401);
		expect(f2.status).toBe(401);
		expect(f3.status).toBe(429);
		expect(await f3.json()).toMatchObject({ scope: "ip" });
	});

	it("register returns 429 after ipMax attempts with Retry-After set", async () => {
		await spinUp({
			login: { ipMax: 100, ipWindowMs: 60_000, usernameMax: 100, usernameWindowMs: 60_000 },
			register: { ipMax: 2, ipWindowMs: 60_000 },
		});

		const r1 = await postRegister({ username: "a", password: "secret123" });
		const r2 = await postRegister({ username: "b", password: "secret123" });
		const r3 = await postRegister({ username: "c", password: "secret123" });

		expect(r1.status).toBe(201);
		expect(r2.status).toBe(201);
		expect(r3.status).toBe(429);
		expect(r3.headers.get("retry-after")).not.toBeNull();
	});

	it("per-username limit blocks a third bad attempt even when IP limit would allow it", async () => {
		await spinUp({
			login: { ipMax: 100, ipWindowMs: 60_000, usernameMax: 2, usernameWindowMs: 60_000 },
			register: { ipMax: 100, ipWindowMs: 60_000 },
		});

		const r1 = await postLogin({ username: "alice", password: "bad" });
		const r2 = await postLogin({ username: "alice", password: "bad" });
		const r3 = await postLogin({ username: "alice", password: "bad" });

		expect(r1.status).toBe(401);
		expect(r2.status).toBe(401);
		expect(r3.status).toBe(429);
		expect(r3.headers.get("retry-after")).not.toBeNull();

		// loginUser is called exactly twice — bcrypt is skipped on the 3rd.
		expect(authStubs.loginUser).toHaveBeenCalledTimes(2);
	});

	it("a successful login resets the per-username counter", async () => {
		await spinUp({
			login: { ipMax: 100, ipWindowMs: 60_000, usernameMax: 2, usernameWindowMs: 60_000 },
			register: { ipMax: 100, ipWindowMs: 60_000 },
		});

		const r1 = await postLogin({ username: "alice", password: "bad" });
		expect(r1.status).toBe(401);

		authStubs.loginUser.mockImplementationOnce(async () => ({
			userId: "u1",
			token: "tok",
			isAdmin: false,
		}));
		const r2 = await postLogin({ username: "alice", password: "good" });
		expect(r2.status).toBe(200);

		const r3 = await postLogin({ username: "alice", password: "bad" });
		const r4 = await postLogin({ username: "alice", password: "bad" });
		expect(r3.status).toBe(401);
		expect(r4.status).toBe(401);
	});

	it("rejects usernames over 64 chars with 400 before touching the limiter or auth module", async () => {
		await spinUp({
			login: { ipMax: 100, ipWindowMs: 60_000, usernameMax: 2, usernameWindowMs: 60_000 },
			register: { ipMax: 100, ipWindowMs: 60_000 },
		});
		const huge = "a".repeat(65);

		const loginRes = await postLogin({ username: huge, password: "bad" });
		expect(loginRes.status).toBe(400);
		const registerRes = await postRegister({ username: huge, password: "secret123" });
		expect(registerRes.status).toBe(400);

		expect(authStubs.loginUser).not.toHaveBeenCalled();
		expect(authStubs.registerUser).not.toHaveBeenCalled();
	});

	it("infra errors from loginUser don't count toward the per-username lockout", async () => {
		await spinUp({
			login: { ipMax: 100, ipWindowMs: 60_000, usernameMax: 2, usernameWindowMs: 60_000 },
			register: { ipMax: 100, ipWindowMs: 60_000 },
		});
		authStubs.loginUser.mockImplementation(async () => {
			throw new Error("D1 timeout");
		});

		const r1 = await postLogin({ username: "alice", password: "bad" });
		const r2 = await postLogin({ username: "alice", password: "bad" });
		const r3 = await postLogin({ username: "alice", password: "bad" });
		expect(r1.status).toBe(500);
		expect(r2.status).toBe(500);
		expect(r3.status).toBe(500);
	});

	it("429 bodies carry a `scope` field so the UI can tell IP vs username lockout apart", async () => {
		await spinUp({
			login: { ipMax: 1, ipWindowMs: 60_000, usernameMax: 100, usernameWindowMs: 60_000 },
			register: { ipMax: 100, ipWindowMs: 60_000 },
		});
		await postLogin({ username: "u1", password: "bad" });
		const ipBlocked = await postLogin({ username: "u2", password: "bad" });
		expect(ipBlocked.status).toBe(429);
		expect(await ipBlocked.json()).toMatchObject({ scope: "ip" });

		// Same Promise-executor-narrowing dance as afterEach. Invariant
		// violation (server was null here) would be a test bug — throw
		// loudly rather than silently skip, since the block below spins
		// up a new server and we'd otherwise get a misleading failure
		// in a completely different test phase.
		const s = server;
		if (!s) throw new Error("test invariant: server was null at mid-test restart");
		await new Promise<void>((resolve) => s.close(() => resolve()));
		server = null;

		await spinUp({
			login: { ipMax: 100, ipWindowMs: 60_000, usernameMax: 1, usernameWindowMs: 60_000 },
			register: { ipMax: 100, ipWindowMs: 60_000 },
		});
		await postLogin({ username: "alice", password: "bad" });
		const usernameBlocked = await postLogin({ username: "alice", password: "bad" });
		expect(usernameBlocked.status).toBe(429);
		expect(await usernameBlocked.json()).toMatchObject({ scope: "username" });
		// Emits the same draft-7 shape the IP limiter does — clients parsing
		// RateLimit-Policy see a consistent response across both layers.
		expect(usernameBlocked.headers.get("ratelimit-policy")).toMatch(/^\d+;w=\d+$/);
		expect(usernameBlocked.headers.get("ratelimit")).toMatch(/limit=\d+, remaining=0, reset=\d+/);
	});

	it("once per-username max is reached, even the correct password 429s until the window resets", async () => {
		await spinUp({
			login: { ipMax: 100, ipWindowMs: 60_000, usernameMax: 2, usernameWindowMs: 60_000 },
			register: { ipMax: 100, ipWindowMs: 60_000 },
		});

		await postLogin({ username: "alice", password: "bad" });
		await postLogin({ username: "alice", password: "bad" });

		authStubs.loginUser.mockImplementationOnce(async () => ({
			userId: "u1",
			token: "tok",
			isAdmin: false,
		}));
		const locked = await postLogin({ username: "alice", password: "good" });
		expect(locked.status).toBe(429);
	});

	it("GET /invites returns 429 after invitesList.ipMax requests", async () => {
		// Issue #47: GET /invites must be rate-limited symmetrically with
		// POST/DELETE so an unbounded polling client can't hammer D1.
		// If a future refactor drops `invitesListIp` from the route signature
		// this test will surface it as a 200 on the third call.
		await spinUp({
			login: { ipMax: 1000, ipWindowMs: 60_000, usernameMax: 1000, usernameWindowMs: 60_000 },
			register: { ipMax: 1000, ipWindowMs: 60_000 },
			invitesList: { ipMax: 2, ipWindowMs: 60_000 },
		});

		const r1 = await fetch(`${baseUrl}/api/invites`);
		const r2 = await fetch(`${baseUrl}/api/invites`);
		const r3 = await fetch(`${baseUrl}/api/invites`);

		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);
		expect(r3.status).toBe(429);
		expect(await r3.json()).toMatchObject({ scope: "ip" });
		expect(r3.headers.get("retry-after")).not.toBeNull();
	});

	// #50 route-level wiring. The `requireAdmin` middleware unit tests
	// pin the gate's behaviour given a userId; these route-level tests
	// pin that the gate is actually wired in front of every invite
	// handler. A future refactor that swaps middleware order or drops
	// the gate from one of the routes would surface here as a 2xx
	// reaching the corresponding handler stub. The `beforeEach` above
	// restores the passthrough so an override here doesn't leak into
	// later tests if an `expect` throws.
	function denyAdmin() {
		authStubs.requireAdmin.mockImplementation(
			(_req: unknown, res: { status: (n: number) => { json: (b: unknown) => unknown } }) => {
				res.status(403).json({ error: "Admin privileges required" });
			},
		);
	}

	it("POST /invites returns 403 (and never reaches the handler) when requireAdmin denies", async () => {
		await spinUp({
			login: { ipMax: 1000, ipWindowMs: 60_000, usernameMax: 1000, usernameWindowMs: 60_000 },
			register: { ipMax: 1000, ipWindowMs: 60_000 },
		});
		denyAdmin();

		const r = await fetch(`${baseUrl}/api/invites`, { method: "POST" });

		expect(r.status).toBe(403);
		expect(await r.json()).toMatchObject({ error: "Admin privileges required" });
		expect(authStubs.createInvite).not.toHaveBeenCalled();
	});

	it("GET /invites returns 403 when requireAdmin denies", async () => {
		await spinUp({
			login: { ipMax: 1000, ipWindowMs: 60_000, usernameMax: 1000, usernameWindowMs: 60_000 },
			register: { ipMax: 1000, ipWindowMs: 60_000 },
		});
		denyAdmin();

		const r = await fetch(`${baseUrl}/api/invites`);

		expect(r.status).toBe(403);
		expect(await r.json()).toMatchObject({ error: "Admin privileges required" });
		expect(authStubs.listInvites).not.toHaveBeenCalled();
	});

	it("DELETE /invites/:hash returns 403 when requireAdmin denies", async () => {
		await spinUp({
			login: { ipMax: 1000, ipWindowMs: 60_000, usernameMax: 1000, usernameWindowMs: 60_000 },
			register: { ipMax: 1000, ipWindowMs: 60_000 },
		});
		denyAdmin();

		// Valid hash shape so the request makes it past the route's
		// regex guard — we want the gate's 403, not a 400 from input
		// validation, to be the response.
		const hash = "a".repeat(64);
		const r = await fetch(`${baseUrl}/api/invites/${hash}`, { method: "DELETE" });

		expect(r.status).toBe(403);
		expect(await r.json()).toMatchObject({ error: "Admin privileges required" });
	});

	// Regression test for #148. /auth/status is public-by-design (the
	// frontend uses it on first load to decide between login and app),
	// but every call hits D1 — without an IP limiter an attacker can
	// amplify D1 cost / push the account toward Cloudflare's per-database
	// query throttle.
	it("GET /auth/status returns 429 after authStatus.ipMax from one IP", async () => {
		await spinUp({
			login: { ipMax: 1000, ipWindowMs: 60_000, usernameMax: 1000, usernameWindowMs: 60_000 },
			register: { ipMax: 1000, ipWindowMs: 60_000 },
			authStatus: { ipMax: 3, ipWindowMs: 60_000 },
		});

		const r1 = await fetch(`${baseUrl}/api/auth/status`);
		const r2 = await fetch(`${baseUrl}/api/auth/status`);
		const r3 = await fetch(`${baseUrl}/api/auth/status`);
		const r4 = await fetch(`${baseUrl}/api/auth/status`);

		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);
		expect(r3.status).toBe(200);
		expect(r4.status).toBe(429);
		expect(r4.headers.get("retry-after")).not.toBeNull();
		expect(await r4.json()).toMatchObject({ scope: "ip" });
	});
});
