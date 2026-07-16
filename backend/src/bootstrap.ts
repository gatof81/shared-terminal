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

import { runAgentSeed } from "./bootstrap/agentSeed.js";
import { runCloneRepo } from "./bootstrap/cloneRepo.js";
import { runDotfiles } from "./bootstrap/dotfiles.js";
import { runGitIdentity } from "./bootstrap/gitIdentity.js";
import { runWriteEnvFile } from "./bootstrap/writeEnvFile.js";
import { d1Query } from "./db.js";
import type { DockerManager } from "./dockerManager.js";
import { logger } from "./logger.js";
import { decryptStoredEntries, getSessionConfig } from "./sessionConfig.js";
import type { SessionManager } from "./sessionManager.js";

/**
 * Total bootstrap wall-clock cap. Beyond this, the in-flight stage
 * is aborted (the stream destroy in `streamExec` unblocks the
 * promise) and the session is hard-failed with a "bootstrap
 * timeout" message in the WS stream. Sized per the issue spec
 * (#191): generous enough for a chunky `npm install` plus dotfiles
 * + repo clone, tight enough that a session stuck on a non-
 * responsive remote doesn't pin a quota slot indefinitely.
 *
 * Note: aborting the streamExec only closes the host-side stream;
 * the in-container process continues until `failSession` kills the
 * container itself. Both happen on the timeout path, in that order.
 */
const BOOTSTRAP_WALL_CLOCK_CAP_MS = 10 * 60 * 1000;

/**
 * Maximum bytes of captured bootstrap output to persist on the row
 * (#274). A chatty postCreate (`npm install` produces ~30 KB of
 * progress lines) shouldn't bloat the sessions table; we keep the
 * LAST N bytes so the tail — where the failure message lives — is
 * always present, and head-trim drops earlier noise once we go over.
 * 64 KiB matches the typical 80×24×80 terminal scrollback the user
 * sees in the live modal.
 */
export const BOOTSTRAP_LOG_MAX_BYTES = 64 * 1024;

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

/**
 * Wire format for the `/ws/bootstrap/<sessionId>` channel. Note the
 * `stage?` field on the `fail` variant (#252): the runner walks five
 * stages (gitIdentity / clone / dotfiles / agentSeed / postCreate)
 * and the failure UI MUST be able to tell the user which one tripped.
 * The default for stage on a synthetic fail (route catch-all) is
 * omitted, which the frontend renders as a generic "bootstrap failed".
 */
export type BootstrapMessage =
	| { type: "output"; data: string }
	| { type: "done"; success: true }
	| { type: "fail"; exitCode: number; error?: string; stage?: string };

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
	cfg: BootstrapRunCfg,
	deps: BootstrapRunDeps,
): Promise<void> {
	// #348 — register this run so the SIGTERM shutdown path can abort it
	// and AWAIT its failure teardown (drainInFlightBootstraps below).
	// The route invokes this at most once per session create, so a plain
	// sessionId-keyed Map can't clobber a concurrent sibling.
	const abortController = new AbortController();
	let settle!: () => void;
	const done = new Promise<void>((resolve) => {
		settle = resolve;
	});
	inFlight.set(sessionId, { controller: abortController, done });
	try {
		await runBootstrapPipeline(sessionId, cfg, deps, abortController);
	} finally {
		settle();
		inFlight.delete(sessionId);
	}
}

interface BootstrapRunCfg {
	postCreateCmd?: string;
	postStartCmd?: string;
	/** True iff any of {repo, gitIdentity, dotfiles, agentSeed} is
	 *  configured — the hint that gates the `getSessionConfig` D1
	 *  fetch. Renamed from the older `hasRepo` (#214 round 2)
	 *  because 191b adds three more stages that all need the
	 *  config row. The route computes this from `validatedConfig`. */
	hasBootstrapConfig?: boolean;
}

interface BootstrapRunDeps {
	sessions: SessionManager;
	docker: DockerManager;
	broadcaster: BootstrapBroadcaster;
}

// ── Runtime-readiness gate (#393) ───────────────────────────────────────────

