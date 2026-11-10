/**
 * cliPolicy.test.ts — COMPOSER_CLI_VERSIONS / _MIN_VERSION / _DENY (§8.1.9, v1.8.3).
 * The version decided on is the LIVE process's (cliIdentity.ts), bare X.Y.Z.
 */

import { describe, expect, it } from "vitest";
import {
	decide,
	describePolicy,
	exactPolicy,
	parsePolicy,
	parseVersion,
	policyWarnings,
	ruleText,
} from "./cliPolicy.js";

const policy = (min?: string, deny?: string, exact = "2.1.314,2.1.316") =>
	parsePolicy({
		COMPOSER_CLI_VERSIONS: exact,
		COMPOSER_CLI_MIN_VERSION: min,
		COMPOSER_CLI_DENY: deny,
	});

describe("default: open from the lowest validated version (owner, 2026-11-10)", () => {
	it("unset ⇒ any stable release ≥ the lowest listed passes: 2.1.322 (session A), a future 3.0.0", () => {
		const p = policy();
		expect(p.min).toBe("2.1.314");
		expect(decide(p, "2.1.314")).toEqual({ ok: true, version: "2.1.314", by: "exact" });
		expect(decide(p, "2.1.322")).toEqual({ ok: true, version: "2.1.322", by: "min" });
		expect(decide(p, "3.0.0")).toEqual({ ok: true, version: "3.0.0", by: "min" });
		expect(decide(p, "2.1.313")).toMatchObject({ ok: false, why: "not-allowed" });
		expect(decide(p, "2.1.322-rc.1")).toMatchObject({ ok: false, why: "invalid-version" });
	});
	it("empty settings ⇒ the default list, open from 2.1.314", () => {
		const p = parsePolicy({});
		expect([...p.exact]).toEqual(["2.1.314"]);
		expect(p.min).toBe("2.1.314");
		expect(decide(p, "2.1.322")).toMatchObject({ ok: true, by: "min" });
	});
	it("the default minimum is the LOWEST listed, whatever the order", () => {
		expect(policy(undefined, undefined, "2.1.316,2.1.314").min).toBe("2.1.314");
		expect(policy(undefined, undefined, "2.1.316").min).toBe("2.1.316");
	});
	it("the deny list still wins over the open default", () => {
		const p = policy(undefined, "2.1.322");
		expect(decide(p, "2.1.322")).toEqual({ ok: false, version: "2.1.322", why: "denied" });
		expect(decide(p, "2.1.323")).toMatchObject({ ok: true, by: "min" });
	});
});

describe("COMPOSER_CLI_MIN_VERSION=off ⇒ exactly the previous behaviour", () => {
	it("only the exact list passes; 2.1.317 (HZ's auto-update, 2026-11-04) is refused", () => {
		const p = policy("off");
		expect(p.min).toBeNull();
		expect(decide(p, "2.1.314")).toEqual({ ok: true, version: "2.1.314", by: "exact" });
		expect(decide(p, "2.1.316")).toEqual({ ok: true, version: "2.1.316", by: "exact" });
		expect(decide(p, "2.1.317")).toEqual({ ok: false, version: "2.1.317", why: "not-allowed" });
		expect(decide(p, "3.0.0")).toMatchObject({ ok: false, why: "not-allowed" });
	});
	it("off with empty settings ⇒ the validated default 2.1.314 only", () => {
		const p = parsePolicy({ COMPOSER_CLI_MIN_VERSION: "off" });
		expect([...p.exact]).toEqual(["2.1.314"]);
		expect(decide(p, "2.1.316")).toMatchObject({ ok: false });
	});
});

