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

import { agentHue, sidebarAgentStatus } from "./acpModel.js";
import { acpAgentsLoaded, acpAgentsReadAt, acpEntry, isAcpAgentSession } from "./acpRegistry.js";
import { readAcpAgents, startAcpStatusFeed } from "./acpStatusFeed.js";
import { openObserversModalFor } from "./admin.js";
import {
	createTab,
	deleteSession,
	deleteTab,
	fetchAdminSessions,
	getSession,
	isAdmin,
	isLead,
	isLoggedIn,
	listSessions,
	listTabs,
	type SessionInfo,
	startSession,
	stopSession,
	TabNotFoundError,
} from "./api.js";
import { type MenuItem, openActionMenu } from "./components/actionMenu.js";
import { confirmDialog } from "./components/dialog.js";
import { showCopySuccessToast, showToast } from "./components/toast.js";
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
	setCurrentActiveTabId,
	setCurrentTabs,
	setServerReachable,
	setSessions,
	updateTerminalControls,
} from "./main.js";
import { renderSidebarObservables } from "./myGroups.js";
import { openBootstrapLogModal } from "./newSession.js";
import { openObserveModalFor } from "./observeModal.js";
import { openPortsModalFor } from "./ports.js";
import { currentProject, projects } from "./projectDirectory.js";
import {
	clear as clearRoute,
	navigateProject,
	projectRouteHash,
	type Route,
	readRoute,
} from "./router.js";
import {
	type SessionActionContext,
	type SessionActionId,
	sessionActions,
	terminalState,
} from "./sessionActions.js";
import { badgeFor, clearBadge, recordOutput } from "./tabActivity.js";
import { openTerminalSession, type SessionStatus } from "./terminal.js";
import {
	applyRouteView,
	beginLanding,
	beginRouteApply,
	choiceGeneration,
	endLanding,
	endRouteApply,
	getView,
	landingFor,
	landView,
	reflectRoute,
	registerRouteDetail,
	setView,
	showFilesOnly,
	syncSessionViews,
	type View,
} from "./viewSwitch.js";

// ── DOM (re-queried locally) ─────────────────────────────────────────────
const sessionList = document.getElementById("session-list")!;
const sidebarRefreshBtn = document.getElementById(
	"sidebar-refresh-btn",
) as HTMLButtonElement | null;
const showTerminatedToggle = document.getElementById("show-terminated-toggle") as HTMLInputElement;
const terminalToolbar = document.getElementById("terminal-toolbar")!;
const terminalSessionName = document.getElementById("terminal-session-name")!;
const terminalSessionSub = document.getElementById("terminal-session-sub");
const sessionMenuBtn = document.getElementById("session-menu-btn") as HTMLButtonElement | null;
sessionMenuBtn?.addEventListener("click", () => openActiveSessionMenu(sessionMenuBtn));
const terminalStatusBadge = document.getElementById("terminal-status-badge")!;

/**
 * The session's state in the bar: a chip (base.css) with the word as the
 * server says it. Amber is for what needs the person, so a stopped or
 * disconnected session is the hollow grey of "not running", not a warning.
 */
const BADGE_TONE = new Map([
	["running", "ok"],
	["reconnecting", "busy"],
	["failed", "err"],
]);
function setStatusBadge(state: string): void {
	terminalStatusBadge.textContent = state;
	terminalStatusBadge.className = `chip tone-${BADGE_TONE.get(state) ?? "off"} ${state}`;
}
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
				showToast((err as Error).message, true);
			}
			return;
		}
	}
}

// ── The terminal's tab row on a phone ───────────────────────────────────────
// The person may hide it from the bar's ⋯ to give the terminal its height
// (one state per device, <html data-tabs="hidden">, applied by mobile.css on
// a phone only). Offered on the Terminal view; the state does not depend on
// the view, so a view switch still resizes nothing and the ⋯ item resizes
// once, which is the point. Nothing hides or shows it on its own.
const TABS_HIDDEN_KEY = "st.terminalTabsHidden";
function readTabsHidden(): boolean {
	try {
		return localStorage.getItem(TABS_HIDDEN_KEY) === "1";
	} catch {
		return false;
	}
}
function applyTabsHidden(hidden: boolean): void {
	if (hidden) document.documentElement.dataset.tabs = "hidden";
	else delete document.documentElement.dataset.tabs;
}
function setTabsHidden(hidden: boolean): void {
	applyTabsHidden(hidden);
	try {
		if (hidden) localStorage.setItem(TABS_HIDDEN_KEY, "1");
		else localStorage.removeItem(TABS_HIDDEN_KEY);
	} catch {
		/* storage unavailable: just not remembered */
	}
}
applyTabsHidden(readTabsHidden());

