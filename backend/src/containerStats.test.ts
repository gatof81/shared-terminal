/**
 * containerStats.test.ts — CPU%/mem% math, TTL cache, error handling
 * for the admin "live usage" surface (#270).
 *
 * Mocks `dockerode` rather than the daemon, mirroring the
 * dockerManager.spawnConfig.test.ts style: a fake `stats()` method on
 * a fake `getContainer()` lets us pin the math without spinning a real
 * container.
 */

import type Dockerode from "dockerode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetStatsCacheForTests,
	computeStats,
	gatherStatsForRunning,
	getContainerStats,
	invalidateStatsCache,
	type RawDockerStats,
} from "./containerStats.js";

// ── computeStats (pure math) ────────────────────────────────────────────────

describe("computeStats", () => {
	function sample(overrides: Partial<RawDockerStats> = {}): RawDockerStats {
		return {
			cpu_stats: {
				cpu_usage: { total_usage: 2_000_000 },
				system_cpu_usage: 20_000_000,
				online_cpus: 4,
			},
			precpu_stats: {
				cpu_usage: { total_usage: 1_000_000 },
				system_cpu_usage: 10_000_000,
			},
			memory_stats: {
				usage: 800 * 1024 * 1024,
				limit: 2 * 1024 * 1024 * 1024,
				stats: { cache: 100 * 1024 * 1024 },
			},
			...overrides,
		};
	}

	it("computes CPU% from cpu/system deltas times onlineCpus * 100", () => {
		// cpuDelta = 1_000_000, sysDelta = 10_000_000, ratio = 0.1, *4 = 40%
		const got = computeStats(sample());
		expect(got.cpuPercent).toBeCloseTo(40, 6);
	});

	it("returns 0% CPU when sysDelta is 0 (avoid divide-by-zero on degenerate samples)", () => {
		// If two consecutive samples report the same system_cpu_usage,
		// the system clock hasn't advanced and the formula would
		// divide-by-zero. Guard collapses to 0% — same shape the
		// Docker CLI's formatter_stats.go uses.
		const got = computeStats({
			cpu_stats: {
				cpu_usage: { total_usage: 1_000_000 },
				system_cpu_usage: 10_000_000,
				online_cpus: 4,
			},
			precpu_stats: {
				cpu_usage: { total_usage: 0 },
				system_cpu_usage: 10_000_000,
			},
			memory_stats: { usage: 0, limit: 0 },
		});
		expect(got.cpuPercent).toBe(0);
	});

	it("clamps a negative cpuDelta to 0% (usage briefly regressed between samples)", () => {
		// Rare but real: cpu_stats.cpu_usage.total_usage can come back
		// less than precpu_stats.cpu_usage.total_usage if the daemon
		// re-samples in the middle of a counter reset. We clamp the
		// negative-rate output to 0 rather than guarding on
		// `cpuDelta > 0` (which would mask "CPU dropped" as 0% for
		// the entire window). Pinning the clamp here protects against
		// a regression that re-introduces the broader guard.
		const got = computeStats({
			cpu_stats: {
				cpu_usage: { total_usage: 1_000_000 },
				system_cpu_usage: 20_000_000,
				online_cpus: 4,
			},
			precpu_stats: {
				cpu_usage: { total_usage: 2_000_000 },
				system_cpu_usage: 10_000_000,
			},
			memory_stats: { usage: 0, limit: 0 },
		});
		expect(got.cpuPercent).toBe(0);
	});

	it("falls back to percpu_usage.length when online_cpus is missing (legacy daemons)", () => {
		const got = computeStats(
			sample({
				cpu_stats: {
					cpu_usage: { total_usage: 2_000_000, percpu_usage: [1, 2, 3, 4, 5, 6, 7, 8] },
					system_cpu_usage: 20_000_000,
				},
			}),
		);
		// onlineCpus = 8 now. 0.1 * 8 * 100 = 80
		expect(got.cpuPercent).toBeCloseTo(80, 6);
	});

	it("defaults to 1 CPU when both online_cpus and percpu_usage are absent", () => {
		const got = computeStats(
			sample({
				cpu_stats: {
					cpu_usage: { total_usage: 2_000_000 },
					system_cpu_usage: 20_000_000,
				},
			}),
		);
		// 0.1 * 1 * 100 = 10
		expect(got.cpuPercent).toBeCloseTo(10, 6);
	});

	it("subtracts memory_stats.stats.cache to match `docker stats`", () => {
		const got = computeStats(sample());
		// 800 MiB - 100 MiB cache = 700 MiB
		expect(got.memBytes).toBe(700 * 1024 * 1024);
		expect(got.memLimitBytes).toBe(2 * 1024 * 1024 * 1024);
		// 700 / 2048 ≈ 34.18%
		expect(got.memPercent).toBeCloseTo(34.18, 1);
	});

	it("clamps mem to 0 if a quirky kernel reports cache > usage", () => {
		const got = computeStats(
			sample({
				memory_stats: { usage: 50, limit: 1000, stats: { cache: 100 } },
			}),
		);
		expect(got.memBytes).toBe(0);
		expect(got.memPercent).toBe(0);
	});

	it("returns 0% mem when limit is missing", () => {
		const got = computeStats(
			sample({
				memory_stats: { usage: 100, limit: 0 },
			}),
		);
		expect(got.memPercent).toBe(0);
	});
});

