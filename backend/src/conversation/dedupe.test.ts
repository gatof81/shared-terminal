/**
 * dedupe.test.ts — docs/CONVERSATION.md §4.6: the seven required cases.
 * Sharing a turn is never a duplicate criterion; natural identities
 * dedupe forever (within the table), payload hashes only inside 10 s.
 */

import { describe, expect, it } from "vitest";
import { canonicalJson, DedupeTable, identityKey, payloadHash } from "./dedupe.js";

const T0 = 1_000_000;

describe("identityKey", () => {
	it("tool events key on tool_use_id regardless of prompt", () => {
		expect(identityKey({ ev: "tool_end", toolUseId: "t1", promptId: "p1" })).toBe("tool_end:t1");
		expect(identityKey({ ev: "tool_end", toolUseId: "t1", promptId: "p2" })).toBe("tool_end:t1");
	});
	it("Stop/StopFailure, notifications and session events have no natural identity", () => {
		for (const ev of [
			"turn_end",
			"turn_failed",
			"notification",
			"session_start",
			"session_end",
			"compact",
			"permission_request",
			"teammate_idle",
		]) {
			expect(identityKey({ ev, promptId: "p1", agentId: "a1" })).toBeNull();
		}
	});
	it("prompts and internal prompts key on prompt_id, as distinct types", () => {
		expect(identityKey({ ev: "user_prompt", promptId: "p1" })).toBe("user_prompt:p1");
		expect(identityKey({ ev: "internal_prompt", promptId: "p1" })).toBe("internal_prompt:p1");
		expect(identityKey({ ev: "internal_prompt" })).toBeNull();
	});
	it("assistant deltas key on agent + message + index", () => {
		expect(identityKey({ ev: "assistant_delta", messageId: "m", index: 3 })).toBe(
			"assistant_delta::m:3",
		);
		expect(identityKey({ ev: "assistant_delta", agentId: "a", messageId: "m", index: 3 })).toBe(
			"assistant_delta:a:m:3",
		);
	});
});

describe("DedupeTable — the seven §4.6 cases", () => {
	it("1. two SubagentStop in the same prompt with different agent_id are both kept", () => {
		const t = new DedupeTable();
		const h = payloadHash({ hook_event_name: "SubagentStop", prompt_id: "p1" });
		expect(t.seen(identityKey({ ev: "agent_end", agentId: "a1", promptId: "p1" }), h, T0)).toBe(
			false,
		);
		expect(t.seen(identityKey({ ev: "agent_end", agentId: "a2", promptId: "p1" }), h, T0)).toBe(
			false,
		);
	});
	it("2. two TaskCreated in the same turn with different task_id are both kept", () => {
		const t = new DedupeTable();
		const h = payloadHash({ hook_event_name: "TaskCreated", prompt_id: "p1" });
		expect(t.seen(identityKey({ ev: "task_created", taskId: "k1", promptId: "p1" }), h, T0)).toBe(
			false,
		);
		expect(t.seen(identityKey({ ev: "task_created", taskId: "k2", promptId: "p1" }), h, T0)).toBe(
			false,
		);
	});
	it("3. identical idle_prompt notifications: 60 s apart both kept, 1 s apart collapsed", () => {
		const t = new DedupeTable();
		const h = payloadHash({ hook_event_name: "Notification", notification_type: "idle_prompt" });
		expect(t.seen(null, h, T0)).toBe(false);
		expect(t.seen(null, h, T0 + 1_000)).toBe(true);
		expect(t.seen(null, h, T0 + 60_000)).toBe(false);
	});
	it("4. two Stops for the same prompt: distinct messages kept, identical within 1 s collapsed", () => {
		const t = new DedupeTable();
		const h1 = payloadHash({
			hook_event_name: "Stop",
			prompt_id: "p1",
			last_assistant_message: "A",
		});
		const h2 = payloadHash({
			hook_event_name: "Stop",
			prompt_id: "p1",
			last_assistant_message: "B",
		});
		expect(t.seen(null, h1, T0)).toBe(false);
		expect(t.seen(null, h2, T0 + 500)).toBe(false);
		expect(t.seen(null, h2, T0 + 1_000)).toBe(true);
	});
	it("5. a retried PostToolUse with the same tool_use_id is dropped", () => {
		const t = new DedupeTable();
		const k = identityKey({ ev: "tool_end", toolUseId: "t1" });
		expect(t.seen(k, "h", T0)).toBe(false);
		expect(t.seen(k, "h", T0 + 30_000)).toBe(true);
	});
	it("6. MessageDisplay: same message/index dropped, next index kept", () => {
		const t = new DedupeTable();
		expect(t.seen(identityKey({ ev: "assistant_delta", messageId: "m", index: 0 }), "h", T0)).toBe(
			false,
		);
		expect(t.seen(identityKey({ ev: "assistant_delta", messageId: "m", index: 0 }), "h", T0)).toBe(
			true,
		);
		expect(t.seen(identityKey({ ev: "assistant_delta", messageId: "m", index: 1 }), "h", T0)).toBe(
			false,
		);
	});
	it("7. two subagents' parallel PreToolUse with distinct tool_use_id are both kept", () => {
		const t = new DedupeTable();
		expect(t.seen(identityKey({ ev: "tool_start", toolUseId: "x", agentId: "a1" }), "h", T0)).toBe(
			false,
		);
		expect(t.seen(identityKey({ ev: "tool_start", toolUseId: "y", agentId: "a2" }), "h", T0)).toBe(
			false,
		);
	});
	it("bounds the table (LRU) and scopes teammate hashes by name", () => {
		const t = new DedupeTable(2);
		t.seen("a", "h", T0);
		t.seen("b", "h", T0);
		t.seen("c", "h", T0);
		expect(t.size()).toBeLessThanOrEqual(2);
		const t2 = new DedupeTable();
		expect(t2.seen(null, "same", T0, "tm1")).toBe(false);
		expect(t2.seen(null, "same", T0, "tm2")).toBe(false);
		expect(t2.seen(null, "same", T0, "tm1")).toBe(true);
	});
});

describe("canonicalJson / payloadHash", () => {
	it("is key-order independent and nesting aware", () => {
		expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toBe(
			'{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}',
		);
		expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }));
		expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }));
	});
});
