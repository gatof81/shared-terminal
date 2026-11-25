/**
 * projectsView.ts — Projects: the sidebar's Projects section (its "+"), the
 * project's pages and the new-project dialog. A project groups ACP agents
 * and gives them topics; each agent keeps its own session.
 *
 *   #/projects/<pid>          the project: its rail (projectRail.ts) — in the
 *                             sidebar on a wide screen, the whole screen on a phone
 *   #/projects/<pid>/c/<cid>  a topic (acpConversation.ts), the rail beside it
 *   #/projects/<pid>/archive[/<k>]  the Archive (acpArchive.ts): its list, or
 *                             one of its read-only chats, the rail beside it
 *   #/projects/<pid>[/c/<cid>]/tools/…  Herramientas (toolsView.ts), over the
 *                             topic it was opened from
 *
 * The page is shown OVER the session workbench, never instead of it: the
 * terminal area's other children only turn `visibility: hidden` (layout
 * kept), so the terminal is neither resized nor detached and its socket
 * stays open (the terminal invariant, viewSwitch.ts).
 */

import {
	archiveHeader,
	archivePage,
	onArchiveWork,
	placeArchiveHeader,
	resetArchive,
	revealInArchive,
	suspendArchive,
} from "./acpArchive.js";
import {
	newTopicDialog,
	onTopicWork,
	placeTopicHeader,
	resetTopic,
	revealInTopic,
	suspendTopic,
	topicHeader,
	topicPage,
	writeInTopic,
} from "./acpConversation.js";
import { configureInbox, mountInboxButton, openInbox, resetInboxPanel } from "./acpInbox.js";
import { resetInbox, startInbox } from "./acpInboxStore.js";
import { acpEntryByName, resetAcpAgents } from "./acpRegistry.js";
import { configureReview } from "./acpReview.js";
import { readAcpAgents, stopAcpStatusFeed } from "./acpStatusFeed.js";
import {
	archiveProject,
	createProject,
	fetchProjects,
	isLoggedIn,
	type ProjectSummary,
	renameProject,
} from "./api.js";
import { confirmDialog, promptDialog } from "./components/dialog.js";
import { showToast } from "./components/toast.js";
import {
	clearProjects,
	currentProject,
	projectName,
	projects,
	projectsLoaded,
	setCurrentProject,
	setProjects,
} from "./projectDirectory.js";
import {
	configureRail,
	hideRail,
	onRailChange,
	railBody,
	railConversations,
	railHead,
	repaintRail,
	resetRail,
	showRail,
	topicTitle,
} from "./projectRail.js";
import {
	disableProjectRoutes,
	enableProjectRoutes,
	fromHistory,
	navigateProject,
	onAddressWrite,
	type ProjectPage,
	type ProjectRoute,
	projectRouteHash,
	pushSessionAddress,
	readProjectRoute,
} from "./router.js";
import { renderSessionList, sessionListLoaded } from "./sessionCore.js";
import { setTitlePage } from "./tabTitle.js";
import {
	hideTools,
	leaveTools,
	openAgentMenu,
	openTools,
	resetTools,
	showTools,
} from "./toolsView.js";
import { button, el } from "./ui.js";

const section = document.getElementById("project-section");
const projectList = document.getElementById("project-list");
const newProjectBtn = document.getElementById("new-project-btn") as HTMLButtonElement | null;
const pageEl = document.getElementById("project-view");
const terminalArea = document.getElementById("terminal-area");

const PROJECTS_REFRESH_MS = 60_000;
const PROJECT_NAME_MAX = 80;

let active = false; // signed in + app shown
let shown: string | null = null; // the project id on screen
let shownPage: ProjectPage | null = null; // which of its pages
let shownTopic: string | null = null;
/** The Archive's chat on screen (`page: "archive"`; null: its list). */
let shownArchive: string | null = null;
let gen = 0; // bumped by every reset (logout): a load started before applies nothing
let loadError = false;
let canCreate = true;
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function loadProjects(): Promise<void> {
	const myGen = gen;
	const a = await fetchProjects().catch(() => null);
	if (myGen !== gen || !active) return;
	if (a?.ok) {
		loadError = false;
		canCreate = a.body.can.createProject.allowed;
		if (setProjects(a.body.projects) && sessionListLoaded()) renderSessionList();
	} else if (a?.code !== "stale") loadError = true;
	renderSection();
	paintSpace();
	repaintRail();
}

