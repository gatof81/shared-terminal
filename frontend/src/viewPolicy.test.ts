import { beforeEach, describe, expect, it } from "vitest";
import {
	chooseLanding,
	forgetSession,
	readHistoryHint,
	readLastConversation,
	readViewPref,
	writeHistoryHint,
	writeLastConversation,
	writeViewPref,
} from "./viewPolicy.js";

describe("chooseLanding", () => {
	it("the person's last choice wins on a running session", () => {
		for (const pref of ["terminal", "files", "git", "chat"] as const) {
			expect(chooseLanding({ pref, hasHistory: true, running: true })).toBe(pref);
			expect(chooseLanding({ pref, hasHistory: false, running: true })).toBe(pref);
		}
	});

	it("without a choice: Chat with history, else Terminal when running", () => {
		expect(chooseLanding({ pref: null, hasHistory: true, running: true })).toBe("chat");
		expect(chooseLanding({ pref: null, hasHistory: false, running: true })).toBe("terminal");
		expect(chooseLanding({ pref: null, hasHistory: null, running: true })).toBe("terminal");
	});

	it("stopped: Chat with history, else Files", () => {
		expect(chooseLanding({ pref: null, hasHistory: true, running: false })).toBe("chat");
		expect(chooseLanding({ pref: null, hasHistory: false, running: false })).toBe("files");
		expect(chooseLanding({ pref: null, hasHistory: null, running: false })).toBe("files");
	});

	it("stopped: a saved Terminal or Git falls back; Files and Chat are kept", () => {
		expect(chooseLanding({ pref: "terminal", hasHistory: true, running: false })).toBe("chat");
		expect(chooseLanding({ pref: "git", hasHistory: false, running: false })).toBe("files");
		expect(chooseLanding({ pref: "files", hasHistory: true, running: false })).toBe("files");
		expect(chooseLanding({ pref: "chat", hasHistory: false, running: false })).toBe("chat");
	});
});

describe("per-session memory", () => {
	beforeEach(() => localStorage.clear());

	it("round-trips the view, the history hint and the last conversation", () => {
		expect(readViewPref("s1")).toBeNull();
		writeViewPref("s1", "git");
		expect(readViewPref("s1")).toBe("git");
		expect(readViewPref("s2")).toBeNull();

		expect(readHistoryHint("s1")).toBeNull();
		writeHistoryHint("s1", true);
		expect(readHistoryHint("s1")).toBe(true);
		writeHistoryHint("s1", false);
		expect(readHistoryHint("s1")).toBe(false);

		expect(readLastConversation("s1")).toBeNull();
		writeLastConversation("s1", "conv-9");
		expect(readLastConversation("s1")).toBe("conv-9");
		writeLastConversation("s1", null);
		expect(readLastConversation("s1")).toBeNull();
	});

	it("ignores a stored value that is not a view", () => {
		localStorage.setItem("st.view.s1", "admin");
		expect(readViewPref("s1")).toBeNull();
	});

	it("forgetSession drops all three", () => {
		writeViewPref("s1", "chat");
		writeHistoryHint("s1", true);
		writeLastConversation("s1", "c");
		forgetSession("s1");
		expect(readViewPref("s1")).toBeNull();
		expect(readHistoryHint("s1")).toBeNull();
		expect(readLastConversation("s1")).toBeNull();
	});
});
