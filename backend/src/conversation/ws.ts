/**
 * conversation/ws.ts — `WS /ws/conversation/<sessionId>` (docs/CONVERSATION.md
 * §6.1): one socket per browser tab carries the replay and the live events
 * of up to 8 conversations of one ST session.
 *
 * Determinism (same technique as the terminal attach): on `subscribe` the
 * live listener is armed BEFORE the file is read, events that land while
 * the replay runs are queued, and the queue is drained in order once the
 * replay is done, skipping every `seq` already sent. So the client sees
 * each persisted event with `seq > after` exactly once, in order.
 *
 * Backpressure is a byte budget per FRAME, on `ws.bufferedAmount`:
 *   - replay: a frame goes out only if `buffered + size ≤ 2 MiB` (or the
 *     buffer is empty, for a frame bigger than that); otherwise wait for
 *     the buffer to drain, up to 30 s, then close 1013 — the client
 *     reconnects from its last seq.
 *   - live: a frame goes out if `buffered + size ≤ 8 MiB`; otherwise the
 *     subscription stops forwarding and, once the buffer is under 2 MiB,
 *     gets ONE `resync{fromSeq: last sent}` and waits for the client to
 *     subscribe again. Nothing is lost: everything is in the file.
 *
 * Owner-only, like the REST reads: a foreign session closes exactly like a
 * missing one.
 */

import type { WebSocket } from "ws";
import { logger } from "../logger.js";
import { streamEvents } from "./reader.js";
import type { ConversationService } from "./service.js";
import type { PersistedEvent } from "./store.js";

const MiB = 1024 * 1024;

export interface ConversationWsLimits {
	replayBudget: number;
	liveBudget: number;
	drainTimeoutMs: number;
	drainPollMs: number;
	subscriptionsPerSocket: number;
	socketsPerUser: number;
	clientFrameBytes: number;
}

export const CONVERSATION_WS_LIMITS: ConversationWsLimits = {
	replayBudget: 2 * MiB,
	liveBudget: 8 * MiB,
	drainTimeoutMs: 30_000,
	drainPollMs: 20,
	subscriptionsPerSocket: 8,
	socketsPerUser: 4,
	clientFrameBytes: 4096,
};

/** WS close code for "try again later" (RFC 6455 §7.4.1 registry). */
export const CLOSE_TRY_AGAIN = 1013;

type ConversationReader = Pick<
	ConversationService,
	"summaries" | "conversationFile" | "residentState" | "onPersistedEvent" | "noteWsResync"
>;

interface Subscription {
	cid: string;
	mode: "replay" | "live" | "paused";
	lastSent: number;
	queue: PersistedEvent[];
	lastStatusKey: string | null;
}

export class ConversationWsHub {
	private readonly socketsByUser = new Map<string, number>();
	private readonly lim: ConversationWsLimits;

	constructor(
		private readonly conversations: ConversationReader,
		limits: Partial<ConversationWsLimits> = {},
	) {
		this.lim = { ...CONVERSATION_WS_LIMITS, ...limits };
	}

	/** For tests/stats. */
	openSockets(userId: string): number {
		return this.socketsByUser.get(userId) ?? 0;
	}

	/**
	 * Serve an already-authenticated socket whose owner check passed.
	 * The caller (wsHandler) does the cookie auth and `assertOwnedBy`.
	 */
	serve(ws: WebSocket, stSessionId: string, userId: string): void {
		const open = this.socketsByUser.get(userId) ?? 0;
		if (open >= this.lim.socketsPerUser) {
			this.sendRaw(ws, { type: "error", code: "too-many-sockets" });
			ws.close(1008, "Too many conversation sockets");
			return;
		}
		this.socketsByUser.set(userId, open + 1);
		const subs = new Map<string, Subscription>();
		let closed = false;

		const unlisten = this.conversations.onPersistedEvent((st, cid, event) => {
			if (st !== stSessionId) return;
			const sub = subs.get(cid);
			if (!sub) return;
			if (sub.mode === "paused") return; // persisted; the client resyncs
			sub.queue.push(event);
			if (sub.mode === "live") this.sendLive(ws, stSessionId, sub);
		});
		const cleanup = () => {
			if (closed) return;
			closed = true;
			unlisten();
			subs.clear();
			const n = (this.socketsByUser.get(userId) ?? 1) - 1;
			if (n <= 0) this.socketsByUser.delete(userId);
			else this.socketsByUser.set(userId, n);
		};
		ws.on("close", cleanup);
		ws.on("error", cleanup);

		ws.on("message", (raw: Buffer, isBinary: boolean) => {
			if (closed) return;
			if (isBinary || raw.length > this.lim.clientFrameBytes) {
				this.sendRaw(ws, { type: "error", code: "bad-request" });
				return;
			}
			let msg: { type?: unknown; conv?: unknown; after?: unknown };
			try {
				msg = JSON.parse(raw.toString("utf8"));
			} catch {
				this.sendRaw(ws, { type: "error", code: "bad-request" });
				return;
			}
			const conv = typeof msg.conv === "string" ? msg.conv : null;
			if (msg.type === "unsubscribe" && conv) {
				subs.delete(conv);
				return;
			}
			if (msg.type !== "subscribe" || !conv) {
				this.sendRaw(ws, { type: "error", code: "bad-request" });
				return;
			}
			const after =
				typeof msg.after === "number" && Number.isSafeInteger(msg.after) && msg.after >= 0
					? msg.after
					: 0;
			if (!subs.has(conv) && subs.size >= this.lim.subscriptionsPerSocket) {
				this.sendRaw(ws, { type: "error", code: "too-many-subscriptions", conv });
				return;
			}
			// Armed now, synchronously: from here every persisted event of
			// `conv` is queued, so none can fall between the file read and
			// the switch to live.
			const sub: Subscription = {
				cid: conv,
				mode: "replay",
				lastSent: after,
				queue: [],
				lastStatusKey: null,
			};
			subs.set(conv, sub);
			void this.replay(ws, stSessionId, sub, () => subs.get(conv) === sub && !closed).catch(
				(err) => {
					logger.warn(
						`[conversation-ws] replay failed for ${stSessionId}/${conv}: ${(err as Error).message}`,
					);
					if (subs.get(conv) === sub) subs.delete(conv);
					this.sendRaw(ws, { type: "error", code: "internal", conv });
				},
			);
		});

		void this.conversations
			.summaries(stSessionId)
			.then((list) => {
				if (closed) return;
				this.sendRaw(ws, {
					type: "hello",
					conversations: list.map((c) => ({
						cid: c.sessionId,
						lastSeq: c.lastSeq,
						firstRetainedSeq: c.firstRetainedSeq,
						status: c.status,
					})),
				});
			})
			.catch((err) => {
				logger.warn(`[conversation-ws] hello failed for ${stSessionId}: ${(err as Error).message}`);
				this.sendRaw(ws, { type: "hello", conversations: [] });
			});
	}

