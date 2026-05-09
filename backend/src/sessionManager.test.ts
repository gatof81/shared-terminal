/**
 * sessionManager.test.ts — quota-filter tests for #185 (PR 185b2a review).
 *
 * Round-2 reviewer flagged that `failed` sessions occupied a quota slot,
 * which combined with the `/start` 409 guard meant a user with N typo'd
 * postCreate hooks would get locked out at the cap. Quota count must
 * exclude both `terminated` AND `failed`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({
		results: [] as unknown[],
		success: true as const,
		meta: { changes: 1, duration: 0, last_row_id: 0 },
	})),
}));
vi.mock("./db.js", () => dbStubs);

import { SessionManager } from "./sessionManager.js";

beforeEach(() => {
	dbStubs.d1Query.mockReset();
});

describe("SessionManager.create — quota filter", () => {
	it("excludes both 'terminated' and 'failed' rows from the quota count", async () => {
		// First call is the atomic INSERT … WHERE COUNT(*) < cap; second
		// is the `get` that materialises the inserted row. We only care
		// about the SQL shape on the first call.
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [],
			success: true,
			meta: { changes: 1, duration: 0, last_row_id: 0 },
		});
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [
				{
					session_id: "sess-new",
					user_id: "u1",
					name: "test",
					status: "running",
					container_id: null,
					container_name: "st-test",
					cols: 80,
					rows: 24,
					env_vars: "{}",
					created_at: "2026-05-09 02:00:00",
					last_connected_at: null,
				},
			],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});

		const mgr = new SessionManager();
		await mgr.create({ userId: "u1", name: "test" });

		const [insertSql] = dbStubs.d1Query.mock.calls[0]!;
		// `failed` is in the exclusion list — without this, a user with
		// N typo'd postCreate hooks gets locked out at the cap with no
		// /start path to recover (the 409 guard refuses failed sessions).
		expect(insertSql).toMatch(/status NOT IN \('terminated', 'failed'\)/);
		// Sanity: a 429 wouldn't fire for the legacy `terminated`-only
		// filter either, so make sure both terms are present (a regex
		// that matched only one would silently regress the new
		// `failed` exclusion).
		expect(insertSql).toMatch(/'terminated'/);
		expect(insertSql).toMatch(/'failed'/);
	});
});
