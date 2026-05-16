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
	type AdminGroupDetail,
	type AdminGroupSummary,
	type AdminObserveLogEntry,
	type AdminSession,
	type AdminStats,
	addAdminGroupMember,
	adminForceDelete,
	adminForceStop,
	checkAuthStatus,
	createAdminGroup,
	createInvite,
	createSession,
	createTab,
	createTemplate,
	deleteAdminGroup,
	deleteSession,
	deleteTab,
	deleteTemplate,
	type EnvVarEntryInput,
	fetchAdminGroup,
	fetchAdminGroups,
	fetchAdminObserveLog,
	fetchAdminSessions,
	fetchAdminStats,
	fetchMyGroups,
	fetchMyObservableSessions,
	fetchSessionObserveLog,
	getResourceCaps,
	getTemplate,
	type Invite,
	InviteRequiredError,
	idleSecondsToFormUnit,
	isAdmin,
	isLead,
	isLoggedIn,
	type LeadGroup,
	listInvites,
	listSessions,
	listTabs,
	listTemplates,
	login,
	logout,
	memBytesToFormUnit,
	type ObservableSession,
	type ObserveLogEntry,
	openBootstrapWs,
	register,
	removeAdminGroupMember,
	revokeInvite,
	SESSION_EXPIRED_EVENT,
	type SessionConfigPayload,
	type SessionInfo,
	startSession,
	stopSession,
	stripConfigForTemplate,
	type Tab,
	TabNotFoundError,
	type Template,
	type TemplateSummary,
	updateAdminGroup,
	updateTemplate,
	uploadSessionFiles,
} from "./api.js";
import { parseDotEnv } from "./envParser.js";
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
const newSessionInputLabel = document.getElementById("new-session-input-label")!;
const newSessionSubmitBtn = document.getElementById("new-session-submit") as HTMLButtonElement;
const newSessionModalTitle = document.getElementById("new-session-modal-title")!;
const editTemplateDescriptionField = document.getElementById("edit-template-description-field")!;
const editTemplateDescriptionInput = document.getElementById(
	"edit-template-description-input",
) as HTMLInputElement;
const showTerminatedToggle = document.getElementById("show-terminated-toggle") as HTMLInputElement;
const mainEl = document.querySelector("main")!;
const sidebarEl = document.getElementById("sidebar")!;
const sidebarToggleBtn = document.getElementById("sidebar-toggle") as HTMLButtonElement;
const sidebarBackdrop = document.getElementById("sidebar-backdrop")!;
const sidebarInvitesBtn = document.getElementById("sidebar-invites-btn") as HTMLButtonElement;
const sidebarAdminBtn = document.getElementById("sidebar-admin-btn") as HTMLButtonElement;
const templatesBtn = document.getElementById("templates-btn") as HTMLButtonElement;
const adminBtn = document.getElementById("admin-btn") as HTMLButtonElement;
const adminModal = document.getElementById("admin-modal")!;
const adminStatsEl = document.getElementById("admin-stats")!;
const adminSessionsListEl = document.getElementById("admin-sessions-list")!;
const adminRefreshBtn = document.getElementById("admin-refresh-btn") as HTMLButtonElement;
const adminUptimeEl = document.getElementById("admin-uptime")!;
// #201e-2 — admin Groups CRUD (in admin dashboard) + admin observe-log
// + per-session Observers button. Visibility for the Groups + observe-log
// sections is the parent admin modal (admin-only). Observers button is
// shown for everyone; the backend returns 403 if the caller can't
// observe the session.
const adminGroupsListEl = document.getElementById("admin-groups-list")!;
const adminGroupCreateBtn = document.getElementById("admin-group-create-btn") as HTMLButtonElement;
const adminObserveLogEl = document.getElementById("admin-observe-log")!;
const adminGroupModal = document.getElementById("admin-group-modal")!;
const adminGroupModalTitle = document.getElementById("admin-group-modal-title")!;
const adminGroupForm = document.getElementById("admin-group-form") as HTMLFormElement;
const adminGroupNameInput = document.getElementById("admin-group-name") as HTMLInputElement;
const adminGroupDescriptionInput = document.getElementById(
	"admin-group-description",
) as HTMLInputElement;
const adminGroupLeadUserIdInput = document.getElementById(
	"admin-group-lead-user-id",
) as HTMLInputElement;
const adminGroupSubmitBtn = document.getElementById("admin-group-submit-btn") as HTMLButtonElement;
const adminGroupMembersModal = document.getElementById("admin-group-members-modal")!;
const adminGroupMembersModalTitle = document.getElementById("admin-group-members-modal-title")!;
const adminGroupMembersModalHint = document.getElementById("admin-group-members-modal-hint")!;
const adminGroupAddMemberForm = document.getElementById(
	"admin-group-add-member-form",
) as HTMLFormElement;
const adminGroupAddMemberInput = document.getElementById(
	"admin-group-add-member-input",
) as HTMLInputElement;
const adminGroupMembersListEl = document.getElementById("admin-group-members-list")!;
const observersBtn = document.getElementById("observers-btn") as HTMLButtonElement;
const observersModal = document.getElementById("observers-modal")!;
const observersModalListEl = document.getElementById("observers-modal-list")!;

// #201e — lead-side "My groups" surface. Visibility flips on isLead()
// from the api-layer mirror. Sidebar + header buttons are gated together
// (same shape as the Admin pair above).
const myGroupsBtn = document.getElementById("my-groups-btn") as HTMLButtonElement;
const sidebarMyGroupsBtn = document.getElementById("sidebar-my-groups-btn") as HTMLButtonElement;
const myGroupsModal = document.getElementById("my-groups-modal")!;
const myGroupsListEl = document.getElementById("my-groups-list")!;
const myGroupsRefreshBtn = document.getElementById("my-groups-refresh-btn") as HTMLButtonElement;
const observeModal = document.getElementById("observe-modal")!;
const observeModalTitle = document.getElementById("observe-modal-title")!;
const observeModalHint = document.getElementById("observe-modal-hint")!;
const observeTerminalHost = document.getElementById("observe-terminal-host")!;
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
		// #200: caps now mirrored in the api module — apply to the form
		// once on init so the very first modal open shows operator-
		// lowered bounds. Re-applied on every modal open below to catch
		// the rare case where caps change after initial paint.
		applyResourceCapsToForm();
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