// ── Sidebar section ─────────────────────────────────────────────────────────

function renderSection(): void {
	if (!section || !projectList) return;
	section.hidden = !active;
	projectList.replaceChildren();
	if (!active) return;
	if (newProjectBtn) {
		newProjectBtn.disabled = !canCreate;
		newProjectBtn.title = canCreate
			? "Crear un proyecto para tus agentes"
			: "Llegaste al límite de proyectos";
	}
	// The projects themselves are the headings of the sidebar tree
	// (sessionCore.ts): this section says what the tree can't.
	if (!projectsLoaded())
		projectList.appendChild(
			el(
				"p",
				"project-list-note",
				loadError ? "No se pudieron cargar los proyectos; reintentando." : "Cargando proyectos…",
			),
		);
	else if (projects().length === 0)
		projectList.appendChild(
			el(
				"p",
				"project-list-note",
				"Sin proyectos. Un proyecto agrupa agentes ACP y les da conversaciones.",
			),
		);
	if (currentProject() !== shown) {
		setCurrentProject(shown);
		if (sessionListLoaded()) renderSessionList();
	}
}

// ── Page ────────────────────────────────────────────────────────────────────

function sync(): void {
	const r = active ? readProjectRoute() : null;
	if (r === null) {
		hidePage();
		return;
	}
	// The address in its canonical form (an encoding written differently):
	// in place, not a history entry; the write comes back here (onAddressWrite).
	if (window.location.hash !== projectRouteHash(r)) {
		navigateProject(r, { replace: true });
		return;
	}
	syncSpace(r, shown, shownPage);
	renderSection();
}

/**
 * Herramientas: the session's workbench comes out from under the page, which
 * stays mounted — invisible (`visibility`, layout and scroll kept) and inert.
 */
function liftPageEl(): void {
	if (!pageEl) return;
	document.body.classList.remove("project-page-on");
	pageEl.hidden = false;
	pageEl.inert = true;
}

function showPageEl(): void {
	if (!pageEl) return;
	document.body.classList.add("project-page-on");
	pageEl.hidden = false;
	pageEl.inert = false;
	// Keystrokes must not keep going to a terminal the page now covers.
	const focused = document.activeElement;
	if (
		focused instanceof HTMLElement &&
		terminalArea?.contains(focused) &&
		!pageEl.contains(focused)
	)
		focused.blur();
}

// ── The project's space: rail + topic ───────────────────────────────────────
//
// One page element (`.ps-page`): a slot for the rail's body (a phone's
// project screen) and the main area (a topic, or on a wide screen with no
// topic, a line saying what to do). Where the rail goes follows the width
// (placeSpace): wide, head and body in the sidebar (#project-rail, the
// sidebar's other children hidden); on a phone, the head in the app's header
// and the body in the page — the header keeps its height either way, and
// the terminal under the page keeps its box (no resize).

const spaceEl = el("div", "ps-page");
const railSlot = el("div", "ps-rail-slot");
const mainSlot = el("div", "ps-main");
spaceEl.append(railSlot, mainSlot);
const railEl = el("div", "project-rail");
railEl.id = "project-rail";
const homeEl = el("div", "ps-home");
const homeTitle = el("h2", "ps-home-title", "Elegí una conversación");
homeTitle.tabIndex = -1;
const homeNote = el("p", "ps-home-note");
const homeNew = button("Nueva conversación", "btn sm ps-new", () => {
	if (shown) void newConversationFlow(shown);
});
homeEl.append(homeTitle, homeNote, homeNew);
const phoneMq = typeof window !== "undefined" ? window.matchMedia?.("(max-width: 768px)") : null;
phoneMq?.addEventListener?.("change", () => placeSpace());

