// acpInbox.ts — Pendientes (PROPUESTA §4): one inbox for every project,
// opened from the header's icon (its count = what requires the person's
// action) on every screen and from the rail's attention row. Sections:
//
//   - «Preguntas»: open questions, first — an agent is waiting (answered
//     right here, the same card as in the thread);
//   - «Interrupciones»: interrupted runs not reviewed (revisión UI §14). Each
//     row says in plain words what happened, whether the agent left a
//     report, that nothing runs any more and what the agent does now; with a
//     report «Dar por revisada» is one tap from the row. Those of agents that
//     no longer exist (not in the registry — never guessed from a name) are
//     one grouped row. «Dar por revisadas…» reviews them all after a summary,
//     one POST …/review each, in series. Nothing here ever requeues: that
//     stays in the review card, behind its acknowledgement;
//   - «Resultados sin ver»: agents' answers to the person not seen yet —
//     informative, not counted.
//
// «Ver en el tema» opens the topic with the message highlighted («Ver en el
// Archivo»: the Archive's chat, for what was written before topics). It is a
// dialog (components/dialog.ts): over everything, `inert` underneath, so the
// terminal under it keeps its box — opening or closing it sends no resize.

import { inboxNow, onInbox, refreshInbox } from "./acpInboxStore.js";
import {
	agentHue,
	agentNow,
	answerText,
	interruptSummary,
	interruptTitle,
	questionForm,
	reportState,
	splitByAgent,
} from "./acpModel.js";
import { questionCard } from "./acpQuestionCard.js";
import { acpAgentsLoaded, acpEntryByName } from "./acpRegistry.js";
import { clockTime, openReview } from "./acpReview.js";
import { type AcpMessage, type AcpQuestion, acpConversations, acpReview } from "./api.js";
import { createDialog, type Dialog } from "./components/dialog.js";
import { showToast } from "./components/toast.js";
import { projectName } from "./projectDirectory.js";
import { el, syncChildren } from "./ui.js";

type GoTarget = {
	id: number;
	conversationId: string | null;
	projectId: string | null;
	agent: string;
};

export interface InboxHooks {
	/** «Ver en el tema»: the topic (or the Archive's chat) at message `id`. */
	goTo: (target: GoTarget, opts: { result: boolean }) => void;
	/** Whether `goTo` has somewhere to go (an agent's Archive needs its project). */
	canGo?: (target: GoTarget) => boolean;
	/** A topic's title the page already knows (the shown project's). */
	titleOf: (conversationId: string) => string | null;
}

let hooks: InboxHooks = { goTo: () => {}, titleOf: () => null };

export function configureInbox(h: InboxHooks): void {
	hooks = h;
}

// ── The header's icon ───────────────────────────────────────────────────────

/** Wires `#inbox-btn` (index.html): opens the panel, shows the count. */
export function mountInboxButton(): void {
	const btn = document.getElementById("inbox-btn");
	if (!btn || btn.dataset.wired) return;
	btn.dataset.wired = "1";
	btn.addEventListener("click", () => openInbox(btn));
	const paint = () => {
		const n = inboxNow()?.count ?? 0;
		const badge = btn.querySelector<HTMLElement>(".inbox-count");
		if (badge) {
			badge.textContent = n > 99 ? "99+" : n > 0 ? String(n) : "";
			badge.hidden = n === 0;
		}
		const name = n
			? `Pendientes: ${n} te ${n === 1 ? "espera" : "esperan"}`
			: "Pendientes: nada pendiente";
		btn.setAttribute("aria-label", name);
		btn.title = n ? `Pendientes (${n})` : "Pendientes";
	};
	onInbox(paint);
	paint();
}

// ── The panel ───────────────────────────────────────────────────────────────

let dialog: Dialog | null = null;
let root: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let closeEl: HTMLElement | null = null;
let unsub: (() => void) | null = null;
/** Bumped per opening: an answer that lands after the panel closed changes nothing. */
let openGen = 0;

