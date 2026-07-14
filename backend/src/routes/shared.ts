/**
 * routes/shared.ts — cross-surface context + helpers for the split route
 * modules (#311). `routes.ts` builds one `RouteContext` and threads it into
 * each `registerX(router, ctx)` function; helpers used by more than one
 * surface live here so the per-surface files don't re-declare them.
 */

import type { Response } from "express";
import type { BootstrapBroadcaster } from "../bootstrap.js";
import type { StatsBySession } from "../containerStats.js";
import type { DockerManager } from "../dockerManager.js";
import { UploadQuotaExceededError } from "../dockerManager.js";
import type { ExecRegistry } from "../execRegistry.js";
import type { IdleSweeperStats } from "../idleSweeper.js";
import { logger } from "../logger.js";
import type { createAuthRateLimiters, RateLimitConfig, UsernameRateLimiter } from "../rateLimit.js";
import type { SessionManager } from "../sessionManager.js";
import { ForbiddenError, NotFoundError } from "../sessionManager.js";
import type { SessionMeta } from "../types.js";

// Mirrors the optional-sweeper shape `buildRouter` accepts (tests build a
// router without one). Defined once so the buildRouter signature and the
// context type can't drift.
export type RouteIdleSweeper = {
	bump: (sessionId: string) => void;
	forget: (sessionId: string) => void;
	getStats?: () => IdleSweeperStats;
};

/**
 * Shared dependencies handed to every `registerX(router, ctx)` function.
 * Each surface destructures exactly the fields it uses (often re-binding to
 * the same local names the handler bodies already reference), so the bodies
 * move verbatim out of the old single closure.
 */
export interface RouteContext {
	sessions: SessionManager;
	docker: DockerManager;
	broadcaster: BootstrapBroadcaster;
	idleSweeper?: RouteIdleSweeper;
	rateLimitConfig: RateLimitConfig;
	limiters: ReturnType<typeof createAuthRateLimiters>;
	usernameLimiter: UsernameRateLimiter;
	// #381 — per-router so tests get isolation for free; production has
	// exactly one router, so this is effectively the process singleton.
	execRegistry: ExecRegistry;
}

// Exported so wsHandler can apply the same upper bound when validating
// cols/rows from the WS upgrade URL — keep both guards moving together.
export const TERMINAL_DIM_MAX = 1024;

// Round to one decimal so a multi-session totals card doesn't drift
// past visible precision (a wedged 0.0001% CPU sample × 100 sessions
// shouldn't dominate the displayed total). Math.round/10 over the
// dotted toFixed pattern so JSON serialises a `number`, not a string
// the frontend would have to re-parse.
export function r1(n: number): number {
	return Math.round(n * 10) / 10;
}

/** Wire serialiser for the per-session usage column (null when the
 *  fetch failed or the session isn't running). Numbers are rounded to
 *  1 decimal place — the cgroup samples are noisy enough that extra
 *  precision is misleading. */
export function serializeUsage(stats: ReturnType<StatsBySession["get"]>) {
	if (stats === null || stats === undefined) return null;
	return {
		cpuPercent: r1(stats.cpuPercent),
		memBytes: stats.memBytes,
		memLimitBytes: stats.memLimitBytes,
		memPercent: r1(stats.memPercent),
	};
}

export function serializeMeta(m: SessionMeta): {
	sessionId: string;
	name: string;
	status: SessionMeta["status"];
	containerId: string | null;
	containerName: string;
	createdAt: string;
	lastConnectedAt: string | null;
	cols: number;
	rows: number;
	envVars: Record<string, string>;
	cpuLimit: number | null;
	memLimit: number | null;
	usage: ReturnType<typeof serializeUsage>;
} {
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
		// #270 / #271 added these to the /sessions list response. Every
		// other single-session endpoint (POST /sessions, GET /:id,
		// POST /:id/start, POST /:id/stop) returns serializeMeta
		// directly — without these defaults the frontend's `SessionInfo`
		// shape has `cpuLimit/memLimit/usage` missing, and
		// `renderSessionList`'s `s.usage !== null` guard reads `undefined`
		// (truthy on `!== null`), then `.cpuPercent` access throws on
		// the newly-created session. Default to null here so every
		// response is shape-consistent; the list route's `...spread`
		// overrides with real values when it has them.
		cpuLimit: null,
		memLimit: null,
		usage: null,
	};
}

export function handleSessionError(err: unknown, res: Response): void {
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
