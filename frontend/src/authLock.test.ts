import { afterEach, describe, expect, it, vi } from "vitest";

type Lock = typeof import("./authLock.js");

async function load(): Promise<Lock> {
	vi.resetModules();
	return import("./authLock.js");
}

function gate() {
	let open!: () => void;
	const promise = new Promise<void>((r) => {
		open = r;
	});
	return { promise, open };
}

async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

afterEach(() => {
	vi.useRealTimers();
});

describe("withAuthLock (in-page fallback)", () => {
	it("exclusive holders run one at a time, in the order they asked", async () => {
		const { withAuthLock } = await load();
		const order: string[] = [];
		const g1 = gate();
		const a = withAuthLock("exclusive", async () => {
			order.push("a+");
			await g1.promise;
			order.push("a-");
		});
		const b = withAuthLock("exclusive", async () => {
			order.push("b");
		});
		await settle();
		expect(order).toEqual(["a+"]);
		g1.open();
		await Promise.all([a, b]);
		expect(order).toEqual(["a+", "a-", "b"]);
	});

	it("shared holders run together; an exclusive one waits for all of them", async () => {
		const { withAuthLock } = await load();
		const order: string[] = [];
		const g = gate();
		const s1 = withAuthLock("shared", async () => {
			order.push("s1");
			await g.promise;
		});
		const s2 = withAuthLock("shared", async () => {
			order.push("s2");
			await g.promise;
		});
		const x = withAuthLock("exclusive", async () => {
			order.push("x");
		});
		await settle();
		expect(order).toEqual(["s1", "s2"]);
		g.open();
		await Promise.all([s1, s2, x]);
		expect(order).toEqual(["s1", "s2", "x"]);
	});

	it("a shared request behind a waiting exclusive one does not overtake it", async () => {
		const { withAuthLock } = await load();
		const order: string[] = [];
		const g = gate();
		const x1 = withAuthLock("exclusive", async () => {
			await g.promise;
			order.push("x1");
		});
		const x2 = withAuthLock("exclusive", async () => {
			order.push("x2");
		});
		const s = withAuthLock("shared", async () => {
			order.push("s");
		});
		g.open();
		await Promise.all([x1, x2, s]);
		expect(order).toEqual(["x1", "x2", "s"]);
	});

	it("a bounded wait gives up with AuthBusyError, runs nothing, and does not block the queue", async () => {
		vi.useFakeTimers();
		const { withAuthLock, AuthBusyError } = await load();
		const g = gate();
		const holder = withAuthLock("exclusive", () => g.promise);
		const ran = vi.fn(async () => {});
		const waiting = withAuthLock("exclusive", ran, 100);
		const rejected = expect(waiting).rejects.toBeInstanceOf(AuthBusyError);
		await vi.advanceTimersByTimeAsync(101);
		await rejected;
		expect(ran).not.toHaveBeenCalled();
		const next = vi.fn(async () => {});
		const after = withAuthLock("exclusive", next);
		g.open();
		await holder;
		await after;
		expect(next).toHaveBeenCalledOnce();
	});

	it("a holder that throws releases the lock", async () => {
		const { withAuthLock } = await load();
		await expect(
			withAuthLock("exclusive", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		await expect(withAuthLock("exclusive", async () => 42)).resolves.toBe(42);
	});
});
