/**
 * sessionCore.ts — the session-list + tab lifecycle, the heart of the SPA
 * (#312). Owns refreshSessions/renderSessionList/openSession/updateToolbar
 * and renderTabBar/openTab/addTab/closeTab. Extracted from main.ts.
 *
 * The cross-cutting session/tab state stays declared in main.ts; this
 * module reads the live bindings directly and writes via the setters
 * (ESM forbids reassigning imported bindings). All main.ts imports are
 * used only inside functions, so the circular import is TDZ-safe.
 */

import { openObserversModalFor } from "./admin.js";
import {
	ApiCodeError,
	createTab,
	deleteSession,
	deleteTab,
	fetchAdminSessions,
	fetchConversations,
	getSession,
	isAdmin,
	isLead,
	isLoggedIn,
	listSessions,
	listTabs,
	projectChatEnabled,
	type SessionBinding,
	type SessionInfo,
	startSession,
	stopSession,
	TabNotFoundError,
} from "./api.js";
import { openActionMenu } from "./components/actionMenu.js";
import { alertDialog, confirmDialog } from "./components/dialog.js";
import { formatBytes, formatCpuCores, formatCpuPercent } from "./format.js";
import { transformKeyInput } from "./keyBar.js";
import {
	activeSessionId,
	closingTabs,
	currentActiveTabId,
	currentTabs,
	currentTerminals,
	disposeAllCurrentTerminals,
	isMobile,
	maybeInjectSelectionHint,
	sessions,
	setActiveSessionId,
	setChromeOpen,
	setCurrentActiveTabId,
	setCurrentTabs,
	setServerReachable,
	setSessions,
	showCopySuccessToast,
	showToast,
	updateChromeToggle,
} from "./main.js";
import { renderSidebarObservables } from "./myGroups.js";
import { openBootstrapLogModal } from "./newSession.js";
import { openObserveModalFor } from "./observeModal.js";
import { openPortsModalFor } from "./ports.js";
import { currentProject, projectName, projects } from "./projectDirectory.js";
import {
	agentActiveDeleteText,
	agentCountText,
	groupSessionsByBinding,
	type PresenceView,
} from "./projectModel.js";
import {
	clear as clearRoute,
	navigateProject,
	projectRouteHash,
	type Route,
	readRoute,
	routeHash,
} from "./router.js";
import {
	type SessionActionContext,
	type SessionActionId,
	sessionActions,
	terminalState,
} from "./sessionActions.js";
import { sidebarPresenceOf, watchSidebarPresence } from "./sidebarPresence.js";
import { badgeFor, clearBadge, recordOutput } from "./tabActivity.js";
import { openTerminalSession, type SessionStatus } from "./terminal.js";
import { currentShell } from "./uiShell.js";
import {
	readHistoryHint,
	readLastConversation,
	readLastConversationTitle,
	readViewPref,
	writeHistoryHint,
} from "./viewPolicy.js";
import {
	applyRouteView,
	beginLanding,
	beginRouteApply,
	choiceGeneration,
	endLanding,
	endRouteApply,
	landingFor,
	landView,
	onViewChange,
	reflectRoute,
	registerRouteDetail,
	setView,
	showFilesOnly,
	syncSessionViews,
	type View,
} from "./viewSwitch.js";

// ── DOM (re-queried locally) ─────────────────────────────────────────────
const sessionList = document.getElementById("session-list")!;
const showTerminatedToggle = document.getElementById("show-terminated-toggle") as HTMLInputElement;
const terminalToolbar = document.getElementById("terminal-toolbar")!;
const terminalSessionName = document.getElementById("terminal-session-name")!;
const terminalStatusBadge = document.getElementById("terminal-status-badge")!;
const terminalTabs = document.getElementById("terminal-tabs")!;
const tabStrip = document.getElementById("tab-strip") ?? terminalTabs;
const terminalContainer = document.getElementById("terminal-container")!;
const emptyState = document.getElementById("empty-state")!;
const terminalStateEl = document.getElementById("terminal-state")!;

// Session currently open in Files-only mode (it wasn't running when
// selected, so no tabs were listed and no terminal attached). Watched by
// refreshSessions so a later start re-opens it with a live terminal.
let filesOnlySessionId: string | null = null;

// The tab whose socket gave up (terminal.ts exhausted its retries, or the
// close was final). The pane is gone; the terminal area offers Reconnect
// for exactly this tab until a pane is attached again or the session
// changes. Only meaningful for the active session.
let disconnectedTabId: string | null = null;

// ── Session actions (one list, every surface) ───────────────────────────────
//
// sessionActions.ts decides WHAT a person may do; this is the one place
// that DOES it. The sidebar rows, their ⋯ menu, the terminal's state panel
// and the Git view all call runSessionAction, so a verb behaves the same
// wherever it is offered.

function actionContext(s: SessionInfo): SessionActionContext {
	const active = s.sessionId === activeSessionId;
	return {
		session: { sessionId: s.sessionId, name: s.name, status: s.status },
		// The sidebar lists the caller's own sessions; a foreign session in
		// the shell (observe / operate) is a later PR and will pass false.
		isOwner: true,
		isAdmin: isAdmin(),
		isLead: isLead(),
		connection: !active
			? "none"
			: currentActiveTabId !== null
				? "attached"
				: disconnectedTabId !== null
					? "disconnected"
					: "none",
		tabs: active ? currentTabs.length : null,
	};
}

export async function runSessionAction(s: SessionInfo, id: SessionActionId): Promise<void> {
	switch (id) {
		case "open":
			await openSession(s.sessionId);
			return;
		case "start":
		case "restore":
			try {
				if (id === "restore") showToast(`Restoring "${s.name}"…`);
				else showToast(`Starting "${s.name}"…`);
				await startSession(s.sessionId);
				await refreshSessions();
				if (id === "restore") showToast(`Session "${s.name}" restored`);
			} catch (err) {
				showToast((err as Error).message, true);
			}
			return;
		case "stop": {
			// Stopping interrupts whatever runs in the container (a Claude
			// mid-turn included), so every entry point — the row's quick
			// button, the ⋯ menu, the session menu — asks first.
			const ok = await confirmDialog({
				title: "Stop session",
				message: `Stop "${s.name}"?\n\nEverything running in it stops now — a Claude working in a terminal tab is interrupted mid-task. Its files and anything installed in the container are kept; you can start it again later.`,
				confirmLabel: "Stop session",
				danger: true,
			});
			if (!ok) return;
			try {
				await stopSession(s.sessionId);
				await refreshSessions();
			} catch (err) {
				showToast((err as Error).message, true);
			}
			return;
		}
		case "newTab":
			if (s.sessionId === activeSessionId) await addTab();
			return;
		case "reconnect": {
			if (s.sessionId !== activeSessionId || disconnectedTabId === null) return;
			const tabId = disconnectedTabId;
			disconnectedTabId = null;
			try {
				openTab(tabId);
			} catch (err) {
				disconnectedTabId = tabId;
				renderTerminalState();
				showToast((err as Error).message, true);
			}
			return;
		}
		case "viewLog":
			await openBootstrapLogModal(s);
			return;
		case "ports":
			openPortsModalFor(s.sessionId);
			return;
		case "observers":
			openObserversModalFor(s.sessionId);
			return;
		case "terminate":
		case "delete": {
			const hard = id === "delete";
			// A session bound to a project agent can't be hard-deleted (the
			// server answers 409 agent-active, PROJECTS.md §6): say so and
			// where to go BEFORE asking for its name, and send nothing.
			const guard = hard && projectChatEnabled();
			if (guard && isBinding(s.binding)) {
				await explainAgentActive(s.name, s.binding, false);
				return;
			}
			// An irreversible delete asks for the session's name (§9.5 of
			// docs/design/ui-unificada.md); a terminate is reversible
			// (Restore) and only needs a plain confirmation.
			const ok = hard
				? await confirmDialog({
						title: "Delete permanently",
						message: `Delete "${s.name}" permanently?\n\nThis stops and removes the container, wipes the workspace files from disk and removes the session record. This cannot be undone.`,
						confirmLabel: "Delete permanently",
						requireText: {
							expected: s.name,
							label: `Type the session name (${s.name}) to confirm`,
						},
					})
				: await confirmDialog({
						title: "Terminate session",
						message: `Terminate "${s.name}"?\n\nThe container is stopped and removed. Workspace files are preserved — you can restore the session later.`,
						confirmLabel: "Terminate",
						danger: true,
					});
			if (!ok) return;
			try {
				await deleteSession(s.sessionId, hard);
				if (activeSessionId === s.sessionId) {
					disposeAllCurrentTerminals();
					setActiveSessionId(null);
					clearRoute();
					updateToolbar();
				}
				await refreshSessions();
			} catch (err) {
				if (guard && err instanceof ApiCodeError && err.code === "agent-active") {
					await explainAgentActiveAfterRefusal(s);
					return;
				}
				showToast((err as Error).message, true);
			}
			return;
		}
	}
}

function isBinding(b: SessionInfo["binding"]): b is SessionBinding {
	return typeof b === "object" && b !== null;
}

/**
 * The server refused a hard delete with `agent-active` although this page
 * did not know the session as bound (binding key absent, or a stale row).
 * Re-read the list for the binding — and for the status: the server's
 * second check refuses AFTER the soft delete happened (PROJECTS.md §6), so
 * a row that was live may now be `terminated`, files kept.
 */
