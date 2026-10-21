/**
 * inFlightLimiter.ts — caps CONCURRENT work, per key and process-wide.
 *
 * express-rate-limit bounds requests per window, which says nothing about
 * how many are in flight at once: a 300/min budget can all arrive in the
 * same second, and each Workspace Explorer preview holds a buffer (text)
 * or an fd + socket (image stream) until the client drains it. A slow or
 * deliberately non-reading client makes that pile up. This bounds the
 * pile: at most `perKey` concurrent operations per user, and `total`
 * across the process so many users together can't exhaust memory/fds.
 *
 * Process-local and in-memory, like every other limiter here.
 */
export class InFlightLimiter {
	private readonly byKey = new Map<string, number>();
	private total = 0;

	constructor(
		private readonly perKey: number,
		private readonly maxTotal: number,
	) {}

	/**
	 * Reserve a slot. Returns a release function (idempotent — safe to call
	 * from both a `finally` and a `close` handler), or null when either cap
	 * is full and the caller should answer 429.
	 */
	tryAcquire(key: string): (() => void) | null {
		const current = this.byKey.get(key) ?? 0;
		if (current >= this.perKey || this.total >= this.maxTotal) return null;
		this.byKey.set(key, current + 1);
		this.total++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.total--;
			const n = (this.byKey.get(key) ?? 1) - 1;
			if (n <= 0) this.byKey.delete(key);
			else this.byKey.set(key, n);
		};
	}

	/** For tests / stats. */
	inFlight(key?: string): number {
		return key === undefined ? this.total : (this.byKey.get(key) ?? 0);
	}
}
