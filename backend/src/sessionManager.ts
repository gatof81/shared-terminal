import { v4 as uuidv4 } from "uuid";
import { SessionMeta, SessionStatus } from "./types.js";

/**
 * SessionManager — authoritative, in-memory registry of all terminal sessions.
 *
 * Responsibilities:
 *   - Create / lookup / list / terminate session *metadata*.
 *   - Does NOT hold PTY references (those live in PtyManager).
 *   - Does NOT hold WebSocket references (those live in WsHandler).
 *
 * Design note: separating metadata from runtime references means a session can
 * exist (and be reconnectable) independently of whether a PTY or WS connection
 * is currently live.
 */

const SESSION_NAME_RE = /^[\w\- ]{1,64}$/;

export class SessionManager {
        private readonly sessions = new Map<string, SessionMeta>();

        // ── CRUD ────────────────────────────────────────────────────────────────────

        create(opts: {
                userId: string;
                name: string;
                cols?: number;
                rows?: number;
                shell?: string;
                cwd?: string;
        }): SessionMeta {
                if (!SESSION_NAME_RE.test(opts.name)) {
                        throw new Error(
                                "Invalid session name. Use letters, numbers, spaces, hyphens or underscores (max 64).",
                        );
                }

                const meta: SessionMeta = {
                        sessionId: uuidv4(),
                        userId: opts.userId,
                        name: opts.name.trim(),
                        status: "running",
                        createdAt: new Date(),
                        lastConnectedAt: null,
                        cols: opts.cols ?? 80,
                        rows: opts.rows ?? 24,
                        pid: null,
                        shell: opts.shell ?? (process.env.SHELL ?? "/bin/bash"),
                        cwd: opts.cwd ?? (process.env.HOME ?? "/"),
                };

                this.sessions.set(meta.sessionId, meta);
                return meta;
        }

        get(sessionId: string): SessionMeta | undefined {
                return this.sessions.get(sessionId);
        }

        /** Return all non-terminated sessions belonging to a user. */
        listForUser(userId: string): SessionMeta[] {
                return [...this.sessions.values()].filter(
                        (s) => s.userId === userId && s.status !== "terminated",
                );
        }

        /** Persist PTY pid once the PTY process has been spawned. */
        setPid(sessionId: string, pid: number): void {
                const s = this.sessions.get(sessionId);
                if (s) s.pid = pid;
        }

        updateStatus(sessionId: string, status: SessionStatus): void {
                const s = this.sessions.get(sessionId);
                if (s) s.status = status;
        }

        updateConnected(sessionId: string): void {
                const s = this.sessions.get(sessionId);
                if (s) {
                        s.lastConnectedAt = new Date();
                        s.status = "running";
                }
        }

        updateDimensions(sessionId: string, cols: number, rows: number): void {
                const s = this.sessions.get(sessionId);
                if (s) {
                        s.cols = cols;
                        s.rows = rows;
                }
        }

        terminate(sessionId: string): boolean {
                const s = this.sessions.get(sessionId);
                if (!s || s.status === "terminated") return false;
                s.status = "terminated";
                s.pid = null;
                return true;
        }

        // ── Ownership guard ──────────────────────────────────────────────────────────

        /** Throws if the session doesn't exist or doesn't belong to userId. */
        assertOwnership(sessionId: string, userId: string): SessionMeta {
                const s = this.sessions.get(sessionId);
                if (!s) throw new NotFoundError("Session not found");
                if (s.userId !== userId) throw new ForbiddenError("Access denied");
                return s;
        }
}

export class NotFoundError extends Error {
        readonly statusCode = 404;
}
export class ForbiddenError extends Error {
        readonly statusCode = 403;
}
