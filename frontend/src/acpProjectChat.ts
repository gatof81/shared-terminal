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
import {
	AcpThread,
	agentAvatar,
	agentHue,
	type FeedStatus,
	type ThreadState,
} from "./acpThread.js";
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
		// Only the header is swapped once the page is built: taking the
		// thread out of the document and back (replaceChildren) resets its
		// scroll to the top — a long history opened at its oldest message.
		if (headerEl?.parentElement === root) headerEl.replaceWith(header);
		// The panel is a sibling of the agents row: on a short screen it is
		// the one part that gives way to the thread's minimum (acp-chat.css).
		else root.replaceChildren(header, barEl, listEl, panelEl, thread.root);
		headerEl = header;
		// The agents' group sits in the header's row, before ⋯ and ×.
		header.querySelector(".pv-tools")?.prepend(groupBtn);
		const title = header.querySelector<HTMLElement>(".pv-title");
		// The full name where the row cuts it with an ellipsis.
		if (title) title.title = title.textContent ?? "";
	}
	if (shownPid !== pid) {
		shownPid = pid;
		panelOpen = null;
		listOpen = false;
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

// Two parts: the agents' GROUP in the header's row (stacked avatars with a
// state dot, "+N", and a counted mark when an agent needs the person) that
// opens the full list under the header; and the "Administrar agentes" panel
// (remove, add an existing one, a new agent session, the help), closed by
// default — open when the project has no agents yet, the only useful thing
// to do there. Rebuilt on every thread change (activity, the 15 s status
// poll): each part only when what it shows changed, and the panels are
// hidden, never removed, so an agent picked in "Agregar agente existente…"
// (not added yet) or the focus on a Quitar survives, with the panel closed
// and reopened too.
const groupBtn = el("button", "acp-agents-group");
groupBtn.type = "button";
groupBtn.setAttribute("aria-expanded", "false");
groupBtn.setAttribute("aria-controls", "acp-agents-list");
groupBtn.hidden = true;
let groupKey = "";
const listEl = el("div", "acp-agents-list");
listEl.id = "acp-agents-list";
listEl.setAttribute("role", "region");
listEl.setAttribute("aria-label", "Agentes del proyecto");
listEl.hidden = true;
const listHead = el("div", "acp-agents-panel-head");
const listClose = el("button", "pv-close acp-agents-panel-close", "×");
listClose.type = "button";
listClose.setAttribute("aria-label", "Cerrar la lista de agentes");
listClose.title = "Cerrar";
listHead.append(el("strong", undefined, "Agentes del proyecto"), listClose);
const listBody = el("ul", "acp-agents-list-body");
listEl.append(listHead, listBody);
let listKey = "";
let listOpen = false;
groupBtn.addEventListener("click", () => {
	listOpen = !listOpen;
	if (listOpen) panelOpen = false;
	renderBar();
	if (listOpen)
		listEl.querySelector<HTMLElement>("a, button:not(.acp-agents-panel-close)")?.focus();
});
listClose.addEventListener("click", () => closeList());
listEl.addEventListener("keydown", (e) => {
	if (e.key !== "Escape") return;
	e.preventDefault();
	e.stopPropagation();
	closeList();
});
function closeList(): void {
	listOpen = false;
	renderBar();
	groupBtn.focus();
}
/** Avatars shown in the group: 3 on a phone, 5 on a wider screen; the rest is "+N". */
const narrowMq = typeof window !== "undefined" ? window.matchMedia?.("(max-width: 640px)") : null;
narrowMq?.addEventListener?.("change", () => renderBar());
let manageEl: HTMLElement | null = null;
let manageKey = "";
let toolsEl: HTMLElement | null = null;
let toolsKey = "";
const helpEl = el("p", "acp-project-help");
const archivedEl = el("p", "acp-project-help acp-project-archived");
const panelEl = el("div", "acp-agents-panel");
panelEl.id = "acp-agents-panel";
panelEl.setAttribute("role", "region");
panelEl.setAttribute("aria-label", "Administrar agentes");
panelEl.hidden = true;
const panelHead = el("div", "acp-agents-panel-head");
const panelClose = el("button", "pv-close acp-agents-panel-close", "×");
panelClose.type = "button";
panelClose.setAttribute("aria-label", "Cerrar Administrar agentes");
panelClose.title = "Cerrar";
panelHead.append(el("strong", undefined, "Administrar agentes"), panelClose);
const panelBody = el("div", "acp-agents-panel-body");
panelEl.append(panelHead, panelBody);
/** null: not chosen on this page yet (open iff the project has no agents). */
let panelOpen: boolean | null = null;
/** Where the focus goes back when the panel closes (the ⋯ that opened it). */
let panelOpener: HTMLElement | null = null;
panelClose.addEventListener("click", () => closeAgentsPanel());
panelEl.addEventListener("keydown", (e) => {
	if (e.key !== "Escape") return;
	e.preventDefault();
	e.stopPropagation();
	closeAgentsPanel();
});

function closeAgentsPanel(): void {
	panelOpen = false;
	renderBar();
	const back = panelOpener?.isConnected ? panelOpener : document.getElementById("pv-title");
	back?.focus();
}

/** "Administrar agentes" from the project's ⋯ menu: open it, focus inside. */
export function openAgentsPanel(opener: HTMLElement): void {
	if (mode !== "active") return;
	panelOpener = opener;
	panelOpen = true;
	listOpen = false;
	renderBar();
	panelEl.querySelector<HTMLElement>("select, button:not(.acp-agents-panel-close), a")?.focus();
}

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
	// Who needs the person first (a question, a login), then who works, then the rest.
	const rank = (tone: string) => (tone === "warn" ? 0 : tone === "busy" ? 1 : 2);
	const ordered = statuses
		.map((x, i) => ({ ...x, i }))
		.sort((x, y) => rank(x.st.tone) - rank(y.st.tone) || x.i - y.i);
	const max = narrowMq?.matches ? 3 : 5;
	const gk = JSON.stringify([ck, max]);
	if (gk !== groupKey) {
		groupKey = gk;
		renderGroup(ordered, max);
	}
	groupBtn.hidden = members.length === 0 || mode === "unavailable";
	if (groupBtn.hidden) listOpen = false;
	if (ck !== listKey) {
		listKey = ck;
		const items = ordered.map(({ a, st }) => {
			const li = el("li", "acp-agents-list-item");
			const who = agentAvatar(a.name);
			who.classList.add("acp-agents-list-who");
			const link = el("a", "acp-agents-list-link", "Abrir su chat");
			link.href = routeHash({ sessionId: a.sessionId, view: "chat", detail: null });
			link.title = "Abrir su sesión (Chat individual, Terminal, Files, Git)";
			link.setAttribute("aria-label", `Abrir su chat (@${a.name})`);
			li.append(who, el("span", `acp-status acp-status-${st.tone}`, st.label), link);
			return li;
		});
		listBody.replaceChildren(...items);
	}
	listEl.hidden = !listOpen;
	groupBtn.setAttribute("aria-expanded", String(listOpen));
	const mk = JSON.stringify([pid, active, members.map((a) => a.name)]);
	if (mk !== manageKey || !manageEl) {
		manageKey = mk;
		manageEl = el("ul", "acp-manage-list");
		manageEl.setAttribute("aria-label", "Quitar agentes del proyecto");
		if (active)
			for (const a of members) {
				const li = el("li", "acp-manage-item");
				const remove = el("button", "files-btn acp-agent-remove", "Quitar");
				remove.type = "button";
				remove.title = `Quitar a @${a.name} del proyecto (conserva su sesión e historial)`;
				remove.setAttribute("aria-label", `Quitar a @${a.name} del proyecto`);
				remove.addEventListener("click", () => void removeAgent(pid, a));
				li.append(el("span", "acp-agent-name", `@${a.name}`), remove);
				manageEl.append(li);
			}
	}
	const candidates = others.filter((a) => a.projectId !== pid);
	const tk = JSON.stringify([pid, active, candidates.map((a) => [a.name, a.projectId ?? null])]);
	if (tk !== toolsKey || !toolsEl) {
		toolsKey = tk;
		// Agent tools write (join / leave / a new agent session): live project only.
		toolsEl = active ? buildTools(pid, candidates) : el("div", "acp-project-tools");
	}
	helpEl.textContent = !active
		? ""
		: members.length
			? "Empezá el mensaje con @agente (uno o varios): cada uno lo recibe en su cola y responde acá. Pueden consultarse entre ellos (st send); esas consultas también aparecen acá."
			: "Este proyecto todavía no tiene agentes ACP. Creá una sesión con agente o agregá una existente.";
	syncChildren(panelBody, [manageEl, toolsEl, helpEl]);
	// The panel holds write tools: a live project only (fail-closed).
	const open = active && (panelOpen ?? (state !== null && members.length === 0));
	panelEl.hidden = !open;
	const parts: HTMLElement[] = [];
	if (mode === "archived") {
		archivedEl.textContent =
			"Su historial se lee acá. Sus agentes siguen en sus sesiones y en su chat individual.";
		parts.push(archivedEl);
	}
	syncChildren(barEl, parts);
	barEl.hidden = parts.length === 0;
}

