#!/usr/bin/env bun
// Send phase-0 test messages through Fakechat and record what happened.
//   bun .poc0/send.mjs --label T --count 1  --min-idle 30     # first instrumented test
//   bun .poc0/send.mjs --label S --count 10 --min-idle 30     # short series
//   bun .poc0/send.mjs --label L --count 2  --min-idle 3600   # long series
// Run from the test folder. It never types in the terminal, never retries,
// and stops at the first message without a UserPromptSubmit, at any
// StopFailure, or on a harness problem (which is never a NO-GO).
// It only READS: hooks.jsonl, `claude agents --json`, the port owner (lsof/ps),
// Fakechat's /ws broadcast (listen only) and, if present, the CLI debug log.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const POC = dirname(fileURLToPath(import.meta.url));
const OUT = join(POC, "out");
const FOLDER = realpathSync(join(POC, ".."));
const PORT = Number(process.env.FAKECHAT_PORT ?? 8787);
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const label = opt("--label", "");
const count = Number(opt("--count", "0"));
const minIdle = Number(opt("--min-idle", "-1"));
const die = (m, code = 4) => {
	console.error(m);
	process.exit(code);
};
if (!/^[A-Z]$/.test(label) || !(count > 0) || !(minIdle >= 0)) die("uso: send.mjs --label T|S|L --count N --min-idle S", 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (c, a) => spawnSync(c, a, { encoding: "utf8", timeout: 30_000 });
const sha = (s) => createHash("sha256").update(s).digest("hex");
const hooks = () => {
	const p = join(OUT, "hooks.jsonl");
	return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];
};

// ── the test session: exactly one interactive claude whose cwd is this folder
function session() {
	const r = sh("claude", ["agents", "--json"]);
	let list;
	try {
		const d = JSON.parse(r.stdout);
		list = Array.isArray(d) ? d : d.agents ?? d.sessions ?? [];
	} catch {
		return { err: `claude agents --json ilegible: ${(r.stderr || "").slice(0, 120)}` };
	}
	const mine = list.filter((e) => (e.kind ?? "interactive") === "interactive" && e.cwd && realpathSafe(e.cwd) === FOLDER);
	if (mine.length !== 1) return { err: `sesiones interactivas en la carpeta de prueba: ${mine.length} (debe ser 1)` };
	const { pid, status, waitingFor, sessionId } = mine[0];
	return { pid: String(pid), sessionId, status, waitingFor, atPrompt: status === "idle" || (status === "waiting" && waitingFor === "input needed") };
}
function realpathSafe(p) { try { return realpathSync(p); } catch { return p; } }
// The Fakechat port must belong to THAT claude: with the plugin enabled for
// the user, another local Claude session could hold the port first, and its
// fakechat would receive the message instead.
function portOwnedBy(pid) {
	const lp = sh("lsof", ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN", "-t"]).stdout.trim().split(/\s+/)[0];
	if (!lp) return { ok: false, detail: `nada escucha en ${PORT}` };
	let cur = lp;
	for (let i = 0; i < 20 && cur && cur !== "1"; i++) {
		if (cur === pid) return { ok: true, detail: `listener ${lp} desciende de claude ${pid}` };
		cur = sh("ps", ["-o", "ppid=", "-p", cur]).stdout.trim();
	}
	return { ok: false, detail: `listener ${lp} NO desciende de claude ${pid}` };
}

async function waitIdle(sessionId) {
	const end = Date.now() + (minIdle + 900) * 1000;
	while (Date.now() < end) {
		const s = session();
		if (s.err) return { ok: false, detail: s.err };
		const mine = hooks().filter((h) => h.session_id === s.sessionId || !s.sessionId);
		if (mine.some((h) => h.event === "StopFailure" && h.t_ms > startedAt)) return { ok: false, detail: "StopFailure" };
		const last = mine.at(-1);
		const openTurn = mine.filter((h) => h.event === "UserPromptSubmit").at(-1)?.t_ms > (mine.filter((h) => h.event === "Stop").at(-1)?.t_ms ?? 0);
		const idleFor = last ? (Date.now() - last.t_ms) / 1000 : null;
		if (s.atPrompt && !openTurn && (idleFor === null || idleFor >= minIdle)) return { ok: true, s, idleFor };
		await sleep(5000);
	}
	return { ok: false, detail: "no se alcanzó la inactividad requerida" };
}

// ── Fakechat broadcast listener (receive only; never sends on the socket)
const replies = [];
function listen() {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		ws.onopen = () => resolve(ws);
		ws.onerror = () => resolve(null);
		ws.onmessage = (m) => {
			try {
				const d = JSON.parse(String(m.data));
				if (d.type !== "msg" || d.from !== "assistant") return;
				const text = String(d.text ?? "");
				replies.push({ t_ms: Date.now(), reply_to: d.replyTo ?? null, text_bytes: Buffer.byteLength(text), text_sha256: sha(text),
					ok_ids: [...new Set((text.match(/OK_P0[A-Z]\d{2}-[0-9a-f]{6}/g) ?? []).map((x) => x.slice(3)))], exact_text: text.trim() });
			} catch {}
		};
	});
}

