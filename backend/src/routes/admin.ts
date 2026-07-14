import type { Request, Response, Router } from "express";
import { requireAdmin } from "../auth.js";
import { invalidateStatsCache } from "../containerStats.js";
import { getD1CallsSinceBoot } from "../db.js";
import type { DockerManager } from "../dockerManager.js";
import { DEFAULT_MEMORY_BYTES, DEFAULT_NANO_CPUS } from "../dockerManager.js";
import { logger } from "../logger.js";
import * as observeLog from "../observeLog.js";
import { getDispatcherStats } from "../portDispatcher.js";
import {
	EFFECTIVE_CPU_NANO_MAX,
	EFFECTIVE_CPU_NANO_MIN,
	EFFECTIVE_MEM_BYTES_MAX,
	EFFECTIVE_MEM_BYTES_MIN,
	listResourceCaps,
	ResourceCapsPatchSchema,
	updateResourceLimits,
} from "../sessionConfig.js";
import type { SessionManager } from "../sessionManager.js";
import {
	effectiveSessionAllocation,
	listUsersWithQuotas,
	resolveEffectiveQuotas,
	UserQuotasPatchSchema,
	updateUserQuotas,
} from "../userQuotas.js";
import { type RouteContext, r1, serializeMeta, serializeUsage } from "./shared.js";

