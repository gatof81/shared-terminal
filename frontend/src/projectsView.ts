/**
 * projectsView.ts — Projects & Agents, P3a (docs/PROJECTS.md; design 15 §4
 * D-UX2/D-UX7/D-UX9, 16 §4): the sidebar's Projects section, the project
 * page (`#/projects/<pid>`: the agent directory), the agent page
 * (`#/projects/<pid>/agents/<aid>`) and the two creation dialogs.
 *
 * Nothing here exists unless `/auth/status` reported `features.projectChat`
 * (api.projectChatEnabled): with the feature absent this module renders
 * nothing, sends nothing and leaves the session router exactly as it was.
 *
 * The pages are shown OVER the session workbench, never instead of it: the
 * terminal area's other children only turn `visibility: hidden` (layout
 * kept), so the terminal is neither resized nor detached, and its socket
 * stays open — the terminal invariant (viewSwitch.ts) holds across a trip
 * to a project page and back. Binding a session changes nothing about it
 * (rule 8): its views, storage keys and links are the session's own.
 *
 * Data: owner-only reads, polled at most every 5 s and only while a page is
 * on screen and the tab visible, one request in flight per resource; every
 * answer is dropped when it belongs to an earlier account (api.ts
 * `projectRequest` → "stale"), and logout clears every cache.
 */

import {
	type AgentDetail,
	type AgentListEntry,
	type AgentsResponse,
	type Allowed,
	createAgent,
	createProject,
	fetchAgent,
	fetchProjectAgents,
	fetchProjects,
	isLoggedIn,
	type ProjectAnswer,
	projectChatEnabled,
	removeAgent,
	type SessionInfo,
} from "./api.js";
import { confirmDialog, createDialog } from "./components/dialog.js";
import { showToast } from "./components/toast.js";
import { relativeDate } from "./format.js";
import { sessions } from "./main.js";
import {
	clearProjects,
	projectName,
	projects,
	projectsLoaded,
	setProjects,
} from "./projectDirectory.js";
import {
	agentCountText,
	bindableSessions,
	CreationAttempt,
	classifyCreation,
	type PresenceView,
	pageTitle,
	presenceSummary,
	presentPresence,
	projectErrorText,
	providerText,
	refusalText,
	retireReasonText,
	type ServerClock,
	serverNow,
	validateHandle,
	validateProjectName,
	validateRole,
} from "./projectModel.js";
import {
	disableProjectRoutes,
	enableProjectRoutes,
	navigateProject,
	onAddressWrite,
	type ProjectRoute,
	projectRouteHash,
	pushSessionAddress,
	readProjectRoute,
	routeHash,
} from "./router.js";
import {
	refreshSessions,
	renderSessionList,
	runSessionAction,
	sessionListLoaded,
} from "./sessionCore.js";
import { setTitlePage } from "./tabTitle.js";
import { button, el, stateBox } from "./ui.js";
import { readLastConversation, readLastConversationTitle } from "./viewPolicy.js";

// ── DOM ─────────────────────────────────────────────────────────────────────

const section = document.getElementById("project-section");
const projectList = document.getElementById("project-list");
const newProjectBtn = document.getElementById("new-project-btn") as HTMLButtonElement | null;
const pageEl = document.getElementById("project-view");
const terminalArea = document.getElementById("terminal-area");

// ── State ───────────────────────────────────────────────────────────────────

interface Loadable<T> {
	data: T | null;
	/** The last failure; cleared by the next success. Data already shown stays. */
	error: { status: number; code: string } | null;
	inFlight: Promise<void> | null;
	/** The browser's clock when `data` arrived (presence ages from it, projectModel ServerClock). */
	receivedAt: number | null;
}

const blank = <T>(): Loadable<T> => ({ data: null, error: null, inFlight: null, receivedAt: null });

let active = false; // feature on + signed in + app shown
let shown: ProjectRoute | null = null;
// Bumped by every reset (logout): a load started before it applies nothing.
let gen = 0;

let projectsState: Loadable<{ can: Allowed }> = blank();
// Keyed by ids in Maps (server strings: never `obj[id]`).
let agentLists = new Map<string, Loadable<AgentsResponse>>();
let agentDetails = new Map<string, Loadable<AgentDetail>>();
// The server clock of the last agents list received, from any project: an
// agent's own answer (§4.5) carries no `generatedAt`, and a clock offset
// does not age, so this is what places "now" for it.
let lastClock: ServerClock | null = null;
// Open creation/removal dialogs: closed on logout so nothing of this
// account survives behind the login view.
const openDialogs = new Set<{ close(): void }>();
// Sessions whose start this page asked for and whose answer hasn't landed:
// their Start button stays disabled (one click, one POST).
const starting = new Set<string>();

const detailKey = (pid: string, aid: string) => `${pid}\n${aid}`;

function entry<T>(map: Map<string, Loadable<T>>, key: string): Loadable<T> {
	let e = map.get(key);
	if (!e) {
		e = blank<T>();
		map.set(key, e);
	}
	return e;
}

/**
 * One request in flight per resource. `fresh`: the caller needs an answer
 * that was REQUESTED after now (rule 4: after a refusal that followed a 503,
 * the list must be re-read — an answer already on its way may predate the
 * lost write landing), so an in-flight one is awaited and another is sent.
 */
