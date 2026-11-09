/**
 * backup.coverage.test.ts — every table the migrations create is either in
 * backup.ts's TABLES (with `sinceSchema` = the migration that creates it) or
 * deliberately excluded here, with the reason. push_subscriptions went
 * unexported from #355 to #560 because nothing compared the two lists.
 *
 * Runs the real MIGRATIONS, one by one, against node:sqlite behind the D1
 * REST shape `d1Query` speaks.
 */

import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Loaded through require: Vite's resolver (vitest 2) does not know `node:sqlite` as a builtin.
const { DatabaseSync } = createRequire(import.meta.url)(
	"node:sqlite",
) as typeof import("node:sqlite");

/** Not backed up, on purpose. */
const EXCLUDED = new Map<string, string>([
	// The ledger: restore runs migrateDb() on the target first, which writes its own.
	["schema_migrations", "restore rebuilds it with migrateDb()"],
]);

let db: DatabaseSyncT;

beforeAll(() => {
	vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
	vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
	vi.stubEnv("D1_DATABASE_ID", "dbid");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string | URL, init?: RequestInit) => {
			const { sql, params } = JSON.parse(String(init?.body)) as { sql: string; params?: unknown[] };
			try {
				const st = db.prepare(sql);
				const bind = (params ?? []) as Array<string | number | null>;
				const rows = /^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql);
				let results: unknown[] = [];
				if (rows) results = st.all(...bind);
				else st.run(...bind);
				return new Response(
					JSON.stringify({
						success: true,
						errors: [],
						result: [{ results, success: true, meta: { changes: 0, duration: 0 } }],
					}),
				);
			} catch (err) {
				return new Response(
					JSON.stringify({
						success: false,
						errors: [{ message: (err as Error).message }],
						result: [],
					}),
				);
			}
		}),
	);
});
afterAll(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

const tables = () =>
	new Set(
		(
			db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
				.all() as Array<{ name: string }>
		).map((r) => r.name),
	);

describe("backup coverage", () => {
	it("backs up every migrated table, each from the migration that creates it", async () => {
		const { MIGRATIONS } = await import("./db.js");
		const { TABLES } = await import("./backup.js");
		db = new DatabaseSync(":memory:");
		db.exec("PRAGMA foreign_keys = ON");
		db.exec(
			"CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT)",
		);

		const createdBy = new Map<string, number>();
		for (const m of MIGRATIONS) {
			const before = tables();
			await m.apply();
			for (const t of tables()) if (!before.has(t)) createdBy.set(t, m.version);
		}

		const backedUp = new Map(TABLES.map((t) => [t.name, t.sinceSchema ?? 1]));
		const migrated = [...tables()].filter((t) => !EXCLUDED.has(t)).sort();
		expect([...backedUp.keys()].sort()).toEqual(migrated);
		// Some tables are rebuilt by a later migration (v11: invite_codes): the
		// last creation counts, and a table without sinceSchema must date from v1–v11.
		for (const [name, since] of backedUp) {
			const v = createdBy.get(name) ?? 1;
			if (since === 1) expect(v, name).toBeLessThanOrEqual(11);
			else expect(since, name).toBe(v);
		}
	});
});
