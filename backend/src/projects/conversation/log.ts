/**
 * projects/conversation/log.ts — one project's append-only event log
 * (docs/PROJECT_CONVERSATION.md §2).
 *
 * `<WORKSPACE_ROOT>/.projects/<pid>/conversation.events.jsonl`, one JSON
 * object per line, `seq` assigned here and contiguous from 1. The rules that
 * make it a delivery record and not a best-effort log:
 *
 *   - an append resolves only after `write` + `fsync` of the file; nothing
 *     is ever queued or dropped (contrast conversation/store.ts, which
 *     degrades into `gap backpressure`);
 *   - any write or fsync error POISONS the log until it is reopened. After a
 *     failed fsync Linux may report a later one as successful although the
 *     earlier pages were lost, and a half-written line followed by another
 *     append would glue two lines into one unreadable line — making a
 *     `sending` that WAS sent unreadable, so recovery would call it
 *     `not-sent`;
 *   - before each append the file's size must be the one this writer left:
 *     anything else means another writer (§2.1 point 4) and poisons too;
 *   - a batch is one write; every line carries `bn` (lines still to come in
 *     its batch), so on open a batch cut by a crash is dropped whole — its
 *     fsync never completed, so nobody was told it was written.
 *
 * On open: a torn tail (bytes after the last `\n`) and an incomplete last
 * batch are truncated away (they were never acknowledged); an unreadable
 * line anywhere else makes the log `unverifiable` — readable, never
 * appended to, never repaired automatically.
 */

import { constants as FS, promises as fs } from "node:fs";
import path from "node:path";
import { fsyncDir } from "../../recreateAttempt.js";

export const LOG_FILE = "conversation.events.jsonl";
export const PROJECT_LOG_MAX_BYTES_DEFAULT = 64 * 1024 * 1024;
/** What in-flight deliveries and recovery may still write past the cap (§2). */
export const PROJECT_LOG_MARGIN_BYTES = 1024 * 1024;

export interface LogLine {
	seq: number;
	ev: string;
	at: string;
	/** The writer's boot id (§2.1 point 4). */
	w: string;
	/** Lines still to come in this line's batch; 0 on the last one. */
	bn: number;
	[k: string]: unknown;
}

export type NewEvent = { ev: string } & Record<string, unknown>;

export class ProjectLogError extends Error {
	constructor(
		readonly code:
			| "persist-failed"
			| "project-log-unverifiable"
			| "project-log-full"
			| "project-writer-unavailable",
		message: string,
	) {
		super(message);
		this.name = "ProjectLogError";
	}
}

export interface ParsedLog {
	lines: LogLine[];
	/** Bytes of whole, acknowledged batches. */
	validBytes: number;
	/** Bytes dropped from the end (torn tail + incomplete last batch). */
	tailBytes: number;
}

/**
 * Pure. `unverifiable` ⇔ a complete line in the acknowledged part is not a
 * well-formed event with the next `seq`.
 */
export function parseLog(buf: Buffer): ParsedLog | { unverifiable: string } {
	const lastNl = buf.lastIndexOf(0x0a);
	const complete = lastNl < 0 ? 0 : lastNl + 1;
	const lines: LogLine[] = [];
	const ends: number[] = [];
	let start = 0;
	while (start < complete) {
		const nl = buf.indexOf(0x0a, start);
		const raw = buf.subarray(start, nl).toString("utf8");
		let v: unknown;
		try {
			v = JSON.parse(raw);
		} catch {
			return { unverifiable: `line ${lines.length + 1}: not JSON` };
		}
		const o = v as Partial<LogLine> | null;
		if (
			!o ||
			typeof o !== "object" ||
			Array.isArray(o) ||
			o.seq !== lines.length + 1 ||
			typeof o.ev !== "string" ||
			typeof o.at !== "string" ||
			typeof o.w !== "string" ||
			!Number.isInteger(o.bn) ||
			(o.bn as number) < 0
		) {
			return { unverifiable: `line ${lines.length + 1}: not a well-formed event` };
		}
		// Inside a batch `bn` counts down by one; a new batch may start only
		// after a line with bn = 0.
		const prev = lines[lines.length - 1];
		if (prev && prev.bn > 0 && o.bn !== prev.bn - 1) {
			return { unverifiable: `line ${lines.length + 1}: batch sequence broken` };
		}
		lines.push(o as LogLine);
		ends.push(nl + 1);
		start = nl + 1;
	}
	// Drop an incomplete last batch: everything after the last line with bn = 0.
	let keep = lines.length;
	while (keep > 0 && (lines[keep - 1] as LogLine).bn !== 0) keep--;
	const validBytes = keep === 0 ? 0 : (ends[keep - 1] as number);
	return { lines: lines.slice(0, keep), validBytes, tailBytes: buf.length - validBytes };
}

export interface LogDeps {
	/** False ⇒ the cross-process lock is gone: poison before writing (§2.1 point 3). */
	lockHeld: () => boolean;
	now?: () => Date;
	maxBytes?: number;
	fsyncDir?: (dir: string) => Promise<void>;
	/** Test seam for the file's fsync (T1/T4 inject its failure). */
	syncFile?: (fh: fs.FileHandle) => Promise<void>;
}

export class ProjectLog {
	private poisoned: string | null = null;

	private constructor(
		private readonly fh: fs.FileHandle,
		readonly file: string,
		private size: number,
		private lastSeq: number,
		private readonly writerId: string,
		private readonly deps: LogDeps,
	) {}

