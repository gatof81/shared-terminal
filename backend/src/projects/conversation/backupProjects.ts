/**
 * projects/conversation/backupProjects.ts — backup and restore of
 * `.projects/` (docs/PROJECT_CONVERSATION.md §8). Called from backup.ts.
 *
 * Backup runs in another process and cannot take the project lock, so it
 * never tars the live directory: it builds a STAGING copy (the log up to its
 * last acknowledged batch, artifacts whose content matches their name; no
 * temp files, no index) and tars that, with every member named.
 *
 * Restore never extracts over a live project. It takes the writer lock
 * (so no backend has a log open), requires the flag off, and per project:
 *
 *   0. journal `{phase: staging}`   — from here the project is "in restore"
 *   1. extract + verify into `.restore-staging/<pid>.<rid>.<n>/`, then write
 *      RESTORED inside the staging dir
 *   2. journal `{phase: publishing}`
 *   3. with --force, move an existing `.projects/<pid>` aside (never delete)
 *   4. rename the staging dir to `.projects/<pid>`
 *   5. close the journal (`<pid>.<rid>.done`)
 *
 * The store refuses a project with an open journal and applies the restore
 * rules to a directory carrying RESTORED, so a death at any step never lets
 * a restored log be read as an ordinary one, nor an empty log replace it.
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as FS, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fsyncDir } from "../../recreateAttempt.js";
import { LOG_FILE, parseLog } from "./log.js";
import {
	ARTIFACTS_DIR,
	PROJECT_ID_RE,
	PROJECTS_DIR,
	projectsRoot,
	RESTORE_JOURNAL_DIR,
	RESTORE_REPLACED_DIR,
	RESTORE_STAGING_DIR,
	RESTORED_MARKER,
	restoreJournalPath,
	writerLockPath,
} from "./paths.js";
import { projectConversationFlagEnabled } from "./store.js";
import { acquireWriterLock, type WriterLock } from "./writerLock.js";

const execFileP = promisify(execFile);
const tarEnv = (): NodeJS.ProcessEnv => ({ ...process.env, LC_ALL: "C" });
const SHA_RE = /^[0-9a-f]{64}$/;
/** §6.1 ARTIFACT_MAX_BYTES; anything larger in the artifacts dir is not ours. */
const ARTIFACT_MAX_BYTES = 1024 * 1024;

export interface ProjectBackupEntry {
	tarBytes: number;
	tarSha256: string;
	lastSeq: number;
	logBytes: number;
	artifacts: number;
	/** Artifact files left out because their content does not match their name. */
	skipped?: string[];
	/** The source log could not be parsed: copied up to its last newline, as evidence. */
	unverifiable?: string;
}

// ── Backup ──────────────────────────────────────────────────────────────────

