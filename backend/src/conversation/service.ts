/**
 * conversation/service.ts — the orchestrator behind `POST /ingest/claude/hook`
 * and the session-lifecycle hooks (docs/CONVERSATION.md §3–§5).
 *
 * Per event, in this order and with no D1 call on the hot path:
 *   headers → token cache (D1 only on a miss, TTL 60 s) → flag/requested
 *   → token → running → rate buckets → body (already parsed, L5-capped)
 *   → normalise → REVOCATION STAT (last, uncached, §2.5) → dedupe
 *   → state machine → enqueue (store assigns `seq`, persists, broadcasts)
 *
 * The HTTP layer answered 204 before `ingest()` resolves (the hook never
 * waits on disk). Everything that can fail after the 204 degrades into a
 * visible `gap`, never into a thrown error.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import {
	type ActivationDeps,
	type DisableResult,
	disableSession,
	type EnableResult,
	enableSession,
	hooksFileExists,
	purgeManagedDir,
	removeAllHooksFiles,
	removeHooksFile,
	writeHooksFile,
} from "./activation.js";
import {
	CaptureAuthority,
	type CaptureBlock,
	type CaptureDockerPort,
	CONTROL_DIR_NAME,
	RELAY_ENABLED_FILE,
	relayEnabledExists,
	removeAllRelayMarkers,
	removeRelayEnabled,
} from "./captureAuth.js";
import { DedupeTable, identityKey, payloadHash } from "./dedupe.js";
import { isSafeStSessionId } from "./ids.js";
import {
	L2_MESSAGE_BYTES,
	RATE_LIMIT_GAP_WINDOW_MS,
	SESSION_END_GRACE_MS,
	TOKEN_CACHE_TTL_MS,
} from "./limits.js";
import { type NormalizedEvent, normalizeHookInput } from "./normalize.js";
import {
	PROBE_ARGV,
	PROBE_MAX_BYTES,
	PROBE_TIMEOUT_MS,
	type ProbeEntry,
	parseAgentsJson,
} from "./probe.js";
import { LargeBodyGate, SessionRateLimiter } from "./rateLimit.js";
import {
	type ConversationRow,
	deleteConversationRows,
	getSessionCapture,
	HeartbeatCoalescer,
	listConversationRows,
	listRequestedSessions,
	listRunningCaptureSessions,
	reserveConversationOwner,
	revokeIngestTokens,
	tokenMatchesHash,
	updateConversation,
} from "./registry.js";
import { checkRevocation } from "./revocation.js";
import { applyStateInput, type ConversationState, type StateInput } from "./state.js";
import {
	type ConversationIndex,
	type ConversationKind,
	type ConversationStore,
	capOpenMessages,
	type EventListener,
	type PendingEvent,
	type PersistedEvent,
	sealMessage,
} from "./store.js";
import { truncateUtf8, utf8Bytes } from "./text.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type RejectReason =
	| "missing_auth"
	| "disabled"
	| "revoked"
	| "bad_token"
	| "not_running"
	| "session_mismatch"
	| "too_large"
	| "invalid_json"
	| "rate_limited"
	| "backpressure"
	| "malformed"
	| "owner_unverified"
	| "truncated";

export interface IngestHeaders {
	authorization?: string;
	stSession?: string;
	tmuxPane?: string;
}

/** §3.2.1 — what the in-container relay could not deliver before this event. */
export interface RelayReport {
	dropped: number;
	droppedBytes: number;
	unattributed: number;
	restarted: boolean;
}

export type IngestOutcome =
	| { accepted: true; cid: string; dedupe?: false }
	| { accepted: false; reason: RejectReason | "duplicate" };

export interface ConversationSummary {
	sessionId: string;
	kind: ConversationKind;
	title: string | null;
	status: string;
	statusEvidence: string;
	statusAt: string;
	tabId: string | null;
	paneId: string | null;
	startedAt: string;
	endedAt: string | null;
	lastEventAt: string;
	lastSeq: number;
	firstRetainedSeq: number;
	eventsCount: number;
	gapsCount: number;
	claudeVersion: string | null;
	parentSessionId: string | null;
	parentInferred: boolean;
	canSendInput: false;
}

/** `GET /api/admin/stats → conversation` (§7), minus the engine's `recreateOrphans`. */
export interface ConversationAdminStats {
	enabledSessions: number;
	effectiveSessions: number;
	eventsSinceBoot: number;
	rejectedSinceBoot: { byReason: Record<string, number> };
	gapsSinceBoot: number;
	unattributedGaps: number;
	bytesOnDisk: number;
	queueBytesNow: number;
	queueBytesMax: number;
	wsResyncsSinceBoot: number;
}

/** How long one walk of `.conversations` serves the stats (dashboards poll). */
export const DISK_BYTES_TTL_MS = 60_000;

export interface ServiceDeps extends ActivationDeps {
	store: ConversationStore;
	now?: () => number;
	/** `docker.execCapture` shaped runner for the probe; absent in tests. */
	execCapture?: (
		sessionId: string,
		cmd: string[],
		opts: { maxBytes: number; timeoutMs: number },
	) => Promise<{ stdout: Buffer; exitCode: number | null; truncated: boolean; timedOut: boolean }>;
	/** 3.0d (CONVERSATION.md §2.7.4): true while a recreation of the
	 *  session is unresolved; `reconcile` then writes nothing for it. */
	isRecreateUnresolved?: (stSessionId: string) => Promise<boolean>;
	/** 3.0d Docker view for capture authorization (§2.7.5–§2.7.6); absent
	 *  in tests that don't exercise it — then no container is ever seen. */
	captureDocker?: CaptureDockerPort;
}

const NO_DOCKER: CaptureDockerPort = {
	inspectCapture: async () => ({ exists: false }),
	currentImage: async () => null,
	probeRelay: async () => false,
};

interface TokenCacheEntry {
	status: string;
	requested: boolean;
	hash: string | null;
	expiresAt: number;
}

interface ConvRuntime {
	stSessionId: string;
	cid: string;
	/** Purge epoch of the ST session when this runtime was created (B4). */
	epoch: number;
	dedupe: DedupeTable;
	endTimer: NodeJS.Timeout | null;
	lastRateGapAt: number;
	rateDropped: number;
	rateDroppedBytes: number;
}

/** The ST session was hard-deleted while this work was in flight (B4). */
class SessionPurged extends Error {
	constructor() {
		super("session purged during ingest");
	}
}

/** Purged ST session ids remembered per process (B4 admission tombstones). */
const TOMBSTONES_MAX = 10_000;

class OwnerMismatch extends Error {
	constructor(readonly owner: string) {
		super(`conversation belongs to ${owner}`);
	}
}
class OwnerUnverified extends Error {
	constructor() {
		super("ownership could not be verified");
	}
}

// ── Service ─────────────────────────────────────────────────────────────────

