/**
 * chatView.ts — the Chat overlay (Phase 3.1, docs/CONVERSATION.md §6 and
 * design §6): the session's captured Claude conversations, read-only.
 *
 * Desktop: conversation list on the left, the thread in the middle, an
 * Agents panel on the right when opened. Mobile: one pane at a time
 * (list → thread, "‹" back), the Agents panel as a bottom sheet, the view
 * nav at the bottom (viewSwitch.ts). Same overlay mechanics as Files and
 * Git, so switching here never touches the terminal.
 *
 * Data: `GET …/conversations` for the list (polled with `capture=0`, which
 * costs the server no relay probe); for each opened conversation the newest
 * page of `GET …/events`, older pages on demand, and the conversation WS
 * from the newest seq on (live, reconnect and resync handled in api.ts).
 *
 * Context survives switching: the last few opened conversations keep
 * their event window, DOM and scroll position (`threads`), so going A → B →
 * A is instant and lands where the reader was; the socket re-follows from
 * the cached seq and the server replays only what was missed.
 *
 * Reading is never interrupted: live events scroll the thread only while
 * the reader is at the bottom; otherwise a "↓ N new" pill appears.
 *
 * Everything is built with textContent / renderMarkdown — no innerHTML.
 * Sending messages is 3.2: the composer is shown disabled with the reason.
 */

import {
	type ConversationCapture,
	type ConversationServerFrame,
	type ConversationSocket,
	type ConversationSummary,
	fetchConversationEvents,
	fetchConversations,
	openConversationSocket,
} from "./api.js";
import {
	type AgentView,
	buildThread,
	clock,
	EventWindow,
	groupBlocks,
	STALE_EVIDENCE_MS,
	STATUS_LABEL,
	statusIsLiveClaim,
	statusTone,
	type ThreadBlock,
	type ThreadItem,
	type ToolItem,
	toolLine,
	toolsSummary,
} from "./conversationModel.js";
import { formatBytes, relativeDate } from "./format.js";
import { activeSessionId, isMobile, sessions, showCopySuccessToast, showToast } from "./main.js";
import { renderMarkdown } from "./markdown.js";
import { button, el, stateBox } from "./ui.js";
import { getView, onSessionSync, onViewChange, setView } from "./viewSwitch.js";

// ── DOM ─────────────────────────────────────────────────────────────────────

const summaryEl = document.getElementById("chat-summary")!;
const refreshBtn = document.getElementById("chat-refresh-btn") as HTMLButtonElement;
const backBtn = document.getElementById("chat-back-btn") as HTMLButtonElement;
const bodyEl = document.getElementById("chat-body")!;
const listEl = document.getElementById("chat-list")!;
const threadEl = document.getElementById("chat-thread")!;
const agentsEl = document.getElementById("chat-agents") ?? bodyEl.appendChild(el("aside"));
const announcer = document.getElementById("chat-announcer");

// ── State ───────────────────────────────────────────────────────────────────

type ListState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "loaded"; capture: ConversationCapture | null; conversations: ConversationSummary[] }
	| { status: "error"; message: string };

interface LiveStatus {
	status: string;
	evidence: string;
	at: string;
}

/** One opened conversation: its window, DOM and reading position. */
interface ThreadCache {
	cid: string;
	window: EventWindow;
	/** Keyed DOM of thread blocks: rebuilt only when a block's signature changes. */
	nodes: Map<string, { sig: string; node: HTMLElement }>;
	scrollTop: number;
	atBottom: boolean;
	liveStatus: LiveStatus | null;
	loadedAt: number;
	/** Live blocks that arrived below the reader's position (the "↓ N new" pill). */
	pendingBelow: number;
	/**
	 * Newest seq in the window at the last render. A block is "new below the
	 * reader" only past it: an older page prepends hundreds of blocks the
	 * reader has not seen either, but those are above, not below.
	 */
	renderedLastSeq: number;
}

/**
 * The reader's place while an older page lands: the first block in view
 * (by the seq its block starts at, not its DOM key — a run of tools split by
 * the page boundary is re-keyed by the older first tool) and where its top
 * edge sat relative to the scroller's.
 */
interface ReadAnchor {
	seq: number;
	offset: number;
}

/** Conversations kept warm for instant switching (LRU). */
export const THREAD_CACHE_MAX = 4;
/** A cached window older than this is re-fetched instead of replayed over the socket. */
const THREAD_CACHE_FRESH_MS = 5 * 60 * 1000;
const LIST_POLL_MS = 15_000;
const PAGE = 200;

let stateSessionId: string | null = null;
/** Bumped on session change: drops every result of the previous session. */
let generation = 0;
/** Bumped on each conversation open: drops results for a previous thread. */
let threadGen = 0;
let list: ListState = { status: "idle" };
let selectedCid: string | null = null;
let threadStatus: "idle" | "loading" | "loaded" | "error" = "idle";
let threadError = "";
/**
 * The thread (`threadGen`) whose "Load earlier" request is in flight, if
 * any. Keyed by thread, not a plain flag: a request still pending for A
 * must neither block B's pagination nor be cleared by B.
 */
let loadingOlderGen: number | null = null;
const loadingOlder = () => loadingOlderGen !== null && loadingOlderGen === threadGen;
const threads = new Map<string, ThreadCache>();
let cur: ThreadCache | null = null;
let socket: ConversationSocket | null = null;
let liveConnected = false;
/** The socket was connected at least once this session view: a drop is worth a banner. */
let everConnected = false;
let mobilePane: "list" | "thread" = "list";
let agentsOpen = false;
let listTimer: ReturnType<typeof setInterval> | null = null;
let renderQueued = false;
/** Highest seq the reader has seen per conversation (the unread dot). */
const seen = new Map<string, number>();
let seenBaselined = false;

// ── View switching ──────────────────────────────────────────────────────────

function isActive(): boolean {
	return getView() === "chat";
}

onViewChange((next, prev) => {
	if (next === "chat") {
		if (stateSessionId !== null && list.status === "idle") void loadList();
		if (selectedCid !== null) openSocket();
		startListPoll();
		renderAll();
	} else if (prev === "chat") {
		closeSocket();
		stopListPoll();
	}
});

onSessionSync(() => {
	const s = sessions.find((x) => x.sessionId === activeSessionId);
	const sid = s?.sessionId ?? null;
	if (sid === stateSessionId) return;
	resetState(sid);
	if (sid !== null && isActive()) {
		void loadList();
		renderAll();
	}
});

