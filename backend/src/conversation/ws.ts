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
 *   - queued during a replay: the live events that land while a replay
 *     runs are held in memory, bounded in BYTES (`queueBudget`). Past it
 *     the queue is dropped, the replay stops and the subscription takes
 *     the same `resync{fromSeq: last sent}` path — every dropped event is
 *     persisted and comes back from the file on the client's re-subscribe.
 *
 * A subscription is invalidated (`cancelled`) the moment a new `subscribe`
 * for the same conversation replaces it, an `unsubscribe` removes it or
 * the socket closes. Every send path re-checks that synchronously right
 * before `ws.send`, also after a backpressure wait, so a replay or resync
 * of a dead subscription can never interleave its frames with the new one.
 *
 * Owner-only, like the REST reads: a foreign session closes exactly like a
 * missing one.
 */

import type { WebSocket } from "ws";
import { logger } from "../logger.js";
import { streamEvents } from "./reader.js";
import type { ConversationService } from "./service.js";

const MiB = 1024 * 1024;

export interface ConversationWsLimits {
	replayBudget: number;
	liveBudget: number;
	drainTimeoutMs: number;
	drainPollMs: number;
	subscriptionsPerSocket: number;
	socketsPerUser: number;
	clientFrameBytes: number;
	/** Bytes of live events held while a replay runs (per subscription). */
	queueBudget: number;
}

export const CONVERSATION_WS_LIMITS: ConversationWsLimits = {
	replayBudget: 2 * MiB,
	liveBudget: 8 * MiB,
	drainTimeoutMs: 30_000,
	drainPollMs: 20,
	subscriptionsPerSocket: 8,
	socketsPerUser: 4,
	clientFrameBytes: 4096,
	queueBudget: 8 * MiB,
};

/** WS close code for "try again later" (RFC 6455 §7.4.1 registry). */
export const CLOSE_TRY_AGAIN = 1013;

type ConversationReader = Pick<
	ConversationService,
	"summaries" | "conversationFile" | "residentState" | "onPersistedEvent" | "noteWsResync"
>;

interface QueuedFrame {
	seq: number;
	data: string;
	bytes: number;
}

interface Subscription {
	cid: string;
	mode: "replay" | "live" | "paused";
	/** Set once, never cleared: replaced, unsubscribed or socket closed. */
	cancelled: boolean;
	lastSent: number;
	queue: QueuedFrame[];
	queueBytes: number;
	lastStatusKey: string | null;
}

export interface ConversationWsDeps {
	/** The backpressure wait; injectable so tests can hold it as a barrier. */
	sleep: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) =>
	new Promise<void>((r) => {
		setTimeout(r, ms).unref?.();
	});

export class ConversationWsHub {
	private readonly socketsByUser = new Map<string, number>();
	private readonly lim: ConversationWsLimits;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly active = new Set<Subscription>();

	constructor(
		private readonly conversations: ConversationReader,
		limits: Partial<ConversationWsLimits> = {},
		deps: Partial<ConversationWsDeps> = {},
	) {
		this.lim = { ...CONVERSATION_WS_LIMITS, ...limits };
		this.sleep = deps.sleep ?? realSleep;
	}

	/** For tests/stats. */
	openSockets(userId: string): number {
		return this.socketsByUser.get(userId) ?? 0;
	}