export class ConversationService {
	private readonly tokenCache = new Map<string, TokenCacheEntry>();
	/** Claude session_id → ST session id (one Claude session belongs to one ST session). */
	private readonly owner = new Map<string, string>();
	private readonly runtime = new Map<string, ConvRuntime>();
	private wsResyncs = 0;
	/** B2 — in-flight runtime creations, keyed by Claude session id. */
	private readonly creating = new Map<string, { st: string; promise: Promise<ConvRuntime> }>();
	/**
	 * B4 — per-ST-session purge epoch. `onSessionPurged` bumps it FIRST;
	 * every ingest/creation captures the epoch when it starts and re-checks
	 * it after each await, so a continuation that outlives the purge
	 * (a delayed D1 ownership SELECT, a reopen) is abandoned instead of
	 * recreating runtimes, files or heartbeats.
	 */
	private readonly purgeEpoch = new Map<string, number>();

	private epochOf(stSessionId: string): number {
		return this.purgeEpoch.get(stSessionId) ?? 0;
	}
	/**
	 * B4 (round 3) — admission is closed for good once a purge starts. ST
	 * session ids are never reused after a hard delete, so a permanent
	 * per-process tombstone is correct: no new ingest can adopt the bumped
	 * epoch and slip in behind the cleanup. Bounded LRU so a long-lived
	 * process with many hard deletes doesn't grow without limit; an evicted
	 * tombstone falls back to D1 (row gone ⇒ `bad_token`).
	 */
	private readonly tombstones = new Set<string>();
	/** Ingests currently running per ST session; the purge awaits them. */
	private readonly inFlight = new Map<string, Set<Promise<unknown>>>();

	private isDead(stSessionId: string): boolean {
		return this.tombstones.has(stSessionId);
	}

	private tombstone(stSessionId: string): void {
		this.tombstones.delete(stSessionId);
		this.tombstones.add(stSessionId);
		while (this.tombstones.size > TOMBSTONES_MAX) {
			const oldest = this.tombstones.values().next().value;
			if (oldest === undefined) break;
			this.tombstones.delete(oldest);
		}
	}

	/** Heartbeat only for live sessions (B4: no late timer for a purged one). */
	private markDirty(stSessionId: string, cid: string): void {
		if (this.isDead(stSessionId)) return;
		this.heartbeat.markDirty(`${stSessionId}/${cid}`);
	}
	private readonly rate = new SessionRateLimiter();
	readonly largeBodies = new LargeBodyGate();
	private readonly heartbeat: HeartbeatCoalescer;
	private readonly now: () => number;
	readonly stats = {
		eventsSinceBoot: 0,
		rejected: {} as Record<string, number>,
		duplicates: 0,
		gaps: 0,
		unattributedGaps: 0,
		fieldsDropped: 0,
		d1Writes: 0,
		/** Events the session relays reported as undelivered (§2.6). */
		relayDropped: 0,
		relayDroppedUnattributed: 0,
		relayRestarts: 0,
	};

	readonly authority: CaptureAuthority;

	constructor(private readonly deps: ServiceDeps) {
		this.authority = new CaptureAuthority({
			workspaceRoot: deps.workspaceRoot,
			enabled: deps.enabled,
			docker: deps.captureDocker ?? NO_DOCKER,
			getRow: (sid) => getSessionCapture(sid),
			checkRevocation: (sid) => checkRevocation(deps.workspaceRoot, sid),
			isRecreateUnresolved: (sid) =>
				deps.isRecreateUnresolved ? deps.isRecreateUnresolved(sid) : Promise.resolve(false),
			writeHooksFile: (sid) => writeHooksFile(this.activationDeps, sid),
			removeHooksFile: (sid) => removeHooksFile(deps.workspaceRoot, sid),
			hooksFileExists: (sid) => hooksFileExists(deps.workspaceRoot, sid),
			now: deps.now,
		});
		this.now = deps.now ?? Date.now;
		this.heartbeat = new HeartbeatCoalescer(async (key) => {
			const [st, cid] = key.split("/");
			if (this.isDead(st)) return;
			const index = this.deps.store.getResidentIndex(st, cid);
			if (!index) return;
			this.stats.d1Writes++;
			await updateConversation(index);
		});
		deps.store.onEvent((st, cid, ev) => this.onPersisted(st, cid, ev));
	}

	/** The Docker side capture authorization reads (3.0d recreation builds its own authority on it). */
	get captureDocker(): CaptureDockerPort {
		return this.deps.captureDocker ?? NO_DOCKER;
	}

	get activationDeps(): ActivationDeps {
		return {
			workspaceRoot: this.deps.workspaceRoot,
			enabled: this.deps.enabled,
			port: this.deps.port,
			invalidate: (sid) => this.invalidateToken(sid),
		};
	}

	invalidateToken(stSessionId: string): void {
		this.tokenCache.delete(stSessionId);
	}

	private reject(reason: RejectReason | "duplicate"): IngestOutcome {
		if (reason === "duplicate") this.stats.duplicates++;
		else this.stats.rejected[reason] = (this.stats.rejected[reason] ?? 0) + 1;
		return { accepted: false, reason };
	}

	// ── Authorisation (everything before the body) ───────────────────────

	/**
	 * Steps 1–4 of §3.1, before the body is read. Returns the ST session
	 * id when the caller may proceed to read the body.
	 */
	async authorize(
		headers: IngestHeaders,
	): Promise<{ ok: true; stSessionId: string } | IngestOutcome> {
		const token = parseBearer(headers.authorization);
		const stSessionId = headers.stSession?.trim();
		// B1 — the ST session id is a path component too (`.conversations/<sid>/`).
		if (!token || !isSafeStSessionId(stSessionId)) return this.reject("missing_auth");
		if (!this.deps.enabled) return this.reject("disabled");
		if (this.isDead(stSessionId)) return this.reject("not_running");
		const entry = await this.lookupToken(stSessionId);
		if (this.isDead(stSessionId)) return this.reject("not_running");
		if (!entry) return this.reject("bad_token");
		if (!entry.requested) return this.reject("disabled");
		if (!entry.hash || !tokenMatchesHash(token, entry.hash)) return this.reject("bad_token");
		if (entry.status !== "running") return this.reject("not_running");
		return { ok: true, stSessionId };
	}

	private async lookupToken(stSessionId: string): Promise<TokenCacheEntry | null> {
		const cached = this.tokenCache.get(stSessionId);
		const now = this.now();
		if (cached && cached.expiresAt > now) return cached;
		let row: Awaited<ReturnType<typeof getSessionCapture>>;
		try {
			row = await getSessionCapture(stSessionId);
		} catch (err) {
			logger.warn(`[conversation] token lookup failed: ${(err as Error).message}`);
			return null;
		}
		if (!row) return null;
		const entry: TokenCacheEntry = {
			status: row.status,
			requested: row.conversation_requested === 1,
			hash: row.ingest_token_hash,
			expiresAt: now + TOKEN_CACHE_TTL_MS,
		};
		this.tokenCache.set(stSessionId, entry);
		return entry;
	}