function resetState(sessionId: string | null): void {
	generation++;
	threadGen++;
	closeSocket();
	stateSessionId = sessionId;
	list = { status: "idle" };
	selectedCid = null;
	threadStatus = "idle";
	threadError = "";
	loadingOlderGen = null;
	threads.clear();
	cur = null;
	everConnected = false;
	mobilePane = "list";
	agentsOpen = false;
	seen.clear();
	seenBaselined = false;
	loadSeen();
}

refreshBtn.addEventListener("click", () => {
	void loadList();
	if (selectedCid !== null) void openConversation(selectedCid, { fresh: true });
});
backBtn.addEventListener("click", showList);

function showList(): void {
	mobilePane = "list";
	agentsOpen = false;
	renderAll();
	// Hand the focus to the row we came from, so the keyboard reader lands back where they were.
	listEl.querySelector<HTMLElement>(".chat-conv-row.selected")?.focus();
}

function startListPoll(): void {
	stopListPoll();
	// The summaries alone (`capture=0`): no relay probe on the container,
	// so the list can stay fresh while this view is on screen.
	listTimer = setInterval(() => {
		if (!isActive() || document.hidden) return;
		void loadList({ quiet: true });
	}, LIST_POLL_MS);
}
function stopListPoll(): void {
	if (listTimer) clearInterval(listTimer);
	listTimer = null;
}

// ── Seen / unread ───────────────────────────────────────────────────────────

function seenKey(): string | null {
	return stateSessionId ? `st.chat.seen.${stateSessionId}` : null;
}
function loadSeen(): void {
	const key = seenKey();
	if (!key) return;
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return;
		const obj = JSON.parse(raw) as Record<string, unknown>;
		for (const [cid, v] of Object.entries(obj)) if (typeof v === "number") seen.set(cid, v);
		seenBaselined = true;
	} catch {
		/* per-viewer convenience only */
	}
}
function saveSeen(): void {
	const key = seenKey();
	if (!key) return;
	try {
		localStorage.setItem(key, JSON.stringify(Object.fromEntries(seen)));
	} catch {
		/* storage unavailable: the dots just reset on reload */
	}
}
function markSeen(cid: string, seq: number): void {
	if ((seen.get(cid) ?? -1) >= seq) return;
	seen.set(cid, seq);
	saveSeen();
}
function isUnread(c: ConversationSummary): boolean {
	const s = seen.get(c.sessionId);
	if (s === undefined) return seenBaselined && c.eventsCount > 0;
	return c.lastSeq > s;
}

// ── Data ────────────────────────────────────────────────────────────────────

async function loadList(opts: { quiet?: boolean } = {}): Promise<void> {
	const sid = stateSessionId;
	if (sid === null) return;
	const gen = generation;
	const quiet = opts.quiet === true && list.status === "loaded";
	if (!quiet) {
		list = { status: "loading" };
		renderAll();
	}
	refreshBtn.classList.add("spinning");
	try {
		const data = await fetchConversations(sid, { capture: !quiet });
		if (gen !== generation) return;
		const capture = data.capture ?? (list.status === "loaded" ? list.capture : null);
		list = { status: "loaded", capture, conversations: data.conversations };
		if (!seenBaselined) {
			// First sight of this session's list: nothing is "new" yet.
			for (const c of data.conversations)
				if (!seen.has(c.sessionId)) seen.set(c.sessionId, c.lastSeq);
			seenBaselined = true;
			saveSeen();
		}
	} catch (err) {
		if (gen !== generation) return;
		if (!quiet) list = { status: "error", message: (err as Error).message };
	} finally {
		if (gen === generation) refreshBtn.classList.remove("spinning");
	}
	renderAll();
}

/** Open a conversation: from the cache when it is fresh, else the newest page. */
async function openConversation(cid: string, opts: { fresh?: boolean } = {}): Promise<void> {
	const sid = stateSessionId;
	if (sid === null) return;
	const gen = ++threadGen;
	const switching = selectedCid !== cid;
	if (cur && switching) rememberScroll();
	selectedCid = cid;
	threadError = "";
	mobilePane = "thread";
	if (isMobile()) agentsOpen = false;
	const cached = threads.get(cid);
	if (cached && !opts.fresh && Date.now() - cached.loadedAt < THREAD_CACHE_FRESH_MS) {
		// Warm: show it now, re-follow from its seq (the server replays only
		// what landed meanwhile), and land where the reader left off.
		touchCache(cached);
		cur = cached;
		threadStatus = "loaded";
		renderAll({ restoreScroll: true });
		openSocket();
		return;
	}
	threads.delete(cid);
	cur = null;
	threadStatus = "loading";
	renderAll();
	try {
		const page = await fetchConversationEvents(sid, cid, { limit: PAGE });
		if (gen !== threadGen) return;
		const t: ThreadCache = {
			cid,
			window: new EventWindow(),
			nodes: new Map(),
			scrollTop: 0,
			atBottom: true,
			liveStatus: null,
			loadedAt: Date.now(),
			pendingBelow: 0,
			renderedLastSeq: 0,
		};
		t.window.setLatest(page.events, page.hasMore);
		touchCache(t);
		cur = t;
		threadStatus = "loaded";
		openSocket();
		renderAll({ scrollToEnd: true });
	} catch (err) {
		if (gen !== threadGen) return;
		threadStatus = "error";
		threadError = (err as Error).message;
		renderAll();
	}
}

function touchCache(t: ThreadCache): void {
	threads.delete(t.cid);
	threads.set(t.cid, t);
	while (threads.size > THREAD_CACHE_MAX) {
		const oldest = threads.keys().next().value;
		if (oldest === undefined || oldest === selectedCid) break;
		threads.delete(oldest);
	}
}

function rememberScroll(): void {
	const sc = threadScroller();
	if (!cur || !sc) return;
	cur.scrollTop = sc.scrollTop;
	cur.atBottom = nearBottom(sc);
}

