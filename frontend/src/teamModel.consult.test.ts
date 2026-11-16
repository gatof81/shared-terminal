import { describe, expect, it } from "vitest";
import {
	collabToSend,
	deliveryText,
	deliveryTone,
	grantActionErrorText,
	grantActions,
	grantEventText,
	grantStateText,
	grantsOfTask,
	grantView,
	type LogEvent,
	outboxText,
	ProjectLog,
	parseLogEvent,
	postErrorText,
	threadRootOf,
} from "./teamModel.js";

// D3 (PROJECT_CONVERSATION.md §7): a consult permission, its relays and its
// outbox as the project log writes them (shapes from the backend's
// collab.ts / fanout.ts / grantRules.ts at b1a538f).

const A = "agent-a";
const B = "agent-b";
const G = "c-0123456789ab";
const at = (seq: number) => `2026-11-16T16:${String(seq).padStart(2, "0")}:00.000Z`;

const task = {
	seq: 1,
	at: at(1),
	ev: "message",
	msg_id: "task",
	client_message_id: "cm-1",
	by: "u1",
	kind: "owner",
	to: [A],
	text: "Ask the other agent",
	relay: null,
	collab: { grant_id: G },
};
const created = {
	seq: 3,
	at: at(3),
	ev: "grant",
	grant_id: G,
	event: "created",
	mode: "ask",
	task_msg_id: "task",
	initiator: A,
	with: B,
	participants: [
		{ agent_id: A, binding_id: "b-a", epoch: 1, sid: "s-a" },
		{ agent_id: B, binding_id: "b-b", epoch: 1, sid: "s-b" },
	],
	max_messages: 2,
	max_wait_min: 60,
	expires_at: "2026-11-16T18:03:00.000Z",
	by: "u1",
};
const relay = (seq: number, id: string, from: string, to: string[], n: number, kind: string) => ({
	seq,
	at: at(seq),
	ev: "message",
	msg_id: id,
	client_message_id: null,
	by: "u1",
	kind: "relay",
	from,
	to,
	text: `text of ${id}`,
	in_reply_to: null,
	relay: { grant_id: G, n, kind, file_sha256: "f".repeat(64) },
});
const delivery = (seq: number, id: string, agent: string, state: string, reason?: string) => ({
	seq,
	at: at(seq),
	ev: "delivery",
	msg_id: id,
	agent_id: agent,
	state,
	...(reason ? { reason } : {}),
	authorized_by: `collab:${G}`,
});
const grant = (seq: number, event: string, extra: Record<string, unknown> = {}) => ({
	seq,
	at: at(seq),
	ev: "grant",
	grant_id: G,
	event,
	...extra,
});
const outbox = (seq: number, event: string, extra: Record<string, unknown> = {}) => ({
	seq,
	at: at(seq),
	ev: "outbox",
	grant_id: G,
	event,
	from: { agent_id: A, binding_id: "b-a", epoch: 1, sid: "s-a", cid: "c-a" },
	path: ".st-outbox/x.md",
	origin: "match",
	...extra,
});

function fold(raw: unknown[]): ProjectLog {
	const log = new ProjectLog();
	log.add(raw.map(parseLogEvent).filter((e): e is LogEvent => e !== null));
	return log;
}

