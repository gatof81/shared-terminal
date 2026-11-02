/**
 * authLock.ts — the one lock every auth transition takes, so the
 * transitions take effect in the order they were started (leaf, no
 * imports; unit-tested in authLock.test.ts).
 *
 * WHY a lock and not "ignore the stale answer": the cookie is not ours to
 * ignore. `POST /auth/logout` answers with a `Set-Cookie` that deletes
 * `st_token`, `POST /auth/login` with one that sets it, and the browser
 * applies each the moment the answer ARRIVES — before, and regardless of,
 * anything the page's JS does with the response. A logout answering after
 * the next login therefore deletes the new person's cookie, and neither
 * dropping its answer in JS nor `AbortController` proves otherwise (an
 * abort is a message racing the network; once the headers arrived the
 * jar has already changed). The only ordering the page controls is when
 * a request LEAVES: a login is never sent while a logout's answer may
 * still arrive, and vice versa.
 *
 * Modes: `exclusive` for the transitions that change the cookie (login,
 * register, logout); `shared` for `/auth/status`, which only reads it —
 * so a status probe never rides the cookie a logout in flight is about
 * to delete. Grants are FIFO: a shared request behind a waiting exclusive
 * one waits too (no barging), which is what makes "in the order started"
 * hold.
 *
 * Web Locks (`navigator.locks`) when the browser has it: the lock is then
 * shared by every tab of the origin, which share one cookie jar — a tab
 * logging in while another's logout is in flight waits for it too. It is
 * released when its holder's promise settles or the tab goes away. Without
 * it (old browsers, jsdom) an in-page queue with the same semantics orders
 * THIS tab only: a logout in another tab is not waited for, so the
 * cross-tab cookie guarantee holds only where Web Locks exist (every
 * current engine: Chromium, Firefox ≥ 96, Safari ≥ 15.4).
 *
 * Waiting can be bounded (`waitMs`): past it the caller gets
 * `AuthBusyError` and NOTHING was sent — aborting the wait for a lock is
 * safe, unlike aborting a request. A holder is never cut short.
 */

export const AUTH_LOCK_NAME = "st-auth-transition";

export type AuthLockMode = "exclusive" | "shared";

export class AuthBusyError extends Error {
	constructor() {
		super("Signing out is still finishing — try again in a moment.");
		this.name = "AuthBusyError";
	}
}

interface LockManagerLike {
	request<T>(
		name: string,
		options: { mode: AuthLockMode; signal?: AbortSignal },
		callback: () => Promise<T>,
	): Promise<T>;
}

function webLocks(): LockManagerLike | null {
	const nav = typeof navigator === "undefined" ? undefined : navigator;
	const locks = (nav as { locks?: LockManagerLike } | undefined)?.locks;
	return locks && typeof locks.request === "function" ? locks : null;
}

export async function withAuthLock<T>(
	mode: AuthLockMode,
	fn: () => Promise<T>,
	waitMs?: number,
): Promise<T> {
	const locks = webLocks();
	if (locks) return withWebLock(locks, mode, fn, waitMs);
	return withLocalLock(mode, fn, waitMs);
}

async function withWebLock<T>(
	locks: LockManagerLike,
	mode: AuthLockMode,
	fn: () => Promise<T>,
	waitMs?: number,
): Promise<T> {
	const controller = waitMs === undefined ? null : new AbortController();
	const timer = controller ? setTimeout(() => controller.abort(), waitMs) : undefined;
	let granted = false;
	try {
		return await locks.request(
			AUTH_LOCK_NAME,
			controller ? { mode, signal: controller.signal } : { mode },
			async () => {
				granted = true;
				// Once granted, the deadline is irrelevant: an abort now would
				// be ignored by the lock manager anyway; clear it so it fires
				// into nothing.
				if (timer !== undefined) clearTimeout(timer);
				return fn();
			},
		);
	} catch (err) {
		if (!granted && controller?.signal.aborted) throw new AuthBusyError();
		throw err;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

// ── In-page fallback ────────────────────────────────────────────────────────

interface Waiter {
	mode: AuthLockMode;
	grant: () => void;
}

const queue: Waiter[] = [];
let exclusiveHeld = false;
let sharedHeld = 0;

function pump(): void {
	while (queue.length > 0) {
		const head = queue[0]!;
		if (head.mode === "exclusive") {
			if (exclusiveHeld || sharedHeld > 0) return;
			exclusiveHeld = true;
			queue.shift();
			head.grant();
			return;
		}
		if (exclusiveHeld) return;
		sharedHeld++;
		queue.shift();
		head.grant();
	}
}

async function withLocalLock<T>(
	mode: AuthLockMode,
	fn: () => Promise<T>,
	waitMs?: number,
): Promise<T> {
	await new Promise<void>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const waiter: Waiter = {
			mode,
			grant: () => {
				if (timer !== undefined) clearTimeout(timer);
				resolve();
			},
		};
		queue.push(waiter);
		if (waitMs !== undefined) {
			timer = setTimeout(() => {
				const i = queue.indexOf(waiter);
				if (i === -1) return; // granted in the same tick
				queue.splice(i, 1);
				// Leaving the queue may unblock the shared waiters behind it.
				pump();
				reject(new AuthBusyError());
			}, waitMs);
		}
		pump();
	});
	try {
		return await fn();
	} finally {
		if (mode === "exclusive") exclusiveHeld = false;
		else sharedHeld--;
		pump();
	}
}
