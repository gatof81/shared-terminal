/**
 * routes/sessions.ts — session lifecycle CRUD, ports, tabs, file uploads
 * (#311). Largest surface; moved verbatim from routes.ts, deps from `ctx`.
 */

import { randomBytes } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import nodePath from "node:path";
import { pipeline } from "node:stream/promises";
import type { NextFunction, Request, Response, Router } from "express";
import multer from "multer";
import type { AuthedRequest } from "../auth.js";
import { isUserAdmin, requireAuth } from "../auth.js";
import { runAsyncBootstrap } from "../bootstrap.js";
import { EnvVarValidationError, validateEnvVars } from "../envVarValidation.js";
import { logger } from "../logger.js";
import * as observeLog from "../observeLog.js";
import { mappingsFromConfig, setPortMappings } from "../portMappings.js";
import {
	encryptAuthCredentials,
	encryptSecretEntries,
	getSessionConfig,
	isEmptyConfig,
	listResourceCaps,
	type PersistableSessionConfig,
	PortsPatchSchema,
	persistSessionConfig,
	type SessionConfig,
	SessionConfigValidationError,
	updatePorts,
	validateSessionConfig,
} from "../sessionConfig.js";
import type { SessionManager } from "../sessionManager.js";
import { SessionQuotaExceededError } from "../sessionManager.js";
import {
	assertBudgetAllows,
	computeRunningAllocations,
	effectiveSessionAllocation,
	getUserQuotaRow,
	resolveEffectiveQuotas,
	UserQuotaExceededError,
	type UserQuotaRow,
} from "../userQuotas.js";
import {
	handleSessionError,
	type RouteContext,
	serializeMeta,
	serializeUsage,
	TERMINAL_DIM_MAX,
} from "./shared.js";

// POST /sessions input caps. Bound user-controlled fields at the
// request boundary so D1 rows and future name-rendering UI don't
// have to defend against multi-KB strings or absurd terminal sizes.
// 64 for the name matches USERNAME_MAX_LEN and the tab-label cap
// (same shape of "user-controlled string with no other natural
// limit"). 1024 for cols/rows is well above any realistic terminal
// (most clients stay under 500×200) and well below sizes that would
// upset xterm/tmux. See #149.
const SESSION_NAME_MAX_LEN = 64;

// #418 — opaque external reference (e.g. an Agent Hub project binding).
// 128 (not 64) because refs are machine-composed ("hub:project:<uuid>"
// runs ~50 chars before any qualifier); still bounded at the request
// boundary like every other user-controlled string. Opaque means NO
// trimming/normalisation — the consumer filters by exact match, and a
// backend that "helpfully" rewrites the value would break round-tripping.
const EXTERNAL_REF_MAX_LEN = 128;

/** Returns an error message, or null when `value` is a valid external-ref
 *  WRITE value (a non-empty bounded string, or null = clear). Shared by
 *  the create route (where null/undefined both mean "unset") and the
 *  PATCH route (where null means "clear"). */
function externalRefError(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value !== "string" || value.length === 0 || value.length > EXTERNAL_REF_MAX_LEN) {
		return `body.externalRef must be null or a non-empty string of at most ${EXTERNAL_REF_MAX_LEN} characters`;
	}
	return null;
}

// Cap for the copy-mode search query (#357). 256 comfortably covers any
// realistic search term while bounding what gets handed to `tmux
// send-keys` argv; same "user-controlled string with no natural limit"
// shape as the name/label caps above.
const TAB_SEARCH_QUERY_MAX_LEN = 256;

