/**
 * projects/conversation/api.ts and ws.ts — PROJECT_CONVERSATION.md §4.3, §5:
 * stable filtered pagination (T26), owner_ack idempotency (T25), the message
 * view, and the project WS (snapshot then live, once, in seq order).
 */

import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { ProjectConversationApi } from "./api.js";
import type { ProjectFanout } from "./fanout.js";
import type { LogLine } from "./log.js";
import { ProjectConversationStore } from "./store.js";
import type { WriterLock } from "./writerLock.js";
import { ProjectWsHub } from "./ws.js";

const PID = "6b1f0c4e-1d2a-4b3c-8d4e-5f6a7b8c9d0e";
const M1 = "11111111-1111-4111-8111-111111111111";
const A = "a0000000-0000-4000-8000-00000000000a";
const lock = (): WriterLock => ({ held: () => true, onLost: () => {}, release: () => {} });

let root: string;
let store: ProjectConversationStore;
let api: ProjectConversationApi;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-papi-"));
	store = await ProjectConversationStore.start({
		workspaceRoot: root,
		bootId: "b",
		acquire: async () => ({ ok: true, lock: lock() }),
	});
	api = new ProjectConversationApi({
		store,
		fanout: {} as ProjectFanout,
		ownsProject: async () => true,
	});
});
afterEach(async () => {
	await store.close();
	await fs.rm(root, { recursive: true, force: true });
});

async function seed(n: number): Promise<void> {
	await store.critical(PID, async (tx) => {
		await tx.append([
			{ ev: "message", msg_id: M1, client_message_id: "c", kind: "owner", to: [A] },
		]);
		for (let i = 0; i < n; i++)
			await tx.append([
				{ ev: i % 3 === 0 ? "delivery" : "noise", msg_id: M1, agent_id: A, state: "planned", i },
			]);
	});
}

describe("GET …/events (T26)", () => {
	it("pages backward in ascending order, no gap, no duplicate — also with a filter and while writing", async () => {
		await seed(30);
		const seen: number[] = [];
		let before: number | undefined;
		for (;;) {
			const r = await api.events(PID, {
				limit: "4",
				...(before ? { before: String(before) } : {}),
			});
			const b = r.body as { events: LogLine[]; oldestSeq: number | null; hasMore: boolean };
			const seqs = b.events.map((e) => e.seq);
			expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
			seen.unshift(...seqs);
			// a write between pages never shifts the cursor
			await store.critical(PID, (tx) => tx.append([{ ev: "noise" }]));
			if (!b.hasMore) break;
			before = b.oldestSeq as number;
		}
		expect(seen).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));

		const filtered: number[] = [];
		before = undefined;
		for (;;) {
			const r = await api.events(PID, {
				limit: "2",
				ev: "delivery,message",
				...(before ? { before: String(before) } : {}),
			});
			const b = r.body as { events: LogLine[]; oldestSeq: number | null; hasMore: boolean };
			filtered.unshift(...b.events.map((e) => e.seq));
			if (!b.hasMore) break;
			before = b.oldestSeq as number;
		}
		const all = (await store.view(PID)).lines
			.filter((l) => l.ev === "delivery" || l.ev === "message")
			.map((l) => l.seq);
		expect(filtered).toEqual(all);
	});

	it("refuses malformed cursors", async () => {
		await seed(1);
		for (const q of [{ before: "0" }, { before: "x" }, { limit: "501" }, { ev: "Bad-Ev" }]) {
			expect((await api.events(PID, q)).status).toBe(400);
		}
	});
});

describe("GET …/messages/:msgId", () => {
	it("the message with deliveries, replies and acks; unknown ⇒ 404", async () => {
		await store.critical(PID, (tx) =>
			tx.append([
				{ ev: "message", msg_id: M1, client_message_id: "c", kind: "owner", to: [A] },
				{ ev: "delivery", msg_id: M1, agent_id: A, state: "planned" },
			]),
		);
		await store.critical(PID, (tx) =>
			tx.append([{ ev: "delivery", msg_id: M1, agent_id: A, state: "delivered" }]),
		);
		await store.critical(PID, (tx) =>
			tx.append([{ ev: "reply_ref", msg_id: M1, agent_id: A, attribution: "exact" }]),
		);
		const r = await api.message(PID, M1);
		expect(r.status).toBe(200);
		const b = r.body as {
			deliveries: Array<{ agentId: string; state: string; events: unknown[] }>;
			replies: Array<{ ref: LogLine | null }>;
		};
		expect(b.deliveries).toMatchObject([{ agentId: A, state: "delivered" }]);
		expect(b.deliveries[0]?.events).toHaveLength(2);
		expect(b.replies[0]?.ref?.attribution).toBe("exact");
		expect((await api.message(PID, "22222222-2222-4222-8222-222222222222")).status).toBe(404);
	});
});

describe("POST …/acks (T25)", () => {
	it("idempotent by clientAckId, conflict on another body, 404 on an unknown message, nothing sent", async () => {
		await seed(0);
		const id = crypto.randomUUID();
		const body = { clientAckId: id, target: { msgId: M1, agentId: A } };
		const a = await api.ack("owner", PID, body);
		expect(a).toMatchObject({ status: 201, body: { replayed: false } });
		expect(await api.ack("owner", PID, body)).toMatchObject({
			status: 200,
			body: { replayed: true },
		});
		expect(await api.ack("owner", PID, { clientAckId: id, target: { msgId: M1 } })).toMatchObject({
			status: 409,
		});
		expect(
			await api.ack("owner", PID, {
				clientAckId: crypto.randomUUID(),
				target: { msgId: "22222222-2222-4222-8222-222222222222" },
			}),
		).toMatchObject({ status: 404 });
		const acks = (await store.view(PID)).lines.filter((l) => l.ev === "owner_ack");
		expect(acks).toHaveLength(1);
		expect(acks[0]).toMatchObject({ by: "owner", target: { msg_id: M1, agent_id: A } });
	});
});

describe("WS /ws/project/<pid>", () => {
	it("snapshot after the cursor, then live; each event once, in order", async () => {
		await seed(5);
		const hub = new ProjectWsHub(store);
		const server = http.createServer();
		const wss = new WebSocketServer({ server });
		wss.on("connection", (ws) => hub.serve(ws, PID));
		await new Promise<void>((r) => server.listen(0, r));
		const port = (server.address() as { port: number }).port;
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		const got: number[] = [];
		ws.on("message", (raw) => {
			const f = JSON.parse(String(raw)) as { type: string; event?: LogLine };
			if (f.type === "event" && f.event) got.push(f.event.seq);
		});
		await new Promise<void>((r) => ws.on("open", () => r()));
		ws.send(JSON.stringify({ type: "subscribe", after: 3 }));
		// writes racing the snapshot
		await store.critical(PID, (tx) => tx.append([{ ev: "noise" }]));
		await new Promise((r) => setTimeout(r, 50));
		await store.critical(PID, (tx) => tx.append([{ ev: "noise" }, { ev: "noise" }]));
		await new Promise((r) => setTimeout(r, 50));
		expect(got).toEqual([4, 5, 6, 7, 8, 9]);
		ws.close();
		wss.close();
		await new Promise<void>((r) => server.close(() => r()));
	});
});
