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
 * counter keyed on `remoteAddress`. Tighter limit than the HTTP
 * limiter (60/min vs 300/min) because each upgrade is more
 * expensive (sets up a long-lived socket on the host) and a
 * legitimate browser only opens a handful of WS connections per
 * minute per session.
 *
 * GC: `attempt()` opportunistically prunes expired buckets when the
 * map crosses a threshold. Map size is bounded by the number of
 * distinct IPs in the current window; at 60 s and reasonable
 * traffic, this stays well within memory.
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

export function createWsUpgradeRateLimiter(cfg: WsUpgradeRateLimitConfig): WsUpgradeRateLimiter {
	const buckets = new Map<string, { count: number; resetAt: number }>();
	const now = cfg.now ?? Date.now;

	function prune(currentTime: number): void {
		for (const [k, v] of buckets) {
			if (v.resetAt <= currentTime) buckets.delete(k);
		}
	}

	return {
		attempt(key) {
			if (!key) return true;
			const currentTime = now();
			const bucket = buckets.get(key);
			if (!bucket || bucket.resetAt <= currentTime) {
				buckets.set(key, { count: 1, resetAt: currentTime + cfg.windowMs });
				// Opportunistic GC. The 1024 threshold keeps the map
				// bounded under sustained unique-IP load (a flood of
				// distinct attacker IPs) without paying the prune
				// cost on every call. Single-pass O(n) over the map.
				if (buckets.size > 1024) prune(currentTime);
				return true;
			}
			bucket.count += 1;
			return bucket.count <= cfg.max;
		},
	};
}
