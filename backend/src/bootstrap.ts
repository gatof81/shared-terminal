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
 *
 * PR 185b2b adds the streaming side: `BootstrapBroadcaster` fans
 * postCreate output to per-session WS subscribers, and
 * `runAsyncBootstrap` wires the runner + broadcaster + status flips
 * together so `POST /api/sessions` can return 201 immediately while
 * the hook continues in the background.
 */

import { runCloneRepo } from "./bootstrap/cloneRepo.js";
import { d1Query } from "./db.js";
import type { DockerManager } from "./dockerManager.js";
import { logger } from "./logger.js";
import { getSessionConfig } from "./sessionConfig.js";
import type { SessionManager } from "./sessionManager.js";

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

// ── Streaming broadcaster (PR 185b2b) ─────────────────────────────────────

/** Server → client message shape on the bootstrap WS channel. */
export type BootstrapMessage =
	| { type: "output"; data: string }
	| { type: "done"; success: true }
	| { type: "fail"; exitCode: number; error?: string };

export type BootstrapListener = (msg: BootstrapMessage) => void;

interface SessionState {
	listeners: Set<BootstrapListener>;
	/**
	 * Buffered output emitted before any subscriber connected — handed
	 * to late joiners so the modal can still see the full log even if
	 * its WS connection lagged behind the POST response. Capped at
	 * `MAX_BUFFER_BYTES` total bytes; old chunks drop off the front
	 * once the cap is reached. The cap is a hostile-input bound, not a
	 * UX target; a hook spamming MB to stdout would otherwise pin the
	 * broadcaster at the same memory footprint indefinitely.
	 */
	bufferedOutput: string[];
	bufferedBytes: number;
	/**
	 * Terminal message (success / fail). Once set, all future
	 * subscribers immediately receive every buffered chunk + this
	 * terminal message and then the broadcaster removes the entry.
	 * Late subscribers get a clean replay even after the runner has
	 * fully exited.
	 */
	terminal: BootstrapMessage | null;
	/**
	 * GC timer that fires after the terminal message lands — keeps the
	 * state alive long enough for any in-flight subscriber to attach
	 * and replay, then drops the entry to free memory. Reset on every
	 * subscribe so the GC clock restarts after each replay.
	 */
	gcTimer: NodeJS.Timeout | null;
}

const MAX_BUFFER_BYTES = 256 * 1024; // 256 KiB per session
const POST_DONE_RETENTION_MS = 60_000; // keep buffered + terminal for 1 min after done

/**
 * Per-session broadcaster for postCreate hook output. WS subscribers
 * (one per browser tab on the modal) get every chunk in arrival order
 * plus a final terminal message. Late subscribers replay from the
 * buffer + terminal so a slow WS connect doesn't lose log lines.
 *
 * Single-instance, owned by `index.ts`, passed into both the route
 * (which calls `broadcast` / `finish`) and the WS handler (which
 * calls `subscribe` / `unsubscribe`).
 */
export class BootstrapBroadcaster {
	private readonly states = new Map<string, SessionState>();

	/**
	 * Returns the existing state for `sessionId` or creates a fresh
	 * one. Lazy init so the first `broadcast` or `subscribe` for a
	 * session sets up the entry without the caller having to remember
	 * to "open" the session first.
	 */
	private ensure(sessionId: string): SessionState {
		let s = this.states.get(sessionId);
		if (!s) {
			s = {
				listeners: new Set(),
				bufferedOutput: [],
				bufferedBytes: 0,
				terminal: null,
				gcTimer: null,
			};
			this.states.set(sessionId, s);
		}
		return s;
	}

	/**
	 * Append a stdout/stderr chunk to the session's buffer and fan it
	 * out to every live listener. Caller must invoke this for every
	 * chunk the postCreate hook emits, in order. After `finish` lands
	 * for a session, further `broadcast` calls are dropped — the
	 * runner shouldn't be emitting anything once it's signalled done,
	 * and ignoring stragglers keeps the broadcaster idempotent.
	 */
	broadcast(sessionId: string, data: string): void {
		const s = this.ensure(sessionId);
		if (s.terminal) return;
		const bytes = Buffer.byteLength(data, "utf-8");
		s.bufferedOutput.push(data);
		s.bufferedBytes += bytes;
		// Trim the head of the buffer if we've blown past the cap. Keep
		// the most-recent chunks because they're what the user wants to
		// see when they finally subscribe (the tail is where the error
		// usually lives). Loose: we drop full chunks rather than partial
		// — the cap is a backstop, not a precise byte clock.
		while (s.bufferedBytes > MAX_BUFFER_BYTES && s.bufferedOutput.length > 1) {
			const dropped = s.bufferedOutput.shift();
			if (dropped !== undefined) s.bufferedBytes -= Buffer.byteLength(dropped, "utf-8");
		}
		const msg: BootstrapMessage = { type: "output", data };
		for (const l of s.listeners) {
			try {
				l(msg);
			} catch (err) {
				// Listener errors are deliberately swallowed — a thrown
				// listener would break the fan-out for everyone else
				// in the Set. WS handlers wrap their send in try/catch
				// at the source already.
				logger.warn(`[bootstrap] listener threw on broadcast: ${(err as Error).message}`);
			}
		}
	}

