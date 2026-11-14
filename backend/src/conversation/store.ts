/**
 * conversation/store.ts — docs/CONVERSATION.md §3.3 / §4.1 / §4.4: the
 * host-side event log.
 *
 *   <WORKSPACE_ROOT>/.conversations/<st_session_id>/<cid>.events.jsonl   append-only
 *   <WORKSPACE_ROOT>/.conversations/<st_session_id>/<cid>.index.json     snapshot
 *
 * Invariants the contract pins:
 *   - "Persisted" ⇔ the line is in the events file with a `seq`. Only
 *     persisted events are counted, broadcast or served. The ingest 204
 *     is sent BEFORE persistence (the hook never waits on disk), so an
 *     event sits in a bounded per-conversation queue until the worker
 *     appends it.
 *   - `seq` is assigned by the worker, strictly increasing per
 *     conversation, and recovered from the FILE on open (the index is a
 *     cache: it records the byte `offset` it is valid up to, and the
 *     tail past that offset is re-scanned). D1 never holds the truth.
 *   - L6 per-conversation and G1 process-wide queue budgets; overflow
 *     drops the event and records a `gap backpressure` instead of
 *     inventing continuity. A failed append does the same.
 *   - L7 rotation keeps one archived generation (`.1`) and starts the
 *     new file with a `gap rotated`; `firstRetainedSeq` is that gap's seq.
 *   - G4: at most 64 indexes resident; eviction flushes the snapshot.
 *
 * The store knows nothing about hooks, D1 or HTTP — it takes normalised
 * events and returns persisted ones. The service layers dedupe, state
 * and registry writes on top.
 */

import { type Dirent, promises as nodeFs } from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import { assertContained, assertSafeComponent } from "./ids.js";
import {
	G1_TOTAL_QUEUE_BYTES,
	G4_INDEX_BYTES,
	G4_RESIDENT_INDEXES,
	INDEX_FLUSH_EVERY_EVENTS,
	INDEX_FLUSH_INTERVAL_MS,
	L6_QUEUE_BYTES,
	L6_QUEUE_EVENTS,
	L7_FILE_BYTES,
} from "./limits.js";
import type { EventData, EventName } from "./normalize.js";
import { conversationsRoot, sessionConversationsDir } from "./revocation.js";
import type { ConversationState } from "./state.js";
import { INITIAL_STATE } from "./state.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface PersistedEvent {
	seq: number;
	ts: string;
	ev: EventName;
	prompt_id: string | null;
	turn_id: string | null;
	agent_id: string | null;
	pane: string | null;
	data: EventData;
}

export type PendingEvent = Omit<PersistedEvent, "seq" | "ts">;

export type ConversationKind = "unknown" | "interactive" | "headless" | "teammate";

export interface AgentSummary {
	agentType: string;
	status: "running" | "done";
	startedSeq: number;
	endedSeq?: number;
	toolCount: number;
	hasResult: boolean;
}

/** The snapshot. Everything the list endpoint and the registry need. */
export interface ConversationIndex {
	v: 1;
	cid: string;
	stSessionId: string;
	/** Byte offset in the current events file the counters are valid up to. */
	offset: number;
	lastSeq: number;
	firstRetainedSeq: number;
	eventsCount: number;
	eventsBytes: number;
	gapsCount: number;
	kind: ConversationKind;
	title: string | null;
	tabId: string | null;
	paneId: string | null;
	startedAt: string;
	endedAt: string | null;
	endReason: string | null;
	lastEventAt: string;
	/**
	 * The turn correlation (`missing_prompt`, §4.6): the `prompt_id` of the
	 * newest INGESTED event. Set synchronously by the service at ingest and
	 * never by persistence — appends are async and batched, so a write of
	 * the previous turn landing after the next prompt was ingested would
	 * take it backwards (Work P2-2). Rebuilt from the file on open.
	 */
	lastPromptId: string | null;
	/**
	 * The `prompt_id` of the newest event ON DISK — what recovery may
	 * claim. Written by `appendOne`, rebuilt by the file scan; the snapshot
	 * carries it so a restart never inherits a live value that was still
	 * queued when the process died.
	 */
	persistedPromptId: string | null;
	claudeVersion: string | null;
	parentSessionId: string | null;
	parentInferred: boolean;
	state: ConversationState;
	agents: Record<string, AgentSummary>;
	/**
	 * Per-message accumulated bytes for L2 (B6). Entries live while a
	 * message is OPEN (no `final` seen); at most MESSAGE_OPEN_MAX are kept
	 * and an overflow seals the oldest. Finalised or sealed ids move to
	 * `sealedMessages`, so a tally is never silently restarted.
	 */
	messageBytes: Record<string, { bytes: number; truncated: boolean }>;
	/** Last `assistant_delta.index` per open message, for `missing_delta` gaps. */
	messageIndex: Record<string, number>;
	/**
	 * Ids of messages that ended (`final`) or were sealed by the open-set
	 * cap: any further delta for them is dropped. Bounded LRU
	 * (MESSAGE_SEALED_MAX, oldest first) — ~150 KiB at the cap.
	 */
	sealedMessages: string[];
	/** Set once a `gap revoked` was written for this conversation (§2.5). */
	revokedNoted?: boolean;
	/**
	 * 3.2 composer (§8.1.4 regla 10): the HTTP answer recorded for each
	 * RELEASED `client_message_id`, newest last, at most IDEMPOTENCY_WINDOW
	 * entries. Fed by `composer_send{state: released}` lines, so it is
	 * rebuilt from the file like the rest; a pending operation lives in its
	 * pane record (paneRecord.ts), never here.
	 */
	composerSends?: Record<string, { status: number; body: unknown; at: string }>;
}

/** §8.1.4 regla 10 — released ids kept per conversation. Mirrors composerText.IDEMPOTENCY_WINDOW. */
export const COMPOSER_IDEMPOTENCY_WINDOW = 256;

/** Record a released composer operation's answer in the index (bounded, oldest out). */
export function trackComposerSend(index: ConversationIndex, event: PersistedEvent): void {
	if (event.ev !== "composer_send" || event.data.state !== "released") return;
	const id = event.data.client_message_id;
	const http = event.data.http as { status?: unknown; body?: unknown } | null | undefined;
	if (typeof id !== "string" || !http || typeof http.status !== "number") return;
	if (!index.composerSends) index.composerSends = {};
	const map = index.composerSends;
	delete map[id];
	map[id] = { status: http.status, body: http.body, at: event.ts };
	const keys = Object.keys(map);
	for (let i = 0; i < keys.length - COMPOSER_IDEMPOTENCY_WINDOW; i++) delete map[keys[i]!];
}

