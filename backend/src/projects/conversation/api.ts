/**
 * projects/conversation/api.ts — the read side and `owner_ack` of the project
 * conversation (docs/PROJECT_CONVERSATION.md §4.3, §5, Appendix A), and the
 * owner check every route and the WS share.
 *
 * Reads are served from the store's in-memory copy of the acknowledged log
 * (store.view), so a page is a slice of one consistent snapshot: append-only
 * plus contiguous seq ⇒ `before` cursors are stable, no gap, no duplicate.
 */

import { createHash, randomUUID } from "node:crypto";
import type { HttpResult } from "../../conversation/composer.js";
import type { ProjectFanout } from "./fanout.js";
import type { LogLine } from "./log.js";
import { ProjectLogError } from "./log.js";
import type { ProjectConversationStore } from "./store.js";

export const EVENTS_PAGE_MAX = 500;
export const EVENTS_PAGE_DEFAULT = 200;
export const EVENTS_PAGE_MAX_BYTES = 8 * 1024 * 1024;
const OWNER_CACHE_MAX = 10_000;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{64}$/;
const EV_RE = /^[a-z_]{1,32}$/;

const err = (status: number, code: string, detail?: string): HttpResult => ({
	status,
	body: detail ? { error: code, detail } : { error: code },
});

export function logErrorToHttp(e: unknown): HttpResult | null {
	if (!(e instanceof ProjectLogError)) return null;
	if (e.code === "persist-failed" || e.code === "project-writer-unavailable")
		return err(503, e.code);
	return err(409, e.code, e.message === "restore-incomplete" ? "restore-incomplete" : undefined);
}

export interface ProjectConversationApiDeps {
	store: ProjectConversationStore;
	fanout: ProjectFanout;
	ownsProject(ownerId: string, projectId: string): Promise<boolean>;
}

export class ProjectConversationApi {
	/** `${owner}/${project}` known to be owned: ownership never changes, so a hit is final. */
	private readonly owned = new Set<string>();

	constructor(private readonly deps: ProjectConversationApiDeps) {}

	get store(): ProjectConversationStore {
		return this.deps.store;
	}

	async owns(ownerId: string, projectId: string): Promise<boolean> {
		const key = `${ownerId}/${projectId}`;
		if (this.owned.has(key)) return true;
		const ok = await this.deps.ownsProject(ownerId, projectId);
		if (ok) {
			// One entry out, oldest first (insertion order) — never a mass
			// invalidation that sends every request to D1 at once.
			if (this.owned.size >= OWNER_CACHE_MAX) {
				const oldest = this.owned.values().next().value;
				if (oldest !== undefined) this.owned.delete(oldest);
			}
			this.owned.add(key);
		}
		return ok;
	}

	send(ownerId: string, projectId: string, body: unknown): Promise<HttpResult> {
		return this.deps.fanout.send(ownerId, projectId, body);
	}

	async events(projectId: string, query: Record<string, unknown>): Promise<HttpResult> {
		const before = query.before === undefined ? null : Number(query.before);
		const limit = query.limit === undefined ? EVENTS_PAGE_DEFAULT : Number(query.limit);
		if (before !== null && (!Number.isInteger(before) || before < 1))
			return err(400, "invalid-query", "before");
		if (!Number.isInteger(limit) || limit < 1 || limit > EVENTS_PAGE_MAX)
			return err(400, "invalid-query", "limit");
		let evs: Set<string> | null = null;
		if (query.ev !== undefined) {
			if (typeof query.ev !== "string") return err(400, "invalid-query", "ev");
			const list = query.ev.split(",").filter(Boolean);
			if (list.length === 0 || list.some((e) => !EV_RE.test(e)))
				return err(400, "invalid-query", "ev");
			evs = new Set(list);
		}
		const { lines } = await this.deps.store.view(projectId);
		// Walk backward from `before` (exclusive); `oldestSeq` is the last line
		// EXAMINED, so a filtered page never makes the next one skip a match.
		const out: LogLine[] = [];
		let bytes = 0;
		let i = before === null ? lines.length - 1 : Math.min(before - 2, lines.length - 1);
		let oldestSeq: number | null = null;
		for (; i >= 0; i--) {
			const l = lines[i] as LogLine;
			if (evs && !evs.has(l.ev)) {
				oldestSeq = l.seq;
				continue;
			}
			const size = Buffer.byteLength(JSON.stringify(l), "utf8");
			if (out.length > 0 && bytes + size > EVENTS_PAGE_MAX_BYTES) break;
			out.push(l);
			bytes += size;
			oldestSeq = l.seq;
			if (out.length >= limit) {
				i--;
				break;
			}
		}
		out.reverse();
		return {
			status: 200,
			body: { events: out, oldestSeq, hasMore: i >= 0 },
		};
	}

