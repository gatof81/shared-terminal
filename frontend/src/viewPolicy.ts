/**
 * viewPolicy.ts — which view a session lands on when it is selected, and
 * the per-session memory behind it (UI unification §9, decision 1).
 *
 * Pure and storage-only: no DOM, no requests. The order is fixed:
 *
 *   0. an ACP agent's session: the view the person last
 *      chose for it, else Chat — the agent is talked to there, and its
 *      chat (acpChat.ts) needs no container, so a stopped one too;
 *   1. the view the person last chose for THIS session (a tab click);
 *   2. Terminal for a running session, Files for a stopped one.
 *
 * A route with an explicit view is applied by the router before any of
 * this runs, so it always wins. A saved view that cannot work without a
 * terminal (Terminal, Git on a stopped session) falls back to rule 2.
 *
 * Everything lives in localStorage, per browser: reads and writes are
 * wrapped, so a private window or blocked storage just means "no
 * preference" and the policy's own defaults.
 */

export type PolicyView = "terminal" | "files" | "git" | "chat";

const VIEW_KEY = "st.view.";

export interface LandingInput {
	/** The view the person chose last for this session, if any. */
	pref: PolicyView | null;
	running: boolean;
	/** Whether the session is an ACP agent's; null = not known (taken as no). */
	isAgent: boolean | null;
}

export function chooseLanding(i: LandingInput): PolicyView {
	if (i.isAgent === true) {
		// A saved view that needs a terminal does not apply to a stopped one.
		if (i.pref !== null && (i.running || i.pref === "files" || i.pref === "chat")) return i.pref;
		return "chat";
	}
	// Only an agent's session has a Chat.
	const pref = i.pref === "chat" ? null : i.pref;
	if (i.running) return pref ?? "terminal";
	return "files";
}

function isPolicyView(v: unknown): v is PolicyView {
	return v === "terminal" || v === "files" || v === "git" || v === "chat";
}

export function readViewPref(sessionId: string): PolicyView | null {
	try {
		const v = localStorage.getItem(VIEW_KEY + sessionId);
		return isPolicyView(v) ? v : null;
	} catch {
		return null;
	}
}

export function writeViewPref(sessionId: string, view: PolicyView): void {
	try {
		localStorage.setItem(VIEW_KEY + sessionId, view);
	} catch {
		/* per-browser convenience only */
	}
}
