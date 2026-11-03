// Regression 4: event identity is the absolute JSONL line, not object
// identity. Phase-0 test T (P0T01-f9dfb6) counted its own UserPromptSubmit
// and Stop as foreign because each read parsed new objects.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classify, singleSummary } from "../classify.mjs";
import { factsToRow, parseHookLines, windowFacts } from "../events.mjs";
import { rediagnose } from "../rediagnose.mjs";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ID = "P0T01-f9dfb6";
const T0 = 1_000_000_000_000;
const jl = (xs) => xs.map((x) => `${JSON.stringify(x)}\n`).join("");
const ups = (dt, pid, extra = {}) => ({ t_ms: T0 + dt, event: "UserPromptSubmit", session_id: "s", prompt_id: pid, source_present: false, source: null,
	keys: ["cwd", "hook_event_name", "permission_mode", "prompt", "prompt_id", "session_id", "transcript_path"], ...extra });
const chan = (dt, pid) => ups(dt, pid, { test_ids: [ID], channel_tag_count: 1, only_channel_tags: true, outside_text_bytes: 0,
	channel_tags: [{ attr_names: ["chat_id", "message_id", "source", "ts", "user"], attrs: { source: "plugin:fakechat:fakechat", message_id: ID } }] });
const stop = (dt, pid) => ({ t_ms: T0 + dt, event: "Stop", session_id: "s", prompt_id: pid, last_message_ok_ids: [ID], stop_hook_active: false, background_tasks: 0 });
const tool = (dt, pid) => ({ t_ms: T0 + dt, event: "PostToolUse", session_id: "s", prompt_id: pid, tool_name: "mcp__plugin_fakechat_fakechat__reply", reply_to: ID, text_ok_ids: [ID] });
const idle = (dt) => ({ t_ms: T0 + dt, event: "Notification", session_id: "s", prompt_id: null, notification_type: "idle_prompt" });
const before = [stop(-200_000, "p0"), idle(-140_000)];
// The T timeline as extracted (X0): one prompt, the reply tool, one Stop, idle_prompt afterwards.
const T_EVENTS = [...before, chan(53, "p1"), tool(70_179, "p1"), stop(72_754, "p1"), idle(132_810)];
const reply = { t_ms: T0 + 70_140, reply_to: ID, exact_text: `OK_${ID}`, ok_ids: [ID] };
const row = (events, from = before.length, to) => ({ label: "T", n: 1, id: ID, t_send: T0, idle_observed_s: 32,
	...factsToRow(windowFacts(events, { id: ID, fromLine: from, toLine: to }), { id: ID, tSend: T0, reply }) });

test("lecturas independientes: el propio prompt y el propio Stop no se cuentan como ajenos", () => {
	const text = jl(T_EVENTS);
	const a = windowFacts(parseHookLines(text), { id: ID, fromLine: before.length });
	const b = windowFacts(parseHookLines(text), { id: ID, fromLine: before.length });
	assert.notEqual(a.ups, b.ups, "cada lectura produce objetos nuevos (la causa del defecto)");
	assert.equal(a.ups._line, b.ups._line);
	assert.equal(a.stop._line, b.stop._line);
	assert.deepEqual(b.otherUps, []);
	assert.deepEqual(b.otherStops, []);
});

test("un solo prompt y un solo Stop (cronología de T): correlación OK, despertar y flujo sí, source ausente ⇒ no limpia", () => {
	const r = classify(row(parseHookLines(jl(T_EVENTS))));
	assert.equal(r.corrOk, true, JSON.stringify(r.corr));
	assert.equal(r.woke, true);
	assert.equal(r.bidirectional, true);
	assert.equal(r.sourceSystem, false);
	assert.equal(r.permission_dialog, false, "idle_prompt no es un diálogo de permiso");
	assert.equal(r.reply_tool.latency_ms, 70_179);
	const s = singleSummary(r);
	assert.match(s, /`source`: \*\*ausente\*\*/);
	assert.match(s, /Correlación: OK/);
	assert.match(s, /no limpia/);
});

test("Stop duplicado con el mismo prompt_id: se distingue por línea y A5 falla (R8)", () => {
	const ev = parseHookLines(jl([...before, chan(53, "p1"), stop(5_000, "p1"), stop(5_001, "p1")]));
	const f = windowFacts(ev, { id: ID, fromLine: before.length });
	assert.equal(f.stop._line, before.length + 1, "el Stop atribuido es el primero");
	assert.deepEqual(f.otherStops, [{ line: before.length + 2, prompt_id: "p1", same_prompt_id: true }]);
	const r = classify(row(ev));
	assert.equal(r.corr["A5 sin Stop ajeno"], false);
	assert.equal(r.corrOk, false);
	assert.match(singleSummary(r), /mismo prompt_id: Stop duplicado/);
});

test("dos líneas idénticas byte a byte siguen siendo dos eventos", () => {
	const ev = parseHookLines(jl([chan(53, "p1"), stop(5_000, "p1"), stop(5_000, "p1")]));
	assert.equal(ev.length, 3);
	assert.equal(windowFacts(ev, { id: ID, fromLine: 0 }).otherStops.length, 1);
});