	/**
	 * Mark the session's bootstrap as terminal (success or failure)
	 * and notify all current + future subscribers. Schedules GC of
	 * the entry after a retention window so a late subscriber can
	 * still see the full replay; without retention, a modal that
	 * raced the response → WS-connect would see "no such session"
	 * for a session that just finished bootstrapping.
	 */
	finish(sessionId: string, msg: BootstrapMessage): void {
		const s = this.ensure(sessionId);
		if (s.terminal) return;
		s.terminal = msg;
		for (const l of s.listeners) {
			try {
				l(msg);
			} catch (err) {
				logger.warn(`[bootstrap] listener threw on finish: ${(err as Error).message}`);
			}
		}
		this.scheduleGc(sessionId);
	}

	/**
	 * Subscribe a listener. Immediately delivers any buffered chunks
	 * + the terminal message (if set), so a late subscriber gets a
	 * complete replay. Returns an `unsubscribe` thunk the caller
	 * MUST call on WS close to avoid leaking the listener.
	 */
	subscribe(sessionId: string, listener: BootstrapListener): () => void {
		const s = this.ensure(sessionId);
		s.listeners.add(listener);
		// Pause GC while a subscriber is active — restart the timer
		// when they leave so the entry sticks around for any other
		// late joiners.
		if (s.gcTimer) {
			clearTimeout(s.gcTimer);
			s.gcTimer = null;
		}
		// Replay buffered output + terminal in a single microtask so
		// the listener's first `onmessage` fire isn't synchronously
		// re-entrant from inside `subscribe`.
		queueMicrotask(() => {
			for (const data of s.bufferedOutput) {
				try {
					listener({ type: "output", data });
				} catch (err) {
					logger.warn(`[bootstrap] listener threw on replay: ${(err as Error).message}`);
				}
			}
			if (s.terminal) {
				try {
					listener(s.terminal);
				} catch (err) {
					logger.warn(`[bootstrap] listener threw on terminal replay: ${(err as Error).message}`);
				}
			}
		});
		return () => this.unsubscribe(sessionId, listener);
	}

	private unsubscribe(sessionId: string, listener: BootstrapListener): void {
		const s = this.states.get(sessionId);
		if (!s) return;
		s.listeners.delete(listener);
		// If the entry is already terminal AND the last subscriber
		// just left, restart the GC timer so the state doesn't sit
		// in memory forever.
		if (s.terminal && s.listeners.size === 0) {
			this.scheduleGc(sessionId);
		}
	}

	private scheduleGc(sessionId: string): void {
		const s = this.states.get(sessionId);
		if (!s) return;
		if (s.gcTimer) clearTimeout(s.gcTimer);
		// `unref()` so a pending GC timer never holds the process open
		// during shutdown. Loss of the entry on shutdown is fine —
		// nothing in D1 depends on the in-memory replay buffer.
		s.gcTimer = setTimeout(() => {
			this.states.delete(sessionId);
		}, POST_DONE_RETENTION_MS).unref();
	}

	/** Test-only: reset all state. */
	clearForTesting(): void {
		for (const s of this.states.values()) {
			if (s.gcTimer) clearTimeout(s.gcTimer);
		}
		this.states.clear();
	}
}

// ── Async runner (PR 185b2b) ──────────────────────────────────────────────

/**
 * Run repo-clone (#188) and postCreate (#185, on success postStart) for
 * a session out-of-band, streaming output to the broadcaster as it
 * arrives. Called from `POST /api/sessions` AFTER the response has
 * been sent (fire-and-forget), so a long-running step can't tie up
 * the HTTP request and the modal can subscribe to
 * `/ws/bootstrap/<sessionId>` to see live output.
 *
 * Step order (188c): clone → postCreate → markBootstrapped → postStart.
 * Clone runs FIRST so a configured repo is in place by the time the
 * user's postCreate hook (or first interactive command) runs. A
 * non-zero exit from any blocking step (clone, postCreate) hard-fails
 * the session.
 *
 * Failure semantics match the synchronous flow that PR 185b2a shipped:
 *   - non-zero clone or postCreate exit → flip status to `failed`
 *     BEFORE killing the container (so reconcile never sees a
 *     half-state row), then kill, then broadcast `{type: "fail"}`
 *     so the modal renders its inline error panel.
 *   - any unexpected throw inside the runner is logged + treated as
 *     a hard failure (same status flip + kill + broadcast).
 *
 * Caller: only invoke this if SOMETHING is configured (postCreateCmd
 * or repo). The markBootstrapped gate is single-use, and the route
 * already checks `bootstrapped_at IS NULL` semantics by virtue of
 * being on the create path.
 */
