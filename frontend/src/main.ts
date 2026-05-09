/**
 * main.ts — Application entry point.
 *
 * Handles auth flow (login/register), session management sidebar,
 * and terminal panel lifecycle.
 */

// Side-effect import: Vite bundles and injects this stylesheet. Kept as the
// first import so rules land in the document before any module-side DOM
// manipulation, minimising FOUC.
import "./main.css";

import {
	BootstrapFailedError,
	checkAuthStatus,
	createInvite,
	createSession,
	createTab,
	deleteSession,
	deleteTab,
	type Invite,
	InviteRequiredError,
	isAdmin,
	isLoggedIn,
	listInvites,
	listSessions,
	listTabs,
	login,
	logout,
	register,
	revokeInvite,
	SESSION_EXPIRED_EVENT,
	type SessionInfo,
	startSession,
	stopSession,
	type Tab,
	TabNotFoundError,
	uploadSessionFiles,
} from "./api.js";
import { openTerminalSession, type SessionStatus, type TerminalSession } from "./terminal.js";

// ── DOM refs ────────────────────────────────────────────────────────────────

const authView = document.getElementById("auth-view")!;
const appView = document.getElementById("app-view")!;
const authForm = document.getElementById("auth-form") as HTMLFormElement;
const authTitle = document.getElementById("auth-title")!;
const authToggle = document.getElementById("auth-toggle")!;
const authError = document.getElementById("auth-error")!;
const authUsername = document.getElementById("auth-username") as HTMLInputElement;
const authPassword = document.getElementById("auth-password") as HTMLInputElement;
const authInviteCode = document.getElementById("auth-invite-code") as HTMLInputElement;
const authSubmitBtn = document.getElementById("auth-submit") as HTMLButtonElement;

const userDisplay = document.getElementById("user-display")!;
const sidebarUserDisplay = document.getElementById("sidebar-user-display")!;

const logoutBtn = document.getElementById("logout-btn")!;
const invitesBtn = document.getElementById("invites-btn") as HTMLButtonElement;
const invitesModal = document.getElementById("invites-modal")!;
const inviteCreateBtn = document.getElementById("invite-create-btn") as HTMLButtonElement;
const inviteList = document.getElementById("invite-list")!;
const sessionList = document.getElementById("session-list")!;
const newSessionBtn = document.getElementById("new-session-btn") as HTMLButtonElement;
const newSessionModal = document.getElementById("new-session-modal")!;
const newSessionForm = document.getElementById("new-session-form") as HTMLFormElement;
const newSessionInput = document.getElementById("new-session-input") as HTMLInputElement;
const newSessionSubmitBtn = document.getElementById("new-session-submit") as HTMLButtonElement;
const showTerminatedToggle = document.getElementById("show-terminated-toggle") as HTMLInputElement;
const mainEl = document.querySelector("main")!;
const sidebarEl = document.getElementById("sidebar")!;
const sidebarToggleBtn = document.getElementById("sidebar-toggle") as HTMLButtonElement;
const sidebarBackdrop = document.getElementById("sidebar-backdrop")!;
const sidebarInvitesBtn = document.getElementById("sidebar-invites-btn") as HTMLButtonElement;
const sidebarLogoutBtn = document.getElementById("sidebar-logout-btn") as HTMLButtonElement;
const chromeToggleBtn = document.getElementById("chrome-toggle") as HTMLButtonElement;
const chromeToggleLabel = document.getElementById("chrome-toggle-label")!;

const terminalToolbar = document.getElementById("terminal-toolbar")!;
const terminalSessionName = document.getElementById("terminal-session-name")!;
const terminalStatusBadge = document.getElementById("terminal-status-badge")!;
const terminalTabs = document.getElementById("terminal-tabs")!;
const terminalContainer = document.getElementById("terminal-container")!;
const emptyState = document.getElementById("empty-state")!;
const fontSizeBtn = document.getElementById("font-size-btn") as HTMLButtonElement;
const actionsBtn = document.getElementById("actions-btn") as HTMLButtonElement;
const actionsMenu = document.getElementById("actions-menu")!;
const actionsPasteBtn = document.getElementById("actions-paste-btn") as HTMLButtonElement;
const actionsAttachBtn = document.getElementById("actions-attach-btn") as HTMLButtonElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const pasteModal = document.getElementById("paste-modal")!;
const pasteTextarea = document.getElementById("paste-textarea") as HTMLTextAreaElement;
const pasteClipboardBtn = document.getElementById("paste-clipboard-btn") as HTMLButtonElement;
const pasteSendBtn = document.getElementById("paste-send-btn") as HTMLButtonElement;
const toast = document.getElementById("toast")!;

// ── Viewport height ─────────────────────────────────────────────────────────
// iOS Safari's soft keyboard overlays the layout viewport without resizing
// it, so `100dvh` on <body> leaves the terminal partially behind the
// keyboard. VisualViewport fires resize events as the keyboard opens/closes
// and as the URL bar shows/hides — we mirror its height into --app-vh so the
// xterm host container refits to the space actually visible to the user.
function syncViewportHeight() {
	const vv = window.visualViewport;
	const h = vv ? vv.height : window.innerHeight;
	document.documentElement.style.setProperty("--app-vh", `${h}px`);
}
syncViewportHeight();
window.visualViewport?.addEventListener("resize", syncViewportHeight);
window.visualViewport?.addEventListener("scroll", syncViewportHeight);
window.addEventListener("resize", syncViewportHeight);

// ── Font size ───────────────────────────────────────────────────────────────
// Persisted across reloads via localStorage. Mobile users want ~16 px on a
// 6" phone, desktop users typically 13–15 px — let them pick once and stick.
const FONT_SIZE_STEPS = [11, 12, 13, 14, 15, 16, 18];
const DEFAULT_FONT_SIZE = 14;
const FONT_SIZE_KEY = "shared-terminal:font-size";
function readFontSize(): number {
	const raw = localStorage.getItem(FONT_SIZE_KEY);
	const n = raw ? Number.parseInt(raw, 10) : DEFAULT_FONT_SIZE;
	return FONT_SIZE_STEPS.includes(n) ? n : DEFAULT_FONT_SIZE;
}
let currentFontSize = readFontSize();

// ── State ───────────────────────────────────────────────────────────────────

let sessions: SessionInfo[] = [];
let activeSessionId: string | null = null;
let isRegisterMode = false;

// Active session's tabs only; switching sessions tears these down.
interface ActiveTerminal {
	pane: HTMLDivElement;
	term: TerminalSession;
}
let currentTabs: Tab[] = [];
let currentActiveTabId: string | null = null;
const currentTerminals = new Map<string, ActiveTerminal>();
// Tabs whose DELETE is in flight. Used so the same × can't fire twice
// while the request is pending (renderTabBar disables the button).
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
	// Clearing the tabs invalidates the chrome-toggle label — refresh
	// even though updateToolbar() (which would also do this) typically
	// runs immediately after. The defensive call costs almost nothing
	// and stops a stale "Tab N" lingering in the header on logout.
	updateChromeToggle();
}

