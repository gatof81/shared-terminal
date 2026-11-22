import { beforeEach, describe, expect, it } from "vitest";
import { chooseLanding, type LandingInput, readViewPref, writeViewPref } from "./viewPolicy.js";

/** A traditional session. */
const T = { isAgent: false } as const;

describe("chooseLanding", () => {
	it("the person's last choice wins on a running session", () => {
		for (const pref of ["terminal", "files", "git"] as const)
			expect(chooseLanding({ ...T, pref, running: true })).toBe(pref);
	});

	it("without a choice: Terminal when running, Files when stopped", () => {
		expect(chooseLanding({ ...T, pref: null, running: true })).toBe("terminal");
		expect(chooseLanding({ ...T, pref: null, running: false })).toBe("files");
		expect(chooseLanding({ isAgent: null, pref: null, running: true })).toBe("terminal");
	});

	it("stopped: a saved Terminal or Git falls back to Files", () => {
		expect(chooseLanding({ ...T, pref: "terminal", running: false })).toBe("files");
		expect(chooseLanding({ ...T, pref: "git", running: false })).toBe("files");
		expect(chooseLanding({ ...T, pref: "files", running: false })).toBe("files");
	});

	it("a saved Chat does not apply: a traditional session has none", () => {
		expect(chooseLanding({ ...T, pref: "chat", running: true })).toBe("terminal");
		expect(chooseLanding({ ...T, pref: "chat", running: false })).toBe("files");
	});
});

describe("chooseLanding — an ACP agent's session", () => {
	const agent = (o: Partial<LandingInput>): LandingInput => ({
		pref: null,
		running: true,
		isAgent: true,
		...o,
	});

	it("lands on Chat, running or stopped", () => {
		for (const running of [true, false]) expect(chooseLanding(agent({ running }))).toBe("chat");
	});

	it("the view the person chose for it wins; a stopped one keeps only Files or Chat", () => {
		for (const pref of ["terminal", "files", "git", "chat"] as const)
			expect(chooseLanding(agent({ pref }))).toBe(pref);
		expect(chooseLanding(agent({ pref: "terminal", running: false }))).toBe("chat");
		expect(chooseLanding(agent({ pref: "git", running: false }))).toBe("chat");
		expect(chooseLanding(agent({ pref: "files", running: false }))).toBe("files");
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

	it("ignores a stored value that is not a view", () => {
		localStorage.setItem("st.view.s1", "admin");
		expect(readViewPref("s1")).toBeNull();
	});
});
