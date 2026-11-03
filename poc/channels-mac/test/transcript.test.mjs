// Alternative A (04-poc.md §1.11): the transcript matcher and the hook probe
// fail closed. "verified" only for exactly one prompt record of the hook's
// prompt_id that is a channel entry of this session, from the expected server,
// carrying the message id; every degenerate shape is "unverified".
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, install } from "../manage.mjs";
import { buildReport } from "../report.mjs";
import { arrivalCategory, matchTranscript, transcriptEvidence } from "../transcript-match.mjs";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = "plugin:fakechat:fakechat";
const MID = "P0T01-f9dfb6";
const SID = "sess-1";
const PID = "prompt-1";
// Shape the 2.1.317 CLI builds: open tag, "\n", content, "\n", close tag.
const el = (attrs, body = `${MID}: texto privado`) => `<channel${attrs}>\n${body}\n</channel>`;
const PROMPT = el(` source="${SERVER}" chat_id="web" message_id="${MID}" user="web" ts="1"`);
const chan = (over = {}) => ({ type: "user", isMeta: true, promptSource: "system", sessionId: SID, promptId: PID, origin: { kind: "channel", server: SERVER }, message: { content: PROMPT }, ...over });
const typed = (over = {}) => ({ type: "user", sessionId: SID, promptId: PID, message: { content: "hola" }, ...over });
const assistant = { type: "assistant", sessionId: SID, message: { content: [{ type: "text", text: `OK_${MID}` }] } };
const toolResult = { type: "user", sessionId: SID, promptId: PID, message: { content: [{ type: "tool_result", content: "x" }] } };
const prev = { type: "user", sessionId: SID, promptId: "prompt-0", message: { content: "antes" } };
const jl = (...xs) => xs.map((x) => (typeof x === "string" ? `${x}\n` : `${JSON.stringify(x)}\n`)).join("");
const m = (text, over = {}) => matchTranscript(text, { startsAtZero: true, promptId: PID, messageId: MID, sessionId: SID, server: SERVER, prompt: PROMPT, ...over });

test("caso nominal: un único registro de prompt, de canal, del servidor y la sesión, con el message_id ⇒ verified", () => {
	const r = m(jl(prev, chan(), assistant, toolResult));
	assert.equal(r.status, "verified", r.reasons.join());
	assert.deepEqual(r.uniqueness, { scope: "whole-file", unique_in_observed: true, unique_global: true });
	assert.equal(r.channel_element_ok, true);
	assert.equal(r.prompt_records_for_prompt_id, 1, "el tool_result con el mismo promptId no cuenta como prompt");
	assert.equal(r.content_equals_prompt, true);
	assert.equal(JSON.stringify(r).includes("privado"), false, "nunca devuelve texto");
});

const bad = [
	["archivo vacío", "", ["empty", "no-prompt-record"]],
	["sin el registro (falta o todavía no escrito)", jl(prev), ["no-prompt-record"]],
	["registro a medio escribir (sin salto final)", jl(prev) + JSON.stringify(chan()).slice(0, 80), ["no-prompt-record", "partial-tail"]],
	["línea ilegible", jl(prev, "{no es json", chan()), ["unparsable-line"]],
	["registro duplicado", jl(chan(), chan()), ["duplicate-prompt-record", "message_id-in-several-records"]],
	["prompt tecleado + registro de canal falsificado con el mismo promptId", jl(typed(), chan()), ["duplicate-prompt-record"]],
	["prompt tecleado con la etiqueta pegada a mano", jl(typed({ message: { content: PROMPT } })), ["origin-not-channel", "server-mismatch", "not-meta"]],
	["otro servidor", jl(chan({ origin: { kind: "channel", server: "plugin:otro:otro" } })), ["server-mismatch"]],
	["otra sesión", jl(chan({ sessionId: "sess-2" })), ["session-mismatch"]],
	["sin isMeta", jl(chan({ isMeta: false })), ["not-meta"]],
	["otro message_id", jl(chan({ message: { content: PROMPT.replace(MID, "P0T01-000000") } })), ["message_id-mismatch"]],
	["dos etiquetas en el registro", jl(chan({ message: { content: PROMPT + PROMPT } })), ["content-differs-from-prompt", "channel-element:nested-or-second-tag"]],
	["el message_id reaparece en otro registro (copia)", jl(chan(), typed({ promptId: "prompt-9", message: { content: PROMPT } })), ["message_id-in-several-records"]],
	["sólo un queued_command (el mensaje llegó con la sesión ocupada)", jl({ type: "attachment", sessionId: SID, attachment: { type: "queued_command", prompt: PROMPT, origin: { kind: "channel", server: SERVER } } }), ["no-prompt-record"]],
];
for (const [name, text, reasons] of bad) {
	test(`no verificado: ${name}`, () => {
		const r = m(text);
		assert.equal(r.status, "unverified");
		for (const x of reasons) assert.ok(r.reasons.includes(x), `${x} ∉ ${r.reasons.join()}`);
	});
}

