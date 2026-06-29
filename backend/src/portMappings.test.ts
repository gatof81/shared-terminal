import { beforeEach, describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({
		results: [] as unknown[],
		success: true as const,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	})),
}));
vi.mock("./db.js", () => dbStubs);

import {
	__resetDispatchCacheForTests,
	CACHE_TTL_MS,
	clearPortMappings,
	getPortMappings,
	lookupDispatchTarget,
	mappingsFromConfig,
	type PortMapping,
	setPortMappings,
} from "./portMappings.js";

beforeEach(() => {
	dbStubs.d1Query.mockReset();
	dbStubs.d1Query.mockImplementation(async () => ({
		results: [],
		success: true,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	}));
	__resetDispatchCacheForTests();
});

// ── mappingsFromConfig ───────────────────────────────────────────────────

describe("mappingsFromConfig", () => {
	it("returns [] for an empty port list", () => {
		expect(mappingsFromConfig([])).toEqual([]);
	});

	it("maps declared config ports to mapping rows, copying the public flag", () => {
		expect(
			mappingsFromConfig([
				{ container: 3000, public: false },
				{ container: 80, public: true },
			]),
		).toEqual([
			// host_port is vestigial — written = the container port (the
			// dispatcher proxies by container name now, not host port).
			{ containerPort: 3000, hostPort: 3000, isPublic: false },
			{ containerPort: 80, hostPort: 80, isPublic: true },
		]);
	});
});

// ── setPortMappings ──────────────────────────────────────────────────────

describe("setPortMappings", () => {
	it("issues DELETE-then-INSERT in order, one INSERT per mapping", async () => {
		const mappings: PortMapping[] = [
			{ containerPort: 3000, hostPort: 32768, isPublic: false },
			{ containerPort: 5500, hostPort: 32769, isPublic: true },
		];
		await setPortMappings("sess-1", mappings);

		expect(dbStubs.d1Query).toHaveBeenCalledTimes(3);
		expect(dbStubs.d1Query.mock.calls[0]?.[0]).toMatch(
			/DELETE FROM sessions_port_mappings WHERE session_id/,
		);
		expect(dbStubs.d1Query.mock.calls[0]?.[1]).toEqual(["sess-1"]);
		expect(dbStubs.d1Query.mock.calls[1]?.[0]).toMatch(/INSERT INTO sessions_port_mappings/);
		// Trailing 0/1 is the SQLite-boolean idiom for `is_public`
		// (#190 PR 190c). The dispatcher reads this column to decide
		// whether to require auth before proxying.
		expect(dbStubs.d1Query.mock.calls[1]?.[1]).toEqual(["sess-1", 3000, 32768, 0]);
		expect(dbStubs.d1Query.mock.calls[2]?.[1]).toEqual(["sess-1", 5500, 32769, 1]);
	});

	it("issues only the DELETE when the mapping list is empty", async () => {
		// Spawning with no declared ports must still clear any stale
		// rows from a previous container life — `setPortMappings(s, [])`
		// is the one-call entry point for that.
		await setPortMappings("sess-empty", []);
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(1);
		expect(dbStubs.d1Query.mock.calls[0]?.[0]).toMatch(/DELETE/);
	});
});

// ── getPortMappings ──────────────────────────────────────────────────────

describe("getPortMappings", () => {
	it("returns [] when no rows exist for the session", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		await expect(getPortMappings("sess-x")).resolves.toEqual([]);
	});

	it("rehydrates D1 rows into the typed shape", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [
				{ container_port: 3000, host_port: 32768, is_public: 0 },
				{ container_port: 5500, host_port: 32769, is_public: 1 },
			],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		await expect(getPortMappings("sess-y")).resolves.toEqual([
			{ containerPort: 3000, hostPort: 32768, isPublic: false },
			{ containerPort: 5500, hostPort: 32769, isPublic: true },
		]);
	});
});

// ── clearPortMappings ────────────────────────────────────────────────────

describe("clearPortMappings", () => {
	it("issues a single DELETE bound to the session id", async () => {
		await clearPortMappings("sess-z");
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(1);
		const [sql, params] = dbStubs.d1Query.mock.calls[0]!;
		expect(sql).toMatch(/DELETE FROM sessions_port_mappings WHERE session_id/);
		expect(params).toEqual(["sess-z"]);
	});
});

// ── lookupDispatchTarget ─────────────────────────────────────────────────

// PR #223 round 3 SHOULD-FIX. lookupDispatchTarget is the single
// security gate the dispatcher relies on for every auth decision —
// the JOIN's `s.status = 'running'` filter is what stops the
// dispatcher from proxying to a stopped/soft-deleted session.
// Without these tests a regression on the JOIN shape, the param order,
// or the `is_public === 1` coercion would have no downstream safety
// net (dispatcher tests mock this function out entirely).

