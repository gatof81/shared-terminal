/**
 * projects/conversation/queue.test.ts — §3.6: a message of the person that
 * waits until its recipient is free (`whenFree`), with D3 off. Real store
 * and log, the real fan-out; the Composer, D1 and the capture are fakes.
 *
 * What these hold: one Composer call per delivery at most, in the order the
 * person sent them; nothing sent to a binding other than the one fixed when
 * it was queued; a cancel written before `planned` wins; a restart leaves
 * the queue as it was and sends each message once.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HttpResult } from "../../conversation/composer.js";
import { ProjectConversationApi } from "./api.js";
import {
	OWNER_QUEUE_MAX_PER_AGENT,
	type ProjectBindings,
	ProjectFanout,
	parseBody,
	requestSha256,
} from "./fanout.js";
import { LOG_FILE, type LogLine } from "./log.js";
import { checkLog } from "./logCheck.js";
import { projectDir } from "./paths.js";
import {
	createDeliveryQueue,
	type DeliveryQueue,
	LINE_HOLD_MAX_MS,
	lineHold,
	OWNER_QUEUE_WAIT_MS,
	REFUSED_HOLD_MS,
	type RecipientState,
} from "./queue.js";
import { recoveryEvents } from "./recovery.js";
import { ProjectConversationStore } from "./store.js";
import type { WriterLock } from "./writerLock.js";

const PID = "6b1f0c4e-1d2a-4b3c-8d4e-5f6a7b8c9d0e";
const OWNER = "u-owner";
const A = "a0000000-0000-4000-8000-00000000000a";
const B = "b0000000-0000-4000-8000-00000000000b";
const SA = "5a000000-0000-4000-8000-0000000000aa";
const SB = "5b000000-0000-4000-8000-0000000000bb";
const uuid = () => crypto.randomUUID();
const lock = (): WriterLock => ({ held: () => true, onLost: () => {}, release: () => {} });

interface Sys {
	store: ProjectConversationStore;
	fanout: ProjectFanout;
	queue: DeliveryQueue;
	calls: Array<{ sid: string; cid: string; text: string }>;
	composer: (sid: string, text: string) => Promise<HttpResult>;
	bindings: () => ProjectBindings | undefined;
	recipient: Map<string, RecipientState>;
	targetCalls: number;
}

let root: string;
let now: number;
let sys: Sys;

function bindingsOf(over: Partial<Record<string, { epoch?: number; removed?: boolean }>> = {}) {
	const m: ProjectBindings = new Map();
	for (const [agent, sid] of [
		[A, SA],
		[B, SB],
	] as const) {
		const o = over[agent] ?? {};
		m.set(agent, {
			removed: o.removed ?? false,
			binding: { bindingId: `bind-${agent[0]}`, epoch: o.epoch ?? 1, sessionId: sid },
		});
	}
	return m;
}

async function lines(): Promise<LogLine[]> {
	const raw = await fs.readFile(path.join(projectDir(root, PID), LOG_FILE), "utf8");
	return raw
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as LogLine);
}

async function boot(bootId = "boot"): Promise<Sys> {
	const store = await ProjectConversationStore.start({
		workspaceRoot: root,
		bootId,
		acquire: async () => ({ ok: true, lock: lock() }),
		now: () => new Date(now),
	});
	const s = {
		store,
		calls: [],
		composer: async () => ({
			status: 202,
			body: { result: "delivered", promptId: `p-${uuid()}`, seq: 7 },
		}),
		bindings: () => bindingsOf(),
		recipient: new Map<string, RecipientState>([
			[SA, { kind: "busy", cid: "cid-a" }],
			[SB, { kind: "busy", cid: "cid-b" }],
		]),
		targetCalls: 0,
	} as unknown as Sys;
	s.fanout = new ProjectFanout({
		store,
		now: () => now,
		bindings: async () => {
			const b = s.bindings();
			if (!b) throw new Error("D1 down");
			return b;
		},
		target: async (sid) => {
			s.targetCalls++;
			return { kind: "ok", cid: sid === SA ? "cid-a" : "cid-b" };
		},
		sessionMeta: async () => ({ userId: OWNER }),
		composerSend: async (input) => {
			s.calls.push({ sid: input.stSessionId, cid: input.cid, text: input.body.text });
			return s.composer(input.stSessionId, input.body.text);
		},
		onDelivered: () => {},
		onUncertain: () => {},
	});
	s.queue = createDeliveryQueue({
		store,
		fanout: s.fanout,
		now: () => now,
		bindings: async () => {
			const b = s.bindings();
			if (!b) throw new Error("D1 down");
			return b;
		},
		recipient: async (sid) => s.recipient.get(sid) ?? { kind: "none" },
		onCaptureEvent: () => () => {},
		gateIntervalMs: 3_600_000,
	});
	await s.queue.start(await store.openAll());
	return s;
}

async function settle(): Promise<void> {
	const tick = () => new Promise((r) => setTimeout(r, 2));
	for (let i = 0; i < 30; i++) await tick();
	const size = async () => (await lines().catch(() => [])).length;
	let seen = await size();
	for (let quiet = 0, i = 0; quiet < 3 && i < 400; i++) {
		await tick();
		const n = await size();
		quiet = sys.queue.idle && n === seen ? quiet + 1 : 0;
		seen = n;
	}
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-queue-"));
	now = Date.parse("2026-11-16T12:00:00.000Z");
	sys = await boot();
});
afterEach(async () => {
	await settle();
	expect(checkLog(await lines().catch(() => [])).violations).toEqual([]);
	sys.queue.stop();
	await sys.store.close();
	await fs.rm(root, { recursive: true, force: true });
});

const body = (text: string, to = [A], extra: Record<string, unknown> = {}) => ({
	clientMessageId: uuid(),
	text,
	to,
	whenFree: true,
	...extra,
});
async function send(text: string, to = [A], extra: Record<string, unknown> = {}) {
	const r = await sys.fanout.send(OWNER, PID, body(text, to, extra));
	return r as { status: number; body: Record<string, unknown> };
}
const free = (sid: string, cid: string) => sys.recipient.set(sid, { kind: "ready", cid });
/** N gate passes with whatever the recipient says now. */
async function pass(n = 1): Promise<void> {
	for (let i = 0; i < n; i++) {
		sys.queue.kick(PID);
		await settle();
	}
}
async function ack(msgId: string, agentId?: string): Promise<void> {
	await sys.store.critical(PID, (tx) =>
		tx.append([
			{
				ev: "owner_ack",
				ack_id: uuid(),
				client_ack_id: uuid(),
				by: OWNER,
				target: { msg_id: msgId, ...(agentId ? { agent_id: agentId } : {}) },
				request_sha256: "0".repeat(64),
			},
		]),
	);
}
const answer = (result: string) => async () =>
	({ status: 202, body: { result, promptId: `p-${uuid()}`, seq: 7 } }) as HttpResult;