describe("COMPOSER_CLI_MIN_VERSION=2.1.314: open, no ceiling", () => {
	const p = policy("2.1.314");
	it.each([
		["2.1.314", true, "exact"],
		["2.1.316", true, "exact"],
		["2.1.317", true, "min"],
		["2.1.318", true, "min"],
		["2.2.0", true, "min"],
		["2.10.0", true, "min"],
		["3.0.0", true, "min"],
		["10.0.0", true, "min"],
		["2.1.313", false, "not-allowed"],
		["2.0.999", false, "not-allowed"],
		["1.999.999", false, "not-allowed"],
	])("%s ⇒ %s (%s)", (ver, ok, tag) => {
		const d = decide(p, ver);
		expect(d.ok).toBe(ok);
		expect(d).toMatchObject(ok ? { by: tag } : { why: tag });
	});
	it("comparison is numeric, not lexical (2.1.1000 > 2.1.314; 2.10.0 > 2.9.0)", () => {
		expect(decide(p, "2.1.1000")).toMatchObject({ ok: true, by: "min" });
		const q = policy("2.1.316");
		expect(decide(q, "2.1.40")).toMatchObject({ ok: false });
		expect(decide(q, "2.10.0")).toMatchObject({ ok: true });
	});
	it("the rule is named in the log text", () => {
		const d = decide(p, "3.0.0");
		if (!d.ok) throw new Error("expected ok");
		expect(ruleText(p, d)).toBe("COMPOSER_CLI_MIN_VERSION >=2.1.314");
		const e = decide(p, "2.1.316");
		if (!e.ok) throw new Error("expected ok");
		expect(ruleText(p, e)).toBe("COMPOSER_CLI_VERSIONS");
	});
	it("startup describes and warns about the open policy", () => {
		expect(describePolicy(policy("2.1.314", "2.1.318"))).toBe(
			"exact 2.1.314, 2.1.316; min 2.1.314 (open: any later stable release, unvalidated); deny 2.1.318",
		);
		expect(policyWarnings(p).join("\n")).toMatch(
			/ANY later stable Claude Code release, including minor and major/,
		);
	});
});

describe("deny list: an explicit block always wins", () => {
	it("a denied version above the minimum is refused; its neighbours are not", () => {
		const p = policy("2.1.314", "2.1.318, 3.0.0");
		expect(decide(p, "2.1.318")).toEqual({ ok: false, version: "2.1.318", why: "denied" });
		expect(decide(p, "3.0.0")).toMatchObject({ ok: false, why: "denied" });
		expect(decide(p, "2.1.319")).toMatchObject({ ok: true, by: "min" });
		expect(decide(p, "3.0.1")).toMatchObject({ ok: true, by: "min" });
	});
	it("a denied version also in the exact list is refused, with a startup warning", () => {
		const p = policy("off", "2.1.316");
		expect(decide(p, "2.1.316")).toMatchObject({ ok: false, why: "denied" });
		expect(policyWarnings(p)).toEqual([
			"COMPOSER_CLI_DENY also lists validated 2.1.316: denied (deny wins)",
		]);
		expect(policyWarnings(policy("off"))).toEqual([]);
		// The open default states its risk at boot.
		expect(policyWarnings(policy())).toEqual([
			expect.stringContaining(
				"COMPOSER_CLI_MIN_VERSION=2.1.314: the composer will type into ANY later stable",
			),
		]);
	});
});

describe("the input is re-validated: anything not a plain release is refused", () => {
	const p = policy("2.1.314");
	it.each([
		"2.1.320-rc.1",
		"2.1.320+build.5",
		"2.1.0317",
		"2.1",
		"2.1.317.1",
		"v2.1.317",
		"",
		"2.1.317 (Claude Code)",
	])("%j ⇒ invalid-version", (raw) => {
		expect(decide(p, raw)).toEqual({ ok: false, version: null, why: "invalid-version" });
	});
	it("parseVersion is strict and bounded", () => {
		expect(parseVersion("2.1.314")).toEqual([2, 1, 314]);
		expect(parseVersion("0.0.0")).toEqual([0, 0, 0]);
		for (const bad of ["02.1.1", "2.1.1 ", "2.1.1-a", "1234567890.0.0", "a.b.c", ""])
			expect(parseVersion(bad)).toBeNull();
	});
});

describe("misconfiguration refuses to start (never silently widened or narrowed)", () => {
	it.each([
		["2.1.315", /must be a validated version listed in COMPOSER_CLI_VERSIONS/],
		[">=2.1.314", /not a version/],
		[">=2.1.314 <2.2.0", /not a version/],
		["2.1.314-rc.1", /not a version/],
		["2.1", /not a version/],
		["latest", /not a version/],
		["^2.1.314", /not a version/],
	])("COMPOSER_CLI_MIN_VERSION=%j", (min, err) => {
		expect(() => policy(min)).toThrow(err);
	});
	it("a malformed deny or exact entry refuses too", () => {
		expect(() => policy(undefined, "2.1.318, latest")).toThrow(
			/COMPOSER_CLI_DENY: not a version: latest/,
		);
		expect(() => policy(undefined, undefined, "2.1.314,next")).toThrow(/COMPOSER_CLI_VERSIONS/);
	});
	it("surrounding whitespace is tolerated", () => {
		expect(policy("  2.1.316 ").min).toBe("2.1.316");
	});
});

describe("exactPolicy (deps without a policy)", () => {
	it("is the exact list alone", () => {
		const p = exactPolicy(["2.1.314"]);
		expect(decide(p, "2.1.314")).toMatchObject({ ok: true, by: "exact" });
		expect(decide(p, "2.1.315")).toMatchObject({ ok: false });
	});
});
