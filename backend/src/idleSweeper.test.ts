import { beforeEach, describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({
		results: [] as unknown[],
		success: true as const,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	})),
}));
vi.mock("./db.js", () => dbStubs);

import { IdleSweeper, listRunningSessionIds } from "./idleSweeper.js";

beforeEach(() => {
	dbStubs.d1Query.mockReset();
	dbStubs.d1Query.mockImplementation(async () => ({
		results: [],
		success: true,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	}));
});

function makeSweeper(opts?: {
	stopContainer?: (sessionId: string) => Promise<void>;
	startTime?: number;
}): {
	sweeper: IdleSweeper;
	stopSpy: ReturnType<typeof vi.fn>;
	advance: (ms: number) => void;
} {
	let mockNow = opts?.startTime ?? 1_000_000;
	const stopSpy = vi.fn(opts?.stopContainer ?? (async () => {}));
	const sweeper = new IdleSweeper({
		stopContainer: stopSpy,
		now: () => mockNow,
		sweepIntervalMs: 60_000,
	});
	return {
		sweeper,
		stopSpy,
		advance(ms) {
			mockNow += ms;
		},
	};
}

function mockRunningWithTtl(rows: { session_id: string; idle_ttl_seconds: number }[]) {
	dbStubs.d1Query.mockImplementationOnce(async () => ({
		results: rows,
		success: true,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	}));
}

// ── bump / forget / init ────────────────────────────────────────────────

describe("IdleSweeper.bump / forget / init", () => {
	it("bump records the current time as lastActivity", () => {
		const { sweeper, advance } = makeSweeper({ startTime: 100 });
		sweeper.bump("s1");
		expect(sweeper.__peekActivity("s1")).toBe(100);
		advance(5000);
		sweeper.bump("s1");
		expect(sweeper.__peekActivity("s1")).toBe(5100);
	});

	it("forget removes the entry", () => {
		const { sweeper } = makeSweeper();
		sweeper.bump("s1");
		expect(sweeper.__peekActivity("s1")).toBeDefined();
		sweeper.forget("s1");
		expect(sweeper.__peekActivity("s1")).toBeUndefined();
	});

	it("init seeds `now()` for every passed session id", () => {
		const { sweeper } = makeSweeper({ startTime: 9000 });
		sweeper.init(["a", "b", "c"]);
		expect(sweeper.__peekActivity("a")).toBe(9000);
		expect(sweeper.__peekActivity("b")).toBe(9000);
		expect(sweeper.__peekActivity("c")).toBe(9000);
	});
});

// ── runSweep ────────────────────────────────────────────────────────────