// #50 / #201e: gate role-conditional UI on the api-layer mirror.
// Each button pair (header + sidebar) flips together. Hydrated from
// /auth/status + login/register so this just reflects the current
// authoritative answer without its own round-trip. Visibility is a
// UX hint only — every gated endpoint is server-side requireAdmin /
// requireAuth-gated, so a leaked button reveal is harmless.
function applyAdminVisibility() {
	const admin = isAdmin();
	invitesBtn.classList.toggle("hidden", !admin);
	sidebarInvitesBtn.classList.toggle("hidden", !admin);
	adminBtn.classList.toggle("hidden", !admin);
	sidebarAdminBtn.classList.toggle("hidden", !admin);
	const lead = isLead();
	myGroupsBtn.classList.toggle("hidden", !lead);
	sidebarMyGroupsBtn.classList.toggle("hidden", !lead);
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
	// Tear down the observe-mode WS BEFORE the logout fires (#201e
	// review). Without this, an active observe attach survives both
	// the explicit logout button and the SESSION_EXPIRED_EVENT path
	// — `disposeAllCurrentTerminals` only walks `currentTerminals`
	// (the owner-mode tab map), and `activeObserveTerm` is a
	// separate module-level handle. The leak doesn't crash anything
	// but leaves the audit row's `ended_at` unset until the backend
	// WS heartbeat eventually kills the socket (minutes later) —
	// observability gap during that window. `closeObserveModal` is
	// idempotent when no observe is active, so calling it
	// unconditionally needs no guard.
	closeObserveModal();
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

// All previously-placeholder tabs (env / hooks / ports) are now wired
// up to real form UI, but the registry stays so a future #197 / #199
// child issue can drop in a placeholder without re-adding the
// rendering scaffold below.
const SESSION_TAB_PLACEHOLDERS: Record<string, { title: string; body: string; issueUrl: string }> =
	{};

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

// Edit-template state (#231). When non-null the create-session modal
// is in "edit template" mode: submit calls `PUT /api/templates/:id`
// instead of `POST /api/sessions`, the session-name input is reused
// as the template name, and a description field appears below it.
// `setNewSessionModalMode` flips all the user-visible chrome so a
// stale label or button text from a previous open can't leak into
// the wrong mode.
let editingTemplateId: string | null = null;

function setNewSessionModalMode(template: Template | null): void {
	editingTemplateId = template ? template.id : null;
	if (template) {
		newSessionModalTitle.textContent = "Edit template";
		newSessionInputLabel.textContent = "Template name";
		newSessionSubmitBtn.textContent = "Save changes";
		// Hide the save-as-template-from-edit path entirely. Nesting
		// "save as template" inside an edit form is a UX trap (does it
		// fork the template? overwrite? open a second modal?) the
		// issue body explicitly says to skip.
		saveTemplateBtn.hidden = true;
		editTemplateDescriptionField.hidden = false;
		editTemplateDescriptionInput.value = template.description ?? "";
	} else {
		newSessionModalTitle.textContent = "New session";
		newSessionInputLabel.textContent = "Session name";
		newSessionSubmitBtn.textContent = "Create session";
		saveTemplateBtn.hidden = false;
		editTemplateDescriptionField.hidden = true;
		editTemplateDescriptionInput.value = "";
	}
}

function openNewSessionModal(opener: HTMLElement) {
	newSessionOpener = opener;
	renderSessionTabPlaceholders();
	setActiveSessionTab("basics");
	newSessionInput.value = "";
	newSessionSubmitBtn.disabled = false;
	clearBootstrapError();
	// Default every open to create-mode. Edit-mode is opted into by
	// `editTemplate(id)` after the modal is open and the form has been
	// populated via `applyTemplateToForm`.
	setNewSessionModalMode(null);
	// `resetEnvTab` no longer fires here — `closeNewSessionModal`
	// already wiped state on the previous close, and the initial
	// declaration of `envRows = []` covers the very first open.
	// #200: re-apply caps in case checkAuthStatus refreshed them since
	// initAuth ran (idempotent — same numbers if nothing changed).
	applyResourceCapsToForm();
	newSessionModal.classList.add("open");
	newSessionModal.setAttribute("aria-hidden", "false");
	// Defer focus to the next paint so the input is reliably focusable
	// (some browsers ignore .focus() on an element that just transitioned
	// from display:none in the same frame).
	requestAnimationFrame(() => newSessionInput.focus());
}

/**
 * PR 185b2b live-tail state. While a bootstrap WS is open we hold onto
 * the close thunk + the rendered `<pre>` so:
 *   - cancelling the modal (Esc, X, backdrop) closes the WS and the
 *     hook keeps running server-side; the user can re-open the
 *     session later from the sidebar to attach to its terminal.
 *   - submitting again while a previous WS is still draining
 *     (shouldn't happen, modal disables the button, but defensive)
 *     tears the old one down first.
 */
let activeBootstrap: { close: () => void } | null = null;

function startBootstrapLiveTail(session: SessionInfo, name: string) {
	clearBootstrapError();
	const panel = document.createElement("div");
	panel.className = "bootstrap-tail";
	panel.id = "bootstrap-error-panel"; // reused id so clearBootstrapError() removes either kind
	const heading = document.createElement("strong");
	heading.textContent = "Bootstrapping session…";
	panel.appendChild(heading);
	const hint = document.createElement("p");
	hint.className = "bootstrap-error-hint";
	hint.textContent =
		"Live output from session bootstrap (clone, dotfiles, agent seed, postCreate). The modal will close on success.";
	panel.appendChild(hint);
	const pre = document.createElement("pre");
	pre.className = "bootstrap-error-output";
	pre.textContent = "";
	panel.appendChild(pre);
	document.getElementById("session-tab-basics")?.appendChild(panel);

	activeBootstrap = openBootstrapWs(session.sessionId, {
		onOutput: (chunk) => {
			pre.textContent += chunk;
			// Auto-scroll to the bottom so the latest line is visible
			// — `npm install`-style hooks emit hundreds of lines and
			// the user expects the tail, not the head.
			pre.scrollTop = pre.scrollHeight;
		},
		onDone: (success, exitCode, error, stage) => {
			activeBootstrap = null;
			if (success) {
				closeNewSessionModal();
				void openSession(session.sessionId);
				showToast(`Session "${name}" created`);
				return;
			}
			// Hard fail: server already flipped row to `failed` and
			// killed the container. Switch panel into the error
			// styling, refresh sidebar so the failed row appears,
			// re-enable the submit button so the user can fix the
			// hook + try again.
			//
			// `stage` (#252) names the pipeline step that failed
			// (gitIdentity / clone / dotfiles / agentSeed /
			// postCreate). Without it, this UI used to hardcode
			// "postCreate hook failed" — confusing for a user whose
			// failure was actually in clone or dotfiles AND who
			// hadn't configured a postCreate at all.
			panel.classList.add("bootstrap-error");
			// Fall back to "bootstrap" (the generic), NOT "postCreate" —
			// the no-stage case (config-fetch failure before any stage
			// runs) would otherwise recreate the exact misleading
			// "postCreate hook failed" label this PR is fixing.
			const stageLabel = stage ?? "bootstrap";
			heading.textContent = error
				? `Bootstrap stage '${stageLabel}' failed (${error})`
				: `Bootstrap stage '${stageLabel}' failed (exit ${exitCode ?? "?"})`;
			hint.textContent =
				stage === "postCreate"
					? "The postCreate command exited non-zero, so the container was killed and the session marked failed. Captured output above — fix the command and create a new session."
					: `The '${stageLabel}' bootstrap stage failed, so the container was killed and the session marked failed. Captured output above — fix the ${stageLabel} config and create a new session.`;
			void refreshSessions();
			newSessionSubmitBtn.disabled = false;
		},
	});
}

function teardownBootstrapTail() {
	if (activeBootstrap) {
		activeBootstrap.close();
		activeBootstrap = null;
	}
	// Clear any rendered tail / error panel too. Without this, a
	// cancelled-mid-bootstrap close left the error-styled panel in
	// the DOM; the next time the modal opened it briefly flashed a
	// "postCreate hook failed" message that didn't apply to the new
	// session (PR #208 round 3).
	clearBootstrapError();
}

function clearBootstrapError() {
	document.getElementById("bootstrap-error-panel")?.remove();
}

function closeNewSessionModal() {
	newSessionModal.classList.remove("open");
	newSessionModal.setAttribute("aria-hidden", "true");
	// PR 185b2b: closing the modal mid-bootstrap MUST cancel the WS
	// subscription. The hook itself keeps running server-side (the
	// async runner is fire-and-forget); we just stop tailing it. The
	// user can re-attach to the session from the sidebar once it
	// reaches `running` (or see the failure in the row's status if it
	// flipped to `failed`).
	teardownBootstrapTail();
	// Reset Env-tab state on close (#211 round 2) so the in-memory
	// `envRows` doesn't drift from the now-hidden DOM between close
	// and re-open. The redundant reset on `openNewSessionModal` is
	// gone — closing always leaves the array empty.
	resetEnvTab();
	// Reset Repo-tab state on close (#188 PR 188e). Critical for the
	// credential fields (PAT, SSH key) — leaving them mounted would
	// risk leaking a stale credential into the next session create.
	resetRepoTab();
	// Reset Advanced-tab state on close (#191 PR 191c). Same
	// rationale plus the agent-seed bodies can be substantial.
	resetAdvancedTab();
	// Reset Ports-tab state on close (#190 PR 190d). Drops any
	// configured ports + the allowPrivilegedPorts toggle so a stale
	// 80/443 row from an earlier modal session doesn't carry over.
	resetPortsTab();
	// Reset edit-template mode (#231). Mirrors the resetXTab pattern
	// above — every modal-close path must leave the module in a clean
	// default state, otherwise a future caller that shows the modal
	// without going through `openNewSessionModal` would silently
	// enter edit mode with a stale `editingTemplateId`.
	setNewSessionModalMode(null);
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

// ── Repo tab (#188 / PR 188e) ───────────────────────────────────────────────
//
// State + render + wiring for the repo-clone Repo tab. The tab is the
// frontend half of #188; backend pieces shipped in 188a-188d.
//
// Three auth modes selected by the `Auth` dropdown:
//   - `none` — anonymous HTTPS clone, no credentials.
//   - `pat`  — HTTPS + personal access token. Token panel reveals.
//   - `ssh`  — SSH clone (git@host:path). Key + known_hosts panel reveals.
//
// State here is read directly from the DOM at submit time
// (`collectRepoForSubmit`) — no in-memory mirror. The form is small
// enough that the env-tab's array-source-of-truth pattern would be
// overkill, and a single-shot collect avoids needing to sync after
// every keystroke.
//
// `resetRepoTab()` runs on modal close so a partially-typed PAT or
// SSH key doesn't leak into the next session create.

const repoUrl = document.getElementById("repo-url") as HTMLInputElement;
const repoRef = document.getElementById("repo-ref") as HTMLInputElement;
const repoTarget = document.getElementById("repo-target") as HTMLInputElement;
const repoDepth = document.getElementById("repo-depth") as HTMLInputElement;
const repoAuth = document.getElementById("repo-auth") as HTMLSelectElement;
const repoAuthPatPanel = document.getElementById("repo-auth-pat-panel") as HTMLDivElement;
const repoAuthPatToken = document.getElementById("repo-auth-pat-token") as HTMLInputElement;
const repoAuthSshPanel = document.getElementById("repo-auth-ssh-panel") as HTMLDivElement;
const repoAuthSshKey = document.getElementById("repo-auth-ssh-key") as HTMLTextAreaElement;
const repoAuthSshKnownHostsMode = document.getElementById(
	"repo-auth-ssh-known-hosts-mode",
) as HTMLSelectElement;
const repoAuthSshKnownHostsCustomWrap = document.getElementById(
	"repo-auth-ssh-known-hosts-custom-wrap",
) as HTMLLabelElement;
const repoAuthSshKnownHostsCustom = document.getElementById(
	"repo-auth-ssh-known-hosts-custom",
) as HTMLTextAreaElement;

/** Show/hide the auth subpanel based on the dropdown selection. */
function syncRepoAuthPanels(): void {
	const mode = repoAuth.value;
	repoAuthPatPanel.toggleAttribute("hidden", mode !== "pat");
	repoAuthSshPanel.toggleAttribute("hidden", mode !== "ssh");
}

/** Show/hide the custom-paste textarea based on the known_hosts mode. */
function syncRepoSshKnownHostsCustom(): void {
	const mode = repoAuthSshKnownHostsMode.value;
	repoAuthSshKnownHostsCustomWrap.toggleAttribute("hidden", mode !== "custom");
}

repoAuth.addEventListener("change", syncRepoAuthPanels);
repoAuthSshKnownHostsMode.addEventListener("change", syncRepoSshKnownHostsCustom);

/**
 * Wipe Repo-tab state on modal close. Critical for the credential
 * fields (PAT, SSH private key) — leaving them in the DOM after a
 * close would let the next session-create operator (or even the
 * same user reopening for a different repo) accidentally submit a
 * stale credential. Reset to the default "none" auth mode so the
 * subpanels collapse too.
 */
function resetRepoTab(): void {
	repoUrl.value = "";
	repoRef.value = "";
	repoTarget.value = "";
	repoDepth.value = "";
	repoAuth.value = "none";
	repoAuthPatToken.value = "";
	repoAuthSshKey.value = "";
	repoAuthSshKnownHostsMode.value = "default";
	repoAuthSshKnownHostsCustom.value = "";
	syncRepoAuthPanels();
	syncRepoSshKnownHostsCustom();
}

/**
 * Read the Repo tab into the wire shape the backend accepts. Returns
 * `undefined` when no URL is set — that's the "no repo configured"
 * signal the bootstrap runner reads as a no-op.
 *
 * Trims input strings; empty `ref` / `target` are omitted entirely
 * from the payload (the backend's `.optional()` fields treat omission
 * identically to `""` — "remote HEAD" and "workspace root"
 * respectively). `depth` is parsed as int if non-empty.
 *
 * The collected shape is the `{ repo, auth }` pair the backend's
 * `validateSessionConfig` cross-field check expects. We do NOT
 * pre-validate URL scheme / refname rules here — the backend's Zod
 * schema is the single source of truth; client-side mirroring would
 * just be one more place to keep in sync. The user gets a 400 with
 * a precise field path on submit.
 *
 * Exported so a future test file (jsdom + DOM seed) can pin the
 * wire shape per (auth-mode) variant without going through the
 * full main.ts side-effect chain. None ship in this PR — the
 * Env tab's equivalent (`collectEnvVarsForSubmit`) is also
 * untested and the precedent is to add tests when the form is
 * extracted into its own module.
 */
export function collectRepoForSubmit(): {
	repo: SessionConfigPayload["repo"];
	auth: SessionConfigPayload["auth"];
} {
	const url = repoUrl.value.trim();
	if (url === "") return { repo: undefined, auth: undefined };
	const ref = repoRef.value.trim();
	const target = repoTarget.value.trim();
	const depthRaw = repoDepth.value.trim();
	const depth = depthRaw === "" ? undefined : Number.parseInt(depthRaw, 10);
	const auth = repoAuth.value as "none" | "pat" | "ssh";

	const repo: NonNullable<SessionConfigPayload["repo"]> = {
		url,
		auth,
	};
	if (ref !== "") repo.ref = ref;
	if (target !== "") repo.target = target;
	if (depth !== undefined && Number.isFinite(depth)) repo.depth = depth;

	if (auth === "none") {
		return { repo, auth: undefined };
	}
	if (auth === "pat") {
		// Trim the PAT — clipboard sources (1Password, GitHub copy
		// button) often append a trailing newline. A `\n`-suffixed
		// token would pass Zod's `.min(1)` check, encrypt fine, and
		// then fail with a cryptic git-auth error at clone time
		// rather than a clean message here (PR #216 round 1 NIT).
		// SSH keys below are deliberately NOT trimmed — they have
		// load-bearing newlines.
		const token = repoAuthPatToken.value.trim();
		// Plaintext token flows into the payload — sent over HTTPS,
		// encrypted server-side at the route boundary before D1 write.
		// Empty token is allowed through here; the backend rejects it
		// in Zod's `.min(1)` check on `auth.pat` (the cross-field guard
		// only fires when `auth.pat` is `undefined`, not `""` — PR #216
		// round 2 NIT corrected the misstatement here).
		return { repo, auth: { pat: token } };
	}
	// auth === "ssh"
	const privateKey = repoAuthSshKey.value;
	const knownHostsMode = repoAuthSshKnownHostsMode.value;
	// "default" is the wire-shape sentinel the backend resolves to the
	// bundled github/gitlab/bitbucket fingerprints (see 188d's
	// knownHosts.ts). Custom mode passes the textarea content verbatim.
	const knownHosts = knownHostsMode === "custom" ? repoAuthSshKnownHostsCustom.value : "default";
	return { repo, auth: { ssh: { privateKey, knownHosts } } };
}

// ── Advanced tab (#191 / PR 191c) ───────────────────────────────────────────
//
// Four sections: Git identity, Dotfiles, Agent config seed, and the
// existing postCreate / postStart lifecycle commands. State is read
// directly from the DOM at submit time (`collectAdvancedForSubmit`)
// — same pattern as the Repo tab, no in-memory mirror needed.
//
// `resetAdvancedTab()` runs on modal close. Critical for the agent-
// seed textareas in particular: those bodies can be substantial
// (settings.json, CLAUDE.md), and leaving them mounted between
// closes risks the next session-create operator submitting stale
// content from a previous attempt.
//
// `validateAgentSeedSettings()` runs on blur of the settings.json
// textarea: client-side JSON parse → red error message inline. The
// backend's Zod refine is the source of truth (catches the same
// case with a 400), but immediate feedback is much friendlier than
// waiting for submit.

const gitIdentityName = document.getElementById("git-identity-name") as HTMLInputElement;
const gitIdentityEmail = document.getElementById("git-identity-email") as HTMLInputElement;
const dotfilesUrl = document.getElementById("dotfiles-url") as HTMLInputElement;
const dotfilesRef = document.getElementById("dotfiles-ref") as HTMLInputElement;
const dotfilesInstallScript = document.getElementById(
	"dotfiles-install-script",
) as HTMLInputElement;
const agentSeedSettings = document.getElementById("agent-seed-settings") as HTMLTextAreaElement;
const agentSeedSettingsError = document.getElementById(
	"agent-seed-settings-error",
) as HTMLSpanElement;
const agentSeedClaudeMd = document.getElementById("agent-seed-claude-md") as HTMLTextAreaElement;
const postCreateCmd = document.getElementById("post-create-cmd") as HTMLTextAreaElement;
const postStartCmd = document.getElementById("post-start-cmd") as HTMLTextAreaElement;
// Resources sub-section. CPU is in cores → translated to nano-CPUs on
// submit (Docker's HostConfig unit; matches the backend's wire shape).
// Memory is amount + GiB/MiB → translated to bytes. Idle is amount +
// minutes/hours → translated to seconds, OR omitted (undefined) for
// "Never" — the schema is `.optional()` not `.nullable()`, so sending
// `null` returns 400.
const resourcesCpuCores = document.getElementById("resources-cpu-cores") as HTMLInputElement;
const resourcesMemAmount = document.getElementById("resources-mem-amount") as HTMLInputElement;
const resourcesMemUnit = document.getElementById("resources-mem-unit") as HTMLSelectElement;
const resourcesIdleAmount = document.getElementById("resources-idle-amount") as HTMLInputElement;
const resourcesIdleUnit = document.getElementById("resources-idle-unit") as HTMLSelectElement;

/**
 * Validate `~/.claude/settings.json` content client-side. Backend's
 * Zod refine catches the same case with a precise 400, but inline
 * feedback on blur is much friendlier than a server round-trip.
 *
 * Returns true when valid (or empty — empty is "don't write the
 * file" per the schema). Sets the inline error message as a side
 * effect.
 */
function validateAgentSeedSettings(): boolean {
	const value = agentSeedSettings.value;
	if (value.trim() === "") {
		agentSeedSettingsError.textContent = "";
		return true;
	}
	try {
		JSON.parse(value);
		agentSeedSettingsError.textContent = "";
		return true;
	} catch (err) {
		agentSeedSettingsError.textContent = `Invalid JSON: ${(err as Error).message}`;
		return false;
	}
}

agentSeedSettings.addEventListener("blur", validateAgentSeedSettings);

// #200 — DOM mirror of the operator-tunable per-session caps. The
// HTML ships with the v1 defaults baked in (cpu max="8", hint says
// "0.25–8 cores, 256 MiB–16 GiB") so that a pre-#200 backend / a
// pre-checkAuthStatus paint shows the same numbers the form would
// have shown before this PR. This function rewrites those two
// surfaces (input `max`, bounds-hint text) once the API client has
// the effective caps. Called from `initAuth` after checkAuthStatus
// succeeds and from `openNewSessionModal` so an operator change
// between auth-check and modal-open still surfaces correctly on the
// next modal open. The `min` attribute is NOT changed — the floor is
// fixed at 0.25c / 256 MiB regardless of operator policy.
const resourcesBoundsHint = document.getElementById(
	"resources-bounds-hint",
) as HTMLParagraphElement;

function applyResourceCapsToForm(): void {
	const caps = getResourceCaps();
	resourcesCpuCores.max = String(caps.cpuMaxCores);
	// Memory hint: surface MiB exactly when the cap is below 1 GiB,
	// otherwise express in GiB for readability. Same dual-unit shape
	// the form's mem-unit dropdown uses.
	const memMaxStr =
		caps.memMaxMiB >= 1024 && caps.memMaxMiB % 1024 === 0
			? `${caps.memMaxMiB / 1024} GiB`
			: `${caps.memMaxMiB} MiB`;
	resourcesBoundsHint.textContent =
		`Per-session limits. Empty fields fall back to the deployment defaults ` +
		`(2 cores / 2 GiB / no auto-stop). Bounds: CPU 0.25–${caps.cpuMaxCores} cores, ` +
		`memory 256 MiB–${memMaxStr}, idle TTL 1 minute–24 hours.`;
}

/** Wipe Advanced-tab state on modal close. Important for the agent-
 *  seed textareas — leaving 256 KiB of pasted content mounted between
 *  modal closes is bad UX (and a potential leak if the next operator
 *  is a different user, though that's not the typical case here). */
function resetAdvancedTab(): void {
	gitIdentityName.value = "";
	gitIdentityEmail.value = "";
	dotfilesUrl.value = "";
	dotfilesRef.value = "";
	dotfilesInstallScript.value = "";
	agentSeedSettings.value = "";
	agentSeedClaudeMd.value = "";
	postCreateCmd.value = "";
	postStartCmd.value = "";
	agentSeedSettingsError.textContent = "";
	resourcesCpuCores.value = "";
	resourcesMemAmount.value = "";
	resourcesMemUnit.value = "GiB";
	resourcesIdleAmount.value = "";
	resourcesIdleUnit.value = "minutes";
}

/**
 * Read the Advanced tab into the wire shape the backend accepts under
 * `body.config`. Returns the four optional fields plus the two cmd
 * strings; `undefined` for any field whose inputs are empty.
 *
 * Trims trimmable values; keeps newlines in agent-seed bodies and the
 * cmd textareas (those are content, not formatting). The backend's
 * Zod schema is the single source of truth for shape validation —
 * client-side mirroring would just be one more place to keep in
 * sync. The user gets a 400 with a precise field path on submit.
 *
 * Exported so a future test file can pin the wire shape; matches the
 * `collectRepoForSubmit` precedent.
 */
export function collectAdvancedForSubmit(): {
	gitIdentity?: SessionConfigPayload["gitIdentity"];
	dotfiles?: SessionConfigPayload["dotfiles"];
	agentSeed?: SessionConfigPayload["agentSeed"];
	postCreateCmd?: string;
	postStartCmd?: string;
	cpuLimit?: number;
	memLimit?: number;
	idleTtlSeconds?: number;
} {
	const out: ReturnType<typeof collectAdvancedForSubmit> = {};

	const name = gitIdentityName.value.trim();
	const email = gitIdentityEmail.value.trim();
	if (name !== "" || email !== "") {
		// Both required when either is set; backend cross-validates.
		// We send what we have and let the 400 surface the missing
		// half — same precedent as the Repo tab's PAT/SSH cases.
		out.gitIdentity = { name, email };
	}

	const dotUrl = dotfilesUrl.value.trim();
	if (dotUrl !== "") {
		const dot: NonNullable<SessionConfigPayload["dotfiles"]> = { url: dotUrl };
		const ref = dotfilesRef.value.trim();
		const install = dotfilesInstallScript.value.trim();
		if (ref !== "") dot.ref = ref;
		if (install !== "") dot.installScript = install;
		out.dotfiles = dot;
	}

	// Trim BOTH fields before the empty check (PR #219 round 1
	// SHOULD-FIX). A whitespace-only `settings` would otherwise pass
	// the empty-check and reach the backend, where `JSON.parse("  ")`
	// throws and Zod returns a 400 with no inline-error indication.
	// Trimming JSON is safe — leading/trailing whitespace is
	// insignificant per the spec. Trimming `claudeMd` is also fine
	// here because the backend's bootstrap stage skips writing the
	// file when the value is empty after the runner's own check.
	const settings = agentSeedSettings.value.trim();
	const claudeMd = agentSeedClaudeMd.value.trim();
	if (settings !== "" || claudeMd !== "") {
		const seed: NonNullable<SessionConfigPayload["agentSeed"]> = {};
		if (settings !== "") seed.settings = settings;
		if (claudeMd !== "") seed.claudeMd = claudeMd;
		out.agentSeed = seed;
	}

	const pc = postCreateCmd.value.trim();
	const ps = postStartCmd.value.trim();
	if (pc !== "") out.postCreateCmd = pc;
	if (ps !== "") out.postStartCmd = ps;

	// Resources sub-section. Each field is optional and only emitted
	// when it parses to a finite positive number — the backend's
	// schema enforces the actual bounds (CPU 0.25–8 cores, memory
	// 256 MiB–16 GiB, idle TTL 60 s–24 h), so a value at-or-near the
	// edge gets a precise 400 with the field path. Empty / "Never" /
	// non-numeric inputs drop through and the field is omitted —
	// `.optional()` in the schema means an absent field falls back
	// to the spawn-time default.
	const cpuRaw = resourcesCpuCores.value.trim();
	if (cpuRaw !== "") {
		const cores = Number(cpuRaw);
		// `Number.isFinite` (not `isInteger`) — the spec accepts
		// fractional cores like 0.25 and 0.5; nano-CPU integer math
		// happens at the multiplication step. Backend re-validates
		// the integer result.
		if (Number.isFinite(cores) && cores > 0) {
			out.cpuLimit = Math.round(cores * 1_000_000_000);
		}
	}

	const memRaw = resourcesMemAmount.value.trim();
	if (memRaw !== "") {
		const amount = Number(memRaw);
		if (Number.isFinite(amount) && amount > 0) {
			const unitFactor = resourcesMemUnit.value === "GiB" ? 1024 ** 3 : 1024 ** 2;
			out.memLimit = Math.round(amount * unitFactor);
		}
	}

	const idleRaw = resourcesIdleAmount.value.trim();
	if (idleRaw !== "") {
		const amount = Number(idleRaw);
		if (Number.isFinite(amount) && amount > 0) {
			const unitSeconds = resourcesIdleUnit.value === "hours" ? 3600 : 60;
			out.idleTtlSeconds = Math.round(amount * unitSeconds);
		}
	}

	return out;
}

// ── Env tab (#186 / PR 186c) ────────────────────────────────────────────────
//
// State + render + wiring for the typed env-var Env tab. Each row
// holds `{ name, value, type }`; the type cell is a toggle that flips
// between plain and secret. Secret rows mask the value input
// (`type="password"`) so the value isn't shoulder-surfable; the
// underlying string still flows out via the form's submit handler.
//
// Invariant: the in-memory `envRows` is the source of truth. We
// re-render rows from the array on every mutation rather than mutating
// the DOM in place — keeps the table mirror of state simple and
// avoids drift between input values and the array.

interface EnvRow {
	id: string; // stable per-row key for the DOM (not sent to the server)
	name: string;
	value: string;
	type: "plain" | "secret";
}

let envRows: EnvRow[] = [];

const envTableBody = document.getElementById("env-table-body") as HTMLTableSectionElement;
const envAddRowBtn = document.getElementById("env-add-row") as HTMLButtonElement;
const envPasteToggle = document.getElementById("env-paste-toggle") as HTMLButtonElement;
const envPastePanel = document.getElementById("env-paste-panel") as HTMLDivElement;
const envPasteTextarea = document.getElementById("env-paste-textarea") as HTMLTextAreaElement;
const envPasteCancel = document.getElementById("env-paste-cancel") as HTMLButtonElement;
const envPasteImport = document.getElementById("env-paste-import") as HTMLButtonElement;
const envPasteStatus = document.getElementById("env-paste-status") as HTMLSpanElement;

function newEnvRowId(): string {
	// Random per-row id stays stable across re-renders so input focus
	// can be preserved (we read DOM input values BEFORE re-rendering;
	// the id is the table row's `data-row-id`).
	return `env-row-${Math.random().toString(36).slice(2, 10)}`;
}

function renderEnvRows() {
	envTableBody.textContent = "";
	for (const row of envRows) {
		const tr = document.createElement("tr");
		tr.className = "env-row";
		tr.dataset.rowId = row.id;

		const nameCell = document.createElement("td");
		const nameInput = document.createElement("input");
		nameInput.type = "text";
		nameInput.value = row.name;
		nameInput.placeholder = "FOO";
		nameInput.spellcheck = false;
		nameInput.autocapitalize = "characters";
		nameInput.className = "env-input env-input-name";
		nameInput.dataset.field = "name";
		nameCell.appendChild(nameInput);
		tr.appendChild(nameCell);

		const valueCell = document.createElement("td");
		const valueInput = document.createElement("input");
		// Secret rows mask the value visually — the user-typed string
		// still flows through `.value` on submit; password masking is
		// purely UX (shoulder-surfing defence).
		valueInput.type = row.type === "secret" ? "password" : "text";
		valueInput.value = row.value;
		valueInput.placeholder = row.type === "secret" ? "••••••••" : "value";
		valueInput.spellcheck = false;
		valueInput.autocomplete = "off";
		valueInput.className = "env-input env-input-value";
		valueInput.dataset.field = "value";
		valueCell.appendChild(valueInput);
		tr.appendChild(valueCell);

		const typeCell = document.createElement("td");
		const typeToggle = document.createElement("button");
		typeToggle.type = "button";
		typeToggle.className = `env-type-toggle env-type-${row.type}`;
		typeToggle.textContent = row.type === "secret" ? "secret" : "plain";
		typeToggle.title =
			row.type === "secret"
				? "Click to mark this entry plain (value visible)"
				: "Click to mark this entry secret (value masked + encrypted server-side)";
		typeToggle.dataset.action = "toggle-type";
		typeCell.appendChild(typeToggle);
		tr.appendChild(typeCell);

		const removeCell = document.createElement("td");
		const removeBtn = document.createElement("button");
		removeBtn.type = "button";
		removeBtn.className = "env-row-remove";
		removeBtn.textContent = "✕";
		removeBtn.title = "Remove this entry";
		removeBtn.setAttribute("aria-label", `Remove ${row.name || "entry"}`);
		removeBtn.dataset.action = "remove";
		removeCell.appendChild(removeBtn);
		tr.appendChild(removeCell);

		envTableBody.appendChild(tr);
	}
}

/**
 * Pull the latest input values out of the DOM into `envRows` before
 * any operation that re-renders. Without this, a user typing into a
 * row and then clicking Add / toggle / Delete on a different row
 * would lose their pending edit when render wipes the table.
 */
function syncEnvRowsFromDom() {
	const trs = envTableBody.querySelectorAll<HTMLTableRowElement>(".env-row");
	for (const tr of trs) {
		const id = tr.dataset.rowId ?? "";
		const row = envRows.find((r) => r.id === id);
		if (!row) continue;
		const nameInput = tr.querySelector<HTMLInputElement>('[data-field="name"]');
		const valueInput = tr.querySelector<HTMLInputElement>('[data-field="value"]');
		// Uppercase at the read site (#211 round 1). The Env-table CSS
		// applies `text-transform: uppercase` for visual consistency,
		// but DOM `.value` returns raw keystrokes — a desktop user
		// typing `foo` sees `FOO` rendered and then hits the backend's
		// `^[A-Z_][A-Z0-9_]*$` regex with the lowercase value on
		// submit. `.toUpperCase()` here keeps state aligned with the
		// rendering. `autocapitalize` already handled mobile.
		if (nameInput) row.name = nameInput.value.toUpperCase();
		if (valueInput) row.value = valueInput.value;
	}
}

function resetEnvTab() {
	envRows = [];
	renderEnvRows();
	envPastePanel.hidden = true;
	envPasteToggle.setAttribute("aria-expanded", "false");
	envPasteTextarea.value = "";
	envPasteStatus.textContent = "";
}

envAddRowBtn.addEventListener("click", () => {
	syncEnvRowsFromDom();
	envRows.push({ id: newEnvRowId(), name: "", value: "", type: "plain" });
	renderEnvRows();
	// Focus the new row's name input so the user can type immediately.
	const last =
		envTableBody.lastElementChild?.querySelector<HTMLInputElement>('[data-field="name"]');
	last?.focus();
});

envTableBody.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	const action = target.dataset.action;
	if (!action) return;
	const tr = target.closest<HTMLTableRowElement>(".env-row");
	const id = tr?.dataset.rowId ?? "";
	syncEnvRowsFromDom();
	if (action === "toggle-type") {
		const row = envRows.find((r) => r.id === id);
		if (row) row.type = row.type === "secret" ? "plain" : "secret";
		renderEnvRows();
	} else if (action === "remove") {
		envRows = envRows.filter((r) => r.id !== id);
		renderEnvRows();
	}
});

