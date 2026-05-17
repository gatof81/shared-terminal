/**
 * sessionManager.ts — D1-backed session metadata.
 *
 * All methods are async since D1 is accessed via HTTP API.
 */

import { v4 as uuidv4 } from "uuid";
import { isUserAdmin } from "./auth.js";
import { parseD1Utc } from "./d1Time.js";
import { d1Query } from "./db.js";
// CJS-safe circular dep: the project compiles to CommonJS, where
// TypeScript emits named imports as property accesses on a captured
// module-exports reference (e.g. `groups_js_1.isLeadOfUserViaGroup`)
// rather than destructured variables. The reference is captured early
// when both modules first load, but the actual property access is
// deferred to call time — by which point both modules have completed
// their top-level evaluation and every export is present. The
// reciprocal import in `groups.ts`
// (`import { ForbiddenError, NotFoundError } from "./sessionManager.js"`)
// is safe for the same reason. ESM live bindings give the same
// behaviour but the load-bearing mechanism here is the CJS shape.
import { isLeadOfUserViaGroup } from "./groups.js";
import { logger } from "./logger.js";
import type { CreateSessionOpts, SessionMeta, SessionStatus } from "./types.js";

// ── Custom errors ───────────────────────────────────────────────────────────

export class NotFoundError extends Error {
	constructor(msg = "Session not found") {
		super(msg);
		this.name = "NotFoundError";
	}
}

export class ForbiddenError extends Error {
	constructor(msg = "Access denied") {
		super(msg);
		this.name = "ForbiddenError";
	}
}

// Caps the number of concurrently *active* sessions (running / stopped /
// anything that hasn't been terminated) a single user can own. Bounds
// resource consumption if an account is compromised or a runaway script
// spams `POST /sessions`: a stolen JWT can create at most this many
// containers, D1 rows, and workspace directories before hitting the
// cap. Terminated sessions don't count — they free a slot immediately
// so the user can always recycle.
//
// Overridable via MAX_ACTIVE_SESSIONS_PER_USER env var. Parsed at module
// load (so changes require a restart), validated to a positive integer;
// any unparseable / non-positive / non-finite value falls back to the
// default AND logs a warning — silently defaulting to 20 when an operator
// set it to "0" (expecting "freeze new sessions") or a typo like "20 "
// with a trailing non-ASCII character would ship the wrong cap with no
// ops-visible signal.
const DEFAULT_MAX_ACTIVE_SESSIONS_PER_USER = 20;
const MAX_ACTIVE_SESSIONS_PER_USER = ((): number => {
	const raw = process.env.MAX_ACTIVE_SESSIONS_PER_USER;
	if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_ACTIVE_SESSIONS_PER_USER;
	const n = Number(raw);
	if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
		// Surface the original value (quoted, so "  " etc. stay visible)
		// and the effective fallback — ops should be able to tell at a
		// glance which variable was wrong and what the server is
		// actually running with. Uses logger.warn rather than throw
		// because a startup abort here would gate the whole server on
		// a non-critical config typo, which is worse than running with
		// the documented default.
		logger.warn(
			`[sessionManager] MAX_ACTIVE_SESSIONS_PER_USER=${JSON.stringify(raw)} ` +
				`is not a positive integer; falling back to ${DEFAULT_MAX_ACTIVE_SESSIONS_PER_USER}`,
		);
		return DEFAULT_MAX_ACTIVE_SESSIONS_PER_USER;
	}
	return n;
})();

export class SessionQuotaExceededError extends Error {
	// Passed through to the HTTP response — include the effective cap so the
	// user knows what "too many" means without asking support.
	readonly quota: number;

	constructor(quota: number) {
		// Phrase as "limit reached" rather than "you already have N
		// active sessions". When this throws, the count is exactly
		// `quota` (the atomic INSERT's WHERE clause guarantees that),
		// so "you already have 20" reads as a count statement — but
		// the purpose of the message is to communicate the *cap*, not
		// a tally. Naming the number as a limit makes the fix
		// (terminate something) obvious.
		super(`Active session limit (${quota}) reached — terminate a session before creating more`);
		this.name = "SessionQuotaExceededError";
		this.quota = quota;
	}
}