export function registerAdminRoutes(router: Router, ctx: RouteContext): void {
	const { sessions, docker, idleSweeper } = ctx;
	const { adminStatsIp, adminActionIp } = ctx.limiters;
	// ── Admin routes (#241) ────────────────────────────────────────────────
	// Cross-user observability for operators. Gated by `requireAdmin`
	// (mirrors the invite-mint pattern from #50). `requireAuth` is
	// provided by `router.use("/admin", requireAuth)` above —
	// `requireAdmin` reads `req.userId` populated there.
	//
	// Counters reported here are in-memory / process-local: this PR
	// surfaces only `sessions.byStatus` (a single GROUP BY against
	// the `sessions` table, no boot-time counter wiring). Subsystem
	// counters (idle sweeper, dispatcher, reconcile, D1 call rate)
	// land in follow-up PRs so each one can ship independently.

	// SHARES `adminStatsIp` (keyed per-IP) with `GET /admin/sessions`
	// — see the comment on that route below + `RateLimitConfig.adminStats`
	// for the budget rationale.
	router.get("/admin/stats", adminStatsIp, requireAdmin, async (_req: Request, res: Response) => {
		try {
			const byStatus = await sessions.countByStatus();
			// `process.uptime()` returns seconds since process start
			// — derive `bootedAt` from that rather than capturing
			// `Date.now()` at module load, so a long-running backend
			// reports the actual boot wallclock even after monotonic
			// clock skew has had time to drift from real time.
			//
			// Round ONCE and reuse the same value for both fields so a
			// client reconstructing `Date.now()` as
			// `new Date(bootedAt).getTime() + uptimeSeconds * 1000`
			// gets the same answer the server sees. Otherwise the
			// rounded `uptimeSeconds` and the float-derived `bootedAt`
			// disagree by up to 500 ms.
			const uptimeSeconds = Math.round(process.uptime());
			const bootedAt = new Date(Date.now() - uptimeSeconds * 1000).toISOString();
			// Subsystem counters added in #241b. All counters are
			// in-memory / process-local; reset on every backend
			// restart. `idleSweeper` is null when the sweeper isn't
			// wired (tests, pre-#194 deployments) — the frontend
			// should treat that as "not available" rather than zero.
			const idleSweeperStats = idleSweeper?.getStats?.() ?? null;
			const reconcileStats = docker.getReconcileStats();
			// #270 — aggregate resource usage across running sessions.
			// `gatherStats` shares its TTL cache with `/admin/sessions`,
			// so the dashboard's parallel fetch only hits the daemon
			// once per container per ~2s — see containerStats.ts. We
			// scope this to `status === "running"` and require a
			// containerId; reconcile-pending or stopped rows have no
			// live process to sample. The `limits` block hands the
			// frontend the same EFFECTIVE_*_MAX / *_MIN constants the
			// PATCH route validates against, so the "Edit caps" form
			// can render with discoverable min/max attributes without
			// hard-coding values.
			const resourceSnapshot = await collectResourceSnapshot(sessions, docker);
			res.json({
				bootedAt,
				uptimeSeconds,
				sessions: { byStatus },
				idleSweeper: idleSweeperStats,
				reconcile: reconcileStats,
				dispatcher: getDispatcherStats(),
				d1: { callsSinceBoot: getD1CallsSinceBoot() },
				resources: resourceSnapshot,
			});
		} catch (err) {
			logger.error(`[admin] stats failed: ${(err as Error).message}`);
			res.status(500).json({ error: "Internal server error" });
		}
	});

	// Cross-user sessions list for the admin dashboard (#241d). Returns
	// every session row across every user (capped at ADMIN_LIST_LIMIT),
	// paired with the owner's username. Reads-only — destructive actions
	// live on the /admin/sessions/:id endpoints below.
	//
	// SHARES `adminStatsIp` (keyed per-IP, not per-admin) with
	// `GET /admin/stats` — see the comment on `RateLimitConfig.adminStats`
	// for the budget rationale. A dashboard polling both pairs of
	// endpoints drains the bucket 2× faster than a single endpoint
	// would, which is why the default is sized for the pair, not the
	// individual route. Per-IP keying means two admins behind the same
	// NAT/office IP share the bucket — same tradeoff every other IP
	// limiter in the app makes.
	router.get(
		"/admin/sessions",
		adminStatsIp,
		requireAdmin,
		async (_req: Request, res: Response) => {
			try {
				const list = await sessions.listAll();
				// #270 — extra fields per row: configured caps from
				// session_configs (NULL → uses spawn default) and live
				// usage from `docker stats` for running rows. Batched
				// in two parallel calls so non-running rows don't pay
				// for the stats fetch and we issue exactly one D1 hit
				// for ALL caps (no N+1). gatherStats returns null per
				// row whose stats fetch failed; the wire shape exposes
				// that as `usage: null` and the UI renders "—".
				const ids = list.map((row) => row.sessionId);
				const running = list.filter((row) => row.status === "running");
				const [caps, stats] = await Promise.all([
					listResourceCaps(ids),
					docker.gatherStats(
						running.map((row) => ({
							sessionId: row.sessionId,
							containerId: row.containerId,
						})),
					),
				]);
				res.json(
					list.map((row) => {
						const sCaps = caps.get(row.sessionId);
						const usage = serializeUsage(stats.get(row.sessionId));
						return {
							...serializeMeta(row),
							userId: row.userId,
							ownerUsername: row.ownerUsername,
							cpuLimit: sCaps?.cpuLimit ?? null,
							memLimit: sCaps?.memLimit ?? null,
							usage,
						};
					}),
				);
			} catch (err) {
				logger.error(`[admin] sessions list failed: ${(err as Error).message}`);
				res.status(500).json({ error: "Internal server error" });
			}
		},
	);

	// PATCH /admin/sessions/:id/resources (#270) — live-edit CPU/RAM caps.
	// Persists the new values to `session_configs` AND applies them on
	// the running container via `docker update`. Same auth gate as the
	// other admin actions (`requireAdmin` + `adminActionIp`).
	router.patch(
		"/admin/sessions/:id/resources",
		adminActionIp,
		requireAdmin,
		async (req: Request, res: Response) => {
			// Parse + validate first — fast 400 path doesn't touch D1 or
			// docker. `safeParse` instead of `parse`+try/catch so we
			// don't allocate a ZodError just to read its first issue.
			// Strict schema (set in ResourceCapsPatchSchema): unknown
			// keys 400 rather than being silently dropped.
			const parsed = ResourceCapsPatchSchema.safeParse(req.body);
			if (!parsed.success) {
				// Match the create-time pattern in validateSessionConfig:
				// surface only the first issue (paths included so the
				// client knows which field is wrong).
				const issue = parsed.error.issues[0]!;
				const path = issue.path.map(String).join(".");
				res.status(400).json({ error: path ? `${path}: ${issue.message}` : issue.message });
				return;
			}
			const patch = parsed.data;
			if (patch.cpuLimit === undefined && patch.memLimit === undefined) {
				res.status(400).json({ error: "At least one of cpuLimit or memLimit must be provided" });
				return;
			}
			try {
				const meta = await sessions.get(req.params.id);
				if (!meta) {
					res.status(404).json({ error: "Session not found" });
					return;
				}
				// Persist first. If the docker call below fails, the row
				// is already updated — the next session start will pick
				// up the new caps regardless. Apply-then-persist would
				// leave the daemon holding caps that disagree with the
				// source of truth, which is the worse rollback shape.
				await updateResourceLimits(req.params.id, patch);
				// Only push to the daemon when the container is running
				// AND we have its id. A stopped session's session_configs
				// row is enough; `docker update` against a non-running
				// container errors out with "container not running".
				if (meta.status === "running" && meta.containerId !== null) {
					try {
						await docker.updateResources(meta.containerId, patch);
						// Force-evict the stats cache so the next dashboard
						// refresh re-samples against the new cgroup limit
						// — the usage numerator may be unchanged but the
						// memLimitBytes denominator just shifted.
						invalidateStatsCache(meta.containerId);
					} catch (err) {
						// Docker rejects a Memory drop below current usage
						// with several substring shapes across versions /
						// cgroup modes; we match the narrow set the
						// daemon's update_linux.go actually emits rather
						// than fuzzy patterns like "Out of memory" that
						// could collide with unrelated allocator errors.
						// Hit any of these → 409 ("conflict with current
						// state") with a clear "free memory first" hint.
						// Everything else falls through to 500 + log.
						//   - cgroup-v1 daemon: "Minimum memory limit can
						//     not be less than memory reservation limit"
						//   - newer daemons:    "lower than current memory"
						//   - cgroup-v2 memcg:  "memory limit too low"
						const message = (err as Error).message ?? "";
						const cgroupReject =
							/lower than current memory|less than (memory )?reservation|Minimum memory limit|memory limit too low/i.test(
								message,
							);
						if (cgroupReject) {
							res.status(409).json({
								error:
									"Cannot lower memory cap below current usage. Free memory inside the session first, then retry.",
							});
							return;
						}
						logger.error(`[admin] docker update failed for session ${req.params.id}: ${message}`);
						res.status(500).json({ error: "Failed to apply caps to running container" });
						return;
					}
				}
				res.status(204).send();
			} catch (err) {
				logger.error(`[admin] resource-caps update failed: ${(err as Error).message}`);
				res.status(500).json({ error: "Internal server error" });
			}
		},
	);

	// Admin force-stop: same code path as `POST /sessions/:id/stop`
	// minus the `assertOwnedBy` gate. `idleSweeper.forget` is called so
	// the swept session doesn't sit in the activity map collecting
	// stale bumps from a future race (e.g. the owner reconnects between
	// stop and the next `/start`). 204 on success, 500 on docker error.
	//
	// Response shape DIVERGES from the user-facing route: the user
	// path re-reads and returns the updated SessionMeta so the
	// caller can update its UI without a second fetch; the admin
	// path returns 204 because the admin dashboard (#241e) always
	// re-fetches the full session list after an action (operators
	// see all sessions, not just the one they touched). Saves a D1
	// round-trip per action.
	router.post(
		"/admin/sessions/:id/stop",
		adminActionIp,
		requireAdmin,
		async (req: Request, res: Response) => {
			try {
				// `get` first so a non-existent id returns 404 rather than
				// surfacing a Docker "no such container" deep in
				// stopContainer. Same shape the user path uses, just
				// without ownership gating.
				const meta = await sessions.get(req.params.id);
				if (!meta) {
					res.status(404).json({ error: "Session not found" });
					return;
				}
				await docker.stopContainer(req.params.id);
				idleSweeper?.forget(req.params.id);
				res.status(204).send();
			} catch (err) {
				logger.error(`[admin] force-stop failed: ${(err as Error).message}`);
				res.status(500).json({ error: "Internal server error" });
			}
		},
	);

	// Admin force-delete: mirrors the user-facing `DELETE /sessions/:id`
	// minus `assertOwnedBy`. `?hard=true` purges workspace files and
	// drops the D1 row; default is soft-delete (container killed, row
	// flips to terminated, workspace preserved). The owner can still
	// restore a soft-deleted session via `POST /sessions/:id/start` —
	// admin force-delete is the same operation the owner could have
	// done themselves, not a stronger semantic.
	router.delete(
		"/admin/sessions/:id",
		adminActionIp,
		requireAdmin,
		async (req: Request, res: Response) => {
			const hard = req.query.hard === "true" || req.query.hard === "1";
			try {
				const meta = await sessions.get(req.params.id);
				if (!meta) {
					res.status(404).json({ error: "Session not found" });
					return;
				}
				// Idempotent soft branch — only kill + terminate if not
				// already torn down.
				if (meta.status !== "terminated") {
					await docker.kill(req.params.id);
					await sessions.terminate(req.params.id);
					idleSweeper?.forget(req.params.id);
				}
				if (hard) {
					try {
						await docker.purgeWorkspace(req.params.id);
					} catch (err) {
						logger.error(
							`[admin] force-delete purgeWorkspace failed for ${req.params.id}: ${(err as Error).message}`,
						);
						// Fall through — the D1 row removal still happens.
					}
					await sessions.deleteRow(req.params.id);
					idleSweeper?.forget(req.params.id);
				}
				res.status(204).send();
			} catch (err) {
				logger.error(`[admin] force-delete failed: ${(err as Error).message}`);
				res.status(500).json({ error: "Internal server error" });
			}
		},
	);

	// ── Admin observe-log (#201d) ────────────────────────────────────────────
	// Cross-user view of "who watched whose session, when." Uses the
	// `adminStatsIp` limiter — same bucket dashboards poll for sessions
	// + stats; the budget assumes one operator dashboard polls multiple
	// admin reads at once.

	const serializeAdminObserveLogEntry = (e: observeLog.AdminObserveLogEntry) => ({
		id: e.id,
		observerUserId: e.observerUserId,
		observerUsername: e.observerUsername,
		sessionId: e.sessionId,
		ownerUserId: e.ownerUserId,
		ownerUsername: e.ownerUsername,
		startedAt: e.startedAt.toISOString(),
		endedAt: e.endedAt?.toISOString() ?? null,
	});

	router.get(
		"/admin/observe-log",
		adminStatsIp,
		requireAdmin,
		async (_req: Request, res: Response) => {
			try {
				const list = await observeLog.listAll();
				res.json(list.map(serializeAdminObserveLogEntry));
			} catch (err) {
				logger.error(`[admin] observe-log list failed: ${(err as Error).message}`);
				res.status(500).json({ error: "Internal server error" });
			}
		},
	);

	// ── Per-user quotas (#202) ───────────────────────────────────────────────

	// GET /admin/users — the users panel's data source: raw overrides
	// (null = deployment default), the resolved effective quotas, and
	// current usage so the operator can see headroom at a glance. Three
	// D1 reads total regardless of user count (users list + cross-user
	// session list + one batched caps read) — same no-N+1 posture as
	// the admin sessions list.
	router.get("/admin/users", adminStatsIp, requireAdmin, async (_req: Request, res: Response) => {
		try {
			const [users, allSessions] = await Promise.all([listUsersWithQuotas(), sessions.listAll()]);
			const runningIds = allSessions.filter((s) => s.status === "running").map((s) => s.sessionId);
			const caps = runningIds.length > 0 ? await listResourceCaps(runningIds) : new Map();
			const byUser = new Map<
				string,
				{ active: number; running: number; cpuNanos: number; memBytes: number }
			>();
			for (const s of allSessions) {
				const agg = byUser.get(s.userId) ?? { active: 0, running: 0, cpuNanos: 0, memBytes: 0 };
				// `active` mirrors the create-time INSERT guard's predicate
				// (terminated/failed don't hold a slot); the budget axes
				// count RUNNING sessions only, like the create-time check.
				if (s.status !== "terminated" && s.status !== "failed") agg.active++;
				if (s.status === "running") {
					const alloc = effectiveSessionAllocation(
						caps.get(s.sessionId) ?? { cpuLimit: null, memLimit: null },
					);
					agg.running++;
					agg.cpuNanos += alloc.cpuNanos;
					agg.memBytes += alloc.memBytes;
				}
				byUser.set(s.userId, agg);
			}
			res.json(
				users.map((u) => {
					const quotas = {
						max_sessions: u.max_sessions,
						max_total_cpu: u.max_total_cpu,
						max_total_mem: u.max_total_mem,
					};
					const effective = resolveEffectiveQuotas(quotas);
					const usage = byUser.get(u.id) ?? { active: 0, running: 0, cpuNanos: 0, memBytes: 0 };
					return {
						userId: u.id,
						username: u.username,
						isAdmin: u.is_admin === 1,
						createdAt: u.created_at,
						quotas: {
							maxSessions: u.max_sessions,
							maxTotalCpu: u.max_total_cpu,
							maxTotalMem: u.max_total_mem,
						},
						effective: {
							maxSessions: effective.maxSessions,
							maxTotalCpu: effective.maxTotalCpuNanos,
							maxTotalMem: effective.maxTotalMemBytes,
						},
						usage: {
							activeSessions: usage.active,
							runningSessions: usage.running,
							cpuNanos: usage.cpuNanos,
							memBytes: usage.memBytes,
						},
					};
				}),
			);
		} catch (err) {
			logger.error(`[admin] users list failed: ${(err as Error).message}`);
			res.status(500).json({ error: "Internal server error" });
		}
	});

	// PATCH /admin/users/:id/quotas — mirrors PATCH /admin/sessions/:id/
	// resources: at least one field, bounds enforced by the schema,
	// `null` clears the override back to the deployment default. Pure
	// D1 write — quotas are evaluated at create time, so there is no
	// running container to poke. 204 because the dashboard re-fetches
	// the users list after every action anyway.
	router.patch(
		"/admin/users/:id/quotas",
		adminActionIp,
		requireAdmin,
		async (req: Request, res: Response) => {
			try {
				const parsed = UserQuotasPatchSchema.safeParse(req.body);
				if (!parsed.success) {
					res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
					return;
				}
				const patch = parsed.data;
				if (
					patch.maxSessions === undefined &&
					patch.maxTotalCpu === undefined &&
					patch.maxTotalMem === undefined
				) {
					res.status(400).json({
						error: "at least one of maxSessions / maxTotalCpu / maxTotalMem is required",
					});
					return;
				}
				const updated = await updateUserQuotas(req.params.id, patch);
				if (!updated) {
					res.status(404).json({ error: "User not found" });
					return;
				}
				res.status(204).send();
			} catch (err) {
				logger.error(`[admin] user quotas patch failed: ${(err as Error).message}`);
				res.status(500).json({ error: "Internal server error" });
			}
		},
	);
}