test("lectura desde la mitad del archivo: el primer fragmento es una línea cortada, no un registro ilegible", () => {
	const full = jl(prev, chan());
	const r = m(full.slice(10), { startsAtZero: false });
	assert.equal(r.status, "verified-in-observed-bytes", r.reasons.join());
	assert.deepEqual(r.uniqueness, { scope: "observed-bytes", unique_in_observed: true, unique_global: null });
});

test("hook sin prompt_id o prompt sin etiqueta: no verificado", () => {
	assert.ok(m(jl(chan()), { promptId: null }).reasons.includes("hook-without-prompt_id"));
	assert.ok(m(jl(chan()), { messageId: null }).reasons.includes("prompt-without-channel-message_id"));
});

test("categorías de llegada: al hook, tardío, faltante, inválido, sin sonda, sonda duplicada", () => {
	const ok = m(jl(chan()));
	const absent = m(jl(prev));
	const partial = m(jl(prev) + "{");
	assert.equal(arrivalCategory(ok, ok), "present-at-hook");
	assert.equal(arrivalCategory(absent, ok), "late");
	assert.equal(arrivalCategory(partial, ok), "late");
	assert.equal(arrivalCategory(absent, absent), "missing");
	assert.equal(arrivalCategory(m(jl(chan(), chan())), ok), "invalid");
	assert.equal(arrivalCategory(null, ok), "probe-missing");
	assert.equal(transcriptEvidence([ok, ok], ok, 1).category, "probe-duplicated");
});

