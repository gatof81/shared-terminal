/**
 * projects/conversation/replies.ts — PROJECT_CONVERSATION.md §4.1 and the
 * §3.1 settlement: exact only after a fully observed settle window, every
 * listed violation makes it ambiguous, a late close is recorded, and an
 * uncertain delivery settles from the Composer's own evidence only.
 * The settle window is shortened to 60 ms; the rules are the same.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PersistedEvent } from "../../conversation/store.js";
import type { LogLine } from "./log.js";
import { ReplyWatcher } from "./replies.js";
import { ProjectConversationStore } from "./store.js";
import type { WriterLock } from "./writerLock.js";

const PID = "6b1f0c4e-1d2a-4b3c-8d4e-5f6a7b8c9d0e";
const SID = "5a000000-0000-4000-8000-0000000000aa";
const CID = "c-1";
const SETTLE = 60;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lock = (): WriterLock => ({ held: () => true, onLost: () => {}, release: () => {} });

let root: string;
let store: ProjectConversationStore;
let capture: PersistedEvent[];
let listener: ((sid: string, cid: string, ev: PersistedEvent) => void) | null;
let watcher: ReplyWatcher;
let bootAt: number;

function emit(
	ev: string,
	o: Partial<PersistedEvent> & { data?: Record<string, unknown> } = {},
): PersistedEvent {
	const e: PersistedEvent = {
		seq: capture.length + 1,
		ts: new Date().toISOString(),
		ev: ev as PersistedEvent["ev"],
		prompt_id: null,
		turn_id: null,
		agent_id: null,
		pane: "%1",
		data: {},
		...o,
	} as PersistedEvent;
	capture.push(e);
	listener?.(SID, CID, e);
	return e;
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-replies-"));
	store = await ProjectConversationStore.start({
		workspaceRoot: root,
		bootId: "b",
		acquire: async () => ({ ok: true, lock: lock() }),
	});
	capture = [];
	listener = null;
	bootAt = Date.now() - 1000;
	watcher = new ReplyWatcher({
		store,
		onCaptureEvent: (l) => {
			listener = l;
			return () => {
				listener = null;
			};
		},
		readCapture: async (_s, _c, after) => capture.filter((e) => e.seq > after),
		bootAt,
		settleMs: SETTLE,
	});
	await store.critical(PID, (tx) =>
		tx.append([
			{ ev: "message", msg_id: "m1", client_message_id: "c1", kind: "owner", to: ["a"] },
			{
				ev: "delivery",
				msg_id: "m1",
				agent_id: "a",
				state: "planned",
				binding: { binding_id: "b", epoch: 1, sid: SID, cid: CID },
				composer_client_message_id: "ccm-1",
			},
		]),
	);
});
afterEach(async () => {
	watcher.stop();
	await store.close();
	await fs.rm(root, { recursive: true, force: true });
});

const ref = (ackSeq: number) => ({
	projectId: PID,
	msgId: "m1",
	agentId: "a",
	sid: SID,
	cid: CID,
	promptId: "P",
	ackSeq,
});
const events = async (): Promise<LogLine[]> =>
	(await store.view(PID)).lines.filter((l) => l.ev !== "message" && l.ev !== "delivery");

describe("reply attribution (§4.1)", () => {
	it("T27: reply_settling at once, reply_ref exact only after the window; the hash, never the text", async () => {
		const ack = emit("user_prompt", { prompt_id: "P" });
		watcher.watch(ref(ack.seq));
		await sleep(10);
		emit("tool_end", { prompt_id: "P" });
		emit("turn_end", { prompt_id: "P", data: { last_assistant_message: "Plan: two steps." } });
		await sleep(10);
		let ev = await events();
		expect(ev.map((l) => l.ev)).toEqual(["reply_settling"]);
		expect(ev[0]).not.toHaveProperty("last_assistant_message");
		await sleep(SETTLE + 30);
		ev = await events();
		expect(ev.map((l) => l.ev)).toEqual(["reply_settling", "reply_ref"]);
		expect(ev[1]).toMatchObject({
			attribution: "exact",
			seq_from: ack.seq,
			turn_end_seq: 3,
			report_bytes: 16,
			truncated: false,
		});
		expect(typeof ev[1]?.report_sha256).toBe("string");
	});

	it("T20b: a second close with P inside the window ⇒ ambiguous{second-close}", async () => {
		const ack = emit("user_prompt", { prompt_id: "P" });
		watcher.watch(ref(ack.seq));
		await sleep(10);
		emit("turn_end", { prompt_id: "P", data: { last_assistant_message: "a" } });
		await sleep(SETTLE / 2);
		emit("turn_end", { prompt_id: "P", data: { last_assistant_message: "b" } });
		await sleep(SETTLE + 30);
		expect((await events()).find((l) => l.ev === "reply_ref")?.attribution).toBe(
			"ambiguous{second-close}",
		);
	});

	it("T20c: a close with P after the window ⇒ reply_late_close; the ref stays", async () => {
		const ack = emit("user_prompt", { prompt_id: "P" });
		watcher.watch(ref(ack.seq));
		await sleep(10);
		emit("turn_end", { prompt_id: "P", data: { last_assistant_message: "a" } });
		await sleep(SETTLE + 30);
		const late = emit("turn_end", { prompt_id: "P", data: { last_assistant_message: "more" } });
		await sleep(20);
		const ev = await events();
		expect(ev.map((l) => l.ev)).toEqual(["reply_settling", "reply_ref", "reply_late_close"]);
		expect(ev[1]?.attribution).toBe("exact");
		expect(ev[2]).toMatchObject({ prompt_id: "P", capture_seq: late.seq });
	});

	it("each violation of §4.1 makes it ambiguous", async () => {
		const cases: Array<[string, () => void]> = [
			["mixed-input", () => emit("user_prompt", { prompt_id: "Q" })],
			["mixed-input", () => emit("turn_end", { prompt_id: null })],
			["gap", () => emit("gap", { data: { reason: "relay_dropped" } })],
		];
		for (const [reason, breakIt] of cases) {
			capture = [];
			await store.critical(PID, (tx) =>
				tx.append([
					{
						ev: "message",
						msg_id: `m-${reason}-${Math.random()}`,
						client_message_id: `${Math.random()}`,
					},
				]),
			);
			const id = `m-${Math.random()}`;
			const ack = emit("user_prompt", { prompt_id: "P" });
			watcher.watch({ ...ref(ack.seq), msgId: id });
			await sleep(5);
			breakIt();
			emit("turn_end", { prompt_id: "P", data: { last_assistant_message: "x" } });
			// Poll rather than sleep a fixed time: under CI load the window's
			// timer can fire late; the attribution, not the latency, is the point.
			let r: LogLine | undefined;
			for (let i = 0; i < 100 && !r; i++) {
				await sleep(i === 0 ? SETTLE + 30 : 20);
				r = (await store.view(PID)).lines.find((l) => l.ev === "reply_ref" && l.msg_id === id);
			}
			expect(r?.attribution, reason).toBe(`ambiguous{${reason}}`);
		}
	});

	it("review regression: two turn_end with P back to back ⇒ second-close, never exact", async () => {
		const ack = emit("user_prompt", { prompt_id: "P" });
		watcher.watch(ref(ack.seq));
		await sleep(10);
		emit("turn_end", { prompt_id: "P", data: { last_assistant_message: "a" } });
		emit("turn_end", { prompt_id: "P", data: { last_assistant_message: "b" } });
		await sleep(SETTLE + 40);
		const refs = (await events()).filter((l) => l.ev === "reply_ref");
		expect(refs).toHaveLength(1);
		expect(refs[0]?.attribution).toBe("ambiguous{second-close}");
	});

	it("review regression: a gap in the file after the turn_end, with live events during catch-up ⇒ ambiguous{gap}", async () => {
		const ack = emit("user_prompt", { prompt_id: "P" });
		emit("turn_end", { prompt_id: "P", data: { last_assistant_message: "a" } });
		emit("gap", { data: { reason: "relay_dropped" } });
		watcher.watch(ref(ack.seq));
		emit("tool_end", { prompt_id: "P" });
		await sleep(SETTLE + 40);
		expect((await events()).find((l) => l.ev === "reply_ref")?.attribution).toBe("ambiguous{gap}");
	});

	it("review regression: live events landing during the settling write still see a gap read from the file", async () => {
		const ack = emit("user_prompt", { prompt_id: "P" });
		emit("turn_end", { prompt_id: "P", data: { last_assistant_message: "a" } });
		emit("gap", { data: { reason: "relay_dropped" } });
		watcher.watch(ref(ack.seq));
		for (let i = 0; i < 5; i++) {
			await new Promise((r) => setImmediate(r));
			emit("tool_end", { prompt_id: "P" });
		}
		await sleep(SETTLE + 40);
		expect((await events()).find((l) => l.ev === "reply_ref")?.attribution).toBe("ambiguous{gap}");
	});

	it("P not new (queued behind another turn) ⇒ ambiguous{queued}", async () => {
		emit("user_prompt", { prompt_id: "P" });
		const ack = emit("user_prompt", { prompt_id: "P" });
		watcher.watch(ref(ack.seq));
		await sleep(10);
		emit("turn_end", { prompt_id: "P", data: { last_assistant_message: "x" } });
		await sleep(SETTLE + 30);
		expect((await events()).find((l) => l.ev === "reply_ref")?.attribution).toBe(
			"ambiguous{queued}",
		);
	});

	it("T20d: a turn_end received before this process started ⇒ settle-unobserved, at once", async () => {
		const ack = emit("user_prompt", { prompt_id: "P" });
		emit("turn_end", {
			prompt_id: "P",
			ts: new Date(bootAt - 5000).toISOString(),
			data: { last_assistant_message: "x" },
		});
		watcher.watch(ref(ack.seq));
		await sleep(20);
		expect((await events()).find((l) => l.ev === "reply_ref")?.attribution).toBe(
			"ambiguous{settle-unobserved}",
		);
	});

	it("turn_failed with P ⇒ reply_ref failed, no settle", async () => {
		const ack = emit("user_prompt", { prompt_id: "P" });
		watcher.watch(ref(ack.seq));
		await sleep(10);
		emit("turn_failed", { prompt_id: "P", data: { error: "x" } });
		await sleep(20);
		const ev = await events();
		expect(ev.map((l) => l.ev)).toEqual(["reply_ref"]);
		expect(ev[0]?.attribution).toBe("failed");
	});

	it("a watch resumed twice writes once", async () => {
		const ack = emit("user_prompt", { prompt_id: "P" });
		watcher.watch(ref(ack.seq));
		watcher.watch(ref(ack.seq));
		await sleep(10);
		emit("turn_end", { prompt_id: "P", data: { last_assistant_message: "x" } });
		await sleep(SETTLE + 40);
		const ev = await events();
		expect(ev.filter((l) => l.ev === "reply_ref")).toHaveLength(1);
		expect(ev.filter((l) => l.ev === "reply_settling")).toHaveLength(1);
	});
});

/** Replaces the default watcher with one on the given clocks. */
function rewatch(clocks: { now?: () => number; monoNow?: () => number }): void {
	watcher.stop();
	watcher = new ReplyWatcher({
		store,
		onCaptureEvent: (l) => {
			listener = l;
			return () => {
				listener = null;
			};
		},
		readCapture: async (_s, _c, after) => capture.filter((e) => e.seq > after),
		bootAt,
		settleMs: SETTLE,
		...clocks,
	});
}

