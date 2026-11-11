/**
 * pilotPanel.ts — the "Ask the agents" panel on a project page (Pilot 1,
 * docs/design/project-chat/18; owner decisions D-PIL1–D-PIL5, 2026-11-10).
 * Opt-in per browser (`?pilot=1`), then shown on every project page of
 * that browser, and only where Projects is on (docs/PROJECTS.md §9).
 *
 * Every send is the person's: one click, one ordinary Composer send per
 * selected agent (`POST …/messages`, CONVERSATION.md §8), each with its own
 * clientMessageId, issued independently — one agent's busy / 409 /
 * unconfirmed never holds back or cancels another's, and nothing is ever
 * retried. Replies are read from each agent's conversation over the
 * existing WS and attributed to a send only on the evidence pilotModel.ts
 * describes (the CLI's prompt id); the panel never matches by time.
 *
 * The panel's element is created once per project and kept across the
 * project page's 5 s re-renders (projectsView mounts it beside the
 * re-rendered content, never inside it), so the draft, the selection and
 * the focus survive a poll.
 */

import {
	type AgentListEntry,
	type ConversationSocket,
	fetchConversationSummaries,
	openConversationSocket,
	sendConversationMessage,
} from "./api.js";
import { explainCode, validateText } from "./composerText.js";
import { type ConversationEvent, clock, type ThreadItem, toolLine } from "./conversationModel.js";
import {
	type Correlation,
	forwardDraft,
	isFinal,
	newClientMessageId,
	pickTarget,
	replyOf,
	type SendState,
	sendStateOf,
	settleFromEvent,
	type Target,
} from "./pilotModel.js";
import { routeHash } from "./router.js";
import { button, el } from "./ui.js";

/** Events a feed keeps for lanes still waiting for their evidence (newest kept). */
const FEED_MAX_EVENTS = 4000;
/** How long the list read behind a target may take. */
const TARGET_TIMEOUT_MS = 8000;

interface Lane {
	agentId: string;
	handle: string;
	sessionId: string;
	cid: string | null;
	clientMessageId: string;
	/** The conversation's last seq read just before the send. */
	after: number;
	state: SendState;
	/**
	 * The lane's own copy of its correlated events (by prompt id), so a reply
	 * survives the feed being evicted, closed or switched to another
	 * conversation of the same session.
	 */
	events: ConversationEvent[];
	/** Events after the send not attributed to it (no evidence yet, or another prompt). */
	unattributed: number;
}

interface Exchange {
	id: string;
	text: string;
	at: string;
	forwardedFrom: string | null;
	lanes: Lane[];
}

/** One followed conversation (the WS follows one conversation per socket). */
interface Feed {
	sessionId: string;
	cid: string;
	socket: ConversationSocket | null;
	/** Recent events, for a lane whose evidence arrives after its events. */
	events: ConversationEvent[];
	lastSeq: number;
	/** The server refused the socket (1008: e.g. too many open Chat views). */
	refused: boolean;
}

const feedKey = (sessionId: string, cid: string) => `${sessionId}/${cid}`;

type TargetState = Target | { kind: "loading" } | { kind: "error"; text: string };

interface PilotState {
	pid: string;
	root: HTMLElement;
	agentsEl: HTMLElement;
	noticeEl: HTMLElement;
	text: HTMLTextAreaElement;
	sendBtn: HTMLButtonElement;
	errorEl: HTMLElement;
	exchangesEl: HTMLElement;
	agents: AgentListEntry[];
	agentsSig: string;
	selected: Set<string>;
	targets: Map<string, TargetState>;
	forwardFrom: string | null;
	/** Agents with a send whose HTTP answer has not arrived: only they wait. */
	sendingAgents: Set<string>;
	exchanges: Exchange[];
	/** By `sessionId/cid`. A socket stays open only while a lane on it can still change. */
	feeds: Map<string, Feed>;
	/** The panel is on screen (sockets open only then). */
	visible: boolean;
}