/** Question cards and rows kept across renders (typed answers and focus survive a refresh). */
const cards = new Map<number, { state: string; el: HTMLElement }>();

type InboxQuestion = AcpQuestion & { conversation_id: string | null; project_id: string | null };
/**
 * Questions answered from this panel, kept on screen for a moment as
 * «✓ Respondida: …» where the person was looking — the inbox read that
 * follows no longer lists them, and a row that just vanished says nothing.
 */
const answered = new Map<number, { q: InboxQuestion; said: string }>();
const ANSWERED_MS = 1500;
const rows = new Map<string, { sig: string; el: HTMLElement }>();

/** Topic titles of other projects, read once per project while the panel needs them. */
const titles = new Map<string, string>();
const titlesRead = new Set<string>();

export function openInbox(opener?: Element | null): void {
	if (dialog?.isOpen()) return;
	build();
	openGen++;
	cards.clear();
	rows.clear();
	answered.clear();
	render();
	refreshInbox(0);
	const onInboxChange = onInbox(() => render());
	// The registry (who exists, what each agent does now) repaints the rows too.
	const onAgents = () => render();
	window.addEventListener("st:acp-agents", onAgents);
	window.addEventListener("st:acp-status", onAgents);
	unsub = () => {
		onInboxChange();
		window.removeEventListener("st:acp-agents", onAgents);
		window.removeEventListener("st:acp-status", onAgents);
	};
	// Wide: the panel opens by what opened it — under the header's icon on
	// the right, under the rail's row on the left.
	const fromHeader = opener instanceof Element && opener.id === "inbox-btn";
	root!.classList.toggle("from-header", fromHeader);
	dialog!.open(opener ?? document.activeElement);
}

export function closeInbox(): void {
	dialog?.close();
}

function build(): void {
	if (root) return;
	root = el("div", "modal acp-inbox");
	root.setAttribute("aria-hidden", "true");
	const backdrop = el("div", "modal-backdrop");
	backdrop.setAttribute("data-close-modal", "");
	const card = el("div", "modal-card acp-inbox-card");
	card.setAttribute("role", "dialog");
	card.setAttribute("aria-modal", "true");
	card.setAttribute("aria-labelledby", "acp-inbox-title");
	const header = el("div", "modal-header acp-inbox-head");
	const title = el("h2", undefined, "Pendientes");
	title.id = "acp-inbox-title";
	const scope = el("span", "acp-inbox-scope", "todos los proyectos");
	const close = el("button", "modal-close", "×");
	close.type = "button";
	close.setAttribute("aria-label", "Cerrar Pendientes");
	close.setAttribute("data-close-modal", "");
	closeEl = close;
	const titles = el("div", "acp-inbox-titles");
	titles.append(title, scope);
	header.append(titles, close);
	listEl = el("div", "acp-inbox-body");
	card.append(header, listEl);
	root.append(backdrop, card);
	document.body.append(root);
	dialog = createDialog(root, {
		initialFocus: () => close,
		onClose: () => {
			unsub?.();
			unsub = null;
			openGen++;
		},
	});
}

/**
 * «Proyecto › Tema», or for what has no topic «Proyecto › Archivo › <chat>»:
 * the previous Project Chat, or `agent`'s direct messages — in the Archive
 * of the project the agent is in now (none: «Archivo › @x · chat individual»).
 */
function whereOf(projectId: string | null, conversationId: string | null, agent: string): string {
	if (!conversationId) {
		const chat = projectId ? "Project Chat anterior" : `@${agent} · chat individual`;
		const pid = projectId ?? acpEntryByName(agent)?.projectId ?? null;
		const name = pid ? projectName(pid) : null;
		return name ? `${name} › Archivo › ${chat}` : `Archivo › ${chat}`;
	}
	const p = projectId ? projectName(projectId) : null;
	let t: string | null = null;
	if (conversationId) {
		t = hooks.titleOf(conversationId) ?? titles.get(conversationId) ?? null;
		if (t === null && projectId && !titlesRead.has(projectId)) void readTitles(projectId);
	}
	const topic = t ?? "Conversación";
	return p ? `${p} › ${topic}` : topic;
}

