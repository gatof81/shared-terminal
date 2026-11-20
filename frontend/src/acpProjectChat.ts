// acpProjectChat.ts — ACP Project Chat (experimental, `features.acpAgents`),
// the project page (`#/projects/<pid>`).
//
// A project only groups agents and gives them a shared conversation: each
// agent keeps its own session (environment, repository, terminal, ACP
// context). What is posted here is visible here; a direct message to an agent
// (its individual chat) never is. Same API, store and delivery as the
// individual chat — the thread component is shared (acpThread.ts).

import { agentStatus } from "./acpModel.js";
import { acpReadTicket, setAcpAgents } from "./acpRegistry.js";
import { AcpThread, agentHue, type FeedStatus, type ThreadState } from "./acpThread.js";
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
		const ticket = acpReadTicket();
		allAgents = await acpListAgents();
		allLoaded = true;
		setAcpAgents(allAgents, ticket);
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
		else root.replaceChildren(header, barEl, listScrim, listEl, panelEl, thread.root);
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
/**
 * A phone (≤ 640 px): the list lies OVER the thread — opening or closing it
 * moves nothing — from 4 px under the row that opens it, 8 px from the
 * sides, never over the message box: at most min(60 % of the visible
 * height, the room down to the box − 8 px). A transparent scrim under it
 * takes a tap outside (it closes the list; the thread under it gets no
 * tap). A wider screen keeps it in the flow (acp-chat.css).
 */
const listScrim = el("div", "acp-agents-list-scrim");
listScrim.hidden = true;
listScrim.addEventListener("click", () => closeList());

function placeList(): void {
	if (narrowMq?.matches !== true) {
		listEl.style.removeProperty("top");
		listEl.style.removeProperty("max-height");
		return;
	}
	const page = root.getBoundingClientRect();
	const opener = (groupBtn.closest(".pv-header") ?? groupBtn).getBoundingClientRect();
	const top = opener.bottom + 4;
	const box = thread.root.querySelector(".acp-chat-composer")?.getBoundingClientRect();
	const visible = window.visualViewport?.height ?? window.innerHeight;
	const room = (box && box.height > 0 ? box.top : visible) - 8 - top;
	listEl.style.top = `${Math.round(top - page.top + root.scrollTop)}px`;
	listEl.style.maxHeight = `${Math.max(88, Math.floor(Math.min(visible * 0.6, room)))}px`;
}
window.visualViewport?.addEventListener("resize", () => {
	if (listOpen) placeList();
});

/**
 * Agents whose running message was looked for and not shown, said in their
 * row: not in this chat ("missing"), or still further back after the pages
 * one search loads ("earlier", with "Seguir buscando").
 */
const notFound = new Map<string, { id: number; why: "missing" | "earlier" }>();

/**
 * The thread at the message an agent works on (AcpThread.revealMessage: it
 * loads back up to 3 pages per search). A phone closes the list first — the thread is
 * under it; not found, the row says so (and a phone shows the list again).
 */
async function goToRunning(name: string, id: number, chip: HTMLElement): Promise<void> {
	// Looking for it may load earlier pages: the chip says it is busy.
	chip.setAttribute("aria-busy", "true");
	const near = thread.placeOf(id) === "shown";
	if (near) {
		listOpen = false;
		renderBar();
	}
	const found = await thread.revealMessage(id);
	chip.removeAttribute("aria-busy");
	if (found === "shown") {
		refocusAgent = null;
		notFound.delete(name);
		if (listOpen) {
			listOpen = false;
			renderBar();
		}
		return;
	}
	// Never in silence: the list stays (or opens again) with the row saying so.
	notFound.set(name, { id, why: found });
	listOpen = true;
	renderBar();
	// Re-renders replace the control that had the focus (this one and any
	// later one, e.g. when the loaded pages change the rows' targets): the
	// row's next step takes it, never <body> (refocusRow, in renderBar).
	refocusAgent = name;
	refocusRow();
}

/** The agent whose row gets the focus back after a search that did not show the message. */
let refocusAgent: string | null = null;
function refocusRow(): void {
	if (!refocusAgent || !listOpen) return;
	const a = document.activeElement;
	if (a && a !== document.body && a.isConnected) return;
	const row = [...listBody.querySelectorAll<HTMLElement>(".acp-agents-list-item")].find(
		(li) => li.dataset.agent === refocusAgent,
	);
	row?.querySelector<HTMLElement>(".acp-agents-list-more, button.acp-agents-list-state")?.focus();
}

