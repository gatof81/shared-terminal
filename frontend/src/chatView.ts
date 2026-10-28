/**
 * chatView.ts — the Chat overlay (Phase 3.1, docs/CONVERSATION.md §6 and
 * design §6): the session's captured Claude conversations, read-only.
 *
 * Desktop: conversation list on the left, the thread on the right. Mobile:
 * one pane at a time (list → thread, with a "‹ Conversations" back
 * button), no horizontal scroll. Same overlay mechanics as Files and Git
 * (viewSwitch.ts), so switching here never touches the terminal.
 *
 * Data: `GET …/conversations` for the list; for the open conversation the
 * newest page of `GET …/events`, older pages on demand, and the
 * conversation WS from the newest seq on (live, with reconnect and resync
 * handled in api.ts). The thread is derived from the event window by
 * conversationModel.ts; the DOM is rebuilt only for items whose content
 * changed (keyed), so streaming text doesn't re-render the whole thread.
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
	type ThreadItem,
	toolLine,
} from "./conversationModel.js";
import { formatBytes, relativeDate } from "./format.js";
import { activeSessionId, isMobile, sessions, showToast } from "./main.js";
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

// ── State ───────────────────────────────────────────────────────────────────

type ListState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "loaded"; capture: ConversationCapture; conversations: ConversationSummary[] }
	| { status: "error"; message: string };

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
const window_ = new EventWindow();
let socket: ConversationSocket | null = null;
let liveConnected = false;
let liveStatus: { status: string; evidence: string; at: string } | null = null;
let mobilePane: "list" | "thread" = "list";
let listTimer: ReturnType<typeof setInterval> | null = null;
let renderQueued = false;
/** Keyed DOM cache of thread items: rebuilt only when the signature changes. */
const itemNodes = new Map<string, { sig: string; node: HTMLElement }>();

const STATUS_LABEL: Record<string, string> = {
	running: "Working",
	waiting_input: "Waiting for input",
	waiting_background: "Background tasks",
	waiting_permission: "Needs permission",
	error: "Error",
	ending: "Ending",
	ended: "Ended",
	disconnected: "Disconnected",
	unknown: "Unknown",
};

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
	window_.reset();
	liveStatus = null;
	mobilePane = "list";
	itemNodes.clear();
}

refreshBtn.addEventListener("click", () => {
	void loadList();
	if (selectedCid !== null) void openConversation(selectedCid);
});
backBtn.addEventListener("click", () => {
	mobilePane = "list";
	renderAll();
});

function startListPoll(): void {
	stopListPoll();
	// The list carries the capture block, which costs a relay probe (D7):
	// poll gently, and only while the list is what's on screen.
	listTimer = setInterval(() => {
		if (!isActive() || document.hidden) return;
		if (isMobile() && mobilePane === "thread") return;
		void loadList({ quiet: true });
	}, 30_000);
}
function stopListPoll(): void {
	if (listTimer) clearInterval(listTimer);
	listTimer = null;
}

// ── Data ────────────────────────────────────────────────────────────────────

async function loadList(opts: { quiet?: boolean } = {}): Promise<void> {
	const sid = stateSessionId;
	if (sid === null) return;
	const gen = generation;
	if (!opts.quiet || list.status !== "loaded") {
		list = { status: "loading" };
		renderAll();
	}
	refreshBtn.classList.add("spinning");
	try {
		const data = await fetchConversations(sid);
		if (gen !== generation) return;
		list = { status: "loaded", capture: data.capture, conversations: data.conversations };
	} catch (err) {
		if (gen !== generation) return;
		if (!opts.quiet) list = { status: "error", message: (err as Error).message };
	} finally {
		if (gen === generation) refreshBtn.classList.remove("spinning");
	}
	renderAll();
}

