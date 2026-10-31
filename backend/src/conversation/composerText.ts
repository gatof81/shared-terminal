/**
 * conversation/composerText.ts — the pure half of the 3.2 composer
 * (docs/CONVERSATION.md §8.1.2, §8.1.5, §8.1.3 "región de entrada").
 *
 * Everything here is a function of its input: the reference `normalize`,
 * the 400-level validation, the segmentation into tmux pastes, the input
 * region check over a `capture-pane -e` dump, and the constants the
 * contract fixes. No I/O, so the tests pin behaviour byte for byte and the
 * frontend can carry an identical copy of `normalizeText` and
 * `validateText` (frontend/src/composerText.ts) to explain a rejection
 * before the request leaves the browser — the server decides.
 *
 * Why the shape is what it is (§8.2, CLI 2.1.314): a bracketed paste with
 * a newline, or longer than ~800 characters, is wrapped by the CLI as
 * `<pasted_content>` and stops being the person's words; without `-p`
 * every `\n` is an Enter; Shift+Enter in CSI u form inserts a newline byte
 * for byte; the first character `/` or `!` switches the CLI into a mode
 * that produces no `UserPromptSubmit` at all.
 */

import { createHash } from "node:crypto";
import { L1_PROMPT_BYTES } from "./limits.js";

// ── Constants (§8.1) ────────────────────────────────────────────────────────

/** Longest single paste that the CLI does not wrap (800 ok, 850 wrapped — §8.2.3). */
export const SEGMENT_MAX_CHARS = 800;
/** Upper bound on pastes per message (§8.1.2 `too-many-segments`). */
/**
 * Pastes per message. Each paste costs ≥ 3 execs (paste, ≥ 1 consumption
 * poll, newline) and T_http is 30 s (§8.1.4): past this many a delivery
 * would deterministically die mid-way with text in the input, so it is
 * refused up front with nothing sent (contract v1.7.1).
 */
export const SEGMENTS_MAX = 48;
/** HTTP budget: past it the POST answers `uncertain` and the operation goes on (§8.1.4). */
export const T_HTTP_MS = 30_000;
/** Confirmation budget after a SETTLED Enter (§8.1.7). */
export const T_ACK_MS = 8_000;
/** Per-exec in-container bound (`timeout -k 2 <s>`), seconds. */
export const EXEC_TIMEOUT_S = 5;
/** Ids kept per conversation for idempotency replay, released operations only (§8.1.4 rule 10). */
export const IDEMPOTENCY_WINDOW = 256;
/** Shift+Enter in CSI u encoding: the CLI inserts a newline (§8.2.3). */
export const CSI_U_NEWLINE = "\u001b[13;2u";
/** The versions §8.2 was run against; `COMPOSER_CLI_VERSIONS` overrides. */
export const DEFAULT_CLI_VERSIONS: readonly string[] = ["2.1.314"];

export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const PANE_ID_RE = /^%\d{1,9}$/;

// ── normalize (§8.1.2) ──────────────────────────────────────────────────────

/**
 * The reference normalisation, applied to the text before it is sent and
 * to both sides of the ack comparison. It reproduces what the CLI does to
 * a paste on its own (§8.2.4): CR and CRLF become LF, a tab becomes four
 * spaces, trailing blanks on a line are dropped, trailing newlines are
 * dropped. Idempotent.
 */
export function normalizeText(s: string): string {
	return s
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((l) => l.replace(/\t/g, "    ").replace(/[ \t]+$/, ""))
		.join("\n")
		.replace(/\n+$/, "");
}

/** SHA-256 hex of the normalised text — the only trace of the text that is persisted. */
export function textHash(normalized: string): string {
	return createHash("sha256").update(normalized, "utf8").digest("hex");
}

// ── Validation (§8.1.2) ─────────────────────────────────────────────────────

export type TextRejection =
	| "invalid-body"
	| "empty-text"
	| "text-too-large"
	| "control-bytes"
	| "unsupported-prefix"
	| "too-many-segments";

export type TextValidation =
	| { ok: true; normalized: string; bytes: number; segments: number }
	| { ok: false; code: TextRejection };

/**
 * Validate a request body. Order matters only for which code a doubly
 * invalid text gets; every rejection means "no effect".
 */
