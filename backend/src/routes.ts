/**
 * routes.ts — REST API router assembly.
 *
 * The route handlers live in per-surface modules under `routes/` (#311);
 * this file is the thin orchestrator: it builds the shared `RouteContext`,
 * registers each surface in the original order (which is load-bearing —
 * the auth-prefix `requireAuth` mounts and the idle-bump middleware must
 * sit between the public auth routes and the authed surfaces), and
 * re-exports the small public API other modules/tests import from here.
 */

import { Router } from "express";
import { requireAuth } from "./auth.js";
import type { BootstrapBroadcaster } from "./bootstrap.js";
import type { DockerManager } from "./dockerManager.js";
import { ExecRegistry } from "./execRegistry.js";
import type { RateLimitConfig } from "./rateLimit.js";
import {
	createAuthRateLimiters,
	DEFAULT_RATE_LIMIT_CONFIG,
	UsernameRateLimiter,
} from "./rateLimit.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerExecRoutes } from "./routes/exec.js";
import { registerGroupRoutes } from "./routes/groups.js";
import { registerInviteRoutes } from "./routes/invites.js";
import { registerPushRoutes } from "./routes/push.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import type { RouteContext, RouteIdleSweeper } from "./routes/shared.js";
import { registerTemplateRoutes } from "./routes/templates.js";
import type { SessionManager } from "./sessionManager.js";

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
	idleSweeper?: RouteIdleSweeper,
): Router {
	const router = Router();

	const limiters = createAuthRateLimiters(rateLimitConfig);
	const usernameLimiter = new UsernameRateLimiter(
		rateLimitConfig.login.usernameMax,
		rateLimitConfig.login.usernameWindowMs,
	);

	const ctx: RouteContext = {
		sessions,
		docker,
		broadcaster,
		idleSweeper,
		rateLimitConfig,
		limiters,
		usernameLimiter,
		execRegistry: new ExecRegistry(),
	};

	// ── Auth routes (public) ────────────────────────────────────────────────
	registerAuthRoutes(router, ctx);

	// ── Authenticated route prefixes ────────────────────────────────────────

	router.use("/invites", requireAuth);
	router.use("/sessions", requireAuth);
	router.use("/templates", requireAuth);
	router.use("/admin", requireAuth);
	// /groups is the lead-side surface (#201c) — auth-gated but NOT
	// admin-gated. Admin-only group management lives under /admin/groups
	// (registered below); this prefix carries `GET /groups/mine[/sessions]`
	// which any authed user may call (a non-lead just gets `[]` back).
	// Adding the prefix here keeps the auth-mount block in one place.
	router.use("/groups", requireAuth);
	// Web Push subscription management (#355) — authed, per-user.
	router.use("/push", requireAuth);

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

	// Authenticated surfaces, in the original registration order (Express
	// matches in order; overlapping paths like `/sessions/:id` vs
	// `/sessions/:id/tabs` rely on this sequence not changing).
	registerInviteRoutes(router, ctx);
	registerPushRoutes(router, ctx);
	registerAdminRoutes(router, ctx);
	registerGroupRoutes(router, ctx);
	registerSessionRoutes(router, ctx);
	registerExecRoutes(router, ctx);
	registerTemplateRoutes(router, ctx);

	return router;
}

// Public API re-exported for back-compat with existing importers:
//   - TERMINAL_DIM_MAX: wsHandler.ts (shared cols/rows upper bound)
//   - TemplateBodyError / assertTemplateConfigShape / parseTemplateBody:
//     the templates route tests
export { TERMINAL_DIM_MAX } from "./routes/shared.js";
export {
	assertTemplateConfigShape,
	parseTemplateBody,
	TemplateBodyError,
} from "./routes/templates.js";
