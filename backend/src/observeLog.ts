/**
 * observeLog.ts — append-only audit log for observe-mode WS attaches (#201d).
 *
 * One row per `WS /ws/sessions/:id?observe=true` connection: INSERT
 * on attach success, UPDATE `ended_at` on socket close. The schema
 * lives in `db.ts` (session_observe_log table + indexes); this module
 * is the typed surface that wsHandler + the two log-read routes
 * consume.
 *
 * Why not log on every observe-attempt, including denied ones? A
 * failed attach is recorded by the existing route/WS access logs
 * (logger.info / logger.warn) and counted by the IP rate limiter.
 * The audit trail's purpose is "who saw what bytes" — a 403'd
 * attempt saw nothing. Logging denied attempts would pollute the
 * "who's been in this session?" view with noise from misconfigured
 * clients or probe traffic.
 */

import { randomUUID } from "node:crypto";
import { parseD1Utc } from "./d1Time.js";
import { d1Query } from "./db.js";

/**
 * Hard cap on rows returned by either list endpoint. Sized at 500
 * for parity with the admin cross-user session list — a deployment
 * that's accumulated thousands of observe events on a single session
 * shouldn't return a multi-megabyte JSON blob on a dashboard refresh.
 * If a deployment grows past this, the page silently misses older
 * entries — pagination is a follow-up if anyone hits the cap in
 * practice.
 */
export const OBSERVE_LOG_LIMIT = 500;

interface ObserveLogRow {
	id: string;
	observer_user_id: string;
	session_id: string;
	owner_user_id: string;
	started_at: string;
	ended_at: string | null;
}

/** Per-session log entry — what `/api/sessions/:id/observe-log`
 *  returns to the owner (or admin / lead via `assertCanObserve`).
 *  The `observerUsername` is JOIN-ed at read time so the caller
 *  can render "alice watched at 12:00" without a second lookup. */
export interface ObserveLogEntry {
	id: string;
	observerUserId: string;
	observerUsername: string;
	sessionId: string;
	ownerUserId: string;
	startedAt: Date;
	endedAt: Date | null;
}

/** Cross-user admin log entry — adds `ownerUsername` so the admin
 *  dashboard can render "alice watched bob's session at 12:00"
 *  without a second lookup per row. */
