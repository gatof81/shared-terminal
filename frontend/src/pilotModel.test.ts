import { describe, expect, it } from "vitest";
import type { ComposerSendResult, ConversationSummary } from "./api.js";
import type { ConversationEvent } from "./conversationModel.js";
import {
	correlated,
	forwardDraft,
	pickTarget,
	pilotFromLocation,
	replyOf,
	sendStateOf,
	settleFromEvent,
	unattributedCount,
} from "./pilotModel.js";

let seq = 0;
const ev = (
	e: string,
	promptId: string | null,
	data: Record<string, unknown> = {},
	at = seq + 1,
): ConversationEvent => {
	seq = at;
	return {
		seq: at,
		ts: new Date(Date.UTC(2026, 10, 10, 12, 0, at)).toISOString(),
		ev: e,
		prompt_id: promptId,
		turn_id: null,
		agent_id: null,
		pane: "%1",
		data,
	};
};
const answer = (p: string, text: string, id = `m-${p}`) =>
	ev("assistant_delta", p, { message_id: id, index: 0, delta: text, final: true });

const conv = (over: Partial<ConversationSummary>): ConversationSummary =>
	({
		sessionId: "c1",
		kind: "interactive",
		title: null,
		status: "waiting_input",
		statusEvidence: "probe:idle",
		statusAt: "2026-11-10T12:00:00Z",
		tabId: "tab-1",
		paneId: "%1",
		startedAt: "2026-11-10T11:00:00Z",
		endedAt: null,
		lastEventAt: "2026-11-10T12:00:00Z",
		lastSeq: 40,
		firstRetainedSeq: 1,
		eventsCount: 40,
		gapsCount: 0,
		claudeVersion: "2.1.314",
		canSendInput: true,
		...over,
	}) as ConversationSummary;

const res = (status: number, body: ComposerSendResult["body"]): ComposerSendResult => ({
	status,
	body,
});

describe("opt-in", () => {
	it("?pilot=1 / ?pilot=0 decide and are reported; otherwise the stored choice", () => {
		expect(pilotFromLocation("?pilot=1", null)).toEqual({ enabled: true, fromUrl: true });
		expect(pilotFromLocation("?pilot=0", "1")).toEqual({ enabled: false, fromUrl: true });
		expect(pilotFromLocation("", "1")).toEqual({ enabled: true, fromUrl: false });
		expect(pilotFromLocation("", null)).toEqual({ enabled: false, fromUrl: false });
		expect(pilotFromLocation("?pilot=yes", null)).toEqual({ enabled: false, fromUrl: false });
	});
});

describe("pickTarget — exactly one receiving conversation, never a guess", () => {
	it("the one live interactive conversation in a pane that can take input", () => {
		expect(pickTarget([conv({})])).toEqual({ kind: "ok", cid: "c1", lastSeq: 40 });
	});
	it("ignores ended, pane-less and non-interactive conversations", () => {
		expect(
			pickTarget([
				conv({ sessionId: "old", endedAt: "2026-11-10T10:00:00Z" }),
				conv({ sessionId: "bg", paneId: null }),
				conv({ sessionId: "h", kind: "headless" }),
				conv({ sessionId: "c1" }),
			]),
		).toEqual({ kind: "ok", cid: "c1", lastSeq: 40 });
	});
	it("two that could receive ⇒ ambiguous (the person chooses in Chat)", () => {
		expect(pickTarget([conv({ sessionId: "a" }), conv({ sessionId: "b" })])).toEqual({
			kind: "ambiguous",
			count: 2,
		});
	});
	it("none ⇒ a reason, including a blocked pane", () => {
		expect(pickTarget([])).toMatchObject({ kind: "none" });
		expect(
			pickTarget([
				conv({ canSendInput: false, composer: { blocked: true, reason: "in-progress" } }),
			]),
		).toEqual({ kind: "none", reason: "Another message is being delivered to this pane." });
		expect(pickTarget([conv({ canSendInput: false })])).toMatchObject({ kind: "none" });
	});
});

