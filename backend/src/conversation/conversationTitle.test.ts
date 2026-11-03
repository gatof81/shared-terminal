/**
 * conversation/conversationTitle.test.ts — CONVERSATION.md §6.2 title rules.
 */

import { describe, expect, it } from "vitest";
import { normalizeTitle, TITLE_MAX_CODE_POINTS } from "./conversationTitle.js";

describe("normalizeTitle", () => {
	it.each([
		["plain", "Plan de migración", "Plan de migración"],
		["trims and collapses inner whitespace", "  Plan   de  migración  ", "Plan de migración"],
		["NFC (decomposed é composed)", "Migración", "Migración"],
		["U+2028 counts as whitespace", "a b", "a b"],
		["emoji and CJK are fine", "🚀 部署 v2", "🚀 部署 v2"],
	])("%s", (_name, raw, want) => {
		expect(normalizeTitle(raw)).toEqual({ ok: true, value: want });
	});

	it("null, empty and whitespace-only clear the title", () => {
		for (const raw of [null, "", "   ", " 　"])
			expect(normalizeTitle(raw)).toEqual({ ok: true, value: null });
	});

	it.each([
		["tab", "a\tb"],
		["newline", "a\nb"],
		["NUL", "a\u0000b"],
		["DEL", "a\u007fb"],
		["C1", "a\u0085b"],
		["RLO override", "abc‮def"],
		["LRI isolate", "⁦x"],
		["RLM mark", "x‏"],
		["lone high surrogate", "a\ud800b"],
		["lone low surrogate", "a\udc00"],
	])("refuses %s", (_name, raw) => {
		expect(normalizeTitle(raw)).toEqual({ ok: false, code: "invalid-title" });
	});

	it("refuses non-strings other than null", () => {
		for (const raw of [undefined, 1, true, {}, ["x"]])
			expect(normalizeTitle(raw)).toEqual({ ok: false, code: "invalid-title" });
	});

	it("caps at 80 code points (not UTF-16 units) and never truncates", () => {
		expect(TITLE_MAX_CODE_POINTS).toBe(80);
		expect(normalizeTitle("x".repeat(80))).toEqual({ ok: true, value: "x".repeat(80) });
		expect(normalizeTitle("x".repeat(81))).toEqual({ ok: false, code: "title-too-long" });
		// 80 astral characters = 160 UTF-16 units: still within the cap.
		expect(normalizeTitle("😀".repeat(80))).toEqual({ ok: true, value: "😀".repeat(80) });
		expect(normalizeTitle("😀".repeat(81))).toEqual({ ok: false, code: "title-too-long" });
		// Measured after normalisation: surrounding spaces do not count.
		expect(normalizeTitle(`  ${"x".repeat(80)}  `)).toEqual({ ok: true, value: "x".repeat(80) });
	});
});
