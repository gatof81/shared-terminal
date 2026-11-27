// acpReview.ts — «Revisar interrupción» (PROPUESTA §11.1, revisión UI §14):
// an `uncertain` run may have done part of its work, so it is never resent
// by a tap. The card is titled with what happened in plain words
// (acpModel.interruptCause; the runner's note stays in «Detalle técnico»)
// and answers three facts — Qué pasó, Informe (the agent's read-only report,
// `recovery_of`), Ahora (the agent's state from the registry, or that it no
// longer exists) — then a «Recomendado» box with the case's action:
//
//   - with a report: «Dar por revisada» (POST …/review: out of Pendientes,
//     nothing written or sent) or «Escribirle un mensaje nuevo»;
//   - without one: «Ver cambios en Git» first;
//   - its agent deleted: only «Dar por revisada» — Git, Terminal, writing to
//     it and requeueing cannot work without the agent, so none is offered.
//
// «Reencolar el mensaje original… (no recomendado)» stays folded and locked
// until «Revisé el estado y acepto que puede repetir operaciones.» is
// checked: the owner's `requeue`, unchanged (the same message, no copy).

import { inboxNow, refreshInbox } from "./acpInboxStore.js";
import { agentNow, interruptCause, interruptTitle, reportState } from "./acpModel.js";
import { acpAgentGone, acpEntryByName, acpSessionOf } from "./acpRegistry.js";
import { type AcpMessage, acpRequeue, acpReview } from "./api.js";
import { markdownBlock } from "./chatMarkdown.js";
import { createDialog } from "./components/dialog.js";
import { showToast } from "./components/toast.js";
import { routeHash } from "./router.js";
import { el } from "./ui.js";

export interface ReviewContext {
	/** Where it was cut: the topic's title (none: the Archive). */
	where?: string | null;
	/** Its last activity, if this page saw any. */
	activity?: string | null;
	/** The recovery report, if the caller has it (else Pendientes' `reports`). */
	report?: AcpMessage | null;
	/**
	 * The row as the review / requeue answered it, with `liveMark()` as it was
	 * when that request left (the caller keeps a newer live frame over it).
	 */
	onChanged?: (row: AcpMessage, mark: number) => void;
	liveMark?: () => number;
}

export interface ReviewHooks {
	/** «Escribirle un mensaje nuevo»: a message to `m.to_id` in `m`'s topic. */
	writeNew: (m: AcpMessage) => void;
	/**
	 * The agent's Git / Terminal in Herramientas (3B F4); false when it could
	 * not open there (no project page up): the agent's session opens in that view.
	 */
	tools?: (agent: string, tool: "git" | "terminal") => boolean;
}

let hooks: ReviewHooks = { writeNew: () => {} };

export function configureReview(h: ReviewHooks): void {
	hooks = h;
}

let seq = 0;