async function readTitles(projectId: string): Promise<void> {
	titlesRead.add(projectId);
	try {
		const [live, old] = await Promise.all([
			acpConversations(projectId),
			acpConversations(projectId, true),
		]);
		for (const c of [...live, ...old]) titles.set(c.id, c.title);
		if (dialog?.isOpen()) render();
	} catch {
		titlesRead.delete(projectId);
	}
}

const byTime =
	(at: (x: { created_at: string; finished_at?: string | null }) => string) =>
	(a: { created_at: string; finished_at?: string | null }, b: typeof a) =>
		Date.parse(at(a)) - Date.parse(at(b));

/** Does agent `name` exist? null while the registry has not been read (nothing is «gone» then). */
function agentExists(name: string): boolean | null {
	return acpAgentsLoaded() ? acpEntryByName(name) !== null : null;
}

function render(): void {
	const list = listEl;
	if (!list) return;
	const box = inboxNow();
	const nodes: HTMLElement[] = [];
	const open = (box?.action.questions ?? []).filter((q) => !answered.has(q.id));
	const questions = [...open, ...[...answered.values()].map((a) => a.q)].sort(
		byTime((q) => q.created_at),
	);
	const interrupted = [...(box?.action.interrupted ?? [])].sort(
		byTime((m) => m.finished_at ?? m.created_at),
	);
	if (box === null) nodes.push(keep("loading", 0, () => el("p", "acp-inbox-none", "Cargando…")));
	else if (questions.length === 0 && interrupted.length === 0 && answered.size === 0)
		nodes.push(keep("none", 0, () => el("p", "acp-inbox-none", "Nada pendiente")));
	if (questions.length) {
		// The count is what still waits: a confirmation on screen is not pending.
		if (open.length)
			nodes.push(
				keep("h:questions", open.length, () =>
					el("h3", "acp-inbox-sec", `Preguntas · ${open.length}`),
				),
			);
		for (const q of questions) nodes.push(answered.has(q.id) ? answeredItem(q) : questionItem(q));
	}
	// A batch whose confirmation outlived its list (all reviewed elsewhere) has nothing to do.
	if (batch && !batch.running && interrupted.length === 0) batch = null;
	if (interrupted.length) {
		const { live, gone } = splitByAgent(interrupted, agentExists);
		nodes.push(interruptsHead(interrupted));
		if (batch) nodes.push(batch.el);
		for (const m of live) nodes.push(interruptedItem(m, false));
		if (gone.length) nodes.push(goneGroup(gone));
	}
	const results = box?.results ?? [];
	if (results.length) {
		nodes.push(keep("h:results", 0, () => el("h3", "acp-inbox-sec", "Resultados sin ver")));
		for (const m of results) nodes.push(resultItem(m));
	}
	const focusWasIn = list.contains(document.activeElement);
	syncChildren(list, nodes);
	// A row that left (reviewed) took the focus with it: keep it in the panel.
	if (focusWasIn && !list.contains(document.activeElement)) closeEl?.focus();
}

// ── Interruptions ───────────────────────────────────────────────────────────

function reportOf(m: AcpMessage): AcpMessage | null {
	return inboxNow()?.reports.find((r) => r.recovery_of === m.id) ?? null;
}

