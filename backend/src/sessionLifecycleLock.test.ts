import { afterEach, describe, expect, it, vi } from "vitest";
import {
	LIFECYCLE_LOCK_MAX_WAIT_MS,
	SessionBusyError,
	SessionLifecycleLock,
} from "./sessionLifecycleLock.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("SessionLifecycleLock", () => {
	it("serialises operations on one session, in arrival order", async () => {
		const lock = new SessionLifecycleLock();
		const order: string[] = [];
		const gate = deferred();
		const first = lock.run("s1", "start", async () => {
			order.push("start:in");
			await gate.promise;
			order.push("start:out");
		});
		const second = lock.run("s1", "delete", async () => {
			order.push("delete");
		});
		const third = lock.run("s1", "stop", async () => {
			order.push("stop");
		});
		await Promise.resolve();
		expect(lock.heldBy("s1")).toBe("start");
		expect(lock.queued("s1")).toBe(2);
		expect(order).toEqual(["start:in"]);
		gate.resolve();
		await Promise.all([first, second, third]);
		expect(order).toEqual(["start:in", "start:out", "delete", "stop"]);
		expect(lock.heldBy("s1")).toBeNull();
	});

	it("does not serialise different sessions", async () => {
		const lock = new SessionLifecycleLock();
		const gate = deferred();
		const a = lock.run("s1", "start", () => gate.promise);
		let ranB = false;
		await lock.run("s2", "delete", async () => {
			ranB = true;
		});
		expect(ranB).toBe(true);
		gate.resolve();
		await a;
	});

	it("releases the lock when the holder throws, and the error reaches the caller", async () => {
		const lock = new SessionLifecycleLock();
		await expect(
			lock.run("s1", "start", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(lock.heldBy("s1")).toBeNull();
		await expect(lock.run("s1", "stop", async () => "ok")).resolves.toBe("ok");
	});

	it("mode fail: busy at once while held, without running", async () => {
		const lock = new SessionLifecycleLock();
		const gate = deferred();
		const holder = lock.run("s1", "delete", () => gate.promise);
		const fn = vi.fn(async () => undefined);
		const err = await lock.run("s1", "recreate", fn, { mode: "fail" }).catch((e) => e);
		expect(err).toBeInstanceOf(SessionBusyError);
		expect((err as SessionBusyError).heldBy).toBe("delete");
		expect(fn).not.toHaveBeenCalled();
		gate.resolve();
		await holder;
	});

	it("mode wait: past the cap the waiter leaves with busy, never runs, and the queue moves on", async () => {
		vi.useFakeTimers();
		const lock = new SessionLifecycleLock();
		const gate = deferred();
		const holder = lock.run("s1", "recreate", () => gate.promise);
		const late = vi.fn(async () => undefined);
		const waiting = lock.run("s1", "start", late).catch((e) => e);
		await vi.advanceTimersByTimeAsync(LIFECYCLE_LOCK_MAX_WAIT_MS - 1);
		expect(lock.queued("s1")).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		const err = await waiting;
		expect(err).toBeInstanceOf(SessionBusyError);
		expect(late).not.toHaveBeenCalled();
		expect(lock.queued("s1")).toBe(0);
		gate.resolve();
		await holder;
		expect(late).not.toHaveBeenCalled();
		expect(lock.heldBy("s1")).toBeNull();
	});

	it("a waiter granted before its cap is not cancelled by the timer", async () => {
		vi.useFakeTimers();
		const lock = new SessionLifecycleLock();
		const gate = deferred();
		const holder = lock.run("s1", "stop", () => gate.promise);
		const after = deferred();
		const next = lock.run("s1", "delete", () => after.promise, { maxWaitMs: 1000 });
		await vi.advanceTimersByTimeAsync(500);
		gate.resolve();
		await holder;
		expect(lock.heldBy("s1")).toBe("delete");
		await vi.advanceTimersByTimeAsync(5000);
		after.resolve();
		await expect(next).resolves.toBeUndefined();
	});

	it("the guard runs under the lock before fn: a refusal never runs fn, releases the lock and the queue moves on", async () => {
		const lock = new SessionLifecycleLock();
		const refusal = new Error("recreate-unresolved");
		const guard = vi.fn(async (_sid: string, op: string) => {
			if (op === "start") throw refusal;
		});
		lock.setGuard(guard);
		const gate = deferred();
		const holder = lock.run("s1", "stop", () => gate.promise);
		const refused = vi.fn(async () => undefined);
		const startP = lock.run("s1", "start", refused).catch((e) => e);
		const after = vi.fn(async () => "deleted");
		const deleteP = lock.run("s1", "delete", after);
		gate.resolve();
		await holder;
		expect(await startP).toBe(refusal);
		expect(refused).not.toHaveBeenCalled();
		await expect(deleteP).resolves.toBe("deleted");
		expect(guard.mock.calls.map((c) => c[1])).toEqual(["stop", "start", "delete"]);
		expect(lock.heldBy("s1")).toBeNull();
	});

	it("the guard is not consulted for create (a fresh id has no history)", async () => {
		const lock = new SessionLifecycleLock();
		const guard = vi.fn(async () => {
			throw new Error("never");
		});
		lock.setGuard(guard);
		await expect(lock.run("s-new", "create", async () => "ok")).resolves.toBe("ok");
		expect(guard).not.toHaveBeenCalled();
	});

	it("fail mode (the idle sweeper) is refused by the guard too", async () => {
		const lock = new SessionLifecycleLock();
		lock.setGuard(async () => {
			throw new Error("recreate-unresolved");
		});
		const stop = vi.fn(async () => undefined);
		await expect(lock.run("s1", "stop", stop, { mode: "fail" })).rejects.toThrow(
			"recreate-unresolved",
		);
		expect(stop).not.toHaveBeenCalled();
	});

	it("default cap is T_rec + T_rb (6 min)", () => {
		expect(LIFECYCLE_LOCK_MAX_WAIT_MS).toBe(6 * 60 * 1000);
	});
});
