/**
 * migrateCheck.ts — the release gate for migration v20 (#627) against a
 * fixture backup directory shaped like `npm run backup`'s output (schema
 * v19): PASS on intact data, FAIL on every check it promises, no network,
 * no D1 credentials, and nothing of a row's content in what it prints.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FENCE_MIGRATION, formatReport, RefusedError, runMigrateCheck } from "./migrateCheck.js";

const SECRET = "SENTINEL-secret-value-0f9e8d7c";
const U1 = "u-1";
const U2 = "u-2";
const S1 = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const S2 = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";

let dir: string;
const realFetch = globalThis.fetch;
let netCalls: string[];

async function writeBackup(
	tables: Record<string, Array<Record<string, unknown>>>,
	manifest: Record<string, unknown> = {},
) {
	for (const [name, rows] of Object.entries(tables)) {
		await fs.writeFile(
			path.join(dir, `${name}.jsonl`),
			rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : ""),
		);
	}
	await fs.writeFile(
		path.join(dir, "manifest.json"),
		JSON.stringify({
			version: 1,
			createdAt: "2026-11-13T10:00:00.000Z",
			schemaVersion: 19,
			tables: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])),
			workspaces: {},
			...manifest,
		}),
	);
}

/** A v19 backup with secrets in the columns that hold them in production. */
function fixture() {
	return {
		users: [
			{ id: U1, username: "owner", password_hash: `bcrypt-${SECRET}`, is_admin: 1 },
			{ id: U2, username: "other", password_hash: "x", is_admin: 0 },
		],
		sessions: [
			{
				session_id: S1,
				user_id: U1,
				name: "hz",
				container_name: "st-0a1b2c3d-4e5",
				status: "stopped",
				container_id: "o".repeat(64),
				env_vars: JSON.stringify({ TOKEN: SECRET }),
				conversation_requested: 1,
				ingest_token_hash: `h-${SECRET}`,
				revocation_seq: 3,
			},
			{
				session_id: S2,
				user_id: U2,
				name: "dev",
				container_name: "st-1b2c3d4e-5f6",
				status: "running",
				container_id: null,
				env_vars: "{}",
			},
		],
		session_configs: [
			{
				session_id: S1,
				env_vars_json: JSON.stringify([{ name: "K", type: "secret", value: SECRET }]),
				ports_json: "[]",
				cpu_limit: 2_000_000_000,
			},
		],
		sessions_port_mappings: [
			{ session_id: S2, container_port: 3000, host_port: 3000, is_public: 0 },
		],
	};
}

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "st-migrate-check-"));
	netCalls = [];
	// Anything that reaches the real network layer is recorded and refused.
	globalThis.fetch = vi.fn(async (url: string | URL) => {
		netCalls.push(String(url));
		throw new Error("network used");
	}) as typeof fetch;
	vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
	vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
	vi.stubEnv("D1_DATABASE_ID", "");
});
afterEach(async () => {
	globalThis.fetch = realFetch;
	vi.unstubAllEnvs();
	await fs.rm(dir, { recursive: true, force: true });
});

