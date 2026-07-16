import { beforeEach, describe, expect, it } from "vitest";
import {
	badgeFor,
	clearAllBadges,
	clearBadge,
	nextBadgeState,
	recordOutput,
} from "./tabActivity.js";

describe("nextBadgeState", () => {
	it("sets a plain output badge for a background tab", () => {
		expect(nextBadgeState(undefined, "hello\r\n", false)).toBe("output");
	});

	it("never badges the active tab", () => {
		expect(nextBadgeState(undefined, "hello", true)).toBeUndefined();
		expect(nextBadgeState(undefined, "ding\x07", true)).toBeUndefined();
	});

	it("clears a stale badge when the tab is active", () => {
		expect(nextBadgeState("bell", "more output", true)).toBeUndefined();
	});

	it("upgrades to bell when the chunk contains BEL", () => {
		expect(nextBadgeState(undefined, "prompt\x07", false)).toBe("bell");
		expect(nextBadgeState("output", "\x07", false)).toBe("bell");
	});

	it("detects BEL anywhere in the chunk, not just at the edges", () => {
		expect(nextBadgeState(undefined, "a\x1b[1m\x07b", false)).toBe("bell");
	});

	it("keeps bell precedence over later plain output", () => {
		expect(nextBadgeState("bell", "just text", false)).toBe("bell");
	});

	it("keeps output at output for repeated plain chunks", () => {
		expect(nextBadgeState("output", "more", false)).toBe("output");
	});
});

describe("recordOutput / clearBadge", () => {
	beforeEach(() => {
		clearAllBadges();
	});

	it("stores the badge and reports the change once", () => {
		expect(recordOutput("t1", "line", false)).toBe(true);
		expect(badgeFor("t1")).toBe("output");
		// Same state again — no DOM repaint needed.
		expect(recordOutput("t1", "line", false)).toBe(false);
	});

	it("output→bell transition reports a change; bell then absorbs output", () => {
		recordOutput("t1", "line", false);
		expect(recordOutput("t1", "\x07", false)).toBe(true);
		expect(badgeFor("t1")).toBe("bell");
		expect(recordOutput("t1", "line", false)).toBe(false);
		expect(badgeFor("t1")).toBe("bell");
	});

	it("active-tab output removes a stale badge and reports the change", () => {
		recordOutput("t1", "\x07", false);
		expect(recordOutput("t1", "line", true)).toBe(true);
		expect(badgeFor("t1")).toBeUndefined();
	});

	it("active-tab output with no badge is a no-op", () => {
		expect(recordOutput("t1", "line", true)).toBe(false);
		expect(badgeFor("t1")).toBeUndefined();
	});

	it("clearBadge clears exactly one tab", () => {
		recordOutput("t1", "line", false);
		recordOutput("t2", "\x07", false);
		expect(clearBadge("t1")).toBe(true);
		expect(clearBadge("t1")).toBe(false);
		expect(badgeFor("t1")).toBeUndefined();
		expect(badgeFor("t2")).toBe("bell");
	});

	it("clearAllBadges wipes everything", () => {
		recordOutput("t1", "line", false);
		recordOutput("t2", "\x07", false);
		clearAllBadges();
		expect(badgeFor("t1")).toBeUndefined();
		expect(badgeFor("t2")).toBeUndefined();
	});
});
