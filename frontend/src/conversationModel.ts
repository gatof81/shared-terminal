/**
 * conversationModel.ts — persisted conversation events → what the Chat view
 * shows (docs/CONVERSATION.md §4.2, §4.5, §10 "3.1 vista"). Pure: no DOM,
 * no network, so the representation rules are unit-tested.
 *
 * Rules the contract pins:
 *   - Tools are keyed by `tool_use_id`. With CLI 2.1.308 a failing Bash
 *     sends `tool_start → tool_failed → tool_end` for the same id; that is
 *     ONE tool, and a failure wins over a success whatever the arrival
 *     order. Tool counts count distinct ids, never events.
 *   - Assistant text arrives as `assistant_delta` fragments per
 *     `message_id`, in `index` order; a hole in the indexes is shown as a
 *     lost fragment, never papered over.
 *   - Events with an `agent_id` belong to a subagent: they stay out of the
 *     main thread and are grouped per agent; the thread keeps one compact
 *     marker where each agent started and ended.
 *   - A turn's report (`turn_end.last_assistant_message`) is attached to
 *     the assistant message it repeats, so the thread shows the final
 *     answer once, marked as the report, with its bytes kept intact for
 *     "Copy report"; a report with no matching message stays its own item.
 *   - `gap` and `truncated` are always visible.
 *   - A `UserPromptSubmit` is not always the person: the CLI delivers its
 *     own task notifications through it (§4.2.1). New captures persist them
 *     as `internal_prompt`; a `user_prompt` persisted before that is
 *     re-classified here with the same strict recognizer, so the history
 *     already on disk reads right without being rewritten. Neither is ever
 *     "You", and both start a new turn for the report matching.
 */

import { classifyPrompt } from "./internalPrompt";

export interface ConversationEvent {
	seq: number;
	ts: string;
	ev: string;
	prompt_id: string | null;
	turn_id: string | null;
	agent_id: string | null;
	pane: string | null;
	data: Record<string, unknown>;
}

export interface ReportInfo {
	/** `last_assistant_message`, byte for byte as persisted. */
	text: string;
	truncated: boolean;
	originalBytes: number | null;
}

export type ThreadItem =
	| {
			kind: "user";
			key: string;
			seq: number;
			ts: string;
			text: string;
			truncated: boolean;
			/** `user_prompt.source` when not the person (`system`, `sdk`, …); null for a typed prompt. */
			source: string | null;
			/** `unverified`: shaped like a CLI notification but not a valid one — not called "You". */
			origin: "human" | "unverified";
	  }
	| {
			/** The CLI's own task notification (§4.2.1): a background tool finished and its result went to the model. */
			kind: "internal";
			key: string;
			seq: number;
			ts: string;
			taskId: string;
			toolUseId: string;
			status: string;
			/** The finished tool, when its `tool_start` is in the window. */
			toolName: string | null;
			/** The subagent it reports on, when it can be correlated (task id = agent id, or the Agent tool's start → the next agent_start). */
			agentId: string | null;
			agentType: string | null;
			/** Re-classified from a `user_prompt` persisted before `internal_prompt` existed. */
			legacy: boolean;
	  }
	| {
			kind: "assistant";
			key: string;
			seq: number;
			ts: string;
			messageId: string;
			/** Text with `[… fragment lost …]` where an index is missing. */
			text: string;
			final: boolean;
			truncated: boolean;
			missingFragments: number;
			/** Set when a `turn_end` reported exactly this text: the turn's final answer. */
			report: ReportInfo | null;
	  }
	| {
			kind: "tool";
			key: string;
			seq: number;
			ts: string;
			toolUseId: string;
			toolName: string;
			summary: Record<string, unknown>;
			state: "running" | "ok" | "failed" | "interrupted";
			durationMs: number | null;
			error: string | null;
	  }
	| ({ kind: "report"; key: string; seq: number; ts: string } & ReportInfo)
	| { kind: "marker"; key: string; seq: number; ts: string; tone: "info" | "warn"; text: string }
	| {
			kind: "agent";
			key: string;
			seq: number;
			ts: string;
			agentId: string;
			agentType: string;
			phase: "start" | "end";
	  };

export interface AgentView {
	agentId: string;
	agentType: string;
	status: "running" | "done";
	startedSeq: number;
	startedAt: string;
	endedAt: string | null;
	toolIds: Set<string>;
	/** Distinct tools that reported a failure. */
	failedToolIds: Set<string>;
	result: string | null;
	resultTruncated: boolean;
}