export interface StoreFs {
	mkdir(p: string, opts: { recursive: true }): Promise<unknown>;
	appendFile(p: string, data: string): Promise<void>;
	writeFile(p: string, data: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	rm(p: string, opts: { force: true; recursive?: boolean }): Promise<void>;
	stat(p: string): Promise<{ size: number }>;
	readFile(p: string, enc: "utf8"): Promise<string>;
	readdir(p: string): Promise<string[]>;
	/**
	 * Optional positional read (`length` bytes from `start`). Without it an
	 * injected fs falls back to reading the whole file; the default (node)
	 * fs always reads positionally.
	 */
	readRange?(p: string, start: number, length: number): Promise<Buffer>;
}

export interface StoreOptions {
	workspaceRoot: string;
	fs?: StoreFs;
	now?: () => number;
	/** Test hooks for the budgets; production uses the contract constants. */
	limits?: Partial<{
		queueEvents: number;
		queueBytes: number;
		totalQueueBytes: number;
		fileBytes: number;
		residentIndexes: number;
		indexBytes: number;
		flushEveryEvents: number;
		flushIntervalMs: number;
		evictionKeepMax: number;
		evictionRetryBaseMs: number;
		evictionRetryMaxMs: number;
	}>;
}

/**
 * What this process knows about an event beyond what it persists. Only for
 * events it received itself: an event read back from the file has none.
 * `origin` is the §3.1.1 network-origin verdict of the request that carried
 * it — `match`, or the cause it did not match (observe mode). With the check
 * off there is no meta at all. It lives in memory only: the persisted format does
 * not change, and D3 (PROJECT_CONVERSATION.md §7.3.1) admits an agent
 * message only on `match`.
 */
export interface EventMeta {
	origin: string;
}

export type EventListener = (
	stSessionId: string,
	cid: string,
	event: PersistedEvent,
	meta?: EventMeta,
) => void;

interface CurrentFile {
	size: number;
	/** The snapshot was taken on an older L7 generation (or the file was rewritten). */
	otherGeneration: boolean;
	/** The lines to scan (from the valid offset, or the whole file). */
	tail: string;
	/** The bytes before the offset, read only for a legacy snapshot (case C). */
	head: string | null;
}

/** Longest first line read to identify a file's generation; past it the file is rescanned whole. */
const FIRST_LINE_MAX_BYTES = 16 * 1024 * 1024;

interface Resident {
	index: ConversationIndex;
	queue: PendingEvent[];
	queueBytes: number;
	/** Serialises appends per conversation. */
	chain: Promise<void>;
	eventsSinceFlush: number;
	flushTimer: NodeJS.Timeout | null;
	dirty: boolean;
	/** Dropped events waiting to be reported as one `gap backpressure`. */
	pendingDrop: { count: number; scope: "conversation" | "global" | "disk" } | null;
	currentFileBytes: number;
	/** True while `drain` runs — an append may be in flight with the queue empty (B2). */
	busy: boolean;
	/**
	 * #546 — a G4-evicted entry whose snapshot write failed is kept (it holds
	 * state that exists only in memory) and its write retried with backoff.
	 */
	retryTimer: NodeJS.Timeout | null;
	retryAttempt: number;
}

/** Open (non-final) messages tracked for the L2 budget. */
export const MESSAGE_OPEN_MAX = 256;
/** Sealed message ids remembered so a late delta can't restart a budget. */
export const MESSAGE_SEALED_MAX = 4096;
const AGENTS_MAX = 256;

/**
 * #546 — bounded overshoot past G4: at most this many evicted entries whose
 * snapshot write failed are kept in memory (each ≤ G4_INDEX_BYTES, so ≤ 64
 * MiB on top of G4's own bound). Past it the oldest kept entry is dropped and
 * counted (`evictionWriteDropped`): what it held only in memory is lost, as
 * before #546, but no longer silently.
 */
export const EVICTION_KEEP_MAX = 16;
/** #546 — retry backoff of a kept entry's snapshot write: 1 s doubling, capped. */
export const EVICTION_RETRY_BASE_MS = 1_000;
export const EVICTION_RETRY_MAX_MS = 60_000;
/**
 * #546 — consecutive index-write failures (any conversation) after which the
 * log escalates from warn to error, and again every this many after.
 * Inode exhaustion or a quota (EDQUOT) fails only the temp-file creation
 * while appends to existing events files keep working, so this log line and
 * the admin counters are the only symptoms.
 */
export const INDEX_WRITE_ESCALATE_AFTER = 5;

/**
 * The kind a `session_start` declares (§5.2): the live path (service
 * `applyMetadata`) and recovery from the file (#546) share this rule.
 */
export function sessionStartKind(data: EventData): ConversationKind {
	const flags = Array.isArray(data.argv_flags)
		? (data.argv_flags as unknown[]).filter((f): f is string => typeof f === "string")
		: [];
	if (flags.includes("-p") || flags.includes("--print")) return "headless";
	if (flags.some((f) => f.startsWith("--agent-name") || f === "--agent-id")) return "teammate";
	return "interactive";
}

/**
 * The title evidence an event carries (§5.1), shared by the live path and
 * recovery (#546): the CLI's `session_title` (on a session start or a prompt)
 * always wins; otherwise the default title is the first prompt the PERSON
 * wrote — not an injected source, not a prompt whose origin could not be
 * verified (§4.2.1), never an `internal_prompt`.
 */
export function applyTitleEvidence(index: ConversationIndex, ev: EventName, data: EventData): void {
	if (ev === "user_prompt") {
		if (
			index.title === null &&
			(data.source === undefined || data.source === "user") &&
			data.origin !== "unverified"
		) {
			index.title = String(data.prompt).slice(0, 80);
		}
	} else if (ev !== "session_start" && ev !== "internal_prompt") return;
	if (typeof data.session_title === "string") index.title = data.session_title;
}

/**
 * B6 — end a message's L2 tally: forget its open-set entries and remember
 * the id as sealed (bounded LRU). Also used when the open set overflows.
 */
export function sealMessage(index: ConversationIndex, id: string): void {
	delete index.messageBytes[id];
	delete index.messageIndex[id];
	const pos = index.sealedMessages.indexOf(id);
	if (pos !== -1) index.sealedMessages.splice(pos, 1);
	index.sealedMessages.push(id);
	while (index.sealedMessages.length > MESSAGE_SEALED_MAX) index.sealedMessages.shift();
}

/** Keep the open set bounded by sealing its oldest member. */
export function capOpenMessages(index: ConversationIndex): void {
	const ids = Object.keys(index.messageBytes);
	for (let i = 0; ids.length - i > MESSAGE_OPEN_MAX; i++) sealMessage(index, ids[i]);
}

// ── Store ───────────────────────────────────────────────────────────────────

/** The `prompt_id` of the last well-formed line that has one; `null` when none does. */
function lastPromptIdIn(content: string): string | null {
	let last: string | null = null;
	for (const line of content.split("\n")) {
		if (!line) continue;
		try {
			const ev = JSON.parse(line) as { prompt_id?: unknown };
			if (typeof ev.prompt_id === "string" && ev.prompt_id) last = ev.prompt_id;
		} catch {
			/* torn line */
		}
	}
	return last;
}

/**
 * `lastEventAt` is the time of the conversation's last ACTIVITY (CONVERSATION.md
 * v1.9.1, #568): what the CLI reported (hook events) or a person started (a
 * composer send's `prepared`). The backend's own records — a `probe` (it may
 * confirm nothing: an unverified identity, no status), a `gap` (a loss report)
 * and every other `composer_send` state (settlement, release, recovery, an
 * admin resolution, duplicate markers) — are persisted but do not move it.
 * Otherwise one confirmation-free record made an old `running` claim look
 * fresh to every reader of this time: presence (§5 of PROJECTS.md), the
 * frontend attention rule, the silence seed after a restart. `prepared` is
 * enough for the composer's duplicate watch (`rearmDupWatches`), which scans
 * by this time with a 24 h horizon.
 */
export function movesLastEventAt(event: { ev: unknown; data?: unknown }): boolean {
	if (event.ev === "probe" || event.ev === "gap") return false;
	if (event.ev === "composer_send") {
		return (event.data as { state?: unknown } | undefined)?.state === "prepared";
	}
	return true;
}

/** The last activity line's `ts` and the first line's `ts` of an events file's content. */
function activityTimesIn(content: string): {
	lastActivity: string | null;
	oldest: { ts: string; seq: number } | null;
} {
	let lastActivity: string | null = null;
	let oldest: { ts: string; seq: number } | null = null;
	for (const line of content.split("\n")) {
		if (!line) continue;
		let ev: PersistedEvent;
		try {
			ev = JSON.parse(line) as PersistedEvent;
		} catch {
			continue; // torn line
		}
		if (!ev.ts) continue;
		oldest ??= { ts: ev.ts, seq: ev.seq };
		if (movesLastEventAt(ev)) lastActivity = ev.ts;
	}
	return { lastActivity, oldest };
}

/**
 * `lastEventAt` when the last activity's time can no longer be recovered
 * (CONVERSATION.md §4.1, v1.9.1): the epoch, the same "no time" a state that
 * has none carries (`state.at = 0`). It sorts last and never reads as recent;
 * presence takes it as no evidence at all.
 */
export const NO_ACTIVITY_TIME = new Date(0).toISOString();

export class ConversationStore {
	private readonly fs: StoreFs;
	private readonly now: () => number;
	private readonly resident = new Map<string, Resident>();
	// G4 — an entry between leaving `resident` and its snapshot write landing.
	// peekIndex answers from it, since the file on disk is still older then.
	private readonly evicting = new Map<string, Resident>();
	/**
	 * The last index write of each conversation. Writes of one index run one
	 * after another (each renames a temp file over the snapshot), so an older
	 * write can never land after a newer one, and two writers never share the
	 * temp file at the same time.
	 */
	private readonly indexWrites = new Map<string, Promise<void>>();
	/** B2 — single-flight opens: concurrent first events share one load. */
	private readonly opening = new Map<string, Promise<ConversationIndex>>();
	/** B4 — sessions being purged: opens/appends for them are refused. */
	private readonly purging = new Set<string>();
	private readonly listeners = new Set<EventListener>();
	/** Keyed by the queued object itself, so it goes away with it. */
	private readonly liveMeta = new WeakMap<PendingEvent, EventMeta>();
	private totalQueueBytes = 0;
	/** High-water mark of `totalQueueBytes` since boot (admin stats, §7). */
	private maxTotalQueueBytes = 0;
	private readonly lim: Required<NonNullable<StoreOptions["limits"]>>;
	/**
	 * #546 — the `evicting` entries kept after a failed snapshot write, oldest
	 * first (the order the K bound drops them in). A subset of `evicting`.
	 */
	private readonly kept = new Map<string, Resident>();
	/** Counters for admin stats (3.0d exposes them; #546 adds the index-write ones). */
	readonly stats = {
		persisted: 0,
		dropped: 0,
		appendFailures: 0,
		rotations: 0,
		evictions: 0,
		indexWriteFailures: 0,
		evictionWriteKept: 0,
		evictionWriteDropped: 0,
	};
	/** #546 — the errno code of the last failed index write (`null` until one fails). */
	lastIndexWriteErrorCode: string | null = null;
	/** #546 — index writes failed in a row, any conversation; reset by a success. */
	private consecutiveIndexWriteFailures = 0;

