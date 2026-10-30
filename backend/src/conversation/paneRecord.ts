/**
 * conversation/paneRecord.ts — the durable representation of a composer
 * operation that may still block its pane (docs/CONVERSATION.md §8.1.4.1).
 *
 * One file per pane with an operation that is not `released`:
 * `<WORKSPACE_ROOT>/.st-control/<sid>/composer/<paneDigits>.json`, written
 * with the recreation record's primitive (temp + fsync + rename, then an
 * fsync of the directory; an fsync error is a write error). It lives
 * OUTSIDE the events log on purpose: L7 rotation and the 256-id window of
 * the conversation index apply to released operations only; a pending
 * one must survive both and a restart. A record that does not parse, has an
 * unknown version or names another session is `unreadable`, which the
 * composer treats as "the whole session is unverifiable" — never deleted
 * automatically.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { CONTROL_DIR, fsyncDir, SESSION_ID_RE } from "../recreateAttempt.js";
import { PANE_ID_RE } from "./composerText.js";

export type OperationState =
	| "prepared"
	| "entered"
	| "failed"
	| "uncertain"
	| "delivered"
	| "unconfirmed"
	| "misdelivered"
	| "resolved"
	| "released";
export type OperationResult =
	| "pending"
	| "delivered"
	| "unconfirmed"
	| "misdelivered"
	| "failed"
	| "resolved";
export type OperationPhase = "active" | "completed" | "cancelled";
export type ExecStep = "precheck" | "paste" | "newline" | "enter";

export interface ExecEntry {
	id: string;
	step: ExecStep;
	created_at: string;
	settled: null | { exit_code: number; at: string };
}

export interface PaneRecord {
	v: 1;
	sid: string;
	pane_id: string;
	pane_pid: number;
	container_id: string;
	cid: string;
	client_message_id: string;
	text_hash: string;
	prepared_at: string;
	state: OperationState;
	result: OperationResult;
	phase: OperationPhase;
	cancelled_at?: string;
	cancel_reason?: string;
	execs: ExecEntry[];
	/** How effects got settled when they did (§8.1.4 regla 7). */
	evidence?: "inspected" | "container-gone" | "none-created";
	/** The HTTP answer recorded for replay once `result` is final. */
	http?: { status: number; body: Record<string, unknown> };
	updated_at: string;
}

export type PaneRecordRead =
	| { kind: "none" }
	| { kind: "ok"; record: PaneRecord }
	| { kind: "unreadable"; error: string };

const KEYS = new Set([
	"v",
	"sid",
	"pane_id",
	"pane_pid",
	"container_id",
	"cid",
	"client_message_id",
	"text_hash",
	"prepared_at",
	"state",
	"result",
	"phase",
	"cancelled_at",
	"cancel_reason",
	"execs",
	"evidence",
	"http",
	"updated_at",
]);
const STATES: ReadonlySet<string> = new Set([
	"prepared",
	"entered",
	"failed",
	"uncertain",
	"delivered",
	"unconfirmed",
	"misdelivered",
	"resolved",
	"released",
]);
const RESULTS: ReadonlySet<string> = new Set([
	"pending",
	"delivered",
	"unconfirmed",
	"misdelivered",
	"failed",
	"resolved",
]);
const PHASES: ReadonlySet<string> = new Set(["active", "completed", "cancelled"]);
const STEPS: ReadonlySet<string> = new Set(["precheck", "paste", "newline", "enter"]);

function parseRecord(raw: string, sid: string, paneDigits: string): PaneRecord {
	const r = JSON.parse(raw) as Record<string, unknown>;
	if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error("not an object");
	for (const k of Object.keys(r)) if (!KEYS.has(k)) throw new Error(`unknown key ${k}`);
	const str = (k: string) => {
		if (typeof r[k] !== "string" || (r[k] as string).length === 0) throw new Error(`bad ${k}`);
		return r[k] as string;
	};
	if (r.v !== 1) throw new Error("unknown version");
	if (str("sid") !== sid) throw new Error("record names another session");
	const pane_id = str("pane_id");
	if (!PANE_ID_RE.test(pane_id) || pane_id.slice(1) !== paneDigits)
		throw new Error("pane mismatch");
	if (typeof r.pane_pid !== "number" || !Number.isInteger(r.pane_pid) || r.pane_pid < 1)
		throw new Error("bad pane_pid");
	const state = str("state");
	const result = str("result");
	const phase = str("phase");
	if (!STATES.has(state) || !RESULTS.has(result) || !PHASES.has(phase))
		throw new Error("bad state");
	if (!Array.isArray(r.execs)) throw new Error("bad execs");
	const execs: ExecEntry[] = r.execs.map((e) => {
		const x = e as Record<string, unknown>;
		if (
			!x ||
			typeof x.id !== "string" ||
			!x.id ||
			typeof x.step !== "string" ||
			!STEPS.has(x.step) ||
			typeof x.created_at !== "string"
		) {
			throw new Error("bad exec entry");
		}
		const settled = x.settled;
		if (settled !== null) {
			const s = settled as Record<string, unknown>;
			if (!s || typeof s.exit_code !== "number" || typeof s.at !== "string")
				throw new Error("bad settled");
		}
		return {
			id: x.id,
			step: x.step as ExecStep,
			created_at: x.created_at,
			settled: settled as ExecEntry["settled"],
		};
	});
	const out: PaneRecord = {
		v: 1,
		sid,
		pane_id,
		pane_pid: r.pane_pid,
		container_id: str("container_id"),
		cid: str("cid"),
		client_message_id: str("client_message_id"),
		text_hash: str("text_hash"),
		prepared_at: str("prepared_at"),
		state: state as OperationState,
		result: result as OperationResult,
		phase: phase as OperationPhase,
		execs,
		updated_at: str("updated_at"),
	};
	if (r.cancelled_at !== undefined) out.cancelled_at = str("cancelled_at");
	if (r.cancel_reason !== undefined) out.cancel_reason = str("cancel_reason");
	if (r.evidence !== undefined) {
		if (
			r.evidence !== "inspected" &&
			r.evidence !== "container-gone" &&
			r.evidence !== "none-created"
		)
			throw new Error("bad evidence");
		out.evidence = r.evidence;
	}
	if (r.http !== undefined) {
		const h = r.http as Record<string, unknown>;
		if (!h || typeof h.status !== "number" || !h.body || typeof h.body !== "object")
			throw new Error("bad http");
		out.http = { status: h.status, body: h.body as Record<string, unknown> };
	}
	return out;
}

