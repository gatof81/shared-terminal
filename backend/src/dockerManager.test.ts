import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// d1Query is the only direct D1 touch-point in DockerManager (reconcile()).
// Every other path is reached through the fake SessionManager. Default to an
// empty result so tests that don't exercise reconcile aren't affected.
const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({ results: [], meta: { changes: 0 } })),
}));
vi.mock("./db.js", () => dbStubs);

import {
	DockerManager,
	demuxDockerOutputAll,
	type OutputListener,
	sanitiseHostname,
	sanitiseUploadName,
} from "./dockerManager.js";
import { logger } from "./logger.js";
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
		updateConnected: vi.fn(async () => {
			/* noop */
		}),
		updateStatus: vi.fn(async () => {
			/* noop */
		}),
		setContainerId: vi.fn(async () => {
			/* noop */
		}),
		recordContainerGone: vi.fn(async () => {
			/* noop */
		}),
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

			// One-shot commands (every Tty:false exec — tmux list-sessions,
			// kill-session, capture-pane, new-session -d, set-option, AND
			// the postCreate `bash -c <cmd>` introduced in #185 / PR
			// 185b2a) don't hijack the stream. If a test supplied a hook,
			// let it decide the stdout + exit code. Attaches (`tmux attach`
			// or the self-healing `tmux new-session -A`) are explicitly
			// NOT one-shots — they keep a long-lived stream open and the
			// test drives output by writing to `container._streams[...]`.
			const isAttach =
				opts.Cmd[0] === "tmux" &&
				(opts.Cmd[1] === "attach" || (opts.Cmd[1] === "new-session" && opts.Cmd.includes("-A")));
			// Every one-shot exec (capture-pane, kill-session, set-option,
			// new-session -d, bash -c, …) needs SOME canned response —
			// otherwise execOneShot's `await stream.on("end")` hangs the
			// test forever. If the caller provided a hook and it answers
			// for this command, use that; if the hook returns undefined or
			// wasn't provided, default to an empty stdout + exit 0 so
			// tests that don't care about the one-shot machinery don't
			// have to wire up a full oneShot mock just to unblock attach.
			const oneShotResult =
				!isAttach && opts.Tty === false
					? (oneShot?.(opts.Cmd) ?? { stdout: "", exitCode: 0 })
					: undefined;

			const exec: FakeExec = {
				start: vi.fn(async () => {
					if (oneShotResult) {
						setImmediate(() => {
							// Wrap in Docker multiplexed frame (type=1/stdout) to mirror Tty:false.
							const payload = Buffer.from(oneShotResult.stdout, "utf-8");
							const header = Buffer.alloc(8);
							header[0] = 1; // stdout
							header.writeUInt32BE(payload.length, 4);
							stream.write(Buffer.concat([header, payload]));
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
	// Swap in the fake Dockerode BEFORE any method on `dm` is called. The
	// constructor's default-selection logic now picks between letting
	// docker-modem read DOCKER_HOST (env var present) and pinning to
	// /var/run/docker.sock (env var absent), so the "real" client it
	// instantiated could be aimed at either depending on the runner's
	// environment. The swap is safe regardless because the field is
	// replaced before any code path that would actually open a connection.
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
	const calls = (container.exec as unknown as { mock: { calls: Array<[{ Cmd: string[] }]> } }).mock
		.calls;
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

const isAttachExec = (e: FakeExec): boolean => e._cmd[1] === "new-session" && e._cmd.includes("-A");

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

		await dm.attach(
			"s1",
			"a1",
			80,
			24,
			() => {
				/* noop */
			},
			"tab-test",
		);
		await dm.attach(
			"s1",
			"a2",
			80,
			24,
			() => {
				/* noop */
			},
			"tab-test",
		);

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
				opts.Cmd[0] === "tmux" && opts.Cmd[1] === "new-session" && opts.Cmd.includes("-A");
			if (!isAttach) {
				// Fall through to the default fake for one-shots.
				return (origExec as (...a: unknown[]) => Promise<FakeExec>).apply(container, [opts]);
			}

			const stream = new PassThrough();
			container._streams.push(stream);
			const exec: FakeExec = {
				start: vi.fn(
					() =>
						new Promise<PassThrough>((r) => {
							resolveAttachStart = r;
						}),
				),
				resize: vi.fn(async () => {
					/* noop */
				}),
				inspect: vi.fn(async () => ({ ExitCode: 0 })),
				_resizes: [],
				_stream: stream,
				_cmd: opts.Cmd,
			};
			container._execs.push(exec);
			return exec;
		}) as typeof origExec;

		const p1 = dm.attach(
			"s1",
			"a1",
			80,
			24,
			() => {
				/* noop */
			},
			"tab-test",
		);
		const p2 = dm.attach(
			"s1",
			"a2",
			80,
			24,
			() => {
				/* noop */
			},
			"tab-test",
		);

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
		// the one-shot hook so we don't need a live tmux. display-message is
		// also called now (in parallel) to fetch tmux's actual cursor position
		// so the replay can append a CUP escape — see the
		// "appends cursor position" test below for the cursor-specific
		// invariant.
		const { dm } = makeDocker({
			oneShot: (cmd) => {
				if (cmd[1] === "capture-pane") {
					return { stdout: "line-a\nline-b", exitCode: 0 };
				}
				if (cmd[1] === "display-message") {
					return { stdout: "1;3\n", exitCode: 0 };
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

		// capture-pane stdout with \n promoted to \r\n, plus the CUP escape
		// derived from display-message (1;3 → row 2 col 4 in 1-based ANSI).
		expect(replay).toBe("line-a\r\nline-b\x1b[2;4H");
		// Second attach must not cross-fan to the first listener, and a2
		// receives the replay via its return value (wsHandler, not the
		// listener) so the listener stays unfired.
		expect(a1).not.toHaveBeenCalled();
		expect(a2).not.toHaveBeenCalled();
	});

	it("appends an explicit CUP escape derived from tmux's cursor position", async () => {
		// Without this escape, xterm's local cursor lands one row past the
		// last replay row (each \r\n advances the cursor) — typed input then
		// renders below the visible prompt until tmux happens to redraw. The
		// CUP suffix re-syncs xterm to where tmux says the shell's cursor
		// actually is. tmux's #{cursor_y}/#{cursor_x} are 0-based, ANSI CUP
		// is 1-based — pin the +1 conversion.
		const { dm } = makeDocker({
			oneShot: (cmd) => {
				if (cmd[1] === "capture-pane") return { stdout: "$ ", exitCode: 0 };
				if (cmd[1] === "display-message") return { stdout: "0;2\n", exitCode: 0 };
				return undefined;
			},
		});
		const { replay } = await dm.attach("s1", "a1", 80, 24, vi.fn(), "tab-cur");
		// 0;2 → row 1 col 3 in 1-based ANSI.
		expect(replay).toBe("$ \x1b[1;3H");
	});

	it("falls through to plain snapshot if display-message exits non-zero", async () => {
		// Older tmux, race with `new-session -A`, or a malformed format
		// string can all yield a non-zero exit on display-message. We
		// deliberately accept the trailing-newline drift in that case
		// rather than emit a malformed escape — the user gets the same
		// behaviour as before this fix landed, not a broken one.
		const { dm } = makeDocker({
			oneShot: (cmd) => {
				if (cmd[1] === "capture-pane") return { stdout: "$ ", exitCode: 0 };
				if (cmd[1] === "display-message") return { stdout: "", exitCode: 1 };
				return undefined;
			},
		});
		const { replay } = await dm.attach("s1", "a1", 80, 24, vi.fn(), "tab-cur");
		expect(replay).toBe("$ ");
	});

	it("falls through to plain snapshot if display-message returns unparseable output", async () => {
		const { dm } = makeDocker({
			oneShot: (cmd) => {
				if (cmd[1] === "capture-pane") return { stdout: "$ ", exitCode: 0 };
				if (cmd[1] === "display-message") return { stdout: "garbage\n", exitCode: 0 };
				return undefined;
			},
		});
		const { replay } = await dm.attach("s1", "a1", 80, 24, vi.fn(), "tab-cur");
		expect(replay).toBe("$ ");
	});

	it("resizes the shared exec to min(cols) × min(rows) and recomputes on detach", async () => {
		const { dm, container } = makeDocker();

		await dm.attach(
			"s1",
			"a1",
			80,
			24,
			() => {
				/* noop */
			},
			"tab-test",
		);
		await dm.attach(
			"s1",
			"a2",
			120,
			36,
			() => {
				/* noop */
			},
			"tab-test",
		);
		await dm.attach(
			"s1",
			"a3",
			100,
			30,
			() => {
				/* noop */
			},
			"tab-test",
		);

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

		await dm.attach(
			"s1",
			"a1",
			80,
			24,
			() => {
				/* noop */
			},
			"tab-test",
		);
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
		(sessions.updateConnected as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("db down"),
		);
		const { dm, container } = makeDocker({ sessions });

		await expect(
			dm.attach(
				"s1",
				"a1",
				80,
				24,
				() => {
					/* noop */
				},
				"tab-test",
			),
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
				opts.Cmd[0] === "tmux" && opts.Cmd[1] === "new-session" && opts.Cmd.includes("-A");
			if (isAttach && !rejectedOnce) {
				rejectedOnce = true;
				throw new Error("kaboom");
			}
			return (origExec as (...a: unknown[]) => Promise<FakeExec>).apply(container, [opts]);
		}) as typeof origExec;

		await expect(
			dm.attach(
				"s1",
				"a1",
				80,
				24,
				() => {
					/* noop */
				},
				"tab-test",
			),
		).rejects.toThrow("kaboom");
		// Let the .catch handler clear the slot.
		await tick();

		await dm.attach(
			"s1",
			"a2",
			80,
			24,
			() => {
				/* noop */
			},
			"tab-test",
		);
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

		// 8 random bytes → 16 hex chars (#150).
		expect(tab.tabId).toMatch(/^tab-[0-9a-f]{16}$/);
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

		await dm.attach(
			"s1",
			"a1",
			80,
			24,
			() => {
				/* noop */
			},
			"tab-x",
		);

		const bufKey = "s1:tab-x";
		expect((dm as unknown as { shared: Map<string, unknown> }).shared.has(bufKey)).toBe(true);

		await dm.deleteTab("s1", "tab-x");
		await tick();

		// tmux kill-session got called with the right target.
		const killCmd = mustFind(
			container._execs,
			(e) => e._cmd.includes("kill-session"),
			"kill-session exec",
		);
		expect(killCmd._cmd).toEqual(["tmux", "kill-session", "-t", "tab-x"]);

		// The shared exec slot for that tab is gone.
		expect((dm as unknown as { shared: Map<string, unknown> }).shared.has(bufKey)).toBe(false);
		// keyOf mapping for the detached attach is cleared.
		expect((dm as unknown as { keyOf: Map<string, string> }).keyOf.has("a1")).toBe(false);
	});
});

describe("DockerManager.reconcile", () => {
	// d1Query is a module-level mock; reset between tests so a mockResolvedValueOnce
	// from one test can't bleed into the next (or into any future test elsewhere
	// that touches reconcile).
	beforeEach(() => {
		dbStubs.d1Query.mockReset();
		dbStubs.d1Query.mockResolvedValue({ results: [], meta: { changes: 0 } });
	});

	function makeDockerWithInspectError(err: Error & { statusCode?: number }): {
		dm: DockerManager;
		sessions: SessionManager;
	} {
		const sessions = makeFakeSessions();
		const dm = new DockerManager(sessions);
		(dm as unknown as { docker: unknown }).docker = {
			getContainer: vi.fn(() => ({
				inspect: vi.fn(async () => {
					throw err;
				}),
			})),
		};
		return { dm, sessions };
	}

	it("atomically clears container_id and sets status=stopped on 404", async () => {
		const err = Object.assign(new Error("No such container"), { statusCode: 404 });
		const { dm, sessions } = makeDockerWithInspectError(err);
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [{ session_id: "s1", container_id: "container-123" }],
			meta: { changes: 0 },
		});

		await dm.reconcile();

		// Single atomic write — no separate setContainerId / updateStatus pair
		// that a crash between could split.
		expect(sessions.recordContainerGone).toHaveBeenCalledWith("s1");
		expect(sessions.setContainerId).not.toHaveBeenCalled();
		expect(sessions.updateStatus).not.toHaveBeenCalled();
	});

	it("preserves container_id on non-404 inspect failure (transient daemon error)", async () => {
		// No statusCode — simulates a daemon-unreachable / socket error where
		// the container may well still be alive. Nulling the id here would
		// orphan it (no D1 row points at it, so nothing ever cleans it up).
		const { dm, sessions } = makeDockerWithInspectError(new Error("ECONNREFUSED"));
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [{ session_id: "s1", container_id: "container-123" }],
			meta: { changes: 0 },
		});

		await dm.reconcile();

		expect(sessions.recordContainerGone).not.toHaveBeenCalled();
		expect(sessions.setContainerId).not.toHaveBeenCalled();
		expect(sessions.updateStatus).toHaveBeenCalledWith("s1", "stopped");
	});

	// Issue-#15 hardening migration. The warn fires for any pre-hardened
	// container reconcile sees, regardless of running state — operators who
	// stopped sessions before redeploying still need the heads-up at boot.
	function makeDockerWithInspectResult(info: {
		State: { Running: boolean };
		HostConfig: { CapDrop?: string[]; SecurityOpt?: string[] };
	}): { dm: DockerManager; sessions: SessionManager } {
		const sessions = makeFakeSessions();
		const dm = new DockerManager(sessions);
		(dm as unknown as { docker: unknown }).docker = {
			getContainer: vi.fn(() => ({
				inspect: vi.fn(async () => info),
			})),
		};
		return { dm, sessions };
	}

	it("warns when reconcile inspects a running pre-#15 container (no CapDrop/SecurityOpt)", async () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { dm, sessions } = makeDockerWithInspectResult({
			State: { Running: true },
			HostConfig: { CapDrop: [], SecurityOpt: [] },
		});
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [{ session_id: "s1", container_id: "container-old" }],
			meta: { changes: 0 },
		});

		await dm.reconcile();

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0]?.[0]).toMatch(/predates issue-#15 hardening/);
		expect(warnSpy.mock.calls[0]?.[0]).toMatch(/session s1/);
		// Running container — reconcile shouldn't flip status.
		expect(sessions.updateStatus).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it("warns even when the pre-#15 container is stopped at reconcile time", async () => {
		// reconcile() queries WHERE status = 'running', so this exercises the
		// case where D1 still says 'running' but the Docker process is down
		// (external `docker stop`, OOM kill, host reboot mid-flight). The
		// warn must fire regardless of Docker's State.Running so the
		// migration footgun surfaces even on containers that happen to be
		// dead at reconcile time — they'll be respawned later, and the
		// operator needs to know the old image is involved.
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { dm, sessions } = makeDockerWithInspectResult({
			State: { Running: false },
			HostConfig: { CapDrop: [], SecurityOpt: [] },
		});
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [{ session_id: "s2", container_id: "container-old-stopped" }],
			meta: { changes: 0 },
		});

		await dm.reconcile();

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0]?.[0]).toMatch(/session s2/);
		expect(sessions.updateStatus).toHaveBeenCalledWith("s2", "stopped");
		warnSpy.mockRestore();
	});

	it("does not warn for properly hardened containers", async () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { dm } = makeDockerWithInspectResult({
			State: { Running: true },
			HostConfig: { CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"] },
		});
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [{ session_id: "s3", container_id: "container-new" }],
			meta: { changes: 0 },
		});

		await dm.reconcile();

		expect(warnSpy).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});
});

