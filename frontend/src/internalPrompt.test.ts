/**
 * internalPrompt.test.ts — docs/CONVERSATION.md §4.2.1 (frontend mirror): which prompts are
 * the CLI's own task notifications, which are a person's, and which are
 * neither for sure. The vectors are shared with
 * `backend/src/conversation/internalPrompt.test.ts` (same classifier, same answers).
 */

import { describe, expect, it } from "vitest";
import { classifyPrompt } from "./internalPrompt";

// Shaped like the pilot's seq 22 (CLI 2.1.308, an `Agent` tool finishing
// in the background): ids are synthetic, no content copied.
export const NOTIFICATION = [
	"<task-notification>",
	"<task-id>afc95b2b37cb620a1</task-id>",
	"<tool-use-id>toolu_01NrcdMjX7yQ2bK9vTz3Lm4W</tool-use-id>",
	"<status>completed</status>",
	"<summary>Agent completed</summary>",
	"<result>",
	"The subagent's report: **done**, 3 files, see `src/x.ts`.",
	"</result>",
	"</task-notification>",
].join("\n");

const internal = (s: string) => {
	const c = classifyPrompt(s);
	if (c.kind !== "internal") throw new Error(`expected internal, got ${JSON.stringify(c)}`);
	return c.notification;
};
const kindOf = (s: string) => classifyPrompt(s).kind;

describe("classifyPrompt — verified internal notifications", () => {
	it("the real shape (seq 21–23 of the pilot) is internal, with the three ids", () => {
		expect(internal(NOTIFICATION)).toEqual({
			taskId: "afc95b2b37cb620a1",
			toolUseId: "toolu_01NrcdMjX7yQ2bK9vTz3Lm4W",
			status: "completed",
		});
	});
	it("surrounding whitespace, a background Bash shape and other statuses are fine", () => {
		expect(kindOf(`\n\n  ${NOTIFICATION}\n`)).toBe("internal");
		const bash = [
			"<task-notification>",
			"<task-id>btesl5hn3</task-id>",
			"<tool-use-id>toolu_01SuzrSX6G4ikw9fPVXhR188</tool-use-id>",
			"<output-file>/tmp/x/tasks/btesl5hn3.output</output-file>",
			"<status>failed</status>",
			"<summary>Background command exited 1</summary>",
			"</task-notification>",
		].join("\n");
		expect(internal(bash)).toEqual({
			taskId: "btesl5hn3",
			toolUseId: "toolu_01SuzrSX6G4ikw9fPVXhR188",
			status: "failed",
		});
	});
	it("a result that itself contains notification-like children does not confuse the ids", () => {
		const nested = NOTIFICATION.replace(
			"</result>",
			"Nested text mentioning <status>weird</status> is content.\n</result>",
		);
		// Two <status> children ⇒ cannot verify ⇒ not human, not internal.
		expect(kindOf(nested)).toBe("unverified");
	});
});

describe("classifyPrompt — human prompts stay human", () => {
	it("ordinary prompts, including ones that mention the tags", () => {
		for (const s of [
			"Fix the bug in auth.ts please",
			"",
			"what does <task-notification> mean in the logs?",
			"The CLI sends <task-notification>…</task-notification> blocks, can we hide them?",
			`Look at this and explain it:\n${NOTIFICATION}`,
			`${NOTIFICATION}\n\nAnd now continue with the next step.`,
			"<task-notification>",
			"</task-notification>",
		]) {
			expect(kindOf(s), s.slice(0, 40)).toBe("human");
		}
	});
});

describe("classifyPrompt — notification shape that cannot be verified", () => {
	it("missing, repeated or malformed identifiers", () => {
		const without = (tag: string) =>
			NOTIFICATION.split("\n")
				.filter((l) => !l.startsWith(`<${tag}>`))
				.join("\n");
		expect(classifyPrompt(without("task-id"))).toEqual({
			kind: "unverified",
			reason: "missing-field",
		});
		expect(classifyPrompt(without("tool-use-id"))).toEqual({
			kind: "unverified",
			reason: "missing-field",
		});
		expect(classifyPrompt(without("status"))).toEqual({
			kind: "unverified",
			reason: "missing-field",
		});
		expect(
			classifyPrompt(NOTIFICATION.replace("toolu_01NrcdMjX7yQ2bK9vTz3Lm4W", "call_123")),
		).toEqual({ kind: "unverified", reason: "tool-use-id" });
		expect(classifyPrompt(NOTIFICATION.replace("afc95b2b37cb620a1", "../etc"))).toEqual({
			kind: "unverified",
			reason: "task-id",
		});
		expect(classifyPrompt(NOTIFICATION.replace("completed", "Completed now!"))).toEqual({
			kind: "unverified",
			reason: "status",
		});
		expect(
			classifyPrompt(
				NOTIFICATION.replace(
					"<status>completed</status>",
					"<status>completed</status><status>x</status>",
				),
			),
		).toEqual({ kind: "unverified", reason: "missing-field" });
	});
	it("two blocks, or an empty block", () => {
		expect(classifyPrompt(`${NOTIFICATION}\n${NOTIFICATION}`)).toEqual({
			kind: "unverified",
			reason: "multiple-blocks",
		});
		expect(classifyPrompt("<task-notification></task-notification>")).toEqual({
			kind: "unverified",
			reason: "missing-field",
		});
	});
});
