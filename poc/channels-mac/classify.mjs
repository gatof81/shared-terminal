// Pure classification for report.mjs. Keeps two things apart:
//   - agent wake: the channel message reached Claude as a prompt and started
//     a turn with no other prompt and no permission dialog in the window;
//   - bidirectional communication: wake + the turn ended (Stop of the same
//     prompt_id) + the reply was OBSERVED back in Fakechat.
// The phase-0 verdict applies docs/design/project-chat/04-poc.md §1.7 as
// written; bidirectionality is reported beside it and never inferred.
// G1–G12 (§5) are not evaluated here and are not changed.
export function classify(r) {
	const u = r.ups ?? null;
	const woke = !!u && r.other_prompt_events_after_send === 0 && !r.permission_dialog;
	const responded = !!r.stop;
	const returned = !!r.fakechat_reply;
	const corr = u
		? {
				"A1 una etiqueta": u.channel_tag_count === 1 && u.only_channel_tags === true,
				"A2 prompt_id presente": !!u.prompt_id,
				"A3 prompt_id nuevo": u.prompt_id_seen_before === false,
				"A4 sin otros prompts": r.other_prompt_events_after_send === 0,
				// Any other Stop in the window fails A5, a duplicate with the SAME
				// prompt_id included: R8 needs one unambiguous turn_end.
				"A5 sin Stop ajeno": (r.other_stops ?? r.stops_with_other_or_no_prompt_id ?? []).length === 0,
				"Stop del mismo prompt_id": responded,
				"message_id = id enviado": u.tag_message_id_matches === true,
			}
		: null;
	return {
		...r,
		woke,
		responded,
		returned,
		bidirectional: woke && responded && returned,
		sourceSystem: !!u && u.source_present === true && u.source === "system",
		corr,
		corrOk: !!corr && Object.values(corr).every(Boolean),
	};
}

export function summarize(sends) {
	const rows = sends.map(classify);
	const formal = rows.filter((r) => r.label === "S" || r.label === "L");
	const hooked = formal.filter((r) => r.ups);
	const shortN = formal.filter((r) => r.label === "S").length;
	const longN = formal.filter((r) => r.label === "L").length;
	const count = (f) => formal.filter(f).length;
	const agg = {
		formal: formal.length, shortN, longN, hooked: hooked.length,
		woke: count((r) => r.woke), bidirectional: count((r) => r.bidirectional),
		sourceSystem: count((r) => r.sourceSystem), sourceAbsent: count((r) => r.ups && r.ups.source_present === false),
		corrOk: count((r) => r.corrOk), returned: count((r) => r.returned),
	};
	let wakeVerdict;
	if (formal.length === 0) wakeVerdict = "**Sin muestras formales todavía** (sólo la prueba individual T).";
	else if (formal.some((r) => r.result === "harness-error")) wakeVerdict = "**Indeterminado**: fallo del harness (no es NO-GO).";
	else if (formal.some((r) => r.result === "no-hook"))
		wakeVerdict = "**Sin `UserPromptSubmit` en al menos un mensaje.** Es \"no despertó\" (NO-GO de despertar, §1.7) sólo si el CLI registró la recepción, la sesión seguía en su prompt, no hubo turno **y** confirmás que la terminal de Claude no tenía texto escrito; si no, **indeterminado**.";
	else if (shortN !== 10 || longN !== 2) wakeVerdict = `**Incompleta** (${shortN}/10 cortas, ${longN}/2 largas).`;
	else if (agg.woke === 12 && agg.sourceSystem === 12 && agg.corrOk === 12)
		wakeVerdict = "**Fase 0 superada en despertar** (12/12, `source=system`, correlación OK). No es un GO de arquitectura: pedir GO separado para la POC completa (G1–G12 sin cambios).";
	else wakeVerdict = "**Despertar en riesgo**: `source`, correlación o intervención (ver tablas). La POC completa sólo con GO explícito.";
	const flowVerdict = formal.length === 0
		? "—"
		: agg.bidirectional === formal.length && formal.length === 12
			? "**Flujo bidireccional observado 12/12** (mensaje → turno → `Stop` → respuesta en Fakechat)."
			: `**Flujo bidireccional NO demostrado**: ${agg.bidirectional}/${formal.length} completos; faltan respuestas observadas en Fakechat o turnos cerrados.`;
	return { rows, formal, agg, wakeVerdict, flowVerdict };
}

export function singleSummary(row) {
	if (!row) return "Sin prueba individual (T).";
	const r = classify(row);
	const lines = [
		`- Despertar del agente: ${r.woke ? "**sí**" : "**no**"}${r.ups ? "" : " (sin `UserPromptSubmit`)"}`,
		`- Comunicación bidireccional: ${r.bidirectional ? "**sí**" : "**no**"} (turno cerrado: ${r.responded ? "sí" : "no"}; respuesta vista en Fakechat: ${r.returned ? "sí" : "no"})`,
		`- \`source\`: ${r.ups ? (r.ups.source_present ? `\`${r.ups.source}\`` : "**ausente**") : "—"}`,
		`- Correlación: ${r.corr ? (r.corrOk ? "OK" : `FALLA: ${Object.entries(r.corr).filter(([, v]) => !v).map(([k]) => k).join(", ")}`) : "—"}`,
	];
	for (const p of r.other_prompts ?? []) lines.push(`  - \`UserPromptSubmit\` adicional: línea ${p.line}, prompt_id \`${p.prompt_id ?? "—"}\``);
	for (const s of r.other_stops ?? []) lines.push(`  - \`Stop\` adicional: línea ${s.line}, prompt_id \`${s.prompt_id ?? "—"}\`${s.same_prompt_id ? " (mismo prompt_id: Stop duplicado)" : ""}`);
	const go = r.woke && r.bidirectional && r.sourceSystem && r.corrOk;
	lines.push(go
		? "- **Prueba individual limpia**: se puede pedir autorización para las 12 muestras."
		: "- **Prueba individual no limpia**: no seguir con las series; revisar antes.");
	return lines.join("\n");
}
