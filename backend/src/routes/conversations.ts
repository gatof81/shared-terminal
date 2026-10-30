/**
 * routes/conversations.ts — the conversation read surface
 * (docs/CONVERSATION.md §6): the list (3.0b), and the events pages, a
 * single event and the agents of one conversation (3.1). The WS lives in
 * conversation/ws.ts.
 *
 * Owner-only via `assertOwnedByOr404` (design §3.4, decision 6: titles
 * and derived metadata are conversation content, so a foreign session
 * answers like a missing one). An unknown conversation id answers the
 * same 404 as a foreign one. `canSendInput` is pinned to false until 3.2.
 *
 * Reads stream the events file (it can be 64 MiB before rotating), so
 * they hold an `InFlightLimiter` slot — 4 per user, 16 process-wide — until
 * the response has finished, like Files.
 */

import type { Request, Response, Router } from "express";
import type { AuthedRequest } from "../auth.js";
import { requireAuth } from "../auth.js";
import { G5_RESPONSE_BYTES } from "../conversation/limits.js";
import { readOne, readPage } from "../conversation/reader.js";
import type { ConversationService } from "../conversation/service.js";
import { InFlightLimiter } from "../inFlightLimiter.js";
import { NotFoundError } from "../sessionManager.js";
import { holdSlotUntilResponseEnds } from "./files.js";
import { assertOwnedByOr404, handleSessionError, type RouteContext } from "./shared.js";

const READ_IN_FLIGHT_PER_USER = 4;
const READ_IN_FLIGHT_TOTAL = 16;
const PAGE_LIMIT_MAX = 500;
const PAGE_LIMIT_DEFAULT = 200;

/** A non-negative integer query value, or undefined when absent, or NaN when malformed. */
function intParam(v: unknown): number | undefined {
	if (v === undefined) return undefined;
	if (typeof v !== "string" || !/^\d{1,15}$/.test(v)) return Number.NaN;
	return Number(v);
}

export function registerConversationRoutes(router: Router, ctx: RouteContext): void {
	const { sessions, conversation, composer } = ctx;
	const { conversationIp } = ctx.limiters;
	const readSlots = new InFlightLimiter(READ_IN_FLIGHT_PER_USER, READ_IN_FLIGHT_TOTAL);

	/**
	 * 3.2 (§8.1.1, §6): `canSendInput` and the `composer` block, orientative
	 * — no probe, no exec. The owner is the only caller of this route, so
	 * `callerMayOperate` is true; `capture.effective` comes from this request
	 * when it computed it, else from the last one that did.
	 */
	const decorate = async (
		sid: string,
		capture: { effective: boolean } | null,
		summaries: Awaited<ReturnType<ConversationService["summaries"]>>,
	) => {
		if (!composer) return summaries;
		if (capture) composer.noteCapture(sid, capture.effective);
		const av = await composer.availability(
			sid,
			summaries.map((s) => ({ cid: s.sessionId, kind: s.kind, paneId: s.paneId })),
			{
				captureEffective: capture?.effective ?? composer.lastCaptureEffective(sid),
				callerMayOperate: true,
			},
		);
		return summaries.map((s) => ({
			...s,
			...(av.get(s.sessionId) ?? { canSendInput: false, composer: { blocked: false } }),
		}));
	};

	/** Ownership, then the conversation (throws NotFoundError for either). */
	const resolve = async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		await assertOwnedByOr404(sessions, req.params.id, userId);
		res.setHeader("Cache-Control", "no-store");
		const file = conversation
			? await conversation.conversationFile(req.params.id, req.params.cid)
			: null;
		// The same 404 as a foreign or missing session (NotFoundError's body).
		if (!file) throw new NotFoundError();
		return { userId, ...file };
	};
	const takeSlot = (userId: string, res: Response): boolean => {
		const outcome = holdSlotUntilResponseEnds(readSlots, userId, res);
		if (outcome === "busy") {
			res.setHeader("Retry-After", "1");
			res.status(429).json({ error: "Too many conversation reads in progress, try again shortly" });
		}
		return outcome === "held";
	};

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
				// `?capture=0`: the summaries alone. The capture block costs a
				// fresh relay probe of the container (D7, §2.7.6); a client
				// polling the list for status/activity must not pay — nor make
				// the container pay — for it on every tick.
				if (req.query.capture === "0") {
					const summaries = await conversation.summaries(req.params.id);
					res.json({
						capture: null,
						conversations: await decorate(req.params.id, null, summaries),
					});
					return;
				}
				const data = await conversation.list(req.params.id);
				res.json({
					...data,
					conversations: await decorate(req.params.id, data.capture, data.conversations),
				});
			} catch (err) {
				handleSessionError(err, res);
			}
		},
	);

	router.get(
		"/sessions/:id/conversations/:cid/events",
		requireAuth,
		conversationIp,
		async (req: Request, res: Response) => {
			try {
				const before = intParam(req.query.before);
				const limit = intParam(req.query.limit);
				if (Number.isNaN(before) || Number.isNaN(limit) || limit === 0) {
					res.status(400).json({ error: "before and limit must be positive integers" });
					return;
				}
				const c = await resolve(req, res);
				if (!takeSlot(c.userId, res)) return;
				const page = await readPage(c.eventsFile, {
					before: before ?? null,
					limit: Math.min(limit ?? PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX),
					firstRetainedSeq: c.index.firstRetainedSeq,
					maxBytes: G5_RESPONSE_BYTES,
				});
				res.json({ ...page, firstRetainedSeq: c.index.firstRetainedSeq });
			} catch (err) {
				handleSessionError(err, res);
			}
		},
	);

	router.get(
		"/sessions/:id/conversations/:cid/events/:seq",
		requireAuth,
		conversationIp,
		async (req: Request, res: Response) => {
			try {
				const seq = intParam(req.params.seq);
				if (seq === undefined || Number.isNaN(seq)) {
					res.status(400).json({ error: "seq must be a positive integer" });
					return;
				}
				const c = await resolve(req, res);
				if (!takeSlot(c.userId, res)) return;
				const event = await readOne(c.eventsFile, seq, c.index.firstRetainedSeq);
				if (!event) {
					res.status(404).json({ error: "Event not found" });
					return;
				}
				res.json(event);
			} catch (err) {
				handleSessionError(err, res);
			}
		},
	);

	router.get(
		"/sessions/:id/conversations/:cid/agents",
		requireAuth,
		conversationIp,
		async (req: Request, res: Response) => {
			try {
				const c = await resolve(req, res);
				const agents = Object.entries(c.index.agents ?? {}).map(([agentId, a]) => ({
					agentId,
					agentType: a.agentType,
					status: a.status,
					startedSeq: a.startedSeq,
					...(a.endedSeq !== undefined ? { endedSeq: a.endedSeq } : {}),
					toolCount: a.toolCount,
					hasResult: a.hasResult,
				}));
				agents.sort((a, b) => a.startedSeq - b.startedSeq);
				res.json({ agents });
			} catch (err) {
				handleSessionError(err, res);
			}
		},
	);
}