envPasteToggle.addEventListener("click", () => {
	const isOpen = !envPastePanel.hidden;
	envPastePanel.hidden = isOpen;
	envPasteToggle.setAttribute("aria-expanded", String(!isOpen));
	if (!isOpen) requestAnimationFrame(() => envPasteTextarea.focus());
});

envPasteCancel.addEventListener("click", () => {
	envPastePanel.hidden = true;
	envPasteToggle.setAttribute("aria-expanded", "false");
	envPasteTextarea.value = "";
	envPasteStatus.textContent = "";
});

envPasteImport.addEventListener("click", () => {
	syncEnvRowsFromDom();
	const result = parseDotEnv(envPasteTextarea.value);
	for (const entry of result.parsed) {
		// Spec: imported entries default to `plain`. User flips to
		// `secret` afterwards by clicking the type toggle on the row.
		envRows.push({
			id: newEnvRowId(),
			name: entry.name,
			value: entry.value,
			type: "plain",
		});
	}
	const skippedSummary = result.skipped
		.slice(0, 3) // first 3 reasons; "+N more" if longer
		.map((s) => `line ${s.line}: ${s.reason}`)
		.join("; ");
	const moreCount = result.skipped.length - 3;
	const more = moreCount > 0 ? ` (+${moreCount} more)` : "";
	envPasteStatus.textContent =
		result.skipped.length === 0
			? `Imported ${result.parsed.length} entr${result.parsed.length === 1 ? "y" : "ies"}.`
			: `Imported ${result.parsed.length}, skipped ${result.skipped.length} — ${skippedSummary}${more}`;
	envPasteTextarea.value = "";
	envPastePanel.hidden = true;
	envPasteToggle.setAttribute("aria-expanded", "false");
	renderEnvRows();
});

