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
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { factsToRow, parseHookLines, windowFacts } from "./events.mjs";
import { createIdleTracker } from "./idle.mjs";
import { matchTranscript, transcriptEvidence } from "./transcript-match.mjs";

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
// Only the single instrumented test is authorized for now; the 12-sample
// series need a separate decision and an explicit flag.
if (label !== "T" && !args.includes("--series-authorized")) die("sólo está autorizada la prueba individual (--label T --count 1); las series necesitan --series-authorized", 1);
if (label === "T" && count !== 1) die("la prueba individual es de un solo mensaje (--count 1)", 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (c, a) => spawnSync(c, a, { encoding: "utf8", timeout: 30_000 });
const sha = (s) => createHash("sha256").update(s).digest("hex");
const hooks = () => {
	const p = join(OUT, "hooks.jsonl");
	return existsSync(p) ? parseHookLines(readFileSync(p, "utf8")) : [];
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

// --min-idle is enforced as CONTINUOUS observation (idle.mjs): one probe every
// POLL_MS; any probe off the prompt, any new hook line or a gap > MAX_GAP_MS
// restarts the window. The hooks file may be empty or missing: it only feeds
// "did anything happen", never "how long ago".
const POLL_MS = 3000;
const MAX_GAP_MS = 10_000;
async function waitIdle() {
	const tracker = createIdleTracker({ minIdleMs: minIdle * 1000, maxGapMs: MAX_GAP_MS });
	const end = Date.now() + (minIdle + 900) * 1000;
	while (Date.now() < end) {
		const s = session();
		if (s.err) return { ok: false, detail: s.err };
		const all = hooks();
		if (all.some((h) => h.event === "StopFailure" && h.t_ms > startedAt)) return { ok: false, detail: "StopFailure" };
		const mine = all.filter((h) => !s.sessionId || h.session_id === s.sessionId);
		const lastUps = mine.filter((h) => h.event === "UserPromptSubmit").at(-1)?.t_ms ?? 0;
		const lastStop = mine.filter((h) => h.event === "Stop" || h.event === "StopFailure").at(-1)?.t_ms ?? 0;
		const st = tracker.observe({ tMs: Date.now(), atPrompt: s.atPrompt, openTurn: lastUps > lastStop, hookCount: all.length });
		if (st.ready) return { ok: true, s, idleObservedS: st.observedMs / 1000, observations: st.observations };
		await sleep(POLL_MS);
	}
	return { ok: false, detail: "no se observó la inactividad continua requerida" };
}

// ── Alternative A: the probe's hook-time verdict vs a later read of the whole
// transcript (after the turn). Read-only; the transcript is located by session
// id and its path is never written anywhere.
function laterTranscriptCheck(ups, id, tSend) {
	const pp = join(OUT, "transcript-probe.jsonl");
	const probeLines = existsSync(pp)
		? readFileSync(pp, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }).filter((x) => x.prompt_id && x.prompt_id === ups.prompt_id)
		: [];
	const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
	const files = existsSync(projects) ? readdirSync(projects).map((d) => join(projects, d, `${ups.session_id}.jsonl`)).filter((x) => existsSync(x)) : [];
	let later = null;
	const t = Date.now();
	if (files.length === 1) {
		try {
			// Exact equality with the hook's prompt through the logger's SHA-256
			// of it: the harness never holds the prompt text itself.
			later = matchTranscript(readFileSync(files[0], "utf8"), { startsAtZero: true, promptId: ups.prompt_id, messageId: id, sessionId: ups.session_id,
				server: process.env.POC0_CHANNEL_SERVER ?? "plugin:fakechat:fakechat", promptSha256: ups.prompt_sha256 });
		} catch {
			later = { status: "unverified", reasons: ["unreadable"], prompt_records_for_prompt_id: 0 };
		}
	} else later = { status: "unverified", reasons: [files.length ? "several-files" : "file-missing"], prompt_records_for_prompt_id: 0 };
	return transcriptEvidence(probeLines, later, t - tSend);
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
	const w = await waitIdle();
	if (!w.ok) die(`#${n} no enviado: ${w.detail}`, w.detail === "StopFailure" ? 7 : 6);
	const id = `P0${label}${String(n).padStart(2, "0")}-${randomBytes(3).toString("hex")}`;
	const text = `${id}: respondé exactamente OK_${id} y enviá tu respuesta a Fakechat.`;
	// The window starts after the last line parsed before the send; every
	// later comparison is by absolute line (events.mjs), never object identity.
	// A line still being written at that instant lands inside the window: an
	// extra event can only make the row stricter, never cleaner.
	const fromLine = hooks().reduce((m, h) => Math.max(m, h._line + 1), 0);
	const tSend = Date.now();
	let http = "error";
	try {
		const fd = new FormData();
		fd.set("id", id);
		fd.set("text", text);
		http = String((await fetch(`http://127.0.0.1:${PORT}/upload`, { method: "POST", body: fd })).status);
	} catch (e) { http = `error:${e.message}`; }
	const rec = { label, n, id, t_send: tSend, idle_observed_s: w.idleObservedS, idle_observations: w.observations, session_id: w.s.sessionId, upload_http: http };
	if (http !== "204") {
		writeFileSync(sendsPath, `${JSON.stringify({ ...rec, result: "harness-error" })}\n`, { flag: "a" });
		die(`#${n}: Fakechat respondió ${http}: fallo del harness, no NO-GO`);
	}
	let f = windowFacts([], { id, fromLine });
	for (const end = Date.now() + 120_000; Date.now() < end && !f.ups; ) {
		await sleep(500);
		f = windowFacts(hooks(), { id, fromLine });
	}
	let reply = null;
	if (f.ups) {
		for (const end = Date.now() + 300_000; Date.now() < end && !(f.stop && reply); ) {
			await sleep(1000);
			f = windowFacts(hooks(), { id, fromLine });
			reply = replies.find((r) => r.t_ms >= tSend && (r.reply_to === id || r.ok_ids.includes(id))) ?? null;
			if (f.stopFailure) break;
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
	// Final facts from ONE read; the window's line range is recorded so the
	// row can be re-derived from hooks.jsonl later without guessing.
	f = windowFacts(hooks(), { id, fromLine });
	Object.assign(rec, factsToRow(f, { id, tSend, reply }), { cli_received: cliReceived, hooks_lines: [fromLine, f.lastLine] });
	if (f.ups) rec.transcript_a = laterTranscriptCheck(f.ups, id, tSend);
	writeFileSync(sendsPath, `${JSON.stringify(rec)}\n`, { flag: "a" });
	console.log(`#${n} ${id}: hook=${!!f.ups}${f.ups ? ` (${rec.ups.latency_ms} ms, source=${f.ups.source_present ? f.ups.source : "<ausente>"})` : ""} · Stop=${!!f.stop} · respuesta en Fakechat=${!!reply}`);
	if (!f.ups) die(`#${n}: sin UserPromptSubmit en 120 s. Serie detenida (no se reintenta). Ver el informe.`, 5);
	if (f.stopFailure) die("StopFailure (límite del plan o error): serie detenida.", 7);
}
ws.close();
console.log(`listo: ${sendsPath}`);