async function explainAgentActiveAfterRefusal(s: SessionInfo): Promise<void> {
	await refreshSessions();
	let fresh: SessionInfo | null = sessions.find((x) => x.sessionId === s.sessionId) ?? null;
	// Hidden from the list (terminated rows are shown only with the toggle on).
	if (fresh === null) fresh = await getSession(s.sessionId).catch(() => null);
	// The fresh row decides when it carries the key; an absent key (unknown)
	// keeps what the page knew before, a null (now unbound) means stale.
	const binding = fresh && "binding" in fresh ? fresh.binding : s.binding;
	const terminated = s.status !== "terminated" && fresh?.status === "terminated";
	await explainAgentActive(s.name, isBinding(binding) ? binding : null, terminated);
}

/** "Can't delete permanently": whose session it is, and a way to that agent. */
async function explainAgentActive(
	name: string,
	binding: SessionBinding | null,
	terminated: boolean,
): Promise<void> {
	const agent = binding && {
		handle: binding.handle,
		projectName: projectName(binding.projectId),
	};
	const { title, message } = agentActiveDeleteText(name, agent, terminated);
	if (binding === null) {
		await alertDialog({ title, message, okLabel: "Close" });
		return;
	}
	const open = await confirmDialog({
		title,
		message,
		confirmLabel: `Open @${binding.handle}`,
		cancelLabel: "Close",
	});
	if (open) navigateProject({ projectId: binding.projectId, agentId: binding.agentId });
}

/** The ⋯ menu of the ACTIVE session (shell v2's session bar). */
export function openActiveSessionMenu(opener: HTMLElement): void {
	const s = sessions.find((x) => x.sessionId === activeSessionId);
	if (s) openSessionMenu(s, opener);
}

function openSessionMenu(s: SessionInfo, opener: HTMLElement): void {
	openActionMenu({
		title: s.name,
		opener,
		items: sessionActions(actionContext(s)),
		onPick: (id) => void runSessionAction(s, id as SessionActionId),
	});
}

/**
 * The terminal area when it has no pane to show: stopped / terminated /
 * failed session, no tabs yet, or a tab whose socket gave up. Rendered
 * from sessionActions.terminalState so the offered buttons are exactly
 * the actions that apply. Hidden whenever a pane is attached — the panel
 * and the terminal container never share the box.
 */
export function renderTerminalState(): void {
	const s = sessions.find((x) => x.sessionId === activeSessionId);
	const attached = currentActiveTabId !== null && currentTerminals.has(currentActiveTabId);
	// Tabs not listed yet (openSession in flight): nothing to say.
	const tabsKnown =
		s?.status !== "running" || currentTabs.length > 0 || terminalTabs.style.display === "flex";
	const state = s && !attached && tabsKnown ? terminalState(actionContext(s)) : null;
	terminalStateEl.replaceChildren();
	terminalStateEl.hidden = state === null;
	if (!state || !s) return;
	const box = document.createElement("div");
	box.className = "terminal-state-box";
	box.setAttribute("role", "status");
	const h = document.createElement("h2");
	h.textContent = state.title;
	box.appendChild(h);
	const p = document.createElement("p");
	p.textContent = state.detail;
	box.appendChild(p);
	const row = document.createElement("div");
	row.className = "terminal-state-actions";
	for (const a of state.actions) {
		const b = document.createElement("button");
		b.type = "button";
		b.className = `terminal-state-btn kind-${a.kind}`;
		b.dataset.action = a.id;
		b.textContent = a.label;
		if (!a.enabled) {
			b.disabled = true;
			const why = document.createElement("span");
			why.className = "terminal-state-reason";
			why.textContent = a.reason ?? "";
			row.appendChild(b);
			row.appendChild(why);
			continue;
		}
		b.addEventListener("click", () => void runSessionAction(s, a.id));
		row.appendChild(b);
	}
	box.appendChild(row);
	terminalStateEl.appendChild(box);
}

// ── Session management ──────────────────────────────────────────────────────

// Every list request takes a number; only the newest one's answer is
// applied. An older answer landing later — a poll or a manual refresh
// that was slow, or a request sent with the PREVIOUS account's cookie
// before a logout and a new login — is dropped, so it can never replace
// a fresher list (or put account A's sessions in account B's sidebar).
// `invalidateSessionList()` (logout) retires every request in flight.
let listGen = 0;
// Whether a list has ever been applied since the last invalidation. The
// deep-link resolver needs to tell "the list never loaded" from "loaded
// and the session is not in it" — only the latter is "Session not found".
let listLoaded = false;

export function invalidateSessionList(): void {
	listGen++;
	listLoaded = false;
}

export function sessionListLoaded(): boolean {
	return listLoaded;
}

export async function refreshSessions() {
	// Read the checkbox state fresh every time so there's no stale
	// module-variable to get out of sync with the DOM.
	const includeTerminated = showTerminatedToggle.checked;
	const gen = ++listGen;
	// Only the request decides the reachability light, not a render error after it.
	let answered = false;
	try {
		const list = await listSessions(includeTerminated);
		answered = true;
		// Superseded (a newer request, or a logout) or answered for an
		// account that is no longer the one signed in: not ours to apply.
		if (gen !== listGen || !isLoggedIn()) return;
		const firstLoad = !listLoaded;
		listLoaded = true;
		setServerReachable(true);
		setSessions(list);
		console.debug(
			`[sessions] fetched ${sessions.length} session(s) (includeTerminated=${includeTerminated})`,
			sessions.map((s) => ({ id: s.sessionId.slice(0, 8), name: s.name, status: s.status })),
		);
		renderSessionList();
		reattachIfStarted();
		// A deep link that could not be resolved while the list had never
		// loaded (a failed first request) is applied now that it has.
		if (firstLoad && activeSessionId === null) {
			const route = readRoute();
			if (route !== null) void applyRoute(route);
		}
	} catch (err) {
		if (gen !== listGen) return;
		if (!answered) setServerReachable(false);
		showToast((err as Error).message, true);
	}
}

/** A Files-only session that is now running gets a real open (tabs +
 *  terminal attach). The Files view keeps its state — same session id. */
function reattachIfStarted(): void {
	if (filesOnlySessionId === null || filesOnlySessionId !== activeSessionId) return;
	const s = sessions.find((x) => x.sessionId === filesOnlySessionId);
	if (s?.status !== "running") return;
	const id = filesOnlySessionId;
	filesOnlySessionId = null;
	setActiveSessionId(null);
	void openSession(id);
}

/**
 * Mark the "↳ last conversation" link that is the open conversation, in place:
 * in-app navigation writes the address with push/replaceState (no event, no
 * sidebar render), so the mark is re-synced on navigation, not only on polls.
 */
export function syncLastConversationCurrent(): void {
	const route = readRoute();
	for (const b of sessionList.querySelectorAll<HTMLElement>(".session-last-conv")) {
		const sid = b.closest<HTMLElement>(".session-item")?.dataset.sessionId;
		const on =
			route !== null &&
			route.view === "chat" &&
			route.sessionId === sid &&
			route.detail === b.dataset.cid;
		if (on) b.setAttribute("aria-current", "page");
		else b.removeAttribute("aria-current");
	}
}

// Leaving Chat (or coming back) changes which link is the open conversation.
onViewChange(() => syncLastConversationCurrent());

export function renderSessionList() {
	// Re-rendered on every 5 s poll: keep the keyboard user's place.
	const active = document.activeElement;
	const focusedId =
		active instanceof HTMLElement && sessionList.contains(active)
			? active.closest<HTMLElement>(".session-item")?.dataset.sessionId
			: undefined;
	const focusedRole = active instanceof HTMLElement ? (active.dataset.role ?? "select") : "select";
	// …also on a group's heading (its chevron or its project link).
	const focusedGroup =
		active instanceof HTMLElement && sessionList.contains(active)
			? active.closest<HTMLElement>(".sgroup-head")?.parentElement?.dataset.group
			: undefined;
	sessionList.replaceChildren();
	// The compact phone rows (sidebar-sessions.css) belong to the grouped
	// list only: with the project feature off the sidebar is exactly as before.
	sessionList.classList.toggle("session-list-grouped", projectChatEnabled());
	if (projectChatEnabled()) renderGroupedSessions();
	else for (const s of sessions) sessionList.appendChild(buildSessionItem(s, null));
	if (focusedId !== undefined) {
		sessionList
			.querySelector<HTMLElement>(
				`.session-item[data-session-id="${CSS.escape(focusedId)}"] [data-role="${CSS.escape(focusedRole)}"]`,
			)
			?.focus();
	} else if (focusedGroup !== undefined) {
		sessionList
			.querySelector<HTMLElement>(
				`.sgroup[data-group="${CSS.escape(focusedGroup)}"] .sgroup-head [data-role="${CSS.escape(focusedRole)}"]`,
			)
			?.focus();
	}
	// Sidebar observables (#394) dedupe against THIS list, so re-render
	// them whenever it changes.
	renderSidebarObservables();
	// A binding made or removed, or a project's name loaded: the session
	// bar names the agent too.
	renderToolbarAgent();
}

/**
 * P3a: the session bar says which agent the open session is —
 * "@handle · <project>" (just "@handle" until the project's name is
 * loaded), a link to the agent's page. Only for a binding OBJECT (§4.6):
 * `null` (unassigned) and an absent key (unknown) show nothing. With the
 * feature off the element is never created.
 *
 * One line with an ellipsis inside the room the bar already has
 * (terminal.css `#terminal-session-agent`): it must never make the bar
 * taller — the bar's height is part of the terminal's box, and a change
 * there refits xterm and resizes tmux for every viewer. Where there is no
 * room (phones, both shells) the CSS leaves it out rather than wrap.
 */
let toolbarAgentLink: HTMLAnchorElement | null = null;

