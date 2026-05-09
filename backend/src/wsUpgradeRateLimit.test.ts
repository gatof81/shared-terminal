import { describe, expect, it } from "vitest";
import { createWsUpgradeRateLimiter } from "./wsUpgradeRateLimit.js";

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

	// At ~1024 buckets the limiter prunes expired entries. Test that
	// the prune doesn't drop in-window buckets — only expired ones.
	it("prune at the threshold preserves in-window buckets", () => {
		const { limiter, advance } = makeLimiter({ max: 1, windowMs: 60_000 });
		// Seed with 1024 distinct IPs at t=0; their buckets all
		// expire at t=60_000.
		for (let i = 0; i < 1024; i++) {
			limiter.attempt(`10.0.${Math.floor(i / 256)}.${i % 256}`);
		}
		// Half the window passes — original buckets are still in
		// flight. A 1025th distinct IP triggers prune; the new
		// bucket survives, the old ones do too (resetAt > now).
		advance(30_000);
		expect(limiter.attempt("99.99.99.99")).toBe(true);
		// The original IP should still be at-budget (not reset).
		expect(limiter.attempt("10.0.0.0")).toBe(false);
	});

	it("prune at the threshold drops expired buckets", () => {
		const { limiter, advance } = makeLimiter({ max: 1, windowMs: 60_000 });
		// Seed 1024 IPs at t=0.
		for (let i = 0; i < 1024; i++) {
			limiter.attempt(`10.0.${Math.floor(i / 256)}.${i % 256}`);
		}
		// Advance past the window — every original bucket has
		// expired. The 1025th attempt triggers prune, which clears
		// them, and the original IP gets a fresh budget.
		advance(60_001);
		expect(limiter.attempt("99.99.99.99")).toBe(true);
		expect(limiter.attempt("10.0.0.0")).toBe(true);
	});
});
