/**
 * conversation/normalize.ts — docs/CONVERSATION.md §4.2: hook input →
 * persisted event. Tolerant on purpose: Claude Code self-updates inside
 * the workspace, so an unknown field is dropped and counted, a missing
 * required field makes the event `malformed` (a visible gap), and
 * nothing ever throws into the ingest path.
 *
 * Every string that can carry free text goes through the §4.3 redaction
 * or a byte-accurate truncation with a visible `truncated: true` flag —
 * the contract's rule is that no truncation is silent.
 */

import { z } from "zod";
import { ERROR_TEXT_BYTES, L1_PROMPT_BYTES, L3_REPORT_BYTES, L4_AUX_BYTES } from "./limits.js";
import {
	filterArgvFlags,
	redactNotification,
	redactToolError,
	summarizeToolInput,
	type ToolSummary,
} from "./redact.js";
import { clipAux, truncateUtf8, utf8Bytes } from "./text.js";

export type EventName =
	| "session_start"
	| "session_end"
	| "user_prompt"
	| "assistant_delta"
	| "tool_start"
	| "tool_end"
	| "tool_failed"
	| "turn_end"
	| "turn_failed"
	| "agent_start"
	| "agent_end"
	| "notification"
	| "permission_request"
	| "compact"
	| "task_created"
	| "task_completed"
	| "teammate_idle"
	| "gap"
	| "probe"
	| "composer_send";

export type EventData = Record<string, unknown>;

/** A normalised event before it gets its `seq`/`ts` from the store. */
export interface NormalizedEvent {
	ev: EventName;
	sessionId: string;
	promptId: string | null;
	turnId: string | null;
	agentId: string | null;
	/** Only for the dedupe identity; not persisted on its own. */
	identity: {
		messageId?: string;
		index?: number;
		toolUseId?: string;
		taskId?: string;
		teammateName?: string;
	};
	data: EventData;
	/** Count of top-level fields the parser dropped (unknown to the contract). */
	droppedFields: number;
}

export type NormalizeResult =
	| { ok: true; event: NormalizedEvent }
	| { ok: false; reason: "malformed"; hookEventName?: string; sessionId?: string; detail: string };

// Common fields (§1.3 of the design). Everything optional but
// `hook_event_name` and `session_id`; unknown keys are allowed by zod's
// default object behaviour and counted separately.
const Common = z.object({
	hook_event_name: z.string(),
	session_id: z.string().min(1).max(128),
	transcript_path: z.string().optional(),
	cwd: z.string().optional(),
	prompt_id: z.string().optional(),
	permission_mode: z.string().optional(),
	agent_id: z.string().optional(),
	agent_type: z.string().optional(),
});

type CommonT = z.infer<typeof Common>;

const KNOWN_TOP_LEVEL: Record<string, readonly string[]> = {
	SessionStart: [
		"source",
		"agent_type",
		"model",
		"session_title",
		"st",
		"seconds_since_last_response",
		"context_tokens",
		"prompt_cache_likely_expired",
		"estimated_cache_write_usd",
	],
	SessionEnd: ["reason"],
	UserPromptSubmit: ["prompt", "source", "session_title"],
	MessageDisplay: ["turn_id", "message_id", "index", "final", "delta"],
	PreToolUse: ["tool_name", "tool_input", "tool_use_id", "mcp_server"],
	PostToolUse: [
		"tool_name",
		"tool_input",
		"tool_use_id",
		"tool_response",
		"duration_ms",
		"mcp_server",
	],
	PostToolUseFailure: [
		"tool_name",
		"tool_input",
		"tool_use_id",
		"error",
		"is_interrupt",
		"duration_ms",
		"mcp_server",
	],
	Stop: ["stop_hook_active", "last_assistant_message", "background_tasks", "session_crons"],
	StopFailure: ["error", "error_details", "last_assistant_message"],
	SubagentStart: ["agent_id", "agent_type"],
	SubagentStop: [
		"stop_hook_active",
		"agent_id",
		"agent_type",
		"agent_transcript_path",
		"last_assistant_message",
		"background_tasks",
		"session_crons",
	],
	Notification: ["message", "title", "notification_type"],
	PermissionRequest: ["tool_name", "tool_input", "permission_suggestions", "mcp_server"],
	PreCompact: ["trigger", "custom_instructions"],
	PostCompact: ["trigger", "compact_summary"],
	TaskCreated: ["task_id", "task_subject", "task_description", "teammate_name", "team_name"],
	TaskCompleted: ["task_id", "task_subject", "task_description", "teammate_name", "team_name"],
	TeammateIdle: ["teammate_name", "team_name"],
};
const COMMON_KEYS = new Set(Object.keys(Common.shape).concat(["effort", "scratchpad_dir"]));