/**
 * Collect the in-memory `envRows` into the wire shape the backend
 * accepts under `body.config.envVars`. Drops fully-empty rows
 * (user added an entry then deleted both fields) but DOES surface
 * partially-filled rows so the backend's clear 400 covers the typo
 * cases the user is most likely to hit.
 */
function collectEnvVarsForSubmit(): EnvVarEntryInput[] | undefined {
	syncEnvRowsFromDom();
	const out: EnvVarEntryInput[] = [];
	for (const row of envRows) {
		if (row.name === "" && row.value === "") continue;
		out.push(
			row.type === "secret"
				? { name: row.name, type: "secret", value: row.value }
				: { name: row.name, type: "plain", value: row.value },
		);
	}
	return out.length > 0 ? out : undefined;
}

newSessionForm.addEventListener("submit", async (e) => {
	e.preventDefault();
	const name = newSessionInput.value.trim();
	if (!name) {
		newSessionInput.focus();
		return;
	}
	// Disable the submit button for the duration of the request so a
	// double-click doesn't fire two POSTs (which would create two
	// sessions and burn quota silently — or two PUTs in edit mode).
	newSessionSubmitBtn.disabled = true;
	clearBootstrapError();
	teardownBootstrapTail();

	// Edit-template branch (#231). Build the same SessionConfigPayload
	// the create flow would, then strip secret values and PUT to the
	// templates endpoint. The strip is the same one save-as-template
	// uses — so a template that's been edited can be `Use template`d
	// without any "stale credential leaked" surprise.
	if (editingTemplateId !== null) {
		try {
			const config = stripConfigForTemplate(buildSessionConfigPayload() ?? {});
			const description = editTemplateDescriptionInput.value.trim();
			await updateTemplate(editingTemplateId, {
				name,
				description: description.length > 0 ? description : null,
				config,
			});
			showToast(`Template "${name}" saved`);
			closeNewSessionModal();
			// Re-open the templates modal so the user lands back on the
			// list (with the freshly-saved row at the top via D1's
			// `ORDER BY updated_at DESC`). `openTemplatesModal` already
			// kicks off `refreshTemplatesList` so no separate fetch
			// is needed here.
			openTemplatesModal(resolveTemplatesOpener());
		} catch (err) {
			showToast((err as Error).message, true);
			newSessionSubmitBtn.disabled = false;
		}
		return;
	}

	try {
		showToast("Creating session…");
		const config = buildSessionConfigPayload();
		const session = await createSession(name, undefined, config);
		sessions.unshift(session);
		renderSessionList();
		if (session.bootstrapping) {
			// PR 185b2b: postCreate is running asynchronously on the
			// server. Switch the modal into live-tail mode and wait
			// for the WS terminal message before either closing
			// (success) or rendering an error panel (failure).
			startBootstrapLiveTail(session, name);
			return;
		}
		closeNewSessionModal();
		void openSession(session.sessionId);
		showToast(`Session "${name}" created`);
	} catch (err) {
		showToast((err as Error).message, true);
		newSessionSubmitBtn.disabled = false;
	}
});

/**
 * Collects the current modal state into a `SessionConfigPayload`.
 * Returns `undefined` when nothing has been configured (the bare
 * `POST /sessions` shape) so callers can omit `body.config`.
 *
 * Extracted from the submit handler so the edit-template path can
 * reuse it (#231) — without this, the edit branch would have to
 * duplicate the whole "is anything configured" check.
 */
function buildSessionConfigPayload(): SessionConfigPayload | undefined {
	const envVars = collectEnvVarsForSubmit();
	const { repo, auth } = collectRepoForSubmit();
	const advanced = collectAdvancedForSubmit();
	const { ports, allowPrivilegedPorts } = collectPortsForSubmit();
	const advancedHasContent =
		advanced.gitIdentity !== undefined ||
		advanced.dotfiles !== undefined ||
		advanced.agentSeed !== undefined ||
		advanced.postCreateCmd !== undefined ||
		advanced.postStartCmd !== undefined ||
		advanced.cpuLimit !== undefined ||
		advanced.memLimit !== undefined ||
		advanced.idleTtlSeconds !== undefined;
	const portsHasContent = ports !== undefined || allowPrivilegedPorts === true;
	if (!envVars && !repo && !advancedHasContent && !portsHasContent) return undefined;
	return {
		...(envVars ? { envVars } : {}),
		...(repo ? { repo } : {}),
		...(auth ? { auth } : {}),
		...advanced,
		...(ports ? { ports } : {}),
		...(allowPrivilegedPorts ? { allowPrivilegedPorts } : {}),
	};
}

// ── Save-as-template flow (#195 / PR 195b) ──────────────────────────────────
//
// "Save as template…" button on the create-session modal opens a tiny
// dialog (name + optional description), strips secrets from the
// current form state via `stripConfigForTemplate`, and POSTs to
// `/api/templates`. The create-session modal stays open underneath so
// the user can still create the session after saving the template, or
// dismiss both. The Templates *page* (list / use / delete) lands in
// the next sub-PR; this PR is "save only".

const saveTemplateBtn = document.getElementById("save-as-template-btn") as HTMLButtonElement;
const saveTemplateModal = document.getElementById("save-template-modal")!;
const saveTemplateForm = document.getElementById("save-template-form") as HTMLFormElement;
const saveTemplateNameInput = document.getElementById("save-template-name") as HTMLInputElement;
const saveTemplateDescriptionInput = document.getElementById(
	"save-template-description",
) as HTMLInputElement;
const saveTemplateSubmit = document.getElementById("save-template-submit") as HTMLButtonElement;

function openSaveTemplateModal() {
	saveTemplateNameInput.value = "";
	saveTemplateDescriptionInput.value = "";
	saveTemplateSubmit.disabled = false;
	saveTemplateModal.classList.add("open");
	saveTemplateModal.setAttribute("aria-hidden", "false");
	requestAnimationFrame(() => saveTemplateNameInput.focus());
}

function closeSaveTemplateModal() {
	saveTemplateModal.classList.remove("open");
	saveTemplateModal.setAttribute("aria-hidden", "true");
	// Return focus to the trigger button so keyboard users don't lose
	// their tab-order position. Same shape as `closeInvitesModal` /
	// `closePasteModal`. PR #229 round 1 NIT.
	saveTemplateBtn.focus();
}

saveTemplateBtn.addEventListener("click", () => {
	openSaveTemplateModal();
});

saveTemplateModal.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	if (target.hasAttribute("data-close-modal")) closeSaveTemplateModal();
});

/**
 * Build the same `body.config` payload `createSession` would send,
 * then strip secrets before handing it to `createTemplate`. Reuses
 * the four collectors so the template captures EXACTLY what the
 * user sees in the form — no drift between "what would I create"
 * and "what would I save".
 */
function buildTemplateConfigFromForm(): SessionConfigPayload {
	const envVars = collectEnvVarsForSubmit();
	const { repo, auth } = collectRepoForSubmit();
	const advanced = collectAdvancedForSubmit();
	const { ports, allowPrivilegedPorts } = collectPortsForSubmit();
	const config: SessionConfigPayload = {
		...(envVars ? { envVars } : {}),
		...(repo ? { repo } : {}),
		...(auth ? { auth } : {}),
		...advanced,
		...(ports ? { ports } : {}),
		...(allowPrivilegedPorts ? { allowPrivilegedPorts } : {}),
	};
	return stripConfigForTemplate(config);
}

saveTemplateForm.addEventListener("submit", async (e) => {
	e.preventDefault();
	const name = saveTemplateNameInput.value.trim();
	if (!name) {
		saveTemplateNameInput.focus();
		return;
	}
	const description = saveTemplateDescriptionInput.value.trim();
	saveTemplateSubmit.disabled = true;
	try {
		const config = buildTemplateConfigFromForm();
		await createTemplate({
			name,
			...(description !== "" ? { description } : {}),
			config,
		});
		closeSaveTemplateModal();
		showToast(`Template "${name}" saved`);
	} catch (err) {
		showToast((err as Error).message, true);
		saveTemplateSubmit.disabled = false;
	}
});

// ── Templates page (#195 / PR 195c) ─────────────────────────────────────────
//
// Sidebar entry → modal listing the user's own templates with Use /
// Delete actions. Use opens the create-session modal pre-filled with
// the template's config; secret-slot env entries collapse back to
// type:"secret" with empty values so the user has to fill them in
// before submit. Edit is deferred to a follow-up.

const sidebarTemplatesBtn = document.getElementById("sidebar-templates-btn") as HTMLButtonElement;
const templatesModal = document.getElementById("templates-modal")!;
const templatesList = document.getElementById("templates-list") as HTMLDivElement;
const templatesEmptyHint = document.getElementById("templates-empty-hint") as HTMLParagraphElement;

let templatesOpener: HTMLElement | null = null;

/**
 * Pick the Templates button that's actually rendered for the current
 * viewport — `templatesBtn` on desktop, `sidebarTemplatesBtn` on mobile.
 * `offsetParent === null` is the standard "is this element rendered"
 * test (returns null for `display:none` ancestors), and the header /
 * sidebar split is exactly the case it was designed for.
 *
 * Used by callers that open the templates modal from a third place
 * (e.g. the save-template flow re-opening templates after a save) —
 * those callers don't know which button the user clicked first, so
 * they must resolve the contextually-correct opener themselves.
 * Without this, focus restoration on close would land on a hidden
 * element and silently drop to `document.body`. See PR #257 review.
 */
function resolveTemplatesOpener(): HTMLButtonElement {
	return templatesBtn.offsetParent !== null ? templatesBtn : sidebarTemplatesBtn;
}

function openTemplatesModal(opener: HTMLElement) {
	templatesOpener = opener;
	templatesModal.classList.add("open");
	templatesModal.setAttribute("aria-hidden", "false");
	void refreshTemplatesList();
}

function closeTemplatesModal() {
	templatesModal.classList.remove("open");
	templatesModal.setAttribute("aria-hidden", "true");
	// Fall back to whichever button is rendered for the current
	// viewport if the opener is missing (legacy path or a future
	// caller that forgot to set it). The resolver covers both
	// desktop and mobile — `templatesBtn` is `display:none` on
	// mobile and would silently drop focus there otherwise.
	(templatesOpener ?? resolveTemplatesOpener()).focus();
	templatesOpener = null;
}

