/**
 * recreate/run.ts — one recreation attempt's epoch and its Docker
 * requests in flight (CONVERSATION.md §2.7.4).
 *
 * "A timeout does not mean the operation finished." Docker may apply a
 * request after we stop waiting for it, so:
 *
 *   - no request of the attempt is ever aborted on the client: the
 *     deadline only stops WAITING. The promise stays tracked until dockerd
 *     answers, and that answer (success or error) is the evidence of how
 *     the request ended;
 *   - the epoch closes when the deadline passes (or the caller closes it
 *     to roll back). After that, `call()` refuses to start anything, and a
 *     request that answers late never hands its result to the code that
 *     was waiting for it — that continuation gets `EpochClosedError`, so it
 *     cannot write D1, rename, create, start, write markers or seed;
 *   - `settled()` resolves only once every tracked request has answered.
 *     With a hung dockerd it never resolves, and the attempt stays
 *     `uncertain` for as long as that lasts. No time limit substitutes for
 *     the answer.
 *
 * Resolution, which runs after the epoch closed, issues its own requests
 * through `untimed()`: tracked the same way, never aborted, no deadline.
 */

export class EpochClosedError extends Error {
	readonly code = "epoch-closed";
	constructor(
		readonly label: string,
		readonly reason: string,
	) {
		super(`recreation epoch closed (${reason}) while waiting for ${label}`);
		this.name = "EpochClosedError";
	}
}

export interface Evidence {
	label: string;
	ok: boolean;
	/** Settled after the epoch had closed. */
	late: boolean;
	at: number;
}

export interface RunClock {
	now(): number;
}

const SYSTEM_CLOCK: RunClock = { now: () => Date.now() };

export class AttemptRun {
	readonly evidence: Evidence[] = [];
	private readonly inflight = new Map<number, string>();
	private nextId = 0;
	private closedReason: string | null = null;
	private idleWaiters: Array<() => void> = [];

	constructor(
		/** Absolute deadline of the epoch (deps clock), i.e. lock time + T_rec. */
		readonly deadline: number,
		private readonly clock: RunClock = SYSTEM_CLOCK,
	) {}

	get epochOpen(): boolean {
		return this.closedReason === null;
	}

	get closeReason(): string | null {
		return this.closedReason;
	}

	remaining(): number {
		return Math.max(0, this.deadline - this.clock.now());
	}

	close(reason: string): void {
		if (this.closedReason === null) this.closedReason = reason;
	}

	inflightLabels(): string[] {
		return [...this.inflight.values()];
	}

	/**
	 * A forward step's Docker request: started only while the epoch is
	 * open, waited for at most until the epoch deadline, and its outcome
	 * handed back only if the epoch is still open when it arrives.
	 */
	async call<T>(label: string, fn: () => Promise<T>): Promise<T> {
		if (!this.epochOpen) throw new EpochClosedError(label, this.closedReason as string);
		const remaining = this.deadline - this.clock.now();
		if (remaining <= 0) {
			this.close("T_rec");
			throw new EpochClosedError(label, "T_rec");
		}
		const p = this.track(label, fn);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const expired = new Promise<"expired">((r) => {
			timer = setTimeout(() => r("expired"), remaining);
		});
		try {
			const r = await Promise.race([
				p.then(
					(v) => ({ ok: true as const, v }),
					(e: unknown) => ({ ok: false as const, e }),
				),
				expired,
			]);
			if (r === "expired") {
				this.close("T_rec");
				throw new EpochClosedError(label, "T_rec");
			}
			// The answer arrived, but the epoch may have closed meanwhile
			// (another step's deadline, a rollback): no continuation then.
			if (!this.epochOpen) throw new EpochClosedError(label, this.closedReason as string);
			if (!r.ok) throw r.e;
			return r.v;
		} finally {
			clearTimeout(timer);
		}
	}

	/** A resolution request: tracked as evidence, never aborted, no deadline. */
	untimed<T>(label: string, fn: () => Promise<T>): Promise<T> {
		return this.track(label, fn);
	}

	/** Resolves when no tracked request is in flight. */
	settled(): Promise<void> {
		if (this.inflight.size === 0) return Promise.resolve();
		return new Promise((r) => this.idleWaiters.push(r));
	}

	private track<T>(label: string, fn: () => Promise<T>): Promise<T> {
		const id = this.nextId++;
		this.inflight.set(id, label);
		// `fn` runs inside the promise chain so a synchronous throw is a
		// rejection like any other answer.
		const p = Promise.resolve().then(fn);
		const done = (ok: boolean) => {
			this.inflight.delete(id);
			this.evidence.push({ label, ok, late: !this.epochOpen, at: this.clock.now() });
			if (this.inflight.size === 0) {
				const waiters = this.idleWaiters;
				this.idleWaiters = [];
				for (const w of waiters) w();
			}
		};
		p.then(
			() => done(true),
			() => done(false),
		);
		return p;
	}
}
