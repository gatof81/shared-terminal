#!/usr/bin/env bun
// Build the phase-0 instrumented report section for PR #512 from .poc0/out.
//   bun .poc0/report.mjs        → .poc0/out/phase0-instrumented-report.md
// It applies docs/design/project-chat/04-poc.md §1.7 literally and never
// relaxes G1–G12; it only adds evidence. Fields the scripts cannot observe
// (macOS version, whether you touched Terminal 1) are left for you to fill.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");
const read = (f) => readFileSync(join(OUT, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const sends = readdirSync(OUT).filter((f) => /^sends-[A-Z]\.jsonl$/.test(f)).flatMap(read).sort((a, b) => a.t_send - b.t_send);
const hooks = existsSync(join(OUT, "hooks.jsonl")) ? read("hooks.jsonl") : [];
const yn = (b) => (b === null || b === undefined ? "—" : b ? "sí" : "no");
const ms = (x) => (typeof x === "number" ? (x / 1000).toFixed(2) : "—");

const rows = sends.map((r) => {
	const u = r.ups;
	const corr = u ? {
		"A1 una etiqueta": u.channel_tag_count === 1 && u.only_channel_tags,
		"A2 prompt_id presente": !!u.prompt_id,
		"A3 prompt_id nuevo": u.prompt_id_seen_before === false,
		"A4 sin otros prompts": r.other_prompt_events_after_send === 0,
		"A5 sin Stop ajeno": (r.stops_with_other_or_no_prompt_id ?? []).length === 0,
		"Stop del mismo prompt_id": !!r.stop,
		"message_id = id enviado": u.tag_message_id_matches === true,
	} : null;
	return { ...r, corr, corrOk: corr && Object.values(corr).every(Boolean) };
});
const formal = rows.filter((r) => r.label === "S" || r.label === "L");
const hooked = formal.filter((r) => r.ups);
const sys = hooked.filter((r) => r.ups.source_present && r.ups.source === "system").length;
const absent = hooked.filter((r) => !r.ups.source_present).length;
const shortN = formal.filter((r) => r.label === "S").length;
const longN = formal.filter((r) => r.label === "L").length;
let verdict;
if (formal.some((r) => r.result === "harness-error")) verdict = "**Indeterminado**: fallo del harness (no es NO-GO).";
else if (formal.some((r) => r.result === "no-hook"))
	verdict = "**Sin `UserPromptSubmit` en al menos un mensaje.** Es \"no despertó\" (NO-GO de despertar, §1.7) sólo si el CLI registró la recepción, la sesión seguía en su prompt, no hubo turno **y** confirmás que la Terminal 1 no tenía texto escrito; si no, **indeterminado**.";
else if (shortN !== 10 || longN !== 2) verdict = `**Incompleta** (${shortN}/10 cortas, ${longN}/2 largas).`;
else if (sys === hooked.length && formal.every((r) => r.corrOk))
	verdict = "**Fase 0 superada** (12/12, `source=system`, correlación OK). No es un GO de arquitectura: pedir GO separado para la POC completa (G1–G12 sin cambios).";
else verdict = "**Disponibilidad y despertar OK; `source` o correlación en riesgo** (ver tablas). La POC completa sólo con GO explícito.";

const keysSeen = {};
for (const h of hooks) keysSeen[h.event] = [...new Set([...(keysSeen[h.event] ?? []), ...(h.keys ?? [])])].sort();

const md = [
	"## Fase 0 instrumentada — resultados",
	"",
	"| Entorno | Valor |", "| --- | --- |",
	"| Fecha | _(completar)_ |", "| macOS | _(completar: `sw_vers -productVersion`)_ |",
	"| Claude Code | _(completar: `claude --version`)_ |", "| Autenticación | suscripción de Claude, login oficial (sin API key, sin uso extra) |",
	"| Plugin | `fakechat@claude-plugins-official` _(completar versión/commit si se conoce)_ |",
	"| Terminal 1 sin tocar durante las series | _(completar: sí / no)_ |",
	"",
	`Veredicto según §1.7: ${verdict}`,
	"",
	"### Por mensaje",
	"",
	"| Id | Inactivo antes (s) | Recibido por el CLI | Hook | Despertó sin intervención | Respondió (`Stop`) | Volvió a Fakechat | Latencia hook / Stop / Fakechat (s) | `source` | Forma del prompt | Correlación |",
	"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	...rows.map((r) => {
		const u = r.ups;
		const shape = u ? `${u.channel_tag_count} etiqueta(s); sólo etiquetas: ${yn(u.only_channel_tags)}; atributos: ${u.tag_attr_names.join(",")}; source de la etiqueta: \`${u.tag_source}\`` : "—";
		const woke = u ? r.other_prompt_events_after_send === 0 && !r.permission_dialog : false;
		const corr = r.corr ? (r.corrOk ? "OK" : `FALLA: ${Object.entries(r.corr).filter(([, v]) => !v).map(([k]) => k).join(", ")}`) : "—";
		return `| \`${r.id}\` | ${typeof r.idle_before_s === "number" ? Math.round(r.idle_before_s) : "—"} | ${r.cli_received === null ? "sin log" : yn(!!r.cli_received)} | ${yn(!!u)} | ${yn(woke)}${r.permission_dialog ? " (diálogo de permiso)" : ""} | ${yn(!!r.stop)} | ${yn(!!r.fakechat_reply)}${r.fakechat_reply?.exact ? " (exacta)" : ""} | ${ms(u?.latency_ms)} / ${ms(r.stop?.latency_ms)} / ${ms(r.fakechat_reply?.latency_ms)} | ${u ? (u.source_present ? `\`${u.source}\`` : "**ausente**") : "—"} | ${shape} | ${corr} |`;
	}),
	"",
	"### Agregados (sólo las series S y L; T es la prueba individual)",
	"",
	`- Con hook: ${hooked.length}/${formal.length} · \`source=system\`: ${sys}/${hooked.length} · \`source\` ausente: ${absent}/${hooked.length}`,
	`- Correlación completa (A1–A5 + Stop + message_id): ${formal.filter((r) => r.corrOk).length}/${formal.length}`,
	`- Respuesta vuelta a Fakechat: ${formal.filter((r) => r.fakechat_reply).length}/${formal.length}`,
	"",
	"### Campos recibidos por evento (nombres, no valores)",
	"",
	...Object.entries(keysSeen).map(([e, k]) => `- \`${e}\`: ${k.map((x) => `\`${x}\``).join(", ")}`),
	"",
	"### Qué queda comprobado y qué sigue siendo hipótesis",
	"",
	"| Afirmación | Estado tras esta prueba |", "| --- | --- |",
	`| Una entrada de canal produce \`UserPromptSubmit\` | ${hooked.length ? `observado ${hooked.length}/${formal.length}` : "no observado"} |`,
	`| \`source=system\` presente en esa entrada (requisito de #512 §5) | ${hooked.length ? `${sys}/${hooked.length}${absent ? `; ausente en ${absent}` : ""}` : "—"} |`,
	"| Las claves de `meta` aparecen como atributos de `<channel>` | observado con `message_id` de Fakechat (si la columna Forma lo muestra) |",
	"| **`st_msg` del futuro monitor** | **hipótesis**: Fakechat no envía `st_msg`; sólo demuestra el mecanismo con su propio `message_id`. Nuestro servidor, su nombre (`source`) y su carga como plugin autorizado no se probaron |",
	"| Atribución inequívoca del `turn_end` (#512 §3.1) | A1–A5 evaluadas aquí sólo sin interferencia; A3–A5 con entrada simultánea, A6–A7 (relay) y la recuperación tras reinicio **no** se prueban localmente |",
	`| Despertar tras ≥ 1 h | ${longN ? `${formal.filter((r) => r.label === "L" && r.ups).length}/${longN}` : "no probado"} |`,
	"| `--resume`, concurrencia, fallos, kill switch | **no probados** (POC completa, en VM/contenedores) |",
	"",
	"Los criterios G1–G12 de la POC no cambian; esta sección sólo aporta evidencia.",
	"",
];
writeFileSync(join(OUT, "phase0-instrumented-report.md"), md.join("\n"));
console.log(join(OUT, "phase0-instrumented-report.md"));