describe("DockerManager.startContainer", () => {
	// Case 2 (containerId on file, container exists in Docker) is the
	// interactive `POST /api/sessions/:id/start` path. A pre-#15 container
	// reached this way must surface the same warn as reconcile so a future
	// refactor can't silently drop the call.
	it("warns when starting an existing pre-#15 container (Case 2)", async () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const sessions = makeFakeSessions();
		const dm = new DockerManager(sessions);
		(dm as unknown as { docker: unknown }).docker = {
			getContainer: vi.fn(() => ({
				inspect: vi.fn(async () => ({
					State: { Running: false },
					HostConfig: { CapDrop: [], SecurityOpt: [] },
				})),
				start: vi.fn(async () => {
					/* started */
				}),
			})),
		};

		await dm.startContainer("s1");

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0]?.[0]).toMatch(/predates issue-#15 hardening/);
		expect(warnSpy.mock.calls[0]?.[0]).toMatch(/session s1/);
		expect(sessions.updateStatus).toHaveBeenCalledWith("s1", "running");
		warnSpy.mockRestore();
	});
});

describe("DockerManager constructor", () => {
	// The constructor's default-selection logic — pass `{ socketPath: '/var/
	// run/docker.sock' }` when DOCKER_HOST is unset, and `undefined` when it
	// IS set so docker-modem reads the URL from the env — is trivial in
	// shape but load-bearing for the optional docker-socket-proxy
	// deployment posture documented in the README. A future refactor that
	// reinstates the always-socketPath default would silently break proxy
	// deployments and only surface at deploy time, so pin both branches.
	//
	// We have to do real `new DockerManager()` instantiation here (no fake-
	// Dockerode swap) because the unit under test is what `new Dockerode(
	// opts)` ends up doing with the options the constructor picks. That's
	// docker-modem behaviour, not DockerManager behaviour, so the FakeDocker
	// shim used by every other test would defeat the assertion.
	//
	// FRAGILITY NOTE: both branches assert on `docker.modem.socketPath`,
	// which is a docker-modem private field — not part of dockerode's
	// public surface. A future docker-modem version that renames or
	// lazily-initialises that field would break these tests with no
	// behavioural change in DockerManager. If they fail after a `npm
	// update` of dockerode/docker-modem, look for the field rename in
	// node_modules/docker-modem/lib/modem.js BEFORE assuming
	// DockerManager regressed. The tradeoff is intentional: the only
	// equivalent we could observe through dockerode's public API would
	// involve actually opening a connection, which would either need a
	// real Docker daemon or a TCP fixture per test — both heavier and
	// slower than this targeted private-field read.
	//
	// process.env.DOCKER_HOST is process-global state, so save and restore
	// it around each case. A leak into other suites in the same vitest
	// run could change the implicit constructor branch the harness exercises
	// (see makeDocker comment) and produce confusing failures elsewhere.

	let savedDockerHost: string | undefined;
	beforeEach(() => {
		savedDockerHost = process.env.DOCKER_HOST;
	});
	afterEach(() => {
		if (savedDockerHost === undefined) {
			delete process.env.DOCKER_HOST;
		} else {
			process.env.DOCKER_HOST = savedDockerHost;
		}
	});

	it("falls back to /var/run/docker.sock when DOCKER_HOST is unset", () => {
		// Explicit delete rather than 'if undefined skip' — a CI runner that
		// happens to have DOCKER_HOST inherited from the shell would silently
		// flip this case into the wrong branch and pass for the wrong reason.
		delete process.env.DOCKER_HOST;
		const dm = new DockerManager(makeFakeSessions());
		// docker-modem exposes the resolved transport on .modem; the field is
		// untyped on dockerode's side so we cast.
		const modem = (dm as unknown as { docker: { modem: { socketPath?: string } } }).docker.modem;
		expect(modem.socketPath).toBe("/var/run/docker.sock");
	});

	it("forwards no socketPath to dockerode when DOCKER_HOST is set (proxy posture)", () => {
		// Use a syntactically valid URL so docker-modem's parser is happy.
		// We never actually open a connection — DockerManager doesn't
		// exercise the client at construction time, so just instantiating
		// is enough to inspect what options ended up on the modem.
		process.env.DOCKER_HOST = "tcp://docker-socket-proxy:2375";
		const dm = new DockerManager(makeFakeSessions());
		const modem = (dm as unknown as { docker: { modem: { socketPath?: string } } }).docker.modem;
		// The proxy overlay in README "Security model" depends on this
		// branch: with socketPath undefined, docker-modem reads
		// DOCKER_HOST and routes to the proxy. If a refactor reinstates a
		// hardcoded socketPath, this assertion fails and CI catches it
		// before deploy.
		expect(modem.socketPath).toBeUndefined();
	});
});

