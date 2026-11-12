import { describe, expect, it } from "vitest";
import { detailLines } from "./teamLog.js";
import {
	ackTargetOf,
	buildThreads,
	deliveryText,
	deliveryTone,
	forYou,
	type LogEvent,
	mentionAt,
	ProjectLog,
	parseLogEvent,
	recipientsToSend,
	threadRootOf,
	threadTitle,
	unrootedMessages,
} from "./teamModel.js";

// ── Builders (wire shape, §2.2) ─────────────────────────────────────────────

let n = 0;
function msg(
	seq: number,
	msgId: string,
	to: string[],
	text: string,
	extra: Record<string, unknown> = {},
): unknown {
	return {
		seq,
		at: `2026-11-11T12:${String(seq).padStart(2, "0")}:00Z`,
		ev: "message",
		msg_id: msgId,
		client_message_id: `c-${++n}`,
		kind: "owner",
		to,
		text,
		...extra,
	};
}
function del(
	seq: number,
	msgId: string,
	agentId: string,
	state: string,
	extra: Record<string, unknown> = {},
): unknown {
	return { seq, at: "t", ev: "delivery", msg_id: msgId, agent_id: agentId, state, ...extra };
}
function reply(
	seq: number,
	msgId: string,
	agentId: string,
	promptId: string,
	attribution = "exact",
): unknown {
	return {
		seq,
		at: "t",
		ev: "reply_ref",
		msg_id: msgId,
		agent_id: agentId,
		sid: `s-${agentId}`,
		cid: `c-${agentId}`,
		prompt_id: promptId,
		turn_end_seq: 40 + seq,
		report_sha256: "ab".repeat(32),
		report_bytes: 10,
		truncated: false,
		attribution,
	};
}
function parsed(raws: unknown[]): LogEvent[] {
	return raws.map((r) => {
		const e = parseLogEvent(r);
		if (!e) throw new Error(`unparsed ${JSON.stringify(r)}`);
		return e;
	});
}
function logOf(raws: unknown[]): ProjectLog {
	const log = new ProjectLog();
	log.add(parsed(raws));
	return log;
}

// ── Parsing ─────────────────────────────────────────────────────────────────

describe("parseLogEvent", () => {
	it("reads the §2.2 fields and skips what this UI doesn't render", () => {
		const m = parseLogEvent(msg(1, "m1", ["a"], "hi", { in_reply_to: "m0" }));
		expect(m).toMatchObject({
			ev: "message",
			msgId: "m1",
			to: ["a"],
			inReplyTo: "m0",
			kind: "owner",
		});
		expect(parseLogEvent({ seq: 2, ev: "artifact", sha256: "x" })).toBeNull();
		expect(parseLogEvent({ seq: 3, ev: "recovery" })).toBeNull();
	});

	it("refuses malformed lines instead of guessing", () => {
		expect(parseLogEvent(null)).toBeNull();
		expect(parseLogEvent({ ev: "message", msg_id: "m" })).toBeNull(); // no seq
		expect(parseLogEvent({ seq: -1, ev: "message" })).toBeNull();
		expect(parseLogEvent(del(4, "m1", "a", "teleported"))).toBeNull();
		expect(parseLogEvent(reply(5, "m1", "a", "p", "probably"))).toBeNull();
		expect(parseLogEvent(msg(6, "m1", ["a"], "x", { kind: "bot" }))).toBeNull();
	});

	it("reads a quote_ref only when it names one exact reply", () => {
		const q = { msg_id: "m1", agent_id: "a", prompt_id: "p", report_sha256: "ff" };
		expect(parseLogEvent(msg(1, "m2", ["a"], "x", { quote_ref: q }))).toMatchObject({
			quoteRef: { msgId: "m1", agentId: "a", promptId: "p", reportSha256: "ff" },
		});
		expect(parseLogEvent(msg(1, "m2", ["a"], "x", { quote_ref: { msg_id: "m1" } }))).toMatchObject({
			quoteRef: null,
		});
	});
});

// ── Delivery state ──────────────────────────────────────────────────────────