export async function backupProjects(
	workspaceRoot: string,
	outDir: string,
	secureFile: (p: string) => Promise<void>,
	log: { info(m: string): void; warn(m: string): void },
): Promise<Record<string, ProjectBackupEntry>> {
	const root = projectsRoot(workspaceRoot);
	let names: string[];
	try {
		names = await fs.readdir(root);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw err;
	}
	const pids = names.filter((n) => PROJECT_ID_RE.test(n)).sort();
	const out: Record<string, ProjectBackupEntry> = {};
	if (pids.length === 0) return out;
	await fs.mkdir(path.join(outDir, "projects"), { mode: 0o700 });
	const staging = await fs.mkdtemp(path.join(outDir, ".projects-staging-"));
	try {
		for (const pid of pids) {
			const src = path.join(root, pid);
			const dst = path.join(staging, PROJECTS_DIR, pid);
			await fs.mkdir(path.join(dst, ARTIFACTS_DIR), { recursive: true, mode: 0o700 });
			const entry: ProjectBackupEntry = {
				tarBytes: 0,
				tarSha256: "",
				lastSeq: 0,
				logBytes: 0,
				artifacts: 0,
			};
			const members: string[] = [];

			const buf = await readNoFollow(path.join(src, LOG_FILE));
			if (buf !== null) {
				const parsed = parseLog(buf);
				let bytes: Buffer;
				if ("unverifiable" in parsed) {
					entry.unverifiable = parsed.unverifiable;
					bytes = buf.subarray(0, buf.lastIndexOf(0x0a) + 1);
				} else {
					bytes = buf.subarray(0, parsed.validBytes);
					entry.lastSeq = parsed.lines[parsed.lines.length - 1]?.seq ?? 0;
				}
				await fs.writeFile(path.join(dst, LOG_FILE), bytes, { mode: 0o600 });
				entry.logBytes = bytes.length;
				members.push(`${PROJECTS_DIR}/${pid}/${LOG_FILE}`);
			}

			let arts: string[] = [];
			try {
				arts = await fs.readdir(path.join(src, ARTIFACTS_DIR));
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			}
			for (const name of arts.filter((n) => SHA_RE.test(n)).sort()) {
				const content = await readNoFollow(path.join(src, ARTIFACTS_DIR, name), ARTIFACT_MAX_BYTES);
				if (content === null || sha256(content) !== name) {
					entry.skipped = [...(entry.skipped ?? []), name];
					continue;
				}
				await fs.writeFile(path.join(dst, ARTIFACTS_DIR, name), content, { mode: 0o600 });
				members.push(`${PROJECTS_DIR}/${pid}/${ARTIFACTS_DIR}/${name}`);
				entry.artifacts++;
				const meta = await readNoFollow(path.join(src, ARTIFACTS_DIR, `${name}.json`), 64 * 1024);
				if (meta !== null) {
					await fs.writeFile(path.join(dst, ARTIFACTS_DIR, `${name}.json`), meta, { mode: 0o600 });
					members.push(`${PROJECTS_DIR}/${pid}/${ARTIFACTS_DIR}/${name}.json`);
				}
			}
			if (members.length === 0) continue;

			const tarPath = path.join(outDir, "projects", `${pid}.tar.gz`);
			await execFileP("tar", ["-czf", tarPath, "-C", staging, "--", ...members], { env: tarEnv() });
			await secureFile(tarPath);
			const tarBuf = await fs.readFile(tarPath);
			entry.tarBytes = tarBuf.length;
			entry.tarSha256 = sha256(tarBuf);
			out[pid] = entry;
			if (entry.skipped)
				log.warn(
					`[backup] project ${pid}: ${entry.skipped.length} artifact(s) left out (content ≠ name)`,
				);
			if (entry.unverifiable)
				log.warn(
					`[backup] project ${pid}: log unverifiable (${entry.unverifiable}) — copied as evidence`,
				);
			log.info(
				`[backup] project ${pid}: log seq ≤ ${entry.lastSeq}, ${entry.artifacts} artifact(s)`,
			);
		}
	} finally {
		// Our own staging copy, created by this run inside this backup's dir.
		await fs.rm(staging, { recursive: true, force: true });
	}
	return out;
}

// ── Restore ─────────────────────────────────────────────────────────────────

export interface ProjectsRestorePlan {
	pids: string[];
	lock: WriterLock;
}

/**
 * Everything checked BEFORE runRestore writes anything (§8): the flag is off,
 * the writer lock is free (no backend has a log open), every tarball is a
 * project of the manifest, has the right sha256, and lists only allowlisted
 * plain files. Returns the held lock; the caller releases it at the end.
 */
export async function preflightProjectsRestore(
	inDir: string,
	projects: Record<string, ProjectBackupEntry> | undefined,
	workspaceRoot: string,
	deps: { acquire?: typeof acquireWriterLock; env?: NodeJS.ProcessEnv } = {},
): Promise<ProjectsRestorePlan | null> {
	const pids = Object.keys(projects ?? {}).sort();
	if (pids.length === 0) return null;
	if (projectConversationFlagEnabled((deps.env ?? process.env).PROJECT_CONVERSATION_ENABLED)) {
		throw new Error(
			"PROJECT_CONVERSATION_ENABLED is on: restoring .projects needs it off (and the backend's writer " +
				"lock free) — refusing before any write",
		);
	}
	for (const pid of pids) {
		if (!PROJECT_ID_RE.test(pid))
			throw new Error(`manifest project ${JSON.stringify(pid)} is not a project id`);
		const tarPath = path.join(inDir, "projects", `${pid}.tar.gz`);
		const tarBuf = await fs.readFile(tarPath);
		if (sha256(tarBuf) !== projects?.[pid]?.tarSha256)
			throw new Error(`project tarball ${pid}: sha256 mismatch`);
		const listing = (
			await execFileP("tar", ["-tvzf", tarPath], { env: tarEnv(), maxBuffer: 16 * 1024 * 1024 })
		).stdout;
		const names = (
			await execFileP("tar", ["-tzf", tarPath], { env: tarEnv(), maxBuffer: 16 * 1024 * 1024 })
		).stdout
			.split("\n")
			.filter((l) => l !== "");
		const types = listing
			.split("\n")
			.filter((l) => l !== "")
			.map((l) => l[0]);
		if (types.length !== names.length) throw new Error(`project tarball ${pid}: listing mismatch`);
		names.forEach((n, i) => {
			if (!allowedMember(pid, n) || types[i] !== "-") {
				throw new Error(`project tarball ${pid}: ${JSON.stringify(n)} is not allowed — refusing`);
			}
		});
	}
	await fs.mkdir(projectsRoot(workspaceRoot), { recursive: true, mode: 0o700 });
	const r = await (deps.acquire ?? acquireWriterLock)(writerLockPath(workspaceRoot));
	if (!r.ok) {
		throw new Error(
			`the projects writer lock is not free (${r.reason}) — a backend holds .projects open; refusing before any write`,
		);
	}
	return { pids, lock: r.lock };
}