/** «Interrupciones · N» and «Dar por revisadas…» (a summary, then a confirmation). */
function interruptsHead(all: AcpMessage[]): HTMLElement {
	const ids = all.map((m) => m.id);
	const head = keep("h:interrupts", ids, () => {
		const h = el("div", "acp-inbox-sechead");
		const more = el("button", "acp-inbox-more", "Dar por revisadas…");
		more.type = "button";
		// The header is kept while the ids stay the same, but who exists and
		// which reports landed can change meanwhile: judged at the click.
		more.addEventListener("click", () => {
			const summary = interruptSummary(
				all.map((m) => ({
					report: reportState(reportOf(m)),
					gone: agentExists(m.to_id) === false,
				})),
			);
			confirmBatch(ids, summary);
		});
		h.append(el("h3", "acp-inbox-sec", `Interrupciones · ${all.length}`), more);
		return h;
	});
	const more = head.querySelector<HTMLButtonElement>(".acp-inbox-more");
	if (more) more.disabled = batch !== null;
	return head;
}

function chip(text: string, tone: "" | "ok" | "busy" | "warn" = "", cls = ""): HTMLElement {
	return el("span", `acp-ib-chip${tone ? ` is-${tone}` : ""}${cls ? ` ${cls}` : ""}`, text);
}

/** One interruption: what happened, report, «Ya no está corriendo», what the agent does now. */
function interruptedItem(m: AcpMessage, gone: boolean): HTMLElement {
	const where = whereOf(m.project_id ?? null, m.conversation_id ?? null, m.to_id);
	const report = reportState(reportOf(m));
	const now = gone ? null : acpEntryByName(m.to_id);
	const held = Boolean(now?.heldBy.length);
	const item = keep(
		`u:${m.id}`,
		[m.reviewed_at ?? null, m.note, m.finished_at, where, report, gone, held],
		() => {
			const { item, main } = itemShell("is-interrupted", m.to_id, where, gone);
			const at = m.finished_at ?? m.created_at;
			main.querySelector(".acp-ib-where")?.append(el("span", "acp-ib-time", ` · ${clockTime(at)}`));
			main.append(el("p", "acp-ib-what", interruptTitle(m)));
			main.append(
				el(
					"p",
					"acp-ib-quote",
					m.from_id === "owner"
						? `«${clip(m.body)}»`
						: `Consulta de @${m.from_id}: «${clip(m.body)}»`,
				),
			);
			const chips = el("div", "acp-ib-chips");
			chips.append(
				report === "done"
					? chip("✓ Dejó informe", "ok")
					: report === "writing"
						? chip("Escribiendo informe…", "busy")
						: chip("Sin informe", "warn"),
				chip("Ya no está corriendo"),
				gone ? chip("Agente eliminado") : chip("", "", "acp-ib-now"),
			);
			main.append(chips);

			const acts = el("div", "acp-ib-acts");
			const status = el("p", "acp-ib-status");
			status.setAttribute("role", "status");
			const review = el("button", "btn sm", report === "done" ? "Ver informe" : "Revisar");
			review.type = "button";
			review.addEventListener("click", () =>
				openReview(m, {
					where: m.conversation_id ? whereOf(null, m.conversation_id, m.to_id) : null,
				}),
			);
			const done = el("button", "btn sm", "Dar por revisada");
			done.type = "button";
			done.addEventListener("click", () => reviewFromRow(m, done, status));
			// With a report (or no agent to go back to), reviewing is what almost
			// always fits: one tap. Without one, or with a process it left open,
			// the review card comes first.
			if (gone || (report === "done" && !held)) {
				done.classList.add("primary");
				acts.append(done, review);
			} else {
				review.classList.add("primary");
				done.classList.add("acp-ib-textbtn");
				acts.append(review, done);
			}
			const go = gone ? null : goButton(m, m.to_id, false);
			if (go) acts.append(go);
			main.append(acts, status);
			return item;
		},
	);
	// What the agent does now changes often: repainted in place, the row (and its focus) kept.
	const nowChip = item.querySelector<HTMLElement>(".acp-ib-now");
	if (nowChip) {
		const n = now ? agentNow(now) : null;
		nowChip.textContent = n?.chip ?? "";
		nowChip.hidden = n === null;
		nowChip.className = `acp-ib-chip acp-ib-now${n ? ` is-${n.tone}` : ""}`;
	}
	return item;
}

