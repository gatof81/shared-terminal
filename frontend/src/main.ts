/**
 * main.ts — Application entry point.
 *
 * Handles auth flow (login/register), session management sidebar,
 * and terminal panel lifecycle.
 */

import {
        isLoggedIn, login, register, logout, checkAuthStatus,
        listSessions, createSession, deleteSession, stopSession, startSession,
        listTabs, createTab, deleteTab, LastTabError,
        type SessionInfo, type Tab,
} from "./api.js";
import { openTerminalSession, type TerminalSession, type SessionStatus } from "./terminal.js";

// ── DOM refs ────────────────────────────────────────────────────────────────

const authView = document.getElementById("auth-view")!;
const appView = document.getElementById("app-view")!;
const authForm = document.getElementById("auth-form") as HTMLFormElement;
const authTitle = document.getElementById("auth-title")!;
const authToggle = document.getElementById("auth-toggle")!;
const authError = document.getElementById("auth-error")!;
const authUsername = document.getElementById("auth-username") as HTMLInputElement;
const authPassword = document.getElementById("auth-password") as HTMLInputElement;
const authSubmitBtn = document.getElementById("auth-submit") as HTMLButtonElement;

const userDisplay = document.getElementById("user-display")!;
const logoutBtn = document.getElementById("logout-btn")!;
const sessionList = document.getElementById("session-list")!;
const newSessionForm = document.getElementById("new-session-form") as HTMLFormElement;
const newSessionInput = document.getElementById("new-session-input") as HTMLInputElement;
const showTerminatedToggle = document.getElementById("show-terminated-toggle") as HTMLInputElement;

const terminalToolbar = document.getElementById("terminal-toolbar")!;
const terminalSessionName = document.getElementById("terminal-session-name")!;
const terminalStatusBadge = document.getElementById("terminal-status-badge")!;
const terminalTabs = document.getElementById("terminal-tabs")!;
const terminalContainer = document.getElementById("terminal-container")!;
const emptyState = document.getElementById("empty-state")!;
const toast = document.getElementById("toast")!;

// ── State ───────────────────────────────────────────────────────────────────

let sessions: SessionInfo[] = [];
let activeSessionId: string | null = null;
let isRegisterMode = false;

// Tab state — only for the CURRENTLY active session. Switching sessions
// disposes these terminals (tmux keeps the tabs alive server-side, so
// reconnecting replays from the ring buffer). Switching tabs WITHIN the
// active session keeps every tab's xterm + WS live so background work
// (e.g. a dev server running in a closed tab) isn't interrupted.
interface ActiveTerminal { pane: HTMLDivElement; term: TerminalSession }
let currentTabs: Tab[] = [];
let currentActiveTabId: string | null = null;
const currentTerminals = new Map<string, ActiveTerminal>();

function disposeAllCurrentTerminals() {
        for (const { term, pane } of currentTerminals.values()) {
                term.dispose();
                pane.remove();
        }
        currentTerminals.clear();
        currentTabs = [];
        currentActiveTabId = null;
        terminalTabs.innerHTML = "";
}

// ── Auth flow ───────────────────────────────────────────────────────────────

async function initAuth() {
        if (isLoggedIn()) {
                showApp();
                return;
        }

        try {
                const { needsSetup } = await checkAuthStatus();
                if (needsSetup) {
                        isRegisterMode = true;
                        updateAuthUI();
                }
        } catch {
                // Backend probably not running — show login anyway
        }

        showAuth();
}

function showAuth() {
        authView.style.display = "flex";
        appView.style.display = "none";
        authUsername.focus();
}

function showApp() {
        authView.style.display = "none";
        appView.style.display = "flex";
        userDisplay.textContent = "●";
        refreshSessions();
}

function updateAuthUI() {
        if (isRegisterMode) {
                authTitle.textContent = "Create Account";
                authSubmitBtn.textContent = "Register";
                authToggle.innerHTML = 'Already have an account? <a href="#" id="auth-toggle-link">Login</a>';
        } else {
                authTitle.textContent = "Login";
                authSubmitBtn.textContent = "Login";
                authToggle.innerHTML = 'No account? <a href="#" id="auth-toggle-link">Register</a>';
        }
        // Re-bind toggle link
        document.getElementById("auth-toggle-link")?.addEventListener("click", (e) => {
                e.preventDefault();
                isRegisterMode = !isRegisterMode;
                authError.textContent = "";
                updateAuthUI();
        });
}

authForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        authError.textContent = "";
        const username = authUsername.value.trim();
        const password = authPassword.value;

        if (!username || !password) {
                authError.textContent = "Username and password required";
                return;
        }

        try {
                if (isRegisterMode) {
                        await register(username, password);
                } else {
                        await login(username, password);
                }
                showApp();
        } catch (err) {
                authError.textContent = (err as Error).message;
        }
});

logoutBtn.addEventListener("click", () => {
        logout();
        disposeAllCurrentTerminals();
        activeSessionId = null;
        sessions = [];
        showAuth();
});

// ── Session management ──────────────────────────────────────────────────────

async function refreshSessions() {
        // Read the checkbox state fresh every time so there's no stale
        // module-variable to get out of sync with the DOM.
        const includeTerminated = showTerminatedToggle.checked;
        try {
                sessions = await listSessions(includeTerminated);
                console.debug(
                        `[sessions] fetched ${sessions.length} session(s) (includeTerminated=${includeTerminated})`,
                        sessions.map((s) => ({ id: s.sessionId.slice(0, 8), name: s.name, status: s.status })),
                );
                renderSessionList();
        } catch (err) {
                showToast((err as Error).message, true);
        }
}

function renderSessionList() {
        sessionList.innerHTML = "";
        for (const s of sessions) {
                const item = document.createElement("div");
                const terminatedCls = s.status === "terminated" ? " terminated" : "";
                item.className = `session-item${s.sessionId === activeSessionId ? " active" : ""}${terminatedCls}`;

                const dot = document.createElement("span");
                dot.className = `session-dot ${s.status}`;
                item.appendChild(dot);

                const name = document.createElement("span");
                name.className = "session-name";
                name.textContent = s.name;
                item.appendChild(name);

                // Action buttons
                const actions = document.createElement("span");
                actions.className = "session-actions";

                if (s.status === "stopped") {
                        const playBtn = document.createElement("button");
                        playBtn.className = "session-action-btn start";
                        playBtn.textContent = "▶";
                        playBtn.title = "Start";
                        playBtn.addEventListener("click", async (e) => {
                                e.stopPropagation();
                                try {
                                        await startSession(s.sessionId);
                                        await refreshSessions();
                                } catch (err) { showToast((err as Error).message, true); }
                        });
                        actions.appendChild(playBtn);
                } else if (s.status === "running") {
                        const stopBtn = document.createElement("button");
                        stopBtn.className = "session-action-btn stop";
                        stopBtn.textContent = "⏸";
                        stopBtn.title = "Stop";
                        stopBtn.addEventListener("click", async (e) => {
                                e.stopPropagation();
                                try {
                                        await stopSession(s.sessionId);
                                        await refreshSessions();
                                } catch (err) { showToast((err as Error).message, true); }
                        });
                        actions.appendChild(stopBtn);
                } else if (s.status === "terminated") {
                        // Restore — spawns a fresh container reusing the original
                        // container name + workspace bind mount. Files are preserved.
                        const restoreBtn = document.createElement("button");
                        restoreBtn.className = "session-action-btn start";
                        restoreBtn.textContent = "↻";
                        restoreBtn.title = "Restore (respawn container with existing workspace files)";
                        restoreBtn.addEventListener("click", async (e) => {
                                e.stopPropagation();
                                try {
                                        showToast(`Restoring "${s.name}"…`);
                                        await startSession(s.sessionId);
                                        await refreshSessions();
                                        showToast(`Session "${s.name}" restored`);
                                } catch (err) { showToast((err as Error).message, true); }
                        });
                        actions.appendChild(restoreBtn);
                }

                const killBtn = document.createElement("button");
                killBtn.className = "session-kill";
                killBtn.textContent = "✕";
                // Shift-click enables hard delete — also wipes workspace files and
                // removes the session record entirely. Plain click is a soft delete,
                // which keeps the workspace files so the session can be restored.
                killBtn.title = s.status === "terminated"
                        ? "Delete permanently (wipes workspace files)"
                        : "Terminate (Shift-click to also wipe workspace files)";
                killBtn.addEventListener("click", async (e) => {
                        e.stopPropagation();
                        const mouseEvent = e as MouseEvent;
                        // If the session is already terminated, the only meaningful action
                        // is hard delete — otherwise there's nothing to do.
                        const hard = s.status === "terminated" || mouseEvent.shiftKey;

                        const prompt = hard
                                ? `Permanently delete "${s.name}"?\n\nThis stops and removes the container, wipes workspace files from disk, and removes the session record. This cannot be undone.`
                                : `Terminate "${s.name}"?\n\nContainer will be stopped and removed. Workspace files are preserved — you can restore the session later.`;
                        if (!confirm(prompt)) return;

                        try {
                                await deleteSession(s.sessionId, hard);
                                if (activeSessionId === s.sessionId) {
                                        disposeAllCurrentTerminals();
                                        activeSessionId = null;
                                        updateToolbar();
                                }
                                await refreshSessions();
                        } catch (err) { showToast((err as Error).message, true); }
                });
                actions.appendChild(killBtn);
                item.appendChild(actions);

                // Click to open session
                item.addEventListener("click", () => {
                        if (s.status === "running") {
                                void openSession(s.sessionId);
                        } else if (s.status === "stopped") {
                                showToast("Start the session first", true);
                        }
                });

                sessionList.appendChild(item);
        }
}

