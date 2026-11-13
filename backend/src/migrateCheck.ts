/**
 * migrateCheck.ts — release gate for a schema migration (first use: v20,
 * `sessions.recreate_fence`, contract v1.9.4, #627), run by the operator
 * against REAL data without that data leaving the host:
 *
 *   npm run db:migrate-check -- <backupDir>
 *
 * `<backupDir>` is a directory written by `npm run backup` (one
 * `<table>.jsonl` per table + `manifest.json`). The check:
 *
 *   1. builds a fresh in-memory SQLite (node:sqlite — D1 is SQLite) at the
 *      backup's schema version through the real `migrateDb()`, i.e. the
 *      same ledger path a deployment runs, stopped at that version;
 *   2. loads every table of `backup.ts`'s TABLES list, in its order, with
 *      explicit-column INSERTs (as `restore` does);
 *   3. records, per table, the row count and a SHA-256 over every row's
 *      pre-existing columns in the table's backup ORDER BY;
 *   4. runs `migrateDb()` again, which applies the pending migrations;
 *   5. checks: counts and hashes unchanged, `sessions.recreate_fence`
 *      present and 0 on every row, v20 in `schema_migrations`, no foreign
 *      key violation, `integrity_check` ok.
 *
 * Output is counts, hashes and verdicts ONLY — never a row, a column value
 * or an SQLite error that could echo one (`env_vars`, secret blobs and
 * password hashes are in these tables). No network: `fetch` is replaced
 * for the whole run by a handler that answers the D1 endpoint from the
 * local database and throws on anything else, and the CLI drops the D1
 * credentials from its environment before db.ts is even loaded; it never
 * calls `validateD1Config`. Read-only on the backup directory.
 *
 * Exit: 0 PASS, 1 FAIL, 2 refused (usage, unreadable or unsuitable backup).
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** The migration this gate was written for; a backup at or past it has nothing to prove. */
export const FENCE_MIGRATION = 20;

// ── node:sqlite, typed narrowly (the repo's @types/node predates it) ────────

interface SqliteStatement {
	all(...params: unknown[]): unknown[];
	get(...params: unknown[]): unknown;
	run(...params: unknown[]): { changes: number | bigint };
}
interface SqliteDb {
	prepare(sql: string): SqliteStatement;
	exec(sql: string): void;
	close(): void;
}

function openMemoryDb(): SqliteDb {
	// Any absolute path anchors createRequire; builtins resolve the same.
	const req = createRequire(path.join(process.cwd(), "migrate-check.js"));
	let mod: { DatabaseSync: new (p: string) => SqliteDb };
	try {
		mod = req("node:sqlite") as typeof mod;
	} catch {
		throw new RefusedError("node:sqlite is not available in this Node.js (needs ≥ 22.13)");
	}
	return new mod.DatabaseSync(":memory:");
}

// ── Report ──────────────────────────────────────────────────────────────────

export class RefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RefusedError";
	}
}

export interface TableCheck {
	name: string;
	/** Lines in `<table>.jsonl`; null when the file is absent. */
	jsonlRows: number | null;
	/** What the manifest says was exported; null when it does not list the table. */
	manifestRows: number | null;
	rowsBefore: number;
	rowsAfter: number;
	hashBefore: string;
	hashAfter: string;
	ok: boolean;
}

export interface CheckReport {
	ok: boolean;
	backupCreatedAt: string;
	schemaFrom: number;
	schemaTo: number;
	tables: TableCheck[];
	fence: { column: boolean; rows: number; nonZero: number };
	ledger: { versions: number; hasFence: boolean; max: number };
	foreignKeys: { before: number; after: number };
	integrity: string;
	failures: string[];
}

interface Manifest {
	version: number;
	createdAt: string;
	schemaVersion: number;
	tables: Record<string, number>;
}

const SAFE_COL = /^\w+$/;

function quoteIdent(name: string): string {
	if (!SAFE_COL.test(name)) throw new RefusedError("unsafe identifier in the schema or backup");
	return `"${name}"`;
}

// ── The check ───────────────────────────────────────────────────────────────

export interface CheckOptions {
	/** The migration run after loading; defaults to the real `migrateDb`. Tests inject one. */
	migrate?: () => Promise<void>;
}

