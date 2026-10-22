/**
 * routes/git.ts — Git Changes view: read-only git state of a session's
 * workspace.
 *
 *   GET /sessions/:id/git/status[?dir=]              branch + changed files + line counts
 *   GET /sessions/:id/git/diff?path=&area=[&oldPath=][&dir=]  one file's patch
 *   GET /sessions/:id/git/log[?dir=]                 recent commits
 *
 * Strictly read-only: there is no stage / commit / checkout / reset /
 * push here, and nothing a client sends is ever interpreted as a
 * command — see gitReadOnly.ts for the argv discipline and for WHY git
 * runs inside the session container (which is also why these answer
 * 409 for a session that isn't running, unlike the Files routes).
 *
 * Authorization is OWNER-ONLY via `assertOwnedByOr404`, identical to the
 * Workspace Explorer routes and for the same reason: no audit trail
 * exists for "lead/admin read this diff", so the observe/operate tiers
 * are deliberately not used.
 */

import type { Request, Response, Router } from "express";
import type { AuthedRequest } from "../auth.js";
import { requireAuth } from "../auth.js";
import { ContainerNotFoundError } from "../dockerManager.js";
import {
	GitError,
	getGitDiff,
	getGitLog,
	getGitStatus,
	makeGitRunner,
	parseArea,
	validateGitDir,
	validateGitPath,
} from "../gitReadOnly.js";
import { InFlightLimiter } from "../inFlightLimiter.js";
import { logger } from "../logger.js";
import { isRestrictedPath, type WorkspaceFsError } from "../workspaceFiles.js";
import { holdSlotUntilResponseEnds } from "./files.js";
import { assertOwnedByOr404, handleSessionError, type RouteContext } from "./shared.js";

// Concurrency: each request is 1–4 docker execs holding up to 2 MiB of
// output apiece. Per user, one status refresh plus one diff in flight is
// the interactive maximum; process-wide, 8 keeps a burst of users from
// stacking dozens of git processes on the daemon.
export const GIT_IN_FLIGHT_PER_USER = 2;
export const GIT_IN_FLIGHT_TOTAL = 8;

function sendFsError(res: Response, err: WorkspaceFsError): void {
	res.status(err.status).json({ error: err.error });
}

function sendGitError(res: Response, err: GitError): void {
	// 504 for a timeout (the container's git didn't answer in time), 409
	// for a repo git refuses to touch, 502 for any other git failure —
	// none of them are this server's fault, and the frontend keys its
	// message off `code`, not the status.
	const status = err.code === "timeout" ? 504 : err.code === "unsafe-repository" ? 409 : 502;
	res.status(status).json({ error: err.message, code: err.code });
}

function isDockerNotRunning(err: unknown): boolean {
	if (err instanceof ContainerNotFoundError) return true;
	// dockerode surfaces the daemon's "container X is not running" as a
	// 409 with that message; a container removed under us is a 404.
	const e = err as { statusCode?: number; message?: string };
	return e.statusCode === 409 || e.statusCode === 404;
}

export function registerGitRoutes(router: Router, ctx: RouteContext): void {
	const { sessions, docker } = ctx;
	const { gitIp } = ctx.limiters;
	const slots = new InFlightLimiter(GIT_IN_FLIGHT_PER_USER, GIT_IN_FLIGHT_TOTAL);

	/**
	 * Shared preamble: validate `dir`, authorize, require a running
	 * container, take a slot. Returns the runner, or null when the
	 * response has already been answered.
	 */
	async function prepare(
		req: Request,
		res: Response,
	): Promise<{ runner: ReturnType<typeof makeGitRunner>; dir: string } | null> {
		const { userId } = req as AuthedRequest;
		const dir = validateGitDir(req.query.dir);
		if (typeof dir !== "string") {
			sendFsError(res, dir);
			return null;
		}
		// Ownership BEFORE anything else; foreign == missing.
		await assertOwnedByOr404(sessions, req.params.id, userId);
		const meta = await sessions.getOrThrow(req.params.id);
		if (meta.status !== "running" || !meta.containerId) {
			res.status(409).json({
				error: "Session is not running — start it to view git changes",
				code: "session-not-running",
			});
			return null;
		}
		const outcome = holdSlotUntilResponseEnds(slots, userId, res);
		if (outcome === "gone") return null;
		if (outcome === "busy") {
			res.setHeader("Retry-After", "1");
			res.status(429).json({ error: "Too many git requests in progress, try again shortly" });
			return null;
		}
		// Git output is a snapshot of a tree that changes under the user —
		// never let any cache answer for it.
		res.setHeader("Cache-Control", "no-store");
		return { runner: makeGitRunner(docker, req.params.id, meta.containerId), dir };
	}

	function handleError(err: unknown, res: Response, sessionId: string): void {
		if (err instanceof GitError) {
			sendGitError(res, err);
			return;
		}
		if (isDockerNotRunning(err)) {
			res.status(409).json({
				error: "Session is not running — start it to view git changes",
				code: "session-not-running",
			});
			return;
		}
		if (res.headersSent) return;
		logger.warn(`[routes] git request failed for session ${sessionId}: ${(err as Error).message}`);
		handleSessionError(err, res);
	}

	router.get("/sessions/:id/git/status", requireAuth, gitIp, async (req, res) => {
		try {
			const prepared = await prepare(req, res);
			if (!prepared) return;
			res.json(await getGitStatus(prepared.runner, prepared.dir));
		} catch (err) {
			handleError(err, res, req.params.id);
		}
	});

	router.get("/sessions/:id/git/diff", requireAuth, gitIp, async (req, res) => {
		const path = validateGitPath(req.query.path);
		if (typeof path !== "string") {
			sendFsError(res, path);
			return;
		}
		const area = parseArea(req.query.area);
		if (area === null) {
			res
				.status(400)
				.json({ error: "query param 'area' must be staged|unstaged|untracked|conflict" });
			return;
		}
		let oldPath: string | null = null;
		if (req.query.oldPath !== undefined) {
			const v = validateGitPath(req.query.oldPath);
			if (typeof v !== "string") {
				sendFsError(res, v);
				return;
			}
			oldPath = v;
		}
		// Same credential denylist as the Files view: a `.env` that someone
		// committed is exactly the diff this surface must not show.
		if (isRestrictedPath(path) || (oldPath !== null && isRestrictedPath(oldPath))) {
			res.status(403).json({ error: "This path is restricted because it may contain credentials" });
			return;
		}
		try {
			const prepared = await prepare(req, res);
			if (!prepared) return;
			res.json(await getGitDiff(prepared.runner, prepared.dir, { path, oldPath, area }));
		} catch (err) {
			handleError(err, res, req.params.id);
		}
	});

	router.get("/sessions/:id/git/log", requireAuth, gitIp, async (req, res) => {
		try {
			const prepared = await prepare(req, res);
			if (!prepared) return;
			res.json({ commits: await getGitLog(prepared.runner, prepared.dir) });
		} catch (err) {
			handleError(err, res, req.params.id);
		}
	});
}