async function openConversation(cid: string): Promise<void> {
	const sid = stateSessionId;
	if (sid === null) return;
	const gen = ++threadGen;
	selectedCid = cid;
	threadStatus = "loading";
	threadError = "";
	window_.reset();
	itemNodes.clear();
	liveStatus = null;
	mobilePane = "thread";
	renderAll();
	try {
		const page = await fetchConversationEvents(sid, cid, { limit: 200 });
		if (gen !== threadGen) return;
		window_.setLatest(page.events, page.hasMore);
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

async function loadOlder(): Promise<void> {
	const sid = stateSessionId;
	const cid = selectedCid;
	const first = window_.firstSeq();
	if (sid === null || cid === null || first === null || loadingOlder()) return;
	const gen = threadGen;
	loadingOlderGen = gen;
	renderAll();
	// Keep the reader's place: measure from the bottom, restore after.
	const fromBottom = threadScroller()?.scrollHeight ?? 0;
	const top = threadScroller()?.scrollTop ?? 0;
	try {
		const page = await fetchConversationEvents(sid, cid, { before: first, limit: 200 });
		if (gen !== threadGen) return;
		window_.prepend(page.events, page.hasMore);
	} catch (err) {
		if (gen === threadGen)
			showToast(`Could not load earlier events: ${(err as Error).message}`, true);
	} finally {
		if (loadingOlderGen === gen) loadingOlderGen = null;
	}
	if (gen !== threadGen) return;
	renderAll();
	const sc = threadScroller();
	if (sc) sc.scrollTop = sc.scrollHeight - fromBottom + top;
}

function jumpToLatest(): void {
	if (selectedCid !== null) void openConversation(selectedCid);
}

function openSocket(): void {
	const sid = stateSessionId;
	const cid = selectedCid;
	if (sid === null || cid === null || threadStatus !== "loaded" || !isActive()) return;
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
				renderSummary();
			},
		);
	}
	socket.follow(cid, window_.lastSeq);
}

function closeSocket(): void {
	socket?.close();
	socket = null;
	liveConnected = false;
}

function onFrame(f: ConversationServerFrame): void {
	if (f.type === "event" && f.conv === selectedCid) {
		if (window_.append(f.event) || !window_.atLatest) scheduleRender();
	} else if (f.type === "status" && f.conv === selectedCid) {
		liveStatus = { status: f.status, evidence: f.evidence, at: f.at };
		renderSummary();
	} else if (f.type === "gap" && f.conv === selectedCid) {
		// Our cursor fell behind the retained history: start from the newest.
		jumpToLatest();
	} else if (f.type === "error" && f.conv === selectedCid && f.code === "not-found") {
		closeSocket();
	}
}

// ── Rendering ───────────────────────────────────────────────────────────────

function scheduleRender(): void {
	if (renderQueued) return;
	renderQueued = true;
	requestAnimationFrame(() => {
		renderQueued = false;
		renderThread({ stick: true });
	});
}

function renderAll(opts: { scrollToEnd?: boolean } = {}): void {
	if (!isActive()) return;
	bodyEl.classList.toggle("show-thread", mobilePane === "thread" && selectedCid !== null);
	backBtn.hidden = !(isMobile() && mobilePane === "thread" && selectedCid !== null);
	renderSummary();
	renderList();
	renderThread({ stick: opts.scrollToEnd === true });
}

function selected(): ConversationSummary | undefined {
	return list.status === "loaded"
		? list.conversations.find((c) => c.sessionId === selectedCid)
		: undefined;
}

function titleOf(c: ConversationSummary): string {
	return c.title?.trim() || (c.kind === "headless" ? "Headless run" : "Untitled conversation");
}

function statusChip(status: string, evidence?: string, at?: string): HTMLElement {
	const chip = el("span", `chat-status chat-status-${status}`, STATUS_LABEL[status] ?? status);
	if (evidence || at) chip.title = [evidence, at ? clock(at) : ""].filter(Boolean).join(" · ");
	return chip;
}

function renderSummary(): void {
	summaryEl.replaceChildren();
	const c = selected();
	if (c && (!isMobile() || mobilePane === "thread")) {
		summaryEl.appendChild(el("span", "chat-summary-title", titleOf(c)));
		const st = liveStatus ?? { status: c.status, evidence: c.statusEvidence, at: c.statusAt };
		summaryEl.appendChild(statusChip(st.status, st.evidence, st.at));
		const live = el(
			"span",
			`chat-live ${liveConnected ? "on" : "off"}`,
			liveConnected ? "live" : "offline",
		);
		live.title = liveConnected ? "Receiving new events" : "Not connected — reconnecting";
		summaryEl.appendChild(live);
		return;
	}
	summaryEl.appendChild(el("span", "chat-summary-title", "Conversations"));
	if (list.status === "loaded") {
		summaryEl.appendChild(el("span", "git-summary-count", String(list.conversations.length)));
	}
}

