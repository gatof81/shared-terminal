// projectRail.ts — the project's rail (3B F1, PROPUESTA §2): the project
// selector ▾ and Pendientes (its count; the inbox itself is F3), the
// attention row, the topics (Conversaciones: create, unread per topic),
// the team with each agent's state in the seven fixed words (Equipo), the
// works (Trabajos: active ones; closed ones on demand), the Archive's entry
// and a foot with the sessions and the settings.
//
// One rail, for the project on screen: projectsView.ts places its two parts
// (`railHead`, `railBody`) in the sidebar on a wide screen, and on a phone
// the head in the app's header and the body as the project's own screen.
// Data: the project's topics, the agents, the works and the inbox over REST,
// kept current by /ws/acp (acpLive.ts: one socket for the tab), re-read
// debounced; while the socket is down, a slow poll.

import { acpLiveUp, subscribeAcp } from "./acpLive.js";
import { agentHue, teamState } from "./acpModel.js";
import { acpReadTicket, setAcpAgents } from "./acpRegistry.js";
import {
	type AcpAgentInfo,
	type AcpConversation,
	type AcpInbox,
	type AcpWork,
	acpConversations,
	acpInbox,
	acpListAgents,
	acpWorks,
} from "./api.js";
import { openActionMenu } from "./components/actionMenu.js";
import { projectName, projects } from "./projectDirectory.js";
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
	sessions: (opener: HTMLElement) => void;
	settings: (opener: HTMLElement) => void;
	/** An agent's menu: Files · Git · Terminal · its works (toolsView.ts). */
	agentMenu: (name: string, opener: HTMLElement) => void;
	/** A work's row: Herramientas on that work. */
	openWork: (work: AcpWork) => void;
}

let actions: RailActions | null = null;

export function configureRail(a: RailActions): void {
	actions = a;
}

// ── State ───────────────────────────────────────────────────────────────────

let pid: string | null = null;
/** The topic on screen («trabajando aquí»; its row is the current one). */
let here: string | null = null;
let gen = 0;
let convs: AcpConversation[] = [];
let convsRead: "loading" | "ok" | "error" = "loading";
let archived: AcpConversation[] | null = null;
let showArchived = false;
let agents: AcpAgentInfo[] = [];
let agentsRead = false;
let works: AcpWork[] = [];
let showClosed = false;
let inbox: AcpInbox | null = null;
let unsubscribe: (() => void) | null = null;
let poll: ReturnType<typeof setInterval> | null = null;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners: Array<() => void> = [];

/** Told after every change of what the rail knows (the topic's header uses it). */
export function onRailChange(fn: () => void): void {
	listeners.push(fn);
}

export function railAgents(): readonly AcpAgentInfo[] {
	return agents;
}

/** Every work of the owner's agents, as last read (Herramientas' workspaces). */
export function railWorks(): readonly AcpWork[] {
	return works;
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
	return inbox?.action.interrupted.some((m) => m.to_id === agent) ?? false;
}

/** An agent's state in the fixed words, as of now, with `here` the topic on screen. */
export function agentState(a: AcpAgentInfo): { label: string; tone: string } {
	return teamState(a, { here, titleOf: topicTitle, interrupted: interrupted(a.name) });
}

// ── Elements ────────────────────────────────────────────────────────────────

export const railHead = el("div", "rail-head");
export const railBody = el("nav", "rail-body");
railBody.setAttribute("aria-label", "Proyecto");

const selector = el("button", "rail-project");
selector.type = "button";
selector.setAttribute("aria-haspopup", "menu");
const selectorName = el("span", "rail-project-name");
const caret = el("span", "rail-project-caret", "▾");
caret.setAttribute("aria-hidden", "true");
selector.append(selectorName, caret);
selector.addEventListener("click", () => openSelector());

// Pendientes: its icon and count. The inbox panel arrives in F3; until then
// it says the count and nothing more (not a control that does nothing).
const inboxEl = el("span", "rail-inbox");
inboxEl.setAttribute("role", "img");
inboxEl.append(inboxIcon(), el("span", "rail-inbox-count"));
railHead.append(selector, inboxEl);

const attention = el("p", "rail-attention");
attention.hidden = true;

