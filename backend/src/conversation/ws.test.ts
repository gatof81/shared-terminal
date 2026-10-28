/**
 * ws.test.ts — `WS /ws/conversation/<sid>` (CONVERSATION.md §6.1, §10 3.1)
 * against a real ConversationStore on a temp dir and real `ws` sockets:
 * replay + live with no loss and no duplicate while events keep landing,
 * `gap history_rotated`, the slow-client budgets (replay ⇒ 1013 with at
 * most 2 MiB + the largest frame in flight; live ⇒ one `resync`), and the
 * socket/subscription caps.
 */

import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { ConversationStore, type PendingEvent, type PersistedEvent } from "./store.js";
import { CLOSE_TRY_AGAIN, ConversationWsHub, type ConversationWsLimits } from "./ws.js";

const MiB = 1024 * 1024;
let root: string;
let store: ConversationStore;
let server: http.Server;
let port: number;
let serverSockets: WebSocket[];
let resyncs: number;
let hub: ConversationWsHub;

const pending = (i: number, data: Record<string, unknown> = {}): PendingEvent => ({
	ev: "user_prompt",
	prompt_id: `p${i}`,
	turn_id: null,
	agent_id: null,
	pane: null,
	data: { prompt: `hello ${i}`, ...data },
});

async function start(limits: Partial<ConversationWsLimits> = {}, storeLimits = {}) {
	store = new ConversationStore({
		workspaceRoot: root,
		limits: {
			queueEvents: 5000,
			queueBytes: 256 * MiB,
			totalQueueBytes: 512 * MiB,
			...storeLimits,
		},
	});
	resyncs = 0;
	hub = new ConversationWsHub(
		{
			summaries: async (st: string) => {
				const ids = await store.listConversationIds(st);
				const out = [];
				for (const cid of ids) {
					const idx = await store.peekIndex(st, cid);
					if (idx)
						out.push({
							sessionId: cid,
							lastSeq: idx.lastSeq,
							firstRetainedSeq: idx.firstRetainedSeq,
							status: idx.state.status,
						});
				}
				return out as never;
			},
			conversationFile: async (st: string, cid: string) => {
				if (!(await store.exists(st, cid))) return null;
				const index = await store.peekIndex(st, cid);
				return index ? { index, eventsFile: store.eventsPath(st, cid) } : null;
			},
			residentState: (st: string, cid: string) => store.getResidentIndex(st, cid)?.state ?? null,
			onPersistedEvent: (l) => store.onEvent(l),
			noteWsResync: () => {
				resyncs++;
			},
		},
		{ drainPollMs: 5, ...limits },
	);
	serverSockets = [];
	const wss = new WebSocketServer({ noServer: true });
	server = http.createServer();
	server.on("upgrade", (req, socket, head) =>
		wss.handleUpgrade(req, socket, head, (ws) => {
			serverSockets.push(ws);
			hub.serve(ws, "s1", req.headers["x-user"] === "u2" ? "u2" : "u1");
		}),
	);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	port = (server.address() as AddressInfo).port;
}