export function validateBody(body: unknown): TextValidation & { clientMessageId?: string } {
	if (!body || typeof body !== "object" || Array.isArray(body))
		return { ok: false, code: "invalid-body" };
	const { text, clientMessageId } = body as { text?: unknown; clientMessageId?: unknown };
	if (
		typeof text !== "string" ||
		typeof clientMessageId !== "string" ||
		!UUID_V4_RE.test(clientMessageId)
	) {
		return { ok: false, code: "invalid-body" };
	}
	const v = validateText(text);
	return v.ok ? { ...v, clientMessageId: clientMessageId.toLowerCase() } : v;
}

export function validateText(text: string): TextValidation {
	const normalized = normalizeText(text);
	const bytes = Buffer.byteLength(normalized, "utf8");
	if (bytes === 0) return { ok: false, code: "empty-text" };
	if (bytes > L1_PROMPT_BYTES) return { ok: false, code: "text-too-large" };
	// Any C0 control other than `\n` (tabs are already spaces), DEL, or ESC
	// anywhere: the client never sends keys, and ESC[13;2u is a key.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them
	if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(normalized))
		return { ok: false, code: "control-bytes" };
	const first = normalized.replace(/^\s+/, "")[0];
	if (first === "/" || first === "!") return { ok: false, code: "unsupported-prefix" };
	const plan = segment(normalized);
	if (plan.pastes > SEGMENTS_MAX) return { ok: false, code: "too-many-segments" };
	return { ok: true, normalized, bytes, segments: plan.pastes };
}

// ── Segmentation (§8.1.5) ───────────────────────────────────────────────────

export type DeliveryStep =
	| { kind: "paste"; text: string; line: number; chunk: number }
	| { kind: "newline"; line: number }
	| { kind: "enter" };

export interface DeliveryPlan {
	steps: DeliveryStep[];
	/** Number of `paste` steps. */
	pastes: number;
	lines: number;
}

/**
 * Lines split on `\n`; each line cut into chunks of at most
 * SEGMENT_MAX_CHARS code points (never inside a surrogate pair); a CSI u
 * newline between lines (an empty line is two in a row); one Enter at
 * the end. The CLI decides to wrap per paste, so consecutive chunks of
 * one long line land as plain text (§8.2.3).
 */
export function segment(normalized: string): DeliveryPlan {
	const lines = normalized.split("\n");
	const steps: DeliveryStep[] = [];
	let pastes = 0;
	lines.forEach((line, li) => {
		if (li > 0) steps.push({ kind: "newline", line: li });
		const cps = Array.from(line);
		for (let i = 0, chunk = 0; i < cps.length; i += SEGMENT_MAX_CHARS, chunk++) {
			steps.push({
				kind: "paste",
				text: cps.slice(i, i + SEGMENT_MAX_CHARS).join(""),
				line: li,
				chunk,
			});
			pastes++;
		}
	});
	steps.push({ kind: "enter" });
	return { steps, pastes, lines: lines.length };
}

/** The exact argv of each step (fixed shapes; the text travels on stdin). */
export function stepArgv(step: DeliveryStep, paneId: string, bufferName: string): string[] {
	const t = ["timeout", "-k", "2", String(EXEC_TIMEOUT_S)];
	switch (step.kind) {
		case "paste":
			return [
				...t,
				"tmux",
				"load-buffer",
				"-b",
				bufferName,
				"-",
				";",
				"paste-buffer",
				"-p",
				"-d",
				"-b",
				bufferName,
				"-t",
				paneId,
			];
		case "newline":
			return [...t, "tmux", "send-keys", "-t", paneId, "-l", CSI_U_NEWLINE];
		case "enter":
			return [...t, "tmux", "send-keys", "-t", paneId, "Enter"];
	}
}

/** `display -p` for the pane state read in the precondition and the precheck. */
export function paneStateArgv(paneId: string): string[] {
	return [
		"timeout",
		"-k",
		"2",
		String(EXEC_TIMEOUT_S),
		"tmux",
		"display",
		"-p",
		"-t",
		paneId,
		"#{pane_pid} #{pane_in_mode} #{pane_dead} #{pane_current_command}",
	];
}

export interface PaneState {
	panePid: number;
	inMode: boolean;
	dead: boolean;
	command: string;
}

