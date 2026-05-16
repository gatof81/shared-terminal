/**
 * routes.ts — REST API routes.
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import multer from "multer";
import type { AuthedRequest } from "./auth.js";
import {
	AUTH_COOKIE_NAME,
	clearAuthCookie,
	createInvite,
	extractTokenFromCookieHeader,
	hasAnyUsers,
	InvalidCredentialsError,
	InviteQuotaExceededError,
	InviteRequiredError,
	listInvites,
	loginUser,
	registerUser,
	requireAdmin,
	requireAuth,
	revokeInvite,
	setAuthCookie,
	UsernameTakenError,
	verifyJwt,
} from "./auth.js";
import { type BootstrapBroadcaster, runAsyncBootstrap } from "./bootstrap.js";
import { invalidateStatsCache, type StatsBySession } from "./containerStats.js";
import { d1Query, getD1CallsSinceBoot } from "./db.js";
import type { DockerManager } from "./dockerManager.js";
import {
	DEFAULT_MEMORY_BYTES,
	DEFAULT_NANO_CPUS,
	UploadQuotaExceededError,
} from "./dockerManager.js";
import { EnvVarValidationError, validateEnvVars } from "./envVarValidation.js";
import * as groups from "./groups.js";
import type { IdleSweeperStats } from "./idleSweeper.js";
import { logger } from "./logger.js";
import * as observeLog from "./observeLog.js";
import { getDispatcherStats } from "./portDispatcher.js";
import type { RateLimitConfig } from "./rateLimit.js";
import {
	createAuthRateLimiters,
	DEFAULT_RATE_LIMIT_CONFIG,
	UsernameRateLimiter,
} from "./rateLimit.js";
import {
	EFFECTIVE_CPU_NANO_MAX,
	EFFECTIVE_CPU_NANO_MIN,
	EFFECTIVE_MEM_BYTES_MAX,
	EFFECTIVE_MEM_BYTES_MIN,
	encryptAuthCredentials,
	encryptSecretEntries,
	isEmptyConfig,
	listResourceCaps,
	type PersistableSessionConfig,
	persistSessionConfig,
	ResourceCapsPatchSchema,
	type SessionConfig,
	SessionConfigValidationError,
	updateResourceLimits,
	validateSessionConfig,
} from "./sessionConfig.js";
import type { SessionManager } from "./sessionManager.js";
import { ForbiddenError, NotFoundError, SessionQuotaExceededError } from "./sessionManager.js";
import * as templates from "./templates.js";
import type { SessionMeta } from "./types.js";

export function buildRouter(
	sessions: SessionManager,
	docker: DockerManager,
	broadcaster: BootstrapBroadcaster,
	rateLimitConfig: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,
	// Optional so existing tests that build a router without a sweeper
	// keep working. Production wires the singleton from index.ts; the
	// absent-sweeper case is the pre-#194 behaviour. `bump` is the hot
	// path (every authed /sessions/:id hit); `forget` runs on stop /
	// kill / hard-delete so the activity Map doesn't grow unboundedly
	// across the backend's lifetime.
	idleSweeper?: {
		bump: (sessionId: string) => void;
		forget: (sessionId: string) => void;
		// `getStats` is optional so the test scaffold can build a
		// stripped-down stub without wiring all three methods. Real
		// production paths from index.ts always pass the full
		// IdleSweeper instance. Imported from the source module so a
		// future field added to `IdleSweeperStats` propagates here
		// without a paired edit.
		getStats?: () => IdleSweeperStats;
	},
): Router {
	const router = Router();

	// ── Auth routes (public) ────────────────────────────────────────────────

	const {
		loginIp,
		registerIp,
		invitesCreateIp,
		invitesListIp,
		invitesRevokeIp,
		fileUploadIp,
		logoutIp,
		authStatusIp,
		adminStatsIp,
		adminActionIp,
	} = createAuthRateLimiters(rateLimitConfig);
	const usernameLimiter = new UsernameRateLimiter(
		rateLimitConfig.login.usernameMax,
		rateLimitConfig.login.usernameWindowMs,
	);
	// Cap username length at the request boundary so huge strings can't
	// land in the limiter map or D1.
	const USERNAME_MAX_LEN = 64;

	// Public-by-design (the frontend uses it to decide between login and
	// app on first load, since the auth cookie is httpOnly), but it runs
	// hasAnyUsers() on every call plus a users SELECT for the admin
	// lookup if a cookie is present. Without authStatusIp, an attacker
	// IP could spam this to amplify D1 cost or push the account toward
	// Cloudflare's per-database query throttle. Sized permissively at
	// 60/min so legit UI cadence (one call on page load, occasional
	// re-checks) never trips it. See #148.
	router.get("/auth/status", authStatusIp, async (req: Request, res: Response) => {
		// `authenticated` lets the frontend decide between "show login" and
		// "show app" on first load, since the cookie is httpOnly and JS
		// can't observe it directly. Read from req.cookies (populated by
		// cookie-parser); fall back to the raw header for tests / paths
		// that bypass middleware. Verification failures land as
		// `authenticated: false`, never as a 4xx — this endpoint is
		// public-by-design.
		//
		// `isAdmin` is fetched fresh from D1 (#50) rather than from a
		// JWT-embedded claim so admin grant/revoke takes effect without
		// requiring users to log out and back in. `isLead` (#201e)
		// follows the same shape — fetched fresh so an admin
		// adding/removing the user as a group lead lands without a
		// re-login. Both fall back to false on lookup failure or
		// unauthenticated callers — UI should treat the booleans as
		// "show admin/lead features" only when explicitly true.
		const reqWithCookies = req as Request & {
			cookies?: Record<string, string | undefined>;
		};
		const token =
			reqWithCookies.cookies?.[AUTH_COOKIE_NAME] ??
			extractTokenFromCookieHeader(req.headers.cookie) ??
			undefined;
		const payload = verifyJwt(token);
		const authenticated = payload !== null;
		// Run all three lookups in parallel — they have no data
		// dependency, and CLAUDE.md flags D1 round-trips as the
		// expensive thing on hot paths. Admin + lead lookups catch
		// their own errors (surface as false); hasAnyUsers throwing
		// is a real boot-state failure and propagates to the 500
		// handler.
		const [adminLookup, leadLookup, anyUsers] = await Promise.all([
			payload
				? d1Query<{ is_admin: number }>("SELECT is_admin FROM users WHERE id = ?", [
						payload.sub,
					]).catch(() => null)
				: Promise.resolve(null),
			payload ? groups.isUserLead(payload.sub).catch(() => false) : Promise.resolve(false),
			hasAnyUsers(),
		]);
		const isAdmin = adminLookup?.results[0]?.is_admin === 1;
		const isLead = leadLookup === true;
		// #200: surface the effective per-session resource caps so the
		// frontend's create-session form can advertise the operator-
		// lowered max instead of the hardcoded v1 ceiling. Without
		// this, a user on a deployment with MAX_SESSION_CPU=4 still
		// sees "8 cores" in the hint and an input that accepts 6,
		// then gets a 400 from the backend with a message that names
		// an env var they have no power to read. Computed from the
		// module-load values in sessionConfig.ts so the wire shape
		// matches the form's units (cores + MiB) one-to-one.
		const resourceCaps = {
			cpuMaxCores: EFFECTIVE_CPU_NANO_MAX / 1_000_000_000,
			memMaxMiB: EFFECTIVE_MEM_BYTES_MAX / (1024 * 1024),
		};
		res.json({ needsSetup: !anyUsers, authenticated, isAdmin, isLead, resourceCaps });
	});

	router.post("/auth/register", registerIp, async (req: Request, res: Response) => {
		const { username, password, inviteCode } = req.body as {
			username?: string;
			password?: string;
			inviteCode?: string;
		};
		if (!username || !password || password.length < 6) {
			res.status(400).json({ error: "username and password (min 6 chars) required" });
			return;
		}
		if (username.length > USERNAME_MAX_LEN) {
			res.status(400).json({ error: `username must be at most ${USERNAME_MAX_LEN} characters` });
			return;
		}
		// The frontend always sends a string or omits the field, but a hand-
		// crafted POST with `inviteCode: 123` would crash `.trim()` and
		// surface as a 500. Guard at the boundary so callers get a clear 400.
		if (inviteCode !== undefined && typeof inviteCode !== "string") {
			res.status(400).json({ error: "inviteCode must be a string" });
			return;
		}
		// Cap length too — invite codes mint at 16 hex chars, so anything
		// larger is a client bug or a probe. Without this, a megabyte-long
		// string would still hit D1 as a parameter.
		if (inviteCode !== undefined && inviteCode.length > 64) {
			res.status(400).json({ error: "inviteCode must be at most 64 characters" });
			return;
		}
		// Distinguish "field absent" from "field present but whitespace-only".
		// Without this, `inviteCode = "   "` would trim to "" and `|| undefined`
		// would coerce it to absent, surfacing as "Invite code required" instead
		// of "invalid". Whitespace-only is an explicit attempt — treat it as
		// an invalid code so the user sees the right error.
		let trimmedInviteCode: string | undefined;
		if (inviteCode === undefined) {
			trimmedInviteCode = undefined;
		} else if (inviteCode.trim() === "") {
			res.status(403).json({ error: "Invite code is invalid, expired, or already used" });
			return;
		} else {
			trimmedInviteCode = inviteCode.trim();
		}
		try {
			const result = await registerUser(username, password, trimmedInviteCode);
			// JWT goes out as an httpOnly cookie (#18); the response body
			// keeps the userId for clients that want to address the new
			// account, but never the raw token.
			setAuthCookie(res, result.token);
			res.status(201).json({
				userId: result.userId,
				isAdmin: result.isAdmin,
				isLead: result.isLead,
			});
		} catch (err) {
			if (err instanceof InviteRequiredError) {
				// 403 — caller authenticated nothing yet, but the action is
				// forbidden without a valid invite. Distinct from 409 so the
				// frontend can render the invite-code field instead of a
				// username-taken message.
				res.status(403).json({ error: err.message });
				return;
			}
			if (err instanceof UsernameTakenError) {
				res.status(409).json({ error: err.message });
				return;
			}
			logger.error(`[auth] register failed unexpectedly: ${(err as Error).message}`);
			res.status(500).json({ error: "Internal server error" });
		}
	});

	router.post("/auth/login", loginIp, async (req: Request, res: Response) => {
		const { username, password } = req.body as { username?: string; password?: string };
		if (!username || !password) {
			res.status(400).json({ error: "username and password required" });
			return;
		}
		if (username.length > USERNAME_MAX_LEN) {
			res.status(400).json({ error: `username must be at most ${USERNAME_MAX_LEN} characters` });
			return;
		}

		// Per-username gate runs before bcrypt. `scope` distinguishes an
		// account lockout from the IP-layer 429 above. Emits the same
		// draft-7 RateLimit-* headers as express-rate-limit does on the
		// IP 429 so clients parsing them see a consistent shape.
		//
		// beginAttempt reserves an in-flight slot atomically — important
		// now that loginUser uses async bcrypt.compare (no longer blocks
		// the event loop). Without the reservation, a burst of N requests
		// against the same username could all pass check() and all start
		// bcrypt before any recordFailure lands, breaking the bound.
		const check = usernameLimiter.beginAttempt(username);
		if (!check.allowed) {
			const windowSeconds = Math.ceil(rateLimitConfig.login.usernameWindowMs / 1000);
			res.setHeader("Retry-After", String(check.retryAfterSeconds));
			res.setHeader("RateLimit-Policy", `${rateLimitConfig.login.usernameMax};w=${windowSeconds}`);
			res.setHeader(
				"RateLimit",
				`limit=${rateLimitConfig.login.usernameMax}, remaining=0, reset=${check.retryAfterSeconds}`,
			);
			res.status(429).json({
				error: "Too many failed login attempts for this account, try again later",
				scope: "username",
			});
			return;
		}

		let result: { userId: string; token: string; isAdmin: boolean; isLead: boolean };
		try {
			try {
				result = await loginUser(username, password);
			} catch (err) {
				if (err instanceof InvalidCredentialsError) {
					// Only bad creds count — infra errors must not lock real users out.
					usernameLimiter.recordFailure(username);
					res.status(401).json({ error: err.message });
					return;
				}
				// Username omitted from the log to avoid an enumeration vector.
				logger.error(`[auth] login failed unexpectedly: ${(err as Error).message}`);
				res.status(500).json({ error: "Internal server error" });
				return;
			}
			usernameLimiter.reset(username);
			setAuthCookie(res, result.token);
			res.json({
				userId: result.userId,
				isAdmin: result.isAdmin,
				isLead: result.isLead,
			});
		} finally {
			// Always release the in-flight slot — success, invalid creds,
			// or infra error alike. `reset()` above wipes the failure
			// counter but not this slot; pairing it with endAttempt keeps
			// the invariant that every beginAttempt has exactly one
			// endAttempt.
			usernameLimiter.endAttempt(username);
		}
	});

	// Logout is intentionally NOT auth-gated: the action is "discard the
	// cookie", which is harmless to the server even on a missing/invalid
	// session — and gating it would mean that an already-expired token
	// couldn't even be cleaned up locally.
	//
	// In production the auth cookie is SameSite=None (required for the
	// cross-site Pages → Tunnel deployment), so a cross-site form POST
	// to this endpoint *can* reach the server. The consequence is user
	// inconvenience only — no data is exposed, no session can be hijacked
	// by clearing the victim's cookie. State-changing routes that DO
	// matter for CSRF (POST/DELETE/PATCH with JSON bodies) are
	// preflight-gated by the CORS middleware in index.ts.
	router.post("/auth/logout", logoutIp, (_req: Request, res: Response) => {
		clearAuthCookie(res);
		res.status(204).send();
	});

	// ── Authenticated route prefixes ────────────────────────────────────────

	router.use("/invites", requireAuth);
	router.use("/sessions", requireAuth);
	router.use("/templates", requireAuth);
	router.use("/admin", requireAuth);
	// /groups is the lead-side surface (#201c) — auth-gated but NOT
	// admin-gated. Admin-only group management lives under /admin/groups
	// above; this prefix carries `GET /groups/mine[/sessions]` which any
	// authed user may call (a non-lead just gets `[]` back). Adding the
	// prefix here keeps the auth-mount block in one place.
	router.use("/groups", requireAuth);

	// Idle-sweeper bumper. Mounted AFTER `requireAuth` so unauth
	// requests don't reset the activity timer. The `:id` capture is
	// what the sweeper needs; static collection routes like
	// `GET /sessions` (no id) are excluded by the pattern.
	//
	// Bump is hooked on `res.on("finish")` and gated on a successful
	// status (< 400) so a foreign-session probe (`GET /sessions/<not-mine>`)
	// gets its 403 from the handler's `assertOwnership` BEFORE the
	// bump fires — without this, any authed user could keep someone
	// else's session alive indefinitely by hitting their session id
	// in a loop, defeating the idle-TTL contract for the real owner.
	// Status check covers the whole 4xx/5xx range (auth, ownership,
	// rate-limit, 404, internal errors) so anything other than a
	// healthy interaction stays out of the activity signal.
	if (idleSweeper) {
		router.use("/sessions/:id", (req, res, next) => {
			res.on("finish", () => {
				// `res.locals.skipIdleBump` is the opt-out for routes
				// that explicitly tore down the entry (DELETE / stop /
				// hard-delete). Without this gate, the `finish`
				// listener fires AFTER the handler's `res.send()` /
				// `res.json()`, which means a `forget()` called inside
				// the handler runs first, then the bump re-adds the
				// entry milliseconds later — undoing the prune.
				const skip = (res.locals as { skipIdleBump?: boolean }).skipIdleBump === true;
				if (!skip && res.statusCode < 400) {
					idleSweeper.bump(req.params.id);
				}
			});
			next();
		});
	}

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
						// cgroup modes; we match the broad set rather
						// than pinning one. Hit any of these → 409
						// ("conflict with current state") with a clear
						// "free memory first" hint. Everything else falls
						// through to 500 + log.
						//   - cgroup-v1 daemon: "Minimum memory limit can
						//     not be less than memory reservation limit"
						//   - newer daemons:    "lower than current"
						//   - kernel-side OOM:  "Out of memory"
						//   - cgroup-v2 memcg:  "memory limit too low"
						const message = (err as Error).message ?? "";
						const cgroupReject =
							/lower than current|less than (memory )?reservation|Minimum memory limit|memory limit too low|Out of memory/i.test(
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

	// ── Session routes ──────────────────────────────────────────────────────

	router.post("/sessions", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		const { name, cols, rows, envVars, config } = req.body as {
			name?: string;
			cols?: number;
			rows?: number;
			envVars?: unknown;
			config?: unknown;
		};
		if (!name || typeof name !== "string") {
			res.status(400).json({ error: "body.name is required" });
			return;
		}
		// Cap session name at the request boundary. The 100KB express.json
		// body limit is the only upstream bound otherwise — a 50KB name
		// would land in D1 verbatim and ride out on every list response.
		// 64 matches USERNAME_MAX_LEN and the tab-label cap; same shape of
		// "user-controlled string with no other natural limit" → same cap.
		// The empty-string case is already handled by the `!name` guard
		// above; only the upper bound needs to be checked here. See #149.
		if (name.length > SESSION_NAME_MAX_LEN) {
			res
				.status(400)
				.json({ error: `body.name must be at most ${SESSION_NAME_MAX_LEN} characters` });
			return;
		}
		// Numeric dimensions: integer + sane range. xterm uses these to drive
		// PTY size, and tmux can be unhappy with extreme values; also keeps
		// nonsense like cols: -1 / cols: 1e9 out of the row.
		if (cols !== undefined && !isValidTerminalDim(cols)) {
			res.status(400).json({
				error: `body.cols must be an integer in 1..${TERMINAL_DIM_MAX}`,
			});
			return;
		}
		if (rows !== undefined && !isValidTerminalDim(rows)) {
			res.status(400).json({
				error: `body.rows must be an integer in 1..${TERMINAL_DIM_MAX}`,
			});
			return;
		}
		let validatedEnvVars: Record<string, string>;
		try {
			validatedEnvVars = validateEnvVars(envVars);
		} catch (err) {
			if (err instanceof EnvVarValidationError) {
				res.status(400).json({ error: err.message });
				return;
			}
			throw err;
		}
		// Two env-var stores coexist after #185:
		//   - `body.envVars` →  `sessions.env_vars`               (legacy)
		//   - `body.config.envVars` → `session_configs.env_vars_json`
		// Both are applied at `docker run` time by `mergeEnvForSpawn` in
		// DockerManager.spawn — union with config-wins on key collisions
		// (see PR #206). Both inputs flow through `validateEnvVars` here
		// so the denylist (PATH, LD_*, SESSION_ID, …) and shape rules
		// apply identically to either path. The dual-store split exists
		// because #186 will swap `config.envVars` for typed entries with
		// AES-GCM-encrypted secrets — the legacy column stays as the
		// plain-string fast path for callers that don't need secrets.
		// `body.config` is the new typed config object (#185 / epic #184).
		// All sub-fields are optional, so an undefined / empty object is
		// the bare-POST path and behaves exactly like before. A failed
		// validation surfaces the first offending field's path
		// (e.g. "config.cpuLimit") in the 400 message so the client can
		// fix the input without trial-and-error.
		let validatedConfig: SessionConfig | undefined;
		try {
			validatedConfig = validateSessionConfig(config);
		} catch (err) {
			if (err instanceof SessionConfigValidationError) {
				res.status(400).json({ error: err.message });
				return;
			}
			throw err;
		}
		// `sessions.create` writes a D1 row BEFORE `docker.spawn` runs, so a
		// spawn failure (missing image, docker daemon down, name collision on
		// the 12-char container-name prefix, workspace chown EACCES) would
		// otherwise leak a phantom `running` session with a null container_id.
		// reconcile() would later flip it to `stopped`, but the row stays
		// forever and users see a zombie entry in their sidebar. Roll back
		// the D1 row explicitly on any spawn failure.
		let meta: Awaited<ReturnType<SessionManager["create"]>> | null = null;
		try {
			meta = await sessions.create({ userId, name, cols, rows, envVars: validatedEnvVars });
			// Persist the typed config BEFORE spawning the container. If
			// docker.spawn fails the rollback in the catch below deletes
			// the sessions row and ON DELETE CASCADE on session_configs
			// drops the config row atomically — no orphan config rows.
			// Skip the INSERT for an empty `{}` config so we don't bloat
			// D1 with no-op rows; isEmptyConfig handles the bare-POST
			// case (validatedConfig === undefined) implicitly via the
			// outer guard.
			if (validatedConfig && !isEmptyConfig(validatedConfig)) {
				// Encrypt `secret` env-var entries BEFORE the row hits
				// D1 (#186). Plaintext is in scope only inside this
				// handler; once `persistable` is built, the only thing
				// that can leak is ciphertext.
				const persistable: PersistableSessionConfig = {
					...validatedConfig,
					envVars: validatedConfig.envVars
						? encryptSecretEntries(validatedConfig.envVars)
						: undefined,
					// #188 PR 188b: encrypt PAT / SSH credentials at the
					// route boundary, same shape as envVars secrets. The
					// helper returns undefined for an empty/absent blob
					// so `jsonOrNull` collapses the column to NULL.
					auth: encryptAuthCredentials(validatedConfig.auth),
				};
				await persistSessionConfig(meta.sessionId, persistable);
			}
			await docker.spawn(meta.sessionId);
			const updated = await sessions.get(meta.sessionId);
			if (!updated) {
				// Shouldn't happen: sessions.create above just inserted this row,
				// and nothing in this handler deletes it. Guard so serializeMeta
				// doesn't get null. The throw falls into the catch below which
				// runs the spawn rollback and returns 500 — correct disposition
				// for a server-side invariant violation.
				throw new Error(`session ${meta.sessionId} missing from D1 after create`);
			}
			// PR 185b2b: postCreate runs ASYNCHRONOUSLY when configured.
			// The route returns 201 immediately so the modal can subscribe
			// to `/ws/bootstrap/<sessionId>` and tail output live; the
			// runner inside `runAsyncBootstrap` flips status to `failed`
			// + kills the container on hard-fail, then broadcasts a
			// terminal `{type:"fail"}` for the modal to render. The
			// `bootstrapping: true` flag tells the client to open the WS
			// instead of treating the create as immediately complete.
			//
			// postStart fires inside the runner on the success branch
			// (after markBootstrapped). For sessions with postStart but
			// NO postCreate / repo, fire it directly here — the async
			// runner only kicks off when there's something to block on.
			//
			// #188 PR 188c: the trigger now fires when EITHER a repo or
			// a postCreateCmd is configured. The runner's clone step is
			// a no-op when `repo` is absent, so this widening is safe
			// for the postCreate-only path and lets repo-only sessions
			// (no hook, just a clone) get their async-bootstrap modal.
			// Fire async bootstrap when ANY config-driven stage or hook
			// is set. #191 PR 191b widened from `repo || postCreateCmd`
			// to also include the three new lifecycle-hook fields.
			const hasBootstrapConfig =
				(validatedConfig?.repo !== null && validatedConfig?.repo !== undefined) ||
				(validatedConfig?.gitIdentity !== null && validatedConfig?.gitIdentity !== undefined) ||
				(validatedConfig?.dotfiles !== null && validatedConfig?.dotfiles !== undefined) ||
				(validatedConfig?.agentSeed !== null && validatedConfig?.agentSeed !== undefined);
			if (validatedConfig?.postCreateCmd || hasBootstrapConfig) {
				const cfg = {
					postCreateCmd: validatedConfig?.postCreateCmd,
					postStartCmd: validatedConfig?.postStartCmd,
					// `hasBootstrapConfig` gates the runner's
					// `getSessionConfig` D1 fetch — skip the round-trip
					// for postCreate-only sessions (PR #214 round 2 NIT,
					// generalised in #191 PR 191b to cover all four
					// config-driven stages: repo / gitIdentity / dotfiles
					// / agentSeed).
					hasBootstrapConfig,
				};
				// Fire-and-forget; the runner internally catches every
				// throw it can and translates them into broadcaster
				// `fail` messages. A bare `void`-prefix triggers
				// `no-floating-promises`; explicitly catching at the
				// top level satisfies the linter and gives us a final
				// safety net for anything the runner missed.
				const startedSessionId = meta.sessionId;
				runAsyncBootstrap(startedSessionId, cfg, { sessions, docker, broadcaster }).catch((err) => {
					logger.error(
						`[routes] async bootstrap escaped its own error handling for ${startedSessionId}: ${(err as Error).message}`,
					);
					// Push a synthetic terminal so the modal's WS
					// subscriber doesn't sit on "Bootstrapping…"
					// forever (PR #208 round 2). runAsyncBootstrap
					// is very defensive so this branch is unlikely,
					// but a future edit that breaks its internal
					// try/catch would otherwise leave the user
					// with a hung modal and the row at status=running
					// with no further flip path. broadcaster.finish
					// lazy-creates the session entry, so it's safe
					// even if the runner threw before any broadcast.
					broadcaster.finish(startedSessionId, {
						type: "fail",
						exitCode: -1,
						error: (err as Error).message,
					});
				});
				res.status(201).json({ ...serializeMeta(updated), bootstrapping: true });
				return;
			}
			// No postCreate (bare-create or only postStart configured).
			// postStart fires synchronously here for the create path —
			// `runPostStart` only kicks off a detached tmux session, so
			// it returns quickly even though the daemon keeps running.
			if (validatedConfig?.postStartCmd) {
				try {
					await docker.runPostStart(meta.sessionId, validatedConfig.postStartCmd);
				} catch (err) {
					// Don't fail create on a postStart launch error —
					// the container is up and the user can still use it.
					logger.warn(
						`[routes] postStart launch failed for ${meta.sessionId}: ${(err as Error).message}`,
					);
				}
			}
			res.status(201).json(serializeMeta(updated));
		} catch (err) {
			// Quota errors come from sessions.create before any D1 row or
			// container is written, so there's nothing to roll back — return
			// 429 directly. Checking before the generic error log too, so a
			// routine quota hit doesn't spam the logs as a "session create
			// failed" line.
			if (err instanceof SessionQuotaExceededError) {
				res.status(429).json({ error: err.message, quota: err.quota });
				return;
			}
			logger.error(`[routes] session create failed: ${(err as Error).message}`);
			if (meta) {
				// Capture the id once so the closures below don't have to
				// reach back through the outer mutable `let meta` (TS
				// can't narrow `meta` through a closure even though we're
				// already inside `if (meta)`). One const, no optional
				// chains, no ambiguity for future readers about whether
				// meta could ever be null on these lines.
				const rollbackId = meta.sessionId;
				// Best-effort rollback. If deleteRow itself fails (D1 blip),
				// the reconciler will eventually flip status to stopped but
				// the row remains — we log loudly so an operator can clean
				// it up manually.
				//
				// Kill any running container BEFORE deleting the D1 row.
				// Without this, the post-spawn failure paths (e.g.
				// `markBootstrapped` throws on a D1 transient AFTER
				// `docker.spawn` succeeded and `runPostCreate` exited
				// cleanly) would orphan a live container with no row to
				// reach it through — `reconcile()` queries
				// `WHERE status='running'`, so a deleted row means the
				// container survives until the next host reboot. The
				// non-zero-exit path inside the try/catch already kills
				// the container before throwing; this guard covers every
				// other post-spawn failure shape (markBootstrapped,
				// runPostStart, sessions.get, the synthetic invariant
				// throw above). Idempotent: the failure-branch
				// `docker.kill` already ran on hard-fail, and `kill`
				// swallows "no such container" internally.
				await docker.kill(rollbackId).catch((killErr) => {
					logger.error(
						`[routes] CRITICAL: kill during create rollback for session ${rollbackId} failed: ${(killErr as Error).message}`,
					);
				});
				try {
					await sessions.deleteRow(rollbackId);
				} catch (cleanupErr) {
					logger.error(
						`[routes] CRITICAL: spawn rollback failed for session ${rollbackId}: ${(cleanupErr as Error).message}`,
					);
				}
			}
			res.status(500).json({ error: (err as Error).message });
		}
	});

	router.get("/sessions", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		const includeTerminated = req.query.all === "true";
		const list = includeTerminated
			? await sessions.listAllForUser(userId)
			: await sessions.listForUser(userId);
		res.json(list.map(serializeMeta));
	});

	router.get("/sessions/:id", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		try {
			const meta = await sessions.assertOwnership(req.params.id, userId);
			res.json(serializeMeta(meta));
		} catch (err) {
			handleSessionError(err, res);
		}
	});

	// Per-session observe-log read (#201d). Returns the audit history
	// for a single session — who watched, when, and whether they're
	// still watching (`endedAt: null`). Gated by `assertCanObserve`:
	// the owner, any admin, and any lead of a group containing the
	// owner can read this view. A non-authorised caller gets 403/404
	// from the assert (same shape the other session-scoped reads
	// emit). The route lives next to `GET /sessions/:id` so the
	// owner-facing audit view is co-located with the session detail.

	const serializeObserveLogEntry = (e: observeLog.ObserveLogEntry) => ({
		id: e.id,
		observerUserId: e.observerUserId,
		observerUsername: e.observerUsername,
		sessionId: e.sessionId,
		ownerUserId: e.ownerUserId,
		startedAt: e.startedAt.toISOString(),
		endedAt: e.endedAt?.toISOString() ?? null,
	});

	router.get("/sessions/:id/observe-log", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		try {
			// `assertCanObserve` throws NotFoundError for a missing
			// session and ForbiddenError for an unauthorised caller —
			// both shapes flow into `handleSessionError`'s standard 404
			// / 403 emission, so callers get the same status-code
			// contract the rest of the /sessions/:id reads use.
			await sessions.assertCanObserve(req.params.id, userId);
			const list = await observeLog.listForSession(req.params.id);
			res.json(list.map(serializeObserveLogEntry));
		} catch (err) {
			handleSessionError(err, res);
		}
	});

	router.delete("/sessions/:id", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		// `?hard=true` turns this into a hard delete: container is killed,
		// workspace files are wiped from disk, and the D1 row is removed.
		// Without it, we do a soft delete — container goes away but the row
		// stays (status=terminated) and the workspace dir is preserved so
		// the user can later restore the session.
		const hard = req.query.hard === "true" || req.query.hard === "1";

		try {
			const meta = await sessions.assertOwnership(req.params.id, userId);

			// Idempotent path: only tear down the container + flip to
			// terminated the first time. Subsequent calls skip this.
			if (meta.status !== "terminated") {
				await docker.kill(req.params.id);
				await sessions.terminate(req.params.id);
				// Drop the idle-sweeper's lastActivity entry — without
				// this the Map grows unboundedly across the backend's
				// lifetime as soft-deleted sessions accumulate. The
				// `skipIdleBump` flag suppresses the bump middleware's
				// `finish` listener; without it, the success-status
				// bump fires AFTER `forget` on the same response and
				// re-adds the entry, making the prune a no-op. Bump
				// already needed an authed user; forget needs the same
				// gate, which the assertOwnership above provides.
				res.locals.skipIdleBump = true;
				idleSweeper?.forget(req.params.id);
			}

			if (hard) {
				// Wipe workspace files and drop the row entirely.
				try {
					await docker.purgeWorkspace(req.params.id);
				} catch (err) {
					logger.error(
						`[routes] purgeWorkspace failed for ${req.params.id}: ${(err as Error).message}`,
					);
					// Fall through — we still want to remove the row.
				}
				await sessions.deleteRow(req.params.id);
				// Hard-delete also drops the activity entry — covers
				// the path where a user goes straight to ?hard=true on
				// an already-terminated session. Same `skipIdleBump`
				// flag rationale as the soft-delete branch above.
				res.locals.skipIdleBump = true;
				idleSweeper?.forget(req.params.id);
			}

			res.status(204).send();
		} catch (err) {
			handleSessionError(err, res);
		}
	});

	router.post("/sessions/:id/stop", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		try {
			await sessions.assertOwnedBy(req.params.id, userId);
			await docker.stopContainer(req.params.id);
			// Same `forget` rationale as DELETE above: a stopped
			// session shouldn't sit in the activity map collecting
			// stale bumps. `skipIdleBump` blocks the bump middleware's
			// success-status listener from re-adding the entry on
			// the same response. The next /start re-seeds.
			res.locals.skipIdleBump = true;
			idleSweeper?.forget(req.params.id);
			const updated = await sessions.get(req.params.id);
			if (!updated) {
				// Race: the session was deleted between assertOwnership
				// above and this re-read. Return 404 rather than TypeError
				// on serializeMeta(null).
				res.status(404).json({ error: "Session not found" });
				return;
			}
			res.json(serializeMeta(updated));
		} catch (err) {
			handleSessionError(err, res);
		}
	});

	router.post("/sessions/:id/start", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		try {
			const meta = await sessions.assertOwnership(req.params.id, userId);
			// `failed` (#185) means the create-time postCreate hook
			// exited non-zero. Refuse the restart explicitly — letting it
			// through would spawn a fresh container without re-running
			// postCreate (the gate is single-use), leaving the user with
			// what looks like a healthy "running" session whose
			// environment was never bootstrapped. The session can carry
			// partial workspace artefacts from the failed attempt; the
			// safe path is `recreate it to retry`. 409 Conflict reflects
			// "valid request, current state forbids it" — not 400 (the
			// payload is fine) and not 403 (it's not an auth issue).
			if (meta.status === "failed") {
				res.status(409).json({
					error:
						"Session failed during postCreate; recreate it to retry. The original output is still in the failed-row history.",
				});
				return;
			}
			await docker.startContainer(req.params.id);
			const updated = await sessions.get(req.params.id);
			if (!updated) {
				// Race: deleted between assertOwnership and get. See
				// stopContainer handler above for the full explanation.
				res.status(404).json({ error: "Session not found" });
				return;
			}
			res.json(serializeMeta(updated));
		} catch (err) {
			handleSessionError(err, res);
		}
	});

	router.patch("/sessions/:id/env", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		const { envVars } = req.body as { envVars?: unknown };
		// Require envVars to be explicitly present. An omitted body field here
		// is almost certainly a client bug — if the user really wants to clear
		// their vars they should PATCH with `{ envVars: {} }`.
		if (envVars === undefined) {
			res.status(400).json({ error: "body.envVars is required" });
			return;
		}
		let validatedEnvVars: Record<string, string>;
		try {
			validatedEnvVars = validateEnvVars(envVars);
		} catch (err) {
			if (err instanceof EnvVarValidationError) {
				res.status(400).json({ error: err.message });
				return;
			}
			throw err;
		}
		try {
			await sessions.assertOwnedBy(req.params.id, userId);
			await sessions.updateEnvVars(req.params.id, validatedEnvVars);
			const updated = await sessions.get(req.params.id);
			if (!updated) {
				// Race: deleted between assertOwnership and get. See
				// stopContainer handler above for the full explanation.
				res.status(404).json({ error: "Session not found" });
				return;
			}
			res.json(serializeMeta(updated));
		} catch (err) {
			handleSessionError(err, res);
		}
	});

	// ── Tabs within a session ──────────────────────────────────────────────
	// Each tab is a tmux session inside the container. The backend owns the
	// tabId → tmux session name mapping; the UI treats tabId as an opaque
	// string. Deleting a tab SIGHUPs everything inside it.

	router.get("/sessions/:id/tabs", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		try {
			// `assertCanObserve` (#201d) instead of `assertOwnedBy`
			// (#201e-1 review BLOCKER). Reading the tab list is a
			// read-only operation observers MUST be able to do — without
			// it the lead's "Observe" click can't pick a tab to attach
			// to, and the WS would 1008-close on "Missing tab". The auth
			// graduation is owner / admin / lead-of-group-containing-owner,
			// matching what the observe-WS attach itself enforces.
			// Tab CREATE / DELETE further down stay on `assertOwnedBy` —
			// observability does NOT include the right to mutate tab
			// state on someone else's session.
			await sessions.assertCanObserve(req.params.id, userId);
			const tabs = await docker.listTabs(req.params.id);
			res.json(tabs);
		} catch (err) {
			handleSessionError(err, res);
		}
	});

	router.post("/sessions/:id/tabs", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		const { label } = (req.body ?? {}) as { label?: unknown };
		// Tab-label invariants for the tmux TSV listTabs parser — see
		// the JSDoc on DockerManager.createTab for the full rationale
		// (issue #92). Enforced here so dockerManager can trust its
		// input and avoid silent normalisation (a .trim() there would
		// cause "what you sent ≠ what's stored").
		const labelValidation = validateTabLabel(label);
		if (labelValidation) {
			res.status(400).json({ error: labelValidation });
			return;
		}
		try {
			await sessions.assertOwnedBy(req.params.id, userId);
			const tab = await docker.createTab(req.params.id, label as string | undefined);
			res.status(201).json(tab);
		} catch (err) {
			handleSessionError(err, res);
		}
	});

	router.delete("/sessions/:id/tabs/:tabId", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		const { id, tabId } = req.params;
		try {
			await sessions.assertOwnedBy(id, userId);

			// Closing all tabs is allowed — the container lifecycle is
			// independent of tmux now, so a session with zero tabs is a
			// valid state (the user creates a new tab from the +).
			const tabs = await docker.listTabs(id);
			if (!tabs.some((t) => t.tabId === tabId)) {
				res.status(404).json({ error: "tab not found" });
				return;
			}

			await docker.deleteTab(id, tabId);
			res.status(204).send();
		} catch (err) {
			handleSessionError(err, res);
		}
	});

	// ── File uploads ────────────────────────────────────────────────────────
	// Drop user-uploaded files into the session's bind-mounted workspace
	// (under uploads/) so the container — and Claude CLI in it — can read
	// them.
	//
	// Disk storage (NOT memoryStorage) is the load-bearing choice here.
	// 8 × 25 MB = 200 MB of body per request, and the per-IP rate
	// limiter (30/5min) doesn't bound concurrency — 30 concurrent
	// requests with memoryStorage would peak at ~6 GB of heap and
	// OOM-kill the backend. Disk storage streams bytes through Node
	// into the OS page cache, then `writeUploads` atomically renames
	// the temp file into the final per-session location.
	//
	// Caps:
	//   - 25 MB per file: covers the images / PDFs Claude actually
	//     accepts without forcing chunked upload UI.
	//   - 8 files per request: enough for a typical "drop a few
	//     screenshots" gesture, low enough to bound peak disk usage
	//     per request.
	const uploadTmpDir = docker.getUploadTmpDir();
	const upload = multer({
		storage: multer.diskStorage({
			destination: (_req, _file, cb) => {
				// Idempotent — the dir often already exists; recursive: true
				// makes mkdir a no-op in that case.
				fs.mkdir(uploadTmpDir, { recursive: true })
					.then(() => cb(null, uploadTmpDir))
					.catch((err: Error) => cb(err, ""));
			},
			filename: (_req, _file, cb) => {
				// multer-internal name only; writeUploads renames to the
				// user-facing `<ts>-<rand>-<safeBase>` form when it moves
				// the file into the per-session uploads/ dir.
				cb(null, `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`);
			},
		}),
		limits: {
			fileSize: 25 * 1024 * 1024,
			files: 8,
			// Endpoint accepts only file parts (named "files"), no
			// text fields. Cap fields/parts so a JWT holder can't
			// make busboy parse thousands of throwaway parts before
			// the file count hits its limit. parts = files (8) + 1
			// headroom; fields = 0 means any non-file part trips
			// LIMIT_PART_COUNT immediately.
			fields: 0,
			parts: 9,
			fieldNameSize: 64,
		},
	});

	// Wrap multer so its async-throw errors land in our handleSessionError-style
	// responder instead of Express's default HTML 500 page.
	const handleUploadMiddleware = (req: Request, res: Response, next: NextFunction): void => {
		upload.array("files", 8)(req, res, (err: unknown) => {
			if (!err) {
				next();
				return;
			}
			// When multer aborts mid-batch (e.g. file 8 trips
			// LIMIT_FILE_SIZE after files 1–7 already streamed to
			// .tmp-uploads/), it auto-removes only the partial
			// file for the entry that errored. The earlier
			// successfully-streamed files sit in req.files and
			// would otherwise leak — at 30 reqs / 5min × 7 ×
			// ~25 MB = ~5 GB/window of orphaned tmp files. Clear
			// them on every error branch before returning.
			const partial = (req.files as Express.Multer.File[] | undefined) ?? [];
			if (partial.length > 0) {
				void Promise.allSettled(partial.map((f) => fs.unlink(f.path))).then((results) => {
					// Log unlink failures (e.g. EPERM from a misconfigured
					// tmp dir owner) so a real filesystem problem doesn't
					// sit invisible until the next startup sweep. ENOENT
					// is the expected outcome on a never-streamed entry
					// and gets logged too — noise here is a clearer
					// signal than silence.
					for (const r of results) {
						if (r.status === "rejected") {
							logger.warn(`[routes] tmp unlink failed: ${(r.reason as Error).message}`);
						}
					}
				});
			}
			if (err instanceof multer.MulterError) {
				if (err.code === "LIMIT_FILE_SIZE") {
					res.status(413).json({ error: `Upload rejected: ${err.message}` });
					return;
				}
				if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_PART_COUNT") {
					// Both are payload-too-large in spirit: the request
					// exceeds a server cap (8 files / 9 parts). 413 is
					// the spec answer and lets clients distinguish
					// "retry-may-help" 4xxs from this hard cap.
					res.status(413).json({ error: `Upload rejected: ${err.message}` });
					return;
				}
				if (err.code === "LIMIT_UNEXPECTED_FILE") {
					// Default message ("Unexpected field") doesn't tell the
					// caller what field name we DO expect — name it explicitly.
					res
						.status(400)
						.json({ error: "Upload rejected: field must be named 'files' (multipart/form-data)" });
					return;
				}
				res.status(400).json({ error: `Upload rejected: ${err.message}` });
				return;
			}
			logger.error(`[routes] upload middleware error: ${(err as Error).message}`);
			res.status(500).json({ error: "Upload failed" });
		});
	};

	// Verify ownership BEFORE multer reads any bytes from the wire. With
	// up to 200 MB (8 × 25 MB) per request, running the ownership check
	// in the route handler — i.e. after multer has already buffered
	// everything into the Node heap — let an authenticated user with a
	// valid JWT but a foreign session ID cause N × 200 MB allocations
	// bounded only by the per-IP rate limiter. Doing it here means
	// unauthorised requests close the socket on the 403 with no body
	// ever buffered.
	const requireSessionOwnership = async (
		req: Request,
		res: Response,
		next: NextFunction,
	): Promise<void> => {
		try {
			await sessions.assertOwnedBy(req.params.id, (req as AuthedRequest).userId);
			next();
		} catch (err) {
			handleSessionError(err, res);
		}
	};

	router.post(
		"/sessions/:id/files",
		// Explicit requireAuth so the route doesn't silently inherit
		// its auth gate from `router.use("/sessions", requireAuth)`
		// earlier in this file. If a future refactor lifts this
		// route out of the /sessions prefix, the explicit guard
		// makes the failure mode a 401 (loud) instead of an
		// anon-userId reaching assertOwnership and surfacing as a
		// confusing 404.
		requireAuth,
		fileUploadIp,
		requireSessionOwnership,
		handleUploadMiddleware,
		async (req: Request, res: Response) => {
			const files = (req.files as Express.Multer.File[] | undefined) ?? [];
			try {
				if (files.length === 0) {
					res
						.status(400)
						.json({ error: "no files provided (use 'files' field, multipart/form-data)" });
					return;
				}
				const paths = await docker.writeUploads(
					req.params.id,
					// diskStorage — pass the on-disk tmp path, not a buffer.
					files.map((f) => ({ originalname: f.originalname, path: f.path })),
				);
				res.status(201).json({ paths });
			} catch (err) {
				// No tmp cleanup needed here — writeUploads owns
				// its own finally block that unlinks every tmp file
				// it didn't move. The empty-files 400 above returns
				// before the writeUploads call (and only triggers
				// when multer parsed zero files, in which case
				// there's nothing on disk to clean either way).
				handleSessionError(err, res);
			}
		},
	);

	// ── Templates ──────────────────────────────────────────────────────────
	//
	// Per-user reusable session-config presets. The list/read/update/
	// delete code paths all flow through `templates.assertOwnership`
	// (or `templates.getOwned`, which collapses missing + forbidden
	// into a single 404 to avoid status-code-timing enumeration of
	// "your template" vs "someone else's"). The save-as-template
	// flow that strips secret values lands in the next sub-PR; this
	// PR exposes the storage and CRUD surface only.
	//
	// `config` is JSON-stringified by the caller before the route
	// hands it to `templates.create`/`update` so the templates module
	// stays ignorant of the SessionConfig schema. Validation happens
	// at the route boundary, before persist.

	router.post("/templates", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		const body = req.body as { name?: unknown; description?: unknown; config?: unknown };
		try {
			const { name, description } = parseTemplateBody(body);
			// Validate the config shape via the same `SessionConfigSchema`
			// the create-session route uses, with two flags flipped on for
			// the template path:
			//   - `allowSecretSlots: true` lets `secret-slot` env entries
			//     pass (POST /sessions rejects them — no value to spawn
			//     with — but templates EXPECT them).
			//   - `allowMissingAuth: true` tolerates a `repo.auth: "pat"` /
			//     `"ssh"` declaration without the matching credential,
			//     so the template preserves intent ("this template wants
			//     PAT auth") without persisting the PAT itself.
			// PR #228 round 1+2 BLOCKER+SHOULD-FIX.
			validateSessionConfig(body.config, {
				allowSecretSlots: true,
				allowMissingAuth: true,
			});
			// Belt-and-braces: the storage column is raw JSON, not the
			// AES-GCM-encrypted `auth_json` / `env_vars_json` columns
			// that `session_configs` uses. Reject plaintext secret
			// entries and live credentials at the route boundary so a
			// misbehaving client can't smuggle a PAT / SSH key into the
			// template row. PR #228 round 3 BLOCKER.
			assertTemplateConfigShape(body.config);
			const t = await templates.create(userId, {
				name,
				description,
				config: JSON.stringify(body.config),
			});
			res.status(201).json(serializeTemplate(t));
		} catch (err) {
			handleTemplateError(err, res);
		}
	});

	router.get("/templates", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		try {
			const list = await templates.listForUser(userId);
			// Summary shape — no `config`. The full template body is
			// fetched on demand via GET /:id when the user clicks
			// `Use template`. Keeps the list response small even with
			// a quota of 100 templates carrying ~256 KiB configs.
			res.json(list.map(serializeTemplateSummary));
		} catch (err) {
			handleTemplateError(err, res);
		}
	});

	router.get("/templates/:id", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		try {
			const t = await templates.getOwned(req.params.id, userId);
			res.json(serializeTemplate(t));
		} catch (err) {
			handleTemplateError(err, res);
		}
	});

	router.put("/templates/:id", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		const body = req.body as { name?: unknown; description?: unknown; config?: unknown };
		try {
			const { name, description } = parseTemplateBody(body);
			// Same flags as POST. The PUT path must accept exactly
			// the shapes the POST accepted; without symmetric flag
			// handling, a no-op rename of a template that already
			// has secret-slot env vars or a credential-less private
			// repo would 400 on every save.
			validateSessionConfig(body.config, {
				allowSecretSlots: true,
				allowMissingAuth: true,
			});
			assertTemplateConfigShape(body.config);
			const t = await templates.update(req.params.id, userId, {
				name,
				description,
				config: JSON.stringify(body.config),
			});
			res.json(serializeTemplate(t));
		} catch (err) {
			handleTemplateError(err, res);
		}
	});

	router.delete("/templates/:id", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		try {
			await templates.deleteTemplate(req.params.id, userId);
			res.status(204).send();
		} catch (err) {
			handleTemplateError(err, res);
		}
	});

	return router;
}

// ── Templates: shared helpers ────────────────────────────────────────────

/**
 * Bound caps for template metadata. `name` is shown in the sidebar
 * list and reused as the placeholder session name when "Use template"
 * fires; 64 chars matches the existing session-name cap so the same
 * UX assumption holds end-to-end. `description` is a free-form
 * tooltip-shape help string — 512 chars is generous without becoming
 * a row-bloat vector when many templates accumulate.
 */