function closeList(): void {
	refocusAgent = null;
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
	// The message an agent works on, if this chat has it (or an earlier page may).
	const target = (a: AcpAgentInfo) =>
		typeof a.running === "number" && thread.placeOf(a.running) !== "elsewhere" ? a.running : null;
	const ck = JSON.stringify([
		pid,
		active,
		statuses.map(({ a, st }) => [a.name, a.sessionId, st.label, st.tone, target(a)]),
		[...notFound].map(([n, f]) => [n, f.id, f.why]),
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
		// One row per agent, all the same height (acp-chat.css): its face, its
		// name on one line, its state as a chip under it, "Abrir su chat" on
		// the right. The state goes to the message the agent works on, when
		// this chat has it (or may, on an earlier page): a chip with its fill
		// and "›"; otherwise a bare chip, not focusable.
		const items = ordered.map(({ a, st }) => {
			const li = el("li", "acp-agents-list-item");
			li.dataset.agent = a.name;
			li.style.setProperty("--acp-hue", String(agentHue(a.name)));
			const face = el("span", "acp-avatar acp-agents-list-face", a.name.slice(0, 1).toUpperCase());
			face.setAttribute("aria-hidden", "true");
			const name = el("span", "acp-agents-list-name", `@${a.name}`);
			name.title = `@${a.name}`;
			const link = el("a", "btn sm acp-agents-list-link", "Abrir su chat");
			link.href = routeHash({ sessionId: a.sessionId, view: "chat", detail: null });
			link.title = "Abrir su sesión (Chat individual, Terminal, Files, Git)";
			link.setAttribute("aria-label", `Abrir su chat (@${a.name})`);
			// An action of the row closes the list (its destination takes over).
			link.addEventListener("click", () => {
				listOpen = false;
				renderBar();
			});
			const id = target(a);
			let state: HTMLElement;
			if (id !== null) {
				const go = el("button", `chip tone-${st.tone} acp-agents-list-goto`, st.label);
				go.type = "button";
				go.append(el("span", "acp-agents-list-goto-mark", "›"));
				go.lastElementChild!.setAttribute("aria-hidden", "true");
				// Starts with what it does; holds the words it shows (WCAG 2.5.3).
				go.setAttribute("aria-label", `Ir al mensaje en curso de @${a.name} (${st.label})`);
				go.addEventListener("click", () => void goToRunning(a.name, id, go));
				state = go;
			} else state = el("span", `chip bare tone-${st.tone}`, st.label);
			state.classList.add("acp-agents-list-state");
			li.append(face, name, state, link);
			// Looked for and not found: said even now that it reads as not this
			// chat's (all its pages loaded), and until the agent moves on.
			const miss = notFound.get(a.name);
			if (typeof a.running === "number" && miss?.id === a.running) {
				const note = el(
					"p",
					"acp-agents-list-note",
					miss.why === "earlier"
						? `El mensaje #${a.running} está más atrás en el historial.`
						: `No se encontró el mensaje #${a.running} en este Project Chat.`,
				);
				if (miss.why === "earlier" && id !== null) {
					const more = el("button", "btn sm acp-agents-list-more", "Seguir buscando");
					more.type = "button";
					more.addEventListener("click", () => void goToRunning(a.name, id, more));
					note.append(" ", more);
				}
				li.append(note);
			}
			return li;
		});
		listBody.replaceChildren(...items);
		refocusRow();
	}
	listEl.hidden = !listOpen;
	listScrim.hidden = !listOpen;
	if (listOpen) placeList();
	groupBtn.setAttribute("aria-expanded", String(listOpen));
	const mk = JSON.stringify([pid, active, members.map((a) => a.name)]);
	if (mk !== manageKey || !manageEl) {
		manageKey = mk;
		manageEl = el("ul", "acp-manage-list");
		manageEl.setAttribute("aria-label", "Quitar agentes del proyecto");
		if (active)
			for (const a of members) {
				const li = el("li", "acp-manage-item");
				const remove = el("button", "btn sm acp-agent-remove", "Quitar");
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
		const add = el("button", "btn sm", "Agregar");
		add.type = "button";
		add.disabled = true;
		select.addEventListener("change", () => (add.disabled = select.value === ""));
		add.addEventListener("click", () => {
			const name = select.value;
			if (name) void addAgent(pid, name);
		});
		tools.append(select, add);
	}
	const create = el("button", "btn sm", "+ Nueva sesión con agente");
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
