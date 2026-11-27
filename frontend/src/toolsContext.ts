/**
 * toolsContext.ts — which workspace Files and Git read (3B F4): null = the
 * principal workspace (`~/workspace`), else a work's worktree, named by its
 * id only — the client sends `work=<id>` and never a path under `.st/` (the
 * backend builds the root from a work it proved is this session's). Leaf
 * module: filesView, gitView and toolsView share it without a cycle.
 *
 * A work belongs to ONE session (its agent's): `workFor` answers it only for
 * that session. Herramientas picks the work before that session is the one on
 * screen (its selection is async, the session list may still be loading), and
 * the session on screen meanwhile must keep reading its own principal
 * workspace — never ask for another agent's work and show a passing «no
 * disponible».
 */

let work: { sessionId: string; id: string } | null = null;
/** The work whose read answered 404/403: «Este trabajo ya no está disponible». */
let gone: { sessionId: string; id: string } | null = null;
let tools = false;
const listeners: Array<() => void> = [];
const goneListeners: Array<() => void> = [];

/** Whether Herramientas is the page on screen (its words in the shared views). */
export function inTools(): boolean {
	return tools;
}

export function setInTools(on: boolean): void {
	tools = on;
}

/** The workspace `sessionId`'s Files / Git read: a work id, or null (the principal one). */
export function workFor(sessionId: string | null): string | null {
	return work !== null && work.sessionId === sessionId ? work.id : null;
}

/** Herramientas chose `id` of `sessionId` (null: the principal workspace, as outside Herramientas). */
export function setWork(sessionId: string | null, id: string | null): void {
	const next = sessionId !== null && id !== null ? { sessionId, id } : null;
	if (next?.sessionId === work?.sessionId && next?.id === work?.id) return;
	work = next;
	gone = null;
	for (const l of listeners) l();
	for (const l of goneListeners) l();
}

/** Fires after the workspace changed: Files and Git re-key to it (if it is their session's). */
export function onWorkChange(listener: () => void): void {
	listeners.push(listener);
}

/** Files or Git read `id` of `sessionId` and the backend no longer serves it. */
export function reportWorkGone(sessionId: string, id: string): void {
	if (workFor(sessionId) !== id || gone !== null) return;
	gone = { sessionId, id };
	for (const l of goneListeners) l();
}

export function isWorkGone(sessionId: string | null): boolean {
	return gone !== null && gone.sessionId === sessionId && workFor(sessionId) === gone.id;
}

export function onWorkGone(listener: () => void): void {
	goneListeners.push(listener);
}