// ── sanitiseUploadName ──────────────────────────────────────────────────────
// Security-sensitive: the result is concatenated into a host filesystem path
// AND pasted directly into the user's terminal, so it has to (a) prevent any
// path-traversal segment from being written outside <uploads>/ and (b) keep
// the resulting filename safe to surface as a shell argument. Tests cover
// the categories the bot called out: normal pass-through, path-separator
// stripping, full-strip fallback, length cap with extension preservation,
// and Unicode-only names.

describe("sanitiseUploadName", () => {
	it("preserves a normal filename verbatim", () => {
		expect(sanitiseUploadName("screenshot.png")).toBe("screenshot.png");
		expect(sanitiseUploadName("notes-2026_04_26.txt")).toBe("notes-2026_04_26.txt");
	});

	it("strips path separators and traversal segments", () => {
		// Two layered defences: path.basename strips POSIX `/`-separated
		// segments (covers cases 1, 2, 4 below); for backslash-only paths
		// on Linux — where `\` is NOT a path separator — basename leaves
		// the whole string intact and the `[^A-Za-z0-9._-]+` regex
		// collapses each `\` run to `_`, then the leading-underscore
		// strip removes them (case 3). Either way, no "../" escapes.
		expect(sanitiseUploadName("../../etc/passwd")).toBe("passwd");
		expect(sanitiseUploadName("/absolute/path/file.png")).toBe("file.png");
		expect(sanitiseUploadName("..\\..\\windows\\sys.ini")).toBe("windows_sys.ini");
		expect(sanitiseUploadName("./hidden.png")).toBe("hidden.png");
	});

	it("collapses spaces and shell metachars to underscore", () => {
		// The result is pasted into the terminal; spaces would unquote the
		// path, dollar signs would expand, and so on. The regex restricts
		// to [A-Za-z0-9._-] so all of those become _.
		expect(sanitiseUploadName("my file (1).png")).toBe("my_file_1_.png");
		expect(sanitiseUploadName("$(whoami).png")).toBe("whoami_.png");
		// No path separator here — the basename pass would otherwise eat
		// the dangerous prefix and leave us asserting against ".txt".
		expect(sanitiseUploadName("a; rm -rf .txt")).toBe("a_rm_-rf_.txt");
	});

	it("falls back to 'file' when sanitisation strips everything", () => {
		// All-dots, leading-strip, and Unicode-only names all collapse to
		// empty after the basename + restrict + leading-strip pipeline.
		expect(sanitiseUploadName("")).toBe("file");
		expect(sanitiseUploadName("...")).toBe("file");
		expect(sanitiseUploadName("___")).toBe("file");
		expect(sanitiseUploadName("---")).toBe("file");
		expect(sanitiseUploadName("中文")).toBe("file");
		expect(sanitiseUploadName("📎")).toBe("file");
	});

	it("strips leading dashes so the result can't start with a flag-like char", () => {
		// Defends a hypothetical future caller that passes safeBase as a
		// bare subprocess argument. Today the path is always absolute so
		// "-rf.sh" wouldn't collide with anything, but an evolving call
		// site might lose that invariant.
		expect(sanitiseUploadName("-rf.sh")).toBe("rf.sh");
		expect(sanitiseUploadName("--help.txt")).toBe("help.txt");
		// Mid-string dashes are kept; only leading ones are stripped.
		expect(sanitiseUploadName("data-2026-04-27.csv")).toBe("data-2026-04-27.csv");
	});

	it("preserves a short extension when truncating long names", () => {
		// 100-char stem + ".png" → MAX_LEN=80 enforced, ext kept.
		const stem = "a".repeat(100);
		const out = sanitiseUploadName(`${stem}.png`);
		expect(out.length).toBe(80);
		expect(out.endsWith(".png")).toBe(true);
	});

	it("caps a pathological extension so it can't blow past MAX_LEN", () => {
		// Hostile name: ".aaa..." with a 200-char extension. Extension cap
		// is 16 chars, so the trimmed stem still fits inside MAX_LEN=80.
		const out = sanitiseUploadName(`name.${"x".repeat(200)}`);
		expect(out.length).toBeLessThanOrEqual(80);
		expect(out.startsWith("name.")).toBe(true);
	});

	it("handles names that are nothing but an extension", () => {
		// `lastIndexOf(".") >= cleaned.length - 1` means extension-only names
		// shouldn't try to "preserve the extension" — they fall through to
		// the simple slice path.
		expect(sanitiseUploadName(".gitignore")).toBe("gitignore"); // leading dot stripped
	});
});