test("prompt realmente ajeno y su Stop: A4 y A5 fallan, con su prompt_id", () => {
	const ev = parseHookLines(jl([...before, chan(53, "p1"), ups(9_000, "p2"), stop(20_000, "p2"), stop(72_754, "p1")]));
	const r = classify(row(ev));
	assert.deepEqual(r.other_prompts, [{ line: before.length + 1, prompt_id: "p2" }]);
	assert.deepEqual(r.other_stops, [{ line: before.length + 2, prompt_id: "p2", same_prompt_id: false }]);
	assert.equal(r.corr["A4 sin otros prompts"], false);
	assert.equal(r.corr["A5 sin Stop ajeno"], false);
	assert.equal(r.stop.line, before.length + 3);
});

test("una línea a medio escribir conserva su número cuando se completa", () => {
	const full = jl([chan(53, "p1"), stop(5_000, "p1")]);
	const partial = full.slice(0, full.length - 10);
	const a = parseHookLines(partial);
	const b = parseHookLines(full);
	assert.equal(a.length, 1);
	assert.equal(b.at(-1)._line, 1);
});

test("rediagnóstico de la fila original de T: corrige A4/A5 sin tocar los datos crudos", () => {
	const d = mkdtempSync(join(tmpdir(), "poc0-rediag-"));
	const out = join(d, "out");
	mkdirSync(out);
	for (const f of ["rediagnose.mjs", "events.mjs", "classify.mjs"]) copyFileSync(join(KIT, f), join(d, f));
	// The row as the buggy send.mjs wrote it: its own prompt and Stop counted as foreign.
	const bad = { ...row(parseHookLines(jl(T_EVENTS))), other_prompts: undefined, other_stops: undefined, other_prompt_events_after_send: 1,
		stops_with_other_or_no_prompt_id: ["p1"], fakechat_reply: { latency_ms: 70_140, reply_to_matches: true, exact: true } };
	delete bad.hooks_lines;
	assert.equal(classify(bad).corrOk, false);
	const sends = `${JSON.stringify(bad)}\n`;
	const hooks = jl(T_EVENTS);
	writeFileSync(join(out, "sends-T.jsonl"), sends);
	writeFileSync(join(out, "hooks.jsonl"), hooks);
	const p = spawnSync(process.execPath, [join(d, "rediagnose.mjs"), ID], { encoding: "utf8" });
	assert.equal(p.status, 0, p.stderr);
	assert.equal(readFileSync(join(out, "sends-T.jsonl"), "utf8"), sends);
	assert.equal(readFileSync(join(out, "hooks.jsonl"), "utf8"), hooks);
	const j = JSON.parse(readFileSync(join(out, `rediagnosis-${ID}.json`), "utf8"));
	assert.deepEqual(j.window, { fromLine: before.length, toLine: before.length + 2, explicit: false });
	assert.equal(j.nextOutside, null);
	assert.equal(j.prevOutside.prompt_id, "p0");
	const n = classify(j.row);
	assert.equal(n.corrOk, true);
	assert.equal(n.bidirectional, true);
	assert.equal(n.sourceSystem, false);
	const md = readFileSync(join(out, `rediagnosis-${ID}.md`), "utf8");
	assert.match(md, /Fila original: correlación FALLA \(A4 sin otros prompts, A5 sin Stop ajeno\)/);
	assert.match(md, /Recalculada: correlación OK/);
	assert.match(md, /no limpia/);
});

test("rediagnóstico con un prompt ajeno real dentro de la ventana: sigue fallando", () => {
	const ev = parseHookLines(jl([...before, chan(53, "p1"), ups(9_000, "p2"), stop(20_000, "p2"), tool(70_179, "p1"), stop(72_754, "p1")]));
	const r = rediagnose({ id: ID, label: "T", t_send: T0, ups: { latency_ms: 53 }, stop: { latency_ms: 72_754 }, fakechat_reply: { latency_ms: 70_140, exact: true, reply_to_matches: true } }, ev);
	assert.equal(classify(r.fixed).corrOk, false);
	assert.equal(r.fixed.other_prompts[0].prompt_id, "p2");
});

// The reply must equal OK_<id> byte for byte: no trim, no newline allowance.
test("respuesta de Fakechat: igualdad exacta sin normalizar espacios", async () => {
	const { replyRecord } = await import("../events.mjs");
	const { createHash } = await import("node:crypto");
	const sha = (s) => createHash("sha256").update(s).digest("hex");
	const row = (text) => factsToRow({ ups: null, stop: null, tool: null, otherUps: [], otherStops: [], promptIdSeenBefore: false },
		{ id: ID, tSend: T0, reply: replyRecord({ text, replyTo: ID }, T0 + 1000, sha) }).fakechat_reply;
	assert.equal(row(`OK_${ID}`).exact, true);
	for (const t of [` OK_${ID}`, `OK_${ID} `, `OK_${ID}\n`, `\tOK_${ID}`, `OK_${ID}  `])
		assert.equal(row(t).exact, false, JSON.stringify(t));
	assert.equal(replyRecord({ text: `OK_${ID} ` }, 1, sha).exact_text, `OK_${ID} `, "se guarda tal cual llegó");
});
