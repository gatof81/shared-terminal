/**
 * composerText.test.ts — CONVERSATION.md §8.1.2 (normalize, validation),
 * §8.1.5 (segmentation and argv shapes) and the input-region check of
 * §8.1.3, pinned byte for byte. The vectors come from the §8.2 lab with
 * CLI 2.1.314.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	ancestryArgv,
	CSI_U_NEWLINE,
	captureArgv,
	foregroundFault,
	inputRegion,
	isClaudeExe,
	normalizeText,
	PANE_FACTS_SCRIPT,
	paneFactsArgv,
	paneStateArgv,
	parsePaneFacts,
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

describe("foreground identity (§8.1.3 needs-terminal, foreground)", () => {
	const facts = (over: { p?: string; t?: string; a?: string; e?: string; d?: string } = {}) =>
		[
			`D ${over.d ?? "700 0 0 2.1.316"}`,
			`P ${over.p ?? "733 S 700 733 700 34817 733 1000"}`,
			`T ${over.t ?? "700 S 119 700 700 34817 733 900"}`,
			`A ${over.a ?? "yes"}`,
			`E ${over.e ?? "/home/developer/.local/share/claude/versions/2.1.316"}`,
			"",
		].join("\n");
	it("paneFactsArgv: fixed argv, the pane and the pid as positional arguments, never in the script", () => {
		expect(paneFactsArgv("%3", 733).slice(-3)).toEqual(["st-pane-facts", "%3", "733"]);
		expect(paneFactsArgv("%3", 733)[6]).toBe(PANE_FACTS_SCRIPT);
	});
	it("parsePaneFacts: exactly five well-formed lines, in order; anything else ⇒ null", () => {
		const f = parsePaneFacts(facts());
		expect(f?.pane).toEqual({ panePid: 700, inMode: false, dead: false, command: "2.1.316" });
		expect(f?.proc).toEqual({
			pid: 733,
			state: "S",
			ppid: 700,
			pgrp: 733,
			sid: 700,
			tty: 34817,
			tpgid: 733,
			start: "1000",
		});
		expect(f?.ancestry).toBe(true);
		for (const bad of [
			"",
			facts().split("\n").slice(0, 4).join("\n"), // missing E
			facts({ p: "733 S 700 733 700 34817 733" }), // missing start time
			facts({ a: "maybe" }),
			facts({ e: "relative/path" }),
			facts({ d: "can't find pane" }),
			facts().replace("P 733", "T 733"), // lines out of order
			`${facts()}extra\n`,
		]) {
			expect(parsePaneFacts(bad)).toBeNull();
		}
	});
	it("isClaudeExe: npm, node, native (also replaced by an update); nothing else", () => {
		for (const ok of [
			"/home/developer/workspace/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
			"/home/developer/.npm-global/bin/claude",
			"/usr/bin/node",
			"/home/developer/.local/share/claude/versions/2.1.316",
			"/home/developer/.local/share/claude/versions/2.1.220 (deleted)",
			"/home/developer/workspace/.npm-global/lib/node_modules/@anthropic-ai/.claude-code-w1jVs9XG/bin/claude.exe (deleted)",
		])
			expect(isClaudeExe(ok)).toBe(true);
		for (const no of [
			"/usr/bin/bash",
			"/usr/bin/vim",
			"/home/developer/.local/share/other/2.1.316",
			"/tmp/2.1.316",
			"/home/developer/claude.sh",
		])
			expect(isClaudeExe(no)).toBe(false);
	});
	it("foregroundFault: each condition refuses on its own", () => {
		const f = (o = {}) =>
			parsePaneFacts(facts(o)) as NonNullable<ReturnType<typeof parsePaneFacts>>;
		expect(foregroundFault(f(), 733)).toBeNull();
		expect(foregroundFault(f(), 734)).toBe("mismatch");
		expect(foregroundFault(f({ e: "/usr/bin/bash" }), 733)).toBe("identity");
		expect(foregroundFault(f({ p: "733 T 700 733 700 34817 733 1000" }), 733)).toBe("state");
		expect(foregroundFault(f({ p: "733 Z 700 733 700 34817 733 1000" }), 733)).toBe("state");
		expect(foregroundFault(f({ p: "733 S 700 733 1 34817 733 1000" }), 733)).toBe("session");
		expect(foregroundFault(f({ t: "700 S 119 700 119 34817 733 900" }), 733)).toBe("session");
		expect(foregroundFault(f({ p: "733 S 700 733 700 34818 733 1000" }), 733)).toBe("tty");
		expect(
			foregroundFault(
				f({ p: "733 S 700 733 700 0 -1 1000", t: "700 S 119 700 700 0 -1 900" }),
				733,
			),
		).toBe("tty");
		expect(foregroundFault(f({ p: "733 S 700 700 700 34817 700 1000" }), 733)).toBe("group");
		expect(
			foregroundFault(
				f({ p: "733 S 700 733 700 34817 700 1000", t: "700 S 119 700 700 34817 700 900" }),
				733,
			),
		).toBe("not-foreground");
		expect(foregroundFault(f({ t: "700 S 119 700 700 34817 999 900" }), 733)).toBe(
			"not-foreground",
		);
	});

	// The real script against a real tmux pane and /proc on this host (skipped where tmux is missing).
	const hasTmux = spawnSync("tmux", ["-V"]).status === 0 && existsSync("/proc/self/stat");
	it.skipIf(!hasTmux)(
		"PANE_FACTS_SCRIPT on a real tmux pane: a native-named binary in the foreground passes; a background job, a gone process and a foreground child in its own group do not",
		() => {
			const dir = mkdtempSync(path.join(os.tmpdir(), "st-facts-"));
			const sock = `st-facts-${process.pid}`;
			const tmux = (...a: string[]) =>
				execFileSync("tmux", ["-L", sock, ...a], { encoding: "utf8" });
			let restorePath = () => {};
			try {
				// A "native install": a copy of a real binary under …/claude/versions/<X.Y.Z>, as the installer lays it out.
				const vdir = path.join(dir, ".local/share/claude/versions");
				mkdirSync(vdir, { recursive: true });
				const native = path.join(vdir, "2.1.316");
				copyFileSync("/usr/bin/sleep", native);
				chmodSync(native, 0o755);
				tmux(
					"-f",
					"/dev/null",
					"new-session",
					"-d",
					"-s",
					"t",
					"-x",
					"80",
					"-y",
					"20",
					"bash --norc --noprofile -i",
				);
				const pane = tmux("display", "-p", "-t", "t", "#{pane_id}").trim();
				const read = (pid: number) => {
					const r = spawnSync(
						"bash",
						["-c", PANE_FACTS_SCRIPT, "st-pane-facts", pane, String(pid)],
						{
							encoding: "utf8",
							env: { ...process.env, TMUX: "", TMUX_TMPDIR: process.env.TMUX_TMPDIR },
						},
					);
					return r.status === 0 ? parsePaneFacts(r.stdout.replace(/^/, "")) : null;
				};
				const wait = (cond: () => boolean) => {
					for (let i = 0; i < 100 && !cond(); i++) spawnSync("sleep", ["0.05"]);
				};
				// The script talks to the default tmux socket; point it at ours through a wrapper on PATH.
				const bin = path.join(dir, "bin");
				mkdirSync(bin);
				require("node:fs").writeFileSync(
					path.join(bin, "tmux"),
					`#!/bin/sh\nexec ${execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim()} -L ${sock} "$@"\n`,
					{ mode: 0o755 },
				);
				const savedPath = process.env.PATH;
				process.env.PATH = `${bin}:${process.env.PATH}`;
				restorePath = () => {
					process.env.PATH = savedPath;
				};
				// 1. the native-named binary in the foreground
				tmux("send-keys", "-t", pane, `${native} 300`, "Enter");
				let pid = 0;
				wait(() => {
					const out = spawnSync("pgrep", ["-f", `${native} 300`], {
						encoding: "utf8",
					}).stdout.trim();
					pid = Number(out.split("\n")[0] || 0);
					return pid > 0;
				});
				wait(
					() => tmux("display", "-p", "-t", pane, "#{pane_current_command}").trim() === "2.1.316",
				);
				const fg = read(pid);
				expect(fg).not.toBeNull();
				expect(fg?.pane.command).toBe("2.1.316");
				expect(fg?.ancestry).toBe(true);
				expect(fg && foregroundFault(fg, pid)).toBeNull();
				// 2. back at the shell: the same process is gone ⇒ unreadable ⇒ fail closed; a background job ⇒ not-foreground
				tmux("send-keys", "-t", pane, "C-c", "");
				wait(() => tmux("display", "-p", "-t", pane, "#{pane_current_command}").trim() === "bash");
				expect(read(pid)).toBeNull();
				tmux("send-keys", "-t", pane, `${native} 301 &`, "Enter");
				let bg = 0;
				wait(() => {
					bg = Number(
						spawnSync("pgrep", ["-f", `${native} 301`], { encoding: "utf8" })
							.stdout.trim()
							.split("\n")[0] || 0,
					);
					return bg > 0;
				});
				const back = read(bg);
				expect(back).not.toBeNull();
				expect(back && foregroundFault(back, bg)).toBe("not-foreground");
				// 3. a foreground child in its own group: a native-named job-control shell (a copy of bash under
				// …/claude/versions/2.1.315) owns the terminal, then runs a job that takes it over.
				const native2 = path.join(vdir, "2.1.315");
				copyFileSync("/bin/bash", native2);
				chmodSync(native2, 0o755);
				tmux("send-keys", "-t", pane, `kill %1; ${native2} --norc --noprofile -i`, "Enter");
				let owner = 0;
				wait(() => {
					owner = Number(
						spawnSync("pgrep", ["-f", `^${native2} --norc`], { encoding: "utf8" })
							.stdout.trim()
							.split("\n")[0] || 0,
					);
					return (
						owner > 0 &&
						tmux("display", "-p", "-t", pane, "#{pane_current_command}").trim() === "2.1.315"
					);
				});
				const before = read(owner);
				expect(before).not.toBeNull();
				expect(before && foregroundFault(before, owner)).toBeNull();
				tmux("send-keys", "-t", pane, "sleep 303", "Enter");
				wait(() => tmux("display", "-p", "-t", pane, "#{pane_current_command}").trim() === "sleep");
				const after = read(owner);
				expect(after).not.toBeNull();
				expect(after?.ancestry).toBe(true);
				expect(after && foregroundFault(after, owner)).toBe("not-foreground");
			} finally {
				restorePath();
				spawnSync("tmux", ["-L", sock, "kill-server"]);
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
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