async function load<T>(
	state: Loadable<T>,
	fetcher: () => Promise<ProjectAnswer<T>>,
	fresh = false,
): Promise<void> {
	for (let pending = state.inFlight; pending !== null; pending = state.inFlight) {
		if (!fresh) return pending;
		await pending.catch(() => {});
	}
	const myGen = gen;
	const p = (async () => {
		const answer = await fetcher();
		if (myGen !== gen || !active) return;
		if (answer.ok) {
			state.data = answer.body;
			state.receivedAt = Date.now();
			state.error = null;
		} else if (answer.code !== "stale") {
			state.error = { status: answer.status, code: answer.code };
		}
	})();
	state.inFlight = p;
	try {
		await p;
	} finally {
		if (state.inFlight === p) state.inFlight = null;
	}
}

async function loadProjects(fresh = false): Promise<void> {
	const state = projectsState;
	await load(
		state,
		async () => {
			const a = await fetchProjects();
			// The sidebar's session rows name their agent's project
			// ("@handle · <project>"): re-render them now rather than on
			// their own next poll, up to 5 s later. Before the session list
			// has loaded there is nothing to re-render (and rendering then
			// would replace its loading state with an empty list).
			if (a.ok && setProjects(a.body.projects) && sessionListLoaded()) renderSessionList();
			return a.ok ? { ...a, body: { can: a.body.can.createProject } } : a;
		},
		fresh,
	).catch(() => {});
	if (state !== projectsState) return;
	renderSection();
	if (shown) renderPage();
}

async function loadAgents(pid: string, fresh = false): Promise<void> {
	const state = entry(agentLists, pid);
	await load(state, () => fetchProjectAgents(pid), fresh).catch(() => {});
	const clock = listClock(state);
	if (clock && (lastClock === null || clock.receivedAt >= lastClock.receivedAt)) lastClock = clock;
	// The agent page reads its server clock from this list too.
	if (shown?.projectId === pid) renderPage();
}

function listClock(state: Loadable<AgentsResponse> | undefined): ServerClock | null {
	if (!state?.data || state.receivedAt === null) return null;
	return { generatedAt: state.data.generatedAt, receivedAt: state.receivedAt };
}

async function loadAgent(pid: string, aid: string, fresh = false): Promise<void> {
	const state = entry(agentDetails, detailKey(pid, aid));
	await load(state, () => fetchAgent(pid, aid), fresh).catch(() => {});
	if (shown?.projectId === pid && shown.agentId === aid) renderPage();
}

/** Re-read what the current page shows (and its project's list, for counts). */
function loadShown(fresh = false): Promise<unknown> {
	const r = shown;
	if (!r) return Promise.resolve();
	if (r.agentId === null) return loadAgents(r.projectId, fresh);
	// Without any list answer yet there is no server time to age the
	// agent's evidence against: its project's list, once per project (not
	// polled — until it lands, a live claim reads "State unknown").
	if (lastClock === null && !agentLists.has(r.projectId)) void loadAgents(r.projectId);
	return loadAgent(r.projectId, r.agentId, fresh);
}

// ── Sidebar section ─────────────────────────────────────────────────────────

function renderSection(): void {
	if (!section || !projectList) return;
	section.hidden = !active;
	if (!active) {
		projectList.replaceChildren();
		return;
	}
	const can = projectsState.data?.can ?? null;
	if (newProjectBtn) {
		newProjectBtn.disabled = can !== null && !can.allowed;
		newProjectBtn.title =
			can && !can.allowed ? refusalText(can.reason) : "Create a project for your agents";
	}
	const focusedId = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
		"#project-list .project-item",
	)?.dataset.projectId;
	projectList.replaceChildren();
	const list = projects();
	if (!projectsLoaded()) {
		const p = el(
			"p",
			"project-list-note",
			projectsState.error ? "Couldn't load projects — retrying." : "Loading projects…",
		);
		projectList.appendChild(p);
		return;
	}
	if (projectsState.error) {
		projectList.appendChild(
			el("p", "project-list-note", "Couldn't refresh — showing the last list."),
		);
	}
	if (list.length === 0) {
		projectList.appendChild(
			el("p", "project-list-note", "No projects yet. A project groups agents and their sessions."),
		);
		return;
	}
	for (const p of list) {
		const a = el("a", "project-item");
		a.dataset.projectId = p.projectId;
		const route: ProjectRoute = { projectId: p.projectId, agentId: null };
		a.href = projectRouteHash(route);
		if (shown?.projectId === p.projectId) a.setAttribute("aria-current", "page");
		a.appendChild(el("span", "project-item-name", p.name));
		a.appendChild(el("span", "project-item-count", agentCountText(p.agentCount)));
		a.addEventListener("click", (e) => {
			if (!plainClick(e)) return;
			e.preventDefault();
			navigateProject(route);
		});
		projectList.appendChild(a);
	}
	if (focusedId !== undefined) {
		projectList
			.querySelector<HTMLElement>(`.project-item[data-project-id="${CSS.escape(focusedId)}"]`)
			?.focus();
	}
}

function plainClick(e: MouseEvent): boolean {
	return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

// ── Page shell ──────────────────────────────────────────────────────────────

function sync(): void {
	const r = active ? readProjectRoute() : null;
	if (r === null) {
		hidePage();
		return;
	}
	const changed = shown === null || shown.projectId !== r.projectId || shown.agentId !== r.agentId;
	shown = r;
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
		pageEl.scrollTop = 0;
		void loadShown();
		if (!projectsLoaded()) void loadProjects();
	}
}