	/** Rate buckets (R1/R2), charged on the declared body size. */
	takeRate(stSessionId: string, bodyBytes: number): IngestOutcome | { ok: true } {
		const d = this.rate.take(stSessionId, bodyBytes);
		if (d.ok) return { ok: true };
		this.noteRateDrop(stSessionId, bodyBytes);
		return this.reject("rate_limited");
	}

	private noteRateDrop(stSessionId: string, bytes: number): void {
		// One gap per conversation per window: attribute to the most recent
		// conversation of the session (the one being flooded, in practice).
		const rt = this.latestRuntime(stSessionId);
		if (!rt) return;
		rt.rateDropped++;
		rt.rateDroppedBytes += bytes;
		const now = this.now();
		if (now - rt.lastRateGapAt >= RATE_LIMIT_GAP_WINDOW_MS) {
			rt.lastRateGapAt = now;
			const dropped = rt.rateDropped;
			const droppedBytes = rt.rateDroppedBytes;
			rt.rateDropped = 0;
			rt.rateDroppedBytes = 0;
			this.writeGap(rt, { reason: "rate_limited", dropped, dropped_bytes: droppedBytes });
		}
	}

	/** G2 refusal: the body was never read, so only a counter and a gap. */
	noteBackpressure(stSessionId: string, pane: string | undefined, scope: "ingest"): void {
		this.reject("backpressure");
		const rt = this.uniqueByPane(stSessionId, pane);
		if (rt) this.writeGap(rt, { reason: "backpressure", scope });
		else this.stats.unattributedGaps++;
	}

	private uniqueByPane(stSessionId: string, pane: string | undefined): ConvRuntime | null {
		const candidates = Array.from(this.runtime.values()).filter((r) => {
			if (r.stSessionId !== stSessionId) return false;
			const idx = this.deps.store.getResidentIndex(r.stSessionId, r.cid);
			if (!idx || idx.state.status === "ended" || idx.state.status === "disconnected") return false;
			return pane ? idx.paneId === pane : true;
		});
		return candidates.length === 1 ? candidates[0] : null;
	}

	/** §3.3 — an unparseable body: attribute a `gap malformed` by pane if unique. */
	async noteUnparseable(
		stSessionId: string,
		pane: string | undefined,
		reason: "too_large" | "invalid_json",
	): Promise<void> {
		this.reject(reason);
		const rt = this.uniqueByPane(stSessionId, pane);
		if (rt) this.writeGap(rt, { reason: "malformed", detail: reason });
		else this.stats.unattributedGaps++;
	}

	// ── Ingest proper (after the body) ───────────────────────────────────

	/**
	 * Steps 5–10 of the header. `raw` is the parsed JSON body. The caller
	 * has already sent 204; this resolves when the event is queued.
	 */
	async ingest(
		stSessionId: string,
		pane: string | undefined,
		raw: unknown,
		relay?: RelayReport,
	): Promise<IngestOutcome> {
		// B4 — a body that arrives during or after the purge is refused
		// before anything else; otherwise the ingest registers itself so a
		// purge that starts now waits for it to settle.
		if (this.isDead(stSessionId)) return this.reject("not_running");
		const work = this.ingestInner(stSessionId, pane, raw, relay);
		let set = this.inFlight.get(stSessionId);
		if (!set) {
			set = new Set();
			this.inFlight.set(stSessionId, set);
		}
		set.add(work);
		try {
			return await work;
		} finally {
			set.delete(work);
			if (set.size === 0 && this.inFlight.get(stSessionId) === set) {
				this.inFlight.delete(stSessionId);
			}
		}
	}

	private async ingestInner(
		stSessionId: string,
		pane: string | undefined,
		raw: unknown,
		relay: RelayReport | undefined,
	): Promise<IngestOutcome> {
		const normalized = normalizeHookInput(raw);
		if (!normalized.ok) {
			this.stats.rejected.malformed = (this.stats.rejected.malformed ?? 0) + 1;
			const cid = normalized.sessionId;
			if (cid && this.owner.get(cid) === stSessionId) {
				const rt = this.runtime.get(cid);
				if (rt)
					this.writeGap(rt, {
						reason: "malformed",
						detail: normalized.detail,
						hook: normalized.hookEventName ?? null,
					});
			} else {
				this.stats.unattributedGaps++;
			}
			return { accepted: false, reason: "malformed" };
		}
		const event = normalized.event;
		this.stats.fieldsDropped += event.droppedFields;
		const cid = event.sessionId;
		const epoch = this.epochOf(stSessionId);

		// §3.2 — a Claude session id belongs to exactly one ST session.
		const knownOwner = this.owner.get(cid);
		if (knownOwner && knownOwner !== stSessionId) return this.reject("session_mismatch");

		// §2.5 — last authorisation step, uncached, immediately before enqueue.
		const revocation = await checkRevocation(this.deps.workspaceRoot, stSessionId);
		if (this.isDead(stSessionId) || this.epochOf(stSessionId) !== epoch)
			return this.reject("not_running");
		if (revocation !== "none") {
			this.tokenCache.delete(stSessionId);
			// Converge even if the CLI was interrupted before its step 3.
			await removeHooksFile(this.deps.workspaceRoot, stSessionId).catch(() => undefined);
			// 3.0d: the authorization marker never outlives the authorization.
			await removeRelayEnabled(this.deps.workspaceRoot, stSessionId).catch(() => undefined);
			await this.markRevoked(stSessionId);
			return this.reject("revoked");
		}

		let rt: ConvRuntime;
		try {
			rt = await this.ensureRuntime(stSessionId, cid);
		} catch (err) {
			if (err instanceof OwnerMismatch) return this.reject("session_mismatch");
			if (err instanceof OwnerUnverified) return this.reject("owner_unverified");
			if (err instanceof SessionPurged) return this.reject("not_running");
			throw err;
		}
		if (this.isDead(stSessionId) || this.epochOf(stSessionId) !== epoch || rt.epoch !== epoch) {
			return this.reject("not_running");
		}
		// §3.2.1 — before the carrying event (the losses precede it) and
		// before dedupe: a duplicate still delivers the report.
		if (relay) this.applyRelayReport(rt, relay);
		const hash = payloadHash(raw);
		const identity = identityKey({
			ev: event.ev,
			agentId: event.agentId,
			promptId: event.promptId,
			messageId: event.identity.messageId,
			index: event.identity.index,
			toolUseId: event.identity.toolUseId,
			taskId: event.identity.taskId,
		});
		if (rt.dedupe.seen(identity, hash, this.now(), event.identity.teammateName)) {
			return this.reject("duplicate");
		}

		// B6 (round 4) — a delta for a SEALED message is refused before any
		// side effect: no `missing_delta` gap and no `messageIndex` entry may
		// be recreated for a message that already ended. Only this check
		// moves ahead of detectGaps; a `final` still runs detectGaps first
		// (its own index must be checked) and is sealed afterwards.
		if (event.ev === "assistant_delta" && this.isSealed(rt, event.identity.messageId ?? "")) {
			return this.reject("truncated");
		}
		this.detectGaps(rt, event);
		// B6 — accumulated L2 budget per message (never per delta).
		if (event.ev === "assistant_delta" && this.applyMessageBudget(rt, event) === "drop") {
			return this.reject("truncated");
		}
		this.applyMetadata(rt, event, pane);
		const pending: PendingEvent = {
			ev: event.ev,
			prompt_id: event.promptId,
			turn_id: event.turnId,
			agent_id: event.agentId,
			pane: pane ?? null,
			data: event.data,
		};
		let outcome = this.deps.store.enqueue(stSessionId, cid, pending);
		if (outcome === "not_open") {
			// Evicted during the await above (another conversation opened);
			// reopen inline — ingest is async, so this is cheap and ordered.
			// A purge that lands in this window must win (B4).
			try {
				await this.deps.store.open(stSessionId, cid);
			} catch {
				return this.reject("not_running");
			}
			if (this.isDead(stSessionId) || this.epochOf(stSessionId) !== epoch)
				return this.reject("not_running");
			outcome = this.deps.store.enqueue(stSessionId, cid, pending);
		}
		if (outcome === "dropped" || outcome === "not_open") {
			this.stats.rejected.backpressure = (this.stats.rejected.backpressure ?? 0) + 1;
			return { accepted: false, reason: "backpressure" };
		}
		this.stats.eventsSinceBoot++;
		this.applyState(rt, event);
		return { accepted: true, cid };
	}

