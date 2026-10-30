/**
 * composerText.ts — the client-side copy of the composer's text rules
 * (docs/CONVERSATION.md §8.1.2). `normalizeText` and `validateText` are the
 * same functions as backend/src/conversation/composerText.ts; keep them
 * identical. The browser uses them only to explain a rejection before the
 * request leaves — the server decides, every time.
 */

/** L1 — `user_prompt.prompt` content bytes (CONVERSATION.md §4.4). */
export const L1_PROMPT_BYTES = 64 * 1024;
export const SEGMENT_MAX_CHARS = 800;
export const SEGMENTS_MAX = 256;

export function normalizeText(s: string): string {
	return s
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((l) => l.replace(/\t/g, "    ").replace(/[ \t]+$/, ""))
		.join("\n")
		.replace(/\n+$/, "");
}

export type TextRejection =
	| "empty-text"
	| "text-too-large"
	| "control-bytes"
	| "unsupported-prefix"
	| "too-many-segments";

export type TextValidation =
	| { ok: true; normalized: string; bytes: number; segments: number }
	| { ok: false; code: TextRejection };

function utf8Bytes(s: string): number {
	return new TextEncoder().encode(s).length;
}

/** Number of pastes the server will make: lines, each in chunks of ≤ 800 code points. */
export function countSegments(normalized: string): number {
	let pastes = 0;
	for (const line of normalized.split("\n")) {
		const cps = Array.from(line).length;
		pastes += Math.ceil(cps / SEGMENT_MAX_CHARS);
	}
	return pastes;
}

export function validateText(text: string): TextValidation {
	const normalized = normalizeText(text);
	const bytes = utf8Bytes(normalized);
	if (bytes === 0) return { ok: false, code: "empty-text" };
	if (bytes > L1_PROMPT_BYTES) return { ok: false, code: "text-too-large" };
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them
	if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(normalized))
		return { ok: false, code: "control-bytes" };
	const first = normalized.replace(/^\s+/, "")[0];
	if (first === "/" || first === "!") return { ok: false, code: "unsupported-prefix" };
	const segments = countSegments(normalized);
	if (segments > SEGMENTS_MAX) return { ok: false, code: "too-many-segments" };
	return { ok: true, normalized, bytes, segments };
}

/** What the person reads for a rejection or a 409 (§8.1.2–§8.1.3, §8.1.11). */
export function explainCode(code: string, detail?: string): string {
	switch (code) {
		case "empty-text":
			return "Nothing to send.";
		case "text-too-large":
			return "Message too long (64 KiB limit).";
		case "control-bytes":
			return "The message contains control characters that cannot be sent.";
		case "unsupported-prefix":
			return "A message cannot start with / or ! — those are CLI commands. Use the Terminal for them.";
		case "too-many-segments":
			return "Too many lines to deliver safely; shorten the message.";
		case "send-in-progress":
			return detail === "effects-pending"
				? "The terminal pane is blocked: a previous send has effects whose outcome is not known yet."
				: detail === "unverifiable"
					? "The pane state could not be verified; an operator needs to look."
					: "Another message is being delivered to this pane.";
		case "not-interactive":
			return "This conversation is not an interactive terminal session.";
		case "session-not-running":
			return "The session is not running.";
		case "capture-inactive":
			return "Capture is not active, so a send could not be confirmed.";
		case "probe-failed":
			return "Claude's state could not be read; try again.";
		case "binding-stale":
			return "The conversation is no longer in the pane it was bound to.";
		case "busy":
			return "Claude is busy; wait for the turn to finish.";
		case "needs-terminal":
			return detail === "copy-mode"
				? "The terminal is in scroll/copy mode. Leave it first."
				: detail?.startsWith("foreground")
					? "Claude is not in the foreground of the terminal."
					: "A dialog or prompt is open in the terminal. Finish it there first.";
		case "composer-not-empty":
			return "There is text already typed in the terminal's input. Clear or send it there first.";
		case "cli-unvalidated":
			return "This Claude Code version has not been validated for sending from Chat.";
		case "rate-limited":
			return "Too many sends; wait a moment.";
		case "persist-failed":
			return "The send could not be recorded; nothing was sent.";
		case "delivery-failed":
			return "Delivery failed part-way. Part of the text may be in the terminal's input — check the Terminal before sending again.";
		case "audit-failed":
			return "The audit record could not be written; nothing was sent.";
		default:
			return `Send refused (${code}).`;
	}
}
