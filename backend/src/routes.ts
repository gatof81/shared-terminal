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
        createInvite,
        hasAnyUsers,
        InvalidCredentialsError,
        InviteQuotaExceededError,
        InviteRequiredError,
        listInvites,
        loginUser,
        registerUser,
        requireAuth,
        revokeInvite,
        UsernameTakenError,
} from "./auth.js";
import type { DockerManager } from "./dockerManager.js";
import { UploadQuotaExceededError } from "./dockerManager.js";
import { EnvVarValidationError, validateEnvVars } from "./envVarValidation.js";
import type { RateLimitConfig } from "./rateLimit.js";
import {
        createAuthRateLimiters,
        DEFAULT_RATE_LIMIT_CONFIG,
        UsernameRateLimiter,
} from "./rateLimit.js";
import type { SessionManager } from "./sessionManager.js";
import {
        ForbiddenError,
        NotFoundError,
        SessionQuotaExceededError,
} from "./sessionManager.js";
import type { SessionMeta } from "./types.js";

export function buildRouter(
        sessions: SessionManager,
        docker: DockerManager,
        rateLimitConfig: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,
): Router {
        const router = Router();

        // ── Auth routes (public) ────────────────────────────────────────────────

        const { loginIp, registerIp, invitesCreateIp, invitesRevokeIp, fileUploadIp } = createAuthRateLimiters(rateLimitConfig);
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

                let result: { userId: string; token: string };
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
                                console.error(`[auth] login failed unexpectedly:`, (err as Error).message);
                                res.status(500).json({ error: "Internal server error" });
                                return;
                        }
                        usernameLimiter.reset(username);
                        res.json(result);
                } finally {
                        // Always release the in-flight slot — success, invalid creds,
                        // or infra error alike. `reset()` above wipes the failure
                        // counter but not this slot; pairing it with endAttempt keeps
                        // the invariant that every beginAttempt has exactly one
                        // endAttempt.
                        usernameLimiter.endAttempt(username);
                }
        });

        // ── Authenticated route prefixes ────────────────────────────────────────

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

        router.post("/invites", invitesCreateIp, async (req: Request, res: Response) => {
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

        router.delete("/invites/:code", invitesRevokeIp, async (req: Request, res: Response) => {
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
                        name?: string; cols?: number; rows?: number; envVars?: unknown;
                };
                if (!name || typeof name !== "string") {
                        res.status(400).json({ error: "body.name is required" });
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
                        console.error(`[routes] session create failed:`, (err as Error).message);
                        if (meta) {
                                // Best-effort rollback. If deleteRow itself fails (D1 blip),
                                // the reconciler will eventually flip status to stopped but
                                // the row remains — we log loudly so an operator can clean
                                // it up manually.
                                try {
                                        await sessions.deleteRow(meta.sessionId);
                                } catch (cleanupErr) {
                                        console.error(
                                                `[routes] CRITICAL: spawn rollback failed for session ${meta.sessionId}:`,
                                                (cleanupErr as Error).message,
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
                        await sessions.assertOwnership(req.params.id, userId);
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
                        if (!err) { next(); return; }
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
                                                        console.warn("[routes] tmp unlink failed:", (r.reason as Error).message);
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
                                        res.status(400).json({ error: "Upload rejected: field must be named 'files' (multipart/form-data)" });
                                        return;
                                }
                                res.status(400).json({ error: `Upload rejected: ${err.message}` });
                                return;
                        }
                        console.error("[routes] upload middleware error:", (err as Error).message);
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
        const requireSessionOwnership = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
                try {
                        await sessions.assertOwnership(req.params.id, (req as AuthedRequest).userId);
                        next();
                } catch (err) {
                        handleSessionError(err, res);
                }
        };

        router.post(
                "/sessions/:id/files",
                fileUploadIp,
                requireSessionOwnership,
                handleUploadMiddleware,
                async (req: Request, res: Response) => {
                        const files = (req.files as Express.Multer.File[] | undefined) ?? [];
                        try {
                                if (files.length === 0) {
                                        res.status(400).json({ error: "no files provided (use 'files' field, multipart/form-data)" });
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
                // would push you past a server-enforced size cap". The
                // err.message string already carries used/attempted/quota
                // for display; drop the structured byte-count fields so
                // we don't surface another user's disk usage if sessions
                // ever become shared.
                res.status(413).json({ error: err.message });
        } else {
                console.error("[routes] unexpected error:", (err as Error).message);
                res.status(500).json({ error: "Internal server error" });
        }
}
