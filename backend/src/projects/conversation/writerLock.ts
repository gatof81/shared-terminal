/**
 * projects/conversation/writerLock.ts — the cross-process writer lock of the
 * project conversation (docs/PROJECT_CONVERSATION.md §2.1).
 *
 * Nothing in the deployment guarantees a single backend: `app` has no
 * `container_name`, and boot works before `listen`, so a second process
 * (an overlapping compose recreate, a stray `npm run dev` against the same
 * WORKSPACE_ROOT) would open and append to the same logs. The exclusion has
 * to be enforced by the kernel and has to disappear with its holder, even on
 * SIGKILL. Node has no flock/fcntl, and an `O_EXCL` lock file survives a
 * crash, so the lock is held by a helper process:
 *
 *   /usr/bin/flock --exclusive --nonblock <lock> /bin/sh -c 'echo held; exec cat'
 *
 * with stdin a pipe from this process. The lock is ours once `held` arrives;
 * the kernel drops it when the helper exits, and the helper exits when our
 * end of the pipe closes — on any death of this process, or when the
 * container stops. It is the same inode on the host bind mount, so it works
 * across containers too.
 */

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";

export const FLOCK_PATH = "/usr/bin/flock";
export const ACQUIRE_TIMEOUT_MS = 5_000;

export type AcquireFailure = "busy" | "no-flock" | "timeout" | "error";

export interface WriterLock {
	/** False from the moment the helper is seen to exit: the kernel may already have handed the lock to someone else. */
	held(): boolean;
	/** Called once, when the helper exits while the lock was supposed to be held. */
	onLost(cb: () => void): void;
	/** Lets the helper exit (EOF on its stdin). Idempotent. */
	release(): void;
}

export type SpawnFn = (cmd: string, args: string[]) => ChildProcess;

const defaultSpawn: SpawnFn = (cmd, args) =>
	nodeSpawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"] });

export async function acquireWriterLock(
	lockPath: string,
	opts: { spawn?: SpawnFn; flockPath?: string; timeoutMs?: number } = {},
): Promise<
	{ ok: true; lock: WriterLock } | { ok: false; reason: AcquireFailure; detail?: string }
> {
	const spawn = opts.spawn ?? defaultSpawn;
	const timeoutMs = opts.timeoutMs ?? ACQUIRE_TIMEOUT_MS;
	let child: ChildProcess;
	try {
		child = spawn(opts.flockPath ?? FLOCK_PATH, [
			"--exclusive",
			"--nonblock",
			lockPath,
			"/bin/sh",
			"-c",
			"echo held; exec cat",
		]);
	} catch (err) {
		return { ok: false, reason: "no-flock", detail: (err as Error).message };
	}

	return new Promise((resolve) => {
		let settled = false;
		let held = false;
		let released = false;
		let lostCb: (() => void) | null = null;
		let out = "";
		const finish = (
			r: { ok: true; lock: WriterLock } | { ok: false; reason: AcquireFailure; detail?: string },
		) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(r);
		};
		const release = () => {
			released = true;
			try {
				child.stdin?.end();
			} catch {
				/* already closed */
			}
		};
		const timer = setTimeout(() => {
			// Not held yet: we never claimed it, so killing the helper is safe.
			child.kill("SIGKILL");
			finish({ ok: false, reason: "timeout" });
		}, timeoutMs);

		child.on("error", (err) => {
			const code = (err as NodeJS.ErrnoException).code;
			finish({ ok: false, reason: code === "ENOENT" ? "no-flock" : "error", detail: err.message });
		});
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			if (held) return;
			out += chunk;
			if (!out.includes("held\n")) return;
			held = true;
			// The helper must never keep the event loop alive on its own; the
			// pipe still closes when this process dies, which is the point.
			child.unref();
			(child.stdin as unknown as { unref?: () => void })?.unref?.();
			(child.stdout as unknown as { unref?: () => void })?.unref?.();
			finish({
				ok: true,
				lock: {
					held: () => held,
					onLost: (cb) => {
						lostCb = cb;
					},
					release,
				},
			});
		});
		child.on("exit", (code) => {
			if (!held) {
				// flock --nonblock exits 1 when someone else holds the lock.
				finish({ ok: false, reason: code === 1 ? "busy" : "error", detail: `exit ${code}` });
				return;
			}
			held = false;
			if (!released) lostCb?.();
		});
	});
}
