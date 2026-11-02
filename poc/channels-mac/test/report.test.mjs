// Regression 2: agent wake and bidirectional communication are separate; a
// missing Fakechat reply never yields "flujo completo".
import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, singleSummary, summarize } from "../classify.mjs";
import { buildReport } from "../report.mjs";

const ok = (label, n, over = {}) => ({
	label, n, id: `P0${label}${String(n).padStart(2, "0")}-aaaaaa`, t_send: n, idle_observed_s: 31, result: "hook", cli_received: null,
	ups: { latency_ms: 2000, source_present: true, source: "system", prompt_id: `p${label}${n}`, prompt_id_seen_before: false,
		channel_tag_count: 1, only_channel_tags: true, tag_attr_names: ["source", "message_id"], tag_source: "plugin:fakechat:fakechat", tag_message_id_matches: true },
	other_prompt_events_after_send: 0, permission_dialog: false, stop: { latency_ms: 5000 }, stops_with_other_or_no_prompt_id: [],
	fakechat_reply: { latency_ms: 4000, exact: true }, ...over,
});
const twelve = (over = {}) => [...Array.from({ length: 10 }, (_, i) => ok("S", i + 1, over)), ok("L", 1, over), ok("L", 2, over)];

test("despertó y cerró turno pero sin respuesta en Fakechat: despertar sí, bidireccional no", () => {
	const r = classify(ok("T", 1, { fakechat_reply: null }));
	assert.equal(r.woke, true);
	assert.equal(r.responded, true);
	assert.equal(r.returned, false);
	assert.equal(r.bidirectional, false);
	const s = singleSummary(ok("T", 1, { fakechat_reply: null }));
	assert.match(s, /Comunicación bidireccional: \*\*no\*\*/);
	assert.match(s, /no limpia/);
});

test("12/12 despiertan pero falta una respuesta: el veredicto de §1.7 no cambia y el flujo NO se declara completo", () => {
	const rows = twelve();
	rows[3] = ok("S", 4, { fakechat_reply: null });
	const s = summarize(rows);
	assert.match(s.wakeVerdict, /Fase 0 superada en despertar/);
	assert.match(s.flowVerdict, /NO demostrado\*\*: 11\/12 completos/);
	const md = buildReport(rows, []);
	assert.ok(!/Flujo bidireccional observado 12\/12/.test(md));
});

test("todo completo: despertar y flujo bidireccional 12/12, en secciones separadas", () => {
	const s = summarize(twelve());
	assert.match(s.flowVerdict, /observado 12\/12/);
	const md = buildReport(twelve(), []);
	assert.ok(md.indexOf("### Despertar del agente") < md.indexOf("### Comunicación bidireccional"));
	assert.match(md, /G1–G12 de la POC no cambian/);
});

test("source ausente o sin hook nunca es despertar limpio", () => {
	assert.equal(classify(ok("T", 1, { ups: { ...ok("T", 1).ups, source_present: false, source: null } })).sourceSystem, false);
	const none = classify(ok("T", 1, { ups: null, result: "no-hook", stop: null, fakechat_reply: null }));
	assert.equal(none.woke, false);
	assert.equal(none.bidirectional, false);
});

test("un diálogo de permiso es intervención: no cuenta como despertar sin intervención", () => {
	assert.equal(classify(ok("T", 1, { permission_dialog: true })).woke, false);
});
