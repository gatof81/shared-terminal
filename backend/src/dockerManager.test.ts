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
	inspect: ReturnType<typeof vi.fn>;
	_resizes: Array<{ h: number; w: number }>;
	_stream: PassThrough;
	_cmd: string[];
}

interface FakeContainer {
	exec: ReturnType<typeof vi.fn>;
	_streams: PassThrough[];
	_execs: FakeExec[];
}

// Optional per-test hook that lets the test script one-shot `tmux …` calls.
// The hook receives the cmd and returns the stdout to emit plus an exit code.
type OneShotHook = (cmd: string[]) => { stdout: string; exitCode: number } | undefined;

function makeFakeContainer(oneShot?: OneShotHook): FakeContainer {
	const streams: PassThrough[] = [];
	const execs: FakeExec[] = [];

	const container = {
		exec: vi.fn(async (opts: { Cmd: string[]; Tty?: boolean }) => {
			const stream = new PassThrough();
			const resizes: Array<{ h: number; w: number }> = [];
			streams.push(stream);

			// One-shot tmux commands (list-sessions, new-session, set-option,
			// kill-session, has-session) don't hijack the stream. If a test
			// supplied a hook, let it decide the stdout + exit code. `tmux attach`
			// is explicitly NOT a one-shot — it keeps a long-lived stream open.
			const isAttach = opts.Cmd[0] === "tmux" && opts.Cmd[1] === "attach";
			const oneShotResult =
				!isAttach && opts.Cmd[0] === "tmux" && opts.Tty === true && oneShot
					? oneShot(opts.Cmd)
					: undefined;

			const exec: FakeExec = {
				start: vi.fn(async () => {
					if (oneShotResult) {
						setImmediate(() => {
							stream.write(oneShotResult.stdout);
							stream.end();
						});
					}
					return stream;
				}),
				resize: vi.fn(async ({ h, w }: { h: number; w: number }) => {
					resizes.push({ h, w });
				}),
				inspect: vi.fn(async () => ({
					ExitCode: oneShotResult?.exitCode ?? 0,
				})),
				_resizes: resizes,
				_stream: stream,
				_cmd: opts.Cmd,
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

function makeDocker(opts?: { sessions?: SessionManager; oneShot?: OneShotHook }) {
	const sessions = opts?.sessions ?? makeFakeSessions();
	const container = makeFakeContainer(opts?.oneShot);
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

		await dm.attach("s1", "a1", 80, 24, () => { /* noop */ }, "tab-test");
		await dm.attach("s1", "a2", 80, 24, () => { /* noop */ }, "tab-test");

		expect(container.exec).toHaveBeenCalledTimes(1);
	});

	it("fans each byte of tmux output to each listener exactly once (no N× duplication)", async () => {
		const { dm, container } = makeDocker();
		const a1 = vi.fn();
		const a2 = vi.fn();

		await dm.attach("s1", "a1", 80, 24, a1, "tab-test");
		await dm.attach("s1", "a2", 80, 24, a2, "tab-test");

		container._streams[0]!.write("hello");
		await tick();

		expect(a1).toHaveBeenCalledTimes(1);
		expect(a1).toHaveBeenCalledWith("hello");
		expect(a2).toHaveBeenCalledTimes(1);
		expect(a2).toHaveBeenCalledWith("hello");

		// Ring buffer holds one copy of the output, not N.
		const buffer = (dm as unknown as { buffers: Map<string, { byteLength: number }> }).buffers.get("s1:tab-test");
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

		const p1 = dm.attach("s1", "a1", 80, 24, () => { /* noop */ }, "tab-test");
		const p2 = dm.attach("s1", "a2", 80, 24, () => { /* noop */ }, "tab-test");

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

		await dm.attach("s1", "a1", 80, 24, a1, "tab-test");
		container._streams[0]!.write("abc");
		await tick();

		const { replay } = await dm.attach("s1", "a2", 80, 24, a2, "tab-test");

		expect(replay).toBe("abc");
		// a1 got "abc" once via fan-out; replay goes back to the caller only.
		expect(a1).toHaveBeenCalledTimes(1);
		expect(a2).not.toHaveBeenCalled();
	});

	it("resizes the shared exec to min(cols) × min(rows) and recomputes on detach", async () => {
		const { dm, container } = makeDocker();

		await dm.attach("s1", "a1", 80, 24, () => { /* noop */ }, "tab-test");
		await dm.attach("s1", "a2", 120, 36, () => { /* noop */ }, "tab-test");
		await dm.attach("s1", "a3", 100, 30, () => { /* noop */ }, "tab-test");

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

		await dm.attach("s1", "a1", 80, 24, () => { /* noop */ }, "tab-test");
		container._streams[0]!.write("abc");
		await tick();

		dm.detach("a1");
		await tick();
		await tick();

		expect(container._streams[0]!.destroyed).toBe(true);
		const shared = (dm as unknown as { shared: Map<string, unknown> }).shared;
		expect(shared.has("s1:tab-test")).toBe(false);

		// Re-attach: new exec, replay still contains the earlier output.
		const a2 = vi.fn();
		const { replay } = await dm.attach("s1", "a2", 80, 24, a2, "tab-test");
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

		await expect(dm.attach("s1", "a1", 80, 24, () => { /* noop */ }, "tab-test")).rejects.toThrow("kaboom");
		// Let the .catch handler clear the slot.
		await tick();

		await dm.attach("s1", "a2", 80, 24, () => { /* noop */ }, "tab-test");
		expect(container.exec).toHaveBeenCalledTimes(2);
	});
});

describe("DockerManager tabs", () => {
	it("attaches to different tabs on separate execs and doesn't cross-fan-out", async () => {
		const { dm, container } = makeDocker();
		const aListener = vi.fn();
		const bListener = vi.fn();

		await dm.attach("s1", "a1", 80, 24, aListener, "tab-a");
		await dm.attach("s1", "b1", 80, 24, bListener, "tab-b");

		// Two separate `tmux attach -t <tabId>` calls.
		expect(container.exec).toHaveBeenCalledTimes(2);
		const attachCmds = container._execs.map((e) => e._cmd.join(" "));
		expect(attachCmds).toContain("tmux attach -t tab-a");
		expect(attachCmds).toContain("tmux attach -t tab-b");

		// tab-a's stream emits — only tab-a's listener fires.
		const execA = container._execs.find((e) => e._cmd.includes("tab-a"))!;
		const execB = container._execs.find((e) => e._cmd.includes("tab-b"))!;
		execA._stream.write("hello-a");
		execB._stream.write("hello-b");
		await tick();

		expect(aListener).toHaveBeenCalledTimes(1);
		expect(aListener).toHaveBeenCalledWith("hello-a");
		expect(bListener).toHaveBeenCalledTimes(1);
		expect(bListener).toHaveBeenCalledWith("hello-b");
	});

	it("listTabs parses tab-separated tmux list-sessions output", async () => {
		const { dm } = makeDocker({
			oneShot: (cmd) => {
				if (cmd[1] === "list-sessions") {
					return {
						stdout: "tab-00000001\tshell\t1700000000\ntab-abc12345\tclaude\t1700000050\n",
						exitCode: 0,
					};
				}
				return undefined;
			},
		});

		const tabs = await dm.listTabs("s1");
		expect(tabs).toEqual([
			{ tabId: "tab-00000001", label: "shell", createdAt: 1700000000 },
			{ tabId: "tab-abc12345", label: "claude", createdAt: 1700000050 },
		]);
	});

	it("listTabs returns [] when tmux reports no server running", async () => {
		const { dm } = makeDocker({
			oneShot: () => ({ stdout: "no server running on /tmp/tmux-.../default\n", exitCode: 1 }),
		});
		expect(await dm.listTabs("s1")).toEqual([]);
	});

	it("createTab runs new-session + set-option and returns the created Tab", async () => {
		const calls: string[][] = [];
		const { dm } = makeDocker({
			oneShot: (cmd) => {
				calls.push(cmd);
				return { stdout: "", exitCode: 0 };
			},
		});

		const tab = await dm.createTab("s1", "git");

		expect(tab.tabId).toMatch(/^tab-[0-9a-f]{8}$/);
		expect(tab.label).toBe("git");
		expect(tab.createdAt).toBeGreaterThan(0);

		// tmux new-session then set-option @tab-label
		expect(calls[0]?.slice(0, 3)).toEqual(["tmux", "new-session", "-d"]);
		expect(calls[0]).toContain(tab.tabId);
		// New tabs must start in the workspace bind mount, not the image's
		// /home/developer WORKDIR — otherwise the user lands next to
		// entrypoint.sh instead of in their project files.
		expect(calls[0]).toContain("-c");
		expect(calls[0]).toContain("/home/developer/workspace");
		expect(calls[1]?.slice(0, 2)).toEqual(["tmux", "set-option"]);
		expect(calls[1]).toContain("@tab-label");
		expect(calls[1]).toContain("git");
	});

	it("deleteTab kills the tmux session and clears in-memory state for that tab", async () => {
		// Pre-populate an attach on tab-x so we can verify teardown.
		const { dm, container } = makeDocker({
			oneShot: () => ({ stdout: "", exitCode: 0 }),
		});

		await dm.attach("s1", "a1", 80, 24, () => { /* noop */ }, "tab-x");

		const bufKey = "s1:tab-x";
		expect((dm as unknown as { buffers: Map<string, unknown> }).buffers.has(bufKey)).toBe(true);
		expect((dm as unknown as { shared: Map<string, unknown> }).shared.has(bufKey)).toBe(true);

		await dm.deleteTab("s1", "tab-x");
		await tick();

		// tmux kill-session got called with the right target.
		const killCmd = container._execs.find((e) => e._cmd.includes("kill-session"))!;
		expect(killCmd._cmd).toEqual(["tmux", "kill-session", "-t", "tab-x"]);

		// The shared exec slot and ring buffer for that tab are gone.
		expect((dm as unknown as { shared: Map<string, unknown> }).shared.has(bufKey)).toBe(false);
		expect((dm as unknown as { buffers: Map<string, unknown> }).buffers.has(bufKey)).toBe(false);
		// keyOf mapping for the detached attach is cleared.
		expect((dm as unknown as { keyOf: Map<string, string> }).keyOf.has("a1")).toBe(false);
	});

});