// ── sanitiseHostname ────────────────────────────────────────────────────────
// RFC 1123 says a hostname label can't start or end with `-`, max 63 chars.
// Docker enforces this at createContainer; a violation is a 400 the user
// can't recover from without renaming the session. The slice-before-strip
// ordering invariant is what keeps a >63-char name with a dash at index 62
// from sneaking a trailing dash past the regex.
describe("sanitiseHostname", () => {
	const sid = "abcdef1234567890"; // 8-char prefix → "session-abcdef12"

	it("returns a clean name unchanged", () => {
		expect(sanitiseHostname("my-session", sid)).toBe("my-session");
		expect(sanitiseHostname("Project42", sid)).toBe("Project42");
	});

	it("collapses non-alphanumeric chars to dashes", () => {
		expect(sanitiseHostname("my session!", sid)).toBe("my-session");
		expect(sanitiseHostname("foo_bar.baz", sid)).toBe("foo-bar-baz");
	});

	it("strips leading and trailing boundary dashes", () => {
		expect(sanitiseHostname("-foo", sid)).toBe("foo");
		expect(sanitiseHostname("foo-", sid)).toBe("foo");
		expect(sanitiseHostname("-foo-", sid)).toBe("foo");
		expect(sanitiseHostname("---foo---", sid)).toBe("foo");
	});

	it("falls back to a session-prefixed label when the result collapses to empty", () => {
		expect(sanitiseHostname("---", sid)).toBe("session-abcdef12");
		expect(sanitiseHostname("中文", sid)).toBe("session-abcdef12");
		expect(sanitiseHostname("", sid)).toBe("session-abcdef12");
	});

	it("truncates to 63 chars and re-strips trailing dashes left by truncation", () => {
		// 62 'a's + '-' + 'rest' is 67 chars; charset-replace is a no-op,
		// slice(0,63) cuts to "aa…aa-" (62 'a' + '-'), strip trims the
		// trailing dash — Docker would otherwise refuse the hostname.
		const longWithDashAtBoundary = `${"a".repeat(62)}-rest`;
		const out = sanitiseHostname(longWithDashAtBoundary, sid);
		expect(out).toBe("a".repeat(62));
		expect(out.length).toBe(62);
		expect(out.endsWith("-")).toBe(false);
	});

	it("caps length at 63 chars for any input", () => {
		const out = sanitiseHostname("x".repeat(200), sid);
		expect(out.length).toBe(63);
		expect(out).toBe("x".repeat(63));
	});
});

