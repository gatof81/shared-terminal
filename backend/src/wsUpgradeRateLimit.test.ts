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
	it("uses remoteAddress when trust proxy is unset", () => {
		expect(resolveClientIp("203.0.113.5", "1.2.3.4", undefined)).toBe("1.2.3.4");
	});

	it("uses remoteAddress when trust proxy is 0 / false / '0'", () => {
		expect(resolveClientIp("203.0.113.5", "1.2.3.4", 0)).toBe("1.2.3.4");
		expect(resolveClientIp("203.0.113.5", "1.2.3.4", false)).toBe("1.2.3.4");
		expect(resolveClientIp("203.0.113.5", "1.2.3.4", "0")).toBe("1.2.3.4");
	});

	it("uses XFF[0] when trust proxy is enabled (Cloudflare Tunnel shape)", () => {
		expect(resolveClientIp("203.0.113.5", "1.2.3.4", 1)).toBe("203.0.113.5");
		expect(resolveClientIp("203.0.113.5, 198.51.100.7", "1.2.3.4", 1)).toBe("203.0.113.5");
	});

	it("trims whitespace from the parsed XFF entry", () => {
		expect(resolveClientIp("  203.0.113.5  , 198.51.100.7", "1.2.3.4", 1)).toBe("203.0.113.5");
	});

	it("falls back to remoteAddress when XFF is empty / whitespace", () => {
		expect(resolveClientIp("", "1.2.3.4", 1)).toBe("1.2.3.4");
		expect(resolveClientIp("   ", "1.2.3.4", 1)).toBe("1.2.3.4");
		expect(resolveClientIp(undefined, "1.2.3.4", 1)).toBe("1.2.3.4");
	});

	it("handles array-shaped XFF (rare but Node sometimes emits one)", () => {
		expect(resolveClientIp(["203.0.113.5", "ignored"], "1.2.3.4", 1)).toBe("203.0.113.5");
	});

	it("returns undefined when both XFF and remoteAddress are absent", () => {
		expect(resolveClientIp(undefined, undefined, 1)).toBeUndefined();
		expect(resolveClientIp(undefined, undefined, undefined)).toBeUndefined();
	});
});