function allowedMember(pid: string, name: string): boolean {
	const prefix = `${PROJECTS_DIR}/${pid}/`;
	if (!name.startsWith(prefix)) return false;
	const rest = name.slice(prefix.length);
	if (rest === LOG_FILE) return true;
	const m = /^artifacts\/([0-9a-f]{64})(\.json)?$/.exec(rest);
	return m !== null;
}

interface Journal {
	restore_id: string;
	phase: "staging" | "publishing";
	aside?: string;
}

export async function restoreProjects(
	inDir: string,
	manifestCreatedAt: string,
	plan: ProjectsRestorePlan,
	workspaceRoot: string,
	opts: { force?: boolean },
	log: { info(m: string): void; warn(m: string): void },
	hooks: { afterStep?: (pid: string, step: number) => Promise<void> } = {},
): Promise<void> {
	const root = projectsRoot(workspaceRoot);
	for (const d of [RESTORE_JOURNAL_DIR, RESTORE_STAGING_DIR, RESTORE_REPLACED_DIR]) {
		await fs.mkdir(path.join(root, d), { recursive: true, mode: 0o700 });
	}
	await fsyncDir(root);
	for (const pid of plan.pids) {
		const live = path.join(root, pid);
		const jPath = restoreJournalPath(workspaceRoot, pid);
		let journal = await readJournal(jPath);
		// The journal is looked at BEFORE the no-clobber rule: a rerun after a
		// death between publish and close finds the destination present.
		if (!journal) {
			if ((await exists(live)) && !opts.force) {
				log.warn(
					`[restore] project ${pid}: destination exists — kept (pass --force to replace it)`,
				);
				continue;
			}
			journal = { restore_id: randomUUID(), phase: "staging" };
			await writeJournal(jPath, journal);
			await hooks.afterStep?.(pid, 0);
		}
		const rid = journal.restore_id;

		if (await hasMarker(live, rid)) {
			await closeJournal(jPath, pid, rid);
			log.info(`[restore] project ${pid}: already published (${rid}); journal closed`);
			continue;
		}

		const stagings = await completeStagings(root, pid, rid);
		if (stagings.length > 1) {
			log.warn(
				`[restore] project ${pid}: ${stagings.length} complete stagings for ${rid} — not touching anything`,
			);
			continue;
		}
		let staged = stagings[0];
		if (!staged) {
			staged = await stage(inDir, manifestCreatedAt, root, pid, rid, workspaceRoot, log);
			await hooks.afterStep?.(pid, 1);
		}

		if (journal.phase === "staging") {
			journal = { restore_id: rid, phase: "publishing" };
			if (await exists(live)) {
				if (!opts.force) {
					log.warn(
						`[restore] project ${pid}: destination appeared — journal left open, run again with --force`,
					);
					continue;
				}
				journal.aside = path.join(root, RESTORE_REPLACED_DIR, `${pid}.${rid}`);
			}
			await writeJournal(jPath, journal);
			await hooks.afterStep?.(pid, 2);
		}
		if (journal.aside && (await exists(live)) && !(await exists(journal.aside))) {
			await fs.rename(live, journal.aside);
			await fsyncDir(root);
			await fsyncDir(path.dirname(journal.aside));
			await hooks.afterStep?.(pid, 3);
		}
		try {
			await fs.rename(staged, live);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "EEXIST" || code === "ENOTEMPTY") {
				log.warn(
					`[restore] project ${pid}: destination exists — journal left open (rerun with --force)`,
				);
				continue;
			}
			throw err;
		}
		await fsyncDir(root);
		await fsyncDir(path.join(root, RESTORE_STAGING_DIR));
		await hooks.afterStep?.(pid, 4);
		await closeJournal(jPath, pid, rid);
		log.info(
			`[restore] project ${pid}: published (${rid}); the backend applies the restore rules when it opens it`,
		);
	}
}

