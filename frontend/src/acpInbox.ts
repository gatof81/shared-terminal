// acpInbox.ts — Pendientes (PROPUESTA §4): one inbox for every project,
// opened from the header's icon (its count = what requires the person's
// action) on every screen and from the rail's attention row. Two sections:
//
//   - «Requieren tu acción»: open questions (answered right here, the same
//     card as in the thread) and interrupted runs not reviewed («Revisar
//     interrupción», never a one-tap retry);
//   - «Resultados sin ver»: agents' answers to the person not seen yet —
//     informative, not counted.
//
// «Ver en el tema» opens the topic with the message highlighted («Ver en el
// Archivo»: the Archive's chat, for what was written before topics). It is a
// dialog (components/dialog.ts): over everything, `inert` underneath, so the
// terminal under it keeps its box — opening or closing it sends no resize.

import { inboxNow, onInbox, refreshInbox } from "./acpInboxStore.js";
import { agentHue } from "./acpModel.js";
import { questionCard } from "./acpQuestionCard.js";
import { acpEntryByName } from "./acpRegistry.js";
import { openReview } from "./acpReview.js";
import { type AcpMessage, type AcpQuestion, acpConversations } from "./api.js";
import { createDialog, type Dialog } from "./components/dialog.js";
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
let unsub: (() => void) | null = null;
/** Bumped per opening: an answer that lands after the panel closed changes nothing. */
let openGen = 0;

/** Question cards and rows kept across renders (typed answers and focus survive a refresh). */
const cards = new Map<number, { state: string; el: HTMLElement }>();
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
	render();
	refreshInbox(0);
	unsub = onInbox(() => render());
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

function render(): void {
	const list = listEl;
	if (!list) return;
	const box = inboxNow();
	const nodes: HTMLElement[] = [];
	nodes.push(keep("h:action", 0, () => el("h3", "acp-inbox-sec", "Requieren tu acción")));
	const action: Array<{ at: string; node: HTMLElement }> = [];
	for (const q of box?.action.questions ?? [])
		action.push({ at: q.created_at, node: questionItem(q) });
	for (const m of box?.action.interrupted ?? [])
		action.push({ at: m.finished_at ?? m.created_at, node: interruptedItem(m) });
	action.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
	if (box === null) nodes.push(keep("loading", 0, () => el("p", "acp-inbox-none", "Cargando…")));
	else if (action.length === 0)
		nodes.push(keep("none", 0, () => el("p", "acp-inbox-none", "Nada pendiente")));
	else nodes.push(...action.map((a) => a.node));
	const results = box?.results ?? [];
	if (results.length) {
		nodes.push(keep("h:results", 0, () => el("h3", "acp-inbox-sec", "Resultados sin ver")));
		for (const m of results) nodes.push(resultItem(m));
	}
	syncChildren(list, nodes);
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
): { item: HTMLElement; main: HTMLElement } {
	const item = el("div", `acp-ib-item ${cls}`);
	const face = el("span", "acp-avatar", agent.slice(0, 1).toUpperCase());
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

function questionItem(
	q: AcpQuestion & { conversation_id: string | null; project_id: string | null },
): HTMLElement {
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
					// Answered: it leaves the section when the inbox is read again.
					onAnswered: () => refreshInbox(0),
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

function interruptedItem(m: AcpMessage): HTMLElement {
	const where = whereOf(m.project_id ?? null, m.conversation_id ?? null, m.to_id);
	return keep(`u:${m.id}`, [m.reviewed_at ?? null, m.note, where], () => {
		const { item, main } = itemShell("is-interrupted", m.to_id, where);
		main.append(
			el(
				"p",
				"acp-ib-what",
				m.from_id === "owner"
					? `Se interrumpió tu mensaje a @${m.to_id}: «${clip(m.body)}»`
					: `Se interrumpió la consulta de @${m.from_id} a @${m.to_id}: «${clip(m.body)}»`,
			),
		);
		const acts = el("div", "acp-ib-acts");
		const review = el("button", "btn sm acp-review-btn", "Revisar interrupción");
		review.type = "button";
		review.addEventListener("click", () =>
			openReview(m, {
				where: m.conversation_id ? whereOf(null, m.conversation_id, m.to_id) : null,
			}),
		);
		const go = goButton(m, m.to_id, false);
		acts.append(review, ...(go ? [go] : []));
		main.append(acts);
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
	titles.clear();
	titlesRead.clear();
	cards.clear();
	rows.clear();
}
