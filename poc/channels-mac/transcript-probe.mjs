#!/usr/bin/env bun
// UserPromptSubmit probe for alternative A (04-poc.md §1.11). OBSERVATIONAL:
// prints nothing (stdout of this hook is added to Claude's context), always
// exits 0 (2 would block the prompt), never waits or retries — one read, at
// the moment the hook runs, so "present" means the record was already in the
// file, visible to another process, before Claude continued. It is not proof
// of durability (no fsync is observable from here).
//
// Writes one JSONL line to <this dir>/out/transcript-probe.jsonl: verdict,
// reasons, counts, timings. Never the transcript's text, the prompt, or a path.
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { matchTranscript, parseChannelElement } from "./transcript-match.mjs";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");
const SERVER = process.env.POC0_CHANNEL_SERVER ?? "plugin:fakechat:fakechat";
// Bounded read: the prompt record is written moments before the hook, so it
// is near the end; a record outside the tail is "unverified", never searched for.
const TAIL = 1024 * 1024;

try {
	const t0 = Date.now();
	const e = JSON.parse(readFileSync(0, "utf8"));
	if (e?.hook_event_name !== "UserPromptSubmit") process.exit(0);
	const prompt = typeof e.prompt === "string" ? e.prompt : "";
	const el = parseChannelElement(prompt);
	const messageId = el.ok ? el.attrs.message_id ?? null : null;
	const rec = { ts: new Date(t0).toISOString(), t_ms: t0, session_id: e.session_id ?? null, prompt_id: e.prompt_id ?? null,
		message_id: /^P0[A-Z]\d{2}-[0-9a-f]{6}$/.test(messageId ?? "") ? messageId : messageId ? "otro" : null };
	const reasons = [];
	const tp = typeof e.transcript_path === "string" ? e.transcript_path : null;
	const projects = resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
	// The path comes from the CLI, but it is checked before being opened: the
	// session's own file, inside the projects dir, a regular file, not a link.
	if (!tp) reasons.push("no-transcript_path");
	else if (basename(tp) !== `${e.session_id}.jsonl`) reasons.push("path-not-session-file");
	else if (dirname(dirname(resolve(tp))) !== projects) reasons.push("path-outside-projects");
	let m = null;
	if (reasons.length === 0) {
		let st = null;
		try { st = lstatSync(tp); } catch { reasons.push("file-missing"); }
		if (st && st.isSymbolicLink()) reasons.push("symlink");
		else if (st && !st.isFile()) reasons.push("not-a-file");
		else if (st) {
			let fd = null;
			try {
				fd = openSync(tp, "r");
				const size = fstatSync(fd).size;
				const start = Math.max(0, size - TAIL);
				const buf = Buffer.alloc(size - start);
				const n = readSync(fd, buf, 0, buf.length, start);
				const text = buf.subarray(0, n).toString("utf8");
				Object.assign(rec, { file_size: size, read_bytes: n, read_from_zero: start === 0 });
				m = matchTranscript(text, { startsAtZero: start === 0, promptId: e.prompt_id, messageId, sessionId: e.session_id, server: SERVER, prompt });
			} catch {
				reasons.push("unreadable");
			} finally {
				if (fd !== null) try { closeSync(fd); } catch {}
			}
		}
	}
	const all = [...reasons, ...(m?.reasons ?? [])];
	// The scope-qualified status comes from the matcher; any reason of the
	// probe's own (path, file, read) can only turn it into "unverified".
	Object.assign(rec, m ?? {}, { status: all.length === 0 && m ? m.status : "unverified", reasons: all, read_ms: Date.now() - t0 });
	mkdirSync(OUT, { recursive: true });
	appendFileSync(join(OUT, "transcript-probe.jsonl"), `${JSON.stringify(rec)}\n`);
} catch {}
process.exit(0);
