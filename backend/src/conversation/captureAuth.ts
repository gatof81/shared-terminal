/**
 * conversation/captureAuth.ts — 3.0d capture authorization and the
 * `capture` block (docs/CONVERSATION.md §2.4, §2.7.5, §2.7.6).
 *
 * Three levels of authorization (§2.7.5):
 *   - WRITE (in place): flag ∧ requested ∧ no revocation ∧ the D1 container
 *     exists, is running and has BOTH mounts (managed + control) ∧ its own
 *     image carries `conversation-relay="2"` ∧ token↔hash correspondence;
 *   - RETAIN: the same without "running" — a stop keeps what was written;
 *   - SPAWN PREPARATION: lives in activation.ts (`prepareSpawnCapture`): the
 *     container does not exist yet, correspondence holds by construction.
 *
 * Correspondence (§2.7.6, A3): sha256 of the `ST_INGEST_TOKEN` in the D1
 * container's own env, compared in constant time with the authorized hash.
 * Computed in memory, never logged, returned or stored. A mismatch is never
 * repaired by copying the fingerprint into D1.
 *
 * Availability (D7): `effective:true` needs a probe of
 * `GET /st-relay/status` made DURING the request — no positive cache.
 * Concurrent requests for one container share the probe in flight
 * (single-flight) and never reuse a finished one; when anything else is
 * false no probe runs at all.
 *
 * Fail-closed throughout: a Docker or D1 error, an unreadable file, an
 * unresolved recreation — none of them can yield `effective:true` or a
 * write.
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import { assertSafeComponent } from "./ids.js";
import { type SessionCaptureRow, tokenMatchesHash } from "./registry.js";
import type { RevocationState } from "./revocation.js";

export const CONTROL_DIR_NAME = ".st-control";
export const CONTROL_MOUNT_TARGET = "/etc/st-control";
export const RELAY_ENABLED_FILE = "relay.enabled";
export const RELAY_IMAGE_LABEL = "io.shared-terminal.conversation-relay";
export const RELAY_IMAGE_LABEL_VALUE = "2";
export const RELAY_STATUS_URL = "http://127.0.0.1:47613/st-relay/status";
/** One identification probe (§2.7.6). */
export const RELAY_PROBE_TIMEOUT_MS = 2000;
/** How long the write procedure waits for the relay to identify (§2.7.5). */
export const RELAY_IDENTIFY_WAIT_MS = 5000;
const IDENTIFY_POLL_MS = 250;
/** Upper bound of one probe: curl's `-m` plus the exec timeout margin. */
export const RELAY_PROBE_BUDGET_MS = 2500;

// ── Docker view ─────────────────────────────────────────────────────────────

export type ContainerView =
	| { exists: false }
	| {
			exists: true;
			running: boolean;
			/** `ST_INGEST_TOKEN` from the container's own env, or null. */
			token: string | null;
			managedMount: boolean;
			controlMount: boolean;
			imageId: string;
			/** The container's OWN image carries `conversation-relay="2"`. */
			imageRelay2: boolean;
	  };

export interface CaptureDockerPort {
	/** Throws on a daemon error; `{exists:false}` only for a 404. */
	inspectCapture(containerId: string): Promise<ContainerView>;
	/** The image a spawn would use now; null when it doesn't exist. */
	currentImage(): Promise<{ imageId: string; relay2: boolean } | null>;
	/** One `GET /st-relay/status` inside the container, ≤ RELAY_PROBE_TIMEOUT_MS. */
	probeRelay(sessionId: string, containerId: string): Promise<boolean>;
}

// ── Control dir (host side) ─────────────────────────────────────────────────

export function controlDir(workspaceRoot: string, sessionId: string): string {
	assertSafeComponent(sessionId, "session id");
	const root = path.resolve(workspaceRoot, CONTROL_DIR_NAME);
	const dir = path.resolve(root, sessionId);
	if (path.dirname(dir) !== root) throw new Error("[conversation] control dir escapes its root");
	return dir;
}

export function relayEnabledPath(workspaceRoot: string, sessionId: string): string {
	return path.join(controlDir(workspaceRoot, sessionId), RELAY_ENABLED_FILE);
}

/**
 * root:root 0755 by an explicit chmod every time (§2.1): the session user
 * must be able to SEARCH the mounted dir, and mkdir never changes the mode
 * of a directory that already exists.
 */
