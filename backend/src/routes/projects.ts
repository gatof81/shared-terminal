/**
 * routes/projects.ts — projects (projects/directory.ts): create, list,
 * archive. Mounted only with PROJECT_CHAT_ENABLED on: off ⇒ the paths do not
 * exist (404, not 401 — `requireAuth` is per route). Owner-only; a foreign or
 * missing project is the same 404.
 */

import type { Request, Response, Router } from "express";
import type { AuthedRequest } from "../auth.js";
import { requireAuth } from "../auth.js";
import { logger } from "../logger.js";
import { ProjectError } from "../projects/directory.js";
import type { RouteContext } from "./shared.js";

function sendError(res: Response, err: unknown, what: string): void {
	if (err instanceof ProjectError) {
		res.status(err.status).json({ error: err.code, message: err.message });
		return;
	}
	logger.error(`[projects] ${what} failed: ${(err as Error).message}`);
	res.status(500).json({ error: "internal" });
}

export function registerProjectRoutes(router: Router, ctx: RouteContext): void {
	const { projects } = ctx;
	if (!projects) return;
	const { projectIp } = ctx.limiters;

	router.post("/projects", requireAuth, projectIp, async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		res.setHeader("Cache-Control", "no-store");
		try {
			const r = await projects.createProject(userId, req.body);
			res.status(201).json({ ...r.body, replayed: r.replayed });
		} catch (err) {
			sendError(res, err, "create project");
		}
	});

	router.get("/projects", requireAuth, projectIp, async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		res.setHeader("Cache-Control", "no-store");
		try {
			res.json(await projects.listProjects(userId));
		} catch (err) {
			sendError(res, err, "list projects");
		}
	});

	router.delete("/projects/:pid", requireAuth, projectIp, async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		try {
			await projects.archiveProject(userId, req.params.pid);
			res.status(204).send();
		} catch (err) {
			sendError(res, err, "archive project");
		}
	});
}
