/**
 * viewPolicy.ts — which view a session lands on when it is selected, and
 * the per-session memory behind it (UI unification §9, decision 1).
 *
 * Pure and storage-only: no DOM, no requests. The order is fixed:
 *
 *   1. the view the person last chose for THIS session (a tab click);
 *   2. Chat, when the session has captured history;
 *   3. Terminal for a running session, Files for a stopped one.
 *
 * A route with an explicit view is applied by the router before any of
 * this runs, so it always wins. A saved view that cannot work without a
 * terminal (Terminal, Git on a stopped session) falls back to rule 2/3
 * rather than to an error box. The "has history" answer is remembered
 * per session so that selecting it again asks nothing; the Chat view
 * refreshes the memory every time its list loads.
 *
 * Everything lives in localStorage, per browser: reads and writes are
 * wrapped, so a private window or blocked storage just means "no
 * preference" and the policy's own defaults.
 */

export type PolicyView = "terminal" | "files" | "git" | "chat";

const VIEW_KEY = "st.view.";
const HISTORY_KEY = "st.chat.hist.";
const LAST_KEY = "st.chat.last.";

export interface LandingInput {
	/** The view the person chose last for this session, if any. */
	pref: PolicyView | null;
	/** Whether captured conversations exist; null = not known. */
	hasHistory: boolean | null;
	running: boolean;
}

export function chooseLanding(i: LandingInput): PolicyView {
	if (i.running) {
		if (i.pref !== null) return i.pref;
		return i.hasHistory === true ? "chat" : "terminal";
	}
	// No terminal to show: Files and Chat work on a stopped session; the
	// others would open on their "session not running" state.
	if (i.pref === "files" || i.pref === "chat") return i.pref;
	return i.hasHistory === true ? "chat" : "files";
}

export function isPolicyView(v: unknown): v is PolicyView {
	return v === "terminal" || v === "files" || v === "git" || v === "chat";
}

function read(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function write(key: string, value: string | null): void {
	try {
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {
		/* per-browser convenience only */
	}
}

export function readViewPref(sessionId: string): PolicyView | null {
	const v = read(VIEW_KEY + sessionId);
	return isPolicyView(v) ? v : null;
}

export function writeViewPref(sessionId: string, view: PolicyView): void {
	write(VIEW_KEY + sessionId, view);
}

export function readHistoryHint(sessionId: string): boolean | null {
	const v = read(HISTORY_KEY + sessionId);
	return v === "1" ? true : v === "0" ? false : null;
}

export function writeHistoryHint(sessionId: string, has: boolean): void {
	write(HISTORY_KEY + sessionId, has ? "1" : "0");
}

export function readLastConversation(sessionId: string): string | null {
	const v = read(LAST_KEY + sessionId);
	return v && v.length > 0 ? v : null;
}

export function writeLastConversation(sessionId: string, cid: string | null): void {
	write(LAST_KEY + sessionId, cid);
}

/** Drop everything remembered for a session (hard delete). */
export function forgetSession(sessionId: string): void {
	write(VIEW_KEY + sessionId, null);
	write(HISTORY_KEY + sessionId, null);
	write(LAST_KEY + sessionId, null);
}
