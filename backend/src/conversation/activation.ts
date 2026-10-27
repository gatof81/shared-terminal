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

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import { RecreateUnresolvedError } from "../recreateAttempt.js";
import {
	type CaptureAuthority,
	type CaptureBlock,
	CONTROL_MOUNT_TARGET,
	correspondenceOf,
	ensureControlDir,
	RELAY_IMAGE_LABEL,
	type RelayEvidence,
	removeAllRelayMarkers,
	removeRelayEnabled,
	retainAuthorized,
	writeAuthorized,
	writeDeferSeed,
	writeRelayEnabled,
} from "./captureAuth.js";
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
	// Unique per call: concurrent writers of one session (enable racing
	// reconcile) must not consume each other's temp file.
	const tmp = `${file}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
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
	/** True when a token was generated and the marker + hooks file written. */
	effective: boolean;
	/**
	 * The image ID the label was checked on; the container must be created
	 * from exactly this ID (D6), not from the tag, which can move between
	 * the check and the create.
	 */
	imageId?: string;
}

/**
 * Called by `DockerManager.spawnWithConfig` before `createContainer` — the
 * spawn-preparation authorization of §2.7.5: the container doesn't exist
 * yet, so it needs flag ∧ requested ∧ no revocation ∧ the CURRENT image
 * carrying `conversation-relay="2"`; correspondence holds by construction
 * (a fresh token and its hash).
 *
 * Flag off ⇒ nothing (no dir, no bind, no env): behaviour-neutral.
 * Flag on ⇒ the managed dir exists and is mounted ro; token, hash,
 * `relay.enabled` and the hooks file — in that order — only when
 * authorized, plus the control dir mounted ro at /etc/st-control.
 */
export async function prepareSpawnCapture(
	deps: ActivationDeps,
	sessionId: string,
	currentImage: { imageId: string; relay2: boolean } | null,
): Promise<SpawnCapture> {
	if (!deps.enabled) return { env: [], binds: [], effective: false };
	const dir = await ensureManagedDir(deps.workspaceRoot, sessionId);
	const bind = `${dir}:${MANAGED_MOUNT_TARGET}:ro`;
	const row = await getSessionCapture(sessionId);
	const requested = row?.conversation_requested === 1;
	const revoked = (await checkRevocation(deps.workspaceRoot, sessionId)) !== "none";
	if (!requested || revoked || !currentImage?.relay2) {
		if (requested && !revoked) {
			logger.warn(
				`[conversation] spawn of ${sessionId} without capture: the session image lacks ${RELAY_IMAGE_LABEL}="2" (image-without-relay)`,
			);
		}
		await removeHooksFile(deps.workspaceRoot, sessionId);
		await removeRelayEnabled(deps.workspaceRoot, sessionId);
		if (row?.ingest_token_hash || row?.ingest_token_hash_suspended) {
			await revokeIngestTokens(sessionId);
		}
		deps.invalidate?.(sessionId);
		return { env: [], binds: [bind], effective: false };
	}
	// A new container means a new token: the old one (if any) died with
	// the old env. Hash to D1 BEFORE the marker and the file so a crash in
	// between leaves "token but no emitter", never "emitter but no acceptor".
	const token = generateIngestToken();
	await setIngestTokenHash(sessionId, hashIngestToken(token));
	deps.invalidate?.(sessionId);
	let control: string;
	// A disable (CLI or API) may complete while this runs: it removes the
	// files it sees, and a marker or hooks file written after that would
	// outlive it. So authorization is re-read after each write, and the
	// last re-read comes after the hooks file is on disk — a disable that
	// finished before it is seen, one that finishes after it removes it.
	let lost = false;
	try {
		control = await ensureControlDir(deps.workspaceRoot, sessionId);
		lost = !(await spawnStillAuthorized(deps, sessionId));
		if (!lost) {
			await writeRelayEnabled(deps.workspaceRoot, sessionId);
			lost = !(await spawnStillAuthorized(deps, sessionId));
		}
		if (!lost) {
			await writeHooksFile(deps, sessionId);
			lost = !(await spawnStillAuthorized(deps, sessionId));
		}
	} catch (err) {
		// The caller spawns without capture on a throw: leave no marker or
		// file, and no hash for a token no container will carry.
		await removeHooksFile(deps.workspaceRoot, sessionId).catch(() => undefined);
		await removeRelayEnabled(deps.workspaceRoot, sessionId).catch(() => undefined);
		await setIngestTokenHash(sessionId, null).catch(() => undefined);
		deps.invalidate?.(sessionId);
		throw err;
	}
	if (lost) {
		// Withdrawn in the order a disable uses (hooks file, then marker).
		// D1 is the disable's: the hash just written matches no token, since
		// this one is never handed to a container.
		await removeHooksFile(deps.workspaceRoot, sessionId);
		await removeRelayEnabled(deps.workspaceRoot, sessionId);
		deps.invalidate?.(sessionId);
		return { env: [], binds: [bind], effective: false };
	}
	return {
		env: [`${INGEST_TOKEN_ENV}=${token}`, `${BACKEND_PORT_ENV}=${deps.port}`],
		binds: [bind, `${control}:${CONTROL_MOUNT_TARGET}:ro`],
		effective: true,
		imageId: currentImage.imageId,
	};
}

export interface RecreateCapturePrep {
	env: string[];
	binds: string[];
	/** H, the hash of N's token. Only the recreation's CAS ever writes it to D1. */
	hash: string;
}

/**
 * The capture side of recreation step 1 (CONVERSATION.md §2.7.2): N's
 * token and H, `defer-skill-seed`, and both mounts — and NOT the spawn's
 * marker or hooks file. Leftover `relay.enabled` and `conversation.json`
 * are removed, so N's supervisor starts without a relay and N's CLI (none
 * runs before the commit anyway) has no hooks. Nothing goes to D1 here:
 * H is authorized only by the CAS, together with `container_id`.
 */
export async function prepareRecreateCapture(
	deps: ActivationDeps,
	sessionId: string,
	mayAct: () => boolean = () => true,
): Promise<RecreateCapturePrep> {
	// Asked before each effect: the attempt waits for this at most until
	// its epoch closes, and a late continuation must not go on writing.
	const proceed = (): void => {
		if (!mayAct()) throw new Error("recreation capture prepare: stopped, the epoch closed");
	};
	proceed();
	const managed = await ensureManagedDir(deps.workspaceRoot, sessionId);
	proceed();
	const control = await ensureControlDir(deps.workspaceRoot, sessionId);
	proceed();
	await writeDeferSeed(deps.workspaceRoot, sessionId);
	proceed();
	await removeRelayEnabled(deps.workspaceRoot, sessionId);
	proceed();
	await removeHooksFile(deps.workspaceRoot, sessionId);
	const token = generateIngestToken();
	return {
		env: [`${INGEST_TOKEN_ENV}=${token}`, `${BACKEND_PORT_ENV}=${deps.port}`],
		binds: [`${managed}:${MANAGED_MOUNT_TARGET}:ro`, `${control}:${CONTROL_MOUNT_TARGET}:ro`],
		hash: hashIngestToken(token),
	};
}

/** Conditions 1–2 re-read for a spawn: requested, no revocation. Errors ⇒ lost. */
async function spawnStillAuthorized(deps: ActivationDeps, sessionId: string): Promise<boolean> {
	try {
		const row = await getSessionCapture(sessionId);
		const revocation = await checkRevocation(deps.workspaceRoot, sessionId);
		return deps.enabled && row?.conversation_requested === 1 && revocation === "none";
	} catch {
		return false;
	}
}

// ── Enable / disable (§2.4 rows) ────────────────────────────────────────────

export interface EnableResult {
	enabled: true;
	capture: CaptureBlock;
}

export interface DisableResult {
	enabled: false;
	/**
	 * Always true (owner decision, CONVERSATION.md §2.4): the promise is
	 * "stops once the CLI restarts". 2.1.308 was measured to hot-reload,
	 * but self-updating CLIs need not, so nothing relies on it.
	 */
	emissionStopsAfterRestart: true;
}

/**
 * `PATCH … {enabled:true}` (§2.4 rows, §2.7.5). Requires the flag on;
 * refuses under the global marker and while a recreation is unresolved;
 * clears the per-session marker after D1.
 *
 * Writes only through the §2.7.5 procedure and only on a running container
 * with full authorization. A stopped container is never written (its
 * retained config, if any, is kept); a container that can't be made
 * effective in place (no token, a mount missing — e.g. created by the 3.0c
 * backend — or `token-mismatch`) gets its residual marker/file removed and
 * answers `requiresRecreate`. A mismatch is never repaired by copying the
 * container's fingerprint into D1.
 */
export async function enableSession(
	deps: ActivationDeps,
	authority: CaptureAuthority,
	sessionId: string,
	isRecreateUnresolved: (sessionId: string) => Promise<boolean>,
): Promise<EnableResult> {
	if (!deps.enabled) throw new ConversationDisabledError();
	const revocation = await checkRevocation(deps.workspaceRoot, sessionId);
	if (revocation === "global") throw new RevokedGloballyError();
	if (await isRecreateUnresolved(sessionId).catch(() => true)) {
		throw new RecreateUnresolvedError(sessionId, "enable refused");
	}
	const before = await authority.facts(sessionId);
	if (!before.row) throw new Error("session not found");
	deps.invalidate?.(sessionId);
	if (correspondenceOf(before) === "suspended") {
		// Disabled by API without a restart: the container still carries
		// this very token, so the suspended hash is restored as is.
		await restoreIngestToken(sessionId);
	} else {
		await setConversationRequested(sessionId, true);
	}
	await removeSessionRevocation(deps.workspaceRoot, sessionId);
	deps.invalidate?.(sessionId);
	const after = await authority.facts(sessionId);
	const c = after.container;
	let identified: RelayEvidence | undefined;
	if (c?.exists) {
		if (c.running && writeAuthorized(after)) {
			({ identified } = await authority.applyWriteDetailed(sessionId, after));
		} else if (!retainAuthorized(after)) await authority.withdraw(sessionId);
	} else {
		// No container: the next spawn prepares everything from scratch, so
		// whatever a previous container left is retired now.
		await authority.withdraw(sessionId);
	}
	// The write procedure's own identification is this request's probe
	// (D7): reported as such instead of a second exec.
	return { enabled: true, capture: await authority.capture(sessionId, { identified }) };
}

/**
 * `PATCH … {enabled:false}` and the emergency CLI share this order:
 * marker → D1 → hooks file → `relay.enabled` (§2.5). Success is reported
 * only after all of them. A D1 failure leaves the revocation marker in
 * place (the cut stays in force) and propagates, without touching files.
 */
export async function disableSession(
	deps: ActivationDeps,
	sessionId: string,
	by: "api" | "cli",
	reason?: string,
): Promise<DisableResult> {
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
	await removeRelayEnabled(deps.workspaceRoot, sessionId);
	return { enabled: false, emissionStopsAfterRestart: true };
}

/** Emergency `--all`: global marker, every row revoked, every file and marker removed. */
export async function disableAll(deps: ActivationDeps, reason?: string): Promise<string[]> {
	await writeGlobalRevocation(deps.workspaceRoot, {
		at: new Date().toISOString(),
		by: "cli",
		...(reason ? { reason } : {}),
	});
	await revokeAllIngestTokens();
	const removed = await removeAllHooksFiles(deps.workspaceRoot);
	const markers = await removeAllRelayMarkers(deps.workspaceRoot);
	// A session may have only a marker left (crash between the two writes).
	return [...new Set([...removed, ...markers])];
}

/** `conversation:enable-all`: removes only the global marker. */
export async function enableAll(deps: ActivationDeps): Promise<void> {
	await removeGlobalRevocation(deps.workspaceRoot);
}

export function logActivation(msg: string): void {
	logger.info(`[conversation] ${msg}`);
}
