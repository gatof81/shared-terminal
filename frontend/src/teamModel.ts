/**
 * teamModel.ts — the pure half of the Projects v3 workspace (Now · Threads ·
 * For you · New task), over the project conversation log of
 * docs/PROJECT_CONVERSATION.md (#587, D1). No DOM, no requests, no clock.
 *
 * Three rules shape everything here:
 *
 *  1. The log is the only source of what was sent, to whom, what happened
 *     to each delivery and which reply answers it. Nothing a device keeps
 *     locally decides whether something needs the person: a For you item
 *     appears and disappears only through log events, so a phone and a
 *     desktop show the same list (owner criterion 3, 2026-11-11).
 *  2. Presence (a permission prompt) is NOT log data. It comes from the
 *     agent directory, already filtered by projectModel.presentPresence
 *     (fresh hook evidence only), and is kept as its own kind of item.
 *  3. Agent text is never parsed for meaning. "LGTM" is just text; a reply
 *     is shown as the agent's words, never as a verdict.
 */

// ── Wire events (§2.2) ──────────────────────────────────────────────────────

export interface QuoteRef {
	msgId: string;
	agentId: string;
	promptId: string;
	reportSha256: string;
}

export interface LogMessage {
	ev: "message";
	seq: number;
	ts: string;
	msgId: string;
	clientMessageId: string | null;
	kind: "owner" | "relay";
	to: string[];
	text: string;
	quoteRef: QuoteRef | null;
	inReplyTo: string | null;
	/** kind relay only (D3): the grant it ran under. */
	grantId: string | null;
}

export type DeliveryState =
	| "planned"
	| "placing"
	| "sending"
	| "delivered"
	| "unconfirmed"
	| "misdelivered"
	| "failed"
	| "uncertain"
	| "refused"
	| "not-sent";

export interface LogDelivery {
	ev: "delivery";
	seq: number;
	ts: string;
	msgId: string;
	agentId: string;
	/** "settled" is a later resolution of an `uncertain` (§3.1): `result` holds it. */
	state: DeliveryState | "settled";
	result: DeliveryState | null;
	reason: string | null;
	filesPossiblyPlaced: boolean;
}

export type Attribution = "exact" | "ambiguous" | "failed";

export interface LogReplyRef {
	ev: "reply_ref";
	seq: number;
	ts: string;
	msgId: string;
	agentId: string;
	sid: string;
	cid: string;
	promptId: string;
	turnEndSeq: number | null;
	reportSha256: string | null;
	reportBytes: number | null;
	truncated: boolean;
	attribution: Attribution;
	attributionReason: string | null;
}

export interface LogLateClose {
	ev: "reply_late_close";
	seq: number;
	ts: string;
	msgId: string;
	agentId: string;
	promptId: string;
}

export interface LogGrant {
	ev: "grant";
	seq: number;
	ts: string;
	grantId: string;
	event: "created" | "revoked" | "ended";
	taskMsgId: string | null;
}

export type LogEvent = LogMessage | LogDelivery | LogReplyRef | LogLateClose | LogGrant;

