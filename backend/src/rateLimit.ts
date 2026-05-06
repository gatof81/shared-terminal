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
	// Caps how often a single IP can mint invite codes. The atomic per-user
	// quota (20 outstanding) bounds the steady-state surface, but a stolen
	// JWT could otherwise burst all 20 mints in milliseconds before anyone
	// notices. Slower than registerIp because legitimate use is "invite a
	// few friends, then idle for weeks".
	invitesCreate: {
		ipMax: number;
		ipWindowMs: number;
	};
	// Caps how often a single IP can list invites. Kept separate from
	// invitesCreate because reads are cheap (one D1 SELECT, capped at
	// INVITE_LIST_LIMIT = 100 rows the caller already owns) and the UI
	// may legitimately poll the modal — pinning it to the mint rate
	// would 429 on every other refresh. Mostly here for symmetry with
	// the other invite endpoints (issue #47): the asymmetry of "POST
	// and DELETE rate-limited, GET wide open" reads as accidental.
	// Also bounds runaway client behaviour and D1 read load if a
	// logged-in client tab gets stuck in a tight refresh loop.
	invitesList: {
		ipMax: number;
		ipWindowMs: number;
	};
	// Caps how often a single IP can revoke invites. Kept separate from
	// invitesCreate because:
	//   1. Revoke is a cleanup action the legitimate user may need to do in
	//      bursts (e.g. panic-rotate after suspecting JWT theft, or bulk-
	//      clean stale codes). Pinning it to the mint rate would starve the
	//      legitimate use case.
	//   2. A combined budget means an attacker who exhausted the mint quota
	//      could also prevent the victim from revoking their pre-minted
	//      codes — revoke is precisely the action we want available during
	//      an incident.
	// Separate budget, more generous window, distinct 429 message.
	invitesRevoke: {
		ipMax: number;
		ipWindowMs: number;
	};
	// Caps how often a single IP can POST file uploads. Each request can
	// carry up to 8 × 25 MB = 200 MB; without a limiter a valid JWT could
	// loop the route and fill the host disk (workspace files survive
	// soft-delete). Sized for the legitimate "drop a few screenshots in a
	// row" pattern — well above human cadence, well below sustained
	// abuse rates.
	fileUpload: {
		ipMax: number;
		ipWindowMs: number;
	};
}

// Defaults match issue #10: login 10/15min, register 5/1h, per-username 10/15min.
// Invites: create 10/h, list 120/h, revoke 60/h. List is cheapest (a single
// SELECT, capped at INVITE_LIST_LIMIT = 100 owned rows) so it has the most
// generous default — 120/h ≈ 2/min sustained, plenty for a UI that
// polls when the modal is open. Revoke is 6x mint to cover incident-response
// bursts (panic-rotate after suspecting JWT theft).
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
	invitesCreate: {
		ipMax: 10,
		ipWindowMs: 60 * 60 * 1000,
	},
	invitesList: {
		ipMax: 120,
		ipWindowMs: 60 * 60 * 1000,
	},
	invitesRevoke: {
		ipMax: 60,
		ipWindowMs: 60 * 60 * 1000,
	},
	fileUpload: {
		ipMax: 30,
		ipWindowMs: 5 * 60 * 1000,
	},
};

// ── IP-based limiters (express-rate-limit) ─────────────────────────────────

