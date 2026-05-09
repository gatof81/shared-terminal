import { beforeEach, describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({
		results: [] as unknown[],
		success: true as const,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	})),
}));
vi.mock("./db.js", () => dbStubs);

import { ForbiddenError, NotFoundError } from "./sessionManager.js";
import * as templates from "./templates.js";

beforeEach(() => {
	dbStubs.d1Query.mockReset();
	dbStubs.d1Query.mockImplementation(async () => ({
		results: [],
		success: true,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	}));
});

function row(opts: {
	id?: string;
	owner?: string;
	name?: string;
	description?: string | null;
	config?: string;
	created?: string;
	updated?: string;
}) {
	return {
		id: opts.id ?? "t-1",
		owner_user_id: opts.owner ?? "u1",
		name: opts.name ?? "My Template",
		description: opts.description ?? null,
		config: opts.config ?? "{}",
		created_at: opts.created ?? "2026-05-09 12:00:00",
		updated_at: opts.updated ?? "2026-05-09 12:00:00",
	};
}

function mockOnceRows(rows: ReturnType<typeof row>[]) {
	dbStubs.d1Query.mockImplementationOnce(async () => ({
		results: rows,
		success: true,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	}));
}

// ── create ──────────────────────────────────────────────────────────────

describe("templates.create", () => {
	function mockUnderQuota(currentCount = 0) {
		// SELECT COUNT(*) — first call. Returns the user's current
		// template count so create() decides whether to throw the
		// quota error.
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [{ n: currentCount }],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
	}

	it("inserts a new row and re-reads it back", async () => {
		mockUnderQuota(5);
		// Second call: INSERT (returns no results). Third: SELECT (returns
		// the row).
		dbStubs.d1Query
			.mockImplementationOnce(async () => ({
				results: [],
				success: true,
				meta: { changes: 1, duration: 0, last_row_id: 0 },
			}))
			.mockImplementationOnce(async () => ({
				results: [row({ name: "T", config: '{"cpuLimit":1000000000}', description: "hi" })],
				success: true,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			}));

		const t = await templates.create("u1", {
			name: "T",
			description: "hi",
			config: '{"cpuLimit":1000000000}',
		});

		const insertCall = dbStubs.d1Query.mock.calls[1]!;
		expect(insertCall[0]).toMatch(/INSERT INTO templates/);
		// Param shape: id, owner_user_id, name, description, config.
		expect(insertCall[1]?.[1]).toBe("u1");
		expect(insertCall[1]?.[2]).toBe("T");
		expect(insertCall[1]?.[3]).toBe("hi");
		expect(insertCall[1]?.[4]).toBe('{"cpuLimit":1000000000}');

		expect(t.name).toBe("T");
		expect(t.description).toBe("hi");
		expect(t.config).toEqual({ cpuLimit: 1_000_000_000 });
		expect(t.createdAt.toISOString()).toBe("2026-05-09T12:00:00.000Z");
	});

	it("treats missing description as null on persist", async () => {
		mockUnderQuota(0);
		dbStubs.d1Query
			.mockImplementationOnce(async () => ({
				results: [],
				success: true,
				meta: { changes: 1, duration: 0, last_row_id: 0 },
			}))
			.mockImplementationOnce(async () => ({
				results: [row({ description: null })],
				success: true,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			}));
		await templates.create("u1", { name: "T", config: "{}" });
		const insertCall = dbStubs.d1Query.mock.calls[1]!;
		expect(insertCall[1]?.[3]).toBeNull();
	});

	// PR #228 round 4 SHOULD-FIX: per-user template count cap. Mirrors
	// the session-quota pattern; keeps an authenticated user from
	// exhausting D1 row / storage quotas with a tight create loop.
	it("rejects with TemplateQuotaExceededError once the user is at cap", async () => {
		mockUnderQuota(templates.MAX_TEMPLATES_PER_USER);
		await expect(templates.create("u1", { name: "T", config: "{}" })).rejects.toBeInstanceOf(
			templates.TemplateQuotaExceededError,
		);
	});

	it("does NOT issue an INSERT when at cap (avoids partial state)", async () => {
		mockUnderQuota(templates.MAX_TEMPLATES_PER_USER);
		await expect(templates.create("u1", { name: "T", config: "{}" })).rejects.toBeInstanceOf(
			templates.TemplateQuotaExceededError,
		);
		// Only the COUNT query fired; no INSERT, no follow-up SELECT.
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(1);
		expect(dbStubs.d1Query.mock.calls[0]?.[0]).toMatch(/SELECT COUNT/);
	});

	it("allows create at exactly cap-minus-one (boundary pin)", async () => {
		mockUnderQuota(templates.MAX_TEMPLATES_PER_USER - 1);
		dbStubs.d1Query
			.mockImplementationOnce(async () => ({
				results: [],
				success: true,
				meta: { changes: 1, duration: 0, last_row_id: 0 },
			}))
			.mockImplementationOnce(async () => ({
				results: [row({ name: "T" })],
				success: true,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			}));
		await expect(templates.create("u1", { name: "T", config: "{}" })).resolves.toBeDefined();
	});
});

