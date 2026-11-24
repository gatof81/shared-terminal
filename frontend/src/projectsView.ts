/**
 * projectsView.ts — Projects: the sidebar's Projects section (its "+"), the
 * project's pages and the new-project dialog. A project groups ACP agents
 * and gives them topics; each agent keeps its own session.
 *
 *   #/projects/<pid>          the project: its rail (projectRail.ts) — in the
 *                             sidebar on a wide screen, the whole screen on a phone
 *   #/projects/<pid>/c/<cid>  a topic (acpConversation.ts), the rail beside it
 *   #/projects/<pid>/chat     the previous Project Chat (acpProjectChat.ts),
 *                             reached from the rail's Archive until F5
 *
 * The page is shown OVER the session workbench, never instead of it: the
 * terminal area's other children only turn `visibility: hidden` (layout
 * kept), so the terminal is neither resized nor detached and its socket
 * stays open (the terminal invariant, viewSwitch.ts).
 */

import {
	placeTopicHeader,
	refusal,
	resetTopic,
	suspendTopic,
	topicHeader,
	topicPage,
} from "./acpConversation.js";
import {
	acpProjectPage,
	onProjectFeed,
	type ProjectPageMode,
	projectFeed,
	refreshAcpAgents,
	resetAcpProject,
	retryProjectFeed,
	setProjectPageMode,
	suspendAcpProject,
} from "./acpProjectChat.js";
import { resetAcpAgents } from "./acpRegistry.js";
import { stopAcpStatusFeed } from "./acpStatusFeed.js";
import type { FeedStatus } from "./acpThread.js";
import {
	acpCreateConversation,
	archiveProject,
	createProject,
	fetchProjects,
	isLoggedIn,
	type ProjectSummary,
	renameProject,
} from "./api.js";
import { openActionMenu } from "./components/actionMenu.js";
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
	patchConversation,
	railBody,
	railHead,
	repaintRail,
	resetRail,
	showRail,
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
let gen = 0; // bumped by every reset (logout): a load started before applies nothing
let loadError = false;
let canCreate = true;
let pollTimer: ReturnType<typeof setInterval> | null = null;

// ── The shown project's state ───────────────────────────────────────────────
// Active, archived, not found or failed — decided from the project's feed AND
// the project list, never from "not in the list" alone: the feed carries no
// `archived` flag (an archived project's feed still answers 200, and this
// frontend-only change does not touch the backend), so ARCHIVED is concluded
// only from a feed that answered plus a list that was fetched successfully,
// in this auth generation, AFTER the absence was noticed, and still lacks it.
// Until then — and on any error — the page stays locked (fail-closed).
type PageState = "loading" | "active" | "archived" | "missing" | "error";
let pageState: PageState = "loading";
let feedStatus: FeedStatus = "loading";
let feedName: string | null = null;
let absentConfirmed: string | null = null; // the pid a post-absence list confirmed absent
let confirming: string | null = null;
let confirmFailed = false;

const MODE: Record<PageState, ProjectPageMode> = {
	loading: "loading",
	active: "active",
	archived: "archived",
	missing: "unavailable",
	error: "unavailable",
};

function evaluate(): void {
	const pid = shown;
	if (!pid || shownPage !== "chat") return;
	let next: PageState;
	if (feedStatus === "loading") next = "loading";
	else if (feedStatus === "not-found") next = "missing";
	else if (feedStatus === "error" || feedStatus === "stale") next = "error";
	else if (projectName(pid) !== null) next = "active";
	else if (absentConfirmed === pid) next = "archived";
	else if (confirmFailed) next = "error";
	else {
		next = "loading";
		void confirmAbsence(pid);
	}
	pageState = next;
	// The history stays readable (box locked) when it was read once and only a
	// re-read or the list check failed; only a project never read is hidden.
	const readable = feedStatus === "ok" || feedStatus === "stale";
	setProjectPageMode(
		next === "error" && readable ? (absentConfirmed === pid ? "archived" : "loading") : MODE[next],
	);
	renderPage();
}

