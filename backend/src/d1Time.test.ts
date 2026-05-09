import { describe, expect, it } from "vitest";
import { parseD1Utc } from "./d1Time";

describe("parseD1Utc", () => {
	it("treats suffix-less D1 timestamp as UTC, not local time", () => {
		// 2024-01-01 10:00:00 — D1's exact wire shape. Assert via
		// `toISOString()` (always UTC) so the test is timezone-independent.
		const d = parseD1Utc("2024-01-01 10:00:00");
		expect(d.toISOString()).toBe("2024-01-01T10:00:00.000Z");
	});

	it("preserves an explicit Z suffix without doubling", () => {
		const d = parseD1Utc("2024-01-01T10:00:00Z");
		expect(d.toISOString()).toBe("2024-01-01T10:00:00.000Z");
	});

	it("preserves an explicit offset suffix", () => {
		const d = parseD1Utc("2024-01-01T10:00:00+00:00");
		expect(d.toISOString()).toBe("2024-01-01T10:00:00.000Z");
	});

	it("throws on garbage input", () => {
		expect(() => parseD1Utc("not-a-date")).toThrow(/D1: unparseable timestamp/);
	});

	it("includes the caller-supplied context in the error", () => {
		expect(() => parseD1Utc("not-a-date", "templates")).toThrow(/templates: unparseable timestamp/);
	});
});
