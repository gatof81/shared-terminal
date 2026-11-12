/**
 * teamLog.ts — loads a project's conversation log for the v3 workspace
 * (PROJECT_CONVERSATION.md §5) and keeps it folded in a teamModel
 * ProjectLog. Reads only; sending lives in teamView.
 *
 *  - The newest page is re-read on every refresh (the caller polls while
 *    the page is on screen). Events fold by seq, so overlap is harmless.
 *  - A gap between what is loaded and the newest page (the tab slept) is
 *    filled backward, a bounded number of pages per refresh; what is left
 *    is reported as `gap` and the UI offers to load it — a thread that
 *    started inside the gap is never silently missing without a sign.
 *  - "Earlier threads" pages backward from the oldest loaded seq.
 *  - A message referenced by a loaded event but older than the window (a
 *    late reply, a follow-up to an old task) is fetched by id and folded,
 *    so it lands in its own thread — never guessed into another one.
 *  - A reply's text is read from the agent's capture (the log keeps only a
 *    reference, §4.1) and shown only if it hashes to the log's
 *    `report_sha256`.
 *
 * Every answer is dropped when the store was reset (logout) after the
 * request left — api.ts `projectRequest` already drops answers for an
 * earlier account; the generation covers the store's own lifetime.
 */

import {
	fetchProjectEvents,
	fetchProjectMessage,
	openProjectSocket,
	type ProjectMessageDetail,
	type ProjectSocket,
	readConversationEvent,
} from "./api.js";
import {
	hex,
	type LogEvent,
	type LogReplyRef,
	ProjectLog,
	parseLogEvent,
	type ReplyTextState,
} from "./teamModel.js";

/** What locates a reply's text in a capture: a reply_ref, or a reply_settling (same fields). */
export type ReplyPointer = Pick<
	LogReplyRef,
	"sid" | "cid" | "turnEndSeq" | "reportSha256" | "truncated"
>;

export const PAGE_LIMIT = 200;
/** Backward pages a single refresh may read to close a gap. */
export const GAP_FILL_PAGES = 5;
/** Missing originals fetched by id per pass (each is one request). */
export const MISSING_PER_PASS = 8;

/** The by-id answer flattened back to log lines, so one fold reads both. */
export function detailLines(d: ProjectMessageDetail): unknown[] {
	const out: unknown[] = [d.message];
	for (const del of d.deliveries) if (Array.isArray(del.events)) out.push(...del.events);
	for (const r of d.replies) {
		if (r.settling) out.push(r.settling);
		if (r.ref) out.push(r.ref);
		if (Array.isArray(r.lateCloses)) out.push(...r.lateCloses);
	}
	out.push(...d.acks);
	return out;
}

function parseAll(raw: unknown[]): LogEvent[] {
	const out: LogEvent[] = [];
	for (const r of raw) {
		const e = parseLogEvent(r);
		if (e) out.push(e);
	}
	return out;
}

export interface LoadError {
	status: number;
	code: string;
}

export class ProjectLogStore {
	log = new ProjectLog();
	/** Older events exist before the oldest loaded one. */
	hasOlder = false;
	/** True once the newest page answered at least once. */
	loaded = false;
	/** Events between the loaded window and the newest page are not loaded yet. */
	gapBefore: number | null = null;
	/**
	 * Where "Earlier threads" continues: the server's `oldestSeq` of the
	 * oldest page read (the last line it examined — with unknown kinds
	 * skipped by the parser, the oldest PARSED event can be newer).
	 */
	private olderCursor: number | null = null;
	/** The newest seq loaded before the gap opened (what the gap ends at). */
	private gapFloor: number | null = null;
	error: LoadError | null = null;
	/** Message ids that a by-id read answered 404 for (outside the person's reach). */
	readonly unreachable = new Set<string>();

	private refreshing: Promise<void> | null = null;
	private loadingOlder: Promise<void> | null = null;
	private fetchingIds = new Set<string>();
	private gen = 0;
	private listeners = new Set<() => void>();
	private replyTexts = new Map<string, ReplyTextState>();

	constructor(readonly projectId: string) {}

	// ── Live (WS /ws/project/<pid>) ─────────────────────────────────────────
	//
	// After the first page is read, new events arrive over the socket the
	// moment they are persisted — a reply shows within the settle window
	// instead of up to one poll later. The poll stays as the safety net
	// (slower while live); a refused socket (1008) or a dropped one falls
	// back to it. The socket only ADDS events through the same fold, so
	// it can never disagree with a page.

	private socket: ProjectSocket | null = null;
	/** True while the socket is open and following. */
	live = false;

