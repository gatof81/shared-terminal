// rateLimit.ts — per-IP and per-username limiters for the /auth routes.

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
	// draft-7 gives us RateLimit-* and Retry-After; legacyHeaders off.
	// `scope` lets the frontend tell an IP block apart from a per-account
	// lockout and surface a useful message.
	const loginIp = rateLimit({
		windowMs: cfg.login.ipWindowMs,
		limit: cfg.login.ipMax,
		standardHeaders: "draft-7",
		legacyHeaders: false,
		message: { error: "Too many login attempts from this IP, try again later", scope: "ip" },
	});
	const registerIp = rateLimit({
		windowMs: cfg.register.ipWindowMs,
		limit: cfg.register.ipMax,
		standardHeaders: "draft-7",
		legacyHeaders: false,
		message: { error: "Too many registration attempts from this IP, try again later", scope: "ip" },
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

// Cap distinct tracked usernames so a flood of unique keys can't grow the
// map unbounded. FIFO eviction (Map preserves insertion order).
const DEFAULT_MAX_TRACKED_USERNAMES = 10_000;

// Keyed on the literal username string because auth.ts looks up D1 with the
// same literal (case-sensitive). If auth.ts ever normalizes, this class must
// mirror the normalization or the two layers diverge.
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
			// On overflow: sweep expired entries first, then FIFO-evict.
			if (this.attempts.size >= this.maxTracked) this.evictExpired(now);
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

	/** @internal Test helper: wipe all state. */
	clear(): void {
		this.attempts.clear();
	}

	/** @internal Test helper: current map size, for the eviction tests. */
	size(): number {
		return this.attempts.size;
	}

	private evictExpired(now: number): void {
		for (const [key, entry] of this.attempts) {
			if (now >= entry.resetAt) this.attempts.delete(key);
		}
	}
}
