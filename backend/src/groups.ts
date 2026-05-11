/**
 * groups.ts — admin-managed groups for the tech-lead role (#201).
 *
 * A group is a named collection of users with one designated "lead"
 * who can observe (read-only) the sessions of every member. Schema
 * lives in `db.ts` (user_groups + user_group_members). All CRUD here
 * is admin-only at the route layer — this module has no per-user
 * ownership concept of its own (analogous to `invites` rather than
 * `templates`).
 *
 * Forward-looking 201b/c hooks:
 *   - `groupsLedBy(userId)` powers the `assertCanObserve` extension.
 *   - `sessionsObservableBy(userId)` is the cross-user session list
 *     surface for the tech lead's "My group" view.
 *
 * The lead is implicitly inserted into `user_group_members` on
 * create / re-assigned-via-update, so "sessions visible to user X"
 * reduces to a single JOIN against `user_group_members` (no special-
 * case for the lead's own membership).
 */

import { randomUUID } from "node:crypto";
import { parseD1Utc } from "./d1Time.js";
import { d1Query } from "./db.js";
import { ForbiddenError, NotFoundError } from "./sessionManager.js";

// ── Limits ──────────────────────────────────────────────────────────────────

/**
 * Deployment-wide cap on total groups. Groups are admin-created, not
 * user-created, so there's no per-user quota equivalent — but an
 * unbounded admin-mistake (a script that creates groups in a loop)
 * could still bloat D1. 1000 is generous for a v1 self-hosted
 * deployment without being a free-for-all. Adjust upward if a real
 * deployment hits the cap; the route maps the error to 429 so the
 * operator sees the ceiling clearly.
 */
export const MAX_GROUPS_TOTAL = 1000;

/**
 * Per-group member cap. Same shape rationale as `MAX_GROUPS_TOTAL`
 * — defence against a runaway `addMember` loop or a misconfigured
 * import. A real org with more than 500 users in one tech-lead's
 * scope should split the group, not stretch this cap.
 */
export const MAX_MEMBERS_PER_GROUP = 500;

// ── Types ───────────────────────────────────────────────────────────────────

interface GroupRow {
	id: string;
	name: string;
	description: string | null;
	lead_user_id: string;
	created_at: string;
	updated_at: string;
}

/** Domain shape returned by single-row reads / writes. */
export interface Group {
	id: string;
	name: string;
	description: string | null;
	leadUserId: string;
	createdAt: Date;
	updatedAt: Date;
}

/** List shape — extends `Group` with the lead's username (admin UI
 *  doesn't have to do a second lookup per row) and the member count
 *  (so the dashboard can show "Frontend — 8 members" without a
 *  second JOIN per group). */
export interface GroupSummary extends Group {
	leadUsername: string;
	memberCount: number;
}

/** Single member row as returned by `listMembers`. Joins
 *  `users.username` so the route can serialise without a second
 *  D1 round-trip per member. */
export interface GroupMember {
	userId: string;
	username: string;
	addedAt: Date;
}

export interface GroupInput {
	name: string;
	description?: string | null;
	leadUserId: string;
}

export interface GroupUpdateInput {
	name: string;
	description?: string | null;
	leadUserId: string;
}

const GROUP_NOT_FOUND = "Group not found";

// ── Custom errors ───────────────────────────────────────────────────────────

/** Raised by `create` when the deployment-wide group count is at the
 *  cap. The route maps this to 429. */
export class GroupQuotaExceededError extends Error {
	constructor() {
		super(`Group count exceeds deployment cap of ${MAX_GROUPS_TOTAL}`);
		this.name = "GroupQuotaExceededError";
	}
}

/** Raised by `addMember` when the group is already at its per-group
 *  member cap. The route maps this to 429. */
export class GroupMembersCapExceededError extends Error {
	constructor() {
		super(`Group already at member cap of ${MAX_MEMBERS_PER_GROUP}`);
		this.name = "GroupMembersCapExceededError";
	}
}

/** Raised when a referenced user (lead or member candidate) doesn't
 *  exist in `users`. Route maps to 404. */
export class GroupUserNotFoundError extends Error {
	constructor(userId: string) {
		super(`User ${userId} not found`);
		this.name = "GroupUserNotFoundError";
	}
}

