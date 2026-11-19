// acpProjectChat.ts — ACP Project Chat (experimental, `features.acpAgents`),
// the project page (`#/projects/<pid>`).
//
// A project only groups agents and gives them a shared conversation: each
// agent keeps its own session (environment, repository, terminal, ACP
// context). What is posted here is visible here; a direct message to an agent
// (its individual chat) never is. Same API, store and delivery as the
// individual chat — the thread component is shared (acpThread.ts).

import { agentStatus } from "./acpModel.js";
import { setAcpAgents } from "./acpRegistry.js";
import { AcpThread, type FeedStatus, type ThreadState } from "./acpThread.js";
import { type AcpAgentInfo, acpListAgents, acpSetProject } from "./api.js";
import { confirmDialog } from "./components/dialog.js";
import { showToast } from "./components/toast.js";
import { routeHash } from "./router.js";
import { el, syncChildren } from "./ui.js";

const root = el("div", "pv-page acp-project");
const barEl = el("div", "acp-project-agents");
const thread = new AcpThread();
let headerEl: HTMLElement | null = null;
let shownPid: string | null = null;
let others: AcpAgentInfo[] = [];
let state: ThreadState | null = null;
/**
 * What the page allows (projectsView decides, from the feed and the project
 * list): `active` is the only mode with a message box and agent tools —
 * fail-closed while loading, on an error, or for an archived project.
 * `unavailable` (not found / failed) shows no thread at all.
 */
export type ProjectPageMode = "active" | "loading" | "archived" | "unavailable";
let mode: ProjectPageMode = "loading";
let feedListener: ((pid: string, feed: FeedStatus, name: string | null) => void) | null = null;
root.setAttribute("role", "region");
root.setAttribute("aria-labelledby", "pv-title");
thread.onState = (s) => {
	state = s;
	renderBar();
	if (shownPid) feedListener?.(shownPid, s.feed, s.project?.name ?? null);
};

/** projectsView: told of every change of the page's feed (status, project name). */
export function onProjectFeed(
	fn: (pid: string, feed: FeedStatus, name: string | null) => void,
): void {
	feedListener = fn;
}

export function setProjectPageMode(next: ProjectPageMode): void {
	if (next === mode) return;
	mode = next;
	thread.setComposer(mode === "active" ? "on" : mode === "loading" ? "disabled" : "off");
	thread.root.hidden = mode === "unavailable";
	barEl.hidden = mode === "unavailable";
	renderBar();
}

/** The page's feed as last known (a project shown again needs no new read). */
export function projectFeed(pid: string): { feed: FeedStatus; name: string | null } {
	if (shownPid !== pid || !state) return { feed: "loading", name: null };
	return { feed: state.feed, name: state.project?.name ?? null };
}

/** "Reintentar": read the project's feed again. */
export function retryProjectFeed(): void {
	thread.retry();
}

/** ACP agents of the owner, by project (refreshed by the page and by changes). */
let allAgents: AcpAgentInfo[] = [];
let allLoaded = false;

export async function refreshAcpAgents(): Promise<AcpAgentInfo[]> {
	try {
		allAgents = await acpListAgents();
		allLoaded = true;
		setAcpAgents(allAgents);
	} catch {
		/* keep */
	}
	return allAgents;
}

/** Does the project have ACP agents (as last known)? Null while unknown. */
export function projectHasAcpAgents(pid: string): boolean | null {
	return allLoaded ? allAgents.some((a) => a.projectId === pid) : null;
}

/**
 * The page element for project `pid` (one element, kept across the project
 * page's re-renders so the draft, scroll and live socket survive).
 * `header`: the page header built by projectsView.
 */
export function acpProjectPage(pid: string, header: HTMLElement): HTMLElement {
	if (headerEl !== header) {
		headerEl = header;
		root.replaceChildren(header, barEl, thread.root);
	}
	if (shownPid !== pid) {
		shownPid = pid;
		state = null;
		mode = "loading";
		thread.setComposer("disabled");
		thread.root.hidden = false;
		barEl.hidden = false;
		void refreshAcpAgents().then(() => {
			others = allAgents;
			renderBar();
		});
	}
	thread.open({ kind: "project", projectId: pid });
	state = thread.state;
	renderBar();
	return root;
}

/** Off screen: stop following live (state kept for a quick return). */
export function suspendAcpProject(): void {
	thread.close();
}

export function resetAcpProject(): void {
	thread.close();
	shownPid = null;
	headerEl = null;
	allAgents = [];
	allLoaded = false;
}

// ── Agents bar ───────────────────────────────────────────────────────────

// Rebuilt on every thread change (activity, the 15 s status poll): each part
// only when what it shows changed, so an agent picked in "Agregar agente
// existente…" (not added yet) or the focus on a chip's × survives.
let chipsEl: HTMLElement | null = null;
let chipsKey = "";
let toolsEl: HTMLElement | null = null;
let toolsKey = "";
const helpEl = el("p", "acp-project-help");

