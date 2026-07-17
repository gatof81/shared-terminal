/**
 * deepLink.ts — pure helpers for the /#/sessions/<id> hash route (#419).
 *
 * Deliberately a leaf module (no app imports) so both main.ts (route
 * consumption) and sessionCore.ts (hash writes on selection) can use it
 * without adding another import cycle to the main↔sessionCore pair.
 *
 * Two hash formats coexist:
 *   - `#/sessions/<id>` (this module) — the shareable deep link. Written
 *     on every session selection, consumed on load + hashchange.
 *   - `#session=<id>` (main.ts, #355) — the service worker's cold-start
 *     jump after a notification tap. One-shot: consumed and cleared.
 * The parser here matches ONLY the first shape, so the SW path keeps its
 * clear-after-use semantics untouched.
 */

/** Extract the session id from a `#/sessions/<id>` hash, or null when
 *  the hash is absent, a different shape, or undecodable. */
export function parseSessionHash(hash: string): string | null {
	const m = /^#\/sessions\/([^/?#]+)$/.exec(hash);
	if (!m) return null;
	try {
		return decodeURIComponent(m[1]!);
	} catch {
		// Malformed percent-encoding (`%` alone, `%zz`) — treat as no
		// route rather than throwing during app init.
		return null;
	}
}

export function sessionHash(sessionId: string): string {
	return `#/sessions/${encodeURIComponent(sessionId)}`;
}

/**
 * Mirror the active session into the URL so the address bar is always a
 * shareable deep link. `history.replaceState` on purpose, twice over:
 * it does NOT fire `hashchange` (so the route consumer in main.ts can't
 * loop on our own writes), and it does NOT push a history entry (so
 * clicking through five sessions doesn't turn Back into a session
 * carousel).
 *
 * `null` clears the hash — but only when the current hash IS a session
 * deep link. The SW's `#session=` one-shot and any future hash shapes
 * are not ours to clobber.
 */
export function reflectSessionInHash(sessionId: string | null): void {
	const bare = window.location.pathname + window.location.search;
	if (sessionId === null) {
		if (parseSessionHash(window.location.hash) === null) return;
		history.replaceState(null, "", bare);
		return;
	}
	const target = sessionHash(sessionId);
	if (window.location.hash === target) return;
	history.replaceState(null, "", bare + target);
}