export interface ThreadModel {
	items: ThreadItem[];
	agents: AgentView[];
	/** Distinct `tool_use_id`s in the main thread. */
	toolCount: number;
}

const LOST_FRAGMENT = "[… fragment lost …]";

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}
function num(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** "HH:MM" in the viewer's local time. */
export function clock(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** One line for a tool card, from the redacted summary only (§4.3.1). */
export function toolLine(name: string, summary: Record<string, unknown>): string {
	const parts: string[] = [];
	if (Array.isArray(summary.programs) && summary.programs.length > 0) {
		parts.push(summary.programs.map(String).join(" | "));
	} else if (summary.programs_omitted) {
		parts.push("command");
	}
	for (const k of ["file_path", "path", "host", "subagent_type", "description"]) {
		if (typeof summary[k] === "string" && summary[k]) parts.push(summary[k] as string);
	}
	if (typeof summary.command_bytes === "number") parts.push(`${summary.command_bytes} B`);
	if (Array.isArray(summary.keys) && summary.keys.length > 0) {
		parts.push(`{${summary.keys.map(String).join(", ")}}`);
	}
	return parts.length > 0 ? `${name} · ${parts.join(" · ")}` : name;
}

/** The text shown for a `gap` (§4.5). */
export function gapText(data: Record<string, unknown>, ts: string): string {
	const n = num(data.dropped);
	const at = clock(ts);
	switch (str(data.reason)) {
		case "rate_limited":
			return `${n ?? "Some"} events skipped (volume limit)`;
		case "backpressure":
			return `${n ?? "Some"} events skipped (backend saturated)`;
		case "malformed":
			return "Unrecognised or oversized event (CLI version?)";
		case "missing_delta":
			return "A fragment of a message was lost";
		case "missing_prompt":
			return "Prompt not captured";
		case "backend_restart":
			return `Possible lost activity around ${at} (backend restarted)`;
		case "rotated":
			return "Earlier history archived";
		case "revoked":
			return `Capture revoked at ${at}`;
		case "relay_dropped":
			return `${n ?? "Some"} events not delivered by the container`;
		case "relay_restart":
			return "Possible lost activity (relay restarted)";
		case "history_rotated":
			return "Earlier events are no longer available";
		case "history_unavailable":
			return "History before capture was enabled is not available";
		default:
			return `Events missing (${str(data.reason) || "unknown reason"})`;
	}
}

/**
 * The thread line for a `composer_send` state (§8.1.8), or null for the
 * states the thread does not show: `prepared`/`entered`/`released` are
 * bookkeeping, and a `delivered` send is the `user_prompt` that follows.
 */
export function composerSendText(
	data: Record<string, unknown>,
): { tone: "info" | "warn"; text: string } | null {
	switch (str(data.state)) {
		case "failed":
			return {
				tone: "warn",
				text: `Send from Chat failed part-way (${str(data.stage) || "paste"}) — part of the text may be in the terminal's input. Check the Terminal before sending again.`,
			};
		case "uncertain":
			return {
				tone: "warn",
				text:
					str(data.orphaned) === "true" || data.orphaned === true
						? "A send from Chat was interrupted by a backend restart; the pane stays blocked until an operator verifies it."
						: "A send from Chat has an unknown outcome; the pane stays blocked until it is verified.",
			};
		case "unconfirmed":
			return {
				tone: "info",
				text: "A send from Chat was not confirmed by Claude Code — check the Terminal.",
			};
		case "misdelivered":
			return {
				tone: "info",
				text: "A send from Chat landed in another conversation of this pane.",
			};
		case "resolved":
			return {
				tone: "info",
				text: `An operator marked a send from Chat as ${str(data.outcome) || "resolved"}.`,
			};
		default:
			return null;
	}
}

interface MessageAcc {
	item: Extract<ThreadItem, { kind: "assistant" }>;
	fragments: Map<number, string>;
}
interface ToolAcc {
	item: Extract<ThreadItem, { kind: "tool" }>;
	failed: boolean;
	ended: boolean;
}

/** Build the thread from events in ascending `seq` (a contiguous window). */
export function buildThread(events: readonly ConversationEvent[]): ThreadModel {
	const items: ThreadItem[] = [];
	const messages = new Map<string, MessageAcc>();
	const tools = new Map<string, ToolAcc>();
	const agents = new Map<string, AgentView>();
	// Agent tool → subagent correlation (§4.2.1): the CLI gives the agent no
	// tool_use_id, so the Agent tool_starts of the main thread are matched
	// to agent_starts in order of appearance. Best effort, display only.
	const pendingAgentTools: string[] = [];
	const agentByTool = new Map<string, string>();

	const pushInternal = (
		e: ConversationEvent,
		n: { taskId: string; toolUseId: string; status: string },
		legacy: boolean,
	): void => {
		const agentId = agents.has(n.taskId) ? n.taskId : (agentByTool.get(n.toolUseId) ?? null);
		items.push({
			kind: "internal",
			key: `i${e.seq}`,
			seq: e.seq,
			ts: e.ts,
			taskId: n.taskId,
			toolUseId: n.toolUseId,
			status: n.status,
			toolName: tools.get(n.toolUseId)?.item.toolName ?? null,
			agentId,
			agentType: agentId ? (agents.get(agentId)?.agentType ?? "") : null,
			legacy,
		});
	};

	const agentOf = (id: string, type: string, seq: number, ts: string): AgentView => {
		let a = agents.get(id);
		if (!a) {
			a = {
				agentId: id,
				agentType: type,
				status: "running",
				startedSeq: seq,
				startedAt: ts,
				endedAt: null,
				toolIds: new Set(),
				failedToolIds: new Set(),
				result: null,
				resultTruncated: false,
			};
			agents.set(id, a);
		}
		if (type && !a.agentType) a.agentType = type;
		return a;
	};

	// 3.2: a send whose outcome was unknown at T_http but that later reached a
	// final state is not shown as unknown (the final state is the truth).
	const composerFinal = new Set<string>();
	for (const e of events) {
		if (e.ev !== "composer_send") continue;
		const d = e.data as Record<string, unknown>;
		const state = typeof d.state === "string" ? d.state : "";
		if (
			state === "delivered" ||
			state === "unconfirmed" ||
			state === "misdelivered" ||
			state === "failed" ||
			state === "resolved" ||
			state === "released"
		)
			composerFinal.add(String(d.client_message_id ?? ""));
	}

	for (const e of events) {
		const d = e.data ?? {};
		// Subagent activity: grouped per agent, out of the main thread.
		if (e.agent_id && e.ev !== "agent_start" && e.ev !== "agent_end") {
			const a = agentOf(e.agent_id, "", e.seq, e.ts);
			const toolId = str(d.tool_use_id) || `seq-${e.seq}`;
			if (e.ev === "tool_start") a.toolIds.add(toolId);
			if (e.ev === "tool_failed") {
				a.toolIds.add(toolId);
				a.failedToolIds.add(toolId);
			}
			continue;
		}
		switch (e.ev) {
			case "user_prompt": {
				const text = str(d.prompt);
				// History persisted before §4.2.1: the same recognizer, so a
				// notification stored as a prompt is never shown as the person's.
				const cls = classifyPrompt(text);
				if (cls.kind === "internal") {
					pushInternal(e, cls.notification, true);
					break;
				}
				const source = str(d.source);
				items.push({
					kind: "user",
					key: `u${e.seq}`,
					seq: e.seq,
					ts: e.ts,
					text,
					truncated: d.truncated === true,
					source: source && source !== "user" ? source : null,
					origin: cls.kind === "unverified" || d.origin === "unverified" ? "unverified" : "human",
				});
				break;
			}
			case "internal_prompt":
				pushInternal(
					e,
					{ taskId: str(d.task_id), toolUseId: str(d.tool_use_id), status: str(d.status) },
					false,
				);
				break;
			case "assistant_delta": {
				const id = str(d.message_id) || `seq-${e.seq}`;
				let acc = messages.get(id);
				if (!acc) {
					acc = {
						item: {
							kind: "assistant",
							key: `m${id}`,
							seq: e.seq,
							ts: e.ts,
							messageId: id,
							text: "",
							final: false,
							truncated: false,
							missingFragments: 0,
							report: null,
						},
						fragments: new Map(),
					};
					messages.set(id, acc);
					items.push(acc.item);
				}
				const idx = num(d.index) ?? acc.fragments.size;
				if (!acc.fragments.has(idx)) acc.fragments.set(idx, str(d.delta));
				if (d.final === true) acc.item.final = true;
				if (d.truncated === true) acc.item.truncated = true;
				const ordered = [...acc.fragments.keys()].sort((a, b) => a - b);
				let text = "";
				let missing = 0;
				let expect = 0;
				for (const i of ordered) {
					if (i > expect) {
						missing++;
						text += LOST_FRAGMENT;
					}
					text += acc.fragments.get(i);
					expect = i + 1;
				}
				acc.item.text = text;
				acc.item.missingFragments = missing;
				break;
			}
			case "tool_start":
			case "tool_end":
			case "tool_failed": {
				const id = str(d.tool_use_id) || `seq-${e.seq}`;
				let acc = tools.get(id);
				if (!acc) {
					acc = {
						item: {
							kind: "tool",
							key: `t${id}`,
							seq: e.seq,
							ts: e.ts,
							toolUseId: id,
							toolName: str(d.tool_name) || "tool",
							summary: {},
							state: "running",
							durationMs: null,
							error: null,
						},
						failed: false,
						ended: false,
					};
					tools.set(id, acc);
					items.push(acc.item);
				}
				const it = acc.item;
				if (!it.toolName || it.toolName === "tool") it.toolName = str(d.tool_name) || it.toolName;
				if (e.ev === "tool_start") {
					if (d.summary && typeof d.summary === "object") {
						it.summary = d.summary as Record<string, unknown>;
					}
					if (it.toolName === "Agent") pendingAgentTools.push(id);
				} else {
					acc.ended = true;
					const dur = num(d.duration_ms);
					if (dur !== null && (it.durationMs === null || e.ev === "tool_failed")) {
						it.durationMs = dur;
					}
					if (e.ev === "tool_failed") {
						acc.failed = true;
						it.state = d.is_interrupt === true ? "interrupted" : "failed";
						if (typeof d.error === "string") it.error = d.error;
					} else if (!acc.failed) {
						it.state = "ok";
					}
				}
				break;
			}
			case "turn_end": {
				const report: ReportInfo = {
					text: str(d.last_assistant_message),
					truncated: d.truncated === true,
					originalBytes: num(d.original_bytes),
				};
				// The report repeats the turn's last assistant message. When
				// that message is in the window with the same bytes, mark it
				// as the report instead of showing the text twice; tools and
				// markers may sit between the two, a user prompt may not.
				const target = lastAssistantOfTurn(items);
				if (target && report.text !== "" && target.text === report.text) {
					target.report = report;
					target.final = true;
				} else {
					items.push({ kind: "report", key: `r${e.seq}`, seq: e.seq, ts: e.ts, ...report });
				}
				break;
			}
			case "turn_failed":
				items.push({
					kind: "marker",
					key: `x${e.seq}`,
					seq: e.seq,
					ts: e.ts,
					tone: "warn",
					text: `Turn failed: ${str(d.error) || "error"}`,
				});
				break;
			case "agent_start":
			case "agent_end": {
				const a = agentOf(str(d.agent_id) || `seq-${e.seq}`, str(d.agent_type), e.seq, e.ts);
				if (e.ev === "agent_start") {
					const toolId = pendingAgentTools.shift();
					if (toolId !== undefined) agentByTool.set(toolId, a.agentId);
				}
				if (e.ev === "agent_end") {
					a.status = "done";
					a.endedAt = e.ts;
					if (typeof d.last_assistant_message === "string") {
						a.result = d.last_assistant_message;
						a.resultTruncated = d.truncated === true;
					}
				}
				items.push({
					kind: "agent",
					key: `a${e.seq}`,
					seq: e.seq,
					ts: e.ts,
					agentId: a.agentId,
					agentType: a.agentType,
					phase: e.ev === "agent_start" ? "start" : "end",
				});
				break;
			}
			case "gap":
				items.push({
					kind: "marker",
					key: `g${e.seq}`,
					seq: e.seq,
					ts: e.ts,
					tone: "warn",
					text: gapText(d, e.ts),
				});
				break;
			case "composer_send": {
				// 3.2 (§8.1.8): bookkeeping states stay out of the thread; a
				// failed, uncertain, unconfirmed, misdelivered or resolved send
				// is a marker, once per state. A delivered send is the
				// `user_prompt` that follows it.
				const superseded =
					d.state === "uncertain" && composerFinal.has(String(d.client_message_id ?? ""));
				const line = superseded ? null : composerSendText(d);
				if (line) {
					items.push({
						kind: "marker",
						key: `cs${e.seq}`,
						seq: e.seq,
						ts: e.ts,
						tone: line.tone,
						text: line.text,
					});
				}
				break;
			}
			case "compact":
				if (d.phase === "post") {
					items.push({
						kind: "marker",
						key: `c${e.seq}`,
						seq: e.seq,
						ts: e.ts,
						tone: "info",
						text: "Conversation compacted",
					});
				}
				break;
			case "session_start": {
				const source = str(d.source);
				if (source === "resume" || source === "compact" || source === "clear") {
					items.push({
						kind: "marker",
						key: `s${e.seq}`,
						seq: e.seq,
						ts: e.ts,
						tone: "info",
						text:
							source === "resume"
								? "Conversation resumed"
								: source === "clear"
									? "Conversation cleared"
									: "Continued after compaction",
					});
				}
				break;
			}
			case "session_end":
				items.push({
					kind: "marker",
					key: `e${e.seq}`,
					seq: e.seq,
					ts: e.ts,
					tone: "info",
					text: `Session ended${str(d.reason) ? ` (${str(d.reason)})` : ""}`,
				});
				break;
			case "permission_request":
				items.push({
					kind: "marker",
					key: `p${e.seq}`,
					seq: e.seq,
					ts: e.ts,
					tone: "warn",
					text: `Permission requested: ${toolLine(str(d.tool_name) || "tool", (d.summary as Record<string, unknown>) ?? {})}`,
				});
				break;
			default:
				// notification, probe, tasks, teammates…: status evidence, not thread content.
				break;
		}
	}
	return {
		items,
		agents: [...agents.values()].sort((a, b) => a.startedSeq - b.startedSeq),
		toolCount: tools.size,
	};
}

/** The most recent assistant message of the current turn, if the turn has one. */
function lastAssistantOfTurn(
	items: ThreadItem[],
): Extract<ThreadItem, { kind: "assistant" }> | null {
	for (let i = items.length - 1; i >= 0; i--) {
		const it = items[i];
		if (it.kind === "assistant") return it.report ? null : it;
		// A prompt — the person's or the CLI's notification — starts a new turn.
		if (it.kind === "user" || it.kind === "internal" || it.kind === "report") return null;
	}
	return null;
}

// ── Blocks (what the view lays out) ─────────────────────────────────────────

export type ToolItem = Extract<ThreadItem, { kind: "tool" }>;

/**
 * The thread as the view lays it out: every item on its own, except that
 * consecutive tool calls form one `tools` block — a run of 15 edits reads
 * as one activity strip, not 15 cards. Keys are stable across renders
 * (the first tool's key), so a block can keep its DOM while it grows.
 */
export type ThreadBlock =
	| { kind: "item"; key: string; item: Exclude<ThreadItem, ToolItem> }
	| { kind: "tools"; key: string; tools: ToolItem[] };

export function groupBlocks(items: readonly ThreadItem[]): ThreadBlock[] {
	const out: ThreadBlock[] = [];
	for (const item of items) {
		if (item.kind === "tool") {
			const last = out[out.length - 1];
			if (last && last.kind === "tools") last.tools.push(item);
			else out.push({ kind: "tools", key: `T${item.key}`, tools: [item] });
		} else {
			out.push({ kind: "item", key: item.key, item });
		}
	}
	return out;
}

/** Summary of a tools block for its collapsed header. */
export function toolsSummary(tools: readonly ToolItem[]): {
	count: number;
	failed: number;
	running: number;
	names: string[];
	durationMs: number | null;
} {
	const names: string[] = [];
	let failed = 0;
	let running = 0;
	let durationMs: number | null = null;
	for (const t of tools) {
		if (!names.includes(t.toolName)) names.push(t.toolName);
		if (t.state === "failed" || t.state === "interrupted") failed++;
		if (t.state === "running") running++;
		if (t.durationMs !== null) durationMs = (durationMs ?? 0) + t.durationMs;
	}
	return { count: tools.length, failed, running, names, durationMs };
}

// ── Status presentation ─────────────────────────────────────────────────────

export const STATUS_LABEL: Record<string, string> = {
	running: "Working",
	waiting_input: "Waiting for input",
	waiting_background: "Background tasks",
	waiting_permission: "Needs permission",
	error: "Error",
	ending: "Ending",
	ended: "Ended",
	disconnected: "Disconnected",
	unknown: "Unknown",
};

/** Colour family of a status: what the chip and the list dot use. */
export function statusTone(
	status: string,
): "active" | "ready" | "attention" | "error" | "done" | "muted" {
	switch (status) {
		case "running":
		case "waiting_background":
			return "active";
		case "waiting_input":
			return "ready";
		case "waiting_permission":
			return "attention";
		case "error":
			return "error";
		case "ended":
		case "ending":
			return "done";
		default:
			return "muted";
	}
}

/** A status that claims activity but whose evidence is older than this is shown as stale. */
export const STALE_EVIDENCE_MS = 10 * 60 * 1000;

/** True when the status is a live claim ("working", "waiting") that time can falsify. */
export function statusIsLiveClaim(status: string): boolean {
	return (
		status === "running" ||
		status === "waiting_input" ||
		status === "waiting_background" ||
		status === "waiting_permission"
	);
}

// ── Event window (L8) ───────────────────────────────────────────────────────

/** L8 — at most this many events / bytes held for the DOM. */
export const WINDOW_MAX_EVENTS = 500;
export const WINDOW_MAX_BYTES = 8 * 1024 * 1024;

/**
 * A contiguous, ascending window of a conversation's events. Live events
 * append only while the window reaches the newest event (`atLatest`);
 * growing past the L8 budget drops from the far end and remembers that
 * there is more there.
 */
export class EventWindow {
	events: ConversationEvent[] = [];
	private bytes: number[] = [];
	private total = 0;
	/** Older events exist on the server (load earlier). */
	hasOlder = false;
	/** The window ends at the newest known event. */
	atLatest = true;
	/**
	 * Events newer than the window's end that it does not hold: dropped from
	 * the newest end by L8 when an older page landed, or arrived live while
	 * not at the latest (for "N newer events · Jump to latest").
	 */
	newerUnseen = 0;
	/** Highest seq received from the server, in the window or not. */
	lastSeq = 0;

	reset(): void {
		this.events = [];
		this.bytes = [];
		this.total = 0;
		this.hasOlder = false;
		this.atLatest = true;
		this.newerUnseen = 0;
		this.lastSeq = 0;
	}

	firstSeq(): number | null {
		return this.events[0]?.seq ?? null;
	}

	/** The newest page (from `GET …/events`). */
	setLatest(events: ConversationEvent[], hasOlder: boolean): void {
		this.reset();
		for (const e of events) this.pushBack(e);
		this.hasOlder = hasOlder || this.hasOlder;
		this.lastSeq = Math.max(this.lastSeq, this.events[this.events.length - 1]?.seq ?? 0);
	}

	/** A live event. Returns true when the window changed. */
	append(e: ConversationEvent): boolean {
		if (e.seq <= this.lastSeq) return false; // duplicate
		this.lastSeq = e.seq;
		if (!this.atLatest) {
			this.newerUnseen++;
			return false;
		}
		this.pushBack(e);
		while (this.events.length > 1 && this.overBudget()) {
			this.events.shift();
			this.total -= this.bytes.shift() ?? 0;
			this.hasOlder = true;
		}
		return true;
	}

	/** An older page (ascending, all < firstSeq). */
	prepend(events: ConversationEvent[], hasOlder: boolean): void {
		const first = this.firstSeq() ?? Number.POSITIVE_INFINITY;
		const older = events.filter((e) => e.seq < first);
		const sizes = older.map(sizeOf);
		this.events = [...older, ...this.events];
		this.bytes = [...sizes, ...this.bytes];
		this.total += sizes.reduce((a, b) => a + b, 0);
		this.hasOlder = hasOlder;
		while (this.events.length > 1 && this.overBudget()) {
			this.events.pop();
			this.total -= this.bytes.pop() ?? 0;
			this.atLatest = false;
			// Dropped, not forgotten: the reader is told they exist beyond the window.
			this.newerUnseen++;
		}
	}

	private pushBack(e: ConversationEvent): void {
		const s = sizeOf(e);
		this.events.push(e);
		this.bytes.push(s);
		this.total += s;
	}

	private overBudget(): boolean {
		return this.events.length > WINDOW_MAX_EVENTS || this.total > WINDOW_MAX_BYTES;
	}
}

function sizeOf(e: ConversationEvent): number {
	// UTF-16 length × 2 bounds the in-memory size; good enough for L8.
	return JSON.stringify(e.data ?? {}).length * 2 + 128;
}
