/**
 * conversation/state.ts — docs/CONVERSATION.md §5.3: the evidence-based
 * conversation state machine, as a pure function so the whole table is
 * one data-driven test.
 *
 * Inputs are either persisted events (hooks), probe results, or
 * lifecycle facts (container down, silence). Every transition records
 * the evidence string the UI shows ("waiting_input · hook:Stop · 18:21").
 * Priority between a hook and a probe is decided by `at` (§5.3): a newer
 * probe overrides an older hook and vice versa, which `apply` enforces by
 * refusing inputs older than the current `at`.
 */

export type ConversationStatus =
	| "running"
	| "waiting_input"
	| "waiting_background"
	| "waiting_permission"
	| "error"
	| "ending"
	| "ended"
	| "disconnected"
	| "unknown";

export interface ConversationState {
	status: ConversationStatus;
	evidence: string;
	/** ms since epoch of the input that produced this state. */
	at: number;
}

export type ProbeStatus = "busy" | "waiting" | "idle";

export type StateInput =
	| { kind: "event"; ev: "user_prompt"; source?: string; at: number }
	| { kind: "event"; ev: "turn_end"; backgroundTasks: number; at: number }
	| { kind: "event"; ev: "turn_failed"; at: number }
	| { kind: "event"; ev: "notification"; notificationType: string; at: number }
	| { kind: "event"; ev: "permission_request"; at: number }
	| { kind: "event"; ev: "tool_start" | "tool_end" | "tool_failed"; at: number }
	| { kind: "event"; ev: "session_end"; at: number }
	| { kind: "event"; ev: "session_start"; source?: string; at: number }
	| {
			kind: "event";
			ev:
				| "assistant_delta"
				| "agent_start"
				| "agent_end"
				| "compact"
				| "task_created"
				| "task_completed"
				| "teammate_idle";
			at: number;
	  }
	| { kind: "end_grace_elapsed"; at: number }
	| { kind: "probe"; found: false; at: number }
	| { kind: "probe"; found: true; status: ProbeStatus; waitingFor?: string; at: number }
	| { kind: "container_down"; at: number }
	| { kind: "container_up"; at: number }
	| { kind: "silence"; at: number };

export const INITIAL_STATE: ConversationState = { status: "unknown", evidence: "created", at: 0 };

function next(status: ConversationStatus, evidence: string, at: number): ConversationState {
	return { status, evidence, at };
}

/**
 * Apply one input. Returns the same object when nothing changes, so
 * callers can `!==`-compare to decide whether to persist a status row.
 */
export function applyStateInput(state: ConversationState, input: StateInput): ConversationState {
	// §5.3 priority: evidence older than what we already hold never wins.
	// Strictly older only — equal timestamps (same-millisecond hook burst)
	// still apply in arrival order.
	if (input.at < state.at) return state;

	switch (input.kind) {
		case "event":
			return applyEvent(state, input);
		case "end_grace_elapsed":
			return state.status === "ending" ? next("ended", "hook:SessionEnd", input.at) : state;
		case "probe":
			if (!input.found) return next("ended", "probe:absent", input.at);
			if (input.status === "busy") return next("running", "probe:busy", input.at);
			if (input.status === "idle") return next("waiting_input", "probe:idle", input.at);
			// waiting
			if (input.waitingFor === "permission prompt") {
				return next("waiting_permission", "probe:waiting", input.at);
			}
			return next("waiting_input", "probe:waiting", input.at);
		case "container_down":
			return next("disconnected", "reconcile", input.at);
		case "container_up":
			return state.status === "disconnected" ? next("unknown", "reconcile", input.at) : state;
		case "silence":
			return state.status === "ended" || state.status === "disconnected"
				? state
				: next("unknown", "timeout", input.at);
	}
}

function applyEvent(
	state: ConversationState,
	input: Extract<StateInput, { kind: "event" }>,
): ConversationState {
	// Any event from a session that was `ending` reopens it (§4.6).
	const base = state.status === "ending" ? next("unknown", "reopened", input.at) : state;
	switch (input.ev) {
		case "user_prompt":
			// Injected turns (`source: system|sdk|…`) still mean the agent is
			// working on something; the UI marks them differently, the
			// state does not.
			return next("running", "hook:UserPromptSubmit", input.at);
		case "turn_end":
			return input.backgroundTasks > 0
				? next("waiting_background", "hook:Stop", input.at)
				: next("waiting_input", "hook:Stop", input.at);
		case "turn_failed":
			return next("error", "hook:StopFailure", input.at);
		case "notification":
			if (input.notificationType === "permission_prompt") {
				return next("waiting_permission", "hook:Notification", input.at);
			}
			if (input.notificationType === "idle_prompt") {
				return next("waiting_input", "hook:Notification", input.at);
			}
			return base;
		case "permission_request":
			return next("waiting_permission", "hook:PermissionRequest", input.at);
		case "tool_start":
		case "tool_end":
		case "tool_failed":
			return base.status === "waiting_permission"
				? next("running", `hook:${input.ev}`, input.at)
				: base;
		case "session_end":
			return next("ending", "hook:SessionEnd", input.at);
		case "session_start":
			// A (re)start on its own says nothing about busy/idle; a fresh
			// `startup`/`resume` lands in `unknown` until a prompt or probe.
			return base.status === "ended" || base.status === "disconnected"
				? next("unknown", "hook:SessionStart", input.at)
				: base;
		default:
			return base;
	}
}
