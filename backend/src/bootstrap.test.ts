import { beforeEach, describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({
		results: [] as unknown[],
		success: true as const,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	})),
}));
vi.mock("./db.js", () => dbStubs);

import { markBootstrapped } from "./bootstrap.js";

beforeEach(() => {
	dbStubs.d1Query.mockReset();
});

describe("markBootstrapped", () => {
	it("issues a guarded UPDATE that only fires when bootstrapped_at IS NULL", async () => {
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [],
			success: true,
			meta: { changes: 1, duration: 0, last_row_id: 0 },
		});
		const won = await markBootstrapped("sess-1");
		expect(won).toBe(true);
		const [sql, params] = dbStubs.d1Query.mock.calls[0]!;
		expect(sql).toMatch(/UPDATE session_configs/);
		expect(sql).toMatch(/SET bootstrapped_at/);
		// The IS NULL predicate is the lock — without it two concurrent
		// callers would both think they won. Asserting on the SQL shape
		// so a future caller can't drop the predicate by mistake.
		expect(sql).toMatch(/WHERE session_id = \? AND bootstrapped_at IS NULL/);
		expect(params).toEqual(["sess-1"]);
	});

	// Concurrent retry: two callers race on the same row, the slower
	// one's UPDATE finds bootstrapped_at already set, changes === 0,
	// we return false so the caller can skip a duplicate run.
	it("returns false when another caller already won the race", async () => {
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		const won = await markBootstrapped("sess-1");
		expect(won).toBe(false);
	});

	// No row at all (bare-create session, hook never configured) is
	// treated as the race-loser path: changes === 0, returns false. The
	// caller should never reach this method without a postCreateCmd, but
	// degrading rather than throwing keeps the runner code simple.
	it("returns false when no session_configs row exists", async () => {
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		const won = await markBootstrapped("sess-missing");
		expect(won).toBe(false);
	});

	it("propagates D1 errors instead of silently swallowing", async () => {
		dbStubs.d1Query.mockRejectedValueOnce(new Error("D1 transient"));
		await expect(markBootstrapped("sess-1")).rejects.toThrow("D1 transient");
	});
});