async function refreshTemplatesList() {
	templatesList.textContent = "";
	templatesEmptyHint.textContent = "Loading templates…";
	templatesList.appendChild(templatesEmptyHint);
	try {
		const list = await listTemplates();
		templatesList.textContent = "";
		if (list.length === 0) {
			templatesEmptyHint.textContent =
				'No templates yet. Use "Save as template…" on the new-session modal to create one.';
			templatesList.appendChild(templatesEmptyHint);
			return;
		}
		for (const t of list) {
			templatesList.appendChild(renderTemplateCard(t));
		}
	} catch (err) {
		templatesEmptyHint.textContent = `Failed to load: ${(err as Error).message}`;
		templatesList.appendChild(templatesEmptyHint);
	}
}

function renderTemplateCard(t: TemplateSummary): HTMLElement {
	const card = document.createElement("div");
	card.className = "template-card";
	card.dataset.templateId = t.id;

	const header = document.createElement("div");
	header.className = "template-card-header";
	const nameEl = document.createElement("strong");
	nameEl.textContent = t.name;
	header.appendChild(nameEl);
	card.appendChild(header);

	if (t.description) {
		const desc = document.createElement("p");
		desc.className = "template-card-description";
		desc.textContent = t.description;
		card.appendChild(desc);
	}

	const actions = document.createElement("div");
	actions.className = "template-card-actions";
	const useBtn = document.createElement("button");
	useBtn.type = "button";
	useBtn.textContent = "Use";
	useBtn.dataset.action = "use";
	const editBtn = document.createElement("button");
	editBtn.type = "button";
	editBtn.textContent = "Edit";
	editBtn.dataset.action = "edit";
	const delBtn = document.createElement("button");
	delBtn.type = "button";
	delBtn.textContent = "Delete";
	delBtn.dataset.action = "delete";
	delBtn.className = "template-card-delete";
	actions.appendChild(useBtn);
	actions.appendChild(editBtn);
	actions.appendChild(delBtn);
	card.appendChild(actions);

	return card;
}

templatesList.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	const action = target.dataset.action;
	if (action !== "use" && action !== "edit" && action !== "delete") return;
	const card = target.closest<HTMLDivElement>(".template-card");
	const id = card?.dataset.templateId;
	if (!id) return;
	if (action === "use" || action === "edit") {
		// Disable the button before the in-flight `getTemplate` so a
		// double-click can't fire two concurrent fetches that both
		// race to apply config + close-and-open modals. Mirrors the
		// `saveTemplateSubmit.disabled = true` shape on the save
		// flow. PR #230 round 2 NIT.
		const btn = target as HTMLButtonElement;
		btn.disabled = true;
		const op = action === "use" ? useTemplate(id) : editTemplate(id);
		void op.finally(() => {
			btn.disabled = false;
		});
	} else {
		void deleteTemplateConfirmed(id, card!);
	}
});

templatesModal.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	if (target.hasAttribute("data-close-modal")) closeTemplatesModal();
});

templatesBtn.addEventListener("click", () => openTemplatesModal(templatesBtn));
sidebarTemplatesBtn.addEventListener("click", () => openTemplatesModal(sidebarTemplatesBtn));

async function deleteTemplateConfirmed(id: string, card: HTMLDivElement) {
	const name = card.querySelector("strong")?.textContent ?? "this template";
	if (!confirm(`Delete template "${name}"? This cannot be undone.`)) return;
	try {
		await deleteTemplate(id);
		showToast(`Template "${name}" deleted`);
		void refreshTemplatesList();
	} catch (err) {
		showToast((err as Error).message, true);
	}
}

/**
 * Use template: closes the templates modal, opens the create-session
 * modal, and pre-fills the form from the template's config. Secret
 * values are placeholders the user fills in before submit.
 */
async function useTemplate(id: string) {
	try {
		const t = await getTemplate(id);
		closeTemplatesModal();
		openNewSessionModal(resolveTemplatesOpener());
		applyTemplateToForm(t);
		showToast(`Loaded template "${t.name}". Fill in any required secrets, then Create.`);
	} catch (err) {
		showToast((err as Error).message, true);
	}
}

/**
 * Edit template (#231): reuses the create-session modal as the editor.
 * The flow is `useTemplate`'s shape — load, close templates modal,
 * open session modal, apply config — plus a `setNewSessionModalMode`
 * call after the form is populated so the chrome reflects edit mode.
 *
 * The mode flip happens AFTER `applyTemplateToForm` because the
 * latter resets `newSessionInput.value` to the template name (which
 * is what we want as the editable name field), and the mode setter's
 * extra work (description population, button labels) needs to run
 * after the input value is in place.
 */
async function editTemplate(id: string) {
	try {
		const t = await getTemplate(id);
		closeTemplatesModal();
		openNewSessionModal(resolveTemplatesOpener());
		applyTemplateToForm(t);
		setNewSessionModalMode(t);
	} catch (err) {
		showToast((err as Error).message, true);
	}
}

/**
 * Apply a template's stored config to the create-session form's
 * in-memory state. Mirrors the collectors' field shapes in reverse —
 * so a save-then-use round-trip ends up at the same form state the
 * user originally typed (modulo stripped secrets).
 *
 * Secret-slot env entries collapse to `secret`-typed rows with empty
 * values; the user has to type each one before submit. PAT / SSH
 * "intent without credential" cases (config.repo.auth = pat/ssh with
 * no auth.pat / auth.ssh) leave the credential fields empty for the
 * user to fill in.
 */
function applyTemplateToForm(t: Template): void {
	const cfg = t.config;
	// Pre-fill the session name from the template name. The user
	// can rename before submit; sessions and templates have
	// independent name spaces (no uniqueness collision).
	newSessionInput.value = t.name;

	// Env vars — secret-slot becomes a `secret` row with empty
	// value the user must fill in. Plain rows pass through.
	envRows = (cfg.envVars ?? []).map((entry) => {
		if (entry.type === "secret-slot") {
			return { id: newEnvRowId(), name: entry.name, value: "", type: "secret" };
		}
		return {
			id: newEnvRowId(),
			name: entry.name,
			value: entry.value,
			type: entry.type,
		};
	});
	renderEnvRows();

	// Repo + auth. The credential fields stay empty if the
	// template only carried the auth declaration (the strip
	// helper drops auth.pat / auth.ssh.privateKey but keeps
	// auth.ssh.knownHosts and the repo.auth flag).
	if (cfg.repo) {
		repoUrl.value = cfg.repo.url;
		repoRef.value = cfg.repo.ref ?? "";
		repoTarget.value = cfg.repo.target ?? "";
		repoAuth.value = cfg.repo.auth;
		repoDepth.value = cfg.repo.depth ? String(cfg.repo.depth) : "";
		// Trigger the auth panel's render so PAT/SSH fields show
		// or hide per the auth selector.
		repoAuth.dispatchEvent(new Event("change"));
		repoAuthPatToken.value = cfg.auth?.pat ?? "";
		repoAuthSshKey.value = cfg.auth?.ssh?.privateKey ?? "";
		// Leave the known-hosts mode/custom selector in its default
		// state — known_hosts is a niche secondary field with its
		// own mode-selector UX, and the strip helper preserves the
		// public fingerprints anyway. Users who need a custom
		// known_hosts after applying a template re-enter via the
		// existing Repo-tab UI.
	}

	// Advanced — all the optional sub-sections.
	gitIdentityName.value = cfg.gitIdentity?.name ?? "";
	gitIdentityEmail.value = cfg.gitIdentity?.email ?? "";
	dotfilesUrl.value = cfg.dotfiles?.url ?? "";
	dotfilesRef.value = cfg.dotfiles?.ref ?? "";
	dotfilesInstallScript.value = cfg.dotfiles?.installScript ?? "";
	agentSeedSettings.value = cfg.agentSeed?.settings ?? "";
	agentSeedClaudeMd.value = cfg.agentSeed?.claudeMd ?? "";
	postCreateCmd.value = cfg.postCreateCmd ?? "";
	postStartCmd.value = cfg.postStartCmd ?? "";

	// Resources (cpu nano-CPUs → cores, mem bytes → GiB/MiB,
	// idleTtl seconds → minutes/hours). Pick the most natural
	// unit per field so the user sees the same values they would
	// have typed.
	resourcesCpuCores.value = cfg.cpuLimit ? String(cfg.cpuLimit / 1_000_000_000) : "";
	const mem = memBytesToFormUnit(cfg.memLimit);
	if (mem) {
		resourcesMemAmount.value = String(mem.amount);
		resourcesMemUnit.value = mem.unit;
	} else {
		resourcesMemAmount.value = "";
		resourcesMemUnit.value = "GiB";
	}
	const idle = idleSecondsToFormUnit(cfg.idleTtlSeconds);
	if (idle) {
		resourcesIdleAmount.value = String(idle.amount);
		resourcesIdleUnit.value = idle.unit;
	} else {
		resourcesIdleAmount.value = "";
		resourcesIdleUnit.value = "minutes";
	}

	// Ports — round-trip from the wire shape's `{container,public}`
	// back to `PortRow` shape (string container for the input).
	portRows = (cfg.ports ?? []).map((p) => ({
		id: newPortRowId(),
		container: String(p.container),
		public: p.public,
	}));
	renderPortRows();
	allowPrivilegedPortsCheckbox.checked = cfg.allowPrivilegedPorts === true;
}

// ── Ports tab (#190 / PR 190d) ──────────────────────────────────────────────
//
// Mirror of the env-tab pattern. Rows hold `{ container, public }` plus a
// stable per-row id for DOM identity across re-renders. The
// `allowPrivilegedPorts` toggle lives on the Advanced tab (granting
// CAP_NET_BIND_SERVICE is a different mental model than picking ports;
// keeps the Ports tab itself cognitively narrow). Backend rejects
// privileged ports without the toggle, so a user who tries to enter
// `80` while the toggle is off gets a 400 with a precise path
// (`config.ports.0.container`) — surfaced via the existing
// createSession error handler.

interface PortRow {
	id: string; // stable per-row key for the DOM (not sent to the server)
	container: string; // raw input value; parsed to int on submit
	public: boolean;
}

let portRows: PortRow[] = [];

const portsTableBody = document.getElementById("ports-table-body") as HTMLTableSectionElement;
const portsAddRowBtn = document.getElementById("ports-add-row") as HTMLButtonElement;
const allowPrivilegedPortsCheckbox = document.getElementById(
	"allow-privileged-ports",
) as HTMLInputElement;

function newPortRowId(): string {
	return `port-row-${Math.random().toString(36).slice(2, 10)}`;
}

function renderPortRows() {
	portsTableBody.textContent = "";
	for (const row of portRows) {
		const tr = document.createElement("tr");
		tr.className = "ports-row";
		tr.dataset.rowId = row.id;

		const containerCell = document.createElement("td");
		const containerInput = document.createElement("input");
		containerInput.type = "number";
		// Don't pin `min`/`max` on the input itself — privileged-port
		// rejection is a cross-field rule (depends on the Advanced
		// toggle), and the backend's superRefine produces the
		// authoritative error with the right path. Letting the input
		// accept the full TCP range here keeps the form usable when
		// the user enables the toggle and edits an existing row.
		containerInput.inputMode = "numeric";
		containerInput.value = row.container;
		containerInput.placeholder = "3000";
		containerInput.spellcheck = false;
		containerInput.autocomplete = "off";
		containerInput.className = "env-input";
		containerInput.dataset.field = "container";
		containerCell.appendChild(containerInput);
		tr.appendChild(containerCell);

		const publicCell = document.createElement("td");
		const publicWrap = document.createElement("label");
		publicWrap.className = "ports-public-toggle";
		const publicInput = document.createElement("input");
		publicInput.type = "checkbox";
		publicInput.checked = row.public;
		publicInput.dataset.field = "public";
		publicWrap.appendChild(publicInput);
		// Warning chip only when the row is currently `public: true` —
		// the issue spec calls this out as a deliberate UX cue so a
		// user can't tick public by accident without seeing the
		// "anyone with the URL" implication.
		if (row.public) {
			const chip = document.createElement("span");
			chip.className = "ports-public-warning";
			chip.textContent = "anyone with the URL can reach this port";
			publicWrap.appendChild(chip);
		}
		publicCell.appendChild(publicWrap);
		tr.appendChild(publicCell);

		const removeCell = document.createElement("td");
		const removeBtn = document.createElement("button");
		removeBtn.type = "button";
		removeBtn.className = "env-row-remove";
		removeBtn.textContent = "✕";
		removeBtn.title = "Remove this port";
		removeBtn.setAttribute("aria-label", `Remove port ${row.container || "(empty)"}`);
		removeBtn.dataset.action = "remove";
		removeCell.appendChild(removeBtn);
		tr.appendChild(removeCell);

		portsTableBody.appendChild(tr);
	}
}

/**
 * Pull current input values out of the DOM into `portRows` before any
 * operation that re-renders. Same shape as `syncEnvRowsFromDom`: the
 * in-memory array is the source of truth, and a partially-typed input
 * would otherwise be lost on add / remove / public-toggle.
 */