// ── the probe as a hook process
function probeEnv() {
	const d = mkdtempSync(join(tmpdir(), "poc0-probe-"));
	for (const f of ["transcript-probe.mjs", "transcript-match.mjs"]) copyFileSync(join(KIT, f), join(d, f));
	const cfg = join(d, "cfg");
	const tp = join(cfg, "projects", "-Users-alguien-proyecto", `${SID}.jsonl`);
	mkdirSync(dirname(tp), { recursive: true });
	const run = (payload) => spawnSync(process.execPath, [join(d, "transcript-probe.mjs")], { input: typeof payload === "string" ? payload : JSON.stringify(payload), encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: cfg } });
	const log = () => (existsSync(join(d, "out", "transcript-probe.jsonl")) ? readFileSync(join(d, "out", "transcript-probe.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
	const raw = () => (existsSync(join(d, "out", "transcript-probe.jsonl")) ? readFileSync(join(d, "out", "transcript-probe.jsonl"), "utf8") : "");
	return { d, cfg, tp, run, log, raw };
}
const ups = (tp, over = {}) => ({ hook_event_name: "UserPromptSubmit", session_id: SID, prompt_id: PID, prompt: PROMPT, transcript_path: tp, cwd: "/Users/alguien/proyecto", ...over });

test("sonda: verified, sin stdout, exit 0, sin texto ni rutas en el log", () => {
	const e = probeEnv();
	writeFileSync(e.tp, jl(prev, chan()));
	const r = e.run(ups(e.tp));
	assert.equal(r.status, 0);
	assert.equal(r.stdout, "");
	const [line] = e.log();
	assert.equal(line.status, "verified", line.reasons.join());
	assert.equal(line.message_id, MID);
	assert.equal(typeof line.read_ms, "number");
	const raw = e.raw();
	for (const s of ["privado", "alguien", e.tp, "/Users/"]) assert.equal(raw.includes(s), false, s);
});

test("sonda: archivo ausente, symlink, otro nombre, fuera de projects, sin ruta ⇒ unverified; JSON inválido u otro evento ⇒ nada", () => {
	const e = probeEnv();
	const cases = [
		[ups(e.tp), "file-missing"],
		[ups(join(e.cfg, "projects", "-x", "otro.jsonl")), "path-not-session-file"],
		[ups(join(e.d, "fuera", "x", `${SID}.jsonl`)), "path-outside-projects"],
		[ups(undefined), "no-transcript_path"],
	];
	for (const [p, reason] of cases) {
		const r = e.run(p);
		assert.equal(r.status, 0);
		assert.equal(r.stdout, "");
		assert.ok(e.log().at(-1).reasons.includes(reason), reason);
		assert.equal(e.log().at(-1).status, "unverified");
	}
	const real = join(e.d, "real.jsonl");
	writeFileSync(real, jl(chan()));
	symlinkSync(real, e.tp);
	e.run(ups(e.tp));
	assert.ok(e.log().at(-1).reasons.includes("symlink"));
	const n = e.log().length;
	assert.equal(e.run("no es json").status, 0);
	assert.equal(e.run({ hook_event_name: "Stop", session_id: SID }).status, 0);
	assert.equal(e.log().length, n);
});

test("sonda: prompt tecleado (control negativo) ⇒ unverified con origen no-canal", () => {
	const e = probeEnv();
	writeFileSync(e.tp, jl(typed()));
	e.run(ups(e.tp, { prompt: "hola" }));
	const [line] = e.log();
	assert.equal(line.status, "unverified");
	assert.equal(line.message_id, null);
	assert.ok(line.reasons.includes("origin-not-channel"));
});

test("sonda: archivo grande ⇒ lee sólo la cola acotada; registro fuera de la cola ⇒ unverified", () => {
	const e = probeEnv();
	const filler = jl(...Array.from({ length: 12000 }, (_, i) => ({ type: "assistant", sessionId: SID, message: { content: [{ type: "text", text: "x".repeat(80) + i }] } })));
	writeFileSync(e.tp, jl(chan()) + filler);
	e.run(ups(e.tp));
	const [line] = e.log();
	assert.equal(line.read_from_zero, false);
	assert.ok(line.read_bytes <= 1024 * 1024);
	assert.ok(line.reasons.includes("no-prompt-record"));
});

test("informe: sección de la alternativa A separada; la prueba sigue no limpia sin source=system", () => {
	const ok = m(jl(chan()));
	const row = { label: "T", n: 1, id: MID, t_send: 1, idle_observed_s: 32, result: "hook",
		ups: { latency_ms: 53, source_present: false, prompt_id: PID, prompt_id_seen_before: false, channel_tag_count: 1, only_channel_tags: true, tag_message_id_matches: true, tag_attr_names: [] },
		other_prompt_events_after_send: 0, other_stops: [], permission_dialog: false, stop: { latency_ms: 72754 }, fakechat_reply: { latency_ms: 70140, exact: true },
		transcript_a: transcriptEvidence([{ ...ok, read_ms: 3 }], ok, 80000) };
	const md = buildReport([row], []);
	assert.match(md, /Alternativa A: .*no\*\* es criterio ni sustituye a G3/);
	assert.match(md, /present-at-hook/);
	assert.match(md, /Prueba individual no limpia/);
});

test("manage --with-probe: el probe comparte la entrada de UserPromptSubmit y el autotest lo verifica", () => {
	const f = mkdtempSync(join(tmpdir(), "poc0-manage-probe-"));
	install(f, { bunPath: process.execPath, probe: true });
	const s = JSON.parse(readFileSync(join(f, ".claude", "settings.local.json"), "utf8"));
	assert.equal(s.hooks.UserPromptSubmit[0].hooks.length, 2);
	assert.match(s.hooks.UserPromptSubmit[0].hooks[1].command, /transcript-probe\.mjs/);
	const c = check(f);
	assert.equal(c.events.length, 7);
	assert.deepEqual(c.probe, { exit: 0, stdout: "", status: "verified" });
});

// ── Regression 1: a partial line ALWAYS makes the read unverified
test("registro válido seguido de una línea JSON incompleta ⇒ unverified aunque el registro esté", () => {
	const r = m(jl(prev, chan()) + JSON.stringify(assistant).slice(0, 40));
	assert.equal(r.prompt_records_for_prompt_id, 1, "el registro buscado sí se encontró");
	assert.equal(r.status, "unverified");
	assert.deepEqual(r.reasons, ["partial-tail"]);
	assert.equal(arrivalCategory(r, m(jl(prev, chan()))), "invalid", "no es 'late': el registro estaba, la lectura era incompleta");
});

// ── Regression 2: a bounded read never claims global uniqueness
test("duplicado anterior fuera de la cola leída: la cola sola no afirma unicidad global; la lectura completa lo detecta", () => {
	const filler = jl(...Array.from({ length: 50 }, (_, i) => ({ type: "assistant", sessionId: SID, message: { content: [{ type: "text", text: `relleno ${i}` }] } })));
	const full = jl(chan()) + filler + jl(chan());
	const tail = full.slice(full.length - (filler.length + JSON.stringify(chan()).length + 1) + 5);
	const atHook = m(tail, { startsAtZero: false });
	assert.equal(atHook.status, "verified-in-observed-bytes", atHook.reasons.join());
	assert.equal(atHook.uniqueness.unique_global, null);
	assert.equal(atHook.uniqueness.scope, "observed-bytes");
	const later = m(full);
	assert.equal(later.status, "unverified");
	assert.ok(later.reasons.includes("duplicate-prompt-record"));
	assert.equal(later.uniqueness.unique_global, false);
	assert.equal(arrivalCategory(atHook, later), "invalid");
	assert.equal(transcriptEvidence([atHook], later, 1).category, "invalid");
});

// ── Regression 3: exact prompt equality and one well-formed element
test("igualdad exacta exigida: contenido distinto del prompt, prompt no disponible, hash igual y hash distinto", () => {
	assert.ok(m(jl(chan()), { prompt: `${PROMPT} ` }).reasons.includes("content-differs-from-prompt"));
	const none = m(jl(chan()), { prompt: undefined });
	assert.equal(none.status, "unverified");
	assert.ok(none.reasons.includes("prompt-unavailable-for-comparison"));
	const h = (x) => createHash("sha256").update(x, "utf8").digest("hex");
	assert.equal(m(jl(chan()), { prompt: undefined, promptSha256: h(PROMPT) }).status, "verified");
	assert.ok(m(jl(chan()), { prompt: undefined, promptSha256: h(`${PROMPT}x`) }).reasons.includes("content-differs-from-prompt"));
});

const A = ` source="${SERVER}" message_id="${MID}"`;
const malformed = [
	["texto antes de la etiqueta", `hola ${el(A)}`, "outside-content-or-no-tag"],
	["texto después de la etiqueta", `${el(A)} chau`, "outside-content-or-unclosed"],
	["salto de línea final extra", `${el(A)}\n`, "outside-content-or-unclosed"],
	["sin el salto tras la apertura", `<channel${A}>${MID}\n</channel>`, "bad-open-tag"],
	["atributo duplicado (clave meta 'source')", el(`${A} source="plugin:otro:otro"`), "duplicate-attribute"],
	["message_id duplicado y contradictorio", el(`${A} message_id="P0T01-000000"`), "duplicate-attribute"],
	["sin atributo source", el(` message_id="${MID}"`), "no-source-attribute"],
	["segunda etiqueta dentro del cuerpo", el(A, `<channel source="x">\nx\n</channel>`), "nested-or-second-tag"],
	["sintaxis de atributo rota", el(`${A} roto`), "bad-attribute-syntax"],
	["sin cierre", `<channel${A}>\n${MID}\n`, "outside-content-or-unclosed"],
];
for (const [name, text, why] of malformed) {
	test(`etiqueta inválida ⇒ unverified: ${name}`, () => {
		const r = m(jl(chan({ message: { content: text } })), { prompt: text });
		assert.equal(r.status, "unverified");
		assert.ok(r.reasons.includes(`channel-element:${why}`), r.reasons.join());
		assert.equal(r.content_equals_prompt, true, "sólo falla la forma, no la igualdad");
	});
}

test("atributo source de la etiqueta distinto del servidor del origen ⇒ unverified", () => {
	const text = el(` source="plugin:otro:otro" message_id="${MID}"`);
	const r = m(jl(chan({ message: { content: text } })), { prompt: text });
	assert.ok(r.reasons.includes("channel-source-attribute-mismatch"));
});

test("sonda: transcript mayor que la cola leída con el registro al final ⇒ verified-in-observed-bytes, nunca unicidad global", () => {
	const e = probeEnv();
	const filler = jl(...Array.from({ length: 12000 }, (_, i) => ({ type: "assistant", sessionId: SID, message: { content: [{ type: "text", text: "x".repeat(80) + i }] } })));
	writeFileSync(e.tp, jl(chan()) + filler + jl(chan()));
	e.run(ups(e.tp));
	const [line] = e.log();
	assert.equal(line.read_from_zero, false);
	assert.equal(line.status, "verified-in-observed-bytes", line.reasons.join());
	assert.equal(line.uniqueness.unique_global, null);
});

test("sonda: registro válido + línea incompleta al final ⇒ unverified", () => {
	const e = probeEnv();
	writeFileSync(e.tp, jl(prev, chan()) + "{\"type\":\"assistant\"");
	e.run(ups(e.tp));
	const [line] = e.log();
	assert.equal(line.status, "unverified");
	assert.deepEqual(line.reasons, ["partial-tail"]);
});