// ── Auth flow ───────────────────────────────────────────────────────────────

// True only on the very first ever visit before any account exists. The
// backend lets the first register go through without an invite (bootstrap);
// we hide the invite-code field in that case so the screen looks normal.
let isBootstrapRegister = false;

async function initAuth() {
	// Cookie-based auth (#18): the only way to know if we're already
	// authenticated is to ask the server, since the cookie is httpOnly.
	// /auth/status fields both questions in one round-trip — `authenticated`
	// for "show app vs. login" and `needsSetup` for "show invite field".
	try {
		const { needsSetup, authenticated } = await checkAuthStatus();
		if (authenticated) {
			showApp();
			return;
		}
		if (needsSetup) {
			isRegisterMode = true;
			isBootstrapRegister = true;
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
	// Keep the sidebar-footer marker in lockstep with the header one so
	// a future swap of "●" for the actual username only needs editing
	// a single line.
	sidebarUserDisplay.textContent = userDisplay.textContent;
	applyAdminVisibility();
	refreshSessions();
}

// #50: gate invite-mint UI on the current session's admin status.
// Both buttons (desktop top bar + mobile sidebar) flip together. Read
// from the api-layer mirror, which is itself hydrated from /auth/status
// and the login/register responses, so this just reflects the current
// authoritative answer without needing its own round-trip.
function applyAdminVisibility() {
	const admin = isAdmin();
	invitesBtn.classList.toggle("hidden", !admin);
	sidebarInvitesBtn.classList.toggle("hidden", !admin);
}

function updateAuthUI() {
	if (isRegisterMode) {
		authTitle.textContent = "Create Account";
		authSubmitBtn.textContent = "Register";
		authToggle.innerHTML = 'Already have an account? <a href="#" id="auth-toggle-link">Login</a>';
		// Invite code is required for every register except the bootstrap
		// first user — show the field accordingly.
		authInviteCode.classList.toggle("hidden", isBootstrapRegister);
	} else {
		authTitle.textContent = "Login";
		authSubmitBtn.textContent = "Login";
		authToggle.innerHTML = 'No account? <a href="#" id="auth-toggle-link">Register</a>';
		authInviteCode.classList.add("hidden");
	}
	// Re-bind toggle link
	document.getElementById("auth-toggle-link")?.addEventListener("click", async (e) => {
		e.preventDefault();
		isRegisterMode = !isRegisterMode;
		authError.textContent = "";
		// Re-fetch the canonical bootstrap state when entering register
		// mode. Otherwise isBootstrapRegister is whatever it was at page
		// load — toggling login → register would silently keep the flag
		// (and the hidden invite field) even if the bootstrap window
		// closed in the interim. Single GET, only on the toggle click.
		if (isRegisterMode) {
			try {
				const { needsSetup } = await checkAuthStatus();
				isBootstrapRegister = needsSetup;
			} catch {
				/* status check failed — keep prior flag value */
			}
		}
		updateAuthUI();
	});
}

authForm.addEventListener("submit", async (e) => {
	e.preventDefault();
	authError.textContent = "";
	const username = authUsername.value.trim();
	const password = authPassword.value;
	const inviteCode = authInviteCode.value.trim();

	if (!username || !password) {
		authError.textContent = "Username and password required";
		return;
	}
	if (isRegisterMode && !isBootstrapRegister && !inviteCode) {
		authError.textContent = "Invite code required";
		return;
	}

	try {
		if (isRegisterMode) {
			await register(username, password, inviteCode || undefined);
		} else {
			await login(username, password);
		}
		showApp();
	} catch (err) {
		// The bootstrap window can close between page load and submit
		// (a concurrent register sneaks in, or the page sat open after
		// someone else set up the first account). The backend signals
		// this with 403 InviteRequired — clear the flag and reveal the
		// invite-code field so the user can retry without reloading.
		if (err instanceof InviteRequiredError && isBootstrapRegister) {
			isBootstrapRegister = false;
			updateAuthUI();
			authError.textContent = "An account already exists — enter an invite code to register.";
			return;
		}
		// Non-403 failures during bootstrap (transient 500, network blip)
		// would otherwise leave isBootstrapRegister=true forever — the
		// invite field stays hidden and every retry re-fires the no-invite
		// path, which the backend may now reject if a concurrent register
		// already grabbed the bootstrap slot. Re-fetch the canonical state
		// so the next submit either retries cleanly or shows the invite
		// field. checkAuthStatus is cheap and only runs on the rare
		// bootstrap-error path.
		if (isRegisterMode && isBootstrapRegister) {
			try {
				const { needsSetup } = await checkAuthStatus();
				if (!needsSetup) {
					isBootstrapRegister = false;
					updateAuthUI();
				}
			} catch {
				/* status check itself failed — keep the flag, surface the original error */
			}
		}
		authError.textContent = (err as Error).message;
	}
});

// Shared teardown for both the explicit logout button and the auto-triggered
// session-expired path below. Idempotent: `logout()` is safe to call from a
// logged-out state (it just POSTs /auth/logout and the server returns 204
// either way), disposeAllCurrentTerminals() handles an empty terminal map,
// and showAuth() just re-applies display styles. So the burst case (multiple
// 401s briefly racing) is safe even though apiFetch's `_loggedIn` guard
// already deduplicates.
//
// Fire and forget on the network call — the UI teardown shouldn't block on
// the round-trip, and the server's POST /auth/logout response carries no
// information we'd act on.
function handleLogout(toastMessage?: string): void {
	void logout();
	disposeAllCurrentTerminals();
	activeSessionId = null;
	sessions = [];
	showAuth();
	// Symmetry with showApp(): keep the admin-button visibility in
	// lockstep with the api-layer's _isAdmin flag, which logout() and
	// the 401 path both reset to false. No user-visible effect today
	// (showAuth() hides appView entirely), but a future code path that
	// reads admin visibility post-logout sees the right state.
	applyAdminVisibility();
	if (toastMessage) showToast(toastMessage, true);
}

logoutBtn.addEventListener("click", () => {
	handleLogout();
});

// Logout from the sidebar footer just delegates — handleLogout() tears
// the whole UI down so focus return is moot. Invites is wired separately
// further below: closeInvitesModal needs the actual opener button to
// restore focus to (the desktop invitesBtn is `display:none` on mobile,
// so a delegated `invitesBtn.click()` would silently lose focus on close).
sidebarLogoutBtn.addEventListener("click", () => logoutBtn.click());

// Listen for the api-layer signal that our session cookie is no longer
// accepted (#95). Without this, a `refreshSessions()` tick 15 s after
// expiry produces a 401 → red toast, the next tick does the same, and
// so on forever because nothing was flipping `_loggedIn` to false. api.ts
// now does that at the 401 and dispatches this event; we pair that with
// a UI transition back to the login view and a single explanatory toast.
//
// One-shot per burst: apiFetch's internal `_loggedIn` guard ensures the
// event fires at most once per 401 burst, so we don't need extra
// debouncing here.
window.addEventListener(SESSION_EXPIRED_EVENT, () => {
	handleLogout("Your session has expired — please sign in again");
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
		// Status class on the wrapper mirrors the session-dot rules so
		// future CSS can target failed/terminated items uniformly (dim
		// them, cross them out, etc.) without re-deriving the status
		// from a child element. Today only `terminated` has a wrapper
		// rule (.session-item.terminated dims the row); failed shows
		// up via the dot only — adding the class now means a follow-up
		// styling tweak doesn't have to touch this line.
		const statusCls = s.status === "terminated" || s.status === "failed" ? ` ${s.status}` : "";
		item.className = `session-item${s.sessionId === activeSessionId ? " active" : ""}${statusCls}`;

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
				} catch (err) {
					showToast((err as Error).message, true);
				}
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
				} catch (err) {
					showToast((err as Error).message, true);
				}
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
				} catch (err) {
					showToast((err as Error).message, true);
				}
			});
			actions.appendChild(restoreBtn);
		}

		const killBtn = document.createElement("button");
		killBtn.className = "session-kill";
		killBtn.textContent = "✕";
		// Shift-click enables hard delete — also wipes workspace files and
		// removes the session record entirely. Plain click is a soft delete,
		// which keeps the workspace files so the session can be restored.
		killBtn.title =
			s.status === "terminated"
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
			} catch (err) {
				showToast((err as Error).message, true);
			}
		});
		actions.appendChild(killBtn);
		item.appendChild(actions);

		// Click to open session
		item.addEventListener("click", () => {
			if (s.status === "running") {
				void openSession(s.sessionId);
			} else if (s.status === "stopped") {
				showToast("Start the session first", true);
			} else if (s.status === "failed") {
				// Failed sessions are unrecoverable via /start (the server
				// 409s); clicking them used to silently no-op which left
				// the user wondering if the click registered. Toast points
				// them at the recovery path: recreate to retry.
				showToast("Session failed during postCreate — recreate to retry", true);
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

function updateToolbar() {
	const s = sessions.find((x) => x.sessionId === activeSessionId);
	if (!s) {
		terminalToolbar.style.display = "none";
		terminalTabs.style.display = "none";
		terminalContainer.style.display = "none";
		emptyState.style.display = "flex";
		updateChromeToggle();
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
	// Refresh the mobile header context pill — its label tracks the
	// active session/tab, and visibility flips on/off here.
	updateChromeToggle();
}

// ── Tabs within the active session ──────────────────────────────────────────

function renderTabBar() {
	terminalTabs.innerHTML = "";
	if (!activeSessionId) {
		terminalTabs.style.display = "none";
		return;
	}
	// Render even at currentTabs.length === 0 so the + button is reachable
	// — a brand-new session starts with no tabs and the user opens the
	// first one from here.
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
		close.disabled = closingTabs.has(tab.tabId);
		close.addEventListener("click", (e) => {
			e.stopPropagation();
			void closeTab(tab.tabId, close);
		});
		chip.appendChild(close);

		chip.addEventListener("click", () => {
			// Click handlers eat synchronous throws — surface them as
			// a toast instead of letting the UI silently revert.
			try {
				openTab(tab.tabId);
			} catch (err) {
				showToast((err as Error).message, true);
			}
		});
		terminalTabs.appendChild(chip);
	}

	const addBtn = document.createElement("button");
	addBtn.id = "tab-add";
	addBtn.type = "button";
	addBtn.textContent = "+";
	addBtn.title = "Open a new tab (runs services independently; close to SIGHUP them)";
	addBtn.addEventListener("click", () => void addTab(addBtn));
	terminalTabs.appendChild(addBtn);
	// The chrome-toggle label tracks whichever tab is active — refresh
	// every time the bar is rebuilt so renames/closes/switches stay in
	// sync without having to thread updateChromeToggle() through every
	// caller of openTab/addTab/closeTab.
	updateChromeToggle();
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
									currentActiveTabId = null;
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
					// flow, immediately. Toast is one-time per tab
					// (gated inside terminal.ts) so a flapping driver
					// can't spam it. Surfaced as a non-error toast
					// because the terminal still works, just slower.
					showToast(`${msg} Reload the tab to retry GPU rendering.`);
				},
				onCopy: (ok: boolean) => {
					// Failure-only toast policy: silent on success matches
					// the native Cmd-C feel and avoids flooding the user
					// with chips on every selection-finalize (#158).
					// Identity guards mirror onStatus / onError above:
					// session match prevents stale toasts from a
					// torn-down tab in a different session, and active-tab
					// match prevents a background tab in the SAME session
					// from toasting against whatever pane the user is
					// currently looking at.
					if (activeSessionId !== ownSessionId) return;
					if (tabId !== currentActiveTabId) return;
					if (!ok) showToast("Copy failed — clipboard permission denied?", true);
				},
				isActive: () => activeSessionId === ownSessionId && tabId === currentActiveTabId,
			});
			entry = { pane, term };
			currentTerminals.set(tabId, entry);
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
	currentActiveTabId = tabId;
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
			currentTabs = currentTabs.filter((t) => t.tabId !== tab.tabId);
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
	if (
		!confirm(
			`Close tab "${tabLabel}"?\n\nAny processes running in this tab will be terminated (SIGHUP).`,
		)
	) {
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
	currentTabs = currentTabs.filter((t) => t.tabId !== tabId);

	// Closing the last tab on mobile leaves the chrome drawer collapsed
	// (default state), and the CSS hides #terminal-tabs entirely while
	// collapsed — so the + button rebuilt by renderTabBar() below isn't
	// reachable until the user discovers the header pill. Mirror the
	// openSession empty-tabs branch and auto-expand here too, so the
	// first new tab is always one tap away.
	if (isMobile() && currentTabs.length === 0) setChromeOpen(true);

	if (currentActiveTabId === tabId) {
		currentActiveTabId = null;
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

// ── New session ─────────────────────────────────────────────────────────────
//
// The new-session UI is a tabbed modal: Basics / Repo / Env / Ports / Advanced.
// Foundation lands in #185; only the Basics tab (session name) is functional
// today. The other tabs render placeholder copy linking to the child issue
// that wires each one up so users can see what's coming. PR 185b adds the
// bootstrap-output live-tail panel inside the modal once the runner exists.

const SESSION_TAB_PLACEHOLDERS: Record<string, { title: string; body: string; issueUrl: string }> =
	{
		repo: {
			title: "Clone a repo into the workspace",
			body: "Public or private (PAT / SSH), pick a branch or ref, optionally replace the workspace.",
			issueUrl: "https://github.com/gatof81/shared-terminal/issues/188",
		},
		env: {
			title: "Environment variables and secrets",
			body: "Plain values are stored in cleartext; secrets are AES-GCM-encrypted at rest and never echoed by listing endpoints.",
			issueUrl: "https://github.com/gatof81/shared-terminal/issues/186",
		},
		ports: {
			title: "Expose ports to the outside",
			body: "Per-session subdomains, dynamic host ports, auth-gated by default (independent of session ownership).",
			issueUrl: "https://github.com/gatof81/shared-terminal/issues/190",
		},
	};

let newSessionOpener: HTMLElement | null = null;

function renderSessionTabPlaceholders() {
	for (const [key, info] of Object.entries(SESSION_TAB_PLACEHOLDERS)) {
		const panel = document.getElementById(`session-tab-${key}`);
		if (!panel || panel.childElementCount > 0) continue;
		const wrap = document.createElement("p");
		wrap.className = "session-placeholder";
		// textContent path for the title + body so any future copy
		// change with user-supplied parts can't smuggle markup. The
		// trailing link is built with createElement and assembled below.
		const strong = document.createElement("strong");
		strong.textContent = info.title;
		wrap.appendChild(strong);
		wrap.appendChild(document.createElement("br"));
		wrap.appendChild(document.createTextNode(info.body));
		wrap.appendChild(document.createElement("br"));
		const a = document.createElement("a");
		a.href = info.issueUrl;
		a.target = "_blank";
		a.rel = "noopener";
		a.textContent = "Track progress on this tab →";
		wrap.appendChild(a);
		panel.appendChild(wrap);
	}
}

function setActiveSessionTab(key: string) {
	const tabs = newSessionModal.querySelectorAll<HTMLButtonElement>(".session-tab");
	const panels = newSessionModal.querySelectorAll<HTMLDivElement>(".session-tab-panel");
	for (const tab of tabs) {
		const active = tab.dataset.sessionTab === key;
		tab.classList.toggle("is-active", active);
		tab.setAttribute("aria-selected", active ? "true" : "false");
	}
	for (const panel of panels) {
		const active = panel.id === `session-tab-${key}`;
		panel.classList.toggle("is-active", active);
		// `hidden` is the source of truth for accessibility-tree
		// visibility; the .is-active class only handles the CSS
		// transitions. Keep them in sync so a screen reader doesn't
		// announce four placeholder panels every time the modal opens.
		panel.toggleAttribute("hidden", !active);
	}
}

function openNewSessionModal(opener: HTMLElement) {
	newSessionOpener = opener;
	renderSessionTabPlaceholders();
	setActiveSessionTab("basics");
	newSessionInput.value = "";
	newSessionSubmitBtn.disabled = false;
	clearBootstrapError();
	newSessionModal.classList.add("open");
	newSessionModal.setAttribute("aria-hidden", "false");
	// Defer focus to the next paint so the input is reliably focusable
	// (some browsers ignore .focus() on an element that just transitioned
	// from display:none in the same frame).
	requestAnimationFrame(() => newSessionInput.focus());
}

/**
 * Render a postCreate-hook failure inline in the modal — the user sees
 * the captured stdout/stderr without losing the form they were filling
 * out. Clears on next open / next submit. PR 185b2b will replace the
 * static `<pre>` with a live-tail panel that shows output as it
 * streams.
 */
function renderBootstrapError(err: BootstrapFailedError) {
	clearBootstrapError();
	const panel = document.createElement("div");
	panel.className = "bootstrap-error";
	panel.id = "bootstrap-error-panel";
	const heading = document.createElement("strong");
	heading.textContent = `postCreate hook failed (exit ${err.exitCode})`;
	panel.appendChild(heading);
	const hint = document.createElement("p");
	hint.className = "bootstrap-error-hint";
	hint.textContent =
		"The session was created but the bootstrap command exited non-zero, " +
		"so the container was killed and the session marked failed. " +
		"Captured output below — fix the command and create a new session.";
	panel.appendChild(hint);
	const pre = document.createElement("pre");
	pre.className = "bootstrap-error-output";
	pre.textContent = err.output || "(no output captured)";
	panel.appendChild(pre);
	const basicsPanel = document.getElementById("session-tab-basics");
	basicsPanel?.appendChild(panel);
}

function clearBootstrapError() {
	document.getElementById("bootstrap-error-panel")?.remove();
}

function closeNewSessionModal() {
	newSessionModal.classList.remove("open");
	newSessionModal.setAttribute("aria-hidden", "true");
	(newSessionOpener ?? newSessionBtn).focus();
	newSessionOpener = null;
}

newSessionBtn.addEventListener("click", () => openNewSessionModal(newSessionBtn));

newSessionModal.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	if (target.hasAttribute("data-close-modal")) closeNewSessionModal();
	const tab = target.closest<HTMLButtonElement>("[data-session-tab]");
	if (tab?.dataset.sessionTab) setActiveSessionTab(tab.dataset.sessionTab);
});

newSessionForm.addEventListener("submit", async (e) => {
	e.preventDefault();
	const name = newSessionInput.value.trim();
	if (!name) {
		newSessionInput.focus();
		return;
	}
	// Disable the submit button for the duration of the request so a
	// double-click doesn't fire two POSTs (which would create two
	// sessions and burn quota silently).
	newSessionSubmitBtn.disabled = true;
	clearBootstrapError();
	try {
		showToast("Creating session…");
		const session = await createSession(name);
		sessions.unshift(session);
		renderSessionList();
		closeNewSessionModal();
		void openSession(session.sessionId);
		showToast(`Session "${name}" created`);
	} catch (err) {
		if (err instanceof BootstrapFailedError) {
			// postCreate hook hard-failed (#185). Server already killed
			// the container and flipped status=failed. Refresh the
			// sidebar so the failed row shows up, and surface the hook's
			// captured stdout/stderr inline in the modal so the user can
			// see what went wrong without leaving the form.
			void refreshSessions();
			renderBootstrapError(err);
		} else {
			showToast((err as Error).message, true);
		}
		newSessionSubmitBtn.disabled = false;
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
		// Clear textContent too, not just the visibility class. Without
		// this the message stays readable to anything that queries the
		// DOM (devtools, browser extensions, an XSS payload) long after
		// the visual window closes — material when the message carries
		// a one-time secret like a freshly-minted invite code (#49).
		toast.textContent = "";
	}, 4000);
}

// ── Show terminated toggle ──────────────────────────────────────────────────

showTerminatedToggle.addEventListener("change", () => {
	console.debug(`[sessions] show-terminated toggled → ${showTerminatedToggle.checked}`);
	refreshSessions();
});

// ── Sidebar toggle ──────────────────────────────────────────────────────────

// Mirrored in index.html `@media (max-width: 768px)` — keep in sync. The CSS
// query is the source of truth for visual behaviour; this constant exists so
// the JS-side default (open on desktop, closed on mobile) matches.
const MOBILE_BREAKPOINT_PX = 768;
const mobileMql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`);
const isMobile = () => mobileMql.matches;

function setSidebarOpen(open: boolean) {
	const wasOpen = mainEl.classList.contains("sidebar-open");
	mainEl.classList.toggle("sidebar-open", open);
	sidebarToggleBtn.setAttribute("aria-expanded", String(open));

	// Focus management is only meaningful on mobile, where the sidebar
	// is a modal-style drawer — keyboard users opening it expect focus
	// to land inside, and closing it should return focus to the toggle
	// (only when focus was inside the drawer; otherwise the user has
	// already moved on and we'd be stealing their focus).
	if (!isMobile()) return;
	if (open && !wasOpen) {
		const firstFocusable = sidebarEl.querySelector<HTMLElement>(
			'input, button, a, [tabindex]:not([tabindex="-1"])',
		);
		firstFocusable?.focus();
	} else if (!open && wasOpen) {
		if (sidebarEl.contains(document.activeElement)) {
			sidebarToggleBtn.focus();
		}
	}
}

sidebarToggleBtn.addEventListener("click", () => {
	setSidebarOpen(!mainEl.classList.contains("sidebar-open"));
});

sidebarBackdrop.addEventListener("click", () => setSidebarOpen(false));

// Escape closes the mobile drawer, matching the WAI-ARIA modal-dialog
// expectation. Desktop ignores this — the sidebar is always part of the
// layout there and Escape conflicts with terminal/xterm key handling.
// Skip when a modal is open: WAI-ARIA says Escape dismisses the topmost
// dialog, not every overlay at once. Without this guard, an Escape press
// while paste/invites and the sidebar are both open would close both.
document.addEventListener("keydown", (e) => {
	if (e.key !== "Escape") return;
	if (!isMobile()) return;
	if (
		invitesModal.classList.contains("open") ||
		pasteModal.classList.contains("open") ||
		actionsMenu.classList.contains("open") ||
		newSessionModal.classList.contains("open")
	)
		return;
	if (!mainEl.classList.contains("sidebar-open")) return;
	setSidebarOpen(false);
});

// On mobile, picking a session should dismiss the drawer so the user can
// see the terminal — desktop keeps it pinned.
sessionList.addEventListener("click", (e) => {
	if (!isMobile()) return;
	// Ignore clicks on action buttons (start/stop/delete) — those don't
	// switch the active session, so dismissing the drawer is jarring.
	const target = e.target as HTMLElement;
	if (target.closest(".session-actions")) return;
	if (target.closest(".session-item")) setSidebarOpen(false);
});

// Crossing the breakpoint resets to the default state for that mode —
// otherwise a desktop user who shrinks the window would have the drawer
// already slid in (sidebar-open class still set, mobile CSS reads it as
// "show drawer"), and a mobile user who widens the window would find the
// sidebar column pinned at 0 with no visible trigger to recover.
mobileMql.addEventListener("change", () => {
	setSidebarOpen(!isMobile());
	// Re-derive the chrome drawer state too — desktop always wants it open
	// (since the toolbar/tabs are part of the layout there), and mobile
	// wants it closed unless the user is mid-onboarding (no tabs yet).
	setChromeOpen(chromeDefaultOpen());
});

// Default state: open on desktop, closed on mobile. The HTML+CSS start
// with the mobile drawer's transform-transition suppressed via
// `[data-sidebar-ready]`, so the synchronous flip below doesn't slide
// the drawer in on every page load. (The desktop grid-template-columns
// transition was removed in a fix for the resize race — see
// main.css `main { ... }`.)
setSidebarOpen(!isMobile());
mainEl.setAttribute("data-sidebar-ready", "");

// ── Chrome (toolbar + tabs) drawer toggle ───────────────────────────────────
// Mobile only — desktop always shows the toolbar+tabs as part of the layout.
// On mobile we hide them by default to give tmux the full viewport, and
// surface a slim toggle in the header that mirrors the sessions-sidebar
// pattern: tap to expand, tap a tab to collapse again.

function chromeDefaultOpen(): boolean {
	// Desktop: always open — the layout includes the toolbar/tabs row.
	if (!isMobile()) return true;
	// Mobile + active session with no tabs: expand so the user can see
	// the "+" button and create their first tab. Without this they'd
	// land on a blank screen with no obvious way forward.
	if (activeSessionId !== null && currentTabs.length === 0) return true;
	return false;
}

function setChromeOpen(open: boolean) {
	mainEl.classList.toggle("chrome-open", open);
	chromeToggleBtn.setAttribute("aria-expanded", String(open));
}

// Keep the header chrome-toggle's label in sync with the active session
// and tab. On mobile this IS the only on-screen indication of "where you
// are" — sessions sidebar and tabs row are both hidden by default.
// The mobile actions (+) button rides the same visibility lifecycle:
// nothing to paste into or attach to when no session is active, so hide
// both together.
function updateChromeToggle() {
	const s = sessions.find((x) => x.sessionId === activeSessionId);
	// Hide the toggle entirely when there's no session — there's nothing
	// for it to toggle, and the empty-state message in the terminal area
	// already explains what to do next.
	if (!s) {
		chromeToggleBtn.hidden = true;
		actionsBtn.hidden = true;
		return;
	}
	chromeToggleBtn.hidden = false;
	actionsBtn.hidden = false;
	const activeTab = currentTabs.find((t) => t.tabId === currentActiveTabId);
	// Format: "session › tab". Falls back to just the session name when
	// no tab is active yet (fresh session, between switches). Using a
	// thin space + chevron keeps it scannable on a 430-pt-wide screen.
	chromeToggleLabel.textContent = activeTab ? `${s.name} › ${activeTab.label}` : s.name;
}

chromeToggleBtn.addEventListener("click", () => {
	setChromeOpen(!mainEl.classList.contains("chrome-open"));
});

// On mobile, picking a tab from the chrome drawer is the user's signal
// that they're done with the controls and want to focus on tmux —
// auto-collapse so the terminal regains the full viewport. Mirrors the
// sessions-sidebar drawer behaviour. Closing/adding tabs and the font-size
// button are NOT collapse triggers: those are tweaks the user often
// repeats in succession, and forcing a re-expand each time is annoying.
terminalTabs.addEventListener("click", (e) => {
	if (!isMobile()) return;
	const target = e.target as HTMLElement;
	// Ignore the × close button and the + add button — they're explicit
	// affordances inside the chrome drawer that the user expects to stay
	// accessible. Only collapse on a chip click (tab switch).
	if (target.closest(".tab-close")) return;
	if (target.closest("#tab-add")) return;
	if (target.closest(".tab-chip")) setChromeOpen(false);
});

// Default chrome state — apply once, then defer to the per-action
// setChromeOpen calls scattered through openSession/openTab/etc.
setChromeOpen(chromeDefaultOpen());
updateChromeToggle();

// ── Font size cycle button ──────────────────────────────────────────────────

function nextFontSize(current: number): number {
	const i = FONT_SIZE_STEPS.indexOf(current);
	if (i === -1) return DEFAULT_FONT_SIZE;
	return FONT_SIZE_STEPS[(i + 1) % FONT_SIZE_STEPS.length]!;
}

// RAF-coalesce the per-tab apply (#56). Each click cycles
// `currentFontSize` immediately so the button label stays in lock-step
// with what the user clicked, but the per-tab `setFontSize` (which
// triggers an xterm re-layout + refit per tab) defers to the next
// animation frame and reads the latest value once. A burst of N clicks
// inside one frame collapses to exactly one apply per terminal.
let fontSizeRafScheduled = false;
fontSizeBtn.addEventListener("click", () => {
	currentFontSize = nextFontSize(currentFontSize);
	localStorage.setItem(FONT_SIZE_KEY, String(currentFontSize));
	fontSizeBtn.textContent = `Aa ${currentFontSize}`;
	if (fontSizeRafScheduled) return;
	fontSizeRafScheduled = true;
	requestAnimationFrame(() => {
		fontSizeRafScheduled = false;
		for (const { term } of currentTerminals.values()) {
			term.setFontSize(currentFontSize);
		}
	});
});
// Reflect the persisted size in the label on load so users see e.g. "Aa 16"
// rather than a generic "Aa" after they've picked their size once.
fontSizeBtn.textContent = `Aa ${currentFontSize}`;

// ── Invites modal ───────────────────────────────────────────────────────────

// Tracks which button opened the modal so close can return focus to the
// same element. Without this, mobile users opening via the sidebar footer
// would have focus restored to the desktop `invitesBtn` (display:none on
// mobile) and lose their place in the tab order — `.focus()` is a no-op
// on hidden elements.
let invitesOpener: HTMLButtonElement | null = null;

function openInvitesModal(opener: HTMLButtonElement) {
	invitesOpener = opener;
	invitesModal.classList.add("open");
	invitesModal.setAttribute("aria-hidden", "false");
	// Move focus into the dialog so a keyboard user activating the Invites
	// button via Enter doesn't have their first Tab walk through the page
	// behind the backdrop. Restored to invitesOpener on close.
	inviteCreateBtn.focus();
	void renderInvites();
}

function closeInvitesModal() {
	invitesModal.classList.remove("open");
	invitesModal.setAttribute("aria-hidden", "true");
	// Fall back to invitesBtn if the opener is missing (legacy path or
	// a future caller that forgot to set it). On mobile invitesBtn is
	// hidden, so a missing opener would still drop focus — but that's
	// a regression to flag in code review, not something to silently
	// paper over here.
	(invitesOpener ?? invitesBtn).focus();
	invitesOpener = null;
}

async function renderInvites() {
	inviteList.textContent = "Loading…";
	let invites: Invite[];
	try {
		invites = await listInvites();
	} catch (err) {
		inviteList.textContent = "";
		showToast((err as Error).message, true);
		return;
	}

	inviteList.textContent = "";
	if (invites.length === 0) {
		const empty = document.createElement("div");
		empty.className = "invite-empty";
		empty.textContent = "No invites yet — generate one above.";
		inviteList.appendChild(empty);
		return;
	}

	for (const invite of invites) {
		const used = invite.usedAt !== null;
		// expires_at is server-stored as "YYYY-MM-DD HH:MM:SS" UTC. Swap
		// the space for "T" before appending "Z" so the result is valid
		// ISO 8601 — Safari rejects the space-separated form and returns
		// Invalid Date, which would silently misclassify expired invites
		// as Unused.
		const expired =
			!used &&
			invite.expiresAt !== null &&
			new Date(`${invite.expiresAt.replace(" ", "T")}Z`).getTime() <= Date.now();
		const inert = used || expired;
		const row = document.createElement("div");
		row.className = `invite-row${inert ? " used" : ""}`;

		const code = document.createElement("span");
		code.className = "invite-code";
		// Plaintext is gone post-#49 — show the 4-char prefix the server
		// kept for recognition, padded with U+2022 so it visually reads
		// as "starts with abc1, rest hidden" rather than a partial code
		// the user might try to share.
		code.textContent = `${invite.codePrefix}••••••••••••`;
		code.title = `Hash ${invite.codeHash}`;
		row.appendChild(code);

		const status = document.createElement("span");
		status.className = `invite-status ${inert ? "used" : "unused"}`;
		status.textContent = used ? "Used" : expired ? "Expired" : "Unused";
		if (!used && !expired && invite.expiresAt) {
			status.title = `Expires ${invite.expiresAt} UTC`;
		}
		row.appendChild(status);

		// No "Copy" affordance: the plaintext is no longer recoverable
		// from the list. The post-mint reveal in the click handler below
		// is the only window in which the user can copy the live code.

		// Revoke is offered for both unused and expired invites — the
		// backend DELETE matches WHERE used_at IS NULL, so expired-but-
		// unused codes can be cleared from the list. Quota slots are
		// already auto-freed by the expiry filter on the COUNT subquery,
		// so this is purely UI hygiene.
		if (!used) {
			const revokeBtn = document.createElement("button");
			revokeBtn.type = "button";
			revokeBtn.className = "invite-action-btn revoke";
			revokeBtn.textContent = "Revoke";
			revokeBtn.addEventListener("click", async () => {
				if (!confirm(`Revoke invite starting with "${invite.codePrefix}"?`)) return;
				revokeBtn.disabled = true;
				try {
					await revokeInvite(invite.codeHash);
					await renderInvites();
				} catch (err) {
					revokeBtn.disabled = false;
					showToast((err as Error).message, true);
				}
			});
			row.appendChild(revokeBtn);
		}

		inviteList.appendChild(row);
	}

	// Backend caps the response at INVITE_LIST_LIMIT=100 (#54). When we
	// hit that boundary, the modal is silently truncated — surface a
	// hint so a user with > 100 historical invites isn't misled into
	// thinking that's everything. Real cursor pagination is overkill
	// today; this footer is the cheap signal that something was elided.
	const SERVER_INVITE_LIMIT = 100;
	if (invites.length === SERVER_INVITE_LIMIT) {
		const footer = document.createElement("div");
		footer.className = "invite-empty";
		footer.textContent = "Older invites not shown — only the most recent 100 are listed.";
		inviteList.appendChild(footer);
	}
}

invitesBtn.addEventListener("click", () => openInvitesModal(invitesBtn));
sidebarInvitesBtn.addEventListener("click", () => openInvitesModal(sidebarInvitesBtn));

// Mint flow: the server returns plaintext exactly once. We surface it
// to the user with a copy-now-or-lose-it confirm dialog before refreshing
// the list (which only carries the prefix from this point on). The
// confirm() copy is not pretty UX, but it's the one universally available
// "you must dismiss this" affordance the codebase already leans on (see
// the revoke prompt above and the hard-delete prompt elsewhere); a custom
// modal would expand scope without changing the security property.
inviteCreateBtn.addEventListener("click", async () => {
	inviteCreateBtn.disabled = true;
	try {
		const minted = await createInvite();
		try {
			await navigator.clipboard.writeText(minted.code);
			// Don't echo the code into the toast — the clipboard already
			// has it, and the toast element keeps its text in the DOM
			// for the lifetime of the page. Cheap defense in depth on
			// top of the textContent-clearing in showToast itself.
			showToast("Invite code copied to clipboard");
		} catch {
			// Clipboard write can fail under permission-denied / non-secure-
			// context. Fall back to alert() so the plaintext still reaches
			// the user before it's gone forever.
			alert(
				`Invite code (won't be shown again — copy now):\n\n${minted.code}\n\n` +
					"You can share this code with someone you want to invite.",
			);
		}
		await renderInvites();
	} catch (err) {
		showToast((err as Error).message, true);
	} finally {
		inviteCreateBtn.disabled = false;
	}
});

