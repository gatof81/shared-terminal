/**
 * webPush.ts — Web Push (VAPID) sending + config (#355).
 *
 * The backend signs push messages with a VAPID keypair (private key in
 * `VAPID_PRIVATE_KEY`, public served to the frontend via
 * `GET /api/push/vapid-key` so no frontend build-time env var is
 * needed). All three of `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` /
 * `VAPID_SUBJECT` must be present for push to be enabled; any missing →
 * push is silently disabled (one boot-time warn, `sendToUser` becomes a
 * no-op). This keeps dev/local and pre-#355 deployments working with no
 * config.
 *
 * `sendToUser` fans a payload to every one of a user's stored
 * subscriptions and prunes any the push service reports as gone (404 /
 * 410) — a browser that cleared its subscription or a stale endpoint
 * must not accumulate in D1 or cost a send every trigger.
 */

import webpush from "web-push";
import { logger } from "./logger.js";
import { deleteSubscriptionByEndpoint, listSubscriptionsForUser } from "./pushSubscriptions.js";

let configured = false;
let publicKey: string | null = null;

/**
 * Read VAPID config from the environment and configure `web-push`.
 * Called once at boot. Returns whether push is enabled. Idempotent —
 * a second call re-reads the env (tests swap keys mid-run).
 *
 * The `VAPID_SUBJECT` must be a `mailto:` or `https:` URL per the VAPID
 * spec; `web-push` throws on a malformed one, so a bad subject disables
 * push (with a warn) rather than crashing the boot.
 */
export function configureWebPush(): boolean {
	const pub = process.env.VAPID_PUBLIC_KEY?.trim();
	const priv = process.env.VAPID_PRIVATE_KEY?.trim();
	const subject = process.env.VAPID_SUBJECT?.trim();
	if (!pub || !priv || !subject) {
		configured = false;
		publicKey = null;
		logger.warn(
			"[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT not all set — " +
				"Web Push disabled (no subscriptions accepted, no notifications sent).",
		);
		return false;
	}
	try {
		webpush.setVapidDetails(subject, pub, priv);
	} catch (err) {
		configured = false;
		publicKey = null;
		logger.warn(
			`[push] VAPID config rejected by web-push (${(err as Error).message}); Web Push disabled. ` +
				"VAPID_SUBJECT must be a mailto: or https: URL.",
		);
		return false;
	}
	configured = true;
	publicKey = pub;
	logger.info("[push] Web Push enabled (VAPID configured).");
	return true;
}

/** Whether push is configured (routes gate on this: subscribe/vapid-key
 *  404 when push is disabled so the frontend can hide the UI). */
export function isPushEnabled(): boolean {
	return configured;
}

/** The VAPID public key the frontend needs to create a subscription.
 *  Null when push is disabled. */
export function getVapidPublicKey(): string | null {
	return publicKey;
}

/** Payload shape delivered to the service worker. Kept small — push
 *  services cap the encrypted payload (~4 KB) and iOS is stricter. */
export interface PushPayload {
	title: string;
	body: string;
	/** Session the notification is about — the SW uses it to focus/open
	 *  the right session on click. */
	sessionId: string;
}

/**
 * Send `payload` to every subscription owned by `userId`. Best-effort:
 * per-subscription failures are isolated (one dead endpoint doesn't
 * block the others), and a 404/410 ("gone") prunes that subscription
 * from D1. Never throws — callers (the bell sweeper) fire-and-forget.
 * No-op when push is disabled.
 */
export async function sendToUser(userId: string, payload: PushPayload): Promise<void> {
	if (!configured) return;
	let subs: Awaited<ReturnType<typeof listSubscriptionsForUser>>;
	try {
		subs = await listSubscriptionsForUser(userId);
	} catch (err) {
		logger.warn(
			`[push] failed to load subscriptions for user ${userId}: ${(err as Error).message}`,
		);
		return;
	}
	if (subs.length === 0) return;
	const body = JSON.stringify(payload);
	await Promise.all(
		subs.map(async (sub) => {
			try {
				await webpush.sendNotification(
					{ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
					body,
				);
			} catch (err) {
				const status = (err as { statusCode?: number }).statusCode;
				// 404 (endpoint unknown) / 410 (subscription expired) are the
				// push-spec "this subscription is gone forever" signals — prune
				// it so it stops costing a send. Any other error (network,
				// 5xx from the push service) is transient; leave the row.
				if (status === 404 || status === 410) {
					await deleteSubscriptionByEndpoint(sub.endpoint).catch(() => {});
					logger.info(`[push] pruned gone subscription (status ${status}) for user ${userId}`);
				} else {
					logger.warn(
						`[push] send failed for user ${userId} (status ${status ?? "?"}): ${(err as Error).message}`,
					);
				}
			}
		}),
	);
}