// ── listForUser ─────────────────────────────────────────────────────────

describe("templates.listForUser", () => {
	it("filters by owner and orders by updated_at DESC", async () => {
		mockOnceRows([row({ name: "Newer" }), row({ name: "Older", id: "t-2" })]);
		const list = await templates.listForUser("u1");
		const [sql, params] = dbStubs.d1Query.mock.calls[0]!;
		expect(sql).toMatch(/WHERE owner_user_id = \?/);
		expect(sql).toMatch(/ORDER BY updated_at DESC/);
		expect(params).toEqual(["u1"]);
		expect(list).toHaveLength(2);
		expect(list[0]?.name).toBe("Newer");
	});

	it("returns [] when user owns no templates", async () => {
		mockOnceRows([]);
		await expect(templates.listForUser("u1")).resolves.toEqual([]);
	});
});

// ── getOwned (collapse missing + forbidden into 404) ────────────────────

describe("templates.getOwned", () => {
	it("returns the row when caller owns it", async () => {
		mockOnceRows([row({ id: "t-1", owner: "u1" })]);
		const t = await templates.getOwned("t-1", "u1");
		expect(t.id).toBe("t-1");
	});

	it("throws NotFoundError when no row exists", async () => {
		mockOnceRows([]);
		await expect(templates.getOwned("t-missing", "u1")).rejects.toBeInstanceOf(NotFoundError);
	});

	it("throws NotFoundError (NOT ForbiddenError) when row is owned by someone else", async () => {
		// Critical: probe attackers shouldn't be able to enumerate
		// "this id exists, you can't see it" vs "this id doesn't
		// exist" by status-code timing on the read path. Both
		// collapse to 404. Same posture sessions.assertOwnership
		// uses on the dispatcher path. Pinning that the rejection
		// is NotFoundError (and explicitly NOT ForbiddenError) so a
		// future refactor that swaps the throw types trips this.
		mockOnceRows([row({ id: "t-1", owner: "u-other" })]);
		await expect(templates.getOwned("t-1", "u1")).rejects.toBeInstanceOf(NotFoundError);
		mockOnceRows([row({ id: "t-1", owner: "u-other" })]);
		await expect(templates.getOwned("t-1", "u1")).rejects.not.toBeInstanceOf(ForbiddenError);
	});
});

// ── assertOwnership (DELETE / PUT — exposes Forbidden separately) ───────

