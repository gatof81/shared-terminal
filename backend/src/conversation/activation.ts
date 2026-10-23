/**
 * conversation/activation.ts — docs/CONVERSATION.md §2: how a session's
 * capture gets switched on and off, and the files that carry it.
 *
 * Two states, deliberately (§2.4): what the operator REQUESTED (a D1
 * column) and what is EFFECTIVE (a container started with
 * `ST_INGEST_TOKEN` plus the hooks file mounted read-only). A container's
 * env is immutable, so the two can disagree until the next start, and
 * the list endpoint reports both rather than promising capture that is
 * not happening.
 *
 * Files:
 *   <WORKSPACE_ROOT>/.claude-managed/<sid>/conversation.json   mounted ro at
 *   /etc/claude-code/managed-settings.d/ inside the container (§2.1)
 *
 * The hooks file is byte-exact per §2.2 and is written ONLY when the
 * session is requested AND the backend's feature flag is on: without a
 * receiver there must be no emitter, which is what makes a partial
 * deployment harmless.
 *
 * The emergency CLI shares `disableSession`/`disableAll` with the API
 * path; only the API variant can also invalidate the receiver's cache in
 * process, which is why the on-disk revocation marker (§2.5) is written
 * FIRST in every disable, before D1, before the file.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import {
	generateIngestToken,
	getSessionCapture,
	hashIngestToken,
	restoreIngestToken,
	revokeAllIngestTokens,
	revokeIngestTokens,
	setConversationRequested,
	setIngestTokenHash,
	suspendIngestToken,
} from "./registry.js";
import {
	checkRevocation,
	removeGlobalRevocation,
	removeSessionRevocation,
	writeGlobalRevocation,
	writeSessionRevocation,
} from "./revocation.js";

export const HOOKS_FILE_NAME = "conversation.json";
export const MANAGED_MOUNT_TARGET = "/etc/claude-code/managed-settings.d";
export const INGEST_TOKEN_ENV = "ST_INGEST_TOKEN";
export const INGEST_PATH = "/ingest/claude/hook";
/** Network alias of the backend on sessions-net: the relay's fixed upstream. */
export const BACKEND_ALIAS = "st-backend";
export const SESSION_START_SCRIPT = "/opt/st/hooks/session-start.sh";
/**
 * §2.6 — the in-container relay the hooks target. Loopback because CLI
 * 2.1.308 refuses HTTP hooks to private addresses, which `st-backend`
 * always resolves to; fixed port, shared with relay.py and the script.
 */
export const RELAY_URL = `http://127.0.0.1:47613${INGEST_PATH}`;
/** Tells the relay the backend `PORT` (its upstream is `st-backend:<port>`). */
export const BACKEND_PORT_ENV = "ST_BACKEND_PORT";

export function managedRoot(workspaceRoot: string): string {
	return path.resolve(workspaceRoot, ".claude-managed");
}
export function managedDir(workspaceRoot: string, sessionId: string): string {
	return path.join(managedRoot(workspaceRoot), sessionId);
}
export function hooksFilePath(workspaceRoot: string, sessionId: string): string {
	return path.join(managedDir(workspaceRoot, sessionId), HOOKS_FILE_NAME);
}

/**
 * Exactly §2.2. Key order and the per-hook shape are part of the contract.
 * No token and no session header: the relay adds both from its own env, so
 * the CLI never handles the credential.
 */
export function buildHooksSettings(): string {
	const http = {
		type: "http",
		url: RELAY_URL,
		timeout: 1,
		headers: { "X-ST-Tmux-Pane": "$TMUX_PANE" },
		allowedEnvVars: ["TMUX_PANE"],
	};
	const plain = () => [{ hooks: [http] }];
	const matched = () => [{ matcher: "*", hooks: [http] }];
	const settings = {
		hooks: {
			SessionStart: [{ hooks: [{ type: "command", command: SESSION_START_SCRIPT, async: true }] }],
			UserPromptSubmit: plain(),
			MessageDisplay: plain(),
			PreToolUse: matched(),
			PostToolUse: matched(),
			PostToolUseFailure: matched(),
			Stop: plain(),
			StopFailure: plain(),
			SubagentStart: plain(),
			SubagentStop: plain(),
			Notification: plain(),
			PermissionRequest: plain(),
			PreCompact: plain(),
			PostCompact: plain(),
			TaskCreated: plain(),
			TaskCompleted: plain(),
			TeammateIdle: plain(),
			SessionEnd: plain(),
		},
	};
	return `${JSON.stringify(settings, null, 2)}\n`;
}

export interface ActivationDeps {
	workspaceRoot: string;
	/** `CONVERSATION_ENABLED`. */
	enabled: boolean;
	/** Backend `PORT`, baked into the hooks URL. */
	port: number;
	/** In-process cache invalidation (API path); the CLI passes a no-op. */
	invalidate?: (sessionId: string) => void;
}