	private async ensureRuntime(stSessionId: string, cid: string): Promise<ConvRuntime> {
		const existing = this.runtime.get(cid);
		if (existing) {
			// The runtime is keyed by Claude session id; a caller from another
			// ST session must never be handed it (B5).
			if (existing.stSessionId !== stSessionId) throw new OwnerMismatch(existing.stSessionId);
			// Keep the index resident (refreshes LRU) in case it was evicted.
			if (!this.deps.store.getResidentIndex(stSessionId, cid)) {
				await this.deps.store.open(stSessionId, cid);
			}
			return existing;
		}
		// B2 — single-flight: concurrent first events share one creation.
		// The shared promise resolves to the FIRST caller's runtime, so a
		// concurrent caller from a different ST session is a mismatch, not
		// a co-owner.
		const pending = this.creating.get(cid);
		const rt = pending
			? await pending.promise
			: await (() => {
					const create = this.createRuntime(stSessionId, cid).finally(() =>
						this.creating.delete(cid),
					);
					this.creating.set(cid, { st: stSessionId, promise: create });
					return create;
				})();
		if (rt.stSessionId !== stSessionId) throw new OwnerMismatch(rt.stSessionId);
		return rt;
	}

	private async createRuntime(stSessionId: string, cid: string): Promise<ConvRuntime> {
		if (this.isDead(stSessionId)) throw new SessionPurged();
		const epoch = this.epochOf(stSessionId);
		const index = await this.deps.store.open(stSessionId, cid);
		if (this.isDead(stSessionId) || this.epochOf(stSessionId) !== epoch) {
			await this.deps.store.close(stSessionId, cid).catch(() => undefined);
			throw new SessionPurged();
		}
		// B5 — ownership is reserved atomically in D1 on first discovery in
		// this process and cached for the process lifetime (it survives a
		// stop; only a purge forgets it). Never per event.
		if (this.owner.get(cid) !== stSessionId) {
			let reserved: Awaited<ReturnType<typeof reserveConversationOwner>>;
			try {
				reserved = await reserveConversationOwner(index);
				this.stats.d1Writes++;
			} catch (err) {
				logger.warn(
					`[conversation] owner reservation failed for ${cid}: ${(err as Error).message}`,
				);
				await this.deps.store.close(stSessionId, cid);
				throw new OwnerUnverified();
			}
			if (!reserved.ok) {
				this.owner.set(cid, reserved.owner);
				await this.deps.store.close(stSessionId, cid);
				throw new OwnerMismatch(reserved.owner);
			}
			// B4 — the SELECT may have been answered after a purge started:
			// do not record ownership or build a runtime for a dead session.
			if (this.isDead(stSessionId) || this.epochOf(stSessionId) !== epoch) {
				await this.deps.store.close(stSessionId, cid).catch(() => undefined);
				throw new SessionPurged();
			}
			this.owner.set(cid, stSessionId);
		}
		const raced = this.runtime.get(cid);
		if (raced) return raced;
		const rt: ConvRuntime = {
			stSessionId,
			cid,
			epoch,
			dedupe: new DedupeTable(),
			endTimer: null,
			lastRateGapAt: 0,
			rateDropped: 0,
			rateDroppedBytes: 0,
		};
		this.runtime.set(cid, rt);
		return rt;
	}

	/**
	 * B6 — L2 is an ACCUMULATED budget per `message_id`. The first delta
	 * that crosses it is cut (UTF-8 safe) with a visible `truncated`; every
	 * later delta of that message is dropped, except a `final` one, which is
	 * persisted empty so the message is known to have ended. State lives in
	 * the index (snapshotted, and rebuilt from the file on recovery).
	 */
	private isSealed(rt: ConvRuntime, messageId: string): boolean {
		const index = this.deps.store.getResidentIndex(rt.stSessionId, rt.cid);
		return index?.sealedMessages.includes(messageId) ?? false;
	}

	private applyMessageBudget(rt: ConvRuntime, event: NormalizedEvent): "persist" | "drop" {
		const index = this.deps.store.getResidentIndex(rt.stSessionId, rt.cid);
		if (!index) return "persist";
		const id = event.identity.messageId ?? "";
		// B6 — a message that ended (`final`) or was sealed by the open-set
		// cap never reopens its budget: any late delta is dropped.
		if (index.sealedMessages.includes(id)) return "drop";
		const cur = index.messageBytes[id] ?? { bytes: 0, truncated: false };
		const delta = String(event.data.delta ?? "");
		const deltaBytes = utf8Bytes(delta);
		const isFinal = event.data.final === true;
		let truncated = cur.truncated;
		if (cur.truncated) {
			if (!isFinal) return "drop";
			event.data.delta = "";
			event.data.truncated = true;
			event.data.original_bytes = cur.bytes + deltaBytes;
		} else if (cur.bytes + deltaBytes > L2_MESSAGE_BYTES) {
			const cut = truncateUtf8(delta, Math.max(0, L2_MESSAGE_BYTES - cur.bytes));
			event.data.delta = cut.value;
			event.data.truncated = true;
			event.data.original_bytes = cur.bytes + deltaBytes;
			truncated = true;
		}
		const total = cur.bytes + deltaBytes;
		this.deps.store.update(rt.stSessionId, rt.cid, (i) => {
			if (isFinal) {
				sealMessage(i, id);
			} else {
				i.messageBytes[id] = { bytes: total, truncated };
				capOpenMessages(i);
			}
		});
		return "persist";
	}

