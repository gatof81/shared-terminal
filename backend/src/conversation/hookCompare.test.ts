/**
 * hookCompare.test.ts — the smoke's control-dir comparator
 * (session-image/test/hook-compare.mjs, Work I2 on #455): tolerant of
 * MessageDisplay batching and of the async SessionStart's position, strict
 * on every count and on the order of the CLI's own lifecycle hooks.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";

const MOD = path.resolve(__dirname, "../../../session-image/test/hook-compare.mjs");
type Compare = (base: string[], run: string[]) => { ok: boolean; reason?: string };
const load = async (): Promise<Compare> =>
	((await import(MOD)) as { compareHooks: Compare }).compareHooks;

// The real baseline from phase 11 (one interactive turn with a Bash tool,
// then one `claude -p`), snapshotted before tmux is killed.
const BASE =
	"SessionStart UserPromptSubmit PreToolUse PostToolUse MessageDisplay Stop SessionStart UserPromptSubmit MessageDisplay Stop SessionEnd".split(
		" ",
	);

describe("hook comparator", () => {
	it("identical run ⇒ accepted", async () => {
		expect((await load())(BASE, [...BASE])).toEqual({ ok: true });
	});

	it("a different number of MessageDisplay batches (and one landing after Stop) ⇒ accepted", async () => {
		const run =
			"SessionStart UserPromptSubmit PreToolUse PostToolUse MessageDisplay MessageDisplay Stop MessageDisplay SessionStart UserPromptSubmit MessageDisplay MessageDisplay MessageDisplay Stop SessionEnd".split(
				" ",
			);
		expect((await load())(BASE, run)).toEqual({ ok: true });
	});

	it("the async SessionStart arriving after the prompt ⇒ accepted (position not stable, count is)", async () => {
		const run =
			"UserPromptSubmit SessionStart PreToolUse PostToolUse MessageDisplay Stop UserPromptSubmit SessionStart MessageDisplay Stop SessionEnd".split(
				" ",
			);
		expect((await load())(BASE, run)).toEqual({ ok: true });
	});

	it("PreToolUse/PostToolUse inverted ⇒ rejected", async () => {
		const run = [...BASE];
		[run[2], run[3]] = [run[3], run[2]];
		const r = (await load())(BASE, run);
		expect(r.ok).toBe(false);
		expect(r.reason).toMatch(/order differs/);
	});

	it("Stop before PostToolUse ⇒ rejected", async () => {
		const run =
			"SessionStart UserPromptSubmit PreToolUse MessageDisplay Stop PostToolUse SessionStart UserPromptSubmit MessageDisplay Stop SessionEnd".split(
				" ",
			);
		expect((await load())(BASE, run).ok).toBe(false);
	});

	for (const type of [
		"SessionStart",
		"UserPromptSubmit",
		"PreToolUse",
		"PostToolUse",
		"Stop",
		"SessionEnd",
	]) {
		it(`${type} missing ⇒ rejected`, async () => {
			const i = BASE.indexOf(type);
			const run = [...BASE.slice(0, i), ...BASE.slice(i + 1)];
			const r = (await load())(BASE, run);
			expect(r.ok).toBe(false);
			expect(r.reason).toContain(type);
		});
		it(`${type} duplicated ⇒ rejected`, async () => {
			const i = BASE.indexOf(type);
			const run = [...BASE.slice(0, i + 1), type, ...BASE.slice(i + 1)];
			const r = (await load())(BASE, run);
			expect(r.ok).toBe(false);
			expect(r.reason).toContain(type);
		});
	}

	it("MessageDisplay missing entirely, or an unexpected event type ⇒ rejected", async () => {
		const compare = await load();
		expect(
			compare(
				BASE,
				BASE.filter((e) => e !== "MessageDisplay"),
			).ok,
		).toBe(false);
		expect(compare(BASE, [...BASE, "Notification"]).ok).toBe(false);
	});
});