function reviewFromRow(m: AcpMessage, btn: HTMLButtonElement, status: HTMLElement): void {
	btn.disabled = true;
	btn.setAttribute("aria-busy", "true");
	status.textContent = "Guardando…";
	void acpReview(m.id)
		.then(() => {
			status.textContent = "Dada por revisada";
			showToast("Dada por revisada · no se reencoló");
			refreshInbox(0);
		})
		.catch((err: { status?: number }) => {
			btn.removeAttribute("aria-busy");
			if (err.status === 409) {
				status.textContent = "Ya no está interrumpida (se reencoló o terminó).";
				refreshInbox(0);
				return;
			}
			btn.disabled = false;
			status.textContent = "No se pudo guardar. Volvé a intentar.";
		});
}

/** Whether «Ver una por una» is open (kept across renders and openings). */
let goneOpen = false;

/** The interruptions of agents that no longer exist: one row, one tap. */
function goneGroup(gone: AcpMessage[]): HTMLElement {
	const n = gone.length;
	const names = [...new Set(gone.map((m) => `@${m.to_id}`))];
	const ids = gone.map((m) => m.id);
	const group = keep("g:gone", [ids, names], () => {
		const item = el("div", "acp-ib-item is-gone-group");
		const face = el("span", "acp-avatar is-gone", "?");
		face.setAttribute("aria-hidden", "true");
		const main = el("div", "acp-ib-main");
		main.append(
			el("div", "acp-ib-where", "Agentes que ya no existen"),
			el(
				"p",
				"acp-ib-what",
				n === 1
					? "1 interrupción de un agente eliminado"
					: `${n} interrupciones de agentes eliminados`,
			),
			el("p", "acp-ib-quote", `No se pueden retomar · ${names.join(", ")}`),
		);
		const acts = el("div", "acp-ib-acts");
		const all = el(
			"button",
			"btn sm primary acp-ib-gone-all",
			n === 1 ? "Dar por revisada" : `Dar por revisadas las ${n}`,
		);
		all.type = "button";
		// No confirmation: the button names how many, and a review sends nothing.
		all.addEventListener("click", () => runBatch(ids));
		acts.append(all);
		const fold = el("details", "acp-ib-onebyone");
		fold.open = goneOpen;
		fold.addEventListener("toggle", () => {
			goneOpen = fold.open;
		});
		fold.append(el("summary", undefined, "Ver una por una"), el("div", "acp-ib-onebyone-list"));
		main.append(acts, fold);
		item.append(face, main);
		return item;
	});
	const all = group.querySelector<HTMLButtonElement>(".acp-ib-gone-all");
	if (all) all.disabled = batch !== null;
	const inner = group.querySelector(".acp-ib-onebyone-list");
	if (inner)
		syncChildren(
			inner,
			gone.map((m) => interruptedItem(m, true)),
		);
	return group;
}

// ── Reviewing several at once ───────────────────────────────────────────────
//
// N POST …/review, one after the other (no batch endpoint: a follow-up for
// the backend). A 409 means the message is no longer interrupted — requeued
// or reviewed elsewhere —, which is what the person wanted: it counts as
// done. Any other failure is counted, the rest goes on, and the end says how
// many are left (they are still in the list, to retry). Only `review`: a
// batch never requeues.

interface Batch {
	el: HTMLElement;
	running: boolean;
}
let batch: Batch | null = null;
/** Bumped on logout: a batch of the previous account stops at its next step. */
let batchGen = 0;