// data-close-modal lives on both the backdrop and the × button — one
// listener handles both rather than wiring two element refs.
invitesModal.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	if (target.hasAttribute("data-close-modal")) closeInvitesModal();
});

document.addEventListener("keydown", (e) => {
	if (e.key !== "Escape") return;
	if (newSessionModal.classList.contains("open")) {
		closeNewSessionModal();
	} else if (invitesModal.classList.contains("open")) {
		closeInvitesModal();
	} else if (pasteModal.classList.contains("open")) {
		closePasteModal();
	} else if (actionsMenu.classList.contains("open")) {
		closeActionsMenu();
		actionsBtn.focus();
	}
});

// ── Paste modal ─────────────────────────────────────────────────────────────
// Mobile soft-keyboards don't surface a usable Cmd-V into xterm's helper
// textarea — the OS clipboard chooser either does nothing or trickles bytes
// in as individual keystrokes that bypass bracketed-paste, so a multi-line
// paste gets line-by-line executed by the shell. This modal gives users a
// reliable surface: try `navigator.clipboard.readText()` first (silent on
// Android Chrome and after iOS's first consent), and fall back to a
// long-press-able textarea when the API is blocked or rejected.

// Mirror of the textarea's HTML `maxlength` (frontend/index.html). The
// silent clipboard path bypasses the textarea entirely, and `pasteTextarea
// .value = clip` in the clipboard-fill handler isn't constrained by HTML
// maxlength either (that attribute only gates user typing). A user with a
// multi-megabyte clipboard pasted straight to the tmux exec stream would
// freeze the pane long before the WS layer's default 100 MB limit fired —
// cap explicitly so the toast is the worst they see.
const MAX_PASTE_CHARS = 65_536;

