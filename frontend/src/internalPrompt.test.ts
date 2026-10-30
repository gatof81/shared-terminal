/**
 * internalPrompt.test.ts — docs/CONVERSATION.md §4.2.1 (frontend mirror): which prompts are
 * the CLI's own task notifications, which are a person's, and which are
 * neither for sure. The vectors are shared with
 * `backend/src/conversation/internalPrompt.test.ts` (same classifier, same answers).
 */

import { describe, expect, it } from "vitest";
import { classifyPrompt } from "./internalPrompt";
import { NOTIFICATION } from "./internalPrompt.testutil";

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

describe("classifyPrompt — stray, repeated or disordered tags are never verified (Work P2-1)", () => {
	const tool = "<tool-use-id>toolu_01NrcdMjX7yQ2bK9vTz3Lm4W</tool-use-id>";
	const wrap = (inner: string) => `<task-notification>\n${inner}\n</task-notification>`;
	it("Work's reproduction: a closing tag before the opening one", () => {
		expect(
			kindOf(wrap(`</task-id><task-id>a1</task-id>\n${tool}\n<status>completed</status>`)),
		).toBe("unverified");
	});
	it("a stray closing tag after the element, a repeated opening, a missing closing", () => {
		for (const inner of [
			`<task-id>a1</task-id></task-id>\n${tool}\n<status>completed</status>`,
			`<task-id><task-id>a1</task-id>\n${tool}\n<status>completed</status>`,
			`<task-id>a1\n${tool}\n<status>completed</status>`,
			`<task-id>a1</task-id>\n${tool}\n<status>completed`,
			`<task-id>a1</task-id>\n<tool-use-id>toolu_01NrcdMjX7yQ2bK9vTz3Lm4W\n<status>completed</status>`,
			`<task-id>a1</task-id>\n${tool}${tool}\n<status>completed</status>`,
		]) {
			expect(kindOf(wrap(inner)), inner).toBe("unverified");
		}
	});
	it("the three ids out of the CLI's order, or overlapping", () => {
		for (const inner of [
			`<status>completed</status>\n<task-id>a1</task-id>\n${tool}`,
			`${tool}\n<task-id>a1</task-id>\n<status>completed</status>`,
			`<task-id>a1</task-id>\n<status>completed</status>\n${tool}`,
			`<task-id>a1${tool}</task-id>\n<status>completed</status>`,
		]) {
			expect(kindOf(wrap(inner)), inner).toBe("unverified");
		}
	});
	it("a value holding another tag is not an id", () => {
		expect(kindOf(wrap(`<task-id><b>a1</b></task-id>\n${tool}\n<status>completed</status>`))).toBe(
			"unverified",
		);
	});
	it("the CLI's shape with optional children between the ids stays verified", () => {
		expect(
			kindOf(
				wrap(
					`<task-id>a1</task-id>\n<output-file>/tmp/x.out</output-file>\n${tool}\n<summary>done</summary>\n<status>completed</status>`,
				),
			),
		).toBe("internal");
	});
});