const startedAt = Date.now();
const sendsPath = join(OUT, `sends-${label}.jsonl`);
if (existsSync(sendsPath)) renameSync(sendsPath, sendsPath.replace(".jsonl", `.${Date.now()}.jsonl`));
const s0 = session();
if (s0.err) die(`fallo del harness: ${s0.err}`);
const own = portOwnedBy(s0.pid);
if (!own.ok) die(`fallo del harness: ${own.detail}`);
const ws = await listen();
if (!ws) die(`fallo del harness: no puedo escuchar ws://127.0.0.1:${PORT}/ws`);
console.log(`sesión ${s0.sessionId} (pid ${s0.pid}); ${own.detail}`);

for (let n = 1; n <= count; n++) {
	const w = await waitIdle(s0.sessionId);
	if (!w.ok) die(`#${n} no enviado: ${w.detail}`, w.detail === "StopFailure" ? 7 : 6);
	const id = `P0${label}${String(n).padStart(2, "0")}-${randomBytes(3).toString("hex")}`;
	const text = `${id}: respondé exactamente OK_${id} y enviá tu respuesta a Fakechat.`;
	const before = hooks();
	const priorPromptIds = new Set(before.map((h) => h.prompt_id).filter(Boolean));
	const seen = before.length;
	const tSend = Date.now();
	let http = "error";
	try {
		const fd = new FormData();
		fd.set("id", id);
		fd.set("text", text);
		http = String((await fetch(`http://127.0.0.1:${PORT}/upload`, { method: "POST", body: fd })).status);
	} catch (e) { http = `error:${e.message}`; }
	const rec = { label, n, id, t_send: tSend, idle_before_s: w.idleFor, session_id: w.s.sessionId, upload_http: http };
	if (http !== "204") {
		writeFileSync(sendsPath, `${JSON.stringify({ ...rec, result: "harness-error" })}\n`, { flag: "a" });
		die(`#${n}: Fakechat respondió ${http}: fallo del harness, no NO-GO`);
	}
	let ups = null;
	let otherPrompts = 0;
	for (const end = Date.now() + 120_000; Date.now() < end && !ups; ) {
		await sleep(500);
		const fresh = hooks().slice(seen).filter((h) => h.event === "UserPromptSubmit");
		ups = fresh.find((h) => (h.test_ids ?? []).includes(id) || (h.channel_tags ?? []).some((t) => t.attrs?.message_id === id)) ?? null;
		otherPrompts = fresh.filter((h) => h !== ups).length;
	}
	let stop = null;
	let reply = null;
	let tool = null;
	let failure = false;
	if (ups) {
		for (const end = Date.now() + 300_000; Date.now() < end && !(stop && reply); ) {
			await sleep(1000);
			const fresh = hooks().slice(seen);
			failure = fresh.some((h) => h.event === "StopFailure");
			stop = fresh.find((h) => h.event === "Stop" && h.t_ms >= ups.t_ms && ups.prompt_id && h.prompt_id === ups.prompt_id) ?? null;
			tool = fresh.find((h) => (h.event === "PostToolUse" || h.event === "PostToolUseFailure") && (h.reply_to === id || (h.text_ok_ids ?? []).includes(id))) ?? null;
			reply = replies.find((r) => r.t_ms >= tSend && (r.reply_to === id || r.ok_ids.includes(id))) ?? null;
			if (failure) break;
		}
	}
	// Independent arrival evidence: the CLI logs "notifications/claude/channel:
	// <first 80 chars>" on receipt; lines start with an ISO timestamp.
	let cliReceived = null;
	const dbg = join(OUT, "claude-debug.log");
	if (existsSync(dbg)) {
		const line = readFileSync(dbg, "utf8").split("\n").find((l) => l.includes("notifications/claude/channel:") && l.includes(id));
		cliReceived = line ? { t_ms: Date.parse(line.split(" ")[0]) || null } : false;
	}
	const fresh = hooks().slice(seen);
	Object.assign(rec, {
		result: ups ? "hook" : "no-hook",
		cli_received: cliReceived,
		ups: ups && {
			t_ms: ups.t_ms, latency_ms: ups.t_ms - tSend, source_present: ups.source_present, source: ups.source,
			prompt_id: ups.prompt_id, prompt_id_seen_before: ups.prompt_id ? priorPromptIds.has(ups.prompt_id) : null,
			channel_tag_count: ups.channel_tag_count, only_channel_tags: ups.only_channel_tags, outside_text_bytes: ups.outside_text_bytes,
			tag_attr_names: ups.channel_tags?.[0]?.attr_names ?? [], tag_source: ups.channel_tags?.[0]?.attrs?.source ?? null,
			tag_message_id_matches: ups.channel_tags?.[0]?.attrs?.message_id === id, keys: ups.keys,
		},
		other_prompts_in_window: otherPrompts,
		other_prompt_events_after_send: fresh.filter((h) => h.event === "UserPromptSubmit" && h !== ups).length,
		permission_dialog: fresh.some((h) => h.event === "Notification" && /permission/.test(h.notification_type ?? "")),
		stop: stop && { latency_ms: stop.t_ms - tSend, same_prompt_id: true, ok_in_last_message: (stop.last_message_ok_ids ?? []).includes(id) },
		stops_with_other_or_no_prompt_id: fresh.filter((h) => h.event === "Stop" && h !== stop).map((h) => h.prompt_id ?? null),
		reply_tool: tool && { ok: tool.ok, tool_name: tool.tool_name, reply_to_matches: tool.reply_to === id, latency_ms: tool.t_ms - tSend },
		fakechat_reply: reply && { latency_ms: reply.t_ms - tSend, reply_to_matches: reply.reply_to === id, exact: reply.exact_text === `OK_${id}` },
		stop_failure: failure,
	});
	writeFileSync(sendsPath, `${JSON.stringify(rec)}\n`, { flag: "a" });
	console.log(`#${n} ${id}: hook=${!!ups}${ups ? ` (${rec.ups.latency_ms} ms, source=${ups.source_present ? ups.source : "<ausente>"})` : ""} · Stop=${!!stop} · respuesta en Fakechat=${!!reply}`);
	if (!ups) die(`#${n}: sin UserPromptSubmit en 120 s. Serie detenida (no se reintenta). Ver el informe.`, 5);
	if (failure) die("StopFailure (límite del plan o error): serie detenida.", 7);
}
ws.close();
console.log(`listo: ${sendsPath}`);
