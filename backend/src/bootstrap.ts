/**
 * bootstrap.ts — postCreate / postStart lifecycle hooks (#185).
 *
 * The runner itself lives on `DockerManager` (it needs the
 * Dockerode client + the same `execOneShot` plumbing every other
 * tmux/docker command uses). This module owns the D1 side: the
 * atomic `bootstrapped_at` gate that ensures `postCreate` runs
 * exactly once per session, no matter how many concurrent
 * `start()` calls race in.
 *
 * `postStart` has no D1 gate — by design it runs on every container
 * start (a daemon that should die with the container, like
 * `npm run dev` or `code tunnel`).
 */

import { d1Query } from "./db.js";

/**
 * Atomically mark `session_configs.bootstrapped_at` as set, but only
 * if it was still NULL. Returns true iff THIS caller won the race.
 *
 * Called by the postCreate caller AFTER a successful run so that:
 *
 *   - two concurrent `POST /sessions` retries against the same
 *     session id (e.g. user double-clicked Create) don't both
 *     execute the hook,
 *   - a respawn after a hard-fail can NOT silently re-run the hook
 *     (the row stays at `bootstrapped_at = NULL` until the user
 *     explicitly recreates the session),
 *   - if D1 is briefly unavailable we surface the failure to the
 *     caller rather than silently letting two postCreates run.
 *
 * The hook command itself runs BEFORE this UPDATE so a partial run
 * that crashed the backend mid-flight still leaves the gate open
 * for the next attempt — matching the issue-#185 hard-fail
 * semantics ("the row stays so the user can read the streamed
 * log"). Using SQLite-serialised semantics on D1 — same pattern
 * as the invite-mint and session-quota INSERTs — so the
 * `meta.changes === 1` predicate is the source of truth.
 */
export async function markBootstrapped(sessionId: string): Promise<boolean> {
	const result = await d1Query(
		"UPDATE session_configs SET bootstrapped_at = datetime('now') " +
			"WHERE session_id = ? AND bootstrapped_at IS NULL",
		[sessionId],
	);
	return result.meta.changes === 1;
}