describe("the settle window is measured on the monotonic clock (owner review of #590)", () => {
	it("the system clock jumps forward 1 h right after the turn_end: no exact before the whole window, and a second close inside it is seen", async () => {
		let jump = 0;
		rewatch({ now: () => Date.now() + jump });
		const ack = emit("user_prompt", { prompt_id: "P" });
		watcher.watch(ref(ack.seq));
		await sleep(10);
		emit("turn_end", { prompt_id: "P", data: { last_assistant_message: "a" } });
		// The capture stamps from here on are an hour ahead, as are the watcher's.
		jump = 3_600_000;
		await sleep(SETTLE / 2);
		expect((await events()).map((l) => l.ev)).toEqual(["reply_settling"]);
		emit("turn_end", {
			prompt_id: "P",
			ts: new Date(Date.now() + jump).toISOString(),
			data: { last_assistant_message: "a" },
		});
		await sleep(SETTLE + 30);
		const refs = (await events()).filter((l) => l.ev === "reply_ref");
		expect(refs).toHaveLength(1);
		expect(refs[0]?.attribution).toBe("ambiguous{second-close}");
	});

	it("the same jump with a clean window ⇒ exact, but only once the window has elapsed in this process", async () => {
		let jump = 0;
		rewatch({ now: () => Date.now() + jump });
		const ack = emit("user_prompt", { prompt_id: "P" });
		watcher.watch(ref(ack.seq));
		await sleep(10);
		const t0 = performance.now();
		emit("turn_end", { prompt_id: "P", data: { last_assistant_message: "a" } });
		jump = 3_600_000;
		let decidedAt: number | null = null;
		while (decidedAt === null && performance.now() - t0 < SETTLE * 4) {
			if ((await events()).some((l) => l.ev === "reply_ref")) decidedAt = performance.now();
			else await sleep(2);
		}
		expect(decidedAt).not.toBeNull();
		expect((decidedAt as number) - t0).toBeGreaterThanOrEqual(SETTLE);
		expect((await events()).find((l) => l.ev === "reply_ref")?.attribution).toBe("exact");
	});

	it("a turn_end stamped in the past (clock stepped back after it) still waits the whole window", async () => {
		rewatch({});
		const ack = emit("user_prompt", { prompt_id: "P" });
		watcher.watch(ref(ack.seq));
		await sleep(10);
		// Stamped after boot but long enough ago that ts + T_SETTLE is already past.
		emit("turn_end", {
			prompt_id: "P",
			ts: new Date(Date.now() - 10 * SETTLE).toISOString(),
			data: { last_assistant_message: "a" },
		});
		await sleep(SETTLE / 2);
		expect((await events()).some((l) => l.ev === "reply_ref")).toBe(false);
		emit("turn_end", { prompt_id: "P", data: { last_assistant_message: "a" } });
		await sleep(SETTLE + 30);
		expect((await events()).find((l) => l.ev === "reply_ref")?.attribution).toBe(
			"ambiguous{second-close}",
		);
	});

	it("the monotonic clock decides: while it has not reached the end, a fired timer re-arms and writes nothing", async () => {
		let frozen: number | null = null;
		rewatch({ monoNow: () => frozen ?? performance.now() });
		const ack = emit("user_prompt", { prompt_id: "P" });
		watcher.watch(ref(ack.seq));
		await sleep(10);
		emit("turn_end", { prompt_id: "P", data: { last_assistant_message: "a" } });
		await sleep(5);
		frozen = performance.now();
		await sleep(SETTLE * 2);
		expect((await events()).some((l) => l.ev === "reply_ref")).toBe(false);
		frozen = null;
		await sleep(SETTLE);
		expect((await events()).find((l) => l.ev === "reply_ref")?.attribution).toBe("exact");
	});

	it("review NIT: a turn_end seen live BEFORE its watch exists (a fast turn, the watch starts after S4) still counts as observed", async () => {
		const ack = emit("user_prompt", { prompt_id: "P" });
		emit("turn_end", { prompt_id: "P", data: { last_assistant_message: "a" } });
		watcher.watch(ref(ack.seq));
		await sleep(10);
		expect((await events()).map((l) => l.ev)).toEqual(["reply_settling"]);
		await sleep(SETTLE + 30);
		expect((await events()).find((l) => l.ev === "reply_ref")?.attribution).toBe("exact");
	});

	it("a turn_end stamped after boot but never seen live by this process (a previous process with its clock ahead) ⇒ settle-unobserved", async () => {
		const ack = emit("user_prompt", { prompt_id: "P" });
		capture.push({
			seq: capture.length + 1,
			ts: new Date(Date.now() + 3_600_000).toISOString(),
			ev: "turn_end",
			prompt_id: "P",
			turn_id: null,
			agent_id: null,
			pane: "%1",
			data: { last_assistant_message: "a" },
		} as PersistedEvent);
		watcher.watch(ref(ack.seq));
		await sleep(20);
		expect((await events()).find((l) => l.ev === "reply_ref")?.attribution).toBe(
			"ambiguous{settle-unobserved}",
		);
	});
});