async function stage(
	inDir: string,
	manifestCreatedAt: string,
	root: string,
	pid: string,
	rid: string,
	workspaceRoot: string,
	log: { warn(m: string): void },
): Promise<string> {
	const stagingRoot = path.join(root, RESTORE_STAGING_DIR);
	const taken = (await fs.readdir(stagingRoot)).filter((n) =>
		n.startsWith(`${pid}.${rid}.`),
	).length;
	const dir = path.join(stagingRoot, `${pid}.${rid}.${taken + 1}`);
	await fs.mkdir(dir, { mode: 0o700 });
	await execFileP(
		"tar",
		[
			"-xzf",
			path.join(inDir, "projects", `${pid}.tar.gz`),
			"-C",
			dir,
			"--strip-components=2",
			"--no-same-owner",
		],
		{ env: tarEnv() },
	);
	// The archive's mode bits are not trusted: every published dir is 0700
	// and every file 0600 (§2), whatever a hand-made tarball says.
	await normalizeModes(dir);
	const arts = path.join(dir, ARTIFACTS_DIR);
	if (await exists(arts)) {
		for (const name of (await fs.readdir(arts)).filter((n) => SHA_RE.test(n))) {
			const content = await readNoFollow(path.join(arts, name), ARTIFACT_MAX_BYTES);
			if (content !== null && sha256(content) === name) continue;
			const ev = path.join(workspaceRoot, ".restore-evidence", "projects", pid);
			await fs.mkdir(ev, { recursive: true, mode: 0o700 });
			await fs.rename(path.join(arts, name), path.join(ev, name));
			log.warn(
				`[restore] project ${pid}: artifact ${name} does not match its name — kept in ${ev}, not published`,
			);
		}
	}
	const marker = path.join(dir, RESTORED_MARKER);
	const fh = await fs.open(marker, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, 0o600);
	try {
		await fh.writeFile(
			`${JSON.stringify({ restore_id: rid, manifest_at: manifestCreatedAt, restored_at: new Date().toISOString() })}\n`,
		);
		await fh.sync();
	} finally {
		await fh.close();
	}
	await fsyncDir(dir);
	await fsyncDir(stagingRoot);
	return dir;
}

async function normalizeModes(dir: string): Promise<void> {
	await fs.chmod(dir, 0o700);
	for (const e of await fs.readdir(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) await normalizeModes(p);
		else if (e.isFile()) await fs.chmod(p, 0o600);
	}
}

async function completeStagings(root: string, pid: string, rid: string): Promise<string[]> {
	const stagingRoot = path.join(root, RESTORE_STAGING_DIR);
	const out: string[] = [];
	for (const n of await fs.readdir(stagingRoot)) {
		if (!n.startsWith(`${pid}.${rid}.`)) continue;
		if (await hasMarker(path.join(stagingRoot, n), rid)) out.push(path.join(stagingRoot, n));
	}
	return out;
}

async function hasMarker(dir: string, rid: string): Promise<boolean> {
	const buf = await readNoFollow(path.join(dir, RESTORED_MARKER), 4096);
	if (buf === null) return false;
	try {
		return (JSON.parse(buf.toString("utf8")) as { restore_id?: unknown }).restore_id === rid;
	} catch {
		return false;
	}
}

async function readJournal(p: string): Promise<Journal | null> {
	const buf = await readNoFollow(p, 4096);
	if (buf === null) return null;
	const j = JSON.parse(buf.toString("utf8")) as Journal;
	if (typeof j.restore_id !== "string" || (j.phase !== "staging" && j.phase !== "publishing")) {
		throw new Error(`restore journal ${p} is malformed — not touching this project`);
	}
	return j;
}

/** temp + fsync + rename + fsync of the directory (§8 step 0). */
async function writeJournal(p: string, j: Journal): Promise<void> {
	const tmp = `${p}.${randomUUID()}.tmp`;
	const fh = await fs.open(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, 0o600);
	try {
		await fh.writeFile(`${JSON.stringify(j)}\n`);
		await fh.sync();
	} finally {
		await fh.close();
	}
	await fs.rename(tmp, p);
	await fsyncDir(path.dirname(p));
}

async function closeJournal(p: string, pid: string, rid: string): Promise<void> {
	await fs.rename(p, path.join(path.dirname(p), `${pid}.${rid}.done`));
	await fsyncDir(path.dirname(p));
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.lstat(p);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw err;
	}
}

/** A regular file's bytes, never through a link, never blocking on a FIFO; null if absent or not one. */
async function readNoFollow(p: string, max = Number.POSITIVE_INFINITY): Promise<Buffer | null> {
	let fh: fs.FileHandle;
	try {
		fh = await fs.open(p, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ELOOP") return null;
		throw err;
	}
	try {
		const st = await fh.stat();
		if (!st.isFile() || st.size > max) return null;
		return await fh.readFile();
	} finally {
		await fh.close();
	}
}

function sha256(b: Buffer): string {
	return createHash("sha256").update(b).digest("hex");
}