function syncPortRowsFromDom() {
	const trs = portsTableBody.querySelectorAll<HTMLTableRowElement>(".ports-row");
	for (const tr of trs) {
		const id = tr.dataset.rowId ?? "";
		const row = portRows.find((r) => r.id === id);
		if (!row) continue;
		const containerInput = tr.querySelector<HTMLInputElement>('[data-field="container"]');
		const publicInput = tr.querySelector<HTMLInputElement>('[data-field="public"]');
		if (containerInput) row.container = containerInput.value.trim();
		if (publicInput) row.public = publicInput.checked;
	}
}

function resetPortsTab() {
	portRows = [];
	renderPortRows();
	allowPrivilegedPortsCheckbox.checked = false;
}

portsAddRowBtn.addEventListener("click", () => {
	syncPortRowsFromDom();
	portRows.push({ id: newPortRowId(), container: "", public: false });
	renderPortRows();
	const last = portsTableBody.lastElementChild?.querySelector<HTMLInputElement>(
		'[data-field="container"]',
	);
	last?.focus();
});

portsTableBody.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	const action = target.dataset.action;
	if (action !== "remove") return;
	const tr = target.closest<HTMLTableRowElement>(".ports-row");
	const id = tr?.dataset.rowId ?? "";
	syncPortRowsFromDom();
	portRows = portRows.filter((r) => r.id !== id);
	renderPortRows();
});

// `change` (not `click`) so keyboard interaction with the checkbox
// (Space) also re-renders. The render swap toggles the warning chip;
// without re-render the chip wouldn't appear/disappear when public
// flips.
portsTableBody.addEventListener("change", (e) => {
	const target = e.target as HTMLElement;
	if (target.dataset.field !== "public") return;
	syncPortRowsFromDom();
	renderPortRows();
});

/**
 * Collect the in-memory `portRows` + `allowPrivilegedPorts` toggle
 * into the wire shape `SessionConfigPayload` accepts. Returns
 * `undefined` for both when the user touched neither — a bare
 * POST keeps the field absent so the backend's `.strict()` stays
 * happy and the row in `session_configs.ports_json` collapses to
 * NULL.
 *
 * Container values that don't parse to a positive integer are
 * skipped silently; the backend would reject them at validation
 * with a precise error path, but it's better UX to drop a stray
 * empty row than to surface "ports.3.container: expected number"
 * for a row the user clearly didn't fill in. Out-of-range
 * integers (negative, > 65535) are still sent — those are real
 * misconfigurations the backend's error path should surface.
 */
export function collectPortsForSubmit(): {
	ports?: SessionConfigPayload["ports"];
	allowPrivilegedPorts?: boolean;
} {
	syncPortRowsFromDom();
	const out: NonNullable<SessionConfigPayload["ports"]> = [];
	for (const row of portRows) {
		if (row.container === "") continue;
		// `Number()` + `Number.isInteger` REJECTS decimal-like input
		// instead of silently truncating it. `Number("3000.9")` is
		// `3000.9` → not an integer → row dropped, the user retypes a
		// real port. `parseInt("3000.9", 10)` would return `3000`,
		// which is exactly the truncation we want to avoid (a user
		// who typed `3000.9` clearly didn't mean port 3000).
		// `type="number"` step=1 mostly prevents this at the browser
		// layer, but pasted text or a non-strict browser can still
		// surface it. PR #224 round 2 NIT (corrects round 1, which
		// inadvertently used `parseInt` and silently truncated).
		const parsed = Number(row.container);
		if (!Number.isInteger(parsed)) continue;
		out.push({ container: parsed, public: row.public });
	}
	const result: ReturnType<typeof collectPortsForSubmit> = {};
	if (out.length > 0) result.ports = out;
	if (allowPrivilegedPortsCheckbox.checked) result.allowPrivilegedPorts = true;
	return result;
}

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
		newSessionModal.classList.contains("open") ||
		// Both templates modals (the listing page and the
		// save-as-template dialog) need the same guard or pressing
		// Escape with one of them open AND the sidebar visible
		// would close both at once. PR #230 round 1 NIT.
		templatesModal.classList.contains("open") ||
		saveTemplateModal.classList.contains("open") ||
		// adminModal joined the modal lineup in #241e; without this
		// guard, Escape with the admin dashboard open AND the
		// sidebar drawer visible would close the sidebar instead
		// of the dialog.
		adminModal.classList.contains("open") ||
		// #201e — same guard for the two new lead-side modals.
		// Without this, Escape on mobile while either is open
		// would close the sidebar drawer instead of dismissing
		// the dialog.
		myGroupsModal.classList.contains("open") ||
		observeModal.classList.contains("open") ||
		// #201e-2 — admin Group dialogs + per-session Observers
		// modal need the same guard.
		adminGroupModal.classList.contains("open") ||
		adminGroupMembersModal.classList.contains("open") ||
		observersModal.classList.contains("open")
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
	// Topmost-first: WAI-ARIA 1.2 §6.2 says Escape dismisses the
	// dialog the user is currently focused on, not the parent it
	// floats above. The save-template dialog opens ON TOP of the
	// create-session modal; without this priority, Escape would
	// close the parent and leave the save-template dialog
	// orphaned (and the parent's reset would wipe the form
	// underneath, so confirming the save would persist a stripped
	// template from default values). PR #229 round 1 SHOULD-FIX.
	if (saveTemplateModal.classList.contains("open")) {
		closeSaveTemplateModal();
	} else if (observeModal.classList.contains("open")) {
		// #201e — checked BEFORE myGroupsModal so the observe modal
		// (which opens on top of My groups when the lead clicks
		// Observe without closing the parent) dismisses first. WAI-
		// ARIA 1.2 §6.2: Escape closes the topmost dialog. The
		// owner-side My groups list survives so the lead can pick
		// another session without re-opening the parent.
		closeObserveModal();
	} else if (myGroupsModal.classList.contains("open")) {
		closeMyGroupsModal();
	} else if (adminGroupMembersModal.classList.contains("open")) {
		// #201e-2 — admin Groups dialogs open ON TOP of the parent
		// admin dashboard. Same topmost-first ordering as
		// observeModal above: members management nested-dialog →
		// create/edit nested-dialog → admin parent → other modals.
		closeAdminGroupMembersModal();
	} else if (adminGroupModal.classList.contains("open")) {
		closeAdminGroupModal();
	} else if (observersModal.classList.contains("open")) {
		// #201e-2 — Observers modal is opened from the per-session
		// toolbar, not from inside another dialog, so it slots
		// alongside the other top-level modals (admin/invites/etc).
		closeObserversModal();
	} else if (newSessionModal.classList.contains("open")) {
		closeNewSessionModal();
	} else if (templatesModal.classList.contains("open")) {
		closeTemplatesModal();
	} else if (adminModal.classList.contains("open")) {
		closeAdminModal();
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

// ── Admin dashboard (#241e) ─────────────────────────────────────────────────
//
// Visible only to is_admin=1 users via `applyAdminVisibility()`. Pulls
// `/api/admin/stats` and `/api/admin/sessions` on open + on refresh.
// No auto-polling — keeps the shared `adminStatsIp` (240/h) bucket
// available for operator-initiated refreshes and pairs naturally with
// the dashboard's "did my force-action take effect" mental model
// (refresh, see new state, act, refresh).

let adminOpener: HTMLButtonElement | null = null;

/** Symmetric with `resolveTemplatesOpener` — see that helper for the
 *  rationale. Admin is opened from a single click site per surface,
 *  so the resolver is currently only consumed by the close fallback,
 *  but keeping it parallel to Templates makes the pattern uniform if
 *  a future caller opens the admin modal from a third place. */
function resolveAdminOpener(): HTMLButtonElement {
	return adminBtn.offsetParent !== null ? adminBtn : sidebarAdminBtn;
}

function openAdminModal(opener: HTMLButtonElement) {
	adminOpener = opener;
	adminModal.classList.add("open");
	adminModal.setAttribute("aria-hidden", "false");
	adminRefreshBtn.focus();
	void refreshAdmin();
}

function closeAdminModal() {
	adminModal.classList.remove("open");
	adminModal.setAttribute("aria-hidden", "true");
	// Fall back to the viewport-rendered button if the opener is
	// missing — same rationale as closeTemplatesModal.
	(adminOpener ?? resolveAdminOpener()).focus();
	adminOpener = null;
}

adminModal.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	if (target.hasAttribute("data-close-modal")) closeAdminModal();
});

adminBtn.addEventListener("click", () => openAdminModal(adminBtn));
sidebarAdminBtn.addEventListener("click", () => openAdminModal(sidebarAdminBtn));

adminRefreshBtn.addEventListener("click", () => {
	void refreshAdmin();
});

async function refreshAdmin(): Promise<void> {
	// Fetch all four endpoints in parallel — independent reads gated
	// by the same admin token. Sequential awaits would multiply the
	// dashboard latency without any safety upside. `Promise.allSettled`
	// rather than `all` so a transient on one endpoint doesn't wipe
	// the other three panels — each section renders or shows its own
	// per-section error.
	adminRefreshBtn.disabled = true;
	try {
		const [statsR, sessionsR, groupsR, observeLogR] = await Promise.allSettled([
			fetchAdminStats(),
			fetchAdminSessions(),
			fetchAdminGroups(),
			fetchAdminObserveLog(),
		]);
		if (statsR.status === "fulfilled") renderAdminStats(statsR.value);
		else showToast(`Stats: ${statsR.reason.message}`, true);
		if (sessionsR.status === "fulfilled") renderAdminSessions(sessionsR.value);
		else showToast(`Sessions: ${sessionsR.reason.message}`, true);
		if (groupsR.status === "fulfilled") renderAdminGroups(groupsR.value);
		else showToast(`Groups: ${groupsR.reason.message}`, true);
		if (observeLogR.status === "fulfilled") renderAdminObserveLog(observeLogR.value);
		else showToast(`Observe log: ${observeLogR.reason.message}`, true);
	} finally {
		adminRefreshBtn.disabled = false;
	}
}

