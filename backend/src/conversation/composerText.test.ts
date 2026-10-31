/**
 * composerText.test.ts — CONVERSATION.md §8.1.2 (normalize, validation),
 * §8.1.5 (segmentation and argv shapes) and the input-region check of
 * §8.1.3, pinned byte for byte. The vectors come from the §8.2 lab with
 * CLI 2.1.314.
 */

import { describe, expect, it } from "vitest";
import {
	ancestryArgv,
	CSI_U_NEWLINE,
	captureArgv,
	inputRegion,
	normalizeText,
	paneStateArgv,
	parsePaneState,
	SEGMENT_MAX_CHARS,
	SEGMENTS_MAX,
	segment,
	stepArgv,
	textHash,
	validateBody,
	validateText,
} from "./composerText.js";
import { L1_PROMPT_BYTES } from "./limits.js";

describe("normalizeText (§8.1.2, §8.2.4)", () => {
	it("maps CR/CRLF to LF, tab to 4 spaces, drops trailing blanks per line and trailing newlines", () => {
		expect(normalizeText("a  \r\nb\t c   \r\n  indented\n\n")).toBe("a\nb     c\n  indented");
		expect(normalizeText("col1\tcol2 end")).toBe("col1    col2 end");
		expect(normalizeText("  spaced  ")).toBe("  spaced");
		expect(normalizeText("tail nl\n")).toBe("tail nl");
	});
	it("is idempotent and keeps blank lines inside the text", () => {
		const n = normalizeText("line one\nline two\n\nline four");
		expect(normalizeText(n)).toBe(n);
		expect(n).toBe("line one\nline two\n\nline four");
	});
	it("hashes the normalized text", () => {
		expect(textHash("x")).toMatch(/^[0-9a-f]{64}$/);
		expect(textHash(normalizeText("a \n"))).toBe(textHash("a"));
	});
});

describe("validateText / validateBody (§8.1.2)", () => {
	it("accepts a plain message and counts its pastes", () => {
		const v = validateText("hello\nworld");
		expect(v).toEqual({ ok: true, normalized: "hello\nworld", bytes: 11, segments: 2 });
	});
	it("rejects empty, oversize, control bytes and ESC anywhere", () => {
		expect(validateText("   \n\n")).toEqual({ ok: false, code: "empty-text" });
		expect(validateText("x".repeat(L1_PROMPT_BYTES + 1))).toEqual({
			ok: false,
			code: "text-too-large",
		});
		expect(validateText("a\u0007b")).toEqual({ ok: false, code: "control-bytes" });
		expect(validateText("a\u007fb")).toEqual({ ok: false, code: "control-bytes" });
		expect(validateText(`ok${CSI_U_NEWLINE}more`)).toEqual({ ok: false, code: "control-bytes" });
	});
	it("rejects a leading / or ! (after leading blanks) but accepts them on later lines (§8.2.3)", () => {
		expect(validateText("/help")).toEqual({ ok: false, code: "unsupported-prefix" });
		expect(validateText("  !echo hi")).toEqual({ ok: false, code: "unsupported-prefix" });
		expect(validateText("first\n!echo hi\n/help").ok).toBe(true);
		expect(validateText("a/b !c").ok).toBe(true);
	});
	it("rejects more than SEGMENTS_MAX pastes", () => {
		const lines = Array.from({ length: SEGMENTS_MAX + 1 }, (_, i) => `l${i}`).join("\n");
		expect(validateText(lines)).toEqual({ ok: false, code: "too-many-segments" });
	});
	it("validateBody: shape and UUID v4, lowercased", () => {
		expect(validateBody(null)).toEqual({ ok: false, code: "invalid-body" });
		expect(validateBody({ text: "x" })).toEqual({ ok: false, code: "invalid-body" });
		expect(validateBody({ text: "x", clientMessageId: "nope" })).toEqual({
			ok: false,
			code: "invalid-body",
		});
		const id = "4F2A9C7E-1B3D-4E5F-8A6B-9C0D1E2F3A4B";
		expect(validateBody({ text: "x", clientMessageId: id })).toEqual({
			ok: true,
			normalized: "x",
			bytes: 1,
			segments: 1,
			clientMessageId: id.toLowerCase(),
		});
	});
});