function batchShell(): { box: HTMLElement; text: HTMLElement; acts: HTMLElement } {
	const box = el("div", "acp-ib-batch");
	box.setAttribute("role", "group");
	box.setAttribute("aria-label", "Dar por revisadas");
	const text = el("p", "acp-ib-batch-text");
	text.setAttribute("role", "status");
	text.tabIndex = -1;
	const acts = el("div", "acp-ib-acts");
	box.append(text, acts);
	return { box, text, acts };
}

function confirmBatch(ids: number[], summary: string): void {
	if (batch) return;
	const { box, text, acts } = batchShell();
	text.textContent = `${summary} No se reenvía nada.`;
	const go = el(
		"button",
		"btn sm primary",
		ids.length === 1 ? "Dar por revisada" : `Dar por revisadas las ${ids.length}`,
	);
	go.type = "button";
	go.addEventListener("click", () => {
		batch = null;
		runBatch(ids);
	});
	const cancel = el("button", "btn sm", "Cancelar");
	cancel.type = "button";
	cancel.addEventListener("click", () => {
		batch = null;
		render();
		listEl?.querySelector<HTMLElement>(".acp-inbox-more")?.focus();
	});
	acts.append(go, cancel);
	batch = { el: box, running: false };
	render();
	go.focus();
}

function runBatch(ids: number[]): void {
	if (batch) return;
	const { box, text, acts } = batchShell();
	const me: Batch = { el: box, running: true };
	batch = me;
	const g = batchGen;
	render();
	text.focus();
	void (async () => {
		let ok = 0;
		const failed: number[] = [];
		for (const [i, id] of ids.entries()) {
			if (g !== batchGen) return;
			text.textContent = `Revisando ${i + 1} de ${ids.length}…`;
			try {
				await acpReview(id);
				ok++;
			} catch (err) {
				if ((err as { status?: number }).status === 409) ok++;
				else failed.push(id);
			}
		}
		if (g !== batchGen) return;
		me.running = false;
		refreshInbox(0);
		const reviewed = ok === 1 ? "1 dada por revisada" : `${ok} dadas por revisadas`;
		if (failed.length === 0) {
			batch = null;
			showToast(`${reviewed} · no se reencoló nada`);
			render();
			return;
		}
		text.textContent = `${reviewed}; ${failed.length} no se ${failed.length === 1 ? "pudo" : "pudieron"} guardar y ${failed.length === 1 ? "sigue" : "siguen"} en la lista.`;
		const retry = el("button", "btn sm primary", "Volver a intentar");
		retry.type = "button";
		retry.addEventListener("click", () => {
			batch = null;
			runBatch(failed);
		});
		const close = el("button", "btn sm", "Cerrar");
		close.type = "button";
		close.addEventListener("click", () => {
			batch = null;
			render();
		});
		acts.append(retry, close);
		render();
	})();
}

function keep(key: string, sig: unknown, build: () => HTMLElement): HTMLElement {
	const s = JSON.stringify(sig);
	let r = rows.get(key);
	if (r?.sig !== s) {
		r = { sig: s, el: build() };
		rows.set(key, r);
	}
	return r.el;
}

function itemShell(
	cls: string,
	agent: string,
	where: string,
	gone = false,
): { item: HTMLElement; main: HTMLElement } {
	const item = el("div", `acp-ib-item ${cls}`);
	const face = el(
		"span",
		gone ? "acp-avatar is-gone" : "acp-avatar",
		gone ? "?" : agent.slice(0, 1).toUpperCase(),
	);
	face.setAttribute("aria-hidden", "true");
	item.style.setProperty("--acp-hue", String(agentHue(agent)));
	const main = el("div", "acp-ib-main");
	main.append(el("div", "acp-ib-where", where));
	item.append(face, main);
	return { item, main };
}

