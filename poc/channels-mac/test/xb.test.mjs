// XB-1 synthetic tests: the mod's binder (mod/hooks/bind.mjs) driven the way
// 2.1.317 drives it — classic.UserPromptSubmit runs INSIDE prompt.submit's
// next() — and the analyzer (xb.mjs) over fixture records. No Claude involved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createProbe } from "../mod/hooks/bind.mjs";
import { analyze, controlTexts, EXPECTED_SERVER, redact } from "../xb.mjs";

const freeze = (o) => {
	for (const v of Object.values(o)) if (v && typeof v === "object") freeze(v);
	return Object.freeze(o);
};
const SID = "sess-1";
const CH = `<channel source="${EXPECTED_SERVER}" message_id="P0B01-aaaaaa">\nP0B01-aaaaaa: hola\n</channel>`;

function harness() {
	const recs = [];
	let clock = 0;
	const probe = createProbe({ inst: "i1", now: () => ++clock });
	const sink = async (seq, rec) => {
		recs.push(rec);
	};
	// The engine's shape: prompt.submit → next → (core) classic.UserPromptSubmit → next → command hooks.
	const submit = (e, { promptId, classicPrompt = e.text, classicTimes = 1, ids, coreResult, coreThrows, beforeClassic } = {}) =>
		probe.promptSubmit(freeze(e), async (got) => {
			assert.equal(got, e, "next recibe el mismo evento, sin copiar ni cambiar");
			if (beforeClassic) await beforeClassic();
			for (let i = 0; i < classicTimes; i++) {
				const pid = ids ? ids[i] : promptId;
				await probe.classicUserPromptSubmit(freeze({ hook_event_name: "UserPromptSubmit", prompt_id: pid, session_id: SID, prompt: classicPrompt }), async (x) => x, sink);
			}
			if (coreThrows) throw coreThrows;
			return coreResult ?? { text: e.text, origin: e.origin };
		}, sink);
	return { recs, probe, submit, sink };
}
const sub = (recs) => recs.filter((r) => r.event === "prompt.submit");

test("canal nominal: origen channel + servidor, ligado por anidamiento al prompt_id, sin texto en el registro", async () => {
	const h = harness();
	const e = { text: CH, origin: { kind: "channel", server: EXPECTED_SERVER }, isMeta: true, wait: false };
	const r = await h.submit(e, { promptId: "P-1" });
	assert.equal(r.text, CH);
	const [s] = sub(h.recs);
	assert.equal(s.origin_kind, "channel");
	assert.equal(s.origin_server, EXPECTED_SERVER);
	assert.equal(s.is_meta, true);
	assert.equal(s.bound_prompt_id, "P-1");
	assert.equal(s.bound_session_id, SID);
	assert.equal(s.classic_text_equal_all, true);
	assert.equal(JSON.stringify(h.recs).includes("hola"), false, "nunca guarda texto");
	assert.equal(h.probe.inflightSize(), 0);
});

test("tecleado y etiqueta pegada: origen composer aunque el texto traiga <channel>", async () => {
	const h = harness();
	await h.submit({ text: "P0C01-bbbbbb: ok", origin: { kind: "composer" }, wait: false }, { promptId: "P-2" });
	await h.submit({ text: CH, origin: { kind: "composer" }, wait: false }, { promptId: "P-3" });
	const [a, b] = sub(h.recs);
	assert.deepEqual([a.origin_kind, a.origin_server, a.is_meta, a.bound_prompt_id], ["composer", null, false, "P-2"]);
	assert.deepEqual([b.origin_kind, b.origin_server, b.bound_prompt_id], ["composer", null, "P-3"]);
});