// ── Admin resource-snapshot helper (#270) ──────────────────────────────────

interface ResourceSnapshot {
	runningCount: number;
	statsAvailable: number;
	totalCpuPercent: number;
	totalMemBytes: number;
	totalCpuLimitNanos: number;
	totalMemLimitBytes: number;
	limits: {
		minCpuNanos: number;
		maxCpuNanos: number;
		minMemBytes: number;
		maxMemBytes: number;
		defaultCpuNanos: number;
		defaultMemBytes: number;
	};
}

/**
 * Build the `resources` block for `GET /admin/stats`. Pulled into a
 * helper because the wire shape lives at two layers (here and the
 * `/admin/sessions` list, which reuses the same stats fetch) and the
 * route handler should not balloon.
 *
 * Two D1 hits per call: `listAll` + `listResourceCaps` (batched, so
 * no N+1 over the cap reads). `GET /admin/sessions` fires its own
 * `listAll` in parallel on the same dashboard refresh — the two are
 * NOT deduplicated, which is fine at v1 scale but a future "share
 * the snapshot across the two endpoints" optimisation is possible.
 * The `gatherStats` TTL cache reduces Docker-stats round-trips but
 * does not deduplicate D1 reads.
 *
 * Failure modes (snapshot-wide):
 *  - `listAll`/`listResourceCaps` errors bubble to the caller's
 *    try/catch and surface as 500.
 *  - Per-container stats failures collapse to `null` and DO NOT
 *    propagate — admins see "X of Y reported" rather than a wedged
 *    dashboard.
 */