export interface AdminObserveLogEntry extends ObserveLogEntry {
	ownerUsername: string;
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Record the start of an observe-attach. Returns the log id so the
 * caller can pair it with `recordObserveEnd(id)` on socket close.
 *
 * `ownerUserId` is denormalised into the row at insert time so a
 * later hard-delete of the session (which CASCADEs the log via the
 * FK) doesn't strand the observer-side history WITHOUT preserving
 * the owner side. The denormalised column is a tombstone for the
 * observer's history view; the session-side history vanishes with
 * the session row.
 *
 * No throw on D1 failure — the caller (wsHandler) catches and
 * decides whether to abort the attach. INSERT failure means we
 * couldn't record the audit row; the locked-in invariant is "audit
 * trail exists for every observe", so the right policy is to abort
 * the attach. The route layer translates that into a 500-class WS
 * close.
 */
export async function recordObserveStart(
	observerUserId: string,
	sessionId: string,
	ownerUserId: string,
): Promise<string> {
	const id = randomUUID();
	await d1Query(
		"INSERT INTO session_observe_log (id, observer_user_id, session_id, owner_user_id) " +
			"VALUES (?, ?, ?, ?)",
		[id, observerUserId, sessionId, ownerUserId],
	);
	return id;
}

/**
 * Mark the observe-attach as ended. Idempotent: a second call on the
 * same id is a no-op because the WHERE clause filters on
 * `ended_at IS NULL`. This matters because wsHandler registers both
 * `ws.on("close")` and `ws.on("error")` handlers — depending on the
 * teardown shape, either or both can fire for the same socket. Both
 * call this without coordination; the idempotency in SQL is the
 * coordination point.
 *
 * Errors are logged at the caller (D1 transients during close are
 * common and shouldn't fail the socket teardown). The route layer
 * does NOT consume the return; the row either reflects close-time
 * or stays null forever — both are recoverable.
 */
export async function recordObserveEnd(id: string): Promise<void> {
	await d1Query(
		"UPDATE session_observe_log SET ended_at = datetime('now') " +
			"WHERE id = ? AND ended_at IS NULL",
		[id],
	);
}

// ── Reads ──────────────────────────────────────────────────────────────────

/**
 * List the observe-attach history for one session, newest-first,
 * capped at `OBSERVE_LOG_LIMIT`. Joins `users` to surface the
 * observer's username — the caller (the per-session log route)
 * is gated by `assertCanObserve`, so the owner, an admin, or a lead
 * of any group containing the owner can all read this view.
 *
 * The result includes observe events with `ended_at IS NULL` — i.e.
 * currently-active observers. That's deliberate: a session's owner
 * looking at "who's watching me right now" sees the live row. The
 * route serializer surfaces `null` for endedAt; clients render the
 * absence as "still watching."
 *
 * Returns `[]` for a session with no observe history (including a
 * never-observed session); the caller's auth gate is what decides
 * whether the empty array is visible at all.
 */
export async function listForSession(sessionId: string): Promise<ObserveLogEntry[]> {
	const result = await d1Query<ObserveLogRow & { observer_username: string }>(
		"SELECT l.id, l.observer_user_id, l.session_id, l.owner_user_id, " +
			"l.started_at, l.ended_at, u.username AS observer_username " +
			"FROM session_observe_log l " +
			"JOIN users u ON u.id = l.observer_user_id " +
			"WHERE l.session_id = ? " +
			`ORDER BY l.started_at DESC LIMIT ${OBSERVE_LOG_LIMIT}`,
		[sessionId],
	);
	return result.results.map(rowToEntry);
}

/**
 * Cross-user observe-log for the admin dashboard. Joins `users`
 * twice — once for the observer username, once for the owner —
 * via two aliased LEFT JOINs (LEFT, not INNER, so a deleted user
 * whose CASCADE hasn't yet fired surfaces as a tombstone row
 * rather than disappearing from the audit trail).
 *
 * Newest-first by `started_at`, hard-capped at `OBSERVE_LOG_LIMIT`.
 * Admin-gated at the route layer; do NOT call from non-admin code
 * paths — bypasses the per-session ownership scoping that
 * `listForSession` relies on.
 */
export async function listAll(): Promise<AdminObserveLogEntry[]> {
	const result = await d1Query<
		ObserveLogRow & { observer_username: string | null; owner_username: string | null }
	>(
		"SELECT l.id, l.observer_user_id, l.session_id, l.owner_user_id, " +
			"l.started_at, l.ended_at, " +
			"obs.username AS observer_username, " +
			"own.username AS owner_username " +
			"FROM session_observe_log l " +
			"LEFT JOIN users obs ON obs.id = l.observer_user_id " +
			"LEFT JOIN users own ON own.id = l.owner_user_id " +
			`ORDER BY l.started_at DESC LIMIT ${OBSERVE_LOG_LIMIT}`,
	);
	return result.results.map((row) => ({
		...rowToEntry({
			...row,
			// LEFT JOIN can land null for a deleted observer (CASCADE
			// race) or a deleted owner. Surface "(deleted user)" so
			// the dashboard renders a tombstone rather than blowing
			// up on a missing string. The audit row is still
			// meaningful — it records that the observation happened.
			observer_username: row.observer_username ?? "(deleted user)",
		}),
		ownerUsername: row.owner_username ?? "(deleted user)",
	}));
}

// ── Row → domain mapper ────────────────────────────────────────────────────

function rowToEntry(row: ObserveLogRow & { observer_username: string }): ObserveLogEntry {
	return {
		id: row.id,
		observerUserId: row.observer_user_id,
		observerUsername: row.observer_username,
		sessionId: row.session_id,
		ownerUserId: row.owner_user_id,
		startedAt: parseD1Utc(row.started_at, "observeLog"),
		endedAt: row.ended_at ? parseD1Utc(row.ended_at, "observeLog") : null,
	};
}