describe("lookupDispatchTarget", () => {
	it("returns null when the JOIN finds no row (no mapping OR session not running)", async () => {
		// Both states collapse to "no row in the JOIN result", which is
		// the contract — collapsing both 404s in the dispatcher
		// prevents probe-time enumeration of recently-stopped sessions.
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		await expect(lookupDispatchTarget("sess-x", 3000)).resolves.toBeNull();
	});

	it("returns the typed target when the session is running and the mapping exists", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [
				{ container_port: 3000, container_name: "st-sess-y", is_public: 0, user_id: "u-owner" },
			],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		await expect(lookupDispatchTarget("sess-y", 3000)).resolves.toEqual({
			containerName: "st-sess-y",
			isPublic: false,
			ownerUserId: "u-owner",
		});
	});

	it("coerces is_public: 1 → true (the public-port branch)", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [
				{ container_port: 3000, container_name: "st-sess-pub", is_public: 1, user_id: "u-owner" },
			],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		const got = await lookupDispatchTarget("sess-pub", 3000);
		expect(got?.isPublic).toBe(true);
	});

	it("coerces non-1 is_public values to false (defence-in-depth)", async () => {
		// Stored 0 must rehydrate to false; any other unexpected
		// value (a future migration that wrote 2, a NULL that
		// slipped past NOT NULL, a string from a hand-edit) must
		// also rehydrate to false — never accidentally true.
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [
				{ container_port: 3000, container_name: "st-sess-zero", is_public: 0, user_id: "u-owner" },
			],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		expect((await lookupDispatchTarget("sess-zero", 3000))?.isPublic).toBe(false);

		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [
				{ container_port: 3000, container_name: "st-sess-weird", is_public: 2, user_id: "u-owner" },
			],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		expect((await lookupDispatchTarget("sess-weird", 3000))?.isPublic).toBe(false);
	});

	it("issues the JOIN with the running-status filter, keyed on session only", async () => {
		// Locks the SQL shape so a rename of the status column or a
		// dropped filter is caught immediately. The `running` literal
		// in the SQL is the security gate — losing it would let the
		// dispatcher proxy stopped/terminated sessions. The JOIN also
		// pulls `s.container_name` (the dispatcher's proxy target).
		//
		// Per-port WHERE was REMOVED in #238 — the cache populates the
		// full session-scoped set in one round-trip and serves
		// subsequent per-port lookups from memory. The bound params
		// list is now session-only.
		await lookupDispatchTarget("sess-1", 3000);
		const [sql, params] = dbStubs.d1Query.mock.calls[0]!;
		expect(sql).toMatch(/JOIN\s+sessions\s+s\s+ON\s+s\.session_id\s*=\s*spm\.session_id/i);
		expect(sql).toMatch(/s\.status\s*=\s*'running'/);
		expect(sql).toMatch(/s\.container_name/);
		expect(params).toEqual(["sess-1"]);
	});
});

// ── Dispatch cache (#238) ────────────────────────────────────────────────
//
// The cache layer is hot-path-critical: a wrong invalidation lets a
// stopped session keep proxying (security regression) and a missed
// invalidation lets a stale target keep flowing (correctness
// regression). These tests pin the contract.