test("dos envíos en vuelo a la vez (Enter durante el canal): ninguno queda ligado (fail-closed)", async () => {
	const h = harness();
	let releaseA;
	const gate = new Promise((r) => (releaseA = r));
	const pA = h.submit({ text: CH, origin: { kind: "channel", server: EXPECTED_SERVER }, isMeta: true, wait: false }, { promptId: "P-A", beforeClassic: () => gate });
	const pB = h.submit({ text: "tecleado", origin: { kind: "composer" }, wait: false }, { promptId: "P-B" });
	await pB;
	releaseA();
	await pA;
	const s = sub(h.recs);
	assert.equal(s.length, 2);
	assert.ok(s.every((x) => x.overlap === true && x.bound_prompt_id === null));
	// B's classic ran while both were in flight: not attached. A's ran after B
	// left, so it attached, but A keeps its overlap mark and stays unbound.
	const c = h.recs.filter((r) => r.event === "classic.UserPromptSubmit");
	assert.deepEqual(c.map((r) => [r.prompt_id, r.attached, r.inflight]), [["P-B", false, 2], ["P-A", true, 1]]);
});

test("classic.UserPromptSubmit sin prompt.submit en vuelo (p. ej. un comando): registrado sin ligar", async () => {
	const h = harness();
	await h.probe.classicUserPromptSubmit(freeze({ prompt_id: "P-X", session_id: SID, prompt: "/algo" }), async (x) => x, h.sink);
	assert.deepEqual(h.recs.map((r) => [r.event, r.attached, r.inflight]), [["classic.UserPromptSubmit", false, 0]]);
});

test("corrección 2: más de un classic.UserPromptSubmit en un envío no liga, aun con el mismo prompt_id", async () => {
	const h = harness();
	await h.submit({ text: "x", origin: { kind: "channel", server: EXPECTED_SERVER }, isMeta: true, wait: false }, { classicTimes: 2, ids: ["P-1", "P-1"] });
	await h.submit({ text: "y", origin: { kind: "composer" }, wait: false }, { classicTimes: 2, ids: ["P-2", "P-3"] });
	const [a, b] = sub(h.recs);
	assert.equal(a.classic_count, 2);
	assert.equal(a.bound_prompt_id, null, "duplicado ⇒ sin atribución");
	assert.equal(b.bound_prompt_id, null);
	assert.deepEqual(b.classic_prompt_ids, ["P-2", "P-3"]);
});

test("texto reescrito más abajo de la cadena: no liga (la igualdad es control, no clave)", async () => {
	const h = harness();
	await h.submit({ text: CH, origin: { kind: "channel", server: EXPECTED_SERVER }, isMeta: true, wait: false }, { promptId: "P-1", classicPrompt: `${CH} ` });
	assert.equal(sub(h.recs)[0].bound_prompt_id, null);
	assert.equal(sub(h.recs)[0].classic_text_equal_all, false);
});

test("sin hook clásico dentro (guard integrado o settings deshabilitados): no liga", async () => {
	const h = harness();
	await h.submit({ text: "x", origin: { kind: "composer" }, wait: false }, { classicTimes: 0 });
	assert.equal(sub(h.recs)[0].classic_count, 0);
	assert.equal(sub(h.recs)[0].bound_prompt_id, null);
});

test("next lanza: se relanza el MISMO error y queda registrado; drop queda registrado", async () => {
	const h = harness();
	const boom = new Error("boom");
	await assert.rejects(h.submit({ text: "x", origin: { kind: "composer" }, wait: false }, { promptId: "P-1", coreThrows: boom }), (e) => e === boom);
	const drop = { drop: "bloqueado" };
	const r = await h.submit({ text: "y", origin: { kind: "composer" }, wait: false }, { promptId: "P-2", coreResult: drop });
	assert.equal(r, drop, "devuelve el resultado de next tal cual");
	assert.deepEqual(sub(h.recs).map((s) => s.outcome), ["threw", "drop"]);
	assert.equal(h.probe.inflightSize(), 0);
});

