// acpArchive.ts — a project's Archive (3B F5, PROPUESTA §7): what was
// written before topics, read where it is (nothing is migrated):
//
//   #/projects/<pid>/archive           its list: the previous Project Chat
//                                      and, per agent of the project, its
//                                      previous direct messages — only the
//                                      ones that have any
//   #/projects/<pid>/archive/<key>     one of them (`project` | `@<agent>`),
//                                      read-only: the topic's thread
//                                      (acpThread.ts, source "archive")
//                                      without composer, a fixed strip
//                                      «Archivo · solo lectura» and
//                                      «Continuar en una conversación nueva»
//
// An interruption or a question that lives here is resolved in Pendientes
// (acpInbox.ts reads every scope); this thread only says so.

import { newTopicDialog } from "./acpConversation.js";
import { AcpThread, type ThreadState } from "./acpThread.js";
import { type AcpMessage, acpFeed, acpProjectFeed } from "./api.js";
import { projectName } from "./projectDirectory.js";
import { onRailChange, railAgents } from "./projectRail.js";
import { depth, navigateProject, projectRouteHash } from "./router.js";
import { setTitlePage } from "./tabTitle.js";
import { openAgentMenu } from "./toolsView.js";
import { button, el, syncChildren } from "./ui.js";

/** The page size of the feeds (the server's): a shorter page is the first one. */
const PAGE = 100;
/**
 * Pages read back, at most, looking for an agent's first direct message:
 * its feed carries the project's previous chat too, and a long one can hide
 * older direct messages. Past that the entry is listed without a date.
 */
const PROBE_PAGES = 5;

interface Entry {
	key: string;
	title: string;
	/** When its last message was written; null: not looked that far back. */
	last: string | null;
}

/** An entry's title: also the base of the new topic's title. */
export function archiveTitle(key: string): string {
	return key === "project" ? "Project Chat anterior" : `${key} · chat individual`;
}

// ── Elements ────────────────────────────────────────────────────────────────

export const archiveHeader = el("div", "pv-header ps-topic-head");
const back = el("a", "btn btn-icon ps-back", "‹");
const titleBox = el("div", "ps-topic-titles");
const titleEl = el("h2", "pv-title ps-topic-title");
titleEl.id = "ps-archive-title";
titleEl.tabIndex = -1;
const subEl = el("p", "ps-topic-sub");
titleBox.append(titleEl, subEl);
archiveHeader.append(back, titleBox);

const root = el("div", "ps-topic ps-archive");
root.setAttribute("role", "region");
root.setAttribute("aria-labelledby", titleEl.id);
const noteEl = el("p", "pv-status");
noteEl.hidden = true;

const listEl = el("ul", "ps-archive-list");
listEl.setAttribute("aria-label", "Archivo");
const listNote = el("p", "ps-home-note ps-archive-note");

const thread = new AcpThread();
thread.setComposer("off");
const strip = el("div", "ps-readonly");
strip.append(
	el("span", "ps-readonly-text", "Archivo · solo lectura"),
	button("Continuar en una conversación nueva", "btn sm ps-continue", () => void continueHere()),
);

// An agent's avatar or name opens its menu, as in a topic.
thread.root.addEventListener("click", (e) => {
	const t = e.target;
	if (!(t instanceof Element)) return;
	const who = t.closest<HTMLElement>(".acp-agent-id[data-agent]");
	if (who?.dataset.agent) openAgentMenu(who.dataset.agent, who);
});

// ── State ───────────────────────────────────────────────────────────────────

let pid: string | null = null;
/** The chat on screen; null: the list. */
let key: string | null = null;
let state: ThreadState | null = null;
/** The list of `listFor`'s project, as last read (null: not read yet). */
let entries: Entry[] | null = null;
let listFor: string | null = null;
let listError = false;
/** The agents the list was read for: a change in the team reads it again. */
let listAgents = "";
let listGen = 0;
/** Whether the chat on screen was opened from the list (‹ is then Back). */
let fromList = false;

thread.onState = (s) => {
	state = s;
	paint();
	revealPending();
};
onRailChange(() => {
	if (pid && root.isConnected && teamKey(pid) !== listAgents) void loadList(pid);
});