describe("lookupDispatchTarget cache (#238)", () => {
	// `containerName` doubles as a per-port identity marker in these
	// cache tests (the value the dispatcher would proxy to); the second
	// arg names it after the port so the assertions stay readable.
	const sessionRow = (containerPort: number, name: string, isPublic = 0) => ({
		container_port: containerPort,
		container_name: name,
		is_public: isPublic,
		user_id: "u-owner",
	});

	it("repeated lookups against the same session hit D1 exactly once", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [sessionRow(3000, "st-p3000")],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		for (let i = 0; i < 100; i++) {
			await lookupDispatchTarget("sess-hot", 3000);
		}
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(1);
	});

	it("different ports for the same session share one D1 round-trip", async () => {
		// The whole point of populating the full session set on first
		// miss: a typical dev session has app + WS + asset proxy on
		// distinct ports, all hit in close succession.
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [
				sessionRow(3000, "st-p3000"),
				sessionRow(5173, "st-p5173"),
				sessionRow(8080, "st-p8080"),
			],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		const a = await lookupDispatchTarget("sess-multi", 3000);
		const b = await lookupDispatchTarget("sess-multi", 5173);
		const c = await lookupDispatchTarget("sess-multi", 8080);
		expect(a?.containerName).toBe("st-p3000");
		expect(b?.containerName).toBe("st-p5173");
		expect(c?.containerName).toBe("st-p8080");
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(1);
	});

	it("returns null for a port that doesn't exist in the cached set without re-querying", async () => {
		// Negative result for an unknown port on a session that's
		// otherwise live must not invalidate the cache — the cache
		// captures the FULL set, so a port that isn't in it truly
		// doesn't exist for that session at this moment.
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [sessionRow(3000, "st-p3000")],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		await lookupDispatchTarget("sess-partial", 3000);
		const missing = await lookupDispatchTarget("sess-partial", 9999);
		expect(missing).toBeNull();
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(1);
	});

	it("does NOT cache an empty result (session not running / no mapping)", async () => {
		// Caching the miss would extend the "session is starting"
		// race window into a 30-second 404 wall — see header comment.
		dbStubs.d1Query.mockImplementation(async () => ({
			results: [],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		await lookupDispatchTarget("sess-empty", 3000);
		await lookupDispatchTarget("sess-empty", 3000);
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(2);
	});

	it("setPortMappings invalidates the cache so the next lookup re-fetches", async () => {
		// First lookup populates cache.
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [sessionRow(3000, "st-p3000")],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		await lookupDispatchTarget("sess-w", 3000);
		// setPortMappings: 1 DELETE + 1 INSERT. Then the next lookup
		// should miss cache and re-query.
		dbStubs.d1Query.mockImplementation(async () => ({
			results: [],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		await setPortMappings("sess-w", [{ containerPort: 3000, hostPort: 32999, isPublic: false }]);
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [sessionRow(3000, "st-p3000-new")],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		const got = await lookupDispatchTarget("sess-w", 3000);
		expect(got?.containerName).toBe("st-p3000-new");
	});

	it("expired entry triggers a fresh D1 call and re-populates the cache", async () => {
		// PR #242 round 2 SHOULD-FIX. Without this test the TTL-expiry
		// branch was unreached: a regression that flipped `>` to `>=`
		// or moved the pre-delete after the await would leave entries
		// either never expiring or lingering as stale forever, and
		// nothing would have caught it.
		vi.useFakeTimers();
		try {
			dbStubs.d1Query.mockImplementation(async () => ({
				results: [sessionRow(3000, "st-p3000")],
				success: true,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			}));
			await lookupDispatchTarget("sess-ttl", 3000);
			expect(dbStubs.d1Query).toHaveBeenCalledTimes(1);

			// Advance past TTL — same shape `setTimeout` users would see.
			vi.advanceTimersByTime(CACHE_TTL_MS + 1);

			await lookupDispatchTarget("sess-ttl", 3000);
			expect(dbStubs.d1Query).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("clearPortMappings invalidates so the next lookup re-fetches and returns null", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [sessionRow(3000, "st-p3000")],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		await lookupDispatchTarget("sess-cl", 3000);
		// Drop mappings: 1 DELETE.
		await clearPortMappings("sess-cl");
		// Subsequent D1 returns no rows (mappings gone, or session no
		// longer running — either collapses to null per the contract).
		dbStubs.d1Query.mockImplementation(async () => ({
			results: [],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		const got = await lookupDispatchTarget("sess-cl", 3000);
		expect(got).toBeNull();
	});

	it("does not cache rows read before a writer invalidated mid-SELECT (#299)", async () => {
		// Reproduces the read-populate-after-invalidate race: lookup A's
		// SELECT is in flight (and will return STALE public rows) when an
		// owner flips the port public->private via setPortMappings. Without
		// the writeEpoch guard, lookup A would cache.set the stale public
		// row AFTER the writer's post-write invalidate, serving it as
		// public/unauthenticated for up to the TTL.
		let releaseSelect!: () => void;
		const selectInFlight = new Promise<void>((r) => {
			releaseSelect = r;
		});
		// Lookup A's SELECT: blocks until released, then returns is_public=1.
		dbStubs.d1Query.mockImplementationOnce(async () => {
			await selectInFlight;
			return {
				results: [sessionRow(3000, "st-stale", 1)],
				success: true,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			};
		});
		const lookupA = lookupDispatchTarget("sess-race", 3000);

		// Writer lands while A's SELECT is in flight (DELETE + INSERT shape
		// irrelevant here; the point is the invalidateCache → writeEpoch bump).
		dbStubs.d1Query.mockImplementation(async () => ({
			results: [],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		await setPortMappings("sess-race", [{ containerPort: 3000, hostPort: 3000, isPublic: false }]);

		// Let A's SELECT resolve with the now-stale public row.
		releaseSelect();
		await lookupA;

		// The stale row must NOT have been cached: the next lookup re-fetches
		// and sees the fresh private value.
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [sessionRow(3000, "st-fresh", 0)],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		const after = await lookupDispatchTarget("sess-race", 3000);
		expect(after?.containerName).toBe("st-fresh");
		expect(after?.isPublic).toBe(false);
	});
});
