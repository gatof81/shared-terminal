/**
 * routes/auth.ts — public auth surface (#311): /auth/status, /auth/register,
 * /auth/login, /auth/logout. Split out of routes.ts verbatim; the handler
 * bodies reference the rate limiters / username limiter by the same local
 * names the old closure used, re-bound from `ctx` below.
 */

import type { Request, Response, Router } from "express";
import {
	AUTH_COOKIE_NAME,
	clearAuthCookie,
	extractTokenFromCookieHeader,
	hasAnyUsers,
	InvalidCredentialsError,
	InviteRequiredError,
	loginUser,
	registerUser,
	setAuthCookie,
	UsernameTakenError,
	verifyJwt,
} from "../auth.js";
import { d1Query } from "../db.js";
import * as groups from "../groups.js";
import { logger } from "../logger.js";
import { EFFECTIVE_CPU_NANO_MAX, EFFECTIVE_MEM_BYTES_MAX } from "../sessionConfig.js";
import type { RouteContext } from "./shared.js";

export function registerAuthRoutes(router: Router, ctx: RouteContext): void {
	const { usernameLimiter, rateLimitConfig } = ctx;
	const { loginIp, registerIp, logoutIp, authStatusIp } = ctx.limiters;
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
		// Trim and reject whitespace-only (#307): a blank-looking username
		// would otherwise be stored verbatim and render blank in the sidebar.
		// Mirrors the trim-then-check convention used for session / group /
		// template names. The trimmed value is what gets persisted.
		const trimmedUsername = username.trim();
		if (!trimmedUsername) {
			res.status(400).json({ error: "username and password (min 6 chars) required" });
			return;
		}
		if (trimmedUsername.length > USERNAME_MAX_LEN) {
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
			const result = await registerUser(trimmedUsername, password, trimmedInviteCode);
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
		// Trim to match the stored (trimmed) username from register (#307),
		// and reject whitespace-only. Used consistently below so the
		// per-username limiter buckets the same identity register stored.
		const trimmedUsername = username.trim();
		if (!trimmedUsername) {
			res.status(400).json({ error: "username and password required" });
			return;
		}
		if (trimmedUsername.length > USERNAME_MAX_LEN) {
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
		const check = usernameLimiter.beginAttempt(trimmedUsername);
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
				result = await loginUser(trimmedUsername, password);
			} catch (err) {
				if (err instanceof InvalidCredentialsError) {
					// Only bad creds count — infra errors must not lock real users out.
					usernameLimiter.recordFailure(trimmedUsername);
					res.status(401).json({ error: err.message });
					return;
				}
				// Username omitted from the log to avoid an enumeration vector.
				logger.error(`[auth] login failed unexpectedly: ${(err as Error).message}`);
				res.status(500).json({ error: "Internal server error" });
				return;
			}
			usernameLimiter.reset(trimmedUsername);
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
			usernameLimiter.endAttempt(trimmedUsername);
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
}
