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
import { InFlightLimiter } from "../inFlightLimiter.js";
import { logger } from "../logger.js";
import type { ProjectConversationApi } from "../projects/conversation/api.js";
import { logErrorToHttp } from "../projects/conversation/api.js";
import type { ProjectArtifacts } from "../projects/conversation/artifacts.js";
import { contentDispositionFilename } from "../workspaceFiles.js";
import { holdSlotUntilResponseEnds } from "./files.js";
import { holdSlotUntilWorkAndResponseEnd } from "./git.js";
import type { RouteContext } from "./shared.js";

// Artifact reads and registrations each hold ≤ 1 MiB in memory (§6.1); the
// per-minute limiter does not bound memory, these slots do (as in Files).
const ARTIFACT_IN_FLIGHT_PER_USER = 2;
const ARTIFACT_IN_FLIGHT_TOTAL = 8;

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

	// ── D2 artifacts (§6), mounted only with PROJECT_ARTIFACTS_ENABLED effective ──
	if (!("artifacts" in holder)) return;
	const slots = new InFlightLimiter(ARTIFACT_IN_FLIGHT_PER_USER, ARTIFACT_IN_FLIGHT_TOTAL);
	/**
	 * A slot, else the answer has been sent. `"response"`: held until the
	 * response ends — right for a read, whose only cost is the bytes the
	 * client drains. `"work"`: held until the returned `done()` is called AND
	 * the response has ended. A registration keeps reading, copying and
	 * appending after its client disconnects (nothing cancels it), and §6.2's
	 * bound on unreferenced bytes is "budget + what in-flight registrations
	 * copy", so the slots must count those registrations until they settle,
	 * not until their client goes away.
	 */
	const withSlot = (req: Request, res: Response, hold: "response" | "work") => {
		const userId = (req as AuthedRequest).userId;
		const outcome =
			hold === "work"
				? holdSlotUntilWorkAndResponseEnd(slots, userId, res)
				: holdSlotUntilResponseEnds(slots, userId, res);
		if (outcome === "busy") {
			res.setHeader("Retry-After", "1");
			res.status(429).json({ error: "busy" });
		}
		if (outcome === "busy" || outcome === "gone") return null;
		return typeof outcome === "function" ? outcome : () => {};
	};
	/** Owner + started artifacts + an in-flight slot, else the answer has been sent. */
	const artifactGate = async (
		req: Request,
		res: Response,
		hold: "response" | "work",
	): Promise<{ art: ProjectArtifacts; userId: string; done: () => void } | null> => {
		const g = await gate(req, res);
		if (!g) return null;
		const art = holder.artifacts;
		if (!art) {
			res.status(503).json({ error: "project-writer-unavailable" });
			return null;
		}
		const done = withSlot(req, res, hold);
		return done ? { art, userId: g.userId, done } : null;
	};
	const failed = (what: string, res: Response, err: unknown) => {
		const h = logErrorToHttp(err);
		if (h) {
			res.status(h.status).json(h.body);
			return;
		}
		logger.error(`[projects] artifact ${what} failed: ${(err as Error).message}`);
		res.status(500).json({ error: "internal" });
	};
	router.post(
		"/projects/:pid/conversation/artifacts",
		requireAuth,
		projectIp,
		async (req: Request, res: Response) => {
			try {
				const g = await artifactGate(req, res, "work");
				if (!g) return;
				let r: Awaited<ReturnType<ProjectArtifacts["register"]>>;
				try {
					r = await g.art.register(g.userId, req.params.pid as string, req.body);
				} finally {
					g.done();
				}
				res.status(r.status).json(r.body);
			} catch (err) {
				failed("register", res, err);
			}
		},
	);
	router.get(
		"/projects/:pid/conversation/artifacts/:sha",
		requireAuth,
		projectIp,
		async (req: Request, res: Response) => {
			try {
				const g = await artifactGate(req, res, "response");
				if (!g) return;
				const r = await g.art.content(req.params.pid as string, req.params.sha as string);
				if (!("ok" in r)) {
					res.status(r.status).json(r.body);
					return;
				}
				// Another agent's bytes (§6.5): text only, never rendered by the
				// browser as anything else, and downloaded rather than navigated.
				res.setHeader("Content-Type", "text/plain; charset=utf-8");
				res.setHeader("X-Content-Type-Options", "nosniff");
				res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
				res.setHeader(
					"Content-Disposition",
					`attachment; filename="${contentDispositionFilename(r.name)}"`,
				);
				res.status(200).send(r.content);
			} catch (err) {
				failed("read", res, err);
			}
		},
	);
}