const MAX_TEMPLATE_NAME_LEN = 64;
const MAX_TEMPLATE_DESCRIPTION_LEN = 512;

export class TemplateBodyError extends Error {
	constructor(
		message: string,
		public readonly path: string,
	) {
		super(message);
		this.name = "TemplateBodyError";
	}
}

/**
 * Reject live credential shapes — plaintext-`secret` env entries,
 * `auth.pat`, `auth.ssh.privateKey` — at the route boundary so they
 * can never land in `templates.config` (which is stored as raw JSON,
 * not encrypted via the `secrets.ts` AES-GCM path that
 * `session_configs` uses). The frontend save-as-template flow
 * (195b) is responsible for stripping these into `secret-slot`
 * markers + omitted-credential placeholders before submit; this
 * function is the server-side regression guard if a client
 * misbehaves. PR #228 round 3 BLOCKER.
 *
 * The shape we accept after this gate:
 *   - envVars: only `plain` and `secret-slot` (the latter is the
 *     placeholder a `Use template` flow re-prompts for);
 *   - auth: `repo.auth: "none" | "pat" | "ssh"` is fine, but
 *     `auth.pat` and `auth.ssh.privateKey` MUST be omitted —
 *     `validateSessionConfig`'s `allowMissingAuth` flag tolerates
 *     a `"pat"` / `"ssh"` declaration without the credential, so
 *     the template preserves intent without the secret.
 *   - everything else passes through.
 */
