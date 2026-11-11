/**
 * projects/conversation/store.ts — the project conversation's single writer
 * (docs/PROJECT_CONVERSATION.md §2, §2.1, §3.4, §8).
 *
 * Constructed only with PROJECT_CONVERSATION_ENABLED on. It first takes the
 * cross-process writer lock (writerLock.ts); without it every operation is
 * `project-writer-unavailable` and nothing under `.projects/` is touched.
 *
 * `critical(pid, fn)` is the only way to write: it runs `fn` under the
 * project's in-process lock, with the folded state and an `append` that
 * goes through the log's rules (fsync, poison, size check). Every critical
 * section of §3.3 (S1–S4), §4 and §7 is one call. Nothing else holds the
 * lock, and no effect or D1 call may run inside `fn` — that is the caller's
 * contract, stated again in §3.3.
 *
 * Opening a project (first `critical` on it) is where the durable rules of
 * §8 and §3.4 apply, in this order: an open restore journal ⇒ the project is
 * `restore-incomplete` (never opened, never replaced by an empty log); a
 * `RESTORED` marker ⇒ the restore rules; otherwise the boot rules. Opening
 * writes its recovery batch before any caller sees the state.
 */

import { constants as FS, promises as fs } from "node:fs";
import path from "node:path";
import { fsyncDir } from "../../recreateAttempt.js";
import { emptyFold, type Folded, fold } from "./fold.js";
import { type LogLine, type NewEvent, ProjectLog, ProjectLogError } from "./log.js";
import {
	PROJECT_ID_RE,
	projectDir,
	projectsRoot,
	RESTORED_MARKER,
	restoreJournalPath,
	writerLockPath,
} from "./paths.js";
import { interleavedWriters, type RecoverySource, recoveryEvents } from "./recovery.js";
import { type AcquireFailure, acquireWriterLock, type WriterLock } from "./writerLock.js";

/** `PROJECT_CONVERSATION_ENABLED`: only `true` / `1` turn it on (same rule as the other flags). */
export function projectConversationFlagEnabled(raw: string | undefined): boolean {
	const v = (raw ?? "").trim().toLowerCase();
	return v === "true" || v === "1";
}

export interface CriticalTx {
	readonly state: Folded;
	append(events: NewEvent[], opts?: { allowMargin?: boolean }): Promise<LogLine[]>;
}

interface OpenProject {
	log: ProjectLog;
	state: Folded;
	/** Every acknowledged line, in seq order: reads are served from here (≤ the log's cap). */
	lines: LogLine[];
}

export type AppendListener = (projectId: string, lines: readonly LogLine[]) => void;

export interface StoreOptions {
	workspaceRoot: string;
	bootId: string;
	maxBytes?: number;
	acquire?: typeof acquireWriterLock;
	now?: () => Date;
	/** Test seam, passed to every log (log.ts `syncFile`). */
	syncFile?: (fh: fs.FileHandle) => Promise<void>;
	log?: { info(m: string): void; warn(m: string): void; error(m: string): void };
}

export class ProjectConversationStore {
	private readonly open = new Map<string, OpenProject>();
	private readonly chains = new Map<string, Promise<unknown>>();
	private readonly listeners = new Set<AppendListener>();
	private lost = false;
	private closed = false;

	private constructor(
		private readonly opts: StoreOptions,
		private readonly lock: WriterLock | null,
		readonly unavailable: AcquireFailure | null,
	) {
		lock?.onLost(() => {
			this.lost = true;
			for (const p of this.open.values()) p.log.poison("writer lock lost");
			opts.log?.error(
				"[projects] writer lock LOST — project conversation stops writing until restart",
			);
		});
	}

	static async start(opts: StoreOptions): Promise<ProjectConversationStore> {
		const root = projectsRoot(opts.workspaceRoot);
		let r: Awaited<ReturnType<typeof acquireWriterLock>>;
		try {
			await ensureDir(root);
			r = await (opts.acquire ?? acquireWriterLock)(writerLockPath(opts.workspaceRoot));
		} catch (err) {
			// §2.1 point 2: without the lock this subsystem is off — the rest of
			// the backend boots as usual.
			r = { ok: false, reason: "error", detail: (err as Error).message };
		}
		if (!r.ok) {
			opts.log?.error(
				`[projects] writer lock not acquired (${r.reason}${r.detail ? `: ${r.detail}` : ""}) — ` +
					"project conversation OFF in this process (503 project-writer-unavailable)",
			);
			return new ProjectConversationStore(opts, null, r.reason);
		}
		opts.log?.info("[projects] writer lock held");
		return new ProjectConversationStore(opts, r.lock, null);
	}

	private lockHeld = (): boolean => !this.lost && (this.lock?.held() ?? false);

	/** Runs `fn` under the project's lock with its folded state (§3.3). */
	async critical<T>(pid: string, fn: (tx: CriticalTx) => Promise<T>): Promise<T> {
		if (!PROJECT_ID_RE.test(pid)) throw new Error(`invalid project id ${JSON.stringify(pid)}`);
		const prev = this.chains.get(pid) ?? Promise.resolve();
		const run = prev.then(
			() => this.runCritical(pid, fn),
			() => this.runCritical(pid, fn),
		);
		const tail = run.catch(() => {});
		this.chains.set(pid, tail);
		void tail.then(() => {
			if (this.chains.get(pid) === tail) this.chains.delete(pid);
		});
		return run;
	}

	private async runCritical<T>(pid: string, fn: (tx: CriticalTx) => Promise<T>): Promise<T> {
		if (this.closed || this.unavailable || !this.lockHeld()) {
			throw new ProjectLogError("project-writer-unavailable", "writer lock not held");
		}
		const p = this.open.get(pid) ?? (await this.openProject(pid));
		const tx: CriticalTx = {
			state: p.state,
			append: async (events, o) => {
				const lines = await p.log.append(events, o);
				fold(p.state, lines);
				p.lines.push(...lines);
				this.emit(pid, lines);
				return lines;
			},
		};
		return fn(tx);
	}

