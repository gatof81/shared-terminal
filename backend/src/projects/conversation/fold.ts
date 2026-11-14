/**
 * projects/conversation/fold.ts — the state a project log folds into
 * (docs/PROJECT_CONVERSATION.md §2.2, §3.1). Pure: the log is the truth and
 * this is recomputed from it on every open, so there is no snapshot that
 * could disagree with the file (the §2 `.index.json` cache is not needed for
 * correctness and is not written in D1).
 */

import type { LogLine } from "./log.js";

export type DeliveryState =
	| "queued"
	| "planned"
	| "placing"
	| "sending"
	| "settled"
	| "delivered"
	| "unconfirmed"
	| "misdelivered"
	| "failed"
	| "uncertain"
	| "refused"
	| "not-sent";

/** States after which this log never calls the Composer for the delivery (§3.4 rule 1). */
const RESULT_STATES: ReadonlySet<DeliveryState> = new Set([
	"settled",
	"delivered",
	"unconfirmed",
	"misdelivered",
	"failed",
	"uncertain",
	"refused",
	"not-sent",
]);

export interface DeliveryFold {
	msgId: string;
	agentId: string;
	state: DeliveryState;
	/** A `placing` / `sending` line exists (whatever came after). */
	placed: boolean;
	sent: boolean;
	binding?: { binding_id: string; epoch: number; sid: string; cid: string };
	composerClientMessageId?: string;
	/** `owner` or `collab:<grant_id>` (§2.2). */
	authorizedBy?: string;
	/** ISO time of its `queued` line (D3, §7.5): what `maxWaitMin` counts from. */
	queuedAt?: string;
	promptId?: string;
	/** The acknowledged `user_prompt`'s seq in the capture (Composer `seq`). */
	ackSeq?: number;
	reason?: string;
	/** On `settled`: the Composer result it settled to. */
	result?: string;
	lastSeq: number;
}

export interface MessageFold {
	msgId: string;
	seq: number;
	kind: "owner" | "relay";
	clientMessageId: string | null;
	requestSha256: string | null;
	to: string[];
	/** D3: the grant this message belongs to (its task, or a relay under it). */
	grantId?: string;
	/** D3, `kind: relay`: the agent that wrote it. */
	from?: string;
	/** D3, `kind: relay`: its body (what a queued delivery will carry) and its place in the grant. */
	text?: string;
	relay?: { n: number; kind: string };
}

export interface GrantParticipant {
	agent_id: string;
	binding_id: string;
	epoch: number;
	sid: string;
}

/** A D3 grant as the log says it is (§7.2, §7.5). `paused` is still alive. */
export interface GrantFold {
	grantId: string;
	taskMsgId: string;
	by: string;
	initiator: string;
	with: string;
	participants: GrantParticipant[];
	maxMessages: number;
	maxWaitMin: number;
	expiresAt: string;
	state: "live" | "paused" | "ended";
	/** Why it is paused or ended. */
	reason?: string;
	/** The delivery whose outcome paused it (what an evidence resume must match). */
	pauseRef?: { msg_id: string; agent_id: string };
	/** Relay messages counted against `maxMessages` (ask/reply). */
	used: number;
	/** `outbox{rejected}` lines written, in total and per agent (§7.3). */
	rejected: number;
	rejectedBy: Map<string, number>;
}

/** §7.2: alive ⇔ not revoked/ended and before `expires_at`. Paused is alive. */
export function grantAlive(g: GrantFold, nowMs: number): boolean {
	return g.state !== "ended" && nowMs < Date.parse(g.expiresAt);
}

export const outboxKey = (grantId: string, sid: string, path: string, sha256: string): string =>
	`${grantId}\u0000${sid}\u0000${path}\u0000${sha256}`;