// ── Row → domain mapper ────────────────────────────────────────────────────

interface SessionRow {
	session_id: string;
	user_id: string;
	name: string;
	status: string;
	container_id: string | null;
	container_name: string;
	cols: number;
	rows: number;
	env_vars: string;
	created_at: string;
	last_connected_at: string | null;
}

function rowToMeta(row: SessionRow): SessionMeta {
	return {
		sessionId: row.session_id,
		userId: row.user_id,
		name: row.name,
		status: row.status as SessionStatus,
		containerId: row.container_id,
		containerName: row.container_name,
		cols: row.cols,
		rows: row.rows,
		envVars: JSON.parse(row.env_vars),
		createdAt: parseD1Utc(row.created_at, "sessions"),
		lastConnectedAt: row.last_connected_at ? parseD1Utc(row.last_connected_at, "sessions") : null,
	};
}

// ── Ownership cache (#239) ──────────────────────────────────────────────────
//
// `assertOwnership` and its void-return sibling `assertOwnedBy` are called
// on every authed REST hit under `/api/sessions/:id` and on every WS attach.
// CLAUDE.md is explicit: every `d1Query` is an HTTP round-trip to Cloudflare,
// so this is the hottest auth-check path in the app and the natural target
// for caching after the dispatcher cache (#238) shipped.
//
// What we cache: `(sessionId → ownerUserId)` only. The full SessionMeta
// has mutable fields (status, container_id, last_connected_at, env_vars),
// and broadening the cache to those would mean wiring an invalidation hook
// into every UPDATE in this class — high blast radius for a small win.
// Ownership, by contrast, is immutable in v1: there is no transfer flow,
// no admin-takeover, no merge. The only way `user_id` can change is a
// future feature, so the only invalidation we need today is `deleteRow`
// dropping the entry on hard delete.
//
// What we don't cache: negative results (no row, foreign user). A miss
// hits D1; the caller gets `NotFoundError` / `ForbiddenError`. Caching
// negative results would amplify the "session is starting" race window
// (a session that just spawned would 404 from cache for the TTL), and
// the per-IP rate limit on the auth-bearing routes is the throttle for
// probe traffic.
//
// Bounded at OWNERSHIP_CACHE_MAX entries with insertion-order eviction
// (delete-then-insert refreshes a hot session's position so it doesn't
// roll out under cap pressure). 1-hour TTL is the safety net — if a
// future feature lands a transfer/admin-takeover path WITHOUT updating
// the invalidation point here, the staleness window is bounded at the
// TTL rather than the lifetime of the backend process.

/** Exported for the test suite — pin TTL behaviour against the constant
 *  rather than a magic literal that wouldn't surface a future change. */
export const OWNERSHIP_CACHE_TTL_MS = 60 * 60 * 1000;
/** Exported for the test suite — same shape as TTL. The default is
 *  conservative: with a `users.MAX_ACTIVE_SESSIONS_PER_USER = 20` cap
 *  and 500 users this caps memory at ~10k entries × ~80 bytes each. */
export const OWNERSHIP_CACHE_MAX = 10_000;

/**
 * Hard cap on rows returned by `listAll()` (#241d). Sized at 500
 * because a typical operator dashboard refresh on a deployment with
 * hundreds of sessions shouldn't return a multi-megabyte JSON blob.
 * If a deployment grows past this, the dashboard will silently miss
 * older terminated rows — pagination is a follow-up if anyone hits
 * the cap in practice.
 */
export const ADMIN_LIST_LIMIT = 500;

interface OwnershipCacheEntry {
	ownerUserId: string;
	expiresAt: number;
}

// ── SessionManager ──────────────────────────────────────────────────────────