function renderToolbarAgent(): void {
	const s = projectChatEnabled()
		? sessions.find((x) => x.sessionId === activeSessionId)
		: undefined;
	const binding = s?.binding;
	if (!binding || typeof binding !== "object") {
		toolbarAgentLink?.remove();
		toolbarAgentLink = null;
		return;
	}
	if (!toolbarAgentLink) {
		const a = document.createElement("a");
		a.id = "terminal-session-agent";
		a.addEventListener("click", (e) => {
			if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
			const pid = a.dataset.projectId;
			const aid = a.dataset.agentId;
			if (pid === undefined || aid === undefined) return;
			e.preventDefault();
			navigateProject({ projectId: pid, agentId: aid });
		});
		toolbarAgentLink = a;
	}
	const a = toolbarAgentLink;
	const route = { projectId: binding.projectId, agentId: binding.agentId };
	a.dataset.projectId = route.projectId;
	a.dataset.agentId = route.agentId;
	a.href = projectRouteHash(route);
	const project = projectName(binding.projectId);
	const text = project ? `@${binding.handle} · ${project}` : `@${binding.handle}`;
	if (a.textContent !== text) a.textContent = text;
	a.title = `Open the agent ${text}`;
	if (a.previousElementSibling !== terminalStatusBadge) terminalStatusBadge.after(a);
}

/**
 * P3a (PROJECTS.md §4.6, rule 1): with the project feature on, the rows are
 * grouped by their binding — bound ones first, each naming its agent; then
 * «Unassigned sessions» (`binding: null`); then the rows whose binding is
 * UNKNOWN (the key is absent: the directory read failed), which are never
 * listed as unassigned. The rows themselves are the same as without the
 * feature: binding a session changes nothing about it (rule 8).
 */
function renderGroupedSessions(): void {
	const groups = groupSessionsByBinding(sessions);
	// One group per PROJECT, keyed by id (two projects may share a name), in
	// the directory's order and including the ones without a session yet —
	// the tree is where projects are listed (they used to appear twice: a
	// list above the sessions and a heading among them; UX audit N1). A
	// bound session whose project isn't in the loaded list (the list hasn't
	// arrived, or it lags a creation) falls into one "Agent sessions" group
	// instead of several identical headings.
	type Row = (typeof groups.bound)[number];
	const byProject = new Map<string, Row[]>();
	const unnamed: Row[] = [];
	for (const p of projects()) byProject.set(p.projectId, []);
	for (const b of groups.bound) {
		const rows = byProject.get(b.binding.projectId);
		if (rows) rows.push(b);
		else unnamed.push(b);
	}
	// Claude's state is read only for the projects whose rows can be seen:
	// expanded, with a running session (a stopped one's state is its own
	// word), and not behind a closed phone drawer.
	const folded = collapsed();
	watchSidebarPresence(
		projects()
			.filter(
				(p) =>
					!folded.has(p.projectId) &&
					(byProject.get(p.projectId) ?? []).some((r) => r.session.status === "running"),
			)
			.map((p) => p.projectId),
		!isMobile() || document.querySelector("main.sidebar-open") !== null,
	);
	for (const p of projects()) {
		const rows = byProject.get(p.projectId) ?? [];
		sessionList.appendChild(
			buildGroup({
				key: p.projectId,
				title: p.name,
				project: p.projectId,
				cls: "sgroup-project",
				tooltip: `Open ${p.name} · ${agentCountText(p.agentCount)}`,
				rows: rows.map(({ session, binding }) => buildSessionItem(session, binding)),
				// With the bindings unread, its sessions may be the ones under
				// "Assignment unknown": neither a count nor "none" is known.
				countUnknown: groups.unknown.length > 0,
				// "shown": its sessions may also be terminated ones the list hides.
				empty: p.agentCount === 0 ? "No agents yet." : "No sessions shown.",
			}),
		);
	}
	if (unnamed.length > 0) {
		sessionList.appendChild(
			buildGroup({
				key: "~agents",
				title: "Agent sessions",
				project: null,
				cls: "sgroup-project",
				rows: unnamed.map(({ session, binding }) => buildSessionItem(session, binding)),
			}),
		);
	}
	if (groups.unassigned.length > 0) {
		sessionList.appendChild(
			buildGroup({
				key: "~unassigned",
				title: "Unassigned",
				project: null,
				cls: "sgroup-unassigned",
				tooltip: "Sessions that don't belong to any project's agent.",
				rows: groups.unassigned.map((s) => buildSessionItem(s, null)),
			}),
		);
	}
	if (groups.unknown.length > 0) {
		sessionList.appendChild(
			buildGroup({
				key: "~unknown",
				title: "Assignment unknown",
				project: null,
				cls: "sgroup-unknown",
				tooltip:
					"The project directory could not be read: these sessions may or may not belong to an agent.",
				note: "Couldn't read which agent these belong to.",
				rows: groups.unknown.map((s) => buildSessionItem(s, null)),
			}),
		);
	}
}

// ── Sidebar tree: collapsible groups ────────────────────────────────────────

/**
 * Which groups this browser keeps collapsed (project ids and the "~…" keys
 * of the non-project groups). A per-viewer convenience, so localStorage is
 * the right place; unreadable storage just means "all expanded".
 */
const COLLAPSED_KEY = "st.sidebarCollapsed";
let collapsedGroups: Set<string> | null = null;

function collapsed(): Set<string> {
	if (collapsedGroups) return collapsedGroups;
	collapsedGroups = new Set();
	try {
		const raw = localStorage.getItem(COLLAPSED_KEY);
		const list: unknown = raw ? JSON.parse(raw) : [];
		if (Array.isArray(list))
			for (const k of list) if (typeof k === "string") collapsedGroups.add(k);
	} catch {
		// Private mode / blocked storage / a corrupt value: start expanded.
	}
	return collapsedGroups;
}

/** Logout: the next person on this browser starts with every group open. */
export function forgetSidebarCollapsed(): void {
	collapsedGroups = null;
	try {
		localStorage.removeItem(COLLAPSED_KEY);
	} catch {
		// Nothing was stored then.
	}
}

function setCollapsed(key: string, on: boolean): void {
	const set = collapsed();
	if (on) set.add(key);
	else set.delete(key);
	try {
		localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
	} catch {
		// Not persisted: the choice still holds until the page is reloaded.
	}
}

const CHEVRON_PATH = "M6 4l4 4-4 4";

/** Memory use from which the tree row shows it (it is in the tooltip always). */
const USAGE_HOT_PERCENT = 80;

function buildGroup(g: {
	key: string;
	title: string;
	/** A project's id: its title is then the link to its page. */
	project: string | null;
	cls: string;
	rows: HTMLElement[];
	tooltip?: string;
	note?: string;
	empty?: string;
	/** The rows are not the whole truth (bindings unread): show no number. */
	countUnknown?: boolean;
}): HTMLElement {
	const isCollapsed = collapsed().has(g.key);
	const section = document.createElement("section");
	section.className = `sgroup ${g.cls}${isCollapsed ? " collapsed" : ""}`;
	section.dataset.group = g.key;
	section.setAttribute("role", "group");
	section.setAttribute("aria-label", g.title);
	const rowsId = `sgroup-rows-${g.key.replace(/[^a-zA-Z0-9-]/g, "_")}`;

	const head = document.createElement("div");
	head.className = "sgroup-head";
	const toggle = document.createElement("button");
	toggle.type = "button";
	toggle.className = "sgroup-toggle";
	toggle.dataset.role = "toggle";
	toggle.setAttribute("aria-expanded", String(!isCollapsed));
	toggle.setAttribute("aria-controls", rowsId);
	toggle.setAttribute("aria-label", `${isCollapsed ? "Expand" : "Collapse"} ${g.title}`);
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", "0 0 16 16");
	svg.setAttribute("aria-hidden", "true");
	const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
	path.setAttribute("d", CHEVRON_PATH);
	svg.appendChild(path);
	toggle.appendChild(svg);
	const flip = () => {
		setCollapsed(g.key, !collapsed().has(g.key));
		renderSessionList();
		// The list was rebuilt: keep the keyboard on the control just used.
		sessionList
			.querySelector<HTMLElement>(`.sgroup[data-group="${CSS.escape(g.key)}"] .sgroup-toggle`)
			?.focus();
	};
	toggle.addEventListener("click", flip);
	head.appendChild(toggle);

	let title: HTMLElement;
	if (g.project !== null) {
		// A project's name opens its page (the chevron beside it folds the
		// group): the same link the old Projects list was, same class.
		const a = document.createElement("a");
		const route = { projectId: g.project, agentId: null };
		a.className = "sgroup-title project-item";
		a.dataset.projectId = g.project;
		a.dataset.role = "project";
		a.href = projectRouteHash(route);
		if (currentProject() === g.project) a.setAttribute("aria-current", "page");
		a.addEventListener("click", (e) => {
			if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
			e.preventDefault();
			navigateProject(route);
		});
		title = a;
	} else {
		// No page behind these groups: the whole heading folds them.
		const b = document.createElement("button");
		b.type = "button";
		b.className = "sgroup-title";
		b.tabIndex = -1; // the chevron is the Tab stop; this is the bigger target
		b.setAttribute("aria-hidden", "true");
		b.addEventListener("click", flip);
		title = b;
	}
	const name = document.createElement("span");
	name.className = "sgroup-name project-item-name";
	name.textContent = g.title;
	title.appendChild(name);
	title.title = g.tooltip ?? g.title;
	head.appendChild(title);

	const count = document.createElement("span");
	count.className = "sgroup-count";
	if (g.countUnknown) {
		// Never a known zero for an unknown (PROJECTS.md §4.6).
		count.textContent = "–";
		count.title = "Couldn't read which sessions belong to this project";
	} else {
		count.textContent = String(g.rows.length);
		count.title = g.rows.length === 1 ? "1 session" : `${g.rows.length} sessions`;
	}
	count.setAttribute("aria-label", count.title);
	head.appendChild(count);
	section.appendChild(head);

	const rows = document.createElement("div");
	rows.className = "sgroup-rows";
	rows.id = rowsId;
	rows.hidden = isCollapsed;
	if (g.note) {
		const note = document.createElement("p");
		note.className = "session-group-note";
		note.textContent = g.note;
		rows.appendChild(note);
	}
	if (g.rows.length === 0 && g.empty && !g.countUnknown) {
		const empty = document.createElement("p");
		empty.className = "sgroup-empty";
		empty.textContent = g.empty;
		rows.appendChild(empty);
	}
	for (const r of g.rows) rows.appendChild(r);
	section.appendChild(rows);
	return section;
}

