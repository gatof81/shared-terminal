/**
 * conversation/registry.ts — the D1 side of Phase 3: the
 * `claude_conversations` metadata rows and the three capture columns on
 * `sessions` (migration v16). CLAUDE.md's rule applies with force here:
 * every call is an HTTP round-trip, and the ingest path handles hundreds
 * of events per second, so NOTHING in this module runs per event. Rows
 * are written on creation, on `session_start`/`session_end`, on a
 * status change, and by a coalesced heartbeat (≤ one write per
 * conversation per 30 s). The events file is the source of truth; D1
 * holds what the list endpoint and a cold backend need.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { parseD1Utc } from "../d1Time.js";
import { d1Query } from "../db.js";
import { D1_HEARTBEAT_INTERVAL_MS } from "./limits.js";
import type { ConversationIndex, ConversationKind } from "./store.js";

// ── Tokens ──────────────────────────────────────────────────────────────────

/** 32 random bytes as 64 hex chars — the value of `ST_INGEST_TOKEN`. */
export function generateIngestToken(): string {
	return randomBytes(32).toString("hex");
}

export function hashIngestToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison of a presented token against the stored hash. */
export function tokenMatchesHash(token: string, hash: string): boolean {
	const a = Buffer.from(hashIngestToken(token), "hex");
	const b = Buffer.from(hash, "hex");
	return a.length === b.length && timingSafeEqual(a, b);
}

// ── sessions capture columns ───────────────────────────────────────────────

export interface SessionCaptureRow {
	status: string;
	conversation_requested: number;
	ingest_token_hash: string | null;
	ingest_token_hash_suspended: string | null;
	user_id: string;
	/** 3.0d: the container whose token must correspond (§2.7.6). */
	container_id: string | null;
	/** 3.0d audit A1: bumped by every revocation (migration v17). */
	revocation_seq?: number;
}

export async function getSessionCapture(sessionId: string): Promise<SessionCaptureRow | null> {
	const r = await d1Query<SessionCaptureRow>(
		"SELECT status, conversation_requested, ingest_token_hash, ingest_token_hash_suspended, user_id, container_id, revocation_seq FROM sessions WHERE session_id = ?",
		[sessionId],
	);
	return r.results[0] ?? null;
}

export async function setConversationRequested(
	sessionId: string,
	requested: boolean,
): Promise<void> {
	await d1Query("UPDATE sessions SET conversation_requested = ? WHERE session_id = ?", [
		requested ? 1 : 0,
		sessionId,
	]);
}

export async function setIngestTokenHash(sessionId: string, hash: string | null): Promise<void> {
	await d1Query("UPDATE sessions SET ingest_token_hash = ? WHERE session_id = ?", [
		hash,
		sessionId,
	]);
}

// Every revocation bumps `revocation_seq` in its own statement, and the
// enable writes below apply only while it still holds the value the enable
// read at its start (3.0d audit A1). D1 statements are atomic, so a
// revocation that lands while an enable is in flight — from this process
// or from the emergency CLI — either happens before the enable's write
// (which then matches 0 rows and refuses) or after it (and wins). Never
// overwritten, and without a lock the emergency would have to wait for.

/** Disable: move the live hash aside so a later enable can restore it (§2.4). */
export async function suspendIngestToken(sessionId: string): Promise<void> {
	await d1Query(
		"UPDATE sessions SET ingest_token_hash_suspended = ingest_token_hash, ingest_token_hash = NULL, conversation_requested = 0, revocation_seq = revocation_seq + 1 WHERE session_id = ?",
		[sessionId],
	);
}

/**
 * Enable on a container that still carries its token: restore the hash —
 * only if no revocation happened since `seq` was read. True when applied.
 */
export async function restoreIngestTokenIfUnrevoked(
	sessionId: string,
	seq: number,
): Promise<boolean> {
	const r = await d1Query(
		"UPDATE sessions SET ingest_token_hash = COALESCE(ingest_token_hash, ingest_token_hash_suspended), ingest_token_hash_suspended = NULL, conversation_requested = 1 WHERE revocation_seq = ? AND session_id = ?",
		[seq, sessionId],
	);
	return r.meta.changes === 1;
}