export interface AuthRateLimiters {
	loginIp: RateLimitRequestHandler;
	registerIp: RateLimitRequestHandler;
	invitesCreateIp: RateLimitRequestHandler;
	invitesListIp: RateLimitRequestHandler;
	invitesRevokeIp: RateLimitRequestHandler;
	fileUploadIp: RateLimitRequestHandler;
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
		// Only failed logins count toward the IP budget. Brings the IP layer
		// in line with the per-username layer (which also only counts failures)
		// and means a legitimate user re-logging in ten times in 15 min
		// doesn't self-block. Attackers burn the budget on failures anyway.
		skipSuccessfulRequests: true,
		message: { error: "Too many login attempts from this IP, try again later", scope: "ip" },
	});
	const registerIp = rateLimit({
		windowMs: cfg.register.ipWindowMs,
		limit: cfg.register.ipMax,
		standardHeaders: "draft-7",
		legacyHeaders: false,
		message: { error: "Too many registration attempts from this IP, try again later", scope: "ip" },
	});
	const invitesCreateIp = rateLimit({
		windowMs: cfg.invitesCreate.ipWindowMs,
		limit: cfg.invitesCreate.ipMax,
		standardHeaders: "draft-7",
		legacyHeaders: false,
		message: { error: "Too many invite-mint requests from this IP, try again later", scope: "ip" },
	});
	const invitesListIp = rateLimit({
		windowMs: cfg.invitesList.ipWindowMs,
		limit: cfg.invitesList.ipMax,
		standardHeaders: "draft-7",
		legacyHeaders: false,
		// Distinct 429 message so a 429 on the list endpoint isn't mis-
		// attributed to the mint or revoke endpoint when troubleshooting.
		message: { error: "Too many invite-list requests from this IP, try again later", scope: "ip" },
	});
	const invitesRevokeIp = rateLimit({
		windowMs: cfg.invitesRevoke.ipWindowMs,
		limit: cfg.invitesRevoke.ipMax,
		standardHeaders: "draft-7",
		legacyHeaders: false,
		message: { error: "Too many invite-revoke requests from this IP, try again later", scope: "ip" },
	});
	const fileUploadIp = rateLimit({
		windowMs: cfg.fileUpload.ipWindowMs,
		limit: cfg.fileUpload.ipMax,
		standardHeaders: "draft-7",
		legacyHeaders: false,
		message: { error: "Too many file uploads from this IP, try again later", scope: "ip" },
	});
	return { loginIp, registerIp, invitesCreateIp, invitesListIp, invitesRevokeIp, fileUploadIp };
}

// ── Per-username limiter ────────────────────────────────────────────────────

