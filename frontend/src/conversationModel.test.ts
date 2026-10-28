import { describe, expect, it } from "vitest";
import {
	buildThread,
	type ConversationEvent,
	EventWindow,
	gapText,
	toolLine,
	WINDOW_MAX_EVENTS,
} from "./conversationModel";

let seq = 0;
function ev(
	name: string,
	data: Record<string, unknown> = {},
	extra: Partial<ConversationEvent> = {},
) {
	seq++;
	return {
		seq,
		ts: new Date(1_800_000_000_000 + seq * 1000).toISOString(),
		ev: name,
		prompt_id: null,
		turn_id: null,
		agent_id: null,
		pane: null,
		data,
		...extra,
	} as ConversationEvent;
}

describe("tools by tool_use_id (§4.2 note 1)", () => {
	const start = () =>
		ev("tool_start", {
			tool_use_id: "t1",
			tool_name: "Bash",
			summary: { programs: ["npm"], command_bytes: 8 },
		});
	const failed = () =>
		ev("tool_failed", {
			tool_use_id: "t1",
			tool_name: "Bash",
			ok: false,
			duration_ms: 40,
			error_bytes: 12,
		});
	const ended = () =>
		ev("tool_end", {
			tool_use_id: "t1",
			tool_name: "Bash",
			ok: true,
			duration_ms: 41,
			response_bytes: 3,
		});

	it("the real 2.1.308 sequence start → failed → end is ONE failed tool", () => {
		const m = buildThread([start(), failed(), ended()]);
		const tools = m.items.filter((i) => i.kind === "tool");
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ state: "failed", durationMs: 40, toolName: "Bash" });
		expect(m.toolCount).toBe(1);
	});

	it("failure wins in any arrival order", () => {
		const orders = [
			[start(), ended(), failed()],
			[ended(), failed(), start()],
			[failed(), start(), ended()],
			[ended(), start(), failed()],
		];
		for (const o of orders) {
			const t = buildThread(o).items.filter((i) => i.kind === "tool");
			expect(t).toHaveLength(1);
			expect(t[0]).toMatchObject({ state: "failed" });
		}
	});

	it("counts distinct ids, not events; the summary line uses only redacted fields", () => {
		const m = buildThread([
			start(),
			ended(),
			ev("tool_start", {
				tool_use_id: "t2",
				tool_name: "Read",
				summary: { file_path: "src/x.ts" },
			}),
			ev("tool_end", { tool_use_id: "t2", tool_name: "Read", ok: true }),
		]);
		expect(m.toolCount).toBe(2);
		expect(toolLine("Read", { file_path: "src/x.ts" })).toBe("Read · src/x.ts");
		expect(toolLine("Bash", { command_bytes: 61, programs_omitted: true })).toBe(
			"Bash · command · 61 B",
		);
		expect(toolLine("mcp__x", { keys: ["server", "headers"] })).toBe("mcp__x · {server, headers}");
	});

	it("an interrupt is shown as interrupted, a lone start as running", () => {
		const a = buildThread([
			ev("tool_failed", { tool_use_id: "i", tool_name: "Bash", is_interrupt: true }),
		]);
		expect(a.items[0]).toMatchObject({ state: "interrupted" });
		const b = buildThread([ev("tool_start", { tool_use_id: "r", tool_name: "Bash" })]);
		expect(b.items[0]).toMatchObject({ state: "running" });
	});
});

describe("assistant messages", () => {
	it("joins deltas by index and marks a lost fragment", () => {
		const m = buildThread([
			ev("assistant_delta", { message_id: "m1", index: 0, delta: "Hello ", final: false }),
			ev("assistant_delta", { message_id: "m1", index: 2, delta: "world", final: true }),
		]);
		expect(m.items).toHaveLength(1);
		expect(m.items[0]).toMatchObject({
			kind: "assistant",
			text: "Hello [… fragment lost …]world",
			final: true,
			missingFragments: 1,
		});
	});
	it("a duplicate index is not appended twice; truncated is surfaced", () => {
		const m = buildThread([
			ev("assistant_delta", { message_id: "m", index: 0, delta: "a" }),
			ev("assistant_delta", { message_id: "m", index: 0, delta: "a" }),
			ev("assistant_delta", { message_id: "m", index: 1, delta: "b", truncated: true }),
		]);
		expect(m.items[0]).toMatchObject({ text: "ab", truncated: true });
	});
});

