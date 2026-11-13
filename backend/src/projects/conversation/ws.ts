/**
 * projects/conversation/ws.ts — `WS /ws/project/<pid>` (docs/PROJECT_CONVERSATION.md
 * §5, Appendix A): every persisted project event after the client's cursor,
 * once, in seq order, then live.
 *
 * Same determinism as conversation/ws.ts, simpler because the log is held in
 * memory: on `subscribe{after}` the live listener is armed FIRST (lines it
 * sees are queued), then the snapshot is taken under the project lock; the
 * snapshot is sent, then the queue, both deduplicated by seq. Backpressure:
 * past `liveBudget` buffered bytes the client gets ONE `resync{fromSeq}` and
 * nothing more until it subscribes again (everything is in the log).
 *
 * The queue held while the snapshot is pending is bounded in BYTES
 * (`queueBudget`, the contract's "cola en bytes", same rule as
 * conversation/ws.ts): `view()` waits for the project lock, so a long
 * critical section with a busy writer behind it would otherwise grow the
 * queue without limit. Past the budget the queue is dropped, nothing more is
 * queued for that subscription, and once the snapshot has been sent the
 * client gets the same ONE `resync{fromSeq: last sent}` — every dropped line
 * is persisted and comes back by `GET …/events` — but ONLY if a dropped line
 * is newer than what the snapshot delivered (`maxDroppedSeq`).
 *
 * With today's store that never happens: `view()` runs inside
 * `critical(pid)`, serialised with every `tx.append`, listeners fire inside
 * the append's critical section, and the in-memory lines are never trimmed —
 * so every line queued before the snapshot is already IN the snapshot. A
 * resync there would only cost the client a needless GET. The budget is a
 * memory guard for a future store that emits outside the lock, where the
 * loss would be real.
 */

import type { RawData, WebSocket } from "ws";
import type { LogLine } from "./log.js";
import type { ProjectConversationStore } from "./store.js";

export const LIVE_BUDGET_BYTES = 8 * 1024 * 1024;
/** Bytes of live lines held per subscription while its snapshot is pending. */
export const QUEUE_BUDGET_BYTES = 8 * 1024 * 1024;

interface Sub {
	cancelled: boolean;
	paused: boolean;
	ready: boolean;
	lastSent: number;
	queue: LogLine[];
	queueBytes: number;
	/** The queue went past `queueBudget`: dropped, nothing more queued. */
	overflowed: boolean;
	/** Highest seq dropped since; a resync is owed only if it is past the snapshot. */
	maxDroppedSeq: number;
}

export class ProjectWsHub {
	constructor(
		private readonly store: ProjectConversationStore,
		private readonly liveBudget = LIVE_BUDGET_BYTES,
		private readonly queueBudget = QUEUE_BUDGET_BYTES,
	) {}

	/** Called after auth (owner of `pid`). */
	/**
	 * `early`: frames the client sent before authorization finished (its
	 * `subscribe` goes out on `open`, while the owner check may still be on
	 * its way to D1) — handled first, in order, so none is lost.
	 */
	serve(ws: WebSocket, pid: string, early: readonly RawData[] = []): void {
		let sub: Sub | null = null;
		const unlisten = this.store.onAppend((p, lines) => {
			if (p !== pid || !sub || sub.cancelled || sub.paused) return;
			if (!sub.ready) {
				const s = sub;
				const drop = (l: LogLine) => {
					if (l.seq > s.maxDroppedSeq) s.maxDroppedSeq = l.seq;
				};
				for (const l of lines) {
					if (s.overflowed) {
						drop(l); // persisted; recovered by the resync if the snapshot lacks it
						continue;
					}
					// The size of the frame it will become, as conversation/ws.ts counts.
					const bytes = Buffer.byteLength(JSON.stringify({ type: "event", event: l }), "utf8");
					if (s.queueBytes + bytes > this.queueBudget) {
						for (const q of s.queue) drop(q);
						drop(l);
						s.queue = [];
						s.queueBytes = 0;
						s.overflowed = true;
						continue;
					}
					s.queue.push(l);
					s.queueBytes += bytes;
				}
				return;
			}
			for (const l of lines) this.sendLine(ws, sub, l);
		});
		const end = () => {
			if (sub) sub.cancelled = true;
			unlisten();
		};
		ws.on("close", end);
		const onMessage = (raw: RawData) => {
			try {
				let msg: unknown;
				try {
					msg = JSON.parse(String(raw));
				} catch {
					return;
				}
				if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
				const m = msg as { type?: unknown; after?: unknown };
				if (m.type !== "subscribe") return;
				const after =
					typeof m.after === "number" && Number.isInteger(m.after) && m.after >= 0 ? m.after : 0;
				if (sub) sub.cancelled = true;
				const mine: Sub = {
					cancelled: false,
					paused: false,
					ready: false,
					lastSent: after,
					queue: [],
					queueBytes: 0,
					overflowed: false,
					maxDroppedSeq: 0,
				};
				sub = mine;
				void this.store.view(pid).then(
					({ lines }) => {
						if (mine.cancelled) return;
						for (const l of lines) if (l.seq > after) this.sendLine(ws, mine, l);
						mine.ready = true;
						if (mine.maxDroppedSeq > mine.lastSent) {
							// A dropped line is not in what was sent: stop here and let
							// the client re-read from the last line it actually got.
							// `pause` is a no-op if the snapshot already paused it.
							this.pause(ws, mine);
							return;
						}
						// Otherwise every dropped line was in the snapshot (see the
						// header): nothing was lost, so no resync — follow live.
						for (const l of mine.queue.splice(0)) this.sendLine(ws, mine, l);
						mine.queueBytes = 0;
					},
					() => {
						if (mine.cancelled) return;
						try {
							ws.close(1011, "project unavailable");
						} catch {
							/* already closed */
						}
					},
				);
			} catch {
				/* nothing thrown here may escape to the process */
			}
		};
		ws.on("message", onMessage);
		for (const raw of early) onMessage(raw);
	}

	private sendLine(ws: WebSocket, sub: Sub, l: LogLine): void {
		if (sub.cancelled || sub.paused || l.seq <= sub.lastSent) return;
		if (ws.readyState !== ws.OPEN) return;
		if (ws.bufferedAmount > this.liveBudget) {
			this.pause(ws, sub);
			return;
		}
		ws.send(JSON.stringify({ type: "event", event: l }));
		sub.lastSent = l.seq;
	}

	/** Stops forwarding and sends the subscription's ONE resync (at most once). */
	private pause(ws: WebSocket, sub: Sub): void {
		if (sub.cancelled || sub.paused) return;
		sub.paused = true;
		sub.queue = [];
		sub.queueBytes = 0;
		if (ws.readyState !== ws.OPEN) return;
		ws.send(JSON.stringify({ type: "resync", fromSeq: sub.lastSent }));
	}
}
