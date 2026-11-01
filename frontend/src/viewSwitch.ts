/**
 * viewSwitch.ts — the per-session view selector: Terminal ⇄ Files ⇄ Git ⇄ Chat.
 *
 * Owns the one piece of state the overlays share (which view is up) and
 * the mechanics that must be identical for every overlay:
 *
 * TERMINAL INVARIANT: switching views must not disconnect, resize or
 * dispose the terminal. Files and Git are absolutely-positioned OVERLAYS
 * inside #terminal-area, stacked over the tab bar, the xterm panes and
 * the mobile key bar — those keep their exact layout box underneath, so
 * no ResizeObserver fires, xterm never refits, and no `resize` reaches
 * tmux (which would reflow the pane for every other viewer). Hiding the
 * terminal with display:none would zero its box and trip all of that.
 *
 * While an overlay is up the covered subtrees are `inert` (out of focus,
 * input and the accessibility tree WITHOUT touching layout), and the
 * terminal-only toolbar controls are disabled.
 *
 * The overlays' top edge tracks the toolbar's bottom (ResizeObserver on
 * the toolbar): its height varies — it wraps on narrow screens and is
 * hidden entirely on mobile while the chrome drawer is collapsed.
 *
 * Each overlay module (filesView.ts, gitView.ts, chatView.ts) registers listeners
 * here; this module imports neither, so it can't form a cycle with them.
 */

import {
	activeSessionId,
	currentTerminals,
	getActiveTerminal,
	isMobile,
	sessions,
	setChromeOpen,
	updateChromeToggle,
} from "./main.js";
import { navigate } from "./router.js";

export type View = "terminal" | "files" | "git" | "chat";

// ── Route ───────────────────────────────────────────────────────────────────
//
// The address bar mirrors (session, view, detail) — router.ts. Each view
// registers what its "detail" is (the open file, diff, conversation or
// tab) and how to show one; this module writes the route whenever the
// view or a detail changes, and applies a route the browser hands back.

export interface RouteDetailHandler {
	/** The detail on screen, or null. */
	current(): string | null;
	/** Show `detail` (null = nothing selected; on mobile, the list pane). */
	apply(detail: string | null): void;
}

const detailHandlers: Partial<Record<View, RouteDetailHandler>> = {};

export function registerRouteDetail(view: View, handler: RouteDetailHandler): void {
	detailHandlers[view] = handler;
}

// True while a route from the browser (load, Back/Forward, a pasted URL)
// is being applied: the resulting setView / selections must not write the
// route again (the address already says it).
let applying = false;

export function isApplyingRoute(): boolean {
	return applying;
}

/**
 * A detail a route named that its view could not show synchronously (a
 * listing or the git status is still loading). The address already says
 * it, so nothing is written meanwhile — no transient URL without the
 * detail — and when the view lands it the write is IN PLACE, never a
 * history entry. Void as soon as the person chooses something else, the
 * view changes, or another route arrives.
 */
let pendingRoute: { view: View; detail: string | null } | null = null;

/**
 * Raised by sessionCore.applyRoute around the whole, possibly async,
 * application of a route (opening the session, listing its tabs,
 * attaching). The in-place writes those steps would make (the session,
 * the first tab) are skipped: the address already says what the route
 * named, and must not read anything else meanwhile. A write the PERSON
 * causes (a push) still goes through.
 */
let suppressed = 0;
// The session that application selected. Its in-place writes are the
// ones to suppress; once another session is on screen (the person picked
// it while the tabs were still loading) the application is over, whatever
// its continuation still does, and that selection must reach the address.
let suppressedFor: string | null = null;

export function beginRouteApply(sessionId: string): void {
	suppressed++;
	suppressedFor = sessionId;
}

export function endRouteApply(): void {
	suppressed = Math.max(0, suppressed - 1);
	if (suppressed === 0) suppressedFor = null;
}

/**
 * Write the route for what is on screen. `push` records a history entry
 * (a view or detail the person chose); otherwise the current entry is
 * updated in place (a forced landing, a tab switch, a selection reset).
 */
export function reflectRoute(opts: { push: boolean }): void {
	if (applying || activeSessionId === null) return;
	if (suppressed > 0 && !opts.push) {
		if (activeSessionId === suppressedFor) return;
		suppressed = 0;
		suppressedFor = null;
	}
	const detail = detailHandlers[view]?.current() ?? null;
	const landed =
		pendingRoute !== null && pendingRoute.view === view && pendingRoute.detail === detail;
	// Landed, or superseded by the person's own choice: either way done.
	if (pendingRoute !== null && pendingRoute.view === view) pendingRoute = null;
	navigate({ sessionId: activeSessionId, view, detail }, { replace: !opts.push || landed });
}

