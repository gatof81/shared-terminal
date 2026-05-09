/**
 * wsUpgradeRateLimit.ts — fixed-window per-IP limiter for the
 * `server.on('upgrade')` handler (#190 PR 190c).
 *
 * `express-rate-limit` only runs as Express middleware, which means
 * it sees HTTP requests but NOT raw upgrade events — the dispatcher's
 * HTTP path is capped, the WS path is not. Without this, a bot sending
 * upgrade frames to `p<port>-<uuid>.<base>` with no `Origin` header
 * (which `isAllowedWsOrigin` allows for non-browser callers) reaches
 * `lookupDispatchTarget` once per attempt — a D1 round-trip per probe.
 * Cloudflare WAF can absorb this at the edge but isn't guaranteed to
 * be configured on every deployment.
 *
 * This module is a minimal in-memory equivalent. Fixed-window
 * counter keyed on the client IP (X-Forwarded-For when trust proxy
 * is set, else `remoteAddress`). Tighter limit than the HTTP
 * limiter (60/min vs 300/min) because each upgrade is more
 * expensive (sets up a long-lived socket on the host) and a
 * legitimate browser only opens a handful of WS connections per
 * minute per session.
 *
 * Map sizing: PR #223 round 5 SHOULD-FIX caught a many-distinct-IP
 * flood scenario where every bucket was still in-window — `prune()`
 * was a no-op and the map grew unboundedly. The current shape:
 *
 *   1. On every `attempt()`, if `size > MAX_BUCKETS`, first try
 *      expired-only `prune()`.
 *   2. If still over cap, evict the OLDEST insertion-order chunk
 *      (Map preserves insertion order) — drops the bottom 25 % to
 *      amortize the cost of the eviction across many subsequent
 *      attempts. The evicted IPs lose their counter, which lets an
 *      attacker squeeze one extra free attempt per cycled IP, but
 *      bounds the heap at MAX_BUCKETS × ~60 bytes ≈ 60 KB.
 */

export interface WsUpgradeRateLimitConfig {
	windowMs: number;
	max: number;
	/** Test seam — defaults to `Date.now`. */
	now?: () => number;
}

export interface WsUpgradeRateLimiter {
	/**
	 * Record an upgrade attempt for `key`. Returns true if the attempt
	 * is allowed; false if the current window's budget is exhausted.
	 * `key === undefined` (e.g. a socket without `remoteAddress`) fails
	 * OPEN — better to occasionally over-allow than to block a
	 * legitimate IPv6 connection whose remoteAddress isn't surfaced.
	 */
	attempt(key: string | undefined): boolean;
}

/**
 * Resolve the client IP for upgrade-event rate-limiting in a way that
 * mirrors Express's `req.ip` resolution under our `trust proxy` setting.
 * Without this, the limiter keys on `socket.remoteAddress`, which behind
 * a Cloudflare Tunnel is the Tunnel's egress IP — shared by every user,
 * so the per-IP budget collapses to a single shared bucket and a small
 * burst of legitimate reconnects locks everyone out. PR #223 round 5
 * SHOULD-FIX.
 *
 * Logic:
 *   - `trust proxy` enabled (number > 0 or non-`false` truthy value)
 *     → take the leftmost X-Forwarded-For value; that's the original
 *     client when exactly one trusted proxy (the Tunnel) sits in front.
 *     Multi-hop infrastructure (CF → corporate proxy → backend) would
 *     need a richer proxy-addr-style resolution, but the documented
 *     deployment is one hop and that's what this matches.
 *   - `trust proxy` unset / 0 / false → use `socket.remoteAddress`
 *     (direct connection or local dev).
 *
 * `undefined` return falls open in `attempt()` — same as a missing
 * remoteAddress; better to occasionally over-allow than to drop a
 * legitimate connection over a missing header.
 */
export function resolveClientIp(
	xForwardedFor: string | string[] | undefined,
	remoteAddress: string | undefined,
	trustProxy: boolean | number | string | undefined,
): string | undefined {
	const proxyTrusted =
		trustProxy !== undefined && trustProxy !== false && trustProxy !== 0 && trustProxy !== "0";
	if (proxyTrusted) {
		const xff = Array.isArray(xForwardedFor) ? xForwardedFor[0] : xForwardedFor;
		if (typeof xff === "string" && xff.length > 0) {
			const first = xff.split(",")[0]!.trim();
			if (first.length > 0) return first;
		}
	}
	return remoteAddress;
}

// Hard cap on bucket count. With 60-byte rows this caps heap at
// ~60 KB regardless of attacker IP count. Sized generously above the
// "10k-user-deployment + brief reconnect spike" working set, so
// legitimate traffic never trips eviction.
const MAX_BUCKETS = 1024;

export function createWsUpgradeRateLimiter(cfg: WsUpgradeRateLimitConfig): WsUpgradeRateLimiter {
	const buckets = new Map<string, { count: number; resetAt: number }>();
	const now = cfg.now ?? Date.now;

	function prune(currentTime: number): void {
		for (const [k, v] of buckets) {
			if (v.resetAt <= currentTime) buckets.delete(k);
		}
	}

	function enforceCap(currentTime: number): void {
		if (buckets.size <= MAX_BUCKETS) return;
		// Cheap path first: drop expired buckets.
		prune(currentTime);
		if (buckets.size <= MAX_BUCKETS) return;
		// Still over cap (every bucket is in-window — flood scenario).
		// Evict the OLDEST insertion-order chunk. Map iteration order
		// is insertion order in JS, so `keys().next()` is the oldest.
		// Drop ~25 % to amortize the cost over many subsequent
		// `attempt()` calls; otherwise we'd evict on every attempt
		// while at-cap.
		const dropCount = Math.max(1, Math.floor(buckets.size / 4));
		let dropped = 0;
		for (const k of buckets.keys()) {
			buckets.delete(k);
			if (++dropped >= dropCount) break;
		}
	}

	return {
		attempt(key) {
			if (!key) return true;
			const currentTime = now();
			const bucket = buckets.get(key);
			if (!bucket || bucket.resetAt <= currentTime) {
				buckets.set(key, { count: 1, resetAt: currentTime + cfg.windowMs });
				enforceCap(currentTime);
				return true;
			}
			bucket.count += 1;
			return bucket.count <= cfg.max;
		},
	};
}
