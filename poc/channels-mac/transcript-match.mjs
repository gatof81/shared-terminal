// Alternative A (04-poc.md §1.11): does the CLI's own transcript identify a
// UserPromptSubmit as a channel entry? Pure; no I/O. Never returns text.
//
// Fail-closed by construction: the only way to get "verified" is EXACTLY ONE
// prompt record for the hook's prompt_id, and that record is a channel entry
// of this session, from the expected server, carrying the message id. Every
// other shape — missing, partial, unreadable, duplicated, forged next to the
// real one — is "unverified" with the reasons listed.
const NL = String.fromCharCode(10);
const TAG_OPEN = /<channel(\s[^>]*)?>/g;
const ATTR = /([a-zA-Z_][a-zA-Z0-9_]*)="([^"]*)"/g;

const promptText = (r) => (typeof r.message?.content === "string" ? r.message.content : null);
const isToolResult = (r) => Array.isArray(r.message?.content) && r.message.content.some((b) => b?.type === "tool_result");
// A record that IS a prompt (not a tool result also tagged with the turn's promptId).
const isPromptRecord = (r) => r.type === "user" && !isToolResult(r);
const originOf = (r) => r.origin ?? (r.attachment?.type === "queued_command" ? r.attachment.origin : null) ?? null;

export function channelTags(text) {
	if (typeof text !== "string") return [];
	return [...text.matchAll(TAG_OPEN)].map((m) => Object.fromEntries([...(m[1] ?? "").matchAll(ATTR)].map((a) => [a[1], a[2]])));
}

// text: the bytes read (whole file, or its tail). startsAtZero: false when the
// read began mid-file, so the first fragment is a cut line, not a record.
export function matchTranscript(text, { startsAtZero, promptId, messageId, sessionId, server, prompt }) {
	const reasons = [];
	const parts = text.split(NL);
	if (!startsAtZero) parts.shift();
	// A last fragment without its newline is a write in progress: never parsed.
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
	if (unparsable > 0) reasons.push("unparsable-line");
	if (!promptId) reasons.push("hook-without-prompt_id");
	if (!messageId) reasons.push("prompt-without-channel-message_id");
	const forPrompt = promptId ? records.filter((r) => r.promptId === promptId && isPromptRecord(r)) : [];
	// Any record anywhere in what was read that carries this message id in a
	// channel tag; more than the one prompt record means a copy or a forgery.
	const mentioning = messageId ? records.filter((r) => channelTags(promptText(r)).some((t) => t.message_id === messageId)) : [];
	const queuedOnly = promptId ? records.some((r) => r.attachment?.type === "queued_command" && originOf(r)?.kind === "channel") : false;
	if (forPrompt.length === 0) reasons.push(partialTail ? "no-prompt-record-partial-tail" : "no-prompt-record");
	if (forPrompt.length > 1) reasons.push("duplicate-prompt-record");
	const rec = forPrompt.length === 1 ? forPrompt[0] : null;
	const tags = rec ? channelTags(promptText(rec)) : [];
	if (rec) {
		if (originOf(rec)?.kind !== "channel") reasons.push("origin-not-channel");
		if (originOf(rec)?.server !== server) reasons.push("server-mismatch");
		if (rec.isMeta !== true) reasons.push("not-meta");
		if (rec.sessionId !== sessionId) reasons.push("session-mismatch");
		if (tags.length !== 1) reasons.push("channel-tag-count");
		else if (messageId && tags[0].message_id !== messageId) reasons.push("message_id-mismatch");
	}
	if (messageId && mentioning.length > 1) reasons.push("message_id-in-several-records");
	if (messageId && rec && mentioning.length === 1 && mentioning[0] !== rec) reasons.push("message_id-in-other-record");
	return {
		status: reasons.length === 0 ? "verified" : "unverified",
		reasons,
		records: records.length,
		unparsable,
		partial_tail: partialTail,
		prompt_records_for_prompt_id: forPrompt.length,
		records_with_message_id: mentioning.length,
		origin_kind: rec ? originOf(rec)?.kind ?? null : null,
		server_matches: rec ? originOf(rec)?.server === server : null,
		is_meta: rec ? rec.isMeta === true : null,
		prompt_source: rec ? (["typed", "queued", "system", "sdk", "suggestion_accepted"].includes(rec.promptSource) ? rec.promptSource : rec.promptSource == null ? null : "otro") : null,
		session_matches: rec ? rec.sessionId === sessionId : null,
		content_equals_prompt: rec && typeof prompt === "string" ? promptText(rec) === prompt : null,
		queued_attachment_seen: queuedOnly,
	};
}

// One send: what the probe saw at hook time vs a later read of the whole file.
// "late" needs the hook-time read to have found NO prompt record (or only a
// partial line) and a later read to verify; anything else that fails is "invalid".
export function arrivalCategory(atHook, later) {
	if (!atHook) return "probe-missing";
	if (atHook.status === "verified") return "present-at-hook";
	const absentAtHook = atHook.reasons.every((r) => r === "no-prompt-record" || r === "no-prompt-record-partial-tail");
	if (absentAtHook && later?.status === "verified") return "late";
	if (absentAtHook && (!later || later.prompt_records_for_prompt_id === 0)) return "missing";
	return "invalid";
}

const pick = (m) => m && {
	status: m.status, reasons: m.reasons, prompt_records_for_prompt_id: m.prompt_records_for_prompt_id,
	records_with_message_id: m.records_with_message_id, origin_kind: m.origin_kind, server_matches: m.server_matches,
	is_meta: m.is_meta, prompt_source: m.prompt_source, session_matches: m.session_matches, content_equals_prompt: m.content_equals_prompt,
	unparsable: m.unparsable, partial_tail: m.partial_tail, read_ms: m.read_ms, read_from_zero: m.read_from_zero,
};

// The row fields for one send. probeLines: every transcript-probe.jsonl line
// with this prompt_id; anything but exactly one is itself a finding.
export function transcriptEvidence(probeLines, later, laterDtMs) {
	const atHook = probeLines.length === 1 ? probeLines[0] : null;
	const category = probeLines.length > 1 ? "probe-duplicated" : arrivalCategory(atHook, later);
	return { probe_lines: probeLines.length, at_hook: pick(atHook), later: pick(later), later_dt_ms: laterDtMs ?? null, category };
}
