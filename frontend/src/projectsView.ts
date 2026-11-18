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
	refreshAcpAgents,
	resetAcpProject,
	suspendAcpProject,
} from "./acpProjectChat.js";
import {
	archiveProject,
	createProject,
	fetchProjects,
	isLoggedIn,
	projectChatEnabled,
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
	if (shown) renderPage();
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

let headerFor: { pid: string; name: string | null; el: HTMLElement } | null = null;
function header(pid: string, name: string | null): HTMLElement {
	if (headerFor?.pid === pid && headerFor.name === name) return headerFor.el;
	const h = el("div", "pv-header");
	const title = el("h2", "pv-title", name ?? "Proyecto");
	title.id = "pv-title";
	title.tabIndex = -1;
	const tools = el("div", "pv-tools");
	const archive = button(
		"Archivar",
		"pv-btn",
		() => void archiveFlow(pid, name ?? "este proyecto"),
	);
	archive.title =
		"El proyecto deja de mostrarse; sus agentes quedan sin proyecto (conservan sesión e historial).";
	const close = button("×", "pv-close", leavePage, "Cerrar el proyecto");
	tools.append(archive, close);
	h.append(title, tools);
	headerFor = { pid, name, el: h };
	return h;
}

function renderPage(): void {
	if (!pageEl || !shown) return;
	const name = projectName(shown);
	setTitlePage(name ?? "Proyecto");
	const page = acpProjectPage(shown, header(shown, name), null);
	if (pageEl.childNodes.length !== 1 || pageEl.firstChild !== page) pageEl.replaceChildren(page);
}

async function archiveFlow(pid: string, name: string): Promise<void> {
	const ok = await confirmDialog({
		title: `Archivar ${name}`,
		message:
			"Deja de aparecer en la lista. Sus agentes quedan sin proyecto; sus sesiones, contexto e historial no cambian.",
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

// ── New project ─────────────────────────────────────────────────────────────

export async function openCreateProjectDialog(): Promise<void> {
	// One id per dialog: a retry after an unknown outcome is the same request.
	const clientRequestId = crypto.randomUUID();
	let created: string | null = null;
	const name = await promptDialog({
		title: "Nuevo proyecto",
		label: "Nombre",
		confirmLabel: "Crear",
		validate: (v) =>
			v.trim() === ""
				? "Poné un nombre"
				: [...v.trim()].length > PROJECT_NAME_MAX
					? `Hasta ${PROJECT_NAME_MAX} caracteres`
					: null,
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
	hidePage();
	renderSection();
}