/** The feed answered but the list lacks the project: ask for the list once more before concluding. */
async function confirmAbsence(pid: string): Promise<void> {
	if (confirming === pid) return;
	confirming = pid;
	const myGen = gen;
	const a = await fetchProjects().catch(() => null);
	if (confirming === pid) confirming = null;
	if (myGen !== gen || !active || shown !== pid || (a && !a.ok && a.code === "stale")) return;
	if (a?.ok) {
		loadError = false;
		canCreate = a.body.can.createProject.allowed;
		if (setProjects(a.body.projects) && sessionListLoaded()) renderSessionList();
		if (!a.body.projects.some((p) => p.projectId === pid)) absentConfirmed = pid;
	} else confirmFailed = true;
	renderSection();
	evaluate();
}

function onFeed(pid: string, feed: FeedStatus, name: string | null): void {
	if (pid !== shown) return;
	if (feed === feedStatus && name === feedName) return;
	feedStatus = feed;
	feedName = name;
	evaluate();
}

function retryPage(): void {
	confirmFailed = false;
	if (feedStatus !== "ok") retryProjectFeed();
	evaluate();
}

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
	if (shown) evaluate();
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
				"Sin proyectos. Un proyecto agrupa agentes ACP y les da un Project Chat.",
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
	const page = r.page ?? "home";
	const prevPid = shown;
	const prevPage = shownPage;
	// Leaving one kind of page for the other: the one left stops following.
	if (prevPage === "chat" && page !== "chat") {
		suspendAcpProject();
		headerFor = null;
	}
	if (prevPage !== null && prevPage !== "chat" && page === "chat") leaveSpace();
	if (page === "chat") syncChat(r.projectId, prevPid !== r.projectId || prevPage !== "chat");
	else syncSpace(r, prevPid, prevPage);
	renderSection();
}

/** The previous Project Chat (its own page until F5). */
function syncChat(pid: string, changed: boolean): void {
	shown = pid;
	shownPage = "chat";
	shownTopic = null;
	if (changed) {
		pageState = "loading";
		absentConfirmed = null;
		confirming = null;
		confirmFailed = false;
	}
	if (!pageEl) return;
	showPageEl();
	renderPage();
	if (changed) {
		const f = projectFeed(pid);
		feedStatus = f.feed;
		feedName = f.name;
		evaluate();
		pageEl.querySelector<HTMLElement>(".pv-title")?.focus({ preventScroll: true });
		if (!projectsLoaded()) void loadProjects();
	}
}