function syncSpace(r: ProjectRoute, prevPid: string | null, prevPage: ProjectPage | null): void {
	const page = r.page ?? "home";
	// Herramientas keeps the topic it was opened from mounted under it.
	const topic = page === "conversation" || page === "tools" ? (r.conversationId ?? null) : null;
	const archive = page === "archive" ? (r.archive ?? null) : null;
	const topicChanged = topic !== shownTopic || archive !== shownArchive || prevPid !== r.projectId;
	const prevArchive = shownArchive;
	shown = r.projectId;
	shownPage = page;
	shownTopic = topic;
	shownArchive = archive;
	if (!pageEl) return;
	if (page === "tools") liftPageEl();
	else {
		hideTools({ fromHistory: fromHistory() });
		showPageEl();
	}
	document.body.classList.add("project-space-on");
	// A phone's stack: the project's screen (the rail) → a topic / the Archive.
	document.body.classList.toggle("ps-on-topic", topic !== null || page === "archive");
	showRail(r.projectId, topic, page === "archive");
	if (topic) rememberTopic(r.projectId, topic);
	if (page !== "archive") suspendArchive();
	if (topic) {
		// From the rail (a phone's project screen, or the sidebar) by a tap,
		// not Back / Forward: ‹ is then the browser's Back.
		const opener =
			prevPid === r.projectId && prevPage === "home" && !fromHistory() ? "rail" : "other";
		place(mainSlot, topicPage(r.projectId, topic, opener));
	} else if (page === "archive") {
		suspendTopic();
		// A chat picked from the Archive's list by a tap: its ‹ is Back.
		const opener =
			prevPid === r.projectId && prevPage === "archive" && prevArchive === null && !fromHistory()
				? "list"
				: "other";
		place(mainSlot, archivePage(r.projectId, archive, opener));
	} else {
		suspendTopic();
		place(mainSlot, homeEl);
	}
	if (pageEl.firstChild !== spaceEl || pageEl.childNodes.length !== 1)
		pageEl.replaceChildren(spaceEl);
	placeSpace();
	paintSpace();
	if (page === "tools") {
		// The topic under Herramientas only waits (its place is kept by the DOM).
		suspendTopic();
		showTools(r);
		if (!projectsLoaded()) void loadProjects();
		return;
	}
	openTopicIfWide();
	if (topicChanged || prevPage !== page) {
		// The page's heading, for a screen reader (a phone's project screen has
		// none of its own: the rail's head is the app's header there).
		const target = topic
			? topicHeader.querySelector<HTMLElement>(".pv-title")
			: page === "archive"
				? archiveHeader.querySelector<HTMLElement>(".pv-title")
				: homeTitle;
		if (target?.offsetParent) target.focus({ preventScroll: true });
		if (!projectsLoaded()) void loadProjects();
	}
}

/**
 * `node` as `slot`'s only child — left where it is when it already is: taking
 * the thread out of the document and back loses its scroll (Herramientas ⇄
 * its topic must find the reader where they were).
 */
function place(slot: HTMLElement, node: HTMLElement): void {
	if (slot.firstChild !== node || slot.childNodes.length !== 1) slot.replaceChildren(node);
}

// ── The topic a wide screen opens ──────────────────────────────────────────
// Wide, the rail is beside the topic: entering a project opens its last
// topic visited in this browser, else its most recently active one (in the
// project's place, not a new entry, so Back leaves the project as it came).
// The empty main area is only for a project without topics. A phone's
// project screen IS the rail: nothing opens by itself there.

const LAST_TOPIC_KEY = "st.lastTopic";

function lastTopics(): Record<string, string> {
	try {
		const v = JSON.parse(localStorage.getItem(LAST_TOPIC_KEY) ?? "{}");
		return v && typeof v === "object" ? (v as Record<string, string>) : {};
	} catch {
		return {};
	}
}

function rememberTopic(pid: string, cid: string): void {
	try {
		localStorage.setItem(LAST_TOPIC_KEY, JSON.stringify({ ...lastTopics(), [pid]: cid }));
	} catch {
		/* storage off: the most recent topic opens instead */
	}
}

function openTopicIfWide(): void {
	if (shownPage !== "home" || !shown || phoneMq?.matches) return;
	const list = railConversations();
	if (!list?.length) return;
	const last = lastTopics()[shown];
	const pick = list.find((c) => c.id === last) ?? list[0]!;
	navigateProject(
		{ projectId: shown, page: "conversation", conversationId: pick.id },
		{ replace: true },
	);
}