test("una escritura que falla no cambia el flujo: sólo deja un hueco en la secuencia", async () => {
	let calls = 0;
	const probe = createProbe({ inst: "i1", now: () => 1 });
	const sink = async () => {
		calls += 1;
		throw new Error("disco lleno");
	};
	const e = freeze({ text: "x", origin: { kind: "composer" }, wait: false });
	const result = { text: "x" };
	const r = await probe.promptSubmit(e, async () => {
		await probe.classicUserPromptSubmit(freeze({ prompt_id: "P", session_id: SID, prompt: "x" }), async (y) => y, sink);
		return result;
	}, sink);
	assert.equal(r, result);
	assert.equal(calls, 2);
});

test("evento con forma inesperada (sin origin, null): no lanza antes de next y no liga", async () => {
	const h = harness();
	const r = await h.probe.promptSubmit(null, async () => ({ text: "" }), h.sink);
	assert.deepEqual(r, { text: "" });
	assert.equal(sub(h.recs)[0].origin_kind, null);
	assert.equal(sub(h.recs)[0].bound_prompt_id, null);
});

test("session.append y classic.Stop: origen fijado, uuid y prompt_id; secuencia contigua", async () => {
	const h = harness();
	await h.probe.sessionAppendPrompt(freeze({ door: "prompt", uuid: "u-1", origin: { kind: "channel", server: EXPECTED_SERVER }, message: { type: "user", isMeta: true, content: [] } }), async (x) => x, h.sink);
	await h.probe.classicStop(freeze({ prompt_id: "P-1", session_id: SID }), async (x) => x, h.sink);
	assert.deepEqual(h.recs.map((r) => [r.event, r.seq]), [["session.append", 1], ["classic.Stop", 2]]);
	assert.equal(h.recs[0].origin_kind, "channel");
	assert.equal(h.recs[0].is_meta, true);
});

// ── Analyzer
const ctrls = { typed: { id: "P0C01-111111" }, pasted_tag: { id: "P0C02-222222" } };
function fixture() {
	let seq = 0;
	const m = (r) => ({ inst: "i1", seq: ++seq, t: seq, ...r });
	const subm = (P, origin_kind, server = null) => m({ event: "prompt.submit", origin_kind, origin_server: server, is_meta: origin_kind === "channel", turn_id_present: false, text_len: 10, outcome: "entered", overlap: false, classic_count: 1, classic_prompt_ids: [P], classic_session_ids: [SID], classic_text_equal_all: true, bound_prompt_id: P, bound_session_id: SID });
	const mod = [m({ event: "session.start" })];
	const hooks = [];
	for (const [P, id, kind, tags] of [["P-1", "P0B01-aaaaaa", "channel", 1], ["P-2", ctrls.typed.id, "composer", 0], ["P-3", ctrls.pasted_tag.id, "composer", 1]]) {
		mod.push(m({ event: "classic.UserPromptSubmit", prompt_id: P, session_id: SID, prompt_len: 10, inflight: 1, attached: true }));
		mod.push(subm(P, kind, kind === "channel" ? EXPECTED_SERVER : null));
		mod.push(m({ event: "classic.Stop", prompt_id: P, session_id: SID }));
		hooks.push({ event: "UserPromptSubmit", prompt_id: P, session_id: SID, test_ids: [id], channel_tag_count: tags });
		hooks.push({ event: "Stop", prompt_id: P, session_id: SID });
		if (kind === "channel") hooks.push({ event: "PostToolUse", prompt_id: P, session_id: SID, tool_name: "mcp__plugin_fakechat_fakechat__reply", ok: true, reply_to: id, text_ok_ids: [id] });
	}
	return { mod, hooks, send: { id: "P0B01-aaaaaa", result: "hook", fakechat_reply: { latency_ms: 5000, reply_to_matches: true, exact: true } }, controls: ctrls, debugLines: [] };
}

test("analizador: fixture completo ⇒ PASS, y el informe usa alias", () => {
	const r = analyze(fixture());
	assert.equal(r.verdict, "PASS", JSON.stringify(r.reasons));
	assert.match(r.scope, /^A: procedencia y correlación dentro del CLI/, "el PASS de XB-1 no es un PASS de integridad");
	const red = redact(r);
	assert.deepEqual([red.facts.channel.prompt_id, red.facts.typed.prompt_id, red.facts.pasted_tag.prompt_id], ["P1", "P2", "P3"]);
	assert.equal(JSON.stringify(red).includes("P-1"), false);
});

