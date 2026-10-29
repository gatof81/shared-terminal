/**
 * internalPrompt.ts — which `UserPromptSubmit` payloads are NOT a human
 * prompt (docs/CONVERSATION.md §4.2.1).
 *
 * Claude Code delivers some of its own notifications to the model through
 * the user-prompt channel: when a background task (an `Agent`, a background
 * Bash) finishes, the CLI injects a synthetic prompt shaped as
 *
 *     <task-notification>
 *     <task-id>…</task-id>
 *     <tool-use-id>toolu_…</tool-use-id>
 *     <status>completed</status>
 *     …
 *     </task-notification>
 *
 * and fires `UserPromptSubmit` for it exactly as for typed input (observed
 * with CLI 2.1.308 in the 3.1 pilot: `agent_end`, then this prompt 69 ms
 * later, then the assistant's next turn). Capturing it as `user_prompt`
 * misattributes it to the person and can even become the conversation's
 * title.
 *
 * The recognizer is deliberately strict and structural: the WHOLE trimmed
 * prompt must be exactly one `<task-notification>` block, and the three
 * identifying children must each appear exactly once with well-formed
 * values. Anything else is a human prompt — a person who mentions the tag
 * in a sentence, pastes a notification and then adds a question, or
 * writes two blocks, stays "You". A prompt that has the block's shape but
 * fails validation is `unverified`: the view does not call it human and
 * does not call it internal, and the title never comes from it.
 *
 * Mirrored byte-for-byte in `frontend/src/internalPrompt.ts`, where it
 * re-classifies events persisted as `user_prompt` before this existed; the
 * two test files share their vectors. Keep them identical.
 */

export interface TaskNotification {
	taskId: string;
	toolUseId: string;
	status: string;
}

export type PromptClass =
	| { kind: "human" }
	| { kind: "unverified"; reason: string }
	| { kind: "internal"; notice: "task-notification"; notification: TaskNotification };

const OPEN = "<task-notification>";
const CLOSE = "</task-notification>";

// Ids as the CLI prints them: a short task id, an Anthropic `toolu_` tool-use
// id and a one-word status. Bounded, so a verified value never carries free
// text into the persisted record.
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOOL_USE_ID = /^toolu_[A-Za-z0-9]{8,64}$/;
const STATUS = /^[a-z][a-z_-]{0,31}$/;

export function classifyPrompt(prompt: string): PromptClass {
	const s = prompt.trim();
	if (!s.startsWith(OPEN) || !s.endsWith(CLOSE)) return { kind: "human" };
	const unverified = (reason: string): PromptClass => ({ kind: "unverified", reason });
	// Exactly one block: a second opening tag anywhere, or a closing tag
	// before the end, means the text is more than one notification.
	if (s.indexOf(OPEN, 1) !== -1 || s.indexOf(CLOSE) !== s.length - CLOSE.length) {
		return unverified("multiple-blocks");
	}
	const body = s.slice(OPEN.length, s.length - CLOSE.length);
	// The CLI's fixed order: task-id, then tool-use-id, then status (other
	// children, e.g. output-file or summary, may sit between). Each of the
	// three must open and close exactly once, in that order, with no stray
	// opening or closing tag anywhere in the block.
	const taskId = child(body, "task-id");
	const toolUseId = child(body, "tool-use-id");
	const status = child(body, "status");
	if (taskId === null || toolUseId === null || status === null) return unverified("missing-field");
	if (!(taskId.end < toolUseId.start && toolUseId.end < status.start)) return unverified("order");
	if (!TASK_ID.test(taskId.value)) return unverified("task-id");
	if (!TOOL_USE_ID.test(toolUseId.value)) return unverified("tool-use-id");
	if (!STATUS.test(status.value)) return unverified("status");
	return {
		kind: "internal",
		notice: "task-notification",
		notification: { taskId: taskId.value, toolUseId: toolUseId.value, status: status.value },
	};
}

interface Child {
	value: string;
	/** Offset of the opening tag in the block body. */
	start: number;
	/** Offset just past the closing tag. */
	end: number;
}

/**
 * `<tag>…</tag>` when the block body holds exactly ONE opening and exactly
 * ONE closing tag for `tag`, the opening first and the value free of `<`;
 * `null` for anything else — a stray closing tag before the opening, a
 * repeated opening, a missing or doubled closing. Not an XML parser: a
 * strict check of the one shape the CLI prints.
 */
function child(body: string, tag: string): Child | null {
	const open = `<${tag}>`;
	const close = `</${tag}>`;
	if (count(body, open) !== 1 || count(body, close) !== 1) return null;
	const start = body.indexOf(open);
	const closeAt = body.indexOf(close);
	if (closeAt < start + open.length) return null;
	const value = body.slice(start + open.length, closeAt);
	if (value.includes("<")) return null;
	return { value: value.trim(), start, end: closeAt + close.length };
}

function count(haystack: string, needle: string): number {
	let n = 0;
	for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length))
		n++;
	return n;
}
