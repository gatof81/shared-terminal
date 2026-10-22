/**
 * dockerManager.execCapture.test.ts — the bounded raw-bytes exec primitive
 * behind the Git Changes view. Drives a fake dockerode container whose
 * exec stream is a PassThrough of hand-built multiplexed frames, so frame
 * boundaries, the byte cap and the timeout paths are all controllable.
 */

import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({ results: [], meta: { changes: 0 } })),
}));
vi.mock("./db.js", () => dbStubs);

import { ContainerNotFoundError, DockerManager } from "./dockerManager.js";
import type { SessionManager } from "./sessionManager.js";

function frame(type: 1 | 2, data: Buffer | string): Buffer {
	const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf-8");
	const header = Buffer.alloc(8);
	header[0] = type;
	header.writeUInt32BE(payload.length, 4);
	return Buffer.concat([header, payload]);
}

interface Scripted {
	/** Raw bytes to write (already framed); each entry is one `data` chunk. */
	chunks: Buffer[];
	exitCode: number | null;
	/** Never end the stream (simulates a hung process). */
	hang?: boolean;
}

function makeDocker(script: Scripted, containerId: string | null = "c-1") {
	const sessions = {
		getOrThrow: vi.fn(async () => ({ sessionId: "s1", containerId, status: "running" })),
	} as unknown as SessionManager;
	const dm = new DockerManager(sessions);
	const execCreate = vi.fn(async () => {
		const stream = new PassThrough();
		return {
			start: vi.fn(async () => {
				setImmediate(() => {
					for (const c of script.chunks) stream.write(c);
					if (!script.hang) stream.end();
				});
				return stream;
			}),
			inspect: vi.fn(async () => ({ ExitCode: script.exitCode })),
			_stream: stream,
		};
	});
	const getContainer = vi.fn(() => ({ exec: execCreate }));
	(dm as unknown as { docker: unknown }).docker = { getContainer };
	return { dm, execCreate, getContainer, sessions };
}

describe("execCapture", () => {
	it("wraps the argv in coreutils timeout and keeps stdout/stderr apart as raw bytes", async () => {
		const utf8 = Buffer.from("héllo wörld\0", "utf-8");
		// Split a multi-byte character across two frames: byte-exact
		// capture must reassemble it (a per-frame string decode wouldn't).
		const { dm, execCreate } = makeDocker({
			chunks: [frame(1, utf8.subarray(0, 2)), frame(2, "warn\n"), frame(1, utf8.subarray(2))],
			exitCode: 0,
		});
		const r = await dm.execCapture("s1", ["git", "status"], {
			maxBytes: 1024,
			timeoutMs: 20_000,
			env: { LC_ALL: "C" },
			cwd: "/home/developer/workspace",
		});
		expect(r.stdout.equals(utf8)).toBe(true);
		expect(r.stderr.toString()).toBe("warn\n");
		expect(r).toMatchObject({ exitCode: 0, truncated: false, timedOut: false });

		const opts = execCreate.mock.calls[0]?.[0] as unknown as {
			Cmd: string[];
			Env: string[];
			Tty: boolean;
			WorkingDir: string;
		};
		expect(opts.Cmd).toEqual(["timeout", "-k", "2", "20", "git", "status"]);
		expect(opts.Env).toEqual(["LC_ALL=C"]);
		expect(opts.Tty).toBe(false);
		expect(opts.WorkingDir).toBe("/home/developer/workspace");
	});

	it("uses the caller-supplied containerId without a session lookup", async () => {
		const { dm, getContainer, sessions } = makeDocker({ chunks: [], exitCode: 0 });
		await dm.execCapture("s1", ["true"], { containerId: "c-given", maxBytes: 10, timeoutMs: 1000 });
		expect(getContainer).toHaveBeenCalledWith("c-given");
		expect(sessions.getOrThrow).not.toHaveBeenCalled();
	});

	it("throws ContainerNotFoundError when the session has no container", async () => {
		const { dm } = makeDocker({ chunks: [], exitCode: 0 }, null);
		await expect(
			dm.execCapture("s1", ["true"], { maxBytes: 10, timeoutMs: 1000 }),
		).rejects.toBeInstanceOf(ContainerNotFoundError);
	});

	it("cuts stdout at maxBytes, flags truncated and reports an unknown exit code", async () => {
		const { dm, execCreate } = makeDocker({
			chunks: [frame(1, "a".repeat(100)), frame(1, "b".repeat(100)), frame(1, "c".repeat(100))],
			exitCode: 0,
			hang: true,
		});
		const r = await dm.execCapture("s1", ["git", "diff"], { maxBytes: 150, timeoutMs: 20_000 });
		expect(r.stdout.length).toBe(150);
		expect(r.stdout.toString()).toBe(`${"a".repeat(100)}${"b".repeat(50)}`);
		expect(r.truncated).toBe(true);
		expect(r.exitCode).toBeNull();
		// The stream was destroyed — nothing more is read, and inspect
		// isn't consulted for a process whose output we abandoned.
		const exec = (await execCreate.mock.results[0]?.value) as { inspect: ReturnType<typeof vi.fn> };
		expect(exec.inspect).not.toHaveBeenCalled();
	});

	it("reports timedOut when the in-container timeout fired (exit 124)", async () => {
		const { dm } = makeDocker({ chunks: [frame(1, "partial")], exitCode: 124 });
		const r = await dm.execCapture("s1", ["git", "status"], { maxBytes: 1024, timeoutMs: 1000 });
		expect(r.timedOut).toBe(true);
		expect(r.exitCode).toBe(124);
		expect(r.stdout.toString()).toBe("partial");
	});

	it("settles via the host-side guard when the stream never ends", async () => {
		vi.useFakeTimers();
		try {
			const { dm } = makeDocker({ chunks: [frame(1, "x")], exitCode: 0, hang: true });
			const p = dm.execCapture("s1", ["sleep"], { maxBytes: 1024, timeoutMs: 100 });
			// Let the fake write its chunk, then run the guard (timeoutMs + 5 s).
			await vi.advanceTimersByTimeAsync(10);
			await vi.advanceTimersByTimeAsync(6_000);
			const r = await p;
			expect(r.timedOut).toBe(true);
			expect(r.exitCode).toBeNull();
			expect(r.stdout.toString()).toBe("x");
		} finally {
			vi.useRealTimers();
		}
	});

	it("caps stderr independently of stdout", async () => {
		const { dm } = makeDocker({
			chunks: [frame(2, "e".repeat(70 * 1024)), frame(1, "out")],
			exitCode: 1,
		});
		const r = await dm.execCapture("s1", ["git"], { maxBytes: 1024, timeoutMs: 1000 });
		expect(r.stderr.length).toBe(64 * 1024);
		expect(r.stdout.toString()).toBe("out");
		expect(r.truncated).toBe(false);
		expect(r.exitCode).toBe(1);
	});
});
