// Phase-0 diagnostic hook logger — OBSERVATIONAL ONLY.
//
// Installed only in the test folder's .claude/settings.local.json. For each
// hook it appends ONE JSON line to <this dir>/out/hooks.jsonl with the fields
// needed to judge acceptance and attribution, and nothing else:
//   - no prompt text, no assistant text, no tool input/response text: only
//     byte counts, SHA-256 digests and test ids matched by a fixed pattern;
//   - no transcript_path, no cwd (both contain the user name);
//   - <channel> attribute VALUES only for a fixed allowlist, sanitized.
//
// It must never influence the session: for UserPromptSubmit and SessionStart,
// anything printed on stdout is ADDED TO CLAUDE'S CONTEXT, and exit code 2
// BLOCKS the prompt. So this script prints nothing, swallows every error and
// always exits 0.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");
const TEST_ID = /\bP0[A-Z]\d{2}-[0-9a-f]{6}\b/g;
const ATTR_ALLOW = new Set(["source", "chat_id", "message_id", "user", "ts", "st_msg"]);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const bytes = (s) => Buffer.byteLength(s, "utf8");
const ids = (s) => [...new Set(String(s).match(TEST_ID) ?? [])];
const clean = (v) => String(v).replace(/[^\w:.\-]/g, "_").slice(0, 80);

function channelShape(prompt) {
	const tags = [];
	const re = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/g;
	let m;
	let covered = 0;
	while ((m = re.exec(prompt))) {
		const attrs = {};
		const names = [];
		for (const a of m[1].matchAll(/(\w+)="([^"]*)"/g)) {
			names.push(a[1]);
			if (ATTR_ALLOW.has(a[1])) attrs[a[1]] = clean(a[2]);
		}
		tags.push({ attr_names: names, attrs, content_bytes: bytes(m[2]), content_test_ids: ids(m[2]) });
		covered += m[0].length;
	}
	const outside = prompt.replace(/<channel\b[^>]*>[\s\S]*?<\/channel>/g, "");
	return {
		channel_tag_count: tags.length,
		channel_open_count: (prompt.match(/<channel\b/g) ?? []).length,
		channel_close_count: (prompt.match(/<\/channel>/g) ?? []).length,
		outside_text_bytes: bytes(outside.trim()),
		only_channel_tags: tags.length > 0 && outside.trim() === "",
		channel_tags: tags,
	};
}

try {
	const raw = readFileSync(0, "utf8");
	const e = JSON.parse(raw);
	const ev = e.hook_event_name;
	if (typeof ev !== "string") process.exit(0);
	const rec = {
		ts: new Date().toISOString(),
		t_ms: Date.now(),
		event: ev,
		session_id: e.session_id ?? null,
		prompt_id: e.prompt_id ?? null,
		agent_id: e.agent_id ?? null,
		// Field NAMES actually received (never values): the empirical check of
		// the payload shape for the CLI version in use.
		keys: Object.keys(e).sort(),
	};
	if (ev === "UserPromptSubmit") {
		const p = typeof e.prompt === "string" ? e.prompt : "";
		rec.source_present = Object.hasOwn(e, "source");
		rec.source = rec.source_present ? clean(e.source) : null;
		rec.prompt_bytes = bytes(p);
		rec.prompt_sha256 = sha(p);
		rec.test_ids = ids(p);
		Object.assign(rec, channelShape(p));
	} else if (ev === "Stop" || ev === "StopFailure") {
		const m = typeof e.last_assistant_message === "string" ? e.last_assistant_message : "";
		rec.last_message_bytes = bytes(m);
		rec.last_message_test_ids = ids(m);
		rec.last_message_ok_ids = [...new Set((m.match(/OK_P0[A-Z]\d{2}-[0-9a-f]{6}/g) ?? []).map((x) => x.slice(3)))];
		if (ev === "Stop") {
			rec.stop_hook_active = e.stop_hook_active ?? null;
			rec.background_tasks = Array.isArray(e.background_tasks) ? e.background_tasks.length : null;
		} else {
			rec.error = clean(e.error ?? "");
			rec.error_details_present = typeof e.error_details === "string";
		}
	} else if (ev === "SessionStart") {
		rec.start_source = clean(e.source ?? "");
		rec.model = e.model ? clean(e.model) : null;
	} else if (ev === "PostToolUse" || ev === "PostToolUseFailure") {
		const ti = e.tool_input && typeof e.tool_input === "object" ? e.tool_input : {};
		rec.tool_name = clean(e.tool_name ?? "");
		rec.tool_use_id = clean(e.tool_use_id ?? "");
		rec.ok = ev === "PostToolUse";
		rec.reply_to = typeof ti.reply_to === "string" ? clean(ti.reply_to) : null;
		rec.text_bytes = typeof ti.text === "string" ? bytes(ti.text) : null;
		rec.text_test_ids = typeof ti.text === "string" ? ids(ti.text) : [];
		rec.text_ok_ids = typeof ti.text === "string"
			? [...new Set((ti.text.match(/OK_P0[A-Z]\d{2}-[0-9a-f]{6}/g) ?? []).map((x) => x.slice(3)))] : [];
		rec.files_count = Array.isArray(ti.files) ? ti.files.length : 0;
	} else if (ev === "Notification") {
		rec.notification_type = clean(e.notification_type ?? "");
	}
	mkdirSync(OUT, { recursive: true });
	appendFileSync(join(OUT, "hooks.jsonl"), `${JSON.stringify(rec)}\n`);
} catch {
	// logging must never affect Claude
}
process.exit(0);