interface Client {
	ws: WebSocket;
	frames: Array<Record<string, unknown>>;
	closed: Promise<{ code: number }>;
	send(m: object): void;
	events(conv?: string): PersistedEvent[];
	waitFor(pred: () => boolean, ms?: number): Promise<void>;
}
async function connect(user = "u1"): Promise<Client> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/conversation/s1`, {
		headers: { "x-user": user },
	});
	const frames: Array<Record<string, unknown>> = [];
	ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
	const closed = new Promise<{ code: number }>((r) => ws.on("close", (code) => r({ code })));
	await new Promise<void>((r, j) => {
		ws.once("open", () => r());
		ws.once("error", j);
	});
	const c: Client = {
		ws,
		frames,
		closed,
		send: (m) => ws.send(JSON.stringify(m)),
		events: (conv = "c1") =>
			frames
				.filter((f) => f.type === "event" && f.conv === conv)
				.map((f) => f.event as PersistedEvent),
		waitFor: async (pred, ms = 10_000) => {
			const end = Date.now() + ms;
			while (!pred()) {
				if (Date.now() > end) throw new Error("timed out waiting");
				await new Promise((r) => setTimeout(r, 5));
			}
		},
	};
	await c.waitFor(() => frames.some((f) => f.type === "hello"));
	return c;
}
const seqs = (events: PersistedEvent[]) => events.map((e) => e.seq);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
// A paused client socket: the kernel buffers fill, then ws.bufferedAmount grows.
const pauseReading = (c: Client) =>
	(c.ws as unknown as { _socket: { pause(): void } })._socket.pause();
const resumeReading = (c: Client) =>
	(c.ws as unknown as { _socket: { resume(): void } })._socket.resume();

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "conv-ws-"));
});
afterEach(async () => {
	for (const s of serverSockets ?? []) s.terminate();
	await new Promise<void>((r) => server?.close(() => r()));
	await fs.rm(root, { recursive: true, force: true });
});

describe("replay + live", () => {
	it("hello, then every event once and in order while events keep landing", async () => {
		await start();
		await store.open("s1", "c1");
		for (let i = 1; i <= 500; i++) store.enqueue("s1", "c1", pending(i));
		await store.flush("s1", "c1");
		const c = await connect();
		expect(c.frames[0]).toMatchObject({
			type: "hello",
			conversations: [{ cid: "c1", lastSeq: 500, firstRetainedSeq: 1 }],
		});
		c.send({ type: "subscribe", conv: "c1", after: 0 });
		// Concurrent appends during the replay, then live ones after it.
		for (let i = 501; i <= 1000; i++) store.enqueue("s1", "c1", pending(i));
		await store.flush("s1", "c1");
		await c.waitFor(() => c.events().length >= 1000);
		for (let i = 1001; i <= 1100; i++) store.enqueue("s1", "c1", pending(i));
		await store.flush("s1", "c1");
		await c.waitFor(() => c.events().length >= 1100);
		await new Promise((r) => setTimeout(r, 50));
		expect(seqs(c.events())).toEqual(range(1, 1100));
	});

	it("subscribe with `after` replays only newer events; a status frame follows", async () => {
		await start();
		await store.open("s1", "c1");
		for (let i = 1; i <= 20; i++) store.enqueue("s1", "c1", pending(i));
		await store.flush("s1", "c1");
		const c = await connect();
		c.send({ type: "subscribe", conv: "c1", after: 15 });
		await c.waitFor(() => c.events().length >= 5);
		await c.waitFor(() => c.frames.some((f) => f.type === "status"));
		expect(seqs(c.events())).toEqual(range(16, 20));
		expect(c.frames.find((f) => f.type === "status")).toMatchObject({ conv: "c1" });
	});

	it("a cursor older than the retained history gets `gap history_rotated` first", async () => {
		await start({}, { fileBytes: 4000 });
		await store.open("s1", "c1");
		for (let i = 1; i <= 60; i++) store.enqueue("s1", "c1", pending(i));
		await store.flush("s1", "c1");
		const first = store.getResidentIndex("s1", "c1")?.firstRetainedSeq ?? 0;
		const last = store.getResidentIndex("s1", "c1")?.lastSeq ?? 0;
		expect(first).toBeGreaterThan(1);
		const c = await connect();
		c.send({ type: "subscribe", conv: "c1", after: 0 });
		await c.waitFor(() => c.events().length >= last - first + 1);
		const gapIdx = c.frames.findIndex((f) => f.type === "gap");
		const firstEventIdx = c.frames.findIndex((f) => f.type === "event");
		expect(c.frames[gapIdx]).toEqual({
			type: "gap",
			conv: "c1",
			reason: "history_rotated",
			from: 1,
			to: first - 1,
		});
		expect(gapIdx).toBeLessThan(firstEventIdx);
		expect(seqs(c.events())).toEqual(range(first, last));
	});

	it("an unknown conversation answers error not-found; bad frames answer bad-request", async () => {
		await start();
		const c = await connect();
		c.send({ type: "subscribe", conv: "nope", after: 0 });
		c.ws.send("not json");
		c.send({ type: "dance" });
		await c.waitFor(() => c.frames.filter((f) => f.type === "error").length >= 3);
		const codes = c.frames.filter((f) => f.type === "error").map((f) => f.code);
		expect(codes.sort()).toEqual(["bad-request", "bad-request", "not-found"]);
	});
});

describe("backpressure (G3)", () => {
	it("replay to a client that does not read: ≤ 2 MiB + largest frame in flight, close 1013, reconnect loses and duplicates nothing", async () => {
		await start({ drainTimeoutMs: 400 }, { fileBytes: 1 << 30 }); // no L7 rotation at 66 MiB
		await store.open("s1", "c1");
		for (let i = 1; i <= 60; i++) {
			// One event of pure \u0001 (its frame is ~6 MiB after JSON escaping),
			// early so it is sent while the client has stopped reading.
			const prompt = i === 2 ? "\u0001".repeat(MiB) : "y".repeat(MiB);
			store.enqueue("s1", "c1", pending(i, { prompt }));
		}
		await store.flush("s1", "c1");
		const c = await connect();
		const srv = serverSockets[0];
		let maxBuffered = 0;
		let largestFrame = 0;
		const send = srv.send.bind(srv);
		(srv as unknown as { send: (d: string) => void }).send = (d: string) => {
			largestFrame = Math.max(largestFrame, Buffer.byteLength(d));
			send(d);
			maxBuffered = Math.max(maxBuffered, srv.bufferedAmount);
		};
		let closeCode = 0;
		const close = srv.close.bind(srv);
		(srv as unknown as { close: (code: number, r: string) => void }).close = (code, r) => {
			closeCode = code;
			close(code, r);
		};
		pauseReading(c);
		c.send({ type: "subscribe", conv: "c1", after: 0 });
		const end = Date.now() + 20_000;
		while (closeCode === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
		expect(closeCode).toBe(CLOSE_TRY_AGAIN);
		expect(largestFrame).toBeGreaterThan(5 * MiB);
		expect(maxBuffered).toBeLessThanOrEqual(2 * MiB + largestFrame);
		resumeReading(c);
		expect((await c.closed).code).toBe(CLOSE_TRY_AGAIN);
		const got = seqs(c.events());
		expect(got).toEqual(range(1, got.length));
		expect(got.length).toBeLessThan(60);
		// Reconnect from the last seq received.
		const c2 = await connect();
		c2.send({ type: "subscribe", conv: "c1", after: got.at(-1) ?? 0 });
		await c2.waitFor(() => c2.events().length >= 60 - got.length, 20_000);
		expect([...got, ...seqs(c2.events())]).toEqual(range(1, 60));
	}, 60_000);

	it("live past the budget: one `resync{fromSeq}`, re-subscribing from it loses and duplicates nothing", async () => {
		await start();
		await store.open("s1", "c1");
		store.enqueue("s1", "c1", pending(1));
		await store.flush("s1", "c1");
		const c = await connect();
		c.send({ type: "subscribe", conv: "c1", after: 0 });
		await c.waitFor(() => c.events().length >= 1 && c.frames.some((f) => f.type === "status"));
		pauseReading(c);
		for (let i = 2; i <= 40; i++)
			store.enqueue("s1", "c1", pending(i, { prompt: "z".repeat(MiB) }));
		await store.flush("s1", "c1");
		const end = Date.now() + 10_000;
		while (resyncs === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
		expect(resyncs).toBe(1);
		resumeReading(c);
		await c.waitFor(() => c.frames.some((f) => f.type === "resync"));
		const resync = c.frames.find((f) => f.type === "resync") as { fromSeq: number; conv: string };
		expect(resync.conv).toBe("c1");
		const before = seqs(c.events());
		expect(before.at(-1)).toBe(resync.fromSeq);
		c.send({ type: "subscribe", conv: "c1", after: resync.fromSeq });
		await c.waitFor(() => c.events().length >= 40, 20_000);
		expect(seqs(c.events())).toEqual(range(1, 40));
		expect(c.frames.filter((f) => f.type === "resync")).toHaveLength(1);
	}, 60_000);
});

describe("caps", () => {
	it("a fifth socket per user gets too-many-sockets and 1008; another user is unaffected", async () => {
		await start();
		const open = [];
		for (let i = 0; i < 4; i++) open.push(await connect());
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/conversation/s1`, {
			headers: { "x-user": "u1" },
		});
		const frames: Array<Record<string, unknown>> = [];
		ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
		const code = await new Promise<number>((r) => ws.on("close", (c) => r(c)));
		expect(code).toBe(1008);
		expect(frames).toEqual([{ type: "error", code: "too-many-sockets" }]);
		await connect("u2");
		// Closing one frees its slot.
		open[0].ws.close();
		await open[0].closed;
		await new Promise((r) => setTimeout(r, 20));
		expect(hub.openSockets("u1")).toBe(3);
		await connect();
	});

	it("a ninth subscription on one socket is refused", async () => {
		await start();
		for (let i = 1; i <= 9; i++) {
			await store.open("s1", `c${i}`);
			store.enqueue("s1", `c${i}`, pending(i));
			await store.flush("s1", `c${i}`);
		}
		const c = await connect();
		for (let i = 1; i <= 9; i++) c.send({ type: "subscribe", conv: `c${i}`, after: 0 });
		await c.waitFor(() => c.frames.some((f) => f.type === "error"));
		await c.waitFor(() => range(1, 8).every((i) => c.events(`c${i}`).length === 1));
		expect(c.frames.filter((f) => f.type === "error")).toEqual([
			{ type: "error", code: "too-many-subscriptions", conv: "c9" },
		]);
		// Unsubscribing frees a slot.
		c.send({ type: "unsubscribe", conv: "c1" });
		c.send({ type: "subscribe", conv: "c9", after: 0 });
		await c.waitFor(() => c.events("c9").length === 1);
	});
});
