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
 *
 * v1.8 §6.2: the owner renames/archives from a ⋯ menu per row and in the
 * thread header; the list filters Active / Archived / All (chatMeta.ts holds
 * the rules). None of it touches the thread, the socket, the composer or the
 * terminal: a change only re-renders the list and the header.
 */

import {
	type ConversationCapture,
	type ConversationServerFrame,
	type ConversationSocket,
	type ConversationSummary,
	fetchConversationEvents,
	fetchConversations,
	openConversationSocket,
	patchConversationMeta,
	projectChatEnabled,
	sendConversationMessage,
} from "./api.js";
import {
	automaticTitle,
	CHAT_FILTERS,
	type ChatFilter,
	displayTitle,
	explainMetaError,
	filterCounts,
	inFilter,
	isArchived,
	MetaOverlay,
	metaOutcomeUnknown,
	readFilter,
	titleProblem,
	writeFilter,
} from "./chatMeta.js";
import { openActionMenu } from "./components/actionMenu.js";
import { promptDialog } from "./components/dialog.js";
import { explainCode, normalizeText, validateText } from "./composerText.js";
import {
	type AgentView,
	BG_TEXT,
	buildThread,
	clock,
	EventWindow,
	groupBlocks,
	lastEvidenceAt,
	presentStatus,
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
import { forgetAllDrafts, readDraft, writeDraft } from "./draftStore.js";
import { formatBytes, relativeDate } from "./format.js";
import {
	activeSessionId,
	currentTabs,
	isMobile,
	sessions,
	showCopySuccessToast,
	showToast,
} from "./main.js";
import { renderMarkdown } from "./markdown.js";
import { renderSessionList, showTerminalTab, syncLastConversationCurrent } from "./sessionCore.js";
import { sessionNoun, switcherWords } from "./switcherModel.js";
import { button, el, stateBox } from "./ui.js";
import {
	clearLastConversationTitle,
	readLastConversation,
	readLastConversationTitle,
	writeHistoryHint,
	writeLastConversation,
	writeLastConversationTitle,
} from "./viewPolicy.js";
import {
	getView,
	onSessionSync,
	onViewChange,
	reflectRoute,
	registerRouteDetail,
	routeBack,
	setView,
} from "./viewSwitch.js";

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
// Per-request sequence within a session: a refresh click, the poll and a
// Retry all load the same list, and only the newest request's answer may
// land — an older one answering later would roll the list (and the
// landing policy's "has history" memory) back.
let listReq = 0;
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
// The socket stopped for good (1008 refusal, or the conversation not found):
// nothing is reconnecting, so the UI must not say it is.
let socketGaveUp = false;
let mobilePane: "list" | "thread" = "list";
let agentsOpen = false;
let listTimer: ReturnType<typeof setInterval> | null = null;
let renderQueued = false;
// One shot per session selection: when the list first lands with no
// conversation open, the one the person last read here is reopened (in
// place — no history entry). A route that names a conversation, or none
// ("…/chat"), and the person's own clicks all clear it first.
let restorePending = false;
/** Highest seq the reader has seen per conversation (the unread dot). */
const seen = new Map<string, number>();
let seenBaselined = false;
// v1.8 §6.2 — owner metadata.
let filter: ChatFilter = readFilter();
let metaState: "ok" | "unavailable" = "ok";
const metaOverlay = new MetaOverlay();
/** Conversations with a rename/archive request in flight (their actions are disabled meanwhile). */
const metaBusy = new Set<string>();
/** Where the last rename/archive was started from, so focus can go back there after the re-render. */
let metaFocusWhere: "list" | "head" = "list";

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
	metaState = "ok";
	metaOverlay.clear();
	metaBusy.clear();
	selectedCid = null;
	threadStatus = "idle";
	threadError = "";
	loadingOlderGen = null;
	threads.clear();
	cur = null;
	everConnected = false;
	socketGaveUp = false;
	mobilePane = "list";
	agentsOpen = false;
	seen.clear();
	seenBaselined = false;
	restorePending = sessionId !== null;
	loadSeen();
}

refreshBtn.addEventListener("click", () => {
	void loadList();
	if (selectedCid !== null) void openConversation(selectedCid, { fresh: true });
});
backBtn.addEventListener("click", routeBack);

// Route detail = the open conversation (#/sessions/<id>/chat/<cid>). The
// thread cache (`threads`) survives a deselection, so Back and Forward
// between conversations land where the reader was, without a request.
registerRouteDetail("chat", {
	current: () => selectedCid,
	apply: (cid) => {
		if (cid === null) {
			deselect();
			return;
		}
		if (cid !== selectedCid) void openConversation(cid);
	},
});

/** No conversation open: the list (the only pane on mobile), socket released. */
function deselect(): void {
	threadGen++;
	closeSocket();
	restorePending = false;
	selectedCid = null;
	cur = null;
	threadStatus = "idle";
	threadError = "";
	mobilePane = "list";
	agentsOpen = false;
	renderAll();
	// Hand the focus to the row we came from, so the keyboard reader lands back where they were.
	listEl.querySelector<HTMLElement>('.chat-conv-row[aria-current="true"]')?.focus();
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
	const req = ++listReq;
	const quiet = opts.quiet === true && list.status === "loaded";
	if (!quiet) {
		list = { status: "loading" };
		renderAll();
	}
	refreshBtn.classList.add("spinning");
	try {
		const data = await fetchConversations(sid, { capture: !quiet });
		if (gen !== generation || req !== listReq) return;
		const capture = data.capture ?? (list.status === "loaded" ? list.capture : null);
		metaOverlay.apply(data.conversations, req);
		metaState = data.meta ?? "ok";
		list = { status: "loaded", capture, conversations: data.conversations };
		// The landing policy's memory (viewPolicy.ts): Chat first next time, if there is history.
		writeHistoryHint(sid, data.conversations.length > 0);
		if (restorePending && selectedCid === null && isActive()) {
			restorePending = false;
			const last = readLastConversation(sid);
			if (last !== null && data.conversations.some((c) => c.sessionId === last)) {
				void openConversation(last, { restore: true });
			}
		}
		if (!seenBaselined) {
			// First sight of this session's list: nothing is "new" yet.
			for (const c of data.conversations)
				if (!seen.has(c.sessionId)) seen.set(c.sessionId, c.lastSeq);
			seenBaselined = true;
			saveSeen();
		}
	} catch (err) {
		if (gen !== generation || req !== listReq) return;
		if (!quiet) list = { status: "error", message: (err as Error).message };
	} finally {
		if (gen === generation && req === listReq) refreshBtn.classList.remove("spinning");
	}
	renderAll();
}