let pasteOpener: HTMLButtonElement | null = null;

function getActiveTerminal(): TerminalSession | null {
	if (!currentActiveTabId) return null;
	return currentTerminals.get(currentActiveTabId)?.term ?? null;
}

function openPasteModal(opener: HTMLButtonElement) {
	pasteOpener = opener;
	pasteModal.classList.add("open");
	pasteModal.setAttribute("aria-hidden", "false");
	pasteTextarea.value = "";
	pasteSendBtn.disabled = true;
	// Focus the textarea so the soft keyboard pops and a long-press
	// immediately offers Paste — saves the user one tap.
	pasteTextarea.focus();
}

function closePasteModal() {
	pasteModal.classList.remove("open");
	pasteModal.setAttribute("aria-hidden", "true");
	pasteTextarea.value = "";
	pasteSendBtn.disabled = true;
	// Release the runPasteFlow in-flight guard. The flow intentionally
	// leaves it set on the modal-open path so a second tap can't kick
	// off a parallel readClipboardText() while the modal is open;
	// closure of the modal is the signal that the cycle is truly
	// finished.
	pasteInFlight = false;
	// Restore focus to the opener — typically actionsBtn, which is
	// visible whenever a session is active. If it's somehow gone the
	// focus call is a harmless no-op.
	pasteOpener?.focus();
	pasteOpener = null;
}

