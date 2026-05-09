import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({
		results: [] as unknown[],
		success: true as const,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	})),
}));
vi.mock("./db.js", () => dbStubs);

import {
	BootstrapBroadcaster,
	type BootstrapMessage,
	markBootstrapped,
	runAsyncBootstrap,
} from "./bootstrap.js";
import type { DockerManager } from "./dockerManager.js";
import type { SessionManager } from "./sessionManager.js";

beforeEach(() => {
	dbStubs.d1Query.mockReset();
});

describe("markBootstrapped", () => {
	it("issues a guarded UPDATE that only fires when bootstrapped_at IS NULL", async () => {
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [],
			success: true,
			meta: { changes: 1, duration: 0, last_row_id: 0 },
		});
		const won = await markBootstrapped("sess-1");
		expect(won).toBe(true);
		const [sql, params] = dbStubs.d1Query.mock.calls[0]!;
		expect(sql).toMatch(/UPDATE session_configs/);
		expect(sql).toMatch(/SET bootstrapped_at/);
		// The IS NULL predicate is the lock — without it two concurrent
		// callers would both think they won. Asserting on the SQL shape
		// so a future caller can't drop the predicate by mistake.
		expect(sql).toMatch(/WHERE session_id = \? AND bootstrapped_at IS NULL/);
		expect(params).toEqual(["sess-1"]);
	});

	// Concurrent retry: two callers race on the same row, the slower
	// one's UPDATE finds bootstrapped_at already set, changes === 0,
	// we return false so the caller can skip a duplicate run.
	it("returns false when another caller already won the race", async () => {
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		const won = await markBootstrapped("sess-1");
		expect(won).toBe(false);
	});

	// No row at all (bare-create session, hook never configured) is
	// treated as the race-loser path: changes === 0, returns false. The
	// caller should never reach this method without a postCreateCmd, but
	// degrading rather than throwing keeps the runner code simple.
	it("returns false when no session_configs row exists", async () => {
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		const won = await markBootstrapped("sess-missing");
		expect(won).toBe(false);
	});

	it("propagates D1 errors instead of silently swallowing", async () => {
		dbStubs.d1Query.mockRejectedValueOnce(new Error("D1 transient"));
		await expect(markBootstrapped("sess-1")).rejects.toThrow("D1 transient");
	});
});

// ── BootstrapBroadcaster (PR 185b2b) ──────────────────────────────────────

describe("BootstrapBroadcaster", () => {
	let broadcaster: BootstrapBroadcaster;
	let received: BootstrapMessage[];
	const flush = () => new Promise<void>((r) => setImmediate(r));

	beforeEach(() => {
		broadcaster = new BootstrapBroadcaster();
		received = [];
	});

	afterEach(() => {
		broadcaster.clearForTesting();
	});

	it("fans live broadcasts to all subscribers", async () => {
		const a: BootstrapMessage[] = [];
		const b: BootstrapMessage[] = [];
		broadcaster.subscribe("s1", (m) => a.push(m));
		broadcaster.subscribe("s1", (m) => b.push(m));
		await flush(); // microtask drains the (empty) replay queue

		broadcaster.broadcast("s1", "hello\n");
		expect(a).toEqual([{ type: "output", data: "hello\n" }]);
		expect(b).toEqual([{ type: "output", data: "hello\n" }]);
	});

	it("replays buffered output to a late subscriber", async () => {
		// Producer emits first; subscriber connects after.
		broadcaster.broadcast("s1", "early\n");
		broadcaster.subscribe("s1", (m) => received.push(m));
		await flush();
		expect(received).toEqual([{ type: "output", data: "early\n" }]);
	});

	it("delivers terminal message + buffered output to subscribers that joined after finish", async () => {
		broadcaster.broadcast("s1", "step1\n");
		broadcaster.finish("s1", { type: "done", success: true });
		broadcaster.subscribe("s1", (m) => received.push(m));
		await flush();
		expect(received).toEqual([
			{ type: "output", data: "step1\n" },
			{ type: "done", success: true },
		]);
	});

	it("ignores broadcasts after finish — runner shouldn't emit but if it does we don't surface stragglers", async () => {
		broadcaster.subscribe("s1", (m) => received.push(m));
		await flush();
		broadcaster.broadcast("s1", "before\n");
		broadcaster.finish("s1", { type: "fail", exitCode: 1 });
		broadcaster.broadcast("s1", "after\n");
		expect(received).toEqual([
			{ type: "output", data: "before\n" },
			{ type: "fail", exitCode: 1 },
		]);
	});

	it("unsubscribe stops further deliveries", async () => {
		const unsubscribe = broadcaster.subscribe("s1", (m) => received.push(m));
		await flush();
		unsubscribe();
		broadcaster.broadcast("s1", "after-unsub\n");
		expect(received).toEqual([]);
	});

	it("isolates per-session state — broadcast on s1 doesn't reach s2 listener", async () => {
		const onS1: BootstrapMessage[] = [];
		const onS2: BootstrapMessage[] = [];
		broadcaster.subscribe("s1", (m) => onS1.push(m));
		broadcaster.subscribe("s2", (m) => onS2.push(m));
		await flush();
		broadcaster.broadcast("s1", "x");
		expect(onS1).toEqual([{ type: "output", data: "x" }]);
		expect(onS2).toEqual([]);
	});
});

// ── runAsyncBootstrap (PR 185b2b) ─────────────────────────────────────────