async function openSession(sessionId: string) {
        if (activeSessionId === sessionId) return;

        // Tear down the previous session's terminals. (Switching tabs within
        // a session keeps them alive; switching sessions doesn't.)
        disposeAllCurrentTerminals();
        terminalContainer.innerHTML = "";

        activeSessionId = sessionId;
        renderSessionList();
        updateToolbar();

        // Pull tabs from the backend. An empty list is unusual (the entrypoint
        // always creates tab-default) but we auto-create one so the user can
        // keep working instead of being stuck. `sessionId` is captured here so
        // a second rapid click on another session doesn't let this resolution
        // clobber the newer one's state — each `await` re-checks identity.
        try {
                const tabs = await listTabs(sessionId);
                if (activeSessionId !== sessionId) return; // superseded by another click
                // tmux list-sessions emits alphabetical order; show creation order
                // instead so the +-added tabs stay on the right.
                currentTabs = tabs.sort((a, b) => a.createdAt - b.createdAt);
                if (currentTabs.length === 0) {
                        const created = await createTab(sessionId);
                        if (activeSessionId !== sessionId) return;
                        currentTabs = [created];
                }
        } catch (err) {
                // If nothing else claimed the slot in the meantime, drop back to
                // the empty state — otherwise the toolbar/container would stay
                // visible with no tabs rendered. Toast is always shown so the
                // user knows what happened.
                if (activeSessionId === sessionId) {
                        activeSessionId = null;
                        currentTabs = [];
                        renderSessionList();
                        updateToolbar();
                }
                showToast((err as Error).message, true);
                return;
        }

        renderTabBar();
        if (currentTabs.length > 0) openTab(currentTabs[0]!.tabId);
}

function updateToolbar() {
        const s = sessions.find((x) => x.sessionId === activeSessionId);
        if (!s) {
                terminalToolbar.style.display = "none";
                terminalTabs.style.display = "none";
                terminalContainer.style.display = "none";
                emptyState.style.display = "flex";
                return;
        }
        terminalToolbar.style.display = "flex";
        terminalTabs.style.display = "flex";
        terminalContainer.style.display = "block";
        emptyState.style.display = "none";
        terminalSessionName.textContent = s.name;
        terminalStatusBadge.textContent = s.status;
        terminalStatusBadge.className = s.status;
}

// ── Tabs within the active session ──────────────────────────────────────────

function renderTabBar() {
        terminalTabs.innerHTML = "";
        if (!activeSessionId) return;

        for (const tab of currentTabs) {
                const chip = document.createElement("div");
                chip.className = `tab-chip${tab.tabId === currentActiveTabId ? " active" : ""}`;
                chip.dataset.tabId = tab.tabId;
                chip.title = tab.label;

                const label = document.createElement("span");
                label.className = "tab-chip-label";
                label.textContent = tab.label;
                chip.appendChild(label);

                const close = document.createElement("button");
                close.className = "tab-close";
                close.textContent = "×";
                close.title = "Close tab";
                close.disabled = currentTabs.length <= 1;
                close.addEventListener("click", (e) => {
                        e.stopPropagation();
                        void closeTab(tab.tabId);
                });
                chip.appendChild(close);

                chip.addEventListener("click", () => openTab(tab.tabId));
                terminalTabs.appendChild(chip);
        }

        const addBtn = document.createElement("button");
        addBtn.id = "tab-add";
        addBtn.type = "button";
        addBtn.textContent = "+";
        addBtn.title = "Open a new tab (runs services independently; close to SIGHUP them)";
        addBtn.addEventListener("click", () => void addTab(addBtn));
        terminalTabs.appendChild(addBtn);
}

