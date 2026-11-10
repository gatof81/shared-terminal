/**
 * pilotPanel.ts — the "Ask the agents" panel on a project page (Pilot 1,
 * docs/design/project-chat/18; owner decisions D-PIL1–D-PIL5, 2026-11-10).
 * Opt-in per browser (`?pilot=1`) and only where Projects is on.
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
	correlated,
	forwardDraft,
	newClientMessageId,
	pickTarget,
	replyOf,
	type SendState,
	sendStateOf,
	settleFromEvent,
	type Target,
	unattributedCount,
} from "./pilotModel.js";
import { routeHash } from "./router.js";
import { button, el } from "./ui.js";

/** A conversation's events held for the lanes (newest kept). */
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
}

interface Exchange {
	id: string;
	text: string;
	at: string;
	forwardedFrom: string | null;
	lanes: Lane[];
}

interface Feed {
	socket: ConversationSocket;
	cid: string;
	events: ConversationEvent[];
}

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
	inFlight: number;
	exchanges: Exchange[];
	/** One socket per agent session, following that agent's conversation. */
	feeds: Map<string, Feed>;
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
	return state.root;
}

/** Logout, expiry, or leaving the project: sockets closed, nothing kept. */
export function resetPilot(): void {
	gen++;
	if (!state) return;
	for (const f of state.feeds.values()) f.socket.close();
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
		inFlight: 0,
		exchanges: [],
		feeds: new Map(),
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
	s.sendBtn.disabled = s.inFlight > 0 || n === 0 || s.text.value.trim() === "";
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
				`Forwarding @${s.forwardFrom}'s answer. Read and edit it below — nothing is sent until you click the button.`,
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
	const chosen = s.agents.filter((a) => s.selected.has(a.agentId));
	if (chosen.length === 0) return;
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
		})),
	};
	s.exchanges.unshift(ex);
	s.inFlight++;
	renderControls(s);
	renderExchanges(s);
	// Independent: each lane runs on its own; none waits for, or is cancelled
	// by, another's answer (D-PIL, 2026-11-10).
	const runs = ex.lanes.map((lane) => sendLane(s, lane, ex.text, g));
	const accepted = (await Promise.all(runs)).some(Boolean);
	if (g !== gen || state !== s) return;
	s.inFlight--;
	// The draft goes only when at least one agent took it; otherwise it stays
	// for the person to fix or resend (never resent by the panel).
	if (accepted) {
		s.text.value = "";
		s.forwardFrom = null;
	}
	renderControls(s);
	loadTargets(s);
}

/** One agent's send. Returns whether the server took it (202). Never retried. */
async function sendLane(s: PilotState, lane: Lane, text: string, g: number): Promise<boolean> {
	const update = (st: SendState) => {
		if (g !== gen || state !== s) return;
		lane.state = st;
		renderExchanges(s);
	};
	// The target is read again now: its lastSeq is where the replies start,
	// and it may have changed since the list was shown.
	const a = s.agents.find((x) => x.agentId === lane.agentId);
	const t = a ? await targetOf(a) : ({ kind: "none", reason: "no longer in the project" } as const);
	if (t.kind !== "ok") {
		update({ kind: "refused", status: 0, text: `Not sent: ${targetText(t)}.` });
		return false;
	}
	lane.cid = t.cid;
	lane.after = t.lastSeq;
	// Follow BEFORE the send, from the seq read above: nothing the send causes
	// can arrive before the subscription.
	follow(s, lane.sessionId, t.cid, t.lastSeq);
	try {
		const r = await sendConversationMessage(lane.sessionId, t.cid, text, lane.clientMessageId);
		const st = sendStateOf(r);
		// The send's own event may have landed before its HTTP answer.
		const feed = s.feeds.get(lane.sessionId);
		let settled: SendState | null = null;
		if (st.kind === "pending" && feed) {
			for (const e of feed.events) settled = settleFromEvent(e, lane.clientMessageId) ?? settled;
		}
		update(settled && settled.kind !== "pending" ? settled : st);
		return r.status === 202 || r.status === 200;
	} catch {
		update({
			kind: "error",
			text:
				"The request failed before an answer arrived; it is not known whether it was sent. Check @" +
				`${lane.handle}'s Chat before sending again.`,
		});
		return false;
	}
}