	/**
	 * Opens (creating if absent) and returns the acknowledged lines. Truncates
	 * an unacknowledged tail; throws `project-log-unverifiable` on a bad line
	 * in the middle. The caller must hold the writer lock.
	 */
	static async open(
		dir: string,
		writerId: string,
		deps: LogDeps,
	): Promise<{ log: ProjectLog; lines: LogLine[]; truncatedBytes: number }> {
		const file = path.join(dir, LOG_FILE);
		const sync = deps.fsyncDir ?? fsyncDir;
		let fh: fs.FileHandle;
		try {
			fh = await fs.open(file, FS.O_RDWR | FS.O_APPEND | FS.O_NOFOLLOW);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			fh = await fs.open(
				file,
				FS.O_RDWR | FS.O_APPEND | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW,
				0o600,
			);
		}
		try {
			const st = await fh.stat();
			if (!st.isFile()) throw new ProjectLogError("project-log-unverifiable", "not a regular file");
			// On EVERY open, not only when this call created the file: a creation
			// whose directory fsync failed (EIO) throws, but the file is already
			// there, so the next open would find it, skip the syncs and go on to
			// acknowledge appends to a file whose directory entry the disk may
			// still lose. Re-syncing here is idempotent and costs one fsync pair
			// per project load. The parent chain (`.projects/<pid>/` in
			// `.projects/`, `.projects/` in the workspace root) is re-synced the
			// same way by the store's `ensureDir`.
			await fh.sync();
			await sync(dir);
			const buf = st.size === 0 ? Buffer.alloc(0) : await readAll(fh, st.size);
			const parsed = parseLog(buf);
			if ("unverifiable" in parsed) {
				throw new ProjectLogError("project-log-unverifiable", `${file}: ${parsed.unverifiable}`);
			}
			if (parsed.tailBytes > 0) {
				await fh.truncate(parsed.validBytes);
				await fh.sync();
			}
			const last = parsed.lines[parsed.lines.length - 1];
			const log = new ProjectLog(fh, file, parsed.validBytes, last?.seq ?? 0, writerId, deps);
			return { log, lines: parsed.lines, truncatedBytes: parsed.tailBytes };
		} catch (err) {
			await fh.close().catch(() => {});
			throw err;
		}
	}

	get isPoisoned(): boolean {
		return this.poisoned !== null;
	}

	get bytes(): number {
		return this.size;
	}

	/** Marks the log unusable (writer lock lost, …). */
	poison(reason: string): void {
		this.poisoned ??= reason;
	}

	/**
	 * Appends `events` as ONE batch and resolves after fsync with the lines as
	 * written. `allowMargin` lets in-flight deliveries and recovery write up
	 * to the cap + margin; a new message never does (§2 "Sin rotación").
	 * Callers serialise appends (the project's in-process lock).
	 */
	async append(events: NewEvent[], opts: { allowMargin?: boolean } = {}): Promise<LogLine[]> {
		if (events.length === 0) return [];
		if (this.poisoned)
			throw new ProjectLogError("persist-failed", `log poisoned: ${this.poisoned}`);
		if (!this.deps.lockHeld()) {
			this.poison("writer lock lost");
			throw new ProjectLogError("persist-failed", "writer lock lost");
		}
		const at = (this.deps.now?.() ?? new Date()).toISOString();
		const lines: LogLine[] = events.map((e, i) => {
			const { seq: _s, at: _a, w: _w, bn: _b, ...rest } = e as Record<string, unknown>;
			return {
				seq: this.lastSeq + 1 + i,
				ev: e.ev,
				at,
				w: this.writerId,
				bn: events.length - 1 - i,
				...rest,
			} as LogLine;
		});
		const buf = Buffer.from(lines.map((l) => `${JSON.stringify(l)}\n`).join(""), "utf8");
		const max = this.deps.maxBytes ?? PROJECT_LOG_MAX_BYTES_DEFAULT;
		const limit = opts.allowMargin ? max + PROJECT_LOG_MARGIN_BYTES : max;
		if (this.size + buf.length > limit) {
			throw new ProjectLogError("project-log-full", `${this.size + buf.length} > ${limit} bytes`);
		}
		try {
			const st = await this.fh.stat();
			if (st.size !== this.size) {
				this.poison(`size ${st.size} ≠ expected ${this.size}: another writer`);
				throw new ProjectLogError("persist-failed", "log changed under the writer");
			}
			let off = 0;
			while (off < buf.length) {
				const { bytesWritten } = await this.fh.write(buf, off, buf.length - off, null);
				if (bytesWritten <= 0) throw new Error("short write");
				off += bytesWritten;
			}
			await (this.deps.syncFile ? this.deps.syncFile(this.fh) : this.fh.sync());
		} catch (err) {
			if (err instanceof ProjectLogError) throw err;
			this.poison((err as Error).message);
			throw new ProjectLogError("persist-failed", (err as Error).message);
		}
		this.size += buf.length;
		this.lastSeq += lines.length;
		return lines;
	}

	async close(): Promise<void> {
		await this.fh.close().catch(() => {});
	}
}

async function readAll(fh: fs.FileHandle, size: number): Promise<Buffer> {
	const buf = Buffer.alloc(size);
	let off = 0;
	while (off < size) {
		const { bytesRead } = await fh.read(buf, off, size - off, off);
		if (bytesRead === 0) break;
		off += bytesRead;
	}
	return buf.subarray(0, off);
}
