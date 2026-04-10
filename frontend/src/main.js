/**
 * main.ts — Application entry point.
 *
 * Wires together:
 *   - User identity (simple prompt, stored in sessionStorage)
 *   - ApiClient for REST calls
 *   - Session list sidebar
 *   - Terminal panel (openTerminalSession)
 */
import { ApiClient } from "./api.js";
import { openTerminalSession } from "./terminal.js";
// ── User identity ─────────────────────────────────────────────────────────────
// In a real system this would come from a proper auth flow.
// For the MVP we ask once per browser session and store in sessionStorage.
function getOrPromptUserId() {
    let id = sessionStorage.getItem("userId");
    if (!id) {
        id = prompt("Enter your user ID (letters/numbers/hyphens):", `user-${Date.now()}`) ?? `user-${Date.now()}`;
        id = id.replace(/[^\w-]/g, "-").slice(0, 64) || `user-${Date.now()}`;
        sessionStorage.setItem("userId", id);
    }
    return id;
}
const userId = getOrPromptUserId();
const api = new ApiClient(userId);
// ── DOM refs ──────────────────────────────────────────────────────────────────
const userIdDisplay = document.getElementById("user-id-display");
const newSessionForm = document.getElementById("new-session-form");
const newSessionInput = document.getElementById("new-session-input");
const sessionListEl = document.getElementById("session-list");
const emptyState = document.getElementById("empty-state");
const terminalToolbar = document.getElementById("terminal-toolbar");
const terminalContainer = document.getElementById("terminal-container");
const terminalSessionName = document.getElementById("terminal-session-name");
const terminalStatusBadge = document.getElementById("terminal-status-badge");
const toastEl = document.getElementById("toast");
userIdDisplay.textContent = userId;
// ── State ─────────────────────────────────────────────────────────────────────
let sessions = [];
let activeSessionId = null;
let activeTerminal = null;
// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(message, isError = false) {
    if (toastTimer)
        clearTimeout(toastTimer);
    toastEl.textContent = message;
    toastEl.classList.toggle("error", isError);
    toastEl.classList.add("visible");
    toastTimer = setTimeout(() => toastEl.classList.remove("visible"), 4000);
}
// ── Session list rendering ────────────────────────────────────────────────────
function renderSessionList() {
    sessionListEl.innerHTML = "";
    if (sessions.length === 0) {
        sessionListEl.innerHTML = `<p style="padding:.75rem 1rem;font-size:.78rem;color:#8b949e;">No active sessions yet.</p>`;
        return;
    }
    for (const s of sessions) {
        const item = document.createElement("div");
        item.className = `session-item${s.sessionId === activeSessionId ? " active" : ""}`;
        item.dataset.id = s.sessionId;
        const dot = document.createElement("span");
        dot.className = `session-dot ${s.status}`;
        const name = document.createElement("span");
        name.className = "session-name";
        name.textContent = s.name;
        const kill = document.createElement("button");
        kill.className = "session-kill";
        kill.title = "Terminate session";
        kill.textContent = "✕";
        kill.addEventListener("click", async (e) => {
            e.stopPropagation();
            await terminateSession(s.sessionId);
        });
        item.appendChild(dot);
        item.appendChild(name);
        item.appendChild(kill);
        item.addEventListener("click", () => openSession(s.sessionId));
        sessionListEl.appendChild(item);
    }
}
// ── Toolbar status ────────────────────────────────────────────────────────────
function updateToolbar(session, status) {
    if (!session) {
        emptyState.style.display = "flex";
        terminalToolbar.style.display = "none";
        terminalContainer.style.display = "none";
        return;
    }
    emptyState.style.display = "none";
    terminalToolbar.style.display = "flex";
    terminalContainer.style.display = "block";
    terminalSessionName.textContent = session.name;
    const s = status ?? session.status;
    terminalStatusBadge.textContent = s;
    terminalStatusBadge.className = `session-status-badge ${s}`;
    // Align with the CSS id selector name
    terminalStatusBadge.id = "terminal-status-badge";
}
// ── Open / attach a session ───────────────────────────────────────────────────
async function openSession(sessionId) {
    if (activeTerminal) {
        activeTerminal.dispose();
        activeTerminal = null;
    }
    activeSessionId = sessionId;
    renderSessionList();
    const session = sessions.find((s) => s.sessionId === sessionId);
    if (!session || session.status === "terminated") {
        showToast("Cannot open a terminated session.", true);
        return;
    }
    updateToolbar(session);
    // Clear previous terminal content.
    terminalContainer.innerHTML = "";
    activeTerminal = openTerminalSession({
        container: terminalContainer,
        sessionId,
        userId,
        onStatus: (status) => {
            // Update local cache and re-render.
            const cached = sessions.find((s) => s.sessionId === sessionId);
            if (cached)
                cached.status = status;
            renderSessionList();
            updateToolbar(session, status);
        },
        onError: (message) => {
            showToast(message, true);
        },
    });
}
// ── Create session ────────────────────────────────────────────────────────────
newSessionForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = newSessionInput.value.trim();
    if (!name)
        return;
    try {
        const created = await api.createSession({ name });
        sessions.push(created);
        newSessionInput.value = "";
        renderSessionList();
        await openSession(created.sessionId);
        showToast(`Session "${created.name}" created`);
    }
    catch (err) {
        showToast(err.message, true);
    }
});
// ── Terminate session ─────────────────────────────────────────────────────────
async function terminateSession(sessionId) {
    try {
        await api.terminateSession(sessionId);
        // Update local state immediately.
        sessions = sessions.filter((s) => s.sessionId !== sessionId);
        if (activeSessionId === sessionId) {
            activeTerminal?.dispose();
            activeTerminal = null;
            activeSessionId = null;
            updateToolbar(undefined);
        }
        renderSessionList();
        showToast("Session terminated");
    }
    catch (err) {
        showToast(err.message, true);
    }
}
// ── Initial load ──────────────────────────────────────────────────────────────
async function init() {
    try {
        sessions = await api.listSessions();
        renderSessionList();
    }
    catch {
        showToast("Could not reach backend — is it running?", true);
    }
}
init();
