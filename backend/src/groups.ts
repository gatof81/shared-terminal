/**
 * groups.ts — admin-managed groups for the tech-lead role (#201).
 *
 * A group is a named collection of users with one designated "lead"
 * who can observe (read-only) the sessions of every member. Schema
 * lives in `db.ts` (user_groups + user_group_members). Group CRUD
 * (create / update / delete / addMember / removeMember) is admin-
 * only at the route layer; the lead-side READ surface is auth-only
 * (any authed user can call `/api/groups/mine[/sessions]` and the
 * SQL itself does the user-scoping).
 *
 * Auth integration:
 *   - `isLeadOfUserViaGroup(leadId, memberId)` is the indexed
 *     point-read consumed by `SessionManager.assertCanObserve`
 *     (#201b) for the observe-mode auth check.
 *   - `listGroupsLedBy(userId)` and `sessionsObservableBy(userId)`
 *     (#201c) are the lead-side reads behind `/api/groups/mine`
 *     and `/api/groups/mine/sessions` respectively.
 *
 * The lead is implicitly inserted into `user_group_members` on
 * create / re-assigned-via-update, so "sessions visible to user X"
 * reduces to a single JOIN against `user_group_members` (no special-
 * case for the lead's own membership).
 */

import { randomUUID } from "node:crypto";
import { parseD1Utc } from "./d1Time.js";
import { d1Query } from "./db.js";
import { ADMIN_LIST_LIMIT, ForbiddenError, NotFoundError } from "./sessionManager.js";
import type { SessionStatus } from "./types.js";

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

/** Lead-side group shape returned by `listGroupsLedBy`. Extends
 *  `Group` with the inlined member list so the `GET /api/groups/mine`
 *  endpoint renders in one round-trip per lead, regardless of how
 *  many groups they lead — the implementation does two D1 calls
 *  total (groups + a single IN-clause member fetch) and zips the
 *  result in JS. */
export interface LeadGroup extends Group {
	members: GroupMember[];
}

/** Cross-user session row returned by `sessionsObservableBy` — the
 *  lead's read-only view of "every session a member of any group I
 *  lead currently owns." Shape mirrors the admin cross-user list
 *  (`sessionManager.listAll`) but excludes `envVars`: the lead's
 *  observability surface is intentionally narrower than admin's,
 *  and the list view doesn't need plaintext env. A future per-
 *  session lead GET (the redaction-locked-in path from #201) can
 *  surface env via `redactStoredEntries` once that endpoint ships. */