const convHead = sectionHead("Conversaciones", "Nueva conversación", () => {
	if (pid) actions?.newConversation(pid);
});
const convList = el("ul", "rail-list rail-convs");
const convNote = el("p", "rail-note");
const archivedToggle = el("button", "rail-more", "Ver archivadas");
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

const foot = el("div", "rail-foot");
const sessionsBtn = el("button", "rail-foot-btn", "Sesiones");
sessionsBtn.type = "button";
sessionsBtn.addEventListener("click", () => actions?.sessions(sessionsBtn));
const settingsBtn = el("button", "rail-foot-btn", "Ajustes");
settingsBtn.type = "button";
settingsBtn.addEventListener("click", () => actions?.settings(settingsBtn));
foot.append(sessionsBtn, el("span", "rail-foot-sep", "·"), settingsBtn);

const scroll = el("div", "rail-scroll");
scroll.append(
	attention,
	section(convHead, convList, convNote, archivedToggle),
	section(teamHead, teamList, teamNote),
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

function inboxIcon(): SVGElement {
	const ns = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(ns, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("aria-hidden", "true");
	const p = document.createElementNS(ns, "path");
	p.setAttribute("d", "M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5");
	svg.append(p);
	return svg;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/** Shows the rail of project `projectId`, with topic `topic` on screen (or none). */
export function showRail(projectId: string, topic: string | null): void {
	const changed = projectId !== pid;
	here = topic;
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
	}
	if (!unsubscribe) {
		unsubscribe = subscribeAcp((ev) => onLive(ev));
		poll = setInterval(() => {
			if (document.hidden) return;
			// Agents' state is not all pushed (runner liveness, queues): read it
			// on a budget; everything else only while the socket is down.
			soon("agents", 0);
			if (!acpLiveUp()) reloadAll();
		}, POLL_MS);
	}
	if (changed) reloadAll();
	render();
}

/** Off screen: stop following (what it knows stays for a quick return). */
export function hideRail(): void {
	unsubscribe?.();
	unsubscribe = null;
	if (poll) clearInterval(poll);
	poll = null;
}

/** Logout: nothing of this account stays. */
export function resetRail(): void {
	hideRail();
	gen++;
	pid = null;
	here = null;
	convs = [];
	convsRead = "loading";
	archived = null;
	agents = [];
	agentsRead = false;
	works = [];
	inbox = null;
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
	render();
}

function reloadAll(): void {
	if (!pid) return;
	void loadConvs(pid, gen);
	if (showArchived) void loadArchived(pid, gen);
	soon("agents", 0);
	soon("works", 0);
	soon("inbox", 0);
}

function soon(what: "convs" | "agents" | "works" | "inbox", delay = LIVE_DEBOUNCE_MS): void {
	if (timers.has(what) || !pid) return;
	const p = pid;
	const g = gen;
	timers.set(
		what,
		setTimeout(() => {
			timers.delete(what);
			if (what === "convs") void loadConvs(p, g);
			else if (what === "agents") void loadAgents(g);
			else if (what === "works") void loadWorks(g);
			else void loadInbox(g);
		}, delay),
	);
}

async function loadConvs(p: string, g: number): Promise<void> {
	try {
		const list = await acpConversations(p);
		if (g !== gen) return;
		convs = list;
		convsRead = "ok";
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

async function loadAgents(g: number): Promise<void> {
	try {
		const ticket = acpReadTicket();
		const all = await acpListAgents();
		setAcpAgents(all, ticket);
		if (g !== gen) return;
		agents = all;
		agentsRead = true;
	} catch {
		/* keep */
	}
	if (g === gen) render();
}

async function loadWorks(g: number): Promise<void> {
	try {
		const all = await acpWorks();
		if (g === gen) works = all;
	} catch {
		/* keep */
	}
	if (g === gen) render();
}

async function loadInbox(g: number): Promise<void> {
	try {
		const box = await acpInbox();
		if (g === gen) inbox = box;
	} catch {
		/* keep */
	}
	if (g === gen) render();
}

function onLive(ev: Parameters<Parameters<typeof subscribeAcp>[0]>[0]): void {
	switch (ev.type) {
		case "open":
			reloadAll();
			return;
		case "down":
			return;
		case "message": {
			const m = ev.message;
			// Its topic's counts and activity, the agents' state and the inbox
			// (a result, an interruption) — whatever project it is in: the inbox is global.
			if (m.project_id === pid || convs.some((c) => c.id === m.conversation_id)) soon("convs");
			soon("agents");
			soon("inbox");
			if (m.context) soon("works");
			return;
		}
		case "question":
			soon("agents", 0);
			soon("inbox", 0);
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

	const count = inbox?.count ?? 0;
	const results = inbox?.results.length ?? 0;
	const countEl = inboxEl.querySelector<HTMLElement>(".rail-inbox-count")!;
	countEl.textContent = count > 99 ? "99+" : count > 0 ? String(count) : "";
	countEl.hidden = count === 0;
	inboxEl.setAttribute("aria-label", count ? `Pendientes: ${count}` : "Pendientes: nada pendiente");
	inboxEl.title = count ? `Pendientes: ${count}` : "Nada pendiente";
	// «N te esperan · N resultados nuevos» (fixed words); only with something to say.
	const said: string[] = [];
	if (count) said.push(`${count} ${count === 1 ? "te espera" : "te esperan"}`);
	if (results) said.push(`${results} ${results === 1 ? "resultado nuevo" : "resultados nuevos"}`);
	attention.textContent = said.join(" · ");
	attention.hidden = said.length === 0;

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
	archivedToggle.textContent = showArchived ? "Ocultar archivadas" : "Ver archivadas";
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

	// Archivo · solo lectura: the previous Project Chat (its content moves here in F5).
	syncChildren(archiveList, [
		row(`arch:${p}`, p, () => {
			const li = el("li");
			const a = el("a", "rail-row rail-archive-row");
			a.href = projectRouteHash({ projectId: p, page: "chat" });
			const text = el("span", "rail-row-text");
			text.append(
				el("span", "rail-row-title", "Project Chat anterior"),
				el("span", "rail-row-sub", "Lo escrito antes de los temas"),
			);
			a.append(text);
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
	if (inbox?.action.interrupted.some((m) => m.conversation_id === c.id))
		return { label: "ejecución interrumpida", tone: "err" };
	const working = agents
		.filter((a) => a.runningIn?.some((r) => r.conversationId === c.id))
		.map((a) => `@${a.name}`);
	if (working.length) return { label: `${working.join(", ")} trabajando…`, tone: "busy" };
	return null;
}

function agentRow(a: AcpAgentInfo, st: { label: string; tone: string }): HTMLElement {
	const li = el("li");
	// Its menu: Files · Git · Terminal of its session, and its works (F4).
	const link = el("button", "rail-row rail-agent");
	link.type = "button";
	link.setAttribute("aria-haspopup", "menu");
	link.addEventListener("click", () => actions?.agentMenu(a.name, link));
	link.style.setProperty("--acp-hue", String(agentHue(a.name)));
	link.title = `Herramientas de @${a.name}`;
	const face = el("span", "acp-avatar rail-face", a.name.slice(0, 1).toUpperCase());
	face.setAttribute("aria-hidden", "true");
	face.append(el("span", `rail-dot tone-${st.tone}`));
	const text = el("span", "rail-row-text");
	text.append(
		el("span", "rail-row-title", `@${a.name}`),
		el("span", `rail-row-sub tone-${st.tone}`, st.label),
	);
	link.append(face, text);
	li.append(link);
	return li;
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
	openActionMenu({
		title: "Proyectos",
		opener: selector,
		items: [
			...projects().map((p) => ({
				id: `p:${p.projectId}`,
				label: p.name,
				hint: p.projectId === current ? "el proyecto abierto" : undefined,
			})),
			{ id: "new", label: "+ Proyecto nuevo…" },
			{ id: "rename", label: "Renombrar este proyecto" },
			{
				id: "archive",
				label: "Archivar este proyecto",
				kind: "danger",
				hint: "No se puede deshacer desde la app; el historial sigue legible.",
			},
		],
		onPick: (id) => {
			if (id === "new") a.newProject();
			else if (id === "rename") a.renameProject(current);
			else if (id === "archive") a.archiveProject(current);
			else if (id.startsWith("p:") && id.slice(2) !== current)
				navigateProject({ projectId: id.slice(2) });
		},
	});
}
