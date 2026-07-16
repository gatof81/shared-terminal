import { describe, expect, it } from "vitest";
import { decideSearchAction, type SubmittedSearch } from "./search.js";

const target = { sessionId: "s1", tabId: "tab-a" };
const submitted = (query: string, overrides: Partial<SubmittedSearch> = {}): SubmittedSearch => ({
	sessionId: "s1",
	tabId: "tab-a",
	query,
	...overrides,
});

describe("decideSearchAction", () => {
	it("first Enter searches", () => {
		expect(decideSearchAction(null, target, "foo", false)).toBe("search");
	});

	it("Enter again with the same value steps to the next match", () => {
		expect(decideSearchAction(submitted("foo"), target, "foo", false)).toBe("next");
	});

	it("Shift+Enter with the same value steps to the previous match", () => {
		expect(decideSearchAction(submitted("foo"), target, "foo", true)).toBe("prev");
	});

	it("a changed query forces a fresh search, even with Shift held", () => {
		expect(decideSearchAction(submitted("foo"), target, "bar", false)).toBe("search");
		// No previous match of the NEW pattern exists to step back through.
		expect(decideSearchAction(submitted("foo"), target, "bar", true)).toBe("search");
	});

	it("Shift+Enter before any search still searches", () => {
		expect(decideSearchAction(null, target, "foo", true)).toBe("search");
	});

	it("a tab switch forces a fresh search on the new pane", () => {
		const last = submitted("foo", { tabId: "tab-b" });
		expect(decideSearchAction(last, target, "foo", false)).toBe("search");
	});

	it("a session switch forces a fresh search too", () => {
		const last = submitted("foo", { sessionId: "s2" });
		expect(decideSearchAction(last, target, "foo", true)).toBe("search");
	});
});