function hidePage(): void {
	if (shown === null && pageEl?.hidden !== false) return;
	shown = null;
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

// Re-rendered on every poll: keep the keyboard user's place (by data-key).
function renderPage(): void {
	if (!pageEl || !shown) return;
	const focusKey = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
		"#project-view [data-key]",
	)?.dataset.key;
	const scroll = pageEl.scrollTop;
	const content =
		shown.agentId === null
			? renderProjectPage(shown.projectId)
			: renderAgentPage(shown.projectId, shown.agentId);
	pageEl.replaceChildren(content);
	pageEl.scrollTop = scroll;
	if (focusKey !== undefined) {
		pageEl.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)?.focus({
			preventScroll: true,
		});
	}
}

function pageHeader(
	title: string,
	back: HTMLElement | null,
	...actions: HTMLElement[]
): HTMLElement {
	const header = el("div", "pv-header");
	if (back) header.appendChild(back);
	const h = el("h2", "pv-title", title);
	h.id = "pv-title";
	h.tabIndex = -1;
	h.dataset.key = "title";
	header.appendChild(h);
	const tools = el("div", "pv-tools");
	for (const a of actions) tools.appendChild(a);
	const close = button("×", "pv-close", leavePage, "Close the project page");
	close.dataset.key = "close";
	tools.appendChild(close);
	header.appendChild(tools);
	return header;
}

function page(...children: HTMLElement[]): HTMLElement {
	const root = el("div", "pv-page");
	root.setAttribute("role", "region");
	root.setAttribute("aria-labelledby", "pv-title");
	for (const c of children) root.appendChild(c);
	return root;
}

/**
 * "Back to Projects": there is no projects index page — the list lives in
 * the sidebar — so leave the page for the session underneath and put the
 * keyboard on that list (opening the mobile drawer when it is closed).
 */
function backToProjects(): void {
	leavePage();
	const list = document.getElementById("project-list");
	const target = list?.querySelector<HTMLElement>(".project-item") ?? newProjectBtn;
	if (!target) return;
	if (target.getClientRects().length === 0) document.getElementById("sidebar-toggle")?.click();
	target.focus();
}

function projectNotFoundPage(): HTMLElement {
	const back = button("Back to Projects", "pv-btn", backToProjects);
	back.dataset.key = "back-projects";
	return page(
		pageHeader("Project not found", null),
		stateBox(
			"info",
			"This project doesn't exist or isn't yours — the link may be wrong, or it belongs to another account.",
			back,
		),
	);
}

function sessionOf(sessionId: string): SessionInfo | undefined {
	return sessions.find((s) => s.sessionId === sessionId);
}

/** A link to the session's existing workbench (`#/sessions/<sid>`), named if known. */
function sessionLink(sessionId: string, key: string): HTMLElement {
	const s = sessionOf(sessionId);
	const a = el("a", "pv-session-link");
	a.href = routeHash({ sessionId, view: null, detail: null });
	a.dataset.key = key;
	if (s) {
		const dot = el("span", `session-dot ${s.status}`);
		dot.setAttribute("aria-hidden", "true");
		a.appendChild(dot);
		a.appendChild(el("span", undefined, s.name));
		a.appendChild(el("span", "pv-muted", ` · ${s.status}`));
		a.title = `Open the session ${s.name}`;
	} else {
		// Not in the sidebar's list (terminated and hidden, or gone): the id
		// says which, and the session route answers for it.
		a.appendChild(el("span", undefined, `Session ${sessionId.slice(0, 8)}`));
		a.title = "Open this session";
	}
	return a;
}

/**
 * One tap from an agent to its session's Chat or Terminal (and, when this
 * browser remembers one, straight to the last conversation it opened
 * there). Plain links to the session's own routes: the browser pushes the
 * entry, so Back returns to this page (router.ts: a view the person chose
 * is a push), and the session opens exactly as from its sidebar row.
 */
function sessionActions(sessionId: string, keyPrefix: string): HTMLElement {
	const s = sessionOf(sessionId);
	const name = s?.name ?? `Session ${sessionId.slice(0, 8)}`;
	const row = el("div", "pv-session-actions");
	const link = (label: string, cls: string, hash: string, key: string, title: string) => {
		const a = el("a", cls, label);
		a.href = hash;
		a.dataset.key = `${keyPrefix}:${key}`;
		a.title = title;
		row.appendChild(a);
		return a;
	};
	link(
		"Chat",
		"pv-btn pv-open-chat",
		routeHash({ sessionId, view: "chat", detail: null }),
		"chat",
		`Open the Chat of ${name}`,
	);
	link(
		"Terminal",
		"pv-btn pv-open-terminal",
		routeHash({ sessionId, view: "terminal", detail: null }),
		"terminal",
		`Open the Terminal of ${name}`,
	);
	// Same memory and same rule as the sidebar's "↳ last conversation":
	// what Chat remembered in this browser, no request; never for a failed
	// session.
	const cid = s?.status === "failed" ? null : readLastConversation(sessionId);
	const title = cid ? readLastConversationTitle(sessionId, cid) : null;
	if (cid && title) {
		const last = link(
			`↳ ${title}`,
			"pv-last-conv",
			routeHash({ sessionId, view: "chat", detail: cid }),
			"last-conv",
			`Open the last conversation: ${title}`,
		);
		last.setAttribute("aria-label", `Open the last conversation in ${name}: ${title}`);
	}
	return row;
}

/**
 * PROJECTS.md §5: `disconnected · session-stopped` is the one state a
 * click can fix. Offered only while the sidebar's row agrees the session
 * is stopped (after a start the row reads `running` before the presence
 * does), and never pressed for the person.
 */