export function assertTemplateConfigShape(config: unknown): void {
	if (config === null || typeof config !== "object" || Array.isArray(config)) return;
	const c = config as Record<string, unknown>;
	const envVars = c.envVars;
	if (Array.isArray(envVars)) {
		for (const entry of envVars) {
			if (entry === null || typeof entry !== "object") continue;
			const t = (entry as { type?: unknown }).type;
			if (t === "secret") {
				throw new TemplateBodyError(
					"config.envVars: 'secret' entries are not allowed in templates; strip to 'secret-slot' before saving",
					"config.envVars",
				);
			}
		}
	}
	const auth = c.auth;
	if (auth !== null && typeof auth === "object" && !Array.isArray(auth)) {
		const a = auth as Record<string, unknown>;
		if (a.pat !== undefined) {
			throw new TemplateBodyError(
				"config.auth.pat: PAT credentials must not be stored in a template; the recipient re-supplies on use",
				"config.auth.pat",
			);
		}
		const ssh = a.ssh;
		if (
			ssh !== null &&
			typeof ssh === "object" &&
			(ssh as { privateKey?: unknown }).privateKey !== undefined
		) {
			throw new TemplateBodyError(
				"config.auth.ssh.privateKey: SSH key material must not be stored in a template; the recipient re-supplies on use",
				"config.auth.ssh.privateKey",
			);
		}
	}
}