	private async openProject(pid: string): Promise<OpenProject> {
		const root = this.opts.workspaceRoot;
		// An open journal: a restore of this project started and did not
		// finish. Opening (or creating an empty log in its place) would read a
		// restored log without its restore rules, or bury it (§8).
		if (await exists(restoreJournalPath(root, pid))) {
			throw new ProjectLogError("project-log-unverifiable", "restore-incomplete");
		}
		const dir = projectDir(root, pid);
		await ensureDir(dir);
		const { log, lines, truncatedBytes } = await ProjectLog.open(dir, this.opts.bootId, {
			lockHeld: this.lockHeld,
			now: this.opts.now,
			maxBytes: this.opts.maxBytes,
			syncFile: this.opts.syncFile,
		});
		try {
			const state = fold(emptyFold(), lines);
			const marker = await readRestoredMarker(dir);
			const src: RecoverySource = marker
				? { source: "restore", restoreId: marker.restoreId, manifestAt: marker.manifestAt }
				: { source: "boot" };
			const events = recoveryEvents(state, src, {
				bootId: this.opts.bootId,
				truncatedBytes,
				interleavedWriters: interleavedWriters(lines),
			});
			const all = [...lines];
			if (events.length > 0) {
				const written = await log.append(events, { allowMargin: true });
				fold(state, written);
				all.push(...written);
			}
			if (marker) {
				// After the recovery batch is durable. A death before this rename
				// re-runs the restore rules next time; they are idempotent by
				// restore_id (recovery.ts), so nothing changes twice.
				await fs.rename(
					path.join(dir, RESTORED_MARKER),
					path.join(dir, `${RESTORED_MARKER}.consumed-${this.opts.bootId}`),
				);
				await fsyncDir(dir);
				this.opts.log?.warn(
					`[projects] ${pid}: restored log opened under the restore rules (${marker.restoreId})`,
				);
			}
			const p = { log, state, lines: all };
			if (this.lost) log.poison("writer lock lost");
			this.open.set(pid, p);
			return p;
		} catch (err) {
			await log.close();
			throw err;
		}
	}

	/** Live lines after each durable append (the project WS, §5). Returns the unsubscribe. */
	onAppend(listener: AppendListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(pid: string, lines: readonly LogLine[]): void {
		for (const l of this.listeners) {
			try {
				l(pid, lines);
			} catch {
				/* a listener never breaks a write */
			}
		}
	}

	/**
	 * A read view of an opened project (opening it first, which runs its
	 * recovery). The returned lines are the acknowledged log at this moment.
	 */
	async view(pid: string): Promise<{ state: Folded; lines: readonly LogLine[] }> {
		return this.critical(pid, async (tx) => {
			const p = this.open.get(pid);
			return { state: tx.state, lines: p ? p.lines.slice() : [] };
		});
	}

	/** Opens every project on disk (boot): recovery runs now, not at the first request. */
	async openAll(): Promise<string[]> {
		let names: string[];
		try {
			names = await fs.readdir(projectsRoot(this.opts.workspaceRoot));
		} catch {
			return [];
		}
		const opened: string[] = [];
		for (const n of names.filter((x) => PROJECT_ID_RE.test(x))) {
			try {
				await this.critical(n, async () => {});
				opened.push(n);
			} catch (err) {
				this.opts.log?.warn(`[projects] ${n}: not opened at boot (${(err as Error).message})`);
			}
		}
		return opened;
	}

	/** Lets the helper go; for graceful shutdown and tests. */
	async close(): Promise<void> {
		this.closed = true;
		for (const p of this.open.values()) await p.log.close();
		this.open.clear();
		this.lock?.release();
	}
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

/**
 * mkdir 0700 under an existing parent, then fsync the parent (§2: a created
 * directory must survive a crash before anything in it is acknowledged).
 * Only `.projects/` (parent: the workspace root) and `.projects/<pid>/` are
 * created here.
 */
async function ensureDir(dir: string): Promise<void> {
	try {
		const st = await fs.lstat(dir);
		if (!st.isDirectory())
			throw new ProjectLogError("project-log-unverifiable", `${dir} is not a directory`);
		return;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	try {
		await fs.mkdir(dir, { mode: 0o700 });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}
	await fsyncDir(path.dirname(dir));
}

async function readRestoredMarker(
	dir: string,
): Promise<{ restoreId: string; manifestAt: string | null } | null> {
	let fh: fs.FileHandle;
	try {
		fh = await fs.open(
			path.join(dir, RESTORED_MARKER),
			FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK,
		);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new ProjectLogError(
			"project-log-unverifiable",
			`RESTORED unreadable: ${(err as Error).message}`,
		);
	}
	try {
		const st = await fh.stat();
		if (!st.isFile() || st.size > 4096) throw new Error("not a small regular file");
		const v = JSON.parse(await fh.readFile("utf8")) as {
			restore_id?: unknown;
			manifest_at?: unknown;
		};
		if (typeof v.restore_id !== "string" || v.restore_id === "") throw new Error("no restore_id");
		return {
			restoreId: v.restore_id,
			manifestAt: typeof v.manifest_at === "string" ? v.manifest_at : null,
		};
	} catch (err) {
		// A marker we cannot read still says "this came from a backup": never
		// fall back to the ordinary boot rules.
		throw new ProjectLogError(
			"project-log-unverifiable",
			`RESTORED unreadable: ${(err as Error).message}`,
		);
	} finally {
		await fh.close();
	}
}
