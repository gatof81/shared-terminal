/**
 * projects/conversation/logCheck.ts — a read-only check of a project
 * conversation log against the rules of docs/PROJECT_CONVERSATION.md §2.2,
 * §3.1, §3.4, §4.1, §4.3 and §7 (D3 grants, outbox admissions and queued
 * relays), and a per-message summary of what happened.
 *
 * It exists to read the pilot's evidence without touching the host: the
 * operator pastes a page of `GET …/conversation/events` (message `text`
 * removed) into `npm run projects:check-log`, on any checkout. Nothing here
 * opens the log file, takes a lock or writes anything; the input is data.
 *
 * What it can prove is bounded by the page: a log longer than the page is
 * checked from its first line on (`oldestSeq`), and a delivery whose
 * `planned` precedes the page is reported as such, never guessed.
 */

export interface CheckedLine {
	seq: number;
	ev: string;
	w?: string;
	[k: string]: unknown;
}

export interface DeliverySummary {
	agentId: string;
	states: string[];
	final: string;
	reason?: string;
	sid?: string;
	cid?: string;
	composerClientMessageId?: string;
	promptId?: string;
	reply?: { attribution: string; promptId?: string; sid?: string; settledFirst: boolean };
	acked: boolean;
}

export interface MessageSummary {
	msgId: string;
	seq: number;
	to: string[];
	deliveries: DeliverySummary[];
	/** Delivered replies (reply_ref exact) not yet closed by an owner_ack for that agent or the whole message. */
	pending: string[];
	/** Only for messages with ≥ 2 recipients (§3: deliveries are independent). */
	independence?: {
		distinctComposerIds: boolean;
		distinctSessions: boolean;
		distinctPrompts: boolean;
		individualAcks: number;
	};
}

export interface CheckReport {
	ok: boolean;
	firstSeq: number | null;
	lastSeq: number | null;
	lines: number;
	writers: string[];
	violations: string[];
	notes: string[];
	messages: MessageSummary[];
}

const RESULTS = new Set([
	"delivered",
	"unconfirmed",
	"misdelivered",
	"failed",
	"uncertain",
	"refused",
]);

