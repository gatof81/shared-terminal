/**
 * routes.ts — REST API routes.
 *
 * Auth routes (public):
 *   POST /auth/register   — create account
 *   POST /auth/login      — get JWT
 *   GET  /auth/status      — check if setup needed
 *
 * Session routes (require JWT):
 *   POST   /sessions          — create a new session + Docker container
 *   GET    /sessions          — list caller's sessions
 *   GET    /sessions/:id      — get single session
 *   DELETE /sessions/:id      — terminate (stop + remove container)
 *   POST   /sessions/:id/stop — stop container (preservable)
 *   POST   /sessions/:id/start— restart stopped container
 *   PATCH  /sessions/:id/env  — update env vars
 */

import { Router, Request, Response } from "express";
import { AuthedRequest, requireAuth, registerUser, loginUser, hasAnyUsers } from "./auth.js";
import { SessionManager, NotFoundError, ForbiddenError } from "./sessionManager.js";
import { DockerManager } from "./dockerManager.js";
import { SessionMeta } from "./types.js";

export function buildRouter(sessions: SessionManager, docker: DockerManager): Router {
        const router = Router();

        // ── Auth routes (public) ────────────────────────────────────────────────

        router.get("/auth/status", (_req: Request, res: Response) => {
                res.json({ needsSetup: !hasAnyUsers() });
        });

        router.post("/auth/register", (req: Request, res: Response) => {
                const { username, password } = req.body as { username?: string; password?: string };
                if (!username || !password || password.length < 6) {
                        res.status(400).json({ error: "username and password (min 6 chars) required" });
                        return;
                }
                try {
                        const result = registerUser(username, password);
                        res.status(201).json(result);
                } catch (err) {
                        res.status(409).json({ error: (err as Error).message });
                }
        });

        router.post("/auth/login", (req: Request, res: Response) => {
                const { username, password } = req.body as { username?: string; password?: string };
                if (!username || !password) {
                        res.status(400).json({ error: "username and password required" });
                        return;
                }
                try {
                        const result = loginUser(username, password);
                        res.json(result);
                } catch (err) {
                        res.status(401).json({ error: (err as Error).message });
                }
        });

        // ── Session routes (authenticated) ──────────────────────────────────────

        router.use("/sessions", requireAuth);

        // POST /sessions
        router.post("/sessions", async (req: Request, res: Response) => {
                const { userId } = req as AuthedRequest;
                const { name, cols, rows, envVars } = req.body as {
                        name?: string;
                        cols?: number;
                        rows?: number;
                        envVars?: Record<string, string>;
                };

                if (!name || typeof name !== "string") {
                        res.status(400).json({ error: "body.name is required" });
                        return;
                }

                let meta: SessionMeta;
                try {
                        meta = sessions.create({ userId, name, cols, rows, envVars });
                } catch (err) {
                        res.status(400).json({ error: (err as Error).message });
                        return;
                }

                try {
                        await docker.spawn(meta.sessionId);
                        // Re-fetch to get the container ID
                        const updated = sessions.get(meta.sessionId)!;
                        res.status(201).json(serializeMeta(updated));
                } catch (err) {
                        sessions.terminate(meta.sessionId);
                        console.error(`[routes] container spawn failed:`, (err as Error).message);
                        res.status(500).json({ error: `Failed to start container: ${(err as Error).message}` });
                }
        });

        // GET /sessions
        router.get("/sessions", (req: Request, res: Response) => {
                const { userId } = req as AuthedRequest;
                const includeTerminated = req.query.all === "true";
                const list = includeTerminated
                        ? sessions.listAllForUser(userId)
                        : sessions.listForUser(userId);
                res.json(list.map(serializeMeta));
        });

        // GET /sessions/:id
        router.get("/sessions/:id", (req: Request, res: Response) => {
                const { userId } = req as AuthedRequest;
                try {
                        const meta = sessions.assertOwnership(req.params.id, userId);
                        res.json(serializeMeta(meta));
                } catch (err) {
                        handleSessionError(err, res);
                }
        });

        // DELETE /sessions/:id — full terminate (stop + remove container)
        router.delete("/sessions/:id", async (req: Request, res: Response) => {
                const { userId } = req as AuthedRequest;
                try {
                        sessions.assertOwnership(req.params.id, userId);
                        await docker.kill(req.params.id);
                        sessions.terminate(req.params.id);
                        res.status(204).send();
                } catch (err) {
                        handleSessionError(err, res);
                }
        });

        // POST /sessions/:id/stop — stop container but keep it
        router.post("/sessions/:id/stop", async (req: Request, res: Response) => {
                const { userId } = req as AuthedRequest;
                try {
                        sessions.assertOwnership(req.params.id, userId);
                        await docker.stopContainer(req.params.id);
                        const updated = sessions.get(req.params.id)!;
                        res.json(serializeMeta(updated));
                } catch (err) {
                        handleSessionError(err, res);
                }
        });

        // POST /sessions/:id/start — restart a stopped container
        router.post("/sessions/:id/start", async (req: Request, res: Response) => {
                const { userId } = req as AuthedRequest;
                try {
                        sessions.assertOwnership(req.params.id, userId);
                        await docker.startContainer(req.params.id);
                        const updated = sessions.get(req.params.id)!;
                        res.json(serializeMeta(updated));
                } catch (err) {
                        handleSessionError(err, res);
                }
        });

        // PATCH /sessions/:id/env — update env vars
        router.patch("/sessions/:id/env", (req: Request, res: Response) => {
                const { userId } = req as AuthedRequest;
                const { envVars } = req.body as { envVars?: Record<string, string> };
                if (!envVars || typeof envVars !== "object") {
                        res.status(400).json({ error: "body.envVars must be an object" });
                        return;
                }
                try {
                        sessions.assertOwnership(req.params.id, userId);
                        sessions.updateEnvVars(req.params.id, envVars);
                        const updated = sessions.get(req.params.id)!;
                        res.json(serializeMeta(updated));
                } catch (err) {
                        handleSessionError(err, res);
                }
        });

        return router;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function serializeMeta(m: SessionMeta) {
        return {
                sessionId: m.sessionId,
                name: m.name,
                status: m.status,
                containerId: m.containerId?.slice(0, 12) ?? null,
                containerName: m.containerName,
                createdAt: m.createdAt.toISOString(),
                lastConnectedAt: m.lastConnectedAt?.toISOString() ?? null,
                cols: m.cols,
                rows: m.rows,
                envVars: m.envVars,
        };
}

function handleSessionError(err: unknown, res: Response): void {
        if (err instanceof NotFoundError) {
                res.status(404).json({ error: err.message });
        } else if (err instanceof ForbiddenError) {
                res.status(403).json({ error: err.message });
        } else {
                console.error("[routes] unexpected error:", (err as Error).message);
                res.status(500).json({ error: "Internal server error" });
        }
}