// ── getContainerStats (cache + error handling) ──────────────────────────────

describe("getContainerStats", () => {
	beforeEach(() => {
		__resetStatsCacheForTests();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function makeFakeDocker(statsFn: (id: string) => Promise<unknown>): {
		docker: Dockerode;
		getContainer: ReturnType<typeof vi.fn>;
	} {
		const getContainer = vi.fn((id: string) => ({
			stats: vi.fn(async () => statsFn(id)),
		}));
		return { docker: { getContainer } as unknown as Dockerode, getContainer };
	}

	it("returns parsed stats on a successful one-shot call", async () => {
		const { docker } = makeFakeDocker(async () => ({
			cpu_stats: {
				cpu_usage: { total_usage: 2_000_000 },
				system_cpu_usage: 20_000_000,
				online_cpus: 2,
			},
			precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 10_000_000 },
			memory_stats: { usage: 100, limit: 1000 },
		}));
		const got = await getContainerStats(docker, "c1");
		expect(got).not.toBeNull();
		expect(got?.cpuPercent).toBeCloseTo(20, 6);
		expect(got?.memBytes).toBe(100);
	});

	it("returns null when dockerode throws (no such container, daemon unreachable, etc.)", async () => {
		const { docker } = makeFakeDocker(async () => {
			throw new Error("No such container: c1");
		});
		const got = await getContainerStats(docker, "c1");
		expect(got).toBeNull();
	});

	it("caches a successful sample for the TTL window — second call does not re-hit docker", async () => {
		const stats = vi.fn(async () => ({
			cpu_stats: {
				cpu_usage: { total_usage: 2_000_000 },
				system_cpu_usage: 20_000_000,
				online_cpus: 1,
			},
			precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 10_000_000 },
			memory_stats: { usage: 100, limit: 1000 },
		}));
		const docker = {
			getContainer: vi.fn(() => ({ stats })),
		} as unknown as Dockerode;
		await getContainerStats(docker, "c1");
		await getContainerStats(docker, "c1");
		// Critical: the same container fetched twice in the TTL window
		// hits the cache, not the daemon — protects the admin route
		// from N×daemon-calls per refresh.
		expect(stats).toHaveBeenCalledTimes(1);
	});

	it("invalidateStatsCache forces the next call to re-fetch", async () => {
		const stats = vi.fn(async () => ({
			cpu_stats: {
				cpu_usage: { total_usage: 2_000_000 },
				system_cpu_usage: 20_000_000,
				online_cpus: 1,
			},
			precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 10_000_000 },
			memory_stats: { usage: 100, limit: 1000 },
		}));
		const docker = {
			getContainer: vi.fn(() => ({ stats })),
		} as unknown as Dockerode;
		await getContainerStats(docker, "c1");
		invalidateStatsCache("c1");
		await getContainerStats(docker, "c1");
		// Two real fetches because the cache was force-cleared between
		// them. This is the path the PATCH-caps route uses so the next
		// dashboard refresh shows usage against the new cgroup limit.
		expect(stats).toHaveBeenCalledTimes(2);
	});

	it("does not crash on a late rejection from a timed-out fetch", async () => {
		// Simulate a daemon that wedges past the 3 s per-call timeout
		// then eventually rejects (e.g. socket closed by daemon after
		// we already returned null). Without the no-op .catch() on the
		// abandoned promise, Node treats this as an unhandledRejection
		// and — on default `--unhandled-rejections=throw` — kills the
		// backend. The fix attaches `.catch(() => {})` before returning;
		// this test pins that behaviour by ensuring NO unhandled
		// rejection event fires before the test completes.
		const seen: unknown[] = [];
		const onRejection = (reason: unknown) => seen.push(reason);
		process.on("unhandledRejection", onRejection);
		try {
			let rejectStats!: (err: Error) => void;
			const stats = vi.fn(
				() =>
					new Promise((_resolve, reject) => {
						rejectStats = reject;
					}),
			);
			const docker = {
				getContainer: vi.fn(() => ({ stats })),
			} as unknown as Dockerode;
			// Run the fetch with a tight injected timeout so the test
			// completes in milliseconds instead of waiting on the real
			// 3 s. We use vi's fake timers to advance past
			// PER_CALL_TIMEOUT_MS without sleeping.
			vi.useFakeTimers();
			const fetchPromise = getContainerStats(docker, "c1");
			await vi.advanceTimersByTimeAsync(3_500);
			const result = await fetchPromise;
			expect(result).toBeNull();
			// NOW reject the floating promise — this is the moment a
			// regression (no .catch attached) would surface as an
			// unhandledRejection. The handler attached above would
			// capture it; we assert it stayed empty.
			rejectStats(new Error("daemon socket closed after timeout"));
			// Let microtasks run so any rejection has a chance to fire.
			await Promise.resolve();
			await Promise.resolve();
			expect(seen).toEqual([]);
		} finally {
			vi.useRealTimers();
			process.off("unhandledRejection", onRejection);
		}
	});

	it("does NOT cache null results — a failed fetch is retried on the next call", async () => {
		const stats = vi
			.fn()
			.mockRejectedValueOnce(new Error("transient daemon error"))
			.mockResolvedValueOnce({
				cpu_stats: {
					cpu_usage: { total_usage: 2_000_000 },
					system_cpu_usage: 20_000_000,
					online_cpus: 1,
				},
				precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 10_000_000 },
				memory_stats: { usage: 100, limit: 1000 },
			});
		const docker = {
			getContainer: vi.fn(() => ({ stats })),
		} as unknown as Dockerode;
		const first = await getContainerStats(docker, "c1");
		const second = await getContainerStats(docker, "c1");
		expect(first).toBeNull();
		expect(second).not.toBeNull();
		// Critical: a transient failure must NOT poison the cache for
		// the TTL window. Each call must re-try the daemon until it
		// gets a real sample.
		expect(stats).toHaveBeenCalledTimes(2);
	});
});