describe("runAsyncBootstrap", () => {
	function makeFakes(): {
		sessions: SessionManager;
		docker: DockerManager;
		broadcaster: BootstrapBroadcaster;
		final: BootstrapMessage[];
		spies: {
			updateStatus: ReturnType<typeof vi.fn>;
			kill: ReturnType<typeof vi.fn>;
			runPostCreate: ReturnType<typeof vi.fn>;
			runPostStart: ReturnType<typeof vi.fn>;
		};
	} {
		const updateStatus = vi.fn(async () => undefined);
		const kill = vi.fn(async () => undefined);
		const runPostCreate = vi.fn();
		const runPostStart = vi.fn(async () => undefined);
		const sessions = { updateStatus } as unknown as SessionManager;
		const docker = { kill, runPostCreate, runPostStart } as unknown as DockerManager;
		const broadcaster = new BootstrapBroadcaster();
		const final: BootstrapMessage[] = [];
		broadcaster.subscribe("sess-1", (m) => {
			if (m.type === "done" || m.type === "fail") final.push(m);
		});
		return {
			sessions,
			docker,
			broadcaster,
			final,
			spies: { updateStatus, kill, runPostCreate, runPostStart },
		};
	}

	const settle = () => new Promise<void>((r) => setImmediate(r));

	it("success path: streams output, marks bootstrapped, runs postStart, broadcasts done", async () => {
		const { sessions, docker, broadcaster, final, spies } = makeFakes();
		spies.runPostCreate.mockImplementation(
			async (_id: string, _cmd: string, onOutput: (s: string) => void) => {
				onOutput("step1\n");
				onOutput("step2\n");
				return { exitCode: 0 };
			},
		);
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [],
			success: true,
			meta: { changes: 1, duration: 0, last_row_id: 0 },
		});

		await runAsyncBootstrap(
			"sess-1",
			{ postCreateCmd: "npm install", postStartCmd: "npm run dev" },
			{ sessions, docker, broadcaster },
		);
		await settle();

		expect(spies.updateStatus).not.toHaveBeenCalled();
		expect(spies.kill).not.toHaveBeenCalled();
		expect(spies.runPostStart).toHaveBeenCalledWith("sess-1", "npm run dev");
		// markBootstrapped fired the UPDATE on session_configs.
		expect(dbStubs.d1Query).toHaveBeenCalled();
		expect(final).toEqual([{ type: "done", success: true }]);
	});

	// Round-5 of PR 185b2a settled the order: status flip BEFORE kill,
	// so reconcile never sees a (running, null) row that it would
	// silently promote to stopped. Same rule applies to the async runner.
	it("fail path: flips status to failed BEFORE kill, broadcasts fail with exitCode", async () => {
		const { sessions, docker, broadcaster, final, spies } = makeFakes();
		const order: string[] = [];
		spies.updateStatus.mockImplementation(async () => {
			order.push("updateStatus");
		});
		spies.kill.mockImplementation(async () => {
			order.push("kill");
		});
		spies.runPostCreate.mockImplementation(
			async (_id: string, _cmd: string, onOutput: (s: string) => void) => {
				onOutput("npm ERR! ENOENT\n");
				return { exitCode: 1 };
			},
		);

		await runAsyncBootstrap(
			"sess-1",
			{ postCreateCmd: "false" },
			{ sessions, docker, broadcaster },
		);
		await settle();

		expect(spies.updateStatus).toHaveBeenCalledWith("sess-1", "failed");
		expect(spies.kill).toHaveBeenCalledWith("sess-1");
		// Ordering invariant — status flip lands BEFORE kill.
		expect(order).toEqual(["updateStatus", "kill"]);
		expect(spies.runPostStart).not.toHaveBeenCalled();
		expect(final).toEqual([{ type: "fail", exitCode: 1 }]);
	});

	it("throw path: runPostCreate throws → still flip + kill + broadcast fail with error", async () => {
		const { sessions, docker, broadcaster, final, spies } = makeFakes();
		spies.runPostCreate.mockRejectedValueOnce(new Error("docker daemon down"));

		await runAsyncBootstrap(
			"sess-1",
			{ postCreateCmd: "npm install" },
			{ sessions, docker, broadcaster },
		);
		await settle();

		expect(spies.updateStatus).toHaveBeenCalledWith("sess-1", "failed");
		expect(spies.kill).toHaveBeenCalledWith("sess-1");
		expect(final).toHaveLength(1);
		expect(final[0]).toMatchObject({ type: "fail", exitCode: -1 });
	});

	// markBootstrapped failure on the success path is logged but not
	// terminal — the hook DID complete cleanly, the user's environment
	// is set up, the gate just couldn't be marked. A future restart
	// would re-attempt the gate atomically.
	it("markBootstrapped throws on success: still runs postStart + broadcasts done", async () => {
		const { sessions, docker, broadcaster, final, spies } = makeFakes();
		spies.runPostCreate.mockImplementation(async () => ({ exitCode: 0 }));
		dbStubs.d1Query.mockRejectedValueOnce(new Error("D1 transient"));

		await runAsyncBootstrap(
			"sess-1",
			{ postCreateCmd: "npm install", postStartCmd: "npm run dev" },
			{ sessions, docker, broadcaster },
		);
		await settle();

		expect(spies.runPostStart).toHaveBeenCalledWith("sess-1", "npm run dev");
		expect(final).toEqual([{ type: "done", success: true }]);
	});
});