describe("parsing the D3 lines", () => {
	it("reads a relay's author, kind and number, and the task's grant", () => {
		const t = parseLogEvent(task);
		expect(t).toMatchObject({ ev: "message", kind: "owner", collabGrantId: G, from: null });
		const r = parseLogEvent(relay(5, "r1", A, [B], 1, "ask"));
		expect(r).toMatchObject({
			kind: "relay",
			from: A,
			to: [B],
			grantId: G,
			relayKind: "ask",
			relayN: 1,
			text: "text of r1",
		});
		// An owner / done relay is addressed to nobody: `to` is empty and it still parses.
		expect(parseLogEvent(relay(6, "r2", A, [], 0, "owner"))).toMatchObject({
			to: [],
			relayKind: "owner",
			relayN: 0,
		});
		expect(parseLogEvent(relay(7, "r3", A, [B], 1, "shout"))).toMatchObject({ relayKind: null });
	});

	it("reads every grant event with its cause, and skips an event it doesn't know", () => {
		expect(parseLogEvent(created)).toMatchObject({
			event: "created",
			taskMsgId: "task",
			initiator: A,
			with: B,
			maxMessages: 2,
			expiresAt: "2026-11-16T18:03:00.000Z",
			by: "u1",
		});
		expect(
			parseLogEvent(
				grant(9, "paused", {
					reason: "write-observed",
					by: "system",
					detail: { tool: "Edit", cid: "c" },
				}),
			),
		).toMatchObject({
			event: "paused",
			reason: "write-observed",
			by: "system",
			detailTool: "Edit",
		});
		expect(parseLogEvent(grant(9, "resumed", { by: "evidence" }))).toMatchObject({
			event: "resumed",
			by: "evidence",
		});
		expect(parseLogEvent(grant(9, "renewed"))).toBeNull();
	});

	it("reads outbox lines; an unknown event is skipped", () => {
		expect(
			parseLogEvent(outbox(8, "rejected", { reason: "grant-paused", kind: "ask" })),
		).toMatchObject({
			ev: "outbox",
			event: "rejected",
			fromAgentId: A,
			reason: "grant-paused",
			kind: "ask",
			path: ".st-outbox/x.md",
		});
		expect(parseLogEvent(outbox(8, "accepted", { kind: "ask", msg_id: "r1" }))).toMatchObject({
			event: "accepted",
			msgId: "r1",
		});
		expect(parseLogEvent(outbox(8, "seen"))).toBeNull();
	});

	it("`queued` is a delivery state (it was skipped before D3)", () => {
		expect(parseLogEvent(delivery(6, "r1", B, "queued"))).toMatchObject({ state: "queued" });
		expect(deliveryTone("queued")).toBe("pending");
		expect(deliveryText({ state: "queued", reason: null, filesPossiblyPlaced: false })).toBe(
			"Queued: waiting for it to be free",
		);
	});
});

describe("the grant's state is the log's, in whatever order the pages arrive", () => {
	const lines = [
		task,
		delivery(2, "task", A, "delivered"),
		created,
		outbox(4, "accepted", { kind: "ask", msg_id: "r1" }),
		relay(5, "r1", A, [B], 1, "ask"),
		delivery(6, "r1", B, "queued"),
		grant(7, "paused", { reason: "owner", by: "u1" }),
		grant(8, "resumed", { by: "u1" }),
		delivery(9, "r1", B, "planned"),
		delivery(10, "r1", B, "sending"),
		delivery(11, "r1", B, "delivered"),
		outbox(12, "accepted", { kind: "reply", msg_id: "r2", from: { agent_id: B } }),
		relay(13, "r2", B, [A], 2, "reply"),
		delivery(14, "r2", A, "queued"),
		delivery(15, "r2", A, "delivered"),
		grant(16, "ended", { reason: "budget", by: "system" }),
	];

	it("folds to ended{budget}, 2 of 2 used, both relays delivered", () => {
		const log = fold(lines);
		const g = grantView(log, G)!;
		expect(g).toMatchObject({ state: "ended", reason: "budget", used: 2, by: "system" });
		expect(g.created?.maxMessages).toBe(2);
		expect(grantStateText(g)).toBe("Ended: all its messages were used");
		expect(log.messages.get("r1")?.deliveries.get(B)?.state).toBe("delivered");
		expect(log.messages.get("r2")?.deliveries.get(A)?.state).toBe("delivered");
		expect(grantsOfTask(log, "task").map((x) => x.grantId)).toEqual([G]);
		// A relay belongs to the thread of its grant's task.
		expect(threadRootOf(log, "r2")).toBe("task");
	});

	it("gives the same state for every arrival order, one event at a time", () => {
		const parsed = lines.map(parseLogEvent).filter((e): e is LogEvent => e !== null);
		const want = JSON.stringify(grantView(fold(lines), G));
		const orders = [
			[...parsed].reverse(),
			[...parsed].sort((a, b) => (a.seq % 3) - (b.seq % 3) || b.seq - a.seq),
			[...parsed.slice(8), ...parsed.slice(0, 8)],
		];
		for (const order of orders) {
			const log = new ProjectLog();
			for (const e of order) log.add([e]);
			expect(JSON.stringify(grantView(log, G))).toBe(want);
			// Folding everything again changes nothing.
			log.add(order);
			expect(JSON.stringify(grantView(log, G))).toBe(want);
			expect(log.grantEvents.get(G)?.map((e) => e.seq)).toEqual([3, 7, 8, 16]);
		}
	});

	it("a queued relay reads as waiting, then as delivered", () => {
		const log = fold(lines.slice(0, 6));
		const d = log.messages.get("r1")!.deliveries.get(B)!;
		expect(d.state).toBe("queued");
		expect(grantView(log, G)).toMatchObject({ state: "live", used: 1 });
		log.add(lines.slice(6, 11).map(parseLogEvent) as LogEvent[]);
		expect(log.messages.get("r1")!.deliveries.get(B)!.state).toBe("delivered");
	});

	it("an ended grant never changes again, whatever a later line says (§7.5)", () => {
		const log = fold([
			task,
			created,
			grant(5, "revoked", { by: "u1" }),
			grant(6, "paused", { reason: "needs-owner", by: "system" }),
			grant(7, "resumed", { by: "u1" }),
		]);
		expect(grantView(log, G)).toMatchObject({ state: "ended", reason: "revoked", seq: 5 });
		expect(grantStateText(grantView(log, G)!)).toBe("Ended: you stopped it");
		expect(grantActions("ended")).toEqual([]);
	});

	it("a pause keeps its cause until it is lifted; a later pause replaces it", () => {
		const log = fold([
			task,
			created,
			grant(5, "paused", { reason: "delivery-uncertain", by: "system" }),
			grant(6, "paused", { reason: "owner", by: "u1" }),
		]);
		expect(grantView(log, G)).toMatchObject({ state: "paused", reason: "owner", by: "u1" });
		log.add([parseLogEvent(grant(7, "resumed", { by: "u1" }))!]);
		expect(grantView(log, G)).toMatchObject({ state: "live", reason: null });
	});

	it("`used` is the highest relay number loaded: a partial window doesn't undercount", () => {
		// Only the newest page is loaded: relay 3 of 4, without relays 1 and 2.
		const log = fold([
			relay(40, "r3", A, [B], 3, "ask"),
			delivery(41, "r3", B, "queued"),
			grant(42, "paused", { reason: "owner", by: "u1" }),
		]);
		expect(grantView(log, G)).toMatchObject({ created: null, state: "paused", used: 3 });
		// The older page arrives: still 3, never 3 + what was added.
		log.add(
			[task, created, relay(5, "r1", A, [B], 1, "ask"), relay(13, "r2", B, [A], 2, "reply")].map(
				(l) => parseLogEvent(l)!,
			),
		);
		expect(grantView(log, G)).toMatchObject({ used: 3 });
		expect(grantView(log, G)?.created?.maxMessages).toBe(2);
	});

	it("owner / done relays are not counted against the budget", () => {
		const log = fold([task, created, relay(5, "o1", A, [], 0, "owner")]);
		expect(grantView(log, G)?.used).toBe(0);
	});

	it("a grant whose `created` is outside the window still folds; unknown grant is null", () => {
		const log = fold([grant(9, "paused", { reason: "recovered", by: "system" })]);
		expect(grantView(log, G)).toMatchObject({
			created: null,
			state: "paused",
			reason: "recovered",
		});
		expect(grantView(log, "c-ffffffffffff")).toBeNull();
		expect(grantsOfTask(log, "task")).toEqual([]);
	});
});

