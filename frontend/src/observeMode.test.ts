import { describe, expect, it } from "vitest";
import { nextObserveMode } from "./observeMode.js";

describe("nextObserveMode", () => {
	it("escalates observe → operate (take control)", () => {
		expect(nextObserveMode("observe")).toBe("operate");
	});

	it("de-escalates operate → observe (release control)", () => {
		expect(nextObserveMode("operate")).toBe("observe");
	});

	it("is an involution — two flips return to the start", () => {
		expect(nextObserveMode(nextObserveMode("observe"))).toBe("observe");
		expect(nextObserveMode(nextObserveMode("operate"))).toBe("operate");
	});
});