function startSessionButton(
	presence: AgentListEntry["presence"],
	sessionId: string,
	key: string,
): HTMLElement | null {
	if (presence.value !== "disconnected" || presence.detail !== "session-stopped") return null;
	const s = sessionOf(sessionId);
	if (!s || s.status !== "stopped") return null;
	const inFlight = starting.has(sessionId);
	const b = button(inFlight ? "Starting…" : "Start session", "pv-btn pv-primary pv-start", () => {
		void startFromPage(s);
	});
	b.dataset.key = key;
	b.disabled = inFlight;
	if (inFlight) b.setAttribute("aria-busy", "true");
	return b;
}

async function startFromPage(s: SessionInfo): Promise<void> {
	if (starting.has(s.sessionId)) return;
	const myGen = gen;
	starting.add(s.sessionId);
	renderPage();
	try {
		// The sidebar's own verb: same request, same toasts (errors
		// included), same list refresh.
		await runSessionAction(s, "start");
		if (myGen === gen) await loadShown(true);
	} finally {
		starting.delete(s.sessionId);
		if (myGen === gen) renderPage();
	}
}

function presenceBlock(v: PresenceView, compact: boolean): HTMLElement {
	const box = el("div", `pv-presence-block${compact ? " compact" : ""}`);
	const chip = el("span", `pv-presence tone-${v.tone}`);
	const dot = el("span", "pv-presence-dot");
	dot.setAttribute("aria-hidden", "true");
	chip.appendChild(dot);
	chip.appendChild(el("span", undefined, v.label));
	box.appendChild(chip);
	const why = v.reason ? `${v.reason} · ${v.evidence}` : v.evidence;
	box.appendChild(el("span", "pv-evidence", why));
	return box;
}

function allowedButton(
	label: string,
	can: Allowed | null,
	onClick: () => void,
	key: string,
): HTMLElement {
	const wrap = el("span", "pv-allowed");
	const b = button(label, "pv-btn pv-primary", onClick);
	b.dataset.key = key;
	if (can && !can.allowed) {
		b.disabled = true;
		const why = el("span", "pv-muted pv-why", refusalText(can.reason));
		wrap.append(b, why);
		return wrap;
	}
	// Unknown (not loaded yet): offered; the server decides anyway (rule 6).
	wrap.appendChild(b);
	return wrap;
}

// ── Project page ────────────────────────────────────────────────────────────

function renderProjectPage(pid: string): HTMLElement {
	const name = projectName(pid);
	setTitlePage(pageTitle(name, null));
	const state = agentLists.get(pid);
	const data = state?.data ?? null;
	if (!data && state?.error && state.error.status === 404) {
		return projectNotFoundPage();
	}
	const createBtn = allowedButton(
		"+ New agent",
		data?.can.createAgent ?? null,
		() => openCreateAgentDialog(pid),
		"new-agent",
	);
	const refresh = button("↻", "pv-btn pv-icon", () => void loadAgents(pid, true), "Refresh");
	refresh.dataset.key = "refresh";
	const header = pageHeader(name ?? "Project", null, refresh, createBtn);
	const now = Date.now();
	const clock = listClock(state);
	const sub = el("p", "pv-sub");
	if (data) {
		// "as of" on the server's clock: the answer's age is the browser's
		// own time since it arrived, whatever the two clocks say.
		const asOf = relativeDate(data.generatedAt, serverNow(clock, now));
		sub.textContent = `${agentCountText(data.agents.length)} · as of ${asOf}`;
	}
	if (state?.error && data) {
		sub.appendChild(el("span", "pv-warn", " · couldn't refresh, showing the last answer"));
	}
	if (!data) {
		if (state?.error) {
			const retry = button("Retry", "pv-btn", () => void loadAgents(pid, true));
			return page(
				header,
				stateBox("error", projectErrorText(state.error.code, state.error.status), retry),
			);
		}
		return page(header, stateBox("loading", "Loading agents…"));
	}
	if (data.agents.length === 0) {
		const actions: HTMLElement[] = [];
		if (data.can.createAgent.allowed) {
			const add = button("+ New agent", "pv-btn pv-primary", () => openCreateAgentDialog(pid));
			add.dataset.key = "new-agent-empty";
			actions.push(add);
		}
		const box = stateBox(
			"empty",
			"No agents yet. An agent is a stable identity bound to one of your unassigned sessions.",
			...actions,
		);
		const free = unassignedText();
		if (free) box.insertBefore(el("p", "pv-free-count", free), box.children[1] ?? null);
		return page(header, sub, box);
	}
	// One view per agent, shared by its card and the summary (one source of
	// truth). Cards stay in the server's order (creation, §4.4): a poll
	// that changes a state never moves a card under the reader's pointer.
	const views = data.agents.map((a) => presentPresence(a.presence, clock, now));
	const summary = el("p", "pv-summary", presenceSummary(views).join(" · "));
	const list = el("ul", "pv-agents");
	list.setAttribute("aria-label", "Agents");
	data.agents.forEach((a, i) => {
		list.appendChild(agentCard(pid, a, views[i]!));
	});
	return page(header, sub, summary, list);
}

/** How many sessions a new agent could take; nothing when that is unknown (rule 1). */
function unassignedText(): string | null {
	if (!sessions.some((s) => "binding" in s)) return null;
	const n = bindableSessions(sessions).length;
	if (n === 0) return "You have no unassigned session right now.";
	return n === 1 ? "You have 1 unassigned session." : `You have ${n} unassigned sessions.`;
}