/** Opens the review of interrupted message `m`. */
export function openReview(m: AcpMessage, ctx: ReviewContext = {}): void {
	const id = `acp-review-${++seq}`;
	const root = el("div", "modal acp-review");
	root.setAttribute("aria-hidden", "true");
	const backdrop = el("div", "modal-backdrop");
	backdrop.setAttribute("data-close-modal", "");
	const card = el("div", "modal-card acp-review-card");
	card.setAttribute("role", "dialog");
	card.setAttribute("aria-modal", "true");
	card.setAttribute("aria-labelledby", `${id}-title`);
	root.append(backdrop, card);

	const gone = acpAgentGone(m.to_id);
	const agent = `@${m.to_id}`;
	const header = el("div", "modal-header");
	const h2 = el("h2", undefined, interruptTitle(m));
	h2.id = `${id}-title`;
	const close = el("button", "modal-close", "×");
	close.type = "button";
	close.setAttribute("aria-label", "Cerrar");
	close.setAttribute("data-close-modal", "");
	header.append(h2, close);

	const body = el("div", "acp-review-body");
	const mine = m.from_id === "owner";
	const where = ctx.where ? ` en «${ctx.where}»` : "";
	body.append(
		el(
			"p",
			"acp-review-sub",
			`${mine ? `Tu mensaje a ${agent}` : `La consulta de @${m.from_id} a ${agent}`}${where} · ${clockTime(m.created_at)}`,
		),
		el("blockquote", "acp-review-quote", m.body),
	);

	// ── The three facts ──
	const facts = el("dl", "acp-review-facts");
	const fact = (k: string, ...v: Array<string | Node>) => {
		const dd = el("dd");
		dd.append(...v);
		facts.append(el("dt", undefined, k), dd);
	};
	const cut = m.finished_at ? ` a las ${clockTime(m.finished_at)}` : "";
	const tech = el("details", "acp-review-tech");
	tech.append(el("summary", undefined, "Detalle técnico"));
	tech.append(el("code", undefined, m.note ?? "sin detalle del motivo"));
	if (ctx.activity) tech.append(el("code", undefined, `última actividad: ${ctx.activity}`));
	fact(
		"Qué pasó",
		`${agent} ${interruptCause(m.note).what}${cut}, en medio de este trabajo. `,
		el("b", undefined, "Ya no está corriendo"),
		": nada se reintenta solo.",
		tech,
	);

	const report = ctx.report ?? inboxNow()?.reports.find((r) => r.recovery_of === m.id) ?? null;
	const has = reportState(report);
	if (report && has === "done") {
		const box = el("div", "acp-review-report acp-md");
		box.setAttribute("aria-label", `Informe de ${agent}`);
		box.append(markdownBlock(report.result_text ?? ""));
		const by = report.finished_at
			? `Lo escribió ${agent} a las ${clockTime(report.finished_at)}, después del corte (solo lectura).`
			: `Lo escribió ${agent} después del corte (solo lectura).`;
		fact("Informe", box, el("p", "acp-review-muted", by));
	} else if (has === "writing") fact("Informe", `${agent} está escribiendo su informe.`);
	else fact("Informe", "No dejó informe.");

	const now = acpEntryByName(m.to_id);
	if (gone)
		fact("Ahora", el("b", undefined, `${agent} ya no existe`), ": su sesión fue eliminada.");
	else if (now) fact("Ahora", `${agent} ${agentNow(now).sentence}`);
	body.append(facts);

	const status = el("p", "acp-review-status");
	status.setAttribute("role", "status");
	const reviewed = Boolean(m.reviewed_at) || m.state !== "uncertain";

	// ── Recomendado ──
	const done = el("button", "btn primary", "Dar por revisada");
	done.type = "button";
	if (reviewed) {
		done.disabled = true;
		status.textContent =
			m.state === "uncertain"
				? "interrumpida · revisada, no reencolada"
				: "Ya no está interrumpida.";
	}
	done.addEventListener("click", () => {
		done.disabled = true;
		status.textContent = "Guardando…";
		const mark = ctx.liveMark?.() ?? 0;
		void acpReview(m.id)
			.then((row) => {
				ctx.onChanged?.(row, mark);
				refreshInbox(0);
				dialog.close();
				showToast("Dada por revisada · no se reencoló");
			})
			.catch((err: { status?: number; code?: string }) => {
				// 409: no longer interrupted (requeued elsewhere): nothing to mark.
				status.textContent =
					err.status === 409
						? "Ya no está interrumpida (se reencoló o terminó)."
						: "No se pudo guardar. Volvé a intentar.";
				done.disabled = err.status === 409;
				refreshInbox(0);
			});
	});
	const write = el("button", "btn acp-review-write", "Escribirle un mensaje nuevo");
	write.type = "button";
	write.addEventListener("click", () => {
		dialog.close();
		hooks.writeNew(m);
	});
	const toolButton = (tool: "git" | "terminal", label: string, cls = "btn") => {
		const b = el("button", cls, label);
		b.type = "button";
		b.addEventListener("click", () => {
			dialog.close();
			if (!hooks.tools?.(m.to_id, tool)) {
				const sid = acpSessionOf(m.to_id);
				if (sid) window.location.hash = routeHash({ sessionId: sid, view: tool, detail: null });
			}
		});
		return b;
	};

	const reco = el("section", "acp-review-reco");
	reco.setAttribute("aria-label", "Recomendado");
	reco.append(el("b", "acp-review-reco-head", "Recomendado"));
	const recoActs = el("div", "acp-review-actions");
	// Git leads when there is no report: what it left done is looked at there.
	const gitFirst = !gone && has !== "done";
	if (gone) {
		reco.append(
			el(
				"p",
				undefined,
				"Dala por revisada. No se puede retomar ni reencolar: no hay agente que lo reciba.",
			),
		);
		recoActs.append(done);
	} else if (has === "done") {
		reco.append(
			el(
				"p",
				undefined,
				"El informe dice qué quedó hecho. Si está bien, dala por revisada. Si querés que lo termine, escribile un mensaje nuevo: reencolar puede repetir lo que ya hizo.",
			),
		);
		recoActs.append(done, write);
	} else {
		reco.append(
			el(
				"p",
				undefined,
				"Mirá los cambios en Git antes de decidir: puede haber hecho parte del trabajo (comandos, archivos, commits, mensajes a otros agentes). Reencolar puede repetir lo que ya hizo.",
			),
		);
		done.classList.remove("primary");
		recoActs.append(toolButton("git", "Ver cambios en Git", "btn primary"), done, write);
	}
	reco.append(recoActs);

	// The agent's tools: only an agent that exists has any.
	const toolsRow = el("div", "acp-review-tools");
	if (!gone) {
		if (!gitFirst) toolsRow.append(toolButton("git", "Ver cambios en Git"));
		toolsRow.append(toolButton("terminal", "Abrir Terminal"));
	}

	// Requeue: folded, and locked until the person says they checked.
	const fold = el("details", "acp-review-requeue");
	fold.append(el("summary", undefined, "Reencolar el mensaje original… (no recomendado)"));
	fold.append(
		el(
			"p",
			"acp-review-muted",
			"Vuelve a la cola el mismo mensaje, sin copia. Si ya había hecho algo, puede repetirlo.",
		),
	);
	const ack = el("label", "acp-review-ack");
	const check = el("input");
	check.type = "checkbox";
	ack.append(
		check,
		el("span", undefined, "Revisé el estado y acepto que puede repetir operaciones."),
	);
	const requeue = el("button", "btn sm danger acp-review-requeue-btn", "Reencolar");
	requeue.type = "button";
	requeue.disabled = true;
	check.addEventListener("change", () => {
		requeue.disabled = !check.checked || m.state !== "uncertain";
	});
	requeue.addEventListener("click", () => {
		if (!check.checked) return;
		requeue.disabled = true;
		status.textContent = "Reencolando…";
		const mark = ctx.liveMark?.() ?? 0;
		void acpRequeue(m.id)
			.then((row) => {
				ctx.onChanged?.(row, mark);
				refreshInbox(0);
				dialog.close();
				showToast("Reencolado");
			})
			.catch((err: { status?: number }) => {
				status.textContent =
					err.status === 409
						? "Ya no está interrumpida (se reencoló o terminó)."
						: "No se pudo reencolar. Volvé a intentar.";
				requeue.disabled = err.status === 409 || !check.checked;
			});
	});
	fold.append(ack, requeue);
	if (m.state !== "uncertain" || gone) fold.hidden = true;

	const foot = el("div", "modal-actions");
	const closeBtn = el("button", "dialog-cancel", "Cerrar");
	closeBtn.type = "button";
	closeBtn.setAttribute("data-close-modal", "");
	foot.append(closeBtn);

	const scroll = el("div", "acp-review-scroll");
	scroll.append(body, reco, status);
	if (toolsRow.childElementCount) scroll.append(toolsRow);
	scroll.append(fold);
	card.append(header, scroll, foot);
	document.body.append(root);
	const dialog = createDialog(root, {
		initialFocus: () =>
			recoActs.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? closeBtn,
		onClose: () => root.remove(),
	});
	dialog.open(document.activeElement);
}

/** «10:25»: a row's time as Pendientes and the review show it. */
export function clockTime(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime())
		? ""
		: d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}