async function loadOlder(): Promise<void> {
	const sid = stateSessionId;
	const cid = selectedCid;
	const t = cur;
	const first = t?.window.firstSeq() ?? null;
	if (sid === null || cid === null || !t || first === null || loadingOlder()) return;
	const gen = threadGen;
	loadingOlderGen = gen;
	// Keep the reader's place by the block they are looking at, not by the
	// distance to the bottom: L8 may drop the newest events of the window
	// when the page lands, and anything measured from the bottom would then
	// move the reader by exactly the dropped height (C6).
	const sc = threadScroller();
	const anchor = sc ? captureAnchor(sc) : null;
	renderAll();
	try {
		const page = await fetchConversationEvents(sid, cid, { before: first, limit: PAGE });
		if (gen !== threadGen) return;
		t.window.prepend(page.events, page.hasMore);
	} catch (err) {
		if (gen === threadGen)
			showToast(`Could not load earlier events: ${(err as Error).message}`, true);
	} finally {
		if (loadingOlderGen === gen) loadingOlderGen = null;
	}
	if (gen !== threadGen) return;
	renderAll();
	const after = threadScroller();
	if (after) restoreAnchor(after, t, anchor);
}

/** The first block at least partly in view, and where its top edge sits. */
function captureAnchor(sc: HTMLElement): ReadAnchor | null {
	const top = sc.getBoundingClientRect().top;
	for (const child of sc.children) {
		const seq = Number((child as HTMLElement).dataset.seq);
		if (!Number.isFinite(seq) || seq <= 0) continue; // the Load-earlier button, markers
		const r = child.getBoundingClientRect();
		if (r.bottom > top) return { seq, offset: r.top - top };
	}
	return null;
}

/**
 * Put the anchored block back where it was. Blocks are contiguous and in seq
 * order, so the block holding `anchor.seq` is the last one starting at or
 * before it. When no block holds it — the window dropped its newest end past
 * the anchor (L8) — the closest surviving context is the end of the window,
 * so the reader lands there; the pill then says how many newer events exist.
 */
function restoreAnchor(sc: HTMLElement, t: ThreadCache, anchor: ReadAnchor | null): void {
	if (!anchor) return;
	const last = t.window.events[t.window.events.length - 1]?.seq ?? 0;
	if (anchor.seq > last) {
		setScrollNow(sc, sc.scrollHeight);
		t.atBottom = nearBottom(sc);
		return;
	}
	let node: HTMLElement | null = null;
	for (const child of sc.children) {
		const seq = Number((child as HTMLElement).dataset.seq);
		if (!Number.isFinite(seq) || seq <= 0) continue;
		if (seq > anchor.seq) break;
		node = child as HTMLElement;
	}
	if (!node) return;
	const now = node.getBoundingClientRect().top - sc.getBoundingClientRect().top;
	setScrollNow(sc, sc.scrollTop + (now - anchor.offset));
	t.scrollTop = sc.scrollTop;
	t.atBottom = nearBottom(sc);
}

/** A position restore must land at once: `scroll-behavior: smooth` would animate it. */
function setScrollNow(sc: HTMLElement, top: number): void {
	const prev = sc.style.scrollBehavior;
	sc.style.scrollBehavior = "auto";
	sc.scrollTop = top;
	sc.style.scrollBehavior = prev;
}

function jumpToLatest(): void {
	if (selectedCid !== null) void openConversation(selectedCid, { fresh: true });
}

function openSocket(): void {
	const sid = stateSessionId;
	const cid = selectedCid;
	if (sid === null || cid === null || threadStatus !== "loaded" || !cur || !isActive()) return;
	if (!socket) {
		// One socket per session view; `follow` retargets it per thread, and
		// onFrame filters by the selected conversation.
		const gen = generation;
		socket = openConversationSocket(
			sid,
			(f) => {
				if (gen === generation) onFrame(f);
			},
			(connected) => {
				if (gen !== generation) return;
				liveConnected = connected;
				if (connected) everConnected = true;
				renderSummary();
				renderThreadHead();
			},
		);
	}
	socket.follow(cid, cur.window.lastSeq);
}

function closeSocket(): void {
	socket?.close();
	socket = null;
	liveConnected = false;
}

function onFrame(f: ConversationServerFrame): void {
	if (f.type === "hello") {
		// Free refresh of the list rows on every (re)connect: no request.
		if (list.status === "loaded") {
			const byCid = new Map(f.conversations.map((c) => [c.cid, c]));
			for (const c of list.conversations) {
				const h = byCid.get(c.sessionId);
				if (!h) continue;
				c.lastSeq = Math.max(c.lastSeq, h.lastSeq);
				c.status = h.status;
			}
			renderList();
		}
		return;
	}
	if (!("conv" in f) || f.conv !== selectedCid || !cur) return;
	if (f.type === "event") {
		const changed = cur.window.append(f.event);
		bumpRow(f.conv, f.event.seq);
		if (changed || !cur.window.atLatest) scheduleRender();
	} else if (f.type === "status") {
		cur.liveStatus = { status: f.status, evidence: f.evidence, at: f.at };
		const row = rowOf(f.conv);
		if (row) {
			row.status = f.status;
			row.statusEvidence = f.evidence;
			row.statusAt = f.at;
		}
		renderSummary();
		renderThreadHead();
		renderList();
	} else if (f.type === "gap") {
		// Our cursor fell behind the retained history: start from the newest.
		jumpToLatest();
	} else if (f.type === "error" && f.code === "not-found") {
		closeSocket();
	}
}

function rowOf(cid: string): ConversationSummary | undefined {
	return list.status === "loaded" ? list.conversations.find((c) => c.sessionId === cid) : undefined;
}
function bumpRow(cid: string, seq: number): void {
	const row = rowOf(cid);
	if (!row) return;
	if (seq > row.lastSeq) {
		row.lastSeq = seq;
		row.eventsCount++;
		row.lastEventAt = new Date().toISOString();
	}
}

// ── Rendering ───────────────────────────────────────────────────────────────

function scheduleRender(): void {
	if (renderQueued) return;
	renderQueued = true;
	requestAnimationFrame(() => {
		renderQueued = false;
		renderThread({ stick: true });
		renderList();
	});
}

function renderAll(opts: { scrollToEnd?: boolean; restoreScroll?: boolean } = {}): void {
	if (!isActive()) return;
	const inThread = mobilePane === "thread" && selectedCid !== null;
	bodyEl.classList.toggle("show-thread", inThread);
	bodyEl.classList.toggle("show-agents", agentsOpen && selectedCid !== null);
	backBtn.hidden = !(isMobile() && inThread);
	renderSummary();
	renderList();
	renderThread({ stick: opts.scrollToEnd === true, restore: opts.restoreScroll === true });
	renderAgents();
}

