import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "http";
import type { AddressInfo } from "net";
import express from "express";

import { UsernameRateLimiter, RateLimitError } from "./rateLimit.js";

// `routes.ts` calls registerUser / loginUser / hasAnyUsers from `./auth.js`,
// which talk to D1. Stub the whole module so routing tests don't need a real
// database. Stubs are configured per-test via the handles captured below.
const authStubs = vi.hoisted(() => ({
	registerUser: vi.fn(async (_u: string, _p: string) => ({ userId: "u1", token: "tok" })),
	loginUser: vi.fn(async (_u: string, _p: string) => ({ userId: "u1", token: "tok" })),
	hasAnyUsers: vi.fn(async () => true),
	requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("./auth.js", () => authStubs);

// `buildRouter` is imported AFTER the mock is in place.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import { buildRouter } from "./routes.js";

// ── UsernameRateLimiter unit tests ─────────────────────────────────────────

describe("UsernameRateLimiter", () => {
	it("allows attempts up to the configured max", () => {
		const rl = new UsernameRateLimiter(3, 60_000);
		// 3 allowed assertAllowed calls, each followed by a recorded failure.
		for (let i = 0; i < 3; i++) {
			expect(() => rl.assertAllowed("alice")).not.toThrow();
			rl.recordFailure("alice");
		}
	});

	it("throws RateLimitError with retryAfterSeconds on the (max+1)th attempt", () => {
		const rl = new UsernameRateLimiter(2, 60_000);
		rl.recordFailure("alice");
		rl.recordFailure("alice");
		let thrown: unknown;
		try {
			rl.assertAllowed("alice");
		} catch (err) { thrown = err; }
		expect(thrown).toBeInstanceOf(RateLimitError);
		const rle = thrown as RateLimitError;
		// 60_000ms window → between 1 and 60 seconds remaining.
		expect(rle.retryAfterSeconds).toBeGreaterThan(0);
		expect(rle.retryAfterSeconds).toBeLessThanOrEqual(60);
	});

	it("isolates buckets per username", () => {
		const rl = new UsernameRateLimiter(1, 60_000);
		rl.recordFailure("alice");
		expect(() => rl.assertAllowed("alice")).toThrow(RateLimitError);
		// bob is untouched
		expect(() => rl.assertAllowed("bob")).not.toThrow();
	});

	it("resets the window automatically after windowMs elapses", () => {
		vi.useFakeTimers();
		try {
			const rl = new UsernameRateLimiter(1, 60_000);
			rl.recordFailure("alice");
			expect(() => rl.assertAllowed("alice")).toThrow(RateLimitError);
			vi.advanceTimersByTime(60_001);
			expect(() => rl.assertAllowed("alice")).not.toThrow();
		} finally {
			vi.useRealTimers();
		}
	});

	it("reset(username) clears a single bucket, clear() clears all", () => {
		const rl = new UsernameRateLimiter(1, 60_000);
		rl.recordFailure("alice");
		rl.recordFailure("bob");
		rl.reset("alice");
		expect(() => rl.assertAllowed("alice")).not.toThrow();
		expect(() => rl.assertAllowed("bob")).toThrow(RateLimitError);

		rl.clear();
		expect(() => rl.assertAllowed("bob")).not.toThrow();
	});

	it("recordFailure past the window starts a fresh counter", () => {
		vi.useFakeTimers();
		try {
			const rl = new UsernameRateLimiter(2, 60_000);
			rl.recordFailure("alice");
			rl.recordFailure("alice");
			// At max. Advance past the window then record again — should be a
			// fresh bucket at count=1, so we're below the limit again.
			vi.advanceTimersByTime(60_001);
			rl.recordFailure("alice");
			expect(() => rl.assertAllowed("alice")).not.toThrow();
		} finally {
			vi.useRealTimers();
		}
	});
});

// ── Route-level integration tests ──────────────────────────────────────────
//
// Fire real HTTP requests at an ephemeral server so we're exercising the
// express-rate-limit middleware as it'll run in prod — headers, 429 status,
// Retry-After, the works. The auth module is stubbed so nothing touches D1.

describe("auth route rate limiting", () => {
	let server: http.Server | null = null;
	let baseUrl: string;

	// Default stub behaviour reset before each test; tight per-test limits
	// set via spinUp() so individual tests can raise the IP ceiling when
	// they only care about the per-username path.
	beforeEach(() => {
		authStubs.registerUser.mockClear();
		authStubs.loginUser.mockClear();
		authStubs.loginUser.mockImplementation(async () => {
			throw new Error("Invalid credentials");
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
		const router = buildRouter({} as never, {} as never, cfg);
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
		// ipMax=3, usernameMax ridiculously high so only the IP limit can fire.
		// Distinct usernames per call so the per-username bucket is irrelevant.
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
		// usernameMax=2 exhausts alice after two failures. ipMax high so the
		// 429 on the 3rd request has to come from the username limiter, not
		// express-rate-limit.
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

		// 429 came via our handler (before bcrypt), so loginUser was called
		// twice, not three times — the expensive hash never ran on the 3rd.
		expect(authStubs.loginUser).toHaveBeenCalledTimes(2);
	});

	it("a successful login resets the per-username counter", async () => {
		// usernameMax=2, ipMax high. The key sequence:
		//   fail → success (reset) → fail → fail
		// All four login attempts should be handled normally (401/200/401/401).
		// Without the reset-on-success, the fourth call would hit assertAllowed
		// with count=2 already and return 429 — so 401 on r4 is the load-
		// bearing assertion here.
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

	it("once per-username max is reached, even the correct password 429s until the window resets", async () => {
		// Strict lockout: we assertAllowed BEFORE verifying the password, so a
		// blocked account stays blocked for the rest of the window. Trade-off
		// is worth it — the alternative runs bcrypt on every guess and leaks
		// timing info.
		await spinUp({
			login: { ipMax: 100, ipWindowMs: 60_000, usernameMax: 2, usernameWindowMs: 60_000 },
			register: { ipMax: 100, ipWindowMs: 60_000 },
		});

		await postLogin({ username: "alice", password: "bad" });
		await postLogin({ username: "alice", password: "bad" });

		// Even a "correct" password now 429s — bucket is at max.
		authStubs.loginUser.mockImplementationOnce(async () => ({ userId: "u1", token: "tok" }));
		const locked = await postLogin({ username: "alice", password: "good" });
		expect(locked.status).toBe(429);
	});
});