export class SessionManager {
	async create(opts: CreateSessionOpts): Promise<SessionMeta> {
		const sessionId = uuidv4();
		const containerName = `st-${sessionId.slice(0, 12)}`;
		const cols = opts.cols ?? 120;
		const rows = opts.rows ?? 36;
		const envVars = opts.envVars ?? {};

		// Atomic quota check: fold the per-user count into the INSERT so two
		// concurrent POST /sessions from the same user can't both read
		// `count = cap-1` and both insert. Same SQLite-serialised pattern as
		// invite mint and bootstrap-register elsewhere in the codebase. The
		// race loser observes `meta.changes === 0` and raises a typed error
		// the route can map to 429.
		//
		// `terminated` rows don't count (the user soft-deleted them — slot
		// frees immediately so they can recycle).
		// `failed` rows ALSO don't count (PR #207 review): a postCreate
		// hook that exits non-zero leaves the row in `failed` to preserve
		// the captured output for the user to read, but the user can NO
		// LONGER /start it (we 409 on that), so the only valid next step
		// is "fix the hook and create a fresh session". Counting failed
		// rows would mean N typo'd hooks would lock the user out at the
		// quota cap with no recourse short of deleting their failure
		// history, which we want them to keep so they can audit what
		// went wrong.
		const insert = await d1Query(
			`INSERT INTO sessions (session_id, user_id, name, container_name, cols, rows, env_vars)
                         SELECT ?, ?, ?, ?, ?, ?, ?
                         WHERE (
                                 SELECT COUNT(*) FROM sessions
                                 WHERE user_id = ? AND status NOT IN ('terminated', 'failed')
                         ) < ?`,
			[
				sessionId,
				opts.userId,
				opts.name,
				containerName,
				cols,
				rows,
				JSON.stringify(envVars),
				opts.userId,
				MAX_ACTIVE_SESSIONS_PER_USER,
			],
		);
		if (insert.meta.changes !== 1) {
			throw new SessionQuotaExceededError(MAX_ACTIVE_SESSIONS_PER_USER);
		}

		const meta = await this.get(sessionId);
		if (!meta) {
			// Unreachable in practice: we just inserted this row and
			// confirmed changes === 1. Guard anyway so the return type
			// is honest (no non-null assertion) and a hypothetical
			// read-after-write hiccup becomes a loud error rather than
			// a TypeError downstream when callers access .sessionId.
			throw new Error(`sessionManager.create: session ${sessionId} missing from D1 after insert`);
		}
		return meta;
	}

	async get(sessionId: string): Promise<SessionMeta | null> {
		const result = await d1Query<SessionRow>("SELECT * FROM sessions WHERE session_id = ?", [
			sessionId,
		]);
		return result.results.length > 0 ? rowToMeta(result.results[0]) : null;
	}

	async getOrThrow(sessionId: string): Promise<SessionMeta> {
		const meta = await this.get(sessionId);
		if (!meta) throw new NotFoundError();
		return meta;
	}

	private readonly ownershipCache = new Map<string, OwnershipCacheEntry>();

	/**
	 * Auth-only check that doesn't return SessionMeta. Use this at every
	 * call site that discards the return value of `assertOwnership` — the
	 * cache short-circuits the D1 round-trip on a hit, where
	 * `assertOwnership` always has to fetch fresh meta for the caller.
	 *
	 * Throws `NotFoundError` if the session row is gone, `ForbiddenError`
	 * if the row exists but `user_id` doesn't match.
	 */
	async assertOwnedBy(sessionId: string, userId: string): Promise<void> {
		const cached = this.ownershipCache.get(sessionId);
		const now = Date.now();
		if (cached && cached.expiresAt > now) {
			if (cached.ownerUserId !== userId) throw new ForbiddenError();
			return;
		}
		if (cached) {
			// Expired entry — drop before the await so an empty D1 result
			// (session hard-deleted) leaves a clean map. Without this,
			// `getOrThrow` throws NotFoundError without ever touching
			// the cache, and the stale expired entry would linger forever
			// for any session whose `deleteRow` invalidation was missed.
			this.ownershipCache.delete(sessionId);
		}
		const meta = await this.getOrThrow(sessionId);
		this.cacheOwnership(sessionId, meta.userId);
		if (meta.userId !== userId) throw new ForbiddenError();
	}