/** Enable: `conversation_requested = 1`, only if no revocation since `seq`. True when applied. */
export async function setRequestedIfUnrevoked(sessionId: string, seq: number): Promise<boolean> {
	const r = await d1Query(
		"UPDATE sessions SET conversation_requested = 1 WHERE revocation_seq = ? AND session_id = ?",
		[seq, sessionId],
	);
	return r.meta.changes === 1;
}

/** Emergency / global off: everything to NULL and requested=0. */
export async function revokeIngestTokens(sessionId: string): Promise<void> {
	await d1Query(
		"UPDATE sessions SET ingest_token_hash = NULL, ingest_token_hash_suspended = NULL, conversation_requested = 0, revocation_seq = revocation_seq + 1 WHERE session_id = ?",
		[sessionId],
	);
}

export async function revokeAllIngestTokens(): Promise<void> {
	await d1Query(
		"UPDATE sessions SET ingest_token_hash = NULL, ingest_token_hash_suspended = NULL, conversation_requested = 0, revocation_seq = revocation_seq + 1",
	);
}

export interface RunningCaptureSession {
	session_id: string;
	conversation_requested: number;
	ingest_token_hash: string | null;
}

export async function listRunningCaptureSessions(): Promise<RunningCaptureSession[]> {
	const r = await d1Query<RunningCaptureSession>(
		"SELECT session_id, conversation_requested, ingest_token_hash FROM sessions WHERE status = 'running'",
	);
	return r.results;
}

export interface RequestedSession {
	status: string;
	/** 1 when `ingest_token_hash` is set: never the hash itself. */
	authorized: number;
	session_id: string;
}

/** Every session with capture requested (admin stats, §7): one read. */
export async function listRequestedSessions(): Promise<RequestedSession[]> {
	const r = await d1Query<RequestedSession>(
		"SELECT session_id, status, (ingest_token_hash IS NOT NULL) AS authorized FROM sessions WHERE conversation_requested = 1",
	);
	return r.results;
}

// ── claude_conversations rows ──────────────────────────────────────────────

