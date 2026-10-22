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

import { logger } from "../logger.js";
import {
	type ActivationDeps,
	type ActivationResult,
	captureStatus,
	disableSession,
	enableSession,
	hooksFileExists,
	purgeManagedDir,
	removeAllHooksFiles,
	removeHooksFile,
	writeHooksFile,
} from "./activation.js";
import { DedupeTable, identityKey, payloadHash } from "./dedupe.js";
import { RATE_LIMIT_GAP_WINDOW_MS, SESSION_END_GRACE_MS, TOKEN_CACHE_TTL_MS } from "./limits.js";
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
	listRunningCaptureSessions,
	revokeIngestTokens,
	tokenMatchesHash,
	upsertConversation,
} from "./registry.js";
import { checkRevocation } from "./revocation.js";
import { applyStateInput, type ConversationState, type StateInput } from "./state.js";
import type {
	ConversationIndex,
	ConversationKind,
	ConversationStore,
	PendingEvent,
	PersistedEvent,
} from "./store.js";

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
	| "malformed";

export interface IngestHeaders {
	authorization?: string;
	stSession?: string;
	tmuxPane?: string;
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

export interface ServiceDeps extends ActivationDeps {
	store: ConversationStore;
	now?: () => number;
	/** `docker.execCapture` shaped runner for the probe; absent in tests. */
	execCapture?: (
		sessionId: string,
		cmd: string[],
		opts: { maxBytes: number; timeoutMs: number },
	) => Promise<{ stdout: Buffer; exitCode: number | null; truncated: boolean; timedOut: boolean }>;
}

interface TokenCacheEntry {
	status: string;
	requested: boolean;
	hash: string | null;
	expiresAt: number;
}

interface ConvRuntime {
	stSessionId: string;
	cid: string;
	dedupe: DedupeTable;
	endTimer: NodeJS.Timeout | null;
	lastRateGapAt: number;
	rateDropped: number;
	rateDroppedBytes: number;
}

// ── Service ─────────────────────────────────────────────────────────────────

export class ConversationService {
	private readonly tokenCache = new Map<string, TokenCacheEntry>();
	/** Claude session_id → ST session id (one Claude session belongs to one ST session). */
	private readonly owner = new Map<string, string>();
	private readonly runtime = new Map<string, ConvRuntime>();
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
	};

