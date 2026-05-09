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
 * Resolve the client IP for upgrade-event rate-limiting using the same
 * peel-from-right algorithm proxy-addr (Express) uses for `req.ip`.
 *
 * `parseTrustProxy` already refuses `TRUST_PROXY=true` precisely
 * because Express in that mode takes the *leftmost* X-Forwarded-For
 * entry (attacker-controlled), defeating per-IP rate limits. The
 * earlier shape of this helper accidentally replicated that rejected
 * pattern — it took XFF[0] for any truthy trustProxy value. PR #223
 * round 6 SHOULD-FIX hardened it: only positive-numeric trust is
 * acted on, and the algorithm now mirrors proxy-addr — peel
 * `trustProxy` entries from the right of `[...XFF, remoteAddress]`
 * and return the first non-trusted entry (the `(trustProxy+1)`th
 * from the right).
 *
 * Examples (single-hop Cloudflare Tunnel, `TRUST_PROXY=1`):
 *
 *     xff = "203.0.113.5"          remote = "10.0.0.1" (Tunnel egress)
 *     ips = ["203.0.113.5", "10.0.0.1"]
 *     idx = 2 - 1 - 1 = 0          → "203.0.113.5" ✓ (real client)
 *
 * Multi-hop attacker injection (still `TRUST_PROXY=1`):
 *
 *     xff = "1.2.3.4 (forged), 203.0.113.5 (real)"   remote = Tunnel
 *     ips = ["1.2.3.4", "203.0.113.5", "10.0.0.1"]
 *     idx = 3 - 1 - 1 = 1          → "203.0.113.5" ✓ (NOT the forged head)
 *
 * For boolean / string / undefined `trustProxy` the helper falls back
 * to `remoteAddress` rather than try to parse XFF — those cases need
 * proxy-addr's full IP/CIDR matcher (`"loopback"`, `"linklocal"`,
 * comma-separated CIDRs), which is out of scope here.
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
	if (typeof trustProxy !== "number" || trustProxy <= 0) {
		return remoteAddress;
	}
	const xff = Array.isArray(xForwardedFor) ? xForwardedFor.join(",") : (xForwardedFor ?? "");
	const parts = xff
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	const ips: string[] = [...parts];
	if (remoteAddress) ips.push(remoteAddress);
	if (ips.length === 0) return undefined;
	const idx = ips.length - trustProxy - 1;
	// idx < 0 means we trust more hops than the chain has — every
	// entry is "trusted", so take the leftmost (the original client
	// per Express semantics).
	return idx < 0 ? ips[0] : ips[idx];
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