	private latestRuntime(stSessionId: string): ConvRuntime | undefined {
		let best: ConvRuntime | undefined;
		let bestAt = "";
		for (const rt of this.runtime.values()) {
			if (rt.stSessionId !== stSessionId) continue;
			const idx = this.deps.store.getResidentIndex(rt.stSessionId, rt.cid);
			const at = idx?.lastEventAt ?? "";
			if (at >= bestAt) {
				best = rt;
				bestAt = at;
			}
		}
		return best;
	}

	// ── Metadata, gaps, state ────────────────────────────────────────────

	private applyMetadata(rt: ConvRuntime, event: NormalizedEvent, pane: string | undefined): void {
		const store = this.deps.store;
		const nowIso = new Date(this.now()).toISOString();
		store.update(rt.stSessionId, rt.cid, (index) => {
			if (event.ev === "session_start") {
				const flags = (event.data.argv_flags as string[] | undefined) ?? [];
				if (flags.includes("-p") || flags.includes("--print")) index.kind = "headless";
				else if (flags.some((f) => f.startsWith("--agent-name") || f === "--agent-id")) {
					index.kind = "teammate";
				} else index.kind = "interactive";
				if (typeof event.data.claude_version === "string")
					index.claudeVersion = event.data.claude_version;
				if (typeof event.data.session_title === "string") index.title = event.data.session_title;
				const tmuxSession = event.data.tmux_session;
				if (typeof tmuxSession === "string") index.tabId = tmuxSession;
				const p = (event.data.pane as string | undefined) ?? pane;
				if (p) this.bindPane(index, p);
				if (event.data.source === "resume" || event.data.source === "fork") {
					if (index.eventsCount === 0) {
						// Known only from a resume: the earlier history never
						// reached us (§4.5 history_unavailable).
						this.stats.gaps++;
						store.enqueue(rt.stSessionId, rt.cid, {
							ev: "gap",
							prompt_id: null,
							turn_id: null,
							agent_id: null,
							pane: null,
							data: { reason: "history_unavailable", source: event.data.source },
						});
					}
				}
				if (index.endedAt && (event.data.source === "resume" || event.data.source === "startup")) {
					index.endedAt = null;
					index.endReason = null;
				}
			} else if (event.ev === "user_prompt") {
				if (
					index.title === null &&
					(event.data.source === undefined || event.data.source === "user")
				) {
					index.title = String(event.data.prompt).slice(0, 80);
				}
				if (typeof event.data.session_title === "string") index.title = event.data.session_title;
				if (pane && !index.paneId) this.bindPane(index, pane);
			} else if (event.ev === "session_end") {
				index.endedAt = nowIso;
				index.endReason = String(event.data.reason);
			}
			if (index.kind === "unknown" && event.ev !== "session_start" && pane && !index.paneId) {
				this.bindPane(index, pane);
			}
			// Synchronous bookkeeping for the §4.6 gap detectors: the store
			// updates these too, but only when the event is PERSISTED (async),
			// and the next hook can arrive before that.
			if (event.promptId) index.lastPromptId = event.promptId;
		});
	}

	/** §5.2 — the newest conversation keeps a pane; the previous holder loses it. */
	private bindPane(index: ConversationIndex, pane: string): void {
		if (index.paneId === pane) return;
		index.paneId = pane;
		for (const other of this.runtime.values()) {
			if (other.stSessionId !== index.stSessionId || other.cid === index.cid) continue;
			const otherIndex = this.deps.store.getResidentIndex(other.stSessionId, other.cid);
			if (otherIndex && otherIndex.paneId === pane) {
				otherIndex.paneId = null;
				otherIndex.tabId = null;
				otherIndex.state = { status: "unknown", evidence: "binding_lost", at: this.now() };
				this.markDirty(other.stSessionId, other.cid);
			}
		}
	}

	/** §4.6 — out-of-order detection that yields explicit gaps. */
	private detectGaps(rt: ConvRuntime, event: NormalizedEvent): void {
		const index = this.deps.store.getResidentIndex(rt.stSessionId, rt.cid);
		if (!index) return;
		if (event.ev === "assistant_delta") {
			const id = event.identity.messageId ?? "";
			const idx = event.identity.index ?? 0;
			const last = index.messageIndex[id];
			const expected = last === undefined ? 0 : last + 1;
			if (idx > expected) {
				this.writeGap(rt, { reason: "missing_delta", message_id: id, range: [expected, idx - 1] });
			}
			this.deps.store.update(rt.stSessionId, rt.cid, (i) => {
				i.messageIndex[id] = Math.max(idx, i.messageIndex[id] ?? -1);
			});
		} else if (event.ev === "turn_end" && event.promptId) {
			if (index.lastPromptId !== event.promptId) {
				this.writeGap(rt, { reason: "missing_prompt", prompt_id: event.promptId });
			}
		}
	}

	private applyRelayReport(rt: ConvRuntime, relay: RelayReport): void {
		if (relay.unattributed > 0) {
			this.stats.unattributedGaps++;
			this.stats.relayDroppedUnattributed += relay.unattributed;
		}
		if (relay.restarted) {
			this.stats.relayRestarts++;
			// A conversation the relay starts with lost nothing to it.
			const idx = this.deps.store.getResidentIndex(rt.stSessionId, rt.cid);
			if (idx && idx.lastSeq > 0) this.writeGap(rt, { reason: "relay_restart" });
		}
		if (relay.dropped > 0) {
			this.stats.relayDropped += relay.dropped;
			this.writeGap(rt, {
				reason: "relay_dropped",
				dropped: relay.dropped,
				dropped_bytes: relay.droppedBytes,
			});
		}
	}

	private writeGap(rt: ConvRuntime, data: Record<string, unknown>): void {
		this.stats.gaps++;
		this.enqueueOrOpen(rt, {
			ev: "gap",
			prompt_id: null,
			turn_id: null,
			agent_id: null,
			pane: null,
			data,
		});
	}

	/**
	 * Enqueue synchronously when the conversation is resident (the common
	 * case, and required so a gap lands BEFORE the event that revealed
	 * it); when the G4 LRU evicted it, reopen and enqueue afterwards.
	 */
	private enqueueOrOpen(rt: ConvRuntime, pending: PendingEvent): void {
		const r = this.deps.store.enqueue(rt.stSessionId, rt.cid, pending);
		if (r !== "not_open") return;
		if (this.isDead(rt.stSessionId) || this.epochOf(rt.stSessionId) !== rt.epoch) return;
		void this.deps.store
			.open(rt.stSessionId, rt.cid)
			.then(() => {
				if (this.isDead(rt.stSessionId) || this.epochOf(rt.stSessionId) !== rt.epoch) return;
				this.deps.store.enqueue(rt.stSessionId, rt.cid, pending);
			})
			.catch((err) =>
				logger.warn(`[conversation] reopen failed for ${rt.cid}: ${(err as Error).message}`),
			);
	}

