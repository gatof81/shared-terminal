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

// Active session's tabs only; switching sessions tears these down.
interface ActiveTerminal { pane: HTMLDivElement; term: TerminalSession }
let currentTabs: Tab[] = [];
let currentActiveTabId: string | null = null;
const currentTerminals = new Map<string, ActiveTerminal>();
// Tabs whose DELETE is in flight. Used so the last-tab guard accounts for
// concurrent closes — two × clicks on two different chips would each see
// currentTabs.length == 2 and race, with the second eating a spurious 409.
const closingTabs = new Set<string>();

function disposeAllCurrentTerminals() {
        for (const { term, pane } of currentTerminals.values()) {
                term.dispose();
                pane.remove();
        }
        currentTerminals.clear();
        currentTabs = [];
        currentActiveTabId = null;
        closingTabs.clear();
        terminalTabs.innerHTML = "";
        terminalTabs.style.display = "none";
        terminalContainer.style.display = "none";
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

        // Tabs stay alive across tab-switch, but are torn down on session-switch.
        disposeAllCurrentTerminals();

        activeSessionId = sessionId;
        renderSessionList();
        updateToolbar();

        // Capturing `sessionId` guards against a rapid second openSession call
        // clobbering this one — each `await` re-checks identity.
        try {
                const tabs = await listTabs(sessionId);
                if (activeSessionId !== sessionId) return;
                // Sort by creation order so +-added tabs stay on the right
                // (listTabs returns alphabetical from tmux list-sessions).
                currentTabs = tabs.sort((a, b) => a.createdAt - b.createdAt);
                if (currentTabs.length === 0) {
                        // Unusual (entrypoint creates tab-default) but recover instead
                        // of leaving the user stuck with no tabs.
                        const created = await createTab(sessionId);
                        if (activeSessionId !== sessionId) return;
                        currentTabs = [created];
                }
        } catch (err) {
                // Drop back to empty state so the toolbar/container don't linger
                // visible with no tabs.
                if (activeSessionId === sessionId) {
                        activeSessionId = null;
                        currentTabs = [];
                        renderSessionList();
                        updateToolbar();
                }
                showToast((err as Error).message, true);
                return;
        }

        // openTab can throw synchronously (openTerminalSession init failure) —
        // openSession is called with `void`, so an unhandled throw here would
        // become an unhandled rejection with no toast and the UI left mid-switch.
        if (currentTabs.length > 0) {
                try {
                        openTab(currentTabs[0]!.tabId);
                } catch (err) {
                        if (activeSessionId === sessionId) {
                                activeSessionId = null;
                                currentTabs = [];
                                renderSessionList();
                                updateToolbar();
                        }
                        showToast((err as Error).message, true);
                }
        }
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
        // #terminal-tabs and #terminal-container are flipped to visible only
        // by renderTabBar/openTab — avoids an empty-bar flash before listTabs
        // resolves.
        emptyState.style.display = "none";
        terminalSessionName.textContent = s.name;
        terminalStatusBadge.textContent = s.status;
        terminalStatusBadge.className = s.status;
}

// ── Tabs within the active session ──────────────────────────────────────────

