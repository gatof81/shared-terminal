// acpReview.ts — «Revisar interrupción» (PROPUESTA §11.1): an `uncertain`
// run may have done part of its work, so it is never resent by a tap. The
// dialog shows the facts the rows carry — the original message, when and
// why it was cut (`note`), the last activity known (only if there is one),
// the agent's read-only report (`recovery_of`) once it is there — and the
// agent's Git and Terminal. Its actions, safest first:
//
//   - «Dar por revisada, sin reencolar» (POST …/review): out of Pendientes,
//     nothing written or sent; the message reads «interrumpida · revisada,
//     no reencolada»;
//   - «Escribirle un mensaje nuevo»: its topic, with that agent as recipient;
//   - «Reencolar el mensaje original…», folded and locked until «Revisé el
//     estado y acepto que puede repetir operaciones.» is checked: the owner's
//     `requeue`, unchanged (the same message, no copy).

import { inboxNow, refreshInbox } from "./acpInboxStore.js";
import { acpSessionOf } from "./acpRegistry.js";
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
	/** The row as the review / requeue answered it. */
	onChanged?: (row: AcpMessage) => void;
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

	const header = el("div", "modal-header");
	const h2 = el("h2", undefined, "Revisar interrupción");
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
			`${mine ? `Tu mensaje a @${m.to_id}` : `La consulta de @${m.from_id} a @${m.to_id}`}${where} · ${time(m.created_at)}`,
		),
		el("blockquote", "acp-review-quote", m.body),
	);
	const facts = el("dl", "acp-review-facts");
	const fact = (k: string, v: string | HTMLElement) => {
		const dd = el("dd");
		dd.append(v);
		facts.append(el("dt", undefined, k), dd);
	};
	fact(
		"Se interrumpió",
		`${m.finished_at ? `${time(m.finished_at)} — ` : ""}${m.note ?? "sin detalle del motivo"}`,
	);
	if (ctx.activity) fact("Última actividad", el("code", undefined, ctx.activity));
	body.append(
		facts,
		el(
			"p",
			"acp-review-warn",
			"Puede haber hecho parte del trabajo (comandos, archivos, commits, mensajes a otros agentes). Nada se reenvía solo.",
		),
	);
	const report = ctx.report ?? inboxNow()?.reports.find((r) => r.recovery_of === m.id) ?? null;
	if (report) {
		const box = el("section", "acp-review-report");
		box.setAttribute("aria-label", `Informe de @${report.to_id}`);
		const head = el("div", "acp-review-report-head");
		head.append(el("b", undefined, `Informe de @${report.to_id}`), " (solo lectura)");
		box.append(head);
		if (report.result_text) {
			const text = el("div", "acp-md");
			text.append(markdownBlock(report.result_text));
			box.append(text);
		} else box.append(el("p", "acp-review-muted", `@${report.to_id} todavía lo está escribiendo.`));
		body.append(box);
	}

	// The agent's Git and Terminal: what it left done is looked at there.
	const toolsRow = el("div", "acp-review-tools");
	for (const [tool, label] of [
		["git", "Ver cambios en Git"],
		["terminal", "Abrir Terminal"],
	] as const) {
		const b = el("button", "btn sm", label);
		b.type = "button";
		b.addEventListener("click", () => {
			dialog.close();
			if (!hooks.tools?.(m.to_id, tool)) {
				const sid = acpSessionOf(m.to_id);
				if (sid) window.location.hash = routeHash({ sessionId: sid, view: tool, detail: null });
			}
		});
		toolsRow.append(b);
	}
	body.append(toolsRow);

	const actions = el("div", "acp-review-actions");
	const status = el("p", "acp-review-status");
	status.setAttribute("role", "status");
	const reviewed = Boolean(m.reviewed_at) || m.state !== "uncertain";
	const done = el("button", "btn acp-review-done", "Dar por revisada, sin reencolar");
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
		void acpReview(m.id)
			.then((row) => {
				ctx.onChanged?.(row);
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
	actions.append(done, write);

	// Requeue: folded, and locked until the person says they checked.
	const fold = el("details", "acp-review-requeue");
	fold.append(el("summary", undefined, "Reencolar el mensaje original…"));
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
		void acpRequeue(m.id)
			.then((row) => {
				ctx.onChanged?.(row);
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
	if (m.state !== "uncertain") fold.hidden = true;

	const foot = el("div", "modal-actions");
	const closeBtn = el("button", "dialog-cancel", "Cerrar");
	closeBtn.type = "button";
	closeBtn.setAttribute("data-close-modal", "");
	foot.append(closeBtn);

	const scroll = el("div", "acp-review-scroll");
	scroll.append(body, actions, status, fold);
	card.append(header, scroll, foot);
	document.body.append(root);
	const dialog = createDialog(root, {
		initialFocus: () => (done.disabled ? closeBtn : done),
		onClose: () => root.remove(),
	});
	dialog.open(document.activeElement);
}

function time(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime())
		? ""
		: d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}