	/** Follow the log live (idempotent). Starts after the first page, never before. */
	startLive(): void {
		if (this.socket || !this.loaded) return;
		const gen = this.gen;
		this.socket = openProjectSocket(
			this.projectId,
			(f) => {
				if (gen !== this.gen) return;
				if (f.type === "event") {
					const e = parseLogEvent(f.event);
					if (e && this.log.add([e]) > 0) {
						this.changed();
						void this.resolveMissing();
					}
				} else {
					// The server stopped sending (backpressure): read the gap by
					// GET, then follow again from what the log now holds.
					void this.refresh().then(() => {
						if (gen === this.gen) this.socket?.follow(Math.max(this.log.newestSeq, 0));
					});
				}
			},
			(connected) => {
				if (gen !== this.gen) return;
				const was = this.live;
				this.live = connected;
				// On (re)connect, catch up by GET first (a reconnect may have missed
				// a resync), then follow from the newest seq the log holds.
				if (connected)
					void this.refresh().then(() => {
						if (gen === this.gen) this.socket?.follow(Math.max(this.log.newestSeq, 0));
					});
				if (was !== connected) this.changed();
			},
		);
	}

	stopLive(): void {
		this.socket?.close();
		this.socket = null;
		if (this.live) {
			this.live = false;
			this.changed();
		}
	}

	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private changed(): void {
		for (const fn of this.listeners) fn();
	}

	/** Forget everything (logout). In-flight answers are dropped. */
	reset(): void {
		this.socket?.close();
		this.socket = null;
		this.live = false;
		this.gen++;
		this.log = new ProjectLog();
		this.hasOlder = false;
		this.loaded = false;
		this.gapBefore = null;
		this.gapFloor = null;
		this.olderCursor = null;
		this.error = null;
		this.unreachable.clear();
		this.refreshing = null;
		this.loadingOlder = null;
		this.fetchingIds.clear();
		this.replyTexts.clear();
		this.changed();
	}

	/** Re-read the newest page (one request in flight at a time). */
	refresh(): Promise<void> {
		this.refreshing ??= this.doRefresh().finally(() => {
			this.refreshing = null;
		});
		return this.refreshing;
	}

	/**
	 * A read that STARTS after a write the caller just made (a send, an
	 * ack): a refresh already in flight left before it and may not show it.
	 */
	async refreshAfterWrite(): Promise<void> {
		if (this.refreshing) await this.refreshing;
		await this.refresh();
	}

	private async doRefresh(): Promise<void> {
		const gen = this.gen;
		const knownNewest = this.log.newestSeq;
		const a = await fetchProjectEvents(this.projectId, { limit: PAGE_LIMIT });
		if (gen !== this.gen || (!a.ok && a.code === "stale")) return;
		if (!a.ok) {
			const was = this.error;
			this.error = { status: a.status, code: a.code };
			if (!was || was.status !== a.status || was.code !== a.code) this.changed();
			return;
		}
		const hadError = this.error !== null;
		this.error = null;
		const events = parseAll(a.body.events);
		const firstLoad = !this.loaded;
		let folded = this.log.add(events);
		this.loaded = true;
		if (firstLoad) this.olderCursor = a.body.oldestSeq ?? minSeq(events);
		const pageOldest = a.body.oldestSeq ?? minSeq(events);
		if (firstLoad) {
			this.hasOlder = a.body.hasMore;
		} else if (pageOldest !== null && pageOldest > knownNewest + 1 && a.body.hasMore) {
			// Something happened between what we had and this page. A gap still
			// open from before merges with this one (its floor is lower): the
			// overlap re-reads events already folded, which changes nothing.
			const floor = this.gapFloor === null ? knownNewest : Math.min(this.gapFloor, knownNewest);
			folded += await this.fillGap(gen, floor, pageOldest);
			if (gen !== this.gen) return;
		}
		// A poll that brought nothing new re-renders nothing: a re-render
		// would drop the person's text selection and keyboard place.
		if (folded > 0 || firstLoad || hadError) this.changed();
		void this.resolveMissing();
	}

	/**
	 * Read backward from `before` until the window meets `floor`. The gap
	 * is recorded BEFORE the first request and cleared only when it closes,
	 * so a failed read leaves it visible ("Some recent activity isn't
	 * loaded yet") instead of silently losing it. Returns events folded.
	 */
	private async fillGap(gen: number, floor: number, before: number): Promise<number> {
		this.gapBefore = before;
		this.gapFloor = floor;
		let folded = 0;
		for (let i = 0; i < GAP_FILL_PAGES; i++) {
			const a = await fetchProjectEvents(this.projectId, { before, limit: PAGE_LIMIT });
			if (gen !== this.gen || !a.ok) return folded;
			const events = parseAll(a.body.events);
			folded += this.log.add(events);
			const oldest = a.body.oldestSeq ?? minSeq(events);
			if (oldest === null || oldest <= floor + 1 || !a.body.hasMore) {
				this.gapBefore = null;
				this.gapFloor = null;
				return folded;
			}
			before = oldest;
			this.gapBefore = before;
		}
		return folded;
	}

	/** Continue filling a gap the last refresh left open. */
	async loadGap(): Promise<void> {
		if (this.gapBefore === null || this.gapFloor === null) return;
		const gen = this.gen;
		await this.fillGap(gen, this.gapFloor, this.gapBefore);
		if (gen === this.gen) {
			this.changed();
			void this.resolveMissing();
		}
	}

