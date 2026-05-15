/**
 * observeLog.test.ts — unit tests for the observe-mode audit log
 * module (#201d). Stubs d1Query so each case drives the call sequence
 * the module issues. Mirrors groups.test.ts / templates.test.ts setup.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({
		results: [] as unknown[],
		success: true as const,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	})),
}));
vi.mock("./db.js", () => dbStubs);

import * as observeLog from "./observeLog.js";

beforeEach(() => {
	dbStubs.d1Query.mockReset();
	dbStubs.d1Query.mockImplementation(async () => ({
		results: [],
		success: true,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	}));
});

function mockNextRows(rows: unknown[], changes = 0): void {
	dbStubs.d1Query.mockImplementationOnce(async () => ({
		results: rows,
		success: true,
		meta: { changes, duration: 0, last_row_id: 0 },
	}));
}

// ── recordObserveStart ──────────────────────────────────────────────────────

describe("observeLog.recordObserveStart", () => {
	it("inserts a row with a uuid id and returns it", async () => {
		mockNextRows([], 1);
		const id = await observeLog.recordObserveStart("u-lead", "s-1", "u-owner");
		// Pin the INSERT shape so a future refactor doesn't silently
		// drop the denormalised owner column (the audit-fidelity hook
		// for retention after session hard-delete).
		const call = dbStubs.d1Query.mock.calls[0]!;
		expect(call[0]).toMatch(/^INSERT INTO session_observe_log/);
		const params = call[1] as string[];
		expect(params).toHaveLength(4);
		expect(params[1]).toBe("u-lead");
		expect(params[2]).toBe("s-1");
		expect(params[3]).toBe("u-owner");
		// id is the first param and matches the returned value.
		expect(params[0]).toBe(id);
		// Standard uuid v4 shape.
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});

	it("propagates a D1 INSERT failure so wsHandler can abort the attach", async () => {
		// The audit-trail invariant requires every observe to be logged.
		// Swallowing INSERT failure here would let observe sessions
		// proceed unaudited — the failure must bubble.
		dbStubs.d1Query.mockImplementationOnce(async () => {
			throw new Error("D1 transient");
		});
		await expect(observeLog.recordObserveStart("u-lead", "s-1", "u-owner")).rejects.toThrow(
			"D1 transient",
		);
	});
});

// ── recordObserveEnd ────────────────────────────────────────────────────────

describe("observeLog.recordObserveEnd", () => {
	it("UPDATEs ended_at with the WHERE-ended-at-IS-NULL idempotency guard", async () => {
		mockNextRows([], 1);
		await observeLog.recordObserveEnd("log-1");
		const call = dbStubs.d1Query.mock.calls[0]!;
		// Pin both the SET and the WHERE shapes — the idempotency
		// contract is "second call on the same id is a no-op", which
		// the WHERE l.ended_at IS NULL clause enforces. Removing it
		// would re-stamp ended_at and lose the original close time
		// if ws.on("close") and ws.on("error") both fire.
		expect(call[0]).toMatch(/UPDATE session_observe_log SET ended_at = datetime\('now'\)/);
		expect(call[0]).toMatch(/WHERE id = \? AND ended_at IS NULL/);
		expect(call[1]).toEqual(["log-1"]);
	});

	it("returns successfully when the UPDATE matches zero rows (already ended)", async () => {
		// changes=0 is the legitimate path when the row was already
		// ended by a prior call — recordObserveEnd's job is "make sure
		// ended_at is set", not "set it again". Swallowing changes=0
		// keeps the close-then-error WS teardown shape clean.
		mockNextRows([], 0);
		await expect(observeLog.recordObserveEnd("log-1")).resolves.toBeUndefined();
	});
});

// ── listForSession ──────────────────────────────────────────────────────────

describe("observeLog.listForSession", () => {
	it("returns typed entries with observerUsername inlined and dates parsed", async () => {
		mockNextRows([
			{
				id: "log-1",
				observer_user_id: "u-lead",
				session_id: "s-1",
				owner_user_id: "u-owner",
				started_at: "2026-05-12 10:00:00",
				ended_at: "2026-05-12 10:05:00",
				observer_username: "alice",
			},
		]);
		const list = await observeLog.listForSession("s-1");
		expect(list).toHaveLength(1);
		expect(list[0]?.observerUsername).toBe("alice");
		expect(list[0]?.startedAt).toBeInstanceOf(Date);
		expect(list[0]?.endedAt).toBeInstanceOf(Date);
		// Bound parameters: session id only.
		expect(dbStubs.d1Query.mock.calls[0]![1]).toEqual(["s-1"]);
	});

	it("surfaces in-progress observers via endedAt: null", async () => {
		// Live "who's watching me right now" view of the owner's UI.
		// Without this row shape the owner only sees historical
		// observes, not current ones — the use case the audit trail
		// was added for in the first place.
		mockNextRows([
			{
				id: "log-1",
				observer_user_id: "u-lead",
				session_id: "s-1",
				owner_user_id: "u-owner",
				started_at: "2026-05-12 10:00:00",
				ended_at: null,
				observer_username: "alice",
			},
		]);
		const list = await observeLog.listForSession("s-1");
		expect(list[0]?.endedAt).toBeNull();
	});

	it("issues the ORDER BY started_at DESC + LIMIT clause", async () => {
		mockNextRows([]);
		await observeLog.listForSession("s-1");
		const call = dbStubs.d1Query.mock.calls[0]!;
		expect(call[0]).toMatch(/ORDER BY l\.started_at DESC LIMIT 500/);
	});

	it("returns an empty array for a session with no observe history", async () => {
		mockNextRows([]);
		expect(await observeLog.listForSession("s-never-watched")).toEqual([]);
	});
});

// ── listAll ─────────────────────────────────────────────────────────────────

describe("observeLog.listAll", () => {
	it("joins users twice (observer + owner) and inlines both usernames", async () => {
		mockNextRows([
			{
				id: "log-1",
				observer_user_id: "u-lead",
				session_id: "s-1",
				owner_user_id: "u-owner",
				started_at: "2026-05-12 10:00:00",
				ended_at: null,
				observer_username: "alice",
				owner_username: "bob",
			},
		]);
		const list = await observeLog.listAll();
		expect(list).toHaveLength(1);
		expect(list[0]?.observerUsername).toBe("alice");
		expect(list[0]?.ownerUsername).toBe("bob");
		// Pin the JOIN shape — admin view depends on both joins firing.
		const sql = dbStubs.d1Query.mock.calls[0]![0]!;
		expect(sql).toMatch(/LEFT JOIN users obs/);
		expect(sql).toMatch(/LEFT JOIN users own/);
		expect(sql).toMatch(/ORDER BY l\.started_at DESC LIMIT 500/);
	});

	it("renders (deleted user) tombstones for a LEFT JOIN miss on either side", async () => {
		// CASCADE on `observer_user_id` (or a future owner-side delete
		// path) can leave the audit row briefly orphaned. INNER JOIN
		// would silently drop the row from the admin view — worse
		// outcome than surfacing a tombstone. Pin the tombstone shape
		// so an inadvertent INNER-JOIN rewrite is caught.
		mockNextRows([
			{
				id: "log-1",
				observer_user_id: "u-lead-deleted",
				session_id: "s-1",
				owner_user_id: "u-owner",
				started_at: "2026-05-12 10:00:00",
				ended_at: null,
				observer_username: null,
				owner_username: "bob",
			},
			{
				id: "log-2",
				observer_user_id: "u-lead",
				session_id: "s-2",
				owner_user_id: "u-owner-deleted",
				started_at: "2026-05-12 09:00:00",
				ended_at: null,
				observer_username: "alice",
				owner_username: null,
			},
		]);
		const list = await observeLog.listAll();
		expect(list[0]?.observerUsername).toBe("(deleted user)");
		expect(list[0]?.ownerUsername).toBe("bob");
		expect(list[1]?.observerUsername).toBe("alice");
		expect(list[1]?.ownerUsername).toBe("(deleted user)");
	});

	it("returns an empty array when no observe events have happened", async () => {
		mockNextRows([]);
		expect(await observeLog.listAll()).toEqual([]);
	});
});

// ── Constants ───────────────────────────────────────────────────────────────

describe("OBSERVE_LOG_LIMIT", () => {
	it("is 500 (sized for parity with the admin session-list cap)", () => {
		expect(observeLog.OBSERVE_LOG_LIMIT).toBe(500);
	});
});
