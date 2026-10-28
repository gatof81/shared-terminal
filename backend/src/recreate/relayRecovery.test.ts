import { describe, expect, it } from "vitest";
import { measureRelayRecovery } from "./relayRecovery.testutil.js";

/** Virtual monotonic time: only the kill, the probes and the sleeps move it. */
function clock() {
	let t = 1_000;
	return {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms;
		},
		advance: (ms: number) => {
			t += ms;
		},
	};
}

/** A probe taking `ms` each time, identifying from the `from`-th call on. */
function probe(c: ReturnType<typeof clock>, ms: number, from: number) {
	let n = 0;
	return async () => {
		c.advance(ms);
		n++;
		return n >= from;
	};
}

describe("measureRelayRecovery (audit smoke S4)", () => {
	it("slow probes: every probe's duration counts, so recovery past 3 s fails", async () => {
		const c = clock();
		const r = await measureRelayRecovery({
			kill: async () => c.advance(50),
			probe: probe(c, 1_200, 3),
			limitMs: 3_000,
			pollMs: 200,
			now: c.now,
			sleep: c.sleep,
		});
		// 50 kill + 1200 + 200 + 1200 + 200 + 1200: the third probe started at
		// 2850 (inside the deadline) but its evidence came at 4050.
		expect(r.probes.map((p) => [p.startMs, p.endMs, p.identified])).toEqual([
			[50, 1_250, false],
			[1_450, 2_650, false],
			[2_850, 4_050, true],
		]);
		expect(r).toMatchObject({
			firstProbeIdentified: false,
			recoveredAfterMs: 4_050,
			withinLimit: false,
		});
		// The earlier measurement (clock from the first failed query's end)
		// would have reported 2800 ms and passed.
		expect((r.recoveredAfterMs ?? 0) - r.probes[0].endMs).toBeLessThan(3_000);
	});

	it("the clock starts at the kill: a slow kill counts", async () => {
		const c = clock();
		const r = await measureRelayRecovery({
			kill: async () => c.advance(2_500),
			probe: probe(c, 200, 2),
			limitMs: 3_000,
			pollMs: 200,
			now: c.now,
			sleep: c.sleep,
		});
		expect(r).toMatchObject({
			firstProbeIdentified: false,
			recoveredAfterMs: 3_100,
			withinLimit: false,
		});
	});

	it("a kill that outlasts the limit leaves no probe and fails", async () => {
		const c = clock();
		const r = await measureRelayRecovery({
			kill: async () => c.advance(3_500),
			probe: probe(c, 10, 1),
			limitMs: 3_000,
			pollMs: 200,
			now: c.now,
			sleep: c.sleep,
		});
		expect(r).toEqual({
			firstProbeIdentified: null,
			recoveredAfterMs: null,
			withinLimit: false,
			probes: [],
		});
	});

	it("never identified: fails, and the waits stop at the deadline", async () => {
		const c = clock();
		const r = await measureRelayRecovery({
			kill: async () => undefined,
			probe: probe(c, 300, Number.POSITIVE_INFINITY),
			limitMs: 3_000,
			pollMs: 200,
			now: c.now,
			sleep: c.sleep,
		});
		expect(r.withinLimit).toBe(false);
		expect(r.recoveredAfterMs).toBeNull();
		expect(c.now() - 1_000).toBeLessThanOrEqual(3_000 + 300);
	});

	it("evidence exactly at the deadline counts; fast recovery passes", async () => {
		const c = clock();
		const exact = await measureRelayRecovery({
			kill: async () => c.advance(100),
			probe: probe(c, 1_450, 2),
			limitMs: 3_000,
			pollMs: 0,
			now: c.now,
			sleep: c.sleep,
		});
		expect(exact).toMatchObject({ recoveredAfterMs: 3_000, withinLimit: true });
		const c2 = clock();
		const fast = await measureRelayRecovery({
			kill: async () => c2.advance(30),
			probe: probe(c2, 100, 4),
			limitMs: 3_000,
			pollMs: 200,
			now: c2.now,
			sleep: c2.sleep,
		});
		expect(fast).toMatchObject({
			firstProbeIdentified: false,
			recoveredAfterMs: 1_030,
			withinLimit: true,
		});
	});
});
