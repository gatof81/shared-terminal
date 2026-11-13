/**
 * projects/conversation/ws.ts — the queue held while a subscription's
 * snapshot is pending is bounded in bytes (PROJECT_CONVERSATION.md A.1:
 * "la misma mecánica que /ws/conversation/ … cola en bytes, resync").
 *
 * Deterministic: the store's `view()` is a barrier the test releases, and
 * the socket is a fake that records every frame synchronously.
 */

import { describe, expect, it } from "vitest";
import type { RawData, WebSocket } from "ws";
import type { LogLine } from "./log.js";
import type { ProjectConversationStore } from "./store.js";
import { ProjectWsHub } from "./ws.js";

const PID = "6b1f0c4e-1d2a-4b3c-8d4e-5f6a7b8c9d0e";

const line = (seq: number, pad = ""): LogLine => ({
	seq,
	ev: "noise",
	at: "2026-11-13T00:00:00.000Z",
	w: "b",
	bn: 0,
	pad,
});
const frameBytes = (l: LogLine) =>
	Buffer.byteLength(JSON.stringify({ type: "event", event: l }), "utf8");

function harness(queueBudget: number) {
	let listener: ((pid: string, lines: readonly LogLine[]) => void) | null = null;
	let release!: (lines: LogLine[]) => void;
	const store = {
		onAppend(cb: (pid: string, lines: readonly LogLine[]) => void) {
			listener = cb;
			return () => {
				listener = null;
			};
		},
		view: () =>
			new Promise<{ state: unknown; lines: readonly LogLine[] }>((r) => {
				release = (lines) => r({ state: {}, lines });
			}),
	} as unknown as ProjectConversationStore;
	const frames: Array<{ type: string; event?: LogLine; fromSeq?: number }> = [];
	const handlers = new Map<string, (raw: RawData) => void>();
	const ws = {
		OPEN: 1,
		readyState: 1,
		bufferedAmount: 0,
		on(ev: string, fn: (raw: RawData) => void) {
			handlers.set(ev, fn);
		},
		send(data: string) {
			frames.push(JSON.parse(data));
		},
		close() {},
	} as unknown as WebSocket;
	const hub = new ProjectWsHub(store, undefined, queueBudget);
	hub.serve(ws, PID);
	return {
		subscribe: (after: number) =>
			handlers.get("message")?.(Buffer.from(JSON.stringify({ type: "subscribe", after }))),
		append: (...lines: LogLine[]) => listener?.(PID, lines),
		release: async (lines: LogLine[]) => {
			release(lines);
			// let the `view().then` continuation run
			await new Promise((r) => setImmediate(r));
		},
		frames,
		seqs: () => frames.map((f) => (f.type === "event" ? f.event?.seq : `resync:${f.fromSeq}`)),
	};
}

describe("WS /ws/project — queue during the snapshot is bounded in bytes", () => {
	it("past the budget: the queue is dropped, ONE resync from the last sent seq, nothing of it after", async () => {
		const pad = "x".repeat(200);
		const budget = frameBytes(line(10, pad)) * 2; // room for two queued lines, not three
		const h = harness(budget);
		h.subscribe(1);
		// While the snapshot is blocked, more than the budget lands.
		h.append(line(4, pad), line(5, pad));
		h.append(line(6, pad), line(7, pad));
		h.append(line(8, pad));
		expect(h.frames).toEqual([]);
		await h.release([line(1), line(2), line(3)]);
		expect(h.seqs()).toEqual([2, 3, "resync:3"]);
		// Paused: live lines are not forwarded either, until a new subscribe.
		h.append(line(9));
		await new Promise((r) => setImmediate(r));
		expect(h.seqs()).toEqual([2, 3, "resync:3"]);
		expect(h.frames.filter((f) => f.type === "resync")).toHaveLength(1);
	});

	it("within the budget: snapshot > after, then the queue in order, deduplicated; no resync", async () => {
		const h = harness(10_000);
		h.subscribe(1);
		// line 3 also arrives live (it landed between arming and the snapshot)
		h.append(line(3), line(4));
		h.append(line(5));
		await h.release([line(1), line(2), line(3)]);
		expect(h.seqs()).toEqual([2, 3, 4, 5]);
		h.append(line(6));
		expect(h.seqs()).toEqual([2, 3, 4, 5, 6]);
	});

	it("a re-subscribe after the resync replays from the new cursor and follows live again", async () => {
		const pad = "x".repeat(200);
		const h = harness(frameBytes(line(10, pad)));
		h.subscribe(0);
		h.append(line(2, pad), line(3, pad));
		await h.release([line(1)]);
		expect(h.seqs()).toEqual([1, "resync:1"]);
		h.subscribe(1);
		await h.release([line(1), line(2, pad), line(3, pad)]);
		h.append(line(4));
		expect(h.seqs()).toEqual([1, "resync:1", 2, 3, 4]);
	});
});