describe("wording", () => {
	it("says why a consult paused or ended; an unknown code is shown as it is", () => {
		const p = (reason: string | null, detailTool: string | null = null) =>
			grantStateText({ state: "paused", reason, detailTool });
		expect(grantStateText({ state: "live", reason: null, detailTool: null })).toBe("Active");
		expect(p("needs-owner")).toBe("Paused: an agent asked for you");
		expect(p("write-observed", "Edit")).toBe(
			"Paused: the consulted agent started changing files (Edit)",
		);
		expect(p("too-many-rejections")).toBe(
			"Paused: an agent wrote three messages the server couldn't accept",
		);
		expect(p("recovered")).toBe("Paused: the server restarted during a delivery");
		expect(p("delivery-refused")).toBe("Paused: the agent couldn't take a message");
		expect(p("something-new")).toBe("Paused: something-new");
		expect(p(null)).toBe("Paused: no cause recorded");
		for (const [code, words] of [
			["done", "an agent said it was done"],
			["expired", "its time ran out"],
			["wait-expired", "an agent stayed busy for too long"],
			["binding-changed", "an agent's session changed"],
			["task-not-delivered", "the task never reached the agent"],
		])
			expect(grantStateText({ state: "ended", reason: code!, detailTool: null })).toBe(
				`Ended: ${words}`,
			);
	});

	it("names each event of a consult's history", () => {
		const e = (event: string, extra: Record<string, unknown> = {}) =>
			grantEventText(parseLogEvent(grant(9, event, extra)) as never);
		expect(e("paused", { reason: "needs-owner", by: "system" })).toBe(
			"Consult paused: an agent asked for you",
		);
		expect(e("paused", { reason: "owner", by: "u1" })).toBe("Consult paused: you paused it");
		expect(e("resumed", { by: "evidence" })).toBe(
			"Consult resumed: the message was confirmed as delivered",
		);
		expect(e("resumed", { by: "u1" })).toBe("You resumed the consult");
		expect(e("revoked", { by: "u1" })).toBe("You stopped the consult");
		expect(e("ended", { reason: "budget", by: "system" })).toBe(
			"Consult ended: all its messages were used",
		);
	});

	it("explains a file the server would not pass on", () => {
		expect(outboxText({ event: "rejected", reason: "grant-paused" }, "@a")).toBe(
			"A message from @a was not passed on: the consult was paused.",
		);
		expect(outboxText({ event: "rejected", reason: "header-invalid" }, "@a")).toBe(
			"A message from @a was not passed on: its header wasn't the exact one the task gave.",
		);
		expect(outboxText({ event: "rejected", reason: "text-too-long" }, "@a")).toBe(
			"A message from @a was not passed on: its text can't be typed into a Claude session.",
		);
		expect(outboxText({ event: "rejected", reason: "odd" }, "@a")).toBe(
			"A message from @a was not passed on: odd.",
		);
		expect(outboxText({ event: "unverified", reason: null }, "@a")).toBe(
			"A message file from @a couldn't be verified as written by its own session. It was not passed on.",
		);
	});

	it("the new not-sent causes of a relay", () => {
		const t = (reason: string) =>
			deliveryText({ state: "not-sent", reason, filesPossiblyPlaced: false });
		expect(t("grant-paused")).toBe("Not delivered: the consult was paused");
		expect(t("wait-expired")).toBe("Not delivered: it stayed busy for too long");
		expect(t("grant-inactive")).toBe("Not delivered: the handoffs had stopped");
	});

	it("explains each refusal of a task with a consult; the old codes read as before", () => {
		expect(postErrorText("relay-off", 409)).toBe(
			"Consults between agents are turned off on this server. Nothing was sent.",
		);
		expect(postErrorText("agent-in-collab", 409, G)).toMatch(/already in a consult/);
		expect(postErrorText("collab-unavailable", 409, "no-binding")).toBe(
			"The consult can't be set up: the agent to consult has no session bound. Nothing was sent.",
		);
		expect(postErrorText("collab-unavailable", 409, "same-session")).toMatch(
			/both agents run in the same session/,
		);
		expect(postErrorText("collab-unavailable", 409, "agent-removed")).toMatch(/was removed/);
		expect(postErrorText("collab-unavailable", 409)).toMatch(/can't consult each other right now/);
		expect(postErrorText("invalid-body", 400, "collab.maxMessages")).toBe(
			"The server rejected the consult settings (collab.maxMessages). Nothing was sent.",
		);
		expect(postErrorText("invalid-body", 400)).toBe(
			"The server rejected the message. Nothing was sent.",
		);
		expect(postErrorText("invalid-body", 400, "unknown msgId reference")).toBe(
			"The server rejected the message. Nothing was sent.",
		);
		expect(grantActionErrorText("grant-ended", 409)).toBe("This consult has already ended.");
		expect(grantActionErrorText("network", 0)).toMatch(/No answer from the server/);
		expect(grantActionErrorText("", 500)).toBe("The server couldn't do that (500).");
	});
});

describe("collabToSend", () => {
	it("no choice ⇒ no collab; a valid choice ⇒ exactly the wire object", () => {
		expect(collabToSend([A], null)).toEqual({ collab: null });
		expect(collabToSend([A], { with: B, maxMessages: 4 })).toEqual({
			collab: { mode: "ask", with: B, maxMessages: 4 },
		});
	});

	it("needs one recipient, another agent, and 2–6 messages", () => {
		expect(collabToSend([A, B], { with: B, maxMessages: 2 })).toEqual({
			error: "A consult needs exactly one recipient.",
		});
		expect(collabToSend([A], { with: "", maxMessages: 2 })).toEqual({
			error: "Choose which agent it may consult.",
		});
		expect(collabToSend([A], { with: A, maxMessages: 2 })).toEqual({
			error: "An agent can't consult itself.",
		});
		for (const n of [1, 7, 2.5, Number.NaN])
			expect(collabToSend([A], { with: B, maxMessages: n })).toEqual({
				error: "A consult allows 2 to 6 messages.",
			});
		expect(grantActions("live")).toEqual(["pause", "revoke"]);
		expect(grantActions("paused")).toEqual(["resume", "revoke"]);
	});
});
