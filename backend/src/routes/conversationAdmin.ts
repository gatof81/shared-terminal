/**
 * routes/conversationAdmin.ts — the 3.0d admin surface (CONVERSATION.md §7):
 *
 *   PATCH /admin/sessions/:id/conversation {enabled}   §2.4 rows, §2.7.5
 *   GET   /admin/sessions/:id/recreate[?preserveLayer=1] preflight, no effects
 *   POST  /admin/sessions/:id/recreate {expectImageId, preserveLayer?} §2.7.2–§2.7.4, §2.7.7
 *   POST  /admin/sessions/:id/recreate/approve          remove the retained container (§2.7.7)
 *   POST  /admin/sessions/:id/recreate/rollback         back to the retained O (§2.7.7)
 *   POST  /admin/sessions/:id/recreate/recover          operator D8 recovery (§2.7.7)
 *
 * The routes only translate HTTP: the §2.4 rows live in `ConversationService`
 * (`enable`/`disable`), the recreation in `RecreationEngine`, and both own
 * their own locking — the session lifecycle lock and the
 * `recreate-unresolved` gate for enable and recreate; never for disable,
 * which always works (§2.4, K1). Error bodies are `{ error: <code> }` with
 * the contract's codes. `requireAuth` comes from the `/admin` prefix.
 */

import type { Request, Response, Router } from "express";
import type { AuthedRequest } from "../auth.js";
import { requireAdmin } from "../auth.js";
import {
	ConversationDisabledError,
	RevokedGloballyError,
	RevokedMeanwhileError,
} from "../conversation/activation.js";
import { logger } from "../logger.js";
import * as observeLog from "../observeLog.js";
import { RecreateUnresolvedError } from "../recreateAttempt.js";
import { SessionBusyError, sessionLifecycleLock } from "../sessionLifecycleLock.js";
import type { RouteContext } from "./shared.js";

/** `expectImageId` is the immutable image ID the preflight showed (D6). */
const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;

/** The cross-user audit row could not be written: nothing was done (fail-closed). */
class OperateAuditError extends Error {
	constructor(cause: Error) {
		super(`operate audit insert failed: ${cause.message}`);
		this.name = "OperateAuditError";
	}
}