	async assertOwnership(sessionId: string, userId: string): Promise<SessionMeta> {
		// Negative-result fast path: a cached owner that doesn't match the
		// requested user → 403 without a D1 round-trip. The positive case
		// CAN'T short-circuit here because the caller may use the returned
		// SessionMeta (status, last_connected_at, container_id, env_vars all
		// mutate). Callers that don't need the meta should call
		// `assertOwnedBy` instead — that one short-circuits both directions.
		const cached = this.ownershipCache.get(sessionId);
		const now = Date.now();
		if (cached && cached.expiresAt > now && cached.ownerUserId !== userId) {
			throw new ForbiddenError();
		}
		if (cached && cached.expiresAt <= now) {
			// Mirror the `assertOwnedBy` cleanup: drop expired entries
			// before the await so a `getOrThrow` that throws NotFoundError
			// (session hard-deleted) leaves a clean map. Without this, a
			// missed `deleteRow` invalidation would let a stale entry
			// linger for the full eviction-cap rollover.
			this.ownershipCache.delete(sessionId);
		}
		const meta = await this.getOrThrow(sessionId);
		this.cacheOwnership(sessionId, meta.userId);
		if (meta.userId !== userId) throw new ForbiddenError();
		return meta;
	}

	private cacheOwnership(sessionId: string, ownerUserId: string): void {
		// Delete-then-insert refreshes Map insertion order so frequently-
		// asserted sessions stay near the back and don't get evicted under
		// cap pressure. JS Map preserves insertion order; deleting the
		// first key (`keys().next().value`) is the LRU-by-access
		// approximation a Map gives us without an explicit doubly-linked-
		// list — adequate for the bounded-cache use case here.
		this.ownershipCache.delete(sessionId);
		if (this.ownershipCache.size >= OWNERSHIP_CACHE_MAX) {
			const oldestKey = this.ownershipCache.keys().next().value;
			if (oldestKey !== undefined) this.ownershipCache.delete(oldestKey);
		}
		this.ownershipCache.set(sessionId, {
			ownerUserId,
			expiresAt: Date.now() + OWNERSHIP_CACHE_TTL_MS,
		});
	}

	// ── Observe-access primitive (#201b) ────────────────────────────────────
	//
	// `assertCanObserve` is the auth choke point for the new tech-lead read
	// paths landing in 201c (the lead's "My groups" cross-user session list)
	// and 201d (observe-mode WS attach). It accepts a graded set of
	// observers:
	//
	//   1. The session owner (cheapest path — covered by the ownership cache
	//      from #239 so a repeated observe by the owner hits no D1).
	//   2. Any user with `is_admin=1` (admins already see every session via
	//      the admin dashboard; the observe path is just another way in).
	//   3. The lead of ANY group containing the session owner (the actual
	//      v1 new capability — gated by a single indexed point read via
	//      `isLeadOfUserViaGroup`).
	//
	// All other callers throw `ForbiddenError` (route → 403). A missing
	// session row throws `NotFoundError` (route → 404) — collapsing
	// observe-of-missing into a generic 404 matches the existing
	// `assertOwnership` shape and the dispatcher's no-status-leak posture.
	//
	// No write capability is granted by this method — destructive paths
	// (stop / start / delete / env-update) still go through
	// `assertOwnership`. The two checks are deliberately separate so a
	// future feature that broadens observe (e.g. adding "any authed user
	// in the same org") doesn't accidentally widen the write surface.
	//
	// Caching shape: the ownership cache short-circuits the owner-positive
	// path (cache hit when observer === cached_owner). Admin lookups and
	// lead-of-user JOIN are NOT cached — the observe path is rare relative
	// to the owner-only path, and caching tech-lead access would mean
	// invalidating on every `addMember` / `removeMember` / `update` (lead
	// reassignment), which is a bigger surface than the saved round-trip
	// justifies.

	/**
	 * Read-access check that returns the SessionMeta on success. Use this
	 * at call sites that need the meta (the route serializer, the WS
	 * attach handler). Throws `NotFoundError` if no session row exists,
	 * `ForbiddenError` if the observer is none of: owner / admin / lead-
	 * of-group-containing-owner.
	 */
	async assertCanObserve(sessionId: string, observerUserId: string): Promise<SessionMeta> {
		// Owner positive path — leverages the ownership cache. Same
		// `assertOwnership`-shaped flow that fetches fresh meta even on
		// cache hit (callers may consume mutable fields).
		const meta = await this.getOrThrow(sessionId);
		this.cacheOwnership(sessionId, meta.userId);
		if (meta.userId === observerUserId) return meta;
		// Admin positive path. `isUserAdmin` throws on D1 failure rather
		// than silently returning false — propagate so the route maps
		// the transient error to 500 instead of falsely returning 403.
		if (await isUserAdmin(observerUserId)) return meta;
		// Tech-lead positive path: is the observer the lead of any
		// group containing the owner? Single indexed JOIN with LIMIT 1
		// inside `isLeadOfUserViaGroup`.
		if (await isLeadOfUserViaGroup(observerUserId, meta.userId)) return meta;
		throw new ForbiddenError();
	}