async function readClipboardText(): Promise<string | null> {
	// navigator.clipboard.readText is the silent path. Returns null when
	// the API is unavailable, rejected (permission denied / in-app
	// webview), or throws synchronously on browsers that ship the API
	// gated on a secure context they don't recognise.
	if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") {
		return null;
	}
	try {
		return await navigator.clipboard.readText();
	} catch {
		return null;
	}
}

// Guards against two distinct races:
//   1. iOS "Paste" consent chip: the chip can take a second to appear,
//      and a second tap during that window would re-enter the async path
//      and queue a second clipboard read.
//   2. Modal-open window: openPasteModal() is synchronous, so a naive
//      try/finally would clear the guard the moment the modal opens —
//      letting another tap re-fire and re-initialise the modal,
//      clobbering text the user has started typing in the textarea.
//
// The guard therefore stays held across the modal lifetime; closePasteModal
// is the single release point. The local `releaseGuard` boolean tracks
// which exit path we're on so the silent-paste path still releases via
// finally without depending on a synthetic catch-and-rethrow.
let pasteInFlight = false;

async function runPasteFlow(opener: HTMLButtonElement) {
	if (pasteInFlight) return;
	pasteInFlight = true;
	let releaseGuard = true;
	try {
		const term = getActiveTerminal();
		if (!term) {
			showToast("No active session", true);
			return;
		}
		const clip = await readClipboardText();
		// Empty string is treated the same as null. iOS Safari can
		// resolve readText() with "" when the user dismisses or
		// never engages with the system "Paste" consent chip — even
		// if the clipboard genuinely has content. Treating that as
		// success would dead-end the user with a misleading
		// "clipboard empty" toast; falling through to the modal
		// gives them a long-press path that always works.
		if (clip) {
			if (clip.length > MAX_PASTE_CHARS) {
				showToast(`Clipboard too large (${clip.length} chars; max ${MAX_PASTE_CHARS})`, true);
				return;
			}
			term.paste(clip);
			showToast(`Pasted ${clip.length} character${clip.length === 1 ? "" : "s"}`);
			return;
		}
		// Clipboard API unavailable, denied, or returned empty —
		// surface the manual fallback. Hand the guard ownership to
		// closePasteModal so the second-tap protection covers the
		// entire modal lifetime, not just the synchronous tail of
		// this handler.
		openPasteModal(opener);
		releaseGuard = false;
	} finally {
		if (releaseGuard) pasteInFlight = false;
	}
}

