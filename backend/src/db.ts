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
 */
export async function d1Batch(statements: string[]): Promise<void> {
        // D1 doesn't have a batch endpoint via HTTP, so run sequentially
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
        console.log("[db] running D1 migrations…");
        await d1Batch([
                `CREATE TABLE IF NOT EXISTS users (
                        id          TEXT PRIMARY KEY,
                        username    TEXT UNIQUE NOT NULL,
                        password_hash TEXT NOT NULL,
                        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
                )`,
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
                        last_connected_at TEXT
                )`,
                `CREATE INDEX IF NOT EXISTS idx_sessions_user
                        ON sessions(user_id, status)`,
                // Invite-only registration. The first user is allowed to register
                // without an invite (bootstrap); every subsequent register must
                // claim a row here. Atomic claim is enforced by an UPDATE …
                // WHERE used_at IS NULL with `meta.changes === 1` check, so two
                // concurrent registers can't redeem the same code.
                `CREATE TABLE IF NOT EXISTS invite_codes (
                        code        TEXT PRIMARY KEY,
                        created_by  TEXT NOT NULL,
                        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                        used_by     TEXT,
                        used_at     TEXT
                )`,
                `CREATE INDEX IF NOT EXISTS idx_invite_codes_creator
                        ON invite_codes(created_by)`,
        ]);
        console.log("[db] migrations complete");
}

/** Validate that D1 credentials are configured. */
export function validateD1Config(): void {
        if (!ACCOUNT_ID || !API_TOKEN || !DATABASE_ID) {
                throw new Error(
                        "Missing Cloudflare D1 config. Set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, and D1_DATABASE_ID env vars.",
                );
        }
}
