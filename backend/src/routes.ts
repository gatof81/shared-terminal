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
import { d1Query } from "./db.js";
import type { DockerManager } from "./dockerManager.js";
import { UploadQuotaExceededError } from "./dockerManager.js";
import { EnvVarValidationError, validateEnvVars } from "./envVarValidation.js";
import { logger } from "./logger.js";
import type { RateLimitConfig } from "./rateLimit.js";
import {
	createAuthRateLimiters,
	DEFAULT_RATE_LIMIT_CONFIG,
	UsernameRateLimiter,
} from "./rateLimit.js";
import {
	encryptAuthCredentials,
	encryptSecretEntries,
	isEmptyConfig,
	type PersistableSessionConfig,
	persistSessionConfig,
	type SessionConfig,
	SessionConfigValidationError,
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
	idleSweeper?: { bump: (sessionId: string) => void; forget: (sessionId: string) => void },
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
		// requiring users to log out and back in. Falls back to false on
		// lookup failure or unauthenticated callers — UI should treat
		// the boolean as "show admin features" only when explicitly true.
		const reqWithCookies = req as Request & {
			cookies?: Record<string, string | undefined>;
		};
		const token =
			reqWithCookies.cookies?.[AUTH_COOKIE_NAME] ??
			extractTokenFromCookieHeader(req.headers.cookie) ??
			undefined;
		const payload = verifyJwt(token);
		const authenticated = payload !== null;
		// Run the admin-lookup and hasAnyUsers in parallel — they have
		// no data dependency, and CLAUDE.md flags D1 round-trips as the
		// expensive thing on hot paths. The admin lookup catches its
		// own error (surfaces as isAdmin=false); hasAnyUsers throwing
		// is a real boot-state failure and propagates to the 500 handler.
		const [adminLookup, anyUsers] = await Promise.all([
			payload
				? d1Query<{ is_admin: number }>("SELECT is_admin FROM users WHERE id = ?", [
						payload.sub,
					]).catch(() => null)
				: Promise.resolve(null),
			hasAnyUsers(),
		]);
		const isAdmin = adminLookup?.results[0]?.is_admin === 1;
		res.json({ needsSetup: !anyUsers, authenticated, isAdmin });
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
			res.status(201).json({ userId: result.userId, isAdmin: result.isAdmin });
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

		let result: { userId: string; token: string; isAdmin: boolean };
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
			res.json({ userId: result.userId, isAdmin: result.isAdmin });
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
			await sessions.assertOwnership(req.params.id, userId);
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
			await sessions.assertOwnership(req.params.id, userId);
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
			await sessions.assertOwnership(req.params.id, userId);
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
			await sessions.assertOwnership(req.params.id, userId);
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
			await sessions.assertOwnership(id, userId);

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
			await sessions.assertOwnership(req.params.id, (req as AuthedRequest).userId);
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
			res.json(list.map(serializeTemplate));
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

class TemplateBodyError extends Error {
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
function assertTemplateConfigShape(config: unknown): void {
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

function parseTemplateBody(body: { name?: unknown; description?: unknown; config?: unknown }): {
	name: string;
	description: string | null;
} {
	if (typeof body.name !== "string" || body.name.trim() === "") {
		throw new TemplateBodyError("name is required", "name");
	}
	if (body.name.length > MAX_TEMPLATE_NAME_LEN) {
		throw new TemplateBodyError(`name exceeds ${MAX_TEMPLATE_NAME_LEN} characters`, "name");
	}
	let description: string | null = null;
	if (body.description !== undefined && body.description !== null) {
		if (typeof body.description !== "string") {
			throw new TemplateBodyError("description must be a string", "description");
		}
		if (body.description.length > MAX_TEMPLATE_DESCRIPTION_LEN) {
			throw new TemplateBodyError(
				`description exceeds ${MAX_TEMPLATE_DESCRIPTION_LEN} characters`,
				"description",
			);
		}
		description = body.description;
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
	return { name: body.name.trim(), description };
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

function handleTemplateError(err: unknown, res: Response): void {
	if (err instanceof NotFoundError) {
		res.status(404).json({ error: "Template not found" });
		return;
	}
	if (err instanceof ForbiddenError) {
		res.status(403).json({ error: "Forbidden" });
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
