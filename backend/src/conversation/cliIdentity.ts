/**
 * conversation/cliIdentity.ts — the Claude Code version of the PROCESS that
 * will receive the text (docs/CONVERSATION.md §8.1.9, v1.8.2 proposal).
 *
 * Why not `session_start.claude_version`: the SessionStart hook runs
 * `claude --version` through PATH, which is not necessarily the binary the
 * conversation runs. Educación HZ, 2026-11-04: the process was the npm
 * 2.1.316 (`~/.npm-global/bin/claude`) while PATH found the native launcher
 * at 2.1.317, so the hook recorded 2.1.317 and the composer refused a
 * validated process. The reverse is just as possible — an unvalidated
 * process admitted under a validated label —, so the hook's text can never
 * authorize a send. It stays metadata.
 *
 * The version is asked of the exact process the preconditions verified
 * (the probe's pid, under `pane_pid`, in the foreground, with its
 * `starttime`), inside its container, with fixed argv and NO shell:
 *   1. `cat /proc/<pid>/status`: its real and effective uid, which must be
 *      equal and not root — the query runs as that uid (an exec `User`),
 *      never as root;
 *   2. `env -i PATH=/usr/bin:/bin HOME=/nonexistent DISABLE_AUTOUPDATER=1 …
 *      timeout -k 1 3 /proc/<pid>/exe --version`: the process's own binary
 *      (also when replaced on disk, " (deleted)": the kernel keeps the inode),
 *      with an empty environment — no token, no proxy, no HOME to write to,
 *      the auto-updater off. Measured: `--version` is a fast path (≈ 8 ms),
 *      exit 0, creates nothing under HOME;
 *   3. `cat /proc/<pid>/stat`, `readlink /proc/<pid>/exe` and the device:inode
 *      of that file again (`stat -L`, also read just before step 2): the same
 *      `starttime`, path and file as before (a pid reused, or a process that
 *      exec'd something — execve keeps pid and starttime — makes the answer
 *      about someone else).
 * Every program is named by absolute path (the container's PATH starts in
 * the workspace).
 * Output: exactly `X.Y.Z (Claude Code)` (one trailing newline allowed),
 * ≤ 128 bytes, a plain release. Anything else — a `node` runtime (the old JS
 * CLI: `--version` would print node's), a non-zero or unknown exit, a
 * timeout, extra text, a pre-release — is "no verifiable version": refused.
 */

import type { ComposerExecResult } from "./composer.js";

export const VERSION_TIMEOUT_S = 3;
export const VERSION_OUTPUT_MAX = 128;
/** Per read exec (`timeout -k 2 <s>`), as the other precondition reads. */
const READ_TIMEOUT_S = 5;

const PID_RE = /^[1-9]\d{0,9}$/;
const RELEASE_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

function pidText(pid: number): string {
	const s = String(pid);
	if (!PID_RE.test(s)) throw new Error(`not a pid: ${s}`);
	return s;
}

// Absolute paths for every program (2nd review of #523): Docker resolves an
// exec's first argv element with the CONTAINER's PATH, which starts at
// ~/.npm-global/bin — in the workspace, i.e. under the session user's
// control. /usr/bin is the image's (merged /usr on Ubuntu 24.04).
const TIMEOUT = "/usr/bin/timeout";
const read = (prog: string, ...args: string[]) => [
	TIMEOUT,
	"-k",
	"2",
	String(READ_TIMEOUT_S),
	prog,
	...args,
];
export function statusArgv(pid: number): string[] {
	return read("/usr/bin/cat", `/proc/${pidText(pid)}/status`);
}
export function statArgv(pid: number): string[] {
	return read("/usr/bin/cat", `/proc/${pidText(pid)}/stat`);
}
export function exeLinkArgv(pid: number): string[] {
	return read("/usr/bin/readlink", `/proc/${pidText(pid)}/exe`);
}
/** Device:inode of the file the process executes (follows /proc/<pid>/exe, deleted files included). */
export function exeInodeArgv(pid: number): string[] {
	return read("/usr/bin/stat", "-L", "-c", "%d:%i", `/proc/${pidText(pid)}/exe`);
}
export function versionArgv(pid: number): string[] {
	return [
		"/usr/bin/env",
		"-i",
		"PATH=/usr/bin:/bin",
		"HOME=/nonexistent",
		"DISABLE_AUTOUPDATER=1",
		"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
		TIMEOUT,
		"-k",
		"1",
		String(VERSION_TIMEOUT_S),
		`/proc/${pidText(pid)}/exe`,
		"--version",
	];
}

/** Field 22 (`starttime`) of /proc/<pid>/stat; the comm field may contain anything up to ") ". */
export function parseStarttime(stat: string): string | null {
	const i = stat.lastIndexOf(") ");
	if (i < 0) return null;
	const rest = stat
		.slice(i + 2)
		.replace(/\n$/, "")
		.split(" ");
	// rest[0] is field 3 (state) ⇒ field 22 is rest[19].
	const v = rest[19];
	return v !== undefined && /^\d+$/.test(v) ? v : null;
}

