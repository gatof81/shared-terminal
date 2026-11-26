/**
 * d1Limits.test.ts — D1's statement limits (d1Limits.ts) on the checker
 * itself and on every statement a fresh `migrateDb()` sends: the whole
 * schema, migration by migration, as a deployment applies it.
 */

import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { d1LimitViolations } from "./d1Limits.js";

const { DatabaseSync } = createRequire(import.meta.url)(
	"node:sqlite",
) as typeof import("node:sqlite");

const union = (n: number) => Array.from({ length: n }, (_, k) => `SELECT ${k}`).join(" UNION ALL ");

describe("d1LimitViolations", () => {
	it("allows five compound terms and refuses six", () => {
		expect(d1LimitViolations(union(5))).toEqual([]);
		expect(d1LimitViolations(union(6))).toEqual(["compound SELECT with 6 terms (> 5)"]);
		expect(d1LimitViolations(`SELECT * FROM (${union(10)})`)).toHaveLength(1);
		expect(
			d1LimitViolations(
				"SELECT 1 UNION SELECT 2 INTERSECT SELECT 3 EXCEPT SELECT 4 UNION SELECT 5 UNION SELECT 6",
			),
		).toHaveLength(1);
	});

	it("counts each subquery and each statement of a trigger body on its own", () => {
		expect(
			d1LimitViolations(`SELECT * FROM (${union(4)}) UNION ALL SELECT * FROM (${union(4)})`),
		).toEqual([]);
		expect(
			d1LimitViolations(`BEGIN INSERT INTO t ${union(4)}; INSERT INTO t ${union(4)}; END`),
		).toEqual([]);
	});

	it("ignores UNION in strings, quoted names and comments", () => {
		expect(
			d1LimitViolations(
				`SELECT 'UNION UNION UNION UNION UNION UNION', "union" -- UNION UNION UNION UNION UNION\n/* UNION UNION UNION UNION UNION */`,
			),
		).toEqual([]);
		expect(d1LimitViolations(`SELECT 'it''s UNION UNION UNION UNION UNION UNION'`)).toEqual([]);
	});

	it("bound parameters, function arguments and size", () => {
		const q = (n: number) => Array.from({ length: n }, () => "?").join(", ");
		expect(d1LimitViolations(`INSERT INTO t VALUES (${q(100)})`)).toEqual([]);
		expect(d1LimitViolations(`INSERT INTO t VALUES (${q(101)})`)).toEqual([
			"101 bound parameters (> 100)",
		]);
		expect(d1LimitViolations("SELECT ?101")).toEqual(["101 bound parameters (> 100)"]);
		expect(d1LimitViolations("SELECT ?", 101)).toHaveLength(1);
		const args = (n: number) => Array.from({ length: n }, (_, k) => `'${k}'`).join(", ");
		expect(d1LimitViolations(`SELECT json_object(${args(32)})`)).toEqual([]);
		expect(d1LimitViolations(`SELECT json_object(${args(34)})`)).toEqual([
			"json_object() with 34 arguments (> 32)",
		]);
		// A column list is not a call, however long.
		expect(d1LimitViolations(`INSERT INTO t (${args(40)}) VALUES (${args(40)})`)).toEqual([]);
		expect(d1LimitViolations(`SELECT '${"x".repeat(100_001)}'`)).toHaveLength(1);
	});
});

describe("every statement of migrateDb() is within D1's limits", () => {
	let db: DatabaseSyncT;
	const sent: string[] = [];
	beforeAll(() => {
		vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
		vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
		vi.stubEnv("D1_DATABASE_ID", "dbid");
		db = new DatabaseSync(":memory:");
		db.exec("PRAGMA foreign_keys = ON");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string | URL, init?: RequestInit) => {
				const { sql, params = [] } = JSON.parse(String(init?.body)) as {
					sql: string;
					params?: Array<string | number | null>;
				};
				sent.push(sql);
				const st = db.prepare(sql);
				const reads = /^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql);
				const results = reads ? st.all(...params) : [];
				if (!reads) st.run(...params);
				return new Response(
					JSON.stringify({
						success: true,
						errors: [],
						result: [{ results, success: true, meta: {} }],
					}),
				);
			}),
		);
	});
	afterAll(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("from an empty database to the last version", async () => {
		const { migrateDb, MIGRATIONS } = await import("./db.js");
		await migrateDb();
		const last = MIGRATIONS[MIGRATIONS.length - 1].version;
		expect(db.prepare("SELECT max(version) AS v FROM schema_migrations").get()).toEqual({
			v: last,
		});
		const bad = sent
			.map((sql) => ({ sql: sql.slice(0, 120), why: d1LimitViolations(sql) }))
			.filter((s) => s.why.length);
		expect(bad).toEqual([]);
	});
});