// ── gatherStatsForRunning (per-row dispatch) ────────────────────────────────

describe("gatherStatsForRunning", () => {
	beforeEach(() => {
		__resetStatsCacheForTests();
	});

	it("returns a Map keyed by sessionId with per-container results", async () => {
		const docker = {
			getContainer: vi.fn((id: string) => ({
				stats: vi.fn(async () => ({
					cpu_stats: {
						cpu_usage: { total_usage: 2_000_000 },
						system_cpu_usage: 20_000_000,
						online_cpus: 1,
					},
					precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 10_000_000 },
					memory_stats: { usage: id === "cA" ? 100 : 200, limit: 1000 },
				})),
			})),
		} as unknown as Dockerode;
		const got = await gatherStatsForRunning(docker, [
			{ sessionId: "sA", containerId: "cA" },
			{ sessionId: "sB", containerId: "cB" },
		]);
		expect(got.get("sA")?.memBytes).toBe(100);
		expect(got.get("sB")?.memBytes).toBe(200);
	});

	it("emits null for sessions without a containerId (reconcile-pending state)", async () => {
		const docker = { getContainer: vi.fn() } as unknown as Dockerode;
		const got = await gatherStatsForRunning(docker, [{ sessionId: "sA", containerId: null }]);
		expect(got.get("sA")).toBeNull();
		// CRITICAL: no daemon call must have fired. Without this short-
		// circuit the dockerode mock would have surfaced an
		// "undefined.stats is not a function" — the test would still
		// pass with the current shape, but the assertion locks the
		// no-call invariant against a future regression.
		expect(docker.getContainer as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
	});

	it("a single container's failure does NOT stall the others (Promise.allSettled)", async () => {
		const docker = {
			getContainer: vi.fn((id: string) => ({
				stats: vi.fn(async () => {
					if (id === "cA") throw new Error("daemon hiccup");
					return {
						cpu_stats: {
							cpu_usage: { total_usage: 2_000_000 },
							system_cpu_usage: 20_000_000,
							online_cpus: 1,
						},
						precpu_stats: {
							cpu_usage: { total_usage: 1_000_000 },
							system_cpu_usage: 10_000_000,
						},
						memory_stats: { usage: 100, limit: 1000 },
					};
				}),
			})),
		} as unknown as Dockerode;
		const got = await gatherStatsForRunning(docker, [
			{ sessionId: "sA", containerId: "cA" },
			{ sessionId: "sB", containerId: "cB" },
		]);
		// Failed row maps to null; healthy row reports a real number.
		// Without allSettled the rejection would have propagated and
		// the admin route would have returned 500 — losing visibility
		// into the working sessions because one was wedged.
		expect(got.get("sA")).toBeNull();
		expect(got.get("sB")).not.toBeNull();
	});
});