export class PaneRecordStore {
	constructor(private readonly workspaceRoot: string) {}

	dir(sid: string): string {
		if (!SESSION_ID_RE.test(sid)) throw new Error("[composer] unsafe session id");
		const root = path.resolve(this.workspaceRoot, CONTROL_DIR);
		const d = path.resolve(root, sid, "composer");
		if (!d.startsWith(root + path.sep)) throw new Error("[composer] control dir escapes its root");
		return d;
	}

	file(sid: string, paneId: string): string {
		if (!PANE_ID_RE.test(paneId)) throw new Error("[composer] unsafe pane id");
		return path.join(this.dir(sid), `${paneId.slice(1)}.json`);
	}

	async read(sid: string, paneId: string): Promise<PaneRecordRead> {
		const file = this.file(sid, paneId);
		let raw: string;
		try {
			raw = await fs.readFile(file, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
			return { kind: "unreadable", error: (err as NodeJS.ErrnoException).code ?? "read error" };
		}
		try {
			return { kind: "ok", record: parseRecord(raw, sid, paneId.slice(1)) };
		} catch (err) {
			return { kind: "unreadable", error: (err as Error).message };
		}
	}

	/** Every record of the session; `unreadable` lists files that could not be trusted. */
	async list(sid: string): Promise<{ records: PaneRecord[]; unreadable: string[] }> {
		const dir = this.dir(sid);
		let names: string[];
		try {
			names = await fs.readdir(dir);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return { records: [], unreadable: [] };
			return {
				records: [],
				unreadable: [`<dir>:${(err as NodeJS.ErrnoException).code ?? "readdir"}`],
			};
		}
		const records: PaneRecord[] = [];
		const unreadable: string[] = [];
		for (const name of names) {
			if (name.startsWith(".") || name.endsWith(".tmp")) continue;
			const m = name.match(/^(\d{1,9})\.json$/);
			if (!m) {
				unreadable.push(`${name}:unexpected-file`);
				continue;
			}
			const r = await this.read(sid, `%${m[1]}`);
			if (r.kind === "ok") records.push(r.record);
			else if (r.kind === "unreadable") unreadable.push(`${name}:${r.error}`);
		}
		return { records, unreadable };
	}

	/**
	 * Atomic, durable write: temp file, fsync, rename over the target,
	 * fsync of the directory. Any error propagates and the caller must not
	 * treat the record as written.
	 */
	async write(record: PaneRecord): Promise<void> {
		const file = this.file(record.sid, record.pane_id);
		const dir = path.dirname(file);
		await fs.mkdir(dir, { recursive: true });
		const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
		const fh = await fs.open(tmp, "wx", 0o600);
		try {
			try {
				await fh.writeFile(JSON.stringify(record), "utf8");
				await fh.sync();
			} finally {
				await fh.close();
			}
			await fs.rename(tmp, file);
		} catch (err) {
			// Never leave a temp file behind: `list()` would otherwise see it.
			await fs.rm(tmp, { force: true }).catch(() => undefined);
			throw err;
		}
		await fsyncDir(dir);
	}

	/** Session ids that have a composer directory (admin stats). */
	async sessionsWithRecords(): Promise<string[]> {
		const root = path.resolve(this.workspaceRoot, CONTROL_DIR);
		let names: string[];
		try {
			names = await fs.readdir(root);
		} catch {
			return [];
		}
		const out: string[] = [];
		for (const n of names) {
			if (!SESSION_ID_RE.test(n)) continue;
			try {
				const entries = await fs.readdir(path.join(root, n, "composer"));
				if (entries.length > 0) out.push(n);
			} catch {
				/* no composer dir */
			}
		}
		return out;
	}

	/** Retire the record after `released` was persisted. Idempotent. */
	async remove(sid: string, paneId: string): Promise<void> {
		const file = this.file(sid, paneId);
		await fs.rm(file, { force: true });
		await fsyncDir(path.dirname(file)).catch(() => undefined);
	}
}
