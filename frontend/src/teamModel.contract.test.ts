import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detailLines } from "./teamLog.js";
import { buildThreads, forYou, ProjectLog, parseLogEvent } from "./teamModel.js";

/**
 * The frontend model against REAL answers of the D1-b backend (#590,
 * 3332651): the fixture was produced by running its own ProjectFanout,
 * ReplyWatcher and ProjectConversationApi (fake Composer + capture), not
 * written by hand. Scenario: a task to A (delivered, replies "Done one.")
 * and B (refused busy); a follow-up to B quoting A's reply (refused again);
 * a Done on B's first refusal. Regenerate when Appendix A changes.
 */
const fx = JSON.parse(
	// vitest runs from frontend/ (the jsdom environment has no file: import.meta.url).
	readFileSync(join(process.cwd(), "src/__fixtures__/project-conversation-590.json"), "utf8"),
);
const A = "a0000000-0000-4000-8000-00000000000a";
const B = "b0000000-0000-4000-8000-00000000000b";
const m1: string = fx.post1.body.msgId;
const m2: string = fx.post2.body.msgId;

describe("contract: #590's own answers", () => {
	it("every line of the log parses (none dropped)", () => {
		const raw: unknown[] = fx.page.body.events;
		const parsed = raw.map(parseLogEvent);
		expect(parsed.every((e) => e !== null)).toBe(true);
		expect(parsed.map((e) => e!.ev)).toContain("reply_settling");
		expect(parsed.map((e) => e!.ev)).toContain("owner_ack");
		expect(parsed.every((e) => e!.ts !== "")).toBe(true); // `at`
	});

	it("For you: A's reply stays (the quoting send was refused); only the acked refusal goes", () => {
		const log = new ProjectLog();
		log.add(fx.page.body.events.map(parseLogEvent));
		const items = forYou(log).map((i) => [i.kind, i.msgId, i.agentId]);
		expect(items).toEqual(
			expect.arrayContaining([
				["replied", m1, A],
				["not-delivered", m2, B],
			]),
		);
		expect(items).not.toContainEqual(["not-delivered", m1, B]); // owner_ack{m1, B}
		expect(items).toHaveLength(2);
		// One thread: the follow-up joins its original through in_reply_to.
		expect(buildThreads(log).map((t) => [t.rootId, t.messageIds])).toEqual([[m1, [m1, m2]]]);
	});

	it("a page mid-settle shows the settling reply and no For you reply", () => {
		const log = new ProjectLog();
		log.add(fx.midPage.body.events.map(parseLogEvent));
		expect(log.messages.get(m1)!.settling.has(A)).toBe(true);
		expect(forYou(log).filter((i) => i.kind === "replied")).toEqual([]);
	});

	it("paging: `oldestSeq` is the next cursor and pages are ascending", () => {
		const small = fx.small.body;
		expect(small.events.map((e: { seq: number }) => e.seq)).toEqual([12, 13, 14]);
		expect(small.oldestSeq).toBe(12);
		expect(small.hasMore).toBe(true);
	});

	it("GET …/messages/:msgId folds to the same state as the log", () => {
		const byId = new ProjectLog();
		byId.addFetched(
			detailLines(fx.msg.body)
				.map(parseLogEvent)
				.filter((e) => e !== null),
		);
		const m = byId.messages.get(m1)!;
		expect(m.deliveries.get(A)?.state).toBe("delivered");
		expect(m.deliveries.get(B)?.state).toBe("refused");
		expect(m.replies.get(A)?.[0]?.ref.attribution).toBe("exact");
		expect(byId.acks).toHaveLength(1);
	});

	it("the capture's turn_end hashes to the reply_ref's report_sha256", () => {
		const ref = fx.page.body.events.find((e: { ev: string }) => e.ev === "reply_ref");
		const text: string = fx.captureTurnEnd.data.last_assistant_message;
		expect(createHash("sha256").update(text, "utf8").digest("hex")).toBe(ref.report_sha256);
		expect(ref.turn_end_seq).toBe(fx.captureTurnEnd.seq);
	});

	it("POST answers: deliveries per agent with reason, and acks", () => {
		expect(fx.post1.body).toMatchObject({ replayed: false });
		expect(fx.post1.body.deliveries).toEqual([
			expect.objectContaining({ agentId: A, state: "delivered" }),
			expect.objectContaining({ agentId: B, state: "refused", reason: "busy" }),
		]);
		expect(fx.ack).toMatchObject({ status: 201, body: { replayed: false } });
		expect(typeof fx.ack.body.ackId).toBe("string");
	});
});
