/**
 * db.ts — Cloudflare D1 database client.
 *
 * All session & user data lives on Cloudflare D1 (serverless SQLite).
 * Accessed via the D1 HTTP API from the home server backend.
 *
 * Required env vars:
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_API_TOKEN
 *   D1_DATABASE_ID
 */

import { logger } from "./logger.js";

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? "";
const DATABASE_ID = process.env.D1_DATABASE_ID ?? "";

interface D1QueryResult<T = Record<string, unknown>> {
	results: T[];
	success: boolean;
	meta: { changes: number; duration: number; last_row_id: number };
}

interface D1ApiResponse<T = Record<string, unknown>> {
	result: D1QueryResult<T>[];
	success: boolean;
	errors: Array<{ code: number; message: string }>;
}

/**
 * Execute a single SQL statement against D1.
 * Returns the results array for SELECT, or meta for INSERT/UPDATE/DELETE.
 */
export async function d1Query<T = Record<string, unknown>>(
	sql: string,
	params?: unknown[],
): Promise<D1QueryResult<T>> {
	const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;

	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${API_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ sql, params: params ?? [] }),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`D1 API error (${res.status}): ${text}`);
	}

	const data = (await res.json()) as D1ApiResponse<T>;
	if (!data.success) {
		throw new Error(`D1 query failed: ${data.errors.map((e) => e.message).join(", ")}`);
	}

	return data.result[0];
}

/**
 * Execute multiple SQL statements (for migrations).
 *
 * Sequential one-statement-per-request. The D1 REST `/query` endpoint
 * does have undocumented multi-statement shapes (semicolon-joined SQL,
 * `{ batch: [...] }` body), but neither has been empirically verified
 * here. Five DDL round-trips at cold start is negligible; trading
 * proven reliability for that tiny optimisation regresses the only
 * code path that runs at every boot. See PR #141 review history.
 */
export async function d1Batch(statements: string[]): Promise<void> {
	for (const sql of statements) {
		const trimmed = sql.trim();
		if (!trimmed) continue;
		await d1Query(trimmed);
	}
}

/**
 * Run migrations to create tables if they don't exist.
 * Call once on server startup.
 */
