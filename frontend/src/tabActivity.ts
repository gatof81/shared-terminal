/**
 * tabActivity.ts — activity badges for background terminal tabs (#359).
 *
 * Pure state module: tracks, per tabId, whether output arrived while the
 * tab was NOT the one the user is viewing. Two levels — "output" (plain
 * dot) and "bell" (the chunk contained BEL 0x07, e.g. Claude prompting
 * for input; stronger visual, wins over plain output until cleared).
 * DOM rendering stays in sessionCore.ts; this module holds no element
 * references so the transition logic is unit-testable without a DOM.
 */

export type TabBadge = "output" | "bell";

const badges = new Map<string, TabBadge>();

/**
 * Pure transition function: the badge a tab should carry after `chunk`
 * arrived, given its previous badge and whether the tab is the one the
 * user is currently viewing.
 */
export function nextBadgeState(
	prev: TabBadge | undefined,
	chunk: string,
	isActive: boolean,
): TabBadge | undefined {
	// The viewed tab never carries a badge — the user is already looking
	// at the output. Returning undefined (not `prev`) also self-heals a
	// stale badge that somehow survived activation.
	if (isActive) return undefined;
	// Bell is sticky: once a background tab rang, later plain output must
	// not downgrade the signal — the user still hasn't seen the prompt.
	if (prev === "bell" || chunk.includes("\x07")) return "bell";
	return "output";
}

export function badgeFor(tabId: string): TabBadge | undefined {
	return badges.get(tabId);
}

/**
 * Record an output chunk for a tab. Returns true iff the badge state
 * changed (caller only touches the DOM when it did — output streams
 * continuously, so the common case is a no-op).
 */
export function recordOutput(tabId: string, chunk: string, isActive: boolean): boolean {
	const prev = badges.get(tabId);
	const next = nextBadgeState(prev, chunk, isActive);
	if (next === prev) return false;
	if (next === undefined) badges.delete(tabId);
	else badges.set(tabId, next);
	return true;
}

/** Clear on tab activation and on tab close. Returns true iff a badge was present. */
export function clearBadge(tabId: string): boolean {
	return badges.delete(tabId);
}

/** Clear everything on session switch / logout (tab set is torn down wholesale). */
export function clearAllBadges(): void {
	badges.clear();
}