describe("segment + stepArgv (§8.1.5)", () => {
	it("one paste per line, chunks of ≤ 800 code points, CSI u between lines, one Enter", () => {
		const long = "y".repeat(1800);
		const plan = segment(`first\n\n${long}`);
		expect(plan.lines).toBe(3);
		expect(plan.pastes).toBe(4);
		expect(plan.steps.map((s) => s.kind)).toEqual([
			"paste",
			"newline",
			"newline",
			"paste",
			"paste",
			"paste",
			"enter",
		]);
		const chunks = plan.steps
			.filter((s) => s.kind === "paste")
			.map((s) => (s as { text: string }).text.length);
		expect(chunks).toEqual([5, 800, 800, 200]);
	});
	it("never splits a surrogate pair", () => {
		const text = `${"a".repeat(SEGMENT_MAX_CHARS - 1)}😀b`;
		const plan = segment(text);
		const first = (plan.steps[0] as { text: string }).text;
		expect(first.endsWith("😀")).toBe(true);
		expect((plan.steps[1] as { text: string }).text).toBe("b");
	});
	it("argv shapes: fixed, the text only on stdin, the pane from the binding", () => {
		expect(
			stepArgv({ kind: "paste", text: "ignored", line: 0, chunk: 0 }, "%3", "st-abc-0"),
		).toEqual([
			"timeout",
			"-k",
			"2",
			"5",
			"tmux",
			"load-buffer",
			"-b",
			"st-abc-0",
			"-",
			";",
			"paste-buffer",
			"-p",
			"-d",
			"-b",
			"st-abc-0",
			"-t",
			"%3",
		]);
		expect(stepArgv({ kind: "newline", line: 1 }, "%3", "x")).toEqual([
			"timeout",
			"-k",
			"2",
			"5",
			"tmux",
			"send-keys",
			"-t",
			"%3",
			"-l",
			"\u001b[13;2u",
		]);
		expect(stepArgv({ kind: "enter" }, "%3", "x")).toEqual([
			"timeout",
			"-k",
			"2",
			"5",
			"tmux",
			"send-keys",
			"-t",
			"%3",
			"Enter",
		]);
		expect(paneStateArgv("%3").slice(4)).toEqual([
			"tmux",
			"display",
			"-p",
			"-t",
			"%3",
			"#{pane_pid} #{pane_in_mode} #{pane_dead} #{pane_current_command}",
		]);
		expect(captureArgv("%3").slice(4)).toEqual([
			"tmux",
			"capture-pane",
			"-p",
			"-e",
			"-t",
			"%3",
			"-S",
			"-200",
		]);
		expect(ancestryArgv(733, 700).slice(-3)).toEqual(["st-ancestry", "733", "700"]);
	});
	it("parsePaneState reads the display line and refuses anything else", () => {
		expect(parsePaneState("700 0 0 claude\n")).toEqual({
			panePid: 700,
			inMode: false,
			dead: false,
			command: "claude",
		});
		expect(parsePaneState("700 1 0 node")).toEqual({
			panePid: 700,
			inMode: true,
			dead: false,
			command: "node",
		});
		expect(parsePaneState("can't find pane")).toBeNull();
		expect(parsePaneState("")).toBeNull();
	});
});

describe("inputRegion (§8.1.3 composer-not-empty)", () => {
	const RULE = "─".repeat(60);
	const DIM = "\u001b[2m";
	const RESET = "\u001b[0m";
	it("empty input line ⇒ empty", () => {
		expect(inputRegion(`history line\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ auto mode on`)).toEqual({
			kind: "empty",
		});
	});
	it("ghost suggestion rendered dim ⇒ empty; typed (unstyled) text ⇒ text", () => {
		expect(inputRegion(`${RULE}\n❯ ${DIM}Try "fix typecheck errors"${RESET}\n${RULE}\n`)).toEqual({
			kind: "empty",
		});
		expect(inputRegion(`${RULE}\n❯ partial\n${RULE}\n`)).toEqual({ kind: "text" });
		expect(inputRegion(`${RULE}\n❯ \n  second line typed\n${RULE}\n`)).toEqual({ kind: "text" });
	});
	it("the last marker wins; scrollback above it never counts", () => {
		expect(inputRegion(`❯ old prompt\n● OK\n${RULE}\n❯ \n${RULE}\n`)).toEqual({ kind: "empty" });
	});
	it("no marker or no closing rule ⇒ unknown (fail closed)", () => {
		expect(inputRegion("just output\nmore")).toEqual({
			kind: "unknown",
			reason: "no-prompt-marker",
		});
		expect(inputRegion(`${RULE}\n❯ \n  ⏵⏵ auto mode`)).toEqual({
			kind: "unknown",
			reason: "no-closing-rule",
		});
	});
	it("a marker wrapped in attributes is still the marker", () => {
		expect(inputRegion(`${RULE}\n\u001b[1m❯${RESET} \n${RULE}\n`)).toEqual({ kind: "empty" });
	});
});

describe("inputRegion SGR handling (§8.1.3)", () => {
	const RULE = "─".repeat(20);
	it("a run that only ends an attribute (22m, 39m) leaves the following text typed; dim ghost stays empty", () => {
		expect(inputRegion(`${RULE}\n❯ \u001b[2mTry "fix the tests"\u001b[22m\n${RULE}\n`)).toEqual({
			kind: "empty",
		});
		expect(inputRegion(`${RULE}\n❯ \u001b[2m\u001b[22mhello\n${RULE}\n`)).toEqual({ kind: "text" });
		expect(inputRegion(`${RULE}\n\u001b[39m❯ \u001b[38;5;244m\u001b[39mtyped\n${RULE}\n`)).toEqual({
			kind: "text",
		});
		expect(
			inputRegion(`${RULE}\n❯ \u001b[38;2;10;20;30mghost\u001b[0m \u001b[7m \u001b[0m\n${RULE}\n`),
		).toEqual({ kind: "empty" });
	});
});
