// acpQuestionCard.ts — an agent's question to the person (ACP form
// elicitation): the card with its form while open, its outcome after.
// Shared by a chat's thread (acpThread.ts) and Pendientes (acpInbox.ts), so
// a question answers the same way wherever it is answered.

import { answerText, questionForm } from "./acpModel.js";
import { type AcpQuestion, acpAnswer } from "./api.js";
import { el } from "./ui.js";

export interface QuestionCardOptions {
	/** The answer as the server took it (the caller lays it over what it shows). */
	onAnswered: (row: AcpQuestion) => void;
	/** False once the card's chat or panel is gone: a late answer then changes nothing there. */
	stillHere: () => boolean;
	/** An orphaned question: put the decision in the message box, as an ordinary message. */
	onResend?: (text: string) => void;
	/** Where nothing is written (the Archive): an open question is answered in Pendientes. */
	readOnly?: boolean;
	/** Opens Pendientes (the read-only card's link). */
	onOpenInbox?: (opener: HTMLElement) => void;
}

export function questionCard(q: AcpQuestion, opts: QuestionCardOptions): HTMLElement {
	const form = questionForm(q.request);
	const card = el("section", `acp-question acp-question-${q.state}`);
	card.setAttribute("aria-label", `Pregunta de @${q.agent}`);
	card.append(el("div", "acp-question-head", `@${q.agent} pregunta`));
	if (form.message) card.append(el("p", "acp-question-text", form.message));
	if (q.state === "open") {
		if (opts.readOnly) {
			const line = el("div", "acp-question-state", "Esperando tu respuesta · respondela en ");
			const go = el("button", "acp-link", "Pendientes");
			go.type = "button";
			go.addEventListener("click", () => opts.onOpenInbox?.(go));
			line.append(go, ".");
			card.append(line);
		} else card.append(answerForm(q, form, opts));
		return card;
	}
	const said = answerText(form, q.answer);
	const line =
		q.state === "answered"
			? `Tu respuesta: ${said} · entregándola al agente…`
			: q.state === "delivered"
				? `Tu respuesta: ${said}`
				: q.state === "withdrawn"
					? "El agente retiró la pregunta (ya no la necesita)."
					: `Sin entregar: ${q.note ?? "el agente se reinició"}.${said ? ` Tu respuesta (${said}) no se usó.` : ""}`;
	card.append(el("div", "acp-question-state", line));
	if (q.state === "orphaned" && opts.onResend) {
		// Continue safely: the person decides whether the agent gets the decision
		// again, as an ordinary message in its queue.
		const again = el("button", "btn sm", "Enviar la decisión como mensaje");
		again.type = "button";
		const resend = opts.onResend;
		again.addEventListener("click", () =>
			resend(`Sobre tu pregunta «${form.message}»: ${said && !said.startsWith("(") ? said : ""}`),
		);
		card.append(again);
	}
	return card;
}

function answerForm(
	q: AcpQuestion,
	form: ReturnType<typeof questionForm>,
	opts: QuestionCardOptions,
): HTMLElement {
	const f = el("form", "acp-question-form");
	const read: Array<() => [string, unknown] | null> = [];
	form.fields.forEach((field, i) => {
		const box = el("fieldset", "acp-question-field");
		if (field.label) box.append(el("legend", undefined, field.label));
		const name = `q${q.id}-${i}-${++formSeq}`;
		if (field.kind === "single" || field.kind === "multi") {
			const inputs: HTMLInputElement[] = [];
			for (const o of field.options) {
				const lab = el("label", "acp-option");
				const inp = el("input");
				inp.type = field.kind === "single" ? "radio" : "checkbox";
				inp.name = name;
				inp.value = o.value;
				inputs.push(inp);
				lab.append(inp, el("span", undefined, o.label));
				if (o.description) lab.append(el("small", undefined, ` — ${o.description}`));
				box.append(lab);
			}
			read.push(() => {
				const picked = inputs.filter((x) => x.checked).map((x) => x.value);
				if (field.kind === "multi") return picked.length ? [field.key, picked] : null;
				return picked[0] !== undefined ? [field.key, picked[0]] : null;
			});
		} else if (field.kind === "boolean") {
			const lab = el("label", "acp-option");
			const inp = el("input");
			inp.type = "checkbox";
			lab.append(inp, el("span", undefined, "Sí"));
			box.append(lab);
			read.push(() => [field.key, inp.checked]);
		} else {
			const inp = el("textarea", "acp-question-input");
			inp.rows = 2;
			inp.setAttribute("aria-label", field.label || form.message || "Respuesta");
			box.append(inp);
			read.push(() => {
				const v = inp.value.trim();
				if (!v) return null;
				return [field.key, field.kind === "number" ? Number(v) : v];
			});
		}
		if (field.custom) {
			const other = el("input", "acp-question-other");
			other.type = "text";
			other.placeholder = "Otra respuesta o nota (opcional)";
			other.setAttribute("aria-label", "Otra respuesta");
			box.append(other);
			const key = field.custom;
			read.push(() => (other.value.trim() ? [key, other.value.trim()] : null));
		}
		f.append(box);
	});
	const actions = el("div", "acp-question-actions");
	const send = el("button", "btn sm acp-question-send", "Responder");
	send.type = "submit";
	const skip = el("button", "btn sm", "Omitir");
	skip.type = "button";
	const status = el("span", "acp-chat-hint");
	actions.append(send, skip, status);
	f.append(actions);
	const submit = (body: { action: "accept" | "decline"; content?: Record<string, unknown> }) => {
		send.disabled = skip.disabled = true;
		status.textContent = "Enviando…";
		void acpAnswer(q.id, body)
			.then((row) => {
				if (opts.stillHere()) opts.onAnswered(row);
			})
			.catch((err: Error & { status?: number }) => {
				// 409: someone (another tab, Pendientes) answered first, or the agent restarted.
				status.textContent =
					err.status === 409
						? "Ya no está abierta; se actualiza sola."
						: `No se envió: ${err.message}`;
				send.disabled = skip.disabled = err.status === 409;
			});
	};
	f.addEventListener("submit", (e) => {
		e.preventDefault();
		const content = Object.fromEntries(
			read.map((g) => g()).filter((x): x is [string, unknown] => x !== null),
		);
		submit({ action: "accept", content });
	});
	skip.addEventListener("click", () => submit({ action: "decline" }));
	return f;
}

/** Radio groups of the same question shown twice (thread and Pendientes) must not share a name. */
let formSeq = 0;