/** What the space says about the project itself, and the tab's title. */
function paintSpace(): void {
	if (!shown || shownPage === null) return;
	const name = projectName(shown);
	const gone = projectsLoaded() && name === null;
	const list = railConversations();
	homeTitle.textContent = gone
		? "Proyecto no encontrado"
		: list?.length === 0
			? "Sin conversaciones todavía"
			: "";
	homeNote.textContent = gone
		? "No existe o fue archivado."
		: list?.length === 0
			? "Cada tema es una conversación con el equipo del proyecto."
			: "";
	homeNew.hidden = gone || list?.length !== 0;
	// Nothing of a rail for a project that is not there: the sidebar keeps its
	// sessions, and a phone shows this line instead of an empty project screen.
	document.body.classList.toggle("ps-gone", gone);
	// A topic's or the Archive's title is its own page's.
	if (!shownTopic && shownPage !== "archive") setTitlePage(name ?? "Proyecto");
}

function placeSpace(): void {
	const slot = document.getElementById("header-project");
	const sidebar = document.getElementById("sidebar");
	if (!shown || shownPage === null) return;
	if (phoneMq?.matches) {
		railEl.remove();
		railSlot.replaceChildren(railBody);
		if (slot) {
			// Herramientas: the header's row is the session bar's (its tools bar).
			if (shownPage === "tools") slot.replaceChildren();
			else
				slot.replaceChildren(
					shownPage === "archive" ? archiveHeader : shownTopic ? topicHeader : railHead,
				);
			slot.hidden = shownPage === "tools";
		}
		placeTopicHeader(false);
		placeArchiveHeader(false);
	} else {
		railSlot.replaceChildren();
		if (railEl.firstChild !== railHead) railEl.replaceChildren(railHead, railBody);
		if (sidebar && railEl.parentElement !== sidebar) sidebar.prepend(railEl);
		if (slot) {
			slot.hidden = true;
			slot.replaceChildren();
		}
		placeTopicHeader(true);
		placeArchiveHeader(true);
	}
}

/** Leaving the space (another kind of page, or no page): rail and topic stop following. */
function leaveSpace(): void {
	leaveTools();
	hideRail();
	suspendTopic();
	suspendArchive();
	railEl.remove();
	railSlot.replaceChildren();
	topicHeader.remove();
	archiveHeader.remove();
	document.body.classList.remove("project-space-on", "ps-on-topic", "ps-gone");
	const slot = document.getElementById("header-project");
	if (
		slot &&
		(slot.contains(railHead) || slot.contains(topicHeader) || slot.contains(archiveHeader))
	) {
		slot.hidden = true;
		slot.replaceChildren();
	}
	shownTopic = null;
	shownArchive = null;
}

/** "+" of Conversaciones (and the space's own button): a new topic, then into it. */
async function newConversationFlow(pid: string): Promise<void> {
	const c = await newTopicDialog(pid);
	if (c && shown === pid)
		navigateProject({ projectId: pid, page: "conversation", conversationId: c.id });
}

function hidePage(): void {
	leaveTools();
	if (shown === null && pageEl?.hidden !== false) return;
	if (shownPage !== null) leaveSpace();
	shown = null;
	shownPage = null;
	document.body.classList.remove("project-page-on");
	if (pageEl) {
		pageEl.hidden = true;
		pageEl.inert = false;
		pageEl.replaceChildren();
	}
	setTitlePage(null);
	renderSection();
}

/**
 * A session row picked while the page is up — the active session's too, which
 * would not change the address on its own: the page gives way to it (Back
 * returns to the page). The page itself has no control that does this.
 */
function leaveForSession(): void {
	if (shown === null) return;
	pushSessionAddress();
	sync();
}

async function archiveFlow(pid: string, name: string): Promise<void> {
	const ok = await confirmDialog({
		title: `Archivar ${name}`,
		message:
			"Deja de aparecer en la lista y no se puede deshacer desde la app. Sus agentes quedan sin proyecto; sus sesiones y su contexto no cambian.",
		confirmLabel: "Archivar",
	}).catch(() => false);
	if (!ok) return;
	const r = await archiveProject(pid);
	if (!r.ok) {
		showToast(`No se pudo archivar (${r.code})`, true);
		return;
	}
	await readAcpAgents();
	await loadProjects();
}