export async function runMigrateCheck(
	backupDir: string,
	opts: CheckOptions = {},
): Promise<CheckReport> {
	const manifest = await readManifest(backupDir);
	const db = openMemoryDb();
	const realFetch = globalThis.fetch;
	globalThis.fetch = localD1Fetch(db) as typeof fetch;
	try {
		// Loaded only now (and in the CLI only after the credentials are gone
		// from the environment): db.ts reads them at module load.
		const { MIGRATIONS, migrateDb } = await import("./db.js");
		const { TABLES } = await import("./backup.js");
		const latest = Math.max(...MIGRATIONS.map((m) => m.version));
		if (manifest.schemaVersion >= FENCE_MIGRATION) {
			throw new RefusedError(
				`backup is already at schema v${manifest.schemaVersion} (≥ v${FENCE_MIGRATION}): take the backup BEFORE deploying the migration`,
			);
		}
		if (latest < FENCE_MIGRATION) {
			throw new RefusedError(`this build has no migration v${FENCE_MIGRATION}`);
		}

		// 1. The backup's schema, through the real ledger path: the versions
		//    above it are pre-recorded so `migrateDb()` stops there, then removed.
		db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
			version     INTEGER PRIMARY KEY,
			description TEXT NOT NULL,
			applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
		)`);
		const hold = db.prepare("INSERT INTO schema_migrations (version, description) VALUES (?, ?)");
		for (const m of MIGRATIONS) if (m.version > manifest.schemaVersion) hold.run(m.version, "held");
		await migrateDb();
		db.prepare("DELETE FROM schema_migrations WHERE version > ?").run(manifest.schemaVersion);

		// 2. The rows. Foreign keys off while loading (D1 enforces them; any
		//    violation in the data is reported by foreign_key_check below).
		db.exec("PRAGMA foreign_keys = OFF");
		const failures: string[] = [];
		const present = new Set(
			(
				db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
					name: string;
				}>
			).map((r) => r.name),
		);
		const loaded: Array<{ name: string; orderBy: string; cols: string[]; check: TableCheck }> = [];
		for (const t of TABLES) {
			const lines = await readJsonlLines(backupDir, t.name);
			const manifestRows =
				typeof manifest.tables?.[t.name] === "number" ? manifest.tables[t.name] : null;
			if (!present.has(t.name)) {
				if (lines !== null && lines.length > 0) {
					failures.push(
						`${t.name}: rows in the backup for a table schema v${manifest.schemaVersion} does not have`,
					);
				}
				continue;
			}
			const check: TableCheck = {
				name: t.name,
				jsonlRows: lines?.length ?? null,
				manifestRows,
				rowsBefore: 0,
				rowsAfter: 0,
				hashBefore: "",
				hashAfter: "",
				ok: true,
			};
			if (manifestRows !== null && (lines?.length ?? 0) !== manifestRows) {
				failures.push(
					`${t.name}: ${lines?.length ?? 0} row(s) in the file, manifest says ${manifestRows}`,
				);
				check.ok = false;
			}
			for (const [i, line] of (lines ?? []).entries()) {
				const err = insertRow(db, t.name, line);
				if (err) {
					failures.push(`${t.name}: row ${i + 1} not loaded (${err})`);
					check.ok = false;
				}
			}
			loaded.push({ name: t.name, orderBy: t.orderBy, cols: columnsOf(db, t.name), check });
		}

		// 3. Before.
		for (const l of loaded) {
			const s = snapshot(db, l.name, l.cols, l.orderBy);
			l.check.rowsBefore = s.rows;
			l.check.hashBefore = s.hash;
		}
		const fkBefore = fkViolations(db);

		// 4. The migration under test, as a deployment runs it.
		await (opts.migrate ?? migrateDb)();

		// 5. After.
		for (const l of loaded) {
			const s = snapshot(db, l.name, l.cols, l.orderBy);
			l.check.rowsAfter = s.rows;
			l.check.hashAfter = s.hash;
			if (s.rows !== l.check.rowsBefore || s.hash !== l.check.hashBefore) {
				l.check.ok = false;
				failures.push(`${l.name}: content of the pre-existing columns changed`);
			}
			if (l.check.jsonlRows !== null && l.check.rowsBefore !== l.check.jsonlRows)
				l.check.ok = false;
		}
		const sessionCols = columnsOf(db, "sessions");
		const fence = { column: sessionCols.includes("recreate_fence"), rows: 0, nonZero: 0 };
		fence.rows = count(db, "SELECT COUNT(*) AS n FROM sessions");
		if (fence.column) {
			fence.nonZero = count(db, "SELECT COUNT(*) AS n FROM sessions WHERE recreate_fence IS NOT 0");
		} else {
			failures.push("sessions.recreate_fence: column missing after the migration");
		}
		if (fence.nonZero > 0) failures.push(`sessions.recreate_fence: ${fence.nonZero} row(s) not 0`);
		const versions = (
			db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
				version: number;
			}>
		).map((r) => r.version);
		const ledger = {
			versions: versions.length,
			hasFence: versions.includes(FENCE_MIGRATION),
			max: versions.length > 0 ? Math.max(...versions) : 0,
		};
		if (!ledger.hasFence) failures.push(`schema_migrations: v${FENCE_MIGRATION} not recorded`);
		const fkAfter = fkViolations(db);
		if (fkAfter > 0)
			failures.push(`foreign_key_check: ${fkAfter} violation(s) after the migration`);
		const integrity = String(
			(db.prepare("PRAGMA integrity_check").get() as Record<string, unknown>)?.integrity_check ??
				"unknown",
		);
		if (integrity !== "ok") failures.push("integrity_check: not ok");

		return {
			ok: failures.length === 0,
			backupCreatedAt: manifest.createdAt,
			schemaFrom: manifest.schemaVersion,
			schemaTo: ledger.max,
			tables: loaded.map((l) => l.check),
			fence,
			ledger,
			foreignKeys: { before: fkBefore, after: fkAfter },
			integrity: integrity === "ok" ? "ok" : "not ok",
			failures,
		};
	} finally {
		globalThis.fetch = realFetch;
		db.close();
	}
}

async function readManifest(dir: string): Promise<Manifest> {
	let raw: string;
	try {
		raw = await fs.readFile(path.join(dir, "manifest.json"), "utf8");
	} catch {
		throw new RefusedError(
			`${dir} has no readable manifest.json — not a complete backup (interrupted run?)`,
		);
	}
	let m: Manifest;
	try {
		m = JSON.parse(raw) as Manifest;
	} catch {
		throw new RefusedError("manifest.json is not valid JSON");
	}
	if (m?.version !== 1 || !Number.isInteger(m.schemaVersion) || typeof m.createdAt !== "string") {
		throw new RefusedError("manifest.json is not a backup manifest this tool understands");
	}
	return m;
}

async function readJsonlLines(dir: string, table: string): Promise<string[] | null> {
	let raw: string;
	try {
		raw = await fs.readFile(path.join(dir, `${table}.jsonl`), "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new RefusedError(`${table}.jsonl is not readable`);
	}
	return raw.split("\n").filter((l) => l.trim() !== "");
}

/**
 * One row, by explicit column list (as `restore`). Returns a reason on
 * failure — built from column NAMES and SQLite's error class only, never
 * from a value: SQLite messages can quote one (a CHECK, a datatype
 * mismatch), so they are not passed through.
 */
function insertRow(db: SqliteDb, table: string, line: string): string | null {
	let row: Record<string, unknown>;
	try {
		row = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return "not JSON";
	}
	if (!row || typeof row !== "object" || Array.isArray(row)) return "not an object";
	const cols = Object.keys(row);
	for (const c of cols) if (!SAFE_COL.test(c)) return "unsafe column name";
	const values: Array<string | number | null> = [];
	for (const c of cols) {
		const v = row[c];
		if (v === null || typeof v === "string" || typeof v === "number") values.push(v);
		else if (typeof v === "boolean") values.push(v ? 1 : 0);
		else return `non-scalar value in column ${c}`;
	}
	try {
		db.prepare(
			`INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
		).run(...values);
		return null;
	} catch (err) {
		const msg = (err as Error).message;
		// Constraint and schema errors name columns; anything else is summarised.
		const unknown = /no column named (\w+)/.exec(msg);
		if (unknown) return `unknown column ${unknown[1]}`;
		if (/UNIQUE constraint failed/.test(msg)) return "UNIQUE constraint failed";
		if (/NOT NULL constraint failed/.test(msg)) return "NOT NULL constraint failed";
		if (/CHECK constraint failed/.test(msg)) return "CHECK constraint failed";
		return "rejected by SQLite";
	}
}

