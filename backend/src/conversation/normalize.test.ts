/**
 * normalize.test.ts — docs/CONVERSATION.md §4.2: hook input → event,
 * field by field, with the L1/L3 truncation flags and the tolerant
 * handling of unknown fields and unsupported hooks.
 */

import { describe, expect, it } from "vitest";
import { NOTIFICATION } from "./internalPrompt.test.js";
import { L1_PROMPT_BYTES, L3_REPORT_BYTES } from "./limits.js";
import { normalizeHookInput } from "./normalize.js";

const base = {
	session_id: "c1",
	transcript_path: "/home/developer/.claude/projects/x/c1.jsonl",
	cwd: "/home/developer/workspace",
	prompt_id: "p1",
	permission_mode: "bypassPermissions",
};

function ok(raw: unknown) {
	const r = normalizeHookInput(raw);
	if (!r.ok) throw new Error(`expected ok, got ${r.detail}`);
	return r.event;
}

describe("normalizeHookInput — happy paths", () => {
	it("SessionStart with the st block → session_start with argv by allowlist", () => {
		const e = ok({
			...base,
			hook_event_name: "SessionStart",
			source: "startup",
			model: "claude-opus-5-5",
			st: {
				claude_version: "2.1.308",
				tmux_session: "tab-abc",
				pane: "%0",
				argv_flags: ["--dangerously-skip-permissions", "--append-system-prompt", "x"],
			},
		});
		expect(e.ev).toBe("session_start");
		expect(e.data).toEqual({
			source: "startup",
			model: "claude-opus-5-5",
			cwd: "/home/developer/workspace",
			transcript_path: "/home/developer/.claude/projects/x/c1.jsonl",
			claude_version: "2.1.308",
			tmux_session: "tab-abc",
			pane: "%0",
			argv_flags: ["--dangerously-skip-permissions"],
		});
	});
	it("UserPromptSubmit keeps the prompt, source and title", () => {
		const e = ok({ ...base, hook_event_name: "UserPromptSubmit", prompt: "hola", source: "user" });
		expect(e.ev).toBe("user_prompt");
		expect(e.promptId).toBe("p1");
		expect(e.data).toEqual({ prompt: "hola", source: "user" });
	});
	it("§4.2.1 UserPromptSubmit carrying a verified task notification → internal_prompt, ids only", () => {
		const e = ok({
			...base,
			hook_event_name: "UserPromptSubmit",
			prompt: NOTIFICATION,
			source: "user",
			session_title: "T",
		});
		expect(e.ev).toBe("internal_prompt");
		expect(e.promptId).toBe("p1");
		expect(e.data).toEqual({
			notice: "task-notification",
			task_id: "afc95b2b37cb620a1",
			tool_use_id: "toolu_01NrcdMjX7yQ2bK9vTz3Lm4W",
			status: "completed",
			prompt_bytes: Buffer.byteLength(NOTIFICATION),
			source: "user",
			session_title: "T",
		});
		// Never the text: the subagent's result lives in agent_end only.
		expect(JSON.stringify(e.data)).not.toContain("subagent");
	});

	it("§4.2.1 a notification-shaped prompt that fails validation stays user_prompt, marked unverified", () => {
		const e = ok({
			...base,
			hook_event_name: "UserPromptSubmit",
			prompt: NOTIFICATION.replace("toolu_01NrcdMjX7yQ2bK9vTz3Lm4W", "nope"),
		});
		expect(e.ev).toBe("user_prompt");
		expect(e.data.origin).toBe("unverified");
		expect(e.data.prompt).toContain("<task-notification>");
	});

	it("§4.2.1 a person mentioning the tags, or pasting a notification plus a question, is user_prompt", () => {
		for (const prompt of [
			"why does <task-notification> show up as me?",
			`${NOTIFICATION}

explain this`,
		]) {
			const e = ok({ ...base, hook_event_name: "UserPromptSubmit", prompt });
			expect(e.ev).toBe("user_prompt");
			expect(e.data.origin).toBeUndefined();
			expect(e.data.prompt).toBe(prompt);
		}
	});

	it("UserPromptSubmit past L1 is truncated visibly", () => {
		const e = ok({
			...base,
			hook_event_name: "UserPromptSubmit",
			prompt: "x".repeat(L1_PROMPT_BYTES + 10),
		});
		expect(e.data.truncated).toBe(true);
		expect(e.data.original_bytes).toBe(L1_PROMPT_BYTES + 10);
		expect(Buffer.byteLength(e.data.prompt as string)).toBeLessThanOrEqual(L1_PROMPT_BYTES);
	});
	it("MessageDisplay → assistant_delta with turn/message identity", () => {
		const e = ok({
			...base,
			hook_event_name: "MessageDisplay",
			turn_id: "t1",
			message_id: "m1",
			index: 2,
			final: false,
			delta: "line\n",
		});
		expect(e.ev).toBe("assistant_delta");
		expect(e.turnId).toBe("t1");
		expect(e.identity).toEqual({ messageId: "m1", index: 2 });
		expect(e.data).toEqual({ message_id: "m1", index: 2, final: false, delta: "line\n" });
	});
	it("PreToolUse → tool_start with a redacted summary and never tool_input", () => {
		const e = ok({
			...base,
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_use_id: "tu1",
			tool_input: { command: "curl -H 'Authorization: Bearer S' https://x" },
			mcp_server: { name: "srv", source: "user" },
		});
		expect(e.ev).toBe("tool_start");
		expect(e.identity.toolUseId).toBe("tu1");
		expect(JSON.stringify(e.data)).not.toContain("Bearer");
		expect(e.data.summary).toEqual({
			command_bytes: Buffer.byteLength("curl -H 'Authorization: Bearer S' https://x"),
			programs_omitted: true,
		});
		expect(e.data.mcp_server).toEqual({ name: "srv", source: "user" });
	});
	it("PostToolUse keeps only response_bytes, never tool_response", () => {
		const e = ok({
			...base,
			hook_event_name: "PostToolUse",
			tool_name: "Read",
			tool_use_id: "tu2",
			tool_input: { file_path: "/w/secret.txt" },
			tool_response: { content: "TOP SECRET CONTENT" },
			duration_ms: 12,
		});
		expect(e.ev).toBe("tool_end");
		expect(JSON.stringify(e.data)).not.toContain("SECRET");
		expect(e.data).toEqual({
			tool_name: "Read",
			tool_use_id: "tu2",
			ok: true,
			response_bytes: JSON.stringify({ content: "TOP SECRET CONTENT" }).length,
			duration_ms: 12,
		});
	});
	it("PostToolUseFailure for Bash keeps bytes/exit code; for Read keeps the text", () => {
		const bash = ok({
			...base,
			hook_event_name: "PostToolUseFailure",
			tool_name: "Bash",
			tool_use_id: "a",
			error: "exit code 3: cat x",
			is_interrupt: false,
		});
		expect(bash.data).toEqual({
			tool_name: "Bash",
			tool_use_id: "a",
			ok: false,
			error_bytes: 18,
			exit_code: 3,
			is_interrupt: false,
		});
		const read = ok({
			...base,
			hook_event_name: "PostToolUseFailure",
			tool_name: "Read",
			tool_use_id: "b",
			error: "ENOENT",
		});
		expect(read.data.error).toBe("ENOENT");
	});
	it("Stop → turn_end with the full report, slim background tasks and cron count", () => {
		const e = ok({
			...base,
			hook_event_name: "Stop",
			stop_hook_active: false,
			last_assistant_message: "# Report\nDone.",
			background_tasks: [
				{ id: "t1", type: "subagent", status: "running", description: "secret-ish" },
			],
			session_crons: [{ id: "c" }],
		});
		expect(e.ev).toBe("turn_end");
		expect(e.data).toEqual({
			stop_hook_active: false,
			last_assistant_message: "# Report\nDone.",
			background_tasks: [{ id: "t1", type: "subagent", status: "running" }],
			session_crons_count: 1,
		});
	});
	it("Stop past L3 is truncated visibly, never silently", () => {
		const e = ok({
			...base,
			hook_event_name: "Stop",
			stop_hook_active: false,
			last_assistant_message: "y".repeat(L3_REPORT_BYTES + 1),
		});
		expect(e.data.truncated).toBe(true);
		expect(e.data.original_bytes).toBe(L3_REPORT_BYTES + 1);
	});
	it("SubagentStart/Stop carry agent identity and the final result", () => {
		const start = ok({
			...base,
			hook_event_name: "SubagentStart",
			agent_id: "a1",
			agent_type: "Explore",
		});
		expect(start.ev).toBe("agent_start");
		expect(start.agentId).toBe("a1");
		const stop = ok({
			...base,
			hook_event_name: "SubagentStop",
			agent_id: "a1",
			agent_type: "Explore",
			stop_hook_active: false,
			last_assistant_message: "result",
			agent_transcript_path: "/p",
		});
		expect(stop.ev).toBe("agent_end");
		expect(stop.data).toEqual({
			agent_id: "a1",
			agent_type: "Explore",
			last_assistant_message: "result",
			background_tasks: [],
			agent_transcript_path: "/p",
		});
	});
	it("Notification permission_prompt keeps only the type", () => {
		const e = ok({
			...base,
			hook_event_name: "Notification",
			notification_type: "permission_prompt",
			message: "run rm -rf",
			title: "x",
		});
		expect(e.data).toEqual({ notification_type: "permission_prompt" });
	});
	it("PermissionRequest keeps tool name and summary", () => {
		const e = ok({
			...base,
			hook_event_name: "PermissionRequest",
			tool_name: "Bash",
			tool_input: { command: "rm -rf /" },
		});
		expect(e.data).toEqual({ tool_name: "Bash", summary: { programs: ["rm"], command_bytes: 8 } });
	});
	it("Pre/PostCompact drop compact_summary", () => {
		const e = ok({
			...base,
			hook_event_name: "PostCompact",
			trigger: "auto",
			compact_summary: "all the secrets",
		});
		expect(e.data).toEqual({ phase: "post", trigger: "auto" });
	});
	it("TaskCreated keeps id/subject/teammate, never the description", () => {
		const e = ok({
			...base,
			hook_event_name: "TaskCreated",
			task_id: "k1",
			task_subject: "Do X",
			task_description: "with secret Y",
			teammate_name: "tm",
		});
		expect(e.identity.taskId).toBe("k1");
		expect(e.data).toEqual({ task_id: "k1", task_subject: "Do X", teammate_name: "tm" });
	});
	it("TeammateIdle → teammate_idle", () => {
		const e = ok({
			...base,
			hook_event_name: "TeammateIdle",
			teammate_name: "tm",
			team_name: "deprecated",
		});
		expect(e.data).toEqual({ teammate_name: "tm" });
		expect(e.identity.teammateName).toBe("tm");
	});
	it("SessionEnd → session_end", () => {
		expect(ok({ ...base, hook_event_name: "SessionEnd", reason: "clear" }).data).toEqual({
			reason: "clear",
		});
	});
	it("unknown top-level fields are dropped and counted", () => {
		const e = ok({
			...base,
			hook_event_name: "SessionEnd",
			reason: "other",
			brand_new_field: 1,
			another: 2,
		});
		expect(e.droppedFields).toBe(2);
		expect(e.data).toEqual({ reason: "other" });
	});
});

describe("normalizeHookInput — malformed", () => {
	it("non-object bodies", () => {
		expect(normalizeHookInput("x").ok).toBe(false);
		expect(normalizeHookInput([1]).ok).toBe(false);
		expect(normalizeHookInput(null).ok).toBe(false);
	});
	it("missing session_id / hook_event_name", () => {
		const r = normalizeHookInput({ hook_event_name: "Stop" });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.hookEventName).toBe("Stop");
	});
	it("required event-specific fields", () => {
		expect(normalizeHookInput({ ...base, hook_event_name: "UserPromptSubmit" }).ok).toBe(false);
		expect(
			normalizeHookInput({ ...base, hook_event_name: "MessageDisplay", message_id: "m" }).ok,
		).toBe(false);
		expect(normalizeHookInput({ ...base, hook_event_name: "SubagentStop" }).ok).toBe(false);
		expect(normalizeHookInput({ ...base, hook_event_name: "TaskCreated" }).ok).toBe(false);
	});
	it("unsupported hooks report the name", () => {
		const r = normalizeHookInput({
			...base,
			hook_event_name: "InstructionsLoaded",
			file_path: "/x",
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.detail).toContain("InstructionsLoaded");
	});
});