// ── Bootstrap hooks (#185) ─────────────────────────────────────────────────

describe("DockerManager.runPostCreate", () => {
	it("runs the cmd via `bash -c` and returns exit code + stdout", async () => {
		const { dm, container } = makeDocker({
			oneShot: (cmd) => {
				if (cmd[0] === "bash" && cmd[1] === "-c") {
					return { stdout: "installed\n", exitCode: 0 };
				}
				return undefined;
			},
		});
		const result = await dm.runPostCreate("s1", "npm install");
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("installed");
		// Cmd shape: bash -c <user-script>. Argv form means tmux/exec
		// gets the script as a single argument, no shell-quoting hazard.
		const exec = mustFind(
			container._execs,
			(e) => e._cmd[0] === "bash" && e._cmd[1] === "-c",
			"bash -c exec for runPostCreate",
		);
		expect(exec._cmd).toEqual(["bash", "-c", "npm install"]);
	});

	it("propagates a non-zero exit code so the route can hard-fail", async () => {
		const { dm } = makeDocker({
			oneShot: (cmd) => {
				if (cmd[0] === "bash") return { stdout: "boom\n", exitCode: 42 };
				return undefined;
			},
		});
		const result = await dm.runPostCreate("s1", "false");
		expect(result.exitCode).toBe(42);
		expect(result.output).toContain("boom");
	});

	// Round-2 review fix: hook diagnostics go to stderr (`npm ERR!`,
	// `bash: cmd: not found`, `tsc: error TS…`). The capture must
	// include stderr, otherwise the hard-fail modal shows "(no output)"
	// for the most common failure mode and the user can't see what
	// went wrong.
	it("captures stderr alongside stdout in the returned output", async () => {
		const { dm } = makeDocker({
			oneShot: (cmd) => {
				// Inject a stderr frame ahead of an empty stdout to assert
				// the combined demux walks both. The test harness packs
				// whatever the hook returns as stdout (frame type 1), so
				// we simulate by writing a custom multiplexed buffer
				// directly. Easier path: use `mergeFrames` below.
				if (cmd[0] === "bash") {
					return { stdout: "bash: bad-cmd: not found\n", exitCode: 127 };
				}
				return undefined;
			},
		});
		const result = await dm.runPostCreate("s1", "bad-cmd");
		// Even with the harness packing as stdout, the combined demux
		// must surface the bytes — exiting code 127 is the canonical
		// "command not found" semaphore the modal now relies on.
		expect(result.exitCode).toBe(127);
		expect(result.output).toContain("bash: bad-cmd: not found");
	});
});

