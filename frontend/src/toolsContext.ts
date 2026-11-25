/**
 * toolsContext.ts — which workspace of the active session Files and Git read
 * (3B F4): null = the principal workspace (`~/workspace`), else a work's
 * worktree, named by its id only — the client sends `work=<id>` and never a
 * path under `.st/` (the backend builds the root from a work it proved is
 * this session's). Leaf module: filesView, gitView and toolsView share it
 * without a cycle.
 */

let work: string | null = null;
let tools = false;
const listeners: Array<() => void> = [];

/** Whether Herramientas is the page on screen (its words in the shared views). */
export function inTools(): boolean {
	return tools;
}

export function setInTools(on: boolean): void {
	tools = on;
}

export function currentWork(): string | null {
	return work;
}

/** Herramientas chose a workspace (null: the principal one, as outside Herramientas). */
export function setWork(next: string | null, opts: { silent?: boolean } = {}): void {
	if (next === work) return;
	work = next;
	// Silent: another session is about to be selected, and its selection
	// re-keys the views anyway — not a read of the old session's workspace.
	if (!opts.silent) for (const l of listeners) l();
}

/** Fires after the workspace changed: Files and Git re-key to it. */
export function onWorkChange(listener: () => void): void {
	listeners.push(listener);
}