describe("reports, gaps and subagents", () => {
	it("a turn_end report keeps last_assistant_message byte for byte and its truncation", () => {
		const text = "# Report\n\n```ts\nconst x = 1;\n```\n\u0001 tail ";
		const m = buildThread([
			ev("turn_end", { last_assistant_message: text, truncated: true, original_bytes: 2_000_000 }),
		]);
		expect(m.items[0]).toEqual(
			expect.objectContaining({ kind: "report", text, truncated: true, originalBytes: 2_000_000 }),
		);
	});

	it("gaps are visible markers with their reason", () => {
		const m = buildThread([ev("gap", { reason: "relay_dropped", dropped: 3 })]);
		expect(m.items[0]).toMatchObject({
			kind: "marker",
			tone: "warn",
			text: "3 events not delivered by the container",
		});
		expect(gapText({ reason: "history_rotated" }, "")).toBe(
			"Earlier events are no longer available",
		);
		expect(gapText({ reason: "something_new" }, "")).toContain("something_new");
	});

	it("subagent events stay out of the main thread and are grouped per agent", () => {
		const m = buildThread([
			ev("user_prompt", { prompt: "go" }),
			ev("agent_start", { agent_id: "a1", agent_type: "Explore" }, { agent_id: "a1" }),
			ev("tool_start", { tool_use_id: "x1", tool_name: "Grep", summary: {} }, { agent_id: "a1" }),
			ev("tool_end", { tool_use_id: "x1", tool_name: "Grep", ok: true }, { agent_id: "a1" }),
			ev(
				"agent_end",
				{ agent_id: "a1", agent_type: "Explore", last_assistant_message: "found it" },
				{ agent_id: "a1" },
			),
		]);
		expect(m.items.map((i) => i.kind)).toEqual(["user"]);
		expect(m.toolCount).toBe(0);
		expect(m.agents).toHaveLength(1);
		expect(m.agents[0]).toMatchObject({
			agentId: "a1",
			agentType: "Explore",
			status: "done",
			result: "found it",
		});
		expect(m.agents[0].toolIds.size).toBe(1);
	});
});

describe("EventWindow (L8)", () => {
	const mk = (n: number) => ({
		seq: n,
		ts: "",
		ev: "user_prompt",
		prompt_id: null,
		turn_id: null,
		agent_id: null,
		pane: null,
		data: { prompt: `p${n}` },
	});

	it("live append skips duplicates and trims the oldest past 500 events", () => {
		const w = new EventWindow();
		w.setLatest([mk(1), mk(2)], false);
		expect(w.append(mk(2))).toBe(false);
		for (let i = 3; i <= 700; i++) w.append(mk(i));
		expect(w.events.length).toBe(WINDOW_MAX_EVENTS);
		expect(w.events[0].seq).toBe(201);
		expect(w.hasOlder).toBe(true);
	});

	it("loading earlier past the budget drops the newest and stops live appends", () => {
		const w = new EventWindow();
		w.setLatest(
			Array.from({ length: 300 }, (_, i) => mk(i + 301)),
			true,
		);
		w.prepend(
			Array.from({ length: 300 }, (_, i) => mk(i + 1)),
			false,
		);
		expect(w.events.length).toBe(WINDOW_MAX_EVENTS);
		expect(w.events[0].seq).toBe(1);
		expect(w.atLatest).toBe(false);
		expect(w.append(mk(601))).toBe(false);
		expect(w.newerUnseen).toBe(1);
	});
});