describe("deliveries", () => {
	it("follows the state machine and never moves a terminal state", () => {
		const log = logOf([
			msg(1, "m1", ["a"], "task"),
			del(2, "m1", "a", "planned"),
			del(3, "m1", "a", "sending"),
			del(4, "m1", "a", "delivered"),
			del(5, "m1", "a", "failed"), // impossible after a terminal: ignored
		]);
		expect(log.messages.get("m1")?.deliveries.get("a")?.state).toBe("delivered");
	});

	it("lets a later `settled` resolve an `uncertain` (and nothing else)", () => {
		const log = logOf([
			msg(1, "m1", ["a", "b"], "task"),
			del(2, "m1", "a", "uncertain", { reason: "orphaned" }),
			del(3, "m1", "b", "delivered"),
			del(4, "m1", "a", "settled", { result: "delivered" }),
			del(5, "m1", "b", "settled", { result: "failed" }),
		]);
		const ds = log.messages.get("m1")!.deliveries;
		expect(ds.get("a")).toMatchObject({ state: "delivered", settled: true });
		expect(ds.get("b")).toMatchObject({ state: "delivered", settled: false });
	});

	it("applies in seq order whatever order the pages arrive in", () => {
		const log = new ProjectLog();
		log.add(parsed([del(4, "m1", "a", "delivered")])); // newer page first, message unknown
		expect(log.messages.size).toBe(0);
		log.add(
			parsed([
				msg(1, "m1", ["a"], "task"),
				del(2, "m1", "a", "planned"),
				del(3, "m1", "a", "sending"),
			]),
		);
		expect(log.messages.get("m1")?.deliveries.get("a")?.state).toBe("delivered");
	});

	it("is idempotent", () => {
		const raws = [
			msg(1, "m1", ["a"], "task"),
			del(2, "m1", "a", "delivered"),
			reply(3, "m1", "a", "p1"),
		];
		const log = logOf(raws);
		log.add(parsed(raws));
		expect(log.messages.get("m1")?.replies.get("a")).toHaveLength(1);
	});

	it("separates safe-to-resend from look-first", () => {
		expect(deliveryTone("refused")).toBe("not-delivered");
		expect(deliveryTone("not-sent")).toBe("not-delivered");
		for (const s of ["unconfirmed", "misdelivered", "uncertain", "failed"] as const)
			expect(deliveryTone(s)).toBe("unsure");
		expect(deliveryTone("sending")).toBe("pending");
		expect(deliveryText({ state: "refused", reason: "busy", filesPossiblyPlaced: false })).toBe(
			"Not delivered: it was busy",
		);
		expect(
			deliveryText({ state: "not-sent", reason: "artifact-failed", filesPossiblyPlaced: true }),
		).toMatch(/files may already be in its inbox/);
		// A server reason named like an Object.prototype key must miss.
		expect(
			deliveryText({ state: "refused", reason: "constructor", filesPossiblyPlaced: false }),
		).toBe("Not delivered: it couldn't take it");
	});
});

// ── Threads ─────────────────────────────────────────────────────────────────

