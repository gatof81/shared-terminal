/**
 * conversation/rateLimit.ts — docs/CONVERSATION.md §3.1: per-ST-session
 * token buckets (R1 events, R2 bytes) and the G2 large-body gate.
 *
 * Token buckets rather than fixed windows so a single body of L5 bytes
 * always fits when the bucket is full (capacity ≥ L5): a large final
 * report in an otherwise quiet session is never rejected by R2. Both
 * buckets are process-local and in-memory like every other limiter.
 */

import {
	G2_LARGE_BODIES_IN_FLIGHT,
	G2_LARGE_BODY_BYTES,
	R1_EVENTS_CAPACITY,
	R1_EVENTS_PER_SECOND,
	R2_BYTES_CAPACITY,
	R2_BYTES_PER_SECOND,
} from "./limits.js";

class TokenBucket {
	private tokens: number;
	private last: number;

	constructor(
		private readonly capacity: number,
		private readonly refillPerSecond: number,
		now: number,
	) {
		this.tokens = capacity;
		this.last = now;
	}

	private refill(now: number): void {
		const elapsed = Math.max(0, now - this.last) / 1000;
		this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
		this.last = now;
	}

	has(cost: number, now: number): boolean {
		this.refill(now);
		return cost <= this.tokens;
	}

	consume(cost: number): void {
		this.tokens -= cost;
	}

	available(now: number): number {
		this.refill(now);
		return this.tokens;
	}
}

export interface RateDecision {
	ok: boolean;
	/** Which bucket refused, for the gap's detail. */
	reason?: "events" | "bytes";
}

export class SessionRateLimiter {
	private readonly buckets = new Map<string, { events: TokenBucket; bytes: TokenBucket }>();

	constructor(private readonly now: () => number = Date.now) {}

	take(stSessionId: string, bodyBytes: number): RateDecision {
		const t = this.now();
		let b = this.buckets.get(stSessionId);
		if (!b) {
			b = {
				events: new TokenBucket(R1_EVENTS_CAPACITY, R1_EVENTS_PER_SECOND, t),
				bytes: new TokenBucket(R2_BYTES_CAPACITY, R2_BYTES_PER_SECOND, t),
			};
			this.buckets.set(stSessionId, b);
		}
		// Check both before consuming either, so a refusal never
		// half-charges the session.
		if (!b.bytes.has(bodyBytes, t)) return { ok: false, reason: "bytes" };
		if (!b.events.has(1, t)) return { ok: false, reason: "events" };
		b.bytes.consume(bodyBytes);
		b.events.consume(1);
		return { ok: true };
	}

	forget(stSessionId: string): void {
		this.buckets.delete(stSessionId);
	}
}

/** G2 — bodies above the large-body threshold in flight at once. */
export class LargeBodyGate {
	private inFlight = 0;

	constructor(private readonly max = G2_LARGE_BODIES_IN_FLIGHT) {}

	isLarge(contentLength: number): boolean {
		return contentLength > G2_LARGE_BODY_BYTES;
	}

	/** Returns a release function, or null when the gate is full. */
	acquire(): (() => void) | null {
		if (this.inFlight >= this.max) return null;
		this.inFlight++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.inFlight--;
		};
	}

	current(): number {
		return this.inFlight;
	}
}