/**
 * The row's one-word form of a presence. The full wording (`label`, owner
 * rules of 2026-11-09) stays in the tooltip and the accessible name; a
 * shorter word never claims more than the label does.
 */
function shortPresence(v: PresenceView): { word: string; cls: string } {
	switch (v.tone) {
		case "working":
			return { word: "Working", cls: "" };
		case "attention":
			return { word: "Needs you", cls: "" };
		case "ready":
			return v.label === "Ready"
				? { word: "Ready", cls: "" }
				: { word: "Ready?", cls: " unverified" };
		case "off":
			return { word: "Claude off", cls: "" };
		default:
			return v.label === "No recent activity"
				? { word: "Quiet", cls: " stale" }
				: { word: "Unknown", cls: "" };
	}
}

function buildSessionItem(s: SessionInfo, binding: SessionBinding | null): HTMLElement {
	const item = document.createElement("div");
	// Status class on the wrapper mirrors the session-dot rules so CSS
	// can target failed/terminated items uniformly.
	const statusCls = s.status === "terminated" || s.status === "failed" ? ` ${s.status}` : "";
	item.className = `session-item${s.sessionId === activeSessionId ? " active" : ""}${statusCls}`;
	item.dataset.sessionId = s.sessionId;

	// The row itself is a button (keyboard, screen readers): it selects
	// the session. The quick action and the ⋯ menu are siblings, never
	// nested inside it.
	const select = document.createElement("button");
	select.type = "button";
	select.className = "session-select";
	select.dataset.role = "select";
	select.setAttribute("aria-current", String(s.sessionId === activeSessionId));
	// The agent is part of the name: on phones the separate agent link is
	// hidden and the visible tag inside this button is overridden by the label.
	const agentPart = binding ? `, agent @${binding.handle}` : "";
	select.setAttribute(
		"aria-label",
		`${s.name}, ${s.status}${agentPart}${s.status === "failed" ? " — view the bootstrap log" : ""}`,
	);

	const dot = document.createElement("span");
	dot.className = `session-dot ${s.status}`;
	dot.setAttribute("aria-hidden", "true");
	select.appendChild(dot);

	const nameCol = document.createElement("span");
	nameCol.className = "session-name-col";
	const name = document.createElement("span");
	name.className = "session-name";
	name.textContent = s.name;
	nameCol.appendChild(name);
	const meta = document.createElement("span");
	meta.className = "session-meta";
	// The tree (project feature on) names a row by its session and its agent;
	// CPU / memory are infrastructure detail there — in the row's tooltip, and
	// on the row only when memory runs hot (UX audit N2: they took two of
	// each row's three lines and pushed the agent out of the phone's row).
	const tree = projectChatEnabled();
	if (tree && s.status === "running" && s.usage) {
		const usage = `CPU ${formatCpuCores(s.usage.cpuPercent / 100)} cores (${formatCpuPercent(s.usage.cpuPercent)}) · Mem ${formatBytes(s.usage.memBytes)} (${s.usage.memPercent.toFixed(0)}%)`;
		select.title = `${s.name}\n${usage}`;
		if (s.usage.memPercent >= USAGE_HOT_PERCENT) {
			const hot = document.createElement("span");
			hot.className = "session-usage session-usage-hot";
			hot.textContent = `Mem ${s.usage.memPercent.toFixed(0)}%`;
			meta.appendChild(hot);
		}
	} else if (s.status === "running" && s.usage) {
		const cpuCores = s.usage.cpuPercent / 100;
		const cpuLine = document.createElement("span");
		cpuLine.className = "session-usage session-usage-wide";
		cpuLine.textContent = `CPU ${formatCpuCores(cpuCores)} cores (${formatCpuPercent(s.usage.cpuPercent)})`;
		meta.appendChild(cpuLine);
		const memLine = document.createElement("span");
		memLine.className = "session-usage session-usage-wide";
		memLine.textContent = `Mem ${formatBytes(s.usage.memBytes)} (${s.usage.memPercent.toFixed(0)}%)`;
		meta.appendChild(memLine);
		// Phones: the same on one line (owner review 2026-11-13: the sidebar
		// wasted room); wide layouts keep the two lines above.
		const compact = document.createElement("span");
		compact.className = "session-usage session-usage-compact";
		compact.textContent = `${formatCpuCores(cpuCores)} cores · ${formatBytes(s.usage.memBytes)} (${s.usage.memPercent.toFixed(0)}%)`;
		meta.appendChild(compact);
	} else if (s.status !== "running") {
		// The dot's colour alone told stopped / terminated / failed apart.
		// The row's aria-label already says it: this line is for the eye.
		const state = document.createElement("span");
		state.className = `session-usage session-state ${s.status}`;
		state.setAttribute("aria-hidden", "true");
		state.textContent =
			s.status === "stopped"
				? "Stopped"
				: s.status === "terminated"
					? "Terminated · files kept"
					: s.status === "failed"
						? "Failed · open the log"
						: s.status;
		meta.appendChild(state);
	}
	// Claude's state in a running session bound to an agent: one short word
	// and a mark whose SHAPE differs per state; what it rests on is in the
	// tooltip and the row's accessible name. Nothing while it isn't known
	// whether anything was read (a collapsed or not-yet-read project).
	const presence =
		tree && binding !== null && s.status === "running"
			? sidebarPresenceOf(binding.projectId, binding.agentId, s.sessionId)
			: null;
	if (presence !== null) {
		const short = shortPresence(presence);
		const chip = document.createElement("span");
		chip.className = `session-presence tone-${presence.tone}${short.cls}`;
		chip.dataset.presence = presence.tone;
		chip.setAttribute("aria-hidden", "true");
		const mark = document.createElement("span");
		mark.className = "session-presence-mark";
		chip.appendChild(mark);
		chip.appendChild(document.createTextNode(short.word));
		meta.appendChild(chip);
		const why = [presence.label, presence.reason, presence.evidence].filter(Boolean).join(" · ");
		select.title = `${select.title || s.name}\nClaude: ${why}`;
		select.setAttribute(
			"aria-label",
			`${s.name}, ${s.status}${agentPart}, Claude: ${presence.label}`,
		);
	}
	// Phones: the agent as a word in this line (the separate agent link is
	// desktop-only there — the row is too narrow for both). Not a link: the
	// whole row opens the session; the agent page is one tap away from its
	// project, which is this group's heading.
	if (binding !== null) {
		const tag = document.createElement("span");
		tag.className = "session-agent-tag";
		tag.textContent = `@${binding.handle}`;
		meta.appendChild(tag);
	}
	if (meta.childElementCount > 0) nameCol.appendChild(meta);
	select.appendChild(nameCol);
	select.addEventListener("click", () => {
		// A failed session has no workspace: the row opens its log.
		void runSessionAction(s, s.status === "failed" ? "viewLog" : "open");
	});
	item.appendChild(select);
	// With the "↳ last conversation" line the row has room between its
	// controls; a tap there is a tap on the row (select), not a dead zone.
	item.addEventListener("click", (e) => {
		if (e.target === item) select.click();
	});

	const actions = document.createElement("span");
	actions.className = "session-actions";
	// The one obvious next step as a quick button; everything else
	// (incl. terminate / delete, each with its own dialog) in the menu.
	const quick = sessionActions(actionContext(s)).find(
		(a) => a.kind === "primary" || a.id === "stop",
	);
	if (quick?.enabled) {
		const b = document.createElement("button");
		b.type = "button";
		b.className = `session-action-btn ${quick.id === "stop" ? "stop" : "start"}`;
		b.dataset.role = quick.id;
		b.dataset.action = quick.id;
		b.textContent = quick.id === "stop" ? "⏸" : quick.id === "restore" ? "↻" : "▶";
		b.title = quick.label;
		b.setAttribute("aria-label", `${quick.label}: ${s.name}`);
		b.addEventListener("click", () => void runSessionAction(s, quick.id));
		actions.appendChild(b);
	}
	const more = document.createElement("button");
	more.type = "button";
	more.className = "session-menu-btn";
	more.dataset.role = "menu";
	more.textContent = "⋯";
	more.title = "More actions";
	more.setAttribute("aria-label", `More actions: ${s.name}`);
	more.setAttribute("aria-haspopup", "menu");
	more.addEventListener("click", () => openSessionMenu(s, more));
	actions.appendChild(more);
	item.appendChild(actions);

	// One click back to this project's last conversation, from anywhere.
	// Named from what Chat remembered (no request); no status shown —
	// knowing it would mean asking every project.
	const lastCid = s.status === "failed" ? null : readLastConversation(s.sessionId);
	const lastTitle = lastCid ? readLastConversationTitle(s.sessionId, lastCid) : null;
	if (lastCid && lastTitle) {
		const last = document.createElement("button");
		last.type = "button";
		last.className = "session-last-conv";
		// Focus restore after each 5 s re-render finds controls by role.
		last.dataset.role = "last-conv";
		last.dataset.cid = lastCid;
		const route = readRoute();
		if (route?.sessionId === s.sessionId && route.view === "chat" && route.detail === lastCid)
			last.setAttribute("aria-current", "page");
		last.textContent = `↳ ${lastTitle}`;
		last.title = `Open the last conversation: ${lastTitle}`;
		last.setAttribute("aria-label", `Open the last conversation in ${s.name}: ${lastTitle}`);
		last.addEventListener("click", () => {
			const hash = routeHash({ sessionId: s.sessionId, view: "chat", detail: lastCid });
			if (window.location.hash !== hash) window.location.hash = hash;
		});
		item.appendChild(last);
	}

	// P3a: the agent this session is bound to — a way to its page. A
	// name, not identity: the link carries the ids (rule 3).
	if (binding !== null) {
		const agent = document.createElement("a");
		agent.className = "session-agent-link";
		agent.dataset.role = "agent";
		const route = { projectId: binding.projectId, agentId: binding.agentId };
		agent.href = projectRouteHash(route);
		// The project is the group's heading now: the row names the agent only.
		const project = projectName(binding.projectId);
		agent.textContent = `@${binding.handle}`;
		agent.title = project
			? `Open the agent @${binding.handle} · ${project}`
			: `Open the agent @${binding.handle}`;
		agent.addEventListener("click", (e) => {
			if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
			e.preventDefault();
			navigateProject(route);
		});
		item.appendChild(agent);
	}

	return item;
}