function agentCard(pid: string, a: AgentListEntry, presence: PresenceView): HTMLElement {
	const li = el("li", presence.tone === "attention" ? "pv-agent pv-agent-attention" : "pv-agent");
	li.dataset.agentId = a.agentId;
	const top = el("div", "pv-agent-top");
	const link = el("a", "pv-agent-handle", `@${a.handle}`);
	const route: ProjectRoute = { projectId: pid, agentId: a.agentId };
	link.href = projectRouteHash(route);
	link.dataset.key = `agent:${a.agentId}`;
	link.addEventListener("click", (e) => {
		if (!plainClick(e)) return;
		e.preventDefault();
		navigateProject(route);
	});
	top.appendChild(link);
	top.appendChild(el("span", "pv-role", a.role ?? "No role"));
	li.appendChild(top);
	li.appendChild(presenceBlock(presence, true));
	const bind = el("div", "pv-agent-session");
	if (a.binding) {
		bind.appendChild(el("span", "pv-muted", "Session: "));
		bind.appendChild(sessionLink(a.binding.sessionId, `session:${a.agentId}`));
		if (a.binding.state !== "active")
			bind.appendChild(el("span", "pv-muted", ` (${a.binding.state})`));
	} else {
		bind.appendChild(el("span", "pv-muted", "No session bound"));
	}
	li.appendChild(bind);
	if (a.binding && a.binding.state !== "retired") {
		const actions = sessionActions(a.binding.sessionId, `agent:${a.agentId}`);
		const start = startSessionButton(a.presence, a.binding.sessionId, `start:${a.agentId}`);
		if (start) actions.prepend(start);
		li.appendChild(actions);
	}
	return li;
}

// ── Agent page ──────────────────────────────────────────────────────────────

function renderAgentPage(pid: string, aid: string): HTMLElement {
	const state = agentDetails.get(detailKey(pid, aid));
	const data = state?.data ?? null;
	const name = projectName(pid);
	setTitlePage(pageTitle(name, data?.handle ?? null));
	const backRoute: ProjectRoute = { projectId: pid, agentId: null };
	const back = el("a", "pv-back", `‹ ${name ?? "Project"}`);
	back.href = projectRouteHash(backRoute);
	back.dataset.key = "back";
	back.addEventListener("click", (e) => {
		if (!plainClick(e)) return;
		e.preventDefault();
		navigateProject(backRoute);
	});
	if (!data && state?.error?.code === "project-not-found") return projectNotFoundPage();
	if (!data && state?.error && state.error.status === 404) {
		const toProject = button(`Back to ${name ?? "the project"}`, "pv-btn", () =>
			navigateProject(backRoute),
		);
		toProject.dataset.key = "back-project";
		return page(
			pageHeader("Agent not found", back),
			stateBox(
				"info",
				`There is no such agent in ${name ?? "this project"} — the link may be wrong, or the agent belongs to another project.`,
				toProject,
			),
		);
	}
	if (!data) {
		const header = pageHeader("Agent", back);
		if (state?.error) {
			const retry = button("Retry", "pv-btn", () => void loadAgent(pid, aid, true));
			return page(
				header,
				stateBox("error", projectErrorText(state.error.code, state.error.status), retry),
			);
		}
		return page(header, stateBox("loading", "Loading the agent…"));
	}
	const actions: HTMLElement[] = [];
	if (data.can.remove.allowed) {
		const remove = button("Remove agent", "pv-btn pv-danger", () => void removeFlow(pid, data));
		remove.dataset.key = "remove";
		actions.push(remove);
	}
	const header = pageHeader(`@${data.handle}`, back, ...actions);
	const sub = el(
		"p",
		"pv-sub",
		`${data.role ?? "No role"} · ${providerText(data.provider)} · created ${relativeDate(data.createdAt)}`,
	);
	if (state?.error)
		sub.appendChild(el("span", "pv-warn", " · couldn't refresh, showing the last answer"));
	const parts: HTMLElement[] = [header, sub];
	if (data.removedAt !== null) {
		const banner = el("div", "pv-banner");
		banner.setAttribute("role", "status");
		banner.textContent = `Removed ${relativeDate(data.removedAt)}. Its page and history are kept, and the handle @${data.handle} stays reserved in this project.`;
		parts.push(banner);
	}

	const presence = el("section", "pv-section");
	presence.appendChild(el("h3", undefined, "Presence"));
	const clock = listClock(agentLists.get(pid)) ?? lastClock;
	presence.appendChild(presenceBlock(presentPresence(data.presence, clock, Date.now()), false));
	parts.push(presence);

	const sessionSec = el("section", "pv-section");
	sessionSec.appendChild(el("h3", undefined, "Session"));
	if (data.binding && data.binding.state !== "retired") {
		const row = el("div", "pv-session-row");
		row.appendChild(sessionLink(data.binding.sessionId, "bound-session"));
		const actions = sessionActions(data.binding.sessionId, "bound");
		const start = startSessionButton(data.presence, data.binding.sessionId, "start");
		if (start) actions.prepend(start);
		row.appendChild(actions);
		sessionSec.appendChild(row);
		sessionSec.appendChild(
			el(
				"p",
				"pv-muted",
				"Terminal, Files, Git and Chat stay the session's own: binding it to this agent changed nothing in it.",
			),
		);
	} else {
		sessionSec.appendChild(el("p", "pv-muted", "No session bound."));
	}
	parts.push(sessionSec);

	const caps = el("section", "pv-section");
	caps.appendChild(el("h3", undefined, "Capabilities"));
	const capList = el("ul", "pv-caps");
	const cap = (label: string, on: boolean, note: string) => {
		const li = el("li", on ? "on" : "off");
		li.appendChild(el("span", "pv-cap-mark", on ? "✓" : "—"));
		li.appendChild(el("span", undefined, `${label}: ${on ? "yes" : "no"}`));
		li.appendChild(el("span", "pv-muted", ` · ${note}`));
		capList.appendChild(li);
	};
	cap(
		"Conversation capture",
		data.capabilities.capture,
		"the Chat view can read its conversations",
	);
	cap("Channels", data.capabilities.channels, "agent-to-agent messaging (not available yet)");
	cap("Direct control", data.capabilities.directControl, "the Composer can type into its Claude");
	caps.appendChild(capList);
	parts.push(caps);

	const hist = el("section", "pv-section");
	hist.appendChild(el("h3", undefined, "Session history"));
	const table = el("table", "pv-history");
	const thead = el("thead");
	const hr = el("tr");
	for (const h of ["#", "Session", "State", "Bound", "Retired"])
		hr.appendChild(el("th", undefined, h));
	thead.appendChild(hr);
	table.appendChild(thead);
	const tbody = el("tbody");
	for (const b of [...data.bindings].sort((x, y) => y.epoch - x.epoch)) {
		const tr = el("tr");
		tr.dataset.bindingId = b.bindingId;
		tr.appendChild(el("td", undefined, String(b.epoch)));
		const sess = el("td");
		sess.appendChild(sessionLink(b.sessionId, `history:${b.bindingId}`));
		tr.appendChild(sess);
		tr.appendChild(el("td", `pv-state ${b.state}`, b.state));
		tr.appendChild(el("td", undefined, b.createdAt ? relativeDate(b.createdAt) : ""));
		const retired = b.retiredAt
			? `${relativeDate(b.retiredAt)}${b.retireReason ? ` · ${retireReasonText(b.retireReason)}` : ""}`
			: "";
		tr.appendChild(el("td", undefined, retired));
		tbody.appendChild(tr);
	}
	table.appendChild(tbody);
	hist.appendChild(table);
	parts.push(hist);
	return page(...parts);
}

