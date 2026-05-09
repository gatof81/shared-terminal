import { describe, expect, it } from "vitest";
import { createWsUpgradeRateLimiter, resolveClientIp } from "./wsUpgradeRateLimit.js";

describe("createWsUpgradeRateLimiter", () => {
	function makeLimiter(opts?: { windowMs?: number; max?: number; startTime?: number }) {
		let mockNow = opts?.startTime ?? 1_000_000;
		const limiter = createWsUpgradeRateLimiter({
			windowMs: opts?.windowMs ?? 60_000,
			max: opts?.max ?? 5,
			now: () => mockNow,
		});
		return {
			limiter,
			advance(ms: number) {
				mockNow += ms;
			},
		};
	}

	it("allows attempts within the budget", () => {
		const { limiter } = makeLimiter({ max: 3 });
		expect(limiter.attempt("1.2.3.4")).toBe(true);
		expect(limiter.attempt("1.2.3.4")).toBe(true);
		expect(limiter.attempt("1.2.3.4")).toBe(true);
	});

	it("rejects attempts past the budget within the same window", () => {
		const { limiter } = makeLimiter({ max: 2 });
		expect(limiter.attempt("1.2.3.4")).toBe(true);
		expect(limiter.attempt("1.2.3.4")).toBe(true);
		expect(limiter.attempt("1.2.3.4")).toBe(false);
		// Subsequent attempts in the same window keep rejecting.
		expect(limiter.attempt("1.2.3.4")).toBe(false);
	});

	it("resets the bucket at window expiry", () => {
		const { limiter, advance } = makeLimiter({ max: 2, windowMs: 60_000 });
		expect(limiter.attempt("1.2.3.4")).toBe(true);
		expect(limiter.attempt("1.2.3.4")).toBe(true);
		expect(limiter.attempt("1.2.3.4")).toBe(false);
		// Advance past the window; the next attempt opens a fresh
		// budget for the same IP.
		advance(60_001);
		expect(limiter.attempt("1.2.3.4")).toBe(true);
		expect(limiter.attempt("1.2.3.4")).toBe(true);
		expect(limiter.attempt("1.2.3.4")).toBe(false);
	});

	it("buckets are per-IP — a flood from one IP doesn't affect another", () => {
		const { limiter } = makeLimiter({ max: 1 });
		expect(limiter.attempt("1.1.1.1")).toBe(true);
		expect(limiter.attempt("1.1.1.1")).toBe(false); // exhausted
		// Different IP = different bucket.
		expect(limiter.attempt("2.2.2.2")).toBe(true);
		expect(limiter.attempt("2.2.2.2")).toBe(false);
	});

	// `socket.remoteAddress` can theoretically be undefined (very
	// unusual — only seen on an already-destroyed socket). Failing
	// open beats dropping a legitimate connection over a Node API
	// edge case.
	it("fails open on missing key (undefined remoteAddress)", () => {
		const { limiter } = makeLimiter({ max: 1 });
		expect(limiter.attempt(undefined)).toBe(true);
		expect(limiter.attempt(undefined)).toBe(true);
		expect(limiter.attempt(undefined)).toBe(true);
	});

	it("expired-bucket prune at the threshold avoids eviction (cheap path wins)", () => {
		// PR #223 round 5: the cap-eviction path is the fallback;
		// when buckets ARE expired, plain prune handles it without
		// touching in-window data. This pins that ordering — the
		// `enforceCap` cheap path mustn't accidentally evict
		// in-window buckets when a prune would suffice.
		const { limiter, advance } = makeLimiter({ max: 1, windowMs: 60_000 });
		// Seed 1024 IPs at t=0 (these all expire at t=60_000).
		for (let i = 0; i < 1024; i++) {
			limiter.attempt(`10.0.${Math.floor(i / 256)}.${i % 256}`);
		}
		// Advance past the window — every original bucket has
		// expired. The 1025th attempt should trigger prune (which
		// clears them) NOT eviction.
		advance(60_001);
		expect(limiter.attempt("99.99.99.99")).toBe(true);
		// All 1024 originals are gone and the cap is well below
		// the threshold again. A cycled-back IP gets a fresh
		// budget — same as if the limiter had never seen it.
		expect(limiter.attempt("10.0.0.0")).toBe(true);
	});

	// PR #223 round 5 SHOULD-FIX: many-distinct-IP flood within a
	// single window. Every bucket is in-window so prune() does
	// nothing — the cap-eviction path drops the oldest 25 % of
	// entries to keep memory bounded.
	it("evicts the oldest 25% when the map is over-cap and no buckets are expired", () => {
		const { limiter } = makeLimiter({ max: 1, windowMs: 60_000 });
		// Fill exactly to MAX_BUCKETS (1024). The 1025th attempt
		// trips eviction.
		for (let i = 0; i < 1024; i++) {
			limiter.attempt(`10.0.${Math.floor(i / 256)}.${i % 256}`);
		}
		// All buckets at-budget; the next attempt for any of these
		// IPs returns false.
		expect(limiter.attempt("10.0.0.0")).toBe(false);
		// Now flood with another 1024 distinct IPs — each triggers
		// `enforceCap`, which evicts the oldest. After ~256 new
		// arrivals, the original "10.0.0.0" bucket should be
		// evicted (oldest insertion-order). A subsequent attempt
		// for "10.0.0.0" gets a fresh budget back.
		for (let i = 0; i < 256; i++) {
			limiter.attempt(`192.168.${Math.floor(i / 256)}.${i % 256}`);
		}
		// "10.0.0.0" was evicted in the first 25% drop and
		// re-allocated when its key reappeared, so it now has a
		// fresh budget.
		expect(limiter.attempt("10.0.0.0")).toBe(true);
	});
});