function selected(): ConversationSummary | undefined {
	return selectedCid ? rowOf(selectedCid) : undefined;
}

function titleOf(c: ConversationSummary): string {
	return c.title?.trim() || (c.kind === "headless" ? "Headless run" : "Untitled conversation");
}

function currentStatus(c: ConversationSummary): LiveStatus {
	return cur?.liveStatus ?? { status: c.status, evidence: c.statusEvidence, at: c.statusAt };
}

/**
 * The status chip: a dot in the status colour, the label and — when the
 * evidence is older than a minute — its age, so "Working" never reads as a
 * fact when the last sign of life is from an hour ago (contract §5.3).
 */
function statusChip(st: LiveStatus, opts: { age?: boolean } = {}): HTMLElement {
	const chip = el("span", `chat-status tone-${statusTone(st.status)}`);
	chip.appendChild(el("span", "chat-dot"));
	chip.appendChild(el("span", "chat-status-label", STATUS_LABEL[st.status] ?? st.status));
	const t = new Date(st.at).getTime();
	const ageMs = Number.isNaN(t) ? 0 : Date.now() - t;
	if (opts.age && ageMs >= 60_000) {
		chip.appendChild(el("span", "chat-status-age", relativeDate(st.at)));
	}
	if (statusIsLiveClaim(st.status) && ageMs >= STALE_EVIDENCE_MS) chip.classList.add("stale");
	chip.title = [st.evidence, st.at ? `last evidence ${clock(st.at)}` : ""]
		.filter(Boolean)
		.join(" · ");
	return chip;
}

function liveDot(): HTMLElement {
	const live = el("span", `chat-live ${liveConnected ? "on" : "off"}`);
	live.appendChild(el("span", "chat-dot"));
	live.appendChild(el("span", undefined, liveConnected ? "Live" : "Offline"));
	live.title = liveConnected
		? "Connected: new events arrive as they happen"
		: "Not connected — reconnecting";
	return live;
}

function renderSummary(): void {
	summaryEl.replaceChildren();
	const c = selected();
	if (c && isMobile() && mobilePane === "thread") {
		const col = el("div", "chat-summary-col");
		col.appendChild(el("span", "chat-summary-title", titleOf(c)));
		const sub = el("span", "chat-summary-sub");
		sub.appendChild(statusChip(currentStatus(c), { age: true }));
		col.appendChild(sub);
		summaryEl.appendChild(col);
		return;
	}
	summaryEl.appendChild(el("span", "chat-summary-title", "Conversations"));
	if (list.status === "loaded") {
		const active = list.conversations.filter((x) => statusIsLiveClaim(x.status)).length;
		summaryEl.appendChild(el("span", "chat-summary-count", String(list.conversations.length)));
		if (active > 0) summaryEl.appendChild(el("span", "chat-summary-active", `${active} active`));
	}
}

function captureBanner(capture: ConversationCapture | null): HTMLElement | null {
	if (!capture || capture.effective) return null;
	const box = el("div", "chat-banner");
	box.setAttribute("role", "status");
	box.appendChild(
		el(
			"strong",
			undefined,
			capture.requested ? "Capture not active yet" : "Capture is off for this session",
		),
	);
	const why = (capture.pendingReasons ?? []).join(", ");
	box.appendChild(
		el(
			"span",
			undefined,
			capture.requested
				? ` New conversations are not being recorded${why ? ` (${why})` : ""}.`
				: " Only conversations recorded earlier are shown.",
		),
	);
	return box;
}

function skeletonList(): HTMLElement {
	const box = el("div", "chat-skeleton");
	box.setAttribute("role", "status");
	box.setAttribute("aria-label", "Loading conversations");
	for (let i = 0; i < 4; i++) {
		const row = el("div", "chat-skel-row");
		row.appendChild(el("span", "chat-skel chat-skel-dot"));
		const col = el("span", "chat-skel-col");
		col.appendChild(el("span", "chat-skel chat-skel-line"));
		col.appendChild(el("span", "chat-skel chat-skel-line short"));
		row.appendChild(col);
		box.appendChild(row);
	}
	return box;
}

function skeletonThread(): HTMLElement {
	const box = el("div", "chat-skeleton chat-skeleton-thread");
	box.setAttribute("role", "status");
	box.setAttribute("aria-label", "Loading conversation");
	for (const side of ["right", "left", "left", "right", "left"]) {
		box.appendChild(el("div", `chat-skel chat-skel-bubble ${side}`));
	}
	return box;
}

function renderList(): void {
	if (!isActive()) return;
	// Live frames re-render the rows; a reader arrowing through them must not lose their place.
	const focused =
		document.activeElement instanceof HTMLElement && listEl.contains(document.activeElement)
			? document.activeElement.dataset.cid
			: undefined;
	listEl.replaceChildren();
	try {
		renderListInner();
	} finally {
		if (focused) listEl.querySelector<HTMLElement>(`[data-cid="${focused}"]`)?.focus();
	}
}

function renderListInner(): void {
	if (list.status === "idle" || list.status === "loading") {
		listEl.appendChild(skeletonList());
		return;
	}
	if (list.status === "error") {
		listEl.appendChild(
			stateBox(
				"error",
				list.message,
				button("Retry", "files-btn", () => void loadList()),
			),
		);
		return;
	}
	const banner = captureBanner(list.capture);
	if (banner) listEl.appendChild(banner);
	if (list.conversations.length === 0) {
		const empty = stateBox(
			"empty",
			"No conversations recorded yet. Use Claude in the terminal and they will appear here.",
		);
		empty.classList.add("chat-empty");
		if (!isMobile() || list.capture?.effective)
			empty.appendChild(button("Open terminal", "files-btn", () => setView("terminal")));
		listEl.appendChild(empty);
		return;
	}
	const active = list.conversations.filter(
		(c) => statusIsLiveClaim(c.status) || c.status === "error",
	);
	const rest = list.conversations.filter((c) => !active.includes(c));
	const sectioned = active.length > 0 && rest.length > 0;
	if (sectioned) listEl.appendChild(el("h3", "chat-list-title", "Active"));
	listEl.appendChild(convList(active.length > 0 ? active : rest));
	if (sectioned) {
		listEl.appendChild(el("h3", "chat-list-title", "Earlier"));
		listEl.appendChild(convList(rest));
	}
}