pasteClipboardBtn.addEventListener("click", async () => {
	// Disable for the duration of the async readText() so a double-tap on
	// a slow iOS consent chip doesn't queue a stale second resolve. Same
	// intent as the runPasteFlow pasteInFlight guard, just expressed via
	// the button's own disabled state since there's nowhere visual to
	// look for in-flight feedback otherwise.
	pasteClipboardBtn.disabled = true;
	try {
		const clip = await readClipboardText();
		// Collapse null and "" — both mean "we couldn't get usable
		// clipboard text". null = API unavailable/denied. "" = iOS
		// resolved without engaging the consent chip, OR the
		// clipboard genuinely is empty. Either way the textarea
		// (long-press fallback) is the right next step. The toast
		// covers both interpretations because we can't distinguish
		// them: iOS doesn't tell us which "" we got.
		if (!clip) {
			showToast("Clipboard is empty or couldn't be read — long-press to paste manually", true);
			return;
		}
		if (clip.length > MAX_PASTE_CHARS) {
			showToast(`Clipboard too large (${clip.length} chars; max ${MAX_PASTE_CHARS})`, true);
			return;
		}
		pasteTextarea.value = clip;
		pasteSendBtn.disabled = false;
		pasteTextarea.focus();
	} finally {
		pasteClipboardBtn.disabled = false;
	}
});