export async function migrateDb(): Promise<void> {
	logger.info("[db] running D1 migrations…");
	await d1Batch([
		// `is_admin` (0/1) gates invite-mint and revoke (#50). The
		// bootstrap-register path INSERTs is_admin=1; every other account
		// defaults to 0. Auto-promotion of an existing earliest-created
		// user happens AFTER the d1Batch (see migration block below) so a
		// pre-existing single-user deploy doesn't get locked out of
		// minting after the column is added.
		`CREATE TABLE IF NOT EXISTS users (
                        id          TEXT PRIMARY KEY,
                        username    TEXT UNIQUE NOT NULL,
                        password_hash TEXT NOT NULL,
                        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                        is_admin    INTEGER NOT NULL DEFAULT 0
                )`,
		// `sessions` must follow `users` — the FK on user_id references
		// users(id), and these statements run sequentially. Don't reorder
		// without also handling deferred-FK semantics on D1.
		// FK on user_id (#20): D1 enables foreign-key enforcement on every
		// connection by default, so this is load-bearing once user
		// deletion lands. ON DELETE CASCADE: deleting a user purges their
		// sessions atomically, no orphan rows. Pre-existing tables
		// (created before this migration) won't pick up the FK — SQLite
		// has no ADD CONSTRAINT, only table rebuild — so existing
		// deployments need a manual rebuild if they want enforcement on
		// rows that already exist. Documented as a known limitation in
		// the issue.
		`CREATE TABLE IF NOT EXISTS sessions (
                        session_id      TEXT PRIMARY KEY,
                        user_id         TEXT NOT NULL,
                        name            TEXT NOT NULL,
                        status          TEXT NOT NULL DEFAULT 'running',
                        container_id    TEXT,
                        container_name  TEXT NOT NULL,
                        cols            INTEGER NOT NULL DEFAULT 120,
                        rows            INTEGER NOT NULL DEFAULT 36,
                        env_vars        TEXT NOT NULL DEFAULT '{}',
                        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                        last_connected_at TEXT,
                        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )`,
		`CREATE INDEX IF NOT EXISTS idx_sessions_user
                        ON sessions(user_id, status)`,
		// Invite-only registration. The first user is allowed to register
		// without an invite (bootstrap); every subsequent register must
		// claim a row here. Atomic claim is enforced by an UPDATE …
		// WHERE used_at IS NULL with `meta.changes === 1` check, so two
		// concurrent registers can't redeem the same code. expires_at
		// bounds how long an unredeemed code stays valid (NULL = never).
		//
		// `code_hash` (SHA-256 hex of the plaintext) is stored at rest;
		// the plaintext is only returned to the minter once at creation
		// time and never persisted (#49). `code_prefix` is the first
		// 4 hex chars of the plaintext — leaks 16 bits but lets the
		// minter recognise their own codes in the list ("oh, the one
		// starting `ab12` is for bob"); 48 bits of secret remain.
		`CREATE TABLE IF NOT EXISTS invite_codes (
                        code_hash   TEXT PRIMARY KEY,
                        code_prefix TEXT NOT NULL,
                        created_by  TEXT NOT NULL,
                        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                        used_by     TEXT,
                        used_at     TEXT,
                        expires_at  TEXT
                )`,
		`CREATE INDEX IF NOT EXISTS idx_invite_codes_creator
                        ON invite_codes(created_by)`,
		// Session configuration is 1:1 with `sessions.session_id` and is
		// bound at create time (see epic #184 / issue #185). Every column
		// is nullable so a bare `POST /api/sessions` with no config still
		// produces a valid sessions row without forcing a config row to
		// exist; today there's no FK from sessions → session_configs, only
		// the reverse, so a missing config row is the legitimate "no
		// config supplied" state. ON DELETE CASCADE on the FK keeps the
		// table garbage-free when a hard-delete drops the parent.
		//
		// Structured columns where the field has a defined scalar shape;
		// JSON columns for repeating sub-records (repos, ports, env vars)
		// because storing them relationally would require a child table
		// per shape and #184 deliberately defers that scope. Each child
		// issue (#186 env, #188 repos, #190 ports, #191 hooks, #194
		// resources) hardens validation when its UI lands.
		//
		// `bootstrapped_at` gates the one-shot postCreate hook (PR 185b):
		// NULL = not yet run; set to an ISO timestamp on success. The
		// runner uses an UPDATE … WHERE bootstrapped_at IS NULL with
		// `meta.changes === 1` to make the gate atomic across concurrent
		// `start()` calls (e.g. two browser tabs racing to revive a stopped
		// session). See PR 185b for the runner.
		//
		// IMPORTANT — `bootstrapped_at` MUST stay nullable with no
		// DEFAULT. If a `DEFAULT (datetime('now'))` were added (or `NOT
		// NULL` without an explicit insert column), every freshly-
		// persisted config row would land with `bootstrapped_at` already
		// set, the runner's `WHERE bootstrapped_at IS NULL` predicate
		// would never match, and the one-shot postCreate hook would
		// silently never fire — a data-loss-class silent failure for
		// users who expected their repo to be cloned / bootstrap to have
		// run. `created_at` directly below is the only column on this
		// table that legitimately uses `NOT NULL DEFAULT (datetime('now'))`.
		// `persistSessionConfig` deliberately omits `bootstrapped_at`
		// from its INSERT column list to preserve the NULL-on-create
		// invariant; `sessionConfig.test.ts` locks this with an explicit
		// SQL-shape assertion.
		`CREATE TABLE IF NOT EXISTS session_configs (
                        session_id          TEXT PRIMARY KEY,
                        workspace_strategy  TEXT,
                        cpu_limit           INTEGER,
                        mem_limit           INTEGER,
                        idle_ttl_seconds    INTEGER,
                        post_create_cmd     TEXT,
                        post_start_cmd      TEXT,
                        repos_json          TEXT,
                        ports_json          TEXT,
                        env_vars_json       TEXT,
                        auth_json           TEXT,
                        bootstrapped_at     TEXT,
                        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
                        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
                )`,
	]);
	// ALTER for any table that pre-dates the expires_at column (e.g. a dev
	// DB that ran the original migration before this column existed). SQLite
	// has no ADD COLUMN IF NOT EXISTS, so we run it unguarded and swallow
	// the "duplicate column" error. CREATE TABLE above already includes the
	// column for fresh deploys, so this is a no-op there.
	try {
		await d1Query("ALTER TABLE invite_codes ADD COLUMN expires_at TEXT");
	} catch (err) {
		if (!/duplicate column name|already exists/i.test((err as Error).message)) {
			throw err;
		}
	}
	// #50: same shape — add `users.is_admin` to pre-existing tables.
	try {
		await d1Query("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
	} catch (err) {
		if (!/duplicate column name|already exists/i.test((err as Error).message)) {
			throw err;
		}
	}
	// #188 PR 188b: `auth_json` column on `session_configs` — encrypted
	// repo-clone credentials (PAT / SSH key + known_hosts). Same idiom
	// as the columns above: ADD COLUMN unguarded, swallow the duplicate
	// error so re-running migrations on a fresh-deploy DB (where the
	// CREATE TABLE above already declared the column) is a no-op.
	try {
		await d1Query("ALTER TABLE session_configs ADD COLUMN auth_json TEXT");
	} catch (err) {
		if (!/duplicate column name|already exists/i.test((err as Error).message)) {
			throw err;
		}
	}
	// Auto-promote the earliest-created user when no admin exists yet.
	// Idempotent: re-runs are no-ops once an admin row exists. Both
	// fresh deploys post-bootstrap and pre-#50 single-user dev DBs
	// converge on "first user is admin" without operator action. On a
	// truly empty users table the inner SELECT is null → the outer WHERE
	// can't match → no-op, and the bootstrap-register path will set
	// is_admin=1 directly when the first account lands.
	await d1Query(
		"UPDATE users SET is_admin = 1 " +
			"WHERE NOT EXISTS (SELECT 1 FROM users WHERE is_admin = 1) " +
			"AND id = (SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1)",
	);
	// #49 migration: pre-existing `invite_codes` tables that still have
	// the old plaintext `code` column need to be rebuilt. Cloudflare D1
	// has no built-in `sha256()`, so the hash has to be computed in app
	// code — we can't do this purely in SQL, and a streaming rebuild
	// would interleave with normal traffic. Strategy:
	//
	//   - Empty old shape (no rows): drop and immediately recreate
	//     inline with the new (code_hash, code_prefix, …) shape.
	//   - Non-empty old shape: refuse, log loudly with recovery steps.
	//     This codebase had no production invites at the time of
	//     migration, so the loud-fail path is never expected to trip.
	//
	// `PRAGMA table_info` is a SELECT-shaped statement in SQLite; D1
	// returns its rows under `results`.
	const cols = await d1Query<{ name: string }>("PRAGMA table_info(invite_codes)");
	const colNames = new Set(cols.results.map((r) => r.name));
	const isOldShape = colNames.has("code") && !colNames.has("code_hash");
	if (isOldShape) {
		const rowCount = await d1Query<{ n: number }>("SELECT COUNT(*) AS n FROM invite_codes");
		const n = rowCount.results[0]?.n ?? 0;
		if (n > 0) {
			// Loud abort — rebuild logic isn't worth shipping for a path
			// that wasn't hit at the time of migration. Operator runs the
			// rebuild manually if they ever land here.
			throw new Error(
				`invite_codes still has the pre-#49 schema with ${n} row(s). ` +
					"Rebuild manually: dump the rows, hash each `code` to SHA-256 hex, " +
					"and re-INSERT into the new (code_hash, code_prefix, …) shape.",
			);
		}
		logger.warn("[db] migrating empty pre-#49 invite_codes table to hashed-at-rest shape");
		await d1Query("DROP TABLE invite_codes");
		await d1Query(
			`CREATE TABLE invite_codes (
                                code_hash   TEXT PRIMARY KEY,
                                code_prefix TEXT NOT NULL,
                                created_by  TEXT NOT NULL,
                                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                                used_by     TEXT,
                                used_at     TEXT,
                                expires_at  TEXT
                        )`,
		);
		await d1Query(
			"CREATE INDEX IF NOT EXISTS idx_invite_codes_creator ON invite_codes(created_by)",
		);
	}
	logger.info("[db] migrations complete");
}

/** Validate that D1 credentials are configured. */
export function validateD1Config(): void {
	if (!ACCOUNT_ID || !API_TOKEN || !DATABASE_ID) {
		throw new Error(
			"Missing Cloudflare D1 config. Set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, and D1_DATABASE_ID env vars.",
		);
	}
}