const refuse =
	(code: string, status = 409) =>
	async () =>
		({ status, body: { error: code } }) as HttpResult;
const busy = (sid: string, cid: string) => sys.recipient.set(sid, { kind: "busy", cid });
async function states(msgId: string, agentId = A): Promise<string[]> {
	return (await lines())
		.filter((l) => l.ev === "delivery" && l.msg_id === msgId && l.agent_id === agentId)
		.map((l) => (l.reason ? `${l.state}{${l.reason}}` : String(l.state)));
}

describe("whenFree: the message waits in the log (§3.6)", () => {
	it("busy recipient ⇒ 202 queued at once, 0 Composer calls, the binding fixed without a conversation", async () => {
		const r = await send("hola");
		expect(r.status).toBe(202);
		expect(r.body.deliveries).toEqual([{ agentId: A, state: "queued" }]);
		await settle();
		expect(sys.calls).toHaveLength(0);
		// The conversation is chosen when its turn comes: no target read now.
		expect(sys.targetCalls).toBe(0);
		const q = (await lines()).find((l) => l.ev === "delivery");
		expect(q).toMatchObject({
			state: "queued",
			authorized_by: "owner",
			binding: { binding_id: "bind-a", epoch: 1, sid: SA },
		});
		expect((q?.binding as Record<string, unknown>).cid).toBeUndefined();
	});

	it("it leaves when the agent is free: queued → planned → sending → delivered, one call, the same text", async () => {
		const r = await send("tarea 1");
		const msgId = r.body.msgId as string;
		await settle();
		free(SA, "cid-a");
		sys.queue.kick(PID);
		await settle();
		expect(sys.calls).toEqual([{ sid: SA, cid: "cid-a", text: "tarea 1" }]);
		expect(await states(msgId)).toEqual(["queued", "planned", "sending", "delivered"]);
		// Nothing more on later looks.
		sys.queue.kick(PID);
		await settle();
		expect(sys.calls).toHaveLength(1);
	});

	it("a free recipient gets it right away through the same path", async () => {
		free(SA, "cid-a");
		const r = await send("ya");
		await settle();
		expect(sys.calls).toHaveLength(1);
		expect(await states(r.body.msgId as string)).toEqual([
			"queued",
			"planned",
			"sending",
			"delivered",
		]);
	});

	it("FIFO per recipient: one at a time, oldest first; another agent's line is independent", async () => {
		await send("uno");
		await send("dos");
		await send("para B", [B]);
		await send("tres");
		await settle();
		// The agent turns busy with each message it takes.
		sys.composer = async (sid) => {
			busy(sid, sid === SA ? "cid-a" : "cid-b");
			return { status: 202, body: { result: "delivered", promptId: `p-${uuid()}`, seq: 7 } };
		};
		free(SB, "cid-b");
		sys.queue.kick(PID);
		await settle();
		expect(sys.calls.map((c) => c.text)).toEqual(["para B"]);
		for (const expected of ["uno", "dos", "tres"]) {
			free(SA, "cid-a");
			sys.queue.kick(PID);
			await settle();
			expect(sys.calls.at(-1)?.text).toBe(expected);
		}
		expect(sys.calls).toHaveLength(4);
	});

	it("two recipients of one message are queued and delivered independently", async () => {
		const r = await send("a los dos", [A, B]);
		const msgId = r.body.msgId as string;
		free(SB, "cid-b");
		sys.queue.kick(PID);
		await settle();
		expect(await states(msgId, B)).toContain("delivered");
		expect(await states(msgId, A)).toEqual(["queued"]);
	});

	it("the same request again replays the queued answer and queues nothing twice", async () => {
		const b = body("una vez");
		const r1 = await sys.fanout.send(OWNER, PID, b);
		const r2 = await sys.fanout.send(OWNER, PID, b);
		expect(r2.body).toMatchObject({
			msgId: (r1.body as { msgId: string }).msgId,
			replayed: true,
			deliveries: [{ agentId: A, state: "queued" }],
		});
		expect((await lines()).filter((l) => l.ev === "delivery")).toHaveLength(1);
	});

	it("a body without whenFree keeps its request hash and its immediate path", async () => {
		const plain = parseBody({ clientMessageId: uuid(), text: "x", to: [A] });
		const queued = parseBody({ clientMessageId: uuid(), text: "x", to: [A], whenFree: true });
		const off = parseBody({ clientMessageId: uuid(), text: "x", to: [A], whenFree: false });
		if ("status" in plain || "status" in queued || "status" in off) throw new Error("parse");
		expect(requestSha256({ ...off, clientMessageId: plain.clientMessageId })).toBe(
			requestSha256(plain),
		);
		expect(requestSha256({ ...queued, clientMessageId: plain.clientMessageId })).not.toBe(
			requestSha256(plain),
		);
		expect(
			parseBody({ clientMessageId: uuid(), text: "x", to: [A], whenFree: "yes" }),
		).toMatchObject({ status: 400 });
		// Without the field: planned and sent now, as before.
		const r = await sys.fanout.send(OWNER, PID, {
			clientMessageId: uuid(),
			text: "ahora",
			to: [A],
		});
		expect(r.body).toMatchObject({ deliveries: [{ agentId: A, state: "delivered" }] });
		expect(sys.targetCalls).toBe(1);
	});
});

