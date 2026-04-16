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
        async create(opts: CreateSessionOpts): Promise<SessionMeta> {
                const sessionId = uuidv4();
                const containerName = `st-${sessionId.slice(0, 12)}`;
                const cols = opts.cols ?? 120;
                const rows = opts.rows ?? 36;
                const envVars = opts.envVars ?? {};

                await d1Query(
                        `INSERT INTO sessions (session_id, user_id, name, container_name, cols, rows, env_vars)
                         VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        [sessionId, opts.userId, opts.name, containerName, cols, rows, JSON.stringify(envVars)],
                );

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

        async setContainerId(sessionId: string, containerId: string): Promise<void> {
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
}
