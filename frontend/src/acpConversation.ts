// acpConversation.ts — a topic of a project (`#/projects/<pid>/c/<cid>`,
// 3B F1): its header and its thread. The thread is the shared one
// (acpThread.ts, source "conversation"): the topic's feed, posts with
// `conversationId`, live rows over /ws/acp, the divider «Nuevos desde tu
// última visita», «↓ N nuevos», the reading anchor kept across visits and
// the read mark of what the reader saw.
//
// One element for every topic (the thread resets itself when the topic
// changes): leaving a topic only stops following it, so coming back finds
// the same DOM and the reader's place.

import { AcpThread, type ThreadState } from "./acpThread.js";
import {
	type AcpConversation,
	acpArchiveConversation,
	acpCreateConversation,
	acpRenameConversation,
} from "./api.js";
import { openActionMenu } from "./components/actionMenu.js";
import { confirmDialog, promptDialog } from "./components/dialog.js";
import { showToast } from "./components/toast.js";
import { projectName } from "./projectDirectory.js";
import {
	agentState,
	onRailChange,
	patchConversation,
	railAgents,
	railConversation,
	topicTitle,
} from "./projectRail.js";
import { depth, navigateProject, projectRouteHash } from "./router.js";
import { setTitlePage } from "./tabTitle.js";
import { openAgentMenu, openTools } from "./toolsView.js";
import { button, el, syncChildren } from "./ui.js";

const TITLE_MAX = 120;

const root = el("div", "ps-topic");
root.setAttribute("role", "region");
root.setAttribute("aria-labelledby", "ps-topic-title");
const thread = new AcpThread();
const noteEl = el("p", "pv-status");
noteEl.hidden = true;

export const topicHeader = el("div", "pv-header ps-topic-head");
const back = el("a", "btn btn-icon ps-back", "‹");
back.setAttribute("aria-label", "Volver al proyecto");
back.title = "Volver al proyecto";
const titleBox = el("div", "ps-topic-titles");
const titleEl = el("h2", "pv-title ps-topic-title");
titleEl.id = "ps-topic-title";
titleEl.tabIndex = -1;
const subEl = el("p", "ps-topic-sub");
titleBox.append(titleEl, subEl);
const menuBtn = button(
	"⋯",
	"btn btn-icon pv-menu-btn",
	() => openMenu(),
	"Acciones de la conversación",
);
menuBtn.setAttribute("aria-haspopup", "menu");
topicHeader.append(back, titleBox, menuBtn);
root.append(noteEl, thread.root);

let pid: string | null = null;
let cid: string | null = null;
let state: ThreadState | null = null;
/** Whether the person reached this topic from the project's rail (‹ is then Back). */
let fromRail = false;

// An agent's avatar or name in the thread opens its menu (Files · Git ·
// Terminal · its works). A work's chip `⎇ <id>`: onTopicWork (projectsView).
thread.root.addEventListener("click", (e) => {
	const t = e.target;
	if (!(t instanceof Element)) return;
	const who = t.closest<HTMLElement>(".acp-agent-id[data-agent]");
	if (who?.dataset.agent) openAgentMenu(who.dataset.agent, who);
});

thread.titleOf = topicTitle;
thread.onState = (s) => {
	state = s;
	paint();
	revealPending();
};
onRailChange(() => paint());