/** Open a conversation: from the cache when it is fresh, else the newest page. */
async function openConversation(
	cid: string,
	opts: { fresh?: boolean; restore?: boolean } = {},
): Promise<void> {
	const sid = stateSessionId;
	if (sid === null) return;
	const gen = ++threadGen;
	const switching = selectedCid !== cid;
	if (cur && switching) rememberScroll();
	restorePending = false;
	selectedCid = cid;
	writeLastConversation(sid, cid);
	rememberLastTitle(sid);
	threadError = "";
	mobilePane = "thread";
	if (isMobile()) agentsOpen = false;
	// Opening a conversation is a step Back undoes (a no-op while a route
	// is being applied); reopening the last one on landing is not.
	reflectRoute({ push: switching && opts.restore !== true });
	syncLastConversationCurrent();
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
		socketGaveUp = false;
		socket = openConversationSocket(
			sid,
			(f) => {
				if (gen === generation) onFrame(f);
			},
			(connected, refused) => {
				if (gen !== generation) return;
				liveConnected = connected;
				if (connected) everConnected = true;
				if (refused) {
					socketGaveUp = true;
					// 1008 never reconnects: drop the dead object so the next
					// openSocket (reopen, Refresh) builds a new one, as the banner says.
					socket = null;
				}
				// The "connection lost" banner follows the socket now, not the
				// next thread render (which may be a long time coming offline).
				syncOffline();
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
	// Every caller closes on purpose (view switch, deselect, session change):
	// the next socket's connect window is "Connecting…", not a lost connection.
	// Real drops arrive only through the socket's own onState(false).
	everConnected = false;
}

/** The thread's connection banner: shown while reconnecting or after the socket gave up. */
function syncOffline(): void {
	const down = !liveConnected && (everConnected || socketGaveUp);
	threadEl.classList.toggle("offline", down);
	const banner = threadEl.querySelector<HTMLElement>(".chat-offline");
	if (banner) {
		banner.textContent = socketGaveUp
			? "Not receiving new events. Reopen the conversation or refresh the list to try again."
			: "Connection lost — reconnecting. New events will appear when it is back.";
	}
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
		socketGaveUp = true;
		syncOffline();
		renderThreadHead();
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

// An agent to show once its conversation is open (the switcher's "↳ agent"
// rows): navigation only — the Agents panel opens with that card in view.
// Only honoured for a short while: a request whose conversation never opened
// must not pop the panel open the next time someone opens it by hand.
let pendingAgentFocus: { cid: string; agentId: string; at: number } | null = null;
const AGENT_FOCUS_TTL_MS = 15_000;

/** Open the Agents panel on `agentId` when conversation `cid` is next shown. */
export function focusAgentWhenOpen(cid: string, agentId: string): void {
	pendingAgentFocus = { cid, agentId, at: Date.now() };
	if (selectedCid === cid && cur !== null) renderAll();
}

function renderAll(opts: { scrollToEnd?: boolean; restoreScroll?: boolean } = {}): void {
	if (!isActive()) return;
	if (pendingAgentFocus && Date.now() - pendingAgentFocus.at > AGENT_FOCUS_TTL_MS)
		pendingAgentFocus = null;
	if (pendingAgentFocus && pendingAgentFocus.cid === selectedCid && cur !== null) agentsOpen = true;
	const inThread = mobilePane === "thread" && selectedCid !== null;
	bodyEl.classList.toggle("show-thread", inThread);
	bodyEl.classList.toggle("show-agents", agentsOpen && selectedCid !== null);
	backBtn.hidden = !(isMobile() && inThread);
	renderSummary();
	renderList();
	renderThread({ stick: opts.scrollToEnd === true, restore: opts.restoreScroll === true });
	renderComposer();
	renderAgents();
}

function selected(): ConversationSummary | undefined {
	return selectedCid ? rowOf(selectedCid) : undefined;
}

function titleOf(c: ConversationSummary): string {
	return displayTitle(c);
}

function currentStatus(c: ConversationSummary): LiveStatus {
	const live = cur?.liveStatus ?? { status: c.status, evidence: c.statusEvidence, at: c.statusAt };
	// Freshness: the later of the status time and the last event (lastEvidenceAt).
	return { ...live, at: lastEvidenceAt({ statusAt: live.at, lastEventAt: c.lastEventAt }) };
}

/**
 * The status chip: a dot in the status colour, the label and — when the
 * evidence is older than a minute — its age, so "Working" never reads as a
 * fact when the last sign of life is from an hour ago (contract §5.3).
 */
function statusChip(
	st: LiveStatus,
	opts: { age?: boolean; staleness?: boolean } = {},
): HTMLElement {
	// `staleness: false` for chips whose time is not evidence of liveness
	// (a subagent's start time): they keep their own label.
	const shown =
		opts.staleness === false
			? {
					label: STATUS_LABEL[st.status] ?? st.status,
					tone: statusTone(st.status),
					active: false,
					stale: false,
				}
			: presentStatus(st.status, st.at, Date.now());
	const chip = el("span", `chat-status tone-${shown.tone}`);
	chip.appendChild(el("span", "chat-dot"));
	chip.appendChild(el("span", "chat-status-label", shown.label));
	const t = new Date(st.at).getTime();
	const ageMs = Number.isNaN(t) ? 0 : Date.now() - t;
	if (opts.age && ageMs >= 60_000) {
		chip.appendChild(el("span", "chat-status-age", relativeDate(st.at)));
	}
	if (shown.stale) chip.classList.add("stale");
	chip.title = [st.evidence, st.at ? `last evidence ${clock(st.at)}` : ""]
		.filter(Boolean)
		.join(" · ");
	return chip;
}

/**
 * The event socket's state, shown only when it is NOT delivering: "Live"
 * already names conversation activity (the list's Live section and the
 * "N live" pill), so a second, always-on "Live" for the socket made the two
 * indistinguishable. Connected = nothing to say.
 */
function connectionChip(): HTMLElement | null {
	if (liveConnected) return null;
	const live = el("span", "chat-live off");
	live.appendChild(el("span", "chat-dot"));
	const text = socketGaveUp
		? "Not receiving events"
		: everConnected
			? "Reconnecting…"
			: "Connecting…";
	live.appendChild(el("span", undefined, text));
	live.title = socketGaveUp
		? "The server stopped sending new events. Reopen the conversation or refresh the list to try again."
		: everConnected
			? "Connection lost — new events will appear when it is back"
			: "Connecting to receive new events as they happen";
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
		const now = Date.now();
		const active = list.conversations.filter(
			(x) => presentStatus(x.status, lastEvidenceAt(x), now).active,
		).length;
		summaryEl.appendChild(el("span", "chat-summary-count", String(list.conversations.length)));
		if (active > 0) summaryEl.appendChild(el("span", "chat-summary-active", `${active} live`));
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
	// Live frames and polls re-render the rows; whoever is on a row, its ⋯, its Unarchive
	// or a filter button (keyboard, screen reader) must stay on the same control.
	const focusSel = focusedListControl();
	listEl.replaceChildren();
	try {
		renderListInner();
	} finally {
		if (focusSel) listEl.querySelector<HTMLElement>(focusSel)?.focus();
	}
}

/** A selector that finds the focused list control again after a re-render, or null. */
function focusedListControl(): string | null {
	const a = document.activeElement;
	if (!(a instanceof HTMLElement) || !listEl.contains(a)) return null;
	const d = a.dataset;
	if (d.metaCid) return `[data-meta-cid="${CSS.escape(d.metaCid)}"][data-meta-where="list"]`;
	if (d.unarchiveCid) return `[data-unarchive-cid="${CSS.escape(d.unarchiveCid)}"]`;
	if (d.filter) return `.chat-filter-btn[data-filter="${CSS.escape(d.filter)}"]`;
	if (d.cid) return `.chat-conv-row[data-cid="${CSS.escape(d.cid)}"]`;
	return null;
}

/**
 * Keep the sidebar's "↳ last conversation" link named after the current title
 * of this project's last conversation (a rename included): written only when
 * it changed, then the sidebar re-renders (a DOM pass, no request).
 */
function rememberLastTitle(sid: string): void {
	const cid = readLastConversation(sid);
	if (cid === null) return;
	const row = rowOf(cid);
	if (!row) {
		// Not in a loaded list any more: the link would open nothing.
		if (list.status === "loaded" && readLastConversationTitle(sid, cid) !== null) {
			clearLastConversationTitle(sid);
			renderSessionList();
		}
		return;
	}
	const title = titleOf(row);
	if (readLastConversationTitle(sid, cid) === title) return;
	writeLastConversationTitle(sid, cid, title);
	renderSessionList();
}

function renderListInner(): void {
	if (list.status === "loaded" && stateSessionId !== null) rememberLastTitle(stateSessionId);
	if (list.status === "idle" || list.status === "loading") {
		listEl.appendChild(skeletonList());
		return;
	}
	if (list.status === "error") {
		listEl.appendChild(
			stateBox(
				"error",
				`Could not load the conversations: ${list.message}`,
				button("Retry", "files-btn", () => void loadList()),
			),
		);
		return;
	}
	const banner = captureBanner(list.capture);
	if (banner) listEl.appendChild(banner);
	if (metaState === "unavailable") listEl.appendChild(metaBanner());
	if (list.conversations.length === 0) {
		// Three different situations read as "nothing here" — say which.
		const cap = list.capture;
		const why = (cap?.pendingReasons ?? []).join(", ");
		const text =
			cap === null || cap.effective
				? "No conversations recorded yet. Use Claude in the terminal and they will appear here."
				: cap.requested
					? `Capture is requested but not active yet${why ? ` (${why})` : ""}. Conversations will appear here once it is.`
					: "Capture is off for this session: Claude conversations are not recorded. An admin can enable it.";
		const empty = stateBox("empty", text);
		empty.classList.add("chat-empty");
		empty.dataset.reason =
			cap === null || cap.effective ? "none" : cap.requested ? "pending" : "off";
		if (!isMobile() || cap?.effective)
			empty.appendChild(button("Open terminal", "files-btn", () => setView("terminal")));
		listEl.appendChild(empty);
		return;
	}
	// "Live" = a live claim with fresh evidence. Unknown, stale, ended,
	// disconnected and errored conversations are all listed under "Earlier",
	// still openable and readable. (v1.8: the heading is "Live", so it never
	// reads like the "Active" filter.)
	const now = Date.now();
	const isLive = (c: ConversationSummary) => presentStatus(c.status, lastEvidenceAt(c), now).active;
	// With the metadata unreadable the archive state is unknown: every
	// conversation is shown and the filters wait.
	const effective: ChatFilter = metaState === "unavailable" ? "all" : filter;
	listEl.appendChild(filterBar(filterCounts(list.conversations, isLive), effective));
	// On a phone the header has no switcher button and the sidebar's is two
	// taps away: from the list, one tap reaches every running project's
	// conversations. (The event name mirrors switcher.ts OPEN_SWITCHER_EVENT.)
	if (isMobile()) {
		const go = button(
			switcherWords(sessionNoun(projectChatEnabled())).otherConversations,
			"chat-switcher-entry",
			() =>
				document.dispatchEvent(
					new CustomEvent("st:open-switcher", {
						detail: { opener: listEl.querySelector(".chat-switcher-entry") },
					}),
				),
		);
		listEl.appendChild(go);
	}
	const shown = list.conversations.filter((c) => inFilter(c, effective, isLive(c)));
	if (shown.length === 0) {
		const empty = stateBox(
			"empty",
			effective === "archived"
				? "No archived conversations. Archive one from its ⋯ menu; it stays readable here."
				: "Every conversation is archived.",
		);
		empty.classList.add("chat-empty");
		if (effective !== "all")
			empty.appendChild(button("Show all", "files-btn", () => pickFilter("all")));
		listEl.appendChild(empty);
		return;
	}
	const active = shown.filter(isLive);
	const rest = shown.filter((c) => !active.includes(c));
	const sectioned = active.length > 0 && rest.length > 0;
	if (sectioned) listEl.appendChild(el("h3", "chat-list-title", "Live"));
	listEl.appendChild(convList(active.length > 0 ? active : rest));
	if (sectioned) {
		listEl.appendChild(el("h3", "chat-list-title", "Earlier"));
		listEl.appendChild(convList(rest));
	}
}

function metaBanner(): HTMLElement {
	const box = el("div", "chat-banner chat-meta-banner");
	box.setAttribute("role", "status");
	box.appendChild(el("strong", undefined, "Names and archive state unavailable."));
	box.appendChild(
		el(
			"span",
			undefined,
			" Showing every conversation with its automatic title; your names are not lost. Refresh to try again.",
		),
	);
	return box;
}

/** Active · Archived · All — a group of toggle buttons (one pressed). */
function filterBar(counts: ReturnType<typeof filterCounts>, effective: ChatFilter): HTMLElement {
	const bar = el("div", "chat-filter");
	bar.setAttribute("role", "group");
	bar.setAttribute("aria-label", "Show conversations");
	const disabled = metaState === "unavailable";
	for (const f of CHAT_FILTERS) {
		const b = el("button", "chat-filter-btn");
		b.type = "button";
		b.dataset.filter = f.id;
		b.setAttribute("aria-pressed", String(f.id === effective));
		b.disabled = disabled;
		b.appendChild(el("span", undefined, f.label));
		b.appendChild(el("span", "chat-filter-count", String(counts[f.id])));
		// An archived conversation that is live again is surfaced in Active,
		// and the Archived button says how many of its own are live.
		if (f.id === "archived" && counts.archivedLive > 0) {
			const badge = el("span", "chat-filter-live", `${counts.archivedLive} live`);
			b.appendChild(badge);
		}
		b.setAttribute(
			"aria-label",
			`${f.label}: ${counts[f.id]}${f.id === "archived" && counts.archivedLive > 0 ? `, ${counts.archivedLive} live again` : ""}`,
		);
		b.addEventListener("click", () => pickFilter(f.id));
		bar.appendChild(b);
	}
	return bar;
}

function pickFilter(f: ChatFilter): void {
	filter = f;
	writeFilter(f);
	renderList();
	listEl.querySelector<HTMLElement>(`.chat-filter-btn[data-filter="${f}"]`)?.focus();
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
		const shown = presentStatus(c.status, lastEvidenceAt(c), Date.now());
		const tone = shown.tone;
		if (isArchived(c)) row.classList.add("archived");
		row.classList.add(`tone-${tone}`);
		const dot = el("span", `chat-conv-dot tone-${tone}`);
		dot.title = shown.label;
		row.appendChild(dot);
		const main = el("span", "chat-conv-main");
		const top = el("span", "chat-conv-top");
		top.appendChild(el("span", "chat-conv-title", titleOf(c)));
		top.appendChild(el("span", "chat-conv-time", relativeDate(c.lastEventAt)));
		main.appendChild(top);
		const bottom = el("span", "chat-conv-bottom");
		bottom.appendChild(el("span", `chat-conv-status tone-${tone}`, shown.label));
		if (c.kind === "headless" || c.kind === "teammate")
			bottom.appendChild(el("span", "chat-conv-kind", c.kind));
		if (c.gapsCount > 0) {
			bottom.appendChild(
				el("span", "chat-conv-warn", `${c.gapsCount} gap${c.gapsCount === 1 ? "" : "s"}`),
			);
		}
		if (isArchived(c)) {
			// Archived and live again (shown in Active): say both, so it is found and understood.
			const liveAgain = shown.active;
			bottom.appendChild(
				el(
					"span",
					`chat-conv-archived${liveAgain ? " live" : ""}`,
					liveAgain ? "Archived · active again" : "Archived",
				),
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
		li.classList.add("chat-conv-item");
		li.appendChild(row);
		// Siblings of the row button (a button cannot hold buttons): reachable with Tab.
		const tools = el("span", "chat-conv-tools");
		if (isArchived(c) && shown.active) {
			const un = button("Unarchive", "files-btn chat-conv-unarchive", () => {
				if (metaBusy.has(c.sessionId)) return;
				metaFocusWhere = "list";
				void setArchived(c, false);
			});
			un.setAttribute("aria-label", `Unarchive: ${titleOf(c)}`);
			un.dataset.unarchiveCid = c.sessionId;
			markBusy(un, c.sessionId);
			tools.appendChild(un);
		}
		tools.appendChild(metaMenuButton(c, "list"));
		li.appendChild(tools);
		ul.appendChild(li);
	}
	return ul;
}

// ── Rename / archive (v1.8 §6.2) ────────────────────────────────────────────

function metaMenuButton(c: ConversationSummary, where: "list" | "head"): HTMLButtonElement {
	const b = el("button", "chat-meta-btn", "⋯");
	b.type = "button";
	b.dataset.metaCid = c.sessionId;
	b.dataset.metaWhere = where;
	b.title = "Rename or archive";
	b.setAttribute("aria-label", `Actions: ${titleOf(c)}`);
	b.setAttribute("aria-haspopup", "menu");
	// With the metadata unreadable the current name/archive state is unknown: no guessed actions.
	b.disabled = metaState === "unavailable";
	if (metaState === "unavailable") b.title = "Names and archive state are unavailable right now";
	// Busy = aria-disabled, not `disabled`: a disabled button cannot keep the keyboard focus.
	markBusy(b, c.sessionId);
	b.addEventListener("click", () => {
		if (metaBusy.has(c.sessionId)) return;
		metaFocusWhere = where;
		openMetaMenu(c.sessionId, b);
	});
	return b;
}

function markBusy(b: HTMLElement, cid: string): void {
	if (!metaBusy.has(cid)) return;
	b.setAttribute("aria-disabled", "true");
	b.classList.add("busy");
}

/** Back to this conversation's ⋯ where the action started (after any dialog's own focus return). */
function refocusMeta(cid: string): void {
	const where = metaFocusWhere;
	setTimeout(() => {
		const target =
			document.querySelector<HTMLElement>(
				`[data-meta-cid="${CSS.escape(cid)}"][data-meta-where="${where}"]`,
			) ?? document.querySelector<HTMLElement>(`[data-meta-cid="${CSS.escape(cid)}"]`);
		if (target && target.offsetParent !== null && !isFocusInDialog()) target.focus();
	}, 0);
}

function isFocusInDialog(): boolean {
	return document.activeElement?.closest(".modal.open") != null;
}

function openMetaMenu(cid: string, opener: HTMLElement): void {
	const c = rowOf(cid);
	if (!c) return;
	const custom = c.customTitle?.trim() || null;
	const auto = automaticTitle(c);
	openActionMenu({
		title: titleOf(c),
		opener,
		items: [
			{ id: "rename", label: "Rename…", hint: custom ? undefined : "Give it your own name" },
			{
				id: "restore",
				label: "Restore automatic title",
				hint: auto ? `“${auto}”` : "No automatic title yet",
				enabled: custom !== null,
				reason: "It already shows the automatic title",
			},
			isArchived(c)
				? { id: "unarchive", label: "Unarchive", hint: "Back to Active" }
				: { id: "archive", label: "Archive", hint: "Hide from Active; nothing is deleted" },
		],
		onPick: (id) => {
			if (id === "rename") void renameConversation(cid);
			else if (id === "restore")
				void applyMeta(cid, { title: null }, "Automatic title restored").then(
					(f) => f !== null && showToast(f, true),
				);
			else if (id === "archive" || id === "unarchive") void setArchived(c, id === "archive");
		},
	});
}

async function renameConversation(cid: string): Promise<void> {
	const c = rowOf(cid);
	if (!c) return;
	const auto = automaticTitle(c);
	await promptDialog({
		title: "Rename conversation",
		message: auto
			? `Your name is shown instead of the automatic title (“${auto}”). Leave it empty to go back to the automatic title.`
			: "Your name is shown instead of the automatic title. Leave it empty to go back to the automatic title.",
		label: "Name",
		placeholder: auto ?? "Conversation name",
		initialValue: c.customTitle ?? "",
		confirmLabel: "Save",
		// §6.2: a button back to the automatic title, in the dialog itself.
		alternate: auto ? { label: "Use automatic title", value: "" } : undefined,
		validate: (v) => (v === "" ? null : titleProblem(v)),
		// The dialog stays open until the server answered: a refusal is explained where it was typed.
		onConfirm: (v) =>
			applyMeta(
				cid,
				{ title: v === "" ? null : v },
				v === "" ? "Automatic title restored" : "Renamed",
			),
	});
}

async function setArchived(c: ConversationSummary, archived: boolean): Promise<void> {
	const failure = await applyMeta(c.sessionId, { archived }, archived ? "Archived" : "Unarchived");
	if (failure !== null) showToast(failure, true);
}

/**
 * One rename/archive request. Not optimistic: the row changes when the
 * server answered, with what it answered. Resolves null on success, else
 * the explanation (the caller shows it inline or as a toast).
 */
async function applyMeta(
	cid: string,
	patch: { title?: string | null; archived?: boolean },
	done: string,
): Promise<string | null> {
	const sid = stateSessionId;
	// Never "success" without a request: the rename dialog would close as saved.
	if (sid === null) return "No session is open.";
	if (metaBusy.has(cid))
		return "Another change to this conversation is still in progress. Try again in a moment.";
	const gen = generation;
	metaBusy.add(cid);
	renderList();
	renderThreadHead();
	const r = await patchConversationMeta(sid, cid, patch);
	if (gen !== generation)
		return "The session changed while saving; check the list of that session.";
	metaBusy.delete(cid);
	if (!r.ok) {
		renderList();
		renderThreadHead();
		// The write may have landed: re-read instead of guessing.
		if (metaOutcomeUnknown(r.status, r.code)) void loadList({ quiet: true });
		refocusMeta(cid);
		return explainMetaError(r.status, r.code);
	}
	// Recorded whether or not the row is in view (the list may be reloading right now):
	// a list request that left before this answer must not bring the old state back.
	metaOverlay.record(r.summary, listReq);
	const row = rowOf(cid);
	if (row) {
		// Only the owner's fields: status/binding come from the capture, and a
		// list or socket frame newer than this answer may already be applied.
		row.title = r.summary.title;
		row.customTitle = r.summary.customTitle ?? null;
		row.archivedAt = r.summary.archivedAt ?? null;
	}
	renderSummary();
	renderThreadHead();
	renderList();
	if (announcer) announcer.textContent = `${done}: ${displayTitle(r.summary)}`;
	// The list re-rendered under the person's focus: put it back on this conversation's ⋯ where
	// the action started. A macrotask, so it runs after a dialog's own close/focus-return.
	refocusMeta(cid);
	return null;
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
		} else routeBack();
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
	// Status frames rebuild the header: keep the keyboard on its ⋯ / Agents button.
	const a = document.activeElement;
	const sel =
		a instanceof HTMLElement && head.contains(a)
			? a.dataset.metaWhere === "head"
				? '[data-meta-where="head"]'
				: a.classList.contains("chat-agents-btn")
					? ".chat-agents-btn"
					: null
			: null;
	head.replaceChildren(...threadHeadChildren(c));
	if (sel) head.querySelector<HTMLElement>(sel)?.focus();
}

/**
 * The server's newest probe of the open conversation (in its window, and
 * about the current process) said `kind: background`. Wording only: Chat's
 * input stays decided by the server's canSendInput.
 */
function runsInBackground(c: ConversationSummary): boolean {
	if (!cur || cur.cid !== c.sessionId) return false;
	return buildThread(cur.window.events).runMode?.kind === "background";
}

function threadHeadChildren(c: ConversationSummary): HTMLElement[] {
	const out: HTMLElement[] = [];
	const title = el("div", "chat-thread-title");
	title.appendChild(el("span", "chat-thread-name", titleOf(c)));
	const bits: string[] = [];
	const auto = automaticTitle(c);
	if (c.customTitle?.trim() && auto && auto !== c.customTitle.trim())
		bits.push(`automatic title: ${auto}`);
	if (isArchived(c)) bits.push("archived");
	if (c.kind === "headless" || c.kind === "teammate") bits.push(c.kind);
	if (runsInBackground(c)) bits.push("background session");
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
			`${subagentsWord()} ${agents.length}${running > 0 ? ` · ${running} running` : ""}`,
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
	const conn = connectionChip();
	if (conn) right.appendChild(conn);
	right.appendChild(metaMenuButton(c, "head"));
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
		// The visible height changes without a scroll event — the mobile soft
		// keyboard shrinks the app (`--app-vh`), the composer grows a row. A
		// reader who was at the bottom stays at the bottom; one reading earlier
		// messages keeps their place (scrollTop is untouched then). `atBottom`
		// still holds the pre-resize truth: a shrink fires no scroll event.
		if (typeof ResizeObserver !== "undefined") {
			const sc = scroller;
			new ResizeObserver(() => {
				if (cur?.atBottom && sc.isConnected) setScrollNow(sc, sc.scrollHeight);
			}).observe(sc);
		}
		threadEl.appendChild(scroller);
		threadEl.appendChild(floatPill());
		threadEl.appendChild(composer());
	}
	syncOffline();
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
	renderPendingBubble();
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

/**
 * What the CLI's own helpers inside a conversation are called. With the
 * project directory on (P3a), "agents" are the project's team agents, so
 * these become "Subagents" (design 15, D-UX7); with it off, nothing changes.
 */
function subagentsWord(): string {
	return projectChatEnabled() ? "Subagents" : "Agents";
}

function renderAgents(): void {
	const open = agentsOpen && selectedCid !== null && cur !== null;
	agentsEl.hidden = !open;
	if (!open || !cur) return;
	const agents = buildThread(cur.window.events).agents;
	agentsEl.replaceChildren();
	const head = el("div", "chat-agents-head");
	agentsEl.setAttribute("aria-label", subagentsWord());
	head.appendChild(el("h3", undefined, `${subagentsWord()} · ${agents.length}`));
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
	const want = pendingAgentFocus;
	if (want && want.cid === selectedCid) {
		pendingAgentFocus = null;
		const card = ul.querySelector<HTMLElement>(`[data-agent="${CSS.escape(want.agentId)}"]`);
		if (card) {
			card.classList.add("focused");
			card.scrollIntoView({ block: "nearest" });
		}
	}
}

function agentCard(a: AgentView): HTMLElement {
	const li = el("li", `chat-agent ${a.status}`);
	li.dataset.agent = a.agentId;
	const top = el("div", "chat-agent-top");
	top.appendChild(el("span", "chat-agent-type", a.agentType || "agent"));
	// "done" is confirmed by a SubagentStop; without one the agent is only
	// "started, no end yet" — never presented as working (nothing times it out).
	if (a.status === "done")
		top.appendChild(
			statusChip(
				{ status: "ended", evidence: "", at: a.endedAt ?? a.startedAt },
				{ staleness: false },
			),
		);
	else {
		const chip = el("span", "chat-status tone-muted");
		chip.appendChild(el("span", "chat-dot"));
		chip.appendChild(el("span", "chat-status-label", "Started, no end yet"));
		top.appendChild(chip);
	}
	li.appendChild(top);
	const bits: string[] = [a.agentId.slice(0, 8)];
	bits.push(`${a.toolIds.size} tool${a.toolIds.size === 1 ? "" : "s"}`);
	if (a.failedToolIds.size > 0) bits.push(`${a.failedToolIds.size} failed`);
	const started = new Date(a.startedAt).getTime();
	const ended = a.endedAt ? new Date(a.endedAt).getTime() : Date.now();
	// Without an end event the span to now is not a run time (the end may
	// just be missing): say when it started instead.
	if (!Number.isNaN(started) && !Number.isNaN(ended) && ended >= started)
		bits.push(a.endedAt ? duration(ended - started) : `started ${duration(ended - started)} ago`);
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
		li.appendChild(el("div", "chat-note", "No end reported yet, so no result to show."));
	}
	return li;
}

// ── Composer (3.2) ──────────────────────────────────────────────────────────
// CONVERSATION.md §8. The server decides everything; this is the person's
// side of it: one draft per conversation, one clientMessageId per click,
// never an automatic retry, and every refusal shown in the server's words.

interface ComposerNotice {
	tone: "info" | "warn" | "error";
	text: string;
	/** A partial delivery (§8.1.6): the next send waits for the person to confirm they looked at the Terminal. */
	blockUntilChecked?: boolean;
	/** `misdelivered`: the conversation the text landed in. */
	conversation?: string;
	/** v1.9 §8.1.12.8: the one-time background notice — Send waits for "I understand". */
	confirmBackground?: boolean;
	/** v1.9: `accepted` has its own indicator, never the delivered ✓. */
	indicator?: "accepted";
}
interface ComposerState {
	/** The project the conversation belongs to: the stored draft's key. */
	sessionId: string | null;
	draft: string;
	sending: boolean;
	notice: ComposerNotice | null;
	/** The optimistic bubble: shown until the matching `user_prompt` arrives or the send is not delivered. */
	pending: { id: string; text: string; sentAt: number } | null;
	checked: boolean;
	/**
	 * v1.9 §8.1.12.6: a background send Claude Code ACCEPTED (not delivered).
	 * The draft is kept and locked until the send's final state arrives as a
	 * `composer_send` event: delivered/misdelivered clear it; unconfirmed,
	 * failed or uncertain keep it and ask to check the Terminal.
	 */
	accepted: { id: string } | null;
	/** The send in flight goes through the background transport. */
	background: boolean;
	/**
	 * D1: a background send of this text that ended `unconfirmed`. The next
	 * send, once the person confirmed they checked the Terminal, carries its
	 * id so the server records the acknowledgement (durable, server-side).
	 */
	unconfirmedId: string | null;
}

/**
 * v1.9 §8.1.12.8: the background notice is shown once per conversation (per
 * page life — a reload shows it again, which errs on the side of saying it).
 */
const backgroundNoticeSeen = new Set<string>();
const composerStates = new Map<string, ComposerState>();
function composerStateFor(cid: string): ComposerState {
	let st = composerStates.get(cid);
	if (!st) {
		const sessionId = stateSessionId;
		// A draft left on this browser (a reload, a closed tab) comes back as
		// text in the box — never as a send.
		const draft = sessionId !== null ? readDraft(sessionId, cid) : "";
		st = {
			sessionId,
			draft,
			sending: false,
			notice: null,
			pending: null,
			checked: false,
			accepted: null,
			background: false,
			unconfirmedId: null,
		};
		composerStates.set(cid, st);
	}
	return st;
}

function setDraft(cid: string, st: ComposerState, text: string): void {
	st.draft = text;
	if (st.sessionId !== null) writeDraft(st.sessionId, cid, text);
}

/** Logout: the next account on this browser starts with no composer state at all. */
export function forgetComposerState(): void {
	composerStates.clear();
	backgroundNoticeSeen.clear();
	forgetAllDrafts();
}

/** Why the composer is disabled right now, in the person's words; null when it can send. */
function composerBlockReason(c: ConversationSummary | undefined, st: ComposerState): string | null {
	if (!c) return "Open a conversation to send a message.";
	if (c.composer?.blocked) return explainCode("send-in-progress", c.composer.reason);
	// Over, or lost: say that before anything about the pane.
	if (c.status === "ended" || c.status === "ending")
		return "This conversation has ended. Start a new one in the terminal.";
	if (c.status === "disconnected" || c.status === "error")
		return "This conversation is no longer reachable from Chat.";
	if (!c.canSendInput) {
		if (c.kind !== "interactive")
			return "Only an interactive Claude Code session can take a message from Chat.";
		if (list.status === "loaded" && list.capture && !list.capture.effective)
			return "Capture is not active on this session, so a send could not be confirmed.";
		// The backend took the pane away from this conversation (another one
		// started or resumed in it, or the container went down): its history
		// stays readable here, input goes through the terminal.
		// paneId, not tabId: the tab can be unknown on a well-bound pane
		// (the hook carried no tmux session), and canSendInput follows the pane.
		// Two different situations, said apart (B, 2026-11-05: a background
		// Claude session was told "another conversation took it over"):
		// - binding_lost: another conversation started in its pane;
		// - no pane ever: its hooks carry none (e.g. Claude runs it as a
		//   background session) — nothing was taken; Chat just cannot prove
		//   where a message would go.
		if (c.statusEvidence === "binding_lost")
			return "This conversation no longer has a terminal pane — another conversation started in it, or the session was restarted. Its history stays readable; type in the Terminal to continue.";
		if (c.paneId === null && runsInBackground(c))
			return "Claude Code runs this conversation as a background session. The terminal shows a client attached to it, not the conversation itself, so Chat can't prove where a message would land and doesn't send. Its history stays live here; to write to it, type in the Terminal.";
		if (c.paneId === null)
			return "Chat can't tie this conversation to a terminal pane, so it can't confirm where a message would go (for example, Claude runs it as a background session). Its history stays readable; type in the Terminal to continue.";
		return "Sending from Chat is not available for this conversation.";
	}
	// The CLI must be at its prompt (§10 "3.2 composer": waiting_input/idle). The
	// server decides anyway (409 busy / needs-terminal); this only explains the
	// obvious case before a request. A live claim with stale evidence does not
	// block — the list may be behind, and the server has the fresh probe.
	const stale =
		statusIsLiveClaim(c.status) && Date.now() - Date.parse(lastEvidenceAt(c)) > STALE_EVIDENCE_MS;
	if (!stale) {
		if (c.status === "running") return "Claude is working; wait for the turn to finish.";
		if (c.status === "waiting_permission")
			return "A permission prompt is open in the terminal. Answer it there first.";
		if (c.status === "unknown")
			return "State unknown — Claude Code hasn't reported since it started or resumed. It updates when it reports or a check confirms it's at its prompt; typing in the Terminal also updates it.";
		if (c.status !== "waiting_input" && c.status !== "waiting_background")
			return "This conversation is not at its prompt.";
	}
	if (st.sending) return "Sending…";
	if (st.accepted) return BG_TEXT.accepted;
	if (st.notice?.blockUntilChecked && !st.checked)
		return "Check the Terminal for partial text, then confirm below.";
	return null;
}

/**
 * Whether the textarea takes typing — separate from whether Send is enabled.
 * While Claude is working, waiting on a permission or not yet confirmed at
 * its prompt (or another send is settling), the person can write the next
 * message; Send stays off until the composer allows it, and nothing is ever
 * sent on its own when that changes (no queue: the click is the send). Kept
 * off where a draft cannot go anywhere (ended, unreachable, no pane, not
 * interactive), while a send is in flight, and after a failed delivery until
 * the Terminal has been checked.
 */
function composerDraftable(c: ConversationSummary | undefined, st: ComposerState): boolean {
	if (!c || st.sending) return false;
	// Accepted by Claude Code: the draft stays, locked, until the outcome is known.
	if (st.accepted) return false;
	if (st.notice?.blockUntilChecked && !st.checked) return false;
	if (
		c.status === "ended" ||
		c.status === "ending" ||
		c.status === "disconnected" ||
		c.status === "error"
	)
		return false;
	return c.canSendInput || c.composer?.blocked === true;
}

/**
 * Grow the textarea with its content; CSS max-height caps it, then it scrolls.
 * The measurement collapses the box to one row for a moment, which lets the
 * thread above clamp its scrollTop; the reader's place is put back after
 * (kept at the bottom if they were there), or every keystroke of a long
 * draft would pull the thread up while Claude streams.
 */
function autosize(ta: HTMLTextAreaElement): void {
	if (!ta.isConnected) return;
	const sc = threadScroller();
	const top = sc?.scrollTop ?? 0;
	// The tracked state, not a live read: it is the pre-measure truth.
	const stick = sc !== null && (cur?.atBottom ?? nearBottom(sc));
	ta.style.height = "auto";
	if (ta.scrollHeight > 0) ta.style.height = `${ta.scrollHeight + 2}px`;
	// Instant, not the scroller's smooth behaviour: an animated restore fires
	// scroll events mid-way that would mark the reader as not at the bottom.
	if (sc) setScrollNow(sc, stick ? sc.scrollHeight : top);
}

function composer(): HTMLElement {
	const box = el("div", "chat-composer");
	const c = selected();
	const cid = selectedCid;
	if (cid) box.dataset.cid = cid;
	const st = cid ? composerStateFor(cid) : null;
	const row = el("div", "chat-composer-row");
	const ta = el("textarea");
	ta.rows = 1;
	ta.setAttribute("aria-label", "Message to Claude");
	ta.setAttribute("aria-describedby", "chat-composer-status");
	const sendBtn = button("Send", "files-btn primary chat-send", () => void submitComposer());
	const reason = st ? composerBlockReason(c, st) : "Open a conversation to send a message.";
	const can = reason === null;
	ta.disabled = !(st && composerDraftable(c, st));
	sendBtn.disabled = !can;
	// The reason a send is blocked lives in the status line only; the
	// placeholder repeating it was cut off on narrow screens.
	ta.placeholder = "Message Claude…";
	if (st) {
		ta.value = st.draft;
		ta.addEventListener("input", () => {
			setDraft(cid as string, st, ta.value);
			autosize(ta);
		});
		// Measured once it is in the document.
		requestAnimationFrame(() => autosize(ta));
	}
	ta.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			void submitComposer();
		}
	});
	const status = composerStatus(st, reason, st !== null && composerDraftable(c, st));
	row.appendChild(ta);
	row.appendChild(sendBtn);
	box.appendChild(status);
	box.appendChild(row);
	return box;
}