export function registerSessionRoutes(router: Router, ctx: RouteContext): void {
	const { sessions, docker, broadcaster, idleSweeper } = ctx;
	// `execIp` covers the tab-search route too (#357): search and exec
	// are the same abuse surface — an authed caller driving docker execs
	// into a container (each search = 1-2 tmux execs + a D1 ownership
	// read) — so they deliberately share one per-IP budget instead of
	// threading a new limiter key through every config site. PR #405
	// review SHOULD-FIX.
	const { execIp, fileUploadIp } = ctx.limiters;
	// ── Session routes ──────────────────────────────────────────────────────

	router.post("/sessions", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		const { name, cols, rows, envVars, config, externalRef, ownerUserId } = req.body as {
			name?: string;
			cols?: number;
			rows?: number;
			envVars?: unknown;
			config?: unknown;
			externalRef?: unknown;
			ownerUserId?: unknown;
		};
		if (!name || typeof name !== "string") {
			res.status(400).json({ error: "body.name is required" });
			return;
		}
		// Trim and reject whitespace-only (#307): "   " is truthy so it slips
		// past the guard above and would render blank in the sidebar. Mirrors
		// the trim-then-check convention used for group / template names. The
		// trimmed value is what gets persisted (see sessions.create below).
		const trimmedName = name.trim();
		if (!trimmedName) {
			res.status(400).json({ error: "body.name is required" });
			return;
		}
		// Cap session name at the request boundary. The 100KB express.json
		// body limit is the only upstream bound otherwise — a 50KB name
		// would land in D1 verbatim and ride out on every list response.
		// 64 matches USERNAME_MAX_LEN and the tab-label cap; same shape of
		// "user-controlled string with no other natural limit" → same cap.
		// The empty-string case is already handled by the trim guard above;
		// only the upper bound needs to be checked here. See #149.
		if (trimmedName.length > SESSION_NAME_MAX_LEN) {
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
		// #418 — on create, null and undefined both mean "unset".
		if (externalRef !== undefined) {
			const refErr = externalRefError(externalRef);
			if (refErr !== null) {
				res.status(400).json({ error: refErr });
				return;
			}
		}
		// #420 — admin-only create-on-behalf. The session lands owned by
		// `ownerUserId` (visible/usable in that user's own account) while
		// the caller is only the creating identity — the Hub's technical
		// account creating project sessions for the human owner. Absent /
		// null → exactly today's self-owned behavior.
		let targetOwnerId = userId;
		let targetQuotaRow: UserQuotaRow | null = null;
		if (ownerUserId !== undefined && ownerUserId !== null) {
			if (typeof ownerUserId !== "string" || ownerUserId.length === 0) {
				res.status(400).json({ error: "body.ownerUserId must be a non-empty string" });
				return;
			}
			try {
				// Admin gate BEFORE the target-existence lookup, so a
				// non-admin can't use this field to probe user ids: they
				// get the same 403 whether the target exists or not.
				// isUserAdmin throws on D1 failure (→ 500) rather than
				// silently answering false — same rationale as the
				// operate-tier predicates.
				if (!(await isUserAdmin(userId))) {
					res
						.status(403)
						.json({ error: "Only admins can create sessions on behalf of another user" });
					return;
				}
				// Existence check, NOT fail-open like the quota read below:
				// a typo'd target id should be a clean 400 here, not an FK
				// failure surfacing as a generic 500 from sessions.create.
				// The row doubles as the target's quota row so the budget
				// check below doesn't re-read it.
				targetQuotaRow = await getUserQuotaRow(ownerUserId);
				if (targetQuotaRow === null) {
					res.status(400).json({ error: "body.ownerUserId: no such user" });
					return;
				}
			} catch (err) {
				handleSessionError(err, res);
				return;
			}
			targetOwnerId = ownerUserId;
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
		// #202 — per-user quotas. The CPU/RAM budget check runs here
		// (read-then-insert; racy under concurrent creates by the same
		// user, accepted for v1 — see userQuotas.ts header). The session-
		// COUNT cap stays atomic inside sessions.create's INSERT guard;
		// this block only resolves the per-user override to fold into it.
		// Budget math uses the same clamp formula spawn() applies, so a
		// stored 8-core cap on a 4-core-max deployment burns 4, not 8.
		//
		// D1 transients fail OPEN (warn + deployment defaults, budgets
		// unenforced for this one request): gating every create on the
		// quota read would turn a D1 blip into a create outage, and the
		// count cap still holds — its check lives inside the INSERT
		// itself. Same availability-over-correctness call as
		// loadConfigForSpawn.
		let effectiveMaxSessions: number | undefined;
		try {
			// #420 — quotas run against the TARGET owner (the account the
			// session will belong to), not the caller: an admin creating on
			// behalf charges the owner's budget, and the owner's 429 shapes
			// (#388/#389) apply unchanged. On-behalf reuses the row the
			// existence check above already fetched.
			const quotas = resolveEffectiveQuotas(
				targetQuotaRow ?? (await getUserQuotaRow(targetOwnerId)),
			);
			effectiveMaxSessions = quotas.maxSessions;
			if (quotas.maxTotalCpuNanos !== null || quotas.maxTotalMemBytes !== null) {
				const current = await computeRunningAllocations(sessions, targetOwnerId);
				const requested = effectiveSessionAllocation({
					cpuLimit: validatedConfig?.cpuLimit ?? null,
					memLimit: validatedConfig?.memLimit ?? null,
				});
				assertBudgetAllows(quotas, current, requested);
			}
		} catch (err) {
			if (err instanceof UserQuotaExceededError) {
				res.status(429).json({ error: err.message, cap: err.cap });
				return;
			}
			logger.warn(
				`[routes] quota check failed for user ${targetOwnerId}, proceeding with defaults: ${(err as Error).message}`,
			);
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
			meta = await sessions.create({
				userId: targetOwnerId,
				name: trimmedName,
				cols,
				rows,
				envVars: validatedEnvVars,
				maxActiveSessions: effectiveMaxSessions,
				// Validated above; null collapses to undefined so the
				// manager's `?? null` lands NULL either way.
				externalRef: typeof externalRef === "string" ? externalRef : undefined,
			});
			// #420 — audit every owner ≠ caller create. A log line (not a
			// session_observe_log row): the observe-log models attach-shaped
			// access with a start/end lifecycle, while creation is a
			// point-in-time provenance fact that the row itself will
			// outlive; the X-Request-Id-stamped line is the join point.
			if (targetOwnerId !== userId) {
				logger.info(
					`[routes] create-on-behalf: caller=${userId} owner=${targetOwnerId} session=${meta.sessionId}`,
				);
			}
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
				(validatedConfig?.agentSeed !== null && validatedConfig?.agentSeed !== undefined) ||
				// #277 — writeEnvFile is another bootstrap stage that
				// needs the config row fetched. Including it here
				// triggers the async runner for "envVars-toggle-only"
				// sessions and ensures the runner's `hasBootstrapConfig`
				// gate doesn't skip the `getSessionConfig` D1 round-trip.
				validatedConfig?.writeEnvFile === true ||
				// #198 — same shape as the writeEnvFile precedent above:
				// a session whose ONLY bootstrap-relevant config is a
				// readiness-annotated port must still trigger the async
				// runner (and its config load), or the probe stage would
				// silently never run. Plain ports (no readiness) stay
				// outside the gate — they're pure dispatcher metadata.
				(validatedConfig?.ports ?? []).some((p) => p.readiness !== undefined);
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

	// GET /quotas (#202 / 202b) — the caller's OWN effective quotas +
	// current usage, powering the create-form headroom hint. Outside the
	// /sessions auth prefix, hence the explicit requireAuth (same
	// rationale as /sessions/:id/files below). Admin sees everyone via
	// GET /admin/users; this returns only the caller's numbers.
	router.get("/quotas", requireAuth, async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		try {
			const effective = resolveEffectiveQuotas(await getUserQuotaRow(userId));
			const all = await sessions.listForUser(userId);
			// Mirrors the create-time INSERT guard's predicate for the
			// count and the budget check's running-only scope.
			const active = all.filter((s) => s.status !== "terminated" && s.status !== "failed");
			const current = await computeRunningAllocations(sessions, userId, all);
			res.json({
				effective: {
					maxSessions: effective.maxSessions,
					maxTotalCpu: effective.maxTotalCpuNanos,
					maxTotalMem: effective.maxTotalMemBytes,
				},
				usage: {
					activeSessions: active.length,
					runningSessions: current.runningSessions,
					cpuNanos: current.cpuNanos,
					memBytes: current.memBytes,
				},
			});
		} catch (err) {
			handleSessionError(err, res);
		}
	});

	router.get("/sessions", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		const includeTerminated = req.query.all === "true";
		// #418 — exact-match filter, applied in SQL by the list queries.
		// A non-string shape (`?externalRef=a&externalRef=b` parses as an
		// array) is a 400 rather than a silent ignore: the caller is a
		// machine reconciling bindings, and "filter dropped" must not
		// read as "every session matches".
		const externalRefQ = req.query.externalRef;
		if (externalRefQ !== undefined && typeof externalRefQ !== "string") {
			res.status(400).json({ error: "query.externalRef must be a single string" });
			return;
		}
		// Wrapped in try/catch because #271 added two new async legs
		// (listResourceCaps + docker.gatherStats) that can throw on a
		// transient D1 hiccup or Docker socket error. Without the
		// wrap, Express forwards the rejection to its default handler
		// and the browser sees a closed-connection / network error
		// rather than a structured 500. Pre-#271 the body had no
		// post-listForUser async work and the missing try/catch was
		// harmless. Same shape the admin route uses.
		try {
			const list = includeTerminated
				? await sessions.listAllForUser(userId, externalRefQ)
				: await sessions.listForUser(userId, externalRefQ);
			// #271 — surface configured caps + live usage so the user
			// can see what their own session is doing without going
			// through the admin dashboard. Same shape the admin
			// /admin/sessions route returns (caps + usage); usage is
			// null for non-running rows and rows whose stats fetch
			// failed. Parallelised so the D1 caps read overlaps with
			// the (slower) Docker stats fan-out.
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
						cpuLimit: sCaps?.cpuLimit ?? null,
						memLimit: sCaps?.memLimit ?? null,
						usage,
					};
				}),
			);
		} catch (err) {
			logger.error(`[routes] sessions list failed: ${(err as Error).message}`);
			res.status(500).json({ error: "Internal server error" });
		}
	});

	router.get("/sessions/:id", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		try {
			// #admin-operate: assertCanOperate (owner OR admin) instead of
			// owner-only, so an admin can read a foreign session's full meta
			// (incl. envVars) — the same shape they already get from
			// GET /admin/sessions. When the caller isn't the owner, skip the
			// idle bump: this is a pollable read, and an admin polling a
			// foreign session shouldn't reset the OWNER's idle-auto-stop
			// clock (the #300 principle applied to the operate tier).
			const meta = await sessions.assertCanOperate(req.params.id, userId);
			if (meta.userId !== userId) res.locals.skipIdleBump = true;
			// Runtime-readiness signal (#393): true once the entrypoint has
			// finished provisioning (docker exec can resolve image binaries),
			// false while it's still running (or the container predates the
			// sentinel — recycle to fix), null when not probed: session not
			// running, or the probe itself errored (container mid-teardown /
			// daemon hiccup — "unknown" is more honest than a hard 500 for a
			// status-shaped field). Single-session GET only: the list
			// endpoint would fan out one docker exec per row on the sidebar's
			// 5 s poll. The probe is cheap after first success (positive
			// per-container cache in DockerManager).
			let runtimeReady: boolean | null = null;
			if (meta.status === "running") {
				try {
					// Pass the row assertCanOperate just fetched so the probe
					// doesn't re-read it from D1 (PR #399 review SHOULD-FIX).
					runtimeReady = await docker.isRuntimeReady(req.params.id, meta);
				} catch {
					runtimeReady = null;
				}
			}
			res.json({ ...serializeMeta(meta), runtimeReady });
		} catch (err) {
			handleSessionError(err, res);
		}
	});

	// #274 — Bootstrap log read. Returns the captured output from the
	// last bootstrap run (success or failure). Owner-gated via
	// `assertOwnership`, same shape as the rest of /sessions/:id/*.
	// Returns 200 with `{ log: string | null }`; null means no
	// bootstrap ever ran for this session (bare-create with no hooks),
	// or the row pre-dates the #274 migration and the column is NULL.
	router.get("/sessions/:id/bootstrap-log", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		try {
			// `assertOwnedBy`, NOT `assertOwnership` — we don't use the
			// returned meta and assertOwnership pays an unconditional
			// D1 read on the positive path. Matches the convention the
			// other read-only routes that discard meta use (stop / start
			// / restore / observe-log read).
			//
			// Hard-delete race: if the row is deleted between
			// `assertOwnedBy` (which can short-circuit via the
			// ownership cache) and `getBootstrapLog`, the second call
			// returns null and the route responds 200 { log: null } —
			// indistinguishable from the legitimate "no bootstrap ever
			// ran" state. This is intentional. The auth gate already
			// passed and there is no log content to leak; collapsing
			// the race into the no-op response is simpler than wiring
			// `getBootstrapLog` to distinguish missing-row from
			// present-but-null-column purely for this route's 404
			// shape.
			await sessions.assertOwnedBy(req.params.id, userId);
			const log = await sessions.getBootstrapLog(req.params.id);
			res.json({ log });
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
		// #admin-operate: 'observe' vs 'operate' — the owner's own
		// per-session log surfaces it too, so they can see an admin
		// drove (not just watched) their session.
		mode: e.mode,
	});

	router.get("/sessions/:id/observe-log", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		try {
			// `assertCanObserve` throws NotFoundError for a missing
			// session and ForbiddenError for an unauthorised caller —
			// both shapes flow into `handleSessionError`'s standard 404
			// / 403 emission, so callers get the same status-code
			// contract the rest of the /sessions/:id reads use.
			const meta = await sessions.assertCanObserve(req.params.id, userId);
			// (#300) A non-owner observer (admin / group-lead) gets a 200
			// here, which would otherwise trip the idle-bump middleware and
			// keep the OWNER's session alive — defeating idle auto-stop
			// (#194) for any session a lead polls. Skip the bump unless the
			// caller is the owner, so only the owner's own activity counts.
			if (meta.userId !== userId) res.locals.skipIdleBump = true;
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
			// #429: operate-tier (owner OR admin) instead of owner-only, so
			// Agent Hub's admin identity can start a specialist session it
			// operates on the owner's behalf. Start is the last lifecycle
			// verb widened to operate — terminal (#411), metadata (#412) and
			// exec (#416) already are; stop/delete stay owner-driven (the
			// owner and the idle sweeper own teardown). Group leads excluded:
			// `assertCanOperate` has no lead arm (observe stays read-only).
			const meta = await sessions.assertCanOperate(req.params.id, userId);
			const isForeignCaller = meta.userId !== userId;
			// Don't reset the owner's idle-auto-stop clock when an admin acts
			// on their session (#300 principle, same as the other operate
			// routes). The bump middleware checks this on `finish`.
			if (isForeignCaller) res.locals.skipIdleBump = true;
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
			// Audit a cross-user start (#429) as a point-in-time
			// `mode='operate'` row (start≈end — starting is instantaneous
			// from the audit's view, unlike the exec span in #416). The
			// audit IS the security mitigation for widening admin power by
			// this verb, so it's fail-closed like the exec-start audit: an
			// INSERT failure aborts BEFORE any container spawns, rather than
			// fire-and-forget like the kill safety-valve. Recorded only once
			// the auth + `failed` guards passed and the spawn is imminent, so
			// a denied/409'd attempt leaves no row (observeLog's "denied
			// attempts saw nothing" posture).
			if (isForeignCaller) {
				try {
					const logId = await observeLog.recordObserveStart(
						userId,
						req.params.id,
						meta.userId,
						"operate",
					);
					await observeLog.recordObserveEnd(logId);
					logger.info(
						`[sessions] operate start logged: caller=${userId} session=${req.params.id} ` +
							`owner=${meta.userId} log=${logId}`,
					);
				} catch (err) {
					logger.error(
						`[sessions] operate start audit insert failed, aborting start: ${(err as Error).message} ` +
							`(caller=${userId} session=${req.params.id})`,
					);
					res.status(500).json({ error: "Internal server error" });
					return;
				}
			}
			await docker.startContainer(req.params.id);
			const updated = await sessions.get(req.params.id);
			if (!updated) {
				// Race: deleted between assertCanOperate and get. See
				// stopContainer handler above for the full explanation.
				res.status(404).json({ error: "Session not found" });
				return;
			}
			res.json(serializeMeta(updated));
		} catch (err) {
			handleSessionError(err, res);
		}
	});

	// PATCH /sessions/:id — mutable session metadata (#418). The only
	// field today is `externalRef` (set with a string, clear with null);
	// unknown keys 400 rather than silently no-op, so a client that
	// PATCHes a field this route doesn't handle yet (e.g. `name`) learns
	// immediately instead of concluding the write "succeeded".
	router.patch("/sessions/:id", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		const body = (req.body ?? {}) as Record<string, unknown>;
		if (!("externalRef" in body)) {
			res.status(400).json({ error: "body.externalRef is required" });
			return;
		}
		const unknownKey = Object.keys(body).find((k) => k !== "externalRef");
		if (unknownKey !== undefined) {
			res.status(400).json({ error: `body.${unknownKey} is not a patchable field` });
			return;
		}
		const refErr = externalRefError(body.externalRef);
		if (refErr !== null) {
			res.status(400).json({ error: refErr });
			return;
		}
		try {
			// #admin-operate: writing metadata is the operate tier, same as
			// PATCH /env below (the Hub's admin execution identity re-binds
			// refs on sessions owned by the human admin account). Skip the
			// idle bump when the caller isn't the owner (#300 principle).
			const meta = await sessions.assertCanOperate(req.params.id, userId);
			if (meta.userId !== userId) res.locals.skipIdleBump = true;
			await sessions.updateExternalRef(req.params.id, body.externalRef as string | null);
			const updated = await sessions.get(req.params.id);
			if (!updated) {
				// Race: deleted between assertCanOperate and get. See
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
			// #admin-operate: env is a write surface an admin can drive on
			// a foreign session. assertCanOperate (owner OR admin); skip the
			// idle bump when the caller isn't the owner.
			const meta = await sessions.assertCanOperate(req.params.id, userId);
			if (meta.userId !== userId) res.locals.skipIdleBump = true;
			await sessions.updateEnvVars(req.params.id, validatedEnvVars);
			const updated = await sessions.get(req.params.id);
			if (!updated) {
				// Race: deleted between assertCanOperate and get. See
				// stopContainer handler above for the full explanation.
				res.status(404).json({ error: "Session not found" });
				return;
			}
			res.json(serializeMeta(updated));
		} catch (err) {
			handleSessionError(err, res);
		}
	});

	// GET /sessions/:id/ports — the session's DECLARED exposed-port set
	// (from `session_configs`, the source of truth) so the frontend ports
	// editor can populate. Reads config rather than `sessions_port_mappings`
	// so a stopped session (whose runtime rows are cleared) still shows the
	// ports the owner configured. `allowPrivilegedPorts` is returned so the
	// UI can explain that a < 1024 port needs a recreate when it's off.
	router.get("/sessions/:id/ports", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		try {
			// #admin-operate: READING the port set is the observe tier
			// (owner / admin / lead can see it), matching GET /tabs. Editing
			// (PATCH below) is the narrower operate tier. Skip the idle bump
			// on a foreign read (pollable — same #300 principle).
			const meta = await sessions.assertCanObserve(req.params.id, userId);
			if (meta.userId !== userId) res.locals.skipIdleBump = true;
			const config = await getSessionConfig(req.params.id);
			res.json({
				ports: config?.ports ?? [],
				allowPrivilegedPorts: config?.allowPrivilegedPorts === true,
			});
		} catch (err) {
			handleSessionError(err, res);
		}
	});

	// PATCH /sessions/:id/ports — live-edit the exposed-port set (#190).
	// Unlike create-time config, ports are now pure metadata: the dispatcher
	// proxies to the container by name over the shared network, so there is
	// no `docker` recreate. We persist `ports_json` then rewrite the runtime
	// `sessions_port_mappings` rows; the dispatcher's `status='running'` gate
	// means a stopped session simply stores the config (mappings get re-derived
	// on its next start). Owner-gated, mirroring `PATCH /sessions/:id/env`.
	router.patch("/sessions/:id/ports", async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		// `safeParse` (strict schema): unknown keys / bad shape 400 without
		// allocating a throw. Validates range, count cap, and uniqueness;
		// the privileged-port rule is enforced below against stored config.
		const parsed = PortsPatchSchema.safeParse(req.body);
		if (!parsed.success) {
			const issue = parsed.error.issues[0]!;
			const path = issue.path.map(String).join(".");
			res.status(400).json({ error: path ? `${path}: ${issue.message}` : issue.message });
			return;
		}
		const { ports } = parsed.data;
		try {
			// #admin-operate: editing ports is the operate tier (owner OR
			// admin); skip the idle bump on a foreign edit.
			const meta = await sessions.assertCanOperate(req.params.id, userId);
			if (meta.userId !== userId) res.locals.skipIdleBump = true;
			// Privileged-port gate: a port < 1024 needs CAP_NET_BIND_SERVICE,
			// which is granted at spawn from `allowPrivilegedPorts` and can't
			// be added to a live container. So a newly-requested privileged
			// port is only allowed if the session was CREATED with the toggle
			// on; otherwise the in-container process would hit EACCES binding
			// it. Reject with a clear, actionable message rather than letting
			// the dispatcher proxy to a port nothing can listen on.
			const config = await getSessionConfig(req.params.id);
			if (config?.allowPrivilegedPorts !== true) {
				const privileged = ports.find((p) => p.container < 1024);
				if (privileged) {
					res.status(400).json({
						error:
							`port ${privileged.container} is privileged (< 1024) and this session was not ` +
							`created with privileged ports enabled; recreate the session with ` +
							`"allow privileged ports" to expose it`,
					});
					return;
				}
			}
			// Persist first (source of truth), then rewrite the runtime rows.
			// Persist-before-apply matches the #270 resources PATCH: if the
			// mapping write below fails, the next container start re-derives
			// mappings from the now-current config regardless.
			await updatePorts(req.params.id, ports);
			await setPortMappings(req.params.id, mappingsFromConfig(ports));
			const updated = await sessions.get(req.params.id);
			if (!updated) {
				// Race: deleted between assertCanOperate and get. See
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
			// Tab CREATE / DELETE / search further down use the operate tier
			// (`assertCanOperate`, owner OR admin) — reading the tab list is
			// observe (owner/admin/lead), but mutating tab state is a write
			// an observer/lead must not do.
			const meta = await sessions.assertCanObserve(req.params.id, userId);
			// (#300) The observe UI polls this endpoint. A non-owner
			// observer (admin / group-lead) gets a 200, which would trip
			// the idle-bump middleware and keep the OWNER's session alive
			// indefinitely, defeating idle auto-stop (#194). Only the
			// owner's own polling should count as activity.
			if (meta.userId !== userId) res.locals.skipIdleBump = true;
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
			// #admin-operate: creating a tab is part of driving the
			// terminal — operate tier (owner OR admin), skip foreign bump.
			const meta = await sessions.assertCanOperate(req.params.id, userId);
			if (meta.userId !== userId) res.locals.skipIdleBump = true;
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
			// #admin-operate: deleting a tab is a terminal-mutation — operate
			// tier (owner OR admin), skip the idle bump on a foreign delete.
			const meta = await sessions.assertCanOperate(id, userId);
			if (meta.userId !== userId) res.locals.skipIdleBump = true;

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

	// POST /sessions/:id/tabs/:tabId/search — drive tmux copy-mode search
	// across the tab's full history (#357). The 50k-line scrollback lives
	// in tmux, not xterm, so search happens server-side; the visual result
	// is tmux's own copy-mode UI streamed through the existing pane fanout.
	router.post("/sessions/:id/tabs/:tabId/search", execIp, async (req: Request, res: Response) => {
		const { userId } = req as AuthedRequest;
		const { id, tabId } = req.params;
		// Same allowlist the WS attach applies to ?tab= (wsHandler.ts).
		// docker exec takes argv (no shell), but the defensive charset
		// keeps surprising tmux targets like "main:1" out of `-t`.
		if (!/^[a-zA-Z0-9._-]{1,64}$/.test(tabId)) {
			res.status(400).json({ error: "invalid tab id" });
			return;
		}
		const { action, query } = (req.body ?? {}) as { action?: unknown; query?: unknown };
		if (action !== "search" && action !== "next" && action !== "prev" && action !== "exit") {
			res.status(400).json({
				error: 'body.action must be one of "search" | "next" | "prev" | "exit"',
			});
			return;
		}
		let validatedQuery: string | undefined;
		if (action === "search") {
			if (
				typeof query !== "string" ||
				query.length === 0 ||
				query.length > TAB_SEARCH_QUERY_MAX_LEN
			) {
				res.status(400).json({
					error: `body.query must be a string of 1..${TAB_SEARCH_QUERY_MAX_LEN} characters`,
				});
				return;
			}
			// Control bytes can never match pane text, and \r\n would read
			// as key presses inside copy-mode's search prompt — reject the
			// whole 0x00–0x1F, 0x7F block like the tab-label validator.
			// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars IS the rejection criterion
			if (/[\x00-\x1f\x7f]/.test(query)) {
				res.status(400).json({ error: "body.query must not contain control characters" });
				return;
			}
			validatedQuery = query;
		}
		try {
			// operate tier (owner OR admin), NOT the observe tier: search
			// steers the shared tmux pane (copy-mode UI repaints for every
			// attached client), so a read-only observer/lead must not drive
			// it — same graduation as tab create/delete above. Skip the idle
			// bump on a foreign drive.
			const meta = await sessions.assertCanOperate(id, userId);
			if (meta.userId !== userId) res.locals.skipIdleBump = true;
			await docker.searchTabHistory(id, tabId, action, validatedQuery);
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

	// ── File download (#358) ────────────────────────────────────────────────
	// Stream a single file out of the session workspace from the HOST bind
	// mount (`<WORKSPACE_ROOT>/<sessionId>`) — no docker exec involved, so
	// downloads work on stopped sessions too (the workspace outlives the
	// container).

	router.get(
		"/sessions/:id/files",
		// Explicit requireAuth for the same reason as the upload route
		// above: don't silently inherit the gate from the /sessions
		// prefix mount.
		requireAuth,
		// Shares the upload limiter deliberately — same "bulk file
		// transfer" surface, and a JWT holder shouldn't be able to loop
		// 512 MiB download streams faster than they could loop uploads.
		fileUploadIp,
		async (req: Request, res: Response) => {
			const { userId } = req as AuthedRequest;
			const rel = req.query.path;
			// `req.query.path` is string | string[] | ParsedQs — the typeof
			// check rejects the repeated-param array shape along with the
			// missing case.
			if (typeof rel !== "string" || rel.length === 0) {
				res.status(400).json({ error: "query param 'path' is required" });
				return;
			}
			if (rel.length > DOWNLOAD_PATH_MAX_LEN) {
				res.status(400).json({
					error: `path must be at most ${DOWNLOAD_PATH_MAX_LEN} characters`,
				});
				return;
			}
			// NUL would truncate the path at the syscall boundary, making
			// the string we containment-check differ from the path the
			// kernel resolves — reject alongside absolute paths.
			if (nodePath.isAbsolute(rel) || rel.includes("\0")) {
				res.status(400).json({ error: "path must be workspace-relative" });
				return;
			}
			try {
				// Ownership BEFORE any filesystem access, mirroring the
				// upload route: a foreign-session probe gets its 404
				// without learning anything about that workspace's
				// contents (not even file-exists timing).
				await sessions.assertOwnedBy(req.params.id, userId);
				await streamWorkspaceFile(req.params.id, rel, res);
			} catch (err) {
				handleSessionError(err, res);
			}
		},
	);
}

// Host-side workspace root. Same env read as dockerManager.ts / backup.ts —
// each module reads it at load rather than sharing an export, so route
// tests can point it at a tmp dir without dragging the docker socket in.
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/var/shared-terminal/workspaces";

// Download size cap. 512 MiB comfortably covers build artefacts / archives
// a session realistically produces while bounding what one request can
// pull through the backend (and what the frontend's fetch+blob flow has
// to hold in browser memory). Bigger payloads should leave via git or the
// user's own tooling inside the container.
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

// Linux PATH_MAX — anything longer can't name a real file on the host
// filesystem anyway, so reject it before path.resolve chews on it.
const DOWNLOAD_PATH_MAX_LEN = 4096;

/**
 * Containment-check `rel` against the session's workspace root and stream
 * the file to `res`. Follows the purgeWorkspace discipline (lexical
 * resolve + strict-prefix check) and adds the symlink hardening a READ
 * path needs that a recursive-rm path doesn't: `fs.rm` never follows
 * symlinks out of the tree, but a read here happily would.
 *
 * Error shape: writes the 4xx/413 response itself; throws only on
 * unexpected filesystem errors (caller maps those via handleSessionError).
 */
async function streamWorkspaceFile(sessionId: string, rel: string, res: Response): Promise<void> {
	const sessionRoot = nodePath.resolve(WORKSPACE_ROOT, sessionId);
	// `path.resolve` collapses `../` segments lexically, so a traversal
	// either lands outside the root (caught by the strict-prefix check)
	// or is harmlessly normalised back inside.
	const joined = nodePath.resolve(sessionRoot, rel);
	if (!joined.startsWith(sessionRoot + nodePath.sep)) {
		res.status(400).json({ error: "path escapes the session workspace" });
		return;
	}

	// The lexical check above says nothing about symlinked PARENTS
	// (`ln -s /etc workspace/link` + path=link/passwd passes it). realpath
	// the containing directory and re-verify against the realpath'd root —
	// both sides canonicalised so a legitimately-symlinked WORKSPACE_ROOT
	// (e.g. /var → /private/var) doesn't false-positive every download.
	let realRoot: string;
	let realDir: string;
	try {
		realRoot = await fs.realpath(sessionRoot);
		realDir = await fs.realpath(nodePath.dirname(joined));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			res.status(404).json({ error: "File not found" });
			return;
		}
		throw err;
	}
	if (realDir !== realRoot && !realDir.startsWith(realRoot + nodePath.sep)) {
		// 404, not 400: a symlink pointing out of the workspace was
		// planted by code running in the container — don't hand a
		// probing client confirmation that its link took effect.
		res.status(404).json({ error: "File not found" });
		return;
	}

	const leaf = nodePath.join(realDir, nodePath.basename(joined));
	let lst: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		// lstat (not stat) so a symlink LEAF is visible as such instead
		// of being transparently followed to wherever it points.
		lst = await fs.lstat(leaf);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			res.status(404).json({ error: "File not found" });
			return;
		}
		throw err;
	}
	if (lst.isSymbolicLink()) {
		// Same no-disclosure 404 as the parent-escape branch — even a
		// symlink that resolves INSIDE the workspace is refused rather
		// than followed; the user can download the target directly.
		res.status(404).json({ error: "File not found" });
		return;
	}
	if (lst.isDirectory()) {
		res.status(400).json({ error: "path is a directory, not a file" });
		return;
	}
	if (!lst.isFile()) {
		// Sockets, FIFOs, device nodes — nothing streamable lives here.
		res.status(400).json({ error: "path is not a regular file" });
		return;
	}
	if (lst.size > MAX_DOWNLOAD_BYTES) {
		res.status(413).json({
			error: `file exceeds the ${MAX_DOWNLOAD_BYTES / (1024 * 1024)} MiB download cap`,
		});
		return;
	}

	// O_NOFOLLOW closes the lstat→open TOCTOU: code running INSIDE the
	// container can swap the checked file for a symlink between the lstat
	// above and this open, and the backend (typically root on the host)
	// would follow it anywhere. With O_NOFOLLOW the kernel answers ELOOP
	// instead; the fstat re-check below covers the same race for
	// type/size. (A racing parent-DIRECTORY swap remains theoretically
	// open — openat-chain hardening isn't worth it for an owner-only
	// endpoint reading the owner's own workspace.)
	let handle: FileHandle;
	try {
		handle = await fs.open(leaf, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ELOOP") {
			res.status(404).json({ error: "File not found" });
			return;
		}
		throw err;
	}
	// Guard the fstat: if it throws (EBADF/ENOMEM under OS pressure) the
	// exception would otherwise propagate with the fd still open — a
	// root-held descriptor Node's GC finaliser closes eventually, but
	// "eventually" can lose a race against fd-table exhaustion under
	// sustained load. The pipeline path below doesn't need this (the
	// read stream's autoClose owns the fd from there on). PR #403
	// review SHOULD-FIX.
	let st: Awaited<ReturnType<typeof handle.stat>>;
	try {
		st = await handle.stat();
	} catch (err) {
		await handle.close().catch(() => {});
		throw err;
	}
	if (!st.isFile()) {
		await handle.close();
		res.status(400).json({ error: "path is not a regular file" });
		return;
	}
	if (st.size > MAX_DOWNLOAD_BYTES) {
		await handle.close();
		res.status(413).json({
			error: `file exceeds the ${MAX_DOWNLOAD_BYTES / (1024 * 1024)} MiB download cap`,
		});
		return;
	}

	res.setHeader("Content-Type", "application/octet-stream");
	// From the fstat, not the earlier lstat — the fd's answer is the one
	// that matches the bytes we're about to stream.
	res.setHeader("Content-Length", String(st.size));
	res.setHeader(
		"Content-Disposition",
		`attachment; filename="${contentDispositionFilename(nodePath.basename(joined))}"`,
	);
	try {
		// pipeline (not .pipe): on EITHER side failing — read error, or
		// the client going away mid-download — both streams are destroyed,
		// which closes the fd via the read stream's autoClose. Bare .pipe
		// leaks the fd on client abort.
		await pipeline(handle.createReadStream(), res);
	} catch (err) {
		if (!res.headersSent) {
			// Nothing flushed yet — a structured 500 is still possible.
			// Drop the download headers first so the JSON error doesn't
			// go out with an attachment disposition and a stale length.
			res.removeHeader("Content-Length");
			res.removeHeader("Content-Disposition");
			res.status(500).json({ error: "Internal server error" });
		} else {
			// Bytes already went out under a 200 — the only honest signal
			// left is killing the socket so the client sees a truncated
			// transfer (Content-Length mismatch), not a clean short EOF.
			res.destroy();
		}
		logger.warn(`[routes] download aborted for session ${sessionId}: ${(err as Error).message}`);
	}
}

/**
 * Content-Disposition filename as an RFC 6266 quoted-string. Header
 * injection is neutralised by replacing everything outside printable
 * ASCII (CR/LF are what matter; Node would throw on them, but a 500 for
 * a weird filename is the wrong answer), then `"` and `\` are
 * backslash-escaped so the quoted-string can't be broken out of.
 * Multi-byte names degrade to underscores — losing the pretty name beats
 * emitting a header clients mis-parse; the RFC 5987 `filename*` dance
 * isn't worth it for v1.
 */
function contentDispositionFilename(name: string): string {
	const printable = name.replace(/[^\x20-\x7e]/g, "_");
	const escaped = printable.replace(/[\\"]/g, "\\$&");
	return escaped.trim().length > 0 ? escaped : "download";
}

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
