/**
 * routes.ts — REST API routes.
 */

import { Router, Request, Response } from "express";
import {
        AuthedRequest, requireAuth, registerUser, loginUser, hasAnyUsers,
        InvalidCredentialsError, InviteRequiredError, UsernameTakenError,
        InviteQuotaExceededError,
        createInvite, listInvites, revokeInvite,
} from "./auth.js";
import { SessionManager, NotFoundError, ForbiddenError } from "./sessionManager.js";
import { DockerManager } from "./dockerManager.js";
import { SessionMeta } from "./types.js";
import {
        RateLimitConfig,
        DEFAULT_RATE_LIMIT_CONFIG,
        createAuthRateLimiters,
        UsernameRateLimiter,
} from "./rateLimit.js";

export function buildRouter(
        sessions: SessionManager,
        docker: DockerManager,
        rateLimitConfig: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,
): Router {
        const router = Router();

        // ── Auth routes (public) ────────────────────────────────────────────────

        const { loginIp, registerIp, invitesIp } = createAuthRateLimiters(rateLimitConfig);
        const usernameLimiter = new UsernameRateLimiter(
                rateLimitConfig.login.usernameMax,
                rateLimitConfig.login.usernameWindowMs,
        );
        // Cap username length at the request boundary so huge strings can't
        // land in the limiter map or D1.
        const USERNAME_MAX_LEN = 64;

        router.get("/auth/status", async (_req: Request, res: Response) => {
                res.json({ needsSetup: !(await hasAnyUsers()) });
        });

        router.post("/auth/register", registerIp, async (req: Request, res: Response) => {
                const { username, password, inviteCode } = req.body as {
                        username?: string; password?: string; inviteCode?: string;
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
                        res.status(201).json(result);
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
                        console.error(`[auth] register failed unexpectedly:`, (err as Error).message);
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
                const check = usernameLimiter.check(username);
                if (!check.allowed) {
                        const windowSeconds = Math.ceil(rateLimitConfig.login.usernameWindowMs / 1000);
                        res.setHeader("Retry-After", String(check.retryAfterSeconds));
                        res.setHeader(
                                "RateLimit-Policy",
                                `${rateLimitConfig.login.usernameMax};w=${windowSeconds}`,
                        );
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

                // Concurrency note: check() is sync but loginUser is async, so
                // `max + parallelism` slippage is possible in theory. Today
                // parallelism is effectively 1 because loginUser uses
                // `bcrypt.compareSync`, which blocks the event loop — that
                // synchronous call is what pins the bound, not an explicit
                // mutex. Swapping to the async `bcrypt.compare` removes the
                // guarantee, so either add queueing or re-check the limit
                // after the await.
                let result: { userId: string; token: string };
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
                        console.error(`[auth] login failed unexpectedly:`, (err as Error).message);
                        res.status(500).json({ error: "Internal server error" });
                        return;
                }
                usernameLimiter.reset(username);
                res.json(result);
        });

        // ── Authenticated route prefixes ────────────────────────────────────────
        // Grouped so an auth-coverage audit is a single scan rather than a
        // file-wide search. Order doesn't affect correctness — each `use(path,
        // middleware)` only runs for routes mounted on that path *afterwards*.

        router.use("/invites", requireAuth);
        router.use("/sessions", requireAuth);

        // ── Invite routes ───────────────────────────────────────────────────────
        // Any authenticated user can mint invites — there is no admin tier yet.
        // If you ever want to gate this to specific accounts, add an is_admin
        // column to users and a middleware check here.

        router.get("/invites", async (req: Request, res: Response) => {
                const { userId } = req as AuthedRequest;
                try {
                        const invites = await listInvites(userId);
                        res.json(invites);
                } catch (err) {
                        console.error(`[invites] list failed:`, (err as Error).message);
                        res.status(500).json({ error: "Internal server error" });
                }
        });

        router.post("/invites", invitesIp, async (req: Request, res: Response) => {
                const { userId } = req as AuthedRequest;
                try {
                        const invite = await createInvite(userId);
                        res.status(201).json(invite);
                } catch (err) {
                        if (err instanceof InviteQuotaExceededError) {
                                res.status(429).json({ error: err.message });
                                return;
                        }
                        console.error(`[invites] create failed:`, (err as Error).message);
                        res.status(500).json({ error: "Internal server error" });
                }
        });

        router.delete("/invites/:code", async (req: Request, res: Response) => {
                const { userId } = req as AuthedRequest;
                const { code } = req.params;
                // Same 64-char ceiling as the inviteCode body field at register —
                // codes mint at 16 hex chars, anything larger is a probe and
                // shouldn't reach D1 even as a parameterized arg.
                if (code.length > 64) {
                        res.status(400).json({ error: "code must be at most 64 characters" });
                        return;
                }
                try {
                        const removed = await revokeInvite(userId, code);
                        if (!removed) {
                                // Vague on purpose: don't distinguish missing / already-used /
                                // owned-by-someone-else, since that would let a caller probe for
                                // codes outside their ownership.
                                res.status(404).json({ error: "Invite not found or already used" });
                                return;
                        }
                        res.status(204).send();
                } catch (err) {
                        console.error(`[invites] revoke failed:`, (err as Error).message);
                        res.status(500).json({ error: "Internal server error" });
                }
        });

        // ── Session routes ──────────────────────────────────────────────────────

        router.post("/sessions", async (req: Request, res: Response) => {
                const { userId } = req as AuthedRequest;
                const { name, cols, rows, envVars } = req.body as {
                        name?: string; cols?: number; rows?: number; envVars?: Record<string, string>;
                };
                if (!name || typeof name !== "string") {
                        res.status(400).json({ error: "body.name is required" });
                        return;
                }
                try {
                        const meta = await sessions.create({ userId, name, cols, rows, envVars });
                        await docker.spawn(meta.sessionId);
                        const updated = await sessions.get(meta.sessionId);
                        res.status(201).json(serializeMeta(updated!));
                } catch (err) {
                        console.error(`[routes] session create failed:`, (err as Error).message);
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
                        }

                        if (hard) {
                                // Wipe workspace files and drop the row entirely.
                                try {
                                        await docker.purgeWorkspace(req.params.id);
                                } catch (err) {
                                        console.error(`[routes] purgeWorkspace failed for ${req.params.id}:`, (err as Error).message);
                                        // Fall through — we still want to remove the row.
                                }
                                await sessions.deleteRow(req.params.id);
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
                        const updated = await sessions.get(req.params.id);
                        res.json(serializeMeta(updated!));
                } catch (err) {
                        handleSessionError(err, res);
                }
        });

        router.post("/sessions/:id/start", async (req: Request, res: Response) => {
                const { userId } = req as AuthedRequest;
                try {
                        await sessions.assertOwnership(req.params.id, userId);
                        await docker.startContainer(req.params.id);
                        const updated = await sessions.get(req.params.id);
                        res.json(serializeMeta(updated!));
                } catch (err) {
                        handleSessionError(err, res);
                }
        });

        router.patch("/sessions/:id/env", async (req: Request, res: Response) => {
                const { userId } = req as AuthedRequest;
                const { envVars } = req.body as { envVars?: Record<string, string> };
                if (!envVars || typeof envVars !== "object") {
                        res.status(400).json({ error: "body.envVars must be an object" });
                        return;
                }
                try {
                        await sessions.assertOwnership(req.params.id, userId);
                        await sessions.updateEnvVars(req.params.id, envVars);
                        const updated = await sessions.get(req.params.id);
                        res.json(serializeMeta(updated!));
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
                const { label } = (req.body ?? {}) as { label?: string };
                try {
                        await sessions.assertOwnership(req.params.id, userId);
                        const tab = await docker.createTab(req.params.id, label);
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

                        // Enforce "always at least one tab per session" — refuse the close
                        // and let the client decide whether to create a new tab first.
                        const tabs = await docker.listTabs(id);
                        if (!tabs.some((t) => t.tabId === tabId)) {
                                res.status(404).json({ error: "tab not found" });
                                return;
                        }
                        if (tabs.length <= 1) {
                                res.status(409).json({ error: "cannot close the last tab" });
                                return;
                        }

                        await docker.deleteTab(id, tabId);
                        res.status(204).send();
                } catch (err) {
                        handleSessionError(err, res);
                }
        });

        return router;
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

function handleSessionError(err: unknown, res: Response): void {
        if (err instanceof NotFoundError) {
                res.status(404).json({ error: err.message });
        } else if (err instanceof ForbiddenError) {
                res.status(403).json({ error: err.message });
        } else {
                console.error("[routes] unexpected error:", (err as Error).message);
                res.status(500).json({ error: "Internal server error" });
        }
}