/**
 * "Open terminal" for a conversation goes to ITS tab — the one whose pane runs
 * that Claude — and says which. When the tab is unknown (the hook carried no
 * tmux session) or no longer listed, the label says so before the click, and
 * the click shows the Terminal without switching tabs.
 */
function openTerminalButton(c: ConversationSummary | undefined): HTMLButtonElement {
	if (!c) return button("Open terminal", "chat-link", () => setView("terminal"));
	const tab = c.tabId ? currentTabs.find((t) => t.tabId === c.tabId) : undefined;
	const label = tab ? `Open terminal · ${tab.label}` : "Open terminal (its tab is unknown)";
	const b = button(label, "chat-link", () => {
		// A listed tab that could not be opened is the one case to warn about;
		// a stopped session shows its own state in the Terminal.
		const r = showTerminalTab(c.tabId);
		// The button named a tab and it was not opened (gone from the list
		// since, or the switch failed): say so. A stopped session shows its
		// own state in the Terminal.
		if (tab && (r === "failed" || r === "unknown"))
			showToast(`Could not switch to ${tab.label}; check the active tab before typing.`, true);
	});
	b.dataset.openTerminalTab = tab?.tabId ?? "";
	return b;
}

/** The composer's status line: the notice, or the hint, or the block reason. */
function composerStatus(
	st: ComposerState | null,
	reason: string | null,
	draftable: boolean,
): HTMLElement {
	const status = el("div", "chat-composer-status");
	// The textarea points here (aria-describedby): a blocked composer's
	// reason is read with it, now that the placeholder no longer carries it.
	status.id = "chat-composer-status";
	const can = reason === null;
	if (st?.notice) {
		status.classList.add(st.notice.tone);
		if (st.notice.indicator === "accepted") {
			status.classList.add("accepted");
			// Its own mark: a clock, never the delivered check.
			status.appendChild(el("span", "chat-composer-accepted", "◷"));
		}
		status.appendChild(el("span", undefined, st.notice.text));
		if (st.notice.confirmBackground) {
			const cidNow = selectedCid;
			status.appendChild(
				button("I understand — send", "chat-link", () => {
					if (cidNow) backgroundNoticeSeen.add(cidNow);
					st.notice = null;
					void submitComposer();
				}),
			);
		}
		if (st.notice.conversation) {
			const target = st.notice.conversation;
			status.appendChild(button("Open it", "chat-link", () => void openConversation(target)));
		}
		if (st.notice.blockUntilChecked && !st.checked) {
			status.appendChild(
				button("I checked the Terminal", "chat-link", () => {
					st.checked = true;
					renderComposer();
				}),
			);
		}
		status.appendChild(openTerminalButton(selected()));
	} else if (can) {
		// Narrow (mobile) layout: the Send button is the affordance there.
		status.appendChild(
			el(
				"span",
				undefined,
				isMobile()
					? "/ and ! commands belong in the Terminal"
					: "Ctrl+Enter sends · / and ! commands belong in the Terminal",
			),
		);
	} else {
		status.appendChild(el("span", undefined, reason ?? ""));
		// Typing is open while Send waits: say what happens to the draft.
		if (draftable && reason !== null)
			status.appendChild(
				el(
					"span",
					"chat-composer-draft-note",
					// A send settling on the pane clears on the backend, not when
					// Claude reaches its prompt: say which wait this is.
					selected()?.composer?.blocked
						? "You can keep writing; Send turns on once the previous send is settled."
						: "You can keep writing; Send turns on when Claude is ready.",
				),
			);
		status.appendChild(openTerminalButton(selected()));
	}
	return status;
}

