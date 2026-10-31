/**
 * composerText.test.ts — the client copy of the composer's text rules
 * (CONVERSATION.md §8.1.2) must agree with the backend's byte for byte: the
 * vectors here are the backend's.
 */
import { describe, expect, it } from "vitest";
import { countSegments, explainCode, normalizeText, validateText } from "./composerText.js";

describe("normalizeText (mirror of backend/src/conversation/composerText.ts)", () => {
	it("CR/CRLF → LF, tab → 4 spaces, trailing blanks and trailing newlines dropped; idempotent", () => {
		expect(normalizeText("a  \r\nb\t c   \r\n  indented\n\n")).toBe("a\nb     c\n  indented");
		expect(normalizeText("  spaced  ")).toBe("  spaced");
		const n = normalizeText("line one\nline two\n\nline four");
		expect(normalizeText(n)).toBe(n);
	});
});

describe("validateText", () => {
	it("accepts text and counts pastes per line and per 800 code points", () => {
		expect(validateText("hello\nworld")).toEqual({
			ok: true,
			normalized: "hello\nworld",
			bytes: 11,
			segments: 2,
		});
		expect(countSegments("y".repeat(1800))).toBe(3);
	});
	it("rejects empty, oversize, control bytes, a leading / or !, and too many segments", () => {
		expect(validateText("  \n")).toEqual({ ok: false, code: "empty-text" });
		expect(validateText("x".repeat(64 * 1024 + 1))).toEqual({ ok: false, code: "text-too-large" });
		expect(validateText("a\u001b[13;2u")).toEqual({ ok: false, code: "control-bytes" });
		expect(validateText("/help")).toEqual({ ok: false, code: "unsupported-prefix" });
		expect(validateText(" !ls")).toEqual({ ok: false, code: "unsupported-prefix" });
		expect(validateText("ok\n/help").ok).toBe(true);
		expect(validateText(Array.from({ length: 257 }, (_, i) => `l${i}`).join("\n"))).toEqual({
			ok: false,
			code: "too-many-segments",
		});
	});
});

describe("explainCode", () => {
	it("gives a sentence for every server code and a generic one otherwise", () => {
		expect(explainCode("unsupported-prefix")).toMatch(/cannot start with/);
		expect(explainCode("send-in-progress", "effects-pending")).toMatch(/blocked/);
		expect(explainCode("needs-terminal", "copy-mode")).toMatch(/copy mode/);
		expect(explainCode("needs-terminal", "foreground:bash")).toMatch(/foreground/);
		expect(explainCode("delivery-failed")).toMatch(/check the Terminal/i);
		expect(explainCode("something-new")).toBe("Send refused (something-new).");
	});
});