describe("db:migrate-check (v20 release gate)", () => {
	it("PASS on intact v19 data: counts and hashes unchanged, fence 0 everywhere, v20 recorded, FKs clean", async () => {
		await writeBackup(fixture());
		const r = await runMigrateCheck(dir);
		expect(r.failures).toEqual([]);
		expect(r.ok).toBe(true);
		expect(r.schemaFrom).toBe(19);
		expect(r.schemaTo).toBe(FENCE_MIGRATION);
		const by = Object.fromEntries(r.tables.map((t) => [t.name, t]));
		expect(by.users).toMatchObject({
			jsonlRows: 2,
			manifestRows: 2,
			rowsBefore: 2,
			rowsAfter: 2,
			ok: true,
		});
		expect(by.sessions).toMatchObject({ rowsBefore: 2, rowsAfter: 2, ok: true });
		expect(by.sessions?.hashAfter).toBe(by.sessions?.hashBefore);
		expect(by.sessions?.hashBefore).toMatch(/^[0-9a-f]{64}$/);
		// Tables the backup has no file for load as 0 rows, like restore.
		expect(by.templates).toMatchObject({ jsonlRows: null, rowsBefore: 0, ok: true });
		expect(r.fence).toEqual({ column: true, rows: 2, nonZero: 0 });
		expect(r.ledger.hasFence).toBe(true);
		expect(r.foreignKeys).toEqual({ before: 0, after: 0 });
		expect(r.integrity).toBe("ok");
		// No network, no D1: the only fetch during the run was the local one,
		// and the real one (the stub here) was never reached.
		expect(netCalls).toEqual([]);
		expect(globalThis.fetch).not.toBe(realFetch); // our stub is back in place
		const text = formatReport(dir, r);
		expect(text).toMatch(/\nPASS$/);
		expect(text).not.toContain(SECRET);
		expect(text).not.toContain("owner");
	});

	it("FAIL when the migration changes pre-existing content (the hash catches a single value)", async () => {
		await writeBackup(fixture());
		const { migrateDb, d1Query } = await import("./db.js");
		const r = await runMigrateCheck(dir, {
			migrate: async () => {
				await migrateDb();
				await d1Query("UPDATE sessions SET status = 'running' WHERE session_id = ?", [S1]);
			},
		});
		expect(r.ok).toBe(false);
		const s = r.tables.find((t) => t.name === "sessions");
		expect(s?.ok).toBe(false);
		expect(s?.rowsAfter).toBe(s?.rowsBefore);
		expect(s?.hashAfter).not.toBe(s?.hashBefore);
		expect(r.failures).toContain("sessions: content of the pre-existing columns changed");
		expect(formatReport(dir, r)).toMatch(/\nFAIL$/);
	});

	it("FAIL when a row disappears, and when the fence is not 0", async () => {
		await writeBackup(fixture());
		const { migrateDb, d1Query } = await import("./db.js");
		const r = await runMigrateCheck(dir, {
			migrate: async () => {
				await migrateDb();
				await d1Query("DELETE FROM sessions_port_mappings");
				await d1Query("UPDATE sessions SET recreate_fence = 1 WHERE session_id = ?", [S2]);
			},
		});
		expect(r.ok).toBe(false);
		expect(r.tables.find((t) => t.name === "sessions_port_mappings")).toMatchObject({
			rowsBefore: 1,
			rowsAfter: 0,
			ok: false,
		});
		expect(r.fence).toEqual({ column: true, rows: 2, nonZero: 1 });
		expect(r.failures).toContain("sessions.recreate_fence: 1 row(s) not 0");
	});

	it("FAIL when v20 is not applied (the migration under test skipped)", async () => {
		await writeBackup(fixture());
		const r = await runMigrateCheck(dir, { migrate: async () => undefined });
		expect(r.ok).toBe(false);
		expect(r.fence.column).toBe(false);
		expect(r.ledger.hasFence).toBe(false);
		expect(r.failures).toEqual(
			expect.arrayContaining([
				"sessions.recreate_fence: column missing after the migration",
				`schema_migrations: v${FENCE_MIGRATION} not recorded`,
			]),
		);
	});

	it("FAIL on a foreign-key violation in the data, and on a count that disagrees with the manifest", async () => {
		const f = fixture();
		f.sessions_port_mappings.push({
			session_id: "9f9f9f9f-0000-4000-8000-000000000000",
			container_port: 8080,
			host_port: 8080,
			is_public: 1,
		});
		await writeBackup(f, { tables: { users: 5 } });
		const r = await runMigrateCheck(dir);
		expect(r.ok).toBe(false);
		expect(r.foreignKeys).toEqual({ before: 1, after: 1 });
		expect(r.failures).toEqual(
			expect.arrayContaining([
				"foreign_key_check: 1 violation(s) after the migration",
				"users: 2 row(s) in the file, manifest says 5",
			]),
		);
	});

	it("a row that does not load is reported by column NAME and constraint class, never by value", async () => {
		const f = fixture();
		f.users.push({ id: U1, username: SECRET, password_hash: SECRET, is_admin: 0 }); // duplicate id
		(f.sessions[0] as Record<string, unknown>).no_such_column = SECRET;
		await writeBackup(f);
		const r = await runMigrateCheck(dir);
		expect(r.ok).toBe(false);
		expect(r.failures).toEqual(
			expect.arrayContaining([
				"users: row 3 not loaded (UNIQUE constraint failed)",
				"sessions: row 1 not loaded (unknown column no_such_column)",
			]),
		);
		expect(formatReport(dir, r)).not.toContain(SECRET);
		expect(JSON.stringify(r)).not.toContain(SECRET);
	});

	it("refuses a backup already at v20, a directory without a manifest, and a manifest it does not understand", async () => {
		await writeBackup(fixture(), { schemaVersion: FENCE_MIGRATION });
		await expect(runMigrateCheck(dir)).rejects.toThrow(RefusedError);
		await expect(runMigrateCheck(dir)).rejects.toThrow(/BEFORE deploying/);
		await fs.rm(path.join(dir, "manifest.json"));
		await expect(runMigrateCheck(dir)).rejects.toThrow(/no readable manifest.json/);
		await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({ version: 2 }));
		await expect(runMigrateCheck(dir)).rejects.toThrow(
			/not a backup manifest this tool understands/,
		);
		expect(netCalls).toEqual([]);
	});

	it("never writes into the backup directory", async () => {
		await writeBackup(fixture());
		const before = (await fs.readdir(dir)).sort();
		const stats = await Promise.all(before.map((f) => fs.stat(path.join(dir, f))));
		await runMigrateCheck(dir);
		expect((await fs.readdir(dir)).sort()).toEqual(before);
		const after = await Promise.all(before.map((f) => fs.stat(path.join(dir, f))));
		expect(after.map((s) => s.mtimeMs)).toEqual(stats.map((s) => s.mtimeMs));
	});
});
