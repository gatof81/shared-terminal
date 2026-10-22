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

import { promises as nodeFs } from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
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
import { sessionConversationsDir } from "./revocation.js";
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
	lastPromptId: string | null;
	claudeVersion: string | null;
	parentSessionId: string | null;
	parentInferred: boolean;
	state: ConversationState;
	agents: Record<string, AgentSummary>;
	/** Per-message accumulated bytes for L2; bounded, oldest dropped. */
	messageBytes: Record<string, { bytes: number; truncated: boolean }>;
	/** Last `assistant_delta.index` per message, for `missing_delta` gaps. */
	messageIndex: Record<string, number>;
	/** Set once a `gap revoked` was written for this conversation (§2.5). */
	revokedNoted?: boolean;
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
	}>;
}

export type EventListener = (stSessionId: string, cid: string, event: PersistedEvent) => void;

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
}

const MESSAGE_TRACK_MAX = 64;
const AGENTS_MAX = 256;

// ── Store ───────────────────────────────────────────────────────────────────

export class ConversationStore {
	private readonly fs: StoreFs;
	private readonly now: () => number;
	private readonly resident = new Map<string, Resident>();
	private readonly listeners = new Set<EventListener>();
	private totalQueueBytes = 0;
	private readonly lim: Required<NonNullable<StoreOptions["limits"]>>;
	/** Counters for admin stats (3.0d exposes them). */
	readonly stats = { persisted: 0, dropped: 0, appendFailures: 0, rotations: 0, evictions: 0 };

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
			...opts.limits,
		};
	}

	// ── Paths ──────────────────────────────────────────────────────────────

	sessionDir(stSessionId: string): string {
		return sessionConversationsDir(this.opts.workspaceRoot, stSessionId);
	}
	eventsPath(stSessionId: string, cid: string): string {
		return path.join(this.sessionDir(stSessionId), `${cid}.events.jsonl`);
	}
	indexPath(stSessionId: string, cid: string): string {
		return path.join(this.sessionDir(stSessionId), `${cid}.index.json`);
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
		const existing = this.resident.get(key);
		if (existing) {
			// Refresh LRU order.
			this.resident.delete(key);
			this.resident.set(key, existing);
			return existing.index;
		}
		const index = await this.loadIndex(stSessionId, cid);
		const fileBytes = await this.recoverFromFile(stSessionId, cid, index);
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
		const resident = this.resident.get(`${stSessionId}/${cid}`);
		if (resident) return resident.index;
		try {
			const raw = await this.fs.readFile(this.indexPath(stSessionId, cid), "utf8");
			const parsed = JSON.parse(raw) as Partial<ConversationIndex>;
			return parsed && parsed.v === 1 && parsed.cid === cid ? (parsed as ConversationIndex) : null;
		} catch {
			return null;
		}
	}

	getResidentIndex(stSessionId: string, cid: string): ConversationIndex | undefined {
		return this.resident.get(`${stSessionId}/${cid}`)?.index;
	}

	residentCount(): number {
		return this.resident.size;
	}

	private async loadIndex(stSessionId: string, cid: string): Promise<ConversationIndex> {
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
			claudeVersion: null,
			parentSessionId: null,
			parentInferred: false,
			state: { ...INITIAL_STATE },
			agents: {},
			messageBytes: {},
			messageIndex: {},
		};
		try {
			const raw = await this.fs.readFile(this.indexPath(stSessionId, cid), "utf8");
			const parsed = JSON.parse(raw) as Partial<ConversationIndex>;
			if (parsed && parsed.v === 1 && parsed.cid === cid) {
				return {
					...fresh,
					...parsed,
					agents: parsed.agents ?? {},
					messageBytes: parsed.messageBytes ?? {},
					messageIndex: parsed.messageIndex ?? {},
				};
			}
		} catch {
			/* no index or unreadable: the file scan below rebuilds */
		}
		return fresh;
	}

	/** Scan the events file from `index.offset`; returns the file size. */
	private async recoverFromFile(
		stSessionId: string,
		cid: string,
		index: ConversationIndex,
	): Promise<number> {
		const file = this.eventsPath(stSessionId, cid);
		let content: string;
		try {
			content = await this.fs.readFile(file, "utf8");
		} catch {
			// No file: whatever the index claims about seq is unproven.
			// Keep lastSeq (a rotated-away file can be gone) but reset offset.
			index.offset = 0;
			return 0;
		}
		let size = Buffer.byteLength(content, "utf8");
		if (size > 0 && !content.endsWith("\n")) {
			// A torn last line (crash mid-append). Terminate it so the next
			// append starts a fresh line instead of gluing onto the fragment;
			// the fragment itself is skipped by the parse below.
			try {
				await this.fs.appendFile(file, "\n");
				content += "\n";
				size += 1;
			} catch {
				/* read-only or failing disk: the scan still works */
			}
		}
		if (index.offset > size) index.offset = 0; // truncated/rewritten file
		const tail =
			index.offset === 0
				? content
				: Buffer.from(content, "utf8").subarray(index.offset).toString("utf8");
		if (index.offset === 0) {
			index.eventsCount = 0;
			index.eventsBytes = 0;
			index.gapsCount = 0;
			index.lastSeq = Math.max(0, index.lastSeq);
			index.firstRetainedSeq = 0;
		}
		let scannedSeq = index.offset === 0 ? 0 : index.lastSeq;
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
			if (ev.ts) index.lastEventAt = ev.ts;
		}
		if (index.firstRetainedSeq === 0) index.firstRetainedSeq = index.lastSeq + 1;
		index.lastSeq = Math.max(index.lastSeq, scannedSeq);
		index.offset = size;
		return size;
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
	): "queued" | "dropped" | "not_open" {
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
		r.queue.push(pending);
		r.queueBytes += bytes;
		this.totalQueueBytes += bytes;
		r.chain = r.chain.then(() => this.drain(stSessionId, cid, r)).catch(() => undefined);
		return "queued";
	}

	private noteDrop(r: Resident, scope: "conversation" | "global" | "disk"): void {
		this.stats.dropped++;
		if (r.pendingDrop && r.pendingDrop.scope === scope) r.pendingDrop.count++;
		else r.pendingDrop = { count: 1, scope };
	}

	/** Wait for every queued event of a conversation to hit disk (tests, shutdown). */
	async flush(stSessionId: string, cid: string): Promise<void> {
		const r = this.resident.get(`${stSessionId}/${cid}`);
		if (!r) return;
		await r.chain;
		await this.writeIndex(r);
	}

	async flushAll(): Promise<void> {
		for (const r of this.resident.values()) {
			await r.chain;
			await this.writeIndex(r);
		}
	}

	private async drain(stSessionId: string, cid: string, r: Resident): Promise<void> {
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
		r.index.lastEventAt = event.ts;
		if (event.ev === "gap") r.index.gapsCount++;
		if (event.prompt_id) r.index.lastPromptId = event.prompt_id;
		if (r.index.firstRetainedSeq === 0) r.index.firstRetainedSeq = seq;
		r.currentFileBytes += lineBytes;
		r.dirty = true;
		r.eventsSinceFlush++;
		this.stats.persisted++;
		this.trackMessageAndAgents(r.index, event);
		for (const l of this.listeners) {
			try {
				l(stSessionId, cid, event);
			} catch {
				/* listener error never breaks persistence */
			}
		}
		if (r.currentFileBytes >= this.lim.fileBytes) await this.rotate(stSessionId, cid, r);
		if (r.eventsSinceFlush >= this.lim.flushEveryEvents) await this.writeIndex(r);
		else this.scheduleFlush(r);
		return event;
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
		} else if (event.ev === "assistant_delta") {
			const id = String(event.data.message_id ?? "");
			const keys = Object.keys(index.messageIndex);
			if (!(id in index.messageIndex) && keys.length >= MESSAGE_TRACK_MAX) {
				delete index.messageIndex[keys[0]];
				delete index.messageBytes[keys[0]];
			}
			index.messageIndex[id] = Number(event.data.index ?? 0);
		}
	}

	private scheduleFlush(r: Resident): void {
		if (r.flushTimer) return;
		r.flushTimer = setTimeout(() => {
			r.flushTimer = null;
			void this.writeIndex(r);
		}, this.lim.flushIntervalMs);
		r.flushTimer.unref?.();
	}

	private async writeIndex(r: Resident): Promise<void> {
		if (!r.dirty) return;
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
			r.index.messageBytes = {};
			r.index.messageIndex = {};
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
			logger.warn(
				`[conversation] index write failed for ${r.index.cid}: ${(err as Error).message}`,
			);
		}
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

	/** Events with `seq > afterSeq`, ascending, at most `limit`. Current file only. */
	async readEvents(
		stSessionId: string,
		cid: string,
		afterSeq: number,
		limit: number,
	): Promise<PersistedEvent[]> {
		let content: string;
		try {
			content = await this.fs.readFile(this.eventsPath(stSessionId, cid), "utf8");
		} catch {
			return [];
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
			if (r.queue.length > 0) {
				// Never evict a conversation with work in flight; try the next.
				this.resident.delete(oldestKey);
				this.resident.set(oldestKey, r);
				if (this.resident.size <= this.lim.residentIndexes) return;
				// All resident entries busy: stop rather than spin.
				let anyIdle = false;
				for (const x of this.resident.values()) if (x.queue.length === 0) anyIdle = true;
				if (!anyIdle) return;
				continue;
			}
			this.resident.delete(oldestKey);
			this.stats.evictions++;
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

	/** Forget everything about a session (after a hard-delete purge). */
	forgetSession(stSessionId: string): void {
		for (const key of Array.from(this.resident.keys())) {
			if (key.startsWith(`${stSessionId}/`)) {
				const r = this.resident.get(key);
				if (r?.flushTimer) clearTimeout(r.flushTimer);
				this.totalQueueBytes -= r?.queueBytes ?? 0;
				this.resident.delete(key);
			}
		}
	}

	totalQueuedBytes(): number {
		return this.totalQueueBytes;
	}
}