export function checkLog(input: unknown): CheckReport {
	const violations: string[] = [];
	const notes: string[] = [];
	const raw = Array.isArray(input)
		? input
		: input && typeof input === "object" && Array.isArray((input as { events?: unknown }).events)
			? (input as { events: unknown[] }).events
			: null;
	if (!raw) {
		return {
			ok: false,
			firstSeq: null,
			lastSeq: null,
			lines: 0,
			writers: [],
			violations: ["input is neither an events page {events: [...]} nor an array of events"],
			notes,
			messages: [],
		};
	}
	if (input && typeof input === "object" && (input as { hasMore?: unknown }).hasMore === true) {
		notes.push("page has more (hasMore): older lines were not checked");
	}
	const lines: CheckedLine[] = [];
	for (const [i, l] of raw.entries()) {
		if (!l || typeof l !== "object" || typeof (l as CheckedLine).seq !== "number") {
			violations.push(`entry ${i}: not an event with a numeric seq`);
			continue;
		}
		lines.push(l as CheckedLine);
	}
	for (let i = 1; i < lines.length; i++) {
		const prev = lines[i - 1] as CheckedLine;
		const cur = lines[i] as CheckedLine;
		if (cur.seq !== prev.seq + 1) violations.push(`seq ${prev.seq} → ${cur.seq}: not contiguous`);
	}
	for (const l of lines) {
		if ("text" in l && l.ev !== "message") notes.push(`seq ${l.seq}: unexpected text field`);
	}

	const messages = new Map<string, MessageSummary>();
	const deliveries = new Map<string, DeliverySummary & { sending: number; lastState: string }>();
	const seenCcmid = new Map<string, string>();
	const ackIds = new Set<string>();
	const settlingBy = new Map<string, CheckedLine>();
	const acked = new Map<string, Set<string>>();
	const key = (m: string, a: string) => `${m}/${a}`;
	// D3 (§7): each grant's state as the lines go by, its budget and its admitted files.
	const grants = new Map<
		string,
		{
			state: "live" | "paused" | "ended";
			max: number;
			n: number;
			reason?: string;
			expiresAt: number;
		}
	>();
	const admitted = new Set<string>();
	const grantOf = (l: CheckedLine): string | null => {
		const by = l.authorized_by;
		return typeof by === "string" && by.startsWith("collab:") ? by.slice(7) : null;
	};

	for (const l of lines) {
		const at = `seq ${l.seq} (${l.ev})`;
		switch (l.ev) {
			case "message": {
				const msgId = String(l.msg_id);
				if (messages.has(msgId)) violations.push(`${at}: message ${msgId} written twice`);
				const to = Array.isArray(l.to) ? (l.to as string[]) : [];
				messages.set(msgId, { msgId, seq: l.seq, to, deliveries: [], pending: [] });
				if (l.kind === "relay") {
					const r = (l.relay ?? {}) as { grant_id?: string; n?: number; kind?: string };
					const g = grants.get(String(r.grant_id));
					if (!g) notes.push(`${at}: relay of a grant created before this page`);
					else if (r.kind === "ask" || r.kind === "reply") {
						if (g.state !== "live") violations.push(`${at}: relay admitted on a ${g.state} grant`);
						g.n++;
						if (r.n !== g.n) violations.push(`${at}: relay n ${String(r.n)}, expected ${g.n}`);
						if (g.n > g.max) violations.push(`${at}: relay ${g.n} over max_messages ${g.max}`);
						if (to.length !== 1) violations.push(`${at}: relay ${r.kind} without one recipient`);
					} else if (to.length !== 0) {
						violations.push(`${at}: relay ${String(r.kind)} addressed to an agent`);
					}
				}
				break;
			}
			case "delivery": {
				const msgId = String(l.msg_id);
				const agentId = String(l.agent_id);
				const state = String(l.state);
				const m = messages.get(msgId);
				const k = key(msgId, agentId);
				let d = deliveries.get(k);
				if (!d) {
					if (!m) {
						notes.push(`${at}: delivery of a message before this page (${msgId})`);
					} else if (!m.to.includes(agentId)) {
						violations.push(`${at}: ${agentId} is not a recipient of ${msgId}`);
					}
					if (state !== "planned" && state !== "not-sent" && state !== "queued" && m) {
						violations.push(`${at}: first state of ${k} is ${state}, not planned/not-sent`);
					}
					d = { agentId, states: [], final: state, acked: false, sending: 0, lastState: "" };
					deliveries.set(k, d);
					m?.deliveries.push(d);
				}
				const last = d.lastState;
				const gid = grantOf(l);
				if (state === "queued") {
					// §3.1: only a D3 relay waits, and only as its first state.
					if (!gid) violations.push(`${at}: queued without a collab authorization`);
					if (last !== "") violations.push(`${at}: queued after ${last}`);
				} else if (state === "planned") {
					const b = l.binding as { sid?: string; cid?: string } | undefined;
					const ccmid = l.composer_client_message_id;
					if (!b || typeof b.sid !== "string" || typeof b.cid !== "string")
						violations.push(`${at}: planned without a fixed binding`);
					if (typeof ccmid !== "string") violations.push(`${at}: planned without a composer id`);
					else {
						const other = seenCcmid.get(ccmid);
						if (other && other !== k)
							violations.push(`${at}: composer id ${ccmid} reused by ${other}`);
						seenCcmid.set(ccmid, k);
						d.composerClientMessageId = ccmid;
					}
					d.sid = b?.sid;
					d.cid = b?.cid;
					if (last !== "" && !(last === "queued" && gid))
						violations.push(`${at}: planned after ${last}`);
				} else if (state === "placing") {
					if (last !== "planned") violations.push(`${at}: placing after ${last || "nothing"}`);
				} else if (state === "sending") {
					d.sending++;
					if (d.sending > 1) violations.push(`${at}: second sending for ${k} (§3.4 rule 1)`);
					if (last !== "planned" && last !== "placing")
						violations.push(`${at}: sending after ${last || "nothing"}`);
					// §7.5: a pause or an end written before S3 wins.
					const g = gid ? grants.get(gid) : undefined;
					if (gid && !g)
						notes.push(`${at}: sending under a grant created before this page (${gid})`);
					else if (g && g.state !== "live")
						violations.push(`${at}: sending under a ${g.state} grant (§7.5)`);
					// The one rule that depends on the clock: alive ⇔ before expires_at (§7.2).
					else if (g && typeof l.at === "string" && Date.parse(l.at) >= g.expiresAt)
						violations.push(`${at}: sending at or after the grant's expires_at (§7.2)`);
				} else if (state === "not-sent") {
					if (d.sending > 0) violations.push(`${at}: not-sent after sending for ${k}`);
					if (last !== "" && last !== "planned" && last !== "placing" && last !== "queued")
						violations.push(`${at}: not-sent after ${last}`);
				} else if (RESULTS.has(state)) {
					if (
						d.sending === 0 &&
						!(state === "uncertain" && /^(orphaned|restored)$/.test(String(l.reason)))
					)
						violations.push(`${at}: result ${state} with no sending before it`);
					if (RESULTS.has(last) || last === "not-sent" || last === "settled")
						violations.push(`${at}: second result for ${k} (${last} → ${state})`);
				} else if (state === "settled") {
					if (last !== "uncertain") violations.push(`${at}: settled after ${last || "nothing"}`);
				} else {
					violations.push(`${at}: unknown delivery state ${state}`);
				}
				d.states.push(state);
				d.lastState = state;
				d.final = state;
				d.reason = typeof l.reason === "string" ? l.reason : undefined;
				const http = l.http as { promptId?: string } | undefined;
				if (typeof http?.promptId === "string") d.promptId = http.promptId;
				break;
			}
			case "reply_settling":
			case "reply_ref": {
				const k = key(String(l.msg_id), String(l.agent_id));
				const d = deliveries.get(k);
				const delivered = d && (d.final === "delivered" || d.final === "settled");
				if (!d) {
					notes.push(`${at}: reply for a delivery before this page (${k})`);
				} else if (!delivered || !d.promptId) {
					violations.push(`${at}: reply for ${k}, which has no delivered promptId (§4.1)`);
				} else if (l.prompt_id !== d.promptId) {
					violations.push(`${at}: prompt_id ${String(l.prompt_id)} ≠ acked ${d.promptId}`);
				}
				if (d && typeof l.sid === "string" && d.sid && l.sid !== d.sid)
					violations.push(`${at}: reply from ${l.sid}, delivery fixed to ${d.sid}`);
				if (l.ev === "reply_settling") {
					settlingBy.set(k, l);
					break;
				}
				if (d?.reply) violations.push(`${at}: second reply_ref for ${k}`);
				const attribution = String(l.attribution);
				const settling = settlingBy.get(k);
				if (attribution === "exact") {
					// §4.1: exact only from a window this same process observed whole.
					if (!settling) violations.push(`${at}: exact without a reply_settling`);
					else if (settling.w !== l.w)
						violations.push(`${at}: exact written by another process than its settling`);
					else if (settling.turn_end_seq !== l.turn_end_seq)
						violations.push(`${at}: turn_end_seq differs from its settling`);
				}
				if (d) {
					d.reply = {
						attribution,
						promptId: typeof l.prompt_id === "string" ? l.prompt_id : undefined,
						sid: typeof l.sid === "string" ? l.sid : undefined,
						settledFirst: settling !== undefined,
					};
				}
				break;
			}
			case "grant": {
				const id = String(l.grant_id);
				const g = grants.get(id);
				if (l.event === "created") {
					if (g) violations.push(`${at}: grant ${id} created twice`);
					const ps = Array.isArray(l.participants)
						? (l.participants as Array<{ sid?: string }>)
						: [];
					if (ps.length !== 2 || ps[0]?.sid === ps[1]?.sid)
						violations.push(`${at}: grant without two participants in two sessions`);
					if (!messages.has(String(l.task_msg_id)))
						violations.push(`${at}: grant created without its task in this page`);
					grants.set(id, {
						state: "live",
						max: Number(l.max_messages),
						n: 0,
						expiresAt: Date.parse(String(l.expires_at)),
					});
				} else if (!g) {
					notes.push(`${at}: event of a grant created before this page (${id})`);
				} else if (g.state === "ended") {
					violations.push(`${at}: ${String(l.event)} after the grant ended`);
				} else if (l.event === "paused") {
					// A second pause is legitimate only when it changes who can lift it
					// (grantRules.ts `mayPause`): the person's over any other, or any cause
					// over `delivery-uncertain`.
					if (
						g.state === "paused" &&
						!(l.reason === "owner" ? g.reason !== "owner" : g.reason === "delivery-uncertain")
					)
						violations.push(`${at}: paused twice (${String(g.reason)} → ${String(l.reason)})`);
					g.state = "paused";
					g.reason = String(l.reason);
				} else if (l.event === "resumed") {
					if (g.state !== "paused") violations.push(`${at}: resumed while ${g.state}`);
					// §7.1: an agent never resumes; only the person or the Composer's evidence.
					if (l.by === "system") violations.push(`${at}: resumed by the system`);
					g.state = "live";
				} else if (l.event === "revoked" || l.event === "ended") {
					g.state = "ended";
				} else violations.push(`${at}: unknown grant event ${String(l.event)}`);
				break;
			}
			case "outbox": {
				const g = grants.get(String(l.grant_id));
				if (!g) {
					notes.push(`${at}: outbox of a grant created before this page`);
					break;
				}
				if (g.state === "ended") violations.push(`${at}: outbox written after the grant ended`);
				if (l.event === "accepted") {
					if (l.origin !== "match")
						violations.push(`${at}: admitted without origin match (§7.3.1)`);
					if (g.state !== "live") violations.push(`${at}: admitted on a ${g.state} grant`);
					const f = (l.from ?? {}) as { sid?: string };
					const id = `${String(l.grant_id)}/${String(f.sid)}/${String(l.path)}/${String(l.sha256)}`;
					if (admitted.has(id))
						violations.push(`${at}: the same file admitted twice (§7.3 rule 8)`);
					admitted.add(id);
				}
				break;
			}
			case "owner_ack": {
				const id = String(l.client_ack_id);
				if (ackIds.has(id)) violations.push(`${at}: client_ack_id ${id} written twice`);
				ackIds.add(id);
				const t = (l.target ?? {}) as { msg_id?: string; agent_id?: string };
				const m = t.msg_id ? messages.get(t.msg_id) : undefined;
				if (!m) {
					notes.push(`${at}: ack of a message before this page (${String(t.msg_id)})`);
					break;
				}
				if (t.agent_id && !m.to.includes(t.agent_id))
					violations.push(`${at}: ack of ${t.agent_id}, not a recipient of ${m.msgId}`);
				const set = acked.get(m.msgId) ?? new Set<string>();
				set.add(t.agent_id ?? "*");
				acked.set(m.msgId, set);
				break;
			}
			default:
				break;
		}
	}

	for (const m of messages.values()) {
		const a = acked.get(m.msgId) ?? new Set<string>();
		for (const d of m.deliveries) {
			d.acked = a.has("*") || a.has(d.agentId);
			if (d.reply?.attribution === "exact" && !d.acked) m.pending.push(d.agentId);
		}
		const missing = m.to.filter((t) => !m.deliveries.some((d) => d.agentId === t));
		if (missing.length > 0)
			violations.push(`message ${m.msgId}: no delivery for ${missing.join(", ")}`);
		if (m.to.length >= 2) {
			const ids = m.deliveries.map((d) => d.composerClientMessageId).filter(Boolean);
			const sids = m.deliveries.map((d) => d.sid).filter(Boolean);
			const prompts = m.deliveries.map((d) => d.reply?.promptId).filter(Boolean);
			m.independence = {
				distinctComposerIds: new Set(ids).size === ids.length,
				distinctSessions: new Set(sids).size === sids.length,
				distinctPrompts: new Set(prompts).size === prompts.length,
				individualAcks: [...a].filter((x) => x !== "*").length,
			};
			if (!m.independence.distinctComposerIds)
				violations.push(`message ${m.msgId}: two deliveries share a composer id`);
		}
	}

	const strip = (
		d: DeliverySummary & { sending?: number; lastState?: string },
	): DeliverySummary => {
		const { sending: _s, lastState: _l, ...rest } = d;
		return rest;
	};
	return {
		ok: violations.length === 0,
		firstSeq: lines[0]?.seq ?? null,
		lastSeq: lines[lines.length - 1]?.seq ?? null,
		lines: lines.length,
		writers: [...new Set(lines.map((l) => String(l.w ?? "")))].filter(Boolean),
		violations,
		notes,
		messages: [...messages.values()].map((m) => ({ ...m, deliveries: m.deliveries.map(strip) })),
	};
}