/**
 * The group's button: up to `max` stacked avatars (the thread's colour), each
 * with a state dot; "+N" for the rest; and — wherever the agents needing the
 * person are, shown or in the "+N" — a mark with a shape and a count ("1 !"),
 * said in the button's name too.
 */
function renderGroup(
	ordered: Array<{ a: AcpAgentInfo; st: { label: string; tone: string } }>,
	max: number,
): void {
	const shown = ordered.slice(0, max);
	const rest = ordered.length - shown.length;
	const avatars = el("span", "acp-group-avatars");
	for (const { a, st } of shown) {
		const av = el("span", "acp-avatar acp-group-avatar", a.name.slice(0, 1).toUpperCase());
		av.style.setProperty("--acp-hue", String(agentHue(a.name)));
		const dot = el("span", `acp-group-dot acp-dot-${st.tone}`);
		av.append(dot);
		avatars.append(av);
	}
	const parts: HTMLElement[] = [avatars];
	if (rest > 0) parts.push(el("span", "acp-group-more", `+${rest}`));
	const needs = ordered.filter(({ st }) => st.tone === "warn");
	if (needs.length) parts.push(el("span", "acp-group-alert", `${needs.length} !`));
	for (const p of parts) p.setAttribute("aria-hidden", "true");
	const said = needs.map(({ a, st }) =>
		st.label === "esperando login"
			? `@${a.name} necesita login.`
			: `@${a.name} espera tu respuesta.`,
	);
	const label = [`Agentes del proyecto: ${ordered.length}.`, ...said].join(" ");
	// The name is the button's own (hidden) text, not an aria-label: the
	// letters and "+N" drawn on it are shapes, not words a voice user says.
	groupBtn.replaceChildren(...parts, el("span", "visually-hidden", label));
	groupBtn.title = label;
	groupBtn.classList.toggle("needs-you", needs.length > 0);
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
		// The button itself: the dialog gives the focus back to it on close.
		window.dispatchEvent(
			new CustomEvent("st:new-acp-session", { detail: { projectId: pid, opener: create } }),
		),
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