function goButton(
	m: { id: number; conversation_id?: string | null; project_id?: string | null },
	agent: string,
	result: boolean,
): HTMLElement | null {
	const target: GoTarget = {
		id: m.id,
		conversationId: m.conversation_id ?? null,
		projectId: m.project_id ?? null,
		agent,
	};
	if (hooks.canGo && !hooks.canGo(target)) return null;
	const b = el(
		"button",
		"btn sm ghost acp-ib-go",
		target.conversationId ? "Ver en el tema" : "Ver en el Archivo",
	);
	b.type = "button";
	b.addEventListener("click", () => {
		dialog?.close();
		hooks.goTo(target, { result });
	});
	return b;
}

function questionItem(q: InboxQuestion): HTMLElement {
	const where = whereOf(q.project_id, q.conversation_id, q.agent);
	return keep(`q:${q.id}`, [q.state, where], () => {
		const { item, main } = itemShell("is-question", q.agent, where);
		const g = openGen;
		let card = cards.get(q.id);
		if (!card || card.state !== q.state) {
			card = {
				state: q.state,
				el: questionCard(q, {
					stillHere: () => g === openGen,
					// Answered: confirmed in place for a moment, then it leaves.
					onAnswered: (row) => onQuestionAnswered(q, row),
				}),
			};
			cards.set(q.id, card);
		}
		const acts = el("div", "acp-ib-acts");
		const go =
			q.message_id === null
				? null
				: goButton(
						{ id: q.message_id, conversation_id: q.conversation_id, project_id: q.project_id },
						q.agent,
						false,
					);
		if (go) acts.append(go);
		main.append(card.el, acts);
		return item;
	});
}

function onQuestionAnswered(q: InboxQuestion, row: AcpQuestion): void {
	const g = openGen;
	answered.set(q.id, { q, said: answerText(questionForm(q.request), row.answer) });
	const list = listEl;
	const focusWasIn = Boolean(list?.contains(document.activeElement));
	render();
	// The focus goes on to the next question still waiting; with none, to the
	// confirmation itself (so it is not lost while the row is replaced).
	if (focusWasIn && list) {
		const next = list.querySelector<HTMLElement>(
			".acp-ib-item.is-question :is(input, textarea, select, button):not(:disabled)",
		);
		(next ?? list.querySelector<HTMLElement>(`[data-answered="${q.id}"]`))?.focus();
	}
	refreshInbox(0);
	setTimeout(() => {
		if (g !== openGen) return;
		answered.delete(q.id);
		render();
	}, ANSWERED_MS);
}

/** «✓ Respondida: GitHub · @arq sigue» — what was sent, where it was answered. */
function answeredItem(q: InboxQuestion): HTMLElement {
	const said = answered.get(q.id)?.said ?? "";
	return keep(`a:${q.id}`, said, () => {
		const where = whereOf(q.project_id, q.conversation_id, q.agent);
		const { item, main } = itemShell("is-answered", q.agent, where);
		item.dataset.answered = String(q.id);
		item.tabIndex = -1;
		const line = el(
			"p",
			"acp-ib-answered",
			`✓ Respondida${said ? `: ${said}` : ""} · @${q.agent} sigue`,
		);
		line.setAttribute("role", "status");
		main.append(line);
		return item;
	});
}

function resultItem(m: AcpMessage): HTMLElement {
	const where = whereOf(m.project_id ?? null, m.conversation_id ?? null, m.to_id);
	return keep(`r:${m.id}`, [m.result_text, where], () => {
		const { item, main } = itemShell("is-result", m.to_id, where);
		main.append(el("p", "acp-ib-what", `@${m.to_id}: ${clip(m.result_text ?? "", 220)}`));
		const acts = el("div", "acp-ib-acts");
		const go = goButton(m, m.to_id, true);
		if (go) acts.append(go);
		main.append(acts);
		return item;
	});
}

function clip(text: string, max = 160): string {
	const t = text.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Logout: nothing of this account stays. */
export function resetInboxPanel(): void {
	dialog?.close();
	batchGen++;
	batch = null;
	goneOpen = false;
	titles.clear();
	titlesRead.clear();
	cards.clear();
	rows.clear();
}
