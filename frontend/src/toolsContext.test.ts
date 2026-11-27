import { describe, expect, it } from "vitest";
import { isWorkGone, onWorkChange, reportWorkGone, setWork, workFor } from "./toolsContext.js";

describe("toolsContext", () => {
	it("a work is its agent's session's only: the session on screen keeps its principal workspace", () => {
		let changes = 0;
		onWorkChange(() => changes++);
		setWork("dev-session", "ci-cache");
		expect(workFor("dev-session")).toBe("ci-cache");
		expect(workFor("arq-session")).toBeNull();
		expect(workFor(null)).toBeNull();
		expect(changes).toBe(1);
		setWork("dev-session", "ci-cache");
		expect(changes).toBe(1);
		setWork(null, null);
		expect(workFor("dev-session")).toBeNull();
	});

	it("gone: only for the work on screen, and forgotten when the workspace changes", () => {
		setWork("dev-session", "old-try");
		reportWorkGone("arq-session", "old-try");
		expect(isWorkGone("arq-session")).toBe(false);
		reportWorkGone("dev-session", "old-try");
		expect(isWorkGone("dev-session")).toBe(true);
		setWork("dev-session", null);
		expect(isWorkGone("dev-session")).toBe(false);
	});
});