// ── Remove (idempotent DELETE) ──────────────────────────────────────────────

async function removeFlow(pid: string, a: AgentDetail): Promise<void> {
	// Captured BEFORE the confirm: a confirm answered after a logout (the
	// dialog is not in openDialogs) must not act for the next account.
	const myGen = gen;
	const ok = await confirmDialog({
		title: "Remove agent",
		message: `Remove @${a.handle}?\n\nIts session is released and nothing in the session changes. The agent's page and its history are kept, and the handle @${a.handle} stays reserved in this project.`,
		confirmLabel: "Remove agent",
		danger: true,
	});
	if (!ok || myGen !== gen) return;
	// A DELETE is idempotent: retrying after a lost answer is always safe —
	// but only when the person asks (never on our own, rule 4).
	for (;;) {
		const answer = await removeAgent(pid, a.agentId);
		if (myGen !== gen || (!answer.ok && answer.code === "stale")) return;
		if (answer.ok) {
			showToast(`Removed @${a.handle}`);
			break;
		}
		const outcome = classifyCreation(answer);
		if (outcome.kind === "unknown") {
			const retry = await confirmDialog({
				title: "Removal not confirmed",
				message: `${projectErrorText(outcome.code, answer.status)}\n\nRetrying cannot remove anything twice.`,
				confirmLabel: "Retry",
				cancelLabel: "Not now",
			});
			if (myGen !== gen) return;
			if (retry) continue;
			break;
		}
		showToast(projectErrorText(answer.code, answer.status), true);
		break;
	}
	await Promise.all([
		loadAgent(pid, a.agentId, true),
		loadAgents(pid, true),
		loadProjects(true),
		refreshSessions(),
	]);
}

// ── Creation dialogs ────────────────────────────────────────────────────────

interface Field {
	label: string;
	control: HTMLInputElement | HTMLSelectElement;
	hint?: string;
	validate?: (value: string) => string | null;
}

interface CreationDialogOptions<T> {
	title: string;
	intro: string;
	fields: Field[];
	submitLabel: string;
	/** Disabled submit + this reason (nothing to create from). */
	blocked?: string | null;
	send: (values: string[], clientRequestId: string) => Promise<ProjectAnswer<T>>;
	replayedOf: (body: T) => boolean;
	onCreated: (body: T) => void;
	/** Re-read the list(s) a lost attempt may have changed. */
	reload: () => Promise<void>;
	/** After a refusal: anything else to refresh (e.g. the sessions on offer). */
	onRefused?: (code: string) => Promise<void> | void;
}

function mintId(): string {
	return crypto.randomUUID();
}

