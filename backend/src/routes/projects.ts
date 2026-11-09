/**
 * routes/projects.ts — P3a, the project & agent directory (docs/PROJECTS.md
 * §4). The routes only translate HTTP; validation, atomicity, idempotency
 * and the read model live in `projects/directory.ts`.
 *
 * Mounted ONLY when PROJECT_CHAT_ENABLED is on: with the flag off the paths
 * do not exist (the same 404 as any unknown route — not a 401, which is why
 * `requireAuth` is per route here and not a `/projects` prefix mount).
 * Owner-only (R5): a foreign or missing project or agent is the same 404,
 * for admins and leads too.
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

	router.post(
		"/projects/:pid/agents",
		requireAuth,
		projectIp,
		async (req: Request, res: Response) => {
			const { userId } = req as AuthedRequest;
			res.setHeader("Cache-Control", "no-store");
			try {
				const r = await projects.createAgent(userId, req.params.pid, req.body);
				res.status(201).json({ ...r.body, replayed: r.replayed });
			} catch (err) {
				sendError(res, err, "create agent");
			}
		},
	);

	router.get(
		"/projects/:pid/agents",
		requireAuth,
		projectIp,
		async (req: Request, res: Response) => {
			const { userId } = req as AuthedRequest;
			res.setHeader("Cache-Control", "no-store");
			try {
				res.json(await projects.listAgents(userId, req.params.pid));
			} catch (err) {
				sendError(res, err, "list agents");
			}
		},
	);

	router.get(
		"/projects/:pid/agents/:aid",
		requireAuth,
		projectIp,
		async (req: Request, res: Response) => {
			const { userId } = req as AuthedRequest;
			res.setHeader("Cache-Control", "no-store");
			try {
				res.json(await projects.getAgent(userId, req.params.pid, req.params.aid));
			} catch (err) {
				sendError(res, err, "read agent");
			}
		},
	);

	router.delete(
		"/projects/:pid/agents/:aid",
		requireAuth,
		projectIp,
		async (req: Request, res: Response) => {
			const { userId } = req as AuthedRequest;
			try {
				await projects.removeAgent(userId, req.params.pid, req.params.aid);
				res.status(204).send();
			} catch (err) {
				sendError(res, err, "remove agent");
			}
		},
	);
}