async function collectResourceSnapshot(
	sessions: SessionManager,
	docker: DockerManager,
): Promise<ResourceSnapshot> {
	const all = await sessions.listAll();
	const running = all.filter((s) => s.status === "running");
	// `caps` (D1 read) and `stats` (Docker socket call) are both
	// derived from `running` but independent of each other — fire
	// them in parallel. The stats leg is the dominant cost on hosts
	// with many running sessions (each container's 3 s timeout inside
	// gatherStats sums up); overlapping the cap read shaves the D1
	// hop off the wall-clock for the dashboard's stats panel.
	const [caps, stats] = await Promise.all([
		listResourceCaps(running.map((s) => s.sessionId)),
		docker.gatherStats(
			running.map((s) => ({ sessionId: s.sessionId, containerId: s.containerId })),
		),
	]);
	let totalCpuPercent = 0;
	let totalMemBytes = 0;
	let totalCpuLimitNanos = 0;
	let totalMemLimitBytes = 0;
	let statsAvailable = 0;
	for (const s of running) {
		const sCaps = caps.get(s.sessionId);
		// Effective cap = configured value when set, else the spawn
		// default. We sum effective caps (not the raw NULL row's
		// undefined) because the question the totals card answers is
		// "how much have we allocated", which is what Docker actually
		// wrote to cgroup — NULL means "spawn default", not zero.
		totalCpuLimitNanos += sCaps?.cpuLimit ?? DEFAULT_NANO_CPUS;
		totalMemLimitBytes += sCaps?.memLimit ?? DEFAULT_MEMORY_BYTES;
		const live = stats.get(s.sessionId);
		if (live !== null && live !== undefined) {
			statsAvailable += 1;
			totalCpuPercent += live.cpuPercent;
			totalMemBytes += live.memBytes;
		}
	}
	return {
		runningCount: running.length,
		statsAvailable,
		totalCpuPercent: r1(totalCpuPercent),
		totalMemBytes,
		totalCpuLimitNanos,
		totalMemLimitBytes,
		limits: {
			minCpuNanos: EFFECTIVE_CPU_NANO_MIN,
			maxCpuNanos: EFFECTIVE_CPU_NANO_MAX,
			minMemBytes: EFFECTIVE_MEM_BYTES_MIN,
			maxMemBytes: EFFECTIVE_MEM_BYTES_MAX,
			defaultCpuNanos: DEFAULT_NANO_CPUS,
			defaultMemBytes: DEFAULT_MEMORY_BYTES,
		},
	};
}