export async function ensureControlDir(workspaceRoot: string, sessionId: string): Promise<string> {
	const dir = controlDir(workspaceRoot, sessionId);
	await fs.mkdir(dir, { recursive: true, mode: 0o755 });
	await fs.chmod(dir, 0o755);
	return dir;
}

export async function writeRelayEnabled(workspaceRoot: string, sessionId: string): Promise<void> {
	const dir = await ensureControlDir(workspaceRoot, sessionId);
	const file = path.join(dir, RELAY_ENABLED_FILE);
	// Unique per call: two writers of one session (an enable racing
	// reconcile) must not consume each other's temp file.
	const tmp = `${file}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
	await fs.writeFile(tmp, "", { mode: 0o644 });
	await fs.chmod(tmp, 0o644);
	await fs.rename(tmp, file);
}

export async function removeRelayEnabled(workspaceRoot: string, sessionId: string): Promise<void> {
	await fs.rm(relayEnabledPath(workspaceRoot, sessionId), { force: true });
}

/** Fail-closed for decisions that GRANT: an error reads as "absent". */
export async function relayEnabledExists(
	workspaceRoot: string,
	sessionId: string,
): Promise<boolean> {
	try {
		await fs.lstat(relayEnabledPath(workspaceRoot, sessionId));
		return true;
	} catch {
		return false;
	}
}

/** Global off / flag off: every `relay.enabled` under `.st-control`. */
export async function removeAllRelayMarkers(workspaceRoot: string): Promise<string[]> {
	const root = path.resolve(workspaceRoot, CONTROL_DIR_NAME);
	let entries: string[];
	try {
		entries = await fs.readdir(root);
	} catch {
		return [];
	}
	const removed: string[] = [];
	for (const sid of entries) {
		// Same guard as controlDir(): never build a path from an odd entry.
		try {
			assertSafeComponent(sid, "session id");
		} catch {
			continue;
		}
		const file = path.join(root, sid, RELAY_ENABLED_FILE);
		try {
			await fs.lstat(file);
			await fs.rm(file, { force: true });
			removed.push(sid);
		} catch {
			/* nothing there */
		}
	}
	return removed;
}

// ── Facts and pure rules ────────────────────────────────────────────────────

export type Correspondence = "match" | "suspended" | "mismatch" | "no-token" | "no-container";

export interface CaptureFacts {
	flag: boolean;
	row: SessionCaptureRow | null;
	revocation: RevocationState;
	unresolved: boolean;
	/** null: D1 holds no container id. */
	container: ContainerView | null;
	currentImageRelay2: boolean;
	marker: boolean;
	hooksFile: boolean;
}

export function correspondenceOf(facts: CaptureFacts): Correspondence {
	const c = facts.container;
	if (!c || !c.exists) return "no-container";
	if (!c.token) return "no-token";
	const hash = facts.row?.ingest_token_hash ?? null;
	const suspended = facts.row?.ingest_token_hash_suspended ?? null;
	if (hash && tokenMatchesHash(c.token, hash)) return "match";
	if (!hash && suspended && tokenMatchesHash(c.token, suspended)) return "suspended";
	return "mismatch";
}

function requested(f: CaptureFacts): boolean {
	return f.row?.conversation_requested === 1;
}

/** Everything but the container's state: who may have capture at all. */
function sessionAllowed(f: CaptureFacts): boolean {
	return f.flag && requested(f) && f.revocation === "none" && !f.unresolved;
}

function containerCapable(f: CaptureFacts): boolean {
	const c = f.container;
	return !!c && c.exists && c.managedMount && c.controlMount && c.imageRelay2;
}

/** §2.7.5 — authorization to WRITE the marker and the hooks file in place. */
export function writeAuthorized(f: CaptureFacts): boolean {
	const c = f.container;
	return (
		sessionAllowed(f) &&
		containerCapable(f) &&
		!!c &&
		c.exists &&
		c.running &&
		correspondenceOf(f) === "match"
	);
}

/** §2.7.5 — authorization to KEEP them (stopped included). */
export function retainAuthorized(f: CaptureFacts): boolean {
	return sessionAllowed(f) && containerCapable(f) && correspondenceOf(f) === "match";
}

export type PendingReason =
	| "flag-off"
	| "not-requested"
	| "revoked"
	| "recreate-unresolved"
	| "container-without-capture"
	| "token-mismatch"
	| "image-without-relay"
	| "stopped"
	| "hooks-file-missing"
	| "relay-unavailable";

export interface CaptureBlock {
	requested: boolean;
	effective: boolean;
	effectiveAfterRestart: boolean;
	requiresRecreate: boolean;
	pendingReasons: PendingReason[];
	/** Time of the relay probe made for this request; null if none ran. */
	checkedAt: string | null;
}

/**
 * The block without the probe: `candidate` is true when only the probe can
 * still decide `effective`.
 */
export function baseCapture(f: CaptureFacts): Omit<CaptureBlock, "effective" | "checkedAt"> & {
	candidate: boolean;
} {
	const reasons: PendingReason[] = [];
	const c = f.container;
	const corr = correspondenceOf(f);
	if (!f.flag) reasons.push("flag-off");
	if (!requested(f)) reasons.push("not-requested");
	if (f.revocation !== "none") reasons.push("revoked");
	if (f.unresolved) reasons.push("recreate-unresolved");
	const noContainer = !c || !c.exists;
	let requiresRecreate = false;
	if (noContainer) {
		if (!f.currentImageRelay2) reasons.push("image-without-relay");
	} else {
		const withoutCapture = !c.token || !c.managedMount || !c.controlMount;
		if (withoutCapture) reasons.push("container-without-capture");
		else if (corr === "mismatch") reasons.push("token-mismatch");
		if (!c.imageRelay2) reasons.push("image-without-relay");
		if (!c.running) reasons.push("stopped");
		requiresRecreate = withoutCapture || corr === "mismatch";
		if (corr === "match" && (!f.marker || !f.hooksFile)) reasons.push("hooks-file-missing");
	}
	const effectiveAfterRestart = noContainer
		? sessionAllowed(f) && f.currentImageRelay2
		: !!c && !c.running && retainAuthorized(f) && f.marker && f.hooksFile;
	const candidate = writeAuthorized(f) && f.marker && f.hooksFile;
	return {
		requested: requested(f),
		effectiveAfterRestart,
		requiresRecreate,
		pendingReasons: reasons,
		candidate,
	};
}

// ── Authority ───────────────────────────────────────────────────────────────

export interface CaptureAuthorityDeps {
	workspaceRoot: string;
	enabled: boolean;
	docker: CaptureDockerPort;
	getRow: (sessionId: string) => Promise<SessionCaptureRow | null>;
	checkRevocation: (sessionId: string) => Promise<RevocationState>;
	isRecreateUnresolved: (sessionId: string) => Promise<boolean>;
	writeHooksFile: (sessionId: string) => Promise<void>;
	removeHooksFile: (sessionId: string) => Promise<void>;
	hooksFileExists: (sessionId: string) => Promise<boolean>;
	now?: () => number;
	/** Pause between identification polls (tests advance a fake clock). */
	sleep?: (ms: number) => Promise<void>;
	/**
	 * Real wall-clock bound for one probe. A Docker exec can hang in any
	 * of its stages (create, start, the stream, inspect) and execCapture
	 * bounds only some of them; the authority never waits longer than
	 * this, whatever Docker does. Tests shrink it.
	 */
	probeBudgetMs?: number;
	identifyWaitMs?: number;
}

const TIMED_OUT = Symbol("timed-out");

export type WriteOutcome = "written" | "not-authorized" | "relay-unavailable" | "revoked-meanwhile";

export class CaptureAuthority {
	private readonly inflight = new Map<string, Promise<boolean>>();

	constructor(private readonly deps: CaptureAuthorityDeps) {}

	private now(): number {
		return this.deps.now ? this.deps.now() : Date.now();
	}

	private sleep(ms: number): Promise<void> {
		return this.deps.sleep ? this.deps.sleep(ms) : new Promise((r) => setTimeout(r, ms));
	}

	/**
	 * Everything the rules need, read fresh. Docker/D1 errors propagate:
	 * the callers turn them into "not effective", never into a grant.
	 */
	async facts(sessionId: string): Promise<CaptureFacts> {
		const row = await this.deps.getRow(sessionId);
		const revocation = await this.deps.checkRevocation(sessionId);
		const unresolved = await this.deps.isRecreateUnresolved(sessionId).catch(() => true);
		const container = row?.container_id
			? await this.deps.docker.inspectCapture(row.container_id)
			: null;
		const current = await this.deps.docker.currentImage().catch(() => null);
		return {
			flag: this.deps.enabled,
			row,
			revocation,
			unresolved,
			container,
			currentImageRelay2: !!current?.relay2,
			marker: await relayEnabledExists(this.deps.workspaceRoot, sessionId),
			hooksFile: await this.deps.hooksFileExists(sessionId).catch(() => false),
		};
	}

	/**
	 * D7 single-flight on the EXECUTION: callers that arrive while a probe
	 * of this container is still running share it, even past their own
	 * deadline — a hung Docker exec is never multiplied. Once it settles
	 * the entry is gone and the next caller probes again. A failing probe
	 * is `false`.
	 */
	private execution(sessionId: string, containerId: string): Promise<boolean> {
		const running = this.inflight.get(containerId);
		if (running) return running;
		const p = this.deps.docker
			.probeRelay(sessionId, containerId)
			.catch(() => false)
			.finally(() => {
				if (this.inflight.get(containerId) === p) this.inflight.delete(containerId);
			});
		this.inflight.set(containerId, p);
		return p;
	}

	/**
	 * One probe, bounded: answers by `deadline` (deps clock) and within the
	 * real-time budget at the latest. A positive that arrives after the
	 * deadline does not count. `at` is when the answer was taken.
	 */
	async probe(
		sessionId: string,
		containerId: string,
		deadline = this.now() + (this.deps.probeBudgetMs ?? RELAY_PROBE_BUDGET_MS),
	): Promise<{ identified: boolean; at: number }> {
		const remaining = deadline - this.now();
		if (remaining <= 0) return { identified: false, at: this.now() };
		const budget = Math.min(remaining, this.deps.probeBudgetMs ?? RELAY_PROBE_BUDGET_MS);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<typeof TIMED_OUT>((r) => {
			timer = setTimeout(() => r(TIMED_OUT), budget);
		});
		try {
			const r = await Promise.race([this.execution(sessionId, containerId), timeout]);
			const at = this.now();
			if (r === TIMED_OUT) return { identified: false, at };
			return { identified: r && at <= deadline, at };
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * The `capture` block of §2.7.6, fresh. `identifiedAt` is for the one
	 * caller that has just identified the relay itself within the same
	 * request (enable's write procedure): that probe IS this request's
	 * probe, so D7 is met without a second exec.
	 */
	async capture(sessionId: string, opts: { identifiedAt?: number } = {}): Promise<CaptureBlock> {
		let f: CaptureFacts;
		try {
			f = await this.facts(sessionId);
		} catch (err) {
			logger.warn(
				`[conversation] capture facts failed for ${sessionId}: ${(err as Error).message}`,
			);
			return {
				requested: false,
				effective: false,
				effectiveAfterRestart: false,
				requiresRecreate: false,
				pendingReasons: [],
				checkedAt: null,
			};
		}
		const base = baseCapture(f);
		const { candidate, ...rest } = base;
		if (!candidate || !f.container || !f.container.exists || !f.row?.container_id) {
			return { ...rest, effective: false, checkedAt: null };
		}
		const containerId = f.row.container_id;
		let identified: boolean;
		let at: number;
		if (opts.identifiedAt !== undefined) {
			identified = true;
			at = opts.identifiedAt;
		} else {
			// `at` is when the probe answered, so a request that joined one
			// already in flight reports the time of the evidence it got.
			({ identified, at } = await this.probe(sessionId, containerId));
		}
		const checkedAt = new Date(at).toISOString();
		if (!identified) {
			return {
				...rest,
				effective: false,
				pendingReasons: [...rest.pendingReasons, "relay-unavailable"],
				checkedAt,
			};
		}
		// The enable path's identification came from its own write procedure,
		// which re-checked authorization and container after it; the facts
		// above were read after that, so there is nothing newer to re-read.
		if (opts.identifiedAt !== undefined) return { ...rest, effective: true, checkedAt };
		// V3: the probe took time. Before saying `effective:true`, the
		// authorization, the configuration and the very container that was
		// identified must still hold — re-read, without a second probe.
		let g: CaptureFacts;
		try {
			g = await this.facts(sessionId);
		} catch {
			return { ...rest, effective: false, checkedAt };
		}
		const after = baseCapture(g);
		const { candidate: still, ...afterRest } = after;
		if (!still || g.row?.container_id !== containerId) {
			return { ...afterRest, effective: false, checkedAt };
		}
		return { ...afterRest, effective: true, checkedAt };
	}

	/**
	 * §2.7.5 write procedure, for a running container with full
	 * authorization: marker → recheck 1–3 → identify the relay (≤ 5 s) →
	 * hooks file → recheck 1–3. A failed recheck removes file then marker;
	 * an unidentified relay removes the marker and never writes the file.
	 */
	async applyWrite(sessionId: string, fresh?: CaptureFacts): Promise<WriteOutcome> {
		return (await this.applyWriteDetailed(sessionId, fresh)).outcome;
	}

	/**
	 * `fresh`: facts the caller has just read for this decision (converge,
	 * enable) — saves a second D1 read and Docker inspect. `identifiedAt`
	 * is when the relay identified, for a caller that reports `capture`.
	 */
	async applyWriteDetailed(
		sessionId: string,
		fresh?: CaptureFacts,
	): Promise<{ outcome: WriteOutcome; identifiedAt?: number }> {
		const f = fresh ?? (await this.facts(sessionId));
		if (!writeAuthorized(f) || !f.row?.container_id) return { outcome: "not-authorized" };
		const containerId = f.row.container_id;
		await writeRelayEnabled(this.deps.workspaceRoot, sessionId);
		// Any throw past this point (a recheck's D1 read, the probe, the
		// hooks-file write) must not leave the marker behind: it would
		// launch a relay no hooks file points at.
		try {
			if (!(await this.stillAllowed(sessionId, containerId))) {
				await this.withdraw(sessionId);
				return { outcome: "revoked-meanwhile" };
			}
			// ≤ 5 s in total, whatever Docker does: every probe is bounded by
			// the overall deadline, and a positive arriving after it doesn't
			// count — no hooks file is written on late evidence.
			const deadline = this.now() + (this.deps.identifyWaitMs ?? RELAY_IDENTIFY_WAIT_MS);
			let identifiedAt: number | undefined;
			for (;;) {
				const r = await this.probe(sessionId, containerId, deadline);
				if (r.identified) {
					identifiedAt = r.at;
					break;
				}
				if (this.now() + IDENTIFY_POLL_MS >= deadline) break;
				await this.sleep(IDENTIFY_POLL_MS);
			}
			if (identifiedAt === undefined) {
				await removeRelayEnabled(this.deps.workspaceRoot, sessionId);
				return { outcome: "relay-unavailable" };
			}
			await this.deps.writeHooksFile(sessionId);
			if (!(await this.stillAllowed(sessionId, containerId))) {
				await this.withdraw(sessionId);
				return { outcome: "revoked-meanwhile" };
			}
			return { outcome: "written", identifiedAt };
		} catch (err) {
			await this.withdraw(sessionId).catch(() => undefined);
			throw err;
		}
	}

	/**
	 * Conditions 1–3 re-read — flag, requested, no revocation (§2.7.5) —
	 * plus the D1 container still being the one this write is about.
	 */
	private async stillAllowed(sessionId: string, containerId: string): Promise<boolean> {
		try {
			const row = await this.deps.getRow(sessionId);
			const revocation = await this.deps.checkRevocation(sessionId);
			return (
				this.deps.enabled &&
				row?.conversation_requested === 1 &&
				row.container_id === containerId &&
				revocation === "none"
			);
		} catch {
			return false;
		}
	}

	/** File first, then marker: the marker never outlives the authorization. */
	async withdraw(sessionId: string): Promise<void> {
		await this.deps.removeHooksFile(sessionId);
		await removeRelayEnabled(this.deps.workspaceRoot, sessionId);
	}

	/**
	 * reconcile (§2.4 row, §2.7.5): running ⇒ converge to full
	 * authorization (write procedure when something is missing); stopped ⇒
	 * keep what retain authorization covers, never write; otherwise remove.
	 * Unresolved recreations are left alone entirely (§2.7.4).
	 */
	async converge(
		sessionId: string,
	): Promise<"written" | "kept" | "withdrawn" | "nothing" | "skipped" | WriteOutcome> {
		const f = await this.facts(sessionId);
		if (f.unresolved) return "skipped";
		const c = f.container;
		if (c?.exists && c.running && writeAuthorized(f)) {
			if (f.marker && f.hooksFile) return "kept";
			return this.applyWrite(sessionId, f);
		}
		// Stopped: never written (start doesn't repair). Keep only a complete
		// pair; a half (marker without file or the reverse) is retired.
		if (c?.exists && !c.running && retainAuthorized(f) && f.marker && f.hooksFile) return "kept";
		if (!f.marker && !f.hooksFile) return "nothing";
		await this.withdraw(sessionId);
		return "withdrawn";
	}
}