function captureBanner(capture: ConversationCapture): HTMLElement | null {
	if (capture.effective) return null;
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

function renderList(): void {
	listEl.replaceChildren();
	if (list.status === "idle" || list.status === "loading") {
		listEl.appendChild(stateBox("loading", "Loading conversations…"));
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
		listEl.appendChild(
			stateBox(
				"empty",
				"No conversations recorded yet. Use Claude in the terminal and they will appear here.",
			),
		);
		return;
	}
	const ul = el("ul", "chat-conv-list");
	for (const c of list.conversations) {
		const li = el("li");
		const row = el("button", "chat-conv-row");
		row.type = "button";
		if (c.sessionId === selectedCid) row.classList.add("selected");
		row.setAttribute("aria-current", String(c.sessionId === selectedCid));
		const top = el("span", "chat-conv-top");
		top.appendChild(el("span", "chat-conv-title", titleOf(c)));
		top.appendChild(statusChip(c.status, c.statusEvidence, c.statusAt));
		row.appendChild(top);
		const meta = el("span", "chat-conv-meta");
		const bits = [relativeDate(c.lastEventAt), `${c.eventsCount} events`];
		if (c.kind !== "interactive" && c.kind !== "unknown") bits.push(c.kind);
		if (c.gapsCount > 0) bits.push(`${c.gapsCount} gap${c.gapsCount === 1 ? "" : "s"}`);
		meta.textContent = bits.join(" · ");
		row.appendChild(meta);
		row.addEventListener("click", () => void openConversation(c.sessionId));
		li.appendChild(row);
		ul.appendChild(li);
	}
	listEl.appendChild(ul);
}

function threadScroller(): HTMLElement | null {
	return threadEl.querySelector<HTMLElement>(".chat-scroll");
}

function renderThread(opts: { stick: boolean }): void {
	if (!isActive()) return;
	if (selectedCid === null) {
		threadEl.replaceChildren(
			stateBox("empty", isMobile() ? "" : "Select a conversation to read it."),
		);
		return;
	}
	if (threadStatus === "loading") {
		threadEl.replaceChildren(stateBox("loading", "Loading conversation…"));
		return;
	}
	if (threadStatus === "error") {
		threadEl.replaceChildren(
			stateBox(
				"error",
				threadError,
				button("Retry", "files-btn", () => selectedCid && void openConversation(selectedCid)),
			),
		);
		return;
	}
	let scroller = threadScroller();
	const atBottom =
		scroller !== null && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
	if (!scroller) {
		threadEl.replaceChildren();
		scroller = el("div", "chat-scroll");
		threadEl.appendChild(scroller);
		threadEl.appendChild(composer());
	}
	const model = buildThread(window_.events);
	const nodes: HTMLElement[] = [];
	if (window_.hasOlder) {
		nodes.push(
			button(
				loadingOlder() ? "Loading…" : "Load earlier",
				"files-btn chat-older",
				() => void loadOlder(),
			),
		);
	} else {
		const c = selected();
		if (c && c.firstRetainedSeq > 1) {
			nodes.push(el("div", "chat-marker info", "Earlier events are no longer available"));
		}
	}
	if (model.agents.length > 0) nodes.push(agentsBox(model.agents));
	const seen = new Set<string>();
	for (const item of model.items) {
		seen.add(item.key);
		const sig = signature(item);
		const cached = itemNodes.get(item.key);
		if (cached && cached.sig === sig) {
			nodes.push(cached.node);
		} else {
			const node = renderItem(item);
			itemNodes.set(item.key, { sig, node });
			nodes.push(node);
		}
	}
	for (const k of itemNodes.keys()) if (!seen.has(k)) itemNodes.delete(k);
	if (model.items.length === 0) {
		nodes.push(stateBox("empty", "No events in this conversation yet."));
	}
	if (!window_.atLatest) {
		nodes.push(
			button(
				window_.newerUnseen > 0
					? `${window_.newerUnseen} new event${window_.newerUnseen === 1 ? "" : "s"} — jump to latest`
					: "Jump to latest",
				"files-btn chat-latest",
				jumpToLatest,
			),
		);
	}
	scroller.replaceChildren(...nodes);
	if (opts.stick && (atBottom || scroller.scrollTop === 0)) {
		scroller.scrollTop = scroller.scrollHeight;
	}
}

function signature(item: ThreadItem): string {
	switch (item.kind) {
		case "assistant":
			return `${item.text.length}|${item.final}|${item.truncated}|${item.missingFragments}`;
		case "tool":
			return `${item.state}|${item.durationMs}|${item.toolName}|${Object.keys(item.summary).length}`;
		default:
			return "static";
	}
}

function renderItem(item: ThreadItem): HTMLElement {
	switch (item.kind) {
		case "user": {
			const box = el("div", "chat-msg chat-user");
			box.appendChild(meta("You", item.ts));
			box.appendChild(el("div", "chat-text", item.text));
			if (item.truncated) box.appendChild(el("div", "chat-note", "Prompt truncated"));
			return box;
		}
		case "assistant": {
			const box = el("div", "chat-msg chat-assistant");
			const head = meta("Claude", item.ts);
			if (item.final) head.appendChild(copyButton("Copy Markdown", () => item.text));
			box.appendChild(head);
			// Streaming text is plain until the message is final, then Markdown.
			if (item.final) {
				const md = renderMarkdown(item.text);
				md.classList.add("chat-md");
				box.appendChild(md);
			} else {
				box.appendChild(el("div", "chat-text streaming", item.text));
			}
			if (item.truncated) box.appendChild(el("div", "chat-note", "Message truncated"));
			return box;
		}
		case "tool": {
			const d = el("details", `chat-tool ${item.state}`);
			const s = el("summary");
			s.appendChild(el("span", "chat-tool-icon", toolIcon(item.state)));
			s.appendChild(el("span", "chat-tool-line", toolLine(item.toolName, item.summary)));
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
		case "report": {
			const box = el("div", "chat-report");
			const head = el("div", "chat-meta");
			head.appendChild(el("span", "chat-who", "Turn report"));
			head.appendChild(el("span", "chat-time", clock(item.ts)));
			head.appendChild(
				copyButton(item.truncated ? "Copy report (truncated)" : "Copy report", () => item.text),
			);
			box.appendChild(head);
			if (item.truncated) {
				box.appendChild(
					el(
						"div",
						"chat-note",
						`Truncated${item.originalBytes ? ` (original ${formatBytes(item.originalBytes)})` : ""} — copying copies what was kept.`,
					),
				);
			}
			return box;
		}
		case "marker":
			return el("div", `chat-marker ${item.tone}`, item.text);
	}
}

function meta(who: string, ts: string): HTMLElement {
	const head = el("div", "chat-meta");
	head.appendChild(el("span", "chat-who", who));
	head.appendChild(el("span", "chat-time", clock(ts)));
	return head;
}

function agentsBox(agents: AgentView[]): HTMLElement {
	const d = el("details", "chat-agents");
	const running = agents.filter((a) => a.status === "running").length;
	d.appendChild(
		el(
			"summary",
			undefined,
			`Agents (${agents.length})${running > 0 ? ` · ${running} running` : ""}`,
		),
	);
	const ul = el("ul");
	for (const a of agents) {
		const li = el("li", "chat-agent");
		const top = el("div", "chat-meta");
		top.appendChild(el("span", "chat-who", a.agentType || "agent"));
		top.appendChild(el("span", "chat-time", a.agentId.slice(0, 8)));
		top.appendChild(statusChip(a.status === "done" ? "ended" : "running"));
		top.appendChild(
			el("span", "chat-time", `${a.toolIds.size} tool${a.toolIds.size === 1 ? "" : "s"}`),
		);
		const result = a.result;
		if (result !== null) top.appendChild(copyButton("Copy result", () => result));
		li.appendChild(top);
		if (result !== null) {
			const r = el("details", "chat-agent-result");
			r.appendChild(el("summary", undefined, a.resultTruncated ? "Result (truncated)" : "Result"));
			const md = renderMarkdown(result);
			md.classList.add("chat-md");
			r.appendChild(md);
			li.appendChild(r);
		}
		ul.appendChild(li);
	}
	d.appendChild(ul);
	return d;
}

function composer(): HTMLElement {
	const box = el("div", "chat-composer");
	const ta = el("textarea");
	ta.disabled = true;
	ta.placeholder = "Sending messages from here is not available yet";
	ta.setAttribute("aria-label", "Message (not available yet)");
	ta.rows = 1;
	box.appendChild(ta);
	box.appendChild(button("Open terminal", "files-btn", () => setView("terminal")));
	return box;
}

function copyButton(label: string, text: () => string): HTMLButtonElement {
	return button(label, "files-btn chat-copy", () => {
		void copyText(text()).then(
			(ok) => showToast(ok ? "Copied" : "Copy failed", !ok),
			() => showToast("Copy failed", true),
		);
	});
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
	return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