	private applyState(rt: ConvRuntime, event: NormalizedEvent): void {
		const at = this.now();
		let input: StateInput | null = null;
		switch (event.ev) {
			case "user_prompt":
				input = {
					kind: "event",
					ev: "user_prompt",
					source: event.data.source as string | undefined,
					at,
				};
				break;
			case "turn_end":
				input = {
					kind: "event",
					ev: "turn_end",
					backgroundTasks: Array.isArray(event.data.background_tasks)
						? event.data.background_tasks.length
						: 0,
					at,
				};
				break;
			case "turn_failed":
				input = { kind: "event", ev: "turn_failed", at };
				break;
			case "notification":
				input = {
					kind: "event",
					ev: "notification",
					notificationType: String(event.data.notification_type),
					at,
				};
				break;
			case "permission_request":
				input = { kind: "event", ev: "permission_request", at };
				break;
			case "tool_start":
			case "tool_end":
			case "tool_failed":
				input = { kind: "event", ev: event.ev, at };
				break;
			case "session_end":
				input = { kind: "event", ev: "session_end", at };
				break;
			case "session_start":
				input = {
					kind: "event",
					ev: "session_start",
					source: event.data.source as string | undefined,
					at,
				};
				break;
			default:
				input = { kind: "event", ev: event.ev as "assistant_delta", at };
		}
		this.transition(rt, input);
		if (event.ev === "session_end") this.scheduleEndGrace(rt);
		else if (rt.endTimer) {
			clearTimeout(rt.endTimer);
			rt.endTimer = null;
		}
	}

	private transition(rt: ConvRuntime, input: StateInput): ConversationState | null {
		const index = this.deps.store.getResidentIndex(rt.stSessionId, rt.cid);
		if (!index) return null;
		const before = index.state;
		const after = applyStateInput(before, input);
		if (after === before) return before;
		this.deps.store.update(rt.stSessionId, rt.cid, (i) => {
			i.state = after;
		});
		// Status changes are worth a D1 write right away (coalesced per 30 s
		// anyway: a flapping session cannot amplify writes).
		this.markDirty(rt.stSessionId, rt.cid);
		return after;
	}

	private scheduleEndGrace(rt: ConvRuntime): void {
		if (rt.endTimer) clearTimeout(rt.endTimer);
		rt.endTimer = setTimeout(() => {
			rt.endTimer = null;
			this.transition(rt, { kind: "end_grace_elapsed", at: this.now() });
			const index = this.deps.store.getResidentIndex(rt.stSessionId, rt.cid);
			if (index?.state.status === "ended") {
				this.deps.store.update(rt.stSessionId, rt.cid, (i) => {
					// §5.2: clear/resume ends undo the binding.
					if (i.endReason === "clear" || i.endReason === "resume") {
						i.paneId = null;
						i.tabId = null;
					}
				});
				void this.heartbeat.flushNow(`${rt.stSessionId}/${rt.cid}`);
			}
		}, SESSION_END_GRACE_MS);
		rt.endTimer.unref?.();
	}

	private onPersisted(stSessionId: string, cid: string, _event: PersistedEvent): void {
		this.markDirty(stSessionId, cid);
	}

	/** Revocation observed mid-stream: queued events persist, then one `gap revoked`. */
	private async markRevoked(stSessionId: string): Promise<void> {
		for (const rt of this.runtime.values()) {
			if (rt.stSessionId !== stSessionId) continue;
			const index = this.deps.store.getResidentIndex(rt.stSessionId, rt.cid);
			if (!index || index.state.status === "ended") continue;
			if (index.revokedNoted) continue;
			this.deps.store.update(rt.stSessionId, rt.cid, (i) => {
				i.revokedNoted = true;
			});
			this.writeGap(rt, { reason: "revoked" });
		}
	}

	// ── Lifecycle (DockerManager / routes call these) ────────────────────

	/** Container stopped/killed: every conversation of the session is `disconnected`. */
	async onSessionDown(stSessionId: string): Promise<void> {
		this.tokenCache.delete(stSessionId);
		this.rate.forget(stSessionId);
		for (const rt of Array.from(this.runtime.values())) {
			if (rt.stSessionId !== stSessionId) continue;
			if (!this.deps.store.getResidentIndex(rt.stSessionId, rt.cid)) {
				try {
					await this.deps.store.open(rt.stSessionId, rt.cid);
				} catch {
					/* unreadable: skip the status write, still forget the runtime */
				}
			}
			this.transition(rt, { kind: "container_down", at: this.now() });
			if (rt.endTimer) clearTimeout(rt.endTimer);
			await this.heartbeat.flushNow(`${rt.stSessionId}/${rt.cid}`);
			await this.deps.store.close(rt.stSessionId, rt.cid);
			this.runtime.delete(rt.cid);
			// B5 — ownership survives a stop (the D1 row keeps it too); only
			// a purge forgets it.
		}
	}

	/**
	 * Hard delete (B4): stop the runtimes, forget their heartbeats so no
	 * late timer re-upserts a row, remove `.conversations/<sid>` entirely
	 * (events, indexes, rotations, markers), the managed dir and the D1
	 * rows, and forget the ownership cache for the session's conversations.
	 */
	async onSessionPurged(stSessionId: string): Promise<void> {
		// B4 — first thing: every in-flight ingest/creation for this session
		// now sees a stale epoch and abandons itself after its next await.
		this.tombstone(stSessionId);
		this.purgeEpoch.set(stSessionId, this.epochOf(stSessionId) + 1);
		this.tokenCache.delete(stSessionId);
		this.rate.forget(stSessionId);
		// Admission is closed (tombstone), so the in-flight set can only
		// shrink: wait until every ingest that was already running for this
		// session has settled (each rejects at its next checkpoint), and
		// every creation it may have started. Re-read the sets each round:
		// a continuation can start a creation while we wait.
		for (;;) {
			const ingests = Array.from(this.inFlight.get(stSessionId) ?? []);
			const creations = Array.from(this.creating.values())
				.filter((c) => c.st === stSessionId)
				.map((c) => c.promise);
			if (ingests.length === 0 && creations.length === 0) break;
			await Promise.allSettled([...ingests, ...creations]);
		}
		for (const rt of Array.from(this.runtime.values())) {
			if (rt.stSessionId !== stSessionId) continue;
			if (rt.endTimer) clearTimeout(rt.endTimer);
			this.heartbeat.forget(`${rt.stSessionId}/${rt.cid}`);
			this.runtime.delete(rt.cid);
		}
		for (const [cid, owner] of Array.from(this.owner)) {
			if (owner === stSessionId) this.owner.delete(cid);
		}
		await this.deps.store.purgeSession(stSessionId);
		await purgeManagedDir(this.deps.workspaceRoot, stSessionId);
		try {
			await deleteConversationRows(stSessionId);
		} catch (err) {
			logger.warn(`[conversation] row purge failed for ${stSessionId}: ${(err as Error).message}`);
		}
	}