	constructor(private readonly deps: ServiceDeps) {
		this.now = deps.now ?? Date.now;
		this.heartbeat = new HeartbeatCoalescer(async (key) => {
			const [st, cid] = key.split("/");
			const index = this.deps.store.getResidentIndex(st, cid);
			if (!index) return;
			this.stats.d1Writes++;
			await upsertConversation(index);
		});
		deps.store.onEvent((st, cid, ev) => this.onPersisted(st, cid, ev));
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
		if (!token || !stSessionId || stSessionId.length > 128) return this.reject("missing_auth");
		if (!this.deps.enabled) return this.reject("disabled");
		const entry = await this.lookupToken(stSessionId);
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

		// §3.2 — a Claude session id belongs to exactly one ST session.
		const knownOwner = this.owner.get(cid);
		if (knownOwner && knownOwner !== stSessionId) return this.reject("session_mismatch");

		// §2.5 — last authorisation step, uncached, immediately before enqueue.
		const revocation = await checkRevocation(this.deps.workspaceRoot, stSessionId);
		if (revocation !== "none") {
			this.tokenCache.delete(stSessionId);
			// Converge even if the CLI was interrupted before its step 3.
			await removeHooksFile(this.deps.workspaceRoot, stSessionId).catch(() => undefined);
			await this.markRevoked(stSessionId);
			return this.reject("revoked");
		}

		const rt = await this.ensureRuntime(stSessionId, cid);
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

		this.detectGaps(rt, event);
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
			await this.deps.store.open(stSessionId, cid);
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
		let rt = this.runtime.get(cid);
		if (rt) {
			// Keep the index resident (refreshes LRU) in case it was evicted.
			if (!this.deps.store.getResidentIndex(stSessionId, cid)) {
				await this.deps.store.open(stSessionId, cid);
			}
			return rt;
		}
		const index = await this.deps.store.open(stSessionId, cid);
		this.owner.set(cid, stSessionId);
		rt = {
			stSessionId,
			cid,
			dedupe: new DedupeTable(),
			endTimer: null,
			lastRateGapAt: 0,
			rateDropped: 0,
			rateDroppedBytes: 0,
		};
		this.runtime.set(cid, rt);
		if (index.eventsCount === 0 && index.lastSeq === 0) {
			// Brand-new conversation: one registry write so it exists in D1.
			void this.heartbeat.flushNow(`${stSessionId}/${cid}`);
		}
		return rt;
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
				this.heartbeat.markDirty(`${other.stSessionId}/${other.cid}`);
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
		void this.deps.store
			.open(rt.stSessionId, rt.cid)
			.then(() => this.deps.store.enqueue(rt.stSessionId, rt.cid, pending))
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
		this.heartbeat.markDirty(`${rt.stSessionId}/${rt.cid}`);
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
		this.heartbeat.markDirty(`${stSessionId}/${cid}`);
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
			this.owner.delete(rt.cid);
		}
	}

	/** Hard delete: files and rows go; the session dir is purged by the caller's purgeWorkspace. */
	async onSessionPurged(stSessionId: string): Promise<void> {
		await this.onSessionDown(stSessionId);
		this.deps.store.forgetSession(stSessionId);
		await purgeManagedDir(this.deps.workspaceRoot, stSessionId);
		try {
			await deleteConversationRows(stSessionId);
		} catch (err) {
			logger.warn(`[conversation] row purge failed for ${stSessionId}: ${(err as Error).message}`);
		}
	}

	async enable(stSessionId: string, containerRunning: boolean): Promise<ActivationResult> {
		return enableSession(this.activationDeps, stSessionId, containerRunning);
	}

	async disable(stSessionId: string): Promise<ActivationResult> {
		const r = await disableSession(this.activationDeps, stSessionId, "api");
		await this.markRevoked(stSessionId);
		return r;
	}

	// ── Reads ────────────────────────────────────────────────────────────

	async list(stSessionId: string): Promise<{
		capture: { requested: boolean; effective: boolean; effectiveAfterRestart: boolean };
		conversations: ConversationSummary[];
	}> {
		const capture = await captureStatus(this.activationDeps, stSessionId);
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
		return { capture, conversations: out };
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
			if (removed.length > 0) {
				logger.info(
					`[conversation] capture disabled: removed ${removed.length} stale hooks file(s)`,
				);
			}
			return;
		}
		let sessions: Awaited<ReturnType<typeof listRunningCaptureSessions>> = [];
		try {
			sessions = await listRunningCaptureSessions();
		} catch (err) {
			logger.warn(`[conversation] reconcile: D1 unavailable: ${(err as Error).message}`);
			return;
		}
		for (const s of sessions) {
			const sid = s.session_id;
			try {
				const revocation = await checkRevocation(this.deps.workspaceRoot, sid);
				if (revocation !== "none") {
					if (s.conversation_requested === 1 || s.ingest_token_hash) {
						await revokeIngestTokens(sid);
						logger.info(`[conversation] reconcile: revocation marker wins over D1 for ${sid}`);
					}
					await removeHooksFile(this.deps.workspaceRoot, sid);
					continue;
				}
				const shouldHaveFile = s.conversation_requested === 1 && !!s.ingest_token_hash;
				const has = await hooksFileExists(this.deps.workspaceRoot, sid);
				if (shouldHaveFile && !has) await writeHooksFile(this.activationDeps, sid);
				else if (!shouldHaveFile && has) await removeHooksFile(this.deps.workspaceRoot, sid);
				if (!shouldHaveFile) continue;
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

	async shutdown(): Promise<void> {
		for (const rt of this.runtime.values()) {
			if (rt.endTimer) clearTimeout(rt.endTimer);
			await this.heartbeat.flushNow(`${rt.stSessionId}/${rt.cid}`);
		}
		await this.deps.store.flushAll();
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
