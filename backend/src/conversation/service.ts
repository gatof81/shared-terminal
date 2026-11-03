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
import { parseD1Utc } from "../d1Time.js";
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
import { ancestryArgv, EXEC_TIMEOUT_S, paneStateArgv, parsePaneState } from "./composerText.js";
import { DedupeTable, identityKey, payloadHash } from "./dedupe.js";
import { isSafeClaudeSessionId, isSafeStSessionId } from "./ids.js";
import {
	L2_MESSAGE_BYTES,
	RATE_LIMIT_GAP_WINDOW_MS,
	SESSION_END_GRACE_MS,
	SILENCE_PROBE_AFTER_MS,
	SILENCE_SWEEP_INTERVAL_MS,
	TARGETED_PROBE_DELAY_MS,
	TOKEN_CACHE_TTL_MS,
	UNKNOWN_AFTER_SILENCE_MS,
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
	type ConversationOwnerMeta,
	type ConversationRow,
	conversationRowExists,
	deleteConversationRows,
	getSessionCapture,
	HeartbeatCoalescer,
	listConversationRows,
	listConversationRowsWithMeta,
	listRequestedSessions,
	listRunningCaptureSessions,
	releaseConversationBinding,
	reserveConversationOwner,
	revokeIngestTokens,
	tokenMatchesHash,
	updateConversation,
	upsertConversationMeta,
} from "./registry.js";
import { checkRevocation } from "./revocation.js";
import { applyStateInput, type ConversationState, isLiveClaim, type StateInput } from "./state.js";
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
	/** 3.2 (§8.1.1): orientative; false until the composer route decorates it. */
	canSendInput: boolean;
	/**
	 * v1.8 §6.2 — the owner's name for it (prevails over `title`, which stays
	 * the automatic one) and when it was archived. Owner data, never derived
	 * from the events.
	 */
	customTitle: string | null;
	archivedAt: string | null;
	/** 3.2 (§8.1.8): the pane's blocking state, when the composer is wired. */
	composer?: {
		blocked: boolean;
		reason?: "in-progress" | "effects-pending" | "unverifiable";
		clientMessageId?: string;
		result?: string;
		since?: string;
	};
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
	/**
	 * ms of the last accepted HOOK event (v1.7.2 §5.3 silence). Not the
	 * index's `lastEventAt`: persisted `probe` events move that one, and an
	 * unverified probe is not evidence of anything.
	 */
	lastHookAt: number;
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
	 * v1.7.2 §5.2 — the container-START generation of a session, bumped
	 * synchronously by `onSessionDown`. Work that began under one start (a
	 * hook being ingested, a probe in flight, an identity check) and
	 * finishes after a stop must not bind, transition or verify anything:
	 * the runtimes it would touch may already belong to the NEXT start, whose
	 * tmux reuses the same pane ids and whose pid namespace reuses pids.
	 */
	private readonly startGen = new Map<string, number>();
	private startGenOf(stSessionId: string): number {
		return this.startGen.get(stSessionId) ?? 0;
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
		// Captured before the first await: the container start this hook came from.
		const startGen = this.startGenOf(stSessionId);
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
		// v1.7.2: the container stopped while this hook was being ingested —
		// same answer as a hook arriving after the stop (authorize: not_running).
		// It must not bind a pane id the next start will reuse.
		if (this.startGenOf(stSessionId) !== startGen) return this.reject("not_running");
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
			if (
				this.isDead(stSessionId) ||
				this.epochOf(stSessionId) !== epoch ||
				this.startGenOf(stSessionId) !== startGen
			)
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
			lastHookAt: Date.parse(index.lastEventAt ?? "") || this.now(),
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
				// §5.1 — the default title is the first prompt the PERSON wrote:
				// not an injected source, not a prompt whose origin could not be
				// verified (§4.2.1), and never an `internal_prompt` (below).
				if (
					index.title === null &&
					(event.data.source === undefined || event.data.source === "user") &&
					event.data.origin !== "unverified"
				) {
					index.title = String(event.data.prompt).slice(0, 80);
				}
				if (typeof event.data.session_title === "string") index.title = event.data.session_title;
				if (pane && !index.paneId) this.bindPane(index, pane);
			} else if (event.ev === "internal_prompt") {
				// The CLI's `session_title` is its own data, not the prompt's.
				if (typeof event.data.session_title === "string") index.title = event.data.session_title;
				if (pane && !index.paneId) this.bindPane(index, pane);
			} else if (event.ev === "session_end") {
				index.endedAt = nowIso;
				index.endReason = String(event.data.reason);
			}
			if (index.kind === "unknown" && event.ev !== "session_start" && pane && !index.paneId) {
				this.bindPane(index, pane);
			}
			// The §4.6 turn correlation is INGEST-ordered and set here only,
			// synchronously: persistence is async and batched, so a write of
			// the previous turn can complete after the next prompt arrived
			// (Work P2-2) — the store records `persistedPromptId` instead and
			// recovery rebuilds `lastPromptId` from the file.
			if (event.promptId) index.lastPromptId = event.promptId;
		});
	}

	/** §5.2 — the newest conversation keeps a pane; the previous holder loses it. */
	private bindPane(index: ConversationIndex, pane: string): void {
		if (index.paneId === pane) return;
		index.paneId = pane;
		const at = this.now();
		for (const other of this.runtime.values()) {
			if (other.stSessionId !== index.stSessionId || other.cid === index.cid) continue;
			const otherIndex = this.deps.store.getResidentIndex(other.stSessionId, other.cid);
			if (otherIndex) {
				if (otherIndex.paneId === pane) {
					otherIndex.paneId = null;
					otherIndex.tabId = null;
					otherIndex.state = { status: "unknown", evidence: "binding_lost", at };
					this.markDirty(other.stSessionId, other.cid);
				}
				continue;
			}
			// v1.7.2 §5.2: an index evicted by G4 still holds its binding on
			// disk; open it to check (async — this caller is synchronous, the
			// release lands right after, before any later event of `other`
			// can be applied since each one first re-opens the index).
			void this.releaseEvictedHolder(other, pane, at);
		}
	}

	private async releaseEvictedHolder(other: ConvRuntime, pane: string, at: number): Promise<void> {
		try {
			const idx = await this.deps.store.open(other.stSessionId, other.cid);
			if (idx.paneId !== pane) return;
			this.deps.store.update(other.stSessionId, other.cid, (i) => {
				i.paneId = null;
				i.tabId = null;
				i.state = { status: "unknown", evidence: "binding_lost", at };
			});
			await this.heartbeat.flushNow(`${other.stSessionId}/${other.cid}`);
		} catch {
			/* unreadable index: nothing to release */
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
			case "internal_prompt":
				input = { kind: "event", ev: "internal_prompt", at };
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
		rt.lastHookAt = at;
		const after = this.transition(rt, input);
		if (event.ev === "session_end") this.scheduleEndGrace(rt);
		else if (rt.endTimer) {
			clearTimeout(rt.endTimer);
			rt.endTimer = null;
		}
		// v1.7.2 §5.3 (a): a CLI that resumed (or started) and waits at its
		// prompt emits no hook until someone types, so nothing else would
		// ever move this `unknown`. Ask the process itself, shortly.
		if (event.ev === "session_start" && after?.status === "unknown") {
			this.scheduleTargetedProbe(rt.stSessionId);
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
			// v1.7.2 §5.2: a conversation whose process is gone, or whose
			// container stopped, holds no pane — a pane id is only meaningful
			// in the tmux server of the container start that reported it.
			if (releasesBinding(after)) {
				i.paneId = null;
				i.tabId = null;
			}
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
		// First, synchronously: everything in flight for the start that just
		// ended is void from here on (ingest, probe, identity check).
		this.startGen.set(stSessionId, this.startGenOf(stSessionId) + 1);
		// A probe still in flight belongs to the old start; the next start's
		// callers must not join it.
		this.probing.delete(stSessionId);
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
		const t = this.targetedTimers.get(stSessionId);
		if (t) clearTimeout(t);
		this.targetedTimers.delete(stSessionId);
		// v1.7.2 §5.2 — and EVERY other conversation of the session on disk,
		// resident or not: the next container start (the same container, or
		// N of a recreation) numbers its panes from %0 again, and a binding
		// left here would be inherited by whatever runs there.
		await this.releaseBindings(stSessionId);
	}

	/**
	 * v1.7.2 §5.2: every conversation of a session that is not running gets
	 * `pane_id = NULL`, `tab_id = NULL` and `disconnected · reconcile`, in
	 * the index and the D1 row. Only state and binding change — the events
	 * file is never touched — and nothing is re-bound: a conversation gets a
	 * pane again only from its own next event. Conversations with a runtime
	 * are handled by `onSessionDown` itself; this covers the others.
	 * Best-effort per conversation: an unreadable index is skipped.
	 */
	private async releaseBindings(stSessionId: string): Promise<void> {
		// Idempotent and recoverable: the index (memory + snapshot) and the D1
		// row are converged INDEPENDENTLY and only where they still differ,
		// so a run that failed half-way (snapshot write, D1) is completed by
		// the next one — the next stop, or the boot reconcile of a session
		// found stopped — and a run with nothing left to do writes nothing.
		const startGen = this.startGenOf(stSessionId);
		let cids: string[] = [];
		try {
			cids = await this.deps.store.listConversationIds(stSessionId);
		} catch {
			cids = [];
		}
		// One D1 read: which rows still claim a pane or a live state. Null
		// when D1 is unreachable — then every conversation's row is written
		// (the statement is idempotent) and failures are left for next time.
		let rows: Map<string, ConversationRow> | null = null;
		try {
			rows = new Map((await listConversationRows(stSessionId)).map((r) => [r.session_id, r]));
		} catch {
			rows = null;
		}
		const at = this.now();
		let failed = 0;
		const all = new Set<string>([...cids, ...(rows ? rows.keys() : [])]);
		for (const cid of all) {
			if (this.isDead(stSessionId)) return;
			// A runtime appeared, or a new start began: an event came from the
			// live container, and that conversation's binding is its own now.
			if (this.runtime.has(cid) || this.startGenOf(stSessionId) !== startGen) continue;
			// ── index ──
			if (cids.includes(cid)) {
				const wasResident = !!this.deps.store.getResidentIndex(stSessionId, cid);
				try {
					const index = wasResident
						? (this.deps.store.getResidentIndex(stSessionId, cid) as ConversationIndex)
						: await this.deps.store.open(stSessionId, cid);
					const stale =
						index.paneId !== null || index.tabId !== null || index.state.status !== "disconnected";
					if (stale) {
						this.deps.store.update(stSessionId, cid, (i) => {
							i.state = { status: "disconnected", evidence: "reconcile", at };
							i.paneId = null;
							i.tabId = null;
						});
					}
					// Durable before moving on. If the snapshot cannot be written the
					// index STAYS resident (memory answers the released state; the
					// next run writes it), instead of being closed and served stale
					// from disk.
					// Always flushed (a no-op when nothing is pending): an earlier run
					// may have released it in memory without managing to write it.
					const durable = await this.deps.store.flush(stSessionId, cid);
					if (!durable) throw new Error("index snapshot not written");
					if (!wasResident) await this.deps.store.close(stSessionId, cid);
				} catch (err) {
					failed++;
					logger.warn(
						`[conversation] release binding (index) failed for ${stSessionId}/${cid}: ${(err as Error).message}`,
					);
				}
			}
			// ── D1 ──
			const row = rows?.get(cid);
			const rowStale =
				rows === null ||
				(row !== undefined &&
					(row.pane_id !== null || row.tab_id !== null || row.status !== "disconnected"));
			if (rowStale && (rows === null ? cids.includes(cid) : true)) {
				try {
					await releaseConversationBinding(stSessionId, cid, new Date(at).toISOString());
					this.stats.d1Writes++;
				} catch (err) {
					failed++;
					logger.warn(
						`[conversation] release binding (D1) failed for ${stSessionId}/${cid}: ${(err as Error).message}`,
					);
				}
			}
		}
		if (failed > 0) {
			logger.warn(
				`[conversation] release bindings of ${stSessionId}: ${failed} write(s) failed; retried at the next stop or boot reconcile`,
			);
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
		meta: "ok" | "unavailable";
	}> {
		const capture = await this.authority.capture(stSessionId);
		return { capture, ...(await this.summariesWithMeta(stSessionId)) };
	}

	/**
	 * The conversation summaries without the capture block. The WS `hello`
	 * uses this: `capture` needs a fresh relay probe (D7), which a socket
	 * open must not pay for.
	 */
	async summaries(stSessionId: string): Promise<ConversationSummary[]> {
		return (await this.summariesWithMeta(stSessionId)).conversations;
	}

	/**
	 * The summaries plus whether the owner metadata could be read (§6.2
	 * rule 3): with D1 failing the list is still served from the resident
	 * indexes, but `meta: "unavailable"` lets the UI say the names are
	 * missing instead of passing the automatic titles off as current.
	 */
	async summariesWithMeta(
		stSessionId: string,
	): Promise<{ conversations: ConversationSummary[]; meta: "ok" | "unavailable" }> {
		let rows: ConversationRow[] = [];
		let ownerMeta = new Map<string, ConversationOwnerMeta>();
		let meta: "ok" | "unavailable" = "ok";
		try {
			({ rows, meta: ownerMeta } = await listConversationRowsWithMeta(stSessionId));
		} catch (err) {
			meta = "unavailable";
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
			if (index) {
				seen.add(rt.cid);
				out.push(summarizeIndex(index));
			}
		}
		// Metadata whose conversation has neither a D1 row nor a resident index: the
		// owner renamed a conversation known only from its files (setOwnerMeta accepts
		// it). Its snapshot is read from disk — no extra D1 call — so the list shows
		// it, with its name, and the PATCH can answer its summary.
		for (const cid of ownerMeta.keys()) {
			if (seen.has(cid) || !isSafeClaudeSessionId(cid)) continue;
			const index = await this.deps.store.peekIndex(stSessionId, cid).catch(() => null);
			if (index) {
				seen.add(cid);
				out.push(summarizeIndex(index));
			}
		}
		for (const s of out) applyOwnerMeta(s, ownerMeta.get(s.sessionId));
		out.sort((a, b) =>
			a.lastEventAt < b.lastEventAt ? 1 : a.lastEventAt > b.lastEventAt ? -1 : 0,
		);
		return { conversations: out, meta };
	}

	/**
	 * v1.8 §6.2 — rename/archive. The conversation must exist for THIS
	 * session (files on disk, a resident index, or a D1 row); `null` for
	 * "no such conversation". Writes only conversation_user_meta: never the
	 * events file, the index, the state or the binding (rule 2).
	 */
	async setOwnerMeta(
		stSessionId: string,
		cid: string,
		patch: { title?: string | null; archived?: boolean },
	): Promise<ConversationSummary | null> {
		if (!isSafeClaudeSessionId(cid)) return null;
		const known =
			this.deps.store.getResidentIndex(stSessionId, cid) !== undefined ||
			(await this.deps.store.exists(stSessionId, cid).catch(() => false)) ||
			(await conversationRowExists(stSessionId, cid));
		if (!known) return null;
		await upsertConversationMeta(stSessionId, cid, patch);
		const { conversations } = await this.summariesWithMeta(stSessionId);
		return conversations.find((c) => c.sessionId === cid) ?? null;
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

	/**
	 * Apply one probe of the session to its resident conversations (§5.3,
	 * v1.7.2). `waiting_input` — the state that enables the composer — is
	 * reached only with the identity verified (`verifyIdentity`); `busy` and
	 * `permission prompt` apply without it (they never enable a send); an
	 * entry whose status is missing or unreadable changes nothing; an ended
	 * conversation is never revived (state.ts).
	 */
	async applyProbe(
		stSessionId: string,
		entries: ProbeEntry[],
		startGen = this.startGenOf(stSessionId),
	): Promise<void> {
		const at = this.now();
		const byId = new Map(entries.map((e) => [e.sessionId, e]));
		for (const rt of Array.from(this.runtime.values())) {
			if (rt.stSessionId !== stSessionId) continue;
			const index = this.deps.store.getResidentIndex(rt.stSessionId, rt.cid);
			if (!index) continue;
			const e = byId.get(rt.cid);
			let input: StateInput;
			if (!e) input = { kind: "probe", found: false, at };
			else {
				const wantsIdle =
					e.status === "idle" ||
					(e.status === "waiting" && (e.waitingFor ?? "input needed") === "input needed");
				const verified = wantsIdle ? await this.verifyIdentity(index, e) : false;
				// The check awaited execs: a stop in the meantime voids it.
				if (this.startGenOf(stSessionId) !== startGen) return;
				input = {
					kind: "probe",
					found: true,
					...(e.status ? { status: e.status } : {}),
					...(e.waitingFor ? { waitingFor: e.waitingFor } : {}),
					verified,
					at,
				};
			}
			if (this.startGenOf(stSessionId) !== startGen) return;
			const before = index.state;
			const after = this.transition(rt, input);
			this.enqueueOrOpen(rt, {
				ev: "probe",
				prompt_id: null,
				turn_id: null,
				agent_id: null,
				pane: null,
				data: e
					? {
							found: true,
							status: e.status ?? null,
							kind: e.kind,
							...(e.waitingFor ? { waitingFor: e.waitingFor } : {}),
							...(input.kind === "probe" && input.found
								? { verified: input.verified === true }
								: {}),
							applied: after !== null && after !== before,
						}
					: { found: false, applied: after !== null && after !== before },
			});
		}
	}

	/**
	 * v1.7.2 §5.3 "identidad verificada": the probe entry is the INTERACTIVE
	 * process reading the prompt of the pane this conversation is bound to,
	 * in the current container start. A background job can descend from the
	 * pane (a parked session continued as a daemon job) and is not it. Every
	 * check that fails or cannot be made answers false (fail closed).
	 */
	private async verifyIdentity(index: ConversationIndex, e: ProbeEntry): Promise<boolean> {
		if (e.kind !== "interactive") return false;
		if (!index.paneId || typeof e.pid !== "number") return false;
		if (!this.deps.execCapture) return false;
		const opts = { maxBytes: 4096, timeoutMs: (EXEC_TIMEOUT_S + 2) * 1000 };
		try {
			const pane = await this.deps.execCapture(
				index.stSessionId,
				paneStateArgv(index.paneId),
				opts,
			);
			if (pane.timedOut || pane.truncated || pane.exitCode !== 0) return false;
			const state = parsePaneState(pane.stdout.toString("utf8"));
			if (!state || state.dead) return false;
			const anc = await this.deps.execCapture(
				index.stSessionId,
				ancestryArgv(e.pid, state.panePid),
				opts,
			);
			if (anc.timedOut || anc.truncated || anc.exitCode !== 0) return false;
			return anc.stdout.toString("utf8").trim() === "yes";
		} catch {
			return false;
		}
	}

	/** One probe per session in flight; callers share it (§5.3 v1.7.2). */
	private readonly probing = new Map<string, Promise<boolean>>();
	private readonly targetedTimers = new Map<string, NodeJS.Timeout>();
	private sweepTimer: NodeJS.Timeout | null = null;

	/** Probe the session and apply the result. Resolves true iff the probe answered. */
	probeAndApply(stSessionId: string): Promise<boolean> {
		const inFlight = this.probing.get(stSessionId);
		if (inFlight) return inFlight;
		const startGen = this.startGenOf(stSessionId);
		const run = (async () => {
			const entries = await this.probeSession(stSessionId);
			if (!entries || this.isDead(stSessionId)) return false;
			// A probe of a container start that has since stopped (its answer
			// came late, possibly from O) describes nothing that exists now.
			if (this.startGenOf(stSessionId) !== startGen) return false;
			await this.applyProbe(stSessionId, entries, startGen);
			return true;
		})().finally(() => {
			if (this.probing.get(stSessionId) === run) this.probing.delete(stSessionId);
		});
		this.probing.set(stSessionId, run);
		return run;
	}

	private scheduleTargetedProbe(stSessionId: string): void {
		if (!this.deps.execCapture || this.targetedTimers.has(stSessionId)) return;
		const t = setTimeout(() => {
			this.targetedTimers.delete(stSessionId);
			void this.probeAndApply(stSessionId).catch(() => undefined);
		}, TARGETED_PROBE_DELAY_MS);
		t.unref?.();
		this.targetedTimers.set(stSessionId, t);
	}

	/** Start the periodic §5.3 silence sweep (index.ts; tests call `sweepSilence`). */
	startSilenceSweep(): void {
		if (this.sweepTimer || !this.deps.enabled) return;
		this.sweepTimer = setInterval(() => {
			void this.sweepSilence().catch((err) =>
				logger.warn(`[conversation] silence sweep failed: ${(err as Error).message}`),
			);
		}, SILENCE_SWEEP_INTERVAL_MS);
		this.sweepTimer.unref?.();
	}

	/**
	 * v1.7.2 §5.3 (b). For each live conversation (running / waiting_*) of a
	 * session whose last evidence — an accepted hook, or a probe that moved
	 * or renewed its state — is ≥ SILENCE_PROBE_AFTER_MS old: one probe of
	 * the session. Whatever is still without evidence after
	 * UNKNOWN_AFTER_SILENCE_MS then decays to `unknown · timeout`. Runtimes
	 * exist only for sessions whose container is up (onSessionDown drops
	 * them), which is the table's "con contenedor running".
	 */
	async sweepSilence(): Promise<void> {
		// One sweep at a time: a sweep slowed by probes (≤ PROBE_TIMEOUT_MS
		// each, plus identity execs) must not overlap the next tick.
		if (this.sweeping) return;
		this.sweeping = true;
		try {
			await this.sweepSilenceOnce();
		} finally {
			this.sweeping = false;
		}
	}

	private sweeping = false;

	private async sweepSilenceOnce(): Promise<void> {
		const now = this.now();
		const evidenceAt = (rt: ConvRuntime, i: ConversationIndex) =>
			Math.max(rt.lastHookAt, i.state.at);
		const due = new Map<string, ConvRuntime[]>();
		for (const rt of this.runtime.values()) {
			if (this.isDead(rt.stSessionId)) continue;
			const index = this.deps.store.getResidentIndex(rt.stSessionId, rt.cid);
			if (!index || !isLiveClaim(index.state.status)) continue;
			if (now - evidenceAt(rt, index) < SILENCE_PROBE_AFTER_MS) continue;
			const list = due.get(rt.stSessionId) ?? [];
			list.push(rt);
			due.set(rt.stSessionId, list);
		}
		for (const [sid, rts] of due) {
			await this.probeAndApply(sid).catch(() => false);
			const at = this.now();
			for (const rt of rts) {
				const index = this.deps.store.getResidentIndex(rt.stSessionId, rt.cid);
				if (!index || !isLiveClaim(index.state.status)) continue;
				if (at - evidenceAt(rt, index) >= UNKNOWN_AFTER_SILENCE_MS) {
					this.transition(rt, { kind: "silence", at });
				}
			}
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
				// v1.7.2 §5.2: a session found stopped holds no pane — also the
				// bindings a stop left behind before this rule existed.
				if (!runningIds.has(sid)) await this.releaseBindings(sid);
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
				await this.probeAndApply(sid);
			} catch (err) {
				logger.warn(`[conversation] reconcile failed for ${sid}: ${(err as Error).message}`);
			}
		}
		// Sessions with conversations on disk but no capture files (their
		// capture was withdrawn): their bindings converge too. Only the
		// binding/state — no capture file is written or retired here.
		for (const sid of await this.sessionsWithConversations()) {
			if (ids.has(sid) || runningIds.has(sid)) continue;
			try {
				if (this.deps.isRecreateUnresolved) {
					if (await this.deps.isRecreateUnresolved(sid).catch(() => true)) continue;
				}
				await this.releaseBindings(sid);
			} catch (err) {
				logger.warn(
					`[conversation] reconcile: releasing bindings of ${sid} failed: ${(err as Error).message}`,
				);
			}
		}
	}

	/** ST session ids with a `.conversations/<sid>` directory. */
	private async sessionsWithConversations(): Promise<string[]> {
		try {
			const entries = await fs.readdir(path.resolve(this.deps.workspaceRoot, ".conversations"));
			return entries.filter((sid) => isSafeStSessionId(sid));
		} catch {
			return [];
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
		if (this.sweepTimer) clearInterval(this.sweepTimer);
		this.sweepTimer = null;
		for (const t of this.targetedTimers.values()) clearTimeout(t);
		this.targetedTimers.clear();
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

/**
 * v1.7.2 §5.2: states in which a conversation holds no pane — its container
 * stopped, or the probe found no process for it. (`ended` after a
 * SessionEnd keeps the existing §5.2 rule: only clear/resume release.)
 */
function releasesBinding(state: ConversationState): boolean {
	return (
		state.status === "disconnected" ||
		(state.status === "ended" && state.evidence === "probe:absent")
	);
}

function parseBearer(header: string | undefined): string | null {
	if (!header) return null;
	const m = /^Bearer\s+([0-9a-f]{64})$/i.exec(header.trim());
	return m ? m[1] : null;
}

function applyOwnerMeta(s: ConversationSummary, meta: ConversationOwnerMeta | undefined): void {
	if (!meta) return;
	s.customTitle = meta.customTitle;
	// D1 `datetime('now')` is suffix-less UTC: parse it as UTC, answer ISO.
	s.archivedAt = meta.archivedAt
		? parseD1Utc(meta.archivedAt, "conversation_user_meta").toISOString()
		: null;
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
		customTitle: null,
		archivedAt: null,
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
		customTitle: null,
		archivedAt: null,
	};
}