function follow(s: PilotState, sessionId: string, cid: string, after: number): void {
	const cur = s.feeds.get(sessionId);
	if (cur && cur.cid === cid) return;
	cur?.socket.close();
	const feed: Feed = { cid, events: [], socket: null as unknown as ConversationSocket };
	feed.socket = openConversationSocket(sessionId, (f) => {
		if (state !== s || f.type !== "event" || f.conv !== feed.cid) return;
		onEvent(s, sessionId, feed, f.event);
	});
	feed.socket.follow(cid, after);
	s.feeds.set(sessionId, feed);
}

function onEvent(s: PilotState, sessionId: string, feed: Feed, e: ConversationEvent): void {
	if (feed.events.length > 0 && e.seq <= feed.events[feed.events.length - 1]!.seq) return;
	feed.events.push(e);
	if (feed.events.length > FEED_MAX_EVENTS)
		feed.events.splice(0, feed.events.length - FEED_MAX_EVENTS);
	for (const ex of s.exchanges) {
		for (const lane of ex.lanes) {
			if (lane.sessionId !== sessionId || lane.cid !== feed.cid) continue;
			if (lane.state.kind === "pending" || lane.state.kind === "sending") {
				const settled = settleFromEvent(e, lane.clientMessageId);
				if (settled) lane.state = settled;
			}
		}
	}
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
		case "pending":
			return st.result === "unconfirmed"
				? {
						text: "Not confirmed: Claude Code did not show this message as received. Check the Terminal before sending again.",
						tone: "warn",
					}
				: st.result === "accepted"
					? { text: "Accepted, waiting for delivery…", tone: "muted" }
					: {
							text: "Outcome not known yet (the server is still settling it).",
							tone: "warn",
						};
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
	const feed = s.feeds.get(lane.sessionId);
	const events = feed && feed.cid === lane.cid ? feed.events : [];
	const corr: Correlation | null = lane.state.kind === "delivered" ? lane.state.corr : null;
	if (corr) {
		const reply = replyOf(events, corr);
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
						? "Finished."
						: `${correlated(events, corr).length} events so far`,
			),
		);
		const others = s.agents.filter((a) => a.agentId !== lane.agentId);
		if (reply.finished && reply.answer && others.length > 0) {
			const fwd = button("Forward…", "pv-btn pilot-forward", () =>
				startForward(s, lane, reply.answer ?? ""),
			);
			fwd.dataset.key = `pilot-forward:${lane.clientMessageId}`;
			fwd.title = `Prefill a message to the other agents with @${lane.handle}'s answer — you review and send it`;
			foot.appendChild(fwd);
		}
		box.appendChild(foot);
	} else if (lane.state.kind !== "sending" && lane.cid !== null) {
		// No evidence ties anything to this send: count, never show as an answer.
		const n = unattributedCount(events, lane.after, null);
		if (n > 0) {
			box.appendChild(
				el(
					"div",
					"pilot-muted pilot-unattributed",
					`${n} new event${n === 1 ? "" : "s"} in @${lane.handle}'s conversation, not attributed to this message.`,
				),
			);
		}
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
	s.selected = new Set(
		s.agents
			.filter((a) => a.agentId !== from.agentId && s.targets.get(a.agentId)?.kind === "ok")
			.map((a) => a.agentId),
	);
	s.errorEl.textContent = "";
	renderAgents(s);
	renderControls(s);
	s.text.focus();
	s.text.setSelectionRange(0, 0);
	s.text.scrollIntoView({ block: "nearest" });
}
