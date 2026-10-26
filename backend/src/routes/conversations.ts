/**
 * routes/conversations.ts — `GET /api/sessions/:id/conversations`
 * (docs/CONVERSATION.md §6, the part that ships in 3.0b).
 *
 * Owner-only via `assertOwnedByOr404` (design §3.4, decision 6: titles
 * and derived metadata are conversation content, so a foreign session
 * answers like a missing one). Content endpoints (events, agents, WS)
 * are 3.1. `canSendInput` is pinned to false until 3.2 exists.
 */

import type { Request, Response, Router } from "express";
import type { AuthedRequest } from "../auth.js";
import { requireAuth } from "../auth.js";
import { assertOwnedByOr404, handleSessionError, type RouteContext } from "./shared.js";

export function registerConversationRoutes(router: Router, ctx: RouteContext): void {
	const { sessions, conversation } = ctx;
	const { conversationIp } = ctx.limiters;

	router.get(
		"/sessions/:id/conversations",
		requireAuth,
		conversationIp,
		async (req: Request, res: Response) => {
			const { userId } = req as AuthedRequest;
			try {
				await assertOwnedByOr404(sessions, req.params.id, userId);
				res.setHeader("Cache-Control", "no-store");
				if (!conversation) {
					// Deployment without the subsystem wired (flag off at boot):
					// a stable, honest shape rather than a 404 the UI would
					// confuse with "session missing".
					res.json({
						capture: {
							requested: false,
							effective: false,
							effectiveAfterRestart: false,
							requiresRecreate: false,
							pendingReasons: ["flag-off"],
							checkedAt: null,
						},
						conversations: [],
					});
					return;
				}
				res.json(await conversation.list(req.params.id));
			} catch (err) {
				handleSessionError(err, res);
			}
		},
	);
}
