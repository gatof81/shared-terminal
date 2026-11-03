// Hook events keyed by their ABSOLUTE line in hooks.jsonl, and the pure
// window facts send.mjs and rediagnose.mjs derive from them.
//
// Event identity is the line number, never object identity: every read parses
// the file again and yields new objects, so `h !== ups` across two reads is
// always true and the test's own UserPromptSubmit/Stop were counted as foreign
// (phase-0 test T, P0T01-f9dfb6). The file is append-only, so a line keeps its
// number across reads; an unparsable line (e.g. a trailing write in progress)
// still occupies its slot, so the next read gives the completed line the same
// number. Two different events never share a line, even with the same
// prompt_id, so duplicates stay distinguishable.
const NL = String.fromCharCode(10);

export function parseHookLines(text) {
	const out = [];
	text.split(NL).forEach((l, i) => {
		if (!l) return;
		try {
			const h = JSON.parse(l);
			if (h && typeof h === "object" && !Array.isArray(h)) out.push({ ...h, _line: i });
		} catch {}
	});
	return out;
}

const mentions = (h, id) => (h.test_ids ?? []).includes(id) || (h.channel_tags ?? []).some((t) => t.attrs?.message_id === id);
const isOk = (id) => (h) => (h.text_ok_ids ?? []).includes(id);

// events: parseHookLines output; [fromLine, toLine) bounds the window
// (toLine omitted = to the end of what was read).
export function windowFacts(events, { id, fromLine, toLine = Number.POSITIVE_INFINITY }) {
	const win = events.filter((h) => h._line >= fromLine && h._line < toLine);
	const ups = win.find((h) => h.event === "UserPromptSubmit" && mentions(h, id)) ?? null;
	const stop = ups && ups.prompt_id
		? win.find((h) => h.event === "Stop" && h._line > ups._line && h.prompt_id === ups.prompt_id) ?? null
		: null;
	const tool = win.find((h) => (h.event === "PostToolUse" || h.event === "PostToolUseFailure") && (h.reply_to === id || isOk(id)(h))) ?? null;
	const otherUps = win.filter((h) => h.event === "UserPromptSubmit" && h._line !== ups?._line);
	const otherStops = win
		.filter((h) => h.event === "Stop" && h._line !== stop?._line)
		.map((h) => ({ line: h._line, prompt_id: h.prompt_id ?? null, same_prompt_id: !!ups?.prompt_id && h.prompt_id === ups.prompt_id }));
	return {
		ups, stop, tool,
		otherUps: otherUps.map((h) => ({ line: h._line, prompt_id: h.prompt_id ?? null })),
		otherStops,
		stopFailure: win.some((h) => h.event === "StopFailure"),
		permissionDialog: win.some((h) => h.event === "Notification" && /permission/.test(h.notification_type ?? "")),
		promptIdSeenBefore: ups?.prompt_id ? events.some((h) => h._line < fromLine && h.prompt_id === ups.prompt_id) : null,
		lastLine: win.length ? win.at(-1)._line : fromLine - 1,
	};
}

// One Fakechat broadcast of an assistant message, as send.mjs records it.
// `exact_text` is the text AS BROADCAST: Fakechat relays the reply tool's
// `text` argument unchanged, so no normalisation is applied and " OK_<id>"
// or "OK_<id>\n" is not an exact reply.
export function replyRecord(d, tMs, sha) {
	const text = String(d.text ?? "");
	return {
		t_ms: tMs,
		reply_to: d.replyTo ?? null,
		text_bytes: Buffer.byteLength(text),
		text_sha256: sha(text),
		ok_ids: [...new Set((text.match(/OK_P0[A-Z]\d{2}-[0-9a-f]{6}/g) ?? []).map((x) => x.slice(3)))],
		exact_text: text,
	};
}

// The sends-<label>.jsonl fields classify.mjs reads, from one windowFacts().
export function factsToRow(f, { id, tSend, reply }) {
	const u = f.ups;
	return {
		result: u ? "hook" : "no-hook",
		ups: u && {
			t_ms: u.t_ms, latency_ms: u.t_ms - tSend, line: u._line, source_present: u.source_present, source: u.source,
			prompt_id: u.prompt_id, prompt_id_seen_before: f.promptIdSeenBefore,
			channel_tag_count: u.channel_tag_count, only_channel_tags: u.only_channel_tags, outside_text_bytes: u.outside_text_bytes,
			tag_attr_names: u.channel_tags?.[0]?.attr_names ?? [], tag_source: u.channel_tags?.[0]?.attrs?.source ?? null,
			tag_message_id_matches: u.channel_tags?.[0]?.attrs?.message_id === id, keys: u.keys,
		},
		other_prompts: f.otherUps,
		other_prompt_events_after_send: f.otherUps.length,
		permission_dialog: f.permissionDialog,
		stop: f.stop && { latency_ms: f.stop.t_ms - tSend, line: f.stop._line, same_prompt_id: true, ok_in_last_message: (f.stop.last_message_ok_ids ?? []).includes(id) },
		other_stops: f.otherStops,
		reply_tool: f.tool && { ok: f.tool.event === "PostToolUse", tool_name: f.tool.tool_name, reply_to_matches: f.tool.reply_to === id, latency_ms: f.tool.t_ms - tSend },
		fakechat_reply: reply && { latency_ms: reply.t_ms - tSend, reply_to_matches: reply.reply_to === id, exact: reply.exact_text === `OK_${id}` },
		stop_failure: f.stopFailure,
	};
}
