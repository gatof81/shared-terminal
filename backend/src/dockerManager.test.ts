import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "stream";
import { DockerManager } from "./dockerManager.js";
import type { SessionManager } from "./sessionManager.js";

// ── Test harness ────────────────────────────────────────────────────────────

const tick = () => new Promise((r) => setImmediate(r));

function makeFakeSessions(containerId: string | null = "container-123"): SessionManager {
	const meta = {
		sessionId: "s1",
		userId: "u1",
		name: "test",
		status: "running" as const,
		containerId,
		containerName: "st-test",
		cols: 80,
		rows: 24,
		envVars: {},
		createdAt: new Date(),
		lastConnectedAt: null,
	};
	return {
		getOrThrow: vi.fn(async () => meta),
		get: vi.fn(async () => meta),
		updateConnected: vi.fn(async () => { /* noop */ }),
		updateStatus: vi.fn(async () => { /* noop */ }),
		setContainerId: vi.fn(async () => { /* noop */ }),
	} as unknown as SessionManager;
}

interface FakeExec {
	start: ReturnType<typeof vi.fn>;
	resize: ReturnType<typeof vi.fn>;
	_resizes: Array<{ h: number; w: number }>;
	_stream: PassThrough;
}

interface FakeContainer {
	exec: ReturnType<typeof vi.fn>;
	_streams: PassThrough[];
	_execs: FakeExec[];
}

function makeFakeContainer(): FakeContainer {
	const streams: PassThrough[] = [];
	const execs: FakeExec[] = [];

	const container = {
		exec: vi.fn(async () => {
			const stream = new PassThrough();
			const resizes: Array<{ h: number; w: number }> = [];
			streams.push(stream);
			const exec: FakeExec = {
				start: vi.fn(async () => stream),
				resize: vi.fn(async ({ h, w }: { h: number; w: number }) => {
					resizes.push({ h, w });
				}),
				_resizes: resizes,
				_stream: stream,
			};
			execs.push(exec);
			return exec;
		}),
		_streams: streams,
		_execs: execs,
	} as unknown as FakeContainer;

	return container;
}

function makeFakeDocker(container: FakeContainer) {
	return { getContainer: vi.fn(() => container) };
}

