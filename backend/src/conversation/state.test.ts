/**
 * state.test.ts — docs/CONVERSATION.md §5.3 as a table test, plus the
 * hook/probe priority rule (decided by `at`) and the `ending` reopen.
 */

import { describe, expect, it } from "vitest";
import { applyStateInput, type ConversationState, type StateInput } from "./state.js";

const at = (ms: number) => 1_700_000_000_000 + ms;
const S = (status: ConversationState["status"], t = 0): ConversationState => ({
	status,
	evidence: "test",
	at: at(t),
});

const prompt = (t: number): StateInput => ({ kind: "event", ev: "user_prompt", at: at(t) });
const stop = (t: number, bg = 0): StateInput => ({
	kind: "event",
	ev: "turn_end",
	backgroundTasks: bg,
	at: at(t),
});

describe("§5.3 transition table", () => {
	const rows: Array<[string, ConversationState, StateInput, ConversationState["status"], string]> =
		[
			["* + user_prompt → running", S("unknown"), prompt(1), "running", "hook:UserPromptSubmit"],
			[
				"running + Stop (no bg) → waiting_input",
				S("running"),
				stop(1),
				"waiting_input",
				"hook:Stop",
			],
			[
				"running + Stop (bg) → waiting_background",
				S("running"),
				stop(1, 2),
				"waiting_background",
				"hook:Stop",
			],
			[
				"running + StopFailure → error",
				S("running"),
				{ kind: "event", ev: "turn_failed", at: at(1) },
				"error",
				"hook:StopFailure",
			],
			[
				"* + permission_prompt → waiting_permission",
				S("running"),
				{ kind: "event", ev: "notification", notificationType: "permission_prompt", at: at(1) },
				"waiting_permission",
				"hook:Notification",
			],
			[
				"* + PermissionRequest → waiting_permission",
				S("running"),
				{ kind: "event", ev: "permission_request", at: at(1) },
				"waiting_permission",
				"hook:PermissionRequest",
			],
			[
				"waiting_permission + tool_start → running",
				S("waiting_permission"),
				{ kind: "event", ev: "tool_start", at: at(1) },
				"running",
				"hook:tool_start",
			],
			[
				"* + idle_prompt → waiting_input",
				S("running"),
				{ kind: "event", ev: "notification", notificationType: "idle_prompt", at: at(1) },
				"waiting_input",
				"hook:Notification",
			],
			[
				"* + SessionEnd → ending",
				S("waiting_input"),
				{ kind: "event", ev: "session_end", at: at(1) },
				"ending",
				"hook:SessionEnd",
			],
			[
				"ending + grace → ended",
				S("ending"),
				{ kind: "end_grace_elapsed", at: at(6) },
				"ended",
				"hook:SessionEnd",
			],
			["ending + any event reopens", S("ending"), prompt(2), "running", "hook:UserPromptSubmit"],
			[
				"* + probe absent → ended",
				S("running"),
				{ kind: "probe", found: false, at: at(1) },
				"ended",
				"probe:absent",
			],
			[
				"* + probe busy → running",
				S("waiting_input"),
				{ kind: "probe", found: true, status: "busy", at: at(1) },
				"running",
				"probe:busy",
			],
			[
				"* + probe waiting/input needed → waiting_input",
				S("running"),
				{ kind: "probe", found: true, status: "waiting", waitingFor: "input needed", at: at(1) },
				"waiting_input",
				"probe:waiting",
			],
			[
				"* + probe waiting/permission prompt → waiting_permission",
				S("running"),
				{
					kind: "probe",
					found: true,
					status: "waiting",
					waitingFor: "permission prompt",
					at: at(1),
				},
				"waiting_permission",
				"probe:waiting",
			],
			[
				"* + probe idle → waiting_input",
				S("running"),
				{ kind: "probe", found: true, status: "idle", at: at(1) },
				"waiting_input",
				"probe:idle",
			],
			[
				"* + container down → disconnected",
				S("running"),
				{ kind: "container_down", at: at(1) },
				"disconnected",
				"reconcile",
			],
			["* + silence → unknown", S("running"), { kind: "silence", at: at(1) }, "unknown", "timeout"],
			["ended + silence stays ended", S("ended"), { kind: "silence", at: at(1) }, "ended", "test"],
			[
				"ended + SessionStart(resume) → unknown",
				S("ended"),
				{ kind: "event", ev: "session_start", source: "resume", at: at(1) },
				"unknown",
				"hook:SessionStart",
			],
			[
				"grace on a non-ending state is a no-op",
				S("running"),
				{ kind: "end_grace_elapsed", at: at(1) },
				"running",
				"test",
			],
			[
				"tool events outside waiting_permission do not change state",
				S("waiting_input"),
				{ kind: "event", ev: "tool_end", at: at(1) },
				"waiting_input",
				"test",
			],
		];
	for (const [name, from, input, status, evidence] of rows) {
		it(name, () => {
			const out = applyStateInput(from, input);
			expect(out.status).toBe(status);
			expect(out.evidence).toBe(evidence);
		});
	}
});

describe("hook/probe priority by status_at", () => {
	it("a newer probe overrides an older hook", () => {
		const afterHook = applyStateInput(S("unknown"), stop(10));
		const afterProbe = applyStateInput(afterHook, {
			kind: "probe",
			found: true,
			status: "busy",
			at: at(20),
		});
		expect(afterProbe.status).toBe("running");
	});
	it("an older probe never overrides a newer hook (returns the same object)", () => {
		const afterHook = applyStateInput(S("unknown"), stop(20));
		const out = applyStateInput(afterHook, {
			kind: "probe",
			found: true,
			status: "busy",
			at: at(10),
		});
		expect(out).toBe(afterHook);
	});
	it("same-millisecond inputs apply in arrival order", () => {
		const a = applyStateInput(S("unknown"), prompt(5));
		const b = applyStateInput(a, stop(5));
		expect(b.status).toBe("waiting_input");
	});
});
