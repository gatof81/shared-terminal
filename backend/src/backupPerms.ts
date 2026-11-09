/**
 * backupPerms.ts — who may read a backup (#562).
 *
 * A backup holds password and token hashes, secret ciphertext, conversation
 * titles, push subscriptions and every workspace (a `writeEnvFile` `.env`
 * included). Before #562 `runBackup` created all of it with the process
 * umask — 0755/0644 in the container — so any host user who could reach
 * `<WORKSPACE_ROOT>/.backups` could read it.
 *
 * Two modes, never world-readable:
 *   - BACKUP_GROUP_GID unset ⇒ 0700/0600, root only (the backend runs as root);
 *   - BACKUP_GROUP_GID=<n>   ⇒ 0750/0640, group n: for an off-host copy that
 *     runs as a non-root user in that group (the nightly NAS mirror).
 * A numeric id, never a name: the container does not know the host's groups.
 *
 * `hardenBackups` brings EXISTING backups to the same modes. Dry run unless
 * asked to write; it never follows a symlink, and it only enters directories
 * nobody else can modify, so no path on the way can be swapped for a link.
 */

import { promises as fs, constants as fsc } from "node:fs";
import path from "node:path";

export interface BackupPerms {
	dirMode: number;
	fileMode: number;
	/** Group to give every entry; null = leave the group as created (root's). */
	gid: number | null;
}

const MAX_GID = 2_147_483_647;

export function backupPerms(env: NodeJS.ProcessEnv = process.env): BackupPerms {
	const raw = env.BACKUP_GROUP_GID?.trim();
	if (!raw) return { dirMode: 0o700, fileMode: 0o600, gid: null };
	// Refuse rather than guess: a typo here would either lock the mirror out
	// (backups silently stop leaving the host) or hand them to the wrong group.
	if (!/^\d+$/.test(raw) || Number(raw) > MAX_GID) {
		throw new Error(`BACKUP_GROUP_GID must be a numeric group id, got ${JSON.stringify(raw)}`);
	}
	return { dirMode: 0o750, fileMode: 0o640, gid: Number(raw) };
}

/**
 * Give one entry the backup's mode (and group). Refuses a symlink: the backup
 * creates none, so one here was planted. The change goes through a descriptor
 * opened with O_NOFOLLOW (O_NONBLOCK so a FIFO swapped in cannot hang it), so
 * a path swapped for a link after a check can never redirect it to the target.
 */
export async function secure(
	p: string,
	kind: "dir" | "file",
	perms: BackupPerms,
	/** dev/ino seen by the caller's lstat: the opened entry must be that one. */
	expected?: { dev: number; ino: number },
): Promise<void> {
	let fh: fs.FileHandle;
	try {
		fh = await fs.open(p, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ELOOP") {
			throw new Error(`refusing to secure a symlink: ${p}`);
		}
		throw err;
	}
	try {
		const st = await fh.stat();
		if (expected && (st.dev !== expected.dev || st.ino !== expected.ino)) {
			throw new Error(`refusing to secure ${p}: it changed since it was examined`);
		}
		if (kind === "dir" ? !st.isDirectory() : !st.isFile()) {
			throw new Error(
				`refusing to secure ${p}: not a ${kind === "dir" ? "directory" : "regular file"}`,
			);
		}
		if (perms.gid !== null && st.gid !== perms.gid) await fh.chown(st.uid, perms.gid);
		await fh.chmod(kind === "dir" ? perms.dirMode : perms.fileMode);
	} finally {
		await fh.close();
	}
}

export interface HardenChange {
	path: string;
	kind: "dir" | "file";
	from: { mode: number; gid: number };
	to: { mode: number; gid: number };
}

export interface HardenReport {
	changes: HardenChange[];
	/** Symlinks and special files: reported, never followed or touched. */
	skipped: Array<{ path: string; reason: string }>;
	written: boolean;
}

/**
 * Walk `root` (the `.backups` dir) and bring every directory and regular file
 * under it — root included — to `perms`. `write: false` only reports.
 */
export async function hardenBackups(
	root: string,
	perms: BackupPerms,
	opts: { write: boolean },
): Promise<HardenReport> {
	const report: HardenReport = { changes: [], skipped: [], written: opts.write };
	const rootSt = await fs.lstat(root);
	if (rootSt.isSymbolicLink() || !rootSt.isDirectory()) {
		throw new Error(`${root} is not a real directory — refusing`);
	}
	const me = process.getuid?.() ?? 0;
	// O_NOFOLLOW guards only the LAST component of a path. The walk resolves
	// every path again from the root, so a directory swapped for a symlink
	// after its lstat would redirect everything below it. It cannot be swapped
	// when nobody else can write to any directory on the way: so the walk only
	// enters (and touches) directories that we own, that are not writable by
	// group or others, and that sit on the root's filesystem. Anything else is
	// reported and left alone, contents included.
	const trusted = (st: { uid: number; mode: number; dev: number }) =>
		st.uid === me && (st.mode & 0o022) === 0 && st.dev === rootSt.dev;
	if (!trusted(rootSt)) {
		throw new Error(
			`${root} must be owned by uid ${me} and writable by nobody else to be hardened — refusing`,
		);
	}
	const visit = async (p: string): Promise<void> => {
		const st = await fs.lstat(p);
		let kind: "dir" | "file";
		if (st.isDirectory()) kind = "dir";
		else if (st.isFile()) kind = "file";
		else {
			report.skipped.push({
				path: p,
				reason: st.isSymbolicLink() ? "symlink" : "not a regular file",
			});
			return;
		}
		if (kind === "dir" && !trusted(st)) {
			report.skipped.push({
				path: p,
				reason: "directory not owned by us, writable by group or others, or on another filesystem",
			});
			return;
		}
		const want = kind === "dir" ? perms.dirMode : perms.fileMode;
		const gid = perms.gid ?? st.gid;
		const mode = st.mode & 0o7777;
		if (mode !== want || st.gid !== gid) {
			report.changes.push({ path: p, kind, from: { mode, gid: st.gid }, to: { mode: want, gid } });
			if (opts.write) await secure(p, kind, perms, { dev: st.dev, ino: st.ino });
		}
		if (kind === "dir") {
			for (const name of (await fs.readdir(p)).sort()) await visit(path.join(p, name));
		}
	};
	await visit(root);
	return report;
}

/** `harden [dir] [--write]`: at most one directory, `--write` the only flag. */
export function parseHardenArgs(
	args: readonly string[],
	defaultRoot: string,
): { root: string; write: boolean } | null {
	const flags = args.filter((a) => a.startsWith("--"));
	const dirs = args.filter((a) => !a.startsWith("--"));
	if (flags.some((f) => f !== "--write") || dirs.length > 1) return null;
	return { root: dirs[0] ?? defaultRoot, write: flags.includes("--write") };
}