	constructor(private readonly opts: StoreOptions) {
		this.fs = opts.fs ?? (nodeFs as unknown as StoreFs);
		this.now = opts.now ?? Date.now;
		this.lim = {
			queueEvents: L6_QUEUE_EVENTS,
			queueBytes: L6_QUEUE_BYTES,
			totalQueueBytes: G1_TOTAL_QUEUE_BYTES,
			fileBytes: L7_FILE_BYTES,
			residentIndexes: G4_RESIDENT_INDEXES,
			indexBytes: G4_INDEX_BYTES,
			flushEveryEvents: INDEX_FLUSH_EVERY_EVENTS,
			flushIntervalMs: INDEX_FLUSH_INTERVAL_MS,
			evictionKeepMax: EVICTION_KEEP_MAX,
			evictionRetryBaseMs: EVICTION_RETRY_BASE_MS,
			evictionRetryMaxMs: EVICTION_RETRY_MAX_MS,
			...opts.limits,
		};
	}

	// ── Paths ──────────────────────────────────────────────────────────────

	sessionDir(stSessionId: string): string {
		return sessionConversationsDir(this.opts.workspaceRoot, stSessionId);
	}
	eventsPath(stSessionId: string, cid: string): string {
		return this.fileUnderSession(stSessionId, cid, ".events.jsonl");
	}
	indexPath(stSessionId: string, cid: string): string {
		return this.fileUnderSession(stSessionId, cid, ".index.json");
	}
	/** B1 — `cid` is attacker-influenced (hook body); validate and contain. */
	private fileUnderSession(stSessionId: string, cid: string, suffix: string): string {
		assertSafeComponent(cid, "conversation id");
		const dir = this.sessionDir(stSessionId);
		return assertContained(dir, path.join(dir, `${cid}${suffix}`), "conversation file");
	}

