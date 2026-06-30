/**
 * routes/invites.ts — admin-gated invite mint/list/revoke (#311). Bodies
 * moved verbatim from routes.ts; limiters re-bound from `ctx`.
 */

import type { Request, Response, Router } from "express";
import type { AuthedRequest } from "../auth.js";
import {
	createInvite,
	InviteQuotaExceededError,
	listInvites,
	requireAdmin,
	revokeInvite,
} from "../auth.js";
import { logger } from "../logger.js";
import type { RouteContext } from "./shared.js";

export function registerInviteRoutes(router: Router, ctx: RouteContext): void {
	const { invitesListIp, invitesCreateIp, invitesRevokeIp } = ctx.limiters;

	// ── Invite routes ───────────────────────────────────────────────────────
	// All three routes are gated by `requireAdmin` (#50). Non-admins
	// don't need invite access at all — they can't mint, and pre-#50
	// codes minted by then-non-admin accounts must remain manageable
	// somewhere; admin-scoped list/revoke is the cleaner answer than
	// per-user filtering that would orphan those rows.
	//
	// requireAuth is provided by `router.use("/invites", requireAuth)`
	// above — requireAdmin reads `req.userId` populated there.

	// GET is rate-limited symmetrically with POST/DELETE (issue #47):
	// a much higher cap because reads are cheap, but the same per-IP
	// shape so the asymmetry doesn't read as accidental and a runaway
	// client polling in a loop can't hammer D1 unbounded.
	router.get("/invites", invitesListIp, requireAdmin, async (_req: Request, res: Response) => {
		try {
			const invites = await listInvites();
			res.json(invites);
		} catch (err) {
			logger.error(`[invites] list failed: ${(err as Error).message}`);
			res.status(500).json({ error: "Internal server error" });
		}
	});

	router.post("/invites", invitesCreateIp, requireAdmin, async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		try {
			const invite = await createInvite(userId);
			res.status(201).json(invite);
		} catch (err) {
			if (err instanceof InviteQuotaExceededError) {
				res.status(429).json({ error: err.message });
				return;
			}
			logger.error(`[invites] create failed: ${(err as Error).message}`);
			res.status(500).json({ error: "Internal server error" });
		}
	});

	router.delete(
		"/invites/:hash",
		invitesRevokeIp,
		requireAdmin,
		async (req: Request, res: Response) => {
			const { hash } = req.params;
			// SHA-256 hex is exactly 64 lowercase hex chars. Reject anything
			// else before the D1 round-trip — a caller probing arbitrary
			// strings shouldn't reach the database.
			if (!/^[0-9a-f]{64}$/.test(hash)) {
				res.status(400).json({ error: "hash must be a 64-char lowercase hex SHA-256 digest" });
				return;
			}
			try {
				const removed = await revokeInvite(hash);
				if (!removed) {
					// Vague on purpose: missing vs. already-used should not be
					// distinguishable from the wire (no enumeration vector).
					res.status(404).json({ error: "Invite not found or already used" });
					return;
				}
				res.status(204).send();
			} catch (err) {
				logger.error(`[invites] revoke failed: ${(err as Error).message}`);
				res.status(500).json({ error: "Internal server error" });
			}
		},
	);
}
