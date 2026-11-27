// projectRail.ts — the project's rail (3B F1, PROPUESTA §2): the project
// selector ▾, the attention row (a way into Pendientes, acpInbox.ts — whose
// icon with its count is the app header's, on every screen), the topics (Conversaciones: create, unread per topic),
// the team with each agent's state in the seven fixed words (Equipo), the
// works (Trabajos: active ones; closed ones on demand), the Archive's entry
// and a foot with the settings. Its head: ‹ back to the main level, and the
// selector.
//
// One rail, for the project on screen: projectsView.ts places its two parts
// (`railHead`, `railBody`) in the sidebar on a wide screen, and on a phone
// the head in the app's header and the body as the project's own screen.
// Data: the project's topics, the agents, the works and the inbox over REST,
// kept current by /ws/acp (acpLive.ts: one socket for the tab), re-read
// debounced; while the socket is down, a slow poll.

import { inboxNow, onInbox } from "./acpInboxStore.js";
import { acpLiveUp, subscribeAcp } from "./acpLive.js";
import { agentHue, type TeamState, teamState } from "./acpModel.js";
import {
	acpAgentsList,
	acpAgentsReading,
	onAcpAgentsRead,
	requestAcpAgentsRead,
	watchAcpAgents,
} from "./acpStatusFeed.js";
import {
	type AcpAgentInfo,
	type AcpConversation,
	type AcpWork,
	acpConversations,
	acpWorks,
} from "./api.js";
import { openActionMenu } from "./components/actionMenu.js";
import { projectName, projects } from "./projectDirectory.js";
import { paintProjectSignals, projectSignals } from "./projectSignals.js";
import { offered, openRecent, recentLabel } from "./recentsView.js";
import { pruneRecents } from "./recentTopics.js";
import { navigateProject, projectRouteHash } from "./router.js";
import { el, syncChildren } from "./ui.js";

const POLL_MS = 15_000;
const LIVE_DEBOUNCE_MS = 600;

/** What the rail asks of the page around it (projectsView.ts), to stay a leaf of it. */
export interface RailActions {
	newProject: () => void;
	renameProject: (pid: string) => void;
	archiveProject: (pid: string) => void;
	newConversation: (pid: string) => void;
	newAgent: (pid: string, opener: HTMLElement) => void;
	/** ‹: out of the project, to the main level (the sidebar's tree). */
	home: (opener: HTMLElement) => void;
	settings: (opener: HTMLElement) => void;
	/** An Equipo row: its agent's Terminal in Herramientas. */
	openTerminal: (name: string) => void;
	/** An Equipo row's ⋯: Files · Git · its works · its settings (toolsView.ts). */
	agentMenu: (name: string, opener: HTMLElement) => void;
	/** A work's row: Herramientas on that work. */
	openWork: (work: AcpWork) => void;
	/** Pendientes (acpInbox.ts), from the attention row. */
	openInbox: (opener: HTMLElement) => void;
}

let actions: RailActions | null = null;

export function configureRail(a: RailActions): void {
	actions = a;
}

// ── State ───────────────────────────────────────────────────────────────────

let pid: string | null = null;
/** The topic on screen («trabajando aquí»; its row is the current one). */
let here: string | null = null;
/** The Archive is on screen (its row is the current one). */
let inArchive = false;
let gen = 0;
let convs: AcpConversation[] = [];
let convsRead: "loading" | "ok" | "error" = "loading";
let archived: AcpConversation[] | null = null;
let showArchived = false;
let agents: AcpAgentInfo[] = [];
let agentsRead = false;
let works: AcpWork[] = [];
let showClosed = false;
let unsubscribe: (() => void) | null = null;
/** Releases the 15 s agents period (acpStatusFeed.ts) while the rail is shown. */
let unwatch: (() => void) | null = null;
/** The first load of this subscription was made (by its first signal, acpLive.ts). */
let loadedSinceSub = false;
let poll: ReturnType<typeof setInterval> | null = null;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Re-reads that fell due while the tab was hidden: made once it shows. */
const dueOnShow = new Set<"convs" | "agents" | "works">();
const listeners: Array<() => void> = [];

/** Told after every change of what the rail knows (the topic's header uses it). */
export function onRailChange(fn: () => void): void {
	listeners.push(fn);
}

export function railAgents(): readonly AcpAgentInfo[] {
	return agents;
}

