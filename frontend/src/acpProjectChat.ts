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
import { openActionMenu } from "./components/actionMenu.js";
import { confirmDialog } from "./components/dialog.js";
import { showToast } from "./components/toast.js";
import { routeHash } from "./router.js";
import { el, syncChildren } from "./ui.js";

const root = el("div", "pv-page acp-project");
// What the page says about itself (archived, not found, an error): a line at
// the top of the thread's area, never a second header row.
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

export async function refreshAcpAgents(): Promise<AcpAgentInfo[]> {
	try {
		const ticket = acpReadTicket();
		allAgents = await acpListAgents();
		setAcpAgents(allAgents, ticket);
	} catch {
		/* keep */
	}
	return allAgents;
}

/**
 * The page element for project `pid` (one element, kept across the project
 * page's re-renders so the draft, scroll and live socket survive).
 * `header`: the page's header row built by projectsView (title, ⋯); `note`:
 * its state line, if any (archived, not found, an error).
 */
export function acpProjectPage(
	pid: string,
	header: HTMLElement,
	note: HTMLElement | null,
): HTMLElement {
	if (root.childElementCount === 0) root.append(barEl, scrim, panelEl, thread.root);
	if (headerEl !== header) {
		headerEl?.remove();
		headerEl = header;
		// The agents' group sits in the header's row, before ⋯.
		header.querySelector(".pv-tools")?.prepend(groupBtn);
		const title = header.querySelector<HTMLElement>(".pv-title");
		// The full name where the row cuts it with an ellipsis.
		if (title) title.title = title.textContent ?? "";
	}
	placeHeader();
	noteEl = note;
	if (shownPid !== pid) {
		shownPid = pid;
		panelOpen = null;
		state = null;
		mode = "loading";
		thread.setComposer("disabled");
		thread.root.hidden = false;
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

/**
 * Where the page's header row goes: on a phone (≤ 768 px) INTO the app's
 * header, in the session bar's place (☰ · title · agents · ⋯ · account; the
 * header keeps its 44 px, so the terminal under the page is not resized);
 * wider, on top of the page. Only the header row moves, never the thread
 * (taking it out of the document resets its scroll).
 */
const headerMq = typeof window !== "undefined" ? window.matchMedia?.("(max-width: 768px)") : null;
headerMq?.addEventListener?.("change", () => placeHeader());
function placeHeader(): void {
	const slot = document.getElementById("header-project");
	if (!headerEl || shownPid === null) return;
	if (headerMq?.matches && slot) {
		if (headerEl.parentElement !== slot) slot.replaceChildren(headerEl);
		slot.hidden = false;
	} else {
		if (headerEl.parentElement !== root) root.prepend(headerEl);
		if (slot) {
			slot.hidden = true;
			slot.replaceChildren();
		}
	}
	if (panelOpen) placePanel();
}

function clearHeaderSlot(): void {
	const slot = document.getElementById("header-project");
	if (!slot) return;
	slot.hidden = true;
	slot.replaceChildren();
}

/** Off screen: stop following live (state kept for a quick return). */
export function suspendAcpProject(): void {
	thread.close();
	clearHeaderSlot();
	headerEl?.remove();
	headerEl = null;
}

export function resetAcpProject(): void {
	thread.close();
	clearHeaderSlot();
	shownPid = null;
	headerEl = null;
	allAgents = [];
}

// ── Agents (U-2 §3) ─────────────────────────────────────────────────────────
//
// The agents' GROUP in the header's row (stacked avatars with a state dot,
// "+N", a counted mark when an agent needs the person; "+" with no agents)
// opens ONE panel, "Agentes": a row per agent (its state — a chip that goes
// to the message it works on —, "Abrir su chat", a ⋯ with "Quitar del
// proyecto") and a fixed foot to add an existing agent or a new agent
// session. The panel lies OVER the thread at every width (opening it moves
// nothing) and never over the message box. Rebuilt on every thread change:
// each part only when what it shows changed, and the panel is hidden, never
// removed, so an agent picked in "Agregar agente existente…" (not added yet)
// survives it closing and reopening.
const groupBtn = el("button", "acp-agents-group");
groupBtn.type = "button";
groupBtn.setAttribute("aria-expanded", "false");
groupBtn.setAttribute("aria-controls", "acp-agents");
let groupKey = "";
let noteEl: HTMLElement | null = null;

const panelEl = el("div", "acp-agents");
panelEl.id = "acp-agents";
panelEl.setAttribute("role", "region");
panelEl.setAttribute("aria-label", "Agentes del proyecto");
panelEl.hidden = true;
const panelHead = el("div", "acp-agents-head");
const panelClose = el("button", "btn btn-icon acp-agents-close", "×");
panelClose.type = "button";
panelClose.setAttribute("aria-label", "Cerrar Agentes");
panelClose.title = "Cerrar";
panelHead.append(el("strong", undefined, "Agentes"), panelClose);
const rowsEl = el("ul", "acp-agents-rows");
const emptyEl = el("p", "acp-agents-empty", "Todavía no hay agentes en este proyecto.");
const footEl = el("div", "acp-agents-foot");
panelEl.append(panelHead, rowsEl, emptyEl, footEl);
let rowsKey = "";
let footKey = "";
/** null: not chosen on this page yet (open iff the project has no agents). */
let panelOpen: boolean | null = null;
/** A transparent layer under the panel: a tap outside only closes it. */
const scrim = el("div", "acp-agents-scrim");
scrim.hidden = true;
scrim.addEventListener("click", () => closePanel());

groupBtn.addEventListener("click", () => {
	if (panelOpen) closePanel();
	else openPanel();
});
panelClose.addEventListener("click", () => closePanel());
panelEl.addEventListener("keydown", (e) => {
	if (e.key !== "Escape") return;
	e.preventDefault();
	e.stopPropagation();
	closePanel();
});

function openPanel(): void {
	panelOpen = true;
	renderBar();
	// The first row's first action, or the foot's selector without agents.
	panelEl
		.querySelector<HTMLElement>(
			".acp-agents-rows button, .acp-agents-rows a, .acp-agents-foot select, .acp-agents-foot button",
		)
		?.focus();
}

/** Closed by ×, Escape, a tap outside or the group: the focus goes back to the group. */
function closePanel(): void {
	panelOpen = false;
	renderBar();
	groupBtn.focus();
}

/** An action of the panel was chosen: it closes; the focus goes to the destination. */
function dismissPanel(): void {
	panelOpen = false;
	renderBar();
}

/** Avatars shown in the group: 3 on a phone, 5 on a wider screen; the rest is "+N". */
const narrowMq = typeof window !== "undefined" ? window.matchMedia?.("(max-width: 640px)") : null;
narrowMq?.addEventListener?.("change", () => renderBar());

/**
 * Over the thread: 4 px under the header row that opens it; on a phone 8 px
 * from the sides, wider 400 px with its right edge on the group's; its
 * bottom at least 8 px above the message box, at most 60 % of the visible
 * height.
 */
function placePanel(): void {
	const page = root.getBoundingClientRect();
	// On a phone the row is the app's header (its bottom line included).
	const row = (
		headerMq?.matches
			? (document.querySelector("header") ?? groupBtn)
			: (groupBtn.closest(".pv-header") ?? groupBtn)
	).getBoundingClientRect();
	const top = row.bottom + 4;
	const box = thread.root.querySelector(".acp-chat-composer")?.getBoundingClientRect();
	const visible = window.visualViewport?.height ?? window.innerHeight;
	const room = (box && box.height > 0 ? box.top : visible) - 8 - top;
	panelEl.style.top = `${Math.round(top - page.top)}px`;
	panelEl.style.maxHeight = `${Math.max(88, Math.floor(Math.min(visible * 0.6, room)))}px`;
	if (narrowMq?.matches) {
		panelEl.style.removeProperty("left");
		panelEl.style.removeProperty("width");
	} else {
		const g = groupBtn.getBoundingClientRect();
		panelEl.style.width = "400px";
		panelEl.style.left = `${Math.round(Math.max(8, g.right - 400 - page.left))}px`;
	}
}
window.visualViewport?.addEventListener("resize", () => {
	if (panelOpen) placePanel();
});

/** The agent whose row gets the focus after a removal (the next row, else the foot). */
let focusAfterRemoval: string | null = null;

/**
 * The thread at the message an agent works on (AcpThread.revealMessage: up
 * to 3 earlier pages per search). The panel closes first — the thread is
 * under it; not found, the composer's notice line says so (never silence).
 */
async function goToRunning(name: string, id: number, chip: HTMLElement): Promise<void> {
	chip.setAttribute("aria-busy", "true");
	dismissPanel();
	const found = await thread.revealMessage(id);
	chip.removeAttribute("aria-busy");
	if (found === "earlier")
		thread.showNotice(
			`El mensaje #${id} de @${name} está más atrás en el historial: «Cargar anteriores» sigue buscando.`,
		);
	else if (found === "missing")
		thread.showNotice(`No se encontró el mensaje #${id} en este Project Chat.`);
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
	groupBtn.hidden = mode === "unavailable" || (members.length === 0 && !active);
	if (ck !== rowsKey) {
		rowsKey = ck;
		const had = rowsEl.contains(document.activeElement);
		rowsEl.replaceChildren(...ordered.map(({ a, st }) => agentRow(pid, a, st, target(a), active)));
		if (focusAfterRemoval !== null) {
			const rows = [...rowsEl.querySelectorAll<HTMLElement>(".acp-agents-row")];
			const next = rows.find((r) => r.dataset.agent === focusAfterRemoval) ?? null;
			(
				next?.querySelector<HTMLElement>("a, button") ??
				footEl.querySelector<HTMLElement>("select, button")
			)?.focus();
			focusAfterRemoval = null;
		} else if (had) rowsEl.querySelector<HTMLElement>("a, button")?.focus();
	}
	emptyEl.hidden = members.length > 0;
	const candidates = others.filter((a) => a.projectId !== pid);
	const fk = JSON.stringify([pid, active, candidates.map((a) => [a.name, a.projectId ?? null])]);
	if (fk !== footKey) {
		footKey = fk;
		// Agent tools write (join / a new agent session): a live project only.
		if (active) buildFoot(pid, candidates);
		else footEl.replaceChildren();
	}
	footEl.hidden = !active;
	// An empty live project opens it on entering: adding an agent is the one
	// useful thing to do there.
	const open =
		!groupBtn.hidden && (panelOpen ?? (active && state !== null && members.length === 0));
	panelEl.hidden = !open;
	scrim.hidden = !open;
	groupBtn.setAttribute("aria-expanded", String(open));
	if (open) placePanel();
	const parts: HTMLElement[] = [];
	if (noteEl) parts.push(noteEl);
	if (mode === "archived")
		parts.push(
			el(
				"p",
				"acp-project-help acp-project-archived",
				"Su historial se lee acá. Sus agentes siguen en sus sesiones y en su chat individual.",
			),
		);
	syncChildren(barEl, parts);
	barEl.hidden = parts.length === 0;
}

/**
 * One row, 64 px whatever it holds: the face; the name on one line (an
 * ellipsis, the whole one in its tooltip) and the state under it — a chip
 * that goes to the message the agent works on (with "›") or a bare one;
 * "Abrir su chat"; on a live project a ⋯ with "Quitar del proyecto".
 */
function agentRow(
	pid: string,
	a: AcpAgentInfo,
	st: { label: string; tone: string },
	id: number | null,
	active: boolean,
): HTMLElement {
	const li = el("li", "acp-agents-row");
	li.dataset.agent = a.name;
	li.style.setProperty("--acp-hue", String(agentHue(a.name)));
	const face = el("span", "acp-avatar acp-agents-face", a.name.slice(0, 1).toUpperCase());
	face.setAttribute("aria-hidden", "true");
	const name = el("span", "acp-agents-name", `@${a.name}`);
	name.title = `@${a.name}`;
	let chip: HTMLElement;
	if (id !== null) {
		const go = el("button", `chip tone-${st.tone} acp-agents-goto`, st.label);
		go.type = "button";
		const mark = el("span", "acp-agents-goto-mark", "›");
		mark.setAttribute("aria-hidden", "true");
		go.append(mark);
		// Starts with what it does; holds the words it shows (WCAG 2.5.3).
		go.setAttribute("aria-label", `Ir al mensaje en curso de @${a.name} (${st.label})`);
		go.addEventListener("click", () => void goToRunning(a.name, id, go));
		chip = go;
	} else chip = el("span", `chip bare tone-${st.tone}`, st.label);
	chip.classList.add("acp-agents-state");
	// "Chat" on the narrowest phones (acp-chat.css), where the long label
	// would cover the state chip; the accessible name stays the long one.
	const open = el("a", "btn sm acp-agents-open");
	open.append(
		el("span", "acp-agents-open-long", "Abrir su chat"),
		el("span", "acp-agents-open-short", "Chat"),
	);
	open.href = routeHash({ sessionId: a.sessionId, view: "chat", detail: null });
	open.title = "Abrir su sesión (Chat individual, Terminal, Files, Git)";
	open.setAttribute("aria-label", `Abrir su chat (@${a.name})`);
	open.addEventListener("click", () => dismissPanel());
	li.append(face, name, chip, open);
	if (active) {
		const more = el("button", "btn btn-icon acp-agents-more", "⋯");
		more.type = "button";
		more.setAttribute("aria-label", `Acciones de @${a.name}`);
		more.setAttribute("aria-haspopup", "menu");
		more.addEventListener("click", () =>
			openActionMenu({
				title: `@${a.name}`,
				opener: more,
				items: [
					{
						id: "remove",
						label: "Quitar del proyecto",
						kind: "danger",
						hint: "Conserva su sesión e historial",
					},
				],
				onPick: () => void removeAgent(pid, a),
			}),
		);
		li.append(more);
	}
	return li;
}

/**
 * The group's button: up to `max` stacked avatars (the thread's colour), each
 * with a state dot; "+N" for the rest; and — wherever the agents needing the
 * person are, shown or in the "+N" — a mark with a shape and a count ("1 !"),
 * said in the button's name too. With no agents: one "+" avatar.
 */
function renderGroup(
	ordered: Array<{ a: AcpAgentInfo; st: { label: string; tone: string } }>,
	max: number,
): void {
	if (ordered.length === 0) {
		const plus = el("span", "acp-avatar acp-group-avatar acp-group-add", "+");
		plus.setAttribute("aria-hidden", "true");
		const avatars = el("span", "acp-group-avatars");
		avatars.append(plus);
		groupBtn.replaceChildren(avatars, el("span", "visually-hidden", "Agregar agentes"));
		groupBtn.title = "Agregar agentes";
		groupBtn.classList.remove("needs-you");
		return;
	}
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

function buildFoot(pid: string, candidates: AcpAgentInfo[]): void {
	const parts: HTMLElement[] = [];
	if (candidates.length) {
		const row = el("div", "acp-agents-add");
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
		row.append(select, add);
		parts.push(row);
	}
	const create = el("button", "btn sm", "+ Nueva sesión con agente");
	create.type = "button";
	create.addEventListener("click", () => {
		dismissPanel();
		// The dialog gives the focus back to the agents' group on close.
		window.dispatchEvent(
			new CustomEvent("st:new-acp-session", { detail: { projectId: pid, opener: groupBtn } }),
		);
	});
	parts.push(create);
	footEl.replaceChildren(...parts);
}

async function addAgent(pid: string, name: string): Promise<void> {
	if (mode !== "active" || shownPid !== pid) return;
	try {
		await acpSetProject(name, pid);
		await refreshAcpAgents();
		others = allAgents;
		// The page's agents come with its feed: read it again.
		thread.retry();
		showToast(`@${name} se unió al proyecto`);
	} catch (err) {
		showToast((err as Error).message, true);
	}
	dismissPanel();
	groupBtn.focus();
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
	// The panel stays open; the focus goes to the next row (else the foot).
	const rows = [...rowsEl.querySelectorAll<HTMLElement>(".acp-agents-row")];
	const at = rows.findIndex((r) => r.dataset.agent === a.name);
	focusAfterRemoval = rows[at + 1]?.dataset.agent ?? "";
	try {
		await acpSetProject(a.name, null);
		await refreshAcpAgents();
		others = allAgents;
		thread.retry();
	} catch (err) {
		showToast((err as Error).message, true);
	}
	if (shownPid === pid) {
		panelOpen = true;
		renderBar();
	}
}