back.addEventListener("click", (e) => {
	if (!pid || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
	e.preventDefault();
	if (key) {
		if (fromList && depth() > 0) history.back();
		else navigateProject({ projectId: pid, page: "archive" }, { replace: true });
	} else navigateProject({ projectId: pid }, { replace: true });
});

function teamKey(p: string): string {
	return railAgents()
		.filter((a) => a.projectId === p)
		.map((a) => a.name)
		.sort()
		.join(" ");
}

// ── The page (projectsView.ts) ──────────────────────────────────────────────

/**
 * The Archive's page of project `projectId`: its list (`archiveKey` null)
 * or one of its chats. `opener` "list": the chat was picked from the list.
 */
export function archivePage(
	projectId: string,
	archiveKey: string | null,
	opener: "list" | "other",
): HTMLElement {
	if (archiveKey !== null && archiveKey !== key) fromList = opener === "list";
	pid = projectId;
	key = archiveKey;
	if (archiveKey === null) {
		thread.close();
		if (listFor !== projectId || teamKey(projectId) !== listAgents) void loadList(projectId);
	} else {
		thread.open({
			kind: "archive",
			projectId,
			agent: archiveKey === "project" ? null : archiveKey.slice(1),
		});
		state = thread.state;
	}
	back.href =
		archiveKey === null
			? projectRouteHash({ projectId })
			: projectRouteHash({ projectId, page: "archive" });
	paint();
	return root;
}

/** Off screen: stop following (DOM and reading place kept for a quick return). */
export function suspendArchive(): void {
	thread.close();
}

export function resetArchive(): void {
	thread.close();
	pid = null;
	key = null;
	state = null;
	entries = null;
	listFor = null;
	listAgents = "";
	listGen++;
}

/**
 * Where the header row goes: on top of the page (wide), or — on a phone —
 * in the app's header (projectsView), like a topic's.
 */
let headerInPage = true;
export function placeArchiveHeader(inPage: boolean): void {
	headerInPage = inPage;
	if (!inPage && archiveHeader.parentElement === root) archiveHeader.remove();
	paint();
}

// ── The list ────────────────────────────────────────────────────────────────

async function loadList(p: string): Promise<void> {
	const g = ++listGen;
	const team = teamKey(p);
	if (listFor !== p) entries = null;
	listFor = p;
	listAgents = team;
	listError = false;
	paint();
	try {
		const names = team ? team.split(" ") : [];
		const found = await Promise.all([
			acpProjectFeed(p).then((f) =>
				f.messages.length ? entry("project", f.messages.at(-1)!) : null,
			),
			...names.map((n) => agentEntry(n)),
		]);
		if (g !== listGen) return;
		entries = found.filter((x): x is Entry => x !== null);
	} catch {
		if (g !== listGen) return;
		listError = true;
	}
	paint();
}

function entry(k: string, m: AcpMessage | null): Entry {
	return { key: k, title: archiveTitle(k), last: m ? (m.finished_at ?? m.created_at) : null };
}

/** An agent's direct part: no project, no topic. */
function direct(m: AcpMessage): boolean {
	return !m.conversation_id && !m.project_id;
}

async function agentEntry(name: string): Promise<Entry | null> {
	let before: number | undefined;
	for (let i = 0; i < PROBE_PAGES; i++) {
		const f = await acpFeed(name, before);
		const mine = f.messages.filter(direct);
		if (mine.length) return entry(`@${name}`, mine.at(-1)!);
		if (f.messages.length < PAGE) return null;
		before = f.messages[0]!.id;
	}
	return entry(`@${name}`, null);
}

function listRow(p: string, e: Entry): HTMLElement {
	const li = el("li");
	const a = el("a", "rail-row ps-archive-row");
	a.href = projectRouteHash({ projectId: p, page: "archive", archive: e.key });
	const text = el("span", "rail-row-text");
	text.append(el("span", "rail-row-title", e.title));
	text.append(
		el("span", "rail-row-sub", e.last ? `hasta ${day(e.last)} · solo lectura` : "solo lectura"),
	);
	a.append(text);
	a.addEventListener("click", (ev) => {
		if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
		ev.preventDefault();
		navigateProject({ projectId: p, page: "archive", archive: e.key });
	});
	li.append(a);
	return li;
}

function day(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime())
		? ""
		: d.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit", year: "numeric" });
}

// ── Painting ────────────────────────────────────────────────────────────────