let state: PilotState | null = null;
let gen = 0;

// ── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * The panel for project `pid`, kept between renders. `agents` is the page's
 * latest list (null while it loads). Switching project starts a new panel.
 */
export function pilotPanel(pid: string, agents: AgentListEntry[] | null): HTMLElement {
	if (!state || state.pid !== pid) {
		resetPilot();
		state = create(pid);
	}
	if (agents) updateAgents(state, agents);
	if (!state.visible) {
		state.visible = true;
		// Shown again by the person: a socket the server refused before is
		// worth one more try now.
		for (const f of state.feeds.values()) {
			f.refused = false;
			syncFeed(state, f);
		}
	}
	return state.root;
}

/**
 * The panel left the screen (another page, the agent page, the session):
 * close every socket — the server allows few per user, and the Chat view
 * needs them. Lanes keep their events; following resumes from each feed's
 * last seq when the panel is shown again.
 */
export function suspendPilot(): void {
	if (!state?.visible) return;
	state.visible = false;
	for (const f of state.feeds.values()) {
		f.socket?.close();
		f.socket = null;
	}
}

/** Logout, expiry, or another project: sockets closed, nothing kept. */
export function resetPilot(): void {
	gen++;
	if (!state) return;
	// A send still in flight on this state must open nothing after this.
	state.visible = false;
	for (const f of state.feeds.values()) f.socket?.close();
	state.root.remove();
	state = null;
}

function create(pid: string): PilotState {
	const root = el("section", "pilot");
	root.setAttribute("aria-label", "Ask the agents (pilot)");
	const head = el("div", "pilot-head");
	head.appendChild(el("h3", "pilot-title", "Ask the agents"));
	head.appendChild(el("span", "pilot-badge", "pilot"));
	root.appendChild(head);
	root.appendChild(
		el(
			"p",
			"pilot-note",
			"Each selected agent gets the same message as an ordinary Chat send. A reply is shown under a message only when Claude Code's own prompt id proves it answers that message.",
		),
	);
	const agentsEl = el("ul", "pilot-agents");
	agentsEl.setAttribute("aria-label", "Agents to ask");
	root.appendChild(agentsEl);
	const noticeEl = el("div", "pilot-notice");
	noticeEl.hidden = true;
	root.appendChild(noticeEl);
	const text = el("textarea", "pilot-text");
	text.rows = 3;
	text.placeholder = "Message to the selected agents…";
	text.dataset.key = "pilot-text";
	text.setAttribute("aria-label", "Message to the selected agents");
	root.appendChild(text);
	const row = el("div", "pilot-actions");
	const errorEl = el("span", "pilot-error");
	errorEl.setAttribute("role", "alert");
	const s: PilotState = {
		pid,
		root,
		agentsEl,
		noticeEl,
		text,
		sendBtn: null as unknown as HTMLButtonElement,
		errorEl,
		exchangesEl: el("div", "pilot-exchanges"),
		agents: [],
		agentsSig: "",
		selected: new Set(),
		targets: new Map(),
		forwardFrom: null,
		sendingAgents: new Set(),
		exchanges: [],
		feeds: new Map(),
		visible: true,
	};
	s.sendBtn = button("Send", "pv-btn pv-primary pilot-send", () => void send(s));
	s.sendBtn.dataset.key = "pilot-send";
	const refresh = button("Check agents", "pv-btn pilot-refresh", () => loadTargets(s));
	refresh.dataset.key = "pilot-refresh";
	row.append(s.sendBtn, refresh, errorEl);
	root.appendChild(row);
	root.appendChild(s.exchangesEl);
	text.addEventListener("input", () => {
		s.errorEl.textContent = "";
		renderControls(s);
	});
	renderControls(s);
	return s;
}

// ── Agents and their targets ────────────────────────────────────────────────

function sendable(a: AgentListEntry): boolean {
	return a.binding !== null && a.binding.state === "active";
}

