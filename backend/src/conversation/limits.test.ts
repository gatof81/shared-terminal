/**
 * limits.test.ts — docs/CONVERSATION.md §4.4: the serialisation guarantee
 * (review round 1, C4). For every repertoire, a `last_assistant_message`
 * of exactly L3 bytes inside a full `Stop` hook input (50 background
 * tasks, a 512-byte transcript path) must serialise under L5 and under
 * R2's bucket capacity. `\u0001` is the worst case (×6) and is the one
 * that would have broken the pre-review 2 MiB / 4 MiB pair.
 */

import { describe, expect, it } from "vitest";
import { L3_REPORT_BYTES, L5_BODY_BYTES, R2_BYTES_CAPACITY } from "./limits.js";
import { truncateUtf8 } from "./text.js";

const REPERTOIRES: Array<[string, string]> = [
	["newline", "\n"],
	["control", "\u0001"],
	["quote", '"'],
	["backslash", "\\"],
	["emoji", "😀"],
	["mixed", 'ab\n"\\\u0002😀 '],
];

function fill(unit: string, bytes: number): string {
	const unitBytes = Buffer.byteLength(unit, "utf8");
	return unit.repeat(Math.floor(bytes / unitBytes));
}

describe("§4.4 serialisation guarantee", () => {
	for (const [name, unit] of REPERTOIRES) {
		it(`an L3 report of pure ${name} fits in L5 and R2`, () => {
			const message = fill(unit, L3_REPORT_BYTES);
			expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(L3_REPORT_BYTES);
			const body = JSON.stringify({
				session_id: "x".repeat(36),
				transcript_path: "/".repeat(512),
				cwd: "/home/developer/workspace",
				prompt_id: "p".repeat(36),
				permission_mode: "bypassPermissions",
				hook_event_name: "Stop",
				stop_hook_active: false,
				last_assistant_message: message,
				background_tasks: Array.from({ length: 50 }, (_, i) => ({
					id: `t${i}`,
					type: "subagent",
					status: "running",
					description: "d".repeat(1000),
				})),
				session_crons: [],
			});
			const bytes = Buffer.byteLength(body, "utf8");
			expect(bytes).toBeLessThanOrEqual(L5_BODY_BYTES);
			expect(bytes).toBeLessThanOrEqual(R2_BYTES_CAPACITY);
		});
	}

	it("L5 covers the worst-case ×6 escaping of L3 plus a 1 MiB envelope", () => {
		expect(L5_BODY_BYTES).toBeGreaterThanOrEqual(6 * L3_REPORT_BYTES + 1024 * 1024);
	});

	it("R2's capacity is at least L5, so a single max body is never rate-refused", () => {
		expect(R2_BYTES_CAPACITY).toBeGreaterThanOrEqual(L5_BODY_BYTES);
	});
});

describe("truncateUtf8", () => {
	it("cuts on a code-point boundary and reports original bytes", () => {
		const s = "😀".repeat(10); // 40 bytes
		const t = truncateUtf8(s, 10);
		expect(t.truncated).toBe(true);
		expect(t.originalBytes).toBe(40);
		expect(Buffer.byteLength(t.value)).toBeLessThanOrEqual(10);
		expect(t.value).toBe("😀😀");
	});
	it("keeps a value within budget untouched", () => {
		expect(truncateUtf8("abc", 3)).toEqual({ value: "abc", truncated: false });
	});
	it("marker variant stays within the budget, marker included", () => {
		const t = truncateUtf8("x".repeat(100), 30, (d) => `…[+${d} chars]`);
		expect(Buffer.byteLength(t.value)).toBeLessThanOrEqual(30);
		expect(t.value).toMatch(/…\[\+\d+ chars\]$/);
	});
});
