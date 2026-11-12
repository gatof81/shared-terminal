/**
 * projects/conversation/fold.ts — the state a project log folds into
 * (docs/PROJECT_CONVERSATION.md §2.2, §3.1). Pure: the log is the truth and
 * this is recomputed from it on every open, so there is no snapshot that
 * could disagree with the file (the §2 `.index.json` cache is not needed for
 * correctness and is not written in D1).
 */

import type { LogLine } from "./log.js";

export type DeliveryState =
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
}

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
				});
				if (cmid) f.byClientMessageId.set(cmid, msgId);
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
			case "recovery":
				if (l.source === "restore" && typeof l.restore_id === "string") {
					f.restoresApplied.add(l.restore_id);
				}
				break;
			default:
				// Unknown kinds (a newer writer's, D3 events) fold to nothing here.
				break;
		}
	}
	return f;
}