// ── Rename ──────────────────────────────────────────────────────────────────

function nameProblem(v: string): string | null {
	return v.trim() === ""
		? "Poné un nombre"
		: [...v.trim()].length > PROJECT_NAME_MAX
			? `Hasta ${PROJECT_NAME_MAX} caracteres`
			: null;
}

async function renameFlow(pid: string, current: string): Promise<void> {
	const myGen = gen;
	let renamed: ProjectSummary | null = null;
	await promptDialog({
		title: "Renombrar proyecto",
		label: "Nombre",
		initialValue: current,
		confirmLabel: "Renombrar",
		validate: nameProblem,
		onConfirm: async (v) => {
			const r = await renameProject(pid, v.trim());
			if (r.ok) {
				renamed = r.body;
				return null;
			}
			return r.code === "network"
				? "No se pudo conectar. Volvé a intentar."
				: r.code === "project-not-found"
					? "El proyecto ya no existe o fue archivado."
					: r.code === "invalid-name" || r.code === "invalid-body"
						? `Nombre inválido: 1–${PROJECT_NAME_MAX} caracteres, sin caracteres de control.`
						: `No se pudo renombrar (${r.code || r.status}).`;
		},
	});
	const done = renamed as ProjectSummary | null;
	// An answer for a previous account changes nothing; for this one, the
	// project's entry is updated wherever it is shown (header only if it is
	// still the page on screen).
	if (!done || myGen !== gen || !active) return;
	const list = projects();
	if (!list.some((p) => p.projectId === pid)) return;
	if (
		setProjects(list.map((p) => (p.projectId === pid ? { ...p, ...done } : p))) &&
		sessionListLoaded()
	)
		renderSessionList();
	renderSection();
	paintSpace();
	repaintRail();
	showToast("Proyecto renombrado");
}

// ── New project ─────────────────────────────────────────────────────────────

async function openCreateProjectDialog(): Promise<void> {
	// One id per dialog: a retry after an unknown outcome is the same request.
	const clientRequestId = crypto.randomUUID();
	let created: string | null = null;
	const name = await promptDialog({
		title: "Nuevo proyecto",
		label: "Nombre",
		confirmLabel: "Crear",
		validate: nameProblem,
		onConfirm: async (v) => {
			const r = await createProject(v.trim(), clientRequestId);
			if (r.ok) {
				created = r.body.projectId;
				return null;
			}
			return r.code === "outcome-unknown" || r.code === "network"
				? "No se pudo confirmar. Volvé a intentar: no se duplica."
				: r.code === "project-limit"
					? "Llegaste al límite de proyectos."
					: `No se pudo crear (${r.code}).`;
		},
	});
	if (name === null || created === null) return;
	await loadProjects();
	navigateProject({ projectId: created });
}

// ── Lifecycle (main.ts) ─────────────────────────────────────────────────────

let wired = false;