	/**
	 * Void-return sibling of `assertCanObserve` for call sites that don't
	 * need the SessionMeta (e.g. a future helper that just answers
	 * "should this user see the observe button?"). Mirrors the
	 * `assertOwnedBy` shape — short-circuits both positive AND negative
	 * directions from the ownership cache before falling through to
	 * admin / lead lookups.
	 */
	async assertCanObserveBy(sessionId: string, observerUserId: string): Promise<void> {
		const cached = this.ownershipCache.get(sessionId);
		const now = Date.now();
		// Cache hit, observer is the cached owner — bypass D1 entirely.
		// Negative-cache shape: observer != cached_owner means we still
		// have to check admin / lead, so we don't short-circuit there
		// (mirrors how `assertOwnedBy` only short-circuits the positive
		// hit + immediate-forbid for owner-only checks).
		if (cached && cached.expiresAt > now && cached.ownerUserId === observerUserId) return;
		if (cached && cached.expiresAt <= now) {
			// Mirror the assertOwnedBy cleanup: drop expired entries
			// before the await so a `getOrThrow` that throws NotFoundError
			// (session hard-deleted) leaves a clean map.
			this.ownershipCache.delete(sessionId);
		}
		const meta = await this.getOrThrow(sessionId);
		this.cacheOwnership(sessionId, meta.userId);
		if (meta.userId === observerUserId) return;
		if (await isUserAdmin(observerUserId)) return;
		if (await isLeadOfUserViaGroup(observerUserId, meta.userId)) return;
		throw new ForbiddenError();
	}

	/**
	 * Cross-user session list for the admin dashboard (#241d). Returns
	 * every session row across every user, paired with the owner's
	 * username, newest-first. Hard-capped at `ADMIN_LIST_LIMIT` so a
	 * deployment with 10k accumulated sessions doesn't return a
	 * 10MB JSON blob on a routine dashboard refresh.
	 *
	 * Admin-gated at the route layer; do NOT call this from any
	 * non-admin code path — it bypasses user-scoping.
	 *
	 * The JOIN to `users` is unconditional inner-join because the FK
	 * means every session row has a parent user; if a row ever slips
	 * past that (manual D1 edit), it's silently dropped from the
	 * admin list, which is the safer fallback vs surfacing a null
	 * username the UI would have to special-case.
	 */
	async listAll(): Promise<Array<SessionMeta & { ownerUsername: string }>> {
		const result = await d1Query<SessionRow & { username: string }>(
			"SELECT s.*, u.username AS username " +
				"FROM sessions s JOIN users u ON u.id = s.user_id " +
				`ORDER BY s.created_at DESC LIMIT ${ADMIN_LIST_LIMIT}`,
		);
		return result.results.map((row) => ({
			...rowToMeta(row),
			ownerUsername: row.username,
		}));
	}

	/**
	 * Counts of sessions across the whole table, grouped by status.
	 * Surfaced via `GET /api/admin/stats` (#241). Cross-user aggregate
	 * — admin-gated at the route layer; do NOT call this from any
	 * non-admin code path.
	 *
	 * Returns a record keyed by every valid `SessionStatus` so callers
	 * can render zero-counts without per-key existence checks. Statuses
	 * the database doesn't know about (a future migration adds one,
	 * GROUP BY emits it before the type is updated) are silently
	 * dropped — the route's serializer handles the typed surface.
	 */
	async countByStatus(): Promise<Record<SessionStatus, number>> {
		const result = await d1Query<{ status: string; n: number }>(
			"SELECT status, COUNT(*) AS n FROM sessions GROUP BY status",
		);
		const out: Record<SessionStatus, number> = {
			running: 0,
			stopped: 0,
			terminated: 0,
			failed: 0,
		};
		for (const row of result.results) {
			if (row.status in out) {
				out[row.status as SessionStatus] = row.n;
			}
		}
		return out;
	}