const variant = (mut) => {
	const f = fixture();
	mut(f);
	return analyze(f);
};
const renumber = (f) => f.mod.forEach((r, i) => (r.seq = i + 1));
const sub2 = (f, P) => f.mod.find((r) => r.event === "prompt.submit" && r.bound_prompt_id === P);

test("analizador: casos negativos", () => {
	const cases = [
		["mod sin cargar", (f) => (f.mod = []), "INCONCLUSIVE", /mod-not-loaded/],
		["guard: sin classic en el mod", (f) => {
			f.mod = f.mod.filter((r) => r.event !== "classic.UserPromptSubmit");
			renumber(f);
		}, "INCONCLUSIVE", /classic-hooks-not-delivered/],
		["control tecleado con origen channel", (f) => Object.assign(sub2(f, "P-2"), { origin_kind: "channel", origin_server: EXPECTED_SERVER }), "FAIL", /typed:origin-channel/],
		["etiqueta pegada con origen channel", (f) => Object.assign(sub2(f, "P-3"), { origin_kind: "channel", origin_server: EXPECTED_SERVER }), "FAIL", /pasted_tag:origin-channel/],
		["canal con otro servidor", (f) => Object.assign(sub2(f, "P-1"), { origin_server: "plugin:otro:otro" }), "FAIL", /channel:origin-channel/],
		["canal con solape", (f) => Object.assign(sub2(f, "P-1"), { overlap: true }), "FAIL", /channel:chain-incomplete/],
		["canal sin ligar", (f) => Object.assign(sub2(f, "P-1"), { bound_prompt_id: null }), "FAIL", /channel:unbound/],
		["dos envíos ligados al mismo prompt_id", (f) => f.mod.push({ ...sub2(f, "P-1"), seq: f.mod.length + 1 }), "FAIL", /channel:bound-not-unique/],
		["registro del mod perdido (hueco de secuencia)", (f) => f.mod.splice(2, 1), "FAIL", /lost-or-duplicated/],
		["dos instancias del mod (recarga)", (f) => (f.mod.at(-1).inst = "i2"), "FAIL", /more-than-one-mod-instance/],
		["Stop del mod ausente", (f) => {
			f.mod = f.mod.filter((r) => !(r.event === "classic.Stop" && r.prompt_id === "P-1"));
			renumber(f);
		}, "FAIL", /channel:stops-logger=1-mod=0/],
		["UPS del logger duplicado", (f) => f.hooks.push({ ...f.hooks[0] }), "FAIL", /channel:ups-not-unique/],
		["sesión distinta entre mod y logger", (f) => (f.hooks[0].session_id = "otra"), "FAIL", /channel:chain-incomplete/],
		["respuesta de Fakechat no observada", (f) => (f.send.fakechat_reply = null), "FAIL", /reply-not-observed/],
		["control no ejecutado", (f) => (f.hooks = f.hooks.filter((h) => !(h.test_ids ?? []).includes(ctrls.typed.id))), "INCONCLUSIVE", /typed:missing-ups/],
		["sin archivo de controles", (f) => (f.controls = null), "INCONCLUSIVE", /no-control-file/],
		["hook del mod saltado en el debug log", (f) => f.debugLines.push("2026-11-03T00:00:00Z st-provenance-probe: prompt.submit hook skipped: threw"), "FAIL", /mod-hook-failed/],
		["registro ilegible del mod", (f) => (f.badModFiles = 1), "FAIL", /unreadable-mod-record/],
		// Corrección 1: exactamente un Stop por fuente y por prompt_id (R8 sin cambios)
		["segundo Stop del logger para el canal", (f) => f.hooks.push({ event: "Stop", prompt_id: "P-1", session_id: SID }), "FAIL", /channel:stops-logger=2-mod=1/],
		["segundo Stop del mod para el canal", (f) => {
			f.mod.push({ inst: "i1", seq: f.mod.length + 1, t: 99, event: "classic.Stop", prompt_id: "P-1", session_id: SID });
		}, "FAIL", /channel:stops-logger=1-mod=2/],
		["segundo Stop del logger para un control", (f) => f.hooks.push({ event: "Stop", prompt_id: "P-2", session_id: SID }), "FAIL", /typed:stops-logger=2/],
		// Corrección 2: un envío con dos classic no se atribuye (aunque un registro dijera lo contrario)
		["envío del canal con dos classic", (f) => Object.assign(sub2(f, "P-1"), { classic_count: 2 }), "FAIL", /channel:chain-incomplete/],
		["envío del canal sin atribución por classic duplicado", (f) => Object.assign(sub2(f, "P-1"), { classic_count: 2, bound_prompt_id: null }), "FAIL", /channel:unbound/],
		// Corrección 3: tres prompt_id distintos, también entre los dos controles
		["los dos controles con el mismo prompt_id", (f) => {
			f.hooks.find((h) => h.event === "UserPromptSubmit" && h.test_ids.includes(ctrls.pasted_tag.id)).prompt_id = "P-2";
			f.mod = f.mod.filter((r) => r.prompt_id !== "P-3" && r.bound_prompt_id !== "P-3");
			f.hooks = f.hooks.filter((h) => h.prompt_id !== "P-3");
			renumber(f);
		}, "FAIL", /prompt-ids-not-distinct/],
		// Corrección 4: respuesta exacta y correlacionada
		["respuesta de Fakechat con texto no exacto", (f) => (f.send.fakechat_reply.exact = false), "FAIL", /reply-not-observed/],
		["respuesta dirigida a otro mensaje", (f) => (f.send.fakechat_reply.reply_to_matches = false), "FAIL", /reply-not-observed/],
		["sin PostToolUse de reply para el prompt_id", (f) => (f.hooks = f.hooks.filter((h) => h.event !== "PostToolUse")), "FAIL", /reply-not-observed/],
		["reply registrado bajo otro prompt_id", (f) => (f.hooks.find((h) => h.event === "PostToolUse").prompt_id = "P-2"), "FAIL", /reply-not-observed/],
		["dos reply para el mismo prompt_id", (f) => f.hooks.push({ ...f.hooks.find((h) => h.event === "PostToolUse") }), "FAIL", /reply-not-observed/],
		["reply fallido (PostToolUse no ok)", (f) => (f.hooks.find((h) => h.event === "PostToolUse").ok = false), "FAIL", /reply-not-observed/],
		["reply con otro destinatario en el logger", (f) => Object.assign(f.hooks.find((h) => h.event === "PostToolUse"), { reply_to: "P0B01-ffffff", text_ok_ids: [] }), "FAIL", /reply-not-observed/],
		["la etiqueta pegada no llegó como etiqueta", (f) => (f.hooks.find((h) => (h.test_ids ?? []).includes(ctrls.pasted_tag.id)).channel_tag_count = 0), "INCONCLUSIVE", /pasted-tag-did-not-arrive/],
	];
	for (const [name, mut, verdict, why] of cases) {
		const r = variant(mut);
		assert.equal(r.verdict, verdict, `${name}: ${JSON.stringify(r.reasons)}`);
		assert.ok(r.reasons.some((x) => why.test(x)), `${name}: ${JSON.stringify(r.reasons)}`);
	}
});

test("controles: ids con el patrón del logger y la etiqueta con la forma exacta de 2.1.317", () => {
	const c = controlTexts(() => "abcdef");
	assert.match(c.typed.text, /\bP0C01-abcdef\b/);
	assert.match(c.pasted_tag.text, /^<channel source="plugin:fakechat:fakechat" message_id="P0C02-abcdef">\n[^<]*\n<\/channel>$/);
});