/** Raised when the caller tries to add a user who's already a member.
 *  The route maps this to 409 (the duplicate is observable, unlike
 *  most NotFoundError shapes in this codebase, because the caller
 *  asked for an action that's a no-op on an existing row). */
export class GroupMemberAlreadyExistsError extends Error {
	constructor(userId: string) {
		super(`User ${userId} is already a member of this group`);
		this.name = "GroupMemberAlreadyExistsError";
	}
}

/** Raised when the caller tries to remove the lead from member rows.
 *  The lead is implicitly a member by invariant — the only way to
 *  remove them is to reassign the lead first (via `update`). The
 *  route maps this to 409. */
export class GroupCannotRemoveLeadError extends Error {
	constructor() {
		super("Cannot remove the lead from group members; reassign the lead first");
		this.name = "GroupCannotRemoveLeadError";
	}
}

// ── Row → domain mapping ────────────────────────────────────────────────────

function rowToGroup(row: GroupRow): Group {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		leadUserId: row.lead_user_id,
		createdAt: parseD1Utc(row.created_at, "groups"),
		updatedAt: parseD1Utc(row.updated_at, "groups"),
	};
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * List every group on the deployment, newest-first. Each row carries
 * the lead's username and the member count for the admin UI's row
 * chrome — saves N+1 round-trips on the dashboard render.
 *
 * Admin-gated at the route layer; do NOT call from non-admin paths
 * (it bypasses any scoping).
 */
export async function listAll(): Promise<GroupSummary[]> {
	// Single JOIN: groups ⋈ users (lead) + correlated subquery for
	// member count. Member-count subquery is small (typically 0–500
	// rows per group, hard-capped at `MAX_MEMBERS_PER_GROUP`) so the
	// optimiser can resolve it inline rather than spinning up an
	// extra grouped scan. Same shape as `sessionManager.listAll`
	// using ownerUsername.
	const result = await d1Query<{
		id: string;
		name: string;
		description: string | null;
		lead_user_id: string;
		created_at: string;
		updated_at: string;
		lead_username: string;
		member_count: number;
	}>(
		"SELECT g.id, g.name, g.description, g.lead_user_id, g.created_at, g.updated_at, " +
			"u.username AS lead_username, " +
			"(SELECT COUNT(*) FROM user_group_members m WHERE m.group_id = g.id) AS member_count " +
			"FROM user_groups g " +
			"JOIN users u ON u.id = g.lead_user_id " +
			"ORDER BY g.created_at DESC",
	);
	return result.results.map((row) => ({
		...rowToGroup(row),
		leadUsername: row.lead_username,
		memberCount: row.member_count,
	}));
}

/** Read one group by id. Throws `NotFoundError` if no row exists.
 *  Admin-gated at the route layer. */
export async function getById(groupId: string): Promise<Group> {
	const row = await fetchRow(groupId);
	if (!row) throw new NotFoundError(GROUP_NOT_FOUND);
	return rowToGroup(row);
}

/**
 * List the members of a group. Inner-joins `users` so the route can
 * emit `username` alongside `userId` without a second round-trip per
 * row. Ordered by `added_at` ascending so the UI can render in
 * stable insertion order across refreshes.
 */
export async function listMembers(groupId: string): Promise<GroupMember[]> {
	// Validate the group exists first — without this, a typo'd groupId
	// returns an empty array which a client could mistake for an
	// existing-but-empty group.
	await getById(groupId);
	const result = await d1Query<{ user_id: string; username: string; added_at: string }>(
		"SELECT m.user_id, u.username, m.added_at " +
			"FROM user_group_members m JOIN users u ON u.id = m.user_id " +
			"WHERE m.group_id = ? ORDER BY m.added_at ASC",
		[groupId],
	);
	return result.results.map((row) => ({
		userId: row.user_id,
		username: row.username,
		addedAt: parseD1Utc(row.added_at, "groups"),
	}));
}

/**
 * Forward-looking helper for 201b/c. Returns the ids of every group
 * the caller leads — the gate `assertCanObserve` uses to test
 * "can user X observe session S?" via `lead-of-any-group-containing
 * -ownerOfS`.
 *
 * Kept here (not in 201b) because the SQL belongs alongside the
 * other group reads. 201b wires the auth check that consumes it.
 */