export function parseTemplateBody(body: {
	name?: unknown;
	description?: unknown;
	config?: unknown;
}): {
	name: string;
	description: string | null;
} {
	if (typeof body.name !== "string") {
		throw new TemplateBodyError("name is required", "name");
	}
	// Trim BEFORE the length check + emptiness check so the API
	// contract ("names up to N characters are accepted") matches
	// the actual stored value. Without trim-first ordering, a
	// 65-char input that's mostly leading whitespace would be
	// rejected even though its trimmed form fits comfortably under
	// the cap.
	const name = body.name.trim();
	if (name === "") {
		throw new TemplateBodyError("name is required", "name");
	}
	if (name.length > MAX_TEMPLATE_NAME_LEN) {
		throw new TemplateBodyError(`name exceeds ${MAX_TEMPLATE_NAME_LEN} characters`, "name");
	}
	let description: string | null = null;
	if (body.description !== undefined && body.description !== null) {
		if (typeof body.description !== "string") {
			throw new TemplateBodyError("description must be a string", "description");
		}
		// Trim then collapse-empty-to-null. A `"   "` description
		// would otherwise persist with its whitespace and render
		// blank-looking in the UI while the column reports non-null
		// — a UX trap when the user thinks they cleared the field.
		const trimmed = body.description.trim();
		if (trimmed.length > MAX_TEMPLATE_DESCRIPTION_LEN) {
			throw new TemplateBodyError(
				`description exceeds ${MAX_TEMPLATE_DESCRIPTION_LEN} characters`,
				"description",
			);
		}
		description = trimmed === "" ? null : trimmed;
	}
	if (body.config === undefined || body.config === null) {
		throw new TemplateBodyError("config is required", "config");
	}
	// `typeof []` is `"object"` in JS, so a bare array would slip
	// past `typeof !== "object"` and reach `validateSessionConfig`,
	// where Zod surfaces a raw schema error instead of the cleaner
	// `TemplateBodyError` path. The Array guard keeps the boundary
	// error path consistent. PR #228 round 2 NIT.
	if (typeof body.config !== "object" || Array.isArray(body.config)) {
		throw new TemplateBodyError("config must be an object", "config");
	}
	return { name, description };
}