describe("sendStateOf — the HTTP answer, as is", () => {
	it("delivered with the CLI's prompt id is the only correlated state", () => {
		expect(sendStateOf(res(202, { result: "delivered", promptId: "p1", seq: 41 }))).toEqual({
			kind: "delivered",
			corr: { promptId: "p1", seq: 41 },
		});
		// No prompt id = no evidence: final, but never a correlated "delivered".
		expect(sendStateOf(res(202, { result: "delivered" }))).toEqual({
			kind: "delivered-unattributed",
		});
	});
	it("unconfirmed / uncertain / accepted are pending; misdelivered is never correlated", () => {
		for (const r of ["unconfirmed", "uncertain", "accepted"] as const) {
			expect(sendStateOf(res(202, { result: r }))).toEqual({ kind: "pending", result: r });
		}
		expect(sendStateOf(res(202, { result: "misdelivered", conversation: "c9" }))).toEqual({
			kind: "misdelivered",
		});
	});
	it("a refusal carries the server's own reason, in words", () => {
		expect(sendStateOf(res(409, { error: "busy" }))).toEqual({
			kind: "refused",
			status: 409,
			text: "Claude is busy; wait for the turn to finish.",
		});
		expect(sendStateOf(res(502, {}))).toMatchObject({ kind: "refused", status: 502 });
	});
});

describe("settleFromEvent — only this send's own event settles it", () => {
	const cs = (data: Record<string, unknown>) => ev("composer_send", null, data);
	it("delivered with a prompt id (interactive `result` or background `state`)", () => {
		expect(
			settleFromEvent(
				cs({ client_message_id: "m1", result: "delivered", prompt_id: "p1", seq: 9 }),
				"m1",
			),
		).toEqual({ kind: "delivered", corr: { promptId: "p1", seq: 9 } });
		expect(
			settleFromEvent(cs({ client_message_id: "m1", state: "delivered", prompt_id: "p1" }), "m1"),
		).toEqual({ kind: "delivered", corr: { promptId: "p1", seq: null } });
	});
	it("another send's event, or a delivered without a prompt id, settles nothing", () => {
		expect(
			settleFromEvent(cs({ client_message_id: "m2", result: "delivered", prompt_id: "p2" }), "m1"),
		).toBeNull();
		expect(settleFromEvent(cs({ client_message_id: "m1", state: "delivered" }), "m1")).toBeNull();
		expect(settleFromEvent(cs({ client_message_id: "m1", state: "prepared" }), "m1")).toBeNull();
		expect(settleFromEvent(ev("user_prompt", "p1", { prompt: "x" }), "m1")).toBeNull();
	});
	it("final answers recorded later: failed (with the server's reason) and an operator's resolution", () => {
		expect(
			settleFromEvent(
				cs({
					client_message_id: "m1",
					state: "failed",
					result: "failed",
					http: { status: 502, body: { error: "delivery-failed", detail: "cancelled" } },
				}),
				"m1",
			),
		).toMatchObject({ kind: "refused", text: expect.stringContaining("Delivery failed part-way") });
		expect(
			settleFromEvent(
				cs({
					client_message_id: "m1",
					state: "resolved",
					result: "resolved",
					outcome: "discarded",
				}),
				"m1",
			),
		).toEqual({ kind: "resolved", outcome: "discarded" });
		// The final result `delivered` without a prompt id: final, unattributable.
		expect(settleFromEvent(cs({ client_message_id: "m1", result: "delivered" }), "m1")).toEqual({
			kind: "delivered-unattributed",
		});
	});

	it("misdelivered and unconfirmed are reported as such", () => {
		expect(settleFromEvent(cs({ client_message_id: "m1", result: "misdelivered" }), "m1")).toEqual({
			kind: "misdelivered",
		});
		expect(settleFromEvent(cs({ client_message_id: "m1", state: "unconfirmed" }), "m1")).toEqual({
			kind: "pending",
			result: "unconfirmed",
		});
	});
});

