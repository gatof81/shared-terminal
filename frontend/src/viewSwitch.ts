/**
 * viewSwitch.ts — the per-session view selector: Terminal ⇄ Files ⇄ Git.
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
 * Each overlay module (filesView.ts, gitView.ts) registers listeners
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

export type View = "terminal" | "files" | "git";

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
};
const overlays: Record<Exclude<View, "terminal">, HTMLElement> = {
	files: document.getElementById("files-view")!,
	git: document.getElementById("git-view")!,
};
// Each overlay's own "‹ Terminal" button (mobile header).
const toTerminalBtns = [
	document.getElementById("files-to-terminal-btn"),
	document.getElementById("git-to-terminal-btn"),
].filter((b): b is HTMLButtonElement => b instanceof HTMLButtonElement);

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

/** Label for the mobile header pill: "Files" / "Git", or null for the terminal. */
export function overlayLabel(): string | null {
	return view === "files" ? "Files" : view === "git" ? "Git" : null;
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
	const bottom = terminalToolbar.offsetTop + terminalToolbar.offsetHeight;
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
}

function renderSwitch(): void {
	for (const [name, btn] of Object.entries(buttons)) {
		btn.setAttribute("aria-pressed", String(view === name));
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
	buttons.terminal.disabled = !canTerminal;
	for (const b of toTerminalBtns) b.disabled = !canTerminal;
	const hint = canTerminal ? "" : "Start the session to use the terminal";
	buttons.terminal.title = hint || "Show terminal";
	for (const b of toTerminalBtns) b.title = hint || "Back to terminal";
	// Listeners first: they re-key their state to the active session, so
	// a forced switch below (which fires onViewChange → load) loads for
	// the NEW session rather than racing a stale one.
	for (const l of syncListeners) l();
	if (!canTerminal) {
		// No terminal to show: land on Files (works for stopped sessions).
		// A user already on Files or Git stays where they are.
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
for (const name of ["files", "git"] as const) {
	buttons[name].addEventListener("click", () => {
		setView(name);
		// Mobile: the toolbar lives in the chrome drawer — collapse it so
		// the overlay gets the full height (its header has a Terminal button).
		if (isMobile()) setChromeOpen(false);
	});
}
