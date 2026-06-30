import type { Request, Response, Router } from "express";
import type { AuthedRequest } from "../auth.js";
import { requireAdmin } from "../auth.js";
import * as groups from "../groups.js";
import { logger } from "../logger.js";
import { ForbiddenError, NotFoundError } from "../sessionManager.js";
import type { RouteContext } from "./shared.js";

// Upper bound for any `user_id` we accept at the request boundary
// (group lead / group member). UUIDs are 36 chars; the 128 cap is
// headroom for any future ID format while keeping the value bounded
// well below `assertUserExists`'s D1 round-trip cost on malformed
// input. Used by the admin-group routes; see the trim-first
// validators there. #262 round 6 NIT.
const USER_ID_MAX_LEN = 128;

export function registerGroupRoutes(router: Router, ctx: RouteContext): void {
	const { adminStatsIp, adminActionIp } = ctx.limiters;
	// ── Admin group-management routes (#201a) ─────────────────────────────────
	// Six routes mounted under /admin/groups for managing user-groups + the
	// tech-lead designation. Routes are gated by `requireAdmin` (via the
	// `/admin` prefix's `requireAuth` + the explicit `requireAdmin` middleware
	// chained on each one). Reads use the shared `adminStatsIp` limiter (high
	// cap, same bucket dashboards poll); writes use `adminActionIp` (lower
	// cap, destructive). Per the lock-in on issue #201 — group authoring is
	// admin-only; the lead's view of their group lives on `/api/groups/mine`
	// in 201c, which is NOT admin-gated.
	//
	// `handleGroupError` collapses every typed error this module raises into
	// the right HTTP status + body shape. Anything else surfaces as 500 with
	// a logged message, matching the rest of the admin-routes pattern.
	const handleGroupError = (err: unknown, res: Response, context: string): void => {
		if (err instanceof NotFoundError) {
			res.status(404).json({ error: err.message });
			return;
		}
		// Pre-wired for 201b — `assertCanObserve` will throw
		// ForbiddenError when a non-lead tries to read a group's
		// member sessions. Adding the arm now means 201b doesn't
		// have to remember to extend this handler. See #262 round
		// 6 NIT.
		if (err instanceof ForbiddenError) {
			res.status(403).json({ error: err.message });
			return;
		}
		if (err instanceof groups.GroupUserNotFoundError) {
			res.status(404).json({ error: err.message });
			return;
		}
		if (err instanceof groups.GroupQuotaExceededError) {
			res.status(429).json({ error: err.message });
			return;
		}
		if (err instanceof groups.GroupMembersCapExceededError) {
			res.status(429).json({ error: err.message });
			return;
		}
		if (err instanceof groups.GroupMemberAlreadyExistsError) {
			res.status(409).json({ error: err.message });
			return;
		}
		if (err instanceof groups.GroupCannotRemoveLeadError) {
			res.status(409).json({ error: err.message });
			return;
		}
		logger.error(`[admin] ${context} failed: ${(err as Error).message}`);
		res.status(500).json({ error: "Internal server error" });
	};

	// Shared body validator. Used by POST + PUT. Returns the parsed
	// shape or null + writes a 400 response — caller `return`s when
	// null.
	const validateGroupBody = (
		req: Request,
		res: Response,
	): { name: string; description: string | null; leadUserId: string } | null => {
		const body = req.body as {
			name?: unknown;
			description?: unknown;
			leadUserId?: unknown;
		};
		// Trim-first, then check empty + cap. Mirrors the template route
		// convention (`routes.ts` template handler) and closes two foot-
		// guns the earlier pre-trim shape had:
		//   1. `leadUserId: "   "` slipped past `length === 0`, got
		//      trimmed to "", and `assertUserExists("")` returned a
		//      confusing `404 User  not found` (double-space message).
		//      See #262 round 5 SHOULD-FIX.
		//   2. Length caps fired against the pre-trim string, so
		//      `"a"+" ".repeat(100)` got rejected at 100 chars even
		//      though only 1 char would actually persist — inconsistent
		//      with how the template route handles the same shape.
		if (typeof body.name !== "string") {
			res.status(400).json({ error: "body.name is required (non-empty string)" });
			return null;
		}
		const name = body.name.trim();
		if (name.length === 0) {
			res.status(400).json({ error: "body.name is required (non-empty string)" });
			return null;
		}
		// Cap consistent with other user-controlled strings — same shape
		// as session-name / template-name caps elsewhere in the codebase.
		if (name.length > 100) {
			res.status(400).json({ error: "body.name must be at most 100 characters" });
			return null;
		}
		let description: string | null = null;
		if (body.description !== undefined && body.description !== null) {
			if (typeof body.description !== "string") {
				res.status(400).json({ error: "body.description must be a string, null, or omitted" });
				return null;
			}
			const trimmed = body.description.trim();
			if (trimmed.length > 500) {
				res.status(400).json({ error: "body.description must be at most 500 characters" });
				return null;
			}
			// Collapse whitespace-only to null so a `"   "` payload
			// doesn't render visually blank while the column reports
			// non-null. Same shape as the template description handling.
			description = trimmed || null;
		}
		if (typeof body.leadUserId !== "string") {
			res.status(400).json({ error: "body.leadUserId is required (non-empty string)" });
			return null;
		}
		const leadUserId = body.leadUserId.trim();
		if (leadUserId.length === 0) {
			res.status(400).json({ error: "body.leadUserId is required (non-empty string)" });
			return null;
		}
		// Cap at 128 — UUIDs are 36 chars, this allows headroom for any
		// future ID format. Mirrors the boundary-validation convention
		// for every other user-controlled string in this codebase
		// (name=100, description=500, …). Without this cap, only the
		// 100 KB `express.json` body limit bounds the value; in
		// practice `assertUserExists` 404s immediately on a multi-KB
		// string, but the cap is cheap defence-in-depth. See #262
		// round 6 NIT.
		if (leadUserId.length > USER_ID_MAX_LEN) {
			res
				.status(400)
				.json({ error: `body.leadUserId must be at most ${USER_ID_MAX_LEN} characters` });
			return null;
		}
		return { name, description, leadUserId };
	};

	// Single serializer keeps the wire shape consistent across list / get /
	// create / update. Dates are emitted as ISO strings via toJSON.
	const serializeGroup = (g: groups.Group) => ({
		id: g.id,
		name: g.name,
		description: g.description,
		leadUserId: g.leadUserId,
		createdAt: g.createdAt.toISOString(),
		updatedAt: g.updatedAt.toISOString(),
	});
	const serializeGroupSummary = (g: groups.GroupSummary) => ({
		...serializeGroup(g),
		leadUsername: g.leadUsername,
		memberCount: g.memberCount,
	});

	router.get("/admin/groups", adminStatsIp, requireAdmin, async (_req: Request, res: Response) => {
		try {
			const list = await groups.listAll();
			res.json(list.map(serializeGroupSummary));
		} catch (err) {
			handleGroupError(err, res, "groups list");
		}
	});

	router.get(
		"/admin/groups/:id",
		adminStatsIp,
		requireAdmin,
		async (req: Request, res: Response) => {
			try {
				// Parallelise the two reads so the outer `getById` fires
				// concurrently with `listMembers` (which issues its own
				// internal `getById` for the existence guard + the
				// member query). D1 call count is the same — three —
				// but the wallclock drops from three serial hops to two
				// (the outer getById and listMembers' inner getById
				// finish together, then the member query runs alone).
				// `Promise.all` rejects on the first error so a
				// missing-group still 404s cleanly via the
				// `handleGroupError` catch below. Eliminating the
				// duplicate guard entirely would mean dropping the
				// existence check inside `listMembers`, which the v1
				// API contract relies on (it 404s an unknown groupId
				// instead of silently returning []). See #262 rounds
				// 1 + 4 NITs.
				const [group, members] = await Promise.all([
					groups.getById(req.params.id),
					groups.listMembers(req.params.id),
				]);
				res.json({
					...serializeGroup(group),
					members: members.map((m) => ({
						userId: m.userId,
						username: m.username,
						addedAt: m.addedAt.toISOString(),
					})),
				});
			} catch (err) {
				handleGroupError(err, res, "groups get");
			}
		},
	);

	router.post("/admin/groups", adminActionIp, requireAdmin, async (req: Request, res: Response) => {
		const input = validateGroupBody(req, res);
		if (!input) return;
		try {
			const group = await groups.create(input);
			res.status(201).json(serializeGroup(group));
		} catch (err) {
			handleGroupError(err, res, "groups create");
		}
	});

	router.put(
		"/admin/groups/:id",
		adminActionIp,
		requireAdmin,
		async (req: Request, res: Response) => {
			const input = validateGroupBody(req, res);
			if (!input) return;
			try {
				const group = await groups.update(req.params.id, input);
				res.json(serializeGroup(group));
			} catch (err) {
				handleGroupError(err, res, "groups update");
			}
		},
	);

	router.delete(
		"/admin/groups/:id",
		adminActionIp,
		requireAdmin,
		async (req: Request, res: Response) => {
			try {
				await groups.deleteGroup(req.params.id);
				res.status(204).send();
			} catch (err) {
				handleGroupError(err, res, "groups delete");
			}
		},
	);

	router.post(
		"/admin/groups/:id/members",
		adminActionIp,
		requireAdmin,
		async (req: Request, res: Response) => {
			const body = req.body as { userId?: unknown };
			if (typeof body.userId !== "string" || body.userId.trim().length === 0) {
				res.status(400).json({ error: "body.userId is required (non-empty string)" });
				return;
			}
			// Trim before persistence — a whitespace-padded id slips past
			// the length check above but `assertUserExists` does an exact-
			// string match against `users.id`, so the padded value 404s
			// even when the user genuinely exists. See #262 round 2 NIT.
			const userId = body.userId.trim();
			// Mirror the boundary cap from `validateGroupBody`'s leadUserId
			// — same #262 round 6 NIT rationale. The two caps must stay
			// in lockstep; `USER_ID_MAX_LEN` is the single knob.
			if (userId.length > USER_ID_MAX_LEN) {
				res
					.status(400)
					.json({ error: `body.userId must be at most ${USER_ID_MAX_LEN} characters` });
				return;
			}
			try {
				await groups.addMember(req.params.id, userId);
				res.status(204).send();
			} catch (err) {
				handleGroupError(err, res, "groups addMember");
			}
		},
	);

	router.delete(
		"/admin/groups/:id/members/:userId",
		adminActionIp,
		requireAdmin,
		async (req: Request, res: Response) => {
			try {
				await groups.removeMember(req.params.id, req.params.userId);
				res.status(204).send();
			} catch (err) {
				handleGroupError(err, res, "groups removeMember");
			}
		},
	);

	// ── Lead-side group routes (#201c) ────────────────────────────────────────
	// Two `/groups/mine[/sessions]` reads. `requireAuth` is provided by the
	// `/groups` prefix mount above; no admin gate — a non-lead caller just
	// gets `[]` back (the SQL is user-scoped). Both routes 500 on D1 error
	// rather than degrading silently to an empty list: the lead's "My
	// groups" UI hides the entry-point when /groups/mine returns 0 rows,
	// so silently swallowing a transient would make the UI disappear for
	// the lead instead of surfacing the failure.

	const serializeLeadGroup = (g: groups.LeadGroup) => ({
		...serializeGroup(g),
		members: g.members.map((m) => ({
			userId: m.userId,
			username: m.username,
			addedAt: m.addedAt.toISOString(),
		})),
	});

	// Lead-side session shape. Mirrors `serializeMeta` minus `envVars`
	// and plus `ownerUserId` / `ownerUsername`. The lead's observability
	// surface is intentionally narrower than admin's; the per-session
	// lead GET (the #201 lock-in's redaction path) is a future PR.
	const serializeObservableSession = (s: groups.ObservableSessionMeta) => ({
		sessionId: s.sessionId,
		ownerUserId: s.ownerUserId,
		ownerUsername: s.ownerUsername,
		name: s.name,
		status: s.status,
		// Match `serializeMeta`'s short-id slice so the wire shape is
		// consistent across user / admin / lead views — clients that
		// already render the short id don't need a per-endpoint switch.
		containerId: s.containerId?.slice(0, 12) ?? null,
		containerName: s.containerName,
		cols: s.cols,
		rows: s.rows,
		createdAt: s.createdAt.toISOString(),
		lastConnectedAt: s.lastConnectedAt?.toISOString() ?? null,
	});

	router.get("/groups/mine", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		try {
			const list = await groups.listGroupsLedBy(userId);
			res.json(list.map(serializeLeadGroup));
		} catch (err) {
			logger.error(`[groups] /mine failed: ${(err as Error).message}`);
			res.status(500).json({ error: "Internal server error" });
		}
	});

	router.get("/groups/mine/sessions", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		try {
			const list = await groups.sessionsObservableBy(userId);
			res.json(list.map(serializeObservableSession));
		} catch (err) {
			logger.error(`[groups] /mine/sessions failed: ${(err as Error).message}`);
			res.status(500).json({ error: "Internal server error" });
		}
	});
}
