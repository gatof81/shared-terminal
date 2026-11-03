// Raw sources through Vite (the frontend has no Node types); the backend file is the reference.

import { beforeEach, describe, expect, it } from "vitest";
import backendTitle from "../../backend/src/conversation/conversationTitle.ts?raw";
import type { ConversationSummary } from "./api.js";
import {
	displayTitle,
	explainMetaError,
	filterCounts,
	inFilter,
	MetaOverlay,
	metaOutcomeUnknown,
	readFilter,
	titleProblem,
	writeFilter,
} from "./chatMeta.js";
import frontendTitle from "./conversationTitle.ts?raw";

const conv = (p: Partial<ConversationSummary> = {}): ConversationSummary =>
	({
		sessionId: "c1",
		kind: "interactive",
		title: "auto title",
		customTitle: null,
		archivedAt: null,
		status: "ended",
		...p,
	}) as ConversationSummary;

describe("conversationTitle.ts is a byte-identical copy of the backend's", () => {
	it("identical bytes (CONVERSATION.md §6.2: keep the two files identical)", () => {
		expect(frontendTitle).toBe(backendTitle);
		expect(frontendTitle.length).toBeGreaterThan(500);
	});
});

describe("displayTitle", () => {
	it("the owner's name prevails, then the automatic one, then a generic", () => {
		expect(displayTitle(conv({ customTitle: "Mío" }))).toBe("Mío");
		expect(displayTitle(conv())).toBe("auto title");
		expect(displayTitle(conv({ title: null }))).toBe("Untitled conversation");
		expect(displayTitle(conv({ title: "  ", kind: "headless" }))).toBe("Headless run");
		// An older backend: no customTitle field at all.
		const old = conv();
		delete (old as Partial<ConversationSummary>).customTitle;
		expect(displayTitle(old)).toBe("auto title");
	});
});

describe("filters", () => {
	const archived = conv({ sessionId: "a", archivedAt: "2026-11-03T10:00:00.000Z" });
	const plain = conv({ sessionId: "p" });
	it("Active = not archived, plus archived that are live again; Archived = archived; All = all", () => {
		expect(inFilter(plain, "active", false)).toBe(true);
		expect(inFilter(archived, "active", false)).toBe(false);
		expect(inFilter(archived, "active", true)).toBe(true);
		expect(inFilter(archived, "archived", false)).toBe(true);
		expect(inFilter(plain, "archived", true)).toBe(false);
		expect(inFilter(archived, "all", false)).toBe(true);
	});
	it("counts, including archived-and-live", () => {
		const live = new Set(["a"]);
		const counts = filterCounts([archived, plain, conv({ sessionId: "b", archivedAt: "x" })], (c) =>
			live.has(c.sessionId),
		);
		expect(counts).toEqual({ active: 2, archived: 2, all: 3, archivedLive: 1 });
	});
});

describe("remembered filter", () => {
	beforeEach(() => localStorage.clear());
	it("defaults to Active, remembers a valid choice, ignores garbage", () => {
		expect(readFilter()).toBe("active");
		writeFilter("archived");
		expect(readFilter()).toBe("archived");
		localStorage.setItem("st.chat.filter", "evil");
		expect(readFilter()).toBe("active");
	});
});

describe("MetaOverlay", () => {
	it("a list response from a request that left before the answer keeps the answer; a later one retires it", () => {
		const o = new MetaOverlay();
		o.record(conv({ customTitle: "Nuevo", archivedAt: null }), 5);
		const stale = [conv({ customTitle: null })];
		o.apply(stale, 5);
		expect(stale[0]!.customTitle).toBe("Nuevo");
		const fresh = [conv({ customTitle: "Nuevo" })];
		o.apply(fresh, 6);
		// Retired: a still-older response (impossible order, defensive) is no longer overlaid.
		const after = [conv({ customTitle: null })];
		o.apply(after, 5);
		expect(after[0]!.customTitle).toBeNull();
	});
});

describe("words", () => {
	it("local title check mirrors the server codes", () => {
		expect(titleProblem("ok")).toBeNull();
		expect(titleProblem("x".repeat(81))).toMatch(/at most 80/);
		expect(titleProblem("a‮b")).toMatch(/control or text-direction/);
	});
	it("every server answer is explained, nothing says it worked when it did not", () => {
		for (const [status, code] of [
			[400, "invalid-title"],
			[400, "title-too-long"],
			[404, "conversation-not-found"],
			[503, "meta-unavailable"],
			[0, "network"],
			[429, ""],
			[500, ""],
		] as const) {
			const m = explainMetaError(status, code);
			expect(m.length).toBeGreaterThan(10);
			// Never a claim of success: "saved" only as "could not be saved" or "may have been saved".
			expect(m).not.toMatch(/(?<!be |been )saved\b/i);
		}
		// A write may have landed: never "nothing changed" for those.
		for (const [status, code] of [
			[0, "network"],
			[200, "unconfirmed"],
			[500, ""],
			[502, "x"],
		] as const) {
			expect(metaOutcomeUnknown(status, code)).toBe(true);
			expect(explainMetaError(status, code)).toMatch(/may have been saved/);
			expect(explainMetaError(status, code)).not.toMatch(/Nothing changed/);
		}
		// An explicit "could not store" is a definite refusal.
		expect(metaOutcomeUnknown(503, "meta-unavailable")).toBe(false);
		expect(metaOutcomeUnknown(400, "invalid-title")).toBe(false);
	});
});
