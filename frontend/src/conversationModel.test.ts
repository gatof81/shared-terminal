import { describe, expect, it } from "vitest";
import {
	buildThread,
	type ConversationEvent,
	EventWindow,
	gapText,
	groupBlocks,
	statusIsLiveClaim,
	statusTone,
	toolLine,
	toolsSummary,
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
		// The agent's own activity stays out; the thread keeps where it started and ended.
		expect(m.items.map((i) => i.kind)).toEqual(["user", "agent", "agent"]);
		expect(m.items[1]).toMatchObject({ kind: "agent", phase: "start", agentType: "Explore" });
		expect(m.items[2]).toMatchObject({ kind: "agent", phase: "end", agentId: "a1" });
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
		expect(w.events[w.events.length - 1].seq).toBe(500);
		expect(w.atLatest).toBe(false);
		// The 100 dropped from the newest end count as newer-than-the-window…
		expect(w.newerUnseen).toBe(100);
		// …and so does a live event that arrives while not at the latest.
		expect(w.append(mk(601))).toBe(false);
		expect(w.newerUnseen).toBe(101);
		expect(w.lastSeq).toBe(601);
	});
});

describe("report merged into the final message", () => {
	it("a turn_end that repeats the last assistant message marks that message as the report", () => {
		const text = "## Done\n\nAll green.\n";
		const m = buildThread([
			ev("user_prompt", { prompt: "go" }),
			ev("assistant_delta", { message_id: "m1", index: 0, delta: text, final: true }),
			ev("tool_start", { tool_use_id: "t1", tool_name: "Bash", summary: {} }),
			ev("tool_end", { tool_use_id: "t1", tool_name: "Bash", ok: true }),
			ev("turn_end", { last_assistant_message: text }),
		]);
		expect(m.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool"]);
		expect(m.items[1]).toMatchObject({
			kind: "assistant",
			final: true,
			report: { text, truncated: false, originalBytes: null },
		});
	});

	it("a report whose bytes differ, or with no message in the window, stays its own item", () => {
		const a = buildThread([
			ev("assistant_delta", { message_id: "m1", index: 0, delta: "partial", final: true }),
			ev("turn_end", { last_assistant_message: "partial — but longer", truncated: true }),
		]);
		expect(a.items.map((i) => i.kind)).toEqual(["assistant", "report"]);
		expect((a.items[0] as { report: unknown }).report).toBeNull();
		const b = buildThread([ev("turn_end", { last_assistant_message: "alone" })]);
		expect(b.items.map((i) => i.kind)).toEqual(["report"]);
		// A user prompt in between is a new turn: never merged across it.
		const c = buildThread([
			ev("assistant_delta", { message_id: "m1", index: 0, delta: "x", final: true }),
			ev("user_prompt", { prompt: "again" }),
			ev("turn_end", { last_assistant_message: "x" }),
		]);
		expect(c.items.map((i) => i.kind)).toEqual(["assistant", "user", "report"]);
	});
});

describe("blocks and status presentation", () => {
	it("consecutive tools form one block keyed by the first tool; other items stand alone", () => {
		const m = buildThread([
			ev("user_prompt", { prompt: "go" }),
			ev("tool_start", { tool_use_id: "t1", tool_name: "Read", summary: {} }),
			ev("tool_end", { tool_use_id: "t1", tool_name: "Read", ok: true, duration_ms: 10 }),
			ev("tool_start", { tool_use_id: "t2", tool_name: "Edit", summary: {} }),
			ev("tool_failed", { tool_use_id: "t2", tool_name: "Edit", ok: false, duration_ms: 20 }),
			ev("assistant_delta", { message_id: "m1", index: 0, delta: "done", final: true }),
			ev("tool_start", { tool_use_id: "t3", tool_name: "Bash", summary: {} }),
		]);
		const blocks = groupBlocks(m.items);
		expect(blocks.map((b) => b.kind)).toEqual(["item", "tools", "item", "tools"]);
		const run = blocks[1];
		if (run.kind !== "tools") throw new Error("expected tools");
		expect(run.key).toBe("Ttt1");
		expect(run.tools.map((t) => t.toolUseId)).toEqual(["t1", "t2"]);
		expect(toolsSummary(run.tools)).toEqual({
			count: 2,
			failed: 1,
			running: 0,
			names: ["Read", "Edit"],
			durationMs: 30,
		});
		const tail = blocks[3];
		if (tail.kind !== "tools") throw new Error("expected tools");
		expect(toolsSummary(tail.tools)).toMatchObject({ running: 1, durationMs: null });
	});

	it("status tones and live claims follow the contract's state machine", () => {
		expect(statusTone("running")).toBe("active");
		expect(statusTone("waiting_input")).toBe("ready");
		expect(statusTone("waiting_permission")).toBe("attention");
		expect(statusTone("error")).toBe("error");
		expect(statusTone("ended")).toBe("done");
		expect(statusTone("disconnected")).toBe("muted");
		expect(statusTone("unknown")).toBe("muted");
		expect(statusIsLiveClaim("running")).toBe(true);
		expect(statusIsLiveClaim("waiting_permission")).toBe(true);
		expect(statusIsLiveClaim("ended")).toBe(false);
		expect(statusIsLiveClaim("disconnected")).toBe(false);
	});
});

describe("§4.2.1 the CLI's task notification is not the person's prompt", () => {
	// The pilot's seq 21–23 shape: Agent tool → agent_start → agent tools →
	// agent_end → UserPromptSubmit carrying the notification → next turn.
	const notification = (toolUseId: string, taskId: string, status = "completed") =>
		[
			"<task-notification>",
			`<task-id>${taskId}</task-id>`,
			`<tool-use-id>${toolUseId}</tool-use-id>`,
			`<status>${status}</status>`,
			"<summary>Agent completed</summary>",
			"<result>",
			"the subagent's own report text",
			"</result>",
			"</task-notification>",
		].join("\n");
	const AGENT_TOOL = "toolu_01NrcdMjX7yQ2bK9vTz3Lm4W";
	const AGENT = "afc95b2b37cb620a1";
	const subagentRun = () => [
		ev("user_prompt", { prompt: "Run the audit with a subagent" }, { prompt_id: "p1" }),
		ev("tool_start", {
			tool_use_id: AGENT_TOOL,
			tool_name: "Agent",
			summary: { subagent_type: "Explore" },
		}),
		ev("agent_start", { agent_id: AGENT, agent_type: "Explore" }, { agent_id: AGENT }),
		ev(
			"tool_start",
			{ tool_use_id: "toolu_01Bash000000000001", tool_name: "Bash", summary: {} },
			{ agent_id: AGENT },
		),
		ev(
			"tool_end",
			{ tool_use_id: "toolu_01Bash000000000001", tool_name: "Bash", ok: true },
			{ agent_id: AGENT },
		),
		ev(
			"agent_end",
			{
				agent_id: AGENT,
				agent_type: "Explore",
				last_assistant_message: "the subagent's own report text",
			},
			{ agent_id: AGENT },
		),
	];

	it("a persisted internal_prompt is an internal item correlated to the agent, never a user item", () => {
		const events = [
			...subagentRun(),
			ev(
				"internal_prompt",
				{
					notice: "task-notification",
					task_id: "task-x",
					tool_use_id: AGENT_TOOL,
					status: "completed",
					prompt_bytes: 200,
				},
				{ prompt_id: "p2" },
			),
			ev(
				"assistant_delta",
				{ message_id: "m2", index: 0, final: true, delta: "Continuing." },
				{ prompt_id: "p2" },
			),
			ev("turn_end", { last_assistant_message: "Continuing." }, { prompt_id: "p2" }),
		];
		const m = buildThread(events);
		expect(m.items.map((i) => i.kind)).toEqual([
			"user",
			"tool",
			"agent",
			"agent",
			"internal",
			"assistant",
		]);
		const internal = m.items[4];
		if (internal.kind !== "internal") throw new Error("not internal");
		expect(internal).toMatchObject({
			taskId: "task-x",
			toolUseId: AGENT_TOOL,
			status: "completed",
			toolName: "Agent",
			agentId: AGENT,
			agentType: "Explore",
			legacy: false,
		});
		// The person's prompt is the only user item; the subagent's text is nowhere in the main thread.
		expect(m.items.filter((i) => i.kind === "user")).toHaveLength(1);
		expect(JSON.stringify(m.items)).not.toContain("subagent's own report");
		expect(m.agents[0].result).toBe("the subagent's own report text");
		// The next turn's report attaches to the message AFTER the notification.
		const last = m.items[5];
		if (last.kind !== "assistant") throw new Error("not assistant");
		expect(last.report?.text).toBe("Continuing.");
	});

	it("a user_prompt persisted before 4.2.1 that is a notification is re-classified (legacy), same correlation", () => {
		const m = buildThread([
			...subagentRun(),
			ev("user_prompt", { prompt: notification(AGENT_TOOL, AGENT) }, { prompt_id: "p2" }),
		]);
		const internal = m.items[m.items.length - 1];
		expect(internal.kind).toBe("internal");
		if (internal.kind !== "internal") return;
		expect(internal.legacy).toBe(true);
		expect(internal.agentId).toBe(AGENT);
		expect(internal.agentType).toBe("Explore");
		expect(m.items.filter((i) => i.kind === "user")).toHaveLength(1);
	});

	it("correlates by task id = agent id when the Agent tool_start is outside the window", () => {
		const m = buildThread([
			ev(
				"agent_end",
				{ agent_id: AGENT, agent_type: "Explore", last_assistant_message: "r" },
				{ agent_id: AGENT },
			),
			ev("user_prompt", { prompt: notification(AGENT_TOOL, AGENT) }),
		]);
		const internal = m.items[1];
		if (internal.kind !== "internal") throw new Error("not internal");
		expect(internal.agentId).toBe(AGENT);
		expect(internal.toolName).toBeNull();
	});

	it("a background Bash notification names the tool and no agent", () => {
		const m = buildThread([
			ev("tool_start", {
				tool_use_id: "toolu_01SuzrSX6G4ikw9fPVXhR188",
				tool_name: "Bash",
				summary: { run_in_background: true },
			}),
			ev("user_prompt", {
				prompt: notification("toolu_01SuzrSX6G4ikw9fPVXhR188", "btesl5hn3", "failed"),
			}),
		]);
		const internal = m.items[1];
		if (internal.kind !== "internal") throw new Error("not internal");
		expect(internal).toMatchObject({
			toolName: "Bash",
			agentId: null,
			agentType: null,
			status: "failed",
		});
	});

	it("a person's prompt stays 'You' even when it mentions or quotes the tags; injected and unverified are marked", () => {
		const m = buildThread([
			ev("user_prompt", { prompt: "why does <task-notification> show as me?" }),
			ev("user_prompt", { prompt: `${notification(AGENT_TOOL, AGENT)}\n\nexplain this` }),
			ev("user_prompt", { prompt: "from the lead", source: "system" }),
			ev("user_prompt", { prompt: notification("call_123", AGENT) }),
			ev("user_prompt", { prompt: "typed", origin: "unverified" }),
		]);
		expect(m.items.map((i) => (i.kind === "user" ? [i.origin, i.source] : i.kind))).toEqual([
			["human", null],
			["human", null],
			["human", "system"],
			["unverified", null],
			["unverified", null],
		]);
	});

	it("two parallel agents: each notification lands on its own agent, in order", () => {
		const m = buildThread([
			ev("tool_start", {
				tool_use_id: "toolu_01AAAAAAAAAAAAAAAA",
				tool_name: "Agent",
				summary: {},
			}),
			ev("tool_start", {
				tool_use_id: "toolu_01BBBBBBBBBBBBBBBB",
				tool_name: "Agent",
				summary: {},
			}),
			ev("agent_start", { agent_id: "a-one", agent_type: "Explore" }, { agent_id: "a-one" }),
			ev("agent_start", { agent_id: "a-two", agent_type: "Plan" }, { agent_id: "a-two" }),
			ev("agent_end", { agent_id: "a-two", agent_type: "Plan" }, { agent_id: "a-two" }),
			ev("user_prompt", { prompt: notification("toolu_01BBBBBBBBBBBBBBBB", "t2") }),
			ev("agent_end", { agent_id: "a-one", agent_type: "Explore" }, { agent_id: "a-one" }),
			ev("user_prompt", { prompt: notification("toolu_01AAAAAAAAAAAAAAAA", "t1") }),
		]);
		const internals = m.items.filter((i) => i.kind === "internal");
		expect(internals.map((i) => (i.kind === "internal" ? [i.agentId, i.agentType] : null))).toEqual(
			[
				["a-two", "Plan"],
				["a-one", "Explore"],
			],
		);
	});
});

describe("§4.2.1 internal prompts through the window: no duplicates on reconnect or paging", () => {
	const internal = (s: number) =>
		({
			seq: s,
			ts: new Date(1_800_000_000_000 + s * 1000).toISOString(),
			ev: "internal_prompt",
			prompt_id: `p${s}`,
			turn_id: null,
			agent_id: null,
			pane: null,
			data: {
				notice: "task-notification",
				task_id: "t",
				tool_use_id: "toolu_01AAAAAAAAAAAAAAAA",
				status: "completed",
			},
		}) as ConversationEvent;
	it("a live frame re-sent after a resync and an overlapping older page both collapse by seq", () => {
		const w = new EventWindow();
		w.setLatest([internal(10), internal(11)], true);
		expect(w.append(internal(11))).toBe(false);
		expect(w.append(internal(12))).toBe(true);
		w.prepend([internal(8), internal(9), internal(10)], false);
		expect(w.events.map((e) => e.seq)).toEqual([8, 9, 10, 11, 12]);
		expect(buildThread(w.events).items.filter((i) => i.kind === "internal")).toHaveLength(5);
	});
});
