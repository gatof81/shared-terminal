/**
 * bellSweeper.ts — Web Push trigger via tmux bell-flag polling (#355).
 *
 * WHY a poller and not the broadcast path: the backend tears down the
 * shared tmux exec when the last browser detaches
 * (`DockerManager.detach` — "last client, shared exec closed"), so it
 * sees NO output while the user is away — exactly when a push matters.
 * The tmux session survives in the container and sets `window_bell_flag`
 * on a BEL (Claude CLI rings it on completion / permission prompts),
 * keeping it set until the window is viewed. So we poll the flag.
 *
 * Per sweep, for each running session:
 *   - user IS attached (any live listener) → they're watching; clear any
 *     pending-notify mark and skip (no push while present).
 *   - user is away AND a bell flag is set → push to the owner ONCE per
 *     bell episode (the flag stays set while away, so dedup on a
 *     `notified` set; the mark clears when the flag clears — i.e. when
 *     the user reattaches and views — re-arming the next notification).
 *
 * Mirrors the IdleSweeper shape (timer + unref + log-and-continue).
 * Only started when Web Push is enabled, so a push-disabled deployment
 * pays zero exec cost.
 */

import { d1Query } from "./db.js";
import { logger } from "./logger.js";
import type { PushPayload } from "./webPush.js";

const DEFAULT_SWEEP_INTERVAL_MS = 15_000;

export interface BellSweeperDeps {
	/** True if a browser is attached to the session (any tab). */
	hasLiveListeners: (sessionId: string) => boolean;
	/** True if any tmux window in the session has a pending bell. */
	readBellFlag: (sessionId: string) => Promise<boolean>;
	/** Push a payload to a user's subscriptions (no-op if push disabled). */
	sendToUser: (userId: string, payload: PushPayload) => Promise<void>;
	/** Running sessions + their owners. Defaults to the D1 query below. */
	listRunningSessions?: () => Promise<Array<{ sessionId: string; userId: string; name: string }>>;
	/** Test seam. */
	sweepIntervalMs?: number;
}

/** Running sessions with owner + name — the sweep universe. Distinct from
 *  idleSweeper's id-only query because a push needs the owner to send to
 *  and the name for the notification body. */
export async function listRunningSessionsWithOwner(): Promise<
	Array<{ sessionId: string; userId: string; name: string }>
> {
	const result = await d1Query<{ session_id: string; user_id: string; name: string }>(
		"SELECT session_id, user_id, name FROM sessions WHERE status = 'running'",
	);
	return result.results.map((r) => ({
		sessionId: r.session_id,
		userId: r.user_id,
		name: r.name,
	}));
}

export class BellSweeper {
	private readonly hasLiveListeners: BellSweeperDeps["hasLiveListeners"];
	private readonly readBellFlag: BellSweeperDeps["readBellFlag"];
	private readonly sendToUser: BellSweeperDeps["sendToUser"];
	private readonly listRunningSessions: NonNullable<BellSweeperDeps["listRunningSessions"]>;
	private readonly sweepIntervalMs: number;

	// Sessions already notified for the CURRENT bell episode. The flag
	// stays set the whole time the user is away, so without this we'd push
	// on every sweep; the mark clears when the flag clears (user viewed it)
	// or the session stops, re-arming the next bell.
	private readonly notified = new Set<string>();
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(deps: BellSweeperDeps) {
		this.hasLiveListeners = deps.hasLiveListeners;
		this.readBellFlag = deps.readBellFlag;
		this.sendToUser = deps.sendToUser;
		this.listRunningSessions = deps.listRunningSessions ?? listRunningSessionsWithOwner;
		this.sweepIntervalMs = deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
	}

	/** Start the periodic sweep. Idempotent. */
	start(): void {
		if (this.timer !== null) return;
		this.timer = setInterval(() => {
			void this.runSweep().catch((err) => {
				logger.warn(`[bell-sweeper] sweep error: ${(err as Error).message}`);
			});
		}, this.sweepIntervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/** One sweep. Exported-ish via being public so tests can drive it
	 *  directly without the timer. */
	async runSweep(): Promise<void> {
		const running = await this.listRunningSessions();
		const runningIds = new Set(running.map((s) => s.sessionId));
		// Prune notify-marks for sessions that are no longer running so the
		// set can't grow unbounded across restarts/stops.
		for (const id of this.notified) {
			if (!runningIds.has(id)) this.notified.delete(id);
		}
		for (const s of running) {
			try {
				// User is watching → not away → never push; clear the mark so a
				// future away-bell re-arms.
				if (this.hasLiveListeners(s.sessionId)) {
					this.notified.delete(s.sessionId);
					continue;
				}
				const bell = await this.readBellFlag(s.sessionId);
				if (!bell) {
					// No pending bell (or it cleared) — re-arm.
					this.notified.delete(s.sessionId);
					continue;
				}
				if (this.notified.has(s.sessionId)) continue; // already pushed this episode
				this.notified.add(s.sessionId);
				await this.sendToUser(s.userId, {
					title: "Session needs attention",
					body: `"${s.name}" rang the bell — Claude may have finished or need input.`,
					sessionId: s.sessionId,
				});
				logger.info(`[bell-sweeper] pushed bell notification for session ${s.sessionId}`);
			} catch (err) {
				// Per-session isolation: one stuck container / D1 hiccup must
				// not stall the rest of the sweep.
				logger.warn(
					`[bell-sweeper] error handling session ${s.sessionId}: ${(err as Error).message}`,
				);
			}
		}
	}
}
