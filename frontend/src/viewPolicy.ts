/**
 * viewPolicy.ts — which view a session lands on when it is selected, and
 * the per-session memory behind it (UI unification §9, decision 1).
 *
 * Pure and storage-only: no DOM, no requests. The order is fixed:
 *
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

export type PolicyView = "terminal" | "files" | "git";

const VIEW_KEY = "st.view.";

export interface LandingInput {
	/** The view the person chose last for this session, if any. */
	pref: PolicyView | null;
	running: boolean;
}

export function chooseLanding(i: LandingInput): PolicyView {
	if (i.running) return i.pref ?? "terminal";
	return "files";
}

function isPolicyView(v: unknown): v is PolicyView {
	return v === "terminal" || v === "files" || v === "git";
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