export type UsernameCheckResult =
	| { allowed: true }
	| { allowed: false; retryAfterSeconds: number };

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
	// In-flight attempts (currently waiting on bcrypt or a D1 round-trip).
	// Tracked separately from the window-bounded `attempts` map because
	// in-flight slots are transient: they're released when the attempt
	// finishes, regardless of the window. Counted against the same `max`
	// budget so a burst of concurrent attempts can't slip past check()
	// between the gate and the first recordFailure.
	//
	// Kept as a plain Map so eviction semantics stay simple — cleared
	// per-username in endAttempt(), no TTL needed (if the process crashes
	// with slots reserved, the restart clears everything anyway).
	private inflight = new Map<string, number>();
	private readonly maxTracked: number;

	constructor(
		private readonly max: number,
		private readonly windowMs: number,
		maxTracked: number = DEFAULT_MAX_TRACKED_USERNAMES,
	) {
		this.maxTracked = maxTracked;
	}

	// Returns allowed=false only when the bucket is full inside its window.
	// Result-based (never throws) so callers don't need try/catch around an
	// otherwise-synchronous check inside an async handler.
	//
	// Does not reserve an in-flight slot — callers doing async verification
	// (bcrypt, D1) should use beginAttempt/endAttempt instead so the bound
	// holds across awaits.
	//
	// NOT pure: if the queried username's entry is present but past its
	// resetAt, it's deleted here. This is not just opportunistic GC —
	// beginAttempt calls check() first and then probes
	// `!this.attempts.has(username)` for the maxTracked bound. When check
	// deletes an expired entry, that `.has` flips to false in the same
	// call and beginAttempt treats the user as brand-new for the tracked-
	// username cap. That's the correct semantics (an expired window SHOULD
	// free the cap slot) but the interaction is subtle enough that a
	// reader glancing at check() could miss it — flagging it here so a
	// future refactor that moves the delete out of check() remembers to
	// adjust beginAttempt's cap accounting in lockstep.
	check(username: string): UsernameCheckResult {
		const now = Date.now();
		const entry = this.attempts.get(username);
		const failed = entry && now < entry.resetAt ? entry.count : 0;
		const inflight = this.inflight.get(username) ?? 0;
		if (entry && now >= entry.resetAt) {
			this.attempts.delete(username);
		}
		if (failed + inflight >= this.max) {
			// Re-fetch after the possible delete above; entry may be gone, in
			// which case all `max` slots are held by in-flight attempts and the
			// soonest possible release is on the order of a single bcrypt —
			// report 1 second as the minimum advisory.
			const resetAt = entry && now < entry.resetAt ? entry.resetAt : now + 1000;
			return {
				allowed: false,
				retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
			};
		}
		return { allowed: true };
	}

	// Atomically check AND reserve one in-flight slot for an async
	// verification. Callers MUST pair every allowed beginAttempt with an
	// endAttempt (use try/finally) or the slot leaks until process restart.
	//
	// Existed as a single method so there's no window between "check passed"
	// and "slot reserved" where a parallel request could observe the same
	// pre-reservation state and also pass.
	beginAttempt(username: string): UsernameCheckResult {
		const result = this.check(username);
		if (!result.allowed) return result;

		// Memory bound on the combined state of attempts + inflight. The
		// previous version checked only `attempts.size >= maxTracked`,
		// which missed the case where all attempts entries had expired (or
		// been cleared by successful logins) while inflight still held
		// many long-running bcrypts — brand-new usernames would keep
		// passing the guard and accumulating inflight entries past the
		// cap.
		//
		// We want to bound the union of the two keysets at maxTracked,
		// but computing the union exactly is O(min(|a|,|b|)) on every
		// call — too much for the login hot path. Use the SUM instead as
		// a conservative upper bound: it over-counts any username present
		// in BOTH maps (a user who has a recorded failure AND is currently
		// holding an inflight slot), which means we start refusing brand-
		// new usernames slightly earlier than strictly necessary. That's
		// the correct direction to err in — the worst case is refusing a
		// legitimate username at ~half capacity, with a 1-second retry
		// advisory, which a human retry will clear.
		//
		// `!has` guards on both maps remain: re-entrant attempts from an
		// already-tracked user don't grow the unique-key set, so they
		// shouldn't be blocked by the cap. Refusal carries a 1s retry
		// (matches the "all max slots held by in-flight" branch in
		// check() — one bcrypt is the soonest a slot could free up).
		if (
			!this.attempts.has(username) &&
			!this.inflight.has(username) &&
			this.attempts.size + this.inflight.size >= this.maxTracked
		) {
			return { allowed: false, retryAfterSeconds: 1 };
		}

		const current = this.inflight.get(username) ?? 0;
		this.inflight.set(username, current + 1);
		return { allowed: true };
	}

	// Release a slot reserved by beginAttempt. Safe to call multiple times
	// against an empty slot (no-op), which keeps try/finally cleanup simple
	// even if the caller accidentally double-releases on an error path.
	endAttempt(username: string): void {
		const current = this.inflight.get(username) ?? 0;
		if (current <= 1) this.inflight.delete(username);
		else this.inflight.set(username, current - 1);
	}

	// Bump the counter for this username. Call after a failed verification.
	recordFailure(username: string): void {
		const now = Date.now();
		const existing = this.attempts.get(username);
		if (existing && now < existing.resetAt) {
			existing.count++;
			return;
		}
		// Either a genuinely new key or an expired entry being reset. Remove
		// the stale slot first so the fresh bucket re-enters at the END of
		// Map insertion order — otherwise an expired entry would be resurrected
		// in its old (early) FIFO position and evicted prematurely on the
		// next overflow.
		if (existing) this.attempts.delete(username);
		if (this.attempts.size >= this.maxTracked) {
			this.evictExpired(now);
			if (this.attempts.size >= this.maxTracked) {
				const oldestKey = this.attempts.keys().next().value;
				if (oldestKey !== undefined) this.attempts.delete(oldestKey);
			}
		}
		this.attempts.set(username, { count: 1, resetAt: now + this.windowMs });
	}

	// Forget any prior failures for this username (call after a successful login).
	reset(username: string): void {
		this.attempts.delete(username);
	}

	// TEST-ONLY: exposed so eviction/size tests can observe internal state.
	// Do not call from production code.
	sizeForTesting(): number {
		return this.attempts.size;
	}
	clearForTesting(): void {
		this.attempts.clear();
	}

	// Map iteration is spec'd to tolerate in-loop deletes of already-visited
	// or current keys (ECMA-262 §24.1.3.5), so this pattern is safe.
	private evictExpired(now: number): void {
		for (const [key, entry] of this.attempts) {
			if (now >= entry.resetAt) this.attempts.delete(key);
		}
	}
}
