/**
 * db.ts — SQLite database layer using better-sqlite3.
 *
 * Stores session metadata and user credentials so they survive server restarts.
 * The DB file lives at DATA_DIR/shared-terminal.db (default: ./data/).
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
        if (_db) return _db;

        fs.mkdirSync(DATA_DIR, { recursive: true });
        const dbPath = path.join(DATA_DIR, "shared-terminal.db");
        _db = new Database(dbPath);

        // Performance pragmas
        _db.pragma("journal_mode = WAL");
        _db.pragma("foreign_keys = ON");

        migrate(_db);
        return _db;
}

function migrate(db: Database.Database): void {
        db.exec(`
                CREATE TABLE IF NOT EXISTS users (
                        id          TEXT PRIMARY KEY,
                        username    TEXT UNIQUE NOT NULL,
                        password_hash TEXT NOT NULL,
                        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS sessions (
                        session_id      TEXT PRIMARY KEY,
                        user_id         TEXT NOT NULL REFERENCES users(id),
                        name            TEXT NOT NULL,
                        status          TEXT NOT NULL DEFAULT 'running',
                        container_id    TEXT,
                        container_name  TEXT NOT NULL,
                        cols            INTEGER NOT NULL DEFAULT 120,
                        rows            INTEGER NOT NULL DEFAULT 36,
                        env_vars        TEXT NOT NULL DEFAULT '{}',
                        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                        last_connected_at TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_sessions_user
                        ON sessions(user_id, status);
        `);
}

export function closeDb(): void {
        if (_db) {
                _db.close();
                _db = null;
        }
}
