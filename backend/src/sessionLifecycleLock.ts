/**
 * sessionLifecycleLock.ts — per-session lock for lifecycle operations
 * (CONVERSATION.md §2.7.2, precondition 1; 3.0d).
 *
 * `start`, `stop`, `kill`, `delete` (soft and hard, purge included), the
 * initial `create` (from before its row exists until 201 or rollback)
 * and, from 3.0d on, `recreate` take the same lock, so two of them never run
 * on one session at once. Without it, the recreation's guarantees are
 * hollow: a `DELETE ?hard=true` racing a recreation could purge the
 * workspace while the new container is starting on it.
 *
 * In-process only — valid while the deployment runs a single backend
 * (the documented shape). Several backends would need a lock in D1.
 *
 * Two acquisition modes, both FIFO per session:
 *   - `wait`: queue behind the holder for at most `maxWaitMs`, then fail
 *     with `SessionBusyError` without running. The default cap is the
 *     contract's T_rec + T_rb (6 min), the longest a recreation can hold
 *     the lock before it must let go.
 *   - `fail`: if anyone holds or is queued for the lock, fail at once.
 *     `recreate` uses this (it never waits), and so does the idle sweeper,
 *     which retries on its next sweep instead of stalling every other
 *     session behind one busy one.
 */

/** T_rec (5 min) + T_rb (60 s), CONVERSATION.md §2.7.4. */
export const LIFECYCLE_LOCK_MAX_WAIT_MS = 6 * 60 * 1000;

export type LifecycleOp =
	| "create"
	| "start"
	| "stop"
	| "kill"
	| "delete"
	| "recreate"
	| "recreate-resolve"
	// `PATCH …/conversation {enabled:true}` (#464 R1): it writes the marker
	// and the hooks file, so it must not interleave with a delete, a start
	// or a recreation. Disable and the emergency CLI never take the lock.
	| "enable"
	// `PATCH /sessions/:id/ports` (3.0d audit A2): the recreation's step 6 and
	// its resolution rewrite the port mappings from the config they read
	// under this lock; a ports edit between that read and the write would be
	// overwritten — a port made private or removed coming back public.
	| "ports"
	// 3.2 composer (CONVERSATION.md §8.1.4): a SEPARATE lock instance keyed by
	// session + pane, not the session lock. `composer-send` is held by the
	// executor for its whole active phase; `composer-admin` is what the
	// resolution, the reconciliation and the recovery take — in `fail` mode,
	// so an active executor answers them 409 instead of being waited for.
	| "composer-send"
	| "composer-admin";

export class SessionBusyError extends Error {
	readonly code = "busy";
	constructor(
		readonly sessionId: string,
		readonly op: LifecycleOp,
		readonly heldBy: LifecycleOp | null,
	) {
		super(`session ${sessionId} is busy${heldBy ? ` (${heldBy} in progress)` : ""}`);
		this.name = "SessionBusyError";
	}
}

interface Waiter {
	op: LifecycleOp;
	grant: () => void;
	timer: ReturnType<typeof setTimeout> | null;
}

interface Entry {
	holder: LifecycleOp;
	queue: Waiter[];
}

export interface AcquireOptions {
	mode?: "wait" | "fail";
	maxWaitMs?: number;
}

/**
 * Checked under the lock, before `fn`, for every op but `create` (a fresh
 * id has no history) and `recreate-resolve` — the resolution of an
 * unresolved attempt by the process run that owns it (recreate/engine.ts).
 * That pass is what the gate is waiting for: gating it would be the
 * attempt blocking itself, while it still needs the lock so no other
 * lifecycle verb interleaves with its mutations. 3.0d installs the `recreate-unresolved` gate here
 * (recreateAttempt.ts, CONVERSATION.md §2.7.4) so no lifecycle operation
 * can run while a recreation of the session is unresolved — one choke
 * point instead of a check per route.
 */
export type LifecycleGuard = (sessionId: string, op: LifecycleOp) => Promise<void>;

export class SessionLifecycleLock {
	private readonly entries = new Map<string, Entry>();
	private guard: LifecycleGuard | null = null;

	setGuard(guard: LifecycleGuard | null): void {
		this.guard = guard;
	}

	/**
	 * Run `fn` holding the session's lock. The lock is released when `fn`
	 * settles, whether it resolves or throws, and handed to the next
	 * waiter in arrival order.
	 */
	async run<T>(
		sessionId: string,
		op: LifecycleOp,
		fn: () => Promise<T>,
		opts: AcquireOptions = {},
	): Promise<T> {
		await this.acquire(sessionId, op, opts);
		try {
			// Inside the try: a refusing guard still releases the lock.
			if (op !== "create" && op !== "recreate-resolve" && this.guard) {
				await this.guard(sessionId, op);
			}
			return await fn();
		} finally {
			this.release(sessionId);
		}
	}

	/** The operation holding the lock, or null. For diagnostics and tests. */
	heldBy(sessionId: string): LifecycleOp | null {
		return this.entries.get(sessionId)?.holder ?? null;
	}

	/** Number of callers queued behind the holder. */
	queued(sessionId: string): number {
		return this.entries.get(sessionId)?.queue.length ?? 0;
	}

	private acquire(sessionId: string, op: LifecycleOp, opts: AcquireOptions): Promise<void> {
		const entry = this.entries.get(sessionId);
		if (!entry) {
			this.entries.set(sessionId, { holder: op, queue: [] });
			return Promise.resolve();
		}
		if ((opts.mode ?? "wait") === "fail") {
			return Promise.reject(new SessionBusyError(sessionId, op, entry.holder));
		}
		const maxWaitMs = opts.maxWaitMs ?? LIFECYCLE_LOCK_MAX_WAIT_MS;
		return new Promise<void>((resolve, reject) => {
			const waiter: Waiter = {
				op,
				grant: () => {
					if (waiter.timer) clearTimeout(waiter.timer);
					resolve();
				},
				timer: null,
			};
			waiter.timer = setTimeout(() => {
				// Still queued (a granted waiter is no longer in the queue):
				// leave without ever having run.
				const i = entry.queue.indexOf(waiter);
				if (i >= 0) entry.queue.splice(i, 1);
				reject(new SessionBusyError(sessionId, op, entry.holder));
			}, maxWaitMs);
			entry.queue.push(waiter);
		});
	}

	private release(sessionId: string): void {
		const entry = this.entries.get(sessionId);
		if (!entry) return;
		const next = entry.queue.shift();
		if (!next) {
			// Nothing queued: drop the entry so the map only holds sessions
			// with work in progress.
			this.entries.delete(sessionId);
			return;
		}
		entry.holder = next.op;
		next.grant();
	}
}

/** The process-wide instance every lifecycle caller shares. */
export const sessionLifecycleLock = new SessionLifecycleLock();