const DELIVERY_STATES: ReadonlySet<string> = new Set([
	"planned",
	"placing",
	"sending",
	"delivered",
	"unconfirmed",
	"misdelivered",
	"failed",
	"uncertain",
	"refused",
	"not-sent",
]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const nonEmpty = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const int = (v: unknown): number | null =>
	typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

function quoteRefOf(v: unknown): QuoteRef | null {
	if (!isObj(v)) return null;
	const msgId = nonEmpty(v.msg_id);
	const agentId = nonEmpty(v.agent_id);
	const promptId = nonEmpty(v.prompt_id);
	const reportSha256 = nonEmpty(v.report_sha256);
	if (!msgId || !agentId || !promptId || !reportSha256) return null;
	return { msgId, agentId, promptId, reportSha256 };
}

/**
 * One persisted line of the project log, as §2.2 lists its fields (flat,
 * snake_case, plus the log's own `seq`/`ts`/`ev`). Anything malformed or of
 * a kind this UI doesn't render (artifact, recovery, a future kind) is
 * null — skipped, never guessed at.
 */
export function parseLogEvent(raw: unknown): LogEvent | null {
	if (!isObj(raw)) return null;
	const seq = int(raw.seq);
	const ev = str(raw.ev);
	if (seq === null || ev === null) return null;
	const ts = str(raw.ts) ?? "";
	switch (ev) {
		case "message": {
			const msgId = nonEmpty(raw.msg_id);
			const kind = raw.kind === "relay" ? "relay" : raw.kind === "owner" ? "owner" : null;
			if (!msgId || !kind || !Array.isArray(raw.to)) return null;
			const to = raw.to.filter((a): a is string => typeof a === "string" && a !== "");
			const relay = isObj(raw.relay) ? raw.relay : null;
			return {
				ev,
				seq,
				ts,
				msgId,
				clientMessageId: nonEmpty(raw.client_message_id),
				kind,
				to,
				text: str(raw.text) ?? "",
				quoteRef: quoteRefOf(raw.quote_ref),
				inReplyTo: nonEmpty(raw.in_reply_to),
				grantId: relay ? nonEmpty(relay.grant_id) : null,
			};
		}
		case "delivery": {
			const msgId = nonEmpty(raw.msg_id);
			const agentId = nonEmpty(raw.agent_id);
			const s = str(raw.state);
			if (!msgId || !agentId || s === null) return null;
			if (s !== "settled" && !DELIVERY_STATES.has(s)) return null;
			const r = str(raw.result);
			return {
				ev,
				seq,
				ts,
				msgId,
				agentId,
				state: s as DeliveryState | "settled",
				result: r !== null && DELIVERY_STATES.has(r) ? (r as DeliveryState) : null,
				reason: nonEmpty(raw.reason),
				filesPossiblyPlaced: raw.files_possibly_placed === true,
			};
		}
		case "reply_ref": {
			const msgId = nonEmpty(raw.msg_id);
			const agentId = nonEmpty(raw.agent_id);
			const sid = nonEmpty(raw.sid);
			const cid = nonEmpty(raw.cid);
			const promptId = nonEmpty(raw.prompt_id);
			const a = raw.attribution;
			const attribution: Attribution | null =
				a === "exact" || a === "ambiguous" || a === "failed" ? a : null;
			if (!msgId || !agentId || !sid || !cid || !promptId || !attribution) return null;
			return {
				ev,
				seq,
				ts,
				msgId,
				agentId,
				sid,
				cid,
				promptId,
				turnEndSeq: int(raw.turn_end_seq),
				reportSha256: nonEmpty(raw.report_sha256),
				reportBytes: int(raw.report_bytes),
				truncated: raw.truncated === true,
				attribution,
				attributionReason: nonEmpty(raw.attribution_reason) ?? nonEmpty(raw.reason),
			};
		}
		case "reply_late_close": {
			const msgId = nonEmpty(raw.msg_id);
			const agentId = nonEmpty(raw.agent_id);
			const promptId = nonEmpty(raw.prompt_id);
			if (!msgId || !agentId || !promptId) return null;
			return { ev, seq, ts, msgId, agentId, promptId };
		}
		case "grant": {
			const grantId = nonEmpty(raw.grant_id);
			const e = raw.event;
			if (!grantId || (e !== "created" && e !== "revoked" && e !== "ended")) return null;
			return { ev, seq, ts, grantId, event: e, taskMsgId: nonEmpty(raw.task_msg_id) };
		}
		default:
			return null;
	}
}

// ── Folding ─────────────────────────────────────────────────────────────────

export interface DeliveryView {
	agentId: string;
	/** The current state; a `settled` resolution replaces an `uncertain`. */
	state: DeliveryState;
	reason: string | null;
	filesPossiblyPlaced: boolean;
	/** Seq of the event that set `state` (ordering in a thread). */
	seq: number;
	ts: string;
	settled: boolean;
}

export interface ReplyView {
	ref: LogReplyRef;
	lateClose: boolean;
}

export interface MessageView {
	message: LogMessage;
	/** In the message's own `to[]` order. */
	deliveries: Map<string, DeliveryView>;
	/** Per agent, in seq order (normally one; a second prompt id is possible). */
	replies: Map<string, ReplyView[]>;
}

/**
 * Everything known from the log: the events of the loaded window plus any
 * message fetched by id (`GET …/messages/:msgId`) to anchor a thread whose
 * original is outside the window. Built by folding events in seq order;
 * folding the same event twice changes nothing.
 */
export class ProjectLog {
	readonly messages = new Map<string, MessageView>();
	/** Deliveries/replies whose message is not known yet (outside the window). */
	private orphans = new Map<string, LogEvent[]>();
	private seen = new Set<number>();
	/** grant_id → task_msg_id, so a relay message finds its thread. */
	readonly grantTask = new Map<string, string>();
	newestSeq = -1;
	oldestSeq = Number.POSITIVE_INFINITY;

	/** Fold events (any order, duplicates allowed); they are applied in seq order. */
	add(events: readonly LogEvent[]): void {
		const fresh = events.filter((e) => !this.seen.has(e.seq)).sort((a, b) => a.seq - b.seq);
		// Apply in global seq order including orphans waiting on these messages,
		// so a delivery older than its (just fetched) message never applies after
		// a newer one.
		for (const e of fresh) {
			this.seen.add(e.seq);
			if (e.seq > this.newestSeq) this.newestSeq = e.seq;
			if (e.seq < this.oldestSeq) this.oldestSeq = e.seq;
		}
		const pending: LogEvent[] = [...fresh];
		for (const e of fresh) {
			if (e.ev === "message") {
				const waiting = this.orphans.get(e.msgId);
				if (waiting) {
					this.orphans.delete(e.msgId);
					pending.push(...waiting);
				}
			}
		}
		pending.sort((a, b) => a.seq - b.seq);
		for (const e of pending) this.apply(e);
	}

	/**
	 * A message fetched by id, with its folded deliveries and replies — the
	 * anchor of a thread whose original is older than the loaded window.
	 */
	addFetched(events: readonly LogEvent[]): void {
		this.add(events);
	}

	has(msgId: string): boolean {
		return this.messages.has(msgId);
	}

	/** msg ids referenced by loaded events but not loaded themselves. */
	missingMessages(): string[] {
		const out = new Set<string>(this.orphans.keys());
		for (const m of this.messages.values()) {
			const ir = m.message.inReplyTo;
			if (ir && !this.messages.has(ir)) out.add(ir);
			if (m.message.kind === "relay" && m.message.grantId) {
				const task = this.grantTask.get(m.message.grantId);
				if (task && !this.messages.has(task)) out.add(task);
			}
		}
		return [...out];
	}

	private apply(e: LogEvent): void {
		switch (e.ev) {
			case "message":
				if (!this.messages.has(e.msgId))
					this.messages.set(e.msgId, { message: e, deliveries: new Map(), replies: new Map() });
				return;
			case "grant":
				if (e.taskMsgId) this.grantTask.set(e.grantId, e.taskMsgId);
				return;
			case "delivery":
			case "reply_ref":
			case "reply_late_close": {
				const m = this.messages.get(e.msgId);
				if (!m) {
					const list = this.orphans.get(e.msgId) ?? [];
					list.push(e);
					this.orphans.set(e.msgId, list);
					return;
				}
				if (e.ev === "delivery") applyDelivery(m, e);
				else if (e.ev === "reply_ref") {
					const list = m.replies.get(e.agentId) ?? [];
					if (!list.some((r) => r.ref.promptId === e.promptId))
						list.push({ ref: e, lateClose: false });
					m.replies.set(e.agentId, list);
				} else {
					const r = m.replies.get(e.agentId)?.find((x) => x.ref.promptId === e.promptId);
					if (r) r.lateClose = true;
				}
				return;
			}
		}
	}
}

/** A terminal state never changes (§3.1); only `settled` resolves an `uncertain`. */
const TERMINAL: ReadonlySet<DeliveryState> = new Set([
	"delivered",
	"unconfirmed",
	"misdelivered",
	"failed",
	"uncertain",
	"refused",
	"not-sent",
]);

function applyDelivery(m: MessageView, e: LogDelivery): void {
	const cur = m.deliveries.get(e.agentId);
	if (e.state === "settled") {
		if (!cur || cur.state !== "uncertain" || e.result === null) return;
		m.deliveries.set(e.agentId, {
			...cur,
			state: e.result,
			seq: e.seq,
			ts: e.ts,
			settled: true,
		});
		return;
	}
	if (cur && TERMINAL.has(cur.state)) return;
	m.deliveries.set(e.agentId, {
		agentId: e.agentId,
		state: e.state,
		reason: e.reason,
		filesPossiblyPlaced: e.filesPossiblyPlaced || (cur?.filesPossiblyPlaced ?? false),
		seq: e.seq,
		ts: e.ts,
		settled: false,
	});
}

// ── Delivery wording ────────────────────────────────────────────────────────

export type DeliveryTone = "pending" | "ok" | "unsure" | "not-delivered";

/**
 * Which of the four things a delivery can mean to the person:
 *  - pending: still on its way (planned / placing / sending);
 *  - ok: the agent got it (delivered);
 *  - not-delivered: nothing reached the agent — refused before any effect,
 *    or never sent — so sending again is safe;
 *  - unsure: something may have reached the pane (unconfirmed,
 *    misdelivered, uncertain, and `failed`, whose paste may have been
 *    partial — composer §8.1.5) — look before sending again.
 */
export function deliveryTone(state: DeliveryState): DeliveryTone {
	switch (state) {
		case "planned":
		case "placing":
		case "sending":
			return "pending";
		case "delivered":
			return "ok";
		case "refused":
		case "not-sent":
			return "not-delivered";
		default:
			return "unsure";
	}
}

const NOT_SENT_REASON: ReadonlyMap<string, string> = new Map([
	["no-target", "it has no open Claude conversation"],
	["ambiguous-target", "it has more than one Claude conversation"],
	["binding-changed", "its session changed"],
	["binding-unverified", "its session couldn't be checked"],
	["agent-removed", "it was removed from the project"],
	["grant-inactive", "the handoffs had stopped"],
	["artifact-failed", "a file couldn't be placed"],
	["persist-failed", "the server couldn't record it"],
]);

const REFUSED_REASON: ReadonlyMap<string, string> = new Map([
	["busy", "it was busy"],
	["needs-terminal", "it was waiting in its Terminal"],
	["composer-not-empty", "its input box wasn't empty"],
	["rate-limited", "too many sends in a minute"],
	["shutting-down", "the server was restarting"],
	["send-in-progress", "another send to it was in progress"],
]);

/** The words for one delivery, e.g. "Not delivered: it was busy". */
export function deliveryText(
	d: Pick<DeliveryView, "state" | "reason" | "filesPossiblyPlaced">,
): string {
	switch (d.state) {
		case "planned":
		case "placing":
		case "sending":
			return "Sending…";
		case "delivered":
			return "Delivered";
		case "not-sent": {
			const why = (d.reason && NOT_SENT_REASON.get(d.reason)) ?? "it wasn't sent";
			return d.filesPossiblyPlaced
				? `Not delivered: ${why}. Some files may already be in its inbox.`
				: `Not delivered: ${why}`;
		}
		case "refused": {
			const why = (d.reason && REFUSED_REASON.get(d.reason)) ?? "it couldn't take it";
			return `Not delivered: ${why}`;
		}
		case "unconfirmed":
			return "Not sure it arrived: no confirmation from the agent";
		case "misdelivered":
			return "Not sure it arrived: it may have gone to another conversation";
		case "failed":
			return "Not sure it arrived: the send failed part-way";
		default:
			return "Not sure it arrived";
	}
}

// ── Threads ─────────────────────────────────────────────────────────────────

/**
 * The thread a message belongs to: its root, the owner message that started
 * it. An owner message without `in_reply_to` is a root; one with it joins
 * the thread of what it answers; a relay joins the thread of its grant's
 * task. `null` when the chain leads to a message not loaded yet (the caller
 * fetches it by id — it is never guessed).
 */
export function threadRootOf(log: ProjectLog, msgId: string): string | null {
	const seen = new Set<string>();
	let id: string | null = msgId;
	while (id !== null) {
		if (seen.has(id)) return null; // a cycle can't come from a valid log
		seen.add(id);
		const m = log.messages.get(id);
		if (!m) return null;
		const msg: LogMessage = m.message;
		if (msg.kind === "relay") {
			id = msg.grantId ? (log.grantTask.get(msg.grantId) ?? null) : null;
			continue;
		}
		if (msg.inReplyTo === null) return msg.msgId;
		id = msg.inReplyTo;
	}
	return null;
}

export interface ThreadSummary {
	rootId: string;
	title: string;
	/** Every agent addressed in the thread, first-seen order. */
	agents: string[];
	/** Seq of the newest event in the thread (sort key). */
	lastSeq: number;
	lastTs: string;
	/** All messages of the thread, in seq order. */
	messageIds: string[];
}

/** A thread's title: the first non-empty line of its task, bounded. */
export function threadTitle(text: string, max = 80): string {
	const line =
		text
			.split("\n")
			.find((l) => l.trim() !== "")
			?.trim() ?? "";
	if (line === "") return "(empty message)";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function lastSeqOf(m: MessageView): { seq: number; ts: string } {
	let seq = m.message.seq;
	let ts = m.message.ts;
	for (const d of m.deliveries.values())
		if (d.seq > seq) {
			seq = d.seq;
			ts = d.ts;
		}
	for (const list of m.replies.values())
		for (const r of list)
			if (r.ref.seq > seq) {
				seq = r.ref.seq;
				ts = r.ref.ts;
			}
	return { seq, ts };
}

/**
 * Every thread with a loaded root, newest activity first. Messages whose
 * root is not loaded are left out (and reported by `unrootedMessages`) —
 * a late reply is never shown under the wrong thread.
 */
export function buildThreads(log: ProjectLog): ThreadSummary[] {
	const byRoot = new Map<string, ThreadSummary>();
	const ordered = [...log.messages.values()].sort((a, b) => a.message.seq - b.message.seq);
	for (const m of ordered) {
		const root = threadRootOf(log, m.message.msgId);
		if (root === null) continue;
		let t = byRoot.get(root);
		if (!t) {
			const r = log.messages.get(root);
			if (!r) continue;
			t = {
				rootId: root,
				title: threadTitle(r.message.text),
				agents: [],
				lastSeq: -1,
				lastTs: "",
				messageIds: [],
			};
			byRoot.set(root, t);
		}
		t.messageIds.push(m.message.msgId);
		for (const a of m.message.to) if (!t.agents.includes(a)) t.agents.push(a);
		const last = lastSeqOf(m);
		if (last.seq > t.lastSeq) {
			t.lastSeq = last.seq;
			t.lastTs = last.ts;
		}
	}
	return [...byRoot.values()].sort((a, b) => b.lastSeq - a.lastSeq);
}

/** Loaded messages whose thread can't be placed yet (root outside the window). */
export function unrootedMessages(log: ProjectLog): string[] {
	return [...log.messages.keys()].filter((id) => threadRootOf(log, id) === null);
}

// ── For you (log-derived) ───────────────────────────────────────────────────

export type ForYouKind = "replied" | "not-delivered" | "unsure";

export interface ForYouItem {
	kind: ForYouKind;
	/** Stable key: kind + msg + agent (+ prompt for a reply). */
	key: string;
	rootId: string;
	msgId: string;
	agentId: string;
	seq: number;
	ts: string;
	/** For "replied": the reply this card is about. */
	reply: LogReplyRef | null;
	/** For delivery items: the delivery. */
	delivery: DeliveryView | null;
}

/**
 * The log half of For you. Each item clears only through the log, so it
 * clears on every device at once:
 *
 *  - "replied": a reply (`reply_ref`, any attribution) that nothing passed
 *    on. It clears when the person sends a message whose `quote_ref` names
 *    exactly that reply (msg, agent, prompt) — "Reply…" on the card always
 *    sets it. A message answering the same original for ANOTHER agent's
 *    reply clears only that one (owner criterion 3: a reply closes only the
 *    item it corresponds to). (D3 relays are not handled here yet.)
 *  - "not-delivered" / "unsure": a delivery that didn't land. It clears
 *    when a later owner message in the same thread reaches the same agent
 *    (delivered), or — for "unsure" — when the agent's reply to it arrives
 *    (then it evidently did arrive).
 *
 * There is no "done" without a reply: that needs an owner event in the log
 * (requested of B on #587); it is never simulated with local state.
 */
export function forYou(log: ProjectLog): ForYouItem[] {
	const quoted = new Set<string>();
	// Later deliveries to an agent, per thread: the clearing evidence.
	const laterOk = new Map<string, number>(); // `${root}\n${agent}` → newest delivered seq
	for (const m of log.messages.values()) {
		const q = m.message.quoteRef;
		if (q) quoted.add(`${q.msgId}\n${q.agentId}\n${q.promptId}`);
		if (m.message.kind !== "owner") continue;
		const root = threadRootOf(log, m.message.msgId);
		if (root === null) continue;
		for (const d of m.deliveries.values()) {
			if (d.state !== "delivered") continue;
			const k = `${root}\n${d.agentId}`;
			const prev = laterOk.get(k) ?? -1;
			if (m.message.seq > prev) laterOk.set(k, m.message.seq);
		}
	}
	const out: ForYouItem[] = [];
	for (const m of log.messages.values()) {
		const root = threadRootOf(log, m.message.msgId);
		if (root === null) continue;
		for (const [agentId, list] of m.replies) {
			for (const r of list) {
				if (quoted.has(`${r.ref.msgId}\n${agentId}\n${r.ref.promptId}`)) continue;
				out.push({
					kind: "replied",
					key: `replied\n${m.message.msgId}\n${agentId}\n${r.ref.promptId}`,
					rootId: root,
					msgId: m.message.msgId,
					agentId,
					seq: r.ref.seq,
					ts: r.ref.ts,
					reply: r.ref,
					delivery: null,
				});
			}
		}
		for (const d of m.deliveries.values()) {
			const tone = deliveryTone(d.state);
			if (tone !== "not-delivered" && tone !== "unsure") continue;
			const later = laterOk.get(`${root}\n${d.agentId}`) ?? -1;
			if (later > m.message.seq) continue;
			if (tone === "unsure" && (m.replies.get(d.agentId)?.length ?? 0) > 0) continue;
			out.push({
				kind: tone,
				key: `${tone}\n${m.message.msgId}\n${d.agentId}`,
				rootId: root,
				msgId: m.message.msgId,
				agentId: d.agentId,
				seq: d.seq,
				ts: d.ts,
				reply: null,
				delivery: d,
			});
		}
	}
	return out.sort((a, b) => b.seq - a.seq);
}

// ── Reply text (verified against the log's hash) ────────────────────────────

export type ReplyTextState =
	| { kind: "loading" }
	| { kind: "ok"; text: string; truncated: boolean }
	/** The capture no longer holds it (rotation) or never had it: say so, with the hash. */
	| { kind: "gone" }
	/** The capture's text doesn't hash to the log's `report_sha256`: never shown. */
	| { kind: "mismatch" }
	| { kind: "error"; message: string };

/** Lowercase hex of a SHA-256 digest. */
export function hex(buf: ArrayBuffer): string {
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Compose ─────────────────────────────────────────────────────────────────

/** The server takes 1–8 distinct recipients (§3.3 step 0). */
export const MAX_RECIPIENTS = 8;

/**
 * Recipients are chosen, never read from the text: an "@name" typed in the
 * message, quoted, or inside an agent's reply adds nobody (owner criterion,
 * UX rev 2). This returns the `to[]` to send — the chosen ids, deduplicated,
 * in the order chosen — or the reason it can't be sent.
 */
export function recipientsToSend(chosen: readonly string[]): { to: string[] } | { error: string } {
	const to = [...new Set(chosen)];
	if (to.length === 0) return { error: "Choose who receives it." };
	if (to.length > MAX_RECIPIENTS) return { error: `At most ${MAX_RECIPIENTS} agents per message.` };
	return { to };
}

/**
 * The "@" being typed at the caret, for the recipient picker: the partial
 * handle after an "@" that starts a word, or null. Picking an agent turns
 * that "@partial" into plain text "@handle" AND adds the agent to the
 * recipients — the chip, not the text, is what the server receives.
 */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
	const before = text.slice(0, caret);
	const m = /(^|\s)@([a-z0-9-]{0,32})$/.exec(before);
	if (!m) return null;
	return { start: caret - m[2]!.length - 1, query: m[2]! };
}

// ── Answers ─────────────────────────────────────────────────────────────────

const POST_ERROR: ReadonlyMap<string, string> = new Map([
	["project-log-full", "This project's conversation is full. Nothing was sent."],
	[
		"project-log-unverifiable",
		"This project's conversation can't be verified right now. Nothing was sent.",
	],
	[
		"idempotency-conflict",
		"This message was already sent with different content. Nothing more was sent.",
	],
	["persist-failed", "The server couldn't record the message. Nothing was sent."],
	[
		"project-writer-unavailable",
		"The server isn't accepting messages right now. Nothing was sent.",
	],
	["invalid-body", "The server rejected the message. Nothing was sent."],
]);

/** The words for a refused POST (the server sent nothing to any agent). */
export function postErrorText(code: string, status: number): string {
	return (
		POST_ERROR.get(code) ??
		(status === 404
			? "This project no longer exists. Nothing was sent."
			: `The server refused the message (${code || status}). Nothing was sent.`)
	);
}