export class ConversationDisabledError extends Error {
	constructor() {
		super("conversation capture is disabled on this deployment");
		this.name = "ConversationDisabledError";
	}
}
export class RevokedGloballyError extends Error {
	constructor() {
		super("conversation capture is revoked globally; run conversation:enable-all first");
		this.name = "RevokedGloballyError";
	}
}

// ── Files ───────────────────────────────────────────────────────────────────

async function ensureManagedDir(workspaceRoot: string, sessionId: string): Promise<string> {
	const dir = managedDir(workspaceRoot, sessionId);
	// Root-owned (the backend runs as root in its container), 0755 so the
	// session user can READ the mounted copy; the mount itself is `ro`.
	await fs.mkdir(dir, { recursive: true, mode: 0o755 });
	return dir;
}

export async function writeHooksFile(deps: ActivationDeps, sessionId: string): Promise<void> {
	const dir = await ensureManagedDir(deps.workspaceRoot, sessionId);
	const file = path.join(dir, HOOKS_FILE_NAME);
	const tmp = `${file}.tmp.${process.pid}`;
	await fs.writeFile(tmp, buildHooksSettings(), { mode: 0o644 });
	await fs.rename(tmp, file);
}

export async function removeHooksFile(workspaceRoot: string, sessionId: string): Promise<void> {
	await fs.rm(hooksFilePath(workspaceRoot, sessionId), { force: true });
}

export async function hooksFileExists(workspaceRoot: string, sessionId: string): Promise<boolean> {
	try {
		await fs.stat(hooksFilePath(workspaceRoot, sessionId));
		return true;
	} catch {
		return false;
	}
}

/** Delete every `conversation.json` under `.claude-managed` (global off / reconcile). */
export async function removeAllHooksFiles(workspaceRoot: string): Promise<string[]> {
	const root = managedRoot(workspaceRoot);
	let entries: string[];
	try {
		entries = await fs.readdir(root);
	} catch {
		return [];
	}
	const removed: string[] = [];
	for (const sid of entries) {
		const file = path.join(root, sid, HOOKS_FILE_NAME);
		try {
			await fs.stat(file);
			await fs.rm(file, { force: true });
			removed.push(sid);
		} catch {
			/* nothing there */
		}
	}
	return removed;
}

/** Purge for hard delete: contained under `.claude-managed`. */
export async function purgeManagedDir(workspaceRoot: string, sessionId: string): Promise<void> {
	const root = managedRoot(workspaceRoot);
	const dir = path.resolve(root, sessionId);
	if (path.dirname(dir) !== root || !dir.startsWith(root + path.sep)) {
		throw new Error(`[conversation] refusing to purge managed dir outside root: ${dir}`);
	}
	await fs.rm(dir, { recursive: true, force: true });
}

// ── Spawn-time preparation (§2.4 "start / spawn" row) ───────────────────────

export interface SpawnCapture {
	/** Extra `KEY=VALUE` entries for the container env. */
	env: string[];
	/** Extra bind mounts (`host:container:ro`). */
	binds: string[];
	/** True when a token was generated and the hooks file written. */
	effective: boolean;
}

/**
 * Called by `DockerManager.spawnWithConfig` before `createContainer`.
 * Flag off ⇒ nothing (no dir, no bind, no env): behaviour-neutral.
 * Flag on ⇒ the managed dir exists and is mounted ro; the hooks file
 * and the token exist only when the session is requested and not revoked.
 */
export async function prepareSpawnCapture(
	deps: ActivationDeps,
	sessionId: string,
): Promise<SpawnCapture> {
	if (!deps.enabled) return { env: [], binds: [], effective: false };
	const dir = await ensureManagedDir(deps.workspaceRoot, sessionId);
	const bind = `${dir}:${MANAGED_MOUNT_TARGET}:ro`;
	const row = await getSessionCapture(sessionId);
	const requested = row?.conversation_requested === 1;
	const revoked = (await checkRevocation(deps.workspaceRoot, sessionId)) !== "none";
	if (!requested || revoked) {
		await removeHooksFile(deps.workspaceRoot, sessionId);
		if (row?.ingest_token_hash || row?.ingest_token_hash_suspended) {
			await revokeIngestTokens(sessionId);
		}
		deps.invalidate?.(sessionId);
		return { env: [], binds: [bind], effective: false };
	}
	// A new container means a new token: the old one (if any) died with
	// the old env. Hash to D1 BEFORE the file so a crash between the two
	// leaves "token but no emitter", never "emitter but no acceptor".
	const token = generateIngestToken();
	await setIngestTokenHash(sessionId, hashIngestToken(token));
	deps.invalidate?.(sessionId);
	await writeHooksFile(deps, sessionId);
	return {
		env: [`${INGEST_TOKEN_ENV}=${token}`, `${BACKEND_PORT_ENV}=${deps.port}`],
		binds: [bind],
		effective: true,
	};
}

