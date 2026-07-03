/**
 * reconnect.ts — pure policy helpers for terminal WS auto-reconnect (#356).
 *
 * Kept free of DOM/WS imports so the backoff schedule and close-code
 * classification are unit-testable in isolation; terminal.ts owns the
 * actual socket lifecycle.
 */

/** Stop retrying after this many consecutive failed attempts — past
 *  ~40 s of outage the user is better served by the explicit
 *  "disconnected" state (click the tab to retry) than by a terminal
 *  that pings the backend forever. */
export const MAX_RECONNECT_ATTEMPTS = 6;

const DELAY_SCHEDULE_MS = [1000, 2000, 5000, 10000];

/**
 * Delay before reconnect attempt N (1-based). Follows the schedule
 * 1s → 2s → 5s → 10s (capped), with ±20% jitter so a fleet of tabs
 * dropped by the same backend restart / Tunnel roll doesn't stampede
 * the reconnect in lockstep. `rand` is injectable for tests.
 */
export function reconnectDelayMs(attempt: number, rand: () => number = Math.random): number {
	const idx = Math.min(Math.max(attempt, 1), DELAY_SCHEDULE_MS.length) - 1;
	const base = DELAY_SCHEDULE_MS[idx]!;
	const jitter = (rand() * 2 - 1) * 0.2 * base;
	return Math.round(base + jitter);
}

/**
 * Whether a WS close code is worth retrying. Mirrors the backend's
 * close-code discipline (wsHandler.ts):
 *
 *   - 1000 — deliberate close: our own dispose() or a server-side
 *     clean finish (e.g. "Bootstrap complete"). Never retry.
 *   - 1008 — policy: auth failure, terminated/failed session, invalid
 *     path/tab. Retrying re-sends the same rejected request; the
 *     failure is deterministic. Never retry.
 *
 * Everything else — 1006 (network drop, the common mobile-lock case),
 * 1001 (server going away: backend restart, Tunnel roll), 1011
 * (transient attach/docker hiccup) — may heal, so retry with backoff.
 */
export function isRetryableCloseCode(code: number): boolean {
	return code !== 1000 && code !== 1008;
}
