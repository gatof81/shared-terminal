/**
 * pushSubscriptions.ts — D1 storage for Web Push subscriptions (#355).
 *
 * One row per (user, browser-endpoint). A subscription is the browser's
 * `PushSubscription` JSON: an `endpoint` URL plus two encryption keys
 * (`p256dh`, `auth`). `endpoint` is UNIQUE — re-subscribing from the
 * same browser upserts rather than duplicating, and re-owns the row to
 * the current user (a shared device that switches accounts must not
 * push the old user's sessions to the new user's browser).
 *
 * Schema: migration v14 in db.ts.
 */

import { randomUUID } from "node:crypto";
import { d1Query } from "./db.js";

/**
 * Per-user cap on stored subscriptions (#415 review). Without it, an
 * authed user can POST synthetic `https://` endpoints (endpoint validity
 * isn't verifiable at subscribe time — only a real push service's 404/410
 * on send prunes) to bloat D1 AND balloon the bell-sweeper's per-trigger
 * fan-out to O(N) concurrent HTTPS calls. 20 devices is already generous.
 * Same guard shape as MAX_TEMPLATES_PER_USER.
 */
export const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 20;

export class PushQuotaExceededError extends Error {
	constructor() {
		super(`Push subscription limit (${MAX_PUSH_SUBSCRIPTIONS_PER_USER}) reached`);
		this.name = "PushQuotaExceededError";
	}
}

export interface PushSubscriptionRow {
	endpoint: string;
	p256dh: string;
	auth: string;
}

/**
 * Upsert a subscription for `userId`. Keyed on the UNIQUE `endpoint`:
 * ON CONFLICT re-points the row to this user and refreshes the keys (a
 * browser can rotate its `p256dh`/`auth` when the subscription is
 * re-created). Idempotent — the frontend re-registers on every load.
 */
export async function upsertSubscription(userId: string, sub: PushSubscriptionRow): Promise<void> {
	// Cap only NEW endpoints: re-subscribing an existing browser is an
	// UPDATE (re-owns / refreshes keys) and must always succeed even at the
	// cap — otherwise a user who hit the limit could never rotate a device's
	// keys. So gate on "does this endpoint already exist?" first. Read-then-
	// write, racy under same-user concurrent subscribes (a benign v1 gap:
	// worst case a couple of rows over the cap, same shape as the #202
	// budget check) — the point read is cheap and subscribe is rare.
	const existing = await d1Query<{ one: number }>(
		"SELECT 1 AS one FROM push_subscriptions WHERE endpoint = ?",
		[sub.endpoint],
	);
	if (existing.results.length === 0) {
		const count = await d1Query<{ n: number }>(
			"SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?",
			[userId],
		);
		if ((count.results[0]?.n ?? 0) >= MAX_PUSH_SUBSCRIPTIONS_PER_USER) {
			throw new PushQuotaExceededError();
		}
	}
	await d1Query(
		"INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) " +
			"VALUES (?, ?, ?, ?, ?) " +
			"ON CONFLICT(endpoint) DO UPDATE SET " +
			"user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth",
		[randomUUID(), userId, sub.endpoint, sub.p256dh, sub.auth],
	);
}

/** Every subscription owned by `userId` — the send fan-out set. */
export async function listSubscriptionsForUser(userId: string): Promise<PushSubscriptionRow[]> {
	const result = await d1Query<PushSubscriptionRow>(
		"SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?",
		[userId],
	);
	return result.results;
}

/**
 * Delete a subscription by endpoint. Two callers:
 *   - the frontend on explicit "turn off notifications" (DELETE route),
 *   - `webPush.sendToUser` when the push service reports 404/410 (gone).
 * Not user-scoped: the endpoint is globally unique and both callers act
 * on the current holder. Returns whether a row was removed.
 */
export async function deleteSubscriptionByEndpoint(endpoint: string): Promise<boolean> {
	const result = await d1Query("DELETE FROM push_subscriptions WHERE endpoint = ?", [endpoint]);
	return result.meta.changes > 0;
}

/** Whether `userId` has at least one subscription — the frontend uses
 *  it (via GET /api/push/status) to render the toggle's initial state
 *  across devices. */
export async function userHasSubscription(userId: string): Promise<boolean> {
	const result = await d1Query<{ n: number }>(
		"SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?",
		[userId],
	);
	return (result.results[0]?.n ?? 0) > 0;
}