function updateAgents(s: PilotState, agents: AgentListEntry[]): void {
	const live = agents.filter(sendable);
	const sig = live.map((a) => `${a.agentId}:${a.binding?.sessionId}`).join(",");
	s.agents = live;
	if (sig === s.agentsSig) return;
	s.agentsSig = sig;
	for (const id of [...s.selected]) if (!live.some((a) => a.agentId === id)) s.selected.delete(id);
	loadTargets(s);
}

/** Read each agent's conversation list (light form): which conversation would receive. */
function loadTargets(s: PilotState): void {
	const g = gen;
	for (const a of s.agents) {
		s.targets.set(a.agentId, { kind: "loading" });
		void targetOf(a).then((t) => {
			if (g !== gen || state !== s) return;
			s.targets.set(a.agentId, t);
			if (t.kind !== "ok") s.selected.delete(a.agentId);
			renderAgents(s);
			renderControls(s);
		});
	}
	renderAgents(s);
	renderControls(s);
}

async function targetOf(a: AgentListEntry): Promise<TargetState> {
	const sid = a.binding?.sessionId;
	if (!sid) return { kind: "none", reason: "no session bound" };
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), TARGET_TIMEOUT_MS);
	try {
		const r = await fetchConversationSummaries(sid, ctl.signal);
		if (!r.ok) return { kind: "error", text: `couldn't read its conversations (${r.status})` };
		return pickTarget(r.conversations);
	} catch {
		return { kind: "error", text: "couldn't read its conversations" };
	} finally {
		clearTimeout(timer);
	}
}

function targetText(t: TargetState | undefined): string {
	if (!t || t.kind === "loading") return "checking…";
	if (t.kind === "ok") return "can receive";
	if (t.kind === "ambiguous")
		return `${t.count} conversations could receive — open its Chat to choose`;
	if (t.kind === "error") return t.text;
	return t.reason;
}

function renderAgents(s: PilotState): void {
	const items: HTMLElement[] = [];
	if (s.agents.length === 0) {
		items.push(el("li", "pilot-muted", "No agent with a live session in this project."));
	}
	for (const a of s.agents) {
		const t = s.targets.get(a.agentId);
		const li = el("li", "pilot-agent");
		const label = el("label");
		const box = el("input");
		box.type = "checkbox";
		box.dataset.key = `pilot-agent:${a.agentId}`;
		box.checked = s.selected.has(a.agentId);
		box.disabled = t?.kind !== "ok";
		box.addEventListener("change", () => {
			if (box.checked) s.selected.add(a.agentId);
			else s.selected.delete(a.agentId);
			renderControls(s);
		});
		label.append(box, el("span", "pilot-handle", `@${a.handle}`));
		li.appendChild(label);
		li.appendChild(el("span", `pilot-target pilot-target-${t?.kind ?? "loading"}`, targetText(t)));
		items.push(li);
	}
	// Keep the focused checkbox focused across a re-render (by data-key).
	const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.key;
	s.agentsEl.replaceChildren(...items);
	if (focusKey?.startsWith("pilot-agent:")) {
		s.agentsEl.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
	}
}

function renderControls(s: PilotState): void {
	const n = s.selected.size;
	const waiting = s.agents.filter(
		(a) => s.selected.has(a.agentId) && s.sendingAgents.has(a.agentId),
	);
	s.sendBtn.disabled = waiting.length > 0 || n === 0 || s.text.value.trim() === "";
	s.sendBtn.title =
		waiting.length > 0
			? `Waiting for the answer to the previous send to ${waiting.map((a) => `@${a.handle}`).join(", ")}`
			: "";
	s.sendBtn.textContent =
		s.forwardFrom !== null
			? `Send forwarded text to ${n} agent${n === 1 ? "" : "s"}`
			: n > 1
				? `Send to ${n} agents`
				: "Send";
	if (s.forwardFrom !== null) {
		s.noticeEl.hidden = false;
		s.noticeEl.replaceChildren(
			el(
				"span",
				undefined,
				`Forwarding @${s.forwardFrom}'s answer. Choose who receives it, read and edit it below — nothing is sent until you click the button.`,
			),
			button("Cancel forward", "pv-btn pilot-cancel-forward", () => {
				s.forwardFrom = null;
				s.text.value = "";
				renderControls(s);
			}),
		);
	} else {
		s.noticeEl.hidden = true;
		s.noticeEl.replaceChildren();
	}
}

