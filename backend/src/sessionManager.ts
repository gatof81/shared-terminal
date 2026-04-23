/**
 * sessionManager.ts — D1-backed session metadata.
 *
 * All methods are async since D1 is accessed via HTTP API.
 */

import { v4 as uuidv4 } from "uuid";
import { d1Query } from "./db.js";
import { SessionMeta, SessionStatus, CreateSessionOpts } from "./types.js";

// ── Custom errors ───────────────────────────────────────────────────────────

export class NotFoundError extends Error {
        constructor(msg = "Session not found") {
                super(msg);
                this.name = "NotFoundError";
        }
}

export class ForbiddenError extends Error {
        constructor(msg = "Access denied") {
                super(msg);
                this.name = "ForbiddenError";
        }
}

// Caps the number of concurrently *active* sessions (running / stopped /
// anything that hasn't been terminated) a single user can own. Bounds
// resource consumption if an account is compromised or a runaway script
// spams `POST /sessions`: a stolen JWT can create at most this many
// containers, D1 rows, and workspace directories before hitting the
// cap. Terminated sessions don't count — they free a slot immediately
// so the user can always recycle.
//
// Overridable via MAX_ACTIVE_SESSIONS_PER_USER env var. Parsed at module
// load (so changes require a restart), validated to a positive integer;
// any unparseable / non-positive / non-finite value falls back to the
// default rather than silently disabling the cap.
const DEFAULT_MAX_ACTIVE_SESSIONS_PER_USER = 20;
const MAX_ACTIVE_SESSIONS_PER_USER = ((): number => {
        const raw = process.env.MAX_ACTIVE_SESSIONS_PER_USER;
        if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_ACTIVE_SESSIONS_PER_USER;
        const n = Number(raw);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
                return DEFAULT_MAX_ACTIVE_SESSIONS_PER_USER;
        }
        return n;
})();

export class SessionQuotaExceededError extends Error {
        // Passed through to the HTTP response — include the effective cap so the
        // user knows what "too many" means without asking support.
        readonly quota: number;

        constructor(quota: number) {
                super(
                        `You already have ${quota} active sessions — terminate some ` +
                        `before creating more`,
                );
                this.name = "SessionQuotaExceededError";
                this.quota = quota;
        }
}

// ── Row → domain mapper ────────────────────────────────────────────────────

interface SessionRow {
        session_id: string;
        user_id: string;
        name: string;
        status: string;
        container_id: string | null;
        container_name: string;
        cols: number;
        rows: number;
        env_vars: string;
        created_at: string;
        last_connected_at: string | null;
}

// D1's `datetime('now')` returns SQLite's canonical UTC format — no 'Z' or
// other timezone suffix. Node's Date parses that as LOCAL time, which is
// wrong: a row written at 2024-01-01T10:00:00 (UTC, from D1) becomes a Date
// 3h off on a UTC-3 machine. We append 'Z' to force UTC interpretation.
// Guard the append in case D1 (or a future migration) ever returns a suffix
// already — double-Z is an invalid date and silently NaNs. Also catch full
// ISO 8601 offsets like `+00:00`.
function parseD1UtcTimestamp(raw: string): Date {
        const hasSuffix = /[zZ]$/.test(raw) || /[+-]\d{2}:?\d{2}$/.test(raw);
        const d = new Date(hasSuffix ? raw : raw + "Z");
        if (Number.isNaN(d.getTime())) {
                // Better to crash loudly here than return "Invalid Date" that
                // would later serialize to null in JSON.
                throw new Error(`D1 returned unparseable timestamp: ${raw}`);
        }
        return d;
}

function rowToMeta(row: SessionRow): SessionMeta {
        return {
                sessionId: row.session_id,
                userId: row.user_id,
                name: row.name,
                status: row.status as SessionStatus,
                containerId: row.container_id,
                containerName: row.container_name,
                cols: row.cols,
                rows: row.rows,
                envVars: JSON.parse(row.env_vars),
                createdAt: parseD1UtcTimestamp(row.created_at),
                lastConnectedAt: row.last_connected_at ? parseD1UtcTimestamp(row.last_connected_at) : null,
        };
}

// ── SessionManager ──────────────────────────────────────────────────────────

