/**
 * rateLimit.test.ts — docs/CONVERSATION.md §3.1: R1/R2 token buckets
 * (a full bucket always admits one L5-sized body) and the G2 gate.
 */

import { describe, expect, it } from "vitest";
import { L5_BODY_BYTES, R1_EVENTS_CAPACITY, R2_BYTES_CAPACITY } from "./limits.js";
import { LargeBodyGate, SessionRateLimiter } from "./rateLimit.js";

describe("SessionRateLimiter", () => {
	it("admits a single L5-sized body on a full bucket", () => {
		const rl = new SessionRateLimiter(() => 0);
		expect(rl.take("s", L5_BODY_BYTES)).toEqual({ ok: true });
	});
	it("refuses on bytes once R2 is spent, without charging the event bucket", () => {
		let t = 0;
		const rl = new SessionRateLimiter(() => t);
		expect(rl.take("s", R2_BYTES_CAPACITY)).toEqual({ ok: true });
		expect(rl.take("s", 1)).toEqual({ ok: false, reason: "bytes" });
		// 1 ms later R2 has ~400 bytes back but R1 only 0.05 of an event:
		// the refusal above must not have consumed an event, so exactly
		// R1 - 1 more events fit before the event bucket refuses.
		t = 1;
		for (let i = 1; i < R1_EVENTS_CAPACITY; i++) expect(rl.take("s", 0).ok).toBe(true);
		expect(rl.take("s", 0)).toEqual({ ok: false, reason: "events" });
	});
	it("refuses on events past R1 and refills at 50/s", () => {
		let t = 0;
		const rl = new SessionRateLimiter(() => t);
		for (let i = 0; i < R1_EVENTS_CAPACITY; i++) expect(rl.take("s", 10).ok).toBe(true);
		expect(rl.take("s", 10)).toEqual({ ok: false, reason: "events" });
		t = 1_000;
		for (let i = 0; i < 50; i++) expect(rl.take("s", 10).ok).toBe(true);
		expect(rl.take("s", 10).ok).toBe(false);
	});
	it("buckets are per ST session", () => {
		const rl = new SessionRateLimiter(() => 0);
		rl.take("a", R2_BYTES_CAPACITY);
		expect(rl.take("b", 100).ok).toBe(true);
		rl.forget("a");
		expect(rl.take("a", 100).ok).toBe(true);
	});
});

describe("LargeBodyGate (G2)", () => {
	it("admits at most 4 large bodies at once; release is idempotent", () => {
		const g = new LargeBodyGate();
		expect(g.isLarge(1024 * 1024)).toBe(false);
		expect(g.isLarge(1024 * 1024 + 1)).toBe(true);
		const releases = [g.acquire(), g.acquire(), g.acquire(), g.acquire()];
		expect(releases.every((r) => r !== null)).toBe(true);
		expect(g.acquire()).toBeNull();
		releases[0]?.();
		releases[0]?.();
		expect(g.current()).toBe(3);
		expect(g.acquire()).not.toBeNull();
	});
});