function serializeTemplate(t: templates.Template): {
	id: string;
	name: string;
	description: string | null;
	config: unknown;
	createdAt: string;
	updatedAt: string;
} {
	return {
		id: t.id,
		name: t.name,
		description: t.description,
		config: t.config,
		createdAt: t.createdAt.toISOString(),
		updatedAt: t.updatedAt.toISOString(),
	};
}

function serializeTemplateSummary(t: templates.TemplateSummary): {
	id: string;
	name: string;
	description: string | null;
	createdAt: string;
	updatedAt: string;
} {
	return {
		id: t.id,
		name: t.name,
		description: t.description,
		createdAt: t.createdAt.toISOString(),
		updatedAt: t.updatedAt.toISOString(),
	};
}

function handleTemplateError(err: unknown, res: Response): void {
	if (err instanceof NotFoundError) {
		res.status(404).json({ error: "Template not found" });
		return;
	}
	if (err instanceof ForbiddenError) {
		res.status(403).json({ error: "Forbidden" });
		return;
	}
	if (err instanceof templates.TemplateQuotaExceededError) {
		// 429 (Too Many Requests) matches the spec's "rate-limit-
		// shape" for "you're at your quota; the system isn't broken".
		// Mirrors the session-quota response code used by the
		// create-session route.
		res.status(429).json({ error: err.message });
		return;
	}
	if (err instanceof TemplateBodyError) {
		res.status(400).json({ error: err.message, path: err.path });
		return;
	}
	if (err instanceof SessionConfigValidationError) {
		res.status(400).json({ error: err.message, path: err.path });
		return;
	}
	logger.error(`[routes] template error: ${(err as Error).message}`);
	res.status(500).json({ error: "Internal server error" });
}