// ↑ / ↓ / Home / End move between rows; Enter / Space are the buttons' own.
sessionList.addEventListener("keydown", (e) => {
	if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
	// Rows inside a collapsed group are not on screen: skip them.
	const rows = [...sessionList.querySelectorAll<HTMLButtonElement>(".session-select")].filter(
		(r) => !r.closest("[hidden]"),
	);
	if (rows.length === 0) return;
	const current = (e.target as HTMLElement).closest<HTMLElement>(".session-item");
	const i = rows.findIndex((r) => r.closest(".session-item") === current);
	const next =
		e.key === "Home"
			? 0
			: e.key === "End"
				? rows.length - 1
				: e.key === "ArrowDown"
					? Math.min(rows.length - 1, i + 1)
					: Math.max(0, i - 1);
	rows[next]?.focus();
	e.preventDefault();
});

// The tab a route asked for while the session's tab list is still
// loading. openSession lands on it once the tabs arrive, so a route that
// supersedes the deep link during the load (tab-2 after tab-1) wins the
// screen the way it already won the address.
let wantedTabId: string | null = null;

// How long the landing may wait for the "has history" answer of a session
// opened for the first time in this browser (viewPolicy.ts). Past it the
// session lands as if it had none; the Chat list corrects the memory.
const LANDING_HISTORY_WAIT_MS = 1500;

/**
 * Resolve the landing view (UI unification §9, decision 1) for a session
 * being selected. Synchronous when the person's choice or the history
 * answer is already remembered; otherwise the one request that decides
 * Chat vs Terminal/Files runs now, in parallel with the tab listing.
 */
function decideLanding(sessionId: string, running: boolean): View | Promise<View> {
	if (currentShell() !== "v2") return landingFor(sessionId, running);
	if (readViewPref(sessionId) !== null || readHistoryHint(sessionId) !== null) {
		return landingFor(sessionId, running);
	}
	const asked = fetchConversations(sessionId, { capture: false })
		.then((d) => {
			writeHistoryHint(sessionId, d.conversations.length > 0);
			return d.conversations.length > 0;
		})
		.catch(() => null);
	const wait = new Promise<null>((resolve) =>
		setTimeout(() => resolve(null), LANDING_HISTORY_WAIT_MS),
	);
	return Promise.race([asked, wait]).then(() => landingFor(sessionId, running));
}

export async function openSession(
	sessionId: string,
	opts: { tabId?: string | null; view?: View | null } = {},
) {
	if (activeSessionId === sessionId) return;
	wantedTabId = opts.tabId ?? null;

	// Tabs stay alive across tab-switch, but are torn down on session-switch.
	disposeAllCurrentTerminals();
	disconnectedTabId = null;

	setActiveSessionId(sessionId);
	renderSessionList();
	const meta = sessions.find((x) => x.sessionId === sessionId);
	const running = meta?.status === "running";
	// The landing view (viewPolicy.ts) — shell v2 only; v1 keeps its own
	// flow below (the open view stays, a stopped session opens in Files) —
	// unless the route names one (the router applies it right after).
	// While it is being decided the view sync must not land a fallback of
	// its own, and a view the person picks meanwhile wins over it.
	const landing = opts.view || currentShell() !== "v2" ? null : decideLanding(sessionId, running);
	const choiceAt = choiceGeneration();
	// The pending landing belongs to THIS session (viewSwitch keys it by
	// id): an overlapping open of another session neither ends it early
	// nor is blocked by it, and every exit of this function ends it.
	if (landing !== null) beginLanding(sessionId);
	try {
		await openSessionBody(sessionId, meta, running, landing, choiceAt);
	} finally {
		if (landing !== null) endLanding(sessionId);
	}
}

async function openSessionBody(
	sessionId: string,
	meta: SessionInfo | undefined,
	running: boolean,
	landing: View | Promise<View> | null,
	choiceAt: number,
): Promise<void> {
	// updateToolbar → syncSessionViews re-keys every view to this session
	// (and may force Files for a stopped one); only then is the address
	// written, in place — selecting a session is not a history entry.
	updateToolbar();
	reflectRoute({ push: false });
	// A landing that needs the history answer waits for it (bounded); the
	// tab listing below runs meanwhile, so a running session loses nothing.
	const land = async (): Promise<boolean> => {
		if (landing === null) return true;
		const v = landing instanceof Promise ? await landing : landing;
		endLanding(sessionId);
		if (activeSessionId !== sessionId) return false;
		// The person chose a view while this was deciding: theirs stands.
		if (choiceGeneration() !== choiceAt) return true;
		landView(v, { forced: !running });
		return true;
	};

	// Not running → no tmux to list tabs from or attach to, but the
	// workspace is on the host: open straight into the Files view (or
	// Chat, with history, under shell v2). refreshSessions re-opens it
	// properly once the session is started.
	if (meta && !running) {
		filesOnlySessionId = sessionId;
		if (landing === null) showFilesOnly();
		else await land();
		return;
	}
	filesOnlySessionId = null;

	// Capturing `sessionId` guards against a rapid second openSession call
	// clobbering this one — each `await` re-checks identity.
	try {
		const tabs = await listTabs(sessionId);
		if (activeSessionId !== sessionId) return;
		if (!(await land())) return;
		// Sort by creation order so +-added tabs stay on the right
		// (listTabs returns alphabetical from tmux list-sessions).
		setCurrentTabs(tabs.sort((a, b) => a.createdAt - b.createdAt));
	} catch (err) {
		// Drop back to empty state so the toolbar/container don't linger
		// visible with no tabs.
		if (activeSessionId === sessionId) {
			setActiveSessionId(null);
			// Un-reflect the failed selection so a reload doesn't replay
			// the broken deep link (#419).
			clearRoute();
			setCurrentTabs([]);
			renderSessionList();
			updateToolbar();
		}
		showToast((err as Error).message, true);
		return;
	}

	// Freshly-spawned session legitimately has zero tabs — the container no
	// longer creates one at boot. Render just the + so the user can open
	// their first tab, and keep the terminal pane hidden.
	if (currentTabs.length === 0) {
		renderTabBar();
		// On mobile the chrome drawer (where the + button lives) is
		// collapsed by default — auto-expand it for the empty session
		// so the user can actually find the + without hunting for it.
		if (isMobile()) setChromeOpen(true);
		return;
	}

	// Tapping a session in the sidebar drawer is the user's "go to that
	// tmux" gesture; collapse the chrome drawer too so the freshly-attached
	// terminal gets the full viewport. Mirrors the chip-click and addTab
	// success paths — without this, switching session-to-session on mobile
	// leaves whichever drawer state was last set by the previous session
	// covering the top of the viewport.
	if (isMobile()) setChromeOpen(false);

	// Render the tab bar BEFORE calling openTab — disposeAllCurrentTerminals()
	// at the top of openSession set #terminal-tabs to display:none, and
	// openTab's own renderTabBar() runs at its tail (after the new pane has
	// been mounted and openTerminalSession's synchronous fitAddon.fit() has
	// already read pane dimensions). Without this pre-render the first auto-
	// opened tab fits at the too-tall geometry of a tab-bar-less layout, the
	// WS opens at that wrong cols/rows (geometry is baked into the upgrade
	// URL — see terminal.ts buildWsUrl), and the backend's attach() / tmux
	// resize-window runs at the wrong size. ResizeObserver corrects xterm
	// locally on the next frame but the backend resize is debounced 100 ms,
	// so the snapshot replay and the first ~100 ms of tmux output land at
	// the wrong row count — visible as a one-row drift where typed input
	// renders below where the prompt actually is, only fixable by a
	// subsequent layout-changing event (sidebar toggle) that bumps tmux
	// into a full repaint at the correct geometry. Subsequent openTab
	// calls (chip clicks, +-add) don't hit this because the tabs row is
	// already laid out by then. openTab's own renderTabBar() at its tail
	// re-runs to mark the active chip — this pre-render just ensures the
	// height is settled.
	renderTabBar();

	// openTab can throw synchronously (openTerminalSession init failure) —
	// openSession is called with `void`, so an unhandled throw here would
	// become an unhandled rejection with no toast and the UI left mid-switch.
	// A route may name the tab to land on (#/sessions/<id>/terminal/<tab>);
	// the latest one asked for during the load wins.
	const asked = wantedTabId;
	wantedTabId = null;
	const wanted = asked && currentTabs.some((t) => t.tabId === asked) ? asked : null;
	try {
		openTab(wanted ?? currentTabs[0]!.tabId);
	} catch (err) {
		if (activeSessionId === sessionId) {
			setActiveSessionId(null);
			setCurrentTabs([]);
			renderSessionList();
			updateToolbar();
		}
		showToast((err as Error).message, true);
	}
}

