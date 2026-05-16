// #200 — operator-tunable resource-cap env vars (MAX_SESSION_CPU /
// MAX_SESSION_MEM). Covers the parse helpers' defaulting, clamping,
// floor / ceiling enforcement, and the warn-on-bad-input behavior.
// The schema-side rejection (Zod max with the env-var-named message)
// is covered against the live module-load values rather than via
// resetModules: tests pin the effective max by reading what
// parseMaxSessionCpu/Mem return for the same env value, so the
// assertions don't get fragile if the v1 ceiling ever changes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "./logger.js";
import { parseMaxSessionCpu, parseMaxSessionMem } from "./sessionConfig.js";

describe("parseMaxSessionCpu (#200)", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		warnSpy.mockRestore();
	});

	it("defaults to 8 cores (v1 ceiling) when unset", () => {
		expect(parseMaxSessionCpu(undefined)).toBe(8_000_000_000);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("defaults to 8 cores when whitespace-only", () => {
		expect(parseMaxSessionCpu("   ")).toBe(8_000_000_000);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("accepts an integer-core lower override", () => {
		expect(parseMaxSessionCpu("4")).toBe(4_000_000_000);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("accepts a fractional-core lower override (form parity)", () => {
		expect(parseMaxSessionCpu("0.5")).toBe(500_000_000);
		expect(parseMaxSessionCpu("2.5")).toBe(2_500_000_000);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("clamps to the v1 ceiling and warns when above 8 cores (env can only LOWER)", () => {
		expect(parseMaxSessionCpu("16")).toBe(8_000_000_000);
		expect(warnSpy).toHaveBeenCalledOnce();
		expect(warnSpy.mock.calls[0]?.[0]).toMatch(/exceeds the v1 ceiling/);
	});

	it("falls back to default and warns when below the per-session floor (0.25 cores)", () => {
		expect(parseMaxSessionCpu("0.1")).toBe(8_000_000_000);
		expect(warnSpy).toHaveBeenCalledOnce();
		expect(warnSpy.mock.calls[0]?.[0]).toMatch(/below the per-session floor/);
	});

	it("accepts the floor value exactly", () => {
		expect(parseMaxSessionCpu("0.25")).toBe(250_000_000);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("falls back to default and warns on non-numeric input", () => {
		expect(parseMaxSessionCpu("two")).toBe(8_000_000_000);
		expect(warnSpy).toHaveBeenCalledOnce();
		expect(warnSpy.mock.calls[0]?.[0]).toMatch(/is not a positive number/);
	});

	it("falls back to default and warns on zero", () => {
		expect(parseMaxSessionCpu("0")).toBe(8_000_000_000);
		expect(warnSpy).toHaveBeenCalledOnce();
	});

	it("falls back to default and warns on negative input", () => {
		expect(parseMaxSessionCpu("-2")).toBe(8_000_000_000);
		expect(warnSpy).toHaveBeenCalledOnce();
	});
});

describe("parseMaxSessionMem (#200)", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		warnSpy.mockRestore();
	});

	it("defaults to 16 GiB (v1 ceiling) when unset", () => {
		expect(parseMaxSessionMem(undefined)).toBe(16 * 1024 * 1024 * 1024);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("accepts a MiB integer lower override", () => {
		expect(parseMaxSessionMem("4096")).toBe(4 * 1024 * 1024 * 1024);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("accepts the 256-MiB floor exactly", () => {
		expect(parseMaxSessionMem("256")).toBe(256 * 1024 * 1024);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("clamps to the v1 ceiling and warns when above 16 GiB", () => {
		// 32 GiB in MiB
		expect(parseMaxSessionMem("32768")).toBe(16 * 1024 * 1024 * 1024);
		expect(warnSpy).toHaveBeenCalledOnce();
		expect(warnSpy.mock.calls[0]?.[0]).toMatch(/exceeds the v1 ceiling/);
	});

	it("falls back to default and warns when below the 256-MiB floor", () => {
		expect(parseMaxSessionMem("128")).toBe(16 * 1024 * 1024 * 1024);
		expect(warnSpy).toHaveBeenCalledOnce();
		expect(warnSpy.mock.calls[0]?.[0]).toMatch(/below the per-session floor/);
	});

	it("falls back to default and warns on a fractional value (MiB is integer-only)", () => {
		expect(parseMaxSessionMem("1024.5")).toBe(16 * 1024 * 1024 * 1024);
		expect(warnSpy).toHaveBeenCalledOnce();
		expect(warnSpy.mock.calls[0]?.[0]).toMatch(/is not a positive integer/);
	});

	it("falls back to default and warns on non-numeric input", () => {
		expect(parseMaxSessionMem("lots")).toBe(16 * 1024 * 1024 * 1024);
		expect(warnSpy).toHaveBeenCalledOnce();
	});

	it("falls back to default and warns on zero / negative input", () => {
		expect(parseMaxSessionMem("0")).toBe(16 * 1024 * 1024 * 1024);
		expect(parseMaxSessionMem("-1024")).toBe(16 * 1024 * 1024 * 1024);
		expect(warnSpy).toHaveBeenCalledTimes(2);
	});
});

// ── Schema integration — verifies the Zod cpuLimit / memLimit max ─────────
// references the live module-load value (not a stale ceiling) and that the
// custom error message names the env var so an operator who lowered the
// cap can point users at it.

describe("SessionConfigSchema resource-cap integration (#200)", () => {
	it("the live module-load CPU cap matches the v1 ceiling when env is unset", async () => {
		// In the test environment MAX_SESSION_CPU is unset, so the
		// effective cap is the v1 ceiling (8 cores). Above rejects,
		// at-cap accepts.
		const { SessionConfigSchema } = await import("./sessionConfig.js");
		const above = SessionConfigSchema.safeParse({ cpuLimit: 8_000_000_001 });
		expect(above.success).toBe(false);
		if (!above.success) {
			const msg = above.error.issues[0]?.message ?? "";
			expect(msg).toMatch(/cpuLimit exceeds the per-session cap/);
			expect(msg).toMatch(/MAX_SESSION_CPU/);
		}
		const at = SessionConfigSchema.safeParse({ cpuLimit: 8_000_000_000 });
		expect(at.success).toBe(true);
	});

	it("the live module-load memory cap rejects above 16 GiB with the env-var-named message", async () => {
		const { SessionConfigSchema } = await import("./sessionConfig.js");
		const above = SessionConfigSchema.safeParse({ memLimit: 16 * 1024 * 1024 * 1024 + 1 });
		expect(above.success).toBe(false);
		if (!above.success) {
			const msg = above.error.issues[0]?.message ?? "";
			expect(msg).toMatch(/memLimit exceeds the per-session cap/);
			expect(msg).toMatch(/MAX_SESSION_MEM/);
		}
	});
});
