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
 * The group mode is for the DAILY backups only — the top-level `20*` dirs,
 * the same glob the nightly cron rotates (KEEP) and mirrors. Every other
 * backup (`pre-*`, `st-control-*`, `quarantine-*`, …) is made by hand for one
 * operation, is not mirrored, and stays root-only whatever the variable says
 * (owner, 2026-11-10).
 *
 * `hardenBackups` brings EXISTING backups in line, and only ever NARROWS: an
 * entry ends at its current mode ∩ its class's mode, so nothing private is
 * opened to the group (owner, 2026-11-10). Dry run unless asked to write; it
 * never follows a symlink, and it only enters directories nobody else can
 * modify, so no path on the way can be swapped for a link.
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

/** Root-only: what every non-daily backup gets. */
export const PRIVATE_PERMS: Readonly<BackupPerms> = { dirMode: 0o700, fileMode: 0o600, gid: null };

/**
 * A daily backup's dir name: the cron's `20*` (its retention and its rsync
 * filter use that glob), which `npm run backup`'s default ISO name matches.
 */
export function isDailyName(name: string): boolean {
	return name.startsWith("20");
}

/** The perms a backup written to `outDir` gets: the group mode only for a daily. */
export function permsForBackup(outDir: string, perms: BackupPerms): BackupPerms {
	return isDailyName(path.basename(path.resolve(outDir))) ? perms : { ...PRIVATE_PERMS };
}

export function backupPerms(env: NodeJS.ProcessEnv = process.env): BackupPerms {
	const raw = env.BACKUP_GROUP_GID?.trim();
	if (!raw) return { ...PRIVATE_PERMS };
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
	/** Never add a bit: the mode becomes current ∩ the perms' (hardenBackups). */
	opts: { narrowOnly?: boolean } = {},
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
		const want = kind === "dir" ? perms.dirMode : perms.fileMode;
		// The intersection is taken on the OPENED entry's mode, not the caller's
		// earlier lstat: a mode changed in between is still only narrowed.
		// Mode BEFORE group: the other way round, a group-writable file would be
		// writable by the new group between the two calls, and a descriptor
		// opened then keeps that access after the chmod.
		await fh.chmod(opts.narrowOnly ? st.mode & 0o7777 & want : want);
		if (perms.gid !== null && st.gid !== perms.gid) await fh.chown(st.uid, perms.gid);
	} finally {
		await fh.close();
	}
}

/** `daily`: the `.backups` root and the `20*` trees; `private`: everything else. */
export type HardenClass = "daily" | "private";

export interface HardenChange {
	path: string;
	kind: "dir" | "file";
	class: HardenClass;
	from: { mode: number; gid: number };
	to: { mode: number; gid: number };
}

export interface HardenReport {
	changes: HardenChange[];
	/** Symlinks and special files: reported, never followed or touched. */
	skipped: Array<{ path: string; reason: string }>;
	/**
	 * With BACKUP_GROUP_GID: daily entries the group still cannot read after
	 * the pass, because reaching it would ADD bits and harden never does. The
	 * mirror running as that group fails on them; widening is a decision for
	 * the operator, by hand.
	 */
	groupUnreadable: string[];
	written: boolean;
}

/**
 * Walk `root` (the `.backups` dir) and narrow every directory and regular file
 * under it — root included — to its class's mode: the root and the `20*`
 * trees to `perms` (group mode when BACKUP_GROUP_GID is set), everything else
 * to PRIVATE_PERMS with its group left as it is. `write: false` only reports.
 */
export async function hardenBackups(
	root: string,
	perms: BackupPerms,
	opts: { write: boolean },
): Promise<HardenReport> {
	const report: HardenReport = {
		changes: [],
		skipped: [],
		groupUnreadable: [],
		written: opts.write,
	};
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
	// The classes are decided by the names directly under `.backups`: pointed at
	// one backup, the walk would take its contents for top-level entries and
	// narrow a daily's files as private (breaking the mirror without a report).
	if (
		isDailyName(path.basename(path.resolve(root))) ||
		(await fs.lstat(path.join(root, "manifest.json")).then(
			() => true,
			() => false,
		))
	) {
		throw new Error(`${root} is one backup, not the backups directory — point harden at .backups`);
	}
	if (!trusted(rootSt)) {
		throw new Error(
			`${root} must be owned by uid ${me} and writable by nobody else to be hardened — refusing`,
		);
	}
	const visit = async (p: string, cls: HardenClass): Promise<void> => {
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
		const target = cls === "daily" ? perms : PRIVATE_PERMS;
		const mode = st.mode & 0o7777;
		const to = {
			mode: mode & (kind === "dir" ? target.dirMode : target.fileMode),
			gid: target.gid ?? st.gid,
		};
		if (mode !== to.mode || st.gid !== to.gid) {
			report.changes.push({ path: p, kind, class: cls, from: { mode, gid: st.gid }, to });
			if (opts.write) {
				await secure(p, kind, target, { dev: st.dev, ino: st.ino }, { narrowOnly: true });
			}
		}
		const groupNeeds = kind === "dir" ? 0o050 : 0o040;
		if (cls === "daily" && perms.gid !== null && (to.mode & groupNeeds) !== groupNeeds) {
			report.groupUnreadable.push(p);
		}
		if (kind === "dir") {
			for (const name of (await fs.readdir(p)).sort()) {
				const child = path.join(p, name);
				// Below the root a tree keeps its class; at the top only a `20*`
				// directory is a daily — a loose file there is private.
				const childCls: HardenClass =
					p !== root ? cls : isDailyName(name) && (await isDir(child)) ? "daily" : "private";
				await visit(child, childCls);
			}
		}
	};
	await visit(root, "daily");
	return report;
}

async function isDir(p: string): Promise<boolean> {
	return fs.lstat(p).then(
		(st) => st.isDirectory(),
		() => false,
	);
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