// ── Sending ─────────────────────────────────────────────────────────────────

async function send(s: PilotState): Promise<void> {
	const v = validateText(s.text.value);
	if (!v.ok) {
		s.errorEl.textContent = explainCode(v.code);
		return;
	}
	const sentRaw = s.text.value;
	const chosen = s.agents.filter((a) => s.selected.has(a.agentId));
	// Re-checked here, not only in the button's state: a click that raced a
	// re-render never sends twice to an agent still waiting for an answer.
	if (chosen.length === 0 || chosen.some((a) => s.sendingAgents.has(a.agentId))) return;
	const g = gen;
	const ex: Exchange = {
		id: newClientMessageId(),
		text: v.normalized,
		at: new Date().toISOString(),
		forwardedFrom: s.forwardFrom,
		lanes: chosen.map((a) => ({
			agentId: a.agentId,
			handle: a.handle,
			sessionId: a.binding?.sessionId ?? "",
			cid: null,
			clientMessageId: newClientMessageId(),
			after: 0,
			state: { kind: "sending" },
			events: [],
			unattributed: 0,
		})),
	};
	s.exchanges.unshift(ex);
	for (const a of chosen) s.sendingAgents.add(a.agentId);
	renderControls(s);
	renderExchanges(s);
	// Independent: each lane runs on its own; none waits for, or is cancelled
	// by, another's answer, and an agent whose answer is back can take the
	// next message while another is still slow (D-PIL, 2026-11-10).
	const runs = ex.lanes.map(async (lane) => {
		const took = await sendLane(s, lane, ex.text, g);
		if (g === gen && state === s) {
			s.sendingAgents.delete(lane.agentId);
			renderControls(s);
		}
		return took;
	});
	const accepted = (await Promise.all(runs)).some(Boolean);
	if (g !== gen || state !== s) return;
	// The draft goes only when at least one agent took it; otherwise it stays
	// for the person to fix or resend (never resent by the panel).
	// …and only if the box still holds what this exchange sent: the person
	// may already be writing the next message or a forward (sends overlap).
	if (accepted && s.text.value === sentRaw) {
		s.text.value = "";
		if (s.forwardFrom === ex.forwardedFrom) s.forwardFrom = null;
	}
	renderControls(s);
	loadTargets(s);
}

/** One agent's send. Returns whether the server took it (202). Never retried. */
async function sendLane(s: PilotState, lane: Lane, text: string, g: number): Promise<boolean> {
	const update = (st: SendState) => {
		if (g !== gen || state !== s) return;
		setState(s, lane, st);
		renderExchanges(s);
	};
	// The target is read again now: its lastSeq is where the replies start,
	// and it may have changed since the list was shown.
	const a = s.agents.find((x) => x.agentId === lane.agentId);
	const t = a ? await targetOf(a) : ({ kind: "none", reason: "no longer in the project" } as const);
	// Logout or another project while the target was read: send nothing.
	if (g !== gen || state !== s) return false;
	if (t.kind !== "ok") {
		update({ kind: "refused", status: 0, text: `Not sent: ${targetText(t)}.` });
		return false;
	}
	lane.cid = t.cid;
	lane.after = t.lastSeq;
	// Follow BEFORE the send, from the seq read above: nothing the send causes
	// can arrive before the subscription.
	const feed = follow(s, lane.sessionId, t.cid, t.lastSeq);
	try {
		const r = await sendConversationMessage(lane.sessionId, t.cid, text, lane.clientMessageId);
		let st = sendStateOf(r);
		// The send's own event may have landed before its HTTP answer.
		if (st.kind === "pending") {
			for (const e of feed.events) {
				const settled = settleFromEvent(e, lane.clientMessageId);
				// The first event that records a decision is the decision.
				if (settled && settled.kind !== "pending") {
					st = settled;
					break;
				}
			}
		}
		update(st);
		return r.status === 202 || r.status === 200;
	} catch {
		update({
			kind: "error",
			text:
				"The request failed before an answer arrived; it is not known whether it was sent. Check @" +
				`${lane.handle}'s Chat before sending again.`,
		});
		return false;
	} finally {
		if (g === gen && state === s) syncFeed(s, feed);
	}
}

