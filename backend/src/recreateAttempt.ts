/**
 * recreateAttempt.ts — durable record of a container recreation attempt
 * and the fail-closed `recreate-unresolved` gate (CONVERSATION.md §2.7.4;
 * 3.0d).
 *
 * A recreation issues Docker requests that can still apply after the
 * backend stops waiting for them, or after the backend dies. The
 * in-process lifecycle lock (sessionLifecycleLock.ts) cannot cover either
 * case: it dies with the process. This record does. It lives on the host at
 * `<WORKSPACE_ROOT>/.st-control/<sessionId>/recreate-attempt.json`, is
 * written atomically before the attempt's first effect, and holds no
 * secret (never the ingest token or its hash).
 *
 * States (§2.7.4):
 *   - `open`      — an attempt is active in a live process that holds the
 *                   session's lifecycle lock;
 *   - `uncertain` — the attempt's epoch closed with Docker requests still
 *                   unanswered, or an `open`/`uncertain` record was found
 *                   after a backend restart;
 *   - `resolved`  — every request has an answer and the final action was
 *                   executed and observed; carries the `outcome`.
 *
 * Fail-closed (owner decision D8): a session whose record is anything but
 * `resolved` — including a record that cannot be read or parsed, or an
 * `open` one this process did not begin — refuses every incompatible
 * lifecycle operation with `recreate-unresolved`. Nothing here resolves an
 * attempt automatically: not elapsed time, not Docker quiescence, not a
 * dockerd restart. `uncertain → resolved` happens only through `resolve()`,
 * which the recreation engine calls with evidence (a later PR).
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

export const CONTROL_DIR = ".st-control";
export const RECORD_FILE = "recreate-attempt.json";
/** Resolved attempts kept to recognise leftovers of aborted attempts
 *  (§2.7.4 "sobrantes"). Not a time bound, not a guarantee. */
export const HISTORY_MAX = 32;

export type AttemptState = "open" | "uncertain" | "resolved";

export type AttemptOutcome = { kind: "committed"; nContainerId: string } | { kind: "rolled-back" };

export interface AttemptIdentity {
	attemptId: string;
	/** Id and canonical name of the existing container, O. */
	oContainerId: string;
	oCanonicalName: string;
	/** The `-old-<ts>` name O is renamed to during the attempt. */
	oOldName: string;
	/** The `-new-<ts>` name N is created with. */
	nTempName: string;
}

export interface AttemptRecord extends AttemptIdentity {
	version: 1;
	sessionId: string;
	startedAt: string;
	state: AttemptState;
	stateAt: string;
	/** Present only when `state === "resolved"`. */
	outcome?: AttemptOutcome;
	/** Short operator-facing reason for the last transition. */
	reason?: string;
	/** Set by boot recovery when the attempt's process was gone: the
	 *  answers to its Docker requests are lost for good, so nothing in
	 *  3.0d may resolve it (D8). Only a future, explicitly approved manual
	 *  recovery procedure could. */
	orphanedAt?: string;
	/** Earlier resolved attempts of this session, newest first. */
	history: Array<{ attemptId: string; outcome: AttemptOutcome; resolvedAt: string }>;
}

export type ReadResult =
	| { kind: "none" }
	| { kind: "ok"; record: AttemptRecord }
	| { kind: "unreadable"; error: string };

export class RecreateUnresolvedError extends Error {
	readonly code = "recreate-unresolved";
	constructor(
		readonly sessionId: string,
		readonly detail: string,
	) {
		super(`session ${sessionId} has an unresolved container recreation (${detail})`);
		this.name = "RecreateUnresolvedError";
	}
}

export class AttemptTransitionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AttemptTransitionError";
	}
}

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function nowIso(): string {
	return new Date().toISOString();
}