	/** "Earlier threads": one more page backward. */
	loadOlder(): Promise<void> {
		if (!this.hasOlder) return Promise.resolve();
		this.loadingOlder ??= this.doLoadOlder().finally(() => {
			this.loadingOlder = null;
		});
		return this.loadingOlder;
	}

	get busyOlder(): boolean {
		return this.loadingOlder !== null;
	}

	private async doLoadOlder(): Promise<void> {
		const gen = this.gen;
		const before = this.olderCursor ?? this.log.oldestSeq;
		if (!Number.isFinite(before)) return;
		const a = await fetchProjectEvents(this.projectId, { before, limit: PAGE_LIMIT });
		if (gen !== this.gen || !a.ok) return;
		const events = parseAll(a.body.events);
		this.log.add(events);
		this.olderCursor = a.body.oldestSeq ?? minSeq(events) ?? before;
		this.hasOlder = a.body.hasMore;
		this.changed();
		void this.resolveMissing();
	}

	/**
	 * Fetch by id the originals that loaded events point at but the window
	 * doesn't hold. Bounded per pass; a 404 is remembered (not retried).
	 */
	resolveMissing(): Promise<void> {
		return this.resolveMissingIds(this.log.missingMessages());
	}

	/** Fetch these messages by id (those not loaded, not in flight, not known 404). */
	async resolveMissingIds(wanted: readonly string[]): Promise<void> {
		const gen = this.gen;
		const ids = wanted
			.filter((id) => !this.log.has(id) && !this.fetchingIds.has(id) && !this.unreachable.has(id))
			.slice(0, MISSING_PER_PASS);
		if (ids.length === 0) return;
		for (const id of ids) this.fetchingIds.add(id);
		const answers = await Promise.all(ids.map((id) => fetchProjectMessage(this.projectId, id)));
		if (gen !== this.gen) return;
		let added = false;
		answers.forEach((a, i) => {
			const id = ids[i]!;
			this.fetchingIds.delete(id);
			if (a.ok) {
				this.log.addFetched(parseAll(detailLines(a.body)));
				added = true;
			} else if (a.status === 404) {
				this.unreachable.add(id);
			}
		});
		this.changed();
		// A fetched message may itself answer an older one.
		if (added) void this.resolveMissing();
	}

	// ── Reply text ──────────────────────────────────────────────────────────

	/** The verified text of a reply; starts the read on first ask. */
	replyText(ref: ReplyPointer): ReplyTextState {
		if (ref.turnEndSeq === null || ref.reportSha256 === null) return { kind: "gone" };
		const key = `${ref.sid}\n${ref.cid}\n${ref.turnEndSeq}`;
		const known = this.replyTexts.get(key);
		if (known) return known;
		this.replyTexts.set(key, { kind: "loading" });
		void this.readReply(key, ref);
		return { kind: "loading" };
	}

	private async readReply(key: string, ref: ReplyPointer): Promise<void> {
		const gen = this.gen;
		let state: ReplyTextState;
		const a = await readConversationEvent(ref.sid, ref.cid, ref.turnEndSeq as number);
		if (!a.ok) {
			// 404: the capture rotated (L7) or the conversation is gone — the
			// reference outlives the text, by design (§4.1).
			state =
				a.status === 404
					? { kind: "gone" }
					: {
							kind: "error",
							message: a.status === 0 ? "No answer from the server" : `Error ${a.status}`,
						};
		} else {
			const d = a.event.data ?? {};
			const text = typeof d.last_assistant_message === "string" ? d.last_assistant_message : null;
			if (a.event.ev !== "turn_end" || text === null) state = { kind: "gone" };
			else {
				const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
				state =
					hex(digest) === ref.reportSha256?.toLowerCase()
						? { kind: "ok", text, truncated: d.truncated === true || ref.truncated }
						: { kind: "mismatch" };
			}
		}
		if (gen !== this.gen) return;
		this.replyTexts.set(key, state);
		this.changed();
	}

	/** Forget a failed read so the next render asks again. */
	retryReply(ref: ReplyPointer): void {
		if (ref.turnEndSeq === null) return;
		this.replyTexts.delete(`${ref.sid}\n${ref.cid}\n${ref.turnEndSeq}`);
		this.changed();
	}
}

function minSeq(events: readonly LogEvent[]): number | null {
	let m: number | null = null;
	for (const e of events) if (m === null || e.seq < m) m = e.seq;
	return m;
}

// ── Stores per project ──────────────────────────────────────────────────────

const stores = new Map<string, ProjectLogStore>();

export function logStore(projectId: string): ProjectLogStore {
	let s = stores.get(projectId);
	if (!s) {
		s = new ProjectLogStore(projectId);
		stores.set(projectId, s);
	}
	return s;
}

/** Logout: every project's log is forgotten. */
export function resetLogStores(): void {
	for (const s of stores.values()) s.reset();
	stores.clear();
}