/**
 * Apply a route from the address bar (#419, UI unification PR 5): on load
 * after the own-session list has loaded, on Back/Forward and on a pasted
 * URL (router.ts → main.ts).
 *
 * Resolution order for the session:
 *   1. Own session → select it (same path as a sidebar click), then the
 *      view and detail the route names.
 *   2. Not own + admin → resolve via the admin list and open the observe
 *      modal (take-control available, exactly the dashboard's path).
 *   3. Anything else → one "Session not found" toast and the address
 *      cleared, so a reload does not replay it.
 *
 * No-existence-leak invariant: for a NON-admin, foreign and nonexistent
 * ids take the identical branch — the own-list check is client-side and
 * no probe request is ever made, so the toast can't differ in timing or
 * wording between the two. (For admins the distinction is fine: the
 * admin list already shows every session.)
 */
// Every route application bumps this; a continuation that resumes after
// an await and finds a newer one is stale — even for the same session
// (Back then Forward in quick succession) — and does nothing.
let routeGen = 0;

export async function applyRoute(route: Route | null): Promise<void> {
	if (route === null) return;
	const gen = ++routeGen;
	const id = route.sessionId;
	if (id !== activeSessionId) {
		if (sessions.some((s) => s.sessionId === id)) {
			// The address already names the route; opening the session must
			// not rewrite it on the way (its own in-place writes are held).
			beginRouteApply(id);
			try {
				await openSession(id, {
					tabId: route.view === "terminal" ? route.detail : null,
					view: route.view,
				});
			} finally {
				endRouteApply();
			}
			// A newer route landed while this one was opening the session.
			if (gen !== routeGen || activeSessionId !== id) return;
			// No view in the address: the session landed where the policy
			// (v2) or the v1 flow put it, with its writes held above — put
			// that view in the address now, in place.
			if (route.view === null) {
				reflectRoute({ push: false });
				return;
			}
		} else {
			if (isAdmin()) {
				try {
					const rows = await fetchAdminSessions();
					if (gen !== routeGen) return;
					const s = rows.find((r) => r.sessionId === id);
					if (s) {
						if (s.status !== "running") {
							// Mirrors the dashboard, which only offers Observe on
							// running rows — the WS attach needs a live container.
							showToast(`Session "${s.name}" is not running — nothing to observe`, true);
							return;
						}
						// Same target shape as the dashboard's openAdminObserve
						// (#admin-operate 4/4): observe first, take-control offered.
						void openObserveModalFor({
							sessionId: s.sessionId,
							name: s.name,
							ownerUsername: s.ownerUsername,
							canOperate: true,
							canReconnect: async () =>
								(await fetchAdminSessions()).some(
									(x) => x.sessionId === s.sessionId && x.status === "running",
								),
						});
						return;
					}
				} catch {
					// Admin-list fetch failed (transient) — fall through to the
					// generic toast rather than surfacing a scarier error for
					// what is just a navigation.
				}
			}
			if (gen !== routeGen) return;
			// Nothing is known yet (the first list request failed): keep the
			// address — the session may well exist — and let the next
			// successful load apply the route. "Not found" is only a verdict
			// over a list that did load.
			if (!listLoaded && sessions.length === 0) return;
			showToast("Session not found", true);
			clearRoute();
			return;
		}
	}
	applyRouteView(route.view, route.detail);
}

// The terminal's route detail is the active tab. Switching tabs updates
// the address in place (openTab), never as a history entry.
registerRouteDetail("terminal", {
	current: () => currentActiveTabId,
	apply: (tabId) => {
		if (tabId === null || tabId === currentActiveTabId) return;
		if (!currentTabs.some((t) => t.tabId === tabId)) {
			// Not listed yet: openSession lands on it when the list arrives.
			if (currentTabs.length === 0) wantedTabId = tabId;
			return;
		}
		try {
			openTab(tabId);
		} catch (err) {
			showToast((err as Error).message, true);
		}
	},
});

export function updateToolbar() {
	renderToolbarAgent();
	const s = sessions.find((x) => x.sessionId === activeSessionId);
	if (!s) {
		terminalToolbar.style.display = "none";
		terminalTabs.style.display = "none";
		terminalContainer.style.display = "none";
		emptyState.style.display = "flex";
		terminalStateEl.hidden = true;
		terminalStateEl.replaceChildren();
		updateChromeToggle();
		syncSessionViews();
		return;
	}
	terminalToolbar.style.display = "flex";
	// #terminal-tabs and #terminal-container are flipped to visible only
	// by renderTabBar/openTab — avoids an empty-bar flash before listTabs
	// resolves.
	emptyState.style.display = "none";
	terminalSessionName.textContent = s.name;
	// The bar shows a long name with an ellipsis (terminal.css): the full one on hover.
	terminalSessionName.title = s.name;
	// A running session whose terminal gave up reads "disconnected" until
	// a pane is attached again (Reconnect) — the server-side status alone
	// would say "running" over an empty area.
	const badge =
		s.status === "running" && disconnectedTabId !== null && currentActiveTabId === null
			? "disconnected"
			: s.status;
	terminalStatusBadge.textContent = badge;
	terminalStatusBadge.className = badge;
	// Refresh the mobile header context pill — its label tracks the
	// active session/tab, and visibility flips on/off here.
	updateChromeToggle();
	syncSessionViews();
	renderTerminalState();
}

// ── Tabs within the active session ──────────────────────────────────────────

export function renderTabBar() {
	const active = document.activeElement;
	const focusedTab =
		active instanceof HTMLElement && terminalTabs.contains(active)
			? active.closest<HTMLElement>(".tab-chip")?.dataset.tabId
			: undefined;
	tabStrip.replaceChildren();
	if (!activeSessionId) {
		terminalTabs.style.display = "none";
		renderTerminalState();
		return;
	}
	// Render even at currentTabs.length === 0 so the + button is reachable
	// — a brand-new session starts with no tabs and the user opens the
	// first one from here.
	terminalTabs.style.display = "flex";
	tabStrip.setAttribute("role", "tablist");
	tabStrip.setAttribute("aria-label", "Terminal tabs");

	for (const tab of currentTabs) {
		const chip = document.createElement("div");
		const badge = badgeFor(tab.tabId);
		const isActive = tab.tabId === currentActiveTabId;
		chip.className = `tab-chip${isActive ? " active" : ""}${badge ? ` activity-${badge}` : ""}`;
		chip.dataset.tabId = tab.tabId;

		// The chip's button is the tab (keyboard, screen readers); the close
		// button sits beside it, never inside it.
		const select = document.createElement("button");
		select.type = "button";
		select.className = "tab-chip-btn";
		select.setAttribute("role", "tab");
		select.setAttribute("aria-selected", String(isActive));
		select.tabIndex = isActive || (currentActiveTabId === null && tab === currentTabs[0]) ? 0 : -1;
		select.title = tab.label;
		const label = document.createElement("span");
		label.className = "tab-chip-label";
		label.textContent = tab.label;
		select.appendChild(label);
		select.addEventListener("click", () => {
			// Click handlers eat synchronous throws — surface them as
			// a toast instead of letting the UI silently revert.
			try {
				openTab(tab.tabId);
			} catch (err) {
				showToast((err as Error).message, true);
			}
		});
		chip.appendChild(select);

		const close = document.createElement("button");
		close.type = "button";
		close.className = "tab-close";
		close.textContent = "×";
		close.title = "Close tab";
		close.setAttribute("aria-label", `Close tab ${tab.label}`);
		close.disabled = closingTabs.has(tab.tabId);
		close.addEventListener("click", () => {
			void closeTab(tab.tabId, close);
		});
		chip.appendChild(close);
		tabStrip.appendChild(chip);
	}

	const addBtn = document.createElement("button");
	addBtn.id = "tab-add";
	addBtn.type = "button";
	addBtn.textContent = "+";
	addBtn.title = "Open a new tab (runs services independently; close to SIGHUP them)";
	addBtn.setAttribute("aria-label", "Open a new tab");
	addBtn.addEventListener("click", () => void addTab(addBtn));
	tabStrip.appendChild(addBtn);
	if (focusedTab !== undefined) {
		terminalTabs
			.querySelector<HTMLElement>(
				`.tab-chip[data-tab-id="${CSS.escape(focusedTab)}"] .tab-chip-btn`,
			)
			?.focus();
	}
	// The chrome-toggle label tracks whichever tab is active — refresh
	// every time the bar is rebuilt so renames/closes/switches stay in
	// sync without having to thread updateChromeToggle() through every
	// caller of openTab/addTab/closeTab.
	updateChromeToggle();
	renderTerminalState();
}

// ← / → / Home / End move between tabs (WAI-ARIA tabs, manual activation:
// Enter / Space on the focused tab opens it).
terminalTabs.addEventListener("keydown", (e) => {
	if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
	const tabs = [...terminalTabs.querySelectorAll<HTMLButtonElement>(".tab-chip-btn")];
	if (tabs.length === 0) return;
	const i = tabs.findIndex(
		(b) => b === document.activeElement || b.contains(document.activeElement),
	);
	const next =
		e.key === "Home"
			? 0
			: e.key === "End"
				? tabs.length - 1
				: e.key === "ArrowRight"
					? (i + 1) % tabs.length
					: (i - 1 + tabs.length) % tabs.length;
	tabs[next]?.focus();
	e.preventDefault();
});