/**
 * Re-render only the composer (keeps the thread's DOM and scroll). The
 * textarea is updated IN PLACE when it already belongs to the selected
 * conversation: replacing it on every list poll would reset the caret and
 * drop an in-progress IME composition while the person types.
 */
function renderComposer(): void {
	const old = threadEl.querySelector<HTMLElement>(".chat-composer");
	if (!old) return;
	const cid = selectedCid;
	const ta = old.querySelector<HTMLTextAreaElement>("textarea");
	if (!ta || !cid || old.dataset.cid !== cid) {
		const hadFocus = old.contains(document.activeElement);
		const fresh = composer();
		old.replaceWith(fresh);
		if (hadFocus) {
			const nta = fresh.querySelector<HTMLTextAreaElement>("textarea");
			nta?.focus();
			nta?.setSelectionRange(nta.value.length, nta.value.length);
		}
		return;
	}
	const st = composerStateFor(cid);
	const reason = composerBlockReason(selected(), st);
	const can = reason === null;
	ta.disabled = !composerDraftable(selected(), st);
	// The reason a send is blocked lives in the status line only; the
	// placeholder repeating it was cut off on narrow screens.
	ta.placeholder = "Message Claude…";
	// The draft is the state; the DOM follows it only when they differ (a
	// send cleared it, a result restored it), never while they agree.
	if (ta.value !== st.draft) {
		ta.value = st.draft;
		autosize(ta);
	}
	const sendBtn = old.querySelector<HTMLButtonElement>(".chat-send");
	if (sendBtn) sendBtn.disabled = !can;
	const status = old.querySelector<HTMLElement>(".chat-composer-status");
	if (status) status.replaceWith(composerStatus(st, reason, composerDraftable(selected(), st)));
}