/** Show the view and detail a route names, for the ACTIVE session. */
export function applyRouteView(next: View | null, detail: string | null): void {
	pendingRoute = null;
	applying = true;
	try {
		if (next !== null) setView(next);
		detailHandlers[next ?? view]?.apply(detail);
	} finally {
		applying = false;
	}
	const shown = next ?? view;
	const handler = detailHandlers[shown];
	if (handler && handler.current() !== (detail ?? null)) {
		// The view is still loading what the route names: it lands it (or
		// reports it missing) later; the address stays as it is until then.
		pendingRoute = { view: shown, detail: detail ?? null };
		return;
	}
	// The short form (#/sessions/<id>) or a view without detail: settle the
	// address to the full form of what is shown, in place.
	reflectRoute({ push: false });
}

/**
 * The in-app "back" of a view's detail pane (‹ Files, ‹ Changes, ‹ in
 * Chat): back to the list, with the address updated IN PLACE — the
 * browser's Back keeps walking the real history (the previous thing the
 * person opened), the mobile back gesture included.
 */
export function routeBack(): void {
	applyRouteView(null, null);
}

// ── DOM ─────────────────────────────────────────────────────────────────────
const terminalToolbar = document.getElementById("terminal-toolbar")!;
const terminalTabs = document.getElementById("terminal-tabs")!;
const terminalContainer = document.getElementById("terminal-container")!;
const keyBar = document.getElementById("key-bar");
// Terminal-only toolbar controls, disabled while an overlay covers the terminal.
const fontSizeBtn = document.getElementById("font-size-btn") as HTMLButtonElement | null;
const terminalSearchBtn = document.getElementById(
	"terminal-search-btn",
) as HTMLButtonElement | null;
const terminalSearchInput = document.getElementById(
	"terminal-search-input",
) as HTMLInputElement | null;
const viewSwitch = document.getElementById("view-switch")!;
const buttons: Record<View, HTMLButtonElement> = {
	terminal: document.getElementById("view-terminal-btn") as HTMLButtonElement,
	files: document.getElementById("view-files-btn") as HTMLButtonElement,
	git: document.getElementById("view-git-btn") as HTMLButtonElement,
	chat: document.getElementById("view-chat-btn") as HTMLButtonElement,
};
const overlays: Record<Exclude<View, "terminal">, HTMLElement> = {
	files: document.getElementById("files-view")!,
	git: document.getElementById("git-view")!,
	chat: document.getElementById("chat-view")!,
};
// Each overlay's own "‹ Terminal" button (mobile header).
const toTerminalBtns = [
	document.getElementById("files-to-terminal-btn"),
	document.getElementById("git-to-terminal-btn"),
	document.getElementById("chat-to-terminal-btn"),
].filter((b): b is HTMLButtonElement => b instanceof HTMLButtonElement);
// Mobile bottom navigation (index.html #view-nav). Shown only while an
// overlay is up: on the Terminal view the key bar owns the bottom edge and
// the terminal's layout box must not change on a view switch, so the nav
// never overlaps it. CSS hides the nav entirely on wide screens.
const terminalArea = document.getElementById("terminal-area");
const viewNav = document.getElementById("view-nav");
const navButtons = [...(viewNav?.querySelectorAll<HTMLButtonElement>("button[data-view]") ?? [])];

// ── State ───────────────────────────────────────────────────────────────────

let view: View = "terminal";
// True when the current overlay was entered because the terminal was
// unavailable (stopped session) rather than by the user — such a view
// snaps back to Terminal once the session is running again.
let forced = false;

const viewListeners: Array<(next: View, prev: View) => void> = [];
const syncListeners: Array<() => void> = [];

export function getView(): View {
	return view;
}

export function isOverlayActive(): boolean {
	return view !== "terminal";
}

/** Label for the mobile header pill: "Files" / "Git" / "Chat", or null for the terminal. */
export function overlayLabel(): string | null {
	return view === "files" ? "Files" : view === "git" ? "Git" : view === "chat" ? "Chat" : null;
}

/** Fires after the view changed (not on a same-view re-select). */
export function onViewChange(listener: (next: View, prev: View) => void): void {
	viewListeners.push(listener);
}

/** Fires on every `syncSessionViews()` — session selection / teardown / poll. */
export function onSessionSync(listener: () => void): void {
	syncListeners.push(listener);
}

function positionOverlays(): void {
	// offsetTop/offsetHeight are relative to #terminal-area (the toolbar's
	// offsetParent — it's position:relative) and both read 0 while the
	// toolbar is display:none (mobile, chrome drawer collapsed).
	// Shell v2's merged mobile bar moves the toolbar into the header: it
	// is then not inside #terminal-area at all and the overlays start at 0.
	const inside = terminalArea?.contains(terminalToolbar) === true;
	const bottom = inside ? terminalToolbar.offsetTop + terminalToolbar.offsetHeight : 0;
	for (const el of Object.values(overlays)) el.style.top = `${bottom}px`;
}
new ResizeObserver(positionOverlays).observe(terminalToolbar);

