import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "stream";
import { DockerManager, type OutputListener } from "./dockerManager.js";
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

			// One-shot tmux commands (list-sessions, new-session -d, set-option,
			// kill-session, has-session) don't hijack the stream. If a test
			// supplied a hook, let it decide the stdout + exit code. Attaches
			// (`tmux attach` or the self-healing `tmux new-session -A`) are
			// explicitly NOT one-shots — they keep a long-lived stream open and
			// the test drives output by writing to `container._streams[...]`.
			const isAttach =
				opts.Cmd[0] === "tmux" &&
				(
					opts.Cmd[1] === "attach" ||
					(opts.Cmd[1] === "new-session" && opts.Cmd.includes("-A"))
				);
			// Every one-shot tmux command (capture-pane, list-sessions, kill-session,
			// set-option, new-session -d, …) needs SOME canned response — otherwise
			// execOneShot's `await stream.on("end")` hangs the test forever. If the
			// caller provided a hook and it answers for this command, use that; if
			// the hook returns undefined or wasn't provided, default to an empty
			// stdout + exit 0 so tests that don't care about the one-shot machinery
			// (e.g. the fan-out test that doesn't use capture-pane) don't have to
			// wire up a full oneShot mock just to unblock attach().
			const oneShotResult =
				!isAttach && opts.Cmd[0] === "tmux" && opts.Tty === true
					? (oneShot?.(opts.Cmd) ?? { stdout: "", exitCode: 0 })
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

// Every attach() fires a capture-pane one-shot in addition to the long-lived
// new-session -A attach, so `container.exec` is called multiple times per
// attach. When the unit under test is the number of distinct SHARED execs
// (i.e. the multiplex guarantee), filter on the attach exec signature.
//
// We count via the mock's call history rather than `_execs`, because a test
// may force container.exec to throw — in that case the exec object is never
// pushed, but the CALL was still made and should be counted.
function countAttachExecs(container: FakeContainer): number {
	const calls = (container.exec as unknown as { mock: { calls: Array<[{ Cmd: string[] }]> } }).mock.calls;
	return calls.filter(
		([opts]) => opts.Cmd[0] === "tmux" && opts.Cmd[1] === "new-session" && opts.Cmd.includes("-A"),
	).length;
}

// Array.prototype.find typed as `T | undefined` but in tests we often KNOW the
// value exists (the harness spawned it above) and treating it as undefined
// clutters every callsite with `?.` + its downstream undefined-propagation. A
// miss here is a test-harness bug, not a production concern, so throw eagerly.
function mustFind<T>(arr: readonly T[], pred: (v: T) => boolean, label: string): T {
	const found = arr.find(pred);
	if (!found) throw new Error(`expected to find ${label}`);
	return found;
}

const isAttachExec = (e: FakeExec): boolean =>
	e._cmd[1] === "new-session" && e._cmd.includes("-A");

// attach() now returns an armed listener (see dockerManager.attach() docs):
// live bytes pile into a tail array until wsHandler calls flushTail(). Tests
// that assert listener behaviour have to flush explicitly to mirror the
// production call-site.
async function attachAndFlush(
	dm: DockerManager,
	sessionId: string,
	attachId: string,
	cols: number,
	rows: number,
	listener: OutputListener,
	tabId: string,
): Promise<{ replay: string | null }> {
	const result = await dm.attach(sessionId, attachId, cols, rows, listener, tabId);
	result.flushTail();
	return { replay: result.replay };
}