function wire(): void {
	if (wired) return;
	wired = true;
	window.addEventListener("popstate", () => sync());
	window.addEventListener("hashchange", () => sync());
	window.addEventListener("st:projects-changed", () => void loadProjects());
	onAddressWrite(() => sync());
	onRailChange(() => {
		paintSpace();
		openTopicIfWide();
	});
	configureRail({
		newProject: () => void openCreateProjectDialog(),
		renameProject: (pid) => void renameFlow(pid, projectName(pid) ?? ""),
		archiveProject: (pid) => void archiveFlow(pid, projectName(pid) ?? "este proyecto"),
		newConversation: (pid) => void newConversationFlow(pid),
		newAgent: (pid, opener) =>
			window.dispatchEvent(
				new CustomEvent("st:new-acp-session", { detail: { projectId: pid, opener } }),
			),
		// Sessions: on a phone the drawer (the page stays under it); wider,
		// the page gives way to the session underneath (Back returns).
		sessions: (opener) => {
			if (phoneMq?.matches)
				window.dispatchEvent(new CustomEvent("st:open-sidebar", { detail: { opener } }));
			else leaveForSession();
		},
		settings: (opener) =>
			window.dispatchEvent(new CustomEvent("st:open-user-menu", { detail: { opener } })),
		agentMenu: (name, opener) => openAgentMenu(name, opener),
		openWork: (w) => openTools({ agent: w.agent, work: w.id, tool: "git" }),
		openInbox: (opener) => openInbox(opener),
	});
	// Pendientes and «Revisar interrupción» lead into a topic, or into the
	// Archive's chat the message belongs to: the previous Project Chat, or the
	// direct messages of an agent — listed in its project's Archive.
	configureInbox({
		titleOf: topicTitle,
		goTo: (t, opts) => {
			if (t.conversationId && t.projectId)
				revealInTopic(t.projectId, t.conversationId, t.id, opts.result);
			else {
				const where = archiveOf(t.projectId, t.agent);
				if (where) revealInArchive(where.projectId, where.key, t.id, opts.result);
				else noProjectToast(t.agent);
			}
		},
		canGo: (t) => Boolean(t.conversationId || archiveOf(t.projectId, t.agent)),
	});
	configureReview({
		writeNew: (m) => {
			if (m.conversation_id && m.project_id) writeInTopic(m.project_id, m.conversation_id, m.to_id);
			else {
				// Out of a topic: a new one, in the project it belongs to.
				const pid = archiveOf(m.project_id ?? null, m.to_id)?.projectId;
				if (pid) void newTopicWith(pid, m.to_id);
				else noProjectToast(m.to_id);
			}
		},
		tools: (agent, tool) => openTools({ agent, work: null, tool }),
	});
	const work = (agent: string, w: string) => openTools({ agent, work: w, tool: "git" });
	onTopicWork(work);
	onArchiveWork(work);
	mountInboxButton();
	newProjectBtn?.addEventListener("click", () => void openCreateProjectDialog());
	// A session row or the session bar used while the page is up: the page
	// gives way to the session (and Back returns to it).
	for (const id of ["session-list", "terminal-toolbar"]) {
		document.getElementById(id)?.addEventListener(
			"click",
			(e) => {
				if (shown === null) return;
				// Herramientas IS the session bar's page: its controls stay in it.
				if (id === "terminal-toolbar" && shownPage === "tools") return;
				const t = e.target;
				if (t instanceof Element && t.closest(".session-actions")) return;
				leaveForSession();
			},
			true,
		);
	}
}

/**
 * The Archive chat a message out of any topic is read in: the previous
 * Project Chat of its project, or the direct messages of `agent` in the
 * Archive of the project the agent is in now (none: no Archive shows them).
 */
function archiveOf(
	projectId: string | null,
	agent: string,
): { projectId: string; key: string } | null {
	if (projectId) return { projectId, key: "project" };
	const p = acpEntryByName(agent)?.projectId;
	return p ? { projectId: p, key: `@${agent}` } : null;
}

function noProjectToast(agent: string): void {
	showToast(
		`@${agent} no está en ningún proyecto: asignale uno desde «Ajustes del agente» (⋯ de su sesión).`,
		true,
	);
}

/** «Escribirle un mensaje nuevo» from the Archive: a new topic of `pid`, `agent` its recipient. */
async function newTopicWith(pid: string, agent: string): Promise<void> {
	const c = await newTopicDialog(pid);
	if (c) writeInTopic(pid, c.id, agent);
}

/** The app is shown for a signed-in account. */
export function startProjects(): void {
	wire();
	active = true;
	enableProjectRoutes(() => shown !== null && readProjectRoute() !== null);
	renderSection();
	void loadProjects();
	void readAcpAgents();
	startInbox();
	sync();
	if (pollTimer) clearInterval(pollTimer);
	pollTimer = setInterval(() => {
		if (active && isLoggedIn() && document.visibilityState === "visible") void loadProjects();
	}, PROJECTS_REFRESH_MS);
}

/** Logout / expiry: nothing of this account stays on screen or in memory. */
export function resetProjects(): void {
	gen++;
	stopAcpStatusFeed();
	resetAcpAgents();
	active = false;
	if (pollTimer) clearInterval(pollTimer);
	pollTimer = null;
	disableProjectRoutes();
	clearProjects();
	resetRail();
	resetTopic();
	resetArchive();
	resetTools();
	resetInboxPanel();
	resetInbox();
	loadError = false;
	canCreate = true;
	hidePage();
	renderSection();
}