function renderBar(): void {
	const pid = shownPid;
	if (!pid) return;
	const members = state?.agents ?? allAgents.filter((a) => a.projectId === pid);
	const now = Date.now();
	const statuses = members.map((a) => ({
		a,
		st: agentStatus(a, now, state?.auth.get(a.name) === true),
	}));
	const active = mode === "active";
	const ck = JSON.stringify([
		pid,
		active,
		statuses.map(({ a, st }) => [a.name, a.sessionId, st.label, st.tone]),
	]);
	if (ck !== chipsKey || !chipsEl) {
		chipsKey = ck;
		chipsEl = el("ul", "acp-agent-chips");
		chipsEl.setAttribute("aria-label", "Agentes del proyecto");
		for (const { a, st } of statuses) {
			const li = el("li", `acp-agent-chip acp-tone-${st.tone}`);
			const link = el("a", "acp-agent-name", `@${a.name}`);
			link.href = routeHash({ sessionId: a.sessionId, view: "chat", detail: null });
			link.title = "Abrir su sesión (Chat individual, Terminal, Files, Git)";
			const remove = el("button", "acp-chip-remove", "×");
			remove.type = "button";
			remove.title = `Quitar a @${a.name} del proyecto (conserva su sesión e historial)`;
			remove.setAttribute("aria-label", remove.title);
			remove.addEventListener("click", () => void removeAgent(pid, a));
			li.append(link, el("span", `acp-status acp-status-${st.tone}`, st.label));
			if (active) li.append(remove);
			chipsEl.append(li);
		}
	}
	const candidates = others.filter((a) => a.projectId !== pid);
	const tk = JSON.stringify([pid, active, candidates.map((a) => [a.name, a.projectId ?? null])]);
	if (tk !== toolsKey || !toolsEl) {
		toolsKey = tk;
		// Agent tools write (join / leave / a new agent session): live project only.
		toolsEl = active ? buildTools(pid, candidates) : el("div", "acp-project-tools");
	}
	helpEl.textContent =
		mode === "archived"
			? "Proyecto archivado: su historial se lee acá. Sus agentes siguen en sus sesiones y en su chat individual."
			: !active
				? ""
				: members.length
					? "Empezá el mensaje con @agente (uno o varios): cada uno lo recibe en su cola y responde acá. Pueden consultarse entre ellos (st send); esas consultas también aparecen acá."
					: "Este proyecto todavía no tiene agentes ACP. Creá una sesión con agente o agregá una existente.";
	syncChildren(barEl, [chipsEl, toolsEl, helpEl]);
}

function buildTools(pid: string, candidates: AcpAgentInfo[]): HTMLElement {
	const tools = el("div", "acp-project-tools");
	if (candidates.length) {
		const select = el("select", "acp-add-select");
		select.setAttribute("aria-label", "Agregar un agente existente");
		select.append(new Option("Agregar agente existente…", ""));
		for (const a of candidates)
			select.append(
				new Option(`@${a.name}${a.projectId ? " (está en otro proyecto)" : ""}`, a.name),
			);
		// An explicit button: a <select> alone would act on its `change`, which
		// keyboard type-ahead fires while it has the focus (typing "@…" picked an agent).
		const add = el("button", "files-btn", "Agregar");
		add.type = "button";
		add.disabled = true;
		select.addEventListener("change", () => (add.disabled = select.value === ""));
		add.addEventListener("click", () => {
			const name = select.value;
			if (name) void addAgent(pid, name);
		});
		tools.append(select, add);
	}
	const create = el("button", "files-btn", "+ Nueva sesión con agente");
	create.type = "button";
	create.addEventListener("click", () =>
		window.dispatchEvent(new CustomEvent("st:new-acp-session", { detail: { projectId: pid } })),
	);
	tools.append(create);
	return tools;
}

async function addAgent(pid: string, name: string): Promise<void> {
	if (mode !== "active" || shownPid !== pid) return;
	try {
		await acpSetProject(name, pid);
		await refreshAcpAgents();
		others = allAgents;
		showToast(`@${name} se unió al proyecto`);
	} catch (err) {
		showToast((err as Error).message, true);
	}
	renderBar();
}

async function removeAgent(pid: string, a: AcpAgentInfo): Promise<void> {
	const ok = await confirmDialog({
		title: `Quitar a @${a.name} del proyecto`,
		message:
			"Su sesión, su contexto ACP y sus mensajes se conservan. Deja de recibir mensajes de este Project Chat.",
		confirmLabel: "Quitar",
	}).catch(() => false);
	// The page may have changed state while the dialog was open.
	if (!ok || mode !== "active" || shownPid !== pid) return;
	try {
		await acpSetProject(a.name, null);
		await refreshAcpAgents();
		others = allAgents;
	} catch (err) {
		showToast((err as Error).message, true);
	}
	if (shownPid === pid) renderBar();
}