export async function groupsLedBy(userId: string): Promise<string[]> {
	const result = await d1Query<{ id: string }>(
		"SELECT id FROM user_groups WHERE lead_user_id = ?",
		[userId],
	);
	return result.results.map((row) => row.id);
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Create a group with the given lead. The lead is implicitly added
 * to `user_group_members` so the group's own member list never has
 * to special-case "the lead's not in members yet."
 *
 * Race window: the count check and the INSERT aren't atomic on
 * D1's HTTP API (no multi-statement transaction). Two concurrent
 * `create` calls at cap-1 could both land at cap+1 — acceptable
 * because admin-only mutations are low-frequency and the cap is
 * deployment-wide (not per-user, so the worst case is one extra
 * group, not a quota-bypass). Mirrors the templates-quota
 * tradeoff.
 *
 * Throws:
 *   - `GroupUserNotFoundError` if `leadUserId` doesn't exist.
 *   - `GroupQuotaExceededError` if at the deployment cap.
 *   - The FK violation on `lead_user_id` is already caught above
 *     by the explicit pre-check, but D1 enforces the FK too if a
 *     concurrent user-delete races the INSERT.
 */
export async function create(input: GroupInput): Promise<Group> {
	const countResult = await d1Query<{ n: number }>("SELECT COUNT(*) AS n FROM user_groups");
	const existing = countResult.results[0]?.n ?? 0;
	if (existing >= MAX_GROUPS_TOTAL) throw new GroupQuotaExceededError();
	// Pre-validate the lead exists. The FK `ON DELETE RESTRICT` blocks
	// deletion of a referenced user, but an INSERT against a NEVER-
	// existed user would land as a FK violation with an opaque
	// "FOREIGN KEY constraint failed" error. Pre-checking lets the
	// route layer return a clean 404 with a clear message instead.
	await assertUserExists(input.leadUserId);
	const id = randomUUID();
	await d1Query(
		"INSERT INTO user_groups (id, name, description, lead_user_id) VALUES (?, ?, ?, ?)",
		[id, input.name, input.description ?? null, input.leadUserId],
	);
	// Insert the lead as the first member. Race window: an admin who
	// concurrently runs `addMember(groupId, leadUserId)` could see a
	// "duplicate" — but the composite PK on `(group_id, user_id)`
	// makes the second INSERT a no-op error that we deliberately
	// swallow here (the invariant is "lead is a member", not "lead
	// is exactly one row, inserted via this code path").
	try {
		await d1Query("INSERT INTO user_group_members (group_id, user_id) VALUES (?, ?)", [
			id,
			input.leadUserId,
		]);
	} catch (err) {
		if (!/UNIQUE constraint failed|already exists/i.test((err as Error).message)) {
			throw err;
		}
	}
	const row = await fetchRow(id);
	if (!row) throw new Error("groups.create: row vanished after insert");
	return rowToGroup(row);
}

/**
 * Update name / description / leadUserId. Reassigning the lead
 * auto-inserts the new lead into `user_group_members` if not
 * already there (preserves the "lead is implicitly a member"
 * invariant). The OLD lead stays as a regular member — admin can
 * remove explicitly via `removeMember` if desired. We don't
 * silently drop the old lead because demoting and remove are
 * separate operations with different semantics; the admin should
 * see what they're doing.
 */
export async function update(groupId: string, input: GroupUpdateInput): Promise<Group> {
	// Read first so a missing group returns 404 rather than a
	// silent "0 rows updated" that the route would otherwise have
	// to translate manually. Cheap — one D1 round-trip we'd need
	// anyway to return the fresh row.
	await getById(groupId);
	await assertUserExists(input.leadUserId);
	await d1Query(
		"UPDATE user_groups SET name = ?, description = ?, lead_user_id = ?, " +
			"updated_at = datetime('now') WHERE id = ?",
		[input.name, input.description ?? null, input.leadUserId, groupId],
	);
	// Mirror create's behaviour: the new lead becomes an implicit
	// member if not already one. Duplicate-INSERT is the expected
	// path when the lead is already a member; swallow the unique
	// constraint error.
	try {
		await d1Query("INSERT INTO user_group_members (group_id, user_id) VALUES (?, ?)", [
			groupId,
			input.leadUserId,
		]);
	} catch (err) {
		if (!/UNIQUE constraint failed|already exists/i.test((err as Error).message)) {
			throw err;
		}
	}
	const row = await fetchRow(groupId);
	if (!row) throw new NotFoundError(GROUP_NOT_FOUND);
	return rowToGroup(row);
}

/**
 * Delete the group. CASCADE on `user_group_members.group_id` cleans
 * up membership rows; no manual sweep needed. A second call on an
 * already-deleted id throws `NotFoundError` (route 404). Sessions
 * of former members are untouched — they simply become invisible
 * to the (now-gone) lead.
 */
export async function deleteGroup(groupId: string): Promise<void> {
	await getById(groupId);
	await d1Query("DELETE FROM user_groups WHERE id = ?", [groupId]);
}

/**
 * Add a user to the group's members. Throws:
 *   - `NotFoundError` if the group doesn't exist.
 *   - `GroupUserNotFoundError` if the user doesn't exist.
 *   - `GroupMemberAlreadyExistsError` if the user is already a member.
 *   - `GroupMembersCapExceededError` if the group is at its per-group cap.
 */
export async function addMember(groupId: string, userId: string): Promise<void> {
	await getById(groupId);
	await assertUserExists(userId);
	const countResult = await d1Query<{ n: number }>(
		"SELECT COUNT(*) AS n FROM user_group_members WHERE group_id = ?",
		[groupId],
	);
	const existing = countResult.results[0]?.n ?? 0;
	if (existing >= MAX_MEMBERS_PER_GROUP) throw new GroupMembersCapExceededError();
	// Pre-check duplicate so the error path is a clean 409 not a
	// raw FK/UNIQUE error message. Race-safe: a concurrent add
	// landing between this SELECT and the INSERT below would still
	// hit the UNIQUE constraint at the DB layer and bubble up.
	const exists = await d1Query<{ n: number }>(
		"SELECT COUNT(*) AS n FROM user_group_members WHERE group_id = ? AND user_id = ?",
		[groupId, userId],
	);
	if ((exists.results[0]?.n ?? 0) > 0) {
		throw new GroupMemberAlreadyExistsError(userId);
	}
	try {
		await d1Query("INSERT INTO user_group_members (group_id, user_id) VALUES (?, ?)", [
			groupId,
			userId,
		]);
	} catch (err) {
		// Surface a concurrent-add race as 409 too, not 500. The
		// pre-check above narrows the window but doesn't close it
		// (D1's HTTP API has no transaction primitive).
		if (/UNIQUE constraint failed|already exists/i.test((err as Error).message)) {
			throw new GroupMemberAlreadyExistsError(userId);
		}
		throw err;
	}
}

/**
 * Remove a member. Refuses to remove the lead — the invariant is
 * that the lead is always a member. Admin must reassign the lead
 * via `update` first if they want the current lead out of the
 * member list.
 *
 * Idempotent at the user-not-in-group level: removing a user who
 * isn't a member returns silently (matches the DELETE-method
 * convention elsewhere — the post-condition is the same either
 * way). The lead-protection check fires BEFORE the not-a-member
 * check so calling this with the lead's id gives a clear 409
 * instead of a silent no-op.
 */
export async function removeMember(groupId: string, userId: string): Promise<void> {
	const group = await getById(groupId);
	if (group.leadUserId === userId) {
		throw new GroupCannotRemoveLeadError();
	}
	await d1Query("DELETE FROM user_group_members WHERE group_id = ? AND user_id = ?", [
		groupId,
		userId,
	]);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function fetchRow(groupId: string): Promise<GroupRow | null> {
	const result = await d1Query<GroupRow>("SELECT * FROM user_groups WHERE id = ?", [groupId]);
	return result.results[0] ?? null;
}

async function assertUserExists(userId: string): Promise<void> {
	const result = await d1Query<{ id: string }>("SELECT id FROM users WHERE id = ? LIMIT 1", [
		userId,
	]);
	if (result.results.length === 0) {
		throw new GroupUserNotFoundError(userId);
	}
}

// Re-export the standard auth errors so the route layer can import a
// stable set from this module without reaching into sessionManager.
export { ForbiddenError, NotFoundError };