/**
 * A lane's new state. On reaching `delivered` the lane takes, from the feed,
 * the events of its prompt that arrived before the evidence did.
 */
function setState(s: PilotState, lane: Lane, st: SendState): void {
	lane.state = st;
	if (st.kind !== "delivered" || lane.cid === null) return;
	const feed = s.feeds.get(feedKey(lane.sessionId, lane.cid));
	const have = new Set(lane.events.map((e) => e.seq));
	for (const e of feed?.events ?? []) {
		if (!have.has(e.seq) && ownsEvent(lane, e)) lane.events.push(e);
	}
	lane.events.sort((x, y) => x.seq - y.seq);
}

function ownsEvent(lane: Lane, e: ConversationEvent): boolean {
	if (lane.state.kind !== "delivered") return false;
	const { promptId, seq } = lane.state.corr;
	return e.prompt_id === promptId && e.ev !== "composer_send" && (seq === null || e.seq >= seq);
}

function lanesOf(s: PilotState, feed: Feed): Lane[] {
	const out: Lane[] = [];
	for (const ex of s.exchanges) {
		for (const l of ex.lanes) if (l.sessionId === feed.sessionId && l.cid === feed.cid) out.push(l);
	}
	return out;
}

/** A lane no later event can change: final, or delivered with its turn ended. */
function laneSettled(lane: Lane): boolean {
	if (isFinal(lane.state)) return true;
	if (lane.state.kind !== "delivered") return false;
	return lane.events.some((e) => e.ev === "turn_end" || e.ev === "turn_failed");
}

function follow(s: PilotState, sessionId: string, cid: string, after: number): Feed {
	const key = feedKey(sessionId, cid);
	let feed = s.feeds.get(key);
	if (!feed) {
		feed = { sessionId, cid, socket: null, events: [], lastSeq: after, refused: false };
		s.feeds.set(key, feed);
	}
	if (!feed.socket && s.visible) openFeed(s, feed);
	return feed;
}

function openFeed(s: PilotState, feed: Feed): void {
	feed.refused = false;
	const socket = openConversationSocket(
		feed.sessionId,
		(f) => {
			if (state !== s || feed.socket !== socket || f.type !== "event" || f.conv !== feed.cid)
				return;
			onEvent(s, feed, f.event);
		},
		(_connected, refused) => {
			if (!refused || state !== s || feed.socket !== socket) return;
			feed.refused = true;
			feed.socket = null;
			renderExchanges(s);
		},
	);
	feed.socket = socket;
	socket.follow(feed.cid, feed.lastSeq);
}

/**
 * Keep a feed's socket open only while the panel is shown and a lane on it
 * can still change; reopen it (from its last seq) when that is true again.
 */
function syncFeed(s: PilotState, feed: Feed): void {
	const needed = s.visible && lanesOf(s, feed).some((l) => !laneSettled(l));
	if (needed && !feed.socket && !feed.refused) openFeed(s, feed);
	if (!needed && feed.socket) {
		feed.socket.close();
		feed.socket = null;
	}
}