export interface ObservableSessionMeta {
	sessionId: string;
	ownerUserId: string;
	ownerUsername: string;
	name: string;
	status: SessionStatus;
	containerId: string | null;
	containerName: string;
	cols: number;
	rows: number;
	createdAt: Date;
	lastConnectedAt: Date | null;
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
 * Returns the ids of every group `userId` leads. Surfaced to the
 * tech-lead "My groups" view in 201c. The SessionManager's
 * `assertCanObserve` uses the narrower `isLeadOfUserViaGroup`
 * predicate below instead — it answers the auth question with one
 * indexed point read rather than fetching every group the lead
 * owns and filtering client-side.
 */
export async function groupsLedBy(userId: string): Promise<string[]> {
	const result = await d1Query<{ id: string }>(
		"SELECT id FROM user_groups WHERE lead_user_id = ?",
		[userId],
	);
	return result.results.map((row) => row.id);
}

/**
 * Auth predicate for `SessionManager.assertCanObserve` (#201b):
 * is `leadUserId` the lead of ANY group whose membership contains
 * `memberUserId`? Returns true iff yes.
 *
 * Single JOIN with `LIMIT 1` so the optimiser short-circuits as
 * soon as a match is found. Both ids are indexed (`lead_user_id`
 * via idx_user_groups_lead, `member.user_id` via the composite
 * PK on user_group_members), so the query is a point read on
 * normal volumes. No caching — the observe path is rare relative
 * to the owner path that does most of the work.
 *
 * Edge: a user who leads a group and is also a member of that
 * group (always true by invariant, since `create` and `update`
 * insert the lead as a member) returns `true` for
 * `isLeadOfUserViaGroup(leadId, leadId)`. The caller
 * (`assertCanObserve`) short-circuits the self-case before
 * reaching here, so the function staying honest doesn't matter
 * for auth correctness — but it does mean the function is a
 * pure relational predicate, not "is X the lead of someone
 * else."
 */
export async function isLeadOfUserViaGroup(
	leadUserId: string,
	memberUserId: string,
): Promise<boolean> {
	const result = await d1Query<{ one: number }>(
		"SELECT 1 AS one FROM user_groups g " +
			"JOIN user_group_members m ON m.group_id = g.id " +
			"WHERE g.lead_user_id = ? AND m.user_id = ? LIMIT 1",
		[leadUserId, memberUserId],
	);
	return result.results.length > 0;
}

// ── Lead-side reads (#201c) ────────────────────────────────────────────────
//
// Two reads power the tech-lead's "My groups" UI without requiring
// admin gating. Both are user-scoped — the lead can only see groups
// they personally lead, and sessions whose owners are members of one
// of those groups. Auth at the route layer is `requireAuth` only
// (no admin); the SQL itself is the user-scoping. A non-lead caller
// gets an empty array from both helpers, NOT a 403 — the auth
// gradient surfaces "the user has lead privileges" via the
// `listGroupsLedBy` result being non-empty, not via a separate
// status code. This matches the "groups where I'm lead" / "any user"
// audience in the issue lock-in.

/**
 * Return every group `userId` leads, newest-first, with each group's
 * full member list inlined. Two D1 round-trips total regardless of
 * how many groups the user leads:
 *
 *   1. Fetch all groups where `lead_user_id = userId`.
 *   2. If any groups came back, fetch ALL their members in a single
 *      IN-clause query joined to `users.username`.
 *
 * Then zip in JS. The IN-clause is built from the group ids the
 * first query returned, so the parameter list is bounded by however
 * many groups the lead leads — which is itself bounded by the
 * deployment-wide `MAX_GROUPS_TOTAL` cap (1000 today). D1 runs
 * SQLite 3.46+, where SQLITE_MAX_VARIABLE_NUMBER is 32 766; a
 * worst-case "one lead leads every group in a maxed-out deployment"
 * binds 1000 placeholders, well within bounds. Raise
 * `MAX_GROUPS_TOTAL` with care if it ever approaches that ceiling
 * (the older 999-default limit predates SQLite 3.32 / 2020 and is
 * not the relevant number on D1).
 *
 * LEFT JOIN on member fetch is deliberate: a group with no members
 * is impossible by invariant (the lead is implicitly inserted on
 * create), but if a future bug ever left a group empty, returning
 * the group with `members: []` is a better failure mode than
 * silently dropping it from the lead's view.
 */
export async function listGroupsLedBy(userId: string): Promise<LeadGroup[]> {
	const groupsResult = await d1Query<GroupRow>(
		"SELECT * FROM user_groups WHERE lead_user_id = ? ORDER BY created_at DESC",
		[userId],
	);
	if (groupsResult.results.length === 0) return [];
	const groupRows = groupsResult.results;
	const groupIds = groupRows.map((row) => row.id);
	// Parameterised IN-clause. Build the placeholder list dynamically
	// (D1's prepared-statement shape requires one `?` per value) but
	// the values themselves are always bound — never interpolated —
	// so the SQL injection surface is closed at the binding boundary.
	const placeholders = groupIds.map(() => "?").join(",");
	const memberRows = await d1Query<{
		group_id: string;
		user_id: string;
		username: string;
		added_at: string;
	}>(
		`SELECT m.group_id, m.user_id, u.username, m.added_at ` +
			`FROM user_group_members m JOIN users u ON u.id = m.user_id ` +
			`WHERE m.group_id IN (${placeholders}) ` +
			`ORDER BY m.added_at ASC`,
		groupIds,
	);
	// Bucket members by group_id. Initialise every bucket so a group
	// with zero members (the bug-defence case above) still renders as
	// `members: []` rather than `members: undefined`.
	const membersByGroup = new Map<string, GroupMember[]>();
	for (const id of groupIds) membersByGroup.set(id, []);
	for (const row of memberRows.results) {
		membersByGroup.get(row.group_id)?.push({
			userId: row.user_id,
			username: row.username,
			addedAt: parseD1Utc(row.added_at, "groups"),
		});
	}
	return groupRows.map((row) => ({
		...rowToGroup(row),
		members: membersByGroup.get(row.id) ?? [],
	}));
}

/**
 * Return every session owned by any user who is a member of any
 * group `userId` leads, newest-first, hard-capped at
 * `ADMIN_LIST_LIMIT`. The cap is shared with the admin path
 * (`sessionManager.listAll`) — same rationale: a deployment with
 * thousands of accumulated sessions across a lead's groups
 * shouldn't blow a multi-megabyte JSON payload on a routine refresh.
 *
 * Excludes `terminated` sessions: they're soft-deleted by the owner
 * and can't be observed (no container, nothing to attach to). Stays
 * parallel to the owner's default-list shape from `listForUser`,
 * which excludes the same status.
 *
 * Single JOIN-with-IN-subquery: the inner SELECT pulls every user
 * id that's a member of any group led by `userId`; the outer
 * SELECT picks every session of those users, joined to `users` for
 * the owner username. Indexes hit on the inner side: `lead_user_id`
 * via `idx_user_groups_lead`, then `m.group_id` via the leading
 * column of the `user_group_members` composite PK `(group_id,
 * user_id)`. Outer JOIN on `sessions.user_id` walks the existing
 * sessions table. No extra index needed on `sessions(user_id)` at
 * v1 scale — the session table is small and the JOIN is bounded
 * by the inner subquery's small result set.
 *
 * Edge: a lead is implicitly a member of every group they lead, so
 * the inner subquery includes the lead's own user_id. This means
 * `sessionsObservableBy(leadUserId)` includes the lead's OWN
 * sessions. That's the right v1 shape: the lead's "My group"
 * dashboard surfaces every session they can observe, including
 * their own — clients can filter or section client-side if they
 * want a different render. Filtering server-side would mean a lead
 * with no members but one of their own sessions sees nothing,
 * which is a confusing UX for "you lead this group but it's
 * empty."
 */
export async function sessionsObservableBy(userId: string): Promise<ObservableSessionMeta[]> {
	const result = await d1Query<{
		session_id: string;
		user_id: string;
		username: string;
		name: string;
		status: string;
		container_id: string | null;
		container_name: string;
		cols: number;
		rows: number;
		created_at: string;
		last_connected_at: string | null;
	}>(
		"SELECT s.session_id, s.user_id, u.username, s.name, s.status, " +
			"s.container_id, s.container_name, s.cols, s.rows, " +
			"s.created_at, s.last_connected_at " +
			"FROM sessions s JOIN users u ON u.id = s.user_id " +
			"WHERE s.user_id IN ( " +
			"  SELECT m.user_id FROM user_group_members m " +
			"  JOIN user_groups g ON g.id = m.group_id " +
			"  WHERE g.lead_user_id = ? " +
			") AND s.status != 'terminated' " +
			`ORDER BY s.created_at DESC LIMIT ${ADMIN_LIST_LIMIT}`,
		[userId],
	);
	return result.results.map((row) => ({
		sessionId: row.session_id,
		ownerUserId: row.user_id,
		ownerUsername: row.username,
		name: row.name,
		status: row.status as SessionStatus,
		containerId: row.container_id,
		containerName: row.container_name,
		cols: row.cols,
		rows: row.rows,
		createdAt: parseD1Utc(row.created_at, "sessions"),
		lastConnectedAt: row.last_connected_at ? parseD1Utc(row.last_connected_at, "sessions") : null,
	}));
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
	// Read first so a missing group returns 404 rather than a silent
	// "0 rows updated" that the route would otherwise have to translate
	// manually. The current row is also used to skip the member-INSERT
	// below when the lead is unchanged (avoiding a wasted D1 call +
	// swallowed UNIQUE error on every rename-only PUT).
	const current = await getById(groupId);
	await assertUserExists(input.leadUserId);
	await d1Query(
		"UPDATE user_groups SET name = ?, description = ?, lead_user_id = ?, " +
			"updated_at = datetime('now') WHERE id = ?",
		[input.name, input.description ?? null, input.leadUserId, groupId],
	);
	// Only re-insert the lead-as-member when the lead actually changed.
	// On a rename-only PUT (lead unchanged), the lead is already in the
	// member table from `create` (or a previous lead-reassignment), so
	// running the INSERT just to swallow a UNIQUE error is one wasted
	// D1 call per call. See #262 round 3 NIT.
	if (input.leadUserId !== current.leadUserId) {
		try {
			await d1Query("INSERT INTO user_group_members (group_id, user_id) VALUES (?, ?)", [
				groupId,
				input.leadUserId,
			]);
		} catch (err) {
			// The new lead might already be a regular member from a
			// prior `addMember` — that's the legitimate path the
			// unique-constraint catch handles. Anything else
			// propagates.
			if (!/UNIQUE constraint failed|already exists/i.test((err as Error).message)) {
				throw err;
			}
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