export function parsePaneState(stdout: string): PaneState | null {
	const m = stdout.trim().match(/^(\d+) ([01]) ([01]) (\S+)$/);
	if (!m) return null;
	return { panePid: Number(m[1]), inMode: m[2] === "1", dead: m[3] === "1", command: m[4] };
}

/**
 * Lines of the pane (history included) read for the input region. The
 * CLI's input box grows with the message, so the prompt marker can sit well
 * above the last rows; the parser takes the LAST marker line anyway.
 */
export const CAPTURE_LINES = 200;
export function captureArgv(paneId: string): string[] {
	return [
		"timeout",
		"-k",
		"2",
		String(EXEC_TIMEOUT_S),
		"tmux",
		"capture-pane",
		"-p",
		"-e",
		"-t",
		paneId,
		"-S",
		`-${CAPTURE_LINES}`,
	];
}

/**
 * Is the descendant chain from `pid` reaching `panePid`? Walks ppid in
 * /proc; prints `yes`/`no`; anything else is unknown (fail closed).
 */
export const ANCESTRY_SCRIPT = `pid="$1"
target="$2"
while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null; do
	if [ "$pid" = "$target" ]; then echo yes; exit 0; fi
	stat="$(cat "/proc/$pid/stat" 2>/dev/null)" || { echo no; exit 0; }
	rest="\${stat##*) }"
	set -- $rest
	pid="\${2:-}"
done
echo no
`;
export function ancestryArgv(pid: number, panePid: number): string[] {
	return [
		"timeout",
		"-k",
		"2",
		String(EXEC_TIMEOUT_S),
		"bash",
		"-c",
		ANCESTRY_SCRIPT,
		"st-ancestry",
		String(pid),
		String(panePid),
	];
}

// ── Input region (§8.1.3 `composer-not-empty`) ──────────────────────────────

export type InputRegion =
	| { kind: "empty" }
	| { kind: "text" }
	| { kind: "unknown"; reason: string };

/**
 * The CLI's input region in a `capture-pane -p -e` dump: everything after
 * the LAST prompt marker (`❯` at the start of a line) up to the next rule
 * line (only `─`). With `-e` the dump keeps SGR attributes: what the person
 * typed is rendered without attributes, the ghost suggestion ("Try …", a
 * previous prompt offered again) dim. So the region is empty when it has
 * no non-blank character outside an SGR run; any unstyled non-blank
 * character means text. No marker, no closing rule, or anything that does
 * not fit ⇒ unknown, which the caller treats as not empty (fail closed).
 * The scrollback above the marker never counts.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR runs before the marker
const MARKER_PREFIX = /^(\u001b\[[0-9;?]*m)*❯/;

/** The input region's raw text (SGR kept), or why it could not be found. */
function extractRegion(dump: string): { region: string } | { reason: string } {
	const lines = dump.replace(/\r/g, "").split("\n");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR sequences
	const sgr = /\u001b\[[0-9;?]*m/g;
	let marker = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i]!.replace(sgr, "").startsWith("❯")) {
			marker = i;
			break;
		}
	}
	if (marker < 0) return { reason: "no-prompt-marker" };
	let end = -1;
	for (let i = marker + 1; i < lines.length; i++) {
		const plain = lines[i]!.replace(sgr, "").trim();
		if (plain.length > 0 && /^─+$/.test(plain)) {
			end = i;
			break;
		}
	}
	if (end < 0) return { reason: "no-closing-rule" };
	return {
		region: [lines[marker]!.replace(MARKER_PREFIX, ""), ...lines.slice(marker + 1, end)].join("\n"),
	};
}

