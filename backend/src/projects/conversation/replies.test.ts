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
			await sleep(SETTLE + 30);
			const r = (await store.view(PID)).lines.find((l) => l.ev === "reply_ref" && l.msg_id === id);
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