	/** For tests/stats: live-event bytes held in memory across all subscriptions. */
	queuedBytes(): number {
		let n = 0;
		for (const sub of this.active) n += sub.queueBytes;
		return n;
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
		const drop = (sub: Subscription | undefined) => {
			if (!sub) return;
			sub.cancelled = true;
			sub.queue = [];
			sub.queueBytes = 0;
			this.active.delete(sub);
			if (subs.get(sub.cid) === sub) subs.delete(sub.cid);
		};

		const unlisten = this.conversations.onPersistedEvent((st, cid, event) => {
			if (st !== stSessionId) return;
			const sub = subs.get(cid);
			if (!sub || sub.cancelled) return;
			if (sub.mode === "paused") return; // persisted; the client resyncs
			const data = JSON.stringify({ type: "event", conv: cid, event });
			const bytes = Buffer.byteLength(data, "utf8");
			if (sub.mode === "replay" && sub.queueBytes + bytes > this.lim.queueBudget) {
				// The replay is behind by more than the budget: stop holding
				// events in memory. All of them are in the file; the replay
				// stops (it checks `mode`) and the client re-subscribes from
				// the last seq it actually got.
				this.pause(ws, sub);
				return;
			}
			sub.queue.push({ seq: event.seq, data, bytes });
			sub.queueBytes += bytes;
			if (sub.mode === "live") this.sendLive(ws, stSessionId, sub);
		});
		const cleanup = () => {
			if (closed) return;
			closed = true;
			unlisten();
			for (const sub of [...subs.values()]) drop(sub);
			subs.clear();
			const n = (this.socketsByUser.get(userId) ?? 1) - 1;
			if (n <= 0) this.socketsByUser.delete(userId);
			else this.socketsByUser.set(userId, n);
		};
		ws.on("close", cleanup);
		ws.on("error", cleanup);

		const onMessage = (raw: Buffer, isBinary: boolean) => {
			if (closed) return;
			if (isBinary || raw.length > this.lim.clientFrameBytes) {
				this.sendRaw(ws, { type: "error", code: "bad-request" });
				return;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw.toString("utf8"));
			} catch {
				this.sendRaw(ws, { type: "error", code: "bad-request" });
				return;
			}
			// Valid JSON is not a valid frame: `null`, a number, a string or
			// an array must be refused here, before any property access.
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				this.sendRaw(ws, { type: "error", code: "bad-request" });
				return;
			}
			const msg = parsed as { type?: unknown; conv?: unknown; after?: unknown };
			const conv = typeof msg.conv === "string" && msg.conv.length > 0 ? msg.conv : null;
			if (msg.type === "unsubscribe" && conv) {
				drop(subs.get(conv));
				return;
			}
			if (msg.type !== "subscribe" || !conv) {
				this.sendRaw(ws, { type: "error", code: "bad-request" });
				return;
			}
			if (msg.after !== undefined && !isCursor(msg.after)) {
				this.sendRaw(ws, { type: "error", code: "bad-request", conv });
				return;
			}
			const after = msg.after === undefined ? 0 : (msg.after as number);
			if (!subs.has(conv) && subs.size >= this.lim.subscriptionsPerSocket) {
				this.sendRaw(ws, { type: "error", code: "too-many-subscriptions", conv });
				return;
			}
			// The previous subscription (a replay possibly parked in a
			// backpressure wait, or a pending resync) dies HERE, before the
			// new one exists, so it cannot send another frame.
			drop(subs.get(conv));
			// Armed now, synchronously: from here every persisted event of
			// `conv` is queued, so none can fall between the file read and
			// the switch to live.
			const sub: Subscription = {
				cid: conv,
				mode: "replay",
				cancelled: false,
				lastSent: after,
				queue: [],
				queueBytes: 0,
				lastStatusKey: null,
			};
			subs.set(conv, sub);
			this.active.add(sub);
			void this.replay(ws, stSessionId, sub).catch((err) => {
				logger.warn(
					`[conversation-ws] replay failed for ${stSessionId}/${conv}: ${(err as Error).message}`,
				);
				if (sub.cancelled) return;
				drop(sub);
				this.sendRaw(ws, { type: "error", code: "internal", conv });
			});
		};
		ws.on("message", (raw: Buffer, isBinary: boolean) => {
			// A throw out of a `ws` listener is an uncaught exception for
			// the whole process; whatever slipped past validation is
			// answered on this socket and logged instead.
			try {
				onMessage(raw, isBinary);
			} catch (err) {
				logger.warn(
					`[conversation-ws] message handling failed for ${stSessionId}: ${(err as Error).message}`,
				);
				this.sendRaw(ws, { type: "error", code: "bad-request" });
			}
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

	private async replay(ws: WebSocket, st: string, sub: Subscription): Promise<void> {
		const current = () => !sub.cancelled && sub.mode === "replay";
		const file = await this.conversations.conversationFile(st, sub.cid);
		if (!current()) return;
		if (!file) {
			this.sendRaw(ws, { type: "error", code: "not-found", conv: sub.cid });
			return;
		}
		const first = Math.max(1, file.index.firstRetainedSeq);
		if (sub.lastSent < first - 1) {
			const gap = gapFrame(sub.cid, sub.lastSent + 1, first - 1);
			if (!(await this.sendBudgeted(ws, gap, current, null))) return;
		}
		for await (const { event } of streamEvents(file.eventsFile)) {
			if (!current()) return;
			if (event.seq <= sub.lastSent || event.seq < first) continue;
			const frame = { type: "event", conv: sub.cid, event };
			if (!(await this.sendBudgeted(ws, frame, current, () => (sub.lastSent = event.seq)))) return;
		}
		if (!current()) return;
		// Queue → live with no await in between: `sendLive` drains what was
		// queued during the replay in order (skipping seqs the file already
		// gave), and from then on the listener feeds it directly.
		sub.mode = "live";
		this.sendLive(ws, st, sub);
	}

	/**
	 * Replay rule: ≤ 2 MiB in flight (+ one oversize frame on an empty
	 * buffer). `current` is re-checked after every wait and immediately
	 * before the send, and `onSent` (the cursor update) runs in the same
	 * synchronous block as `ws.send` — so a frame goes out only for a live
	 * subscription, and a resync triggered at any later point carries the
	 * seq that was really sent.
	 */
	private async sendBudgeted(
		ws: WebSocket,
		frame: object,
		current: () => boolean,
		onSent: (() => void) | null,
	): Promise<boolean> {
		const data = JSON.stringify(frame);
		const size = Buffer.byteLength(data, "utf8");
		const deadline = Date.now() + this.lim.drainTimeoutMs;
		while (ws.bufferedAmount + size > this.lim.replayBudget && ws.bufferedAmount > 0) {
			if (ws.readyState !== ws.OPEN || !current()) return false;
			if (Date.now() >= deadline) {
				ws.close(CLOSE_TRY_AGAIN, "Client not draining");
				return false;
			}
			await this.sleep(this.lim.drainPollMs);
		}
		if (ws.readyState !== ws.OPEN || !current()) return false;
		ws.send(data);
		onSent?.();
		return true;
	}

	// ── Live ──────────────────────────────────────────────────────────────

	/** Send every queued event in order under the live rule (mode must be "live"). */
	private sendLive(ws: WebSocket, st: string, sub: Subscription): void {
		while (sub.mode === "live" && !sub.cancelled && sub.queue.length > 0) {
			const item = sub.queue[0];
			if (item.seq <= sub.lastSent) {
				sub.queue.shift();
				sub.queueBytes -= item.bytes;
				continue;
			}
			if (ws.readyState !== ws.OPEN) return;
			if (ws.bufferedAmount + item.bytes > this.lim.liveBudget) {
				this.pause(ws, sub);
				return;
			}
			sub.queue.shift();
			sub.queueBytes -= item.bytes;
			ws.send(item.data);
			sub.lastSent = item.seq;
		}
		this.sendStatus(ws, st, sub);
	}

	/**
	 * Stop forwarding (live over budget, or the replay queue over its
	 * budget) and, once the buffer has drained, send ONE resync from the
	 * last seq this subscription really sent. A subscription replaced or
	 * removed meanwhile gets nothing.
	 */
	private pause(ws: WebSocket, sub: Subscription): void {
		sub.mode = "paused";
		sub.queue = [];
		sub.queueBytes = 0;
		this.conversations.noteWsResync();
		const deadline = Date.now() + this.lim.drainTimeoutMs;
		const poll = async () => {
			while (ws.bufferedAmount >= this.lim.replayBudget) {
				if (ws.readyState !== ws.OPEN || sub.cancelled) return;
				if (Date.now() >= deadline) {
					ws.close(CLOSE_TRY_AGAIN, "Client not draining");
					return;
				}
				await this.sleep(this.lim.drainPollMs);
			}
			if (sub.cancelled) return;
			this.sendRaw(ws, { type: "resync", conv: sub.cid, fromSeq: sub.lastSent });
		};
		void poll();
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

function isCursor(v: unknown): v is number {
	return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function gapFrame(conv: string, from: number, to: number) {
	return { type: "gap", conv, reason: "history_rotated", from, to };
}
