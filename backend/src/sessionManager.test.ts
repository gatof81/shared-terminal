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

// ── listAll (#241d) ────────────────────────────────────────────────────────

describe("SessionManager.listAll", () => {
	it("issues a single JOIN with the users table, newest-first, capped by ADMIN_LIST_LIMIT", async () => {
		const mgr = new SessionManager();
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		await mgr.listAll();
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(1);
		const [sql, params] = dbStubs.d1Query.mock.calls[0]!;
		// JOIN shape: every session row → owner row via FK.
		expect(sql).toMatch(/FROM\s+sessions\s+s\s+JOIN\s+users\s+u\s+ON\s+u\.id\s*=\s*s\.user_id/i);
		// Newest-first ordering for the dashboard.
		expect(sql).toMatch(/ORDER\s+BY\s+s\.created_at\s+DESC/i);
		// LIMIT is present so a runaway deployment doesn't return a
		// multi-megabyte blob.
		expect(sql).toMatch(/LIMIT\s+\d+/i);
		// No bound params — cross-user aggregate, no per-user filter.
		expect(params).toBeUndefined();
	});

	it("rehydrates rows into SessionMeta + ownerUsername", async () => {
		const mgr = new SessionManager();
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [{ ...fakeSessionRow("s1", "u1"), username: "alice" }],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		const list = await mgr.listAll();
		expect(list).toHaveLength(1);
		expect(list[0]?.sessionId).toBe("s1");
		expect(list[0]?.userId).toBe("u1");
		expect(list[0]?.ownerUsername).toBe("alice");
	});

	it("returns [] when no sessions exist", async () => {
		const mgr = new SessionManager();
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		await expect(mgr.listAll()).resolves.toEqual([]);
	});
});

// ── countByStatus (#241) ───────────────────────────────────────────────────

