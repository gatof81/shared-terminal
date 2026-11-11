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
 */

import type { WebSocket } from "ws";
import type { LogLine } from "./log.js";
import type { ProjectConversationStore } from "./store.js";

export const LIVE_BUDGET_BYTES = 8 * 1024 * 1024;

interface Sub {
	cancelled: boolean;
	paused: boolean;
	ready: boolean;
	lastSent: number;
	queue: LogLine[];
}

export class ProjectWsHub {
	constructor(
		private readonly store: ProjectConversationStore,
		private readonly liveBudget = LIVE_BUDGET_BYTES,
	) {}

	/** Called after auth (owner of `pid`). */
	serve(ws: WebSocket, pid: string): void {
		let sub: Sub | null = null;
		const unlisten = this.store.onAppend((p, lines) => {
			if (p !== pid || !sub || sub.cancelled || sub.paused) return;
			if (!sub.ready) {
				sub.queue.push(...lines);
				return;
			}
			for (const l of lines) this.sendLine(ws, sub, l);
		});
		const end = () => {
			if (sub) sub.cancelled = true;
			unlisten();
		};
		ws.on("close", end);
		ws.on("message", (raw) => {
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
				};
				sub = mine;
				void this.store.view(pid).then(
					({ lines }) => {
						if (mine.cancelled) return;
						for (const l of lines) if (l.seq > after) this.sendLine(ws, mine, l);
						mine.ready = true;
						for (const l of mine.queue.splice(0)) this.sendLine(ws, mine, l);
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
		});
	}

	private sendLine(ws: WebSocket, sub: Sub, l: LogLine): void {
		if (sub.cancelled || sub.paused || l.seq <= sub.lastSent) return;
		if (ws.readyState !== ws.OPEN) return;
		if (ws.bufferedAmount > this.liveBudget) {
			sub.paused = true;
			ws.send(JSON.stringify({ type: "resync", fromSeq: sub.lastSent }));
			return;
		}
		ws.send(JSON.stringify({ type: "event", event: l }));
		sub.lastSent = l.seq;
	}
}