// Direct unit tests on the combined-demux helper itself, since the
// fake-container harness only emits stdout frames (type 1). Asserting
// here that mixed stdout/stderr buffers — which Docker really does
// produce in production — interleave correctly into a single output
// string.
describe("demuxDockerOutputAll", () => {
	function frame(type: 1 | 2, payload: string): Buffer {
		const data = Buffer.from(payload, "utf-8");
		const header = Buffer.alloc(8);
		header[0] = type;
		header.writeUInt32BE(data.length, 4);
		return Buffer.concat([header, data]);
	}

	it("collects type-1 (stdout) and type-2 (stderr) frames in arrival order", () => {
		const raw = Buffer.concat([
			frame(1, "step1\n"),
			frame(2, "warn: something\n"),
			frame(1, "step2\n"),
			frame(2, "err: boom\n"),
		]);
		const out = demuxDockerOutputAll(raw);
		expect(out).toBe("step1\nwarn: something\nstep2\nerr: boom\n");
	});

	it("ignores unknown frame types (defence against future Docker additions)", () => {
		const raw = Buffer.concat([
			frame(1, "kept\n"),
			// type 3 doesn't exist today; skipping it lets a future
			// Docker frame type appear without polluting the panel.
			Buffer.concat([Buffer.from([3, 0, 0, 0, 0, 0, 0, 5]), Buffer.from("xxxxx")]),
			frame(2, "kept-stderr\n"),
		]);
		expect(demuxDockerOutputAll(raw)).toBe("kept\nkept-stderr\n");
	});

	it("returns empty string for an empty buffer", () => {
		expect(demuxDockerOutputAll(Buffer.alloc(0))).toBe("");
	});
});