async function submitComposer(): Promise<void> {
	const sid = stateSessionId;
	const cid = selectedCid;
	if (sid === null || cid === null) return;
	const st = composerStateFor(cid);
	if (st.sending || composerBlockReason(selected(), st) !== null) return;
	const v = validateText(st.draft);
	if (!v.ok) {
		st.notice = { tone: "error", text: explainCode(v.code) };
		renderComposer();
		return;
	}
	// v1.9 §8.1.12.8: before the first send to a background session, say
	// what "accepted" means and that it can't be cancelled from Chat; the
	// send waits for the person's "I understand".
	const background = selected()?.transport === "background";
	if (background && !backgroundNoticeSeen.has(cid)) {
		st.notice = { tone: "info", text: BG_TEXT.notice, confirmBackground: true };
		renderComposer();
		return;
	}
	st.background = background;
	// D1: decided before `checked` is reset for this send.
	const ack = st.checked && st.unconfirmedId ? st.unconfirmedId : undefined;
	// One id per click (§8.1.4): a resend is the person's new action.
	const id = crypto.randomUUID();
	st.sending = true;
	st.checked = false;
	st.notice = { tone: "info", text: "Sending…" };
	st.pending = { id, text: v.normalized, sentAt: Date.now() };
	renderComposer();
	renderPendingBubble();
	try {
		const r = await sendConversationMessage(
			sid,
			cid,
			st.draft,
			id,
			ack ? { acknowledgeUnconfirmed: ack } : {},
		);
		if (ack && r.status >= 200 && r.status < 300) st.unconfirmedId = null;
		applyComposerResult(cid, r.status, r.body);
	} catch (err) {
		st.pending = null;
		st.notice = { tone: "error", text: `Send failed: ${(err as Error).message}` };
	} finally {
		st.sending = false;
		renderComposer();
		renderPendingBubble();
		// The pane's blocking state and canSendInput come from the list.
		void loadList({ quiet: true });
	}
}