function openTab(tabId: string) {
        if (!activeSessionId) return;
        if (!currentTabs.some((t) => t.tabId === tabId)) return;

        // Mirror the sidebar's rule: we only spin up a terminal for a running
        // session. If the user clicked a tab chip while the session was
        // stopped/terminated/disconnected, bail with a toast instead of
        // opening a WS that would immediately fail.
        const s = sessions.find((x) => x.sessionId === activeSessionId);
        if (s && s.status !== "running") {
                showToast("Session isn't running — start it first", true);
                return;
        }

        // Hide the current pane (don't dispose).
        if (currentActiveTabId) {
                currentTerminals.get(currentActiveTabId)?.pane.classList.remove("active");
        }

        // Lazily spin up the xterm+WS for this tab. Subsequent re-opens of the
        // same tab just toggle .active without reconnecting.
        let entry = currentTerminals.get(tabId);
        if (!entry) {
                const pane = document.createElement("div");
                pane.className = "tab-pane";
                pane.dataset.tabId = tabId;
                terminalContainer.appendChild(pane);

                const term = openTerminalSession({
                        container: pane,
                        sessionId: activeSessionId,
                        tabId,
                        onStatus: (status: SessionStatus) => {
                                // Session status travels via the tab's WS too. We still
                                // update the session-level indicator so the sidebar is
                                // honest about "disconnected".
                                const s = sessions.find((x) => x.sessionId === activeSessionId);
                                if (s) s.status = status as SessionInfo["status"];
                                updateToolbar();
                                renderSessionList();
                        },
                        onError: (msg: string) => showToast(msg, true),
                });
                entry = { pane, term };
                currentTerminals.set(tabId, entry);
        }

        entry.pane.classList.add("active");
        currentActiveTabId = tabId;
        renderTabBar();
}

async function addTab(triggeredBy?: HTMLButtonElement) {
        if (!activeSessionId) return;
        const sessionId = activeSessionId;
        if (triggeredBy) triggeredBy.disabled = true;
        try {
                // Default label: smallest "Tab N" not already in use. Using
                // `currentTabs.length + 1` would collide after a middle tab
                // was closed (e.g. [Tab 1, Tab 3] + add → another "Tab 3").
                const tab = await createTab(sessionId, nextDefaultLabel());
                if (activeSessionId !== sessionId) return;
                currentTabs.push(tab);
                renderTabBar();
                openTab(tab.tabId);
        } catch (err) {
                showToast((err as Error).message, true);
        } finally {
                if (triggeredBy) triggeredBy.disabled = false;
        }
}

function nextDefaultLabel(): string {
        const used = new Set(currentTabs.map((t) => t.label));
        let n = 1;
        while (used.has(`Tab ${n}`)) n++;
        return `Tab ${n}`;
}

async function closeTab(tabId: string) {
        if (!activeSessionId) return;
        const sessionId = activeSessionId;
        if (currentTabs.length <= 1) {
                showToast("Can't close the last tab", true);
                return;
        }

        try {
                await deleteTab(sessionId, tabId);
        } catch (err) {
                if (err instanceof LastTabError) {
                        showToast("Can't close the last tab", true);
                } else {
                        showToast((err as Error).message, true);
                }
                return;
        }
        // Guard against the user switching sessions during the DELETE — the
        // session we closed the tab on is no longer the active one, so our
        // in-memory state has already been torn down by openSession().
        if (activeSessionId !== sessionId) return;

        const entry = currentTerminals.get(tabId);
        if (entry) {
                entry.term.dispose();
                entry.pane.remove();
                currentTerminals.delete(tabId);
        }
        currentTabs = currentTabs.filter((t) => t.tabId !== tabId);

        if (currentActiveTabId === tabId) {
                currentActiveTabId = null;
                if (currentTabs.length > 0) openTab(currentTabs[0]!.tabId);
        }
        renderTabBar();
}

// ── New session ─────────────────────────────────────────────────────────────

newSessionForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = newSessionInput.value.trim();
        if (!name) return;
        newSessionInput.value = "";
        try {
                showToast("Creating session…");
                const session = await createSession(name);
                sessions.unshift(session);
                renderSessionList();
                void openSession(session.sessionId);
                showToast(`Session "${name}" created`);
        } catch (err) {
                showToast((err as Error).message, true);
        }
});

// ── Toast ───────────────────────────────────────────────────────────────────

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(message: string, isError = false) {
        toast.textContent = message;
        toast.className = `visible${isError ? " error" : ""}`;
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
                toast.className = "";
        }, 4000);
}

// ── Show terminated toggle ──────────────────────────────────────────────────

showTerminatedToggle.addEventListener("change", () => {
        console.debug(`[sessions] show-terminated toggled → ${showTerminatedToggle.checked}`);
        refreshSessions();
});

// ── Auto-refresh ────────────────────────────────────────────────────────────

setInterval(() => {
        if (isLoggedIn()) refreshSessions();
}, 15_000);

// ── Init ────────────────────────────────────────────────────────────────────

updateAuthUI();
initAuth();
