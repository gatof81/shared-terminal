import { describe, expect, it } from "vitest";
import { hueOf } from "./teamView.js";

describe("hueOf", () => {
	it("neighbouring ids (differing only in their last character) no longer share a colour", () => {
		// Before: 267, 268, 269, 270, 271 — five agents, one colour. A hash onto
		// 360 hues can still put two NON-neighbouring agents close (here a2/a5,
		// 8° apart): colour is a second cue, name and initials are the identity,
		// and a per-project assignment would cost "an agent keeps its colour".
		const ids = ["a1", "a2", "a3", "a4", "a5"].map((x) => `a0000000-0000-4000-8000-0000000000${x}`);
		const hues = ids.map(hueOf);
		const dist = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
		for (let i = 1; i < hues.length; i++) expect(dist(hues[i]!, hues[i - 1]!)).toBeGreaterThan(20);
		expect(new Set(hues).size).toBe(hues.length);
	});

	it("is stable and in range", () => {
		expect(hueOf("x")).toBe(hueOf("x"));
		for (const id of ["", "a", crypto.randomUUID()]) {
			const h = hueOf(id);
			expect(h).toBeGreaterThanOrEqual(0);
			expect(h).toBeLessThan(360);
		}
	});
});