/** Cap on how long the pipeline waits for the entrypoint's readiness
 *  sentinel before proceeding anyway. Generous relative to the ~1-5 s
 *  a first boot's `cp -a` of the CLI install takes, because the only
 *  cost of waiting is bootstrap latency — while proceeding too early
 *  reintroduces the `claude: command not found` race the gate exists
 *  to close. Pre-sentinel images (no file, ever) pay this once per
 *  bootstrap until recycled onto the rebuilt image. */
export const RUNTIME_READY_WAIT_CAP_MS = 60_000;
export const RUNTIME_READY_POLL_INTERVAL_MS = 500;

/** Poll `docker.isRuntimeReady` until true / timeout / abort. Never
 *  throws and never fails the session: a probe error means the
 *  container is being torn down under us (or the daemon hiccuped) and
 *  the first real stage will surface that through runStage's proper
 *  teardown; a timeout means a pre-sentinel image, which must keep
 *  working. Exported for tests. */
export async function waitForRuntimeReady(
	sessionId: string,
	docker: DockerManager,
	onOutput: (chunk: string) => void,
	signal: AbortSignal,
): Promise<void> {
	const startedAt = Date.now();
	let announced = false;
	while (!signal.aborted) {
		try {
			if (await docker.isRuntimeReady(sessionId)) {
				if (announced) {
					onOutput(
						`[bootstrap] runtime ready after ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`,
					);
				}
				return;
			}
		} catch (err) {
			logger.warn(
				`[bootstrap] runtime-readiness probe failed for session ${sessionId}: ${(err as Error).message}; proceeding`,
			);
			return;
		}
		if (!announced) {
			announced = true;
			onOutput("[bootstrap] waiting for container runtime to finish provisioning…\n");
		}
		if (Date.now() - startedAt >= RUNTIME_READY_WAIT_CAP_MS) {
			logger.warn(
				`[bootstrap] runtime-readiness sentinel never appeared for session ${sessionId} ` +
					`after ${RUNTIME_READY_WAIT_CAP_MS / 1000}s (pre-#393 image?); proceeding`,
			);
			onOutput(
				"[bootstrap] WARN: runtime readiness not confirmed — container may be from a " +
					"pre-upgrade image; proceeding\n",
			);
			return;
		}
		await new Promise((r) => setTimeout(r, RUNTIME_READY_POLL_INTERVAL_MS));
	}
}

// ── In-flight registry (#348) ──────────────────────────────────────────────
// sessionId → this run's AbortController + a promise that settles once the
// pipeline (INCLUDING its failure teardown) has finished. Exists so a
// graceful shutdown can leave interrupted sessions in the terminal `failed`
// state instead of stranding them half-provisioned at status='running'
// with bootstrapped_at NULL — a state nothing ever resumes (the postCreate
// gate only runs on the create path) and nothing reports.
const inFlight = new Map<string, { controller: AbortController; done: Promise<void> }>();

/**
 * #348 — abort every in-flight bootstrap and wait for their failure
 * teardown to complete (status flip to `failed`, log persisted with the
 * abort reason, container killed — the same finishWithFail machinery the
 * 10-min cap uses). Called from the SIGTERM/SIGINT shutdown path in
 * index.ts, bounded there by the shutdown watchdog.
 *
 * Known gap, accepted: SIGKILL (or a host power cut) runs no drain, so
 * those rows still strand at running/NULL. Closing that would need a
 * reconcile()-side "requires bootstrap but never bootstrapped" probe that
 * parses each running session's config — deferred until it bites.
 */
export async function drainInFlightBootstraps(): Promise<void> {
	if (inFlight.size === 0) return;
	logger.warn(`[bootstrap] shutdown: aborting ${inFlight.size} in-flight bootstrap run(s)`);
	// Snapshot the settle promises BEFORE aborting — each run's finally
	// deletes its own entry, so iterating inFlight after the aborts start
	// resolving would race the deletions.
	const settled = [...inFlight.values()].map((e) => e.done);
	for (const { controller } of inFlight.values()) {
		controller.abort(new DOMException("backend shutting down", "AbortError"));
	}
	await Promise.allSettled(settled);
}