back.addEventListener("click", (e) => {
	if (!pid || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
	e.preventDefault();
	upToProject(pid);
});

/**
 * Up the stack project → topic: Back when the topic was opened from the
 * rail (what the browser's Back and the gesture do too), otherwise the
 * project in the topic's place — never a second entry of the project.
 */
function upToProject(projectId: string): void {
	if (fromRail && depth() > 0) history.back();
	else navigateProject({ projectId }, { replace: true });
}

/** The topic's page element, following topic `conversationId` of project `projectId`. */
export function topicPage(
	projectId: string,
	conversationId: string,
	opener: "rail" | "other",
): HTMLElement {
	if (cid !== conversationId) fromRail = opener === "rail";
	pid = projectId;
	cid = conversationId;
	back.href = projectRouteHash({ projectId });
	thread.open({ kind: "conversation", conversationId, projectId });
	state = thread.state;
	paint();
	queueMicrotask(revealPending);
	return root;
}

// ── Going to a message from elsewhere (Pendientes, a review) ────────────────

/** A message to show once its topic's feed is read («Ver en el tema»). */
let pendingReveal: { cid: string; id: number; result: boolean } | null = null;

/**
 * Opens topic `conversationId` of project `projectId` at message `id`
 * (its answer's own item when `result`), highlighted.
 */
export function revealInTopic(
	projectId: string,
	conversationId: string,
	id: number,
	result: boolean,
): void {
	pendingReveal = { cid: conversationId, id, result };
	if (cid === conversationId && root.isConnected) revealPending();
	else navigateProject({ projectId, page: "conversation", conversationId });
}

function revealPending(): void {
	const p = pendingReveal;
	if (!p || p.cid !== cid || !root.isConnected) return;
	if (state?.feed === "loading") return;
	pendingReveal = null;
	if (state?.feed === "not-found") return;
	// After the frame that lays the feed out (the thread renders on the next one).
	requestAnimationFrame(() => {
		void thread.revealMessage(p.id, { result: p.result }).then((found) => {
			if (found === "earlier")
				thread.showNotice(
					`El mensaje #${p.id} está más atrás en el historial: «Cargar anteriores» sigue buscando.`,
				);
			else if (found === "missing")
				thread.showNotice(`No se encontró el mensaje #${p.id} en este tema.`);
		});
	});
}

/**
 * Where a message's `⎇ <work>` chip leads: Herramientas on that work (3B
 * F4 plugs it in; until then the chip only names the work).
 */
export function onTopicWork(open: ((agent: string, work: string) => void) | null): void {
	thread.onOpenWork = open;
}

/** «Escribirle un mensaje nuevo»: topic `conversationId`, with `agent` as its recipient. */
export function writeInTopic(projectId: string, conversationId: string, agent: string): void {
	thread.presetRecipients(conversationId, [agent]);
	if (cid !== conversationId || !root.isConnected)
		navigateProject({ projectId, page: "conversation", conversationId });
	requestAnimationFrame(() => thread.input.focus());
}

/** Off screen: stop following (DOM and state kept for a quick return). */
export function suspendTopic(): void {
	thread.close();
}

export function resetTopic(): void {
	thread.close();
	pid = null;
	cid = null;
	state = null;
}

/** The topic as last known: the thread's feed, else the rail's list. */
function topic(): AcpConversation | null {
	if (!cid) return null;
	const fromFeed = state?.conversation?.id === cid ? state.conversation : null;
	return fromFeed ?? railConversation(cid);
}

function paint(): void {
	if (!pid || !cid) return;
	const c = topic();
	const missing = state?.feed === "not-found";
	const title = c?.title ?? (missing ? "Conversación no encontrada" : "Conversación");
	if (titleEl.textContent !== title) titleEl.textContent = title;
	if (root.isConnected) setTitlePage(title);
	titleEl.title = title;
	// "Proyecto · @a trabajando": who works here now, in the fixed words.
	const here = railAgents()
		.filter((a) => a.projectId === pid)
		.filter((a) => agentState(a).label.startsWith("trabajando aquí"))
		.map((a) => `@${a.name} trabajando`);
	const sub = [projectName(pid) ?? "", ...here].filter(Boolean).join(" · ");
	if (subEl.textContent !== sub) subEl.textContent = sub;
	const isArchived = Boolean(c?.archivedAt);
	menuBtn.hidden = !c || isArchived || missing;
	// An archived topic is read here, without a message box; a missing one says so.
	thread.setComposer(missing || isArchived ? "off" : c ? "on" : "disabled");
	const note = missing
		? "Esta conversación no existe o ya no está en este proyecto."
		: isArchived
			? "Conversación archivada · solo lectura"
			: state?.feed === "error"
				? "No se pudo cargar la conversación."
				: "";
	noteEl.hidden = note === "";
	noteEl.classList.toggle("pv-status-error", missing || state?.feed === "error");
	if (noteEl.textContent !== note) {
		const parts: Array<string | HTMLElement> = [note];
		if (state?.feed === "error")
			parts.push(
				" ",
				button("Reintentar", "pv-btn", () => thread.retry()),
			);
		noteEl.replaceChildren(...parts);
	}
	thread.root.hidden = missing;
	syncChildren(root, headerInPage ? [topicHeader, noteEl, thread.root] : [noteEl, thread.root]);
}

/**
 * Where the header row goes: on top of the topic (wide), or out of it — on
 * a phone projectsView puts it in the app's header, in the session bar's place.
 */
let headerInPage = true;
export function placeTopicHeader(inPage: boolean): void {
	headerInPage = inPage;
	if (!inPage && topicHeader.parentElement === root) topicHeader.remove();
	paint();
}

function openMenu(): void {
	const c = topic();
	if (!c) return;
	openActionMenu({
		title: c.title,
		opener: menuBtn,
		items: [
			// Herramientas: the agents of the project, the ones working here first.
			...teamForTools().map((name) => ({
				id: `t:${name}`,
				label: `Herramientas de @${name}`,
				hint: "Files · Git · Terminal",
			})),
			{ id: "rename", label: "Renombrar" },
			{
				id: "archive",
				label: "Archivar",
				kind: "danger",
				hint: "Sale de la lista y no admite mensajes nuevos; su historial sigue legible.",
			},
		],
		onPick: (id) => {
			if (id.startsWith("t:")) openTools({ agent: id.slice(2), work: null, tool: "files" });
			else if (id === "rename") void renameTopic(c);
			else void archiveTopic(c);
		},
	});
}

/** The project's agents, the ones working in this topic first. */
function teamForTools(): string[] {
	const team = railAgents().filter((a) => a.projectId === pid);
	const here = (a: (typeof team)[number]) =>
		a.runningIn?.some((r) => r.conversationId === cid) === true;
	return [...team.filter(here), ...team.filter((a) => !here(a))].map((a) => a.name);
}

function titleProblem(v: string): string | null {
	const t = v.trim();
	return t === ""
		? "Poné un título"
		: [...t].length > TITLE_MAX
			? `Hasta ${TITLE_MAX} caracteres`
			: null;
}

/**
 * «Nueva conversación» (and «Continuar en una conversación nueva», the
 * Archive's): the title, then the topic — shown in the rail at once. Null
 * when cancelled. One id per dialog: a retry after an unknown outcome is
 * the same topic.
 */
export async function newTopicDialog(
	projectId: string,
	opts: { title?: string; initial?: string } = {},
): Promise<AcpConversation | null> {
	const clientRequestId = crypto.randomUUID();
	let created: AcpConversation | null = null;
	await promptDialog({
		title: opts.title ?? "Nueva conversación",
		label: "Título",
		initialValue: opts.initial ? [...opts.initial].slice(0, TITLE_MAX).join("") : undefined,
		confirmLabel: "Crear",
		validate: titleProblem,
		onConfirm: async (v) => {
			try {
				const c = await acpCreateConversation(projectId, v.trim(), clientRequestId);
				patchConversation(c);
				created = c;
				return null;
			} catch (err) {
				const e = err as { code?: string };
				return e.code === "outcome-unknown"
					? "No se pudo confirmar. Volvé a intentar: no se duplica."
					: refusal(err, "No se pudo crear");
			}
		},
	});
	return created;
}

async function renameTopic(c: AcpConversation): Promise<void> {
	let done: AcpConversation | null = null;
	await promptDialog({
		title: "Renombrar conversación",
		label: "Título",
		initialValue: c.title,
		confirmLabel: "Renombrar",
		validate: titleProblem,
		onConfirm: async (v) => {
			try {
				done = await acpRenameConversation(c.id, v.trim());
				return null;
			} catch (err) {
				return refusal(err, "No se pudo renombrar");
			}
		},
	});
	if (done) {
		patchConversation(done);
		showToast("Conversación renombrada");
	}
}

async function archiveTopic(c: AcpConversation): Promise<void> {
	const ok = await confirmDialog({
		title: `Archivar «${c.title}»`,
		message:
			"Sale de la lista de conversaciones y no admite mensajes nuevos. Su historial sigue legible desde «Conversaciones archivadas», en el panel del proyecto.",
		confirmLabel: "Archivar",
		danger: true,
	}).catch(() => false);
	if (!ok) return;
	try {
		const row = await acpArchiveConversation(c.id);
		patchConversation(row);
		showToast("Conversación archivada");
		// The project, in the topic's place: an archived topic is not where one writes.
		if (cid === c.id && pid) upToProject(pid);
	} catch (err) {
		showToast(refusal(err, "No se pudo archivar"), true);
	}
}

/** Fixed words for a refused write (never the server's code alone). */
export function refusal(err: unknown, what: string): string {
	const e = err as { status?: number; code?: string };
	if (e.status === undefined) return "No se pudo conectar. Volvé a intentar.";
	if (e.code === "invalid-title")
		return `Título inválido: 1–${TITLE_MAX} caracteres, sin caracteres de control.`;
	if (e.status === 404) return "La conversación ya no existe.";
	return `${what} (${e.code ?? e.status}).`;
}
