/**
 * sessionManager.ts — SQLite-backed session metadata.
 *
 * Manages the lifecycle of session records.  Docker container management
 * is handled by DockerManager; this module only deals with metadata.
 */

import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
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
                createdAt: new Date(row.created_at + "Z"),
                lastConnectedAt: row.last_connected_at ? new Date(row.last_connected_at + "Z") : null,
        };
}

// ── SessionManager ──────────────────────────────────────────────────────────

export class SessionManager {
        /**
         * Create a new session record and return its metadata.
         * The container is NOT started here — call DockerManager.spawn() after.
         */
        create(opts: CreateSessionOpts): SessionMeta {
                const db = getDb();
                const sessionId = uuidv4();
                const containerName = `st-${sessionId.slice(0, 12)}`;
                const cols = opts.cols ?? 120;
                const rows = opts.rows ?? 36;
                const envVars = opts.envVars ?? {};

                db.prepare(`
                        INSERT INTO sessions (session_id, user_id, name, container_name, cols, rows, env_vars)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                `).run(sessionId, opts.userId, opts.name, containerName, cols, rows, JSON.stringify(envVars));

                return this.get(sessionId)!;
        }

        /** Get a session by ID, or null if not found. */
        get(sessionId: string): SessionMeta | null {
                const db = getDb();
                const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as
                        | SessionRow
                        | undefined;
                return row ? rowToMeta(row) : null;
        }

        /** Get a session by ID or throw NotFoundError. */
        getOrThrow(sessionId: string): SessionMeta {
                const meta = this.get(sessionId);
                if (!meta) throw new NotFoundError();
                return meta;
        }

        /** Assert that userId owns sessionId. Returns the session. */
        assertOwnership(sessionId: string, userId: string): SessionMeta {
                const meta = this.getOrThrow(sessionId);
                if (meta.userId !== userId) throw new ForbiddenError();
                return meta;
        }

        /** List non-terminated sessions for a user. */
        listForUser(userId: string): SessionMeta[] {
                const db = getDb();
                const rows = db
                        .prepare("SELECT * FROM sessions WHERE user_id = ? AND status != 'terminated' ORDER BY created_at DESC")
                        .all(userId) as SessionRow[];
                return rows.map(rowToMeta);
        }

        /** List ALL sessions for a user (including terminated). */
        listAllForUser(userId: string): SessionMeta[] {
                const db = getDb();
                const rows = db
                        .prepare("SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC")
                        .all(userId) as SessionRow[];
                return rows.map(rowToMeta);
        }

        /** Update the Docker container ID after spawn. */
        setContainerId(sessionId: string, containerId: string): void {
                const db = getDb();
                db.prepare("UPDATE sessions SET container_id = ? WHERE session_id = ?").run(containerId, sessionId);
        }

        /** Update session status. */
        updateStatus(sessionId: string, status: SessionStatus): void {
                const db = getDb();
                db.prepare("UPDATE sessions SET status = ? WHERE session_id = ?").run(status, sessionId);
        }

        /** Mark session as recently connected. */
        updateConnected(sessionId: string): void {
                const db = getDb();
                db.prepare("UPDATE sessions SET last_connected_at = datetime('now') WHERE session_id = ?").run(sessionId);
        }

        /** Update per-session environment variables. */
        updateEnvVars(sessionId: string, envVars: Record<string, string>): void {
                const db = getDb();
                db.prepare("UPDATE sessions SET env_vars = ? WHERE session_id = ?").run(
                        JSON.stringify(envVars),
                        sessionId,
                );
        }

        /** Terminate a session (marks as terminated in DB). */
        terminate(sessionId: string): void {
                this.updateStatus(sessionId, "terminated");
        }
}
