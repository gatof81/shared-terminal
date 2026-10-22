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
import { assertOwnedByOr404, handleSessionError, type RouteContext } from "./shared.js";

// Concurrency: each request is 1–4 docker execs holding up to 2 MiB of
// output apiece. Per user, one status refresh plus one diff in flight is
// the interactive maximum; process-wide, 8 keeps a burst of users from
// stacking dozens of git processes on the daemon. The frontend
// sequences its own requests to stay within the per-user cap.
export const GIT_IN_FLIGHT_PER_USER = 2;
export const GIT_IN_FLIGHT_TOTAL = 8;

function sendFsError(res: Response, err: WorkspaceFsError): void {
	res.status(err.status).json({ error: err.error });
}

const GIT_ERROR_STATUS: Record<GitError["code"], number> = {
	// 504 for a timeout (the container's git didn't answer in time), 409
	// for a repo git refuses to touch, 502 for any other git failure —
	// none of them are this server's fault, and the frontend keys its
	// message off `code`, not the status.
	timeout: 504,
	"unsafe-repository": 409,
	"not-a-repo": 502,
	"git-failed": 502,
	// Request-shaped refusals from the identification step (gitReadOnly.ts).
	"outside-workspace": 403,
	restricted: 403,
	"not-a-single-file": 400,
};

function sendGitError(res: Response, err: GitError): void {
	res.status(GIT_ERROR_STATUS[err.code]).json({ error: err.message, code: err.code });
}

/**
 * Take an in-flight slot and keep it until BOTH the handler's work has
 * settled and the response has ended. Returning the slot on the
 * response's `close` alone (the Files view's shape, right for a stream
 * the client drains) would be wrong here: a client that disconnects
 * leaves the git processes running in the container — there is no way
 * to cancel a docker exec — so the limit must follow the work, or six
 * aborted requests become six concurrent git runs for one user. The
 * returned function is what the handler calls when its work is done
 * (success or failure); release happens once the response has ended too.
 */
function holdSlotUntilWorkAndResponseEnd(
	slots: InFlightLimiter,
	userId: string,
	res: Response,
): (() => void) | "busy" | "gone" {
	// Never acquire for a response that already closed: its `close` has
	// fired and will not fire again, so nothing would release the slot.
	if (res.destroyed || res.writableEnded || res.socket?.destroyed) return "gone";
	const release = slots.tryAcquire(userId);
	if (release === null) return "busy";
	let workDone = false;
	let responseDone = false;
	const maybeRelease = () => {
		if (workDone && responseDone) release();
	};
	const onResponseEnd = () => {
		responseDone = true;
		maybeRelease();
	};
	res.once("finish", onResponseEnd);
	res.once("close", onResponseEnd);
	return () => {
		workDone = true;
		maybeRelease();
	};
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
	 * container, take a slot. Returns the runner plus the `done` callback
	 * the handler MUST call once its work settled, or null when the
	 * response has already been answered.
	 */
	async function prepare(
		req: Request,
		res: Response,
	): Promise<{ runner: ReturnType<typeof makeGitRunner>; dir: string; done: () => void } | null> {
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
		const done = holdSlotUntilWorkAndResponseEnd(slots, userId, res);
		if (done === "gone") return null;
		if (done === "busy") {
			res.setHeader("Retry-After", "1");
			res.status(429).json({ error: "Too many git requests in progress, try again shortly" });
			return null;
		}
		// Git output is a snapshot of a tree that changes under the user —
		// never let any cache answer for it.
		res.setHeader("Cache-Control", "no-store");
		return { runner: makeGitRunner(docker, req.params.id, meta.containerId), dir, done };
	}

	/** prepare → work → answer, with the slot held until the work settled. */
	async function serve(
		req: Request,
		res: Response,
		work: (runner: ReturnType<typeof makeGitRunner>, dir: string) => Promise<unknown>,
	): Promise<void> {
		let done: (() => void) | null = null;
		try {
			const prepared = await prepare(req, res);
			if (!prepared) return;
			done = prepared.done;
			const body = await work(prepared.runner, prepared.dir);
			// A client that left mid-work gets nothing written; the slot
			// is still released only now, when git has actually finished.
			if (!res.writableEnded && !res.destroyed) res.json(body);
		} catch (err) {
			handleError(err, res, req.params.id);
		} finally {
			done?.();
		}
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

	router.get("/sessions/:id/git/status", requireAuth, gitIp, (req, res) =>
		serve(req, res, (runner, dir) => getGitStatus(runner, dir)),
	);

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
		// committed is exactly the diff this surface must not show. This is
		// the cheap early refusal; gitReadOnly.ts re-applies the list to
		// the names GIT resolves (a directory pathspec, a rename's old
		// side), which is the check that actually holds.
		if (isRestrictedPath(path) || (oldPath !== null && isRestrictedPath(oldPath))) {
			res.status(403).json({ error: "This path is restricted because it may contain credentials" });
			return;
		}
		await serve(req, res, (runner, dir) => getGitDiff(runner, dir, { path, oldPath, area }));
	});

	router.get("/sessions/:id/git/log", requireAuth, gitIp, (req, res) =>
		serve(req, res, async (runner, dir) => ({ commits: await getGitLog(runner, dir) })),
	);
}