async function runBootstrapPipeline(
	sessionId: string,
	cfg: BootstrapRunCfg,
	deps: BootstrapRunDeps,
	abortController: AbortController,
): Promise<void> {
	const { sessions, docker, broadcaster } = deps;
	// #274 — accumulate every broadcast chunk into a bounded tail
	// buffer so a failed session's captured output survives after the
	// WS modal closes. Persisted to `sessions.bootstrap_log` on the
	// terminal `done`/`fail` branch. `BOOTSTRAP_LOG_MAX_BYTES` is a
	// soft cap; if the pipeline emits more we keep the LAST N bytes
	// (postCreate errors are at the tail, which is the part the user
	// actually needs to debug).
	const logChunks: string[] = [];
	let logBytes = 0;
	const onOutput = (chunk: string) => {
		broadcaster.broadcast(sessionId, chunk);
		logChunks.push(chunk);
		// `Buffer.byteLength(chunk, "utf-8")`, NOT `chunk.length`. The
		// cap constant is named `BOOTSTRAP_LOG_MAX_BYTES` and the
		// sibling BootstrapBroadcaster.broadcast measures UTF-8 bytes
		// too — using `.length` (UTF-16 code units) would undercount
		// CJK / emoji output by up to 4x and silently let the stored
		// log exceed the cap. Matches the broadcaster's accounting.
		const chunkBytes = Buffer.byteLength(chunk, "utf-8");
		logBytes += chunkBytes;
		// Cheap front-trim — only fires when we're over the cap, so
		// the typical success path pays zero work. Drop whole chunks
		// from the head until we're back under the limit; the user
		// loses some early "Cloning into ..." noise but keeps the
		// stage that actually failed.
		while (logBytes > BOOTSTRAP_LOG_MAX_BYTES && logChunks.length > 1) {
			const head = logChunks.shift();
			if (head !== undefined) logBytes -= Buffer.byteLength(head, "utf-8");
		}
	};

	// Persist the accumulated log on a terminal event (success or
	// failure). Best-effort: if D1 hiccups, we log a warning and let
	// the broadcaster's terminal message go out anyway — the WS modal
	// shows everything regardless, and a missing log column is the
	// pre-#274 behaviour.
	const persistLog = async (): Promise<void> => {
		try {
			await sessions.setBootstrapLog(sessionId, logChunks.join(""));
		} catch (err) {
			logger.warn(
				`[bootstrap] failed to persist log for session ${sessionId}: ${(err as Error).message}`,
			);
		}
	};

	// 10-min wall-clock cap (#191 PR 191b). The controller (owned by the
	// runAsyncBootstrap wrapper since #348, so the shutdown drain can
	// abort it too) is aborted either by this timer, by a stage that
	// wants to short-circuit the rest of the pipeline, or by
	// drainInFlightBootstraps. `unref()` so the Node process can shut
	// down cleanly even if a runaway timer is still pending.
	const timer = setTimeout(() => {
		abortController.abort(new DOMException("bootstrap timeout", "TimeoutError"));
	}, BOOTSTRAP_WALL_CLOCK_CAP_MS);
	timer.unref();
	const signal = abortController.signal;

	const finishWithFail = async (msg: BootstrapMessage): Promise<void> => {
		clearTimeout(timer);
		// Persist BEFORE flipping status so a fast subsequent GET
		// /sessions/:id/bootstrap-log races against a populated log,
		// not an empty one. failSession itself does updateStatus +
		// kill; the log column is unrelated to that flip.
		await persistLog();
		await failSession(sessionId, sessions, docker);
		broadcaster.finish(sessionId, msg);
	};

	// Helper: run a stage and route any throw / non-zero exit through
	// the same status-flip-before-kill teardown. Returns true on
	// success (caller continues), false when the pipeline is done
	// (caller returns). Centralised so adding a future stage doesn't
	// require duplicating the four-line teardown block.
	const runStage = async (
		label: string,
		run: () => Promise<{ exitCode: number }>,
	): Promise<boolean> => {
		try {
			const { exitCode } = await run();
			if (exitCode !== 0) {
				// Include the stage label so the frontend can render
				// `"Bootstrap stage 'clone' failed (exit N)"` instead
				// of defaulting to the misleading "postCreate hook
				// failed" (#252).
				await finishWithFail({ type: "fail", exitCode, stage: label });
				return false;
			}
			return true;
		} catch (err) {
			// An abort surfaces here from two sources: the 10-min cap
			// timer, or the shutdown drain (#348). Distinguish them from
			// each other (via `signal.reason` — the timer aborts with a
			// DOMException named TimeoutError, the drain with one named
			// AbortError) and from any other throw, so the modal's
			// rendered error tells the user the right thing.
			//
			// PR #218 round 1 NIT: the discriminator must check that
			// the thrown error itself came FROM the abort path
			// (`AbortError` from streamExec, `TimeoutError` from the
			// timer's `abort(reason)` call) — NOT just `signal.aborted`.
			// Otherwise a stage that throws synchronously *after* the
			// abort has already fired (e.g. `DotfilesAuthMismatchError`
			// raised before the first await in `runDotfiles`) would be
			// misreported as timeout/shutdown and the user would
			// never see the actionable config error. `signal.aborted`
			// is kept as a sanity guard so an unrelated future
			// AbortError can't silently mark itself as abort-sourced.
			const e = err as Error;
			const isAborted = signal.aborted && (e.name === "AbortError" || e.name === "TimeoutError");
			const isTimeout = isAborted && (signal.reason as Error | undefined)?.name === "TimeoutError";
			const message = isTimeout
				? `bootstrap timeout: cumulative wall time exceeded ${BOOTSTRAP_WALL_CLOCK_CAP_MS / 1000}s during '${label}'`
				: isAborted
					? `bootstrap aborted during '${label}': backend shut down mid-provision — recreate the session`
					: e.message;
			logger.error(`[bootstrap] ${label} threw for session ${sessionId}: ${message}`);
			// Surface the abort reason in-stream so the user sees the
			// cap / shutdown, not just a generic fail. Routed through
			// `onOutput` (not `broadcaster.broadcast` directly) so the
			// line lands in `logChunks` and survives in the persisted
			// log — the abort reason is the single most useful line
			// for debugging an interrupted bootstrap, and a "View log"
			// modal that's missing it defeats the feature's purpose.
			if (isAborted) {
				onOutput(`\n${message}\n`);
			}
			await finishWithFail({
				type: "fail",
				exitCode: -1,
				error: message,
				stage: label,
			});
			return false;
		}
	};

	// Runtime-readiness gate (#393). container.start() returns when the
	// entrypoint PROCESS starts, not when the script completes — so
	// every stage below (and any postCreate hook that invokes a binary
	// from ~/.npm-global, e.g. `claude`) races the entrypoint's
	// symlink-swap window without this wait. Best-effort by design:
	// on timeout we WARN and proceed rather than fail, because a
	// container from a pre-sentinel image never writes the file and
	// hard-failing would brick every not-yet-recycled session on
	// upgrade. An abort (10-min cap / shutdown drain) just falls
	// through — the first real stage routes it through the proper
	// teardown messaging in runStage.
	await waitForRuntimeReady(sessionId, docker, onOutput, signal);

	// Load config once if any stage needs it. The hint gates this so
	// postCreate-only sessions (the pre-#188 steady-state) don't pay
	// for the D1 round-trip; it's only "free" for sessions that
	// genuinely have config-driven bootstrap stages to run.
	let config: Awaited<ReturnType<typeof getSessionConfig>> = null;
	if (cfg.hasBootstrapConfig) {
		try {
			config = await getSessionConfig(sessionId);
		} catch (err) {
			await finishWithFail({
				type: "fail",
				exitCode: -1,
				error: (err as Error).message,
			});
			return;
		}
		if (!config) {
			// Defensive: route guarantees the row exists when
			// `hasBootstrapConfig` is set, but a missing row shouldn't
			// crash the runner. Skip the config-driven stages and run
			// only the cmd-driven postCreate/postStart.
			logger.warn(
				`[bootstrap] hasBootstrapConfig=true but no session_configs row for ${sessionId}; skipping config-driven stages`,
			);
		}
	}

	// Stage order per #191 issue spec, extended by #277:
	//   1. git identity (cheap; needed if later stages commit)
	//   2. repo clone (#188)
	//   3. dotfiles
	//   4. agent seed
	//   5. writeEnvFile (#277 — must run AFTER clone so the `.env`
	//      doesn't sit in a directory `git clone` is about to refuse
	//      to populate; must run BEFORE postCreate so `npm install` /
	//      `pnpm i` / a custom hook can `source .env` or rely on
	//      `dotenv` finding a real file on disk)
	//   6. postCreate cmd
	if (config) {
		if (
			!(await runStage("gitIdentity", () =>
				runGitIdentity({
					sessionId,
					identity: config?.gitIdentity ?? null,
					docker,
					onOutput,
					signal,
				}),
			))
		)
			return;
		if (
			!(await runStage("clone", () =>
				runCloneRepo({ sessionId, config: config!, docker, onOutput, signal }),
			))
		)
			return;
		if (
			!(await runStage("dotfiles", () =>
				runDotfiles({
					sessionId,
					dotfiles: config?.dotfiles ?? null,
					storedAuth: config?.auth ?? null,
					docker,
					onOutput,
					signal,
				}),
			))
		)
			return;
		if (
			!(await runStage("agentSeed", () =>
				runAgentSeed({
					sessionId,
					agentSeed: config?.agentSeed ?? null,
					docker,
					onOutput,
					signal,
				}),
			))
		)
			return;
		// #277 — `.env` materialisation. Two invariants ride together
		// on the shape below:
		//
		//   1. Decrypt is gated on `writeEnvFile === true` so a session
		//      with secret envVars but the toggle off does NOT
		//      materialise plaintext on the heap (PR #278 round 1).
		//
		//   2. The decrypt call lives INSIDE `runStage`'s lambda, not
		//      hoisted into a const above it. `decryptSecret` throws
		//      on AES-GCM tag mismatch (tampered ciphertext, wrong
		//      key after rotation, D1 corruption); the throw must be
		//      caught by `runStage`'s try/catch so it lands as a
		//      `fail` broadcast with stage="writeEnvFile" AND
		//      `failSession` flips status to `failed` + kills the
		//      container. A throw outside the lambda escapes to the
		//      outer `.catch()` in routes.ts which only broadcasts
		//      `fail` and leaves the row at status=running with the
		//      container alive — a zombie the user sees as stuck
		//      (PR #278 round 2).
		if (
			!(await runStage("writeEnvFile", () =>
				runWriteEnvFile({
					sessionId,
					enabled: config?.writeEnvFile,
					envVars:
						config?.writeEnvFile === true && config.envVars && config.envVars.length > 0
							? decryptStoredEntries(config.envVars)
							: undefined,
					docker,
					onOutput,
					signal,
				}),
			))
		)
			return;
	}

	// postCreate. May be unset when only config-driven stages were
	// configured (e.g. clone + agentSeed without a hook). The 10-min
	// wall-clock cap applies here too (#301): the signal is forwarded so
	// the timer destroys the in-flight exec stream — a hook hanging on a
	// stalled `npm install` / registry is aborted instead of pinning the
	// quota slot. As with every other stage, the stream destroy only
	// unblocks the host-side promise; `failSession` kills the container to
	// stop the in-container process.
	if (cfg.postCreateCmd) {
		const ok = await runStage("postCreate", () =>
			docker.runPostCreate(sessionId, cfg.postCreateCmd!, onOutput, signal),
		);
		if (!ok) return;
	}

	// All blocking stages succeeded — clear the wall-clock cap timer
	// before markBootstrapped + postStart since those run after the
	// success broadcast and can take their own time without the cap
	// applying.
	clearTimeout(timer);

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
	// Persist the captured log on success too — a user who configured
	// a postCreate and wants to see what `npm install` printed can
	// inspect after the modal closes. Same best-effort shape as the
	// failure branch (warn on D1 hiccup, don't gate the terminal
	// broadcast on it).
	await persistLog();
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
