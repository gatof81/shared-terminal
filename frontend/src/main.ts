/**
 * main.ts — Application entry point.
 *
 * Handles auth flow (login/register), session management sidebar,
 * and terminal panel lifecycle.
 */

import {
        isLoggedIn, login, register, logout, checkAuthStatus,
        listSessions, createSession, deleteSession, stopSession, startSession,
        type SessionInfo,
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

const terminalToolbar = document.getElementById("terminal-toolbar")!;
const terminalSessionName = document.getElementById("terminal-session-name")!;
const terminalStatusBadge = document.getElementById("terminal-status-badge")!;
const terminalContainer = document.getElementById("terminal-container")!;
const emptyState = document.getElementById("empty-state")!;
const toast = document.getElementById("toast")!;

// ── State ───────────────────────────────────────────────────────────────────

let sessions: SessionInfo[] = [];
let activeSessionId: string | null = null;
let activeTerminal: TerminalSession | null = null;
let isRegisterMode = false;

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
        activeTerminal?.dispose();
        activeTerminal = null;
        activeSessionId = null;
        sessions = [];
        showAuth();
});

// ── Session management ──────────────────────────────────────────────────────

async function refreshSessions() {
        try {
                sessions = await listSessions();
                renderSessionList();
        } catch (err) {
                showToast((err as Error).message, true);
        }
}

function renderSessionList() {
        sessionList.innerHTML = "";
        for (const s of sessions) {
                const item = document.createElement("div");
                item.className = `session-item${s.sessionId === activeSessionId ? " active" : ""}`;

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
                }

                const killBtn = document.createElement("button");
                killBtn.className = "session-kill";
                killBtn.textContent = "✕";
                killBtn.title = "Terminate";
                killBtn.addEventListener("click", async (e) => {
                        e.stopPropagation();
                        if (!confirm(`Terminate "${s.name}"? Container will be removed.`)) return;
                        try {
                                await deleteSession(s.sessionId);
                                if (activeSessionId === s.sessionId) {
                                        activeTerminal?.dispose();
                                        activeTerminal = null;
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
                                openSession(s.sessionId);
                        } else if (s.status === "stopped") {
                                showToast("Start the session first", true);
                        }
                });

                sessionList.appendChild(item);
        }
}

function openSession(sessionId: string) {
        if (activeSessionId === sessionId) return;

        activeTerminal?.dispose();
        activeTerminal = null;
        terminalContainer.innerHTML = "";

        activeSessionId = sessionId;
        renderSessionList();
        updateToolbar();

        activeTerminal = openTerminalSession({
                container: terminalContainer,
                sessionId,
                onStatus: (status: SessionStatus) => {
                        const s = sessions.find((x) => x.sessionId === sessionId);
                        if (s) s.status = status as SessionInfo["status"];
                        updateToolbar();
                        renderSessionList();
                },
                onError: (msg: string) => showToast(msg, true),
        });
}

function updateToolbar() {
        const s = sessions.find((x) => x.sessionId === activeSessionId);
        if (!s) {
                terminalToolbar.style.display = "none";
                terminalContainer.style.display = "none";
                emptyState.style.display = "flex";
                return;
        }
        terminalToolbar.style.display = "flex";
        terminalContainer.style.display = "block";
        emptyState.style.display = "none";
        terminalSessionName.textContent = s.name;
        terminalStatusBadge.textContent = s.status;
        terminalStatusBadge.className = s.status;
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
                openSession(session.sessionId);
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

// ── Auto-refresh ────────────────────────────────────────────────────────────

setInterval(() => {
        if (isLoggedIn()) refreshSessions();
}, 15_000);

// ── Init ────────────────────────────────────────────────────────────────────

updateAuthUI();
initAuth();