async function fsyncDir(dir: string): Promise<void> {
	// Makes the rename durable. Same best-effort shape as revocation.ts:
	// a platform that refuses to open directories still gets the rename.
	try {
		const fh = await fs.open(dir, "r");
		try {
			await fh.sync();
		} finally {
			await fh.close();
		}
	} catch {
		/* ignore */
	}
}

function isOutcome(v: unknown): v is AttemptOutcome {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	if (o.kind === "rolled-back") return Object.keys(o).length === 1;
	return (
		o.kind === "committed" &&
		typeof o.nContainerId === "string" &&
		o.nContainerId.length > 0 &&
		Object.keys(o).length === 2
	);
}

const RECORD_KEYS = new Set([
	"version",
	"sessionId",
	"attemptId",
	"oContainerId",
	"oCanonicalName",
	"oOldName",
	"nTempName",
	"startedAt",
	"state",
	"stateAt",
	"outcome",
	"reason",
	"orphanedAt",
	"history",
]);

/**
 * Strict parse. Anything unexpected — an unknown key, a wrong type, an
 * outcome on a non-resolved record — makes the record unreadable, which the
 * gate treats as unresolved: a half-understood record must never let a
 * lifecycle operation through.
 */
function parseRecord(raw: string, sessionId: string): AttemptRecord {
	const v = JSON.parse(raw) as Record<string, unknown>;
	if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
	for (const k of Object.keys(v)) if (!RECORD_KEYS.has(k)) throw new Error(`unknown key ${k}`);
	const str = (k: string) => {
		if (typeof v[k] !== "string" || (v[k] as string).length === 0) throw new Error(`bad ${k}`);
		return v[k] as string;
	};
	if (v.version !== 1) throw new Error("bad version");
	if (str("sessionId") !== sessionId) throw new Error("sessionId mismatch");
	for (const k of [
		"attemptId",
		"oContainerId",
		"oCanonicalName",
		"oOldName",
		"nTempName",
		"startedAt",
		"stateAt",
	])
		str(k);
	const state = v.state;
	if (state !== "open" && state !== "uncertain" && state !== "resolved")
		throw new Error("bad state");
	if (state === "resolved") {
		if (!isOutcome(v.outcome)) throw new Error("resolved without a valid outcome");
	} else if (v.outcome !== undefined) {
		throw new Error("outcome on an unresolved record");
	}
	if (v.reason !== undefined && typeof v.reason !== "string") throw new Error("bad reason");
	if (v.orphanedAt !== undefined && (typeof v.orphanedAt !== "string" || state !== "uncertain"))
		throw new Error("bad orphanedAt");
	if (!Array.isArray(v.history)) throw new Error("bad history");
	for (const h of v.history as unknown[]) {
		const e = h as Record<string, unknown>;
		if (
			!e ||
			typeof e.attemptId !== "string" ||
			typeof e.resolvedAt !== "string" ||
			!isOutcome(e.outcome) ||
			Object.keys(e).length !== 3
		)
			throw new Error("bad history entry");
	}
	return v as unknown as AttemptRecord;
}

export class RecreateAttemptStore {
	/** Attempt ids begun by THIS process and not yet closed. An `open`
	 *  record whose id is not here was left by a process that died. */
	private readonly active = new Set<string>();

	constructor(private readonly workspaceRoot: string) {}

	controlRoot(): string {
		return path.resolve(this.workspaceRoot, CONTROL_DIR);
	}

	controlDir(sessionId: string): string {
		if (!SESSION_ID_RE.test(sessionId)) {
			throw new Error("[recreate] unsafe session id: refusing to build a path from it");
		}
		const root = this.controlRoot();
		const dir = path.resolve(root, sessionId);
		if (!dir.startsWith(root + path.sep))
			throw new Error("[recreate] control dir escapes its root");
		return dir;
	}

	recordPath(sessionId: string): string {
		return path.join(this.controlDir(sessionId), RECORD_FILE);
	}

