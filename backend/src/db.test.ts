/**
 * db.test.ts — call counter tests (#241b).
 *
 * The d1 counter exposed via `getD1CallsSinceBoot()` is what the admin
 * stats endpoint surfaces to operators. The counter is a single
 * `d1CallsSinceBoot++` at the top of `d1Query`, but pinning the
 * behaviour here means a future refactor that moves the increment
 * past an early return (or replaces `d1Query` with a wrapper that
 * forgets to bump) can't silently break the dashboard signal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub fetch globally — the real d1Query hits the Cloudflare HTTP API.
// Each test installs its own response shape via `mockFetch`.
let originalFetch: typeof fetch;

beforeEach(() => {
	originalFetch = globalThis.fetch;
});
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function mockFetch(): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(
		async () =>
			new Response(
				JSON.stringify({
					result: [
						{ results: [], success: true, meta: { changes: 0, duration: 0, last_row_id: 0 } },
					],
					success: true,
					errors: [],
				}),
				{ status: 200 },
			),
	);
	(globalThis as { fetch: unknown }).fetch = fetchMock;
	return fetchMock;
}

describe("d1 call counter (#241b)", () => {
	it("increments on every d1Query call", async () => {
		const { __resetD1CallsForTests, d1Query, getD1CallsSinceBoot } = await import("./db.js");
		__resetD1CallsForTests();
		mockFetch();

		expect(getD1CallsSinceBoot()).toBe(0);
		await d1Query("SELECT 1");
		expect(getD1CallsSinceBoot()).toBe(1);
		await d1Query("SELECT 2");
		await d1Query("SELECT 3");
		expect(getD1CallsSinceBoot()).toBe(3);
	});

	it("counts even when the query throws (so retried/failed calls are visible)", async () => {
		const { __resetD1CallsForTests, d1Query, getD1CallsSinceBoot } = await import("./db.js");
		__resetD1CallsForTests();
		// Mock fetch to return a non-OK response — d1Query will throw.
		(globalThis as { fetch: unknown }).fetch = vi.fn(
			async () => new Response("nope", { status: 500 }),
		);

		await expect(d1Query("SELECT 1")).rejects.toThrow();
		// Counter bumped at the TOP of the function, so failures count.
		// Operator wants to see "100 D1 calls last hour" even if half
		// of them failed — that's a useful signal, not a regression.
		expect(getD1CallsSinceBoot()).toBe(1);
	});
});

// #304: a `success: true` response with an empty `result` array must throw
// a sourced error at d1Query, not return undefined and surface later as
// `Cannot read properties of undefined (reading 'results')` in a caller.
describe("d1Query empty-result guard (#304)", () => {
	it("throws a sourced error when result[] is empty despite success:true", async () => {
		const { d1Query } = await import("./db.js");
		(globalThis as { fetch: unknown }).fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ result: [], success: true, errors: [] }), { status: 200 }),
		);
		await expect(d1Query("SELECT * FROM widgets")).rejects.toThrow(
			/no result set for: SELECT \* FROM widgets/,
		);
	});

	it("throws the same sourced error when the result key is absent entirely", async () => {
		const { d1Query } = await import("./db.js");
		(globalThis as { fetch: unknown }).fetch = vi.fn(
			async () => new Response(JSON.stringify({ success: true, errors: [] }), { status: 200 }),
		);
		await expect(d1Query("SELECT * FROM gadgets")).rejects.toThrow(
			/no result set for: SELECT \* FROM gadgets/,
		);
	});
});

// #343: every fetch must carry an abort signal (the 10 s ceiling), and a
// fired timeout must surface as a sourced D1 error — not undici's generic
// "The operation was aborted due to timeout", which names neither the
// dependency nor the statement.
describe("d1Query timeout (#343)", () => {
	it("passes an AbortSignal to fetch", async () => {
		const { d1Query } = await import("./db.js");
		const fetchMock = mockFetch();
		await d1Query("SELECT 1");
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("rewraps a fired timeout as a sourced error naming D1 and the query", async () => {
		const { d1Query } = await import("./db.js");
		// Simulate undici's rejection shape when AbortSignal.timeout fires.
		(globalThis as { fetch: unknown }).fetch = vi.fn(async () => {
			throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
		});
		await expect(d1Query("SELECT * FROM sessions WHERE session_id = ?")).rejects.toThrow(
			/D1 API timeout after 10000 ms for: SELECT \* FROM sessions/,
		);
	});

	it("rethrows non-timeout fetch failures untouched", async () => {
		const { d1Query } = await import("./db.js");
		(globalThis as { fetch: unknown }).fetch = vi.fn(async () => {
			throw new TypeError("fetch failed");
		});
		await expect(d1Query("SELECT 1")).rejects.toThrow(/fetch failed/);
	});
});

// ── Migration ledger (#349) ─────────────────────────────────────────────────
// Pins the bookkeeping, not the DDL: pending migrations run in order and get
// recorded; recorded versions never re-run. The DDL statements themselves are
// unchanged pre/post-#349 and stay covered by being exercised on every boot
// of a real deployment.
describe("migrateDb ledger (#349)", () => {
	/** Route the fetch mock by SQL. `handler` returns the `results` array for
	 *  a statement (default []); every statement is captured in `seen`. */
	function mockFetchBySql(handler?: (sql: string) => unknown[] | undefined): string[] {
		const seen: string[] = [];
		(globalThis as { fetch: unknown }).fetch = vi.fn(async (_url: unknown, init: unknown) => {
			const { sql } = JSON.parse((init as { body: string }).body) as { sql: string };
			seen.push(sql);
			const results = handler?.(sql) ?? [];
			return new Response(
				JSON.stringify({
					result: [{ results, success: true, meta: { changes: 0, duration: 0, last_row_id: 0 } }],
					success: true,
					errors: [],
				}),
				{ status: 200 },
			);
		});
		return seen;
	}

	it("applies every migration on a fresh DB and records each in schema_migrations", async () => {
		const { MIGRATIONS, migrateDb } = await import("./db.js");
		const seen = mockFetchBySql((sql) => {
			// Fresh DB: empty ledger; PRAGMA reports the NEW invite shape so
			// the v11 rebuild no-ops (v1 just created the hashed table).
			if (sql.startsWith("PRAGMA table_info(invite_codes)")) return [{ name: "code_hash" }];
			return [];
		});
		await migrateDb();
		const recorded = seen.filter((s) => s.startsWith("INSERT OR IGNORE INTO schema_migrations"));
		expect(recorded).toHaveLength(MIGRATIONS.length);
		// Spot-check the baseline actually ran.
		expect(seen.some((s) => s.includes("CREATE TABLE IF NOT EXISTS users"))).toBe(true);
	});

	it("skips everything when the ledger says all versions are applied (2-call steady state)", async () => {
		const { MIGRATIONS, migrateDb } = await import("./db.js");
		const seen = mockFetchBySql((sql) => {
			if (sql.startsWith("SELECT version FROM schema_migrations")) {
				return MIGRATIONS.map((m) => ({ version: m.version }));
			}
			return [];
		});
		await migrateDb();
		// Steady state: ledger CREATE + ledger SELECT, nothing else — this
		// is the boot-cost win the refactor exists for.
		expect(seen).toHaveLength(2);
		expect(seen.some((s) => s.includes("CREATE TABLE IF NOT EXISTS users"))).toBe(false);
		expect(seen.some((s) => s.startsWith("INSERT OR IGNORE INTO schema_migrations"))).toBe(false);
	});

	it("applies only the pending suffix when partially recorded", async () => {
		const { MIGRATIONS, migrateDb } = await import("./db.js");
		const seen = mockFetchBySql((sql) => {
			if (sql.startsWith("SELECT version FROM schema_migrations")) {
				// Everything applied except the last migration.
				return MIGRATIONS.slice(0, -1).map((m) => ({ version: m.version }));
			}
			if (sql.startsWith("PRAGMA table_info(invite_codes)")) return [{ name: "code_hash" }];
			return [];
		});
		await migrateDb();
		const recorded = seen.filter((s) => s.startsWith("INSERT OR IGNORE INTO schema_migrations"));
		expect(recorded).toHaveLength(1);
		// The one recorded insert is for the pending (last) version — the
		// PRAGMA probe proves v11's apply() ran rather than being skipped.
		expect(seen.some((s) => s.startsWith("PRAGMA table_info"))).toBe(true);
		// And no earlier migration re-ran.
		expect(seen.some((s) => s.includes("CREATE TABLE IF NOT EXISTS users"))).toBe(false);
	});

	// Round-1 BLOCKER regression: a prior v11 crash between DROP and CREATE
	// leaves invite_codes absent; the re-run must RECREATE it, not skip.
	it("v11 recreates invite_codes when the table is missing entirely", async () => {
		const { migrateDb, MIGRATIONS } = await import("./db.js");
		const seen = mockFetchBySql((sql) => {
			if (sql.startsWith("SELECT version FROM schema_migrations")) {
				// Everything recorded except v11 — the crashed run's ledger
				// INSERT never fired.
				return MIGRATIONS.slice(0, -1).map((m) => ({ version: m.version }));
			}
			// Table gone: PRAGMA on a missing table returns zero rows.
			if (sql.startsWith("PRAGMA table_info(invite_codes)")) return [];
			return [];
		});
		await migrateDb();
		expect(seen.some((s) => /CREATE TABLE invite_codes/.test(s))).toBe(true);
		// And no COUNT probe — there is no table to count.
		expect(seen.some((s) => s.includes("SELECT COUNT(*) AS n FROM invite_codes"))).toBe(false);
		expect(
			seen.filter((s) => s.startsWith("INSERT OR IGNORE INTO schema_migrations")),
		).toHaveLength(1);
	});

	it("versions are unique and strictly ascending (append-only guard)", async () => {
		const { MIGRATIONS } = await import("./db.js");
		const versions = MIGRATIONS.map((m) => m.version);
		expect(versions).toEqual([...versions].sort((a, b) => a - b));
		expect(new Set(versions).size).toBe(versions.length);
	});
});