	async message(projectId: string, msgId: string): Promise<HttpResult> {
		if (!ID_RE.test(msgId)) return err(404, "message-not-found");
		const id = msgId.toLowerCase();
		const { lines } = await this.deps.store.view(projectId);
		const message = lines.find((l) => l.ev === "message" && l.msg_id === id);
		if (!message) return err(404, "message-not-found");
		const deliveries = new Map<string, LogLine[]>();
		const replies = new Map<
			string,
			{ settling: LogLine | null; ref: LogLine | null; lateCloses: LogLine[] }
		>();
		const acks: LogLine[] = [];
		for (const l of lines) {
			if (l.ev === "owner_ack") {
				if ((l.target as { msg_id?: string } | undefined)?.msg_id === id) acks.push(l);
				continue;
			}
			if (l.msg_id !== id) continue;
			const agent = l.agent_id as string;
			if (l.ev === "delivery") deliveries.set(agent, [...(deliveries.get(agent) ?? []), l]);
			else if (l.ev === "reply_settling" || l.ev === "reply_ref" || l.ev === "reply_late_close") {
				const r = replies.get(agent) ?? { settling: null, ref: null, lateCloses: [] };
				if (l.ev === "reply_settling") r.settling = l;
				else if (l.ev === "reply_ref") r.ref = l;
				else r.lateCloses.push(l);
				replies.set(agent, r);
			}
		}
		return {
			status: 200,
			body: {
				message,
				deliveries: [...deliveries].map(([agentId, events]) => ({
					agentId,
					state: (events[events.length - 1] as LogLine).state,
					events,
				})),
				replies: [...replies].map(([agentId, r]) => ({ agentId, ...r })),
				acks,
			},
		};
	}

	/** §4.3: idempotent by clientAckId under the lock; the canonical body decides a conflict. */
	async ack(ownerId: string, projectId: string, raw: unknown): Promise<HttpResult> {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return err(400, "invalid-body");
		const b = raw as Record<string, unknown>;
		const t = b.target as Record<string, unknown> | undefined;
		if (typeof b.clientAckId !== "string" || !UUID_V4_RE.test(b.clientAckId))
			return err(400, "invalid-body", "clientAckId");
		if (!t || typeof t !== "object" || typeof t.msgId !== "string" || !ID_RE.test(t.msgId)) {
			return err(400, "invalid-body", "target.msgId");
		}
		if (t.agentId !== undefined && (typeof t.agentId !== "string" || !ID_RE.test(t.agentId))) {
			return err(400, "invalid-body", "target.agentId");
		}
		if (
			t.reportSha256 !== undefined &&
			(typeof t.reportSha256 !== "string" || !SHA_RE.test(t.reportSha256))
		) {
			return err(400, "invalid-body", "target.reportSha256");
		}
		const target: Record<string, string> = { msg_id: t.msgId.toLowerCase() };
		if (typeof t.agentId === "string") target.agent_id = t.agentId.toLowerCase();
		if (typeof t.reportSha256 === "string") target.report_sha256 = t.reportSha256;
		const clientAckId = b.clientAckId.toLowerCase();
		const requestSha256 = createHash("sha256")
			.update(JSON.stringify({ target: Object.fromEntries(Object.entries(target).sort()) }), "utf8")
			.digest("hex");
		try {
			return await this.deps.store.critical(projectId, async (tx) => {
				const known = tx.state.acks.get(clientAckId);
				if (known) {
					return known.request_sha256 === requestSha256
						? { status: 200, body: { ackId: known.ack_id, seq: known.seq, replayed: true } }
						: err(409, "idempotency-conflict");
				}
				if (!tx.state.messages.has(target.msg_id as string)) return err(404, "message-not-found");
				const ackId = randomUUID();
				const [line] = await tx.append([
					{
						ev: "owner_ack",
						ack_id: ackId,
						client_ack_id: clientAckId,
						by: ownerId,
						target,
						request_sha256: requestSha256,
					},
				]);
				return { status: 201, body: { ackId, seq: line?.seq, replayed: false } };
			});
		} catch (e) {
			const h = logErrorToHttp(e);
			if (h) return h;
			throw e;
		}
	}
}
