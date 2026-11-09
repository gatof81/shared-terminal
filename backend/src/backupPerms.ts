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
 * asked to write; it never follows a symlink and never leaves its root.
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
export async function secure(p: string, kind: "dir" | "file", perms: BackupPerms): Promise<void> {
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
		const want = kind === "dir" ? perms.dirMode : perms.fileMode;
		const gid = perms.gid ?? st.gid;
		const mode = st.mode & 0o7777;
		if (mode !== want || st.gid !== gid) {
			report.changes.push({ path: p, kind, from: { mode, gid: st.gid }, to: { mode: want, gid } });
			if (opts.write) await secure(p, kind, perms);
		}
		if (kind === "dir") {
			for (const name of (await fs.readdir(p)).sort()) await visit(path.join(p, name));
		}
	};
	await visit(root);
	return report;
}