	onEvent(listener: EventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	// ── Open / recover ─────────────────────────────────────────────────────

	/**
	 * Load (or create) the resident entry for a conversation. The events
	 * file is the source of truth for `lastSeq`/counters: the index is
	 * trusted only up to its `offset`, and every line after it is
	 * re-scanned, so a crash between an append and the next snapshot
	 * can never make `seq` go backwards.
	 */
	async open(stSessionId: string, cid: string): Promise<ConversationIndex> {
		const key = `${stSessionId}/${cid}`;
		if (this.purging.has(stSessionId)) throw new Error(`session ${stSessionId} is being purged`);
		const existing = this.resident.get(key);
		if (existing) {
			// Refresh LRU order.
			this.resident.delete(key);
			this.resident.set(key, existing);
			return existing.index;
		}
		// G4 — reopened while its eviction write is in flight: the entry being
		// written IS the current state (the file is still older, and loading it
		// would register a second entry missing what was only in memory).
		// Adopt it back; the in-flight write is harmless (same object, and the
		// next write is ordered after it).
		const leaving = this.evicting.get(key);
		if (leaving) {
			this.evicting.delete(key);
			// #546 — a kept entry (its eviction write failed) is resident again:
			// no retry timer of its own; the ordinary flush path writes it.
			this.forgetKept(key, leaving);
			this.resident.set(key, leaving);
			if (leaving.dirty) this.scheduleFlush(leaving);
			await this.evictIfNeeded();
			return leaving.index;
		}
		// B2 — two concurrent first events for the same conversation must
		// share ONE load and ONE resident entry; a second entry would carry
		// its own `lastSeq` and hand out duplicate seqs.
		const inFlight = this.opening.get(key);
		if (inFlight) return inFlight;
		const load = this.loadAndRegister(stSessionId, cid, key).finally(() =>
			this.opening.delete(key),
		);
		this.opening.set(key, load);
		return load;
	}

	private async loadAndRegister(
		stSessionId: string,
		cid: string,
		key: string,
	): Promise<ConversationIndex> {
		const { index, legacyPromptCorrelation, fromSnapshot } = await this.loadIndex(stSessionId, cid);
		const fileBytes = await this.recoverFromFile(
			stSessionId,
			cid,
			index,
			legacyPromptCorrelation,
			fromSnapshot,
		);
		// A purge or a concurrent registration may have raced the awaits.
		if (this.purging.has(stSessionId)) throw new Error(`session ${stSessionId} is being purged`);
		const raced = this.resident.get(key);
		if (raced) return raced.index;
		const r: Resident = {
			index,
			queue: [],
			queueBytes: 0,
			chain: Promise.resolve(),
			eventsSinceFlush: 0,
			flushTimer: null,
			dirty: false,
			pendingDrop: null,
			currentFileBytes: fileBytes,
			busy: false,
			retryTimer: null,
			retryAttempt: 0,
		};
		this.resident.set(key, r);
		await this.evictIfNeeded();
		return index;
	}

	/** True when the conversation has an events file or index on disk. */
	async exists(stSessionId: string, cid: string): Promise<boolean> {
		try {
			await this.fs.stat(this.eventsPath(stSessionId, cid));
			return true;
		} catch {
			try {
				await this.fs.stat(this.indexPath(stSessionId, cid));
				return true;
			} catch {
				return false;
			}
		}
	}

	/** Conversation ids with files under a session dir (for listing/reconcile). */
	async listConversationIds(stSessionId: string): Promise<string[]> {
		let names: string[];
		try {
			names = await this.fs.readdir(this.sessionDir(stSessionId));
		} catch {
			return [];
		}
		const ids = new Set<string>();
		for (const n of names) {
			const m = /^(.+)\.(events\.jsonl|index\.json)$/.exec(n);
			if (m) ids.add(m[1]);
		}
		return Array.from(ids);
	}

	/** Read the snapshot from disk without making it resident (list endpoint). */
	async peekIndex(stSessionId: string, cid: string): Promise<ConversationIndex | null> {
		const key = `${stSessionId}/${cid}`;
		const resident = this.resident.get(key) ?? this.evicting.get(key);
		if (resident) return resident.index;
		try {
			const raw = await this.fs.readFile(this.indexPath(stSessionId, cid), "utf8");
			const parsed = JSON.parse(raw) as Partial<ConversationIndex>;
			return parsed && parsed.v === 1 && parsed.cid === cid ? (parsed as ConversationIndex) : null;
		} catch {
			return null;
		}
	}

	/**
	 * §8.1.4 rules 9b/10 — the recorded answer of a RELEASED composer
	 * operation, or null when `clientMessageId` is not in the window.
	 *
	 * In memory (resident or evicting) the index is complete: it was rebuilt
	 * from the file when opened and every append since went through it. A
	 * snapshot alone is only a cache that may be stale — its write can fail
	 * (#546: EDQUOT, inode exhaustion) while the `released` lines still reach
	 * the events file — so a miss there is settled by rebuilding the window
	 * the way `open` would (snapshot + scan of the file past its offset),
	 * without making the conversation resident and without writing anything.
	 * A replay must never depend on a snapshot write having landed: an id
	 * the file proves released and that is treated as new is a second
	 * delivery. The rebuild reads the current file and, when the snapshot is
	 * from an older L7 generation, the `.1` lines past it; an id whose file
	 * L7 rotated away is out of the window and treated as new (§8.1.4 rule
	 * 10). A read error other than "no file" throws: the composer answers
	 * `send-in-progress{unverifiable}` rather than guess (fail closed).
	 */
	async releasedComposerSend(
		stSessionId: string,
		cid: string,
		clientMessageId: string,
	): Promise<{ status: number; body: unknown; at: string } | null> {
		const key = `${stSessionId}/${cid}`;
		const lookup = (index: ConversationIndex) => index.composerSends?.[clientMessageId] ?? null;
		const inMemory = () => this.resident.get(key) ?? this.evicting.get(key);
		let mem = inMemory();
		if (!mem && this.opening.has(key)) {
			await this.opening.get(key)?.catch(() => null);
			mem = inMemory();
		}
		if (mem) return lookup(mem.index);
		const { index, legacyPromptCorrelation, fromSnapshot } = await this.loadIndex(stSessionId, cid);
		if (fromSnapshot) {
			const hit = index.composerSends?.[clientMessageId];
			if (hit) return hit;
		}
		await this.recoverFromFile(stSessionId, cid, index, legacyPromptCorrelation, fromSnapshot, {
			readOnly: true,
		});
		return lookup(index);
	}

	getResidentIndex(stSessionId: string, cid: string): ConversationIndex | undefined {
		return this.resident.get(`${stSessionId}/${cid}`)?.index;
	}

	residentCount(): number {
		return this.resident.size;
	}

	/**
	 * `legacyPromptCorrelation` is true for a snapshot written before
	 * `persistedPromptId` existed: its `lastPromptId` is the dead process's
	 * LIVE value, which may never have reached the disk, so recovery must
	 * not take it as proof (Work P2-2 round 3). An explicit `null` in a
	 * modern snapshot is a value, not an absence.
	 */
	private async loadIndex(
		stSessionId: string,
		cid: string,
	): Promise<{
		index: ConversationIndex;
		legacyPromptCorrelation: boolean;
		fromSnapshot: boolean;
	}> {
		const fresh: ConversationIndex = {
			v: 1,
			cid,
			stSessionId,
			offset: 0,
			lastSeq: 0,
			firstRetainedSeq: 1,
			eventsCount: 0,
			eventsBytes: 0,
			gapsCount: 0,
			kind: "unknown",
			title: null,
			tabId: null,
			paneId: null,
			startedAt: new Date(this.now()).toISOString(),
			endedAt: null,
			endReason: null,
			lastEventAt: new Date(this.now()).toISOString(),
			lastPromptId: null,
			persistedPromptId: null,
			claudeVersion: null,
			parentSessionId: null,
			parentInferred: false,
			state: { ...INITIAL_STATE },
			agents: {},
			messageBytes: {},
			messageIndex: {},
			sealedMessages: [],
		};
		try {
			const raw = await this.fs.readFile(this.indexPath(stSessionId, cid), "utf8");
			const parsed = JSON.parse(raw) as Partial<ConversationIndex>;
			if (parsed && parsed.v === 1 && parsed.cid === cid) {
				return {
					index: {
						...fresh,
						...parsed,
						agents: parsed.agents ?? {},
						messageBytes: parsed.messageBytes ?? {},
						messageIndex: parsed.messageIndex ?? {},
						sealedMessages: parsed.sealedMessages ?? [],
						composerSends: parsed.composerSends ?? {},
					},
					legacyPromptCorrelation: !("persistedPromptId" in parsed),
					fromSnapshot: true,
				};
			}
		} catch {
			/* no index or unreadable: the file scan below rebuilds */
		}
		return { index: fresh, legacyPromptCorrelation: false, fromSnapshot: false };
	}

	/**
	 * Scan the events file from `index.offset`; returns the file size.
	 *
	 * Turn correlation (§4.6) after a restart is rebuilt from EVIDENCE ON
	 * DISK only, in three cases: (A) the snapshot recorded a persisted
	 * prompt id → that is the baseline; (B) it recorded `null` → nothing
	 * persisted had a prompt id, and the dead process's live `lastPromptId`
	 * is NOT a fallback (its write may have failed); (C) a legacy snapshot
	 * without the field → the whole file is read for its last prompt id, and
	 * the live value is ignored. The re-scanned tail then advances the
	 * baseline. A missing file proves nothing: (A) keeps its recorded
	 * value, (B) and (C) are null.
	 */
	private async recoverFromFile(
		stSessionId: string,
		cid: string,
		index: ConversationIndex,
		legacyPromptCorrelation: boolean,
		fromSnapshot = true,
		opts: { readOnly?: boolean } = {},
	): Promise<number> {
		if (legacyPromptCorrelation) index.persistedPromptId = null;
		const file = this.eventsPath(stSessionId, cid);
		// What the snapshot covers: every line with a seq above this is newer.
		const baseSeq = fromSnapshot ? index.lastSeq : 0;
		let current: CurrentFile | null;
		try {
			current = await this.readCurrentFile(
				file,
				index,
				legacyPromptCorrelation,
				fromSnapshot,
				opts,
			);
		} catch (err) {
			// `readOnly` (a rebuild that is not registered, #546) must not take
			// an unreadable file for an absent one: its caller decides on it.
			if (opts.readOnly && (err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			current = null;
		}
		// #546 — the snapshot does not cover the lines between its own offset
		// and the rotation when it belongs to an OLDER L7 generation (its
		// writes failed across a rotation), when there is no snapshot, or when
		// the current file is gone: those lines can only be in `.1`. Only the
		// state that is not a per-file counter is taken from them.
		if (!fromSnapshot || current === null || current.otherGeneration)
			await this.applyArchiveTail(file, index, baseSeq, opts.readOnly === true);
		if (current === null) {
			// No file: whatever the index claims about seq is unproven.
			// Keep lastSeq (a rotated-away file can be gone) but reset offset.
			index.offset = 0;
			index.lastPromptId = index.persistedPromptId;
			// A rotation whose `gap rotated` append failed leaves only `.1`.
			if (!fromSnapshot) await this.lastEventAtFromArchive(file, index, null);
			return 0;
		}
		const { size, tail } = current;
		if (index.offset === 0) {
			index.eventsCount = 0;
			index.eventsBytes = 0;
			index.gapsCount = 0;
			index.lastSeq = Math.max(0, index.lastSeq);
			index.firstRetainedSeq = 0;
			index.persistedPromptId = null;
		} else if (legacyPromptCorrelation) {
			// Case C: the counters stay trusted up to `offset`, but the
			// correlation is proven only by the lines before it.
			index.persistedPromptId = lastPromptIdIn(current.head ?? "");
		}
		index.lastPromptId = index.persistedPromptId;
		let scannedSeq = index.offset === 0 ? 0 : index.lastSeq;
		let sawActivity = false;
		let oldestAny: { ts: string; seq: number } | null = null;
		for (const line of tail.split("\n")) {
			if (!line) continue;
			let ev: PersistedEvent;
			try {
				ev = JSON.parse(line) as PersistedEvent;
			} catch {
				continue; // a torn last line from a crash mid-append
			}
			if (typeof ev.seq !== "number") continue;
			if (index.firstRetainedSeq === 0) index.firstRetainedSeq = ev.seq;
			scannedSeq = Math.max(scannedSeq, ev.seq);
			index.eventsCount++;
			index.eventsBytes += Buffer.byteLength(line, "utf8") + 1;
			if (ev.ev === "gap") index.gapsCount++;
			if (ev.ts) {
				oldestAny ??= { ts: ev.ts, seq: ev.seq };
				if (movesLastEventAt(ev)) {
					index.lastEventAt = ev.ts;
					sawActivity = true;
				}
			}
			if (typeof ev.prompt_id === "string" && ev.prompt_id) {
				index.persistedPromptId = ev.prompt_id;
				index.lastPromptId = ev.prompt_id;
			}
			this.recoverIndexState(index, ev);
			if (ev.ev === "assistant_delta") {
				// B6 — the L2 budget must survive a restart: lines past the
				// snapshot's offset re-add their bytes to the message tally.
				const id = String(ev.data?.message_id ?? "");
				const delta = typeof ev.data?.delta === "string" ? ev.data.delta : "";
				if (!index.sealedMessages.includes(id)) {
					const cur = index.messageBytes[id] ?? { bytes: 0, truncated: false };
					index.messageBytes[id] = {
						bytes: cur.bytes + Buffer.byteLength(delta, "utf8"),
						truncated: cur.truncated || ev.data?.truncated === true,
					};
					const idx = Number(ev.data?.index ?? 0);
					index.messageIndex[id] = Math.max(idx, index.messageIndex[id] ?? -1);
					// Same rules as live processing (B6 round 3): a final seals,
					// otherwise the open set is capped by sealing its oldest.
					if (ev.data?.final === true) sealMessage(index, id);
					else capOpenMessages(index);
				}
			}
		}
		if (index.firstRetainedSeq === 0) index.firstRetainedSeq = index.lastSeq + 1;
		index.lastSeq = Math.max(index.lastSeq, scannedSeq);
		// No snapshot and no activity line in the current file (one that L7
		// rotated, holding only `gap rotated` and probes): the fresh index says
		// "now", which would date the conversation as the newest, and the
		// newest line is a probe or a gap — taking it would let a restart
		// re-freshen an old claim, which the live path never does. What the
		// live index held is the last activity before the rotation, so read it
		// from the `.1` archive; with none there either, the live index still
		// held the time it was opened, and the oldest line on disk is the
		// closest record of that — but only while the whole history is on disk
		// (the oldest line is seq 1). When it is not (two rotations since the
		// last activity, an archive lost), the time is gone: NO_ACTIVITY_TIME,
		// never a later line that would read as activity (owner, 2026-11-10:
		// unknown presence rather than a false sign of activity). A snapshot's
		// value, when there is one, is kept as is.
		if (!fromSnapshot && !sawActivity) await this.lastEventAtFromArchive(file, index, oldestAny);
		index.offset = size;
		return size;
	}

	/**
	 * The current events file as recovery needs it. With a snapshot whose
	 * offset is valid for THIS file only the tail past the offset is read
	 * (a positional read: a lookup on the request path must not read up to
	 * L7 bytes); otherwise the whole file.
	 *
	 * A snapshot's offset is valid only for the L7 generation it was taken
	 * on: the file's first line must be the snapshot's `firstRetainedSeq`.
	 * A rotation starts the new file at a seq above everything the snapshot
	 * saw, so a snapshot left behind by failing writes (#546) never matches —
	 * and trusting its offset would start the scan in the middle of the newer
	 * file, past `released` lines the composer's replay depends on.
	 */
	private async readCurrentFile(
		file: string,
		index: ConversationIndex,
		legacyPromptCorrelation: boolean,
		fromSnapshot: boolean,
		opts: { readOnly?: boolean },
	): Promise<CurrentFile> {
		let size = (await this.fs.stat(file)).size;
		if (size > 0 && !opts.readOnly) {
			const last = await this.readRange(file, size - 1, 1);
			if (last[0] !== 0x0a) {
				// A torn last line (crash mid-append). Terminate it so the next
				// append starts a fresh line instead of gluing onto the fragment;
				// the fragment itself is skipped by the parse.
				try {
					await this.fs.appendFile(file, "\n");
					size += 1;
				} catch {
					/* read-only or failing disk: the scan still works */
				}
			}
		}
		let otherGeneration = false;
		if (index.offset > size) {
			// Truncated or rewritten — or a later generation still shorter.
			index.offset = 0;
			otherGeneration = fromSnapshot;
		} else if (fromSnapshot && index.offset > 0) {
			if ((await this.firstLineSeq(file, size)) !== index.firstRetainedSeq) {
				index.offset = 0;
				otherGeneration = true;
			}
		}
		if (index.offset === 0 || legacyPromptCorrelation) {
			const all = await this.readRange(file, 0, size);
			return {
				size,
				otherGeneration,
				tail: all.subarray(index.offset).toString("utf8"),
				head: legacyPromptCorrelation ? all.subarray(0, index.offset).toString("utf8") : null,
			};
		}
		const tail = await this.readRange(file, index.offset, size - index.offset);
		return { size, otherGeneration, tail: tail.toString("utf8"), head: null };
	}

	/** The `seq` of a file's first line; null when it cannot be read as one. */
	private async firstLineSeq(file: string, size: number): Promise<number | null> {
		let len = Math.min(size, 4 * 1024);
		for (;;) {
			const buf = await this.readRange(file, 0, len);
			const nl = buf.indexOf(0x0a);
			if (nl === -1 && len < size && len < FIRST_LINE_MAX_BYTES) {
				len = Math.min(size, len * 4, FIRST_LINE_MAX_BYTES);
				continue;
			}
			if (nl === -1 && len < size) return null;
			try {
				const line = buf.subarray(0, nl === -1 ? buf.length : nl).toString("utf8");
				const seq = (JSON.parse(line) as { seq?: unknown }).seq;
				return typeof seq === "number" ? seq : null;
			} catch {
				return null;
			}
		}
	}

	/** `length` bytes of `p` from `start`: a positional read when the fs offers one. */
	private async readRange(p: string, start: number, length: number): Promise<Buffer> {
		if (length <= 0) return Buffer.alloc(0);
		if (this.fs.readRange) return this.fs.readRange(p, start, length);
		if (!this.opts.fs) {
			const fh = await nodeFs.open(p, "r");
			try {
				const buf = Buffer.alloc(length);
				const { bytesRead } = await fh.read(buf, 0, length, start);
				return buf.subarray(0, bytesRead);
			} finally {
				await fh.close();
			}
		}
		// An injected fs without positional reads (tests): the whole file.
		const all = Buffer.from(await this.fs.readFile(p, "utf8"), "utf8");
		return all.subarray(start, start + length);
	}

	/**
	 * #546 — lines of the `.1` archive newer than the snapshot (`seq >
	 * baseSeq`): their seq, composer window, agents and metadata. Counters,
	 * the prompt correlation and the L2 tallies belong to the current file
	 * and are left alone. A history older than `.1` (two rotations since the
	 * snapshot) is gone: ids released there are out of the composer window
	 * and treated as new, as §8.1.4 rule 10 states for any rotation.
	 */
	private async applyArchiveTail(
		file: string,
		index: ConversationIndex,
		baseSeq: number,
		readOnly: boolean,
	): Promise<void> {
		let content: string;
		try {
			content = await this.fs.readFile(`${file}.1`, "utf8");
		} catch (err) {
			if (readOnly && (err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			return;
		}
		for (const line of content.split("\n")) {
			if (!line) continue;
			let ev: PersistedEvent;
			try {
				ev = JSON.parse(line) as PersistedEvent;
			} catch {
				continue;
			}
			if (typeof ev.seq !== "number" || ev.seq <= baseSeq) continue;
			// Seq never goes backwards, whichever file proves it.
			index.lastSeq = Math.max(index.lastSeq, ev.seq);
			this.recoverIndexState(index, ev);
		}
	}

	/**
	 * #546 — what only the in-memory index held, rebuilt from a persisted
	 * line where the file carries it: the composer window, the agents (lost
	 * on a crash too, before), the session-start metadata, the title and the
	 * revocation note. Bindings (`paneId`/`tabId`) and `state` are not: they
	 * converge through the stop/boot reconcile, the next event with a pane, a
	 * hook or a probe (CONVERSATION.md v1.7.2).
	 */
	private recoverIndexState(index: ConversationIndex, ev: PersistedEvent): void {
		trackComposerSend(index, ev);
		if (ev.data && typeof ev.data === "object") {
			this.trackMessageAndAgents(index, ev);
			this.recoverMetadata(index, ev);
		}
	}

	// ── Append ─────────────────────────────────────────────────────────────

	/**
	 * Queue an event. Returns "queued" or the drop reason. A `gap` event
	 * bypasses the queue budgets (it IS the drop report, a few bytes) but
	 * still goes through the same serialised chain.
	 */
	enqueue(
		stSessionId: string,
		cid: string,
		pending: PendingEvent,
		meta?: EventMeta,
	): "queued" | "dropped" | "not_open" {
		if (this.purging.has(stSessionId)) return "not_open";
		const r = this.resident.get(`${stSessionId}/${cid}`);
		// Evicted by the G4 LRU between two calls: the caller reopens
		// (async) and retries; never throw into a timer or a hook path.
		if (!r) return "not_open";
		const bytes = Buffer.byteLength(JSON.stringify(pending), "utf8") + 64;
		const isGap = pending.ev === "gap";
		if (!isGap) {
			if (r.queue.length >= this.lim.queueEvents || r.queueBytes + bytes > this.lim.queueBytes) {
				this.noteDrop(r, "conversation");
				return "dropped";
			}
			if (this.totalQueueBytes + bytes > this.lim.totalQueueBytes) {
				this.noteDrop(r, "global");
				return "dropped";
			}
		}
		if (meta) this.liveMeta.set(pending, meta);
		r.queue.push(pending);
		r.queueBytes += bytes;
		this.totalQueueBytes += bytes;
		if (this.totalQueueBytes > this.maxTotalQueueBytes)
			this.maxTotalQueueBytes = this.totalQueueBytes;
		r.chain = r.chain.then(() => this.drain(stSessionId, cid, r)).catch(() => undefined);
		return "queued";
	}

	private noteDrop(r: Resident, scope: "conversation" | "global" | "disk"): void {
		this.stats.dropped++;
		if (r.pendingDrop && r.pendingDrop.scope === scope) r.pendingDrop.count++;
		else r.pendingDrop = { count: 1, scope };
	}

	/** Wait for every queued event of a conversation to hit disk (tests, shutdown). */
	/**
	 * Write the snapshot now. Resolves false when it could not be written
	 * (the index stays resident and dirty; `writeIndex` logged why) — callers
	 * that must know the snapshot is durable check it (v1.7.2 binding release).
	 */
	async flush(stSessionId: string, cid: string): Promise<boolean> {
		const r = this.resident.get(`${stSessionId}/${cid}`);
		if (!r) return true;
		await r.chain;
		await this.writeIndex(r);
		return !r.dirty;
	}

	async flushAll(): Promise<void> {
		for (const r of this.resident.values()) {
			await r.chain;
			await this.writeIndex(r);
		}
		// #546 — one more attempt for the entries kept after a failed eviction
		// write (shutdown): a success lets them leave, a failure keeps them.
		for (const r of Array.from(this.kept.values())) await this.writeIndex(r);
	}

	private async drain(stSessionId: string, cid: string, r: Resident): Promise<void> {
		r.busy = true;
		try {
			await this.drainQueue(stSessionId, cid, r);
		} finally {
			r.busy = false;
		}
	}

	private async drainQueue(stSessionId: string, cid: string, r: Resident): Promise<void> {
		while (r.queue.length > 0) {
			// A pending drop report goes first so the gap sits where the
			// loss happened, before whatever got through after it.
			if (r.pendingDrop) {
				const drop = r.pendingDrop;
				r.pendingDrop = null;
				const gap: PendingEvent = {
					ev: "gap",
					prompt_id: null,
					turn_id: null,
					agent_id: null,
					pane: null,
					data: { reason: "backpressure", scope: drop.scope, dropped: drop.count },
				};
				const written = await this.appendOne(stSessionId, cid, r, gap, { isDropReport: true });
				// The report itself could not be written (disk still down):
				// keep the original tally for the next attempt rather than
				// counting the report as a lost event.
				if (!written) r.pendingDrop = drop;
			}
			const pending = r.queue.shift() as PendingEvent;
			const bytes = Buffer.byteLength(JSON.stringify(pending), "utf8") + 64;
			r.queueBytes -= bytes;
			this.totalQueueBytes -= bytes;
			await this.appendOne(stSessionId, cid, r, pending);
		}
	}

	private async appendOne(
		stSessionId: string,
		cid: string,
		r: Resident,
		pending: PendingEvent,
		opts: { isDropReport?: boolean } = {},
	): Promise<PersistedEvent | null> {
		const seq = r.index.lastSeq + 1;
		const event: PersistedEvent = { seq, ts: new Date(this.now()).toISOString(), ...pending };
		const line = `${JSON.stringify(event)}\n`;
		const lineBytes = Buffer.byteLength(line, "utf8");
		try {
			await this.fs.mkdir(this.sessionDir(stSessionId), { recursive: true });
			await this.fs.appendFile(this.eventsPath(stSessionId, cid), line);
		} catch (err) {
			this.stats.appendFailures++;
			logger.warn(`[conversation] append failed for ${cid}: ${(err as Error).message}`);
			// The event is lost; report it as a gap once the disk is back.
			if (!opts.isDropReport) this.noteDrop(r, "disk");
			return null;
		}
		r.index.lastSeq = seq;
		r.index.offset += lineBytes;
		r.index.eventsCount++;
		r.index.eventsBytes += lineBytes;
		if (movesLastEventAt(event)) r.index.lastEventAt = event.ts;
		if (event.ev === "gap") r.index.gapsCount++;
		// Persistence records what reached the disk and never touches the
		// live correlation: `lastPromptId` belongs to ingest (see its doc).
		if (event.prompt_id) r.index.persistedPromptId = event.prompt_id;
		if (r.index.firstRetainedSeq === 0) r.index.firstRetainedSeq = seq;
		r.currentFileBytes += lineBytes;
		r.dirty = true;
		r.eventsSinceFlush++;
		this.stats.persisted++;
		this.trackMessageAndAgents(r.index, event);
		trackComposerSend(r.index, event);
		const meta = this.liveMeta.get(pending);
		for (const l of this.listeners) {
			try {
				l(stSessionId, cid, event, meta);
			} catch {
				/* listener error never breaks persistence */
			}
		}
		if (r.currentFileBytes >= this.lim.fileBytes) await this.rotate(stSessionId, cid, r);
		if (r.eventsSinceFlush >= this.lim.flushEveryEvents) await this.writeIndex(r);
		else this.scheduleFlush(r);
		return event;
	}

	/** #546 — the metadata a persisted line carries, applied in file order (see recoverFromFile). */
	private recoverMetadata(index: ConversationIndex, ev: PersistedEvent): void {
		if (ev.ev === "session_start") {
			index.kind = sessionStartKind(ev.data);
			// As live (§5.2 v1.8.5): a `claude -p` never holds a pane.
			if (index.kind === "headless") index.paneId = null;
			if (typeof ev.data.claude_version === "string") index.claudeVersion = ev.data.claude_version;
		}
		applyTitleEvidence(index, ev.ev, ev.data);
		if (ev.ev === "gap" && ev.data.reason === "revoked") index.revokedNoted = true;
	}

	private trackMessageAndAgents(index: ConversationIndex, event: PersistedEvent): void {
		if (event.ev === "agent_start") {
			const id = String(event.data.agent_id ?? "");
			if (id && Object.keys(index.agents).length < AGENTS_MAX) {
				index.agents[id] = {
					agentType: String(event.data.agent_type ?? ""),
					status: "running",
					startedSeq: event.seq,
					toolCount: 0,
					hasResult: false,
				};
			}
		} else if (event.ev === "agent_end") {
			const id = String(event.data.agent_id ?? "");
			const a = index.agents[id];
			if (a) {
				a.status = "done";
				a.endedSeq = event.seq;
				a.hasResult = typeof event.data.last_assistant_message === "string";
			} else if (id && Object.keys(index.agents).length < AGENTS_MAX) {
				index.agents[id] = {
					agentType: String(event.data.agent_type ?? ""),
					status: "done",
					startedSeq: event.seq,
					endedSeq: event.seq,
					toolCount: 0,
					hasResult: typeof event.data.last_assistant_message === "string",
				};
			}
		} else if (event.ev === "tool_start" && event.agent_id) {
			const a = index.agents[event.agent_id];
			if (a) a.toolCount++;
		}
		// `assistant_delta`: the L2 tally is owned by the service (synchronous
		// at enqueue) and by `sealMessage`; nothing is shed here (B6).
	}

	private scheduleFlush(r: Resident): void {
		if (r.flushTimer) return;
		r.flushTimer = setTimeout(() => {
			r.flushTimer = null;
			void this.writeIndex(r);
		}, this.lim.flushIntervalMs);
		r.flushTimer.unref?.();
	}

	private writeIndex(r: Resident): Promise<void> {
		const key = `${r.index.stSessionId}/${r.index.cid}`;
		const prev = this.indexWrites.get(key) ?? Promise.resolve();
		// writeIndexNow catches its I/O errors; a throw anyway must neither skip
		// the writes queued behind it nor surface as an unhandled rejection.
		const next = prev.catch(() => undefined).then(() => this.writeIndexNow(r));
		this.indexWrites.set(key, next);
		const done = () => {
			if (this.indexWrites.get(key) !== next) return;
			this.indexWrites.delete(key);
			if (this.evicting.get(key) !== r) return;
			// #546 — the last write of a leaving entry failed: the entry is the
			// only copy of what it held in memory, so it stays (bounded, retried)
			// instead of leaving with it. A purge never keeps anything.
			if (r.dirty && !this.purging.has(r.index.stSessionId)) {
				this.keepAfterFailedWrite(key, r);
				return;
			}
			// The last write of a leaving entry landed, whoever queued it (an
			// eviction, a flush timer, a flush, a retry): it no longer needs to answer.
			this.evicting.delete(key);
			this.forgetKept(key, r);
		};
		void next.then(done, done);
		return next;
	}

	private async writeIndexNow(r: Resident): Promise<void> {
		if (!r.dirty) return;
		// B4 — a purge removes the directory; a write that would recreate it
		// must not start (one already running is awaited by the purge).
		if (this.purging.has(r.index.stSessionId)) {
			// Disarm it too: a flush timer still armed on an entry the purge
			// does not hold (an evicting one) would fire after the rm.
			r.dirty = false;
			if (r.flushTimer) {
				clearTimeout(r.flushTimer);
				r.flushTimer = null;
			}
			return;
		}
		r.dirty = false;
		r.eventsSinceFlush = 0;
		if (r.flushTimer) {
			clearTimeout(r.flushTimer);
			r.flushTimer = null;
		}
		const file = this.indexPath(r.index.stSessionId, r.index.cid);
		let body = JSON.stringify(r.index);
		if (Buffer.byteLength(body, "utf8") > this.lim.indexBytes) {
			// G4: shed the per-message tracking first, then agents.
			// Open tallies are capped at MESSAGE_OPEN_MAX and sealed ids at
			// MESSAGE_SEALED_MAX, so this branch is only reachable through
			// `agents`; shed those first and keep the L2 state intact.
			body = JSON.stringify(r.index);
			if (Buffer.byteLength(body, "utf8") > this.lim.indexBytes) {
				r.index.agents = {};
				body = JSON.stringify(r.index);
			}
		}
		const tmp = `${file}.tmp.${process.pid}`;
		try {
			await this.fs.mkdir(this.sessionDir(r.index.stSessionId), { recursive: true });
			await this.fs.writeFile(tmp, body);
			await this.fs.rename(tmp, file);
		} catch (err) {
			r.dirty = true;
			this.noteIndexWriteFailure(r, err);
			return;
		}
		this.consecutiveIndexWriteFailures = 0;
	}

	/** #546 — count a failed index write; escalate the log after N in a row. */
	private noteIndexWriteFailure(r: Resident, err: unknown): void {
		this.stats.indexWriteFailures++;
		const code = (err as NodeJS.ErrnoException | null)?.code;
		this.lastIndexWriteErrorCode = typeof code === "string" && code ? code : "UNKNOWN";
		const streak = ++this.consecutiveIndexWriteFailures;
		const msg = `[conversation] index write failed for ${r.index.cid}: ${(err as Error)?.message ?? String(err)}`;
		if (streak % INDEX_WRITE_ESCALATE_AFTER === 0) {
			logger.error(
				`${msg} (${streak} index writes failed in a row, last ${this.lastIndexWriteErrorCode}: the capture snapshots are not reaching ${this.opts.workspaceRoot})`,
			);
		} else logger.warn(msg);
	}

	/**
	 * #546 — keep an evicted entry whose snapshot write failed: it stays in
	 * `evicting` (so `open` adopts it and `peekIndex` answers from it) and its
	 * write is retried with backoff. At most `evictionKeepMax` are kept; past
	 * that the oldest is dropped, counted and logged as an error.
	 */
	private keepAfterFailedWrite(key: string, r: Resident): void {
		if (!this.kept.has(key)) {
			this.kept.set(key, r);
			this.stats.evictionWriteKept++;
		}
		r.retryAttempt++;
		const delay = Math.min(
			this.lim.evictionRetryBaseMs * 2 ** Math.min(r.retryAttempt - 1, 30),
			this.lim.evictionRetryMaxMs,
		);
		if (r.retryTimer) clearTimeout(r.retryTimer);
		r.retryTimer = setTimeout(() => {
			r.retryTimer = null;
			if (this.evicting.get(key) === r) void this.writeIndex(r);
		}, delay);
		r.retryTimer.unref?.();
		while (this.kept.size > this.lim.evictionKeepMax) {
			const [oldKey, old] = this.kept.entries().next().value as [string, Resident];
			this.forgetKept(oldKey, old);
			if (this.evicting.get(oldKey) === old) this.evicting.delete(oldKey);
			if (old.flushTimer) {
				clearTimeout(old.flushTimer);
				old.flushTimer = null;
			}
			this.stats.evictionWriteDropped++;
			logger.error(
				`[conversation] evicted index of ${old.index.cid} dropped after failed snapshot writes (more than ${this.lim.evictionKeepMax} kept): its in-memory state is lost; recovery rebuilds what the events file holds`,
			);
		}
	}

	/** #546 — the entry is no longer kept: drop its retry timer and its place in the bound. */
	private forgetKept(key: string, r: Resident): void {
		if (this.kept.get(key) === r) this.kept.delete(key);
		if (r.retryTimer) {
			clearTimeout(r.retryTimer);
			r.retryTimer = null;
		}
		r.retryAttempt = 0;
	}

	/** #546 — evicted entries currently kept after a failed snapshot write (admin stats). */
	keptCount(): number {
		return this.kept.size;
	}

	private async rotate(stSessionId: string, cid: string, r: Resident): Promise<void> {
		const file = this.eventsPath(stSessionId, cid);
		try {
			await this.fs.rm(`${file}.1`, { force: true });
			await this.fs.rename(file, `${file}.1`);
		} catch (err) {
			logger.warn(`[conversation] rotation failed for ${cid}: ${(err as Error).message}`);
			return;
		}
		this.stats.rotations++;
		r.currentFileBytes = 0;
		r.index.offset = 0;
		r.index.eventsCount = 0;
		r.index.eventsBytes = 0;
		r.index.gapsCount = 0;
		r.index.firstRetainedSeq = 0; // set by the next append (the gap below)
		const gap: PendingEvent = {
			ev: "gap",
			prompt_id: null,
			turn_id: null,
			agent_id: null,
			pane: null,
			data: { reason: "rotated", archived_up_to_seq: r.index.lastSeq },
		};
		await this.appendOne(stSessionId, cid, r, gap);
	}

	/**
	 * The snapshotless fallback of recoverFromFile:
	 *  - the `.1` archive's last activity;
	 *  - else, with the whole history on disk and no activity in it (the
	 *    oldest line left is seq 1), that line: the live index still held the
	 *    time it was opened;
	 *  - else, with the start of the history gone (an archive without activity
	 *    is a second rotation; a missing archive under a rotated file),
	 *    NO_ACTIVITY_TIME — the true time is not on disk;
	 *  - nothing on disk at all: the fresh index's load time stays — a new
	 *    conversation.
	 */
	private async lastEventAtFromArchive(
		file: string,
		index: ConversationIndex,
		oldestCurrent: { ts: string; seq: number } | null,
	): Promise<void> {
		const archived = await this.fs.readFile(`${file}.1`, "utf8").catch(() => "");
		const a = activityTimesIn(archived);
		if (a.lastActivity !== null) {
			index.lastEventAt = a.lastActivity;
			return;
		}
		const oldest = a.oldest ?? oldestCurrent;
		if (oldest === null) return;
		index.lastEventAt = oldest.seq === 1 ? oldest.ts : NO_ACTIVITY_TIME;
	}

	// ── Mutation of index metadata (service-driven) ────────────────────────

	/** Returns false when the conversation is not resident (evicted). */
	update(stSessionId: string, cid: string, mutate: (index: ConversationIndex) => void): boolean {
		const r = this.resident.get(`${stSessionId}/${cid}`);
		if (!r) return false;
		mutate(r.index);
		r.dirty = true;
		this.scheduleFlush(r);
		return true;
	}

	// ── Reads ──────────────────────────────────────────────────────────────

	/**
	 * Events with `seq > afterSeq`, ascending, at most `limit`. The current
	 * file only, unless `archive` also asks for the rotated `.1` generation
	 * (read first, it is older).
	 */
	async readEvents(
		stSessionId: string,
		cid: string,
		afterSeq: number,
		limit: number,
		opts: { archive?: boolean } = {},
	): Promise<PersistedEvent[]> {
		const file = this.eventsPath(stSessionId, cid);
		let content = "";
		if (opts.archive) {
			content = await this.fs.readFile(`${file}.1`, "utf8").catch(() => "");
			if (content && !content.endsWith("\n")) content += "\n";
		}
		try {
			content += await this.fs.readFile(file, "utf8");
		} catch {
			if (!content) return [];
		}
		const out: PersistedEvent[] = [];
		for (const line of content.split("\n")) {
			if (!line) continue;
			try {
				const ev = JSON.parse(line) as PersistedEvent;
				if (ev.seq > afterSeq) out.push(ev);
				if (out.length >= limit) break;
			} catch {
				/* torn line */
			}
		}
		return out;
	}

	// ── Eviction / close ───────────────────────────────────────────────────

	private async evictIfNeeded(): Promise<void> {
		while (this.resident.size > this.lim.residentIndexes) {
			// Oldest insertion = least recently opened.
			const oldestKey = this.resident.keys().next().value;
			if (oldestKey === undefined) return;
			const r = this.resident.get(oldestKey);
			if (!r) return;
			if (r.queue.length > 0 || r.busy) {
				// B2 — never evict a conversation with work in flight. `busy`
				// covers the append that was already shifted off the queue
				// (queue empty, I/O pending): evicting it would let a reopen
				// create a second writer with a stale `lastSeq`.
				this.resident.delete(oldestKey);
				this.resident.set(oldestKey, r);
				if (this.resident.size <= this.lim.residentIndexes) return;
				// All resident entries busy: stop rather than spin.
				let anyIdle = false;
				for (const x of this.resident.values()) {
					if (x.queue.length === 0 && !x.busy) anyIdle = true;
				}
				if (!anyIdle) return;
				continue;
			}
			this.resident.delete(oldestKey);
			this.evicting.set(oldestKey, r);
			this.stats.evictions++;
			// The entry leaves `evicting` when the LAST write of its key lands
			// (writeIndex's `done`), so an entry adopted and evicted again keeps
			// answering peekIndex/open until its newest snapshot is on disk.
			await this.writeIndex(r);
		}
	}

	/** Drop a conversation from memory after flushing (session stopped/purged). */
	async close(stSessionId: string, cid: string): Promise<void> {
		const key = `${stSessionId}/${cid}`;
		const r = this.resident.get(key);
		if (!r) return;
		await r.chain;
		await this.writeIndex(r);
		if (r.flushTimer) clearTimeout(r.flushTimer);
		this.resident.delete(key);
	}

	/**
	 * B4 — hard delete. Refuses new opens/appends for the session, waits
	 * for every in-flight append chain, drops the resident entries (and
	 * their timers) WITHOUT writing snapshots, then removes the whole
	 * `.conversations/<sid>` directory: events, indexes, `.1` rotations
	 * and revocation markers. Nothing can recreate the directory while
	 * `purging` holds the id, and no resident survives to do so after.
	 */
	async purgeSession(stSessionId: string): Promise<void> {
		const dir = this.sessionDir(stSessionId);
		this.purging.add(stSessionId);
		try {
			// A load that started before the purge registers only after
			// its awaits; `loadAndRegister` re-checks `purging`, and any
			// in-flight load's promise is awaited here so it has settled.
			for (const [key, load] of Array.from(this.opening)) {
				if (key.startsWith(`${stSessionId}/`)) await load.catch(() => undefined);
			}
			for (const [key, r] of Array.from(this.resident)) {
				if (!key.startsWith(`${stSessionId}/`)) continue;
				this.totalQueueBytes -= r.queueBytes;
				r.queue.length = 0;
				r.queueBytes = 0;
				await r.chain;
				if (r.flushTimer) clearTimeout(r.flushTimer);
				r.dirty = false;
				this.resident.delete(key);
			}
			// #546 — kept entries (failed eviction writes) of the session: their
			// retry timers must not fire after the rm.
			for (const [key, r] of Array.from(this.kept)) {
				if (key.startsWith(`${stSessionId}/`)) this.forgetKept(key, r);
			}
			// A write already running would recreate the directory after the
			// rm: wait for every write of this session to settle first (new ones
			// refuse, see writeIndexNow).
			// Until none is left: a write chained while we waited is awaited too
			// (and refuses to touch the disk, since `purging` holds the id).
			for (;;) {
				const w = [...this.indexWrites].find(([key]) => key.startsWith(`${stSessionId}/`));
				if (!w) break;
				await w[1].catch(() => undefined);
			}
			// Defensive: every evicting entry left with its last write above, so
			// this normally finds nothing; nothing of the session may stay
			// readable from memory (peekIndex/open) whatever the order was.
			for (const [key, r] of Array.from(this.evicting)) {
				if (!key.startsWith(`${stSessionId}/`)) continue;
				this.evicting.delete(key);
				this.forgetKept(key, r);
				if (r.flushTimer) {
					clearTimeout(r.flushTimer);
					r.flushTimer = null;
				}
				r.dirty = false;
			}
			await this.fs.rm(dir, { force: true, recursive: true });
		} finally {
			this.purging.delete(stSessionId);
		}
	}

	totalQueuedBytes(): number {
		return this.totalQueueBytes;
	}

	maxQueuedBytes(): number {
		return this.maxTotalQueueBytes;
	}

	/**
	 * Bytes of the regular files under `<WORKSPACE_ROOT>/.conversations`, two
	 * levels deep (`<sid>/<file>`), measured with `lstat`: a symlink is never
	 * followed out of the tree. A directory that vanishes mid-walk (a purge)
	 * just counts as gone. The caller bounds how often this runs.
	 */
	async diskBytes(): Promise<number> {
		const root = conversationsRoot(this.opts.workspaceRoot);
		let sessions: Dirent[];
		try {
			sessions = await nodeFs.readdir(root, { withFileTypes: true });
		} catch {
			return 0;
		}
		let total = 0;
		for (const d of sessions) {
			if (!d.isDirectory()) continue;
			const dir = path.join(root, d.name);
			let files: Dirent[];
			try {
				files = await nodeFs.readdir(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const f of files) {
				if (!f.isFile()) continue;
				try {
					total += (await nodeFs.lstat(path.join(dir, f.name))).size;
				} catch {
					// Rotated or purged meanwhile.
				}
			}
		}
		return total;
	}
}