function paint(): void {
	const p = pid;
	if (!p) return;
	const parts: HTMLElement[] = headerInPage ? [archiveHeader] : [];
	if (key === null) {
		setText(titleEl, "Archivo · solo lectura");
		setText(subEl, projectName(p) ?? "");
		back.setAttribute("aria-label", "Volver al proyecto");
		back.title = "Volver al proyecto";
		const shown = listFor === p ? entries : null;
		syncChildren(
			listEl,
			(shown ?? []).map((e) => listRow(p, e)),
		);
		listEl.hidden = !shown?.length;
		listNote.replaceChildren(
			listError
				? "No se pudo leer el Archivo. "
				: shown === null
					? "Cargando…"
					: shown.length === 0
						? "El Archivo de este proyecto está vacío: todo lo escrito está en sus conversaciones."
						: "Lo escrito antes de los temas, donde estaba. Se lee; no se escribe.",
		);
		if (listError) listNote.append(button("Reintentar", "pv-btn", () => void loadList(p)));
		parts.push(listNote, listEl);
		if (root.isConnected) setTitlePage("Archivo");
	} else {
		const title = archiveTitle(key);
		setText(titleEl, title);
		setText(subEl, "Solo lectura");
		back.setAttribute("aria-label", "Volver al Archivo");
		back.title = "Volver al Archivo";
		const missing = state?.feed === "not-found";
		const note = missing
			? key === "project"
				? "Este proyecto ya no existe."
				: "Este agente ya no existe."
			: state?.feed === "error"
				? "No se pudo cargar el archivo."
				: "";
		noteEl.hidden = note === "";
		noteEl.classList.toggle("pv-status-error", note !== "");
		if (noteEl.dataset.note !== note) {
			noteEl.dataset.note = note;
			const bits: Array<string | HTMLElement> = [note];
			if (state?.feed === "error")
				bits.push(
					" ",
					button("Reintentar", "pv-btn", () => thread.retry()),
				);
			noteEl.replaceChildren(...bits);
		}
		thread.root.hidden = missing;
		strip.hidden = missing;
		parts.push(noteEl, thread.root, strip);
		if (root.isConnected) setTitlePage(title);
	}
	syncChildren(root, parts);
}

function setText(node: HTMLElement, text: string): void {
	if (node.textContent !== text) node.textContent = text;
}

// ── Continuar en una conversación nueva ────────────────────────────────────

/**
 * A new topic of the project, its title proposed from the archive and
 * editable, opened with an empty message box. Nothing is copied: no
 * message, no recipient, no link back.
 */
async function continueHere(): Promise<void> {
	const p = pid;
	const k = key;
	if (!p || !k) return;
	const c = await newTopicDialog(p, {
		title: "Continuar en una conversación nueva",
		initial: `Continuación de ${archiveTitle(k)}`,
	});
	if (c && pid === p) navigateProject({ projectId: p, page: "conversation", conversationId: c.id });
}

// ── Going to a message from elsewhere (Pendientes) ──────────────────────────

let pendingReveal: { key: string; id: number; result: boolean } | null = null;

/** Opens Archive chat `archiveKey` of project `projectId` at message `id`, highlighted. */
export function revealInArchive(
	projectId: string,
	archiveKey: string,
	id: number,
	result: boolean,
): void {
	pendingReveal = { key: archiveKey, id, result };
	if (pid === projectId && key === archiveKey && root.isConnected) revealPending();
	else navigateProject({ projectId, page: "archive", archive: archiveKey });
}

function revealPending(): void {
	const r = pendingReveal;
	if (!r || r.key !== key || !root.isConnected) return;
	if (state?.feed === "loading") return;
	pendingReveal = null;
	if (state?.feed === "not-found") return;
	requestAnimationFrame(() => {
		void thread.revealMessage(r.id, { result: r.result }).then((found) => {
			if (found === "earlier")
				thread.showNotice(
					`El mensaje #${r.id} está más atrás en el historial: «Cargar anteriores» sigue buscando.`,
				);
			else if (found === "missing") thread.showNotice(`No se encontró el mensaje #${r.id} aquí.`);
		});
	});
}

/** Where a message's `⎇ <work>` chip leads (Herramientas), as in a topic. */
export function onArchiveWork(open: ((agent: string, work: string) => void) | null): void {
	thread.onOpenWork = open;
}