export interface ConversationRow {
	session_id: string;
	st_session_id: string;
	kind: ConversationKind;
	parent_session_id: string | null;
	parent_inferred: number;
	title: string | null;
	tab_id: string | null;
	pane_id: string | null;
	status: string;
	status_evidence: string;
	status_at: string;
	started_at: string;
	ended_at: string | null;
	end_reason: string | null;
	last_event_at: string;
	last_prompt_id: string | null;
	last_seq: number;
	claude_version: string | null;
	events_bytes: number;
	events_count: number;
	gaps_count: number;
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

/**
 * B5 — first discovery of a Claude session id: reserve the ownership row
 * atomically. `INSERT OR IGNORE` never overwrites an existing row, and the
 * follow-up SELECT tells the caller who owns it. Two D1 calls, once per
 * conversation per process (the service caches the verified owner), never
 * per event.
 */
export async function reserveConversationOwner(
	index: ConversationIndex,
): Promise<{ ok: true } | { ok: false; owner: string }> {
	await d1Query(
		`INSERT OR IGNORE INTO claude_conversations (
			session_id, st_session_id, kind, parent_session_id, parent_inferred, title,
			tab_id, pane_id, status, status_evidence, status_at, started_at, ended_at, end_reason,
			last_event_at, last_prompt_id, last_seq, claude_version, events_bytes, events_count, gaps_count
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		rowParams(index),
	);
	const r = await d1Query<{ st_session_id: string }>(
		"SELECT st_session_id FROM claude_conversations WHERE session_id = ?",
		[index.cid],
	);
	const owner = r.results[0]?.st_session_id;
	if (owner === undefined) throw new Error("ownership row vanished after reserve");
	return owner === index.stSessionId ? { ok: true } : { ok: false, owner };
}

/**
 * Counters/status refresh. `WHERE session_id = ? AND st_session_id = ?`
 * pins the owner: a row can never be re-pointed at another ST session by
 * a heartbeat (B5). Never INSERT OR REPLACE.
 */
export async function updateConversation(index: ConversationIndex): Promise<void> {
	await d1Query(
		`UPDATE claude_conversations SET
			kind = ?, parent_session_id = ?, parent_inferred = ?, title = ?, tab_id = ?, pane_id = ?,
			status = ?, status_evidence = ?, status_at = ?, started_at = ?, ended_at = ?, end_reason = ?,
			last_event_at = ?, last_prompt_id = ?, last_seq = ?, claude_version = ?,
			events_bytes = ?, events_count = ?, gaps_count = ?
		WHERE session_id = ? AND st_session_id = ?`,
		[...rowParams(index).slice(2), index.cid, index.stSessionId],
	);
}

function rowParams(index: ConversationIndex): unknown[] {
	return [
		index.cid,
		index.stSessionId,
		index.kind,
		index.parentSessionId,
		index.parentInferred ? 1 : 0,
		index.title,
		index.tabId,
		index.paneId,
		index.state.status,
		index.state.evidence,
		iso(index.state.at || Date.now()),
		index.startedAt,
		index.endedAt,
		index.endReason,
		index.lastEventAt,
		index.lastPromptId,
		index.lastSeq,
		index.claudeVersion,
		index.eventsBytes,
		index.eventsCount,
		index.gapsCount,
	];
}

export async function listConversationRows(stSessionId: string): Promise<ConversationRow[]> {
	const r = await d1Query<ConversationRow>(
		"SELECT * FROM claude_conversations WHERE st_session_id = ? ORDER BY last_event_at DESC",
		[stSessionId],
	);
	return r.results;
}

export async function deleteConversationRows(stSessionId: string): Promise<void> {
	await d1Query("DELETE FROM claude_conversations WHERE st_session_id = ?", [stSessionId]);
}

export function rowStatusAt(row: ConversationRow): Date {
	return parseD1Utc(row.status_at, "claude_conversations");
}

// ── Heartbeat coalescing ───────────────────────────────────────────────────

/**
 * Per-conversation throttle for the "counters" upsert. `markDirty` is
 * called on every persisted event (cheap: a map write); the actual D1
 * write happens at most once per interval per conversation, and
 * `flushNow` forces it (status changes, shutdown).
 */
export class HeartbeatCoalescer {
	private readonly lastWrite = new Map<string, number>();
	private readonly timers = new Map<string, NodeJS.Timeout>();

	constructor(
		private readonly write: (cid: string) => Promise<void>,
		private readonly intervalMs = D1_HEARTBEAT_INTERVAL_MS,
		private readonly now: () => number = Date.now,
	) {}

	markDirty(cid: string): void {
		if (this.timers.has(cid)) return;
		const last = this.lastWrite.get(cid) ?? 0;
		const due = Math.max(0, last + this.intervalMs - this.now());
		const t = setTimeout(() => {
			this.timers.delete(cid);
			void this.flushNow(cid);
		}, due);
		t.unref?.();
		this.timers.set(cid, t);
	}

	async flushNow(cid: string): Promise<void> {
		const t = this.timers.get(cid);
		if (t) {
			clearTimeout(t);
			this.timers.delete(cid);
		}
		this.lastWrite.set(cid, this.now());
		try {
			await this.write(cid);
		} catch {
			/* logged by the caller; the next heartbeat retries */
		}
	}

	forget(cid: string): void {
		const t = this.timers.get(cid);
		if (t) clearTimeout(t);
		this.timers.delete(cid);
		this.lastWrite.delete(cid);
	}

	/** Timers still pending, optionally only those whose key starts with `prefix`. */
	pending(prefix?: string): number {
		if (prefix === undefined) return this.timers.size;
		let n = 0;
		for (const key of this.timers.keys()) if (key.startsWith(prefix)) n++;
		return n;
	}
}