function openCreationDialog<T>(opts: CreationDialogOptions<T>): void {
	const attempt = new CreationAttempt(mintId);
	const root = el("div", "modal");
	root.setAttribute("aria-hidden", "true");
	const backdrop = el("div", "modal-backdrop");
	backdrop.setAttribute("data-close-modal", "");
	root.appendChild(backdrop);
	const card = el("div", "modal-card dialog-card pv-dialog");
	card.setAttribute("role", "dialog");
	card.setAttribute("aria-modal", "true");
	const titleId = `pv-dialog-${mintId()}`;
	card.setAttribute("aria-labelledby", titleId);
	const header = el("div", "modal-header");
	const h2 = el("h2", undefined, opts.title);
	h2.id = titleId;
	header.appendChild(h2);
	const closeX = el("button", "modal-close", "×");
	closeX.type = "button";
	closeX.setAttribute("aria-label", "Close");
	closeX.setAttribute("data-close-modal", "");
	header.appendChild(closeX);
	card.appendChild(header);
	const form = el("form", "dialog-form");
	form.noValidate = true;
	const body = el("div", "dialog-body");
	body.appendChild(el("p", "modal-hint", opts.intro));
	const fieldErrors: HTMLElement[] = [];
	for (const f of opts.fields) {
		const label = el("label", "modal-field");
		label.appendChild(el("span", undefined, f.label));
		label.appendChild(f.control);
		if (f.hint) label.appendChild(el("span", "pv-field-hint", f.hint));
		const err = el("span", "modal-field-error");
		err.hidden = true;
		label.appendChild(err);
		fieldErrors.push(err);
		body.appendChild(label);
		f.control.addEventListener("input", () => {
			err.hidden = true;
		});
	}
	const status = el("p", "pv-dialog-status");
	status.setAttribute("role", "alert");
	status.hidden = true;
	if (opts.blocked) {
		status.textContent = opts.blocked;
		status.hidden = false;
	}
	body.appendChild(status);
	form.appendChild(body);
	const actions = el("div", "modal-actions");
	const cancel = el("button", "dialog-cancel", "Cancel");
	cancel.type = "button";
	cancel.setAttribute("data-close-modal", "");
	const submit = el("button", "modal-primary-action", opts.submitLabel);
	submit.type = "submit";
	submit.disabled = Boolean(opts.blocked);
	actions.append(cancel, submit);
	form.appendChild(actions);
	card.appendChild(form);
	root.appendChild(card);

	// The values the current id was sent with: a retry re-sends exactly them.
	let sentValues: string[] | null = null;
	let created = false;
	const myGen = gen;

	const setLocked = () => {
		const sending = attempt.phase === "sending";
		for (const f of opts.fields) f.control.disabled = attempt.inputsLocked;
		submit.disabled = sending || Boolean(opts.blocked && attempt.phase === "editing");
		cancel.disabled = sending;
		closeX.disabled = sending;
		submit.textContent =
			attempt.phase === "unknown" ? "Retry" : sending ? "Creating…" : opts.submitLabel;
		if (sending) form.setAttribute("aria-busy", "true");
		else form.removeAttribute("aria-busy");
	};
	const say = (text: string | null) => {
		status.textContent = text ?? "";
		status.hidden = text === null;
	};

	form.addEventListener("submit", (e) => {
		e.preventDefault();
		if (attempt.phase === "sending" || attempt.phase === "done") return;
		let values: string[];
		if (attempt.phase === "unknown" && sentValues) {
			values = sentValues;
		} else {
			values = opts.fields.map((f) => f.control.value);
			let bad = false;
			opts.fields.forEach((f, i) => {
				const problem = f.validate?.(values[i]!) ?? null;
				const err = fieldErrors[i]!;
				err.textContent = problem ?? "";
				err.hidden = problem === null;
				if (problem !== null && !bad) {
					bad = true;
					f.control.focus();
				}
			});
			if (bad) return;
		}
		const id = attempt.send();
		sentValues = values;
		say(null);
		setLocked();
		void (async () => {
			const answer = await opts.send(values, id);
			if (myGen !== gen || (!answer.ok && answer.code === "stale")) return;
			const outcome = classifyCreation(
				answer.ok ? { ok: true, replayed: opts.replayedOf(answer.body) } : answer,
			);
			const step = attempt.receive(outcome);
			if (step.phase === "done" && answer.ok) {
				created = true;
				dialog.close();
				opts.onCreated(answer.body);
				return;
			}
			if (step.reloadFirst) {
				// The attempt whose answer was lost may have landed meanwhile:
				// the list is re-read BEFORE the refusal is shown (rule 4).
				say("Checking what happened…");
				await opts.reload().catch(() => {});
				if (myGen !== gen) return;
			}
			if (step.phase === "editing") {
				sentValues = null;
				await opts.onRefused?.(answer.ok ? "" : answer.code);
			}
			say(step.message);
			setLocked();
			if (step.phase === "unknown") submit.focus();
		})();
	});

	document.body.appendChild(root);
	const handle = { close: () => dialog.close() };
	const dialog = createDialog(root, {
		initialFocus: () => (opts.fields[0]?.control as HTMLElement | undefined) ?? submit,
		canDismiss: () => attempt.phase !== "sending",
		onClose: () => {
			openDialogs.delete(handle);
			root.remove();
			// Closed while the outcome was unknown: what was asked may still
			// land, so the lists are re-read (never retried on our own).
			if (!created && attempt.phase === "unknown" && myGen === gen) {
				showToast("It may or may not have been created — the list was reloaded.");
				void opts.reload();
			}
		},
	});
	openDialogs.add(handle);
	dialog.open(document.activeElement);
}

function textInput(placeholder: string, maxLength?: number): HTMLInputElement {
	const i = el("input");
	i.type = "text";
	i.autocomplete = "off";
	i.spellcheck = false;
	i.placeholder = placeholder;
	if (maxLength) i.maxLength = maxLength;
	return i;
}