	async enable(stSessionId: string): Promise<EnableResult> {
		return enableSession(this.activationDeps, this.authority, stSessionId, (sid) =>
			this.deps.isRecreateUnresolved ? this.deps.isRecreateUnresolved(sid) : Promise.resolve(false),
		);
	}

	async disable(stSessionId: string): Promise<DisableResult> {
		const r = await disableSession(this.activationDeps, stSessionId, "api");
		await this.markRevoked(stSessionId);
		return r;
	}

	// ── Admin stats (§7) ─────────────────────────────────────────────────

	private diskBytes: { at: number; value: Promise<number> } | null = null;

	/**
	 * One D1 read and local file checks — no Docker call and no probe, per
	 * §7. `effectiveSessions` is therefore the contract's upper bound
	 * ("configured"): requested, flag on, running in D1 with an authorized
	 * hash, no revocation, and both capture files on disk. Whether the
	 * container's token corresponds and its relay answers is only known per
	 * session, through `capture` and its probe (§2.7.6). No titles, no ids.
	 */
	async adminStats(): Promise<ConversationAdminStats> {
		const rows = await listRequestedSessions();
		let effective = 0;
		if (this.deps.enabled) {
			for (const row of rows) {
				if (row.status !== "running" || row.authorized !== 1) continue;
				const sid = row.session_id;
				if (!isSafeStSessionId(sid)) continue;
				if ((await checkRevocation(this.deps.workspaceRoot, sid)) !== "none") continue;
				if (!(await relayEnabledExists(this.deps.workspaceRoot, sid))) continue;
				if (!(await hooksFileExists(this.deps.workspaceRoot, sid))) continue;
				effective++;
			}
		}
		const now = this.now();
		if (!this.diskBytes || now - this.diskBytes.at >= DISK_BYTES_TTL_MS) {
			// Single flight: concurrent polls share one walk; a failed walk
			// is not cached.
			const value = this.deps.store.diskBytes();
			this.diskBytes = { at: now, value };
			value.catch(() => {
				if (this.diskBytes?.value === value) this.diskBytes = null;
			});
		}
		const disk = this.diskBytes.value;
		return {
			enabledSessions: rows.length,
			effectiveSessions: effective,
			eventsSinceBoot: this.stats.eventsSinceBoot,
			rejectedSinceBoot: { byReason: { ...this.stats.rejected } },
			gapsSinceBoot: this.stats.gaps,
			unattributedGaps: this.stats.unattributedGaps,
			bytesOnDisk: await disk,
			queueBytesNow: this.deps.store.totalQueuedBytes(),
			queueBytesMax: this.deps.store.maxQueuedBytes(),
			wsResyncsSinceBoot: this.wsResyncs,
		};
	}

	// ── Reads ────────────────────────────────────────────────────────────

	async list(stSessionId: string): Promise<{
		capture: CaptureBlock;
		conversations: ConversationSummary[];
	}> {
		const capture = await this.authority.capture(stSessionId);
		return { capture, conversations: await this.summaries(stSessionId) };
	}

	/**
	 * The conversation summaries without the capture block. The WS `hello`
	 * uses this: `capture` needs a fresh relay probe (D7), which a socket
	 * open must not pay for.
	 */
	async summaries(stSessionId: string): Promise<ConversationSummary[]> {
		let rows: ConversationRow[] = [];
		try {
			rows = await listConversationRows(stSessionId);
		} catch (err) {
			logger.warn(`[conversation] list failed for ${stSessionId}: ${(err as Error).message}`);
		}
		const out: ConversationSummary[] = [];
		const seen = new Set<string>();
		// Resident indexes are fresher than D1 (heartbeat lag ≤ 30 s).
		for (const row of rows) {
			seen.add(row.session_id);
			const index = await this.deps.store.peekIndex(stSessionId, row.session_id);
			out.push(index ? summarizeIndex(index) : summarizeRow(row));
		}
		for (const rt of this.runtime.values()) {
			if (rt.stSessionId !== stSessionId || seen.has(rt.cid)) continue;
			const index = this.deps.store.getResidentIndex(stSessionId, rt.cid);
			if (index) out.push(summarizeIndex(index));
		}
		out.sort((a, b) =>
			a.lastEventAt < b.lastEventAt ? 1 : a.lastEventAt > b.lastEventAt ? -1 : 0,
		);
		return out;
	}

	/**
	 * What the 3.1 read surface needs to serve one conversation: its
	 * snapshot and its events file. Null when the session has no such
	 * conversation — including an id that is not a safe path component
	 * (`cid` comes from the URL), which the store refuses.
	 */
	async conversationFile(
		stSessionId: string,
		cid: string,
	): Promise<{ index: ConversationIndex; eventsFile: string } | null> {
		try {
			if (!(await this.deps.store.exists(stSessionId, cid))) return null;
			const index = await this.deps.store.peekIndex(stSessionId, cid);
			if (!index) return null;
			return { index, eventsFile: this.deps.store.eventsPath(stSessionId, cid) };
		} catch {
			return null;
		}
	}

	/** Live status of a resident conversation (WS `status` frames). */
	residentState(stSessionId: string, cid: string): ConversationIndex["state"] | null {
		return this.deps.store.getResidentIndex(stSessionId, cid)?.state ?? null;
	}

	/** Subscribe to persisted events (WS live path). Returns the unsubscribe. */
	onPersistedEvent(listener: EventListener): () => void {
		return this.deps.store.onEvent(listener);
	}

	noteWsResync(): void {
		this.wsResyncs++;
	}

	// ── Probe & reconcile ────────────────────────────────────────────────

	/** One `claude agents --json` per running session (§4.4). Never throws. */
	async probeSession(stSessionId: string): Promise<ProbeEntry[] | null> {
		if (!this.deps.execCapture) return null;
		try {
			const r = await this.deps.execCapture(stSessionId, [...PROBE_ARGV], {
				maxBytes: PROBE_MAX_BYTES,
				timeoutMs: PROBE_TIMEOUT_MS,
			});
			if (r.timedOut || r.truncated || r.exitCode !== 0) return null;
			return parseAgentsJson(r.stdout.toString("utf8"));
		} catch (err) {
			logger.warn(`[conversation] probe failed for ${stSessionId}: ${(err as Error).message}`);
			return null;
		}
	}

	applyProbe(stSessionId: string, entries: ProbeEntry[]): void {
		const at = this.now();
		const byId = new Map(entries.map((e) => [e.sessionId, e]));
		for (const rt of this.runtime.values()) {
			if (rt.stSessionId !== stSessionId) continue;
			const e = byId.get(rt.cid);
			const input: StateInput = e
				? e.status
					? { kind: "probe", found: true, status: e.status, waitingFor: e.waitingFor, at }
					: { kind: "probe", found: true, status: "idle", at }
				: { kind: "probe", found: false, at };
			this.transition(rt, input);
			this.enqueueOrOpen(rt, {
				ev: "probe",
				prompt_id: null,
				turn_id: null,
				agent_id: null,
				pane: null,
				data: e
					? {
							found: true,
							status: e.status ?? "idle",
							...(e.waitingFor ? { waitingFor: e.waitingFor } : {}),
						}
					: { found: false },
			});
		}
	}