describe("IdleSweeper.runSweep", () => {
	it("does nothing when no running sessions have idle_ttl_seconds set", async () => {
		const { sweeper, stopSpy } = makeSweeper();
		mockRunningWithTtl([]);
		await sweeper.runSweep();
		expect(stopSpy).not.toHaveBeenCalled();
	});

	it("seeds + skips a session it hasn't seen yet (race with /start)", async () => {
		// A session that reached `running` between `init()` and the
		// first sweep shouldn't be reaped on its first encounter —
		// give it the full window.
		const { sweeper, stopSpy } = makeSweeper({ startTime: 5_000 });
		mockRunningWithTtl([{ session_id: "newcomer", idle_ttl_seconds: 60 }]);
		await sweeper.runSweep();
		expect(stopSpy).not.toHaveBeenCalled();
		// It is now seeded.
		expect(sweeper.__peekActivity("newcomer")).toBe(5_000);
	});

	it("does NOT stop a session whose idle is still under the TTL", async () => {
		const { sweeper, stopSpy, advance } = makeSweeper({ startTime: 0 });
		sweeper.bump("s-active");
		advance(30_000); // 30 s elapsed; TTL is 60 s.
		mockRunningWithTtl([{ session_id: "s-active", idle_ttl_seconds: 60 }]);
		await sweeper.runSweep();
		expect(stopSpy).not.toHaveBeenCalled();
	});

	it("stops a session whose idle exceeds the TTL", async () => {
		const { sweeper, stopSpy, advance } = makeSweeper({ startTime: 0 });
		sweeper.bump("s-stale");
		advance(61_000); // 61 s; TTL 60 s.
		mockRunningWithTtl([{ session_id: "s-stale", idle_ttl_seconds: 60 }]);
		await sweeper.runSweep();
		expect(stopSpy).toHaveBeenCalledWith("s-stale");
	});

	it("drops the activity entry after a successful auto-stop", async () => {
		// Without this, a re-attach immediately after auto-stop would
		// race against an already-decayed bucket; the next /start
		// flow re-seeds when the session reappears in `running`.
		const { sweeper, advance } = makeSweeper({ startTime: 0 });
		sweeper.bump("s-stale");
		advance(120_000);
		mockRunningWithTtl([{ session_id: "s-stale", idle_ttl_seconds: 60 }]);
		await sweeper.runSweep();
		expect(sweeper.__peekActivity("s-stale")).toBeUndefined();
	});

	it("isolates per-row stop failures so one stuck container doesn't stall the sweep", async () => {
		// `s-bad` throws on stop; the sweeper logs and keeps going.
		// `s-good` is also stale and must still be stopped in the
		// same pass.
		let stopCalls = 0;
		const stops: string[] = [];
		const { sweeper, advance } = makeSweeper({
			startTime: 0,
			stopContainer: async (id) => {
				stopCalls++;
				stops.push(id);
				if (id === "s-bad") throw new Error("docker down");
			},
		});
		sweeper.bump("s-bad");
		sweeper.bump("s-good");
		advance(120_000);
		mockRunningWithTtl([
			{ session_id: "s-bad", idle_ttl_seconds: 60 },
			{ session_id: "s-good", idle_ttl_seconds: 60 },
		]);
		await sweeper.runSweep();
		expect(stopCalls).toBe(2);
		expect(stops).toEqual(["s-bad", "s-good"]);
	});

	it("uses inclusive boundary — exactly the TTL is NOT a reap", async () => {
		// Boundary pin: a session whose idle equals the TTL exactly
		// stays alive for one more sweep window. Dropping `<=` to
		// `<` would shave a window and make the cap behaviour
		// surprising.
		const { sweeper, stopSpy, advance } = makeSweeper({ startTime: 0 });
		sweeper.bump("s-edge");
		advance(60_000); // exactly 60 s; TTL 60 s
		mockRunningWithTtl([{ session_id: "s-edge", idle_ttl_seconds: 60 }]);
		await sweeper.runSweep();
		expect(stopSpy).not.toHaveBeenCalled();
	});

	it("re-seeds an already-stopped session that re-appears in running", async () => {
		// User auto-stopped, /started again. The earlier `delete`
		// after the auto-stop dropped the entry; on the next sweep
		// the session is back in `running` and gets re-seeded
		// (skipped this round).
		const { sweeper, stopSpy, advance } = makeSweeper({ startTime: 0 });
		sweeper.bump("s-recurring");
		advance(120_000);
		mockRunningWithTtl([{ session_id: "s-recurring", idle_ttl_seconds: 60 }]);
		await sweeper.runSweep();
		expect(stopSpy).toHaveBeenCalledTimes(1);
		// User restarts; sweep again — must not double-reap.
		mockRunningWithTtl([{ session_id: "s-recurring", idle_ttl_seconds: 60 }]);
		await sweeper.runSweep();
		expect(stopSpy).toHaveBeenCalledTimes(1); // still 1 — re-seeded, not reaped
	});
});

// ── start / stop lifecycle ──────────────────────────────────────────────

describe("IdleSweeper.start / stop", () => {
	it("start is idempotent (second call is a no-op)", () => {
		// Use real timers but a fast cadence so the test is quick;
		// don't actually wait — just verify start doesn't throw on
		// double-call and stop cancels cleanly.
		const sweeper = new IdleSweeper({
			stopContainer: async () => {},
			sweepIntervalMs: 60_000,
		});
		sweeper.start();
		sweeper.start(); // second call → no-op, no second timer
		sweeper.stop();
	});

	it("stop is idempotent (second call after stop is a no-op)", () => {
		const sweeper = new IdleSweeper({
			stopContainer: async () => {},
			sweepIntervalMs: 60_000,
		});
		sweeper.start();
		sweeper.stop();
		sweeper.stop(); // double-stop → safe
	});
});

// ── listRunningSessionIds (boot helper) ─────────────────────────────────

describe("listRunningSessionIds", () => {
	it("returns an empty array when no running sessions exist", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		await expect(listRunningSessionIds()).resolves.toEqual([]);
	});

	it("returns the session_id column from the running rows", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [{ session_id: "a" }, { session_id: "b" }],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		await expect(listRunningSessionIds()).resolves.toEqual(["a", "b"]);
	});

	it("queries with WHERE status = 'running'", async () => {
		await listRunningSessionIds();
		const [sql] = dbStubs.d1Query.mock.calls[0]!;
		expect(sql).toMatch(/WHERE status = 'running'/);
	});
});