pasteTextarea.addEventListener("input", () => {
	pasteSendBtn.disabled = pasteTextarea.value.length === 0;
});

pasteSendBtn.addEventListener("click", () => {
	const text = pasteTextarea.value;
	if (!text) return;
	// Defence in depth — HTML maxlength gates user typing but not
	// programmatic value sets, so a clipboard-fill of >65 KB could
	// sneak past it before this point.
	if (text.length > MAX_PASTE_CHARS) {
		showToast(`Too large (${text.length} chars; max ${MAX_PASTE_CHARS})`, true);
		return;
	}
	const term = getActiveTerminal();
	if (!term) {
		showToast("No active session", true);
		closePasteModal();
		return;
	}
	term.paste(text);
	showToast(`Pasted ${text.length} character${text.length === 1 ? "" : "s"}`);
	closePasteModal();
});

pasteModal.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	if (target.hasAttribute("data-close-modal")) closePasteModal();
});

// ── Actions (+) menu ────────────────────────────────────────────────────────
// The mobile "+" button hosts both the existing paste flow and the new
// file-attach flow. Two-step UX (open menu → pick action) is the cost of
// supporting more than one command from a single header button.

function openActionsMenu() {
	actionsMenu.classList.add("open");
	actionsMenu.setAttribute("aria-hidden", "false");
	actionsBtn.setAttribute("aria-expanded", "true");
	actionsPasteBtn.focus();
}