function formatRelativeTime(ts: number | null): string {
	if (ts === null) return "never";
	const ageSec = Math.round((Date.now() - ts) / 1000);
	if (ageSec < 60) return `${ageSec}s ago`;
	if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`;
	return `${Math.round(ageSec / 3600)}h ago`;
}

function formatUptime(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
	return `${Math.round(seconds / 86_400)}d`;
}

function renderAdminStats(stats: AdminStats): void {
	adminUptimeEl.textContent = `Uptime ${formatUptime(stats.uptimeSeconds)} · booted ${new Date(stats.bootedAt).toLocaleString()}`;
	adminStatsEl.textContent = "";

	const panel = (title: string, rows: Array<[string, string]>) => {
		const card = document.createElement("div");
		card.className = "admin-stat-card";
		const h = document.createElement("h4");
		h.textContent = title;
		card.appendChild(h);
		for (const [k, v] of rows) {
			const row = document.createElement("div");
			row.className = "admin-stat-row";
			const ks = document.createElement("span");
			ks.className = "admin-stat-key";
			ks.textContent = k;
			const vs = document.createElement("span");
			vs.className = "admin-stat-value";
			vs.textContent = v;
			row.appendChild(ks);
			row.appendChild(vs);
			card.appendChild(row);
		}
		adminStatsEl.appendChild(card);
	};

	const s = stats.sessions.byStatus;
	panel("Sessions", [
		["Running", String(s.running)],
		["Stopped", String(s.stopped)],
		["Terminated", String(s.terminated)],
		["Failed", String(s.failed)],
	]);

	const sw = stats.idleSweeper;
	panel("Idle sweeper", [
		["Last sweep", formatRelativeTime(sw?.lastSweepAt ?? null)],
		["Reaped since boot", String(sw?.sweptSinceBoot ?? 0)],
		["Tracked sessions", String(sw?.currentMapSize ?? 0)],
	]);

	const r = stats.reconcile;
	panel("Reconcile", [
		["Last run", formatRelativeTime(r.lastRunAt)],
		["Sessions checked", String(r.sessionsCheckedSinceBoot)],
		["Errors", String(r.errorsSinceBoot)],
	]);

	const d = stats.dispatcher;
	panel("Dispatcher", [
		["Requests", String(d.requestsSinceBoot)],
		["2xx", String(d.responses2xxSinceBoot)],
		["3xx", String(d.responses3xxSinceBoot)],
		["4xx", String(d.responses4xxSinceBoot)],
		["5xx", String(d.responses5xxSinceBoot)],
	]);

	panel("D1", [["Calls since boot", String(stats.d1.callsSinceBoot)]]);
}

function renderAdminSessions(sessions: AdminSession[]): void {
	adminSessionsListEl.textContent = "";
	if (sessions.length === 0) {
		const empty = document.createElement("p");
		empty.className = "modal-hint";
		empty.textContent = "No sessions.";
		adminSessionsListEl.appendChild(empty);
		return;
	}
	for (const s of sessions) {
		const row = document.createElement("div");
		row.className = "admin-session-row";

		const meta = document.createElement("div");
		meta.className = "admin-session-meta";
		const name = document.createElement("strong");
		name.textContent = s.name;
		const sub = document.createElement("span");
		sub.className = "admin-session-sub";
		sub.textContent = `${s.ownerUsername} · ${s.status} · ${new Date(s.createdAt).toLocaleString()}`;
		meta.appendChild(name);
		meta.appendChild(sub);

		const actions = document.createElement("div");
		actions.className = "admin-session-actions";

		// Force-stop only enabled for running sessions — the backend
		// returns 204 on a no-op stop, but the button label would be
		// misleading on a stopped/terminated session.
		const stopBtn = document.createElement("button");
		stopBtn.type = "button";
		stopBtn.textContent = "Stop";
		stopBtn.disabled = s.status !== "running";
		stopBtn.addEventListener("click", () =>
			confirmAndAct(`Force-stop "${s.name}" (${s.ownerUsername})?`, stopBtn, async () => {
				await adminForceStop(s.sessionId);
				showToast(`Stopped ${s.name}`);
			}),
		);

		const deleteBtn = document.createElement("button");
		deleteBtn.type = "button";
		deleteBtn.textContent = "Delete";
		deleteBtn.className = "admin-session-delete";
		deleteBtn.addEventListener("click", () =>
			confirmAndAct(
				`Soft-delete "${s.name}" (${s.ownerUsername})?\n\nContainer will be stopped and the row terminated; workspace is preserved.`,
				deleteBtn,
				async () => {
					await adminForceDelete(s.sessionId, false);
					showToast(`Soft-deleted ${s.name}`);
				},
			),
		);

		const hardBtn = document.createElement("button");
		hardBtn.type = "button";
		hardBtn.textContent = "Hard-delete";
		hardBtn.className = "admin-session-delete";
		hardBtn.addEventListener("click", () =>
			confirmAndAct(
				`HARD-DELETE "${s.name}" (${s.ownerUsername})?\n\nThis purges the workspace directory AND drops the D1 row. Unrecoverable.`,
				hardBtn,
				async () => {
					await adminForceDelete(s.sessionId, true);
					showToast(`Hard-deleted ${s.name}`);
				},
			),
		);

		actions.appendChild(stopBtn);
		actions.appendChild(deleteBtn);
		actions.appendChild(hardBtn);
		row.appendChild(meta);
		row.appendChild(actions);
		adminSessionsListEl.appendChild(row);
	}
}

/** Confirm + run an admin action. Disables the trigger button across
 *  the in-flight window so a double-click can't fire two destructive
 *  requests; refreshes the dashboard on success so the row reflects
 *  the new state without the operator clicking Refresh. */
async function confirmAndAct(
	prompt: string,
	btn: HTMLButtonElement,
	action: () => Promise<void>,
): Promise<void> {
	if (!confirm(prompt)) return;
	btn.disabled = true;
	try {
		await action();
		await refreshAdmin();
	} catch (err) {
		showToast((err as Error).message, true);
	} finally {
		// `refreshAdmin` swallows its own errors and toasts, so this
		// `catch` only fires on `action()` itself throwing. If the
		// action succeeded but refresh failed AFTER, the DOM hasn't
		// been rebuilt and the original `btn` is still mounted —
		// re-enable it unconditionally here so the operator isn't
		// stuck with a permanently-disabled button until the next
		// manual Refresh. (When refresh DID rebuild the rows, this
		// runs on an orphaned button object — a harmless no-op.)
		btn.disabled = false;
	}
}

// ── Admin Groups CRUD (#201e-2) ────────────────────────────────────────────
//
// New section in the admin dashboard. List + create + edit + delete
// + add/remove members. Backend routes are gated by `requireAdmin`;
// these handlers run only inside the admin modal which is itself
// admin-gated. The create/edit dialog (`adminGroupModal`) and the
// members-management dialog (`adminGroupMembersModal`) open ON TOP
// of the admin dashboard — same nested-dialog pattern the
// save-template dialog uses on top of the new-session modal.

let editingGroupId: string | null = null;
let membersGroupId: string | null = null;

function renderAdminGroups(groups: AdminGroupSummary[]): void {
	adminGroupsListEl.textContent = "";
	if (groups.length === 0) {
		const empty = document.createElement("p");
		empty.className = "modal-hint";
		empty.textContent = "No groups yet — create one with + New group.";
		adminGroupsListEl.appendChild(empty);
		return;
	}
	for (const g of groups) {
		const row = document.createElement("div");
		row.className = "admin-session-row";

		const meta = document.createElement("div");
		meta.className = "admin-session-meta";
		const name = document.createElement("strong");
		name.textContent = g.description ? `${g.name} — ${g.description}` : g.name;
		const sub = document.createElement("span");
		sub.className = "admin-session-sub";
		sub.textContent = `lead: ${g.leadUsername} · ${g.memberCount} member${g.memberCount === 1 ? "" : "s"}`;
		meta.appendChild(name);
		meta.appendChild(sub);

		const actions = document.createElement("div");
		actions.className = "admin-session-actions";

		const editBtn = document.createElement("button");
		editBtn.type = "button";
		editBtn.textContent = "Edit";
		editBtn.addEventListener("click", () => {
			void openAdminGroupModalForEdit(g);
		});

		const membersBtn = document.createElement("button");
		membersBtn.type = "button";
		membersBtn.textContent = "Members";
		membersBtn.addEventListener("click", () => {
			void openAdminGroupMembersModal(g);
		});

		const deleteBtn = document.createElement("button");
		deleteBtn.type = "button";
		deleteBtn.textContent = "Delete";
		deleteBtn.className = "admin-session-delete";
		deleteBtn.addEventListener("click", () =>
			confirmAndAct(
				`Delete group "${g.name}"?\n\nMembership rows cascade automatically. The lead user is NOT deleted.`,
				deleteBtn,
				async () => {
					await deleteAdminGroup(g.id);
					showToast(`Deleted ${g.name}`);
				},
			),
		);

		actions.appendChild(editBtn);
		actions.appendChild(membersBtn);
		actions.appendChild(deleteBtn);
		row.appendChild(meta);
		row.appendChild(actions);
		adminGroupsListEl.appendChild(row);
	}
}

function openAdminGroupModalForCreate(): void {
	editingGroupId = null;
	adminGroupModalTitle.textContent = "New group";
	adminGroupNameInput.value = "";
	adminGroupDescriptionInput.value = "";
	adminGroupLeadUserIdInput.value = "";
	adminGroupSubmitBtn.textContent = "Create";
	adminGroupModal.classList.add("open");
	adminGroupModal.setAttribute("aria-hidden", "false");
	adminGroupNameInput.focus();
}

function openAdminGroupModalForEdit(g: AdminGroupSummary): void {
	editingGroupId = g.id;
	adminGroupModalTitle.textContent = `Edit group "${g.name}"`;
	adminGroupNameInput.value = g.name;
	adminGroupDescriptionInput.value = g.description ?? "";
	adminGroupLeadUserIdInput.value = g.leadUserId;
	adminGroupSubmitBtn.textContent = "Save";
	adminGroupModal.classList.add("open");
	adminGroupModal.setAttribute("aria-hidden", "false");
	adminGroupNameInput.focus();
}

function closeAdminGroupModal(): void {
	adminGroupModal.classList.remove("open");
	adminGroupModal.setAttribute("aria-hidden", "true");
	editingGroupId = null;
}

adminGroupModal.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	if (target.hasAttribute("data-close-modal")) closeAdminGroupModal();
});

adminGroupCreateBtn.addEventListener("click", () => openAdminGroupModalForCreate());

adminGroupForm.addEventListener("submit", async (e) => {
	e.preventDefault();
	const name = adminGroupNameInput.value.trim();
	const description = adminGroupDescriptionInput.value.trim() || null;
	const leadUserId = adminGroupLeadUserIdInput.value.trim();
	if (!name) {
		showToast("Name is required", true);
		return;
	}
	if (!leadUserId) {
		showToast("Lead user id is required", true);
		return;
	}
	adminGroupSubmitBtn.disabled = true;
	try {
		if (editingGroupId === null) {
			await createAdminGroup({ name, description, leadUserId });
			showToast(`Created group "${name}"`);
		} else {
			await updateAdminGroup(editingGroupId, { name, description, leadUserId });
			showToast(`Saved group "${name}"`);
		}
		closeAdminGroupModal();
		await refreshAdmin();
	} catch (err) {
		showToast((err as Error).message, true);
	} finally {
		adminGroupSubmitBtn.disabled = false;
	}
});

async function openAdminGroupMembersModal(g: AdminGroupSummary): Promise<void> {
	membersGroupId = g.id;
	adminGroupMembersModalTitle.textContent = `Members of "${g.name}"`;
	adminGroupMembersModalHint.textContent = `Lead is "${g.leadUsername}" — cannot be removed (reassign via Edit first).`;
	adminGroupAddMemberInput.value = "";
	adminGroupMembersListEl.textContent = "";
	const loading = document.createElement("p");
	loading.className = "modal-hint";
	loading.textContent = "Loading members…";
	adminGroupMembersListEl.appendChild(loading);
	adminGroupMembersModal.classList.add("open");
	adminGroupMembersModal.setAttribute("aria-hidden", "false");
	adminGroupAddMemberInput.focus();
	await refreshAdminGroupMembers(g.id, g.leadUserId);
}

function closeAdminGroupMembersModal(): void {
	adminGroupMembersModal.classList.remove("open");
	adminGroupMembersModal.setAttribute("aria-hidden", "true");
	membersGroupId = null;
}

adminGroupMembersModal.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	if (target.hasAttribute("data-close-modal")) closeAdminGroupMembersModal();
});

async function refreshAdminGroupMembers(groupId: string, leadUserId: string): Promise<void> {
	let detail: AdminGroupDetail;
	try {
		detail = await fetchAdminGroup(groupId);
	} catch (err) {
		showToast((err as Error).message, true);
		return;
	}
	adminGroupMembersListEl.textContent = "";
	if (detail.members.length === 0) {
		const empty = document.createElement("p");
		empty.className = "modal-hint";
		empty.textContent = "No members.";
		adminGroupMembersListEl.appendChild(empty);
		return;
	}
	for (const m of detail.members) {
		const row = document.createElement("div");
		row.className = "admin-session-row";
		const meta = document.createElement("div");
		meta.className = "admin-session-meta";
		const name = document.createElement("strong");
		name.textContent = m.username;
		meta.appendChild(name);
		const sub = document.createElement("span");
		sub.className = "admin-session-sub";
		sub.textContent =
			m.userId === leadUserId
				? `lead · added ${new Date(m.addedAt).toLocaleString()}`
				: `added ${new Date(m.addedAt).toLocaleString()}`;
		meta.appendChild(sub);
		row.appendChild(meta);

		const actions = document.createElement("div");
		actions.className = "admin-session-actions";
		const removeBtn = document.createElement("button");
		removeBtn.type = "button";
		removeBtn.textContent = "Remove";
		removeBtn.className = "admin-session-delete";
		// Lead can't be removed without reassignment — disable the
		// button rather than letting the click 409 from the backend.
		// Same shape as `Stop` being disabled on a non-running session.
		removeBtn.disabled = m.userId === leadUserId;
		removeBtn.addEventListener("click", async () => {
			if (!confirm(`Remove ${m.username} from this group?`)) return;
			removeBtn.disabled = true;
			try {
				await removeAdminGroupMember(groupId, m.userId);
				showToast(`Removed ${m.username}`);
				await refreshAdminGroupMembers(groupId, leadUserId);
				await refreshAdmin();
			} catch (err) {
				showToast((err as Error).message, true);
				removeBtn.disabled = false;
			}
		});
		actions.appendChild(removeBtn);
		row.appendChild(actions);
		adminGroupMembersListEl.appendChild(row);
	}
}

adminGroupAddMemberForm.addEventListener("submit", async (e) => {
	e.preventDefault();
	const userId = adminGroupAddMemberInput.value.trim();
	if (!userId) {
		showToast("User id is required", true);
		return;
	}
	if (membersGroupId === null) return;
	const groupId = membersGroupId;
	// Disable the submit button across the in-flight window so a
	// double-click or fast second Enter doesn't fire a duplicate
	// POST. The backend's composite PK on (group_id, user_id) would
	// 409 the second call (caught + toasted), but keeping the noise
	// out is cheaper than handling it. Same shape as
	// `adminGroupSubmitBtn.disabled` on the create/edit handler.
	const submitBtn =
		adminGroupAddMemberForm.querySelector<HTMLButtonElement>("button[type='submit']");
	if (submitBtn) submitBtn.disabled = true;
	try {
		await addAdminGroupMember(groupId, userId);
		showToast("Member added");
		adminGroupAddMemberInput.value = "";
		// Refresh the members list — re-fetch the current group's
		// detail to render the new row, and refresh the parent admin
		// dashboard so the member-count chip on the row updates.
		// `editingGroupId` is for the create/edit modal; this path
		// keeps `membersGroupId` intact so subsequent operations on
		// the same dialog still target the right group.
		const meta = await fetchAdminGroup(groupId);
		await refreshAdminGroupMembers(groupId, meta.leadUserId);
		await refreshAdmin();
	} catch (err) {
		showToast((err as Error).message, true);
	} finally {
		if (submitBtn) submitBtn.disabled = false;
	}
});

// ── Admin observe-log (#201e-2) ────────────────────────────────────────────

function renderAdminObserveLog(entries: AdminObserveLogEntry[]): void {
	adminObserveLogEl.textContent = "";
	if (entries.length === 0) {
		const empty = document.createElement("p");
		empty.className = "modal-hint";
		empty.textContent = "No observe events yet.";
		adminObserveLogEl.appendChild(empty);
		return;
	}
	for (const e of entries) {
		const row = document.createElement("div");
		row.className = "admin-session-row";
		const meta = document.createElement("div");
		meta.className = "admin-session-meta";
		const name = document.createElement("strong");
		name.textContent = `${e.observerUsername} → ${e.ownerUsername}`;
		const sub = document.createElement("span");
		sub.className = "admin-session-sub";
		const started = new Date(e.startedAt).toLocaleString();
		const ended = e.endedAt ? new Date(e.endedAt).toLocaleString() : "still watching";
		sub.textContent = `session ${e.sessionId.slice(0, 8)}… · ${started} → ${ended}`;
		meta.appendChild(name);
		meta.appendChild(sub);
		row.appendChild(meta);
		adminObserveLogEl.appendChild(row);
	}
}

// ── Per-session Observers button (#201e-2) ─────────────────────────────────
// Surfaces the per-session observe history. Owner / admin / lead-of-
// group-containing-owner can read; the backend `assertCanObserve`
// gate handles auth and surfaces the right 403/404 to the toast on
// fail. The button is shown for every authenticated user — gating it
// on isLead/isAdmin would hide it from owners, who are the primary
// audience ("who has been watching me?"). A non-authorised viewer
// just sees a toast.

function openObserversModal(): void {
	if (!activeSessionId) return;
	const sessionId = activeSessionId;
	observersModalListEl.textContent = "";
	const loading = document.createElement("p");
	loading.className = "modal-hint";
	loading.textContent = "Loading…";
	observersModalListEl.appendChild(loading);
	observersModal.classList.add("open");
	observersModal.setAttribute("aria-hidden", "false");
	void refreshObserversModal(sessionId);
}

function closeObserversModal(): void {
	observersModal.classList.remove("open");
	observersModal.setAttribute("aria-hidden", "true");
}

async function refreshObserversModal(sessionId: string): Promise<void> {
	let entries: ObserveLogEntry[];
	try {
		entries = await fetchSessionObserveLog(sessionId);
	} catch (err) {
		showToast((err as Error).message, true);
		closeObserversModal();
		return;
	}
	observersModalListEl.textContent = "";
	if (entries.length === 0) {
		const empty = document.createElement("p");
		empty.className = "modal-hint";
		empty.textContent = "No observers yet.";
		observersModalListEl.appendChild(empty);
		return;
	}
	for (const e of entries) {
		const row = document.createElement("div");
		row.className = "admin-session-row";
		const meta = document.createElement("div");
		meta.className = "admin-session-meta";
		const name = document.createElement("strong");
		name.textContent = e.observerUsername;
		const sub = document.createElement("span");
		sub.className = "admin-session-sub";
		const started = new Date(e.startedAt).toLocaleString();
		const ended = e.endedAt ? new Date(e.endedAt).toLocaleString() : "still watching";
		sub.textContent = `${started} → ${ended}`;
		meta.appendChild(name);
		meta.appendChild(sub);
		row.appendChild(meta);
		observersModalListEl.appendChild(row);
	}
}

observersModal.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	if (target.hasAttribute("data-close-modal")) closeObserversModal();
});

observersBtn.addEventListener("click", () => openObserversModal());

// ── My groups (#201e — lead-side observe surface) ──────────────────────────
//
// Visible only to users who lead at least one group via
// `applyAdminVisibility()` (which also gates the lead button). Pulls
// `/api/groups/mine` + `/api/groups/mine/sessions` on open + refresh —
// no auto-polling, same rationale as the admin dashboard. The
// observe modal opens read-only via `openTerminalSession({observe:
// true})`; closing the modal disposes the WS attach and triggers the
// server-side `recordObserveEnd()` UPDATE.

let myGroupsOpener: HTMLButtonElement | null = null;
// At most one observe-mode terminal at a time. Opening a second
// observe (via clicking another row's Observe before closing the
// current modal) tears down the prior one — same shape as the
// existing single-terminal-per-modal pattern (paste, file-attach).
let activeObserveTerm: TerminalSession | null = null;

function resolveMyGroupsOpener(): HTMLButtonElement {
	return myGroupsBtn.offsetParent !== null ? myGroupsBtn : sidebarMyGroupsBtn;
}

function openMyGroupsModal(opener: HTMLButtonElement) {
	myGroupsOpener = opener;
	myGroupsModal.classList.add("open");
	myGroupsModal.setAttribute("aria-hidden", "false");
	myGroupsRefreshBtn.focus();
	void refreshMyGroups();
}

function closeMyGroupsModal() {
	// Tear down any active observe attach before dismissing the
	// parent modal (#201e review round 4 SHOULD-FIX). The observe
	// modal opens on top of My groups without closing it; if the
	// lead backdrop-clicks the My groups modal while observe is
	// still visible, the parent dismisses but the observe WS
	// keeps running with no UI affordance to close it. The
	// audit row's `ended_at` would only land when the backend
	// heartbeat eventually killed the socket — a gap the
	// audit-trail invariant explicitly forbids. closeObserveModal
	// is idempotent when no observe is active, same shape as the
	// `handleLogout` call site.
	closeObserveModal();
	myGroupsModal.classList.remove("open");
	myGroupsModal.setAttribute("aria-hidden", "true");
	(myGroupsOpener ?? resolveMyGroupsOpener()).focus();
	myGroupsOpener = null;
}

myGroupsModal.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	if (target.hasAttribute("data-close-modal")) closeMyGroupsModal();
});

myGroupsBtn.addEventListener("click", () => openMyGroupsModal(myGroupsBtn));
sidebarMyGroupsBtn.addEventListener("click", () => openMyGroupsModal(sidebarMyGroupsBtn));

myGroupsRefreshBtn.addEventListener("click", () => {
	void refreshMyGroups();
});

async function refreshMyGroups(): Promise<void> {
	myGroupsRefreshBtn.disabled = true;
	try {
		// Fetch both endpoints in parallel — independent reads, both
		// requireAuth-only. Sequentially awaiting would double the
		// modal latency without a safety upside (same shape as
		// `refreshAdmin`).
		const [groups, observableSessions] = await Promise.all([
			fetchMyGroups(),
			fetchMyObservableSessions(),
		]);
		renderMyGroups(groups, observableSessions);
	} catch (err) {
		showToast((err as Error).message, true);
	} finally {
		myGroupsRefreshBtn.disabled = false;
	}
}

function renderMyGroups(groups: LeadGroup[], sessions: ObservableSession[]): void {
	myGroupsListEl.textContent = "";
	if (groups.length === 0) {
		const empty = document.createElement("p");
		empty.className = "modal-hint";
		empty.textContent = "You don't lead any groups yet.";
		myGroupsListEl.appendChild(empty);
		return;
	}
	// Bucket sessions by ownerUserId so each member-row can render its
	// owner's running sessions inline. The cross-user list is already
	// scoped to "members of any group I lead" by the SQL, so a single
	// pass covers every group below.
	const sessionsByOwner = new Map<string, ObservableSession[]>();
	for (const s of sessions) {
		const bucket = sessionsByOwner.get(s.ownerUserId);
		if (bucket) bucket.push(s);
		else sessionsByOwner.set(s.ownerUserId, [s]);
	}
	for (const g of groups) {
		const card = document.createElement("section");
		card.className = "admin-stat-card";
		const h = document.createElement("h4");
		h.textContent = g.description ? `${g.name} — ${g.description}` : g.name;
		card.appendChild(h);
		if (g.members.length === 0) {
			const empty = document.createElement("p");
			empty.className = "modal-hint";
			empty.textContent = "No members yet.";
			card.appendChild(empty);
			myGroupsListEl.appendChild(card);
			continue;
		}
		for (const m of g.members) {
			const memberRow = document.createElement("div");
			memberRow.className = "admin-session-row";
			const meta = document.createElement("div");
			meta.className = "admin-session-meta";
			const name = document.createElement("strong");
			name.textContent = m.username;
			meta.appendChild(name);
			const memberSessions = sessionsByOwner.get(m.userId) ?? [];
			const sub = document.createElement("span");
			sub.className = "admin-session-sub";
			sub.textContent =
				memberSessions.length === 0
					? "no active sessions"
					: `${memberSessions.length} session${memberSessions.length === 1 ? "" : "s"}`;
			meta.appendChild(sub);
			memberRow.appendChild(meta);

			// Observe buttons — one per running session. Stopped/failed
			// sessions surface in the count above but don't get an
			// Observe button: the WS attach would 1008-close because
			// `wsHandler` rejects non-running statuses, and a button
			// that always errors is worse UX than no button.
			const actions = document.createElement("div");
			actions.className = "admin-session-actions";
			for (const s of memberSessions) {
				if (s.status !== "running") continue;
				const btn = document.createElement("button");
				btn.type = "button";
				btn.textContent = `Observe "${s.name}"`;
				btn.addEventListener("click", () => {
					// openObserveModal is async (it fetches the tab list
					// before opening the WS). Fire-and-forget — it
					// surfaces its own errors via showToast, so there's
					// no caller-side rejection to handle.
					void openObserveModal(s);
				});
				actions.appendChild(btn);
			}
			memberRow.appendChild(actions);
			card.appendChild(memberRow);
		}
		myGroupsListEl.appendChild(card);
	}
}

async function openObserveModal(s: ObservableSession): Promise<void> {
	// Tear down any prior observe attach before opening a new one —
	// keeps the audit log honest (each Observe click maps to one
	// open + one close UPDATE) and avoids stacking xterm DOM nodes
	// in the modal host.
	closeObserveModal();
	// Fetch the session's tab list FIRST. The WS handler hard-rejects
	// any attach without a `?tab=...` query (returns 1008 "Missing
	// tab"), so we must pick a real tab id before opening the socket
	// — the backend has no implicit "default tab." A first slice
	// initially tried to pass no tabId and let the server "default to
	// main"; the WS close fired immediately every time. Pinning the
	// tab here is what makes observe-mode actually work end-to-end.
	//
	// `listTabs` was relaxed to `assertCanObserve` in the same review
	// fix, so a lead can read the tab list of a session they don't
	// own. Tab CREATE / DELETE stays owner-only.
	let tabs: Tab[];
	try {
		tabs = await listTabs(s.sessionId);
	} catch (err) {
		showToast(`Couldn't load tabs for "${s.name}": ${(err as Error).message}`, true);
		return;
	}
	if (tabs.length === 0) {
		// The session has no open tmux tabs — no surface to observe.
		// Owner needs to create one from their UI before the lead can
		// attach. Surface a clear toast rather than opening an empty
		// modal that would just disconnect immediately.
		showToast(`"${s.name}" has no open tabs to observe`, true);
		return;
	}
	// v1 picks the first tab — a session typically has one. A future
	// slice can add a tab picker if multi-tab observability becomes a
	// common need; for now, surfacing a count in the modal hint keeps
	// the lead aware the session may have more.
	const tab = tabs[0]!;
	observeModalTitle.textContent = `Observing "${s.name}" (${s.ownerUsername})`;
	observeModalHint.textContent =
		tabs.length === 1
			? `Read-only view of "${tab.label ?? tab.tabId}". Input is disabled — every observe-attach is logged.`
			: `Read-only view of "${tab.label ?? tab.tabId}" (1 of ${tabs.length} tabs — first shown). Input is disabled — every observe-attach is logged.`;
	observeModal.classList.add("open");
	observeModal.setAttribute("aria-hidden", "false");
	observeTerminalHost.textContent = "";
	const term = openTerminalSession({
		container: observeTerminalHost,
		sessionId: s.sessionId,
		tabId: tab.tabId,
		fontSize: currentFontSize,
		observe: true,
		onStatus: (status) => {
			// A status flip to "disconnected" means the underlying
			// session terminated or the owner stopped it. The audit
			// log row's `ended_at` is set by ws.on("close") on the
			// server. Surface a toast so the lead knows why their
			// view went dark.
			if (status === "disconnected") {
				showToast(`Observe attach to "${s.name}" disconnected`);
			}
		},
		onError: (msg) => showToast(`Observe error: ${msg}`, true),
	});
	activeObserveTerm = term;
}

function closeObserveModal(): void {
	if (activeObserveTerm) {
		// dispose() closes the WS — the server's ws.on("close") then
		// fires `recordObserveEnd()` which UPDATEs ended_at. The
		// idempotency guard (WHERE ended_at IS NULL) makes this safe
		// even if a duplicate close path also runs.
		activeObserveTerm.dispose();
		activeObserveTerm = null;
	}
	observeTerminalHost.textContent = "";
	observeModal.classList.remove("open");
	observeModal.setAttribute("aria-hidden", "true");
}

observeModal.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;
	if (target.hasAttribute("data-close-modal")) closeObserveModal();
});

// ── Auto-refresh ────────────────────────────────────────────────────────────

setInterval(() => {
	if (isLoggedIn()) refreshSessions();
}, 15_000);

// ── Init ────────────────────────────────────────────────────────────────────

updateAuthUI();
initAuth();
