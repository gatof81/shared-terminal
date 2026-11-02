/**
 * terminalGeometry.ts — whether the terminal may change its geometry now.
 *
 * While an overlay (Files, Git, Chat) covers the terminal, the terminal
 * keeps the geometry it had: its container still changes size when the
 * mobile soft keyboard opens or closes for the Chat composer (the whole
 * app follows `--app-vh`), and fitting to that would send a tmux resize
 * to every viewer of the session for a keyboard nobody typed into the
 * terminal with. Fits requested while frozen are deferred; thawing runs
 * them once, so coming back to the Terminal view syncs the size a single
 * time, in a controlled way.
 *
 * A leaf module (no imports) so viewSwitch and terminal can both use it
 * without importing each other.
 */

let frozen = false;
const deferred = new Set<() => void>();

export function isGeometryFrozen(): boolean {
	return frozen;
}

/** Ask for a fit later, when the geometry is free again. Returns the cancel. */
export function deferFit(fit: () => void): () => void {
	deferred.add(fit);
	return () => deferred.delete(fit);
}

export function setGeometryFrozen(next: boolean): void {
	if (frozen === next) return;
	frozen = next;
	if (frozen) return;
	const fits = [...deferred];
	deferred.clear();
	for (const fit of fits) fit();
}
