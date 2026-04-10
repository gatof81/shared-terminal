import { Router, Request, Response } from "express";
import { AuthedRequest, requireUserId } from "./auth.js";
import { SessionManager, NotFoundError, ForbiddenError } from "./sessionManager.js";
import { PtyManager } from "./ptyManager.js";

/**
 * REST routes for session management.
 *
 * POST   /sessions          — create a new session
 * GET    /sessions          — list the caller's active sessions
 * DELETE /sessions/:id      — terminate a session
 *
 * All routes require `X-User-Id` header (see auth.ts).
 */
export function buildRouter(
        sessions: SessionManager,
        ptys: PtyManager,
): Router {
        const router = Router();

        // Apply auth middleware globally for this router.
        router.use(requireUserId);

        // ── POST /sessions ────────────────────────────────────────────────────────

        router.post("/sessions", (req: Request, res: Response) => {
                const { userId } = req as AuthedRequest;
                const { name, cols, rows, shell, cwd } = req.body as {
                        name?: string;
                        cols?: number;
                        rows?: number;
                        shell?: string;
                        cwd?: string;
                };

                if (!name || typeof name !== "string") {
                        res.status(400).json({ error: "body.name is required" });
                        return;
                }

                let meta;
                try {
                        meta = sessions.create({ userId, name, cols, rows, shell, cwd });
                } catch (err) {
                        // Validation error (bad name, etc.)
                        res.status(400).json({ error: (err as Error).message });
                        return;
                }

                try {
                        // Spawn the PTY immediately so the session is live from the start.
                        ptys.spawn(meta.sessionId);
                } catch (err) {
                        // PTY spawn failed — clean up the metadata so the session doesn't
                        // appear in the list in a broken state.
                        sessions.terminate(meta.sessionId);
                        console.error(`[routes] PTY spawn failed for session ${meta.sessionId}:`, (err as Error).message);
                        res.status(500).json({ error: `Failed to start shell process: ${(err as Error).message}` });
                        return;
                }

                res.status(201).json(serializeMeta(meta));
        });

        // ── GET /sessions ─────────────────────────────────────────────────────────

        router.get("/sessions", (req: Request, res: Response) => {
                const { userId } = req as AuthedRequest;
                const list = sessions.listForUser(userId).map(serializeMeta);
                res.json(list);
        });

        // ── DELETE /sessions/:id ──────────────────────────────────────────────────

        router.delete("/sessions/:id", (req: Request, res: Response) => {
                const { userId } = req as AuthedRequest;
                const { id } = req.params;

                try {
                        sessions.assertOwnership(id, userId);
                        ptys.kill(id);
                        sessions.terminate(id);
                        res.status(204).send();
                } catch (err) {
                        if (err instanceof NotFoundError) {
                                res.status(404).json({ error: err.message });
                        } else if (err instanceof ForbiddenError) {
                                res.status(403).json({ error: err.message });
                        } else {
                                res.status(500).json({ error: "Internal server error" });
                        }
                }
        });

        return router;
}

// ── Serialisation helper ─────────────────────────────────────────────────────

function serializeMeta(m: ReturnType<SessionManager["get"]>) {
        if (!m) return null;
        return {
                sessionId: m.sessionId,
                name: m.name,
                status: m.status,
                createdAt: m.createdAt.toISOString(),
                lastConnectedAt: m.lastConnectedAt?.toISOString() ?? null,
                cols: m.cols,
                rows: m.rows,
                pid: m.pid,
                shell: m.shell,
                cwd: m.cwd,
        };
}