function tabRowItem(): MenuItem[] {
	if (!isMobile() || getView() !== "terminal" || currentTabs.length === 0) return [];
	const hint = "Tabs, search and text size row";
	return readTabsHidden()
		? [{ id: "tabs-show", label: "Show tabs", hint }]
		: [{ id: "tabs-hide", label: "Hide tabs", hint }];
}

/** The ⋯ menu of the ACTIVE session (the session bar). */
/**
 * What the bar's ⋯ shows first for the open session, before its actions —
 * acpChat.ts: "Ajustes del agente" for an agent's session (UX iter3 E: its
 * own header row goes; the bar is its header). `onPick` true = handled.
 */
type SessionMenuExtras = (s: SessionInfo) => { items: MenuItem[]; onPick: (id: string) => boolean };
let sessionMenuExtras: SessionMenuExtras | null = null;
export function setSessionMenuExtras(fn: SessionMenuExtras): void {
	sessionMenuExtras = fn;
}

function openActiveSessionMenu(opener: HTMLElement): void {
	const s = sessions.find((x) => x.sessionId === activeSessionId);
	if (!s) return;
	const extra = sessionMenuExtras?.(s);
	openActionMenu({
		title: s.name,
		opener,
		items: [...tabRowItem(), ...(extra?.items ?? []), ...sessionActions(actionContext(s))],
		onPick: (id) => {
			if (id === "tabs-hide" || id === "tabs-show") setTabsHidden(id === "tabs-hide");
			else if (!extra?.onPick(id)) void runSessionAction(s, id as SessionActionId);
		},
	});
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

/**
 * A session this tab just created, shown at once. Every list request already
 * on its way was read by the server BEFORE the creation: applied after it, its
 * answer would drop the new session from the sidebar until the next poll. So
 * they are retired (like a newer refresh would), and one fresh refresh follows.
 */
export function addCreatedSession(session: SessionInfo): void {
	listGen++;
	sessions.unshift(session);
	renderSessionList();
	void refreshSessions();
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
		// Who is an agent decides where a selected session lands: read it now,
		// so it is known before the first click (no wait in the normal case).
		if (firstLoad && !acpAgentsLoaded()) void readAcpAgents();
		setServerReachable(true);
		setSessions(list);
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

// ACP agents joined / left a project: their rows move between groups.
if (typeof window !== "undefined")
	window.addEventListener("st:acp-agents", () => {
		if (sessionListLoaded()) renderSessionList();
		paintBarIdentity();
	});
// Only an agent's state changed: its row and its group heading are
// repainted in place — no rebuild, so focus, scroll, hover and the
// groups' folding are untouched.
window.addEventListener("st:acp-status", () => {
	if (sessionListLoaded()) paintAgentStatus();
	paintBarIdentity();
});
// A project renamed: the bar's "proyecto ↗" link says the new name.
window.addEventListener("st:projects-changed", () => paintBarIdentity());

export function renderSessionList() {
	noteStarts();
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
	const focusedSectionMenu =
		active instanceof HTMLElement &&
		sessionList.contains(active) &&
		active.matches(".ssection-menu");
	sessionList.replaceChildren();
	// The tree (UX iter3 §1: projects → agents without a project → sessions).
	renderGroupedSessions();
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
	} else if (focusedSectionMenu) {
		sessionList.querySelector<HTMLElement>(".ssection-menu")?.focus();
	}
	paintAgentStatus();
	// Agents' states keep current without any chat open (acpStatusFeed.ts).
	startAcpStatusFeed();
	// Sidebar observables (#394) dedupe against THIS list, so re-render
	// them whenever it changes.
	renderSidebarObservables();
}

/**
 * Each agent row's state (mark + one word; the full label in its tooltip
 * and accessible name) and, on each group heading, whether an agent of the
 * group waits for the person — visible with the group folded. Run after
 * every build and on `st:acp-status`; it only touches the agent parts.
 */
function paintAgentStatus(): void {
	const now = acpAgentsReadAt();
	const asking = new Map<string, string[]>();
	for (const row of sessionList.querySelectorAll<HTMLElement>(".session-item[data-session-id]")) {
		const sid = row.dataset.sessionId!;
		const span = row.querySelector<HTMLElement>(".session-agent-status");
		const a = acpEntry(sid);
		const select = row.querySelector<HTMLElement>(".session-select");
		if (!span || !a || !select) continue;
		const st = sidebarAgentStatus(a, now, startedAt(sid));
		span.className = `session-agent-status chip bare tone-${st.tone}${st.asks ? " asks" : ""}`;
		span.textContent = st.word;
		select.dataset.agentLabel = st.label;
		labelSessionRow(select);
		if (st.asks) {
			const group = row.closest<HTMLElement>(".sgroup")?.dataset.group;
			if (group) asking.set(group, [...(asking.get(group) ?? []), `@${a.name}: ${st.label}`]);
		}
	}
	for (const head of sessionList.querySelectorAll<HTMLElement>(".sgroup-head")) {
		const group = head.parentElement?.dataset.group ?? "";
		const who = asking.get(group);
		let flag = head.querySelector<HTMLElement>(".sgroup-asks");
		// The heading's focusable controls (chevron, project link) describe the
		// flag: with the group folded, Tab through the headings still says it.
		const controls = head.querySelectorAll<HTMLElement>(".sgroup-toggle, a.sgroup-title");
		if (!who) {
			flag?.remove();
			for (const c of controls) c.removeAttribute("aria-describedby");
			continue;
		}
		if (!flag) {
			flag = document.createElement("span");
			flag.className = "sgroup-asks";
			flag.id = `sgroup-asks-${group.replace(/[^a-zA-Z0-9-]/g, "_")}`;
			head.querySelector(".sgroup-count")?.before(flag);
		}
		// "●N": how many agents of the group wait (the who, in words, below).
		flag.textContent = `●${who.length}`;
		const text = `${who.length === 1 ? "Un agente te espera" : `${who.length} agentes te esperan`}: ${who.join(", ")}`;
		flag.title = text;
		// Read through aria-describedby: its visible word plus who waits.
		const detail =
			flag.querySelector<HTMLElement>(".visually-hidden") ?? document.createElement("span");
		detail.className = "visually-hidden";
		detail.textContent = ` — ${text}`;
		flag.append(detail);
		for (const c of controls) c.setAttribute("aria-describedby", flag.id);
	}
}

/**
 * When each session was last seen (re)starting by this page: a session that
 * turned running between two polls; else its creation time. "iniciando" is
 * judged against it (acpModel.RUNNER_START_GRACE_MS).
 */
const startedSeenAt = new Map<string, number>();
const lastStatus = new Map<string, string>();
function noteStarts(): void {
	for (const s of sessions) {
		const prev = lastStatus.get(s.sessionId);
		if (prev !== undefined && prev !== "running" && s.status === "running")
			startedSeenAt.set(s.sessionId, Date.now());
		lastStatus.set(s.sessionId, s.status);
	}
}
/** The session's latest start this page knows of: its creation or a status turning `running`. */
function startedAt(sessionId: string): number | undefined {
	const s = sessions.find((x) => x.sessionId === sessionId);
	const created = s ? Date.parse(s.createdAt) : Number.NaN;
	const at = Math.max(startedSeenAt.get(sessionId) ?? 0, Number.isNaN(created) ? 0 : created);
	return at > 0 ? at : undefined;
}

/**
 * The row's accessible name STARTS with the words on the row, in their order
 * (WCAG 2.5.3 — a voice user says what they see; axe
 * `label-content-name-mismatch`), then says what the shapes and the tooltip
 * say: the session's status, the agent's full state.
 */
function labelSessionRow(select: HTMLElement): void {
	const words = [...select.querySelectorAll<HTMLElement>(".session-name, .session-meta > *")]
		.map((c) => c.textContent ?? "")
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	const status = select.dataset.status ?? "";
	const agent = select.dataset.agentLabel ? `, agente: ${select.dataset.agentLabel}` : "";
	// An agent's row shows "@name"; its session's name is said here (and in the tooltip).
	const session = select.dataset.sessionName ? ` ${select.dataset.sessionName}` : "";
	select.setAttribute(
		"aria-label",
		`${words}, session${session} ${status}${status === "failed" ? " — view the bootstrap log" : ""}${agent}`,
	);
	const base = select.dataset.baseTitle ?? "";
	const tip = [base, select.dataset.agentLabel ? `Agente: ${select.dataset.agentLabel}` : ""]
		.filter(Boolean)
		.join("\n");
	if (tip) select.title = tip;
	else select.removeAttribute("title");
}

/**
 * The rows are grouped by the project their ACP agent
 * takes part in (acpRegistry.ts), in the project list's order and including
 * the projects without a session yet — the tree is where projects are
 * listed. Then two sections: the agents that take part in no project, and
 * the sessions worked from their Terminal (buildSection).
 */
function renderGroupedSessions(): void {
	const byProject = new Map<string, SessionInfo[]>();
	for (const p of projects()) byProject.set(p.projectId, []);
	const loose: SessionInfo[] = [];
	for (const s of sessions) {
		const rows = byProject.get(acpEntry(s.sessionId)?.projectId ?? "");
		if (rows) rows.push(s);
		else loose.push(s);
	}
	for (const p of projects()) {
		const rows = byProject.get(p.projectId) ?? [];
		sessionList.appendChild(
			buildGroup({
				key: p.projectId,
				title: p.name,
				project: p.projectId,
				cls: "sgroup-project",
				tooltip: `Abrir ${p.name}`,
				rows: rows.map((s) => buildSessionItem(s)),
				// "shown": its sessions may also be terminated ones the list hides.
				empty: p.agentCount === 0 ? "Sin agentes todavía." : "No sessions shown.",
			}),
		);
	}
	// Then the agents that take part in no project, then the sessions worked
	// from their Terminal: two sections, never one mixed "Sin proyecto".
	const agents = loose.filter((s) => acpEntry(s.sessionId) !== null);
	const plain = loose.filter((s) => acpEntry(s.sessionId) === null);
	if (agents.length > 0)
		sessionList.appendChild(
			buildSection({
				key: "agents",
				title: "Agentes sin proyecto",
				rows: agents.map((s) => buildSessionItem(s)),
			}),
		);
	sessionList.appendChild(
		buildSection({
			key: "sessions",
			title: "Sessions",
			menu: true,
			rows: plain.map((s) => buildSessionItem(s)),
			empty: "No sessions shown.",
		}),
	);
}

/**
 * A section of the tree under its small heading: the agents without a
 * project, the sessions. Not foldable (the projects are). "Sessions" carries
 * a ⋯ with what used to sit above the whole list: "Show terminated" and
 * Refresh (the original controls stay in #sidebar-header, the flat list's).
 */
function buildSection(sec: {
	key: string;
	title: string;
	rows: HTMLElement[];
	menu?: boolean;
	empty?: string;
}): HTMLElement {
	const section = document.createElement("section");
	section.className = `ssection ssection-${sec.key}`;
	section.dataset.section = sec.key;
	const id = `ssection-title-${sec.key}`;
	section.setAttribute("aria-labelledby", id);
	const head = document.createElement("div");
	head.className = "ssection-head";
	const title = document.createElement("h3");
	title.id = id;
	title.textContent = sec.title;
	head.appendChild(title);
	if (sec.menu) {
		const more = document.createElement("button");
		more.type = "button";
		more.className = "btn btn-icon sm ssection-menu";
		more.textContent = "⋯";
		more.title = "Sessions: show terminated, refresh";
		more.setAttribute("aria-label", "Sessions options");
		more.setAttribute("aria-haspopup", "menu");
		more.addEventListener("click", () => openSessionsMenu(more));
		head.appendChild(more);
	}
	section.appendChild(head);
	const rows = document.createElement("div");
	rows.className = "ssection-rows";
	if (sec.rows.length === 0 && sec.empty) {
		const empty = document.createElement("p");
		empty.className = "sgroup-empty";
		empty.textContent = sec.empty;
		rows.appendChild(empty);
	}
	for (const r of sec.rows) rows.appendChild(r);
	section.appendChild(rows);
	return section;
}

/** The "Sessions" ⋯: the list's own options, through the original controls. */
function openSessionsMenu(opener: HTMLElement): void {
	const showing = showTerminatedToggle.checked;
	openActionMenu({
		title: "Sessions",
		opener,
		items: [
			{
				id: "terminated",
				label: showing ? "Hide terminated" : "Show terminated",
				hint: "Include terminated sessions so you can restore them",
			},
			{
				id: "refresh",
				label: "Refresh",
				hint: "Refresh sessions and live usage",
				enabled: sidebarRefreshBtn?.disabled !== true,
			},
		],
		onPick: (id) => {
			if (id === "terminated") {
				showTerminatedToggle.checked = !showing;
				showTerminatedToggle.dispatchEvent(new Event("change"));
			} else sidebarRefreshBtn?.click();
		},
	});
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
		const route = { projectId: g.project };
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

function buildSessionItem(s: SessionInfo): HTMLElement {
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

	// The tree names an ACP agent's row by the agent:
	// its face and "@name" (the same identity as in its chats), ONE indicator
	// — the agent's state — and the session's name in the tooltip and the
	// accessible name. Any other row: the session's status dot and its name.
	const acp = acpEntry(s.sessionId);
	const agentRow = acp !== null;
	if (agentRow) {
		const face = document.createElement("span");
		face.className = "acp-avatar session-avatar";
		// The initial is drawn by CSS (attr()): as text it would be a word of
		// the row's visible label that the accessible name does not start
		// with (WCAG 2.5.3, axe label-content-name-mismatch).
		face.dataset.initial = acp.name.slice(0, 1).toUpperCase();
		face.style.setProperty("--acp-hue", String(agentHue(acp.name)));
		face.setAttribute("aria-hidden", "true");
		select.appendChild(face);
		item.classList.add("session-agent-item");
		select.dataset.sessionName = s.name;
		select.title = s.name;
	} else {
		const dot = document.createElement("span");
		dot.className = `session-dot ${s.status}`;
		dot.setAttribute("aria-hidden", "true");
		select.appendChild(dot);
	}

	const nameCol = document.createElement("span");
	nameCol.className = "session-name-col";
	const name = document.createElement("span");
	name.className = agentRow ? "session-name session-agent-tag" : "session-name";
	name.textContent = agentRow ? `@${acp.name}` : s.name;
	nameCol.appendChild(name);
	const meta = document.createElement("span");
	meta.className = "session-meta";
	// CPU / memory are infrastructure detail in the tree — in the row's
	// tooltip, and on the row only when memory runs hot (UX audit N2: they
	// took two of each row's three lines and pushed the agent out of the
	// phone's row).
	if (s.status === "running" && s.usage) {
		const usage = `CPU ${formatCpuCores(s.usage.cpuPercent / 100)} cores (${formatCpuPercent(s.usage.cpuPercent)}) · Mem ${formatBytes(s.usage.memBytes)} (${s.usage.memPercent.toFixed(0)}%)`;
		select.title = `${s.name}\n${usage}`;
		if (s.usage.memPercent >= USAGE_HOT_PERCENT) {
			const hot = document.createElement("span");
			hot.className = "session-usage session-usage-hot";
			hot.textContent = `Mem ${s.usage.memPercent.toFixed(0)}%`;
			meta.appendChild(hot);
		}
	} else if (s.status !== "running") {
		// The dot's colour alone told stopped / terminated / failed apart.
		// The row's aria-label already says it: this line is for the eye.
		// An agent's row has no dot: the word is its one indicator, a chip.
		const state = document.createElement("span");
		state.className = agentRow
			? `session-state ${s.status} chip bare tone-${s.status === "failed" ? "err" : "off"}`
			: `session-usage session-state ${s.status}`;
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
	// The tree's agent row: while its container runs, the agent's state as a
	// chip (paintAgentStatus fills it); a stopped one says "Stopped" above —
	// "runner sin señal" would be noise.
	if (agentRow && s.status === "running") {
		const st = document.createElement("span");
		st.className = "session-agent-status chip bare";
		meta.appendChild(st);
	}
	// A space between the row's words: laid out by flex they need none, but
	// the row's text is read as one string (accessible-name checks, copy).
	for (const c of [...meta.children].slice(1)) c.before(" ");
	if (meta.childElementCount > 0) nameCol.append(" ", meta);
	select.appendChild(nameCol);
	// The accessible name: labelSessionRow (also run when an agent's state
	// changes). The agent is one of the row's words ("@handle" and its state).
	select.dataset.status = s.status;
	if (select.title) select.dataset.baseTitle = select.title;
	labelSessionRow(select);
	select.addEventListener("click", () => {
		// A failed session has no workspace: the row opens its log.
		void runSessionAction(s, s.status === "failed" ? "viewLog" : "open");
	});
	item.appendChild(select);
	// A tap on the row's padding between its controls is a tap on the row
	// (select), not a dead zone.
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

// How long a selection may wait for the agents list. It is read when the
// session list first loads (refreshSessions), so normally it is in before
// the first click and nothing waits; this only covers a click in the first
// instants after load. A read is one request with three D1 queries in
// parallel — about one D1 round trip — so 500 ms covers it with margin,
// while a slow or failing list costs at most half a second, once.
const LANDING_AGENTS_WAIT_MS = 500;
/**
 * A selection already waited for the list in this page load and it was not
 * there (late or failed): later selections never wait — they take "not an
 * agent" at once while the read goes on (acpStatusFeed retries a failed
 * one), and use it once it lands.
 */
let agentsWaitSpent = false;

/**
 * Resolve the landing view (UI unification §9, decision 1; viewPolicy.ts)
 * for a session being selected. Synchronous when everything it depends on
 * is known; otherwise the read that decides it — is it an agent's session —
 * runs now, in parallel with the tab listing, and the landing waits for it
 * (bounded).
 */
function decideLanding(sessionId: string, running: boolean): View | Promise<View> {
	// Known, or the one wait of this page load was spent: decided without the list.
	if (isAcpAgentSession(sessionId) !== null || agentsWaitSpent)
		return landingFor(sessionId, running);
	// The one shared read of the agents list (acpStatusFeed.ts), bounded.
	return Promise.race([readAcpAgents(), sleep(LANDING_AGENTS_WAIT_MS)]).then(() => {
		if (!acpAgentsLoaded()) agentsWaitSpent = true;
		return landingFor(sessionId, running);
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
	// The landing view (viewPolicy.ts) — unless the route names one (the
	// router applies it right after). While it is being
	// decided the view sync must not land a fallback of its own, and a
	// view the person picks meanwhile wins over it.
	const landing = opts.view ? null : decideLanding(sessionId, running);
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
	// A landing that needs the agents list waits for it (bounded); the
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
	// an agent's Chat). refreshSessions re-opens it
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
		return;
	}

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
	const s = sessions.find((x) => x.sessionId === activeSessionId);
	if (!s) {
		terminalToolbar.style.display = "none";
		terminalTabs.style.display = "none";
		terminalContainer.style.display = "none";
		emptyState.style.display = "flex";
		terminalStateEl.hidden = true;
		terminalStateEl.replaceChildren();
		updateTerminalControls();
		syncSessionViews();
		return;
	}
	terminalToolbar.style.display = "flex";
	// #terminal-tabs and #terminal-container are flipped to visible only
	// by renderTabBar/openTab — avoids an empty-bar flash before listTabs
	// resolves.
	emptyState.style.display = "none";
	paintBarIdentity();
	// Refresh the mobile header context pill — its label tracks the
	// active session/tab, and visibility flips on/off here.
	updateTerminalControls();
	syncSessionViews();
	renderTerminalState();
}

/**
 * The bar's identity zone (UX iter3 §2): the session's name and its state —
 * or, for an ACP agent's session (E), "@agent" in its colour, the agent's
 * state as the chip (the sidebar's words, #703) and "sesión X · proyecto ↗"
 * (wide screens). What it holds depends on the KIND of session, never on
 * the view, and it stays one line: the bar's height is part of the
 * terminal's box (a different height would resize tmux on a view switch).
 */
function paintBarIdentity(): void {
	const s = sessions.find((x) => x.sessionId === activeSessionId);
	if (!s) return;
	terminalToolbar.dataset.sessionName = s.name;
	const acp = acpEntry(s.sessionId);
	terminalToolbar.classList.toggle("bar-agent", acp !== null);
	// A running session whose terminal gave up reads "disconnected" until
	// a pane is attached again (Reconnect) — the server-side status alone
	// would say "running" over an empty area.
	const badge =
		s.status === "running" && disconnectedTabId !== null && currentActiveTabId === null
			? "disconnected"
			: s.status;
	if (!acp) {
		terminalSessionName.textContent = s.name;
		nameFloor(terminalSessionName);
		// A long name shows with an ellipsis (terminal.css): the full one on hover.
		terminalSessionName.title = s.name;
		terminalSessionName.style.removeProperty("--acp-hue");
		if (terminalSessionSub) terminalSessionSub.hidden = true;
		setStatusBadge(badge);
		terminalStatusBadge.removeAttribute("title");
		return;
	}
	terminalSessionName.textContent = `@${acp.name}`;
	nameFloor(terminalSessionName);
	terminalSessionName.title = `@${acp.name} — sesión ${s.name}`;
	terminalSessionName.style.setProperty("--acp-hue", String(agentHue(acp.name)));
	if (s.status === "running" && badge === "running") {
		const st = sidebarAgentStatus(acp, acpAgentsReadAt(), startedAt(s.sessionId));
		terminalStatusBadge.textContent = st.word;
		terminalStatusBadge.className = `chip tone-${st.tone}${st.asks ? " asks" : ""}`;
		terminalStatusBadge.title = `Agente: ${st.label}`;
	} else {
		setStatusBadge(badge);
		terminalStatusBadge.removeAttribute("title");
	}
	if (!terminalSessionSub) return;
	const project = acp.projectId ? projects().find((p) => p.projectId === acp.projectId) : null;
	// The session's name gives way (ellipsis), never the project's link.
	const session = document.createElement("span");
	session.className = "terminal-session-sub-name";
	session.textContent = `sesión ${s.name}`;
	const parts: Array<string | HTMLElement> = [session];
	if (project) {
		const a = document.createElement("a");
		a.href = projectRouteHash({ projectId: project.projectId });
		a.textContent = `${project.name} ↗`;
		a.title = `Abrir Project Chat: ${project.name}`;
		a.addEventListener("click", (e) => {
			if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
			e.preventDefault();
			navigateProject({ projectId: project.projectId });
		});
		parts.push(" · ", a);
	}
	terminalSessionSub.replaceChildren(...parts);
	terminalSessionSub.hidden = false;
}

/**
 * The title keeps at least 8 characters before anything else gives way —
 * but a floor must not WIDEN a shorter name ("docs" would push the rest
 * right): min(8ch, its own length), terminal.css `--name-ch`.
 */
function nameFloor(name: HTMLElement): void {
	name.style.setProperty("--name-ch", `${[...(name.textContent ?? "")].length}ch`);
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
	// A toolbar, not a tablist: a tablist may own only tabs (axe
	// `aria-required-children`, critical — UX audit A2), and each chip's ×
	// and the + live in this row too. Hiding them from assistive tech would
	// leave a phone's screen reader no way to close a tab; a toolbar of
	// buttons says what is here, with the same ← / → roving focus.
	tabStrip.setAttribute("role", "toolbar");
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
		select.setAttribute("aria-pressed", String(isActive));
		select.setAttribute("aria-keyshortcuts", "Delete");
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
	// Insert (+) and the key bar follow whether a terminal is active —
	// refresh every time the bar is rebuilt rather than in every caller of
	// openTab/addTab/closeTab.
	updateTerminalControls();
	renderTerminalState();
}

// ← / → / Home / End move between tabs (WAI-ARIA toolbar, manual activation:
// Enter / Space on the focused tab opens it).
terminalTabs.addEventListener("keydown", (e) => {
	// Delete on a tab closes it: the same path as its ×.
	if (e.key === "Delete" && e.target instanceof HTMLElement && e.target.matches(".tab-chip-btn")) {
		e.target.closest(".tab-chip")?.querySelector<HTMLButtonElement>(".tab-close")?.click();
		e.preventDefault();
		return;
	}
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
 * Show the Terminal on one of the active session's tabs (a tab created for
 * the person, e.g. ACP "Conectar cuenta"). The Terminal is shown in every
 * case; the tab is switched only when it is one of the session's tabs.
 */
function showTerminalTab(tabId: string): void {
	setView("terminal");
	const s = sessions.find((x) => x.sessionId === activeSessionId);
	if (!s || s.status !== "running") return;
	if (!currentTabs.some((t) => t.tabId === tabId)) return;
	try {
		openTab(tabId);
	} catch (err) {
		showToast((err as Error).message, true);
	}
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
						setStatusBadge("reconnecting");
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

// A tab another module created on the server (ACP "Conectar cuenta": the
// adapter's login command): re-read the tab list and show that tab.
if (typeof window !== "undefined")
	window.addEventListener("st:open-terminal-tab", (e) => {
		const { sessionId, tabId } = (e as CustomEvent<{ sessionId: string; tabId: string }>).detail;
		if (sessionId !== activeSessionId) return;
		void listTabs(sessionId)
			.then((tabs) => {
				if (activeSessionId !== sessionId) return;
				setCurrentTabs(tabs.sort((a, b) => a.createdAt - b.createdAt));
				renderTabBar();
				showTerminalTab(tabId);
			})
			.catch((err) => showToast((err as Error).message, true));
	});

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
