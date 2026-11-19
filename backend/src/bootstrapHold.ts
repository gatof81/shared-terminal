/**
 * bootstrapHold.ts — "this session's creation bootstrap has not finished yet".
 *
 * An ACP agent's runner must not start before the create-time bootstrap
 * (git identity → clone → dotfiles → agent seed → `.env` → postCreate) is
 * done: Claude Code reads `~/.claude/CLAUDE.md`, `settings.json` and the
 * project's `CLAUDE.md` when the ACP session is created and never re-reads
 * them, so a runner launched at `container.start()` — what `onStarted` used
 * to do — gets a session without any of them (observed: runner up 16 s
 * before the clone and the seed landed).
 *
 * The create route takes the hold BEFORE `docker.spawn` (spawn fires
 * `onStarted`, and the bootstrap's own in-flight registry is only set once
 * the route reaches `runAsyncBootstrap`, after more awaits — too late to
 * close the race). Every runner launch path (`onStarted`, the watchdog,
 * boot's `ensureAllRunning`) checks `isBootstrapPending` and stands down.
 * The bootstrap releases it with `ok = true` once postCreate has finished
 * (listeners then launch the runner); any other end — a failed stage (the
 * container is killed anyway), a create rollback — releases with
 * `ok = false`, which only drops the hold.
 *
 * Process-local on purpose: a graceful shutdown fails and kills every
 * in-flight bootstrap (#348), so nothing is left to wait for after a
 * restart. A SIGKILL mid-bootstrap strands the session half-provisioned with
 * no resume path (the accepted #348 gap); the hold is gone then and the
 * watchdog launches the runner on that container, as before this module.
 */

const pending = new Set<string>();
const listeners = new Set<(sessionId: string) => void>();

export function holdUntilBootstrapped(sessionId: string): void {
	pending.add(sessionId);
}

export function isBootstrapPending(sessionId: string): boolean {
	return pending.has(sessionId);
}

/** Idempotent: only the first release of a hold notifies (and only when `ok`). */
export function releaseBootstrapHold(sessionId: string, ok: boolean): void {
	if (!pending.delete(sessionId) || !ok) return;
	for (const fn of listeners) fn(sessionId);
}

/** Called with the session id when its bootstrap finished successfully. Returns an unsubscribe. */
export function onBootstrapReleased(fn: (sessionId: string) => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}
