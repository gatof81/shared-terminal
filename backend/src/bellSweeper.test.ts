import { beforeEach, describe, expect, it, vi } from "vitest";
import { BellSweeper } from "./bellSweeper.js";

function makeSweeper(opts: {
	running?: Array<{ sessionId: string; userId: string; name: string }>;
	listeners?: Set<string>;
	bells?: Set<string>;
}) {
	const running = opts.running ?? [{ sessionId: "s1", userId: "u1", name: "sess" }];
	const listeners = opts.listeners ?? new Set<string>();
	const bells = opts.bells ?? new Set<string>();
	const sendToUser = vi.fn(async () => undefined);
	const sweeper = new BellSweeper({
		hasLiveListeners: (id) => listeners.has(id),
		readBellFlag: async (id) => bells.has(id),
		sendToUser,
		listRunningSessions: async () => running,
		sweepIntervalMs: 999_999,
	});
	return { sweeper, sendToUser, listeners, bells };
}

describe("BellSweeper.runSweep", () => {
	it("pushes to the owner when the user is away and a bell is pending", async () => {
		const { sweeper, sendToUser } = makeSweeper({ bells: new Set(["s1"]) });
		await sweeper.runSweep();
		expect(sendToUser).toHaveBeenCalledTimes(1);
		const [userId, payload] = sendToUser.mock.calls[0]!;
		expect(userId).toBe("u1");
		expect(payload).toMatchObject({ sessionId: "s1" });
		expect(payload.body).toContain("sess");
	});

	it("pushes only ONCE per bell episode across repeated sweeps (flag stays set while away)", async () => {
		const { sweeper, sendToUser } = makeSweeper({ bells: new Set(["s1"]) });
		await sweeper.runSweep();
		await sweeper.runSweep();
		await sweeper.runSweep();
		expect(sendToUser).toHaveBeenCalledTimes(1);
	});

	it("does NOT push when a browser is attached (user present)", async () => {
		const { sweeper, sendToUser } = makeSweeper({
			listeners: new Set(["s1"]),
			bells: new Set(["s1"]),
		});
		await sweeper.runSweep();
		expect(sendToUser).not.toHaveBeenCalled();
	});

	it("does NOT push when there is no pending bell", async () => {
		const { sweeper, sendToUser } = makeSweeper({ bells: new Set() });
		await sweeper.runSweep();
		expect(sendToUser).not.toHaveBeenCalled();
	});

	it("re-arms after the bell flag clears — a later bell notifies again", async () => {
		const bells = new Set<string>(["s1"]);
		const { sweeper, sendToUser } = makeSweeper({ bells });
		await sweeper.runSweep(); // push #1
		bells.delete("s1"); // user viewed it (reattached) → flag cleared
		await sweeper.runSweep(); // re-arm
		bells.add("s1"); // new bell
		await sweeper.runSweep(); // push #2
		expect(sendToUser).toHaveBeenCalledTimes(2);
	});

	it("re-arms after the user attaches then leaves — the next away-bell notifies again", async () => {
		const listeners = new Set<string>();
		const bells = new Set<string>(["s1"]);
		const { sweeper, sendToUser } = makeSweeper({ listeners, bells });
		await sweeper.runSweep(); // away + bell → push #1
		listeners.add("s1"); // user reattaches (present)
		await sweeper.runSweep(); // present → mark cleared, no push
		listeners.delete("s1"); // leaves again, bell still pending
		await sweeper.runSweep(); // away + bell → push #2
		expect(sendToUser).toHaveBeenCalledTimes(2);
	});

	it("prunes notify-marks for sessions that stopped running", async () => {
		let running = [{ sessionId: "s1", userId: "u1", name: "sess" }];
		const bells = new Set<string>(["s1"]);
		const sendToUser = vi.fn(async () => undefined);
		const sweeper = new BellSweeper({
			hasLiveListeners: () => false,
			readBellFlag: async (id) => bells.has(id),
			sendToUser,
			listRunningSessions: async () => running,
			sweepIntervalMs: 999_999,
		});
		await sweeper.runSweep(); // push #1, s1 marked notified
		running = []; // s1 stops → pruned from notified on next sweep
		await sweeper.runSweep();
		running = [{ sessionId: "s1", userId: "u1", name: "sess" }]; // restarts, bell still set
		await sweeper.runSweep(); // mark was pruned → push #2
		expect(sendToUser).toHaveBeenCalledTimes(2);
	});

	it("isolates a per-session failure — the others still get processed", async () => {
		const sendToUser = vi.fn(async () => undefined);
		const sweeper = new BellSweeper({
			hasLiveListeners: () => false,
			readBellFlag: async (id) => {
				if (id === "bad") throw new Error("docker down");
				return true;
			},
			sendToUser,
			listRunningSessions: async () => [
				{ sessionId: "bad", userId: "u1", name: "a" },
				{ sessionId: "good", userId: "u2", name: "b" },
			],
			sweepIntervalMs: 999_999,
		});
		await expect(sweeper.runSweep()).resolves.toBeUndefined();
		expect(sendToUser).toHaveBeenCalledTimes(1);
		expect(sendToUser.mock.calls[0]![0]).toBe("u2");
	});
});

describe("BellSweeper.start/stop", () => {
	beforeEach(() => vi.useFakeTimers());

	it("start is idempotent and stop halts the timer", async () => {
		const sendToUser = vi.fn(async () => undefined);
		const listRunningSessions = vi.fn(async () => []);
		const sweeper = new BellSweeper({
			hasLiveListeners: () => false,
			readBellFlag: async () => false,
			sendToUser,
			listRunningSessions,
			sweepIntervalMs: 1000,
		});
		sweeper.start();
		sweeper.start(); // no-op
		await vi.advanceTimersByTimeAsync(1000);
		expect(listRunningSessions).toHaveBeenCalledTimes(1);
		sweeper.stop();
		await vi.advanceTimersByTimeAsync(3000);
		expect(listRunningSessions).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});
});
