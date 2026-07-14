/**
 * routes/exec.ts — HTTP exec API over streamExec/killExecProcessGroup (#381).
 *
 * The agenthub seam: structured command execution in a session container
 * with NDJSON streaming output, exit codes, and race-free cancellation,
 * from outside this backend's process. Product-agnostic by design — no
 * Hub concepts appear here; the canonical contract lives in
 * docs/EXEC_API.md (supersedes the agenthub draft it originated from).
 *
 * Security note: this surface is arbitrary code execution in the session
 * container *by construction* — exactly as powerful as the terminal WS
 * already is for the same authenticated owner. It adds capability breadth
 * (automation), not a new trust level; ownership is the entire
 * authorization story, same as everywhere else.
 */

import type { Request, Response, Router } from "express";
import { z } from "zod";
import type { AuthedRequest } from "../auth.js";
import { EnvVarValidationError, validateEnvVars } from "../envVarValidation.js";
import type { ExecRegistry } from "../execRegistry.js";
import { logger } from "../logger.js";
import { getRequestId } from "../requestContext.js";
import { handleSessionError, type RouteContext } from "./shared.js";

// ── Server-enforced limits (contract §Limits) ───────────────────────────────

// Protects PidsLimit:1024 and keeps one runaway consumer from starving
// tmux inside the container. Counted per-session from the registry.
export const MAX_CONCURRENT_EXECS_PER_SESSION = 4;
// argv total-bytes cap: same magnitude as the env-var total cap — a
// command line past this is a smuggled payload, not a command.
const CMD_BYTES_MAX = 32 * 1024;
const GRACE_MS_DEFAULT = 5_000;
const GRACE_MS_MAX = 30_000;
// Seam-level backstop, applied even when the caller omits maxDurationMs:
// an exec at this seam is always wall-clock-bounded, mirroring the
// bootstrap pipeline's 10-minute cap philosophy. Consumers enforce their
// own tighter budgets.
export const MAX_DURATION_MS_MAX = 60 * 60 * 1000;
// Output that arrives before the pgid sentinel (stderr can beat it) is
// buffered so `started` stays the first event; the buffer is bounded
// because the sentinel not arriving at all is a fail-open path where
// we'd otherwise accumulate the whole output in memory.
const PRESTART_BUF_MAX_BYTES = 256 * 1024;

const ExecBodySchema = z
	.object({
		cmd: z.array(z.string().min(1)).min(1),
		env: z.record(z.string(), z.string()).optional(),
		workingDir: z.string().min(1).max(4096).optional(),
		maxDurationMs: z.number().int().min(1).max(MAX_DURATION_MS_MAX).optional(),
	})
	.strict();

const KillBodySchema = z
	.object({
		graceMs: z.number().int().min(0).max(GRACE_MS_MAX).optional(),
	})
	.strict();

/**
 * Contract §Correlation: every exec-API response carries X-Request-Id so
 * a consumer-side run can be joined to substrate logs after the fact.
 * The id already exists on every log line (requestContext.ts); these
 * routes are the first to emit it publicly — deliberately scoped to this
 * surface, not a global middleware (the global decision stays #376's).
 */
function setRequestIdHeader(res: Response): string {
	const requestId = getRequestId() ?? "";
	if (requestId !== "") res.setHeader("X-Request-Id", requestId);
	return requestId;
}

