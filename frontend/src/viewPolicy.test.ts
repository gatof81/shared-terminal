import { beforeEach, describe, expect, it } from "vitest";
import { chooseLanding, readViewPref, writeViewPref } from "./viewPolicy.js";

describe("chooseLanding", () => {
	it("the person's last choice wins on a running session", () => {
		for (const pref of ["terminal", "files", "git"] as const)
			expect(chooseLanding({ pref, running: true })).toBe(pref);
	});

	it("without a choice: Terminal when running, Files when stopped", () => {
		expect(chooseLanding({ pref: null, running: true })).toBe("terminal");
		expect(chooseLanding({ pref: null, running: false })).toBe("files");
	});

	it("stopped: a saved Terminal or Git falls back to Files", () => {
		expect(chooseLanding({ pref: "terminal", running: false })).toBe("files");
		expect(chooseLanding({ pref: "git", running: false })).toBe("files");
		expect(chooseLanding({ pref: "files", running: false })).toBe("files");
	});
});

describe("per-session memory", () => {
	beforeEach(() => localStorage.clear());

	it("round-trips the view per session", () => {
		expect(readViewPref("s1")).toBeNull();
		writeViewPref("s1", "git");
		expect(readViewPref("s1")).toBe("git");
		expect(readViewPref("s2")).toBeNull();
	});

	it("ignores a stored value that is not a view (a saved Chat included)", () => {
		localStorage.setItem("st.view.s1", "admin");
		expect(readViewPref("s1")).toBeNull();
		localStorage.setItem("st.view.s1", "chat");
		expect(readViewPref("s1")).toBeNull();
	});
});
