/**
 * observeModal.ts — the read-only observe terminal modal plus the admin
 * "take control" (operate) escalation (#admin-operate 4/4). Extracted
 * from myGroups.ts so BOTH the lead-side observe rows (myGroups.ts) and
 * the admin dashboard (admin.ts) can open it without an admin↔myGroups
 * circular import: this module imports only main.ts, api.ts, and
 * terminal.ts — none of which import it back.
 *
 * Same circular-import-safe pattern as admin.ts / myGroups.ts: DOM
 * elements are re-queried locally (singletons by id) and the main.ts
 * imports (showToast, currentFontSize) are read only inside functions.
 */

import { listTabs, type Tab } from "./api.js";
import { currentFontSize, showToast } from "./main.js";
import { nextObserveMode, type ObserveMode } from "./observeMode.js";
import { openTerminalSession, type TerminalSession } from "./terminal.js";

// ── DOM (re-queried locally; see header) ─────────────────────────────────
const observeModal = document.getElementById("observe-modal")!;
const observeModalTitle = document.getElementById("observe-modal-title")!;
const observeModalHint = document.getElementById("observe-modal-hint")!;
const observeTerminalHost = document.getElementById("observe-terminal-host")!;
const takeControlBtn = document.getElementById("observe-take-control-btn") as HTMLButtonElement;

/** What the two call sites (lead rows, admin dashboard) hand the modal.
 *  `canOperate` is the whole observe-vs-operate gate: leads omit it
 *  (read-only), admins pass true so the Take control button appears.
 *  `canReconnect` is caller-specific because the "still running?" probe
 *  differs — leads re-derive from the observable list, admins from the
 *  admin session list (getSession is owner-scoped, so neither can use
 *  it for a foreign session). */
export interface ObserveTarget {
	sessionId: string;
	name: string;
	ownerUsername: string;
	canOperate?: boolean;
	canReconnect: () => Promise<boolean>;
}

// At most one observe/operate terminal at a time. Opening a second
// (via another row before closing the modal) tears down the prior one.
let activeObserveTerm: TerminalSession | null = null;

// Current open target + selected tab + live mode. Held so the Take
// control button can re-attach the SAME session/tab in the other mode
// and so the chrome (title/hint/button) can re-render on each flip.
interface OpenState {
	target: ObserveTarget;
	tab: Tab;
	tabCount: number;
	mode: ObserveMode;
}
let current: OpenState | null = null;

function renderModeChrome(): void {
	if (!current) return;
	const { target, tab, tabCount, mode } = current;
	const tabLabel = tab.label ?? tab.tabId;
	// The tab-count suffix keeps a viewer aware the session may have more
	// than the first tab we attach to — preserved from the pre-extraction
	// observe modal.
	const tabWhich =
		tabCount === 1 ? `"${tabLabel}"` : `"${tabLabel}" (1 of ${tabCount} tabs — first shown)`;
	if (mode === "observe") {
		observeModalTitle.textContent = `Observing "${target.name}" (${target.ownerUsername})`;
		observeModalHint.textContent = `Read-only view of ${tabWhich}. Input is disabled — every observe-attach is logged.`;
	} else {
		observeModalTitle.textContent = `Operating "${target.name}" (${target.ownerUsername})`;
		observeModalHint.textContent = `Full control of ${tabWhich} — you can type in ${target.ownerUsername}'s session. This is logged as an operate action.`;
	}
	if (target.canOperate) {
		takeControlBtn.hidden = false;
		takeControlBtn.textContent = mode === "observe" ? "Take control" : "Release control";
		// Accent the button while operating so the escalated state is
		// visible at a glance (mirrors the observe-log operate pill).
		takeControlBtn.classList.toggle("observe-take-control-btn--active", mode === "operate");
	} else {
		takeControlBtn.hidden = true;
	}
}

/** (Re)attach the WS in `mode`. Disposing then re-opening
 *  `openTerminalSession` is what actually switches observe↔operate: the
 *  backend authorizes the fresh attach via assertCanObserve (observe)
 *  vs assertCanOperate (operate) and audits it with the matching
 *  `mode`. `activeObserveTerm` is repointed so `closeObserveModal` (and
 *  the next attach) tear down the CURRENT term, not the disposed one. */