// ── resolveClientIp ──────────────────────────────────────────────────────

describe("resolveClientIp", () => {
	it("uses remoteAddress when trust proxy is unset / 0 / non-numeric", () => {
		// Per PR #223 round 6 SHOULD-FIX: only positive-numeric trust
		// is acted on. Anything else (boolean true was already
		// rejected by parseTrustProxy; strings would need proxy-addr's
		// full IP/CIDR matcher) falls back to remoteAddress so we
		// don't accidentally take the leftmost XFF.
		expect(resolveClientIp("203.0.113.5", "1.2.3.4", undefined)).toBe("1.2.3.4");
		expect(resolveClientIp("203.0.113.5", "1.2.3.4", 0)).toBe("1.2.3.4");
		expect(resolveClientIp("203.0.113.5", "1.2.3.4", false)).toBe("1.2.3.4");
		expect(resolveClientIp("203.0.113.5", "1.2.3.4", true)).toBe("1.2.3.4");
		expect(resolveClientIp("203.0.113.5", "1.2.3.4", "loopback")).toBe("1.2.3.4");
	});

	it("peels 1 hop from the right (Cloudflare Tunnel single-hop)", () => {
		// xff=[203.0.113.5], remote=10.0.0.1, trust=1
		// ips=[203.0.113.5, 10.0.0.1]; peel 1 → idx=0 → 203.0.113.5
		expect(resolveClientIp("203.0.113.5", "10.0.0.1", 1)).toBe("203.0.113.5");
	});

	it("peels 1 hop from the right when an attacker injects XFF[0]", () => {
		// The bug Express's "trust proxy: true" exhibits — leftmost-
		// XFF logic — would return "1.2.3.4 (forged)". Numeric peel
		// returns the real client appended by the trusted proxy.
		// xff=[forged, real], remote=tunnelEgress, trust=1
		// ips=[forged, real, tunnelEgress]; peel 1 → idx=1 → real
		expect(resolveClientIp("1.2.3.4, 203.0.113.5", "10.0.0.1", 1)).toBe("203.0.113.5");
	});

	it("peels N hops correctly when trust > 1", () => {
		// trust=2 with [forged, victim, real, remote]
		// idx = 4 - 2 - 1 = 1 → "victim"
		expect(resolveClientIp("forged, victim, real", "remote", 2)).toBe("victim");
		// trust=3 with [forged, victim, real, remote]
		// idx = 4 - 3 - 1 = 0 → "forged" (we've trusted everything to
		// the right; original-client position is the leftmost)
		expect(resolveClientIp("forged, victim, real", "remote", 3)).toBe("forged");
	});

	it("returns the leftmost when trustProxy exceeds chain length", () => {
		// xff=[a], remote=b, trust=5
		// ips=[a, b], idx = 2 - 5 - 1 = -4 → fall back to ips[0] = a
		expect(resolveClientIp("a", "b", 5)).toBe("a");
	});

	it("trims whitespace from XFF entries", () => {
		expect(resolveClientIp("  203.0.113.5  , 198.51.100.7", "10.0.0.1", 1)).toBe("198.51.100.7");
	});

	it("falls back to remoteAddress when XFF is empty / whitespace", () => {
		expect(resolveClientIp("", "1.2.3.4", 1)).toBe("1.2.3.4");
		expect(resolveClientIp("   ", "1.2.3.4", 1)).toBe("1.2.3.4");
		expect(resolveClientIp(undefined, "1.2.3.4", 1)).toBe("1.2.3.4");
	});

	it("joins array-shaped XFF before peeling", () => {
		// Node sometimes hands an array for repeated headers. The
		// peel algorithm wants a single comma-joined chain so the
		// rightmost trusted-proxy hop always lines up the same way.
		expect(resolveClientIp(["forged", "real"], "remote", 1)).toBe("real");
	});

	it("returns undefined when both XFF and remoteAddress are absent", () => {
		expect(resolveClientIp(undefined, undefined, 1)).toBeUndefined();
		expect(resolveClientIp(undefined, undefined, undefined)).toBeUndefined();
	});
});
