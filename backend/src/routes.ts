/**
 * routes.ts — REST API routes.
 */

import { Router, Request, Response } from "express";
import { AuthedRequest, requireAuth, registerUser, loginUser, hasAnyUsers } from "./auth.js";
import { SessionManager, NotFoundError, ForbiddenError } from "./sessionManager.js";
import { DockerManager } from "./dockerManager.js";
import { SessionMeta } from "./types.js";

export function buildRouter(sessions: SessionManager, docker: DockerManager): Router {
        const router = Router();

        // ── Auth routes (public) ────────────────────────────────────────────────

        router.get("/auth/status", async (_req: Request, res: Response) => {
                res.json({ needsSetup: !(await hasAnyUsers()) });
        });

        router.post("/auth/register", async (req: Request, res: Response) => {
                const { username, password } = req.body as { username?: string; password?: string };
                if (!username || !password || password.length < 6) {
                        res.status(400).json({ error: "username and password (min 6 chars) required" });
                        return;
                }
                try {
                        const result = await registerUser(username, password);
                        res.status(201).json(result);
                } catch (err) {
                        res.status(409).json({ error: (err as Error).message });
                }
        });

        router.post("/auth/login", async (req: Request, res: Response) => {
                const { username, password } = req.body as { username?: string; password?: string };
                if (!username || !password) {
                        res.status(400).json({ error: "username and password required" });
                        return;
                }
                try {
                        const result = await loginUser(username, password);
                        res.json(result);
                } catch (err) {
                        res.status(401).json({ error: (err as Error).message });
                }
        });

        // ── Session routes (authenticated) ──────────────────────────────────────

        router.use("/sessions", requireAuth);

        router.post("/sessions", async (req: Request, res: Response) => {
                const { userId } = req as AuthedRequest;
                const { name, cols, rows, envVars } = req.body as {
                        name?: string; cols?: number; rows?: number; envVars?: Record<string, string>;
                };
                if (!name || typeof name !== "string") {
                        res.status(400).json({ error: "body.name is required" });
                        return;
                }
                try {
                        const meta = await sessions.create({ userId, name, cols, rows, envVars });
                        await docker.spawn(meta.sessionId);
                        const updated = await sessions.get(meta.sessionId);
                        res.status(201).json(serializeMeta(updated!));
                } catch (err) {
                        console.error(`[routes] session create failed:`, (err as Error).message);
                        res.status(500).json({ error: (err as Error).message });
                }
        });

        router.get("/sessions", async (req: Request, res: Response) => {
                const { userId } = req as AuthedRequest;
                const includeTerminated = req.query.all === "true";
                const list = includeTerminated
                        ? await sessions.listAllForUser(userId)
                        : await sessions.listForUser(userId);
                res.json(list.map(serializeMeta));
        });

        router.get("/sessions/:id", async (req: Request, res: Response) => {
                const { userId } = req as AuthedRequest;
                try {
                        const meta = await sessions.assertOwnership(req.params.id, userId);
                        res.json(serializeMeta(meta));
                } catch (err) {
                        handleSessionError(err, res);
                }
        });

        router.delete("/sessions/:id", async (req: Request, res: Response) => {
                const { userId } = req as AuthedRequest;
                // `?hard=true` turns this into a hard delete: container is killed,
                // workspace files are wiped from disk, and the D1 row is removed.
                // Without it, we do a soft delete — container goes away but the row
                // stays (status=terminated) and the workspace dir is preserved so
                // the user can later restore the session.
                const hard = req.query.hard === "true" || req.query.hard === "1";

                try {
                        const meta = await sessions.assertOwnership(req.params.id, userId);

                        // Idempotent path: only tear down the container + flip to
                        // terminated the first time. Subsequent calls skip this.
                        if (meta.status !== "terminated") {
                                await docker.kill(req.params.id);
                                await sessions.terminate(req.params.id);
                        }

                        if (hard) {
                                // Wipe workspace files and drop the row entirely.
                                try {
                                        await docker.purgeWorkspace(req.params.id);
                                } catch (err) {
                                        console.error(`[routes] purgeWorkspace failed for ${req.params.id}:`, (err as Error).message);
                                        // Fall through — we still want to remove the row.
                                }
                                await sessions.deleteRow(req.params.id);
                        }

                        res.status(204).send();
                } catch (err) {
                        handleSessionError(err, res);
                }
        });

        router.post("/sessions/:id/stop", async (req: Request, res: Response) => {
                const { userId } = req as AuthedRequest;
                try {
                        await sessions.assertOwnership(req.params.id, userId);
                        await docker.stopContainer(req.params.id);
                        const updated = await sessions.get(req.params.id);
                        res.json(serializeMeta(updated!));
                } catch (err) {
                        handleSessionError(err, res);
                }
        });

        router.post("/sessions/:id/start", async (req: Request, res: Response) => {
                const { userId } = req as AuthedRequest;
                try {
                        await sessions.assertOwnership(req.params.id, userId);
                        await docker.startContainer(req.params.id);
                        const updated = await sessions.get(req.params.id);
                        res.json(serializeMeta(updated!));
                } catch (err) {
                        handleSessionError(err, res);
                }
        });

        router.patch("/sessions/:id/env", async (req: Request, res: Response) => {
                const { userId } = req as AuthedRequest;
                const { envVars } = req.body as { envVars?: Record<string, string> };
                if (!envVars || typeof envVars !== "object") {
                        res.status(400).json({ error: "body.envVars must be an object" });
                        return;
                }
                try {
                        await sessions.assertOwnership(req.params.id, userId);
                        await sessions.updateEnvVars(req.params.id, envVars);
                        const updated = await sessions.get(req.params.id);
                        res.json(serializeMeta(updated!));
                } catch (err) {
                        handleSessionError(err, res);
                }
        });

        return router;
}

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