describe("DockerManager shared-exec multiplexing", () => {
	it("creates only one shared exec across multiple attaches to the same session", async () => {
		const { dm, container } = makeDocker();

		await dm.attach("s1", "a1", 80, 24, () => { /* noop */ }, "tab-test");
		await dm.attach("s1", "a2", 80, 24, () => { /* noop */ }, "tab-test");

		expect(countAttachExecs(container)).toBe(1);
	});

	it("fans each byte of tmux output to each listener exactly once (no N× duplication)", async () => {
		const { dm, container } = makeDocker();
		const a1 = vi.fn();
		const a2 = vi.fn();

		await attachAndFlush(dm, "s1", "a1", 80, 24, a1, "tab-test");
		await attachAndFlush(dm, "s1", "a2", 80, 24, a2, "tab-test");

		// Find the LONG-LIVED attach stream (not any short-lived one-shot
		// streams like capture-pane that attach() also spawns).
		const attachStream = mustFind(container._execs, isAttachExec, "attach exec")._stream;
		attachStream.write("hello");
		await tick();

		expect(a1).toHaveBeenCalledTimes(1);
		expect(a1).toHaveBeenCalledWith("hello");
		expect(a2).toHaveBeenCalledTimes(1);
		expect(a2).toHaveBeenCalledWith("hello");
	});

	it("serializes concurrent first-attach calls onto a single container.exec()", async () => {
		const { dm, container } = makeDocker();

		// Block exec.start ONLY for the long-lived attach exec so both attaches
		// queue up on the same in-flight spawnSharedExec. Capture-pane one-shots
		// fire later (after await pending resolves) and must be allowed to
		// complete normally — otherwise attach() itself never returns and the
		// test deadlocks.
		let resolveAttachStart: ((val: PassThrough) => void) | null = null;
		const origExec = container.exec;
		container.exec = vi.fn(async (opts: { Cmd: string[] }) => {
			const isAttach =
				opts.Cmd[0] === "tmux"
				&& opts.Cmd[1] === "new-session"
				&& opts.Cmd.includes("-A");
			if (!isAttach) {
				// Fall through to the default fake for one-shots.
				return (origExec as (...a: unknown[]) => Promise<FakeExec>).apply(container, [opts]);
			}

			const stream = new PassThrough();
			container._streams.push(stream);
			const exec: FakeExec = {
				start: vi.fn(() => new Promise<PassThrough>((r) => { resolveAttachStart = r; })),
				resize: vi.fn(async () => { /* noop */ }),
				inspect: vi.fn(async () => ({ ExitCode: 0 })),
				_resizes: [],
				_stream: stream,
				_cmd: opts.Cmd,
			};
			container._execs.push(exec);
			return exec;
		}) as typeof origExec;

		const p1 = dm.attach("s1", "a1", 80, 24, () => { /* noop */ }, "tab-test");
		const p2 = dm.attach("s1", "a2", 80, 24, () => { /* noop */ }, "tab-test");

		// Both calls are now awaiting the same spawnSharedExec promise — exactly
		// one attach exec has been requested on the wire.
		await tick();
		expect(countAttachExecs(container)).toBe(1);

		resolveAttachStart!(container._streams[0]!);
		await Promise.all([p1, p2]);

		// Still one attach exec after both resolve; the second attach reused
		// the first's shared exec rather than spawning a new one.
		expect(countAttachExecs(container)).toBe(1);
	});

	it("returns the tmux capture-pane snapshot as replay for new attachers without re-sending to existing ones", async () => {
		// Capture-pane replay lets every joiner see the same canonical view of
		// the pane regardless of when they joined. We script the snapshot via
		// the one-shot hook so we don't need a live tmux.
		const { dm } = makeDocker({
			oneShot: (cmd) => {
				if (cmd[1] === "capture-pane") {
					return { stdout: "line-a\nline-b", exitCode: 0 };
				}
				return undefined;
			},
		});
		const a1 = vi.fn();
		const a2 = vi.fn();

		await dm.attach("s1", "a1", 80, 24, a1, "tab-test");
		// a1 has already received its own replay frame via the first attach
		// (captured before any live write). Clear so the post-attach
		// assertion is about what happens to existing clients during a
		// second attach.
		a1.mockClear();

		const { replay } = await dm.attach("s1", "a2", 80, 24, a2, "tab-test");

		// capture-pane stdout, with \n promoted to \r\n for xterm.
		expect(replay).toBe("line-a\r\nline-b");
		// Second attach must not cross-fan to the first listener, and a2
		// receives the replay via its return value (wsHandler, not the
		// listener) so the listener stays unfired.
		expect(a1).not.toHaveBeenCalled();
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

	it("destroys the shared exec on last detach; next attach respawns and replays the latest capture-pane", async () => {
		// The snapshot the hook returns is a proxy for "whatever tmux currently
		// shows". A real re-attach would re-run capture-pane and see the
		// post-detach screen contents.
		let paneSnapshot = "";
		const { dm, container } = makeDocker({
			oneShot: (cmd) => {
				if (cmd[1] === "capture-pane") return { stdout: paneSnapshot, exitCode: 0 };
				return undefined;
			},
		});

		await dm.attach("s1", "a1", 80, 24, () => { /* noop */ }, "tab-test");
		const attachStream = mustFind(container._execs, isAttachExec, "attach exec")._stream;
		attachStream.write("abc");
		await tick();

		dm.detach("a1");
		await tick();
		await tick();

		expect(attachStream.destroyed).toBe(true);
		const shared = (dm as unknown as { shared: Map<string, unknown> }).shared;
		expect(shared.has("s1:tab-test")).toBe(false);

		// Simulate tmux now showing "abc" in the pane, then re-attach. The
		// replay should reflect the current pane view.
		paneSnapshot = "abc";
		const a2 = vi.fn();
		const attachExecsBefore = container._execs.filter(
			(e) => e._cmd[1] === "new-session" && e._cmd.includes("-A"),
		).length;
		const { replay } = await dm.attach("s1", "a2", 80, 24, a2, "tab-test");
		const attachExecsAfter = container._execs.filter(
			(e) => e._cmd[1] === "new-session" && e._cmd.includes("-A"),
		).length;
		expect(attachExecsAfter).toBe(attachExecsBefore + 1);
		expect(replay).toBe("abc");
	});

	it("detaches the armed listener when a post-register await throws, so it doesn't orphan", async () => {
		// The armed bufferedListener is installed in s.listeners BEFORE we
		// await recomputeSize / updateConnected. A throw from either would
		// leak the listener — it would keep piling bytes into a tail array
		// that nothing ever drains — unless attach() explicitly tears down
		// on failure. Simulate that by making updateConnected reject.
		const sessions = makeFakeSessions();
		(sessions.updateConnected as unknown as ReturnType<typeof vi.fn>)
			.mockRejectedValueOnce(new Error("db down"));
		const { dm, container } = makeDocker({ sessions });

		await expect(
			dm.attach("s1", "a1", 80, 24, () => { /* noop */ }, "tab-test"),
		).rejects.toThrow("db down");
		// detach() schedules the listeners.delete on a microtask via
		// pending.then, so wait one tick before asserting. The "last
		// listener gone" branch also does `if (this.shared.get(key) === pending)
		// this.shared.delete(key)` via another microtask, hence two ticks.
		await tick();
		await tick();

		const shared = (dm as unknown as { shared: Map<string, unknown> }).shared;
		// Since this was the only listener, detach's "last client gone" branch
		// fires: listeners.size === 0 → shared entry cleared, stream destroyed.
		// This is the strongest form of "listener not orphaned": the whole
		// bucket the listener lived in is gone.
		expect(shared.has("s1:tab-test")).toBe(false);

		// keyOf mapping for the failed attach is cleared too.
		expect((dm as unknown as { keyOf: Map<string, string> }).keyOf.has("a1")).toBe(false);

		// The attach stream should have been destroyed as part of the
		// last-listener teardown.
		const attachStream = mustFind(container._execs, isAttachExec, "attach exec")._stream;
		expect(attachStream.destroyed).toBe(true);
	});

	it("clears the shared slot when spawnSharedExec rejects so retries succeed", async () => {
		const { dm, container } = makeDocker();

		// Make the first ATTACH container.exec call throw, then let subsequent
		// calls (attaches and one-shots alike) succeed normally.
		let rejectedOnce = false;
		const origExec = container.exec;
		container.exec = vi.fn(async (opts: { Cmd: string[] }) => {
			const isAttach =
				opts.Cmd[0] === "tmux"
				&& opts.Cmd[1] === "new-session"
				&& opts.Cmd.includes("-A");
			if (isAttach && !rejectedOnce) {
				rejectedOnce = true;
				throw new Error("kaboom");
			}
			return (origExec as (...a: unknown[]) => Promise<FakeExec>).apply(container, [opts]);
		}) as typeof origExec;

		await expect(dm.attach("s1", "a1", 80, 24, () => { /* noop */ }, "tab-test")).rejects.toThrow("kaboom");
		// Let the .catch handler clear the slot.
		await tick();

		await dm.attach("s1", "a2", 80, 24, () => { /* noop */ }, "tab-test");
		// One throw + one success = two attach execs requested.
		expect(countAttachExecs(container)).toBe(2);
	});
});

describe("DockerManager tabs", () => {
	it("attaches to different tabs on separate execs and doesn't cross-fan-out", async () => {
		const { dm, container } = makeDocker();
		const aListener = vi.fn();
		const bListener = vi.fn();

		await attachAndFlush(dm, "s1", "a1", 80, 24, aListener, "tab-a");
		await attachAndFlush(dm, "s1", "b1", 80, 24, bListener, "tab-b");

		// Two separate attach execs, each via self-healing `tmux new-session -A`
		// (see dockerManager.ts: same Cmd creates-or-attaches so a dead tmux
		// server doesn't fail the user's click on a stale tab). Each attach()
		// ALSO fires a capture-pane one-shot, so container.exec runs 4× total.
		const attachExecs = container._execs.filter(
			(e) => e._cmd[1] === "new-session" && e._cmd.includes("-A"),
		);
		expect(attachExecs).toHaveLength(2);
		expect(attachExecs[0]!._cmd.slice(0, 3)).toEqual(["tmux", "new-session", "-A"]);
		expect(attachExecs[0]!._cmd).toContain("tab-a");
		expect(attachExecs[1]!._cmd.slice(0, 3)).toEqual(["tmux", "new-session", "-A"]);
		expect(attachExecs[1]!._cmd).toContain("tab-b");

		// tab-a's stream emits — only tab-a's listener fires.
		const execA = attachExecs.find((e) => e._cmd.includes("tab-a"))!;
		const execB = attachExecs.find((e) => e._cmd.includes("tab-b"))!;
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
		expect((dm as unknown as { shared: Map<string, unknown> }).shared.has(bufKey)).toBe(true);

		await dm.deleteTab("s1", "tab-x");
		await tick();

		// tmux kill-session got called with the right target.
		const killCmd = mustFind(container._execs, (e) => e._cmd.includes("kill-session"), "kill-session exec");
		expect(killCmd._cmd).toEqual(["tmux", "kill-session", "-t", "tab-x"]);

		// The shared exec slot for that tab is gone.
		expect((dm as unknown as { shared: Map<string, unknown> }).shared.has(bufKey)).toBe(false);
		// keyOf mapping for the detached attach is cleared.
		expect((dm as unknown as { keyOf: Map<string, string> }).keyOf.has("a1")).toBe(false);
	});

});