export function registerConversationAdminRoutes(router: Router, ctx: RouteContext): void {
	const { sessions, conversation, recreation } = ctx;
	const { adminStatsIp, adminActionIp } = ctx.limiters;

	router.patch(
		"/admin/sessions/:id/conversation",
		adminActionIp,
		requireAdmin,
		async (req: Request, res: Response) => {
			const { userId } = req as AuthedRequest;
			const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
			if (typeof enabled !== "boolean") {
				res.status(400).json({ error: "enabled must be a boolean" });
				return;
			}
			if (!conversation) {
				res.status(503).json({ error: "conversation-unavailable" });
				return;
			}
			const sessionId = req.params.id;
			try {
				if (!(await sessions.get(sessionId))) {
					res.status(404).json({ error: "Session not found" });
					return;
				}
				res.setHeader("Cache-Control", "no-store");
				if (enabled) {
					// Under the session's lifecycle lock (#464 R1), like start /
					// stop / delete / recreate: the writes of the §2.7.5 procedure
					// never interleave with an operation that removes or replaces
					// the session's container or files. Existence and authorization
					// are read again once the lock is held — `enable` reads its own
					// facts there, and a delete that held the lock may have removed
					// the session meanwhile. The lock's guard refuses an unresolved
					// recreation (`recreate-unresolved`).
					const r = await sessionLifecycleLock.run(sessionId, "enable", async () => {
						if (!(await sessions.get(sessionId))) return null;
						return conversation.enable(sessionId);
					});
					if (!r) {
						res.status(404).json({ error: "Session not found" });
						return;
					}
					logger.info(
						`[admin] conversation enabled: session=${sessionId} caller=${userId} ` +
							`effective=${r.capture.effective}`,
					);
					res.json(r);
					return;
				}
				// Never behind the lock: disabling always works (§2.4, K1).
				// marker → D1 → hooks file → relay.enabled (§2.5); the receiver
				// refuses from the marker on, before this answers.
				const r = await conversation.disable(sessionId);
				logger.info(`[admin] conversation disabled: session=${sessionId} caller=${userId}`);
				// The disable is done: a failure READING the state afterwards must
				// not turn it into a 500 the caller would take for "not disabled".
				let capture: Awaited<ReturnType<typeof conversation.authority.capture>> | null = null;
				try {
					capture = await conversation.authority.capture(sessionId);
				} catch (err) {
					logger.warn(
						`[admin] capture read after disable failed for ${sessionId}: ${(err as Error).message}`,
					);
				}
				res.json({ ...r, capture });
			} catch (err) {
				if (err instanceof ConversationDisabledError) {
					res.status(409).json({ error: "flag-off" });
					return;
				}
				if (err instanceof RevokedMeanwhileError) {
					// A disable or the emergency CLI landed while enabling: it won
					// (3.0d audit A1).
					res.status(409).json({ error: "revoked" });
					return;
				}
				if (err instanceof RevokedGloballyError) {
					// CONVERSATION.md §2.5: the global marker's own code.
					res.status(409).json({ error: "revoked-globally" });
					return;
				}
				if (err instanceof SessionBusyError) {
					res.status(409).json({ error: "busy" });
					return;
				}
				if (err instanceof RecreateUnresolvedError) {
					res.status(409).json({ error: "recreate-unresolved" });
					return;
				}
				logger.error(
					`[admin] conversation ${enabled ? "enable" : "disable"} failed for ${sessionId}: ` +
						`${(err as Error).message}`,
				);
				res.status(500).json({ error: "Internal server error" });
			}
		},
	);

	// Preflight: the same evaluation as the POST, every precondition, no
	// effects (§2.7.2). A read, so it shares the dashboard's read budget.
	router.get(
		"/admin/sessions/:id/recreate",
		adminStatsIp,
		requireAdmin,
		async (req: Request, res: Response) => {
			if (!recreation) {
				res.status(503).json({ error: "recreation-unavailable" });
				return;
			}
			try {
				const preserve = req.query.preserveLayer === "1" || req.query.preserveLayer === "true";
				const r = await recreation.preflight(req.params.id, { preserve });
				if ("status" in r) {
					if (r.status === 404) res.status(404).json({ error: "Session not found" });
					else res.status(503).json({ error: "docker-unavailable" });
					return;
				}
				res.setHeader("Cache-Control", "no-store");
				res.json(r);
			} catch (err) {
				logger.error(`[admin] recreate preflight failed: ${(err as Error).message}`);
				res.status(500).json({ error: "Internal server error" });
			}
		},
	);

	router.post(
		"/admin/sessions/:id/recreate",
		adminActionIp,
		requireAdmin,
		async (req: Request, res: Response) => {
			const { userId } = req as AuthedRequest;
			const body = (req.body ?? {}) as { expectImageId?: unknown; preserveLayer?: unknown };
			const expectImageId = body.expectImageId;
			if (typeof expectImageId !== "string" || !IMAGE_ID_RE.test(expectImageId)) {
				res
					.status(400)
					.json({ error: "expectImageId must be the image ID from the preflight (sha256:…)" });
				return;
			}
			if (body.preserveLayer !== undefined && typeof body.preserveLayer !== "boolean") {
				res.status(400).json({ error: "preserveLayer must be a boolean" });
				return;
			}
			const preserve = body.preserveLayer === true;
			if (!recreation) {
				res.status(503).json({ error: "recreation-unavailable" });
				return;
			}
			const sessionId = req.params.id;
			let auditId: string | null = null;
			try {
				const meta = await sessions.get(sessionId);
				if (!meta) {
					res.status(404).json({ error: "Session not found" });
					return;
				}
				const ownerId = meta.userId;
				const r = await recreation.recreate(sessionId, expectImageId, {
					preserve,
					// §2.7.2: with a foreign owner, the `operate` row goes BEFORE
					// any effect and is fail-closed, as the start of #429. The
					// engine calls this under the lock once every precondition
					// passed, so a refused request (409) leaves no row.
					beforeEffects:
						ownerId === userId
							? undefined
							: async () => {
									try {
										auditId = await observeLog.recordObserveStart(
											userId,
											sessionId,
											ownerId,
											"operate",
										);
									} catch (err) {
										throw new OperateAuditError(err as Error);
									}
									logger.info(
										`[admin] operate recreate logged: caller=${userId} session=${sessionId} ` +
											`owner=${ownerId} log=${auditId}`,
									);
								},
				});
				if (r.ok) {
					const { ok: _ok, ...body } = r;
					logger.info(
						`[admin] recreate committed: session=${sessionId} caller=${userId}` +
							(preserve ? " (carry-over)" : "") +
							(r.unresolved ? ` (unresolved: ${(r.pending ?? []).join(", ")})` : ""),
					);
					res.json(body);
					return;
				}
				const { ok: _ok, status, code, ...rest } = r;
				if (status === 404) {
					res.status(404).json({ error: "Session not found" });
					return;
				}
				if (status === 500) {
					logger.error(
						`[admin] recreate failed: session=${sessionId} caller=${userId} ${JSON.stringify(rest)}`,
					);
				}
				res.status(status).json({ error: code, ...rest });
			} catch (err) {
				if (err instanceof OperateAuditError) {
					logger.error(
						`[admin] ${err.message}; recreate aborted before any effect ` +
							`(caller=${userId} session=${sessionId})`,
					);
				} else {
					logger.error(`[admin] recreate threw for ${sessionId}: ${(err as Error).message}`);
				}
				res.status(500).json({ error: "Internal server error" });
			} finally {
				// The row spans the recreation (like the exec span of #416).
				// Its end is best effort: a D1 transient on close must not turn
				// a done recreation into an error.
				if (auditId) {
					const id = auditId;
					observeLog.recordObserveEnd(id).catch((err) => {
						logger.warn(
							`[admin] operate recreate audit end failed: ${(err as Error).message} (log=${id})`,
						);
					});
				}
			}
		},
	);

	// ── §2.7.7: approve / rollback / recover ──────────────────────────────
	// Each is one engine call under the session's lock. A foreign owner gets
	// a point-in-time `operate` row BEFORE the call, fail-closed (as #429's
	// start): these verbs remove a container, move D1 back to the retained
	// one, or resolve an orphaned attempt — the audit is the mitigation for
	// widening admin power by them. The engine's 404/409/5xx translate 1:1;
	// `code` is the error, extra fields (`detail`) ride along.
	for (const verb of ["approve", "rollback", "recover"] as const) {
		router.post(
			`/admin/sessions/:id/recreate/${verb}`,
			adminActionIp,
			requireAdmin,
			async (req: Request, res: Response) => {
				const { userId } = req as AuthedRequest;
				if (!recreation) {
					res.status(503).json({ error: "recreation-unavailable" });
					return;
				}
				const sessionId = req.params.id;
				try {
					const meta = await sessions.get(sessionId);
					if (!meta) {
						res.status(404).json({ error: "Session not found" });
						return;
					}
					if (meta.userId !== userId) {
						let logId: string;
						try {
							logId = await observeLog.recordObserveStart(
								userId,
								sessionId,
								meta.userId,
								"operate",
							);
						} catch (err) {
							logger.error(
								`[admin] operate recreate/${verb} audit insert failed, aborting: ${(err as Error).message} ` +
									`(caller=${userId} session=${sessionId})`,
							);
							res.status(500).json({ error: "Internal server error" });
							return;
						}
						observeLog.recordObserveEnd(logId).catch((err) => {
							logger.warn(
								`[admin] operate recreate/${verb} audit end failed: ${(err as Error).message} (log=${logId})`,
							);
						});
						logger.info(
							`[admin] operate recreate/${verb} logged: caller=${userId} session=${sessionId} owner=${meta.userId} log=${logId}`,
						);
					}
					const r =
						verb === "approve"
							? await recreation.approve(sessionId)
							: verb === "rollback"
								? await recreation.rollbackToRetained(sessionId)
								: await recreation.recover(sessionId);
					res.setHeader("Cache-Control", "no-store");
					if (r.ok) {
						logger.info(`[admin] recreate/${verb} done: session=${sessionId} caller=${userId}`);
						res.status(r.status).json(r.body);
						return;
					}
					const { ok: _ok, status, code, ...rest } = r;
					if (status >= 500) {
						logger.error(
							`[admin] recreate/${verb} failed: session=${sessionId} caller=${userId} ${code} ${JSON.stringify(rest)}`,
						);
					}
					res.status(status).json({ error: code, ...rest });
				} catch (err) {
					logger.error(
						`[admin] recreate/${verb} threw for ${sessionId}: ${(err as Error).message}`,
					);
					res.status(500).json({ error: "Internal server error" });
				}
			},
		);
	}
}