function renderTabBar() {
        terminalTabs.innerHTML = "";
        if (!activeSessionId || currentTabs.length === 0) {
                terminalTabs.style.display = "none";
                return;
        }
        terminalTabs.style.display = "flex";

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
                // Mirror the closeTab guard so the × doesn't render enabled
                // while a concurrent close is in flight — clicking would just
                // produce a misleading "Can't close the last tab" toast.
                close.disabled = currentTabs.length - closingTabs.size <= 1;
                close.addEventListener("click", (e) => {
                        e.stopPropagation();
                        void closeTab(tab.tabId, close);
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
        if (tabId === currentActiveTabId) return;
        if (!currentTabs.some((t) => t.tabId === tabId)) return;

        // Only spin up a terminal for a running session — matches the sidebar.
        const s = sessions.find((x) => x.sessionId === activeSessionId);
        if (s && s.status !== "running") {
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
                pane.className = "tab-pane";
                pane.dataset.tabId = tabId;
                terminalContainer.appendChild(pane);

                // Capture the sessionId for this terminal — if the user switches
                // sessions while this WS is closing, `onStatus("disconnected")`
                // mustn't write to whatever session happens to be active *now*.
                const ownSessionId = activeSessionId;
                try {
                        const term = openTerminalSession({
                                container: pane,
                                sessionId: ownSessionId,
                                tabId,
                                onStatus: (status: SessionStatus) => {
                                        // Only the active tab drives the shared session status. A
                                        // background tab's WS drop (idle TCP teardown) must not mark
                                        // the whole session "disconnected" while the foreground tab
                                        // is still live.
                                        if (activeSessionId !== ownSessionId) return;
                                        if (tabId !== currentActiveTabId) return;
                                        const s = sessions.find((x) => x.sessionId === ownSessionId);
                                        if (s) s.status = status as SessionInfo["status"];
                                        updateToolbar();
                                        renderSessionList();
                                },
                                onError: (msg: string) => showToast(msg, true),
                        });
                        entry = { pane, term };
                        currentTerminals.set(tabId, entry);
                } catch (err) {
                        pane.remove();
                        if (prevActiveTabId) {
                                currentTerminals.get(prevActiveTabId)?.pane.classList.add("active");
                        }
                        throw err;
                }
        }

        entry.pane.classList.add("active");
        terminalContainer.style.display = "block";
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
                if (activeSessionId !== sessionId) {
                        // User switched away before the POST resolved. The backend tab
                        // exists but was never shown; clean it up so it doesn't resurface
                        // on the next listTabs for that session. Fire-and-forget, but if
                        // the cleanup fails surface a toast so the user knows backend
                        // state drifted from what the UI shows.
                        void deleteTab(sessionId, tab.tabId).catch((err) => {
                                console.warn(`[tabs] orphan cleanup failed for ${tab.tabId}:`, err);
                                showToast(`Orphan tab left on server: ${(err as Error).message}`, true);
                        });
                        return;
                }
                currentTabs.push(tab);
                try {
                        openTab(tab.tabId);
                } catch (err) {
                        // Roll back the push so the chip doesn't linger pointing at a
                        // tab with no currentTerminals entry, and clean up the backend
                        // tab fire-and-forget since it was never actually shown.
                        currentTabs = currentTabs.filter((t) => t.tabId !== tab.tabId);
                        void deleteTab(sessionId, tab.tabId).catch((cleanupErr) => {
                                console.warn(`[tabs] rollback cleanup failed for ${tab.tabId}:`, cleanupErr);
                                showToast(`Orphan tab left on server: ${(cleanupErr as Error).message}`, true);
                        });
                        renderTabBar();
                        throw err;
                }
        } catch (err) {
                // Two distinct failure modes funnel here: (a) createTab itself
                // rejected — backend state is clean; (b) the inner openTab
                // rollback re-threw — backend cleanup is already in flight
                // fire-and-forget. Today both just surface the same toast, but
                // future retry logic should branch on these two paths.
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

async function closeTab(tabId: string, triggeredBy?: HTMLButtonElement) {
        if (!activeSessionId) return;
        const sessionId = activeSessionId;
        if (closingTabs.has(tabId)) return; // duplicate invocation for same tab
        // Subtract in-flight closes so two × clicks on different chips can't
        // both pass the last-tab check — without this, each would see length=2
        // and the second DELETE would get a 409 from the backend's last-tab
        // guard and surface a spurious "can't close" toast.
        if (currentTabs.length - closingTabs.size <= 1) {
                showToast("Can't close the last tab", true);
                return;
        }
        closingTabs.add(tabId);
        // Re-render so sibling chips' × reflects the in-flight close (their
        // disabled state mirrors the same guard).
        renderTabBar();
        if (triggeredBy) triggeredBy.disabled = true;

        try {
                await deleteTab(sessionId, tabId);
        } catch (err) {
                closingTabs.delete(tabId);
                renderTabBar();
                if (err instanceof LastTabError) {
                        showToast("Can't close the last tab", true);
                } else {
                        showToast((err as Error).message, true);
                }
                if (triggeredBy?.isConnected) triggeredBy.disabled = false;
                return;
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
        currentTabs = currentTabs.filter((t) => t.tabId !== tabId);

        if (currentActiveTabId === tabId) {
                currentActiveTabId = null;
                // Nearest surviving neighbour: what was at the same index is now
                // the next sibling; clamp to the new last tab when we closed the
                // rightmost one. If the tab wasn't in currentTabs at findIndex
                // time (state drifted from under us), fall back to index 0.
                const s = sessions.find((x) => x.sessionId === activeSessionId);
                if (currentTabs.length > 0 && s?.status === "running") {
                        const idx = closedIndex < 0
                                ? 0
                                : Math.min(closedIndex, currentTabs.length - 1);
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
                                        showToast((err as Error).message, true);
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