describe("settling an uncertain delivery (§3.1)", () => {
	it("only from the Composer's composer_send evidence; delivered then follows the reply", async () => {
		await store.critical(PID, (tx) =>
			tx.append([
				{ ev: "delivery", msg_id: "m1", agent_id: "a", state: "sending" },
				{ ev: "delivery", msg_id: "m1", agent_id: "a", state: "uncertain", reason: "orphaned" },
			]),
		);
		watcher.watchUncertain({
			projectId: PID,
			msgId: "m1",
			agentId: "a",
			sid: SID,
			cid: CID,
			ccmid: "ccm-1",
		});
		await sleep(10);
		emit("composer_send", {
			data: { client_message_id: "other", state: "delivered", prompt_id: "Z", seq: 1 },
		});
		const ack = emit("user_prompt", { prompt_id: "P" });
		emit("composer_send", {
			data: { client_message_id: "ccm-1", state: "delivered", prompt_id: "P", seq: ack.seq },
		});
		await sleep(20);
		const st = (await store.view(PID)).state;
		expect(st.deliveries.get("m1/a")).toMatchObject({
			state: "settled",
			result: "delivered",
			promptId: "P",
			ackSeq: ack.seq,
		});
		emit("turn_end", { prompt_id: "P", data: { last_assistant_message: "x" } });
		await sleep(SETTLE + 40);
		expect((await events()).find((l) => l.ev === "reply_ref")?.attribution).toBe("exact");
	});
});
