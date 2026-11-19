/**
 * projectsView.ts — Projects: the sidebar's Projects section (its "+"), the
 * project page (`#/projects/<pid>`: ACP Project Chat, acpProjectChat.ts) and
 * the new-project dialog. A project only groups ACP agents and gives them a
 * shared conversation; each agent keeps its own session.
 *
 * Nothing here exists unless `/auth/status` reported `features.projectChat`.
 *
 * The page is shown OVER the session workbench, never instead of it: the
 * terminal area's other children only turn `visibility: hidden` (layout
 * kept), so the terminal is neither resized nor detached and its socket
 * stays open (the terminal invariant, viewSwitch.ts).
 */

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
import type { FeedStatus } from "./acpThread.js";
import {
	archiveProject,
	createProject,
	fetchProjects,
	isLoggedIn,
	type ProjectSummary,
	projectChatEnabled,
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
	disableProjectRoutes,
	enableProjectRoutes,
	navigateProject,
	onAddressWrite,
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

let active = false; // feature on + signed in + app shown
let shown: string | null = null; // the project id on screen
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
	if (!pid) return;
	let next: PageState;
	if (feedStatus === "loading") next = "loading";
	else if (feedStatus === "not-found") next = "missing";
	else if (feedStatus === "error") next = "error";
	else if (projectName(pid) !== null) next = "active";
	else if (absentConfirmed === pid) next = "archived";
	else if (confirmFailed) next = "error";
	else {
		next = "loading";
		void confirmAbsence(pid);
	}
	pageState = next;
	// The history stays readable when only the list check failed.
	setProjectPageMode(next === "error" && feedStatus === "ok" ? "loading" : MODE[next]);
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
	const changed = shown !== r.projectId;
	shown = r.projectId;
	if (changed) {
		pageState = "loading";
		absentConfirmed = null;
		confirming = null;
		confirmFailed = false;
	}
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
	renderPage();
	if (changed) {
		const f = projectFeed(r.projectId);
		feedStatus = f.feed;
		feedName = f.name;
		evaluate();
	}
	renderSection();
	if (changed) {
		pageEl.querySelector<HTMLElement>(".pv-title")?.focus({ preventScroll: true });
		if (!projectsLoaded()) void loadProjects();
	}
}

function hidePage(): void {
	if (shown === null && pageEl?.hidden !== false) return;
	shown = null;
	suspendAcpProject();
	document.body.classList.remove("project-page-on");
	if (pageEl) {
		pageEl.hidden = true;
		pageEl.replaceChildren();
	}
	setTitlePage(null);
	renderSection();
}

/** Leave the page for the session underneath (Back returns to the page). */
function leavePage(): void {
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
	if (st === "active") {
		const rename = button("Renombrar", "pv-btn", () => void renameFlow(pid, name ?? ""));
		const archive = button(
			"Archivar",
			"pv-btn",
			() => void archiveFlow(pid, name ?? "este proyecto"),
		);
		archive.title =
			"Deja de mostrarse y no se puede deshacer desde la app; sus agentes quedan sin proyecto. El historial sigue legible en el chat de cada agente y en la URL del proyecto.";
		tools.append(rename, archive);
	}
	const close = button("×", "pv-close", leavePage, "Cerrar el proyecto");
	tools.append(close);
	h.append(title, tools);
	const note = statusNote(st);
	if (note) h.append(note);
	headerFor = { key, el: h };
	return h;
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
			: "No se pudo cargar el proyecto. ",
		button("Reintentar", "pv-btn", retryPage),
	);
	return p;
}

function renderPage(): void {
	if (!pageEl || !shown) return;
	// The live list's name first (a rename lands there); the feed's for an archived one.
	const name = projectName(shown) ?? (pageState === "missing" ? null : feedName);
	setTitlePage(name ?? "Proyecto");
	const page = acpProjectPage(shown, header(shown, name, pageState));
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
	if (shown === pid) leavePage();
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
	if (shown === pid) evaluate();
	showToast("Proyecto renombrado");
}

// ── New project ─────────────────────────────────────────────────────────────

export async function openCreateProjectDialog(): Promise<void> {
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
				leavePage();
			},
			true,
		);
	}
}

/** The app is shown for a signed-in account. With the feature absent this does nothing. */
export function startProjects(): void {
	if (!projectChatEnabled()) return;
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
	active = false;
	if (pollTimer) clearInterval(pollTimer);
	pollTimer = null;
	disableProjectRoutes();
	clearProjects();
	resetAcpProject();
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