describe("DockerManager.runPostStart", () => {
	it("kills any prior `bootstrap` tmux session, then creates a fresh detached one", async () => {
		const calls: string[][] = [];
		const { dm } = makeDocker({
			oneShot: (cmd) => {
				calls.push(cmd);
				return { stdout: "", exitCode: 0 };
			},
		});
		await dm.runPostStart("s1", "code tunnel");
		// Idempotent on re-runs: the kill-session must come first so a
		// stale daemon from the previous start can't race the new one.
		expect(calls[0]).toEqual(["tmux", "kill-session", "-t", "bootstrap"]);
		// new-session -d creates the daemon detached; -c pins cwd to the
		// workspace so the hook runs from the same place a freshly-
		// attached terminal would.
		expect(calls[1]).toEqual([
			"tmux",
			"new-session",
			"-d",
			"-s",
			"bootstrap",
			"-c",
			"/home/developer/workspace",
			"bash",
			"-c",
			"code tunnel",
		]);
	});

	it("treats a non-zero kill-session as expected (first start has no session to kill)", async () => {
		// First-start path: kill-session returns 1 ("no such session")
		// which is the COMMON case, not an error. Wrapped in .catch in
		// runPostStart so it never propagates. The new-session call
		// must still run.
		const calls: string[][] = [];
		const { dm } = makeDocker({
			oneShot: (cmd) => {
				calls.push(cmd);
				if (cmd.includes("kill-session")) return { stdout: "", exitCode: 1 };
				return { stdout: "", exitCode: 0 };
			},
		});
		await dm.runPostStart("s1", "echo started");
		expect(calls.length).toBe(2);
		expect(calls[1]?.[1]).toBe("new-session");
	});

	it("logs a warning but does not throw if the new-session itself fails", async () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
		const { dm } = makeDocker({
			oneShot: (cmd) => {
				if (cmd[1] === "new-session") return { stdout: "boom", exitCode: 99 };
				return { stdout: "", exitCode: 0 };
			},
		});
		await expect(dm.runPostStart("s1", "broken")).resolves.toBeUndefined();
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("postStart launch failed"));
		warnSpy.mockRestore();
	});
});