describe("ends without an effect (§3.6)", () => {
	it("cancel closes what is queued; the agent turning free afterwards receives nothing", async () => {
		const r = await send("no va");
		const msgId = r.body.msgId as string;
		const c = await sys.fanout.cancel(PID, msgId);
		expect(c).toMatchObject({
			status: 200,
			body: {
				cancelled: [A],
				deliveries: [{ agentId: A, state: "not-sent", reason: "cancelled" }],
			},
		});
		free(SA, "cid-a");
		sys.queue.kick(PID);
		await settle();
		expect(sys.calls).toHaveLength(0);
		expect(await states(msgId)).toEqual(["queued", "not-sent{cancelled}"]);
		// Idempotent, and unknown ids are 404.
		expect(await sys.fanout.cancel(PID, msgId)).toMatchObject({
			status: 200,
			body: { cancelled: [] },
		});
		expect(await sys.fanout.cancel(PID, uuid())).toMatchObject({ status: 404 });
	});

	it("cancel after the delivery left the queue changes nothing", async () => {
		free(SA, "cid-a");
		const r = await send("ya salió");
		await settle();
		const c = await sys.fanout.cancel(PID, r.body.msgId as string);
		expect(c.body).toMatchObject({ cancelled: [], deliveries: [{ state: "delivered" }] });
		expect(await states(r.body.msgId as string)).toEqual([
			"queued",
			"planned",
			"sending",
			"delivered",
		]);
	});

	it("a cancel that lands while the binding is being re-read wins over the plan", async () => {
		const r = await send("carrera");
		const msgId = r.body.msgId as string;
		await settle();
		free(SA, "cid-a");
		let cancelled: Promise<unknown> | undefined;
		const real = sys.bindings;
		sys.bindings = () => {
			cancelled ??= sys.fanout.cancel(PID, msgId);
			return real();
		};
		sys.queue.kick(PID);
		await settle();
		await cancelled;
		expect(sys.calls).toHaveLength(0);
		expect(await states(msgId)).toEqual(["queued", "not-sent{cancelled}"]);
	});

	it("the binding changed while queued ⇒ not-sent{binding-changed}; never sent to the new one", async () => {
		const r = await send("para el binding viejo");
		await settle();
		sys.bindings = () => bindingsOf({ [A]: { epoch: 2 } });
		free(SA, "cid-a");
		sys.queue.kick(PID);
		await settle();
		expect(sys.calls).toHaveLength(0);
		expect(await states(r.body.msgId as string)).toEqual(["queued", "not-sent{binding-changed}"]);
	});

	it("an agent removed while queued ⇒ not-sent{binding-changed}", async () => {
		const r = await send("x");
		sys.bindings = () => bindingsOf({ [A]: { removed: true } });
		free(SA, "cid-a");
		sys.queue.kick(PID);
		await settle();
		expect(sys.calls).toHaveLength(0);
		expect(await states(r.body.msgId as string)).toEqual(["queued", "not-sent{binding-changed}"]);
	});

	it("D1 not answering leaves it queued; it goes out when D1 is back", async () => {
		const r = await send("espera a D1");
		await settle();
		free(SA, "cid-a");
		const real = sys.bindings;
		sys.bindings = () => undefined;
		sys.queue.kick(PID);
		await settle();
		expect(await states(r.body.msgId as string)).toEqual(["queued"]);
		sys.bindings = real;
		sys.queue.kick(PID);
		await settle();
		expect(sys.calls).toHaveLength(1);
	});

	it("two interactive conversations in the session ⇒ not-sent{ambiguous-target}, never a guess", async () => {
		const r = await send("x");
		sys.recipient.set(SA, { kind: "ambiguous" });
		sys.queue.kick(PID);
		await settle();
		expect(sys.calls).toHaveLength(0);
		expect(await states(r.body.msgId as string)).toEqual(["queued", "not-sent{ambiguous-target}"]);
	});

	it("no conversation yet (session stopped, CLI not started) waits; after 24 h ⇒ not-sent{wait-expired}", async () => {
		const r = await send("paciencia");
		sys.recipient.delete(SA);
		sys.queue.kick(PID);
		await settle();
		expect(await states(r.body.msgId as string)).toEqual(["queued"]);
		now += OWNER_QUEUE_WAIT_MS + 1;
		sys.queue.kick(PID);
		await settle();
		expect(await states(r.body.msgId as string)).toEqual(["queued", "not-sent{wait-expired}"]);
		expect(sys.calls).toHaveLength(0);
	});

	it("a closed head does not hold the line: the next one is tried in the same pass", async () => {
		const r1 = await send("vieja");
		await settle();
		now += OWNER_QUEUE_WAIT_MS + 1;
		const r2 = await send("nueva");
		free(SA, "cid-a");
		sys.queue.kick(PID);
		await settle();
		expect(await states(r1.body.msgId as string)).toEqual(["queued", "not-sent{wait-expired}"]);
		expect(sys.calls.map((c) => c.text)).toEqual(["nueva"]);
		expect(await states(r2.body.msgId as string)).toContain("delivered");
	});

	it("the limit is per recipient: the 21st is 409 queue-full and writes nothing", async () => {
		for (let i = 0; i < OWNER_QUEUE_MAX_PER_AGENT; i++) await send(`m${i}`);
		const before = (await lines()).length;
		const r = await send("una más");
		expect(r).toMatchObject({ status: 409, body: { error: "queue-full", detail: A } });
		expect((await lines()).length).toBe(before);
		// Another agent's queue is its own.
		expect((await send("a B", [B])).status).toBe(202);
	});

	it("whenFree with collab is refused; an agent without a binding is not-sent{no-target}, not queued", async () => {
		const bad = parseBody(
			{
				clientMessageId: uuid(),
				text: "x",
				to: [A],
				whenFree: true,
				collab: { with: B, maxMessages: 2, maxWaitMin: 5, expiresInMin: 10 },
			},
			false,
			true,
		);
		expect(bad).toMatchObject({ status: 400 });
		sys.bindings = () => {
			const m = bindingsOf();
			m.set(A, { removed: false, binding: null });
			return m;
		};
		const r = await send("sin sesión");
		expect(r.body.deliveries).toEqual([{ agentId: A, state: "not-sent", reason: "no-target" }]);
	});
});