// Targeted repaint of one chip's activity badge (#359) — output streams
// per-chunk, so rebuilding the whole bar on every state flip would churn
// DOM for nothing when only a class pair changes.
function updateChipBadge(tabId: string) {
	const chip = terminalTabs.querySelector(`.tab-chip[data-tab-id="${CSS.escape(tabId)}"]`);
	if (!chip) return;
	const badge = badgeFor(tabId);
	chip.classList.toggle("activity-output", badge === "output");
	chip.classList.toggle("activity-bell", badge === "bell");
}

/**
 * Show the Terminal on one of the active session's tabs (Chat's "Open
 * terminal" for a conversation: its pane lives in that tab, and landing on
 * whichever tab happened to be active sent people to the wrong Claude).
 * The Terminal is shown in every case; the tab is switched only on "opened".
 * "not-running": the session is down (the Terminal shows its stopped state,
 * nothing else to say); "unknown": not one of the session's tabs; "failed":
 * listed, but the switch did not happen — the caller says so.
 */
export function showTerminalTab(
	tabId: string | null,
): "opened" | "not-running" | "unknown" | "failed" {
	setView("terminal");
	const s = sessions.find((x) => x.sessionId === activeSessionId);
	if (!s || s.status !== "running") return "not-running";
	if (tabId === null || !currentTabs.some((t) => t.tabId === tabId)) return "unknown";
	try {
		openTab(tabId);
	} catch (err) {
		showToast((err as Error).message, true);
		return "failed";
	}
	return currentActiveTabId === tabId ? "opened" : "failed";
}

function openTab(tabId: string) {
	if (!activeSessionId) return;
	if (tabId === currentActiveTabId) return;
	if (!currentTabs.some((t) => t.tabId === tabId)) return;

	// Only spin up a terminal for a running session — matches the sidebar.
	// Treat a missing sessions[] entry as not-running too; if the list is
	// stale or the session was deleted externally, attaching would just
	// fail via the WS and leave a blank pane mounted as the active tab.
	const s = sessions.find((x) => x.sessionId === activeSessionId);
	if (!s || s.status !== "running") {
		showToast("Session isn't running — start it first", true);
		return;
	}

	// Capture the previously-active tab before stripping .active so we can
	// restore the UI if openTerminalSession throws below — otherwise the
	// prev pane stays invisible AND the `tabId === currentActiveTabId`
	// guard above prevents the user from re-clicking its chip.
	const prevActiveTabId = currentActiveTabId;
	if (currentActiveTabId) {
		currentTerminals.get(currentActiveTabId)?.pane.classList.remove("active");
	}

	// Lazily spin up the xterm+WS; re-opens of the same tab just toggle
	// .active without reconnecting.
	let entry = currentTerminals.get(tabId);
	if (!entry) {
		const pane = document.createElement("div");
		// `active` from creation, and the parent flipped to display:block
		// BEFORE openTerminalSession runs. xterm's fit() inside that call
		// is synchronous and reads container.clientWidth/Height — if the
		// pane is still inside a display:none subtree it sees 0, falls
		// back to the 80x24 default, and the WS opens at that bogus
		// geometry. tmux then attaches/resumes at 80x24 and the visible
		// terminal shows mis-columned output until the next resize event
		// (sidebar toggle, viewport change) bumps it to real cols/rows.
		pane.className = "tab-pane active";
		pane.dataset.tabId = tabId;
		terminalContainer.appendChild(pane);
		terminalContainer.style.display = "block";

		// Capture the sessionId for this terminal — if the user switches
		// sessions while this WS is closing, `onStatus("disconnected")`
		// mustn't write to whatever session happens to be active *now*.
		const ownSessionId = activeSessionId;
		try {
			const term = openTerminalSession({
				container: pane,
				sessionId: ownSessionId,
				tabId,
				// Sticky-Ctrl from the mobile key bar. One shared transform
				// across every tab — the armed state lives in keyBar.ts (the
				// bar is a global widget), so whichever tab receives the next
				// keystroke consumes the same state the button displays.
				transformInput: transformKeyInput,
				// Auto-reconnect probe (#356): consulted before each retry so
				// a session stopped from another device doesn't get hammered
				// with doomed attach attempts (the backend has no "stopped"
				// close code — the exec stream just ends). A thrown probe is
				// treated as inconclusive by terminal.ts (keep retrying) —
				// during a Tunnel blip REST is as dead as the WS, and only a
				// definitive "not running" should abort the loop.
				canReconnect: async () => (await getSession(ownSessionId)).status === "running",
				onOutput: (data: string) => {
					// Session guard mirrors onStatus/onError: a chunk draining
					// from a torn-down tab after a session switch must not
					// badge whatever chip happens to hold this tabId now.
					if (activeSessionId !== ownSessionId) return;
					if (recordOutput(tabId, data, tabId === currentActiveTabId)) {
						updateChipBadge(tabId);
					}
				},
				onStatus: (status: SessionStatus) => {
					if (activeSessionId !== ownSessionId) return;

					if (status === "disconnected") {
						// "disconnected" is a frontend-only synthetic state
						// fired by ws.onclose — the backend never sends it.
						// Writing it into s.status casts an out-of-type value
						// into SessionInfo.status (typed only as
						// "running"|"stopped"|"terminated") and used to brick
						// the session on any transient WS drop (Cloudflare
						// Tunnel idle timeout ≈100 s, JWT refresh, network
						// blip):
						//   - the sidebar click handler matches neither
						//     "running" nor "stopped" → clicking the session
						//     became a silent no-op. Users reported this as
						//     "my tab went invalid when I came back to the
						//     session" — it's the session, not the tab.
						//   - openTab's `status !== "running"` guard refused
						//     to attach on a perfectly healthy backend.
						//
						// Leave s.status alone; pull the authoritative status
						// with refreshSessions() so the sidebar reflects
						// whatever the backend actually says. Also tear down
						// the dead terminal for this tab so a later click on
						// its chip recreates a fresh WebSocket instead of
						// re-activating a frozen pane. The tab itself stays
						// in currentTabs (still a valid tmux session on the
						// backend) so it remains reachable from the tab bar.
						const entry = currentTerminals.get(tabId);
						if (entry) {
							// queueMicrotask so we don't dispose xterm
							// synchronously inside its own ws.onclose
							// callback chain.
							queueMicrotask(() => {
								const latest = currentTerminals.get(tabId);
								if (!latest || latest !== entry) return;
								latest.term.dispose();
								latest.pane.remove();
								currentTerminals.delete(tabId);
								if (currentActiveTabId === tabId) {
									setCurrentActiveTabId(null);
									disconnectedTabId = tabId;
									terminalContainer.style.display = "none";
									// refreshSessions() below will eventually round-trip
									// and call updateToolbar(), but until that resolves
									// the toolbar still shows the session name + status
									// badge with no terminal beneath it. Match the rest
									// of the codebase (closeTab, openSession's error
									// paths) by syncing the toolbar to the new state
									// synchronously — if the session was meanwhile
									// dropped from sessions[] (rare, but possible if
									// refreshSessions raced ahead), the empty-state
									// panel takes over instead of an orphan toolbar.
									updateToolbar();
								}
								renderTabBar();
							});
						}
						void refreshSessions();
						return;
					}

					if (status === "reconnecting") {
						// Synthetic frontend-only state like "disconnected"
						// above: fired while terminal.ts retries a dropped WS
						// with backoff (#356). Badge-only — it must never land
						// in s.status (same out-of-type footgun documented on
						// the disconnected branch), and the terminal for this
						// tab is deliberately NOT torn down: the retry loop
						// owns the socket, and a successful re-attach repaints
						// in place. Only the active tab may repaint the shared
						// badge (same rule as the backend-status path below).
						if (tabId !== currentActiveTabId) return;
						terminalStatusBadge.textContent = "reconnecting";
						terminalStatusBadge.className = "reconnecting";
						return;
					}

					// Backend-sourced status ("running" on attach). Only the
					// active tab drives the shared session badge — a background
					// tab's signal must not override the foreground view.
					if (tabId !== currentActiveTabId) return;
					const s = sessions.find((x) => x.sessionId === ownSessionId);
					if (s) s.status = status;
					updateToolbar();
					renderSessionList();
				},
				onError: (msg: string) => {
					// Same identity guard as onStatus: background tabs
					// and post-session-switch WS errors must not surface
					// toasts attributed to whatever session is current now.
					if (activeSessionId !== ownSessionId) return;
					showToast(msg, true);
				},
				onRendererFallback: (msg: string) => {
					// Show even for non-active tabs — a backgrounded tab
					// that loses its WebGL context will surface the
					// notice when it next becomes active or, in this
					// flow, immediately. Toast is once per renderer tier
					// (webgl→canvas, canvas→dom; gated inside
					// terminal.ts) so a flapping driver can't spam it —
					// worst case two toasts per tab. Surfaced as a
					// non-error toast because the terminal still works,
					// just slower.
					// Suffix is tier-agnostic on purpose: for the webgl→canvas
					// notice a reload genuinely retries GPU rendering, but for
					// the canvas→dom notice (both tiers failing on this
					// hardware) promising "GPU rendering" back would be
					// over-selling what a reload can do.
					showToast(`${msg} Reload the tab to try again.`);
				},
				onCopy: (ok: boolean) => {
					// Identity guards mirror onStatus / onError above:
					// session match prevents stale toasts from a
					// torn-down tab in a different session, and active-tab
					// match prevents a background tab in the SAME session
					// from toasting against whatever pane the user is
					// currently looking at.
					if (activeSessionId !== ownSessionId) return;
					if (tabId !== currentActiveTabId) return;
					if (ok) {
						// Success chip is intentionally brief (1.2s vs the
						// 4s error toast) — auto-copy fires on every
						// selection-finalise, and originally the design
						// rationale for failure-only was "matches native
						// Cmd-C feel". Field reports showed users with no
						// signal that the copy happened didn't trust the
						// mechanism — the short chip is the smallest
						// addition that confirms without spamming. The
						// chip is unconditional rather than first-time-
						// only because the auto-copy path is genuinely
						// invisible (no Cmd-C kinaesthetic feedback,
						// selection stays highlighted as terminals do)
						// and a one-time confirmation would leave power
						// users wondering "did that one copy too?".
						showCopySuccessToast();
					} else {
						showToast("Copy failed — clipboard permission denied?", true);
					}
				},
				isActive: () => activeSessionId === ownSessionId && tabId === currentActiveTabId,
			});
			entry = { pane, term };
			currentTerminals.set(tabId, entry);
			maybeInjectSelectionHint(pane);
		} catch (err) {
			pane.remove();
			if (prevActiveTabId) {
				currentTerminals.get(prevActiveTabId)?.pane.classList.add("active");
			} else {
				// We just flipped terminalContainer to display:block to host
				// the new pane; with no prev pane to swap back to and our
				// pane removed, leaving display:block would render an empty
				// dark box. Revert.
				terminalContainer.style.display = "none";
			}
			throw err;
		}
	}

	entry.pane.classList.add("active");
	terminalContainer.style.display = "block";
	setCurrentActiveTabId(tabId);
	disconnectedTabId = null;
	updateToolbar();
	reflectRoute({ push: false });
	// Activation acknowledges the pending activity — the user is now
	// looking at whatever rang/streamed. renderTabBar() below repaints
	// the chip from the cleared state.
	clearBadge(tabId);
	renderTabBar();
}

