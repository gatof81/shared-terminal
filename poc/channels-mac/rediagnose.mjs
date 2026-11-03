#!/usr/bin/env bun
// Re-derive one send's window facts from the EXISTING hooks.jsonl with the
// fixed event identity (events.mjs). Read-only on the raw data: sends-*.jsonl
// and hooks.jsonl are never written; the result goes to new files.
//   bun .poc0/rediagnose.mjs P0T01-f9dfb6 [--out <dir with sends-*.jsonl and hooks.jsonl>]
//   → <out>/rediagnosis-<id>.json and .md (default <out>: .poc0/out)
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, singleSummary } from "./classify.mjs";
import { factsToRow, parseHookLines, windowFacts } from "./events.mjs";

// Rows written before the fix carry no line range. The original window began
// just before the POST and ended at the final read, which follows the last of
// {UserPromptSubmit, Stop, reply tool, Fakechat reply} by at most one 1 s poll
// plus the read itself; END_SLACK_MS covers that. The report states the window
// used and the nearest UserPromptSubmit/Stop outside it, so the reader can see
// whether a different end would change anything.
const END_SLACK_MS = 2000;

export function rediagnose(row, events) {
	let fromLine;
	let toLine;
	if (Array.isArray(row.hooks_lines)) {
		fromLine = row.hooks_lines[0];
		toLine = row.hooks_lines[1] + 1;
	} else {
		const lat = [row.ups?.latency_ms, row.stop?.latency_ms, row.reply_tool?.latency_ms, row.fakechat_reply?.latency_ms].filter((x) => typeof x === "number");
		const tEnd = row.t_send + (lat.length ? Math.max(...lat) : 0) + END_SLACK_MS;
		fromLine = events.find((h) => h.t_ms >= row.t_send)?._line ?? Number.POSITIVE_INFINITY;
		const last = events.filter((h) => h._line >= fromLine && h.t_ms <= tEnd).at(-1);
		toLine = last ? last._line + 1 : fromLine;
	}
	const f = windowFacts(events, { id: row.id, fromLine, toLine });
	// The Fakechat reply is /ws evidence, not a hook: it is carried over as recorded.
	const reply = row.fakechat_reply ? { t_ms: row.t_send + row.fakechat_reply.latency_ms, reply_to: row.fakechat_reply.reply_to_matches ? row.id : null, exact_text: row.fakechat_reply.exact ? `OK_${row.id}` : "", ok_ids: [] } : null;
	const fixed = { ...row, ...factsToRow(f, { id: row.id, tSend: row.t_send, reply }), hooks_lines: [fromLine, toLine - 1] };
	delete fixed.stops_with_other_or_no_prompt_id;
	delete fixed.other_prompts_in_window;
	const outside = events.filter((h) => (h._line < fromLine || h._line >= toLine) && (h.event === "UserPromptSubmit" || h.event === "Stop"));
	const near = (xs) => (xs.length ? { event: xs[0].event, line: xs[0]._line, dt_ms: xs[0].t_ms - row.t_send, prompt_id: xs[0].prompt_id ?? null } : null);
	return {
		fixed,
		window: { fromLine, toLine: toLine - 1, explicit: Array.isArray(row.hooks_lines) },
		prevOutside: near(outside.filter((h) => h._line < fromLine).reverse()),
		nextOutside: near(outside.filter((h) => h._line >= toLine)),
	};
}

export function rediagnosisMarkdown(row, r) {
	const o = classify(row);
	const n = classify(r.fixed);
	const failing = (c) => (c.corr ? Object.entries(c.corr).filter(([, v]) => !v).map(([k]) => k) : []);
	const ev = (x) => (x ? `${x.event} en la línea ${x.line}, ${(x.dt_ms / 1000).toFixed(3)} s, prompt_id \`${x.prompt_id ?? "—"}\`` : "ninguno");
	return [
		`## Rediagnóstico de \`${row.id}\` (registros existentes, identidad por línea)`,
		"",
		`- Ventana: líneas ${r.window.fromLine}–${r.window.toLine} de hooks.jsonl (${r.window.explicit ? "registrada en la fila" : `reconstruida: desde el envío hasta el último evento propio + ${END_SLACK_MS / 1000} s`})`,
		`- UserPromptSubmit/Stop más cercano antes de la ventana: ${ev(r.prevOutside)}`,
		`- UserPromptSubmit/Stop más cercano después de la ventana: ${ev(r.nextOutside)}`,
		`- Fila original: correlación ${o.corrOk ? "OK" : `FALLA (${failing(o).join(", ")})`}; otros prompts ${row.other_prompt_events_after_send ?? "—"}, otros Stop ${(row.other_stops ?? row.stops_with_other_or_no_prompt_id ?? []).length}`,
		`- Recalculada: correlación ${n.corrOk ? "OK" : `FALLA (${failing(n).join(", ")})`}; otros prompts ${r.fixed.other_prompt_events_after_send}, otros Stop ${r.fixed.other_stops.length}`,
		"",
		"### Prueba individual recalculada",
		"",
		singleSummary(r.fixed),
		"",
		"Los datos crudos no se modificaron. G1–G12 y R8 no cambian.",
		"",
	].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const a = process.argv.slice(2);
	const OUT = a.includes("--out") ? a[a.indexOf("--out") + 1] : join(dirname(fileURLToPath(import.meta.url)), "out");
	const id = a[0];
	if (!id) { console.error("uso: rediagnose.mjs <id>"); process.exit(1); }
	const rows = readdirSync(OUT).filter((f) => /^sends-[A-Z]\.jsonl$/.test(f))
		.flatMap((f) => readFileSync(join(OUT, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
	const row = rows.find((x) => x.id === id);
	if (!row) { console.error(`no encuentro ${id} en sends-*.jsonl`); process.exit(1); }
	const hp = join(OUT, "hooks.jsonl");
	const events = existsSync(hp) ? parseHookLines(readFileSync(hp, "utf8")) : [];
	const r = rediagnose(row, events);
	writeFileSync(join(OUT, `rediagnosis-${id}.json`), `${JSON.stringify({ window: r.window, prevOutside: r.prevOutside, nextOutside: r.nextOutside, row: r.fixed }, null, 2)}\n`);
	writeFileSync(join(OUT, `rediagnosis-${id}.md`), rediagnosisMarkdown(row, r));
	console.log(join(OUT, `rediagnosis-${id}.md`));
}