export interface Folded {
	lastSeq: number;
	messages: Map<string, MessageFold>;
	/** client_message_id → msg_id, every one in the project (no window, §3.4 rule 2). */
	byClientMessageId: Map<string, string>;
	deliveries: Map<string, DeliveryFold>;
	/** `${msg}/${agent}` → the settling line, until a reply_ref closes it. */
	settling: Map<string, LogLine>;
	replyRefs: Set<string>;
	/** `${msg}/${agent}/${capture_seq}` of each reply_late_close. */
	lateCloses: Set<string>;
	/** client_ack_id → the owner_ack line. */
	acks: Map<string, LogLine>;
	/** restore_ids already applied by a `recovery{source: restore}`. */
	restoresApplied: Set<string>;
	/** sha256 → its first registration's name and bytes, and every `sid:path` it came from (§6.2). */
	artifacts: Map<string, { name: string; bytes: number; sources: Set<string> }>;
	/** Bytes of distinct registered artifacts: what PROJECT_ARTIFACTS_MAX_BYTES counts (§6.1). */
	artifactBytes: number;
	/** D3 grants by id (§7). Empty in a log that never had one. */
	grants: Map<string, GrantFold>;
	/** `outboxKey` of every ADMITTED outbox file (§7.3 rule 8). */
	outboxAccepted: Set<string>;
	/** `outboxKey` (sha256 = "" when unread) of every `outbox{unverified}` (§7.5): written once. */
	outboxUnverified: Set<string>;
	writers: Set<string>;
}

export const deliveryKey = (msgId: string, agentId: string): string => `${msgId}/${agentId}`;

export function emptyFold(): Folded {
	return {
		lastSeq: 0,
		messages: new Map(),
		byClientMessageId: new Map(),
		deliveries: new Map(),
		settling: new Map(),
		replyRefs: new Set(),
		lateCloses: new Set(),
		acks: new Map(),
		restoresApplied: new Set(),
		artifacts: new Map(),
		artifactBytes: 0,
		grants: new Map(),
		outboxAccepted: new Set(),
		outboxUnverified: new Set(),
		writers: new Set(),
	};
}

export function isResultState(s: DeliveryState): boolean {
	return RESULT_STATES.has(s);
}