async function addTab(triggeredBy?: HTMLButtonElement) {
	if (!activeSessionId) return;
	const sessionId = activeSessionId;
	const sessionName =
		sessions.find((x) => x.sessionId === sessionId)?.name ?? sessionId.slice(0, 8);
	// Pre-check: don't create a backend tab we can't attach to. Matches
	// openTab's own guard so this short-circuits before the POST. Treat
	// "session missing from local list" as not-running too, matching both
	// openTab and the post-check below.
	const statusBefore = sessions.find((x) => x.sessionId === sessionId)?.status;
	if (!statusBefore || statusBefore !== "running") {
		showToast("Session isn't running — start it first", true);
		return;
	}
	if (triggeredBy) triggeredBy.disabled = true;
	try {
		// Default label: smallest "Tab N" not already in use. Using
		// `currentTabs.length + 1` would collide after a middle tab
		// was closed (e.g. [Tab 1, Tab 3] + add → another "Tab 3").
		const tab = await createTab(sessionId, nextDefaultLabel());
		if (activeSessionId !== sessionId) {
			// User switched away before the POST resolved. The backend tab
			// exists but was never shown; clean it up so it doesn't resurface
			// on the next listTabs for that session. Fire-and-forget, but if
			// the cleanup fails surface a toast — include the owning session
			// name so the user knows WHICH session has the orphan, not just
			// whichever session happens to be active now.
			void deleteTab(sessionId, tab.tabId).catch((err) => {
				console.warn(`[tabs] orphan cleanup failed for ${tab.tabId}:`, err);
				showToast(`Orphan tab left on "${sessionName}": ${(err as Error).message}`, true);
			});
			return;
		}
		// Post-check: session may have stopped during the POST round-trip.
		// openTab returns early (silent toast + return) on non-running
		// sessions, which would otherwise leave us with currentTabs and
		// a backend tab both pointing at an unattachable tmux session.
		const statusAfter = sessions.find((x) => x.sessionId === sessionId)?.status;
		if (!statusAfter || statusAfter !== "running") {
			void deleteTab(sessionId, tab.tabId).catch((err) => {
				console.warn(`[tabs] post-stop cleanup failed for ${tab.tabId}:`, err);
				showToast(`Orphan tab left on "${sessionName}": ${(err as Error).message}`, true);
			});
			showToast("Session stopped — tab discarded", true);
			return;
		}
		currentTabs.push(tab);
		try {
			openTab(tab.tabId);
			// The tab-bar click listener auto-closes the chrome drawer
			// on chip clicks, but the + button is filtered out of that
			// path (it's not a chip yet at click time). Mirror the
			// behaviour here so adding a tab on mobile drops the user
			// straight into the new tmux pane instead of leaving the
			// drawer covering the top of the viewport.
			if (isMobile()) setChromeOpen(false);
		} catch (err) {
			// Roll back the push so the chip doesn't linger pointing at a
			// tab with no currentTerminals entry, and clean up the backend
			// tab fire-and-forget since it was never actually shown.
			setCurrentTabs(currentTabs.filter((t) => t.tabId !== tab.tabId));
			void deleteTab(sessionId, tab.tabId).catch((cleanupErr) => {
				console.warn(`[tabs] rollback cleanup failed for ${tab.tabId}:`, cleanupErr);
				showToast(`Orphan tab left on "${sessionName}": ${(cleanupErr as Error).message}`, true);
			});
			renderTabBar();
			throw err;
		}
	} catch (err) {
		showToast((err as Error).message, true);
	} finally {
		// The inner-catch renderTabBar() rebuilds the + button, so the
		// original triggeredBy may be detached by the time we get here.
		if (triggeredBy?.isConnected) triggeredBy.disabled = false;
	}
}

function nextDefaultLabel(): string {
	const used = new Set(currentTabs.map((t) => t.label));
	let n = 1;
	while (used.has(`Tab ${n}`)) n++;
	return `Tab ${n}`;
}

async function closeTab(tabId: string, triggeredBy?: HTMLButtonElement) {
	if (!activeSessionId) return;
	const sessionId = activeSessionId;
	if (closingTabs.has(tabId)) return; // duplicate invocation for same tab
	const tabLabel = currentTabs.find((t) => t.tabId === tabId)?.label ?? tabId;
	const ok = await confirmDialog({
		title: "Close tab",
		message: `Close tab "${tabLabel}"?\n\nAny process running in this tab is terminated (SIGHUP).`,
		confirmLabel: "Close tab",
		danger: true,
	});
	// The session may have switched while the question was open.
	if (!ok || activeSessionId !== sessionId || closingTabs.has(tabId)) return;
	closingTabs.add(tabId);
	// Re-render so sibling chips' × reflects the in-flight close (their
	// disabled state mirrors the same guard).
	renderTabBar();
	if (triggeredBy) triggeredBy.disabled = true;

	try {
		await deleteTab(sessionId, tabId);
	} catch (err) {
		// 404 means the backend already lost the tab (e.g. tmux server died).
		// Drop the stale chip from the UI rather than leaving the user stuck
		// with an unremovable phantom tab.
		if (err instanceof TabNotFoundError) {
			// fall through to the success path below
		} else {
			closingTabs.delete(tabId);
			renderTabBar();
			showToast((err as Error).message, true);
			if (triggeredBy?.isConnected) triggeredBy.disabled = false;
			return;
		}
	}
	closingTabs.delete(tabId);
	// Stale-session guard: renderTabBar() below rebuilds chips anyway, so
	// the old `triggeredBy` becomes detached — no need to re-enable it.
	if (activeSessionId !== sessionId) return;

	const closedIndex = currentTabs.findIndex((t) => t.tabId === tabId);
	const entry = currentTerminals.get(tabId);
	if (entry) {
		entry.term.dispose();
		entry.pane.remove();
		currentTerminals.delete(tabId);
	}
	setCurrentTabs(currentTabs.filter((t) => t.tabId !== tabId));
	clearBadge(tabId);

	// Closing the last tab on mobile leaves the chrome drawer collapsed
	// (default state), and the CSS hides #terminal-tabs entirely while
	// collapsed — so the + button rebuilt by renderTabBar() below isn't
	// reachable until the user discovers the header pill. Mirror the
	// openSession empty-tabs branch and auto-expand here too, so the
	// first new tab is always one tap away.
	if (isMobile() && currentTabs.length === 0) setChromeOpen(true);

	if (currentActiveTabId === tabId) {
		setCurrentActiveTabId(null);
		// Nearest surviving neighbour: what was at the same index is now
		// the next sibling; clamp to the new last tab when we closed the
		// rightmost one. If the tab wasn't in currentTabs at findIndex
		// time (state drifted from under us), fall back to index 0.
		const s = sessions.find((x) => x.sessionId === activeSessionId);
		if (currentTabs.length > 0 && s?.status === "running") {
			const idx = closedIndex < 0 ? 0 : Math.min(closedIndex, currentTabs.length - 1);
			const next = currentTabs[idx];
			if (next) {
				// closeTab runs as `void`, so a sync throw from openTab
				// (openTerminalSession init failure) would be swallowed.
				// openTab's own prevActiveTabId restore is a no-op here
				// since the prev tab was just removed — recover directly.
				try {
					openTab(next.tabId);
					return;
				} catch (err) {
					// Spell out the connection — the user sees a blank
					// panel otherwise with no hint why.
					showToast(`Couldn't switch to "${next.label}": ${(err as Error).message}`, true);
					terminalContainer.style.display = "none";
					renderTabBar();
					return;
				}
			}
		}
		// No running sibling to switch to — hide the container so we
		// don't leave an empty block sitting where the terminal was.
		terminalContainer.style.display = "none";
	}
	renderTabBar();
}