function showPageEl(): void {
	if (!pageEl) return;
	document.body.classList.add("project-page-on");
	pageEl.hidden = false;
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
const homeNew = button("Nueva conversación", "btn primary sm", () => {
	if (shown) void newConversationFlow(shown);
});
homeEl.append(homeTitle, homeNote, homeNew);
const phoneMq = typeof window !== "undefined" ? window.matchMedia?.("(max-width: 768px)") : null;
phoneMq?.addEventListener?.("change", () => placeSpace());

function syncSpace(r: ProjectRoute, prevPid: string | null, prevPage: ProjectPage | null): void {
	const page = r.page === "conversation" ? "conversation" : "home";
	const topic = page === "conversation" ? (r.conversationId ?? null) : null;
	const topicChanged = topic !== shownTopic || prevPid !== r.projectId;
	shown = r.projectId;
	shownPage = page;
	shownTopic = topic;
	if (!pageEl) return;
	showPageEl();
	document.body.classList.add("project-space-on");
	document.body.classList.toggle("ps-on-topic", topic !== null);
	showRail(r.projectId, topic);
	if (topic) {
		// From the rail (a phone's project screen, or the sidebar) by a tap,
		// not Back / Forward: ‹ is then the browser's Back.
		const opener =
			prevPid === r.projectId && prevPage === "home" && !fromHistory() ? "rail" : "other";
		mainSlot.replaceChildren(topicPage(r.projectId, topic, opener));
	} else {
		suspendTopic();
		mainSlot.replaceChildren(homeEl);
	}
	if (pageEl.firstChild !== spaceEl || pageEl.childNodes.length !== 1)
		pageEl.replaceChildren(spaceEl);
	placeSpace();
	paintSpace();
	if (topicChanged || prevPage !== page) {
		// The page's heading, for a screen reader (a phone's project screen has
		// none of its own: the rail's head is the app's header there).
		const target = topic ? topicHeader.querySelector<HTMLElement>(".pv-title") : homeTitle;
		if (target?.offsetParent) target.focus({ preventScroll: true });
		if (!projectsLoaded()) void loadProjects();
	}
}

/** What the space says about the project itself, and the tab's title. */
function paintSpace(): void {
	if (!shown || shownPage === null || shownPage === "chat") return;
	const name = projectName(shown);
	const gone = projectsLoaded() && name === null;
	homeTitle.textContent = gone ? "Proyecto no encontrado" : "Elegí una conversación";
	homeNote.textContent = gone
		? "No existe o fue archivado. El historial de un proyecto archivado se lee en su Project Chat anterior."
		: "Elegí un tema del panel, o empezá uno nuevo: cada tema es una conversación con el equipo del proyecto.";
	homeNew.hidden = gone;
	// Nothing of a rail for a project that is not there: the sidebar keeps its
	// sessions, and a phone shows this line instead of an empty project screen.
	document.body.classList.toggle("ps-gone", gone);
	// A topic's title is its own page's (acpConversation.paint).
	if (!shownTopic) setTitlePage(name ?? "Proyecto");
}

function placeSpace(): void {
	const slot = document.getElementById("header-project");
	const sidebar = document.getElementById("sidebar");
	if (!shown || shownPage === null || shownPage === "chat") return;
	if (phoneMq?.matches) {
		railEl.remove();
		railSlot.replaceChildren(railBody);
		if (slot) {
			slot.replaceChildren(shownTopic ? topicHeader : railHead);
			slot.hidden = false;
		}
		placeTopicHeader(false);
	} else {
		railSlot.replaceChildren();
		if (railEl.firstChild !== railHead) railEl.replaceChildren(railHead, railBody);
		if (sidebar && railEl.parentElement !== sidebar) sidebar.prepend(railEl);
		if (slot) {
			slot.hidden = true;
			slot.replaceChildren();
		}
		placeTopicHeader(true);
	}
}

/** Leaving the space (another kind of page, or no page): rail and topic stop following. */
function leaveSpace(): void {
	hideRail();
	suspendTopic();
	railEl.remove();
	railSlot.replaceChildren();
	topicHeader.remove();
	document.body.classList.remove("project-space-on", "ps-on-topic", "ps-gone");
	const slot = document.getElementById("header-project");
	if (slot && (slot.contains(railHead) || slot.contains(topicHeader))) {
		slot.hidden = true;
		slot.replaceChildren();
	}
	shownTopic = null;
}

/** "+" of Conversaciones (and the space's own button): a new topic, then into it. */
async function newConversationFlow(pid: string): Promise<void> {
	// One id per dialog: a retry after an unknown outcome is the same topic.
	const clientRequestId = crypto.randomUUID();
	let created: { id: string } | null = null;
	await promptDialog({
		title: "Nueva conversación",
		label: "Título",
		confirmLabel: "Crear",
		validate: (v) =>
			v.trim() === ""
				? "Poné un título"
				: [...v.trim()].length > 120
					? "Hasta 120 caracteres"
					: null,
		onConfirm: async (v) => {
			try {
				const c = await acpCreateConversation(pid, v.trim(), clientRequestId);
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
	const c = created as { id: string } | null;
	if (c && shown === pid)
		navigateProject({ projectId: pid, page: "conversation", conversationId: c.id });
}

function hidePage(): void {
	if (shown === null && pageEl?.hidden !== false) return;
	if (shownPage === "chat") suspendAcpProject();
	else if (shownPage !== null) leaveSpace();
	shown = null;
	shownPage = null;
	document.body.classList.remove("project-page-on");
	if (pageEl) {
		pageEl.hidden = true;
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

let headerFor: { key: string; el: HTMLElement } | null = null;
function header(pid: string, name: string | null, st: PageState): HTMLElement {
	const key = JSON.stringify([pid, name, st]);
	if (headerFor?.key === key) return headerFor.el;
	const h = el("div", "pv-header");
	const title = el("h2", "pv-title", name ?? "Proyecto");
	title.id = "pv-title";
	title.tabIndex = -1;
	const tools = el("div", "pv-tools");
	// Writes only on a project confirmed live (fail-closed: see evaluate).
	// One row: the title, the agents' group (acpProjectChat) and a ⋯ menu
	// (the app's action menu: Escape, focus back to the button, arrows). No
	// ×: the way out is the sidebar (☰ on a phone) or Back (U-2 N1/N2).
	if (st === "active") {
		const menu = button(
			"⋯",
			"btn btn-icon pv-menu-btn",
			() =>
				openActionMenu({
					title: name ?? "Proyecto",
					opener: menu,
					items: [
						{ id: "rename", label: "Renombrar" },
						{
							id: "archive",
							label: "Archivar",
							kind: "danger",
							hint: "No se puede deshacer desde la app; el historial sigue legible.",
						},
					],
					onPick: (id) => {
						if (id === "rename") void renameFlow(pid, name ?? "");
						else if (id === "archive") void archiveFlow(pid, name ?? "este proyecto");
					},
				}),
			"Acciones del proyecto",
		);
		menu.setAttribute("aria-haspopup", "menu");
		tools.append(menu);
	}
	h.append(title, tools);
	headerFor = { key, el: h };
	return h;
}

let noteCache: { key: string; el: HTMLElement | null } | null = null;
/** The state line, kept across re-renders while the state is the same. */
function noteFor(st: PageState): HTMLElement | null {
	const key = `${st}:${feedStatus}`;
	if (noteCache?.key !== key) noteCache = { key, el: statusNote(st) };
	return noteCache.el;
}

function statusNote(st: PageState): HTMLElement | null {
	if (st === "archived")
		return el("p", "pv-status pv-status-archived", "Proyecto archivado · solo lectura");
	if (st === "missing") return el("p", "pv-status pv-status-error", "Proyecto no encontrado.");
	if (st !== "error") return null;
	const p = el("p", "pv-status pv-status-error");
	p.setAttribute("role", "alert");
	p.append(
		feedStatus === "ok"
			? "No se pudo confirmar el estado del proyecto. "
			: feedStatus === "stale"
				? "No se pudo actualizar el proyecto. "
				: "No se pudo cargar el proyecto. ",
		button("Reintentar", "pv-btn", retryPage),
	);
	return p;
}

function renderPage(): void {
	if (shownPage !== "chat") {
		paintSpace();
		return;
	}
	if (!pageEl || !shown) return;
	// The live list's name first (a rename lands there); the feed's for an archived one.
	const name = projectName(shown) ?? (pageState === "missing" ? null : feedName);
	setTitlePage(name ?? "Proyecto");
	const page = acpProjectPage(shown, header(shown, name, pageState), noteFor(pageState));
	if (pageEl.childNodes.length !== 1 || pageEl.firstChild !== page) pageEl.replaceChildren(page);
}

async function archiveFlow(pid: string, name: string): Promise<void> {
	const ok = await confirmDialog({
		title: `Archivar ${name}`,
		message:
			"Deja de aparecer en la lista y no se puede deshacer desde la app. Sus agentes quedan sin proyecto; sus sesiones y su contexto no cambian. El historial sigue legible en el chat de cada agente y en la URL de este proyecto (solo lectura).",
		confirmLabel: "Archivar",
	}).catch(() => false);
	if (!ok) return;
	const r = await archiveProject(pid);
	if (!r.ok) {
		showToast(`No se pudo archivar (${r.code})`, true);
		return;
	}
	await refreshAcpAgents();
	// The page stays, archived and read-only, at the same address (U-2 N4).
	await loadProjects();
	if (shown === pid) evaluate();
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
	if (shown === pid) evaluate();
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
	onProjectFeed(onFeed);
	onAddressWrite(() => sync());
	onRailChange(() => paintSpace());
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
	});
	newProjectBtn?.addEventListener("click", () => void openCreateProjectDialog());
	// A session row or the session bar used while the page is up: the page
	// gives way to the session (and Back returns to it).
	for (const id of ["session-list", "terminal-toolbar"]) {
		document.getElementById(id)?.addEventListener(
			"click",
			(e) => {
				if (shown === null) return;
				const t = e.target;
				if (t instanceof Element && t.closest(".session-actions")) return;
				leaveForSession();
			},
			true,
		);
	}
}

/** The app is shown for a signed-in account. */
export function startProjects(): void {
	wire();
	active = true;
	enableProjectRoutes(() => shown !== null && readProjectRoute() !== null);
	renderSection();
	void loadProjects();
	void refreshAcpAgents();
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
	resetAcpProject();
	resetRail();
	resetTopic();
	loadError = false;
	canCreate = true;
	headerFor = null;
	pageState = "loading";
	feedStatus = "loading";
	feedName = null;
	absentConfirmed = null;
	confirming = null;
	confirmFailed = false;
	hidePage();
	renderSection();
}