function countDropped(hookEventName: string, raw: Record<string, unknown>): number {
	const known = new Set(KNOWN_TOP_LEVEL[hookEventName] ?? []);
	let dropped = 0;
	for (const key of Object.keys(raw)) {
		if (!COMMON_KEYS.has(key) && !known.has(key)) dropped++;
	}
	return dropped;
}

function optStr(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}
function optBool(v: unknown): boolean | undefined {
	return typeof v === "boolean" ? v : undefined;
}
function optNum(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function responseBytes(v: unknown): number {
	if (v === undefined || v === null) return 0;
	if (typeof v === "string") return utf8Bytes(v);
	try {
		return utf8Bytes(JSON.stringify(v));
	} catch {
		return 0;
	}
}

/** `background_tasks[]` → only `id`, `type`, `status` (§4.2). */
function backgroundTasks(v: unknown): Array<{ id: string; type: string; status: string }> {
	if (!Array.isArray(v)) return [];
	const out: Array<{ id: string; type: string; status: string }> = [];
	for (const t of v.slice(0, 50)) {
		if (!t || typeof t !== "object") continue;
		const r = t as Record<string, unknown>;
		out.push({
			id: clipAux(optStr(r.id) ?? "", 128),
			type: clipAux(optStr(r.type) ?? "", 64),
			status: clipAux(optStr(r.status) ?? "", 64),
		});
	}
	return out;
}

function report(v: unknown): {
	last_assistant_message?: string;
	truncated?: true;
	original_bytes?: number;
} {
	const s = optStr(v);
	if (s === undefined) return {};
	const t = truncateUtf8(s, L3_REPORT_BYTES);
	return t.truncated
		? { last_assistant_message: t.value, truncated: true, original_bytes: t.originalBytes }
		: { last_assistant_message: t.value };
}

function toolCommon(
	raw: Record<string, unknown>,
): { tool_name: string; tool_use_id?: string } | null {
	const toolName = optStr(raw.tool_name);
	if (toolName === undefined) return null;
	const out: { tool_name: string; tool_use_id?: string } = { tool_name: clipAux(toolName, 128) };
	const id = optStr(raw.tool_use_id);
	if (id !== undefined) out.tool_use_id = id;
	return out;
}

function mcpServer(v: unknown): { name?: string; source?: string } | undefined {
	if (!v || typeof v !== "object") return undefined;
	const r = v as Record<string, unknown>;
	const out: { name?: string; source?: string } = {};
	const name = optStr(r.name);
	const source = optStr(r.source);
	if (name !== undefined) out.name = clipAux(name, 128);
	if (source !== undefined) out.source = clipAux(source, 64);
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Normalise one hook payload. `raw` is the parsed JSON body.
 */
export function normalizeHookInput(raw: unknown): NormalizeResult {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, reason: "malformed", detail: "body is not an object" };
	}
	const record = raw as Record<string, unknown>;
	const common = Common.safeParse(record);
	if (!common.success) {
		return {
			ok: false,
			reason: "malformed",
			hookEventName: optStr(record.hook_event_name),
			sessionId: optStr(record.session_id),
			detail: "missing hook_event_name or session_id",
		};
	}
	const c: CommonT = common.data;
	const base = {
		sessionId: c.session_id,
		promptId: c.prompt_id ?? null,
		turnId: null as string | null,
		agentId: c.agent_id ?? null,
		droppedFields: countDropped(c.hook_event_name, record),
	};
	const build = (
		ev: EventName,
		data: EventData,
		identity: NormalizedEvent["identity"] = {},
	): NormalizeResult => ({
		ok: true,
		event: { ...base, ev, data, identity },
	});
	const malformed = (detail: string): NormalizeResult => ({
		ok: false,
		reason: "malformed",
		hookEventName: c.hook_event_name,
		sessionId: c.session_id,
		detail,
	});

	switch (c.hook_event_name) {
		case "SessionStart": {
			const data: EventData = {};
			const source = optStr(record.source);
			if (source === undefined) return malformed("SessionStart without source");
			data.source = clipAux(source, 32);
			if (c.agent_type !== undefined) data.agent_type = clipAux(c.agent_type, 64);
			const model = optStr(record.model);
			if (model !== undefined) data.model = clipAux(model, 64);
			const title = optStr(record.session_title);
			if (title !== undefined) data.session_title = clipAux(title, L4_AUX_BYTES);
			if (c.cwd !== undefined) data.cwd = clipAux(c.cwd, 512);
			if (c.transcript_path !== undefined) data.transcript_path = clipAux(c.transcript_path, 512);
			// `st` is what session-start.sh adds (§2.3).
			const st =
				record.st && typeof record.st === "object" ? (record.st as Record<string, unknown>) : {};
			const version = optStr(st.claude_version);
			if (version !== undefined) data.claude_version = clipAux(version, 32);
			const tmuxSession = optStr(st.tmux_session);
			if (tmuxSession !== undefined) data.tmux_session = clipAux(tmuxSession, 64);
			const pane = optStr(st.pane);
			if (pane !== undefined) data.pane = clipAux(pane, 16);
			if (Array.isArray(st.argv_flags)) data.argv_flags = filterArgvFlags(st.argv_flags);
			else if (Array.isArray(st.argv)) data.argv_flags = filterArgvFlags(st.argv);
			return build("session_start", data);
		}
		case "SessionEnd": {
			const reason = optStr(record.reason);
			if (reason === undefined) return malformed("SessionEnd without reason");
			return build("session_end", { reason: clipAux(reason, 32) });
		}
		case "UserPromptSubmit": {
			const prompt = optStr(record.prompt);
			if (prompt === undefined) return malformed("UserPromptSubmit without prompt");
			const t = truncateUtf8(prompt, L1_PROMPT_BYTES);
			const data: EventData = { prompt: t.value };
			if (t.truncated) {
				data.truncated = true;
				data.original_bytes = t.originalBytes;
			}
			const source = optStr(record.source);
			if (source !== undefined) data.source = clipAux(source, 32);
			const title = optStr(record.session_title);
			if (title !== undefined) data.session_title = clipAux(title, L4_AUX_BYTES);
			return build("user_prompt", data);
		}
		case "MessageDisplay": {
			const messageId = optStr(record.message_id);
			const index = optNum(record.index);
			const final = optBool(record.final);
			const delta = optStr(record.delta);
			if (
				messageId === undefined ||
				index === undefined ||
				final === undefined ||
				delta === undefined
			) {
				return malformed("MessageDisplay missing message_id/index/final/delta");
			}
			const turnId = optStr(record.turn_id) ?? null;
			const result = build(
				"assistant_delta",
				{ message_id: messageId, index, final, delta },
				{ messageId, index },
			);
			if (result.ok) result.event.turnId = turnId;
			return result;
		}
		case "PreToolUse": {
			const tool = toolCommon(record);
			if (!tool) return malformed("PreToolUse without tool_name");
			const data: EventData = {
				...tool,
				summary: summarizeToolInput(tool.tool_name, record.tool_input),
			};
			const mcp = mcpServer(record.mcp_server);
			if (mcp) data.mcp_server = mcp;
			return build("tool_start", data, { toolUseId: tool.tool_use_id });
		}
		case "PostToolUse": {
			const tool = toolCommon(record);
			if (!tool) return malformed("PostToolUse without tool_name");
			const data: EventData = {
				...tool,
				ok: true,
				response_bytes: responseBytes(record.tool_response),
			};
			const duration = optNum(record.duration_ms);
			if (duration !== undefined) data.duration_ms = duration;
			return build("tool_end", data, { toolUseId: tool.tool_use_id });
		}
		case "PostToolUseFailure": {
			const tool = toolCommon(record);
			if (!tool) return malformed("PostToolUseFailure without tool_name");
			const data: EventData = {
				...tool,
				ok: false,
				...redactToolError(tool.tool_name, optStr(record.error) ?? ""),
			};
			const interrupt = optBool(record.is_interrupt);
			if (interrupt !== undefined) data.is_interrupt = interrupt;
			const duration = optNum(record.duration_ms);
			if (duration !== undefined) data.duration_ms = duration;
			return build("tool_failed", data, { toolUseId: tool.tool_use_id });
		}
		case "Stop": {
			const tasks = backgroundTasks(record.background_tasks);
			const data: EventData = {
				stop_hook_active: optBool(record.stop_hook_active) ?? false,
				...report(record.last_assistant_message),
				background_tasks: tasks,
				session_crons_count: Array.isArray(record.session_crons) ? record.session_crons.length : 0,
			};
			return build("turn_end", data);
		}
		case "StopFailure": {
			const error = optStr(record.error);
			if (error === undefined) return malformed("StopFailure without error");
			const data: EventData = { error: clipAux(error, 64) };
			const details = optStr(record.error_details);
			if (details !== undefined) data.error_details = clipAux(details, ERROR_TEXT_BYTES);
			return build("turn_failed", data);
		}
		case "SubagentStart": {
			if (!c.agent_id) return malformed("SubagentStart without agent_id");
			return build("agent_start", {
				agent_id: c.agent_id,
				agent_type: clipAux(c.agent_type ?? "", 64),
			});
		}
		case "SubagentStop": {
			if (!c.agent_id) return malformed("SubagentStop without agent_id");
			const data: EventData = {
				agent_id: c.agent_id,
				agent_type: clipAux(c.agent_type ?? "", 64),
				...report(record.last_assistant_message),
				background_tasks: backgroundTasks(record.background_tasks),
			};
			const transcript = optStr(record.agent_transcript_path);
			if (transcript !== undefined) data.agent_transcript_path = clipAux(transcript, 512);
			return build("agent_end", data);
		}
		case "Notification": {
			const type = optStr(record.notification_type);
			if (type === undefined) return malformed("Notification without notification_type");
			return build(
				"notification",
				redactNotification(clipAux(type, 64), optStr(record.message), optStr(record.title)),
			);
		}
		case "PermissionRequest": {
			const toolName = optStr(record.tool_name);
			if (toolName === undefined) return malformed("PermissionRequest without tool_name");
			return build("permission_request", {
				tool_name: clipAux(toolName, 128),
				summary: summarizeToolInput(toolName, record.tool_input) as ToolSummary,
			});
		}
		case "PreCompact":
		case "PostCompact": {
			const trigger = optStr(record.trigger);
			return build("compact", {
				phase: c.hook_event_name === "PreCompact" ? "pre" : "post",
				trigger: clipAux(trigger ?? "", 16),
			});
		}
		case "TaskCreated":
		case "TaskCompleted": {
			const taskId = optStr(record.task_id);
			if (taskId === undefined) return malformed(`${c.hook_event_name} without task_id`);
			const data: EventData = {
				task_id: clipAux(taskId, 128),
				task_subject: clipAux(optStr(record.task_subject) ?? "", L4_AUX_BYTES),
			};
			const teammate = optStr(record.teammate_name);
			if (teammate !== undefined) data.teammate_name = clipAux(teammate, 128);
			return build(c.hook_event_name === "TaskCreated" ? "task_created" : "task_completed", data, {
				taskId,
			});
		}
		case "TeammateIdle": {
			const teammate = optStr(record.teammate_name);
			if (teammate === undefined) return malformed("TeammateIdle without teammate_name");
			return build(
				"teammate_idle",
				{ teammate_name: clipAux(teammate, 128) },
				{ teammateName: teammate },
			);
		}
		default:
			return malformed(`unsupported hook ${c.hook_event_name}`);
	}
}