function closeActionsMenu() {
	actionsMenu.classList.remove("open");
	actionsMenu.setAttribute("aria-hidden", "true");
	actionsBtn.setAttribute("aria-expanded", "false");
}

actionsBtn.addEventListener("click", () => {
	if (actionsMenu.classList.contains("open")) {
		closeActionsMenu();
		actionsBtn.focus();
	} else {
		openActionsMenu();
	}
});

actionsMenu.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	if (target.hasAttribute("data-close-modal")) {
		closeActionsMenu();
		actionsBtn.focus();
	}
});

actionsPasteBtn.addEventListener("click", async () => {
	closeActionsMenu();
	// actionsBtn is the visible widget the user tapped first; route focus
	// back to it when the paste modal eventually closes.
	await runPasteFlow(actionsBtn);
});

actionsAttachBtn.addEventListener("click", () => {
	closeActionsMenu();
	// Reset the input so picking the same file twice in a row still
	// fires `change` (browsers no-op when value is unchanged).
	fileInput.value = "";
	fileInput.click();
});

// ── File attachment flow ────────────────────────────────────────────────────
// Upload via multipart, then type the in-container paths into the active
// terminal so the user can keep typing their prompt around them.

const MAX_ATTACH_FILES = 8; // mirrors backend multer cap
const MAX_ATTACH_BYTES = 25 * 1024 * 1024; // mirrors backend per-file cap

let attachInFlight = false;

fileInput.addEventListener("change", async () => {
	const picked = Array.from(fileInput.files ?? []);
	// Clear immediately so a re-pick of the same files still triggers change.
	fileInput.value = "";
	if (picked.length === 0) return;
	if (attachInFlight) {
		// Without the toast the picker silently closes and nothing
		// happens — the prior "Uploading…" toast may have already
		// scrolled away, so the user has no feedback.
		showToast("Upload in progress, try again shortly", true);
		return;
	}
	attachInFlight = true;
	// Every `return` inside this try { } is covered by the finally below
	// that resets attachInFlight — including the early validation
	// returns. Don't move attachInFlight = false above the try or
	// duplicate it on each early return; the finally is the single
	// release point.
	try {
		if (!activeSessionId) {
			showToast("No active session", true);
			return;
		}
		// Snapshot the id before any await so a session-switch or
		// logout that flips activeSessionId mid-upload doesn't end
		// up POSTing to /sessions/null/files. Same pattern as
		// addTab and openSession.
		const sessionId = activeSessionId;
		if (picked.length > MAX_ATTACH_FILES) {
			showToast(`Too many files (${picked.length}; max ${MAX_ATTACH_FILES})`, true);
			return;
		}
		const oversized = picked.find((f) => f.size > MAX_ATTACH_BYTES);
		if (oversized) {
			const mb = (oversized.size / (1024 * 1024)).toFixed(1);
			showToast(`"${oversized.name}" is ${mb} MB — files must be ≤25 MB`, true);
			return;
		}
		showToast(`Uploading ${picked.length} file${picked.length === 1 ? "" : "s"}…`);
		let result: { paths: string[] };
		try {
			result = await uploadSessionFiles(sessionId, picked);
		} catch (err) {
			showToast(`Upload failed: ${(err as Error).message}`, true);
			return;
		}
		// Re-check identity post-await: if the user switched away
		// from this session while the upload was in flight, pasting
		// its paths into whatever terminal they're now looking at
		// would silently inject foreign-session paths into their
		// current command. Mirrors the same guard pattern used in
		// addTab/openSession/closeTab. The files still landed in
		// session A's workspace; the user can switch back and
		// reference them manually.
		if (activeSessionId !== sessionId) {
			showToast(`Uploaded ${result.paths.length} to the previous session`);
			return;
		}
		const term = getActiveTerminal();
		if (term && result.paths.length > 0) {
			// Quote any path containing whitespace — the sanitiser shouldn't
			// produce one, but the user pastes this directly into the shell.
			// Trailing space lets them keep typing immediately after.
			const inserted = `${result.paths.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(" ")} `;
			term.paste(inserted);
			showToast(`Attached ${result.paths.length} file${result.paths.length === 1 ? "" : "s"}`);
		} else {
			// Container isn't running, so there's nothing to type into. The
			// files still land in the workspace and survive a /start, so the
			// user can reference them later.
			showToast(`Uploaded ${result.paths.length}; start the session to use them`);
		}
	} finally {
		attachInFlight = false;
	}
});

// ── Auto-refresh ────────────────────────────────────────────────────────────

setInterval(() => {
	if (isLoggedIn()) refreshSessions();
}, 15_000);

// ── Init ────────────────────────────────────────────────────────────────────

updateAuthUI();
initAuth();