	async read(sessionId: string): Promise<ReadResult> {
		let raw: string;
		try {
			raw = await fs.readFile(this.recordPath(sessionId), "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
			// EACCES, EIO, a directory where the file should be…: we do not
			// know what the record says, so it counts as unresolved.
			return { kind: "unreadable", error: (err as NodeJS.ErrnoException).code ?? "read error" };
		}
		try {
			return { kind: "ok", record: parseRecord(raw, sessionId) };
		} catch (err) {
			return { kind: "unreadable", error: (err as Error).message };
		}
	}

	/**
	 * The gate. Resolves when the session has no record or a `resolved`
	 * one; throws `RecreateUnresolvedError` for anything else.
	 */
	async assertResolved(sessionId: string): Promise<void> {
		const r = await this.read(sessionId);
		if (r.kind === "none") return;
		if (r.kind === "unreadable")
			throw new RecreateUnresolvedError(sessionId, `record unreadable: ${r.error}`);
		const { record } = r;
		if (record.state === "resolved") return;
		throw new RecreateUnresolvedError(
			sessionId,
			record.state === "open" && this.active.has(record.attemptId)
				? "attempt in progress"
				: record.state === "open"
					? "open attempt from a previous backend process"
					: "attempt uncertain",
		);
	}

	/**
	 * Start an attempt: write the `open` record before any effect. Refused
	 * while a previous attempt is not resolved (or its record is
	 * unreadable). The previous resolved attempt moves into `history`.
	 */
	async begin(sessionId: string, identity: AttemptIdentity): Promise<AttemptRecord> {
		const prev = await this.read(sessionId);
		if (prev.kind === "unreadable") {
			throw new RecreateUnresolvedError(sessionId, `record unreadable: ${prev.error}`);
		}
		if (prev.kind === "ok" && prev.record.state !== "resolved") {
			throw new RecreateUnresolvedError(sessionId, `previous attempt ${prev.record.state}`);
		}
		const history =
			prev.kind === "ok"
				? [
						{
							attemptId: prev.record.attemptId,
							outcome: prev.record.outcome as AttemptOutcome,
							resolvedAt: prev.record.stateAt,
						},
						...prev.record.history,
					].slice(0, HISTORY_MAX)
				: [];
		const at = nowIso();
		const record: AttemptRecord = {
			version: 1,
			sessionId,
			...identity,
			startedAt: at,
			state: "open",
			stateAt: at,
			history,
		};
		await this.write(sessionId, record);
		this.active.add(identity.attemptId);
		return record;
	}

	/** `open → uncertain`: the epoch closed with Docker requests unanswered. */
	async markUncertain(
		sessionId: string,
		attemptId: string,
		reason: string,
	): Promise<AttemptRecord> {
		const record = await this.current(sessionId, attemptId);
		if (record.state !== "open") {
			throw new AttemptTransitionError(
				`cannot mark ${record.state} attempt ${attemptId} uncertain`,
			);
		}
		this.active.delete(attemptId);
		return this.transition(sessionId, record, "uncertain", reason);
	}

	/**
	 * `open | uncertain → resolved`, with the outcome. The caller vouches
	 * for the evidence (§2.7.4: every request answered, final action done
	 * and observed); this store never infers it.
	 */
	async resolve(
		sessionId: string,
		attemptId: string,
		outcome: AttemptOutcome,
		reason: string,
	): Promise<AttemptRecord> {
		if (!isOutcome(outcome)) throw new AttemptTransitionError("invalid outcome");
		const record = await this.current(sessionId, attemptId);
		if (record.state === "resolved") {
			throw new AttemptTransitionError(`attempt ${attemptId} is already resolved`);
		}
		if (record.orphanedAt) {
			// D8 fail-closed: the process that held the evidence is gone.
			throw new AttemptTransitionError(
				`attempt ${attemptId} was orphaned by a backend restart; no automatic resolution (D8)`,
			);
		}
		this.active.delete(attemptId);
		return this.transition(sessionId, record, "resolved", reason, outcome);
	}

	/**
	 * Boot: every `open` record was left by a process that is gone, so it
	 * becomes `uncertain` (persisted). `uncertain` stays; unreadable
	 * records are logged and stay gated by `assertResolved`. Nothing is
	 * resolved here (D8).
	 */
	async recoverOnBoot(): Promise<{ uncertain: string[]; unreadable: string[] }> {
		const out = { uncertain: [] as string[], unreadable: [] as string[] };
		let entries: string[];
		try {
			entries = await fs.readdir(this.controlRoot());
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
			throw err;
		}
		for (const sessionId of entries) {
			if (!SESSION_ID_RE.test(sessionId)) continue;
			const r = await this.read(sessionId);
			if (r.kind === "none") continue;
			if (r.kind === "unreadable") {
				out.unreadable.push(sessionId);
				logger.error(
					`[recreate] session ${sessionId}: attempt record unreadable (${r.error}); session stays recreate-unresolved`,
				);
				continue;
			}
			if (r.record.state === "resolved") continue;
			// Open or uncertain: either way the process that could still
			// receive Docker's answers is gone. Mark it orphaned, once.
			if (!r.record.orphanedAt) {
				const at = nowIso();
				await this.write(sessionId, {
					...r.record,
					state: "uncertain",
					stateAt: at,
					reason:
						r.record.state === "open"
							? "backend restarted during the attempt"
							: `backend restarted while uncertain (${r.record.reason ?? "no reason"})`,
					orphanedAt: at,
				});
			}
			out.uncertain.push(sessionId);
			logger.warn(
				`[recreate] session ${sessionId}: attempt ${r.record.attemptId} uncertain; session stays recreate-unresolved (D8: no automatic resolution)`,
			);
		}
		return out;
	}

	/** Every attempt id this session ever resolved, for leftover checks. */
	async resolvedAttempts(sessionId: string): Promise<Map<string, AttemptOutcome>> {
		const r = await this.read(sessionId);
		const out = new Map<string, AttemptOutcome>();
		if (r.kind !== "ok") return out;
		if (r.record.state === "resolved" && r.record.outcome)
			out.set(r.record.attemptId, r.record.outcome);
		for (const h of r.record.history) out.set(h.attemptId, h.outcome);
		return out;
	}

	private async current(sessionId: string, attemptId: string): Promise<AttemptRecord> {
		const r = await this.read(sessionId);
		if (r.kind !== "ok") throw new AttemptTransitionError(`no readable record for ${sessionId}`);
		if (r.record.attemptId !== attemptId) {
			throw new AttemptTransitionError(
				`record is for attempt ${r.record.attemptId}, not ${attemptId}`,
			);
		}
		return r.record;
	}

	private async transition(
		sessionId: string,
		record: AttemptRecord,
		state: AttemptState,
		reason: string,
		outcome?: AttemptOutcome,
	): Promise<AttemptRecord> {
		const next: AttemptRecord = { ...record, state, stateAt: nowIso(), reason };
		if (outcome) next.outcome = outcome;
		else delete next.outcome;
		await this.write(sessionId, next);
		return next;
	}

	/**
	 * Atomic replace: temp file in the same directory, fsync, rename,
	 * fsync of the directory. A crash leaves either the old record or the
	 * new one, never a torn file; a stray temp file is never read.
	 */
	private async write(sessionId: string, record: AttemptRecord): Promise<void> {
		const dir = this.controlDir(sessionId);
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		const file = path.join(dir, RECORD_FILE);
		const tmp = `${file}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
		const fh = await fs.open(tmp, "wx", 0o600);
		try {
			await fh.writeFile(JSON.stringify(record));
			await fh.sync();
		} finally {
			await fh.close();
		}
		try {
			await fs.rename(tmp, file);
		} catch (err) {
			await fs.rm(tmp, { force: true }).catch(() => {});
			throw err;
		}
		await fsyncDir(dir);
	}
}
