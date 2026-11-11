/**
 * composerText.test.ts — the client copy of the composer's text rules
 * (CONVERSATION.md §8.1.2) must agree with the backend's byte for byte: the
 * vectors here are the backend's.
 */
// Raw sources through Vite (the frontend has no Node types); the backend files are the reference.

import { describe, expect, it } from "vitest";
import backendText from "../../backend/src/conversation/composerText.ts?raw";
import backendLimits from "../../backend/src/conversation/limits.ts?raw";
import {
	countSegments,
	explainCode,
	L1_PROMPT_BYTES,
	normalizeText,
	SEGMENT_MAX_CHARS,
	SEGMENTS_MAX,
	validateText,
} from "./composerText.js";
import frontendText from "./composerText.ts?raw";

/** `export const NAME = <expr>;` from a source file, evaluated for `N`, `N * KiB` or `N * 1024`. */
function constant(src: string, name: string): number {
	const m = new RegExp(`^export const ${name} = ([^;]+);$`, "m").exec(src);
	if (!m) throw new Error(`${name} not found`);
	const expr = m[1]!.replace(/\bKiB\b/g, "1024").replace(/_/g, "");
	if (!/^[\d\s*]+$/.test(expr)) throw new Error(`${name}: unexpected expression ${m[1]}`);
	return expr.split("*").reduce((acc, f) => acc * Number(f.trim()), 1);
}

/** The text of `export function <name>(` up to its closing `}` at column 0. */
function fnSource(src: string, name: string): string {
	const m = new RegExp(`^export function ${name}\\([\\s\\S]*?^}$`, "m").exec(src);
	if (!m) throw new Error(`${name} not found`);
	return m[0];
}

describe("parity with backend/src/conversation/composerText.ts (the server decides)", () => {
	it("the limits are the backend's: 48 pastes of ≤ 800 code points, L1 = 64 KiB", () => {
		expect(SEGMENTS_MAX).toBe(constant(backendText, "SEGMENTS_MAX"));
		expect(SEGMENT_MAX_CHARS).toBe(constant(backendText, "SEGMENT_MAX_CHARS"));
		expect(L1_PROMPT_BYTES).toBe(constant(backendLimits, "L1_PROMPT_BYTES"));
		expect(SEGMENTS_MAX).toBe(48);
		// …and this file's own declarations are what it exports (no shadowing).
		expect(constant(frontendText, "SEGMENTS_MAX")).toBe(SEGMENTS_MAX);
	});
	it("normalizeText is the same source text", () => {
		expect(fnSource(frontendText, "normalizeText")).toBe(fnSource(backendText, "normalizeText"));
	});
});

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

describe("too-many-segments at the boundary (48 pastes)", () => {
	const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join("\n");
	it("48 lines pass, 49 are refused", () => {
		expect(validateText(lines(48))).toMatchObject({ ok: true, segments: 48 });
		expect(validateText(lines(49))).toEqual({ ok: false, code: "too-many-segments" });
	});
	it("empty lines cost no paste; trailing newlines are dropped before counting", () => {
		const spaced = Array.from({ length: 48 }, (_, i) => `l${i}`).join("\n\n\n");
		expect(validateText(spaced)).toMatchObject({ ok: true, segments: 48 });
		expect(validateText(`${lines(48)}\n\n\n`)).toMatchObject({ ok: true, segments: 48 });
		expect(validateText(lines(48).replace(/\n/g, "\r\n"))).toMatchObject({
			ok: true,
			segments: 48,
		});
	});
	it("a long line costs one paste per 800 code points", () => {
		expect(validateText("y".repeat(48 * 800))).toMatchObject({ ok: true, segments: 48 });
		expect(validateText("y".repeat(48 * 800 + 1))).toEqual({
			ok: false,
			code: "too-many-segments",
		});
		expect(validateText(`${"y".repeat(47 * 800)}\nz`)).toMatchObject({ ok: true, segments: 48 });
		expect(validateText(`${"y".repeat(47 * 800 + 1)}\nz`)).toEqual({
			ok: false,
			code: "too-many-segments",
		});
	});
	it("code points, not UTF-16 units: an astral character is one", () => {
		expect(countSegments("😀".repeat(800))).toBe(1);
		expect(countSegments("😀".repeat(801))).toBe(2);
	});
	it("size is checked before segments: 64 KiB of multibyte text is text-too-large", () => {
		// 49 × 800 × 4 bytes > 64 KiB: the server answers text-too-large first, so must we.
		expect(validateText("😀".repeat(49 * 800))).toEqual({ ok: false, code: "text-too-large" });
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

describe("explainCode needs-terminal: prompt not confirmed (#510)", () => {
	it("says nothing was sent and points at the Terminal, not at a dialog", () => {
		for (const d of ["status-unknown", "waiting-unspecified"]) {
			expect(explainCode("needs-terminal", d)).toBe(
				"Claude Code did not confirm it is waiting at its prompt, so nothing was sent. Check the Terminal.",
			);
		}
		expect(explainCode("needs-terminal", "dialog open")).toContain("dialog");
	});
});

describe("explainCode binding-stale detail", () => {
	it("names the process kind when the CLI runs the conversation outside the pane", () => {
		expect(explainCode("binding-stale", "kind:background")).toContain("background process");
		expect(explainCode("binding-stale")).toBe(
			"The conversation is no longer in the pane it was bound to.",
		);
	});
});