export class SessionManager {
        async create(opts: CreateSessionOpts): Promise<SessionMeta> {
                const sessionId = uuidv4();
                const containerName = `st-${sessionId.slice(0, 12)}`;
                const cols = opts.cols ?? 120;
                const rows = opts.rows ?? 36;
                const envVars = opts.envVars ?? {};

                // Atomic quota check: fold the per-user count into the INSERT so two
                // concurrent POST /sessions from the same user can't both read
                // `count = cap-1` and both insert. Same SQLite-serialised pattern as
                // invite mint and bootstrap-register elsewhere in the codebase. The
                // race loser observes `meta.changes === 0` and raises a typed error
                // the route can map to 429.
                //
                // The count filter matches `listForUser`, which is what the UI shows —
                // so "active" here means the same thing the user sees in their sidebar.
                // Terminated rows don't count against the cap; they'll be garbage-
                // collected by the hard-delete path or left as history.
                const insert = await d1Query(
                        `INSERT INTO sessions (session_id, user_id, name, container_name, cols, rows, env_vars)
                         SELECT ?, ?, ?, ?, ?, ?, ?
                         WHERE (
                                 SELECT COUNT(*) FROM sessions
                                 WHERE user_id = ? AND status != 'terminated'
                         ) < ?`,
                        [
                                sessionId, opts.userId, opts.name, containerName, cols, rows, JSON.stringify(envVars),
                                opts.userId, MAX_ACTIVE_SESSIONS_PER_USER,
                        ],
                );
                if (insert.meta.changes !== 1) {
                        throw new SessionQuotaExceededError(MAX_ACTIVE_SESSIONS_PER_USER);
                }

                return (await this.get(sessionId))!;
        }

        async get(sessionId: string): Promise<SessionMeta | null> {
                const result = await d1Query<SessionRow>(
                        "SELECT * FROM sessions WHERE session_id = ?",
                        [sessionId],
                );
                return result.results.length > 0 ? rowToMeta(result.results[0]) : null;
        }

        async getOrThrow(sessionId: string): Promise<SessionMeta> {
                const meta = await this.get(sessionId);
                if (!meta) throw new NotFoundError();
                return meta;
        }

        async assertOwnership(sessionId: string, userId: string): Promise<SessionMeta> {
                const meta = await this.getOrThrow(sessionId);
                if (meta.userId !== userId) throw new ForbiddenError();
                return meta;
        }

        async listForUser(userId: string): Promise<SessionMeta[]> {
                const result = await d1Query<SessionRow>(
                        "SELECT * FROM sessions WHERE user_id = ? AND status != 'terminated' ORDER BY created_at DESC",
                        [userId],
                );
                return result.results.map(rowToMeta);
        }

        async listAllForUser(userId: string): Promise<SessionMeta[]> {
                const result = await d1Query<SessionRow>(
                        "SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC",
                        [userId],
                );
                return result.results.map(rowToMeta);
        }

        async setContainerId(sessionId: string, containerId: string | null): Promise<void> {
                await d1Query("UPDATE sessions SET container_id = ? WHERE session_id = ?", [containerId, sessionId]);
        }

        async updateStatus(sessionId: string, status: SessionStatus): Promise<void> {
                await d1Query("UPDATE sessions SET status = ? WHERE session_id = ?", [status, sessionId]);
        }

        async updateConnected(sessionId: string): Promise<void> {
                await d1Query(
                        "UPDATE sessions SET last_connected_at = datetime('now') WHERE session_id = ?",
                        [sessionId],
                );
        }

        async updateEnvVars(sessionId: string, envVars: Record<string, string>): Promise<void> {
                await d1Query("UPDATE sessions SET env_vars = ? WHERE session_id = ?", [
                        JSON.stringify(envVars),
                        sessionId,
                ]);
        }

        async terminate(sessionId: string): Promise<void> {
                await this.updateStatus(sessionId, "terminated");
        }

        /**
         * Permanently delete the session row (hard delete). Caller is responsible
         * for having already killed any running container and for cleaning up any
         * workspace data on disk.
         */
        async deleteRow(sessionId: string): Promise<void> {
                await d1Query("DELETE FROM sessions WHERE session_id = ?", [sessionId]);
        }
}