/** Real and effective uid from /proc/<pid>/status (`Uid: real effective saved fs`). */
export function parseUids(status: string): { real: number; effective: number } | null {
	const m = status.match(/^Uid:\t(\d+)\t(\d+)\t(\d+)\t(\d+)$/m);
	return m ? { real: Number(m[1]), effective: Number(m[2]) } : null;
}

/** Exactly "X.Y.Z (Claude Code)", optional single trailing newline, ≤ 128 bytes. */
export function parseVersionOutput(stdout: string): string | null {
	if (Buffer.byteLength(stdout) > VERSION_OUTPUT_MAX) return null;
	const m = stdout.match(/^(\S+) \(Claude Code\)\n?$/);
	if (!m || !RELEASE_RE.test(m[1] as string)) return null;
	return m[1] as string;
}

/** The old JS CLI runs under `node`: `/proc/<pid>/exe --version` would answer for node. */
export function isNodeRuntime(exe: string): boolean {
	const p = exe.replace(/ \(deleted\)$/, "");
	return /^node(\d+(\.\d+)*)?$/.test(p.slice(p.lastIndexOf("/") + 1));
}

export function parseInode(out: string): string | null {
	const m = out.match(/^(\d+:\d+)\n?$/);
	return m ? (m[1] as string) : null;
}

export type LiveVersion =
	| { ok: true; version: string; inode: string }
	| {
			ok: false;
			why:
				| "node-runtime"
				| "uid-unreadable"
				| "uid-root-or-mixed"
				| "version-exec-failed"
				| "version-output-invalid"
				| "identity-changed"
				| "exec-error";
	  };

export type LiveVersionExec = (cmd: string[], user?: string) => Promise<ComposerExecResult>;

/**
 * The live process's version, or why it cannot be established. `before` is
 * what the preconditions read for this pid in THIS request (starttime, exe).
 */
export async function readLiveCliVersion(
	exec: LiveVersionExec,
	pid: number,
	before: { start: string; exe: string },
): Promise<LiveVersion> {
	if (isNodeRuntime(before.exe)) return { ok: false, why: "node-runtime" };
	try {
		const st = await exec(statusArgv(pid));
		const uids = st.exitCode === 0 ? parseUids(st.stdout) : null;
		if (!uids) return { ok: false, why: "uid-unreadable" };
		if (uids.real !== uids.effective || uids.real === 0)
			return { ok: false, why: "uid-root-or-mixed" };
		const inodeBefore = await exec(exeInodeArgv(pid));
		const inode = inodeBefore.exitCode === 0 ? parseInode(inodeBefore.stdout) : null;
		if (!inode) return { ok: false, why: "identity-changed" };
		const v = await exec(versionArgv(pid), String(uids.real));
		if (v.exitCode !== 0) return { ok: false, why: "version-exec-failed" };
		const version = parseVersionOutput(v.stdout);
		if (!version) return { ok: false, why: "version-output-invalid" };
		// The same process before and after: a pid reused or a process that
		// exec'd something else in between makes the answer someone else's.
		const after = await exec(statArgv(pid));
		const link = await exec(exeLinkArgv(pid));
		const inodeAfter = await exec(exeInodeArgv(pid));
		if (
			after.exitCode !== 0 ||
			parseStarttime(after.stdout) !== before.start ||
			link.exitCode !== 0 ||
			link.stdout.replace(/\n$/, "") !== before.exe ||
			inodeAfter.exitCode !== 0 ||
			parseInode(inodeAfter.stdout) !== inode
		)
			return { ok: false, why: "identity-changed" };
		return { ok: true, version, inode };
	} catch {
		return { ok: false, why: "exec-error" };
	}
}

/**
 * Positive answers only, keyed by (container, pid, starttime, exe path), each
 * with the device:inode of the file that answered. A hit is used only after a
 * fresh inode read of /proc/<pid>/exe matches (the caller does it): an execve
 * keeps pid and starttime, and a reinstall can put another file at the same
 * path. It never stands in for the per-send checks — identity, foreground
 * and the rest run on every send.
 */
export class LiveVersionCache {
	private readonly map = new Map<string, { version: string; inode: string }>();
	constructor(private readonly max = 256) {}
	private key(containerId: string, pid: number, start: string, exe: string): string {
		return `${containerId}\u0000${pid}\u0000${start}\u0000${exe}`;
	}
	get(
		containerId: string,
		pid: number,
		start: string,
		exe: string,
	): { version: string; inode: string } | undefined {
		return this.map.get(this.key(containerId, pid, start, exe));
	}
	set(
		containerId: string,
		pid: number,
		start: string,
		exe: string,
		entry: { version: string; inode: string },
	): void {
		const k = this.key(containerId, pid, start, exe);
		this.map.delete(k);
		this.map.set(k, entry);
		while (this.map.size > this.max) {
			const oldest = this.map.keys().next().value as string;
			this.map.delete(oldest);
		}
	}
	get size(): number {
		return this.map.size;
	}
}