describe("replies are attributed by prompt id only — never by time", () => {
	it("interleaved turns of two prompts: each send sees only its own answer", () => {
		seq = 40;
		const events = [
			ev("user_prompt", "pA", { prompt: "question A" }),
			ev("user_prompt", "pB", { prompt: "question B" }),
			answer("pB", "answer B"),
			ev("tool_start", "pA", { tool_use_id: "t1", tool_name: "Bash", summary: {} }),
			answer("pA", "answer A"),
			ev("turn_end", "pB", { last_assistant_message: "answer B" }),
			ev("turn_end", "pA", { last_assistant_message: "answer A" }),
		];
		const a = replyOf(events, { promptId: "pA", seq: 41 });
		const b = replyOf(events, { promptId: "pB", seq: 42 });
		expect(a.answer).toBe("answer A");
		expect(b.answer).toBe("answer B");
		expect(a.finished && b.finished).toBe(true);
		expect(a.items.some((i) => i.kind === "tool")).toBe(true);
		expect(b.items.some((i) => i.kind === "tool")).toBe(false);
	});

	it("an answer right after the send but without the prompt id is NOT the reply", () => {
		seq = 40;
		const events = [
			ev("user_prompt", "pA", { prompt: "q" }),
			answer("", "looks like an answer, no prompt id"),
			ev("assistant_delta", null, { message_id: "x", index: 0, delta: "also none" }),
		];
		const r = replyOf(events, { promptId: "pA", seq: 41 });
		expect(r.answer).toBeNull();
		expect(r.finished).toBe(false);
		expect(r.items.filter((i) => i.kind === "assistant")).toHaveLength(0);
	});

	it("events of the same prompt before the acknowledged seq are not part of it", () => {
		seq = 10;
		const events = [answer("pA", "stale", "m-old"), ev("user_prompt", "pA", { prompt: "q" }, 20)];
		expect(correlated(events, { promptId: "pA", seq: 20 }).map((e) => e.seq)).toEqual([20]);
	});

	it("without a correlation, new events are only counted (no reply)", () => {
		seq = 40;
		const events = [
			ev("composer_send", null, { client_message_id: "m1", state: "prepared" }),
			ev("probe", null, {}),
			ev("user_prompt", "p9", { prompt: "?" }),
			answer("p9", "someone's answer"),
		];
		expect(unattributedCount(events, 40, null)).toBe(2);
		expect(unattributedCount(events, 40, { promptId: "p9", seq: 43 })).toBe(0);
	});

	it("another prompt that joined the turn (same prompt id) makes the reply ambiguous", () => {
		seq = 40;
		const events = [
			ev("user_prompt", "pA", { prompt: "pilot message" }),
			ev("user_prompt", "pA", { prompt: "typed in the Terminal meanwhile" }),
			answer("pA", "answer to both?"),
			ev("turn_end", "pA", { last_assistant_message: "answer to both?" }),
		];
		expect(replyOf(events, { promptId: "pA", seq: 41 }).ambiguous).toBe(true);
		expect(
			replyOf(events.slice(0, 1).concat(events.slice(2)), { promptId: "pA", seq: 41 }).ambiguous,
		).toBe(false);
		// Without the acknowledged seq, two prompts are ambiguous too.
		expect(replyOf(events, { promptId: "pA", seq: null }).ambiguous).toBe(true);
	});

	it("a failed turn is finished and failed", () => {
		seq = 0;
		const r = replyOf(
			[ev("user_prompt", "pA", { prompt: "q" }), ev("turn_failed", "pA", { error: "x" })],
			{ promptId: "pA", seq: 1 },
		);
		expect(r).toMatchObject({ finished: true, failed: true });
	});
});

describe("forwardDraft", () => {
	it("names the source agent and keeps the text for the person to edit", () => {
		expect(forwardDraft("dev-a", "the plan")).toBe("From @dev-a:\n\nthe plan");
	});
});