// POST /sessions input caps. Bound user-controlled fields at the
// request boundary so D1 rows and future name-rendering UI don't
// have to defend against multi-KB strings or absurd terminal sizes.
// 64 for the name matches USERNAME_MAX_LEN and the tab-label cap
// (same shape of "user-controlled string with no other natural
// limit"). 1024 for cols/rows is well above any realistic terminal
// (most clients stay under 500×200) and well below sizes that would
// upset xterm/tmux. See #149.
const SESSION_NAME_MAX_LEN = 64;
// Upper bound for any `user_id` we accept at the request boundary
// (group lead / group member). UUIDs are 36 chars; the 128 cap is
// headroom for any future ID format while keeping the value bounded
// well below `assertUserExists`'s D1 round-trip cost on malformed
// input. Used by the admin-group routes; see the trim-first
// validators there. #262 round 6 NIT.
const USER_ID_MAX_LEN = 128;
// Exported so wsHandler can apply the same upper bound when validating
// cols/rows from the WS upgrade URL — keep both guards moving together.
export const TERMINAL_DIM_MAX = 1024;

// Type-guard for the cols/rows numeric inputs on POST /sessions.
// Returns true only for finite integers in [1, TERMINAL_DIM_MAX] —
// rejects NaN, Infinity, floats, negatives, and absurd values that
// would persist in D1 even though tmux/xterm would clamp or refuse
// them at runtime.
function isValidTerminalDim(value: unknown): value is number {
	return (
		typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= TERMINAL_DIM_MAX
	);
}