describe("templates.assertOwnership", () => {
	it("returns the row when caller owns it", async () => {
		mockOnceRows([row({ id: "t-1", owner: "u1" })]);
		const t = await templates.assertOwnership("t-1", "u1");
		expect(t.id).toBe("t-1");
	});

	it("throws NotFoundError when no row exists", async () => {
		mockOnceRows([]);
		await expect(templates.assertOwnership("t-x", "u1")).rejects.toBeInstanceOf(NotFoundError);
	});

	it("throws ForbiddenError when row is owned by someone else", async () => {
		// Destructive paths (DELETE, PUT) want the distinction: a
		// non-owner attempting to mutate gets a 403 (clearer signal,
		// surfaces the "you tried something not yours" intent in
		// logs / response). The read path collapses to 404; this path
		// doesn't.
		mockOnceRows([row({ id: "t-1", owner: "u-other" })]);
		await expect(templates.assertOwnership("t-1", "u1")).rejects.toBeInstanceOf(ForbiddenError);
	});
});

// ── update ──────────────────────────────────────────────────────────────

describe("templates.update", () => {
	it("checks ownership, then UPDATEs name/description/config + bumps updated_at", async () => {
		// Three queries: (1) ownership SELECT, (2) UPDATE, (3) re-read SELECT.
		dbStubs.d1Query
			.mockImplementationOnce(async () => ({
				results: [row({ id: "t-1", owner: "u1" })],
				success: true,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			}))
			.mockImplementationOnce(async () => ({
				results: [],
				success: true,
				meta: { changes: 1, duration: 0, last_row_id: 0 },
			}))
			.mockImplementationOnce(async () => ({
				results: [row({ id: "t-1", owner: "u1", name: "new", config: '{"memLimit":1}' })],
				success: true,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			}));

		const t = await templates.update("t-1", "u1", {
			name: "new",
			description: null,
			config: '{"memLimit":1}',
		});

		const updateCall = dbStubs.d1Query.mock.calls[1]!;
		expect(updateCall[0]).toMatch(/UPDATE templates/);
		expect(updateCall[0]).toMatch(/updated_at = datetime\('now'\)/);
		expect(updateCall[1]).toEqual(["new", null, '{"memLimit":1}', "t-1"]);
		expect(t.name).toBe("new");
	});

	it("rejects update when caller is not the owner (ForbiddenError)", async () => {
		mockOnceRows([row({ id: "t-1", owner: "u-other" })]);
		await expect(templates.update("t-1", "u1", { name: "x", config: "{}" })).rejects.toBeInstanceOf(
			ForbiddenError,
		);
	});
});

// ── deleteTemplate ──────────────────────────────────────────────────────

describe("templates.deleteTemplate", () => {
	it("checks ownership, then DELETEs the row", async () => {
		dbStubs.d1Query
			.mockImplementationOnce(async () => ({
				results: [row({ id: "t-1", owner: "u1" })],
				success: true,
				meta: { changes: 0, duration: 0, last_row_id: 0 },
			}))
			.mockImplementationOnce(async () => ({
				results: [],
				success: true,
				meta: { changes: 1, duration: 0, last_row_id: 0 },
			}));
		await templates.deleteTemplate("t-1", "u1");
		const deleteCall = dbStubs.d1Query.mock.calls[1]!;
		expect(deleteCall[0]).toMatch(/^DELETE FROM templates WHERE id = \?/);
		expect(deleteCall[1]).toEqual(["t-1"]);
	});

	it("rejects when not the owner", async () => {
		mockOnceRows([row({ id: "t-1", owner: "u-other" })]);
		await expect(templates.deleteTemplate("t-1", "u1")).rejects.toBeInstanceOf(ForbiddenError);
	});

	it("throws NotFoundError (404) when template was already deleted", async () => {
		// Deletion is NOT idempotent in the response shape: the first
		// call returns 204; a second call returns 404. Clients that
		// retry on a partial network failure must tolerate the 404
		// themselves. (The test name previously said "idempotent
		// re-delete", which contradicted the deleteTemplate JSDoc.)
		mockOnceRows([]);
		await expect(templates.deleteTemplate("t-x", "u1")).rejects.toBeInstanceOf(NotFoundError);
	});
});