export function registerExecRoutes(router: Router, ctx: RouteContext): void {
	const { sessions, docker, execRegistry } = ctx;
	const { execIp } = ctx.limiters;

	// ── POST /sessions/:id/exec — start + stream ────────────────────────────

	router.post("/sessions/:id/exec", execIp, async (req: Request, res: Response) => {
		const sessionId = req.params.id;
		const userId = (req as AuthedRequest).userId;
		try {
			// assertOwnership (not assertOwnedBy): the fresh meta is needed
			// for the container-not-running check below.
			const meta = await sessions.assertOwnership(sessionId, userId);

			const parsed = ExecBodySchema.safeParse(req.body);
			if (!parsed.success) {
				res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
				return;
			}
			const body = parsed.data;
			// Reuses the session-config env validation wholesale: name
			// charset (rejects "=" smuggling into the `k=v` join inside
			// streamExec), per-value and total-bytes caps.
			let env: Record<string, string> | undefined;
			if (body.env !== undefined) env = validateEnvVars(body.env);
			const cmdBytes = body.cmd.reduce((n, arg) => n + Buffer.byteLength(arg, "utf-8"), 0);
			if (cmdBytes > CMD_BYTES_MAX) {
				res.status(400).json({ error: `cmd exceeds ${CMD_BYTES_MAX} bytes` });
				return;
			}

			if (meta.status !== "running" || !meta.containerId) {
				res.status(409).json({ error: "container-not-running" });
				return;
			}
			if (execRegistry.runningCount(sessionId) >= MAX_CONCURRENT_EXECS_PER_SESSION) {
				res.status(429).json({ error: "too-many-concurrent-execs" });
				return;
			}

			const entry = execRegistry.register(sessionId);
			const requestId = setRequestIdHeader(res);
			res.setHeader("Content-Type", "application/x-ndjson");
			res.setHeader("Cache-Control", "no-store");

			let startedSent = false;
			let clientGone = false;
			let streamHandle: { pause: () => void; resume: () => void } | undefined;
			const preStart: string[] = [];
			let preStartBytes = 0;
			let preStartDroppedBytes = 0;

			// Client disconnect does NOT kill the process (Docker has no
			// kill-exec; the exec stays addressable via status/kill). But a
			// paused upstream with no reader would wedge the exec forever —
			// resume it so the container-side process can drain and exit,
			// landing its real exit code in the registry.
			res.on("close", () => {
				clientGone = true;
				streamHandle?.resume();
			});

			const writeLine = (line: string): void => {
				if (clientGone || res.writableEnded) return;
				// Flow control (contract §stream lifecycle): when the HTTP
				// response backpressures, pause the Docker stream instead of
				// buffering unboundedly. `drain` fires once per pause cycle.
				if (!res.write(line) && streamHandle !== undefined) {
					streamHandle.pause();
					res.once("drain", () => {
						if (!clientGone) streamHandle?.resume();
					});
				}
			};
			const writeEvent = (event: Record<string, unknown>): void => {
				writeLine(`${JSON.stringify(event)}\n`);
			};

			const onOutput = (chunk: string, source: "stdout" | "stderr"): void => {
				// Exec output is session activity: an agent mid-run must not
				// be idle-reaped under it. Same semantics as WS data chunks.
				ctx.idleSweeper?.bump(sessionId);
				const line = `${JSON.stringify({ v: 1, type: "output", stream: source, data: chunk })}\n`;
				if (!startedSent) {
					// Contract: `started` precedes any output event, but early
					// stderr can beat the stdout pgid sentinel — hold it.
					if (preStartBytes + line.length <= PRESTART_BUF_MAX_BYTES) {
						preStart.push(line);
						preStartBytes += line.length;
					} else {
						// Past the cap the bytes are gone — but never silently:
						// a gap the consumer can't tell from "the process wrote
						// nothing" is worse than the gap itself. Counted here,
						// surfaced as a `dropped` event right after the buffer
						// flush (additive under v:1 — consumers ignore unknown
						// event types) plus a substrate-side warn. Counts raw
						// output bytes, not serialized-event bytes — that's the
						// quantity a consumer can reason about.
						preStartDroppedBytes += Buffer.byteLength(chunk, "utf-8");
					}
					return;
				}
				writeLine(line);
			};

			const onProcessGroup = (pgid: number): void => {
				execRegistry.setPgid(entry.execId, pgid);
				writeEvent({
					v: 1,
					type: "started",
					execId: entry.execId,
					pgid,
					requestId,
					ts: new Date().toISOString(),
				});
				startedSent = true;
				for (const line of preStart) writeLine(line);
				preStart.length = 0;
				if (preStartDroppedBytes > 0) {
					logger.warn(
						`[exec] ${entry.execId} dropped ${preStartDroppedBytes} pre-sentinel output bytes (buffer cap ${PRESTART_BUF_MAX_BYTES})`,
					);
					writeEvent({
						v: 1,
						type: "dropped",
						scope: "pre-start",
						bytes: preStartDroppedBytes,
					});
				}
			};

			// The timer marks intent BEFORE killing so the exit event that
			// follows is attributed `timeout` even if the process exits
			// between the mark and the signal landing; `already-exited`
			// walks the mark back (it beat us — that's a natural exit).
			const maxDurationMs = body.maxDurationMs ?? MAX_DURATION_MS_MAX;
			const timer = setTimeout(() => {
				execRegistry.markKillIntent(entry.execId, "timeout");
				const pgid = execRegistry.get(entry.execId)?.pgid;
				if (pgid === undefined) {
					logger.warn(`[exec] ${entry.execId} hit maxDurationMs with no pgid; cannot kill`);
					return;
				}
				docker
					.killExecProcessGroup(sessionId, pgid, GRACE_MS_DEFAULT)
					.then((outcome) => {
						if (outcome === "already-exited") execRegistry.clearKillIntent(entry.execId);
					})
					.catch((err) => {
						logger.warn(
							`[exec] timeout kill for ${entry.execId} failed: ${(err as Error).message}`,
						);
					});
			}, maxDurationMs);

			try {
				const { exitCode } = await docker.streamExec(
					sessionId,
					{
						cmd: body.cmd,
						env,
						workingDir: body.workingDir,
						// Always a fresh group: the pgid is the cancellation
						// handle and there is no reason to offer an
						// uncancellable mode at this seam.
						newProcessGroup: true,
						onProcessGroup,
						onStreamHandle: (handle) => {
							streamHandle = handle;
							if (clientGone) handle.resume();
						},
					},
					onOutput,
				);
				execRegistry.markExited(entry.execId, exitCode);
				if (startedSent) {
					const reason = execRegistry.get(entry.execId)?.reason ?? "exited";
					writeEvent({ v: 1, type: "exit", exitCode, reason, ts: new Date().toISOString() });
					res.end();
				} else {
					// The exec ran to completion without the wrapper ever
					// reporting a pgid (fail-open sentinel path). Nothing has
					// been written, so a plain status response is still
					// possible — more honest than a stream that violates the
					// started-first contract.
					res.status(500).json({ error: "exec completed without reporting a process group" });
				}
			} catch (err) {
				execRegistry.markExited(entry.execId, null);
				if (res.headersSent) {
					// Mid-stream failure (container died, docker error): the
					// status line is long gone — contract says failures now
					// arrive as a terminal `error` event.
					writeEvent({ v: 1, type: "error", code: "exec-failed", message: (err as Error).message });
					res.end();
				} else if ((err as Error).message === "No container for this session") {
					// Session flipped to stopped between the meta check and
					// the exec — same 409 the pre-check would have returned.
					res.status(409).json({ error: "container-not-running" });
				} else {
					handleSessionError(err, res);
				}
			} finally {
				clearTimeout(timer);
			}
		} catch (err) {
			if (err instanceof EnvVarValidationError) {
				res.status(400).json({ error: err.message });
				return;
			}
			handleSessionError(err, res);
		}
	});

	// ── GET /sessions/:id/exec/:execId — recovery/status ────────────────────

	router.get("/sessions/:id/exec/:execId", async (req: Request, res: Response) => {
		const userId = (req as AuthedRequest).userId;
		try {
			await sessions.assertOwnedBy(req.params.id, userId);
			setRequestIdHeader(res);
			const entry = execRegistry.get(req.params.execId);
			// "Not in the registry" and "registry lost on restart" are
			// indistinguishable from in here, so an unknown execId answers
			// `state: "unknown"` rather than 404 — the contract's restart
			// semantics already force consumers to handle that state, and a
			// 404 would misread as "this exec never existed" after a reboot.
			// Scoping to the session id keeps a foreign owner's execId from
			// confirming its existence (they'd see "unknown" too).
			if (!entry || entry.sessionId !== req.params.id) {
				res.json({ execId: req.params.execId, state: "unknown" });
				return;
			}
			if (entry.state === "running") {
				res.json({
					execId: entry.execId,
					state: "running",
					pgid: entry.pgid ?? null,
					startedAt: entry.startedAt.toISOString(),
				});
				return;
			}
			res.json({
				execId: entry.execId,
				state: "exited",
				exitCode: entry.exitCode,
				reason: entry.reason,
				endedAt: entry.endedAt?.toISOString(),
			});
		} catch (err) {
			handleSessionError(err, res);
		}
	});

	// ── POST /sessions/:id/exec/:execId/kill ────────────────────────────────

	router.post("/sessions/:id/exec/:execId/kill", execIp, async (req: Request, res: Response) => {
		const userId = (req as AuthedRequest).userId;
		try {
			await sessions.assertOwnedBy(req.params.id, userId);
			setRequestIdHeader(res);
			const parsed = KillBodySchema.safeParse(req.body ?? {});
			if (!parsed.success) {
				res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
				return;
			}
			const graceMs = parsed.data.graceMs ?? GRACE_MS_DEFAULT;
			const entry = execRegistry.get(req.params.execId);
			if (!entry || entry.sessionId !== req.params.id) {
				// Unlike status, kill without a pgid is impossible, so 404 is
				// the honest answer for an id the registry doesn't hold.
				res.status(404).json({ error: "unknown execId" });
				return;
			}
			if (entry.state === "exited") {
				// Answer from the registry WITHOUT re-probing /proc: the pgid
				// may have been recycled by an unrelated process group inside
				// the container, and a probe-then-kill there would shoot it.
				res.json({ outcome: "already-exited" });
				return;
			}
			if (entry.pgid === undefined) {
				res.status(409).json({ error: "pgid-unavailable" });
				return;
			}
			execRegistry.markKillIntent(entry.execId, "killed");
			const outcome = await docker.killExecProcessGroup(req.params.id, entry.pgid, graceMs);
			// Walkback is best-effort: if the natural exit settled DURING the
			// await above, markExited already consumed the intent and the
			// stream said `reason:"killed"` — this clear is then a no-op and
			// the two surfaces disagree for that one exec. Documented in
			// docs/EXEC_API.md (§kill, "Known attribution race"): the kill
			// outcome is the authoritative signal. Closing the window means
			// deferring reason resolution past this round-trip — not worth
			// the machinery at v1.
			if (outcome === "already-exited") execRegistry.clearKillIntent(entry.execId);
			res.json({ outcome });
		} catch (err) {
			handleSessionError(err, res);
		}
	});
}