function applyComposerResult(
	cid: string,
	status: number,
	body: Awaited<ReturnType<typeof sendConversationMessage>>["body"],
): void {
	const st = composerStateFor(cid);
	if (status === 202) {
		switch (body.result) {
			case "delivered":
				setDraft(cid, st, "");
				st.notice = st.background ? { tone: "info", text: BG_TEXT.delivered } : null;
				// The bubble stays until the real `user_prompt` arrives over the socket.
				return;
			case "accepted":
				// NOT delivered: the draft stays (locked), the bubble says so.
				st.accepted = { id: st.pending?.id ?? body.clientMessageId ?? "" };
				st.notice = { tone: "info", text: BG_TEXT.accepted, indicator: "accepted" };
				return;
			case "misdelivered":
				setDraft(cid, st, "");
				st.pending = null;
				st.notice = {
					tone: "info",
					text: "Delivered, but to another conversation of this pane.",
					conversation: body.conversation,
				};
				return;
			case "unconfirmed":
				if (st.background) st.unconfirmedId = body.clientMessageId ?? st.pending?.id ?? null;
				st.pending = null;
				st.notice = st.background
					? { tone: "warn", text: BG_TEXT.unconfirmed, blockUntilChecked: true }
					: {
							tone: "warn",
							text: "Claude Code did not confirm the message — check the Terminal. It was not retried.",
						};
				return;
			case "uncertain":
				st.pending = null;
				st.notice = st.background
					? { tone: "warn", text: BG_TEXT.uncertain, blockUntilChecked: true }
					: {
							tone: "warn",
							text: "The outcome is not known yet; the pane stays blocked until it is verified. Nothing is retried.",
						};
				return;
		}
	}
	st.pending = null;
	// D1: an earlier identical background send is unconfirmed: the person
	// checks the Terminal, confirms, and the next send acknowledges it.
	if (
		status === 409 &&
		body.error === "duplicate-pending" &&
		body.detail === "unconfirmed-unacknowledged" &&
		body.clientMessageId
	) {
		st.unconfirmedId = body.clientMessageId;
		st.notice = {
			tone: "warn",
			text: explainCode("duplicate-pending", body.detail),
			blockUntilChecked: true,
		};
		return;
	}
	if (status === 502 && body.error === "delivery-failed" && st.background) {
		st.notice = {
			tone: "error",
			text: `${BG_TEXT.failed} (${body.detail ?? "refused"})`,
			blockUntilChecked: true,
		};
		return;
	}
	if (status === 502 && body.error === "delivery-failed") {
		st.notice = {
			tone: "error",
			text: `${explainCode("delivery-failed")} (${body.segmentsSent ?? 0} of ${body.segments ?? "?"} parts were pasted.)`,
			blockUntilChecked: true,
		};
		return;
	}
	st.notice = { tone: "error", text: explainCode(body.error ?? `http-${status}`, body.detail) };
}