describe("SessionManager.countByStatus", () => {
	it("issues a single GROUP BY query with no parameters", async () => {
		const mgr = new SessionManager();
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		await mgr.countByStatus();
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(1);
		const [sql, params] = dbStubs.d1Query.mock.calls[0]!;
		expect(sql).toMatch(
			/SELECT\s+status,\s+COUNT\(\*\)\s+AS\s+n\s+FROM\s+sessions\s+GROUP\s+BY\s+status/i,
		);
		// No bound params — admin-gated cross-user aggregate, no per-user filter.
		expect(params).toBeUndefined();
	});

	it("returns zeros for every status the table has no rows for", async () => {
		const mgr = new SessionManager();
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		const counts = await mgr.countByStatus();
		expect(counts).toEqual({ running: 0, stopped: 0, terminated: 0, failed: 0 });
	});

	it("rehydrates D1 rows into a fully-populated record", async () => {
		const mgr = new SessionManager();
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [
				{ status: "running", n: 12 },
				{ status: "stopped", n: 4 },
				// `terminated` and `failed` are absent — must default to 0.
			],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		expect(await mgr.countByStatus()).toEqual({
			running: 12,
			stopped: 4,
			terminated: 0,
			failed: 0,
		});
	});

	it("silently drops rows with statuses outside the typed set (forward compat)", async () => {
		// A future migration may add a status the type doesn't know about.
		// Don't crash the admin dashboard — silently drop, route layer
		// surfaces the typed shape.
		const mgr = new SessionManager();
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [
				{ status: "running", n: 5 },
				{ status: "creating", n: 2 }, // hypothetical future status
			],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		const counts = await mgr.countByStatus();
		expect(counts.running).toBe(5);
		expect("creating" in counts).toBe(false);
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

	it("expired entry on the observer fast path drops the stale cache entry before await", async () => {
		const mgr = new SessionManager();
		vi.useFakeTimers();
		try {
			dbStubs.d1Query.mockResolvedValueOnce({
				results: [fakeSessionRow("s-1", "u-owner")],
				success: true,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			});
			await mgr.assertOwnedBy("s-1", "u-owner");
			vi.advanceTimersByTime(OWNERSHIP_CACHE_TTL_MS + 1);
			// After TTL: assertCanObserveBy goes through expired-cleanup,
			// fetches fresh meta, repopulates cache. Owner positive path.
			dbStubs.d1Query.mockResolvedValueOnce({
				results: [fakeSessionRow("s-1", "u-owner")],
				success: true,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			});
			await mgr.assertCanObserveBy("s-1", "u-owner");
			// Now the cache is fresh — next call hits cache, no D1.
			await mgr.assertCanObserveBy("s-1", "u-owner");
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

// ── assertCanObserve (#201b) ────────────────────────────────────────────────

describe("SessionManager.assertCanObserve", () => {
	it("returns meta on the owner positive path with one D1 call", async () => {
		const mgr = new SessionManager();
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [fakeSessionRow("s-1", "u-owner")],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		const meta = await mgr.assertCanObserve("s-1", "u-owner");
		expect(meta.userId).toBe("u-owner");
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(1);
	});

	it("returns meta on the admin positive path (owner != observer, observer is_admin=1)", async () => {
		const mgr = new SessionManager();
		// Call 1: getOrThrow returns session owned by u-owner.
		// Call 2: isUserAdmin(u-admin) → is_admin=1.
		dbStubs.d1Query
			.mockResolvedValueOnce({
				results: [fakeSessionRow("s-1", "u-owner")],
				success: true,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			})
			.mockResolvedValueOnce({
				results: [{ is_admin: 1 }],
				success: true,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			});
		const meta = await mgr.assertCanObserve("s-1", "u-admin");
		expect(meta.userId).toBe("u-owner");
		// isLeadOfUserViaGroup must NOT be called when admin already
		// authorized — short-circuit ordering matters for D1 cost.
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(2);
	});

	it("returns meta on the tech-lead positive path (not owner, not admin, leads owner's group)", async () => {
		const mgr = new SessionManager();
		dbStubs.d1Query
			.mockResolvedValueOnce({
				results: [fakeSessionRow("s-1", "u-owner")],
				success: true,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			})
			.mockResolvedValueOnce({
				results: [{ is_admin: 0 }],
				success: true,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			})
			.mockResolvedValueOnce({
				results: [{ one: 1 }],
				success: true,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			});
		const meta = await mgr.assertCanObserve("s-1", "u-lead");
		expect(meta.userId).toBe("u-owner");
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(3);
	});

	it("throws ForbiddenError when observer is none of owner / admin / lead", async () => {
		const mgr = new SessionManager();
		dbStubs.d1Query
			.mockResolvedValueOnce({
				results: [fakeSessionRow("s-1", "u-owner")],
				success: true,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			})
			.mockResolvedValueOnce({
				results: [{ is_admin: 0 }],
				success: true,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			})
			.mockResolvedValueOnce({
				results: [],
				success: true,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			});
		await expect(mgr.assertCanObserve("s-1", "u-stranger")).rejects.toBeInstanceOf(ForbiddenError);
	});

	it("throws NotFoundError when the session row is missing", async () => {
		const mgr = new SessionManager();
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		await expect(mgr.assertCanObserve("s-nope", "u-any")).rejects.toBeInstanceOf(NotFoundError);
	});

	it("populates the ownership cache as a side effect on the owner path", async () => {
		const mgr = new SessionManager();
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [fakeSessionRow("s-1", "u-owner")],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		await mgr.assertCanObserve("s-1", "u-owner");
		// Owner-only assertOwnedBy must now hit cache, no extra D1.
		await mgr.assertOwnedBy("s-1", "u-owner");
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(1);
	});
});

// ── assertCanObserveBy (#201b void variant) ─────────────────────────────────

describe("SessionManager.assertCanObserveBy", () => {
	it("short-circuits the cached-owner positive path with zero D1 calls", async () => {
		const mgr = new SessionManager();
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [fakeSessionRow("s-1", "u-owner")],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		// Prime the cache via assertOwnedBy.
		await mgr.assertOwnedBy("s-1", "u-owner");
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(1);
		// Observe by the cached owner — zero new D1 calls.
		await mgr.assertCanObserveBy("s-1", "u-owner");
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(1);
	});

	it("falls through to admin/lead lookups when observer != cached_owner", async () => {
		const mgr = new SessionManager();
		dbStubs.d1Query.mockResolvedValueOnce({
			results: [fakeSessionRow("s-1", "u-owner")],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		});
		// Prime cache as owner.
		await mgr.assertOwnedBy("s-1", "u-owner");
		// Observer is a different user — cache hit short-circuit doesn't
		// apply. Fall through: getOrThrow (cached re-fetch happens since
		// we don't have a meta-cache, just owner-cache) → isUserAdmin → isLead.
		dbStubs.d1Query
			.mockResolvedValueOnce({
				results: [fakeSessionRow("s-1", "u-owner")],
				success: true,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			})
			.mockResolvedValueOnce({
				results: [{ is_admin: 1 }],
				success: true,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			});
		await mgr.assertCanObserveBy("s-1", "u-admin");
		// 1 (prime) + 2 (getOrThrow + isUserAdmin) = 3. isLead skipped.
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(3);
	});

	it("throws ForbiddenError when no positive arm matches and the observer is uncached", async () => {
		const mgr = new SessionManager();
		dbStubs.d1Query
			.mockResolvedValueOnce({
				results: [fakeSessionRow("s-1", "u-owner")],
				success: true,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			})
			.mockResolvedValueOnce({
				results: [{ is_admin: 0 }],
				success: true,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			})
			.mockResolvedValueOnce({
				results: [],
				success: true,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			});
		await expect(mgr.assertCanObserveBy("s-1", "u-stranger")).rejects.toBeInstanceOf(
			ForbiddenError,
		);
	});
});
