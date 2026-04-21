/**
 * rateLimit.ts — Rate limiters for the public /auth routes.
 *
 * Two layers defend against credential brute-force:
 *  1. Per-IP, via `express-rate-limit` (middleware). Stops a single machine
 *     from hammering the endpoint.
 *  2. Per-username, via the in-process `UsernameRateLimiter` below. Counts
 *     FAILED logins only and resets on success, so a botnet distributing
 *     guesses across many IPs can still be throttled on a single account.
 *
 * Both are in-memory — fine for the single-node deployment described in
 * CLAUDE.md. If this ever scales horizontally, swap the store for Redis.
 */

import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";

// ── Config ──────────────────────────────────────────────────────────────────

export interface RateLimitConfig {
	login: {
		ipMax: number;
		ipWindowMs: number;
		usernameMax: number;
		usernameWindowMs: number;
	};
	register: {
		ipMax: number;
		ipWindowMs: number;
	};
}

// Defaults match issue #10: login 10/15min, register 5/1h, per-username 10/15min.
export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
	login: {
		ipMax: 10,
		ipWindowMs: 15 * 60 * 1000,
		usernameMax: 10,
		usernameWindowMs: 15 * 60 * 1000,
	},
	register: {
		ipMax: 5,
		ipWindowMs: 60 * 60 * 1000,
	},
};

// ── IP-based limiters (express-rate-limit) ─────────────────────────────────

export interface AuthRateLimiters {
	loginIp: RateLimitRequestHandler;
	registerIp: RateLimitRequestHandler;
}

export function createAuthRateLimiters(cfg: RateLimitConfig): AuthRateLimiters {
	// standardHeaders: draft-7 sends RateLimit-* and Retry-After on 429.
	// legacyHeaders: false suppresses the older X-RateLimit-* variants.
	// Response body is explicit JSON so the frontend can read `error` like
	// every other 4xx on this surface.
	const loginIp = rateLimit({
		windowMs: cfg.login.ipWindowMs,
		limit: cfg.login.ipMax,
		standardHeaders: "draft-7",
		legacyHeaders: false,
		message: { error: "Too many login attempts from this IP, try again later" },
	});
	const registerIp = rateLimit({
		windowMs: cfg.register.ipWindowMs,
		limit: cfg.register.ipMax,
		standardHeaders: "draft-7",
		legacyHeaders: false,
		message: { error: "Too many registration attempts from this IP, try again later" },
	});
	return { loginIp, registerIp };
}

// ── Per-username limiter ────────────────────────────────────────────────────

export class RateLimitError extends Error {
	readonly retryAfterSeconds: number;
	constructor(retryAfterSeconds: number) {
		super("Too many failed attempts for this username, try again later");
		this.name = "RateLimitError";
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

interface FailedAttempts {
	count: number;
	resetAt: number;
}

// Hard cap on how many distinct usernames we'll track at once. Without this,
// a caller hitting /auth/login with a large pool of unique usernames could
// force the map to grow unbounded for the full window — a real DoS vector on
// a public endpoint. JS Map preserves insertion order, so evicting the
// oldest entry when we overflow (FIFO) is cheap: `map.keys().next().value`.
// LRU would be nicer but needs re-insertion on each access; FIFO is enough
// for DoS defence — under steady attack the oldest buckets are the ones
// most likely to have already expired anyway.
const DEFAULT_MAX_TRACKED_USERNAMES = 10_000;

/**
 * Tracks failed logins per username, with a sliding-ish window: the counter
 * resets the first time it's consulted past `resetAt`. Successful logins call
 * `reset()` so legitimate users aren't locked out after one typo.
 *
 * NOTE on case sensitivity: usernames are stored verbatim in D1 and looked
 * up with `WHERE username = ?` (case-sensitive collation), so "Alice" and
 * "alice" are distinct accounts. This limiter keys on the same literal
 * string and therefore locks the same identity the auth module authenticates.
 * If username normalization is ever introduced in `auth.ts`, this class must
 * apply the same normalization or the two layers will diverge.
 */
export class UsernameRateLimiter {
	private attempts = new Map<string, FailedAttempts>();
	private readonly maxTracked: number;

	constructor(
		private readonly max: number,
		private readonly windowMs: number,
		maxTracked: number = DEFAULT_MAX_TRACKED_USERNAMES,
	) {
		this.maxTracked = maxTracked;
	}

	/**
	 * Throws `RateLimitError` when the username has already hit the max within
	 * the current window. Call before attempting verification.
	 */
	assertAllowed(username: string): void {
		const now = Date.now();
		const entry = this.attempts.get(username);
		if (!entry) return;
		if (now >= entry.resetAt) {
			this.attempts.delete(username);
			return;
		}
		if (entry.count >= this.max) {
			const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
			throw new RateLimitError(retryAfterSeconds);
		}
	}

	/** Bump the counter for this username. Call after a failed verification. */
	recordFailure(username: string): void {
		const now = Date.now();
		const entry = this.attempts.get(username);
		if (!entry || now >= entry.resetAt) {
			// Opportunistic GC: if we're about to insert and the map is full,
			// first drop any entries whose windows have already expired. Cheap
			// O(n) sweep but amortizes across many requests.
			if (this.attempts.size >= this.maxTracked) this.evictExpired(now);
			// Still full? Evict the oldest (FIFO) to make room for the new
			// tracker. The attacker keeps winning the race, but we stay within
			// the memory budget.
			if (this.attempts.size >= this.maxTracked) {
				const oldestKey = this.attempts.keys().next().value;
				if (oldestKey !== undefined) this.attempts.delete(oldestKey);
			}
			this.attempts.set(username, { count: 1, resetAt: now + this.windowMs });
			return;
		}
		entry.count++;
	}

	/** Forget any prior failures for this username (called after a successful login). */
	reset(username: string): void {
		this.attempts.delete(username);
	}

	/** Test helper: wipe all state. */
	clear(): void {
		this.attempts.clear();
	}

	/** Test helper: current map size, for the eviction tests. */
	size(): number {
		return this.attempts.size;
	}

	private evictExpired(now: number): void {
		for (const [key, entry] of this.attempts) {
			if (now >= entry.resetAt) this.attempts.delete(key);
		}
	}
}