function convList(items: ConversationSummary[]): HTMLElement {
	const ul = el("ul", "chat-conv-list");
	for (const c of items) {
		const li = el("li");
		const row = el("button", "chat-conv-row");
		row.type = "button";
		row.dataset.cid = c.sessionId;
		const current = c.sessionId === selectedCid;
		if (current) row.classList.add("selected");
		row.setAttribute("aria-current", String(current));
		const tone = statusTone(c.status);
		row.classList.add(`tone-${tone}`);
		const dot = el("span", `chat-conv-dot tone-${tone}`);
		dot.title = STATUS_LABEL[c.status] ?? c.status;
		row.appendChild(dot);
		const main = el("span", "chat-conv-main");
		const top = el("span", "chat-conv-top");
		top.appendChild(el("span", "chat-conv-title", titleOf(c)));
		top.appendChild(el("span", "chat-conv-time", relativeDate(c.lastEventAt)));
		main.appendChild(top);
		const bottom = el("span", "chat-conv-bottom");
		bottom.appendChild(
			el("span", `chat-conv-status tone-${tone}`, STATUS_LABEL[c.status] ?? c.status),
		);
		if (c.kind === "headless" || c.kind === "teammate")
			bottom.appendChild(el("span", "chat-conv-kind", c.kind));
		if (c.gapsCount > 0) {
			bottom.appendChild(
				el("span", "chat-conv-warn", `${c.gapsCount} gap${c.gapsCount === 1 ? "" : "s"}`),
			);
		}
		if (isUnread(c) && !current) {
			const n = el("span", "chat-conv-unread");
			n.setAttribute("aria-label", "New activity");
			bottom.appendChild(n);
		}
		main.appendChild(bottom);
		row.appendChild(main);
		row.addEventListener("click", () => void openConversation(c.sessionId));
		li.appendChild(row);
		ul.appendChild(li);
	}
	return ul;
}

// Roving keyboard navigation over the rows (↑ ↓ Home End); Enter/Space open, as buttons do.
listEl.addEventListener("keydown", (e) => {
	if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
	const rows = [...listEl.querySelectorAll<HTMLButtonElement>(".chat-conv-row")];
	if (rows.length === 0) return;
	const i = rows.findIndex((r) => r === document.activeElement);
	const next =
		e.key === "Home"
			? 0
			: e.key === "End"
				? rows.length - 1
				: e.key === "ArrowDown"
					? Math.min(rows.length - 1, i + 1)
					: Math.max(0, i - 1);
	rows[next]?.focus();
	e.preventDefault();
});
threadEl.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && isMobile() && mobilePane === "thread") {
		if (agentsOpen) {
			agentsOpen = false;
			renderAll();
		} else showList();
		e.preventDefault();
	}
});

function threadScroller(): HTMLElement | null {
	return threadEl.querySelector<HTMLElement>(".chat-scroll");
}
function nearBottom(sc: HTMLElement): boolean {
	return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 64;
}

function renderThreadHead(): void {
	const head = threadEl.querySelector<HTMLElement>(".chat-thread-head");
	const c = selected();
	if (!head || !c) return;
	head.replaceChildren(...threadHeadChildren(c));
}

function threadHeadChildren(c: ConversationSummary): HTMLElement[] {
	const out: HTMLElement[] = [];
	const title = el("div", "chat-thread-title");
	title.appendChild(el("span", "chat-thread-name", titleOf(c)));
	const bits: string[] = [];
	if (c.kind === "headless" || c.kind === "teammate") bits.push(c.kind);
	if (c.claudeVersion) bits.push(`Claude Code ${c.claudeVersion}`);
	bits.push(`${c.eventsCount} events`);
	title.appendChild(el("span", "chat-thread-sub", bits.join(" · ")));
	out.push(title);
	const right = el("div", "chat-thread-tools");
	right.appendChild(statusChip(currentStatus(c), { age: true }));
	const model = cur ? buildThread(cur.window.events) : null;
	const agents = model?.agents ?? [];
	if (agents.length > 0) {
		const running = agents.filter((a) => a.status === "running").length;
		const b = button(
			`Agents ${agents.length}${running > 0 ? ` · ${running} running` : ""}`,
			"files-btn chat-agents-btn",
			() => {
				agentsOpen = !agentsOpen;
				renderAll();
			},
		);
		b.setAttribute("aria-pressed", String(agentsOpen));
		b.setAttribute("aria-controls", "chat-agents");
		right.appendChild(b);
	}
	right.appendChild(liveDot());
	out.push(right);
	return out;
}