function columnsOf(db: SqliteDb, table: string): string[] {
	return (db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name: string }>)
		.map((c) => c.name)
		.sort();
}

function count(db: SqliteDb, sql: string): number {
	return Number((db.prepare(sql).get() as { n: number }).n);
}

/** Rows and a SHA-256 over the given columns, in the backup's deterministic order. */
function snapshot(
	db: SqliteDb,
	table: string,
	cols: string[],
	orderBy: string,
): { rows: number; hash: string } {
	const order = orderBy
		.split(",")
		.map((c) => quoteIdent(c.trim()))
		.join(", ");
	const rows = db
		.prepare(
			`SELECT ${cols.map(quoteIdent).join(", ")} FROM ${quoteIdent(table)} ORDER BY ${order}`,
		)
		.all() as Array<Record<string, unknown>>;
	const h = createHash("sha256");
	h.update(`${table}\n${cols.join(",")}\n`);
	for (const r of rows) {
		// Typed: a number and the same digits as a string hash differently.
		h.update(JSON.stringify(cols.map((c) => [typeof r[c], r[c]])));
		h.update("\n");
	}
	return { rows: rows.length, hash: h.digest("hex") };
}

function fkViolations(db: SqliteDb): number {
	return db.prepare("PRAGMA foreign_key_check").all().length;
}