/**
 * v1.9 §8.1.12.6: an `accepted` background send learns its outcome from its
 * own `composer_send` events in the window. delivered / misdelivered clear
 * the draft; unconfirmed / failed / uncertain keep it and the next send asks
 * to check the Terminal. Returns whether anything changed.
 */
function settleAccepted(cid: string, st: ComposerState): boolean {
	if (!st.accepted || !cur || cur.cid !== cid) return false;
	const id = st.accepted.id;
	let final: string | null = null;
	let target: string | undefined;
	for (const e of cur.window.events) {
		if (e.ev !== "composer_send") continue;
		const d = e.data as Record<string, unknown>;
		if (d.client_message_id !== id) continue;
		const s = typeof d.state === "string" ? d.state : "";
		if (
			["delivered", "misdelivered", "unconfirmed", "failed", "uncertain", "resolved"].includes(s)
		) {
			final = s;
			if (typeof d.misdelivered_to === "string") target = d.misdelivered_to;
		}
	}
	if (final === null) return false;
	st.accepted = null;
	if (final === "delivered" || final === "misdelivered") {
		setDraft(cid, st, "");
		st.notice =
			final === "delivered"
				? { tone: "info", text: BG_TEXT.delivered }
				: { tone: "info", text: BG_TEXT.misdelivered, conversation: target };
		if (final === "misdelivered") st.pending = null;
		return true;
	}
	st.pending = null;
	if (final === "unconfirmed") st.unconfirmedId = id;
	st.notice = {
		tone: "warn",
		text:
			final === "unconfirmed"
				? BG_TEXT.unconfirmed
				: final === "failed"
					? BG_TEXT.failed
					: BG_TEXT.uncertain,
		blockUntilChecked: true,
	};
	return true;
}