function renderThread(opts: { stick: boolean; restore?: boolean }): void {
	if (!isActive()) return;
	const c = selected();
	if (selectedCid === null) {
		const box = stateBox("empty", isMobile() ? "" : "Select a conversation to read it.");
		box.classList.add("chat-empty");
		threadEl.replaceChildren(box);
		return;
	}
	// A failed first page leaves no thread (`cur` null): the error must win
	// over the skeleton, or the reader waits on a load that is not happening (C5).
	if (threadStatus === "error") {
		const box = stateBox(
			"error",
			`Could not load this conversation: ${threadError}`,
			button("Retry", "files-btn", () => {
				if (selectedCid !== null) void openConversation(selectedCid, { fresh: true });
			}),
		);
		box.classList.add("chat-thread-error");
		threadEl.replaceChildren(box);
		return;
	}
	if (threadStatus === "loading" || !cur) {
		threadEl.replaceChildren(skeletonThread());
		return;
	}
	const t = cur;
	let scroller = threadScroller();
	// The scroller belongs to one conversation: a switch rebuilds the pane.
	if (scroller && scroller.dataset.cid !== t.cid) scroller = null;
	const wasEmpty = scroller === null || scroller.childElementCount === 0;
	const atBottom = scroller !== null && nearBottom(scroller);
	if (!scroller) {
		threadEl.replaceChildren();
		const head = el("div", "chat-thread-head");
		if (c) head.replaceChildren(...threadHeadChildren(c));
		threadEl.appendChild(head);
		const offline = el("div", "chat-offline");
		offline.setAttribute("role", "status");
		offline.textContent = "Connection lost — reconnecting. New events will appear when it is back.";
		threadEl.appendChild(offline);
		scroller = el("div", "chat-scroll");
		scroller.dataset.cid = t.cid;
		scroller.addEventListener("scroll", onScroll, { passive: true });
		threadEl.appendChild(scroller);
		threadEl.appendChild(floatPill());
		threadEl.appendChild(composer());
	}
	threadEl.classList.toggle("offline", !liveConnected && everConnected);
	const model = buildThread(t.window.events);
	const blocks = groupBlocks(model.items);
	const nodes: HTMLElement[] = [];
	if (t.window.hasOlder) {
		nodes.push(
			button(
				loadingOlder() ? "Loading…" : "Load earlier",
				"files-btn chat-older",
				() => void loadOlder(),
			),
		);
	} else if (c && c.firstRetainedSeq > 1) {
		nodes.push(el("div", "chat-marker info", "Earlier events are no longer available"));
	}
	const liveKeys = new Set<string>();
	let fresh = 0;
	let announce = false;
	for (const b of blocks) {
		liveKeys.add(b.key);
		const sig = signature(b);
		const cached = t.nodes.get(b.key);
		if (cached && cached.sig === sig) {
			nodes.push(cached.node);
			continue;
		}
		if (!cached) {
			const below = blockSeq(b) > t.renderedLastSeq;
			if (!wasEmpty && below) fresh++;
			if (!wasEmpty && below && b.kind === "item" && b.item.kind === "assistant" && b.item.final)
				announce = true;
		} else if (
			!wasEmpty &&
			b.kind === "item" &&
			b.item.kind === "assistant" &&
			b.item.final &&
			!cached.sig.includes("|final")
		) {
			announce = true;
		}
		const node =
			cached && b.kind === "tools" ? updateToolsBlock(cached.node, b.tools) : renderBlock(b);
		node.dataset.seq = String(blockSeq(b));
		t.nodes.set(b.key, { sig, node });
		nodes.push(node);
	}
	for (const k of t.nodes.keys()) if (!liveKeys.has(k)) t.nodes.delete(k);
	if (model.items.length === 0) {
		nodes.push(stateBox("empty", "No events in this conversation yet."));
	}
	scroller.replaceChildren(...nodes);
	t.renderedLastSeq = t.window.events[t.window.events.length - 1]?.seq ?? 0;
	if (wasEmpty || t.window.lastSeq > (seen.get(t.cid) ?? -1)) {
		if (!document.hidden) markSeen(t.cid, t.window.lastSeq);
	}
	if (opts.restore) {
		setScrollNow(scroller, t.atBottom ? scroller.scrollHeight : t.scrollTop);
		t.pendingBelow = 0;
	} else if (opts.stick && (wasEmpty || atBottom)) {
		scroller.scrollTop = scroller.scrollHeight;
		t.pendingBelow = 0;
	} else if (fresh > 0 && !atBottom && !wasEmpty) {
		t.pendingBelow += fresh;
	}
	if (announce && announcer) {
		announcer.textContent = "";
		announcer.textContent = "Claude replied";
	}
	updateFloat();
	renderThreadHead();
}

function onScroll(): void {
	const sc = threadScroller();
	if (!sc || !cur) return;
	cur.scrollTop = sc.scrollTop;
	cur.atBottom = nearBottom(sc);
	if (cur.atBottom && cur.pendingBelow > 0) {
		cur.pendingBelow = 0;
		updateFloat();
	}
	// Reading upward into the past: fetch the next page before the reader hits the top.
	if (sc.scrollTop < 120 && sc.scrollHeight > sc.clientHeight && cur.window.hasOlder) {
		void loadOlder();
	}
}

function floatPill(): HTMLElement {
	const pill = button("", "chat-float", () => {
		if (!cur) return;
		if (!cur.window.atLatest) {
			jumpToLatest();
			return;
		}
		const sc = threadScroller();
		if (sc) sc.scrollTop = sc.scrollHeight;
		cur.pendingBelow = 0;
		updateFloat();
	});
	pill.hidden = true;
	return pill;
}

function updateFloat(): void {
	const pill = threadEl.querySelector<HTMLButtonElement>(".chat-float");
	if (!pill || !cur) return;
	const t = cur;
	if (!t.window.atLatest) {
		pill.hidden = false;
		pill.textContent =
			t.window.newerUnseen > 0
				? `${t.window.newerUnseen} newer event${t.window.newerUnseen === 1 ? "" : "s"} · Jump to latest`
				: "Jump to latest";
		return;
	}
	if (t.pendingBelow > 0) {
		pill.hidden = false;
		pill.textContent = `↓ ${t.pendingBelow} new`;
		return;
	}
	pill.hidden = true;
}

/** The seq a block starts at (its position in the thread). */
function blockSeq(b: ThreadBlock): number {
	return b.kind === "tools" ? b.tools[0].seq : b.item.seq;
}

function signature(b: ThreadBlock): string {
	if (b.kind === "tools") {
		return b.tools.map((t) => `${t.toolUseId}:${t.state}:${t.durationMs}:${t.toolName}`).join(",");
	}
	const item = b.item;
	switch (item.kind) {
		case "assistant":
			return `${item.text.length}|${item.final ? "final" : "stream"}|${item.truncated}|${item.missingFragments}|${item.report ? "report" : ""}`;
		case "agent":
			return `${item.phase}|${item.agentType}`;
		case "internal":
			return `${item.agentId}|${item.agentType}|${item.toolName}|${item.status}`;
		default:
			return "static";
	}
}

function renderBlock(b: ThreadBlock): HTMLElement {
	if (b.kind === "tools") return updateToolsBlock(el("details", "chat-tools"), b.tools, true);
	return renderItem(b.item);
}