export async function runAsyncBootstrap(
	sessionId: string,
	cfg: { postCreateCmd?: string; postStartCmd?: string },
	deps: {
		sessions: SessionManager;
		docker: DockerManager;
		broadcaster: BootstrapBroadcaster;
	},
): Promise<void> {
	const { sessions, docker, broadcaster } = deps;
	const onOutput = (chunk: string) => broadcaster.broadcast(sessionId, chunk);

	// Step 1: repo clone. `runCloneRepo` is a no-op + exitCode=0 when
	// no `repo` is configured, so this branch is free for sessions
	// that only use postCreate. Load the full config here (one D1
	// round-trip) — the route already persisted it before `spawn()`,
	// so the row is guaranteed to exist when there's anything to
	// clone or hook on.
	let cloneExit: number;
	try {
		const config = await getSessionConfig(sessionId);
		if (config) {
			const result = await runCloneRepo({ sessionId, config, docker, onOutput });
			cloneExit = result.exitCode;
		} else {
			cloneExit = 0;
		}
	} catch (err) {
		logger.error(`[bootstrap] clone threw for session ${sessionId}: ${(err as Error).message}`);
		await failSession(sessionId, sessions, docker);
		broadcaster.finish(sessionId, {
			type: "fail",
			exitCode: -1,
			error: (err as Error).message,
		});
		return;
	}
	if (cloneExit !== 0) {
		await failSession(sessionId, sessions, docker);
		broadcaster.finish(sessionId, { type: "fail", exitCode: cloneExit });
		return;
	}

	// Step 2: postCreate. May be unset when only the repo step is
	// configured — in that case skip straight to markBootstrapped +
	// postStart. The bootstrap is still considered complete.
	let exitCode: number;
	if (cfg.postCreateCmd) {
		try {
			const result = await docker.runPostCreate(sessionId, cfg.postCreateCmd, onOutput);
			exitCode = result.exitCode;
		} catch (err) {
			logger.error(
				`[bootstrap] postCreate threw for session ${sessionId}: ${(err as Error).message}`,
			);
			await failSession(sessionId, sessions, docker);
			broadcaster.finish(sessionId, {
				type: "fail",
				exitCode: -1,
				error: (err as Error).message,
			});
			return;
		}
	} else {
		exitCode = 0;
	}

	if (exitCode !== 0) {
		await failSession(sessionId, sessions, docker);
		broadcaster.finish(sessionId, { type: "fail", exitCode });
		return;
	}

	// postCreate succeeded — mark the gate, then run postStart (if
	// configured). markBootstrapped failure is logged but doesn't
	// fail the session: the hook DID complete cleanly, the user's
	// environment is set up, and a future restart attempting to
	// re-run postCreate would just re-run the gate atomically.
	try {
		await markBootstrapped(sessionId);
	} catch (err) {
		logger.error(
			`[bootstrap] markBootstrapped failed for session ${sessionId}: ${(err as Error).message}. ` +
				"Hook ran successfully but the gate is unset — operator should manually update D1.",
		);
	}
	if (cfg.postStartCmd) {
		try {
			await docker.runPostStart(sessionId, cfg.postStartCmd);
		} catch (err) {
			logger.warn(
				`[bootstrap] postStart launch failed for session ${sessionId}: ${(err as Error).message}`,
			);
		}
	}
	broadcaster.finish(sessionId, { type: "done", success: true });
}

/**
 * Hard-fail tear-down: status flip BEFORE kill so reconcile can't
 * silently promote a (running, null) row to stopped — same rule the
 * sync route enforces (PR 185b2a round 5). updateStatus is allowed to
 * throw here; logging only because the broadcaster will still send a
 * `fail` message and the user sees the failure regardless. The stale
 * row will be cleaned up by an operator or a follow-up reconcile-aware
 * pass.
 */
async function failSession(
	sessionId: string,
	sessions: SessionManager,
	docker: DockerManager,
): Promise<void> {
	try {
		await sessions.updateStatus(sessionId, "failed");
	} catch (err) {
		logger.error(
			`[bootstrap] CRITICAL: could not flip session ${sessionId} to failed: ${(err as Error).message}. ` +
				"Container will still be killed below; row likely shows running. Manual D1 update needed.",
		);
	}
	await docker.kill(sessionId).catch((err) => {
		logger.error(
			`[bootstrap] CRITICAL: kill after failed postCreate ${sessionId} threw: ${(err as Error).message}. ` +
				"Container may need manual `docker rm`.",
		);
	});
}
