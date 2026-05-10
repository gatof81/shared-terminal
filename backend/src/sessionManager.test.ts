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

import {
	ForbiddenError,
	NotFoundError,
	OWNERSHIP_CACHE_MAX,
	OWNERSHIP_CACHE_TTL_MS,
	SessionManager,
} from "./sessionManager.js";

beforeEach(() => {
	dbStubs.d1Query.mockReset();
});

// Helper: a fully-formed `sessions` row that `rowToMeta` can handle.
function fakeSessionRow(sessionId: string, userId: string) {
	return {
		session_id: sessionId,
		user_id: userId,
		name: "test",
		status: "running",
		container_id: null,
		container_name: "st-test",
		cols: 80,
		rows: 24,
		env_vars: "{}",
		created_at: "2026-05-09 02:00:00",
		last_connected_at: null,
	};
}

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

// ── Ownership cache (#239) ─────────────────────────────────────────────────

describe("SessionManager.assertOwnedBy / assertOwnership cache", () => {
	it("populates the cache on first assertOwnedBy and serves the second from memory", async () => {
		const mgr = new SessionManager();
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [fakeSessionRow("s-1", "u-owner")],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		await mgr.assertOwnedBy("s-1", "u-owner");
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(1);
		// Second call hits cache — no new D1 round-trip.
		await mgr.assertOwnedBy("s-1", "u-owner");
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(1);
	});

	it("assertOwnedBy short-circuits foreign-user requests via cache (negative fast path)", async () => {
		const mgr = new SessionManager();
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [fakeSessionRow("s-1", "u-owner")],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		// Prime the cache with a successful assert.
		await mgr.assertOwnedBy("s-1", "u-owner");
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(1);
		// Foreign user — should 403 from cache, no D1 call.
		await expect(mgr.assertOwnedBy("s-1", "u-foreigner")).rejects.toBeInstanceOf(ForbiddenError);
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(1);
	});

	it("assertOwnership populates the cache as a side effect", async () => {
		const mgr = new SessionManager();
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [fakeSessionRow("s-1", "u-owner")],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		const meta = await mgr.assertOwnership("s-1", "u-owner");
		expect(meta.userId).toBe("u-owner");
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(1);
		// Now an assertOwnedBy for the same session is a cache hit.
		await mgr.assertOwnedBy("s-1", "u-owner");
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(1);
	});

	it("assertOwnership short-circuits foreign-user requests via cache without fetching meta", async () => {
		const mgr = new SessionManager();
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [fakeSessionRow("s-1", "u-owner")],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		await mgr.assertOwnedBy("s-1", "u-owner");
		// Foreign user via assertOwnership — short-circuits without
		// the `getOrThrow` D1 call. (The positive case can't
		// short-circuit — caller needs fresh meta — but the negative
		// case absolutely can.)
		await expect(mgr.assertOwnership("s-1", "u-foreigner")).rejects.toBeInstanceOf(ForbiddenError);
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(1);
	});

	it("does NOT cache negative results (no row, session never existed)", async () => {
		const mgr = new SessionManager();
		dbStubs.d1Query.mockResolvedValue({
			results: [],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		await expect(mgr.assertOwnedBy("s-missing", "u")).rejects.toBeInstanceOf(NotFoundError);
		await expect(mgr.assertOwnedBy("s-missing", "u")).rejects.toBeInstanceOf(NotFoundError);
		// Caching the miss would extend a "session is starting" race
		// window (a session that just spawned would 404 from cache for
		// the TTL). Both calls must hit D1.
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(2);
	});

	it("deleteRow invalidates the cache so the next assert hits D1 with the fresh state", async () => {
		const mgr = new SessionManager();
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [fakeSessionRow("s-1", "u-owner")],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		await mgr.assertOwnedBy("s-1", "u-owner");
		// deleteRow is the only mutator that affects ownership today.
		// 1 D1 call for the DELETE.
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [],
			success: true,
			meta: { changes: 1, duration: 0, last_row_id: 0 },
		});
		await mgr.deleteRow("s-1");
		// Subsequent assert must re-fetch — and find no row.
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		await expect(mgr.assertOwnedBy("s-1", "u-owner")).rejects.toBeInstanceOf(NotFoundError);
		// 1 (initial) + 1 (DELETE) + 1 (re-fetch) = 3.
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(3);
	});

	it("expired entry triggers a fresh D1 call and re-populates the cache", async () => {
		const mgr = new SessionManager();
		vi.useFakeTimers();
		try {
			dbStubs.d1Query.mockResolvedValue({
				results: [fakeSessionRow("s-ttl", "u-owner")],
				success: true,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			});
			await mgr.assertOwnedBy("s-ttl", "u-owner");
			expect(dbStubs.d1Query).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(OWNERSHIP_CACHE_TTL_MS + 1);
			await mgr.assertOwnedBy("s-ttl", "u-owner");
			expect(dbStubs.d1Query).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("evicts oldest entry when cap is reached so memory is bounded", async () => {
		// Fill cache to OWNERSHIP_CACHE_MAX, then add one more — first
		// inserted must be evicted. We test the eviction by seeing the
		// evicted session re-issue a D1 call on next assert (i.e. it's
		// no longer in cache).
		const mgr = new SessionManager();
		// Prime first session.
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [fakeSessionRow("s-first", "u-owner")],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		await mgr.assertOwnedBy("s-first", "u-owner");

		// Fill the rest with distinct ids; default mock returns the
		// matching row so we don't need per-call mocks.
		dbStubs.d1Query.mockImplementation(async (_sql, params) => {
			const sid = (params as unknown[] | undefined)?.[0] as string;
			return {
				results: [fakeSessionRow(sid, "u-owner")],
				success: true,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			};
		});
		for (let i = 0; i < OWNERSHIP_CACHE_MAX; i++) {
			await mgr.assertOwnedBy(`s-fill-${i}`, "u-owner");
		}
		// Initial s-first should now be evicted; assert re-issues a call.
		const callsBefore = dbStubs.d1Query.mock.calls.length;
		await mgr.assertOwnedBy("s-first", "u-owner");
		expect(dbStubs.d1Query.mock.calls.length).toBeGreaterThan(callsBefore);
	});
});
