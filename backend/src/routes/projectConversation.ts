/**
 * routes/projectConversation.ts — HTTP for the project conversation
 * (docs/PROJECT_CONVERSATION.md §5). Only translates: the rules live in
 * projects/conversation/{fanout,api}.ts.
 *
 * Mounted only when PROJECT_CONVERSATION_ENABLED is effective (ctx carries
 * the holder); otherwise these paths do not exist (404), as the contract's
 * flag rule requires. Owner only: a foreign or missing project is the same
 * 404 `project-not-found`.
 */

import type { Request, Response, Router } from "express";
import type { AuthedRequest } from "../auth.js";
import { requireAuth } from "../auth.js";
import { logger } from "../logger.js";
import type { ProjectConversationApi } from "../projects/conversation/api.js";
import { logErrorToHttp } from "../projects/conversation/api.js";
import type { RouteContext } from "./shared.js";

export function registerProjectConversationRoutes(router: Router, ctx: RouteContext): void {
	const holder = ctx.projectConversation;
	if (!holder || !ctx.projects) return;
	const { projectIp } = ctx.limiters;

	/** Auth'd owner + started store, else the answer has been sent. */
	const gate = async (
		req: Request,
		res: Response,
	): Promise<{ api: ProjectConversationApi; userId: string } | null> => {
		res.setHeader("Cache-Control", "no-store");
		const { userId } = req as AuthedRequest;
		const api = holder.api;
		if (!api || api.store.unavailable) {
			res.status(503).json({ error: "project-writer-unavailable" });
			return null;
		}
		if (!(await api.owns(userId, req.params.pid as string))) {
			res.status(404).json({ error: "project-not-found" });
			return null;
		}
		return { api, userId };
	};

	const handle =
		(
			what: string,
			fn: (
				api: ProjectConversationApi,
				userId: string,
				req: Request,
			) => Promise<{ status: number; body: unknown }>,
		) =>
		async (req: Request, res: Response) => {
			try {
				const g = await gate(req, res);
				if (!g) return;
				const r = await fn(g.api, g.userId, req);
				res.status(r.status).json(r.body);
			} catch (err) {
				const h = logErrorToHttp(err);
				if (h) {
					res.status(h.status).json(h.body);
					return;
				}
				logger.error(`[projects] conversation ${what} failed: ${(err as Error).message}`);
				res.status(500).json({ error: "internal" });
			}
		};

	router.post(
		"/projects/:pid/conversation/messages",
		requireAuth,
		projectIp,
		handle("send", (api, userId, req) => api.send(userId, req.params.pid as string, req.body)),
	);
	router.get(
		"/projects/:pid/conversation/events",
		requireAuth,
		projectIp,
		handle("events", (api, _u, req) =>
			api.events(req.params.pid as string, req.query as Record<string, unknown>),
		),
	);
	router.get(
		"/projects/:pid/conversation/messages/:msgId",
		requireAuth,
		projectIp,
		handle("message", (api, _u, req) =>
			api.message(req.params.pid as string, req.params.msgId as string),
		),
	);
	router.post(
		"/projects/:pid/conversation/acks",
		requireAuth,
		projectIp,
		handle("ack", (api, userId, req) => api.ack(userId, req.params.pid as string, req.body)),
	);
}
