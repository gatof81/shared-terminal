/**
 * userQuotas.test.ts — env parsing, quota resolution, allocation math,
 * budget assertions, and the admin patch SQL shape (#202).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({
		results: [] as unknown[],
		success: true as const,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	})),
}));
vi.mock("./db.js", () => dbStubs);

import { DEFAULT_MEMORY_BYTES, DEFAULT_NANO_CPUS } from "./dockerManager.js";
import {
	assertBudgetAllows,
	computeRunningAllocations,
	effectiveSessionAllocation,
	getUserQuotaRow,
	parseUserMaxTotalCpu,
	parseUserMaxTotalMem,
	resolveEffectiveQuotas,
	UserQuotaExceededError,
	UserQuotasPatchSchema,
	updateUserQuotas,
} from "./userQuotas.js";

beforeEach(() => {
	dbStubs.d1Query.mockReset();
	dbStubs.d1Query.mockResolvedValue({
		results: [],
		success: true,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	});
});

describe("env parsing", () => {
	it("unset / empty means unlimited (null)", () => {
		expect(parseUserMaxTotalCpu(undefined)).toBeNull();
		expect(parseUserMaxTotalCpu("  ")).toBeNull();
		expect(parseUserMaxTotalMem(undefined)).toBeNull();
	});

	it("cores accept decimals and convert to nanos", () => {
		expect(parseUserMaxTotalCpu("8")).toBe(8_000_000_000);
		expect(parseUserMaxTotalCpu("1.5")).toBe(1_500_000_000);
	});

	it("MiB is integer-only and converts to bytes", () => {
		expect(parseUserMaxTotalMem("16384")).toBe(16384 * 1024 * 1024);
		expect(parseUserMaxTotalMem("1024.5")).toBeNull();
	});

	it("garbage warns and falls back to unlimited, never throws", () => {
		expect(parseUserMaxTotalCpu("lots")).toBeNull();
		expect(parseUserMaxTotalCpu("-4")).toBeNull();
		expect(parseUserMaxTotalMem("0")).toBeNull();
	});
});

describe("resolveEffectiveQuotas", () => {
	it("falls back to deployment defaults on null row / null columns", () => {
		const eff = resolveEffectiveQuotas(null);
		// Deployment default for the count is MAX_ACTIVE_SESSIONS_PER_USER
		// (20 unless the env overrides); budgets default to unlimited in
		// this test env (vars unset).
		expect(eff.maxSessions).toBeGreaterThan(0);
		expect(eff.maxTotalCpuNanos).toBeNull();
		expect(eff.maxTotalMemBytes).toBeNull();
	});

	it("per-user overrides win over defaults", () => {
		const eff = resolveEffectiveQuotas({
			max_sessions: 3,
			max_total_cpu: 6_000_000_000,
			max_total_mem: 4 * 2 ** 30,
		});
		expect(eff).toEqual({
			maxSessions: 3,
			maxTotalCpuNanos: 6_000_000_000,
			maxTotalMemBytes: 4 * 2 ** 30,
		});
	});
});

describe("effectiveSessionAllocation", () => {
	it("uses spawn defaults when the session has no stored caps", () => {
		expect(effectiveSessionAllocation({ cpuLimit: null, memLimit: null })).toEqual({
			cpuNanos: DEFAULT_NANO_CPUS,
			memBytes: DEFAULT_MEMORY_BYTES,
		});
	});

	it("clamps stored caps to the operator max — budgets count real cgroup allocations", () => {
		// A stored 100-core cap can't exceed EFFECTIVE_CPU_NANO_MAX (8
		// cores hard ceiling in this test env), same formula as spawn().
		const alloc = effectiveSessionAllocation({ cpuLimit: 100e9, memLimit: 1 });
		expect(alloc.cpuNanos).toBeLessThanOrEqual(8_000_000_000);
		expect(alloc.memBytes).toBe(1);
	});
});

describe("assertBudgetAllows", () => {
	const current = { runningSessions: 2, cpuNanos: 4e9, memBytes: 4 * 2 ** 30 };

	it("passes when unlimited (null caps)", () => {
		expect(() =>
			assertBudgetAllows(
				{ maxSessions: 20, maxTotalCpuNanos: null, maxTotalMemBytes: null },
				current,
				{ cpuNanos: 100e9, memBytes: 100 * 2 ** 30 },
			),
		).not.toThrow();
	});

	it("throws a cpu-named error when the CPU budget busts", () => {
		expect(() =>
			assertBudgetAllows(
				{ maxSessions: 20, maxTotalCpuNanos: 6e9, maxTotalMemBytes: null },
				current,
				{ cpuNanos: 4e9, memBytes: 0 },
			),
		).toThrow(UserQuotaExceededError);
		try {
			assertBudgetAllows(
				{ maxSessions: 20, maxTotalCpuNanos: 6e9, maxTotalMemBytes: null },
				current,
				{ cpuNanos: 4e9, memBytes: 0 },
			);
		} catch (err) {
			expect((err as UserQuotaExceededError).cap).toBe("cpu");
			expect((err as Error).message).toContain("CPU budget");
		}
	});

	it("throws a mem-named error when the memory budget busts", () => {
		try {
			assertBudgetAllows(
				{ maxSessions: 20, maxTotalCpuNanos: null, maxTotalMemBytes: 6 * 2 ** 30 },
				current,
				{ cpuNanos: 0, memBytes: 4 * 2 ** 30 },
			);
			expect.unreachable("should have thrown");
		} catch (err) {
			expect((err as UserQuotaExceededError).cap).toBe("mem");
		}
	});

	it("exactly-at-budget is allowed (inclusive boundary)", () => {
		expect(() =>
			assertBudgetAllows(
				{ maxSessions: 20, maxTotalCpuNanos: 8e9, maxTotalMemBytes: null },
				current,
				{ cpuNanos: 4e9, memBytes: 0 },
			),
		).not.toThrow();
	});
});

describe("computeRunningAllocations", () => {
	it("sums only running sessions, applying defaults for missing caps rows", async () => {
		const sessions = {
			listForUser: vi.fn(async () => [
				{ sessionId: "s1", status: "running" },
				{ sessionId: "s2", status: "stopped" },
				{ sessionId: "s3", status: "running" },
			]),
		} as never;
		// listResourceCaps does one d1Query; return caps for s1 only so s3
		// exercises the defaults path.
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [{ session_id: "s1", cpu_limit: 1e9, mem_limit: 2 ** 30 }],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		const totals = await computeRunningAllocations(sessions, "u1");
		expect(totals.runningSessions).toBe(2);
		expect(totals.cpuNanos).toBe(1e9 + DEFAULT_NANO_CPUS);
		expect(totals.memBytes).toBe(2 ** 30 + DEFAULT_MEMORY_BYTES);
	});

	it("short-circuits with zeros when nothing is running (no caps query)", async () => {
		const sessions = {
			listForUser: vi.fn(async () => [{ sessionId: "s1", status: "stopped" }]),
		} as never;
		const totals = await computeRunningAllocations(sessions, "u1");
		expect(totals).toEqual({ runningSessions: 0, cpuNanos: 0, memBytes: 0 });
		expect(dbStubs.d1Query).not.toHaveBeenCalled();
	});
});

describe("getUserQuotaRow / updateUserQuotas", () => {
	it("returns null for a missing user", async () => {
		expect(await getUserQuotaRow("ghost")).toBeNull();
	});

	it("updates only the supplied columns and reports row existence", async () => {
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [],
			success: true,
			meta: { changes: 1, duration: 0, last_row_id: 0 },
		});
		const ok = await updateUserQuotas("u1", { maxSessions: 5, maxTotalCpu: null });
		expect(ok).toBe(true);
		const [sql, params] = dbStubs.d1Query.mock.calls[0] as unknown as [string, unknown[]];
		expect(sql).toContain("max_sessions = ?");
		expect(sql).toContain("max_total_cpu = ?");
		expect(sql).not.toContain("max_total_mem");
		expect(params).toEqual([5, null, "u1"]);
	});

	it("empty patch is a no-op returning false", async () => {
		expect(await updateUserQuotas("u1", {})).toBe(false);
		expect(dbStubs.d1Query).not.toHaveBeenCalled();
	});
});

describe("UserQuotasPatchSchema", () => {
	it("accepts nulls (clear override) and in-bounds values", () => {
		expect(
			UserQuotasPatchSchema.safeParse({ maxSessions: null, maxTotalCpu: 8e9, maxTotalMem: null })
				.success,
		).toBe(true);
	});

	it("rejects out-of-bounds and unknown keys", () => {
		expect(UserQuotasPatchSchema.safeParse({ maxSessions: 0 }).success).toBe(false);
		expect(UserQuotasPatchSchema.safeParse({ maxTotalCpu: 1 }).success).toBe(false);
		expect(UserQuotasPatchSchema.safeParse({ nonsense: 1 }).success).toBe(false);
	});
});
