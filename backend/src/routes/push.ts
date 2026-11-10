/**
 * routes/push.ts — Web Push subscription management (#355).
 *
 *   GET    /api/push/vapid-key   → { key } | 404 when push disabled
 *   GET    /api/push/status      → { enabled, subscribed }
 *   POST   /api/push/subscribe   → 204 (upsert the browser's subscription)
 *   DELETE /api/push/subscribe   → 204 (remove the caller's own row by endpoint; "turn off")
 *
 * All under `requireAuth` (mounted in routes.ts). Subscriptions are
 * user-scoped: `upsertSubscription` re-owns the endpoint to the caller,
 * so a shared device switching accounts can't leak the previous user's
 * notifications. When VAPID isn't configured every route degrades
 * gracefully (vapid-key/subscribe 404 so the frontend hides the UI).
 */

import type { Request, Response, Router } from "express";
import type { AuthedRequest } from "../auth.js";
import { logger } from "../logger.js";
import {
	deleteOwnSubscription,
	PushQuotaExceededError,
	upsertSubscription,
	userHasSubscription,
} from "../pushSubscriptions.js";
import { getVapidPublicKey, isAllowedPushEndpoint, isPushEnabled } from "../webPush.js";
import type { RouteContext } from "./shared.js";

// Bound the subscription fields at the boundary. A browser `endpoint`
// is a push-service URL (hundreds of chars); the keys are fixed-size
// base64url. Generous caps that still reject a hostile multi-KB body
// before it reaches D1.
const ENDPOINT_MAX = 2048;
const KEY_MAX = 256;

export function registerPushRoutes(router: Router, _ctx: RouteContext): void {
	router.get("/push/vapid-key", (_req: Request, res: Response) => {
		const key = getVapidPublicKey();
		if (!key) {
			res.status(404).json({ error: "push not configured" });
			return;
		}
		res.json({ key });
	});

	router.get("/push/status", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		const enabled = isPushEnabled();
		if (!enabled) {
			res.json({ enabled: false, subscribed: false });
			return;
		}
		try {
			res.json({ enabled: true, subscribed: await userHasSubscription(userId) });
		} catch (err) {
			logger.error(`[push] status failed for user ${userId}: ${(err as Error).message}`);
			res.status(500).json({ error: "Internal server error" });
		}
	});

	router.post("/push/subscribe", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		if (!isPushEnabled()) {
			// Push disabled server-side — refuse rather than storing a
			// subscription that would never receive anything.
			res.status(404).json({ error: "push not configured" });
			return;
		}
		const body = req.body as {
			endpoint?: unknown;
			keys?: { p256dh?: unknown; auth?: unknown };
		};
		const endpoint = body.endpoint;
		const p256dh = body.keys?.p256dh;
		const auth = body.keys?.auth;
		if (
			typeof endpoint !== "string" ||
			endpoint.length === 0 ||
			endpoint.length > ENDPOINT_MAX ||
			!/^https:\/\//.test(endpoint) ||
			typeof p256dh !== "string" ||
			p256dh.length === 0 ||
			p256dh.length > KEY_MAX ||
			typeof auth !== "string" ||
			auth.length === 0 ||
			auth.length > KEY_MAX
		) {
			res
				.status(400)
				.json({ error: "invalid subscription (endpoint + keys.p256dh + keys.auth required)" });
			return;
		}
		// Only a real push service (#566): any other https URL made the
		// backend POST wherever the client said, from inside its network.
		if (!isAllowedPushEndpoint(endpoint)) {
			res.status(400).json({ error: "push endpoint not allowed", code: "endpoint-not-allowed" });
			return;
		}
		try {
			await upsertSubscription(userId, { endpoint, p256dh, auth });
			res.status(204).send();
		} catch (err) {
			if (err instanceof PushQuotaExceededError) {
				res.status(429).json({ error: err.message });
				return;
			}
			logger.error(`[push] subscribe failed for user ${userId}: ${(err as Error).message}`);
			res.status(500).json({ error: "Internal server error" });
		}
	});

	router.delete("/push/subscribe", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		const body = req.body as { endpoint?: unknown };
		const endpoint = body.endpoint;
		if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > ENDPOINT_MAX) {
			res.status(400).json({ error: "body.endpoint is required" });
			return;
		}
		try {
			// Only the caller's own row (#566): the endpoint is not a secret
			// to anyone who reads a D1 export or a backup. Always 204 — the
			// answer must not tell whether someone else holds the endpoint.
			await deleteOwnSubscription(userId, endpoint);
			logger.info(`[push] user ${userId} unsubscribed an endpoint`);
			res.status(204).send();
		} catch (err) {
			logger.error(`[push] unsubscribe failed for user ${userId}: ${(err as Error).message}`);
			res.status(500).json({ error: "Internal server error" });
		}
	});
}
