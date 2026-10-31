/**
 * routes/composer.ts — `POST /api/sessions/:id/conversations/:cid/messages`
 * (docs/CONVERSATION.md §8). The route only translates HTTP: validation,
 * preconditions, the exclusion, the delivery and the ack live in
 * `conversation/composer.ts`, which answers with an HTTP status and body.
 *
 * Mounted ONLY when `CONVERSATION_COMPOSER_ENABLED` is on (§8.1.1): with the
 * flag off the path does not exist (404) and `canSendInput` is false
 * everywhere. Authorization is `assertCanOperate` — owner, or admin — so a
 * lead or an observer gets 403; a missing session 404. An admin sending to
 * a foreign session writes a point-in-time `session_observe_log
 * mode='operate'` row BEFORE any effect, fail-closed, and does not bump the
 * owner's idle clock (#300).
 */

import type { Request, Response, Router } from "express";
import type { AuthedRequest } from "../auth.js";
import { requireAdmin, requireAuth } from "../auth.js";
import { PANE_ID_RE, UUID_V4_RE } from "../conversation/composerText.js";
import { logger } from "../logger.js";
import * as observeLog from "../observeLog.js";
import { handleSessionError, type RouteContext } from "./shared.js";

export function registerComposerRoutes(router: Router, ctx: RouteContext): void {
	const { sessions, composer } = ctx;
	if (!composer?.enabled) return;
	const { conversationIp } = ctx.limiters;

	router.post(
		"/sessions/:id/conversations/:cid/messages",
		requireAuth,
		conversationIp,
		async (req: Request, res: Response) => {
			const { userId } = req as AuthedRequest;
			const sessionId = req.params.id;
			try {
				const meta = await sessions.assertCanOperate(sessionId, userId);
				if (meta.userId !== userId) res.locals.skipIdleBump = true;
				res.setHeader("Cache-Control", "no-store");
				const r = await composer.send({
					stSessionId: sessionId,
					cid: req.params.cid,
					callerId: userId,
					meta,
					body: req.body,
					audit: async () => {
						// Point-in-time operate row (#429 shape): the start is awaited
						// and fail-closed; the end is fire-and-forget.
						const logId = await observeLog.recordObserveStart(
							userId,
							sessionId,
							meta.userId,
							"operate",
						);
						observeLog.recordObserveEnd(logId).catch((err) => {
							logger.warn(
								`[composer] operate audit end failed: ${(err as Error).message} (log=${logId})`,
							);
						});
					},
				});
				res.status(r.status).json(r.body);
			} catch (err) {
				handleSessionError(err, res);
			}
		},
	);
}

/**
 * §8.1.11 — the admin surface, mounted only with the flag on:
 *   POST /admin/sessions/:id/composer/resolve {paneId, clientMessageId, outcome}
 *   GET  /admin/sessions/:id/composer/panes
 * `outcome` is `discarded` | `sent-manually` (a declaration: `operate` row,
 * fail-closed) or `reconcile` (idempotent, no declaration, no row). Both run
 * under the composer's pane lock: an active executor answers 409
 * `operation-active`. `requireAuth` comes from the `/admin` prefix.
 */
export function registerComposerAdminRoutes(router: Router, ctx: RouteContext): void {
	const { sessions, composer } = ctx;
	if (!composer?.enabled) return;
	const { adminActionIp, adminStatsIp } = ctx.limiters;

	router.post(
		"/admin/sessions/:id/composer/resolve",
		adminActionIp,
		requireAdmin,
		async (req: Request, res: Response) => {
			const { userId } = req as AuthedRequest;
			const b = (req.body ?? {}) as {
				paneId?: unknown;
				clientMessageId?: unknown;
				outcome?: unknown;
			};
			if (
				typeof b.paneId !== "string" ||
				!PANE_ID_RE.test(b.paneId) ||
				typeof b.clientMessageId !== "string" ||
				!UUID_V4_RE.test(b.clientMessageId) ||
				(b.outcome !== "discarded" && b.outcome !== "sent-manually" && b.outcome !== "reconcile")
			) {
				res.status(400).json({ error: "invalid-body" });
				return;
			}
			const sessionId = req.params.id;
			try {
				const meta = await sessions.get(sessionId);
				if (!meta) {
					res.status(404).json({ error: "Session not found" });
					return;
				}
				res.setHeader("Cache-Control", "no-store");
				const r = await composer.resolve({
					stSessionId: sessionId,
					paneId: b.paneId,
					clientMessageId: b.clientMessageId.toLowerCase(),
					outcome: b.outcome,
					by: userId,
					audit: async () => {
						const logId = await observeLog.recordObserveStart(
							userId,
							sessionId,
							meta.userId,
							"operate",
						);
						observeLog.recordObserveEnd(logId).catch((err) => {
							logger.warn(
								`[composer] resolve audit end failed: ${(err as Error).message} (log=${logId})`,
							);
						});
					},
				});
				res.status(r.status).json(r.body);
			} catch (err) {
				handleSessionError(err, res);
			}
		},
	);

	router.get(
		"/admin/sessions/:id/composer/panes",
		adminStatsIp,
		requireAdmin,
		async (req: Request, res: Response) => {
			try {
				if (!(await sessions.get(req.params.id))) {
					res.status(404).json({ error: "Session not found" });
					return;
				}
				res.setHeader("Cache-Control", "no-store");
				res.json(await composer.panes(req.params.id));
			} catch (err) {
				handleSessionError(err, res);
			}
		},
	);
}