/** The shown project has no agent (true), has some (false), or its team is not read yet (null). */
export function railTeamEmpty(): boolean | null {
	if (!agentsRead || !pid) return null;
	return !agents.some((a) => a.projectId === pid);
}

/** Every work of the owner's agents, as last read (Herramientas' workspaces). */
export function railWorks(): readonly AcpWork[] {
	return works;
}

/** The shown project's live topics, most recently active first; null until read. */
export function railConversations(): readonly AcpConversation[] | null {
	return convsRead === "ok" ? convs : null;
}

/** A topic of the shown project as its list says (live or archived), if known. */
export function railConversation(id: string): AcpConversation | null {
	return convs.find((c) => c.id === id) ?? archived?.find((c) => c.id === id) ?? null;
}

/** The project's topic titles, for «ocupado en «X»». */
export function topicTitle(id: string): string | null {
	return railConversation(id)?.title ?? null;
}

/** Whether `agent` has an interrupted run the person has not reviewed (Pendientes). */
function interrupted(agent: string): boolean {
	return inboxNow()?.action.interrupted.some((m) => m.to_id === agent) ?? false;
}
onInbox(() => {
	if (pid) render();
});

/** An agent's state in the fixed words, as of now, with `here` the topic on screen. */
export function agentState(a: AcpAgentInfo): TeamState {
	return teamState(a, { here, titleOf: topicTitle, interrupted: interrupted(a.name) });
}

// ── Elements ────────────────────────────────────────────────────────────────

export const railHead = el("div", "rail-head");
export const railBody = el("nav", "rail-body");
railBody.setAttribute("aria-label", "Proyecto");

// ‹ (the same glyph as a topic's way back, `.ps-back`): the main level.
const back = el("button", "btn btn-icon rail-back", "‹");
back.type = "button";
back.setAttribute("aria-label", "Volver a proyectos");
back.title = "Volver a proyectos";
back.addEventListener("click", () => actions?.home(back));

const selector = el("button", "rail-project");
selector.type = "button";
selector.setAttribute("aria-haspopup", "menu");
selector.setAttribute("aria-expanded", "false");
const selectorName = el("span", "rail-project-name");
selector.append(selectorName, chevronDown());
selector.addEventListener("click", () => openSelector());

railHead.append(back, selector);

/** The sidebar sections' chevron (`.sgroup-toggle`), pointing down. */
function chevronDown(): SVGSVGElement {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", "0 0 16 16");
	svg.setAttribute("aria-hidden", "true");
	svg.classList.add("rail-project-caret");
	const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
	path.setAttribute("d", "M4 6l4 4 4-4");
	svg.append(path);
	return svg;
}

// «N te esperan · N resultados nuevos»: a way into Pendientes.
const attention = el("button", "rail-attention");
attention.type = "button";
attention.hidden = true;
attention.addEventListener("click", () => actions?.openInbox(attention));

const convHead = sectionHead("Conversaciones", "Nueva conversación", () => {
	if (pid) actions?.newConversation(pid);
});
const convList = el("ul", "rail-list rail-convs");
const convNote = el("p", "rail-note");
const archivedToggle = el("button", "rail-more", "Conversaciones archivadas");
archivedToggle.type = "button";
archivedToggle.addEventListener("click", () => {
	showArchived = !showArchived;
	if (showArchived && pid) void loadArchived(pid, gen);
	render();
});

const teamHead = sectionHead("Equipo", "Nueva sesión con agente", () => {
	if (pid) actions?.newAgent(pid, teamHead.querySelector("button")!);
});
const teamList = el("ul", "rail-list rail-team");
const teamNote = el("p", "rail-note");

const worksHead = sectionHead("Trabajos");
const worksList = el("ul", "rail-list rail-works");
const worksNote = el("p", "rail-note");
const closedToggle = el("button", "rail-more", "Ver cerrados");
closedToggle.type = "button";
closedToggle.addEventListener("click", () => {
	showClosed = !showClosed;
	render();
});

const archiveHead = sectionHead("Archivo · solo lectura");
const archiveList = el("ul", "rail-list rail-archive");

// The account's way in: wide, the sidebar's own account foot is hidden
// while the rail is up.
const foot = el("div", "rail-foot");
const settingsBtn = el("button", "rail-foot-btn", "Ajustes");
settingsBtn.type = "button";
settingsBtn.addEventListener("click", () => actions?.settings(settingsBtn));
foot.append(settingsBtn);

