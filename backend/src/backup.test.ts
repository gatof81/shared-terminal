/**
 * backup.test.ts — round-trip + guard semantics for #240.
 *
 * D1 is mocked (an in-memory Map of table → rows that the mock serves
 * and records inserts into); tar is REAL (CI runners and dev hosts ship
 * it), exercised against temp dirs so the workspace tarball path — the
 * part unit mocks would fake away — is actually proven.
 */

import { execFileSync } from "node:child_process";
import { promises as fs, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// No imported helpers inside vi.hoisted — it runs before every import in
// this file is initialised (same trap dockerManager.uploads.test.ts
// documents). Plain string + Node globals only; the dir is created in
// beforeAll below.
const WORKSPACE_ROOT = vi.hoisted(() => {
	const dir = `/tmp/st-backup-ws-${process.pid}-${Date.now()}`;
	process.env.WORKSPACE_ROOT = dir;
	// Base64 key so decryptSecret has something to chew on in the
	// key-check tests (value irrelevant — encryptSecret round-trips).
	process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
	return dir;
});

type Row = Record<string, unknown>;
const dbState = vi.hoisted(() => ({
	tables: new Map<string, Row[]>(),
	inserts: [] as Array<{ sql: string; params: unknown[] }>,
	updates: [] as string[],
}));

vi.mock("./db.js", () => ({
	migrateDb: vi.fn(async () => undefined),
	d1Query: vi.fn(async (sql: string, params?: unknown[]) => {
		const ok = { success: true as const, meta: { changes: 1, duration: 0, last_row_id: 0 } };
		if (sql.startsWith("SELECT MAX(version)")) {
			return { ...ok, results: [{ v: 12 }] };
		}
		const selectMatch = /^SELECT \* FROM (\w+) ORDER BY/.exec(sql);
		if (selectMatch) {
			return { ...ok, results: dbState.tables.get(selectMatch[1]!) ?? [] };
		}
		if (sql.startsWith("SELECT session_id FROM sessions")) {
			return { ...ok, results: dbState.tables.get("sessions") ?? [] };
		}
		if (sql.startsWith("SELECT (SELECT COUNT(*) FROM users)")) {
			return {
				...ok,
				results: [
					{
						u: (dbState.tables.get("users") ?? []).length,
						s: (dbState.tables.get("sessions") ?? []).length,
					},
				],
			};
		}
		if (sql.startsWith("INSERT OR REPLACE")) {
			dbState.inserts.push({ sql, params: params ?? [] });
			return { ...ok, results: [] };
		}
		if (sql.startsWith("UPDATE sessions SET status = 'stopped'")) {
			dbState.updates.push(sql);
			return { ...ok, results: [] };
		}
		return { ...ok, results: [] };
	}),
}));

import { classifyTarStderr, findEncryptedBlob, runBackup, runRestore } from "./backup.js";
import { encryptSecret } from "./secrets.js";

let outDir: string;

beforeAll(async () => {
	await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
});

beforeEach(async () => {
	dbState.tables.clear();
	dbState.inserts.length = 0;
	dbState.updates.length = 0;
	outDir = mkdtempSync(path.join(os.tmpdir(), "st-backup-out-"));
	// runBackup requires an EMPTY dir; mkdtemp gives us one, but it must
	// not pre-create workspaces/ — runBackup does that itself.
	await fs.rm(outDir, { recursive: true });
});

afterEach(async () => {
	await fs.rm(outDir, { recursive: true, force: true });
	for (const entry of await fs.readdir(WORKSPACE_ROOT)) {
		await fs.rm(path.join(WORKSPACE_ROOT, entry), { recursive: true, force: true });
	}
});

async function seedWorkspace(sid: string, files: Record<string, string>): Promise<void> {
	for (const [rel, content] of Object.entries(files)) {
		const p = path.join(WORKSPACE_ROOT, rel);
		await fs.mkdir(path.dirname(p), { recursive: true });
		await fs.writeFile(p, content);
	}
	void sid;
}

describe("runBackup", () => {
	it("writes deterministic jsonl per table, tars workspaces + uploads, manifest last", async () => {
		dbState.tables.set("users", [{ id: "u1", username: "diego" }]);
		dbState.tables.set("sessions", [
			{ session_id: "s1", user_id: "u1", status: "running" },
			{ session_id: "s2", user_id: "u1", status: "stopped" },
		]);
		await seedWorkspace("s1", {
			"s1/hello.txt": "hola",
			"s1/sub/deep.txt": "deep",
			".uploads/s1/file.bin": "upload",
		});
		// s2 has no workspace dir at all — must be skipped, not fail.

		const manifest = await runBackup(outDir);

		expect(manifest.tables.users).toBe(1);
		expect(manifest.tables.sessions).toBe(2);
		expect(manifest.schemaVersion).toBe(12);
		const usersJsonl = await fs.readFile(path.join(outDir, "users.jsonl"), "utf-8");
		expect(JSON.parse(usersJsonl.trim())).toEqual({ id: "u1", username: "diego" });
		// s1 tarball exists and counts its entries; s2 absent.
		expect(manifest.workspaces.s1?.fileCount).toBeGreaterThanOrEqual(3);
		expect(manifest.workspaces.s2).toBeUndefined();
		const listing = execFileSync("tar", [
			"-tzf",
			path.join(outDir, "workspaces", "s1.tar.gz"),
		]).toString();
		expect(listing).toContain("s1/hello.txt");
		expect(listing).toContain(".uploads/s1/file.bin");
		// Manifest present = complete backup.
		const m = JSON.parse(await fs.readFile(path.join(outDir, "manifest.json"), "utf-8"));
		expect(m.version).toBe(1);
	});

	it("refuses a non-empty output dir", async () => {
		await fs.mkdir(outDir, { recursive: true });
		await fs.writeFile(path.join(outDir, "junk"), "x");
		await expect(runBackup(outDir)).rejects.toThrow(/not empty/);
	});
});

describe("runRestore", () => {
	async function makeBackup(): Promise<void> {
		dbState.tables.set("users", [{ id: "u1", username: "diego" }]);
		dbState.tables.set("sessions", [{ session_id: "s1", user_id: "u1", status: "running" }]);
		await seedWorkspace("s1", { "s1/hello.txt": "hola" });
		await runBackup(outDir);
		// Wipe the "source" workspace so extraction is observable.
		await fs.rm(path.join(WORKSPACE_ROOT, "s1"), { recursive: true });
		dbState.tables.clear();
	}

	it("round-trips: replays rows in FK order, flips running→stopped, extracts workspaces", async () => {
		await makeBackup();

		await runRestore(outDir);

		// users insert precedes sessions insert (FK order).
		const tablesInOrder = dbState.inserts.map((i) => /INTO (\w+)/.exec(i.sql)?.[1] ?? "?");
		expect(tablesInOrder.indexOf("users")).toBeLessThan(tablesInOrder.indexOf("sessions"));
		// INSERT OR REPLACE so a --force re-run converges.
		expect(dbState.inserts[0]?.sql).toMatch(/^INSERT OR REPLACE INTO users/);
		expect(dbState.inserts[0]?.params).toEqual(["u1", "diego"]);
		// Previously-running sessions land stopped.
		expect(dbState.updates).toHaveLength(1);
		// Workspace files extracted back under WORKSPACE_ROOT.
		const restored = await fs.readFile(path.join(WORKSPACE_ROOT, "s1", "hello.txt"), "utf-8");
		expect(restored).toBe("hola");
	});

	it("refuses a dir without manifest.json (interrupted backup)", async () => {
		await fs.mkdir(outDir, { recursive: true });
		await expect(runRestore(outDir)).rejects.toThrow(/manifest\.json/);
	});

	it("refuses a non-empty target without --force, proceeds with it", async () => {
		await makeBackup();
		dbState.tables.set("users", [{ id: "existing", username: "x" }]);
		await expect(runRestore(outDir)).rejects.toThrow(/--force/);
		expect(dbState.inserts).toHaveLength(0);
		await runRestore(outDir, { force: true });
		expect(dbState.inserts.length).toBeGreaterThan(0);
	});

	it("aborts before any write when the key can't decrypt a sampled secret — even with --force", async () => {
		dbState.tables.set("users", [{ id: "u1", username: "diego" }]);
		dbState.tables.set("sessions", [{ session_id: "s1", user_id: "u1", status: "stopped" }]);
		// A secret encrypted under a DIFFERENT key than the env's.
		const blob = encryptSecret("super-secret");
		const foreign = { ...blob, tag: Buffer.alloc(16, 1).toString("base64") };
		dbState.tables.set("session_configs", [
			{
				session_id: "s1",
				env_vars_json: JSON.stringify([{ name: "K", type: "secret", ...foreign }]),
			},
		]);
		await runBackup(outDir);
		dbState.tables.clear();

		await expect(runRestore(outDir, { force: true })).rejects.toThrow(/SECRETS_ENCRYPTION_KEY/);
		expect(dbState.inserts).toHaveLength(0);
	});

	it("passes the key check when the sampled secret decrypts", async () => {
		dbState.tables.set("users", [{ id: "u1", username: "diego" }]);
		dbState.tables.set("sessions", [{ session_id: "s1", user_id: "u1", status: "stopped" }]);
		const blob = encryptSecret("super-secret");
		dbState.tables.set("session_configs", [
			{
				session_id: "s1",
				env_vars_json: JSON.stringify([{ name: "K", type: "secret", ...blob }]),
			},
		]);
		await runBackup(outDir);
		dbState.tables.clear();

		await runRestore(outDir);
		expect(dbState.inserts.length).toBeGreaterThan(0);
	});

	it("rejects a tampered JSONL row whose column name smuggles SQL", async () => {
		await makeBackup();
		// Values are parameterized; column NAMES are interpolated — a key
		// like this would otherwise become `INSERT INTO users (id) SELECT
		// ... --) VALUES (?)`, valid SQLite that fires after both the
		// --force and key guards have passed.
		await fs.writeFile(
			path.join(outDir, "users.jsonl"),
			`${JSON.stringify({ "id) SELECT password_hash FROM users--": "x" })}\n`,
		);
		await expect(runRestore(outDir)).rejects.toThrow(/unsafe column name/);
		expect(dbState.inserts).toHaveLength(0);
	});

	it("rejects a tampered workspace tarball with out-of-scope paths", async () => {
		await makeBackup();
		// Craft a tarball whose entries escape the sid prefix.
		const evilDir = mkdtempSync(path.join(os.tmpdir(), "st-evil-"));
		await fs.mkdir(path.join(evilDir, "other"), { recursive: true });
		await fs.writeFile(path.join(evilDir, "other", "planted.txt"), "evil");
		execFileSync("tar", [
			"-czf",
			path.join(outDir, "workspaces", "s1.tar.gz"),
			"-C",
			evilDir,
			"other",
		]);
		await expect(runRestore(outDir)).rejects.toThrow(/out-of-scope/);
		await fs.rm(evilDir, { recursive: true, force: true });
	});
});

// ── Live-session tar outcomes ──────────────────────────────────────────────
//
// GNU tar's concurrent-change diagnostics can't be produced on demand by a
// real race without flakiness, so a `tar` shim on PATH runs the REAL tar
// first (the archive is genuine) and then, for --create only, sources a
// per-test control snippet that injects tar's stderr/exit status — or
// damages the archive. Everything else (verification, restore) runs the
// real tar untouched.
describe("runBackup with a live workspace", () => {
	let shimDir: string;
	let ctlPath: string;
	let savedPath: string | undefined;

	beforeAll(async () => {
		const realTar = execFileSync("sh", ["-c", "command -v tar"]).toString().trim();
		shimDir = mkdtempSync(path.join(os.tmpdir(), "st-tar-shim-"));
		ctlPath = path.join(shimDir, "ctl.sh");
		await fs.writeFile(
			path.join(shimDir, "tar"),
			`#!/bin/sh\nif [ "$1" = "-czf" ] && [ -f "${ctlPath}" ]; then\n\t"${realTar}" "$@" || exit $?\n\t. "${ctlPath}"\nfi\nexec "${realTar}" "$@"\n`,
			{ mode: 0o755 },
		);
		savedPath = process.env.PATH;
		process.env.PATH = `${shimDir}:${savedPath ?? ""}`;
	});

	afterAll(async () => {
		process.env.PATH = savedPath;
		await fs.rm(shimDir, { recursive: true, force: true });
	});

	beforeEach(async () => {
		await fs.rm(ctlPath, { force: true });
		dbState.tables.set("users", [{ id: "u1", username: "diego" }]);
		dbState.tables.set("sessions", [{ session_id: "s1", user_id: "u1", status: "running" }]);
		await seedWorkspace("s1", {
			"s1/hello.txt": "hola",
			"s1/.claude/projects/p/log.jsonl": "{}\n",
		});
	});

	const inject = (snippet: string): Promise<void> => fs.writeFile(ctlPath, snippet);
	const hasManifest = (): Promise<boolean> =>
		fs.access(path.join(outDir, "manifest.json")).then(
			() => true,
			() => false,
		);

	it("accepts exit 1 when every stderr line is a concurrent change, records it, and restores", async () => {
		await inject(
			"printf 'tar: s1/.claude/projects/p/log.jsonl: file changed as we read it\\n" +
				"tar: s1/.claude/tmp1: File removed before we read it\\n" +
				"tar: s1/big: File shrank by 4096 bytes; padding with zeros\\n' >&2; exit 1\n",
		);

		const manifest = await runBackup(outDir);

		expect(await hasManifest()).toBe(true);
		const ws = manifest.workspaces.s1;
		expect(ws?.fileCount).toBeGreaterThanOrEqual(3);
		expect(ws?.concurrentChanges).toEqual({
			count: 3,
			paths: [
				{ path: "s1/.claude/projects/p/log.jsonl", kind: "changed" },
				{ path: "s1/.claude/tmp1", kind: "removed" },
				{ path: "s1/big", kind: "shrank" },
			],
			truncated: false,
		});
		// Restorable: the real tarball round-trips.
		await fs.rm(path.join(WORKSPACE_ROOT, "s1"), { recursive: true });
		dbState.tables.clear();
		await runRestore(outDir);
		expect(await fs.readFile(path.join(WORKSPACE_ROOT, "s1", "hello.txt"), "utf-8")).toBe("hola");
	});

	it("caps the recorded paths and marks the list truncated", async () => {
		await inject(
			'i=0; while [ $i -lt 150 ]; do echo "tar: s1/f$i: file changed as we read it" >&2; i=$((i+1)); done; exit 1\n',
		);
		const manifest = await runBackup(outDir);
		const cc = manifest.workspaces.s1?.concurrentChanges;
		expect(cc?.count).toBe(150);
		expect(cc?.paths).toHaveLength(100);
		expect(cc?.truncated).toBe(true);
	});

	it("a clean run records no concurrentChanges", async () => {
		const manifest = await runBackup(outDir);
		expect(manifest.workspaces.s1).toBeDefined();
		expect(manifest.workspaces.s1?.concurrentChanges).toBeUndefined();
	});

	it.each([
		[
			"a read error mixed with a concurrent change",
			"printf 'tar: s1/a: file changed as we read it\\ntar: s1/b: Cannot open: Permission denied\\n' >&2; exit 1\n",
		],
		["exit 1 with no diagnostic at all", "exit 1\n"],
		[
			"exit 2 even if every line looks like a concurrent change",
			"printf 'tar: s1/a: file changed as we read it\\n' >&2; exit 2\n",
		],
		["a signal", "kill -TERM $$\n"],
		[
			"exit 1 + concurrent change but a damaged archive",
			"truncate -s 100 \"$2\"; printf 'tar: s1/a: file changed as we read it\\n' >&2; exit 1\n",
		],
	])("fails without a manifest on %s", async (_label, snippet) => {
		await inject(snippet);
		await expect(runBackup(outDir)).rejects.toThrow();
		expect(await hasManifest()).toBe(false);
	});

	// Real tar, real error: an unreadable file is exit 2 ("Cannot open"),
	// never tolerated. Root reads mode-000 files, so the case is moot there.
	it.skipIf(process.getuid?.() === 0)(
		"fails without a manifest on an unreadable file",
		async () => {
			const p = path.join(WORKSPACE_ROOT, "s1", "locked.txt");
			await fs.writeFile(p, "x");
			await fs.chmod(p, 0o000);
			try {
				await expect(runBackup(outDir)).rejects.toThrow(/Cannot open: Permission denied/);
				expect(await hasManifest()).toBe(false);
			} finally {
				await fs.chmod(p, 0o600);
			}
		},
	);
});

describe("classifyTarStderr", () => {
	it("recognises only the three concurrent-change diagnostics, whole-line", () => {
		const { changes, unknown } = classifyTarStderr(
			[
				"tar: s1/a: file changed as we read it",
				"tar: s1/b: File removed before we read it",
				"tar: s1/c: File shrank by 12 bytes; padding with zeros",
				"tar: s1/d: Cannot open: Permission denied",
				"tar: s1/e: file changed as we read it (really)",
				"tar: Exiting with failure status due to previous errors",
				"",
			].join("\n"),
		);
		expect(changes.map((c) => c.kind)).toEqual(["changed", "removed", "shrank"]);
		expect(unknown).toHaveLength(3);
	});
});

describe("findEncryptedBlob", () => {
	it("finds a nested ciphertext/iv/tag triple and ignores non-matching shapes", () => {
		expect(findEncryptedBlob({ a: [{ b: { ciphertext: "c", iv: "i", tag: "t" } }] })).toEqual({
			ciphertext: "c",
			iv: "i",
			tag: "t",
		});
		expect(findEncryptedBlob({ ciphertext: "c", iv: 1, tag: "t" })).toBeNull();
		expect(findEncryptedBlob("string")).toBeNull();
		expect(findEncryptedBlob(null)).toBeNull();
	});
});