function renderItem(item: Exclude<ThreadItem, ToolItem>): HTMLElement {
	switch (item.kind) {
		case "user": {
			// "You" only for a prompt the person typed. An injected source
			// (§5.1) and a notification-shaped prompt that could not be
			// verified (§4.2.1) are shown as what they are.
			const injected = item.source !== null;
			const box = el(
				"article",
				`chat-msg chat-user${injected ? " injected" : ""}${item.origin === "unverified" ? " unverified" : ""}`,
			);
			const who =
				item.origin === "unverified"
					? "Prompt · origin unverified"
					: injected
						? `Injected · ${item.source}`
						: "You";
			box.appendChild(meta(who, item.ts));
			box.appendChild(el("div", "chat-text", item.text));
			if (item.truncated) box.appendChild(el("div", "chat-note", "Prompt truncated"));
			return box;
		}
		case "internal": {
			// The CLI told the model a background tool finished; the result
			// itself is in the agent's card (agent_end), shown once there.
			const box = el("div", "chat-marker internal");
			box.appendChild(el("span", "chat-marker-icon", "↩"));
			const outcome = item.status === "completed" ? "finished" : item.status;
			const subject = item.agentId
				? `${item.agentType ? `${item.agentType} agent` : "Agent"} ${outcome}`
				: item.toolName
					? `Background ${item.toolName} ${outcome}`
					: `Background task ${outcome}`;
			box.appendChild(el("span", undefined, `${subject} · result delivered to Claude`));
			box.appendChild(el("span", "chat-marker-id", (item.agentId ?? item.toolUseId).slice(-8)));
			if (item.agentId) {
				const agentId = item.agentId;
				box.appendChild(
					button("Details", "chat-link", () => {
						agentsOpen = true;
						renderAll();
						agentsEl.querySelector<HTMLElement>(`[data-agent="${agentId}"]`)?.scrollIntoView?.({
							block: "nearest",
						});
					}),
				);
			}
			return box;
		}
		case "assistant": {
			const box = el("article", `chat-msg chat-assistant${item.report ? " is-report" : ""}`);
			const head = meta(item.report ? "Claude · final report" : "Claude", item.ts);
			if (item.final) {
				if (item.report) {
					const r = item.report;
					head.appendChild(
						copyButton(r.truncated ? "Copy report (truncated)" : "Copy report", () => r.text),
					);
				} else head.appendChild(copyButton("Copy Markdown", () => item.text));
			}
			box.appendChild(head);
			// Streaming text is plain until the message is final, then Markdown.
			if (item.final) box.appendChild(markdown(item.text));
			else box.appendChild(el("div", "chat-text streaming", item.text));
			if (item.missingFragments > 0)
				box.appendChild(
					el(
						"div",
						"chat-note warn",
						`${item.missingFragments} fragment${item.missingFragments === 1 ? "" : "s"} of this message ${item.missingFragments === 1 ? "was" : "were"} lost`,
					),
				);
			if (item.truncated) box.appendChild(el("div", "chat-note", "Message truncated"));
			if (item.report?.truncated) box.appendChild(truncatedNote(item.report.originalBytes));
			return box;
		}
		case "report": {
			// A report with no matching message in the window (deltas lost or
			// not in the page): the report text itself is the final answer.
			const box = el("article", "chat-msg chat-assistant is-report");
			const head = meta("Claude · final report", item.ts);
			head.appendChild(
				copyButton(item.truncated ? "Copy report (truncated)" : "Copy report", () => item.text),
			);
			box.appendChild(head);
			if (item.text) box.appendChild(markdown(item.text));
			else box.appendChild(el("div", "chat-note", "Empty report"));
			if (item.truncated) box.appendChild(truncatedNote(item.originalBytes));
			return box;
		}
		case "agent": {
			const box = el("div", `chat-marker agent ${item.phase}`);
			box.appendChild(el("span", "chat-marker-icon", "↳"));
			const label = item.agentType ? `${item.agentType} agent` : "Agent";
			box.appendChild(
				el("span", undefined, item.phase === "start" ? `${label} started` : `${label} finished`),
			);
			box.appendChild(el("span", "chat-marker-id", item.agentId.slice(0, 8)));
			box.appendChild(
				button("Details", "chat-link", () => {
					agentsOpen = true;
					renderAll();
					agentsEl.querySelector<HTMLElement>(`[data-agent="${item.agentId}"]`)?.scrollIntoView?.({
						block: "nearest",
					});
				}),
			);
			return box;
		}
		case "marker":
			return el("div", `chat-marker ${item.tone}`, item.text);
	}
}

function truncatedNote(originalBytes: number | null): HTMLElement {
	return el(
		"div",
		"chat-note",
		`Report truncated${originalBytes ? ` (original ${formatBytes(originalBytes)})` : ""} — copying copies what was kept.`,
	);
}

/** Rendered Markdown with a Copy button on every code block. */
function markdown(text: string): HTMLElement {
	const md = renderMarkdown(text);
	md.classList.add("chat-md");
	for (const pre of [...md.querySelectorAll<HTMLElement>("pre.md-pre")]) {
		const wrap = el("div", "chat-pre");
		pre.replaceWith(wrap);
		wrap.appendChild(pre);
		const code = pre.textContent ?? "";
		wrap.appendChild(copyButton("Copy", () => code, "Copy code"));
	}
	return md;
}

/**
 * One block for a run of consecutive tool calls. `details` keeps the
 * user's open/closed choice across live updates: a growing run only
 * replaces the summary line and the rows. Opens by itself when small or
 * when something failed or is still running — that is what the reader
 * must not miss.
 */
function updateToolsBlock(node: HTMLElement, tools: ToolItem[], fresh = false): HTMLElement {
	const d = node as HTMLDetailsElement;
	const s = toolsSummary(tools);
	const summary = el("summary", "chat-tools-summary");
	const icon = el("span", "chat-tool-icon");
	icon.textContent = s.running > 0 ? "…" : s.failed > 0 ? "✗" : "✓";
	icon.classList.add(s.running > 0 ? "running" : s.failed > 0 ? "failed" : "ok");
	summary.appendChild(icon);
	const text = el("span", "chat-tools-text");
	text.appendChild(
		el("span", "chat-tools-count", `${s.count} tool call${s.count === 1 ? "" : "s"}`),
	);
	if (s.failed > 0) text.appendChild(el("span", "chat-tools-failed", `${s.failed} failed`));
	if (s.running > 0) text.appendChild(el("span", "chat-tools-running", `${s.running} running`));
	text.appendChild(el("span", "chat-tools-names", s.names.slice(0, 4).join(", ")));
	summary.appendChild(text);
	if (s.durationMs !== null)
		summary.appendChild(el("span", "chat-tool-dur", duration(s.durationMs)));
	summary.appendChild(el("span", "chat-tools-chevron"));
	const rows = el("div", "chat-tools-rows");
	for (const t of tools) rows.appendChild(toolRow(t));
	const hadFailure = d.dataset.failed === "1";
	d.dataset.failed = s.failed > 0 ? "1" : "0";
	if (fresh) {
		d.open = s.count <= 3 || s.failed > 0 || s.running > 0;
		d.addEventListener("toggle", () => {
			d.dataset.userToggled = "1";
		});
	} else if (s.failed > 0 && !hadFailure && d.dataset.userToggled !== "1") {
		d.open = true;
	}
	d.replaceChildren(summary, rows);
	return d;
}

