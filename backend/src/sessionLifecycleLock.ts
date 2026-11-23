/**
 * sessionLifecycleLock.ts — per-session lock for lifecycle operations.
 *
 * `start`, `stop`, `kill`, `delete` (soft and hard, purge included) and
 * the initial `create` (from before its row exists until 201 or rollback)
 * take the same lock, so two of them never run on one session at once —
 * e.g. a `DELETE ?hard=true` can never purge the workspace while a
 * `/start` is bringing a container up on it.
 *
 * In-process only — valid while the deployment runs a single backend
 * (the documented shape). Several backends would need a lock in D1.
 *
 * Two acquisition modes, both FIFO per session:
 *   - `wait`: queue behind the holder for at most `maxWaitMs`, then fail
 *     with `SessionBusyError` without running.
 *   - `fail`: if anyone holds or is queued for the lock, fail at once.
 *     The idle sweeper uses this: it retries on its next sweep instead of
 *     stalling every other session behind one busy one.
 */

/** Default cap of a `wait` acquisition. */
export const LIFECYCLE_LOCK_MAX_WAIT_MS = 6 * 60 * 1000;

export type LifecycleOp =
	| "create"
	| "start"
	| "stop"
	| "kill"
	| "delete"
	// `PATCH /sessions/:id/ports`: the edit rewrites the port mappings, so it
	// must not interleave with a start/stop that rewrites or clears them.
	| "ports";

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

export class SessionLifecycleLock {
	private readonly entries = new Map<string, Entry>();

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