/** Applies lines in order; mutates and returns `f`. */
export function fold(f: Folded, lines: readonly LogLine[]): Folded {
	for (const l of lines) {
		f.lastSeq = l.seq;
		f.writers.add(l.w);
		switch (l.ev) {
			case "message": {
				const msgId = l.msg_id as string;
				const cmid = (l.client_message_id as string | null) ?? null;
				f.messages.set(msgId, {
					msgId,
					seq: l.seq,
					kind: l.kind === "relay" ? "relay" : "owner",
					clientMessageId: cmid,
					requestSha256: (l.request_sha256 as string | null) ?? null,
					to: Array.isArray(l.to) ? (l.to as string[]) : [],
					...(grantOf(l) ? { grantId: grantOf(l) } : {}),
					...(typeof l.from === "string" ? { from: l.from } : {}),
					...(l.kind === "relay"
						? {
								text: typeof l.text === "string" ? l.text : "",
								relay: {
									n: Number((l.relay as { n?: unknown } | null)?.n ?? 0),
									kind: String((l.relay as { kind?: unknown } | null)?.kind ?? ""),
								},
							}
						: {}),
				});
				if (cmid) f.byClientMessageId.set(cmid, msgId);
				const relay = l.relay as { grant_id?: string; kind?: string } | null | undefined;
				if (l.kind === "relay" && relay && (relay.kind === "ask" || relay.kind === "reply")) {
					const g = f.grants.get(relay.grant_id as string);
					if (g) g.used++;
				}
				break;
			}
			case "delivery": {
				const msgId = l.msg_id as string;
				const agentId = l.agent_id as string;
				const key = deliveryKey(msgId, agentId);
				const prev = f.deliveries.get(key);
				const state = l.state as DeliveryState;
				const http = l.http as { promptId?: string; seq?: number } | undefined;
				f.deliveries.set(key, {
					msgId,
					agentId,
					state,
					placed: (prev?.placed ?? false) || state === "placing",
					sent: (prev?.sent ?? false) || state === "sending",
					binding: (l.binding as DeliveryFold["binding"]) ?? prev?.binding,
					composerClientMessageId:
						(l.composer_client_message_id as string | undefined) ?? prev?.composerClientMessageId,
					authorizedBy: (l.authorized_by as string | undefined) ?? prev?.authorizedBy,
					queuedAt: state === "queued" ? l.at : prev?.queuedAt,
					promptId: http?.promptId ?? (l.prompt_id as string | undefined) ?? prev?.promptId,
					ackSeq: http?.seq ?? prev?.ackSeq,
					reason: (l.reason as string | undefined) ?? undefined,
					result: (l.result as string | undefined) ?? undefined,
					lastSeq: l.seq,
				});
				break;
			}
			case "reply_settling":
				f.settling.set(deliveryKey(l.msg_id as string, l.agent_id as string), l);
				break;
			case "reply_ref": {
				const key = deliveryKey(l.msg_id as string, l.agent_id as string);
				f.replyRefs.add(key);
				f.settling.delete(key);
				break;
			}
			case "reply_late_close":
				f.lateCloses.add(
					`${l.msg_id as string}/${l.agent_id as string}/${l.capture_seq as number}`,
				);
				break;
			case "owner_ack":
				f.acks.set(l.client_ack_id as string, l);
				break;
			case "artifact": {
				const sha = l.sha256 as string;
				const src = l.source as { sid?: string; path?: string } | undefined;
				let a = f.artifacts.get(sha);
				if (!a) {
					a = { name: l.name as string, bytes: l.bytes as number, sources: new Set() };
					f.artifacts.set(sha, a);
					f.artifactBytes += a.bytes;
				}
				a.sources.add(`${src?.sid}:${src?.path}`);
				break;
			}
			case "grant": {
				const id = l.grant_id as string;
				if (l.event === "created") {
					f.grants.set(id, {
						grantId: id,
						taskMsgId: l.task_msg_id as string,
						by: l.by as string,
						initiator: l.initiator as string,
						with: l.with as string,
						participants: (l.participants as GrantParticipant[]) ?? [],
						maxMessages: l.max_messages as number,
						maxWaitMin: l.max_wait_min as number,
						expiresAt: l.expires_at as string,
						state: "live",
						used: 0,
						rejected: 0,
						rejectedBy: new Map(),
					});
					break;
				}
				const g = f.grants.get(id);
				// An ended grant never changes again (§7.5), whatever a later line says.
				if (!g || g.state === "ended") break;
				if (l.event === "paused") {
					g.state = "paused";
					g.reason = l.reason as string | undefined;
					g.pauseRef = l.ref as GrantFold["pauseRef"];
				} else if (l.event === "resumed") {
					g.state = "live";
					g.reason = undefined;
					g.pauseRef = undefined;
				} else if (l.event === "revoked" || l.event === "ended") {
					g.state = "ended";
					g.reason = l.event === "revoked" ? "revoked" : (l.reason as string | undefined);
					g.pauseRef = undefined;
				}
				break;
			}
			case "outbox": {
				const from = l.from as { agent_id?: string; sid?: string } | undefined;
				const key = outboxKey(
					l.grant_id as string,
					String(from?.sid),
					l.path as string,
					(l.sha256 as string | undefined) ?? "",
				);
				if (l.event === "accepted") f.outboxAccepted.add(key);
				else if (l.event === "unverified") f.outboxUnverified.add(key);
				else if (l.event === "rejected") {
					const g = f.grants.get(l.grant_id as string);
					if (g) {
						g.rejected++;
						const a = String(from?.agent_id);
						g.rejectedBy.set(a, (g.rejectedBy.get(a) ?? 0) + 1);
					}
				}
				break;
			}
			case "recovery":
				if (l.source === "restore" && typeof l.restore_id === "string") {
					f.restoresApplied.add(l.restore_id);
				}
				break;
			default:
				// Unknown kinds (a newer writer's) fold to nothing here.
				break;
		}
	}
	return f;
}

/** The grant a `message` line belongs to: its `collab` (the task) or its `relay`. */
function grantOf(l: LogLine): string | undefined {
	const c = l.collab as { grant_id?: unknown } | null | undefined;
	if (c && typeof c.grant_id === "string") return c.grant_id;
	const r = l.relay as { grant_id?: unknown } | null | undefined;
	if (r && typeof r.grant_id === "string") return r.grant_id;
	return undefined;
}