function serializeMeta(m: SessionMeta) {
	return {
		sessionId: m.sessionId,
		name: m.name,
		status: m.status,
		containerId: m.containerId?.slice(0, 12) ?? null,
		containerName: m.containerName,
		createdAt: m.createdAt.toISOString(),
		lastConnectedAt: m.lastConnectedAt?.toISOString() ?? null,
		cols: m.cols,
		rows: m.rows,
		envVars: m.envVars,
	};
}

// ── Admin per-session usage serializer (#270) ──────────────────────────────

// Round to one decimal so a multi-session totals card doesn't drift
// past visible precision (a wedged 0.0001% CPU sample × 100 sessions
// shouldn't dominate the displayed total). Math.round/10 over the
// dotted toFixed pattern so JSON serialises a `number`, not a string
// the frontend would have to re-parse.
function r1(n: number): number {
	return Math.round(n * 10) / 10;
}

/** Wire serialiser for the per-session usage column (null when the
 *  fetch failed or the session isn't running). Numbers are rounded to
 *  1 decimal place — the cgroup samples are noisy enough that extra
 *  precision is misleading. */
function serializeUsage(stats: ReturnType<StatsBySession["get"]>) {
	if (stats === null || stats === undefined) return null;
	return {
		cpuPercent: r1(stats.cpuPercent),
		memBytes: stats.memBytes,
		memLimitBytes: stats.memLimitBytes,
		memPercent: r1(stats.memPercent),
	};
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
	const caps = await listResourceCaps(running.map((s) => s.sessionId));
	const stats = await docker.gatherStats(
		running.map((s) => ({ sessionId: s.sessionId, containerId: s.containerId })),
	);
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

/**
 * Validate a tab label for the /sessions/:id/tabs POST body. Returns an
 * error string suitable for a 400, or null if the label is acceptable
 * (including the `undefined` case — omitted labels fall back to tabId
 * inside DockerManager.createTab). See the JSDoc on createTab for the
 * TSV-parser constraints these rules enforce (issue #92).
 *
 * The order matters — we reject the cheapest-to-detect problems first,
 * so a malformed body gets a fast 400 without running the control-char
 * regex.
 */
function validateTabLabel(label: unknown): string | null {
	if (label === undefined) return null;
	if (typeof label !== "string") return "label must be a string";
	if (label.length === 0) return "label must not be empty";
	if (label.length > 64) return "label must be at most 64 characters";
	// Reject leading/trailing whitespace explicitly rather than silently
	// trimming downstream. If we trimmed we'd have "what the client sent
	// ≠ what's stored", and future GETs would surface the normalised form
	// — a surprise the client can't see coming. A strict 400 lets the
	// caller fix its own UX (e.g. trim the input field) instead.
	if (label !== label.trim()) return "label must not have leading or trailing whitespace";
	// ASCII-control block rejection. \t and \n break the TSV parser in
	// listTabs; \r is silently stripped by execOneShot's demux (stored
	// label wouldn't match the sent label). Higher code points (emoji,
	// non-Latin scripts, typographic punctuation) are opaque to the
	// parser and kept as-is.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars IS the rejection criterion
	if (/[\u0000-\u001F\u007F]/.test(label)) {
		return "label must not contain control characters (tab, newline, etc.)";
	}
	return null;
}

function handleSessionError(err: unknown, res: Response): void {
	if (err instanceof NotFoundError) {
		res.status(404).json({ error: err.message });
	} else if (err instanceof ForbiddenError) {
		res.status(403).json({ error: err.message });
	} else if (err instanceof UploadQuotaExceededError) {
		// 413 Payload Too Large is the HTTP-spec answer for "request
		// would push you past a server-enforced size cap".
		// err.message is intentionally generic — no byte counts —
		// and the structured used/attempted/quota fields are logged
		// server-side by writeUploads at the throw site, never
		// surfaced in the response. Two-layer suppression so a
		// future tweak to either side doesn't silently leak per-
		// session usage to the client.
		res.status(413).json({ error: err.message });
	} else {
		logger.error(`[routes] unexpected error: ${(err as Error).message}`);
		res.status(500).json({ error: "Internal server error" });
	}
}
