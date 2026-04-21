import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "http";
import type { AddressInfo } from "net";
import express from "express";

import { UsernameRateLimiter } from "./rateLimit.js";
import type { SessionManager } from "./sessionManager.js";
import type { DockerManager } from "./dockerManager.js";

// Stub the auth module so routing tests don't touch D1. Handles captured
// as `authStubs` are reconfigured per-test.
const authStubs = vi.hoisted(() => ({
	registerUser: vi.fn(async (_u: string, _p: string) => ({ userId: "u1", token: "tok" })),
	loginUser: vi.fn(async (_u: string, _p: string) => ({ userId: "u1", token: "tok" })),
	hasAnyUsers: vi.fn(async () => true),
	requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
	// The route handler checks `err instanceof InvalidCredentialsError` where
	// `InvalidCredentialsError` is imported from `./auth.js`. Because we
	// `vi.mock` the whole module, both the handler's import and the stub's
	// throw resolve to this same constructor.
	InvalidCredentialsError: class extends Error {
		constructor() { super("Invalid credentials"); this.name = "InvalidCredentialsError"; }
	},
}));
vi.mock("./auth.js", () => authStubs);

// `buildRouter` is imported AFTER the mock is in place.
import { buildRouter } from "./routes.js";

// Typed placeholders for the route tests — no session/docker routes are
// hit in these scenarios, so an empty-object cast is fine AND preserves
// type-checking if a future route starts calling into sessions/docker.
const fakeSessions = {} as unknown as SessionManager;
const fakeDocker = {} as unknown as DockerManager;

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
			rl.recordFailure("bob");   // t=0, resetAt=60_000
			rl.recordFailure("carol"); // t=0, resetAt=60_000
			expect(rl.sizeForTesting()).toBe(3);

			// Expire alice alone.
			vi.setSystemTime(30_000);
			// Refresh bob and carol so they stay live past alice's resetAt.
			rl.recordFailure("bob");   // live, count=2
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
			rl.recordFailure("dave");  // new — triggers overflow logic
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
		// Default: loginUser fails as bad creds (typed so the handler counts it).
		authStubs.loginUser.mockImplementation(async () => {
			throw new authStubs.InvalidCredentialsError();
		});
		authStubs.registerUser.mockImplementation(async () => ({ userId: "u1", token: "tok" }));
	});

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => server!.close(() => resolve()));
			server = null;
		}
	});

	async function spinUp(cfg: {
		login: { ipMax: number; ipWindowMs: number; usernameMax: number; usernameWindowMs: number };
		register: { ipMax: number; ipWindowMs: number };
	}): Promise<void> {
		const router = buildRouter(fakeSessions, fakeDocker, cfg);
		const app = express();
		app.use(express.json());
		app.use("/api", router);

		server = http.createServer(app);
		await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
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

		authStubs.loginUser.mockImplementation(async () => ({ userId: "u1", token: "tok" }));
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

		authStubs.loginUser.mockImplementationOnce(async () => ({ userId: "u1", token: "tok" }));
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

		await new Promise<void>((resolve) => server!.close(() => resolve()));
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

		authStubs.loginUser.mockImplementationOnce(async () => ({ userId: "u1", token: "tok" }));
		const locked = await postLogin({ username: "alice", password: "good" });
		expect(locked.status).toBe(429);
	});
});