describe("uncertainty and restarts (§3.6, §3.4)", () => {
	it("an uncertain result is final: no later pass calls the Composer again", async () => {
		const r = await send("incierto");
		sys.composer = async () => {
			throw new Error("socket hang up");
		};
		free(SA, "cid-a");
		sys.queue.kick(PID);
		await settle();
		expect(await states(r.body.msgId as string)).toEqual([
			"queued",
			"planned",
			"sending",
			"uncertain{composer-error}",
		]);
		for (let i = 0; i < 3; i++) {
			sys.queue.kick(PID);
			await settle();
		}
		expect(sys.calls).toHaveLength(1);
	});

	it("a restart keeps the hold: an uncertain{orphaned} delivery still holds what was queued behind it", async () => {
		const m1 = (await send("m1")).body.msgId as string;
		const m2 = (await send("m2")).body.msgId as string;
		// The process dies inside the Composer call: `sending` with no result.
		const line = (state: string) => ({
			ev: "delivery",
			msg_id: m1,
			agent_id: A,
			state,
			binding: { binding_id: "bind-a", epoch: 1, sid: SA, cid: "cid-a" },
			composer_client_message_id: "11111111-1111-4111-8111-111111111111",
			authorized_by: "owner",
		});
		await sys.store.critical(PID, (tx) => tx.append([line("planned")]));
		await sys.store.critical(PID, (tx) => tx.append([line("sending")]));
		sys.queue.stop();
		await sys.store.close();
		sys = await boot("boot-2");
		free(SA, "cid-a");
		await pass(3);
		expect((await states(m1)).at(-1)).toBe("uncertain{orphaned}");
		expect(sys.calls).toHaveLength(0);
		expect(await states(m2)).toEqual(["queued"]);
	});

	it("a restart leaves the queue as it was and each message is sent once, in order", async () => {
		await send("antes 1");
		await send("antes 2");
		await settle();
		sys.queue.stop();
		await sys.store.close();
		sys = await boot("boot-2");
		await settle();
		expect(sys.calls).toHaveLength(0);
		expect((await lines()).filter((l) => l.ev === "delivery" && l.state !== "queued")).toEqual([]);
		sys.composer = async (sid) => {
			busy(sid, "cid-a");
			return { status: 202, body: { result: "delivered", promptId: `p-${uuid()}`, seq: 7 } };
		};
		for (const expected of ["antes 1", "antes 2"]) {
			free(SA, "cid-a");
			sys.queue.kick(PID);
			await settle();
			expect(sys.calls.at(-1)?.text).toBe(expected);
		}
		expect(sys.calls).toHaveLength(2);
	});

	it("a crash between planned and sending: recovery closes it not-sent, nothing is sent after the restart", async () => {
		const r = await send("a medias");
		const msgId = r.body.msgId as string;
		await sys.store.critical(PID, (tx) =>
			tx.append([
				{
					ev: "delivery",
					msg_id: msgId,
					agent_id: A,
					state: "planned",
					binding: { binding_id: "bind-a", epoch: 1, sid: SA, cid: "cid-a" },
					composer_client_message_id: uuid(),
					authorized_by: "owner",
				},
			]),
		);
		sys.queue.stop();
		await sys.store.close();
		sys = await boot("boot-2");
		free(SA, "cid-a");
		sys.queue.kick(PID);
		await settle();
		expect(sys.calls).toHaveLength(0);
		expect((await states(msgId)).at(-1)).toBe("not-sent{persist-failed}");
	});

	it("a restore closes a queued delivery as uncertain{restored}: the backup may predate its sending", async () => {
		const r = await send("del backup");
		const { state } = await sys.store.view(PID);
		const events = recoveryEvents(
			state,
			{ source: "restore", restoreId: "r1", manifestAt: null },
			{ bootId: "b", truncatedBytes: 0, interleavedWriters: [] },
		);
		expect(events.find((e) => e.ev === "delivery")).toMatchObject({
			msg_id: r.body.msgId,
			state: "uncertain",
			reason: "restored",
		});
	});
});

