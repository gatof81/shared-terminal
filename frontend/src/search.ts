/**
 * search.ts — pure Enter/Shift+Enter state machine for the terminal
 * history search box (#357).
 *
 * Kept free of DOM and api imports so the search-vs-next-vs-prev
 * decision is unit-testable in isolation (same split as keys.ts /
 * keyBar.ts); searchBar.ts supplies the runtime bits (input element,
 * REST calls, focus handoff).
 */

/** The tmux pane a submitted search ran against, plus the query it ran
 *  with. `null` means no search has been submitted yet (or state was
 *  reset when the box closed). */
export interface SubmittedSearch {
	sessionId: string;
	tabId: string;
	query: string;
}

export type SearchKeyAction = "search" | "next" | "prev";

/**
 * Decide what an Enter press in the search box means.
 *
 * - First Enter (or any Enter with a changed query) → `search`: tmux
 *   needs the new pattern before it can step matches.
 * - Enter with the same query on the same pane → `next`.
 * - Shift+Enter with the same query on the same pane → `prev`.
 *
 * Shift+Enter with a CHANGED query still returns `search` — there is no
 * previous match of the new pattern to step back through, and
 * `search-backward` already starts from the newest match, so "search"
 * is what the user meant either way.
 *
 * A session/tab mismatch also forces `search`: the last submission
 * belongs to a different pane, and sending `next` there would step a
 * stale search (or no-op) instead of searching the pane the user is
 * looking at.
 */
export function decideSearchAction(
	last: SubmittedSearch | null,
	target: { sessionId: string; tabId: string },
	query: string,
	shift: boolean,
): SearchKeyAction {
	if (
		last === null ||
		last.sessionId !== target.sessionId ||
		last.tabId !== target.tabId ||
		last.query !== query
	) {
		return "search";
	}
	return shift ? "prev" : "next";
}
