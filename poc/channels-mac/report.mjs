#!/usr/bin/env bun
// Build the phase-0 instrumented report section for PR #512 from .poc0/out.
//   bun .poc0/report.mjs   → .poc0/out/phase0-instrumented-report.md
// Agent wake and bidirectional communication are reported SEPARATELY; a
// missing Fakechat reply is never reported as a complete flow. The §1.7
// verdict is applied as written; G1–G12 are not evaluated or changed here.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { singleSummary, summarize } from "./classify.mjs";

export function buildReport(sends, hooks) {
	const { rows, agg, wakeVerdict, flowVerdict } = summarize(sends);
	const single = sends.filter((r) => r.label === "T").at(-1);
	const yn = (b) => (b ? "sí" : "no");
	const sec = (x) => (typeof x === "number" ? (x / 1000).toFixed(2) : "—");
	const keysSeen = {};
	for (const h of hooks) keysSeen[h.event] = [...new Set([...(keysSeen[h.event] ?? []), ...(h.keys ?? [])])].sort();
	return [
		"## Fase 0 instrumentada — resultados",
		"",
		"| Entorno | Valor |", "| --- | --- |",
		"| Fecha | _(completar)_ |", "| macOS | _(completar: `sw_vers -productVersion`)_ |",
		"| Claude Code | _(completar: `claude --version`)_ |",
		"| Autenticación | suscripción de Claude, login oficial (sin API key, sin uso extra) |",
		"| Plugin | `fakechat@claude-plugins-official` |",
		"| Terminal de Claude sin tocar durante la prueba | _(completar: sí / no)_ |",
		"",
		"### Prueba individual (T)",
		"",
		singleSummary(single),
		"",
		"### Despertar del agente (criterio de §1.7)",
		"",
		`Veredicto: ${wakeVerdict}`,
		"",
		"### Comunicación bidireccional (dimensión aparte; no forma parte del veredicto de §1.7)",
		"",
		`Resultado: ${flowVerdict}`,
		"",
		"### Por mensaje",
		"",
		"| Id | Inactividad observada (s) | Recibido por el CLI | Hook | Despertó | Turno cerrado | Respuesta en Fakechat | Bidireccional | Latencia hook / Stop / Fakechat (s) | `source` | Forma del prompt | Correlación |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
		...rows.map((r) => {
			const u = r.ups;
			const shape = u ? `${u.channel_tag_count} etiqueta(s); sólo etiquetas: ${yn(u.only_channel_tags)}; atributos: ${(u.tag_attr_names ?? []).join(",")}; source de la etiqueta: \`${u.tag_source}\`` : "—";
			const corr = r.corr ? (r.corrOk ? "OK" : `FALLA: ${Object.entries(r.corr).filter(([, v]) => !v).map(([k]) => k).join(", ")}`) : "—";
			return `| \`${r.id}\` | ${typeof r.idle_observed_s === "number" ? Math.round(r.idle_observed_s) : "—"} | ${r.cli_received === null || r.cli_received === undefined ? "sin log" : yn(!!r.cli_received)} | ${yn(!!u)} | ${yn(r.woke)}${r.permission_dialog ? " (diálogo de permiso)" : ""} | ${yn(r.responded)} | ${yn(r.returned)}${r.fakechat_reply?.exact ? " (exacta)" : ""} | ${yn(r.bidirectional)} | ${sec(u?.latency_ms)} / ${sec(r.stop?.latency_ms)} / ${sec(r.fakechat_reply?.latency_ms)} | ${u ? (u.source_present ? `\`${u.source}\`` : "**ausente**") : "—"} | ${shape} | ${corr} |`;
		}),
		"",
		"### Agregados (series S y L; T no cuenta)",
		"",
		`- Con hook: ${agg.hooked}/${agg.formal} · despertaron: ${agg.woke}/${agg.formal} · \`source=system\`: ${agg.sourceSystem}/${agg.hooked} · \`source\` ausente: ${agg.sourceAbsent}/${agg.hooked}`,
		`- Correlación completa: ${agg.corrOk}/${agg.formal} · respuesta vista en Fakechat: ${agg.returned}/${agg.formal} · bidireccionales: ${agg.bidirectional}/${agg.formal}`,
		"",
		"### Campos recibidos por evento (nombres, no valores)",
		"",
		...Object.entries(keysSeen).map(([e, k]) => `- \`${e}\`: ${k.map((x) => `\`${x}\``).join(", ")}`),
		"",
		"### Qué queda comprobado y qué sigue siendo hipótesis",
		"",
		"| Afirmación | Estado tras esta prueba |", "| --- | --- |",
		"| Una entrada de canal produce `UserPromptSubmit` | ver columnas Hook / Despertó |",
		"| `source=system` presente (requisito de #512 §5) | ver columna `source` |",
		"| Las claves de `meta` aparecen como atributos de `<channel>` | observable con el `message_id` de Fakechat (columna Forma) |",
		"| **`st_msg` del futuro monitor** | **hipótesis**: Fakechat no envía `st_msg`; sólo demuestra el mecanismo con su propio `message_id`. Nuestro servidor, su nombre (`source`) y su carga como plugin autorizado no se probaron |",
		"| Atribución inequívoca del `turn_end` (#512 §3.1) | A1–A5 evaluadas sólo sin interferencia; A3–A5 con entrada simultánea, A6–A7 (relay) y la recuperación tras reinicio **no** se prueban localmente |",
		"| Despertar tras ≥ 1 h, `--resume`, concurrencia, fallos, kill switch | **no probados** en esta prueba |",
		"",
		"Los criterios G1–G12 de la POC no cambian; esta sección sólo aporta evidencia.",
		"",
	].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");
	const read = (f) => readFileSync(join(OUT, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const sends = readdirSync(OUT).filter((f) => /^sends-[A-Z]\.jsonl$/.test(f)).flatMap(read).sort((a, b) => a.t_send - b.t_send);
	const hooks = existsSync(join(OUT, "hooks.jsonl")) ? read("hooks.jsonl") : [];
	writeFileSync(join(OUT, "phase0-instrumented-report.md"), buildReport(sends, hooks));
	console.log(join(OUT, "phase0-instrumented-report.md"));
}