/** The input region without attributes (ghost text included), or null when unknown. */
export function inputRegionPlain(dump: string): string | null {
	const r = extractRegion(dump);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR sequences
	return "region" in r ? r.region.replace(/\u001b\[[0-9;?]*m/g, "") : null;
}

export function inputRegion(dump: string): InputRegion {
	const r = extractRegion(dump);
	if ("reason" in r) return { kind: "unknown", reason: r.reason };
	const region = r.region;
	// Walk the region: characters outside any SGR styling are "typed". The
	// styling is tracked as a set of attribute families, so a run that only
	// ENDS an attribute (`ESC[22m` normal intensity, `ESC[39m` default
	// foreground, …) leaves the text unstyled — the ghost suggestion is dim,
	// and the CLI may end that run without a full `ESC[0m`.
	const active = new Set<string>();
	let typed = false;
	for (let i = 0; i < region.length; ) {
		if (region[i] === "\u001b") {
			// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR sequence
			const m = region.slice(i).match(/^\u001b\[([0-9;?]*)m/);
			if (!m) return { kind: "unknown", reason: "unparsed-escape" };
			applySgr(active, m[1]!);
			i += m[0].length;
			continue;
		}
		const ch = region[i]!;
		if (!/\s/.test(ch) && active.size === 0) typed = true;
		i++;
	}
	return typed ? { kind: "text" } : { kind: "empty" };
}

/** Apply one SGR parameter list to the set of active attribute families. */
function applySgr(active: Set<string>, params: string): void {
	const parts = params.split(";");
	for (let k = 0; k < parts.length; k++) {
		const n = parts[k] === "" ? 0 : Number(parts[k]);
		if (Number.isNaN(n)) continue;
		if (n === 0) active.clear();
		else if (n === 1 || n === 2) active.add("intensity");
		else if (n === 22) active.delete("intensity");
		else if (n === 3) active.add("italic");
		else if (n === 23) active.delete("italic");
		else if (n === 4) active.add("underline");
		else if (n === 24) active.delete("underline");
		else if (n === 5 || n === 6) active.add("blink");
		else if (n === 25) active.delete("blink");
		else if (n === 7) active.add("inverse");
		else if (n === 27) active.delete("inverse");
		else if (n === 8) active.add("hidden");
		else if (n === 28) active.delete("hidden");
		else if (n === 9) active.add("strike");
		else if (n === 29) active.delete("strike");
		else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) active.add("fg");
		else if (n === 38 || n === 48 || n === 58) {
			// Extended colour: `38;5;N` or `38;2;R;G;B` consume their arguments.
			const fam = n === 38 ? "fg" : n === 48 ? "bg" : "underline-colour";
			active.add(fam);
			k += parts[k + 1] === "5" ? 2 : parts[k + 1] === "2" ? 4 : 0;
		} else if (n === 39) active.delete("fg");
		else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) active.add("bg");
		else if (n === 49) active.delete("bg");
		else if (n === 59) active.delete("underline-colour");
	}
}

// ── Paste consumption (§8.1.5 paso 2b) ──────────────────────────────────────

/**
 * Polls of the input region after a paste before the delivery fails closed:
 * 100 × 100 ms ≈ 10 s. The 3.2 pilot on VM100 (CLI 2.1.314, 2026-10-31)
 * showed the CLI drawing a pasted line more than 3.5 s after the paste when
 * the send followed a turn's end closely; the previous 40 × 50 ms window then
 * failed closed with the text sitting in the input. Waiting longer is safe —
 * nothing else is sent meanwhile and T_http still bounds the request.
 */
export const CONSUME_POLL_MS = 100;
export const CONSUME_MAX_POLLS = 100;
const CONSUME_TAIL_CPS = 24;

/** Whitespace-free form: the CLI wraps and indents long lines in its input box. */
function compact(s: string): string {
	return s.replace(/\s+/g, "");
}
function occurrences(hay: string, needle: string): number {
	if (needle.length === 0) return 0;
	let n = 0;
	for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
	return n;
}

/**
 * Has the CLI consumed the pasted `chunk`? Evidence: the chunk's tail appears
 * in the input region one more time than before the paste (count-based, so
 * two identical consecutive lines are not confused). The region is compared
 * without whitespace because the input box wraps and indents. A chunk with no
 * visible characters is trivially consumed.
 *
 * Why this matters (smoke, CLI 2.1.314, 2026-10-30): a CSI u newline or an
 * Enter that reaches the CLI in the SAME read as the preceding bracketed
 * paste is applied as a plain Enter — the segment is SUBMITTED. Bytes sent
 * after the paste is visibly consumed land in a later read.
 */
export function pasteConsumed(before: string | null, after: string, chunk: string): boolean {
	const key = compact(Array.from(chunk).slice(-CONSUME_TAIL_CPS).join(""));
	if (key.length === 0) return true;
	return occurrences(compact(after), key) > occurrences(compact(before ?? ""), key);
}