// ── Enable / disable (§2.4 rows) ────────────────────────────────────────────

export interface ActivationResult {
	enabled: boolean;
	effective: boolean;
	effectiveAfterRestart: boolean;
	/** Only on disable; false until the 3.0c smoke test measures hot reload. */
	emissionStopsAfterRestart?: boolean;
}

/**
 * `PATCH … {enabled:true}` semantics. Requires the flag on; refuses while
 * the global marker is present; clears the per-session marker.
 */
export async function enableSession(
	deps: ActivationDeps,
	sessionId: string,
	containerRunning: boolean,
): Promise<ActivationResult> {
	if (!deps.enabled) throw new ConversationDisabledError();
	const revocation = await checkRevocation(deps.workspaceRoot, sessionId);
	if (revocation === "global") throw new RevokedGloballyError();
	const row = await getSessionCapture(sessionId);
	if (!row) throw new Error("session not found");
	deps.invalidate?.(sessionId);
	if (containerRunning && row.ingest_token_hash_suspended) {
		// Disabled and re-enabled without a restart: the container still
		// carries the token, so restoring the hash makes capture effective now.
		await restoreIngestToken(sessionId);
		await removeSessionRevocation(deps.workspaceRoot, sessionId);
		await writeHooksFile(deps, sessionId);
		deps.invalidate?.(sessionId);
		return { enabled: true, effective: true, effectiveAfterRestart: false };
	}
	await setConversationRequested(sessionId, true);
	await removeSessionRevocation(deps.workspaceRoot, sessionId);
	deps.invalidate?.(sessionId);
	if (containerRunning && row.ingest_token_hash) {
		// Already effective (token live, file present or re-written).
		await writeHooksFile(deps, sessionId);
		return { enabled: true, effective: true, effectiveAfterRestart: false };
	}
	// Stopped, or running without a token: nothing until the next start.
	// Writing the file now would only make hooks fire without a token.
	await removeHooksFile(deps.workspaceRoot, sessionId);
	return { enabled: true, effective: false, effectiveAfterRestart: true };
}

/**
 * `PATCH … {enabled:false}` and the emergency CLI share this order:
 * marker → D1 → file (§2.5). Success is reported only after all three.
 * A D1 failure leaves the marker in place (the cut stays in force) and
 * propagates, without touching the file.
 */
export async function disableSession(
	deps: ActivationDeps,
	sessionId: string,
	by: "api" | "cli",
	reason?: string,
): Promise<ActivationResult> {
	deps.invalidate?.(sessionId);
	await writeSessionRevocation(deps.workspaceRoot, sessionId, {
		at: new Date().toISOString(),
		by,
		...(reason ? { reason } : {}),
	});
	deps.invalidate?.(sessionId);
	if (by === "api") await suspendIngestToken(sessionId);
	else await revokeIngestTokens(sessionId);
	deps.invalidate?.(sessionId);
	await removeHooksFile(deps.workspaceRoot, sessionId);
	return {
		enabled: false,
		effective: false,
		effectiveAfterRestart: false,
		emissionStopsAfterRestart: true,
	};
}

/** Emergency `--all`: global marker, every row revoked, every file removed. */
export async function disableAll(deps: ActivationDeps, reason?: string): Promise<string[]> {
	await writeGlobalRevocation(deps.workspaceRoot, {
		at: new Date().toISOString(),
		by: "cli",
		...(reason ? { reason } : {}),
	});
	await revokeAllIngestTokens();
	return removeAllHooksFiles(deps.workspaceRoot);
}

/** `conversation:enable-all`: removes only the global marker. */
export async function enableAll(deps: ActivationDeps): Promise<void> {
	await removeGlobalRevocation(deps.workspaceRoot);
}

/** Capture status block for `GET …/conversations` (§6). */
export async function captureStatus(
	deps: ActivationDeps,
	sessionId: string,
): Promise<{ requested: boolean; effective: boolean; effectiveAfterRestart: boolean }> {
	const row = await getSessionCapture(sessionId);
	const requested = deps.enabled && row?.conversation_requested === 1;
	const revoked = (await checkRevocation(deps.workspaceRoot, sessionId)) !== "none";
	const effective =
		requested &&
		!revoked &&
		row?.status === "running" &&
		!!row.ingest_token_hash &&
		(await hooksFileExists(deps.workspaceRoot, sessionId));
	return { requested, effective, effectiveAfterRestart: requested && !effective };
}

export function logActivation(msg: string): void {
	logger.info(`[conversation] ${msg}`);
}