export function openCreateProjectDialog(): void {
	if (!active) return;
	const name = textInput("e.g. Educación HZ", 80);
	openCreationDialog({
		title: "New project",
		intro: "A project groups agents: stable identities, each bound to one of your sessions.",
		fields: [{ label: "Name", control: name, validate: validateProjectName }],
		submitLabel: "Create project",
		send: ([n], id) => createProject(n!.trim().normalize("NFC"), id),
		replayedOf: (b) => b.replayed === true,
		onCreated: (b) => {
			showToast(
				b.replayed ? `Project "${b.name}" was already created` : `Project "${b.name}" created`,
			);
			void loadProjects(true);
			navigateProject({ projectId: b.projectId, agentId: null });
		},
		reload: () => loadProjects(true),
	});
}

function openCreateAgentDialog(pid: string): void {
	if (!active) return;
	const handle = textInput("e.g. developer-hz", 32);
	const role = textInput("e.g. Developer (optional)", 60);
	const select = el("select");
	const fillSessions = (): string | null => {
		const before = select.value;
		select.replaceChildren();
		const known = sessions.some((s) => "binding" in s);
		const free = bindableSessions(sessions);
		if (free.length === 0) {
			const o = el("option", undefined, "No unassigned session");
			o.value = "";
			select.appendChild(o);
			return known
				? "No unassigned session to bind. Create a session, or remove an agent to free its session."
				: "Couldn't tell which sessions are free (the project directory could not be read). Try again in a moment.";
		}
		for (const s of free) {
			const o = el("option", undefined, `${s.name} · ${s.status}`);
			o.value = s.sessionId;
			select.appendChild(o);
		}
		if (free.some((s) => s.sessionId === before)) select.value = before;
		return null;
	};
	const blocked = fillSessions();
	openCreationDialog({
		title: "New agent",
		intro: `An agent of ${projectName(pid) ?? "this project"}, bound to one of your unassigned sessions. Nothing in the session changes.`,
		fields: [
			{
				label: "Handle",
				control: handle,
				hint: "Lowercase letters, digits and dashes; unique in the project.",
				validate: validateHandle,
			},
			{ label: "Role", control: role, validate: validateRole },
			{
				label: "Session",
				control: select,
				hint: "Only unassigned sessions are offered.",
				validate: (v) => (v ? null : "Pick a session."),
			},
		],
		submitLabel: "Create agent",
		blocked,
		send: ([h, r, sid], id) =>
			createAgent(pid, { handle: h!, role: r!.trim() || null, sessionId: sid! }, id),
		replayedOf: (b) => b.replayed === true,
		onCreated: (b) => {
			showToast(b.replayed ? `@${b.handle} was already created` : `Agent @${b.handle} created`);
			void Promise.all([loadAgents(pid, true), loadProjects(true), refreshSessions()]);
		},
		reload: async () => {
			await Promise.all([loadAgents(pid, true), refreshSessions()]);
		},
		onRefused: async (code) => {
			if (code === "session-taken" || code === "session-not-found") {
				await refreshSessions();
				fillSessions();
			}
			if (code === "project-not-found") void loadAgents(pid, true);
		},
	});
}

// ── Polling ─────────────────────────────────────────────────────────────────

// ≤ every 5 s per visible page (design 16 rule 9; `projectIp` is 120/min);
// the sidebar's list is slower — counts change only on create/remove,
// which re-read it themselves.
const POLL_MS = 5_000;
const PROJECTS_EVERY_N_TICKS = 6;
let tickCount = 0;

function tick(): void {
	if (!active || !isLoggedIn() || document.visibilityState !== "visible") return;
	tickCount++;
	if (shown) void loadShown();
	if (tickCount % PROJECTS_EVERY_N_TICKS === 0) void loadProjects();
}

// ── Lifecycle (main.ts) ─────────────────────────────────────────────────────

let wired = false;

function wire(): void {
	if (wired) return;
	wired = true;
	window.addEventListener("popstate", () => sync());
	window.addEventListener("hashchange", () => sync());
	onAddressWrite(() => sync());
	setInterval(tick, POLL_MS);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") tick();
	});
	newProjectBtn?.addEventListener("click", () => openCreateProjectDialog());
	// A session row or the session bar used while a page is up: the page
	// gives way to the session (and Back returns to it). The agent link and
	// the row's quick actions / ⋯ menu are not "go to the session".
	for (const id of ["session-list", "terminal-toolbar"]) {
		document.getElementById(id)?.addEventListener(
			"click",
			(e) => {
				if (shown === null) return;
				const t = e.target;
				if (!(t instanceof Element)) return;
				if (
					t.closest(
						".session-agent-link, #terminal-session-agent, .session-actions, .session-last-conv",
					)
				)
					return;
				leavePage();
			},
			true,
		);
	}
}

/**
 * The app is shown for a signed-in account (main.ts showApp). With the
 * feature absent this does nothing at all — not even a listener.
 */
export function startProjects(): void {
	if (!projectChatEnabled()) return;
	wire();
	active = true;
	// Held only while the address still names the page: a session link
	// clicked on it has already replaced the hash, and the session's own
	// writes that follow must land.
	enableProjectRoutes(() => shown !== null && readProjectRoute() !== null);
	renderSection();
	void loadProjects();
	sync();
}

/** Logout / expiry: nothing of this account stays on screen or in memory. */
export function resetProjects(): void {
	gen++;
	active = false;
	disableProjectRoutes();
	for (const d of [...openDialogs]) d.close();
	openDialogs.clear();
	clearProjects();
	projectsState = blank();
	agentLists = new Map();
	agentDetails = new Map();
	lastClock = null;
	starting.clear();
	hidePage();
	renderSection();
}