	async listForUser(userId: string): Promise<SessionMeta[]> {
		const result = await d1Query<SessionRow>(
			"SELECT * FROM sessions WHERE user_id = ? AND status != 'terminated' ORDER BY created_at DESC",
			[userId],
		);
		return result.results.map(rowToMeta);
	}

	async listAllForUser(userId: string): Promise<SessionMeta[]> {
		const result = await d1Query<SessionRow>(
			"SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC",
			[userId],
		);
		return result.results.map(rowToMeta);
	}

	async setContainerId(sessionId: string, containerId: string | null): Promise<void> {
		await d1Query("UPDATE sessions SET container_id = ? WHERE session_id = ?", [
			containerId,
			sessionId,
		]);
	}

	async updateStatus(sessionId: string, status: SessionStatus): Promise<void> {
		await d1Query("UPDATE sessions SET status = ? WHERE session_id = ?", [status, sessionId]);
	}

	// Atomic "container was removed out-of-band" write. Collapsing the two
	// fields into one UPDATE closes the crash window where nulling the id
	// would succeed but the status flip wouldn't — leaving the row at
	// (null, running), which a subsequent `WHERE status='running'` reconcile
	// would re-pick up anyway, but a /start or WS attach in between would
	// misread.
	async recordContainerGone(sessionId: string): Promise<void> {
		await d1Query(
			"UPDATE sessions SET status = 'stopped', container_id = NULL WHERE session_id = ?",
			[sessionId],
		);
	}

	async updateConnected(sessionId: string): Promise<void> {
		await d1Query("UPDATE sessions SET last_connected_at = datetime('now') WHERE session_id = ?", [
			sessionId,
		]);
	}

	async updateEnvVars(sessionId: string, envVars: Record<string, string>): Promise<void> {
		await d1Query("UPDATE sessions SET env_vars = ? WHERE session_id = ?", [
			JSON.stringify(envVars),
			sessionId,
		]);
	}

	/**
	 * Persist the captured bootstrap output (success or failure) to D1
	 * so a failed session's modal contents survive after the WS closes.
	 * Surfaced via `GET /sessions/:id/bootstrap-log` (#274).
	 *
	 * Caller is responsible for tail-truncation — `BOOTSTRAP_LOG_MAX_BYTES`
	 * inside `bootstrap.ts` keeps the row size bounded.
	 */
	async setBootstrapLog(sessionId: string, log: string): Promise<void> {
		await d1Query("UPDATE sessions SET bootstrap_log = ? WHERE session_id = ?", [log, sessionId]);
	}

	/** Read just the bootstrap_log column. Returns null when the column
	 *  is null (no bootstrap ever ran, or a session created before #274
	 *  migrated). Separate from `get()` so a sidebar refresh doesn't
	 *  pull a potentially-large 64 KiB blob on every poll. */
	async getBootstrapLog(sessionId: string): Promise<string | null> {
		const result = await d1Query<{ bootstrap_log: string | null }>(
			"SELECT bootstrap_log FROM sessions WHERE session_id = ?",
			[sessionId],
		);
		return result.results[0]?.bootstrap_log ?? null;
	}

	async terminate(sessionId: string): Promise<void> {
		await this.updateStatus(sessionId, "terminated");
	}

	/**
	 * Permanently delete the session row (hard delete). Caller is responsible
	 * for having already killed any running container and for cleaning up any
	 * workspace data on disk.
	 */
	async deleteRow(sessionId: string): Promise<void> {
		// Invalidate before AND after to defend against a concurrent
		// assertOwnership landing between the cache delete and the D1
		// DELETE. Pre-delete prevents a stale cache hit from succeeding
		// while the row is being torn down; post-delete clears any cache
		// state a concurrent assert populated during the await window.
		this.ownershipCache.delete(sessionId);
		await d1Query("DELETE FROM sessions WHERE session_id = ?", [sessionId]);
		this.ownershipCache.delete(sessionId);
	}
}
