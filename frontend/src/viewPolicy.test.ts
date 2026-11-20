import { beforeEach, describe, expect, it } from "vitest";
import {
	chooseLanding,
	forgetAllLastConversationTitles,
	forgetSession,
	type LandingInput,
	landsByPolicy,
	readHistoryHint,
	readLastConversation,
	readLastConversationTitle,
	readViewPref,
	writeHistoryHint,
	writeLastConversation,
	writeLastConversationTitle,
	writeViewPref,
} from "./viewPolicy.js";

/** A traditional session under shell v2: the original rules. */
const V2 = { isAgent: false, shell: "v2" } as const;

describe("chooseLanding", () => {
	it("the person's last choice wins on a running session", () => {
		for (const pref of ["terminal", "files", "git", "chat"] as const) {
			expect(chooseLanding({ ...V2, pref, hasHistory: true, running: true })).toBe(pref);
			expect(chooseLanding({ ...V2, pref, hasHistory: false, running: true })).toBe(pref);
		}
	});

	it("without a choice: Chat with history, else Terminal when running", () => {
		expect(chooseLanding({ ...V2, pref: null, hasHistory: true, running: true })).toBe("chat");
		expect(chooseLanding({ ...V2, pref: null, hasHistory: false, running: true })).toBe("terminal");
		expect(chooseLanding({ ...V2, pref: null, hasHistory: null, running: true })).toBe("terminal");
	});

	it("stopped: Chat with history, else Files", () => {
		expect(chooseLanding({ ...V2, pref: null, hasHistory: true, running: false })).toBe("chat");
		expect(chooseLanding({ ...V2, pref: null, hasHistory: false, running: false })).toBe("files");
		expect(chooseLanding({ ...V2, pref: null, hasHistory: null, running: false })).toBe("files");
	});

	it("stopped: a saved Terminal or Git falls back; Files and Chat are kept", () => {
		expect(chooseLanding({ ...V2, pref: "terminal", hasHistory: true, running: false })).toBe(
			"chat",
		);
		expect(chooseLanding({ ...V2, pref: "git", hasHistory: false, running: false })).toBe("files");
		expect(chooseLanding({ ...V2, pref: "files", hasHistory: true, running: false })).toBe("files");
		expect(chooseLanding({ ...V2, pref: "chat", hasHistory: false, running: false })).toBe("chat");
	});
});

describe("chooseLanding — an ACP agent's session", () => {
	const agent = (o: Partial<LandingInput>): LandingInput => ({
		pref: null,
		hasHistory: null,
		running: true,
		isAgent: true,
		shell: "v2",
		...o,
	});

	it("lands on Chat in both shells, running or stopped, whatever the capture history says", () => {
		for (const shell of ["v1", "v2"] as const)
			for (const running of [true, false])
				for (const hasHistory of [true, false, null])
					expect(chooseLanding(agent({ shell, running, hasHistory }))).toBe("chat");
	});

	it("the view the person chose for it wins (in v1 too); a stopped one keeps only Files or Chat", () => {
		for (const shell of ["v1", "v2"] as const) {
			for (const pref of ["terminal", "files", "git", "chat"] as const)
				expect(chooseLanding(agent({ shell, pref }))).toBe(pref);
			expect(chooseLanding(agent({ shell, pref: "terminal", running: false }))).toBe("chat");
			expect(chooseLanding(agent({ shell, pref: "git", running: false }))).toBe("chat");
			expect(chooseLanding(agent({ shell, pref: "files", running: false }))).toBe("files");
		}
	});

	it("a traditional session in v1 keeps v1's landing: nothing remembered is read", () => {
		const v1 = { isAgent: false, shell: "v1" } as const;
		expect(chooseLanding({ ...v1, pref: "chat", hasHistory: true, running: true })).toBe(
			"terminal",
		);
		expect(chooseLanding({ ...v1, pref: "chat", hasHistory: true, running: false })).toBe("files");
		// Not known to be an agent's: the same.
		expect(
			chooseLanding({ pref: "chat", hasHistory: true, running: true, isAgent: null, shell: "v1" }),
		).toBe("terminal");
	});

	it("only v2, or a v1 session that is (or may be) an agent's, lands by the policy", () => {
		expect(landsByPolicy("v2", false)).toBe(true);
		expect(landsByPolicy("v2", null)).toBe(true);
		expect(landsByPolicy("v1", true)).toBe(true);
		expect(landsByPolicy("v1", null)).toBe(true);
		expect(landsByPolicy("v1", false)).toBe(false);
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

describe("last conversation title (sidebar link)", () => {
	beforeEach(() => localStorage.clear());
	it("is read back only for the conversation it was written for", () => {
		writeLastConversationTitle("s1", "c1", "Refactor auth");
		expect(readLastConversationTitle("s1", "c1")).toBe("Refactor auth");
		expect(readLastConversationTitle("s1", "c2")).toBeNull();
		expect(readLastConversationTitle("s2", "c1")).toBeNull();
	});
	it("keeps a title with newlines or colons intact", () => {
		writeLastConversationTitle("s1", "c1", "a: b\nc");
		expect(readLastConversationTitle("s1", "c1")).toBe("a: b\nc");
	});
	it("is dropped with the session's other memory", () => {
		writeLastConversationTitle("s1", "c1", "x");
		forgetSession("s1");
		expect(readLastConversationTitle("s1", "c1")).toBeNull();
	});
	it("logout forgets every stored title, and only those", () => {
		writeLastConversationTitle("s1", "c1", "x");
		writeLastConversationTitle("s2", "c9", "y");
		writeLastConversation("s1", "c1");
		forgetAllLastConversationTitles();
		expect(readLastConversationTitle("s1", "c1")).toBeNull();
		expect(readLastConversationTitle("s2", "c9")).toBeNull();
		expect(readLastConversation("s1")).toBe("c1");
	});
});
