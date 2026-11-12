/**
 * The two-recipient scenario of the D1 pilot, end to end on the real store,
 * fan-out, reply watcher and ack API (PROJECT_CONVERSATION.md §3, §4.1,
 * §4.3), with D1 and each agent's capture + Composer faked:
 *
 *   one message to @dev and @qa ⇒ two independent deliveries (own binding,
 *   own composer id, own prompt), two independent replies settling at their
 *   own pace, two pending items, each closed by its own owner_ack — and the
 *   log the run leaves passes logCheck.ts, the checker the operator runs on
 *   the pilot's evidence.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HttpResult } from "../../conversation/composer.js";
import type { PersistedEvent } from "../../conversation/store.js";
import { ProjectConversationApi } from "./api.js";
import { type ProjectBindings, ProjectFanout } from "./fanout.js";
import type { LogLine } from "./log.js";
import { checkLog } from "./logCheck.js";
import { ReplyWatcher } from "./replies.js";
import { ProjectConversationStore } from "./store.js";
import type { WriterLock } from "./writerLock.js";

const PID = "6b1f0c4e-1d2a-4b3c-8d4e-5f6a7b8c9d0e";
const OWNER = "u-owner";
const DEV = "a0000000-0000-4000-8000-00000000000a";
const QA = "b0000000-0000-4000-8000-00000000000b";
const S_DEV = "5a000000-0000-4000-8000-0000000000aa";
const S_QA = "5b000000-0000-4000-8000-0000000000bb";
const SETTLE = 60;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lock = (): WriterLock => ({ held: () => true, onLost: () => {}, release: () => {} });
const cidOf = (sid: string) => `c-${sid.slice(0, 2)}`;

let root: string;
let store: ProjectConversationStore;
let watcher: ReplyWatcher;
let api: ProjectConversationApi;
let captures: Map<string, PersistedEvent[]>;
let listeners: Set<(sid: string, cid: string, ev: PersistedEvent) => void>;
let calls: Array<{ sid: string; cid: string; ccmid: string }>;
let refuse: Set<string>;
let prompts: number;

function emit(sid: string, ev: string, o: Partial<PersistedEvent> = {}): PersistedEvent {
	const c = captures.get(sid) ?? [];
	captures.set(sid, c);
	const e = {
		seq: c.length + 1,
		ts: new Date().toISOString(),
		ev,
		prompt_id: null,
		turn_id: null,
		agent_id: null,
		pane: "%1",
		data: {},
		...o,
	} as PersistedEvent;
	c.push(e);
	for (const l of listeners) l(sid, cidOf(sid), e);
	return e;
}

const promptOf = (sid: string) =>
	[...(captures.get(sid) ?? [])].reverse().find((e) => e.ev === "user_prompt")?.prompt_id as string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-two-"));
	store = await ProjectConversationStore.start({
		workspaceRoot: root,
		bootId: "pilot",
		acquire: async () => ({ ok: true, lock: lock() }),
	});
	captures = new Map();
	listeners = new Set();
	calls = [];
	refuse = new Set();
	prompts = 0;
	watcher = new ReplyWatcher({
		store,
		onCaptureEvent: (l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		readCapture: async (sid, _cid, after) => (captures.get(sid) ?? []).filter((e) => e.seq > after),
		bootAt: Date.now() - 1000,
		settleMs: SETTLE,
	});
	const bindings = (): ProjectBindings =>
		new Map([
			[DEV, { removed: false, binding: { bindingId: "bind-dev", epoch: 1, sessionId: S_DEV } }],
			[QA, { removed: false, binding: { bindingId: "bind-qa", epoch: 3, sessionId: S_QA } }],
		]);
	const fanout = new ProjectFanout({
		store,
		bindings: async (owner, pid) => (owner === OWNER && pid === PID ? bindings() : null),
		target: async (sid) => ({ kind: "ok", cid: cidOf(sid) }),
		sessionMeta: async () => ({ userId: OWNER }),
		composerSend: async (input): Promise<HttpResult> => {
			calls.push({ sid: input.stSessionId, cid: input.cid, ccmid: input.body.clientMessageId });
			if (refuse.has(input.stSessionId)) return { status: 409, body: { error: "busy" } };
			const promptId = `p-${++prompts}`;
			const up = emit(input.stSessionId, "user_prompt", {
				prompt_id: promptId,
				data: { prompt: input.body.text },
			});
			return { status: 202, body: { result: "delivered", promptId, seq: up.seq } };
		},
		onDelivered: (d) => watcher.watch(d),
		onUncertain: (d) => watcher.watchUncertain(d),
	});
	api = new ProjectConversationApi({ store, fanout, ownsProject: async () => true });
});
afterEach(async () => {
	watcher.stop();
	await store.close();
	await fs.rm(root, { recursive: true, force: true });
});

const log = async (): Promise<LogLine[]> => (await store.view(PID)).lines.slice();
const page = async () => (await api.events(PID, { limit: "500" })).body;
const ack = (msgId: string, agentId?: string, id = crypto.randomUUID()) =>
	api.ack(OWNER, PID, { clientAckId: id, target: { msgId, ...(agentId ? { agentId } : {}) } });

async function sendToBoth(): Promise<string> {
	const r = await api.send(OWNER, PID, {
		clientMessageId: crypto.randomUUID(),
		text: "Revisen el plan, por favor.",
		to: [DEV, QA],
	});
	expect(r.status).toBe(202);
	return (r.body as { msgId: string }).msgId;
}

describe("two recipients (pilot scenario)", () => {
	it("independent deliveries: own binding, own composer id, own prompt; one call each", async () => {
		const msgId = await sendToBoth();
		expect(calls.map((c) => c.sid).sort()).toEqual([S_DEV, S_QA]);
		expect(new Set(calls.map((c) => c.ccmid)).size).toBe(2);
		const planned = (await log()).filter((l) => l.state === "planned");
		expect(planned.map((l) => (l.binding as { sid: string }).sid).sort()).toEqual([S_DEV, S_QA]);
		expect(planned.find((l) => l.agent_id === QA)?.binding).toMatchObject({
			binding_id: "bind-qa",
			epoch: 3,
			cid: cidOf(S_QA),
		});
		const r = checkLog(await page());
		expect(r.violations).toEqual([]);
		const m = r.messages.find((x) => x.msgId === msgId);
		expect(m?.deliveries.map((d) => [d.agentId, d.states.join(">")])).toEqual([
			[DEV, "planned>sending>delivered"],
			[QA, "planned>sending>delivered"],
		]);
		expect(m?.independence).toMatchObject({ distinctComposerIds: true, distinctSessions: true });
	});

	it("independent replies, two pending, each closed by its own ack", async () => {
		const msgId = await sendToBoth();
		// QA answers first; DEV only after QA's window has settled.
		emit(S_QA, "turn_end", {
			prompt_id: promptOf(S_QA),
			data: { last_assistant_message: "QA: OK." },
		});
		await sleep(SETTLE + 40);
		let ev = (await log()).filter((l) => l.ev === "reply_ref");
		expect(ev.map((l) => [l.agent_id, l.attribution])).toEqual([[QA, "exact"]]);
		emit(S_DEV, "turn_end", {
			prompt_id: promptOf(S_DEV),
			data: { last_assistant_message: "Dev: plan en dos pasos." },
		});
		await sleep(SETTLE + 40);
		ev = (await log()).filter((l) => l.ev === "reply_ref");
		expect(ev.map((l) => [l.agent_id, l.attribution, l.sid])).toEqual([
			[QA, "exact", S_QA],
			[DEV, "exact", S_DEV],
		]);
		expect(ev[0]?.prompt_id).not.toBe(ev[1]?.prompt_id);
		expect(ev[0]?.report_sha256).not.toBe(ev[1]?.report_sha256);

		let r = checkLog(await page());
		expect(r.violations).toEqual([]);
		expect(r.messages[0]?.pending.sort()).toEqual([DEV, QA].sort());

		// Close QA's item only: DEV stays pending, no delivery or reply changes.
		const before = (await log()).filter((l) => l.ev !== "owner_ack");
		expect((await ack(msgId, QA)).status).toBe(201);
		r = checkLog(await page());
		expect(r.messages[0]?.pending).toEqual([DEV]);
		expect((await log()).filter((l) => l.ev !== "owner_ack")).toEqual(before);

		expect((await ack(msgId, DEV)).status).toBe(201);
		r = checkLog(await page());
		expect(r.ok).toBe(true);
		expect(r.messages[0]?.pending).toEqual([]);
		expect(r.messages[0]?.independence?.individualAcks).toBe(2);
		expect(calls).toHaveLength(2);
	});

	it("one refused, one delivered: the refusal neither blocks nor retries; only the delivered one replies", async () => {
		refuse.add(S_DEV);
		const msgId = await sendToBoth();
		emit(S_QA, "turn_end", { prompt_id: promptOf(S_QA), data: { last_assistant_message: "ok" } });
		await sleep(SETTLE + 40);
		const r = checkLog(await page());
		expect(r.violations).toEqual([]);
		const m = r.messages.find((x) => x.msgId === msgId);
		expect(m?.deliveries.map((d) => [d.agentId, d.final, d.reason ?? null])).toEqual([
			[DEV, "refused", "busy"],
			[QA, "delivered", null],
		]);
		expect(m?.pending).toEqual([QA]);
		expect(calls.filter((c) => c.sid === S_DEV)).toHaveLength(1);
	});

	it("an ack replayed with the same id is one ack; another target with that id is a conflict", async () => {
		const msgId = await sendToBoth();
		const id = crypto.randomUUID();
		expect((await ack(msgId, QA, id)).status).toBe(201);
		expect(await ack(msgId, QA, id)).toMatchObject({ status: 200, body: { replayed: true } });
		expect(await ack(msgId, DEV, id)).toMatchObject({
			status: 409,
			body: { error: "idempotency-conflict" },
		});
		expect((await log()).filter((l) => l.ev === "owner_ack")).toHaveLength(1);
	});

	it("the log survives a reopen: same lines, no recovery needed, replies stay attributed", async () => {
		await sendToBoth();
		emit(S_QA, "turn_end", { prompt_id: promptOf(S_QA), data: { last_assistant_message: "a" } });
		emit(S_DEV, "turn_end", { prompt_id: promptOf(S_DEV), data: { last_assistant_message: "b" } });
		await sleep(SETTLE + 40);
		const before = await log();
		watcher.stop();
		await store.close();
		store = await ProjectConversationStore.start({
			workspaceRoot: root,
			bootId: "pilot-2",
			acquire: async () => ({ ok: true, lock: lock() }),
		});
		const after = (await store.view(PID)).lines;
		expect(after).toEqual(before);
		expect(after.some((l) => l.ev === "recovery")).toBe(false);
		expect(checkLog({ events: after }).ok).toBe(true);
	});
});

describe("logCheck (§3.4, §4.1 rules on a page)", () => {
	const base = (seq: number, o: Record<string, unknown>) => ({
		seq,
		w: "w1",
		at: "t",
		bn: 0,
		...o,
	});
	const msg = base(1, { ev: "message", msg_id: "m", to: ["a"] });
	const planned = base(2, {
		ev: "delivery",
		msg_id: "m",
		agent_id: "a",
		state: "planned",
		binding: { sid: "s", cid: "c" },
		composer_client_message_id: "x",
	});

	it("a second sending is a violation (one Composer call per delivery)", () => {
		const r = checkLog([
			msg,
			planned,
			base(3, { ev: "delivery", msg_id: "m", agent_id: "a", state: "sending" }),
			base(4, { ev: "delivery", msg_id: "m", agent_id: "a", state: "sending" }),
		]);
		expect(r.violations.join()).toMatch(/second sending/);
	});

	it("a result with no sending, a gap in seq and an exact from another process are violations", () => {
		const r = checkLog([
			msg,
			planned,
			base(4, {
				ev: "delivery",
				msg_id: "m",
				agent_id: "a",
				state: "delivered",
				http: { promptId: "P" },
			}),
			base(5, {
				ev: "reply_settling",
				msg_id: "m",
				agent_id: "a",
				prompt_id: "P",
				turn_end_seq: 9,
			}),
			{
				...base(6, { ev: "reply_ref", msg_id: "m", agent_id: "a", prompt_id: "P" }),
				attribution: "exact",
				turn_end_seq: 9,
				w: "w2",
			},
		]);
		expect(r.violations.join("\n")).toMatch(/not contiguous/);
		expect(r.violations.join("\n")).toMatch(/no sending before it/);
		expect(r.violations.join("\n")).toMatch(/another process/);
	});

	it("an orphaned uncertain after sending, then settled, is valid", () => {
		const r = checkLog([
			msg,
			planned,
			base(3, { ev: "delivery", msg_id: "m", agent_id: "a", state: "sending" }),
			base(4, {
				ev: "delivery",
				msg_id: "m",
				agent_id: "a",
				state: "uncertain",
				reason: "orphaned",
			}),
			base(5, {
				ev: "delivery",
				msg_id: "m",
				agent_id: "a",
				state: "settled",
				result: "delivered",
				http: { promptId: "P" },
			}),
		]);
		expect(r.violations).toEqual([]);
	});

	it("refuses input that is not a page", () => {
		expect(checkLog({ nope: 1 }).ok).toBe(false);
	});
});