function makeDocker(sessions = makeFakeSessions()) {
	const container = makeFakeContainer();
	const dm = new DockerManager(sessions);
	// Swap in the fake Dockerode. The constructor already instantiated a real
	// one against /var/run/docker.sock but we never touch it before this.
	(dm as unknown as { docker: unknown }).docker = makeFakeDocker(container);
	return { dm, container };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("DockerManager shared-exec multiplexing", () => {
	it("creates only one shared exec across multiple attaches to the same session", async () => {
		const { dm, container } = makeDocker();

		await dm.attach("s1", "a1", 80, 24, () => { /* noop */ });
		await dm.attach("s1", "a2", 80, 24, () => { /* noop */ });

		expect(container.exec).toHaveBeenCalledTimes(1);
	});

	it("fans each byte of tmux output to each listener exactly once (no N× duplication)", async () => {
		const { dm, container } = makeDocker();
		const a1 = vi.fn();
		const a2 = vi.fn();

		await dm.attach("s1", "a1", 80, 24, a1);
		await dm.attach("s1", "a2", 80, 24, a2);

		container._streams[0]!.write("hello");
		await tick();

		expect(a1).toHaveBeenCalledTimes(1);
		expect(a1).toHaveBeenCalledWith("hello");
		expect(a2).toHaveBeenCalledTimes(1);
		expect(a2).toHaveBeenCalledWith("hello");

		// Ring buffer holds one copy of the output, not N.
		const buffer = (dm as unknown as { buffers: Map<string, { byteLength: number }> }).buffers.get("s1");
		expect(buffer?.byteLength).toBe(5);
	});

	it("serializes concurrent first-attach calls onto a single container.exec()", async () => {
		const { dm, container } = makeDocker();

		// Block exec.start so both attaches queue up on the same in-flight spawn.
		let resolveStart: ((val: PassThrough) => void) | null = null;
		const origExec = container.exec;
		container.exec = vi.fn(async () => {
			const stream = new PassThrough();
			container._streams.push(stream);
			const exec: FakeExec = {
				start: vi.fn(() => new Promise<PassThrough>((r) => { resolveStart = r; })),
				resize: vi.fn(async () => { /* noop */ }),
				_resizes: [],
				_stream: stream,
			};
			container._execs.push(exec);
			return exec;
		}) as typeof origExec;

		const p1 = dm.attach("s1", "a1", 80, 24, () => { /* noop */ });
		const p2 = dm.attach("s1", "a2", 80, 24, () => { /* noop */ });

		// Both calls are now awaiting the same spawnSharedExec promise.
		await tick();
		expect(container.exec).toHaveBeenCalledTimes(1);

		resolveStart!(container._streams[0]!);
		await Promise.all([p1, p2]);

		expect(container.exec).toHaveBeenCalledTimes(1);
	});

	it("replays buffered output to new attachers without re-sending to existing ones", async () => {
		const { dm, container } = makeDocker();
		const a1 = vi.fn();
		const a2 = vi.fn();

		await dm.attach("s1", "a1", 80, 24, a1);
		container._streams[0]!.write("abc");
		await tick();

		const { replay } = await dm.attach("s1", "a2", 80, 24, a2);

		expect(replay).toBe("abc");
		// a1 got "abc" once via fan-out; replay goes back to the caller only.
		expect(a1).toHaveBeenCalledTimes(1);
		expect(a2).not.toHaveBeenCalled();
	});

	it("resizes the shared exec to min(cols) × min(rows) and recomputes on detach", async () => {
		const { dm, container } = makeDocker();

		await dm.attach("s1", "a1", 80, 24, () => { /* noop */ });
		await dm.attach("s1", "a2", 120, 36, () => { /* noop */ });
		await dm.attach("s1", "a3", 100, 30, () => { /* noop */ });

		const resizes = container._execs[0]!._resizes;
		expect(resizes[resizes.length - 1]).toEqual({ h: 24, w: 80 });

		dm.detach("a1");
		await tick();
		await tick();

		const after = container._execs[0]!._resizes;
		expect(after[after.length - 1]).toEqual({ h: 30, w: 100 });
	});

	it("destroys the shared exec on last detach but preserves the ring buffer", async () => {
		const { dm, container } = makeDocker();

		await dm.attach("s1", "a1", 80, 24, () => { /* noop */ });
		container._streams[0]!.write("abc");
		await tick();

		dm.detach("a1");
		await tick();
		await tick();

		expect(container._streams[0]!.destroyed).toBe(true);
		const shared = (dm as unknown as { shared: Map<string, unknown> }).shared;
		expect(shared.has("s1")).toBe(false);

		// Re-attach: new exec, replay still contains the earlier output.
		const a2 = vi.fn();
		const { replay } = await dm.attach("s1", "a2", 80, 24, a2);
		expect(container.exec).toHaveBeenCalledTimes(2);
		expect(replay).toBe("abc");
	});

	it("clears the shared slot when spawnSharedExec rejects so retries succeed", async () => {
		const { dm, container } = makeDocker();

		// Make the first container.exec call throw, then let subsequent calls succeed.
		let rejectedOnce = false;
		const origExec = container.exec;
		container.exec = vi.fn(async (...args: unknown[]) => {
			if (!rejectedOnce) {
				rejectedOnce = true;
				throw new Error("kaboom");
			}
			return (origExec as (...a: unknown[]) => Promise<FakeExec>).apply(container, args);
		}) as typeof origExec;

		await expect(dm.attach("s1", "a1", 80, 24, () => { /* noop */ })).rejects.toThrow("kaboom");
		// Let the .catch handler clear the slot.
		await tick();

		await dm.attach("s1", "a2", 80, 24, () => { /* noop */ });
		expect(container.exec).toHaveBeenCalledTimes(2);
	});
});
