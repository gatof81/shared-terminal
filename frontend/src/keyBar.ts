/**
 * keyBar.ts — mobile extra-keys bar (Esc / Tab / Ctrl / ^C / arrows).
 *
 * The iOS/Android soft keyboard has none of the keys a terminal lives
 * on; this bar sits between the terminal and the keyboard and injects
 * them. Follows the #312 module pattern: imports main.ts's live
 * bindings, all cross-module reads happen inside functions (TDZ-safe).
 *
 * Two design points that are easy to break:
 *
 *   - Buttons act on `pointerdown` + preventDefault, NOT `click`.
 *     Cancelling pointerdown suppresses the compatibility mousedown,
 *     and focus follows mousedown — so xterm's helper textarea keeps
 *     focus and the soft keyboard STAYS OPEN while the user taps bar
 *     keys. A click handler would blur the terminal on every tap and
 *     bounce the keyboard closed/open.
 *
 *   - The sticky-Ctrl state lives HERE, not in terminal.ts. The bar is
 *     one global widget; terminals are per-tab. Keeping the armed flag
 *     in the session would desync the button's pressed visual whenever
 *     the user switched tabs with Ctrl armed. terminal.ts instead
 *     exposes a `transformInput` hook that every tab's session shares
 *     (wired in sessionCore.openTab), so whichever terminal receives
 *     the next keystroke consumes the same armed state the button
 *     displays.
 */

import { ctrlifyChar, type SpecialKey } from "./keys.js";
import { activeSessionId, getActiveTerminal } from "./main.js";

const keyBar = document.getElementById("key-bar")!;
const ctrlBtn = document.getElementById("key-bar-ctrl") as HTMLButtonElement;

let ctrlArmed = false;

function setCtrlArmed(on: boolean): void {
	ctrlArmed = on;
	ctrlBtn.classList.toggle("armed", on);
	ctrlBtn.setAttribute("aria-pressed", String(on));
}

/**
 * transformInput hook shared by every tab's terminal session (wired in
 * sessionCore.openTab). When Ctrl is armed, the next keyboard chunk is
 * ctrl-ified and the modifier disarms — including for chunks that have
 * no control mapping (IME output, multi-char bursts), so the armed
 * state can't linger past a keystroke the user visibly typed.
 */
export function transformKeyInput(data: string): string {
	if (!ctrlArmed) return data;
	setCtrlArmed(false);
	return ctrlifyChar(data);
}

/** Show the bar only while a session is active — same lifecycle as the
 *  actions (+) button; called from updateChromeToggle. The `hidden`
 *  attribute is the JS half; CSS additionally gates display on the
 *  mobile breakpoint + coarse pointer, so desktop never sees it. */
export function updateKeyBarVisibility(): void {
	keyBar.hidden = activeSessionId === null;
}

function pressKey(key: SpecialKey): void {
	const term = getActiveTerminal();
	if (!term) return;
	const ctrl = ctrlArmed;
	if (ctrl) setCtrlArmed(false);
	term.sendSpecialKey(key, { ctrl });
}

// Hold-to-repeat for the arrow keys (data-repeat buttons): initial
// delay then steady rate, matching hardware key-repeat feel. Repeats
// send the PLAIN key — the sticky Ctrl was consumed by the first
// press, and auto-repeating a modified arrow (word-jump) is more
// surprising than useful.
const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 80;
let repeatDelayTimer: ReturnType<typeof setTimeout> | null = null;
let repeatTimer: ReturnType<typeof setInterval> | null = null;

function stopRepeat(): void {
	if (repeatDelayTimer !== null) clearTimeout(repeatDelayTimer);
	if (repeatTimer !== null) clearInterval(repeatTimer);
	repeatDelayTimer = null;
	repeatTimer = null;
}

function startRepeat(key: SpecialKey): void {
	stopRepeat();
	repeatDelayTimer = setTimeout(() => {
		repeatDelayTimer = null;
		repeatTimer = setInterval(() => {
			const term = getActiveTerminal();
			// Tab closed / session switched mid-hold — stop rather than
			// spray keys at whatever becomes active next.
			if (!term) {
				stopRepeat();
				return;
			}
			term.sendSpecialKey(key, { ctrl: false });
		}, REPEAT_INTERVAL_MS);
	}, REPEAT_DELAY_MS);
}

export function initKeyBar(): void {
	for (const btn of keyBar.querySelectorAll<HTMLButtonElement>("button[data-key]")) {
		const key = btn.dataset.key!;
		btn.addEventListener("pointerdown", (ev) => {
			// Load-bearing: keeps focus (and the soft keyboard) on xterm's
			// helper textarea — see the module comment.
			ev.preventDefault();
			if (key === "ctrl") {
				setCtrlArmed(!ctrlArmed);
				return;
			}
			pressKey(key as SpecialKey);
			if (btn.hasAttribute("data-repeat")) startRepeat(key as SpecialKey);
		});
		// pointerleave covers the finger sliding off the button mid-hold;
		// pointercancel covers the OS stealing the gesture (notification
		// shade pull, app switch).
		btn.addEventListener("pointerup", stopRepeat);
		btn.addEventListener("pointerleave", stopRepeat);
		btn.addEventListener("pointercancel", stopRepeat);
	}
}
