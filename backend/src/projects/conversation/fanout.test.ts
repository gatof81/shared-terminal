/**
 * projects/conversation/fanout.ts — PROJECT_CONVERSATION.md §3: the order of
 * §3.3 against the real store, with D1 and the Composer faked. The property
 * every test checks in the end: the Composer is called at most once per
 * delivery, only after its `sending` is on disk, and only for the fixed
 * (sid, cid).
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HttpResult } from "../../conversation/composer.js";
import {
	type FanoutDeps,
	mapComposer,
	type ProjectBindings,
	ProjectFanout,
	parseBody,
	pickTarget,
	requestSha256,
} from "./fanout.js";
import { LOG_FILE, type LogLine } from "./log.js";
import { projectDir } from "./paths.js";
import { ProjectConversationStore } from "./store.js";
import type { WriterLock } from "./writerLock.js";

const PID = "6b1f0c4e-1d2a-4b3c-8d4e-5f6a7b8c9d0e";
const OWNER = "u-owner";
const A = "a0000000-0000-4000-8000-00000000000a";
const B = "b0000000-0000-4000-8000-00000000000b";
const SA = "5a000000-0000-4000-8000-0000000000aa";
const SB = "5b000000-0000-4000-8000-0000000000bb";
const cmid = () => crypto.randomUUID();

let root: string;
let store: ProjectConversationStore;
const lock = (): WriterLock => ({ held: () => true, onLost: () => {}, release: () => {} });

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-fanout-"));
	store = await ProjectConversationStore.start({
		workspaceRoot: root,
		bootId: "boot",
		acquire: async () => ({ ok: true, lock: lock() }),
	});
});
afterEach(async () => {
	await store.close();
	await fs.rm(root, { recursive: true, force: true });
});

function bindingsOf(
	over: Partial<
		Record<string, { epoch?: number; sid?: string; removed?: boolean; none?: boolean }>
	> = {},
): ProjectBindings {
	const m: ProjectBindings = new Map();
	for (const [agent, sid] of [
		[A, SA],
		[B, SB],
	] as const) {
		const o = over[agent] ?? {};
		m.set(agent, {
			removed: o.removed ?? false,
			binding: o.none
				? null
				: { bindingId: `bind-${agent.slice(0, 1)}`, epoch: o.epoch ?? 1, sessionId: o.sid ?? sid },
		});
	}
	return m;
}

interface Harness {
	deps: FanoutDeps;
	calls: Array<{
		sid: string;
		cid: string;
		clientMessageId: string;
		text: string;
		diskStateAtCall: string;
	}>;
	delivered: unknown[];
	uncertain: unknown[];
	bindingsQueue: Array<ProjectBindings | Error>;
	composer: (sid: string) => Promise<HttpResult>;
}

async function lines(): Promise<LogLine[]> {
	const raw = await fs.readFile(path.join(projectDir(root, PID), LOG_FILE), "utf8");
	return raw
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as LogLine);
}

function harness(): Harness {
	const h: Harness = {
		calls: [],
		delivered: [],
		uncertain: [],
		bindingsQueue: [],
		composer: async () => ({ status: 202, body: { result: "delivered", promptId: "p1", seq: 7 } }),
		deps: undefined as unknown as FanoutDeps,
	};
	h.deps = {
		store,
		bindings: async () => {
			const next = h.bindingsQueue.length > 0 ? h.bindingsQueue.shift() : bindingsOf();
			if (next instanceof Error) throw next;
			return next as ProjectBindings;
		},
		target: async (sid) => ({ kind: "ok", cid: `c-${sid.slice(0, 2)}` }),
		sessionMeta: async () => ({ userId: OWNER }),
		composerSend: async (input) => {
			// what was on disk for this delivery at the moment of the effect
			const ls = await lines();
			const mine = ls.filter(
				(l) =>
					l.ev === "delivery" &&
					l.composer_client_message_id === undefined &&
					l.state === "sending",
			);
			h.calls.push({
				sid: input.stSessionId,
				cid: input.cid,
				clientMessageId: input.body.clientMessageId,
				text: input.body.text,
				diskStateAtCall: mine.length > 0 ? "sending" : "none",
			});
			return h.composer(input.stSessionId);
		},
		onDelivered: (d) => h.delivered.push(d),
		onUncertain: (d) => h.uncertain.push(d),
		isForbidden: (e) => (e as Error).message === "forbidden",
		tHttpMs: 2_000,
	};
	return h;
}

const send = (h: Harness, body: Record<string, unknown>) =>
	new ProjectFanout(h.deps).send(OWNER, PID, body);

describe("parseBody / requestSha256", () => {
	it("validates and refuses attachments while D2 is not built", () => {
		expect(parseBody({ clientMessageId: "x", text: "hi", to: [A] })).toMatchObject({ status: 400 });
		expect(parseBody({ clientMessageId: cmid(), text: "/help", to: [A] })).toMatchObject({
			status: 400,
			body: { error: "unsupported-prefix" },
		});
		expect(parseBody({ clientMessageId: cmid(), text: "hi", to: [] })).toMatchObject({
			status: 400,
		});
		expect(parseBody({ clientMessageId: cmid(), text: "hi", to: [A, A] })).toMatchObject({
			status: 400,
		});
		expect(
			parseBody({ clientMessageId: cmid(), text: "hi", to: [A], artifacts: [{}] }),
		).toMatchObject({ status: 409, body: { error: "artifacts-off" } });
		expect(parseBody({ clientMessageId: cmid(), text: "x\n".repeat(49), to: [A] })).toMatchObject({
			body: { error: "too-many-segments" },
		});
	});
	it("T5d: the canonical normalized body, not the bytes", () => {
		const id = cmid();
		const a = parseBody({ clientMessageId: id, text: "hola  \r\nmundo\n", to: [A, B] });
		const b = parseBody({ to: [B, A], text: "hola\nmundo", clientMessageId: id.toUpperCase() });
		if ("status" in a || "status" in b) throw new Error("parse");
		expect(requestSha256(a)).toBe(requestSha256(b));
		const c = parseBody({ clientMessageId: id, text: "hola\nmundo", to: [A] });
		if ("status" in c) throw new Error("parse");
		expect(requestSha256(c)).not.toBe(requestSha256(a));
	});
});

describe("pickTarget", () => {
	const c = (
		cid: string,
		o: Partial<{
			kind: string;
			paneId: string | null;
			endedAt: string | null;
			blocked: boolean;
		}> = {},
	) => ({
		cid,
		kind: "interactive",
		paneId: "%1",
		endedAt: null,
		blocked: false,
		...o,
	});
	it("exactly one receiving conversation, never a guess", () => {
		expect(pickTarget([c("x")])).toEqual({ kind: "ok", cid: "x" });
		expect(pickTarget([c("x"), c("y")])).toEqual({ kind: "ambiguous", count: 2 });
		expect(
			pickTarget([
				c("x", { paneId: null }),
				c("y", { kind: "headless" }),
				c("z", { endedAt: "t" }),
			]),
		).toEqual({ kind: "none" });
		expect(pickTarget([c("x", { blocked: true })])).toEqual({ kind: "none" });
	});
});

describe("mapComposer (§3.1)", () => {
	it("maps every answer; a throw or an unknown answer is uncertain, never no-effect", () => {
		expect(
			mapComposer({ status: 202, body: { result: "delivered", promptId: "p", seq: 3 } }),
		).toMatchObject({ state: "delivered", http: { promptId: "p", seq: 3 } });
		for (const [status, code] of [
			[409, "busy"],
			[429, "rate-limited"],
			[503, "shutting-down"],
			[400, "empty-text"],
		] as const) {
			expect(mapComposer({ status, body: { error: code } })).toMatchObject({
				state: "refused",
				reason: code,
			});
		}
		expect(mapComposer({ status: 404, body: { error: "Conversation not found" } }).state).toBe(
			"refused",
		);
		expect(mapComposer({ status: 502, body: { error: "delivery-failed" } })).toMatchObject({
			state: "failed",
		});
		expect(mapComposer(new Error("boom"))).toMatchObject({
			state: "uncertain",
			reason: "composer-error",
		});
		expect(mapComposer({ status: 202, body: { result: "weird" } })).toMatchObject({
			state: "uncertain",
		});
		expect(mapComposer({ status: 500, body: {} })).toMatchObject({ state: "uncertain" });
	});
});

describe("send — §3.3 order", () => {
	it("two recipients: message, planned, sending BEFORE the effect, result; one call each to the fixed target", async () => {
		const h = harness();
		const r = await send(h, { clientMessageId: cmid(), text: "plan it", to: [A, B] });
		expect(r.status).toBe(202);
		expect((r.body as { deliveries: unknown[] }).deliveries).toEqual([
			{
				agentId: A,
				state: "delivered",
				http: { status: 202, result: "delivered", promptId: "p1", seq: 7 },
			},
			{
				agentId: B,
				state: "delivered",
				http: { status: 202, result: "delivered", promptId: "p1", seq: 7 },
			},
		]);
		expect(h.calls.map((c) => [c.sid, c.cid, c.text, c.diskStateAtCall]).sort()).toEqual([
			[SA, "c-5a", "plan it", "sending"],
			[SB, "c-5b", "plan it", "sending"],
		]);
		const ls = await lines();
		const planned = ls.filter((l) => l.state === "planned");
		expect(planned.map((l) => l.composer_client_message_id).sort()).toEqual(
			h.calls.map((c) => c.clientMessageId).sort(),
		);
		expect(planned[0]).toMatchObject({
			binding: { binding_id: "bind-a", epoch: 1, sid: SA, cid: "c-5a" },
		});
		expect(
			ls
				.filter((l) => l.state === "sending")
				.every((l) => typeof l.binding_verified_at === "string"),
		).toBe(true);
		expect(h.delivered).toHaveLength(2);
	});

	it("T5/T5c: a replay returns what is stored with no effect; another body is a conflict", async () => {
		const h = harness();
		const id = cmid();
		await send(h, { clientMessageId: id, text: "once", to: [A] });
		const again = await send(h, { clientMessageId: id, text: "once\n", to: [A] });
		expect(again).toMatchObject({
			status: 202,
			body: { replayed: true, deliveries: [{ agentId: A, state: "delivered" }] },
		});
		expect(await send(h, { clientMessageId: id, text: "other", to: [A] })).toMatchObject({
			status: 409,
			body: { error: "idempotency-conflict" },
		});
		expect(await send(h, { clientMessageId: id, text: "once", to: [A, B] })).toMatchObject({
			status: 409,
		});
		expect(h.calls).toHaveLength(1);
	});

	it("T5b: concurrent POSTs with one id ⇒ one message, one call per recipient", async () => {
		const h = harness();
		const id = cmid();
		const rs = await Promise.all(
			[1, 2, 3].map(() => send(h, { clientMessageId: id, text: "x", to: [A] })),
		);
		expect(rs.filter((r) => (r.body as { replayed?: boolean }).replayed === false)).toHaveLength(1);
		expect((await lines()).filter((l) => l.ev === "message")).toHaveLength(1);
		expect(h.calls).toHaveLength(1);
	});

	it("T6: binding changed or unreadable before the intent ⇒ not-sent, no call", async () => {
		const h = harness();
		// resolve, then a (ok), then c0 changed for A; B unreadable at a
		h.bindingsQueue.push(bindingsOf(), bindingsOf({ [A]: { epoch: 2 } }));
		const r1 = await send(h, { clientMessageId: cmid(), text: "x", to: [A] });
		expect((r1.body as { deliveries: unknown[] }).deliveries).toEqual([
			{ agentId: A, state: "not-sent", reason: "binding-changed" },
		]);
		h.bindingsQueue.push(bindingsOf(), new Error("D1 down"));
		const r2 = await send(h, { clientMessageId: cmid(), text: "y", to: [A] });
		expect((r2.body as { deliveries: unknown[] }).deliveries).toEqual([
			{ agentId: A, state: "not-sent", reason: "binding-unverified" },
		]);
		expect(h.calls).toHaveLength(0);
	});

	it("T6b: a change after c0 cannot redirect: the call goes to the session fixed at send", async () => {
		const h = harness();
		h.composer = async () => {
			h.bindingsQueue.push(
				bindingsOf({ [A]: { sid: "99999999-0000-4000-8000-000000000000", epoch: 2 } }),
			);
			return { status: 202, body: { result: "delivered", promptId: "p", seq: 1 } };
		};
		await send(h, { clientMessageId: cmid(), text: "x", to: [A] });
		expect(h.calls.map((c) => c.sid)).toEqual([SA]);
	});

	it("removed agent / no binding / ambiguous target ⇒ not-sent at S1, no call", async () => {
		const h = harness();
		h.bindingsQueue.push(bindingsOf({ [A]: { removed: true }, [B]: { none: true } }));
		const r = await send(h, { clientMessageId: cmid(), text: "x", to: [A, B] });
		expect((r.body as { deliveries: unknown[] }).deliveries).toEqual([
			{ agentId: A, state: "not-sent", reason: "agent-removed" },
			{ agentId: B, state: "not-sent", reason: "no-target" },
		]);
		h.deps.target = async () => ({ kind: "ambiguous", count: 2 });
		const r2 = await send(h, { clientMessageId: cmid(), text: "y", to: [A] });
		expect((r2.body as { deliveries: unknown[] }).deliveries).toEqual([
			{ agentId: A, state: "not-sent", reason: "ambiguous-target" },
		]);
		expect(h.calls).toHaveLength(0);
	});

	it("T8/T8b: one busy, one delivered — independent, nothing retried; a throw is uncertain", async () => {
		const h = harness();
		h.composer = async (sid) =>
			sid === SA
				? { status: 409, body: { error: "busy" } }
				: { status: 202, body: { result: "delivered", promptId: "p", seq: 2 } };
		const r = await send(h, { clientMessageId: cmid(), text: "x", to: [A, B] });
		expect(
			(r.body as { deliveries: Array<{ state: string }> }).deliveries.map((d) => d.state),
		).toEqual(["refused", "delivered"]);
		h.composer = async () => {
			throw new Error("socket hang up");
		};
		const r2 = await send(h, { clientMessageId: cmid(), text: "y", to: [A] });
		expect((r2.body as { deliveries: unknown[] }).deliveries).toEqual([
			{ agentId: A, state: "uncertain", reason: "composer-error", http: { status: 0 } },
		]);
		expect(h.calls).toHaveLength(3);
	});

	it("review regression: an uncertain answer is handed to the settlement watch at once", async () => {
		const h = harness();
		h.composer = async () => ({ status: 202, body: { result: "uncertain" } });
		await send(h, { clientMessageId: cmid(), text: "x", to: [A] });
		expect(h.uncertain).toEqual([
			expect.objectContaining({ msgId: expect.any(String), agentId: A, sid: SA, cid: "c-5a" }),
		]);
	});

	it("review regression: session meta failing — forbidden ⇒ 409, a D1 hiccup ⇒ 503; at c0 ⇒ not-sent with no call", async () => {
		const h = harness();
		h.deps.sessionMeta = async () => {
			throw new Error("forbidden");
		};
		expect(await send(h, { clientMessageId: cmid(), text: "x", to: [A] })).toMatchObject({
			status: 409,
		});
		h.deps.sessionMeta = async () => {
			throw new Error("D1 timeout");
		};
		expect(await send(h, { clientMessageId: cmid(), text: "x", to: [A] })).toMatchObject({
			status: 503,
			body: { error: "binding-unverified" },
		});
		let n = 0;
		h.deps.sessionMeta = async () => {
			n++;
			if (n === 2) throw new Error("D1 timeout");
			return { userId: OWNER };
		};
		const r = await send(h, { clientMessageId: cmid(), text: "x", to: [A] });
		expect((r.body as { deliveries: unknown[] }).deliveries).toEqual([
			{ agentId: A, state: "not-sent", reason: "binding-unverified" },
		]);
		expect(h.calls).toHaveLength(0);
	});

	it("unknown recipient is 400; not this owner's project is 404; a foreign session is 409", async () => {
		const h = harness();
		expect(
			await send(h, {
				clientMessageId: cmid(),
				text: "x",
				to: ["c0000000-0000-4000-8000-00000000000c"],
			}),
		).toMatchObject({ status: 400 });
		h.deps.bindings = async () => null;
		expect(await send(h, { clientMessageId: cmid(), text: "x", to: [A] })).toMatchObject({
			status: 404,
		});
		const h2 = harness();
		h2.deps.sessionMeta = async () => ({ userId: "someone-else" });
		expect(await send(h2, { clientMessageId: cmid(), text: "x", to: [A] })).toMatchObject({
			status: 409,
			body: { error: "foreign-session" },
		});
		expect(h.calls.length + h2.calls.length).toBe(0);
	});

	it("T_http: a slow send answers `sending` and finishes on its own; the result lands in the log", async () => {
		const h = harness();
		h.deps.tHttpMs = 50;
		let release!: () => void;
		h.composer = () =>
			new Promise((resolve) => {
				release = () =>
					resolve({ status: 202, body: { result: "delivered", promptId: "p", seq: 9 } });
			});
		const r = await send(h, { clientMessageId: cmid(), text: "x", to: [A] });
		expect((r.body as { deliveries: Array<{ state: string }> }).deliveries[0]?.state).toBe(
			"sending",
		);
		release();
		await new Promise((r) => setTimeout(r, 30));
		expect((await lines()).some((l) => l.state === "delivered")).toBe(true);
		expect(h.calls).toHaveLength(1);
	});
});

describe("send — persistence failures (T4, S4)", () => {
	it("T4: the intent cannot be written ⇒ the Composer is never called", async () => {
		await store.close();
		let n = 0;
		store = await ProjectConversationStore.start({
			workspaceRoot: root,
			bootId: "boot2",
			acquire: async () => ({ ok: true, lock: lock() }),
			// S1 is the first append; the second (S3, the intent) fails.
			syncFile: async (fh) => {
				n++;
				if (n === 2) throw new Error("EIO");
				await fh.sync();
			},
		});
		const h = harness();
		const r = await send(h, { clientMessageId: cmid(), text: "x", to: [A] });
		expect((r.body as { deliveries: unknown[] }).deliveries).toEqual([
			{ agentId: A, state: "not-sent", reason: "persist-failed" },
		]);
		expect(h.calls).toHaveLength(0);
	});

	it("S4 cannot be made durable ⇒ sent exactly once; reopened it is delivered or uncertain{orphaned}, never resent", async () => {
		await store.close();
		let n = 0;
		store = await ProjectConversationStore.start({
			workspaceRoot: root,
			bootId: "boot3",
			acquire: async () => ({ ok: true, lock: lock() }),
			syncFile: async (fh) => {
				n++;
				if (n === 3) throw new Error("EIO");
				await fh.sync();
			},
		});
		const h = harness();
		await send(h, { clientMessageId: cmid(), text: "x", to: [A] });
		expect(h.calls).toHaveLength(1);
		await store.close();
		store = await ProjectConversationStore.start({
			workspaceRoot: root,
			bootId: "boot4",
			acquire: async () => ({ ok: true, lock: lock() }),
		});
		const st = await store.critical(PID, async (tx) => tx.state);
		const d = [...st.deliveries.values()][0];
		// A failed fsync may or may not have kept the bytes: either the result
		// survived, or the intent alone did and recovery calls it orphaned.
		// Never not-sent, never a second call.
		expect(["delivered", "uncertain"]).toContain(d?.state);
		if (d?.state === "uncertain") expect(d.reason).toBe("orphaned");
		expect(h.calls).toHaveLength(1);
	});
});
