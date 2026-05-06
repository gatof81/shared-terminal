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
		`CREATE TABLE IF NOT EXISTS users (
                        id          TEXT PRIMARY KEY,
                        username    TEXT UNIQUE NOT NULL,
                        password_hash TEXT NOT NULL,
                        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
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