/**
 * `fetch` for the whole run: the D1 REST endpoint is answered from the local
 * database; every other URL throws. Nothing leaves the host.
 */
function localD1Fetch(db: SqliteDb) {
	return async (url: string | URL, init?: RequestInit): Promise<Response> => {
		if (!String(url).includes("/d1/database/")) {
			throw new Error("migrate-check: network access is disabled");
		}
		const { sql, params } = JSON.parse(String(init?.body)) as { sql: string; params?: unknown[] };
		try {
			const st = db.prepare(sql);
			const bind = (params ?? []) as unknown[];
			if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) {
				return json({ results: st.all(...bind), meta: { changes: 0 } });
			}
			const info = st.run(...bind);
			return json({ results: [], meta: { changes: Number(info.changes) } });
		} catch (err) {
			return new Response(
				JSON.stringify({
					success: false,
					errors: [{ message: (err as Error).message }],
					result: [],
				}),
				{ status: 200 },
			);
		}
	};
}

function json(result: { results: unknown[]; meta: { changes: number } }): Response {
	return new Response(
		JSON.stringify({ success: true, errors: [], result: [{ ...result, success: true }] }),
		{ status: 200 },
	);
}

// ── Output ──────────────────────────────────────────────────────────────────

/** Counts, hashes and verdicts only. */
export function formatReport(dir: string, r: CheckReport): string {
	const out: string[] = [];
	out.push(`migrate-check: ${dir}`);
	out.push(`  backup of ${r.backupCreatedAt}, schema v${r.schemaFrom} → v${r.schemaTo}`);
	const w = Math.max(...r.tables.map((t) => t.name.length), 5);
	for (const t of r.tables) {
		const src =
			t.manifestRows === null
				? `file ${t.jsonlRows ?? "absent"}`
				: `file ${t.jsonlRows ?? "absent"}, manifest ${t.manifestRows}`;
		out.push(
			`  ${t.name.padEnd(w)}  rows ${t.rowsBefore} → ${t.rowsAfter} (${src})  sha256 ${t.hashBefore} → ${t.hashAfter === t.hashBefore ? "same" : t.hashAfter}  ${t.ok ? "OK" : "FAIL"}`,
		);
	}
	out.push(
		`  sessions.recreate_fence: ${r.fence.column ? "present" : "MISSING"}, 0 on ${r.fence.rows - r.fence.nonZero}/${r.fence.rows} row(s)  ${r.fence.column && r.fence.nonZero === 0 ? "OK" : "FAIL"}`,
	);
	out.push(
		`  schema_migrations: ${r.ledger.versions} version(s), max v${r.ledger.max}, v${FENCE_MIGRATION} ${r.ledger.hasFence ? "recorded  OK" : "MISSING  FAIL"}`,
	);
	out.push(
		`  foreign_key_check: ${r.foreignKeys.after} violation(s) after (${r.foreignKeys.before} before)  ${r.foreignKeys.after === 0 ? "OK" : "FAIL"}`,
	);
	out.push(`  integrity_check: ${r.integrity}  ${r.integrity === "ok" ? "OK" : "FAIL"}`);
	for (const f of r.failures) out.push(`  - ${f}`);
	out.push(r.ok ? "PASS" : "FAIL");
	return out.join("\n");
}

/* c8 ignore start — argv shell, exercised by hand on the host */
if (typeof require !== "undefined" && require.main === module) {
	// Before db.ts loads (it reads them at module load): this tool never
	// talks to D1, so it holds no credential at all.
	for (const k of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "D1_DATABASE_ID"]) {
		delete process.env[k];
	}
	process.env.LOG_LEVEL ??= "warn";
	const dir = process.argv[2];
	if (!dir || process.argv.length > 3) {
		process.stderr.write("usage: npm run db:migrate-check -- <backupDir>\n");
		process.exit(2);
	}
	const abs = path.resolve(dir);
	runMigrateCheck(abs).then(
		(r) => {
			process.stdout.write(`${formatReport(abs, r)}\n`);
			process.exit(r.ok ? 0 : 1);
		},
		(err: unknown) => {
			const refused = err instanceof RefusedError;
			// Refusals are this tool's own words; anything else is summarised
			// by class, since an unexpected error could carry a value.
			process.stderr.write(
				`migrate-check: REFUSED — ${refused ? (err as Error).message : `unexpected ${(err as Error)?.name ?? "error"}`}\n`,
			);
			process.exit(2);
		},
	);
}
/* c8 ignore stop */
