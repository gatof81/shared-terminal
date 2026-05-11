/**
 * groups.test.ts — unit tests for the user-groups module (#201a).
 *
 * Stubs d1Query so each case can drive the call sequence the module
 * issues. Mirrors templates.test.ts and routes.admin.test.ts setup.
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

import * as groups from "./groups.js";
import { NotFoundError } from "./sessionManager.js";

beforeEach(() => {
	dbStubs.d1Query.mockReset();
	dbStubs.d1Query.mockImplementation(async () => ({
		results: [],
		success: true,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	}));
});

function groupRow(opts: {
	id?: string;
	name?: string;
	description?: string | null;
	leadUserId?: string;
	createdAt?: string;
	updatedAt?: string;
}) {
	return {
		id: opts.id ?? "g-1",
		name: opts.name ?? "Frontend",
		description: opts.description ?? null,
		lead_user_id: opts.leadUserId ?? "u-lead",
		created_at: opts.createdAt ?? "2026-05-11 12:00:00",
		updated_at: opts.updatedAt ?? "2026-05-11 12:00:00",
	};
}

function mockNextRows(rows: unknown[], changes = 0) {
	dbStubs.d1Query.mockImplementationOnce(async () => ({
		results: rows,
		success: true,
		meta: { changes, duration: 0, last_row_id: 0 },
	}));
}

// ── create ──────────────────────────────────────────────────────────────────

describe("groups.create", () => {
	it("inserts a group, inserts the lead as a member, and returns the row", async () => {
		// Calls in order:
		//   1. SELECT COUNT(*) FROM user_groups        → 5
		//   2. SELECT id FROM users WHERE id = ?        → [{id:'u-lead'}]
		//   3. INSERT INTO user_groups
		//   4. INSERT INTO user_group_members (lead)
		//   5. SELECT * FROM user_groups WHERE id = ?
		mockNextRows([{ n: 5 }]); // count
		mockNextRows([{ id: "u-lead" }]); // user-exists
		mockNextRows([], 1); // INSERT group
		mockNextRows([], 1); // INSERT member
		mockNextRows([groupRow({ name: "Frontend", leadUserId: "u-lead" })]);

		const group = await groups.create({
			name: "Frontend",
			description: null,
			leadUserId: "u-lead",
		});
		expect(group.name).toBe("Frontend");
		expect(group.leadUserId).toBe("u-lead");
		// Member-insert call shape: pinned so a future SQL refactor doesn't
		// drop the implicit-lead-membership invariant silently.
		const memberInsertCall = dbStubs.d1Query.mock.calls[3]!;
		expect(memberInsertCall[0]).toMatch(/INSERT INTO user_group_members/);
		expect(memberInsertCall[1]).toContain("u-lead");
	});

	it("throws GroupQuotaExceededError when at the deployment cap", async () => {
		mockNextRows([{ n: groups.MAX_GROUPS_TOTAL }]);
		await expect(groups.create({ name: "X", leadUserId: "u-lead" })).rejects.toBeInstanceOf(
			groups.GroupQuotaExceededError,
		);
		// Only the COUNT query should have fired.
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(1);
	});

	it("throws GroupUserNotFoundError when the lead user doesn't exist", async () => {
		mockNextRows([{ n: 0 }]);
		mockNextRows([]); // user-exists check empty
		await expect(groups.create({ name: "X", leadUserId: "u-missing" })).rejects.toBeInstanceOf(
			groups.GroupUserNotFoundError,
		);
		// Should NOT have reached the INSERT.
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(2);
	});

	it("swallows a UNIQUE-constraint error on the implicit lead-member insert", async () => {
		// Race: a concurrent addMember(groupId, leadId) lands first. The
		// implicit-lead INSERT then hits a UNIQUE constraint, which we
		// deliberately swallow — the invariant is "lead is a member",
		// not "the lead-member row was inserted by THIS code path."
		mockNextRows([{ n: 0 }]); // count
		mockNextRows([{ id: "u-lead" }]); // user-exists
		mockNextRows([], 1); // INSERT group
		dbStubs.d1Query.mockImplementationOnce(async () => {
			throw new Error("UNIQUE constraint failed: user_group_members.group_id, user_id");
		});
		mockNextRows([groupRow({})]); // re-read
		const group = await groups.create({ name: "X", leadUserId: "u-lead" });
		expect(group.id).toBe("g-1");
	});
});

// ── listAll ─────────────────────────────────────────────────────────────────

describe("groups.listAll", () => {
	it("returns the typed shape with leadUsername + memberCount from the JOIN", async () => {
		mockNextRows([
			{
				id: "g-1",
				name: "Frontend",
				description: "FE team",
				lead_user_id: "u-lead",
				created_at: "2026-05-11 12:00:00",
				updated_at: "2026-05-11 12:00:00",
				lead_username: "alice",
				member_count: 8,
			},
		]);
		const list = await groups.listAll();
		expect(list).toHaveLength(1);
		expect(list[0]?.leadUsername).toBe("alice");
		expect(list[0]?.memberCount).toBe(8);
		expect(list[0]?.name).toBe("Frontend");
	});

	it("returns an empty array when no groups exist", async () => {
		mockNextRows([]);
		expect(await groups.listAll()).toEqual([]);
	});
});

// ── getById ─────────────────────────────────────────────────────────────────

describe("groups.getById", () => {
	it("returns the typed row", async () => {
		mockNextRows([groupRow({ name: "Mobile" })]);
		const g = await groups.getById("g-1");
		expect(g.name).toBe("Mobile");
	});

	it("throws NotFoundError for an unknown id", async () => {
		mockNextRows([]);
		await expect(groups.getById("g-nope")).rejects.toBeInstanceOf(NotFoundError);
	});
});

// ── listMembers ─────────────────────────────────────────────────────────────

describe("groups.listMembers", () => {
	it("returns members joined with usernames in added_at ASC order", async () => {
		mockNextRows([groupRow({})]); // getById guard
		mockNextRows([
			{ user_id: "u-1", username: "alice", added_at: "2026-05-11 12:00:00" },
			{ user_id: "u-2", username: "bob", added_at: "2026-05-11 12:00:01" },
		]);
		const members = await groups.listMembers("g-1");
		expect(members).toHaveLength(2);
		expect(members[0]?.username).toBe("alice");
		expect(members[1]?.username).toBe("bob");
	});

	it("throws NotFoundError when the group doesn't exist", async () => {
		mockNextRows([]); // getById empty
		await expect(groups.listMembers("g-nope")).rejects.toBeInstanceOf(NotFoundError);
	});
});

// ── groupsLedBy ─────────────────────────────────────────────────────────────

describe("groups.groupsLedBy", () => {
	it("returns the ids of every group the user leads", async () => {
		mockNextRows([{ id: "g-1" }, { id: "g-2" }]);
		expect(await groups.groupsLedBy("u-lead")).toEqual(["g-1", "g-2"]);
	});

	it("returns an empty array when the user leads no groups", async () => {
		mockNextRows([]);
		expect(await groups.groupsLedBy("u-other")).toEqual([]);
	});
});

// ── isLeadOfUserViaGroup ────────────────────────────────────────────────────

describe("groups.isLeadOfUserViaGroup", () => {
	it("returns true when the LIMIT-1 JOIN finds a matching row", async () => {
		mockNextRows([{ one: 1 }]);
		expect(await groups.isLeadOfUserViaGroup("u-lead", "u-member")).toBe(true);
	});

	it("returns false when no row matches", async () => {
		mockNextRows([]);
		expect(await groups.isLeadOfUserViaGroup("u-not-lead", "u-some-user")).toBe(false);
	});

	it("uses both ids as parameters in the JOIN query", async () => {
		mockNextRows([{ one: 1 }]);
		await groups.isLeadOfUserViaGroup("u-lead", "u-member");
		const call = dbStubs.d1Query.mock.calls[0]!;
		expect(call[0]).toMatch(/JOIN user_group_members/);
		expect(call[0]).toMatch(/LIMIT 1/);
		expect(call[1]).toEqual(["u-lead", "u-member"]);
	});
});

// ── update ──────────────────────────────────────────────────────────────────

describe("groups.update", () => {
	it("updates the row, inserts the new lead as a member, and re-reads", async () => {
		mockNextRows([groupRow({ id: "g-1", leadUserId: "u-old-lead" })]); // getById guard
		mockNextRows([{ id: "u-new-lead" }]); // user-exists
		mockNextRows([], 1); // UPDATE
		mockNextRows([], 1); // INSERT new-lead-as-member
		mockNextRows([groupRow({ id: "g-1", leadUserId: "u-new-lead", name: "Renamed" })]);
		const g = await groups.update("g-1", {
			name: "Renamed",
			description: null,
			leadUserId: "u-new-lead",
		});
		expect(g.name).toBe("Renamed");
		expect(g.leadUserId).toBe("u-new-lead");
		// The UPDATE call must scope by id.
		const updateCall = dbStubs.d1Query.mock.calls[2]!;
		expect(updateCall[0]).toMatch(/^UPDATE user_groups/);
		expect(updateCall[1]).toContain("g-1");
	});

	it("throws NotFoundError if the group doesn't exist", async () => {
		mockNextRows([]); // getById empty
		await expect(groups.update("g-nope", { name: "X", leadUserId: "u" })).rejects.toBeInstanceOf(
			NotFoundError,
		);
	});

	it("throws GroupUserNotFoundError if the new lead doesn't exist", async () => {
		mockNextRows([groupRow({})]); // getById guard
		mockNextRows([]); // user-exists empty
		await expect(
			groups.update("g-1", { name: "X", leadUserId: "u-missing" }),
		).rejects.toBeInstanceOf(groups.GroupUserNotFoundError);
	});

	it("swallows a UNIQUE error when re-inserting the new lead who is already a member", async () => {
		mockNextRows([groupRow({})]); // getById
		mockNextRows([{ id: "u-new-lead" }]); // user-exists
		mockNextRows([], 1); // UPDATE
		dbStubs.d1Query.mockImplementationOnce(async () => {
			throw new Error("UNIQUE constraint failed");
		});
		mockNextRows([groupRow({ leadUserId: "u-new-lead" })]);
		const g = await groups.update("g-1", { name: "X", leadUserId: "u-new-lead" });
		expect(g.leadUserId).toBe("u-new-lead");
	});

	it("skips the lead-as-member INSERT when the lead is unchanged (rename-only PUT)", async () => {
		// Pins #262 round-3 NIT: a rename-only PUT (same lead) should
		// NOT re-INSERT the lead-as-member. Pre-fix this issued a
		// 5th D1 call that always hit a swallowed UNIQUE error.
		mockNextRows([groupRow({ leadUserId: "u-lead" })]); // getById
		mockNextRows([{ id: "u-lead" }]); // user-exists (same lead)
		mockNextRows([], 1); // UPDATE
		mockNextRows([groupRow({ leadUserId: "u-lead", name: "Renamed" })]); // re-read
		const g = await groups.update("g-1", { name: "Renamed", leadUserId: "u-lead" });
		expect(g.name).toBe("Renamed");
		expect(g.leadUserId).toBe("u-lead");
		// Exactly 4 D1 calls — getById, user-exists, UPDATE, re-read.
		// No member INSERT.
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(4);
	});
});

// ── deleteGroup ─────────────────────────────────────────────────────────────

describe("groups.deleteGroup", () => {
	it("deletes the row after the existence guard", async () => {
		mockNextRows([groupRow({})]); // getById
		mockNextRows([], 1); // DELETE
		await groups.deleteGroup("g-1");
		const deleteCall = dbStubs.d1Query.mock.calls[1]!;
		expect(deleteCall[0]).toMatch(/^DELETE FROM user_groups/);
		expect(deleteCall[1]).toContain("g-1");
	});

	it("throws NotFoundError if the group is already gone", async () => {
		mockNextRows([]); // getById empty
		await expect(groups.deleteGroup("g-nope")).rejects.toBeInstanceOf(NotFoundError);
	});
});

// ── addMember ───────────────────────────────────────────────────────────────

describe("groups.addMember", () => {
	function mockHappyPrechecks(opts: { memberCount?: number } = {}) {
		mockNextRows([groupRow({})]); // getById guard
		mockNextRows([{ id: "u-new" }]); // user-exists
		mockNextRows([{ n: opts.memberCount ?? 0 }]); // members count
		mockNextRows([{ n: 0 }]); // duplicate-check
	}

	it("inserts the member when all guards pass", async () => {
		mockHappyPrechecks();
		mockNextRows([], 1); // INSERT
		await groups.addMember("g-1", "u-new");
		const insertCall = dbStubs.d1Query.mock.calls[4]!;
		expect(insertCall[0]).toMatch(/^INSERT INTO user_group_members/);
		expect(insertCall[1]).toEqual(["g-1", "u-new"]);
	});

	it("throws NotFoundError when the group is missing", async () => {
		mockNextRows([]); // getById empty
		await expect(groups.addMember("g-nope", "u-1")).rejects.toBeInstanceOf(NotFoundError);
	});

	it("throws GroupUserNotFoundError when the user is missing", async () => {
		mockNextRows([groupRow({})]); // getById
		mockNextRows([]); // user-exists empty
		await expect(groups.addMember("g-1", "u-missing")).rejects.toBeInstanceOf(
			groups.GroupUserNotFoundError,
		);
	});

	it("throws GroupMembersCapExceededError when the group is at the per-group cap", async () => {
		mockNextRows([groupRow({})]); // getById
		mockNextRows([{ id: "u-new" }]); // user-exists
		mockNextRows([{ n: groups.MAX_MEMBERS_PER_GROUP }]); // at cap
		await expect(groups.addMember("g-1", "u-new")).rejects.toBeInstanceOf(
			groups.GroupMembersCapExceededError,
		);
	});

	it("throws GroupMemberAlreadyExistsError when the duplicate pre-check fires", async () => {
		mockNextRows([groupRow({})]); // getById
		mockNextRows([{ id: "u-dup" }]); // user-exists
		mockNextRows([{ n: 5 }]); // members count
		mockNextRows([{ n: 1 }]); // duplicate-check
		await expect(groups.addMember("g-1", "u-dup")).rejects.toBeInstanceOf(
			groups.GroupMemberAlreadyExistsError,
		);
	});

	it("translates a UNIQUE-constraint race into GroupMemberAlreadyExistsError", async () => {
		mockHappyPrechecks();
		dbStubs.d1Query.mockImplementationOnce(async () => {
			throw new Error("UNIQUE constraint failed: user_group_members.group_id, user_id");
		});
		await expect(groups.addMember("g-1", "u-dup")).rejects.toBeInstanceOf(
			groups.GroupMemberAlreadyExistsError,
		);
	});
});

// ── removeMember ────────────────────────────────────────────────────────────

describe("groups.removeMember", () => {
	it("deletes the member row when not the lead", async () => {
		mockNextRows([groupRow({ leadUserId: "u-lead" })]); // getById
		mockNextRows([], 1); // DELETE
		await groups.removeMember("g-1", "u-member");
		const del = dbStubs.d1Query.mock.calls[1]!;
		expect(del[0]).toMatch(/^DELETE FROM user_group_members/);
		expect(del[1]).toEqual(["g-1", "u-member"]);
	});

	it("refuses to remove the lead", async () => {
		mockNextRows([groupRow({ leadUserId: "u-lead" })]);
		await expect(groups.removeMember("g-1", "u-lead")).rejects.toBeInstanceOf(
			groups.GroupCannotRemoveLeadError,
		);
		// Should not have fired a DELETE.
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(1);
	});

	it("is silent when the user wasn't a member (DELETE matches 0 rows)", async () => {
		mockNextRows([groupRow({ leadUserId: "u-lead" })]);
		mockNextRows([], 0); // DELETE no-op
		await groups.removeMember("g-1", "u-never-was");
		// No throw — convention is post-condition over precondition.
	});
});