function toolRow(item: ToolItem): HTMLElement {
	const d = el("details", `chat-tool ${item.state}`);
	const s = el("summary");
	s.appendChild(el("span", "chat-tool-icon", toolIcon(item.state)));
	s.appendChild(el("span", "chat-tool-name", item.toolName));
	const line = toolLine(item.toolName, item.summary);
	const detail = line.startsWith(`${item.toolName} · `) ? line.slice(item.toolName.length + 3) : "";
	s.appendChild(el("span", "chat-tool-line", detail));
	if (item.durationMs !== null)
		s.appendChild(el("span", "chat-tool-dur", duration(item.durationMs)));
	d.appendChild(s);
	const body = el("div", "chat-tool-body");
	body.appendChild(
		el(
			"p",
			undefined,
			item.state === "running"
				? "Running…"
				: item.state === "ok"
					? "Succeeded."
					: item.state === "interrupted"
						? "Interrupted."
						: "Failed.",
		),
	);
	if (item.error) body.appendChild(el("pre", "chat-tool-error", item.error));
	body.appendChild(
		el(
			"p",
			"chat-note",
			"Arguments and output are not recorded (privacy) — see the Terminal for details.",
		),
	);
	d.appendChild(body);
	return d;
}

function meta(who: string, ts: string): HTMLElement {
	const head = el("div", "chat-meta");
	head.appendChild(el("span", "chat-who", who));
	const time = el("time", "chat-time", clock(ts));
	time.dateTime = ts;
	head.appendChild(time);
	return head;
}

// ── Agents panel ────────────────────────────────────────────────────────────

function renderAgents(): void {
	const open = agentsOpen && selectedCid !== null && cur !== null;
	agentsEl.hidden = !open;
	if (!open || !cur) return;
	const agents = buildThread(cur.window.events).agents;
	agentsEl.replaceChildren();
	const head = el("div", "chat-agents-head");
	head.appendChild(el("h3", undefined, `Agents · ${agents.length}`));
	head.appendChild(
		button(
			"×",
			"files-btn chat-agents-close",
			() => {
				agentsOpen = false;
				renderAll();
			},
			"Close agents panel",
		),
	);
	agentsEl.appendChild(head);
	if (agents.length === 0) {
		agentsEl.appendChild(stateBox("empty", "No subagents in this conversation."));
		return;
	}
	const ul = el("ul", "chat-agent-list");
	for (const a of agents) ul.appendChild(agentCard(a));
	agentsEl.appendChild(ul);
}

function agentCard(a: AgentView): HTMLElement {
	const li = el("li", `chat-agent ${a.status}`);
	li.dataset.agent = a.agentId;
	const top = el("div", "chat-agent-top");
	top.appendChild(el("span", "chat-agent-type", a.agentType || "agent"));
	top.appendChild(
		statusChip({
			status: a.status === "done" ? "ended" : "running",
			evidence: "",
			at: a.endedAt ?? a.startedAt,
		}),
	);
	li.appendChild(top);
	const bits: string[] = [a.agentId.slice(0, 8)];
	bits.push(`${a.toolIds.size} tool${a.toolIds.size === 1 ? "" : "s"}`);
	if (a.failedToolIds.size > 0) bits.push(`${a.failedToolIds.size} failed`);
	const started = new Date(a.startedAt).getTime();
	const ended = a.endedAt ? new Date(a.endedAt).getTime() : Date.now();
	if (!Number.isNaN(started) && !Number.isNaN(ended) && ended >= started)
		bits.push(duration(ended - started));
	const metaLine = el("div", "chat-agent-meta", bits.join(" · "));
	if (a.failedToolIds.size > 0) metaLine.classList.add("has-failed");
	li.appendChild(metaLine);
	const result = a.result;
	if (result !== null) {
		const r = el("details", "chat-agent-result");
		const s = el("summary");
		s.appendChild(el("span", undefined, a.resultTruncated ? "Result (truncated)" : "Result"));
		r.appendChild(s);
		const actions = el("div", "chat-agent-actions");
		actions.appendChild(copyButton("Copy result", () => result));
		r.appendChild(actions);
		r.appendChild(markdown(result));
		li.appendChild(r);
	} else if (a.status === "running") {
		li.appendChild(el("div", "chat-note", "Working — result not available yet."));
	}
	return li;
}

// ── Composer (3.2 placeholder) ──────────────────────────────────────────────

function composer(): HTMLElement {
	const box = el("div", "chat-composer");
	const ta = el("textarea");
	ta.disabled = true;
	ta.placeholder = "Replying from Chat arrives in 3.2 — use the Terminal for now";
	ta.setAttribute("aria-label", "Message (not available yet)");
	ta.rows = 1;
	box.appendChild(ta);
	box.appendChild(button("Open terminal", "files-btn", () => setView("terminal")));
	return box;
}

// ── Copy ────────────────────────────────────────────────────────────────────

function copyButton(label: string, text: () => string, title?: string): HTMLButtonElement {
	return button(
		label,
		"files-btn chat-copy",
		() => {
			void copyText(text()).then(
				(ok) => (ok ? showCopySuccessToast() : showToast("Copy failed", true)),
				() => showToast("Copy failed", true),
			);
		},
		title,
	);
}

/** Clipboard API, falling back to a hidden textarea (older or non-secure contexts). */
export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.setAttribute("readonly", "");
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.select();
		let ok = false;
		try {
			ok = document.execCommand("copy");
		} catch {
			ok = false;
		}
		ta.remove();
		return ok;
	}
}

function toolIcon(state: string): string {
	return state === "running" ? "…" : state === "ok" ? "✓" : state === "interrupted" ? "■" : "✗";
}
function duration(ms: number): string {
	if (ms < 1000) return `${ms} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
	const m = Math.floor(ms / 60_000);
	const s = Math.round((ms % 60_000) / 1000);
	return `${m} min${s > 0 ? ` ${s} s` : ""}`;
}