/**
 * The optimistic bubble (§10 "3.2 composer"): appended under the thread
 * while a send is in flight or delivered-but-not-yet-seen, removed as soon
 * as a `user_prompt` with the same normalized text is in the window.
 */
function renderPendingBubble(): void {
	const sc = threadScroller();
	if (!sc || !cur) return;
	const st = composerStates.get(cur.cid);
	if (st && settleAccepted(cur.cid, st)) renderComposer();
	sc.querySelector(".chat-pending")?.remove();
	if (!st?.pending) return;
	// The CLI's own prompt for this send: a human `user_prompt` with the same
	// normalized text, not older than the send. Scanned on the raw events,
	// newest first — never a second thread build per live event.
	const pending = st.pending;
	const background = st.background;
	const seen = (() => {
		const evs = cur.window.events;
		// v1.9 §8.1.12.8: a background send's bubble yields ONLY to the
		// user_prompt of its own ack (the prompt_id its `delivered` names) —
		// never to the same words typed in the Terminal.
		if (background) {
			const acked = evs.find(
				(e) =>
					e.ev === "composer_send" &&
					(e.data as Record<string, unknown>).client_message_id === pending.id &&
					(e.data as Record<string, unknown>).state === "delivered",
			);
			const pid = acked ? (acked.data as Record<string, unknown>).prompt_id : undefined;
			return (
				typeof pid === "string" && evs.some((e) => e.ev === "user_prompt" && e.prompt_id === pid)
			);
		}
		for (let i = evs.length - 1; i >= 0; i--) {
			const e = evs[i]!;
			if (Date.parse(e.ts) < pending.sentAt - 60_000) break;
			if (e.ev !== "user_prompt") continue;
			const d = e.data as Record<string, unknown>;
			if (d.origin === "unverified" || (d.source !== undefined && d.source !== "user")) continue;
			if (typeof d.prompt === "string" && normalizeText(d.prompt) === pending.text) return true;
		}
		return false;
	})();
	if (seen) {
		st.pending = null;
		return;
	}
	const bubble = el("article", "chat-msg chat-user chat-pending");
	bubble.appendChild(meta("You", new Date(st.pending.sentAt).toISOString()));
	bubble.appendChild(el("div", "chat-text", st.pending.text));
	bubble.appendChild(
		el(
			"div",
			st.accepted ? "chat-pending-state accepted" : "chat-pending-state",
			st.sending
				? "Sending…"
				: st.accepted
					? BG_TEXT.accepted
					: "Delivered — waiting for it to appear",
		),
	);
	sc.appendChild(bubble);
	if (cur.atBottom) sc.scrollTop = sc.scrollHeight;
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