function onEvent(s: PilotState, feed: Feed, e: ConversationEvent): void {
	if (e.seq <= feed.lastSeq) return;
	feed.lastSeq = Math.max(feed.lastSeq, e.seq);
	feed.events.push(e);
	if (feed.events.length > FEED_MAX_EVENTS)
		feed.events.splice(0, feed.events.length - FEED_MAX_EVENTS);
	for (const lane of lanesOf(s, feed)) {
		if (lane.state.kind === "pending" || lane.state.kind === "sending") {
			const settled = settleFromEvent(e, lane.clientMessageId);
			if (settled) setState(s, lane, settled);
		}
		if (ownsEvent(lane, e)) {
			if (!lane.events.some((x) => x.seq === e.seq)) lane.events.push(e);
		} else if (
			e.seq > lane.after &&
			e.ev !== "composer_send" &&
			e.ev !== "probe" &&
			lane.state.kind !== "sending"
		) {
			lane.unattributed++;
		}
	}
	syncFeed(s, feed);
	renderExchanges(s);
}

// ── Exchanges ───────────────────────────────────────────────────────────────

function stateLine(lane: Lane): { text: string; tone: string } {
	const st = lane.state;
	switch (st.kind) {
		case "sending":
			return { text: "Sending…", tone: "muted" };
		case "delivered":
			return { text: "Delivered", tone: "ok" };
		case "unconfirmed":
			return {
				text: "Not confirmed: Claude Code did not show this message as received. Check the Terminal before sending again.",
				tone: "warn",
			};
		case "pending":
			return st.result === "accepted"
				? { text: "Accepted, waiting for delivery…", tone: "muted" }
				: { text: "Outcome not known yet (the server is still settling it).", tone: "warn" };
		case "delivered-unattributed":
			return {
				text: "Delivered, but Claude Code gave no prompt id, so no reply can be attributed here — read it in Chat.",
				tone: "warn",
			};
		case "resolved":
			return { text: `Settled by an operator (${st.outcome}).`, tone: "warn" };
		case "misdelivered":
			return {
				text: "Delivered to a different conversation in that terminal — nothing is attributed here.",
				tone: "warn",
			};
		case "refused":
			return { text: st.text, tone: "warn" };
		case "error":
			return { text: st.text, tone: "warn" };
	}
}

function renderItem(it: ThreadItem): HTMLElement | null {
	switch (it.kind) {
		case "assistant": {
			const div = el("div", "pilot-answer", it.text);
			if (it.missingFragments > 0) div.classList.add("pilot-incomplete");
			return div;
		}
		case "report":
			return el("div", "pilot-answer", it.text);
		case "tool":
			return el("div", `pilot-tool pilot-tool-${it.state}`, toolLine(it.toolName, it.summary));
		case "marker":
			return el("div", `pilot-marker pilot-marker-${it.tone}`, it.text);
		default:
			return null;
	}
}

