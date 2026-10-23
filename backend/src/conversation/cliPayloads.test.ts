/**
 * cliPayloads.test.ts — hook inputs as the pinned CLI (2.1.308) really
 * sends them, through the 3.0b normaliser.
 *
 * `fixtures/cli-2.1.308-hooks.jsonl` was recorded from the real `claude`
 * binary of the image pin firing the managed hooks file
 * (`buildHooksSettings`) against a local receiver, with a scripted model
 * (session-image/test/mock-anthropic.mjs): `-p` runs, a Bash tool call, a
 * failing one, a subagent, a permission prompt and an interactive paced
 * stream. Only host paths were rewritten to the in-container ones; every
 * field the CLI sent is kept, so a field the normaliser does not know shows
 * up here as a dropped field rather than going unnoticed.
 *
 * Re-record on every pin bump (session-image/README.md).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeHookInput } from "./normalize.js";

const lines = readFileSync(path.join(__dirname, "fixtures/cli-2.1.308-hooks.jsonl"), "utf8")
	.trim()
	.split("\n")
	.map((l) => JSON.parse(l) as Record<string, unknown>);

const EXPECTED: Record<string, string> = {
	SessionStart: "session_start",
	UserPromptSubmit: "user_prompt",
	MessageDisplay: "assistant_delta",
	PreToolUse: "tool_start",
	PostToolUse: "tool_end",
	PostToolUseFailure: "tool_failed",
	PermissionRequest: "permission_request",
	SubagentStart: "agent_start",
	SubagentStop: "agent_end",
	Stop: "turn_end",
	SessionEnd: "session_end",
};

describe("real 2.1.308 hook payloads", () => {
	it("cover every event the smoke scenarios produce", () => {
		const seen = new Set(lines.map((l) => l.hook_event_name));
		expect([...seen].sort()).toEqual(Object.keys(EXPECTED).sort());
	});

	it("each normalises to its contract event, none malformed", () => {
		for (const raw of lines) {
			const r = normalizeHookInput(raw);
			expect(r, JSON.stringify(raw).slice(0, 200)).toMatchObject({ ok: true });
			if (!r.ok) continue;
			expect(r.event.ev).toBe(EXPECTED[String(raw.hook_event_name)]);
		}
	});

	it("preserves the correlation identifiers the CLI sent", () => {
		for (const raw of lines) {
			const r = normalizeHookInput(raw);
			if (!r.ok) throw new Error("malformed");
			const e = r.event;
			expect(e.sessionId).toBe(raw.session_id);
			expect(e.promptId).toBe(raw.prompt_id ?? null);
			expect(e.agentId).toBe(raw.agent_id ?? null);
			if (raw.tool_use_id !== undefined) {
				expect(e.data.tool_use_id).toBe(raw.tool_use_id);
				expect(e.identity.toolUseId).toBe(raw.tool_use_id);
			}
			if (raw.hook_event_name === "MessageDisplay") {
				expect(e.turnId).toBe(raw.turn_id);
				expect(e.data).toMatchObject({
					message_id: raw.message_id,
					index: raw.index,
					final: raw.final,
				});
				expect(e.data.delta).toBe(raw.delta);
			}
			if (raw.hook_event_name === "SessionStart") {
				expect(e.data).toMatchObject({
					claude_version: "2.1.308 (Claude Code)",
					source: "startup",
				});
			}
		}
	});

	it("drops only fields outside the contract, and says which", () => {
		// Fields 2.1.308 sends that the normaliser does not keep, found by
		// removing each key and watching `droppedFields` fall. Listed so a pin
		// bump that adds one is a visible diff here, not a silent drop.
		const dropped = new Map<string, Set<string>>();
		for (const raw of lines) {
			const r = normalizeHookInput(raw);
			if (!r.ok || r.event.droppedFields === 0) continue;
			for (const k of Object.keys(raw)) {
				const { [k]: _, ...without } = raw;
				const r2 = normalizeHookInput(without);
				if (r2.ok && r2.event.droppedFields < r.event.droppedFields) {
					const name = String(raw.hook_event_name);
					dropped.set(name, (dropped.get(name) ?? new Set()).add(k));
				}
			}
		}
		expect(
			Object.fromEntries([...dropped].sort().map(([k, v]) => [k, [...v].sort()])),
		).toMatchInlineSnapshot(`{}`);
	});
});
