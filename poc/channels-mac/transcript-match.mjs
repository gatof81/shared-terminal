// Alternative A (04-poc.md §1.11): does the CLI's own transcript identify a
// UserPromptSubmit as a channel entry? No I/O; never returns text.
//
// Fail-closed by construction. "verified" needs, in the bytes read: exactly
// one prompt record for the hook's prompt_id, a channel entry of this session
// from the expected server, whose content is BYTE-IDENTICAL to the hook's
// prompt and is one well-formed <channel> element carrying the message id,
// with nothing else read that is partial, unreadable or a second copy.
//
// Scope is explicit: when the read did not start at byte 0, uniqueness is
// only known WITHIN THE OBSERVED BYTES; the status says so
// ("verified-in-observed-bytes") and unique_global stays null. Only a read of
// the whole file can return "verified" with unique_global true.
import { createHash } from "node:crypto";

const NL = String.fromCharCode(10);
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const ATTR_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// The exact shape the 2.1.317 CLI builds (binary: `<channel source="${server}"${meta}>`
// + "\n" + content + "\n" + `</channel>`): nothing outside, one element, no
// nested or second tag in the body, attributes name="value" separated by one
// space, each name once. A meta key named "source" would yield a second
// `source` attribute; any repeated name is refused, so the server's own
// `source` cannot be contradicted.
export function parseChannelElement(text) {
	if (typeof text !== "string") return { ok: false, why: "not-text" };
	if (!text.startsWith("<channel ")) return { ok: false, why: "outside-content-or-no-tag" };
	const close = "</channel>";
	if (!text.endsWith(`${NL}${close}`)) return { ok: false, why: "outside-content-or-unclosed" };
	const gt = text.indexOf(">");
	if (gt < 0 || text[gt + 1] !== NL) return { ok: false, why: "bad-open-tag" };
	const attrText = text.slice("<channel".length, gt);
	const body = text.slice(gt + 2, text.length - close.length - 1);
	if (body.includes("<channel") || body.includes(close)) return { ok: false, why: "nested-or-second-tag" };
	const attrs = new Map();
	let rest = attrText;
	while (rest.length > 0) {
		const m = rest.match(/^ ([^=\s"]+)="([^"]*)"/);
		if (!m) return { ok: false, why: "bad-attribute-syntax" };
		if (!ATTR_NAME.test(m[1])) return { ok: false, why: "bad-attribute-name" };
		if (attrs.has(m[1])) return { ok: false, why: "duplicate-attribute" };
		attrs.set(m[1], m[2]);
		rest = rest.slice(m[0].length);
	}
	if (!attrs.has("source")) return { ok: false, why: "no-source-attribute" };
	return { ok: true, attrs: Object.fromEntries(attrs), body_bytes: Buffer.byteLength(body) };
}

// Loose scan used only to find OTHER records that mention the message id.
const mentionsId = (text, id) => typeof text === "string" && text.includes(`message_id="${id}"`);
const promptText = (r) => (typeof r.message?.content === "string" ? r.message.content : null);
const isToolResult = (r) => Array.isArray(r.message?.content) && r.message.content.some((b) => b?.type === "tool_result");
const isPromptRecord = (r) => r.type === "user" && !isToolResult(r);
const originOf = (r) => r.origin ?? (r.attachment?.type === "queued_command" ? r.attachment.origin : null) ?? null;
const SOURCES = ["typed", "queued", "system", "sdk", "suggestion_accepted"];

// text: the bytes read. startsAtZero: the read began at byte 0 (whole file).
// prompt: the hook's prompt (probe), or promptSha256 (later reads, from the
// logger's hash) — one of them is REQUIRED, otherwise equality is unknown and
// the result is unverified.
export function matchTranscript(text, { startsAtZero, promptId, messageId, sessionId, server, prompt, promptSha256 }) {
	const reasons = [];
	const parts = text.split(NL);
	if (!startsAtZero) parts.shift();
	// A last fragment without its newline is a write in progress. It is never
	// parsed, and it always makes the read unverified: it could be anything,
	// a second copy of the record included.
	const partialTail = parts.length > 0 && parts.at(-1) !== "";
	if (partialTail) parts.pop();
	const records = [];
	let unparsable = 0;
	for (const l of parts) {
		if (!l) continue;
		try {
			const r = JSON.parse(l);
			if (r && typeof r === "object" && !Array.isArray(r)) records.push(r);
			else unparsable++;
		} catch {
			unparsable++;
		}
	}
	if (text.length === 0) reasons.push("empty");
	if (partialTail) reasons.push("partial-tail");
	if (unparsable > 0) reasons.push("unparsable-line");
	if (!promptId) reasons.push("hook-without-prompt_id");
	if (!messageId) reasons.push("prompt-without-channel-message_id");
	const forPrompt = promptId ? records.filter((r) => r.promptId === promptId && isPromptRecord(r)) : [];
	const mentioning = messageId ? records.filter((r) => mentionsId(promptText(r), messageId) || mentionsId(r.attachment?.prompt, messageId)) : [];
	if (forPrompt.length === 0) reasons.push("no-prompt-record");
	if (forPrompt.length > 1) reasons.push("duplicate-prompt-record");
	const rec = forPrompt.length === 1 ? forPrompt[0] : null;
	let el = null;
	let contentEquals = null;
	if (rec) {
		const content = promptText(rec);
		if (originOf(rec)?.kind !== "channel") reasons.push("origin-not-channel");
		if (originOf(rec)?.server !== server) reasons.push("server-mismatch");
		if (rec.isMeta !== true) reasons.push("not-meta");
		if (rec.sessionId !== sessionId) reasons.push("session-mismatch");
		if (typeof prompt === "string") contentEquals = content === prompt;
		else if (typeof promptSha256 === "string") contentEquals = typeof content === "string" && sha(content) === promptSha256;
		if (contentEquals === null) reasons.push("prompt-unavailable-for-comparison");
		else if (!contentEquals) reasons.push("content-differs-from-prompt");
		el = parseChannelElement(content);
		if (!el.ok) reasons.push(`channel-element:${el.why}`);
		else {
			if (el.attrs.source !== server) reasons.push("channel-source-attribute-mismatch");
			if (messageId && el.attrs.message_id !== messageId) reasons.push("message_id-mismatch");
		}
	}
	if (messageId && mentioning.length > 1) reasons.push("message_id-in-several-records");
	if (messageId && rec && mentioning.length === 1 && mentioning[0] !== rec) reasons.push("message_id-in-other-record");
	// null = nothing to be unique about (no prompt record); a duplicate is false.
	const uniqueObserved = forPrompt.length === 0 ? null : forPrompt.length === 1 && mentioning.length <= 1;
	const status = reasons.length > 0 ? "unverified" : startsAtZero ? "verified" : "verified-in-observed-bytes";
	return {
		status,
		reasons,
		uniqueness: {
			scope: startsAtZero ? "whole-file" : "observed-bytes",
			unique_in_observed: uniqueObserved,
			// Only a read from byte 0 may claim this; a tail read never does.
			unique_global: startsAtZero ? uniqueObserved : null,
		},
		records: records.length,
		unparsable,
		partial_tail: partialTail,
		prompt_records_for_prompt_id: forPrompt.length,
		records_with_message_id: mentioning.length,
		origin_kind: rec ? originOf(rec)?.kind ?? null : null,
		server_matches: rec ? originOf(rec)?.server === server : null,
		is_meta: rec ? rec.isMeta === true : null,
		prompt_source: rec ? (SOURCES.includes(rec.promptSource) ? rec.promptSource : rec.promptSource == null ? null : "otro") : null,
		session_matches: rec ? rec.sessionId === sessionId : null,
		content_equals_prompt: contentEquals,
		channel_element_ok: el ? el.ok : null,
		channel_attr_names: el?.ok ? Object.keys(el.attrs) : null,
	};
}

const ok = (m) => m?.status === "verified" || m?.status === "verified-in-observed-bytes";

// One send: the probe's hook-time read vs a later read of the whole file.
//   present-at-hook: verified (any scope) at the hook AND the later whole-file
//     read verified — the later read is what supplies global uniqueness;
//   late: NO prompt record at the hook (nothing else wrong) and verified later;
//   missing: no prompt record in either read;
//   invalid: anything else (incl. verified at the hook but not later).
export function arrivalCategory(atHook, later) {
	if (!atHook) return "probe-missing";
	if (ok(atHook)) return later?.status === "verified" ? "present-at-hook" : "invalid";
	const absentAtHook = atHook.prompt_records_for_prompt_id === 0 && atHook.reasons.every((r) => r === "no-prompt-record" || r === "partial-tail");
	if (absentAtHook && later?.status === "verified") return "late";
	if (absentAtHook && (!later || later.prompt_records_for_prompt_id === 0)) return "missing";
	return "invalid";
}

const pick = (m) => m && {
	status: m.status, reasons: m.reasons, uniqueness: m.uniqueness, prompt_records_for_prompt_id: m.prompt_records_for_prompt_id,
	records_with_message_id: m.records_with_message_id, origin_kind: m.origin_kind, server_matches: m.server_matches,
	is_meta: m.is_meta, prompt_source: m.prompt_source, session_matches: m.session_matches, content_equals_prompt: m.content_equals_prompt,
	channel_element_ok: m.channel_element_ok, unparsable: m.unparsable, partial_tail: m.partial_tail, read_ms: m.read_ms, read_from_zero: m.read_from_zero,
};

// The row fields for one send. probeLines: every transcript-probe.jsonl line
// with this prompt_id; anything but exactly one is itself a finding.
export function transcriptEvidence(probeLines, later, laterDtMs) {
	const atHook = probeLines.length === 1 ? probeLines[0] : null;
	const category = probeLines.length > 1 ? "probe-duplicated" : arrivalCategory(atHook, later);
	return { probe_lines: probeLines.length, at_hook: pick(atHook), later: pick(later), later_dt_ms: laterDtMs ?? null, category };
}