	/**
	 * Boot-time reconcile (§2.4 last row, §4.4, §2.5). Flag off: remove any
	 * hooks file left behind and stop. Flag on: files ⇔ requested ∧ hash,
	 * markers win over D1, every non-ended conversation gets a
	 * `gap backend_restart`, and one probe per running session.
	 */
	async reconcile(): Promise<void> {
		if (!this.deps.enabled) {
			const removed = await removeAllHooksFiles(this.deps.workspaceRoot);
			const markers = await removeAllRelayMarkers(this.deps.workspaceRoot);
			if (removed.length > 0 || markers.length > 0) {
				logger.info(
					`[conversation] capture disabled: removed ${removed.length} stale hooks file(s) and ${markers.length} relay marker(s)`,
				);
			}
			return;
		}
		let running: Awaited<ReturnType<typeof listRunningCaptureSessions>> = [];
		try {
			running = await listRunningCaptureSessions();
		} catch (err) {
			logger.warn(`[conversation] reconcile: D1 unavailable: ${(err as Error).message}`);
			return;
		}
		// Every session that is running OR has a hooks file or marker on disk:
		// a stopped or deleted session's leftovers must be retired too (§2.4
		// reconcile row), not only the running ones' state converged.
		const runningIds = new Set(running.map((r) => r.session_id));
		const ids = new Set<string>([...runningIds, ...(await this.sessionsWithCaptureFiles())]);
		for (const sid of ids) {
			try {
				// §2.7.4: while a recreation is unresolved nothing but its own
				// resolution may write for this session — no hooks file, no
				// marker, no gap. Fail-closed: a failing check counts as
				// unresolved.
				if (this.deps.isRecreateUnresolved) {
					const unresolved = await this.deps.isRecreateUnresolved(sid).catch(() => true);
					if (unresolved) {
						logger.warn(`[conversation] reconcile: ${sid} skipped (recreate-unresolved)`);
						continue;
					}
				}
				const revocation = await checkRevocation(this.deps.workspaceRoot, sid);
				if (revocation !== "none") {
					const row = await getSessionCapture(sid);
					if (row && (row.conversation_requested === 1 || row.ingest_token_hash)) {
						await revokeIngestTokens(sid);
						logger.info(`[conversation] reconcile: revocation marker wins over D1 for ${sid}`);
					}
					await this.authority.withdraw(sid);
					continue;
				}
				// §2.7.5: running ⇒ converge to full authorization; stopped ⇒
				// keep what retain authorization covers; anything else ⇒ withdraw.
				const outcome = await this.authority.converge(sid);
				if (outcome !== "written" && outcome !== "kept") continue;
				if (!runningIds.has(sid)) continue;
				// Reopen known conversations and mark the restart window.
				for (const cid of await this.deps.store.listConversationIds(sid)) {
					const rt = await this.ensureRuntime(sid, cid);
					const index = this.deps.store.getResidentIndex(sid, cid);
					if (!index || index.state.status === "ended") continue;
					this.writeGap(rt, {
						reason: "backend_restart",
						from: index.lastEventAt,
						to: new Date(this.now()).toISOString(),
					});
				}
				const entries = await this.probeSession(sid);
				if (entries) this.applyProbe(sid, entries);
			} catch (err) {
				logger.warn(`[conversation] reconcile failed for ${sid}: ${(err as Error).message}`);
			}
		}
	}

	/** Session ids with a hooks file under `.claude-managed` or a marker under `.st-control`. */
	private async sessionsWithCaptureFiles(): Promise<string[]> {
		const out: string[] = [];
		for (const [dir, file] of [
			[path.resolve(this.deps.workspaceRoot, ".claude-managed"), "conversation.json"],
			[path.resolve(this.deps.workspaceRoot, CONTROL_DIR_NAME), RELAY_ENABLED_FILE],
		] as const) {
			let entries: string[] = [];
			try {
				entries = await fs.readdir(dir);
			} catch {
				continue;
			}
			for (const sid of entries) {
				if (!isSafeStSessionId(sid)) continue;
				try {
					await fs.lstat(path.join(dir, sid, file));
					out.push(sid);
				} catch {
					/* none */
				}
			}
		}
		return out;
	}

	async shutdown(): Promise<void> {
		for (const rt of this.runtime.values()) {
			if (rt.endTimer) clearTimeout(rt.endTimer);
			await this.heartbeat.flushNow(`${rt.stSessionId}/${rt.cid}`);
		}
		await this.deps.store.flushAll();
	}

	/** Test/stat helper: heartbeat timers still pending. */
	heartbeatPending(stSessionId?: string): number {
		return this.heartbeat.pending(stSessionId === undefined ? undefined : `${stSessionId}/`);
	}

	/** Test/stat helper. */
	runtimeFor(cid: string): { stSessionId: string } | undefined {
		const rt = this.runtime.get(cid);
		return rt ? { stSessionId: rt.stSessionId } : undefined;
	}
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseBearer(header: string | undefined): string | null {
	if (!header) return null;
	const m = /^Bearer\s+([0-9a-f]{64})$/i.exec(header.trim());
	return m ? m[1] : null;
}

function summarizeIndex(index: ConversationIndex): ConversationSummary {
	return {
		sessionId: index.cid,
		kind: index.kind,
		title: index.title,
		status: index.state.status,
		statusEvidence: index.state.evidence,
		statusAt: new Date(index.state.at || 0).toISOString(),
		tabId: index.tabId,
		paneId: index.paneId,
		startedAt: index.startedAt,
		endedAt: index.endedAt,
		lastEventAt: index.lastEventAt,
		lastSeq: index.lastSeq,
		firstRetainedSeq: index.firstRetainedSeq,
		eventsCount: index.eventsCount,
		gapsCount: index.gapsCount,
		claudeVersion: index.claudeVersion,
		parentSessionId: index.parentSessionId,
		parentInferred: index.parentInferred,
		canSendInput: false,
	};
}

function summarizeRow(row: ConversationRow): ConversationSummary {
	return {
		sessionId: row.session_id,
		kind: row.kind,
		title: row.title,
		status: row.status,
		statusEvidence: row.status_evidence,
		statusAt: row.status_at,
		tabId: row.tab_id,
		paneId: row.pane_id,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		lastEventAt: row.last_event_at,
		lastSeq: row.last_seq,
		firstRetainedSeq: 0,
		eventsCount: row.events_count,
		gapsCount: row.gaps_count,
		claudeVersion: row.claude_version,
		parentSessionId: row.parent_session_id,
		parentInferred: row.parent_inferred === 1,
		canSendInput: false,
	};
}
