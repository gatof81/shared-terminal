/**
 * idleSweeper.ts — auto-stop sessions whose terminals have been idle
 * past the configured `idle_ttl_seconds` (#194).
 *
 * Activity is tracked in-memory only — surviving a backend restart is
 * not required because:
 *
 *   1. The sweeper re-seeds every running session to `now()` on
 *      startup (`init`), so nobody gets reaped seconds after a
 *      restart even if the previous backend's bumps are gone.
 *   2. Idle auto-stop is a soft-stop (workspace preserved); a wrong
 *      reap costs the user a re-attach, not data.
 *
 * Activity sources that bump the entry:
 *   - WS data flow in either direction (bytes from tmux, bytes from
 *     browser, resize events) — wired in wsHandler.
 *   - REST handlers under `/api/sessions/:id` — wired as Express
 *     middleware in routes.
 *
 * Sweep cadence: every 60 s. Per the issue spec, the actual idle
 * time at stop can exceed the configured TTL by up to 60 s, which is
 * acceptable.
 */

import { d1Query } from "./db.js";
import { logger } from "./logger.js";

export interface IdleSweeperDeps {
	/** Stops a session's container — same code path as POST /stop. */
	stopContainer: (sessionId: string) => Promise<void>;
	/** Test seam — defaults to Date.now. */
	now?: () => number;
	/**
	 * Sweep interval in milliseconds. Defaults to 60 s. Tests pass a
	 * smaller value AND drive sweeps directly via `runSweep()`; the
	 * timer is started by `start()` only when the caller wants the
	 * production cadence.
	 */
	sweepIntervalMs?: number;
}

interface RunningWithTtlRow {
	session_id: string;
	idle_ttl_seconds: number;
}

/**
 * Default sweep cadence. The longer-than-1-min ceiling-check error is
 * deliberate — see the "Known wrinkles" note in the #194 issue body.
 */
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

export class IdleSweeper {
	private readonly stopContainer: (sessionId: string) => Promise<void>;
	private readonly now: () => number;
	private readonly sweepIntervalMs: number;

	private readonly lastActivity = new Map<string, number>();
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(deps: IdleSweeperDeps) {
		this.stopContainer = deps.stopContainer;
		this.now = deps.now ?? Date.now;
		this.sweepIntervalMs = deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
	}

	/**
	 * Bump activity for `sessionId`. Called on every WS byte (either
	 * direction), every resize event, and every REST hit under
	 * `/api/sessions/:id`. Cheap (one Map.set), so it's safe to call
	 * on the hot path.
	 *
	 * Calling this for a session that's not running is harmless — the
	 * sweeper only acts on rows whose D1 status is `running`, and
	 * stale Map entries are pruned by `forget()` callers.
	 */
	bump(sessionId: string): void {
		this.lastActivity.set(sessionId, this.now());
	}

	/**
	 * Drop the entry for `sessionId`. Called by `DockerManager.kill()`
	 * and `stopContainer()` so a stopped/dead session doesn't sit in
	 * the activity map forever (memory leak shape if not pruned).
	 */
	forget(sessionId: string): void {
		this.lastActivity.delete(sessionId);
	}

	/**
	 * Seed `lastActivity` to `now()` for each session id passed in.
	 * Called once on backend boot with the list of currently-running
	 * sessions so the first sweep doesn't reap a session whose users
	 * haven't reconnected yet (the previous backend's bumps are gone).
	 */
	init(sessionIds: Iterable<string>): void {
		const t = this.now();
		for (const id of sessionIds) this.lastActivity.set(id, t);
	}

	/** Start the periodic sweep. Idempotent — a second call is a no-op. */
	start(): void {
		if (this.timer !== null) return;
		this.timer = setInterval(() => {
			void this.runSweep().catch((err) => {
				// Sweep errors are logged-and-swallowed: a transient D1
				// failure shouldn't kill the timer (which would silently
				// disable auto-stop until the next backend restart).
				logger.warn(`[idle-sweeper] sweep error: ${(err as Error).message}`);
			});
		}, this.sweepIntervalMs);
		// `unref` so a long-lived sweeper doesn't keep the process
		// alive past `wss.close()` during shutdown.
		this.timer.unref?.();
	}

	/**
	 * Stop the periodic sweep. Idempotent. Called from the shutdown
	 * path before `wss.close()` so the timer doesn't fire during
	 * teardown.
	 */
	stop(): void {
		if (this.timer === null) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	/**
	 * One sweep pass. Exposed for tests so they can drive the loop
	 * synchronously without waiting on real timers.
	 */
	async runSweep(): Promise<void> {
		const result = await d1Query<RunningWithTtlRow>(
			"SELECT s.session_id AS session_id, sc.idle_ttl_seconds AS idle_ttl_seconds " +
				"FROM sessions s " +
				"JOIN session_configs sc ON sc.session_id = s.session_id " +
				"WHERE s.status = 'running' AND sc.idle_ttl_seconds IS NOT NULL",
		);
		const t = this.now();
		for (const row of result.results) {
			const last = this.lastActivity.get(row.session_id);
			if (last === undefined) {
				// Session reached `running` between init() and now (or a
				// previous reap removed the entry). Seed and skip — gives
				// the user a full window before we consider reaping.
				this.lastActivity.set(row.session_id, t);
				continue;
			}
			const idleMs = t - last;
			const ttlMs = row.idle_ttl_seconds * 1000;
			if (idleMs <= ttlMs) continue;
			logger.info(
				`[idle-sweeper] auto-stopping session ${row.session_id}: idle ${Math.round(idleMs / 1000)}s > ttl ${row.idle_ttl_seconds}s`,
			);
			try {
				await this.stopContainer(row.session_id);
				// Drop the entry; the next `/start` flow will re-seed.
				this.lastActivity.delete(row.session_id);
			} catch (err) {
				// Per-row failure is isolated — log and keep iterating
				// so one stuck container doesn't stall the whole sweep.
				logger.warn(
					`[idle-sweeper] stop failed for session ${row.session_id}: ${(err as Error).message}`,
				);
			}
		}
	}

	/**
	 * Test-only — peek at the in-memory map. Production code should
	 * not depend on this; it exists so the test suite can assert
	 * bookkeeping without adding non-test methods to the public
	 * surface.
	 */
	__peekActivity(sessionId: string): number | undefined {
		return this.lastActivity.get(sessionId);
	}
}

/**
 * Helper for the boot path: list every running session id (no JOIN
 * needed since `init` doesn't care about idle_ttl). Exported so
 * `index.ts` can seed the sweeper without duplicating the SQL.
 */
export async function listRunningSessionIds(): Promise<string[]> {
	const result = await d1Query<{ session_id: string }>(
		"SELECT session_id FROM sessions WHERE status = 'running'",
	);
	return result.results.map((r) => r.session_id);
}