function attach(mode: ObserveMode): void {
	if (!current) return;
	const { target, tab } = current;
	current.mode = mode;
	if (activeObserveTerm) {
		activeObserveTerm.dispose();
		activeObserveTerm = null;
	}
	observeTerminalHost.textContent = "";
	renderModeChrome();
	const verb = mode === "observe" ? "Observe" : "Operate";
	activeObserveTerm = openTerminalSession({
		container: observeTerminalHost,
		sessionId: target.sessionId,
		tabId: tab.tabId,
		fontSize: currentFontSize,
		// The observe flag is the ONLY input gate: observe:true suppresses
		// client keystrokes AND makes the backend route via observe-auth;
		// observe:false leaves input flowing and routes via operate-auth.
		observe: mode === "observe",
		onStatus: (status) => {
			// A flip to "disconnected" means the session terminated or the
			// owner stopped it; the audit row's `ended_at` is set server-side
			// on ws close. Surface a toast so the viewer knows why it went dark.
			if (status === "disconnected") {
				showToast(`${verb} attach to "${target.name}" disconnected`);
				// "disconnected" is TERMINAL (the #356 reconnect loop gave up or
				// the close was non-retryable — transient drops emit "reconnecting"),
				// so no live WS remains to mislead about: drop the operate chrome
				// back to observe so the amber "Release control" button stops
				// signalling live write access on a dead socket. PR #414 SHOULD-FIX.
				if (current && current.mode === "operate") {
					current.mode = "observe";
					renderModeChrome();
				}
			}
		},
		onError: (msg) => showToast(`${verb} error: ${msg}`, true),
		// Same renderer-degrade notice the owner-side tabs get — a silent
		// WebGL→DOM fallback in the observed view has no other explanation.
		onRendererFallback: (msg) => showToast(msg),
		canReconnect: target.canReconnect,
	});
}

/** Open the modal for `target` in read-only observe mode. Async: it
 *  fetches the tab list first because the WS handler hard-rejects an
 *  attach without a real `?tab=` (1008 "Missing tab") — the backend has
 *  no implicit default tab. A tab-less session gets a toast, not an
 *  empty modal that would disconnect immediately. */
export async function openObserveModalFor(target: ObserveTarget): Promise<void> {
	// Tear down any prior attach first — keeps the audit log honest (one
	// open maps to one close UPDATE) and avoids stacking xterm DOM nodes.
	closeObserveModal();
	let tabs: Tab[];
	try {
		// listTabs is gated by assertCanObserve server-side, so an admin /
		// lead can read a foreign session's tab list without owning it.
		tabs = await listTabs(target.sessionId);
	} catch (err) {
		showToast(`Couldn't load tabs for "${target.name}": ${(err as Error).message}`, true);
		return;
	}
	if (tabs.length === 0) {
		showToast(`"${target.name}" has no open tabs to observe`, true);
		return;
	}
	// v1 attaches to the first tab — a session typically has one; the
	// hint surfaces the count so the viewer knows if there are more.
	const tab = tabs[0]!;
	current = { target, tab, tabCount: tabs.length, mode: "observe" };
	observeModal.classList.add("open");
	observeModal.setAttribute("aria-hidden", "false");
	attach("observe");
}

export function closeObserveModal(): void {
	if (activeObserveTerm) {
		// dispose() closes the WS — the server's ws.on("close") then fires
		// recordObserveEnd() to UPDATE ended_at (idempotent via WHERE
		// ended_at IS NULL).
		activeObserveTerm.dispose();
		activeObserveTerm = null;
	}
	current = null;
	observeTerminalHost.textContent = "";
	observeModal.classList.remove("open");
	observeModal.setAttribute("aria-hidden", "true");
}

takeControlBtn.addEventListener("click", () => {
	if (!current) return;
	const { target, mode } = current;
	const next = nextObserveMode(mode);
	if (next === "operate") {
		// Escalation is a deliberate, separately-audited act — confirm it.
		// De-escalation (release) needs no confirm; dropping to read-only
		// can't harm the owner's session.
		if (
			!confirm(
				`Take control of "${target.name}" (${target.ownerUsername})? You will be able to type in their session. This is logged.`,
			)
		) {
			return;
		}
	}
	attach(next);
});

observeModal.addEventListener("click", (e) => {
	const el = e.target as HTMLElement;
	if (el.hasAttribute("data-close-modal")) closeObserveModal();
});