// Placed first on a phone while the project has no agent (rail.css): adding
// one is then the only next step.
const teamSection = section(teamHead, teamList, teamNote);
teamSection.classList.add("rail-section-team");

const scroll = el("div", "rail-scroll");
scroll.append(
	attention,
	section(convHead, convList, convNote, archivedToggle),
	teamSection,
	section(worksHead, worksList, worksNote, closedToggle),
	section(archiveHead, archiveList),
);
railBody.append(scroll, foot);

function section(head: HTMLElement, ...parts: HTMLElement[]): HTMLElement {
	const s = el("section", "rail-section");
	const id = `rail-${head.textContent?.split(" ")[0]?.toLowerCase()}`;
	const h = head.querySelector("h2")!;
	h.id = id;
	s.setAttribute("aria-labelledby", id);
	s.append(head, ...parts);
	return s;
}

function sectionHead(title: string, add?: string, onAdd?: () => void): HTMLElement {
	const head = el("div", "rail-section-head");
	head.append(el("h2", undefined, title));
	if (add && onAdd) {
		const b = el("button", "rail-add", "+");
		b.type = "button";
		b.title = add;
		b.setAttribute("aria-label", add);
		b.addEventListener("click", onAdd);
		head.append(b);
	}
	return head;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/** Shows the rail of project `projectId`, with topic `topic` (or the Archive) on screen. */
export function showRail(projectId: string, topic: string | null, archive = false): void {
	const changed = projectId !== pid;
	here = topic;
	inArchive = archive;
	if (changed) {
		gen++;
		pid = projectId;
		convs = [];
		convsRead = "loading";
		archived = null;
		showArchived = false;
		showClosed = false;
		for (const t of timers.values()) clearTimeout(t);
		timers.clear();
		dueOnShow.clear();
	}
	// Agents' state is not all pushed (runner liveness, queues): the shared
	// list is read every 15 s while a rail is shown (acpStatusFeed.ts).
	if (!unwatch) unwatch = watchAcpAgents();
	if (!agentsRead) takeAgents(acpAgentsList());
	if (!unsubscribe) {
		// The socket's first signal (open, down, or slow after ~1 s without a
		// hello) makes the first load: one per showing when the socket is quick.
		loadedSinceSub = false;
		unsubscribe = subscribeAcp((ev) => onLive(ev));
		// Everything else is polled only while the socket is down (a first
		// connection that hangs included).
		poll = setInterval(() => {
			if (!document.hidden && !acpLiveUp()) reloadAll(true);
		}, POLL_MS);
	} else if (changed) reloadAll(false);
	render();
}

/** Off screen: stop following (what it knows stays for a quick return). */
export function hideRail(): void {
	unsubscribe?.();
	unsubscribe = null;
	unwatch?.();
	unwatch = null;
	dueOnShow.clear();
	if (poll) clearInterval(poll);
	poll = null;
}

/** Logout: nothing of this account stays. */
export function resetRail(): void {
	hideRail();
	gen++;
	pid = null;
	here = null;
	inArchive = false;
	convs = [];
	convsRead = "loading";
	archived = null;
	agents = [];
	agentsRead = false;
	works = [];
	for (const t of timers.values()) clearTimeout(t);
	timers.clear();
	railHead.remove();
	railBody.remove();
}

/** The project list changed (a rename): the selector says the new name. */
export function repaintRail(): void {
	if (pid) render();
}

/** Read the project's topics again now (after a create / rename / archive here). */
export function reloadConversations(): Promise<void> {
	if (!pid) return Promise.resolve();
	const p = loadConvs(pid, gen);
	if (showArchived) void loadArchived(pid, gen);
	return p;
}

/** A topic as a write just answered it: shown at once, the list re-read after. */
export function patchConversation(c: AcpConversation): void {
	if (c.projectId !== pid) return;
	if (c.archivedAt) {
		convs = convs.filter((x) => x.id !== c.id);
		if (archived) archived = [c, ...archived.filter((x) => x.id !== c.id)];
	} else convs = [c, ...convs.filter((x) => x.id !== c.id)].sort(byActivity);
	recentsFollow(c.projectId);
	render();
}

/**
 * «Seguir…» / «Recientes» (recentTopics.ts) follow the project's live topics
 * as soon as they are known — not on the next paint, which a switch of
 * project could overtake: an archived or deleted one leaves them, a renamed
 * one is named anew. The topic on screen stays (a new one may not be listed yet).
 */
function recentsFollow(p: string): void {
	if (convsRead === "ok") pruneRecents({ pid: p, live: convs, keep: here });
}

/**
 * `agents`: the agents' list too. It is the tab's, kept by its period
 * (acpStatusFeed.ts): a first load or another project takes the list
 * already read (or the read on its way); after an outage it is read again.
 */
function reloadAll(agents: boolean): void {
	if (!pid) return;
	loadedSinceSub = true;
	soon("convs", 0);
	if (agents || !(acpAgentsList() || acpAgentsReading())) soon("agents", 0);
	soon("works", 0);
}

function soon(what: "convs" | "agents" | "works", delay = LIVE_DEBOUNCE_MS): void {
	if (!pid) return;
	// One read of the tab's shared list, for every view that asks meanwhile.
	if (what === "agents") {
		requestAcpAgentsRead(delay);
		return;
	}
	const pending = timers.get(what);
	if (pending) {
		if (delay > 0) return;
		clearTimeout(pending);
	}
	const p = pid;
	const g = gen;
	timers.set(
		what,
		setTimeout(() => {
			timers.delete(what);
			if (g !== gen) return;
			// Hidden: nothing on screen to keep current; read once when it shows.
			if (document.hidden) {
				dueOnShow.add(what);
				return;
			}
			if (what === "convs") {
				void loadConvs(p, g);
				if (showArchived) void loadArchived(p, g);
			} else void loadWorks(g);
		}, delay),
	);
}

if (typeof document !== "undefined")
	document.addEventListener("visibilitychange", () => {
		if (document.hidden || !unsubscribe) return;
		for (const what of dueOnShow) soon(what, 0);
		dueOnShow.clear();
	});

async function loadConvs(p: string, g: number): Promise<void> {
	try {
		const list = await acpConversations(p);
		if (g !== gen) return;
		convs = list;
		convsRead = "ok";
		recentsFollow(p);
	} catch {
		if (g !== gen) return;
		// A re-read that fails keeps the list already shown.
		if (convsRead !== "ok") convsRead = "error";
	}
	render();
}

async function loadArchived(p: string, g: number): Promise<void> {
	try {
		const list = await acpConversations(p, true);
		if (g === gen) archived = list;
	} catch {
		if (g === gen && archived === null) archived = [];
	}
	if (g === gen) render();
}

/** `name` is an agent of the project on screen, as last read. */
function isTeam(name: string): boolean {
	return agents.some((a) => a.name === name && a.projectId === pid);
}

/** A read of the tab's agents list landed (whoever asked for it). */
function takeAgents(all: AcpAgentInfo[] | null): void {
	if (!all) return;
	agents = all;
	agentsRead = true;
	if (pid) render();
}
onAcpAgentsRead(takeAgents);

async function loadWorks(g: number): Promise<void> {
	try {
		const all = await acpWorks();
		if (g === gen) works = all;
	} catch {
		/* keep */
	}
	if (g === gen) render();
}

function onLive(ev: Parameters<Parameters<typeof subscribeAcp>[0]>[0]): void {
	switch (ev.type) {
		case "open":
			// After its first load, an open is a reconnect: everything again.
			reloadAll(loadedSinceSub);
			return;
		case "down":
		case "slow":
			// Subscribed during an outage, the first connection failed or is slow: its first load.
			if (!loadedSinceSub) reloadAll(false);
			return;
		case "message": {
			const m = ev.message;
			// Its topic's counts and activity, and the state of an agent of this
			// project; another project's row changes nothing here (the inbox,
			// which is global, reads for itself: acpInboxStore.ts).
			const mineAgent = isTeam(m.to_id) || isTeam(m.from_id);
			const mineTopic = m.project_id === pid || convs.some((c) => c.id === m.conversation_id);
			if (mineTopic) soon("convs");
			if (mineTopic || mineAgent) soon("agents");
			if (m.context && mineAgent) soon("works");
			return;
		}
		case "question":
			if (!isTeam(ev.question.agent)) return;
			soon("agents", 0);
			soon("convs");
			return;
		case "agents":
			soon("agents", 0);
			return;
		case "conversation": {
			const c = ev.conversation;
			if (c.projectId !== pid) return;
			const prev = railConversation(c.id);
			// A frame may lack the counts: keep the list's until it is read again.
			patchConversation({
				...c,
				unread: c.unread ?? prev?.unread,
				needsAction: c.needsAction ?? prev?.needsAction,
			});
			soon("convs");
			return;
		}
		case "activity":
			return;
	}
}

/** Most recently active first (the server's order). */
function byActivity(a: AcpConversation, b: AcpConversation): number {
	return Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
}

// ── Rendering ───────────────────────────────────────────────────────────────

/** Rows kept across renders, rebuilt only when what they show changed (focus survives). */
const rows = new Map<string, { sig: string; el: HTMLElement }>();
function row(key: string, sig: unknown, build: () => HTMLElement): HTMLElement {
	const s = JSON.stringify(sig);
	let r = rows.get(key);
	if (r?.sig !== s) {
		r = { sig: s, el: build() };
		rows.set(key, r);
	}
	return r.el;
}

let renderQueued = false;
function render(): void {
	if (renderQueued) return;
	renderQueued = true;
	requestAnimationFrame(() => {
		renderQueued = false;
		paint();
		for (const l of listeners) l();
	});
}

function paint(): void {
	const p = pid;
	if (!p) return;
	const name = projectName(p) ?? "Proyecto";
	selectorName.textContent = name;
	selector.title = `${name} · cambiar de proyecto`;
	selector.setAttribute("aria-label", `Proyecto: ${name}. Cambiar de proyecto`);

	const inbox = inboxNow();
	const count = inbox?.count ?? 0;
	const results = inbox?.results.length ?? 0;
	// «N te esperan · N resultados nuevos» (fixed words); only with something to say.
	const said: string[] = [];
	if (count) said.push(`${count} ${count === 1 ? "te espera" : "te esperan"}`);
	if (results) said.push(`${results} ${results === 1 ? "resultado nuevo" : "resultados nuevos"}`);
	attention.textContent = said.join(" · ");
	attention.hidden = said.length === 0;
	attention.title = "Abrir Pendientes";

	// Conversaciones (and, on demand, the archived ones under them)
	const convRows = convs.map((c) => convRow(p, c, false));
	if (showArchived) {
		if (archived === null)
			convRows.push(row("arch-loading", 0, () => el("li", "rail-note", "Cargando…")));
		else if (archived.length === 0)
			convRows.push(
				row("arch-empty", 0, () => el("li", "rail-note", "Sin conversaciones archivadas.")),
			);
		else convRows.push(...archived.map((c) => convRow(p, c, true)));
	}
	syncChildren(convList, convRows);
	convNote.hidden = convs.length > 0;
	convNote.textContent =
		convsRead === "loading"
			? "Cargando…"
			: convsRead === "error"
				? "No se pudieron cargar las conversaciones; reintentando."
				: "Sin conversaciones todavía. Creá una con +.";
	archivedToggle.textContent = showArchived ? "Ocultar archivadas" : "Conversaciones archivadas";
	archivedToggle.setAttribute("aria-expanded", String(showArchived));

	// Equipo
	const team = agents.filter((a) => a.projectId === p);
	syncChildren(
		teamList,
		team.map((a) => {
			const st = agentState(a);
			return row(`a:${a.name}`, [a.name, a.sessionId, st], () => agentRow(a, st));
		}),
	);
	teamNote.hidden = team.length > 0;
	scroll.classList.toggle("is-team-empty", agentsRead && team.length === 0);
	teamNote.textContent = agentsRead ? "Sin agentes en este proyecto." : "Cargando…";

	// Trabajos
	const mine = works.filter((w) => w.projectId === p);
	const open = mine.filter((w) => OPEN_WORK.has(w.state));
	const closed = mine.filter((w) => !OPEN_WORK.has(w.state));
	const shownWorks = showClosed ? [...open, ...closed] : open;
	syncChildren(
		worksList,
		shownWorks.map((w) => {
			const words = workWords(w);
			return row(`w:${w.id}`, [w.id, w.agent, words], () => workRow(w, words));
		}),
	);
	worksNote.hidden = open.length > 0;
	worksNote.textContent = "Sin trabajos activos.";
	closedToggle.hidden = closed.length === 0;
	closedToggle.textContent = showClosed ? "Ocultar cerrados" : `Ver cerrados (${closed.length})`;
	closedToggle.setAttribute("aria-expanded", String(showClosed));

	// Archivo · solo lectura: what was written before topics (acpArchive.ts).
	syncChildren(archiveList, [
		row(`arch:${p}`, [p, inArchive], () => {
			const li = el("li");
			const a = el("a", "rail-row rail-archive-row");
			a.href = projectRouteHash({ projectId: p, page: "archive" });
			if (inArchive) a.setAttribute("aria-current", "page");
			const text = el("span", "rail-row-text");
			text.append(el("span", "rail-row-title", "Project Chat y chats individuales"));
			a.append(text);
			a.addEventListener("click", (e) => {
				if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
				e.preventDefault();
				navigateProject({ projectId: p, page: "archive" });
			});
			li.append(a);
			return li;
		}),
	]);
}

const OPEN_WORK = new Set(["creating", "active", "closing"]);

function workWords(w: AcpWork): string {
	if (w.state === "creating") return "creándose";
	if (w.state !== "active") return w.state === "cleaned" ? "limpiado" : "cerrado";
	const runs = agents.find((a) => a.name === w.agent)?.runningIn?.some((r) => r.work === w.id);
	return runs ? "en curso" : "activo";
}

function convRow(p: string, c: AcpConversation, isArchived: boolean): HTMLElement {
	const status = isArchived ? null : convStatus(c);
	const current = c.id === here;
	return row(`c:${c.id}`, [c.title, c.unread ?? 0, status, current, isArchived], () => {
		const li = el("li");
		const a = el("a", `rail-row rail-conv${isArchived ? " is-archived" : ""}`);
		a.href = projectRouteHash({ projectId: p, page: "conversation", conversationId: c.id });
		a.dataset.conversation = c.id;
		if (current) a.setAttribute("aria-current", "page");
		const unread = c.unread ?? 0;
		if (unread > 0) a.classList.add("has-unread");
		const text = el("span", "rail-row-text");
		const title = el("span", "rail-row-title", c.title);
		title.title = c.title;
		text.append(title);
		if (status) text.append(el("span", `rail-row-sub tone-${status.tone}`, status.label));
		else if (isArchived) text.append(el("span", "rail-row-sub", "archivada"));
		a.append(text);
		if (unread > 0) {
			const badge = el("span", "rail-unread", unread > 99 ? "99+" : String(unread));
			badge.setAttribute("aria-hidden", "true");
			a.append(badge, el("span", "visually-hidden", `, ${unread} sin leer`));
		}
		a.addEventListener("click", (e) => {
			if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
			e.preventDefault();
			navigateProject({ projectId: p, page: "conversation", conversationId: c.id });
		});
		li.append(a);
		return li;
	});
}

/**
 * What a topic's row says under its title: who is waiting on the person
 * there, an interruption to review, who works there now; else nothing.
 */
function convStatus(c: AcpConversation): { label: string; tone: string } | null {
	if (agents.some((a) => a.question?.conversationId === c.id))
		return { label: "espera tu decisión", tone: "warn" };
	if (inboxNow()?.action.interrupted.some((m) => m.conversation_id === c.id))
		return { label: "ejecución interrumpida", tone: "err" };
	const working = agents
		.filter((a) => a.runningIn?.some((r) => r.conversationId === c.id))
		.map((a) => `@${a.name}`);
	if (working.length) return { label: `${working.join(", ")} trabajando…`, tone: "busy" };
	return null;
}

function agentRow(a: AcpAgentInfo, st: TeamState): HTMLElement {
	const li = el("li", "rail-agent-item");
	li.style.setProperty("--acp-hue", String(agentHue(a.name)));
	// Two targets, siblings: the row opens the agent's Terminal (the same
	// Herramientas route as before: the page stays mounted under it), its ⋯
	// the rest of its menu.
	const link = el("button", "rail-row rail-agent");
	link.type = "button";
	link.dataset.agent = a.name;
	link.addEventListener("click", () => actions?.openTerminal(a.name));
	link.title = "Abrir Terminal";
	// The initial is drawn by CSS (like a sidebar row's face): as text it
	// would be a word of the row its accessible name does not start with.
	const face = el("span", "acp-avatar rail-face");
	face.dataset.initial = a.name.slice(0, 1).toUpperCase();
	face.setAttribute("aria-hidden", "true");
	face.append(el("span", `rail-dot tone-${st.tone}`));
	const text = el("span", "rail-row-text");
	const line = stateLine(st);
	// The space is a word break for whoever reads the text (axe joins the two
	// lines without it); a flex column does not render it.
	text.append(el("span", "rail-row-title", `@${a.name}`), " ", line);
	link.append(face, text);
	// The words on the row first (a voice user says what they see), then what it does.
	link.setAttribute("aria-label", `@${a.name} ${line.textContent ?? ""} — abrir Terminal`);
	const more = el("button", "rail-agent-more", "⋯");
	more.type = "button";
	more.setAttribute("aria-label", `Más acciones de @${a.name}`);
	more.setAttribute("aria-haspopup", "menu");
	more.title = `Más acciones de @${a.name}`;
	more.addEventListener("click", () => actions?.agentMenu(a.name, more));
	li.append(link, more);
	return li;
}

/**
 * The state's line: when it names a topic, only the topic's title gives way
 * (an ellipsis inside «…»); what follows it — «· 1 en cola» — always shows.
 */
function stateLine(st: { label: string; tone: string; short?: string }): HTMLElement {
	const sub = el("span", `rail-row-sub rail-state tone-${st.tone}`);
	// The whole state where the rail says less (a held slot: «ocupado»).
	sub.title = st.label;
	const words = st.short ?? st.label;
	const m = /^(.*?«)(.+)(»)(.*)$/.exec(words);
	if (!m) {
		sub.textContent = words;
		return sub;
	}
	sub.append(
		el("span", "rail-state-fixed", m[1]!),
		el("span", "rail-state-topic", m[2]!),
		el("span", "rail-state-fixed", `${m[3]}${m[4]}`),
	);
	return sub;
}

function workRow(w: AcpWork, words: string): HTMLElement {
	const li = el("li");
	// Its workspace in Herramientas (its Git first: what the work changed).
	const b = el("button", "rail-row rail-work");
	b.type = "button";
	b.dataset.work = w.id;
	b.title = `Abrir el trabajo ${w.id} en Herramientas`;
	b.addEventListener("click", () => actions?.openWork(w));
	const text = el("span", "rail-row-text");
	text.append(
		el("span", "rail-row-title rail-mono", w.id),
		el("span", `rail-row-sub${words === "en curso" ? " tone-busy" : ""}`, `@${w.agent} · ${words}`),
	);
	b.append(text);
	li.append(b);
	return li;
}

function openSelector(): void {
	const current = pid;
	if (!current || !actions) return;
	const a = actions;
	// «Recientes» (revisión 2 §7): up to 3 other topics / Herramientas.
	const recent = offered().slice(0, 3);
	openActionMenu({
		title: "Proyectos",
		caption: recent.length ? "Recientes" : "Cambiar de proyecto",
		opener: selector,
		// Wide: under the rail's head. A phone places it under the app's header.
		anchor: railHead,
		items: [
			...recent.map((e, i) => ({ id: `r:${i}`, label: recentLabel(e) })),
			...projects().map((p, i) => {
				// The sidebar row's dot and pill, painted on a holder the menu adopts.
				const holder = document.createElement("span");
				const said = paintProjectSignals(holder, projectSignals(p.projectId));
				const leading = holder.querySelector(".psig-dot") ?? undefined;
				const trailing = holder.querySelector(".psig-end") ?? undefined;
				return {
					id: `p:${p.projectId}`,
					label: p.name,
					...(i === 0 && recent.length ? { sepBefore: true, heading: "Cambiar de proyecto" } : {}),
					radio: { checked: p.projectId === current },
					leading,
					trailing,
					scroll: true,
					ariaLabel: `${p.name}${said}`,
				};
			}),
			{ id: "new", label: "+ Proyecto nuevo", sepBefore: true },
			{ id: "rename", label: "Renombrar…" },
			{ id: "archive", label: "Archivar proyecto…", kind: "danger", sepBefore: true },
		],
		onPick: (id) => {
			if (id === "new") a.newProject();
			else if (id === "rename") a.renameProject(current);
			else if (id === "archive") a.archiveProject(current);
			else if (id.startsWith("r:")) {
				const e = recent[Number(id.slice(2))];
				if (e) openRecent(e);
			} else if (id.startsWith("p:") && id.slice(2) !== current)
				navigateProject({ projectId: id.slice(2) });
		},
	});
}