describe("the line holds after a result that is not clean (§3.6, review of #663)", () => {
	// The recipient reads `ready` throughout: only the hold keeps m2 and m3 back.
	async function three(first: () => Promise<HttpResult>) {
		const ids: string[] = [];
		for (const t of ["m1", "m2", "m3"]) ids.push((await send(t)).body.msgId as string);
		await settle();
		sys.composer = first;
		free(SA, "cid-a");
		await pass();
		sys.composer = answer("delivered");
		return ids as [string, string, string];
	}

	for (const result of ["uncertain", "unconfirmed", "failed", "misdelivered"]) {
		it(`m1 ends ${result}: N passes with a ready recipient call the Composer once; m2 and m3 stay queued and cancellable`, async () => {
			const [m1, m2, m3] = await three(answer(result));
			await pass(4);
			expect(sys.calls.map((c) => c.text)).toEqual(["m1"]);
			expect((await states(m1)).at(-1)).toBe(result);
			expect(await states(m2)).toEqual(["queued"]);
			expect(await states(m3)).toEqual(["queued"]);
			const c = await sys.fanout.cancel(PID, m3);
			expect(c.status).toBe(200);
			expect(await states(m3)).toEqual(["queued", "not-sent{cancelled}"]);
		});
	}

	it("a Composer exception (uncertain{composer-error}) holds the line the same way", async () => {
		const [, m2] = await three(async () => {
			throw new Error("socket hang up");
		});
		await pass(4);
		expect(sys.calls).toHaveLength(1);
		expect(await states(m2)).toEqual(["queued"]);
	});

	it("another agent's line is not held", async () => {
		await three(answer("uncertain"));
		await send("para B", [B]);
		free(SB, "cid-b");
		await pass();
		expect(sys.calls.map((c) => c.text)).toEqual(["m1", "para B"]);
	});

	it("the person marking it done opens the line: the rest leave in order", async () => {
		const [m1, m2, m3] = await three(answer("unconfirmed"));
		await pass(2);
		await ack(m1, A);
		await settle();
		expect(sys.calls.map((c) => c.text)).toEqual(["m1", "m2", "m3"]);
		expect((await states(m2)).at(-1)).toBe("delivered");
		expect((await states(m3)).at(-1)).toBe("delivered");
	});

	it("an ack of another agent's delivery of that message opens nothing", async () => {
		const m1 = (await send("a los dos", [A, B])).body.msgId as string;
		const m2 = (await send("m2")).body.msgId as string;
		await settle();
		sys.composer = answer("unconfirmed");
		free(SA, "cid-a");
		free(SB, "cid-b");
		await pass();
		sys.composer = answer("delivered");
		await ack(m1, B);
		await pass(2);
		expect(await states(m2)).toEqual(["queued"]);
		await ack(m1, A);
		await settle();
		expect((await states(m2)).at(-1)).toBe("delivered");
	});

	it("the Composer's evidence settling it as failed keeps the line held", async () => {
		const [m1, m2] = await three(answer("uncertain"));
		const settleAs = (result: string) =>
			sys.store.critical(PID, (tx) =>
				tx.append([{ ev: "delivery", msg_id: m1, agent_id: A, state: "settled", result }]),
			);
		await settleAs("failed");
		await pass(2);
		expect(sys.calls).toHaveLength(1);
		expect(await states(m2)).toEqual(["queued"]);
	});

	it("settled{delivered} opens it", async () => {
		const [m1, , m3] = await three(answer("uncertain"));
		await sys.store.critical(PID, (tx) =>
			tx.append([
				{
					ev: "delivery",
					msg_id: m1,
					agent_id: A,
					state: "settled",
					result: "delivered",
					prompt_id: "p-1",
				},
			]),
		);
		await settle();
		expect(sys.calls.map((c) => c.text)).toEqual(["m1", "m2", "m3"]);
		expect((await states(m3)).at(-1)).toBe("delivered");
	});

	it("a later direct message that is delivered opens the line", async () => {
		await three(answer("unconfirmed"));
		await pass(2);
		const direct = await send("directo", [A], { whenFree: false });
		expect((direct.body.deliveries as Array<{ state: string }>)[0]?.state).toBe("delivered");
		await settle();
		expect(sys.calls.map((c) => c.text)).toEqual(["m1", "directo", "m2", "m3"]);
	});

	it("a direct message that ends uncertain holds the queue behind it too", async () => {
		const m2 = (await send("en cola")).body.msgId as string;
		await settle();
		sys.composer = answer("uncertain");
		await send("directo", [A], { whenFree: false });
		sys.composer = answer("delivered");
		free(SA, "cid-a");
		await pass(3);
		expect(sys.calls.map((c) => c.text)).toEqual(["directo"]);
		expect(await states(m2)).toEqual(["queued"]);
	});

	// A's review of #663: "last" is the order in which deliveries LEFT for the
	// pane, not of their last line — a `settled` moves the latter.
	const settleAs = (msgId: string, result: string) =>
		sys.store.critical(PID, (tx) =>
			tx.append([{ ev: "delivery", msg_id: msgId, agent_id: A, state: "settled", result }]),
		);
	const heldBy = async () => lineHold((await sys.store.view(PID)).state, A, now)?.msgId ?? null;

	it("a late settled{failed} of an older delivery does not hold again a line a later delivered message opened", async () => {
		const [m1, m2, m3] = await three(answer("uncertain"));
		// Busy, so the queue stays where it is while the direct message goes.
		busy(SA, "cid-a");
		const direct = await send("directo", [A], { whenFree: false });
		expect((direct.body.deliveries as Array<{ state: string }>)[0]?.state).toBe("delivered");
		expect(await heldBy()).toBeNull();
		await settleAs(m1, "failed");
		expect(await heldBy()).toBeNull();
		free(SA, "cid-a");
		await pass(3);
		// Each one once: nothing is sent twice by the line opening.
		expect(sys.calls.map((c) => c.text)).toEqual(["m1", "directo", "m2", "m3"]);
		expect(await states(m2)).toEqual(["queued", "planned", "sending", "delivered"]);
		expect(await states(m3)).toEqual(["queued", "planned", "sending", "delivered"]);
	});

	it('a later "not now" refusal is no evidence about an earlier unclean result: the line stays held past the 10 min', async () => {
		const [m1, m2] = await three(answer("uncertain"));
		sys.composer = refuse("busy");
		await send("directo", [A], { whenFree: false });
		sys.composer = answer("delivered");
		expect(await heldBy()).toBe(m1);
		now += REFUSED_HOLD_MS + 1_000;
		await pass(3);
		expect(await heldBy()).toBe(m1);
		expect(sys.calls.map((c) => c.text)).toEqual(["m1", "directo"]);
		expect(await states(m2)).toEqual(["queued"]);
		// …and a late settled{failed} of m1 changes nothing either way.
		await settleAs(m1, "failed");
		await pass(2);
		expect(await states(m2)).toEqual(["queued"]);
		await ack(m1, A);
		await settle();
		expect((await states(m2)).at(-1)).toBe("delivered");
	});

	it("a later message that ends unclean holds in its turn, whatever the older one settles as", async () => {
		const [m1, m2] = await three(answer("uncertain"));
		sys.composer = answer("unconfirmed");
		const d = (await send("directo", [A], { whenFree: false })).body.msgId as string;
		sys.composer = answer("delivered");
		await settleAs(m1, "delivered");
		expect(await heldBy()).toBe(d);
		await pass(3);
		expect(await states(m2)).toEqual(["queued"]);
	});

	it("marking the later one done covers what left before it", async () => {
		const [, m2] = await three(refuse("composer-not-empty"));
		sys.composer = answer("uncertain");
		const d = (await send("directo", [A], { whenFree: false })).body.msgId as string;
		sys.composer = answer("delivered");
		expect(await heldBy()).toBe(d);
		await ack(d, A);
		await settle();
		expect(await heldBy()).toBeNull();
		expect((await states(m2)).at(-1)).toBe("delivered");
	});

	it("after 24 h nobody settled or acknowledged it: it stops holding; what expired behind it closes wait-expired", async () => {
		const [, m2] = await three(answer("uncertain"));
		const late = (await send("tarde")).body.msgId as string;
		await pass();
		now += LINE_HOLD_MAX_MS - 60_000;
		const fresh = (await send("fresco")).body.msgId as string;
		await pass();
		expect(sys.calls).toHaveLength(1);
		now += 2 * 60_000;
		await pass();
		// m2, m3 and "tarde" waited their own 24 h; "fresco" did not.
		expect(await states(m2)).toEqual(["queued", "not-sent{wait-expired}"]);
		expect(await states(late)).toEqual(["queued", "not-sent{wait-expired}"]);
		expect((await states(fresh)).at(-1)).toBe("delivered");
		expect(sys.calls.map((c) => c.text)).toEqual(["m1", "fresco"]);
	});

	it("a held message still expires on its own clock", async () => {
		const [, m2] = await three(answer("failed"));
		now += OWNER_QUEUE_WAIT_MS + 1;
		// The hold lapsed with it, but nothing is sent: all three were queued together.
		await pass();
		expect(await states(m2)).toEqual(["queued", "not-sent{wait-expired}"]);
		expect(sys.calls).toHaveLength(1);
	});

	it("refused{busy} — the capture was a moment behind — holds for 10 min, then the next one leaves", async () => {
		const [m1, m2, m3] = await three(refuse("busy"));
		await pass(4);
		expect(await states(m1)).toEqual(["queued", "planned", "sending", "refused{busy}"]);
		expect(sys.calls).toHaveLength(1);
		expect(await states(m2)).toEqual(["queued"]);
		now += REFUSED_HOLD_MS - 1_000;
		await pass();
		expect(sys.calls).toHaveLength(1);
		now += 2_000;
		await pass();
		expect(sys.calls.map((c) => c.text)).toEqual(["m1", "m2", "m3"]);
		expect((await states(m3)).at(-1)).toBe("delivered");
	});

	for (const code of ["send-in-progress", "composer-not-empty", "cli-unvalidated"]) {
		it(`refused{${code}} needs a look: it holds until the person marks it done, not for 10 min`, async () => {
			const [m1, m2] = await three(refuse(code));
			now += REFUSED_HOLD_MS + 1_000;
			await pass(3);
			expect(sys.calls).toHaveLength(1);
			expect(await states(m2)).toEqual(["queued"]);
			await ack(m1);
			await settle();
			expect(sys.calls.map((c) => c.text)).toEqual(["m1", "m2", "m3"]);
		});
	}

	it("a refusal repeated on every attempt costs one message per hold, never the whole line", async () => {
		const [, m2, m3] = await three(refuse("busy"));
		sys.composer = refuse("busy");
		for (let i = 0; i < 5; i++) await pass();
		expect(sys.calls).toHaveLength(1);
		now += REFUSED_HOLD_MS;
		await pass(5);
		expect(sys.calls).toHaveLength(2);
		expect((await states(m2)).at(-1)).toBe("refused{busy}");
		expect(await states(m3)).toEqual(["queued"]);
	});

	it("not-sent says nothing about the pane: it never holds", async () => {
		const m1 = (await send("m1")).body.msgId as string;
		await settle();
		sys.recipient.set(SA, { kind: "ambiguous" });
		await pass();
		expect((await states(m1)).at(-1)).toBe("not-sent{ambiguous-target}");
		const m2 = (await send("m2")).body.msgId as string;
		free(SA, "cid-a");
		await pass();
		expect((await states(m2)).at(-1)).toBe("delivered");
	});
});