	// ── Replay ────────────────────────────────────────────────────────────

	private async replay(
		ws: WebSocket,
		st: string,
		sub: Subscription,
		current: () => boolean,
	): Promise<void> {
		const file = await this.conversations.conversationFile(st, sub.cid);
		if (!current()) return;
		if (!file) {
			this.sendRaw(ws, { type: "error", code: "not-found", conv: sub.cid });
			return;
		}
		const first = Math.max(1, file.index.firstRetainedSeq);
		if (sub.lastSent < first - 1) {
			if (!(await this.sendBudgeted(ws, gapFrame(sub.cid, sub.lastSent + 1, first - 1)))) return;
		}
		for await (const { event } of streamEvents(file.eventsFile)) {
			if (!current()) return;
			if (event.seq <= sub.lastSent || event.seq < first) continue;
			if (!(await this.sendBudgeted(ws, { type: "event", conv: sub.cid, event }))) return;
			if (!current()) return;
			sub.lastSent = event.seq;
		}
		if (!current()) return;
		// Queue → live with no await in between: `sendLive` drains what was
		// queued during the replay in order (skipping seqs the file already
		// gave), and from then on the listener feeds it directly.
		sub.mode = "live";
		this.sendLive(ws, st, sub);
	}

	/** Replay rule: ≤ 2 MiB in flight (+ one oversize frame on an empty buffer). */
	private async sendBudgeted(ws: WebSocket, frame: object): Promise<boolean> {
		const data = JSON.stringify(frame);
		const size = Buffer.byteLength(data, "utf8");
		const deadline = Date.now() + this.lim.drainTimeoutMs;
		while (ws.bufferedAmount + size > this.lim.replayBudget && ws.bufferedAmount > 0) {
			if (ws.readyState !== ws.OPEN) return false;
			if (Date.now() >= deadline) {
				ws.close(CLOSE_TRY_AGAIN, "Client not draining");
				return false;
			}
			await new Promise((r) => setTimeout(r, this.lim.drainPollMs));
		}
		if (ws.readyState !== ws.OPEN) return false;
		ws.send(data);
		return true;
	}

	// ── Live ──────────────────────────────────────────────────────────────

	/** Send every queued event in order under the live rule (mode must be "live"). */
	private sendLive(ws: WebSocket, st: string, sub: Subscription): void {
		while (sub.mode === "live" && sub.queue.length > 0) {
			const ev = sub.queue[0];
			if (ev.seq <= sub.lastSent) {
				sub.queue.shift();
				continue;
			}
			const data = JSON.stringify({ type: "event", conv: sub.cid, event: ev });
			const size = Buffer.byteLength(data, "utf8");
			if (ws.readyState !== ws.OPEN) return;
			if (ws.bufferedAmount + size > this.lim.liveBudget) {
				this.pause(ws, sub);
				return;
			}
			sub.queue.shift();
			ws.send(data);
			sub.lastSent = ev.seq;
		}
		this.sendStatus(ws, st, sub);
	}

	private pause(ws: WebSocket, sub: Subscription): void {
		sub.mode = "paused";
		sub.queue = [];
		this.conversations.noteWsResync();
		const deadline = Date.now() + this.lim.drainTimeoutMs;
		const poll = () => {
			if (ws.readyState !== ws.OPEN) return;
			if (ws.bufferedAmount < this.lim.replayBudget) {
				this.sendRaw(ws, { type: "resync", conv: sub.cid, fromSeq: sub.lastSent });
				return;
			}
			if (Date.now() >= deadline) {
				ws.close(CLOSE_TRY_AGAIN, "Client not draining");
				return;
			}
			setTimeout(poll, this.lim.drainPollMs).unref?.();
		};
		poll();
	}

	private sendStatus(ws: WebSocket, st: string, sub: Subscription): void {
		const state = this.conversations.residentState(st, sub.cid);
		if (!state) return;
		const key = `${state.status}|${state.evidence}|${state.at}`;
		if (key === sub.lastStatusKey) return;
		sub.lastStatusKey = key;
		this.sendRaw(ws, {
			type: "status",
			conv: sub.cid,
			status: state.status,
			evidence: state.evidence,
			at: new Date(state.at || 0).toISOString(),
		});
	}

	private sendRaw(ws: WebSocket, frame: object): void {
		if (ws.readyState !== ws.OPEN) return;
		try {
			ws.send(JSON.stringify(frame));
		} catch {
			/* the close handler cleans up */
		}
	}
}

function gapFrame(conv: string, from: number, to: number) {
	return { type: "gap", conv, reason: "history_rotated", from, to };
}