function laneEl(s: PilotState, lane: Lane): HTMLElement {
	const box = el("div", "pilot-lane");
	box.dataset.agentId = lane.agentId;
	const top = el("div", "pilot-lane-top");
	top.appendChild(el("span", "pilot-handle", `@${lane.handle}`));
	const line = stateLine(lane);
	top.appendChild(el("span", `pilot-state pilot-state-${line.tone}`, line.text));
	box.appendChild(top);
	const feed = lane.cid !== null ? s.feeds.get(feedKey(lane.sessionId, lane.cid)) : undefined;
	const corr: Correlation | null = lane.state.kind === "delivered" ? lane.state.corr : null;
	const settled = laneSettled(lane);
	if (corr) {
		const reply = replyOf(lane.events, corr);
		if (reply.ambiguous) {
			box.appendChild(
				el(
					"div",
					"pilot-state pilot-state-warn pilot-ambiguous",
					"Another message joined this turn (typed in the Terminal while Claude was busy), so this answer may be to both. It is not forwarded from here.",
				),
			);
		}
		const body = el("div", "pilot-reply");
		for (const it of reply.items) {
			if (it.kind === "user") continue;
			const node = renderItem(it);
			if (node) body.appendChild(node);
		}
		if (body.childNodes.length === 0) {
			body.appendChild(el("div", "pilot-muted", reply.finished ? "No answer text." : "Working…"));
		}
		box.appendChild(body);
		const foot = el("div", "pilot-lane-foot");
		foot.appendChild(
			el(
				"span",
				"pilot-muted",
				reply.failed
					? "The turn failed."
					: reply.finished
						? "Turn ended (later activity of this prompt shows in Chat)."
						: `${lane.events.length} events so far`,
			),
		);
		const others = s.agents.filter((a) => a.agentId !== lane.agentId);
		if (reply.finished && !reply.failed && !reply.ambiguous && reply.answer && others.length > 0) {
			const fwd = button("Forward…", "pv-btn pilot-forward", () =>
				startForward(s, lane, reply.answer ?? ""),
			);
			fwd.dataset.key = `pilot-forward:${lane.clientMessageId}`;
			fwd.title = `Prefill a message to the other agents with @${lane.handle}'s answer — you review and send it`;
			foot.appendChild(fwd);
		}
		box.appendChild(foot);
	} else if (lane.state.kind !== "sending" && lane.cid !== null && lane.unattributed > 0) {
		// No evidence ties anything to this send: count, never show as an answer.
		const n = lane.unattributed;
		box.appendChild(
			el(
				"div",
				"pilot-muted pilot-unattributed",
				`${n} new event${n === 1 ? "" : "s"} in @${lane.handle}'s conversation, not attributed to this message.`,
			),
		);
	}
	if (!settled && feed?.refused) {
		box.appendChild(
			el(
				"div",
				"pilot-state pilot-state-warn pilot-not-followed",
				"Replies can't be followed here: the server refused another live Chat connection (too many open Chat views). Open Chat to read them.",
			),
		);
	} else if (!settled && lane.cid !== null && !feed?.socket && lane.state.kind !== "sending") {
		box.appendChild(
			el("div", "pilot-muted pilot-not-followed", "Not following replies right now — open Chat."),
		);
	}
	if (lane.cid !== null) {
		const open = el("a", "pilot-open-chat", "Open Chat");
		open.href = routeHash({ sessionId: lane.sessionId, view: "chat", detail: lane.cid });
		box.appendChild(open);
	}
	return box;
}

function renderExchanges(s: PilotState): void {
	const nodes: HTMLElement[] = [];
	for (const ex of s.exchanges) {
		const card = el("article", "pilot-exchange");
		const head = el("div", "pilot-exchange-head");
		head.appendChild(el("span", "pilot-when", clock(ex.at)));
		if (ex.forwardedFrom)
			head.appendChild(el("span", "pilot-fwd", `forwarded from @${ex.forwardedFrom}`));
		card.appendChild(head);
		card.appendChild(el("div", "pilot-sent", ex.text));
		const lanes = el("div", "pilot-lanes");
		for (const lane of ex.lanes) lanes.appendChild(laneEl(s, lane));
		card.appendChild(lanes);
		nodes.push(card);
	}
	const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.key;
	s.exchangesEl.replaceChildren(...nodes);
	if (focusKey?.startsWith("pilot-forward:")) {
		s.exchangesEl.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
	}
}

// ── Forward (always reviewed and sent by the person) ────────────────────────

function startForward(s: PilotState, from: Lane, answer: string): void {
	s.forwardFrom = from.handle;
	s.text.value = forwardDraft(from.handle, answer);
	// Nobody is pre-selected: the person picks who receives the forward, so a
	// click can never reach an agent they did not choose (D-PIL3: preview,
	// editable text, human confirmation — of the text AND the recipients).
	s.selected = new Set();
	s.errorEl.textContent = "";
	renderAgents(s);
	renderControls(s);
	s.text.focus();
	s.text.setSelectionRange(0, 0);
	s.text.scrollIntoView({ block: "nearest" });
}