describe("threads", () => {
	it("groups concurrent tasks by their root, newest activity first", () => {
		const log = logOf([
			msg(1, "t1", ["dev"], "Adaptive polling\nmore"),
			msg(2, "t2", ["docs"], "Release notes"),
			msg(3, "t3", ["infra"], "Backup check"),
			del(4, "t1", "dev", "delivered"),
			msg(5, "r1", ["dev"], "follow-up", { in_reply_to: "t1" }),
			del(6, "t2", "docs", "refused", { reason: "busy" }),
			reply(7, "t3", "infra", "p3"),
		]);
		const ts = buildThreads(log);
		expect(ts.map((t) => t.rootId)).toEqual(["t3", "t2", "t1"]);
		expect(ts[2]).toMatchObject({
			title: "Adaptive polling",
			messageIds: ["t1", "r1"],
			agents: ["dev"],
		});
		expect(threadRootOf(log, "r1")).toBe("t1");
	});

	it("never places a late reply under the wrong thread: unrooted until its original is fetched", () => {
		// The window holds only recent events: a follow-up and a late reply whose
		// original task (m-old) is older than the window.
		const log = logOf([
			msg(50, "f1", ["qa"], "follow-up", { in_reply_to: "m-old" }),
			reply(51, "m-old", "dev", "p9"),
			msg(52, "t9", ["qa"], "unrelated task"),
		]);
		expect(buildThreads(log).map((t) => t.rootId)).toEqual(["t9"]);
		expect(unrootedMessages(log)).toEqual(["f1"]);
		expect(log.missingMessages().sort()).toEqual(["m-old"]);
		// Fetched by id: the reply attaches to its original, the follow-up joins it.
		log.addFetched(
			parsed([msg(10, "m-old", ["dev"], "Old task"), del(11, "m-old", "dev", "delivered")]),
		);
		const ts = buildThreads(log);
		const old = ts.find((t) => t.rootId === "m-old")!;
		expect(old.messageIds).toEqual(["m-old", "f1"]);
		expect(log.messages.get("m-old")!.replies.get("dev")).toHaveLength(1);
		expect(unrootedMessages(log)).toEqual([]);
	});

	it("a message fetched by id never moves the window's bounds (paging continues from the window)", () => {
		const log = logOf([
			msg(50, "f1", ["qa"], "follow-up", { in_reply_to: "m-old" }),
			del(51, "f1", "qa", "delivered"),
		]);
		log.addFetched(parsed([msg(3, "m-old", ["dev"], "Old task")]));
		expect(log.oldestSeq).toBe(50);
		expect(log.newestSeq).toBe(51);
		// An event already folded by id and then met again in a page still bounds the window.
		log.add(parsed([msg(3, "m-old", ["dev"], "Old task")]));
		expect(log.oldestSeq).toBe(3);
	});

	it("puts a relay under its grant's task thread", () => {
		const log = logOf([
			msg(1, "t1", ["dev"], "task"),
			{ seq: 2, at: "t", ev: "grant", grant_id: "g1", event: "created", task_msg_id: "t1" },
			msg(3, "rl1", ["qa"], "From @dev…", { kind: "relay", relay: { grant_id: "g1", round: 1 } }),
		]);
		expect(threadRootOf(log, "rl1")).toBe("t1");
	});

	it("titles a thread by its first non-empty line, bounded", () => {
		expect(threadTitle("\n  Fix CI  \nbody")).toBe("Fix CI");
		expect(threadTitle("")).toBe("(empty message)");
		expect(threadTitle("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
	});
});

// ── For you ─────────────────────────────────────────────────────────────────

describe("For you", () => {
	const base = [
		msg(1, "t1", ["dev", "qa"], "task"),
		del(2, "t1", "dev", "delivered"),
		del(3, "t1", "qa", "delivered"),
		reply(4, "t1", "dev", "pd"),
		reply(5, "t1", "qa", "pq"),
	];

	it("lists each reply separately", () => {
		const items = forYou(logOf(base));
		expect(items.map((i) => [i.kind, i.agentId])).toEqual([
			["replied", "qa"],
			["replied", "dev"],
		]);
	});

	const qDev = { msg_id: "t1", agent_id: "dev", prompt_id: "pd", report_sha256: "ab".repeat(32) };
	const quoting = (deliveries: unknown[], to = ["dev"]) =>
		forYou(
			logOf([
				...base,
				msg(6, "r1", to, "thanks", { in_reply_to: "t1", quote_ref: qDev }),
				...deliveries,
			]),
		)
			.filter((i) => i.kind === "replied")
			.map((i) => i.agentId);

	it("a delivered quote closes only the reply it quotes, never its sibling (two recipients, one message)", () => {
		expect(quoting([del(7, "r1", "dev", "delivered")])).toEqual(["qa"]);
	});

	it("a quote that didn't reach the agent closes nothing: refused, not sent, unsure, still sending", () => {
		for (const d of [
			del(7, "r1", "dev", "refused", { reason: "busy" }),
			del(7, "r1", "dev", "not-sent", { reason: "binding-changed" }),
			del(7, "r1", "dev", "uncertain"),
			del(7, "r1", "dev", "unconfirmed"),
			del(7, "r1", "dev", "failed"),
			del(7, "r1", "dev", "sending"),
		])
			expect(quoting([d]), JSON.stringify(d)).toEqual(["qa", "dev"]);
		// No delivery recorded yet at all.
		expect(quoting([])).toEqual(["qa", "dev"]);
	});

	it("an uncertain quote that is later settled as delivered closes it", () => {
		expect(
			quoting([
				del(7, "r1", "dev", "uncertain"),
				del(8, "r1", "dev", "settled", { result: "delivered" }),
			]),
		).toEqual(["qa"]);
	});

	it("a quote delivered to someone else doesn't close the quoted agent's reply", () => {
		// Quoting dev's reply in a message that only qa received.
		expect(quoting([del(7, "r1", "qa", "delivered")], ["qa"])).toEqual(["qa", "dev"]);
		// Sent to both; dev refused, qa delivered: dev's reply stays, qa's too (not quoted).
		expect(
			quoting([del(7, "r1", "dev", "refused"), del(8, "r1", "qa", "delivered")], ["dev", "qa"]),
		).toEqual(["qa", "dev"]);
	});

	it("answering the thread without quoting closes nothing", () => {
		const items = forYou(logOf([...base, msg(6, "r1", ["dev"], "more", { in_reply_to: "t1" })]));
		expect(items.filter((i) => i.kind === "replied")).toHaveLength(2);
	});

	it("a not-delivered send clears only when a later send in the thread reaches that agent", () => {
		const raws = [
			msg(1, "t1", ["docs"], "notes"),
			del(2, "t1", "docs", "refused", { reason: "busy" }),
		];
		expect(forYou(logOf(raws)).map((i) => i.kind)).toEqual(["not-delivered"]);
		// Another thread reaching docs doesn't clear it.
		const other = [...raws, msg(3, "t2", ["docs"], "other"), del(4, "t2", "docs", "delivered")];
		expect(forYou(logOf(other)).map((i) => i.key)).toEqual(["not-delivered\nt1\ndocs"]);
		// A resend in the same thread that was itself refused doesn't either.
		const refusedAgain = [
			...raws,
			msg(3, "r1", ["docs"], "again", { in_reply_to: "t1" }),
			del(4, "r1", "docs", "refused"),
		];
		expect(
			forYou(logOf(refusedAgain))
				.map((i) => i.msgId)
				.sort(),
		).toEqual(["r1", "t1"]);
		// A delivered resend in the thread clears it.
		const ok = [
			...raws,
			msg(3, "r1", ["docs"], "again", { in_reply_to: "t1" }),
			del(4, "r1", "docs", "delivered"),
		];
		expect(forYou(logOf(ok))).toEqual([]);
	});

	it("an unsure delivery clears when the agent's reply to it arrives", () => {
		const raws = [msg(1, "t1", ["dev"], "x"), del(2, "t1", "dev", "unconfirmed")];
		expect(forYou(logOf(raws)).map((i) => i.kind)).toEqual(["unsure"]);
		const withReply = forYou(logOf([...raws, reply(3, "t1", "dev", "p")]));
		expect(withReply.map((i) => i.kind)).toEqual(["replied"]);
	});

	it("shows nothing for a send still on its way", () => {
		expect(forYou(logOf([msg(1, "t1", ["dev"], "x"), del(2, "t1", "dev", "sending")]))).toEqual([]);
	});

	it("leaves out items whose thread can't be placed yet", () => {
		expect(forYou(logOf([reply(9, "m-old", "dev", "p")]))).toEqual([]);
	});
});

// ── Compose ─────────────────────────────────────────────────────────────────

describe("compose", () => {
	it("sends the chosen recipients only, deduplicated, 1–8", () => {
		expect(recipientsToSend([])).toEqual({ error: "Choose who receives it." });
		expect(recipientsToSend(["a", "b", "a"])).toEqual({ to: ["a", "b"] });
		expect("error" in recipientsToSend(Array.from({ length: 9 }, (_, i) => `a${i}`))).toBe(true);
	});

	it("finds the @ being typed, only at a word start", () => {
		expect(mentionAt("ask @qa", 7)).toEqual({ start: 4, query: "qa" });
		expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
		expect(mentionAt("mail me@host", 12)).toBeNull();
		expect(mentionAt("ask @qa done", 12)).toBeNull();
	});
});

// ── Appendix A shapes: settling, ambiguity, owner_ack, by-id ────────────────

function settling(seq: number, msgId: string, agentId: string, promptId: string): unknown {
	const r = reply(seq, msgId, agentId, promptId) as Record<string, unknown>;
	const { attribution: _a, ...rest } = r;
	return { ...rest, ev: "reply_settling", settle_until: "2026-11-12T10:03:50.002Z" };
}
function ack(seq: number, msgId: string, agentId?: string, sha?: string): unknown {
	return {
		seq,
		at: "t",
		ev: "owner_ack",
		ack_id: `ack-${seq}`,
		client_ack_id: `cak-${seq}`,
		by: "u",
		target: {
			msg_id: msgId,
			...(agentId ? { agent_id: agentId } : {}),
			...(sha ? { report_sha256: sha } : {}),
		},
	};
}

describe("Appendix A", () => {
	it("reads `ambiguous{<reason>}` and keeps the reason; anything else is refused", () => {
		expect(parseLogEvent(reply(1, "m", "a", "p", "ambiguous{second-close}"))).toMatchObject({
			attribution: "ambiguous",
			attributionReason: "second-close",
		});
		expect(parseLogEvent(reply(1, "m", "a", "p", "ambiguous"))).toBeNull();
		expect(parseLogEvent(reply(1, "m", "a", "p", "ambiguous{x"))).toBeNull();
	});

	it("a settling reply is shown as confirming, is no For you item, and yields to its reply_ref", () => {
		const raws = [
			msg(1, "t1", ["dev"], "x"),
			del(2, "t1", "dev", "delivered"),
			settling(3, "t1", "dev", "pd"),
		];
		const log = logOf(raws);
		expect(log.messages.get("t1")!.settling.get("dev")).toMatchObject({ promptId: "pd" });
		expect(forYou(log)).toEqual([]);
		log.add(parsed([reply(4, "t1", "dev", "pd")]));
		expect(log.messages.get("t1")!.settling.size).toBe(0);
		expect(forYou(log).map((i) => i.kind)).toEqual(["replied"]);
	});

	it("Done (owner_ack) clears exactly the item it names, on any device that reads the log", () => {
		const raws = [
			msg(1, "t1", ["dev", "qa"], "task"),
			del(2, "t1", "dev", "delivered"),
			del(3, "t1", "qa", "refused", { reason: "busy" }),
			reply(4, "t1", "dev", "pd"),
		];
		const items = forYou(logOf(raws));
		const replied = items.find((i) => i.kind === "replied")!;
		const refused = items.find((i) => i.kind === "not-delivered")!;
		expect(ackTargetOf(replied)).toEqual({
			msgId: "t1",
			agentId: "dev",
			reportSha256: "ab".repeat(32),
		});
		expect(ackTargetOf(refused)).toEqual({ msgId: "t1", agentId: "qa" });
		// The reply's Done: the refusal stays.
		expect(
			forYou(logOf([...raws, ack(5, "t1", "dev", "ab".repeat(32))])).map((i) => i.kind),
		).toEqual(["not-delivered"]);
		// The refusal's Done: the reply stays.
		expect(forYou(logOf([...raws, ack(5, "t1", "qa")])).map((i) => i.kind)).toEqual(["replied"]);
		// A Done for dev without the hash (a delivery item) never clears dev's reply.
		expect(
			forYou(logOf([...raws, ack(5, "t1", "dev")]))
				.map((i) => i.kind)
				.sort(),
		).toEqual(["not-delivered", "replied"]);
		// A Done naming another reply's hash clears nothing.
		expect(forYou(logOf([...raws, ack(5, "t1", "dev", "cd".repeat(32))]))).toHaveLength(2);
		// A message-wide Done (no agent) clears nothing: items are per agent.
		expect(forYou(logOf([...raws, ack(5, "t1")]))).toHaveLength(2);
	});

	it("flattens GET …/messages/:msgId back into log lines", () => {
		const lines = detailLines({
			message: msg(10, "m-old", ["dev"], "Old task"),
			deliveries: [
				{
					agentId: "dev",
					state: "delivered",
					events: [del(11, "m-old", "dev", "planned"), del(12, "m-old", "dev", "delivered")],
				},
			],
			replies: [
				{
					agentId: "dev",
					settling: settling(13, "m-old", "dev", "p"),
					ref: reply(14, "m-old", "dev", "p"),
					lateCloses: [],
				},
			],
			acks: [ack(15, "m-old", "dev", "ab".repeat(32))],
		});
		const log = new ProjectLog();
		log.addFetched(parsed(lines));
		const m = log.messages.get("m-old")!;
		expect(m.deliveries.get("dev")?.state).toBe("delivered");
		expect(m.replies.get("dev")).toHaveLength(1);
		expect(m.settling.size).toBe(0);
		expect(forYou(log)).toEqual([]); // acked
	});
});