describe("why a queued delivery waits, on the message read (§3.6)", () => {
	const read = async (msgId: string, agentId = A) => {
		const api = new ProjectConversationApi({
			store: sys.store,
			fanout: sys.fanout,
			ownsProject: async () => true,
			recipient: async (sid) => sys.recipient.get(sid) ?? { kind: "none" },
			now: () => now,
		});
		const r = await api.message(PID, msgId);
		const d = (r.body.deliveries as Array<Record<string, unknown>>).find(
			(x) => x.agentId === agentId,
		) as Record<string, unknown>;
		return { state: d.state, waiting: d.waiting, heldBy: d.heldBy };
	};

	it("busy, no conversation, and nothing to say once it is ready or gone", async () => {
		const m = (await send("m1")).body.msgId as string;
		await settle();
		expect(await read(m)).toEqual({ state: "queued", waiting: "busy", heldBy: undefined });
		sys.recipient.delete(SA);
		expect(await read(m)).toEqual({
			state: "queued",
			waiting: "no-conversation",
			heldBy: undefined,
		});
		sys.recipient.set(SA, { kind: "ambiguous" });
		expect((await read(m)).waiting).toBeUndefined();
		free(SA, "cid-a");
		expect((await read(m)).waiting).toBeUndefined();
		await pass();
		expect(await read(m)).toEqual({ state: "delivered", waiting: undefined, heldBy: undefined });
	});

	it("behind an unclean result it names the delivery that holds the line, until the person marks it done", async () => {
		const ids: string[] = [];
		for (const t of ["m1", "m2"]) ids.push((await send(t)).body.msgId as string);
		const [m1, m2] = ids as [string, string];
		await settle();
		sys.composer = answer("uncertain");
		free(SA, "cid-a");
		await pass();
		expect(await read(m2)).toEqual({ state: "queued", waiting: "held", heldBy: m1 });
		// Another agent's line is its own.
		const other = (await send("to B", [B])).body.msgId as string;
		await settle();
		expect((await read(other, B)).waiting).toBe("busy");
		busy(SA, "cid-a");
		await ack(m1, A);
		expect(await read(m2)).toEqual({ state: "queued", waiting: "busy", heldBy: undefined });
	});

	it('a refusal that says "not now" is the agent being busy, not something to review', async () => {
		const ids: string[] = [];
		for (const t of ["m1", "m2"]) ids.push((await send(t)).body.msgId as string);
		await settle();
		sys.composer = refuse("busy");
		free(SA, "cid-a");
		await pass();
		expect(await read(ids[1] as string)).toEqual({
			state: "queued",
			waiting: "busy",
			heldBy: undefined,
		});
	});

	it("without the queue's reading (dep absent) only the hold is reported", async () => {
		const m = (await send("m1")).body.msgId as string;
		await settle();
		const api = new ProjectConversationApi({
			store: sys.store,
			fanout: sys.fanout,
			ownsProject: async () => true,
		});
		const d = ((await api.message(PID, m)).body.deliveries as Array<Record<string, unknown>>)[0];
		expect(d).not.toHaveProperty("waiting");
	});
});
