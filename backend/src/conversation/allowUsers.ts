/**
 * conversation/allowUsers.ts — `CONVERSATION_ALLOW_USERS` (CONVERSATION.md §7).
 *
 * A comma-separated list of user ids whose NEW sessions are born with
 * `conversation_requested = 1`. It only sets what is requested: capture is
 * still effective only with the flag on, no revocation and an image with
 * the relay (§2.7.6), and existing sessions are never touched — they need
 * the admin `PATCH` (and, if their container has no capture, a recreation).
 *
 * Read once at boot. Entries that are not user-id shaped are dropped with
 * a warning instead of failing the boot: the list widens nothing beyond
 * "requested", and a typo should not take the backend down.
 */

import { logger } from "../logger.js";

/** `users.id` is a UUID v4 (auth.ts); the same shape, case-insensitively. */
const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseAllowUsers(raw: string | undefined): ReadonlySet<string> {
	const out = new Set<string>();
	if (!raw) return out;
	for (const part of raw.split(",")) {
		const id = part.trim();
		if (id === "") continue;
		if (!USER_ID_RE.test(id)) {
			logger.warn(`[conversation] CONVERSATION_ALLOW_USERS: ignoring "${id}" (not a user id)`);
			continue;
		}
		out.add(id.toLowerCase());
	}
	return out;
}