export function setView(next: View, opts: { forced?: boolean } = {}): void {
	forced = next !== "terminal" && opts.forced === true;
	if (view === next) {
		renderSwitch();
		return;
	}
	const prev = view;
	view = next;
	// A detail still pending for the view being left is void.
	if (pendingRoute !== null && pendingRoute.view !== next) pendingRoute = null;
	for (const [name, el] of Object.entries(overlays)) el.hidden = name !== next;
	const covered = next !== "terminal";
	// Covering the terminal visually doesn't stop Tab / Shift+Tab, a
	// click-through or assistive tech from reaching xterm's hidden
	// textarea and typing into the session. `inert` removes the covered
	// subtrees from focus, input and the accessibility tree WITHOUT
	// touching layout — display/visibility would change the box and make
	// xterm refit + resize tmux, which the overlay exists to avoid.
	for (const el of [terminalTabs, terminalContainer, keyBar]) {
		el?.toggleAttribute("inert", covered);
	}
	if (fontSizeBtn) fontSizeBtn.disabled = covered;
	if (terminalSearchBtn) terminalSearchBtn.disabled = covered;
	if (terminalSearchInput) terminalSearchInput.disabled = covered;
	if (covered) {
		// inert also blurs a focused descendant in browsers; the explicit
		// blur covers engines that don't (and jsdom). Also drops the
		// mobile soft keyboard. The terminal itself is untouched.
		const active = document.activeElement;
		if (active instanceof HTMLElement && terminalContainer.contains(active)) active.blur();
		positionOverlays();
	} else if (!isMobile()) {
		// Desktop: hand the keyboard straight back (inert is already off
		// above, so the focus lands). Mobile skips this — focusing xterm
		// pops the soft keyboard, which the user didn't ask for by
		// tapping "Terminal".
		getActiveTerminal()?.focus();
	}
	renderSwitch();
	updateChromeToggle();
	for (const l of viewListeners) l(next, prev);
	// A view the person chose is a history entry; a forced landing (a
	// stopped session opening in Files) only updates the address in place.
	reflectRoute({ push: opts.forced !== true });
}

function renderSwitch(): void {
	for (const [name, btn] of Object.entries(buttons)) {
		btn.setAttribute("aria-pressed", String(view === name));
	}
	const navOn = view !== "terminal" && !viewSwitch.hidden;
	if (viewNav) viewNav.hidden = !navOn;
	terminalArea?.classList.toggle("view-nav-on", navOn);
	for (const b of navButtons) {
		const name = b.dataset.view as View;
		b.setAttribute("aria-pressed", String(view === name));
		if (name === "terminal") b.disabled = buttons.terminal.disabled;
	}
}

function terminalAvailable(): boolean {
	const s = sessions.find((x) => x.sessionId === activeSessionId);
	return s?.status === "running" || currentTerminals.size > 0;
}

/**
 * Re-sync with the active session. Called from sessionCore's
 * updateToolbar() (every session selection / teardown) and on logout.
 */
export function syncSessionViews(): void {
	const s = sessions.find((x) => x.sessionId === activeSessionId);
	if (!s) {
		viewSwitch.hidden = true;
		setView("terminal");
		for (const l of syncListeners) l();
		return;
	}
	viewSwitch.hidden = false;
	const canTerminal = terminalAvailable();
	// The Terminal view is always selectable: with no live terminal it
	// shows the session's state and the action that applies (Start,
	// Restore, Reconnect, Open a tab — sessionCore.renderTerminalState)
	// rather than a disabled button whose only explanation is a tooltip.
	buttons.terminal.disabled = false;
	for (const b of toTerminalBtns) b.disabled = false;
	renderSwitch();
	buttons.terminal.title = canTerminal ? "Show terminal" : "Terminal (session not running)";
	for (const b of toTerminalBtns) b.title = "Back to terminal";
	// Listeners first: they re-key their state to the active session, so
	// a forced switch below (which fires onViewChange → load) loads for
	// the NEW session rather than racing a stale one.
	for (const l of syncListeners) l();
	if (!canTerminal) {
		// No terminal to show: land on Files (works for stopped sessions).
		// A user already on Files, Git or Chat stays where they are.
		if (view === "terminal") setView("files", { forced: true });
	} else if (forced) {
		setView("terminal");
	}
}

/** Open Files for a session that has no terminal (stopped/terminated). */
export function showFilesOnly(): void {
	setView("files", { forced: true });
	if (isMobile()) setChromeOpen(false);
}

buttons.terminal.addEventListener("click", () => setView("terminal"));
for (const b of toTerminalBtns) b.addEventListener("click", () => setView("terminal"));
for (const b of navButtons) {
	b.addEventListener("click", () => {
		const name = b.dataset.view as View;
		if (name === "terminal") setView("terminal");
		else {
			setView(name);
			if (isMobile()) setChromeOpen(false);
		}
	});
}
for (const name of ["files", "git", "chat"] as const) {
	buttons[name].addEventListener("click", () => {
		setView(name);
		// Mobile: the toolbar lives in the chrome drawer — collapse it so
		// the overlay gets the full height (its header has a Terminal button).
		if (isMobile()) setChromeOpen(false);
	});
}
