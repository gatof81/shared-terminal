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
	schemaVersion: 12,
	selected: [] as string[],
	missingTables: new Set<string>(),
	/** Runs before the first query of a backup (the schema read): lets a test look at the disk then. */
	onSchemaRead: null as null | (() => Promise<void>),
}));

vi.mock("./db.js", () => ({
	migrateDb: vi.fn(async () => undefined),
	d1Query: vi.fn(async (sql: string, params?: unknown[]) => {
		const ok = { success: true as const, meta: { changes: 1, duration: 0, last_row_id: 0 } };
		if (sql.startsWith("SELECT MAX(version)")) {
			if (dbState.onSchemaRead) await dbState.onSchemaRead();
			return { ...ok, results: [{ v: dbState.schemaVersion }] };
		}
		const selectMatch = /^SELECT \* FROM (\w+) ORDER BY/.exec(sql);
		if (selectMatch) {
			dbState.selected.push(selectMatch[1]!);
			if (dbState.missingTables.has(selectMatch[1]!)) {
				throw new Error(`D1 query failed: no such table: ${selectMatch[1]}`);
			}
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

import {
	classifyTarStderr,
	findEncryptedBlob,
	installControlEvidence,
	runBackup,
	runRestore,
} from "./backup.js";
import {
	ATTESTATION_KEY_INFO,
	classifyAttestation,
	readAttestation,
	signAttestation,
	writeAttestation,
} from "./conversation/captureAttestation.js";
import { CaptureAuthority, type ContainerView } from "./conversation/captureAuth.js";
import { hashIngestToken } from "./conversation/registry.js";
import {
	checkRevocation,
	retireSessionRevocation,
	revokedAllPath,
	writeGlobalRevocation,
	writeSessionRevocation,
} from "./conversation/revocation.js";
import { logger } from "./logger.js";
import { deriveSubkey, encryptSecret } from "./secrets.js";

let outDir: string;

beforeAll(async () => {
	await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
});

beforeEach(async () => {
	dbState.tables.clear();
	dbState.inserts.length = 0;
	dbState.updates.length = 0;
	dbState.schemaVersion = 12;
	dbState.selected.length = 0;
	dbState.missingTables.clear();
	dbState.onSchemaRead = null;
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

	it("skips a table newer than the source schema, but fails on one the schema should have", async () => {
		dbState.tables.set("users", [{ id: "u1", username: "diego" }]);
		dbState.missingTables.add("claude_conversations");
		// v12 (the mock default) predates v16 — skipped, never queried.
		const manifest = await runBackup(outDir);
		expect(dbState.selected).not.toContain("claude_conversations");
		expect(manifest.tables.claude_conversations).toBeUndefined();
		expect(manifest.tables.users).toBe(1);
		await expect(fs.access(path.join(outDir, "claude_conversations.jsonl"))).rejects.toThrow();

		// At v16 the table must exist: its absence fails, no manifest.
		await fs.rm(outDir, { recursive: true });
		dbState.schemaVersion = 16;
		await expect(runBackup(outDir)).rejects.toThrow(/no such table: claude_conversations/);
		await expect(fs.access(path.join(outDir, "manifest.json"))).rejects.toThrow();
	});

	it("refuses a non-empty output dir", async () => {
		await fs.mkdir(outDir, { recursive: true });
		await fs.writeFile(path.join(outDir, "junk"), "x");
		await expect(runBackup(outDir)).rejects.toThrow(/not empty/);
	});
});

describe("backup permissions (#562)", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});
	async function entries(
		dir: string,
	): Promise<Array<{ p: string; dir: boolean; mode: number; gid: number }>> {
		const out: Array<{ p: string; dir: boolean; mode: number; gid: number }> = [];
		const walk = async (p: string) => {
			const st = await fs.lstat(p);
			out.push({
				p: path.relative(dir, p) || ".",
				dir: st.isDirectory(),
				mode: st.mode & 0o7777,
				gid: st.gid,
			});
			if (st.isDirectory()) for (const n of await fs.readdir(p)) await walk(path.join(p, n));
		};
		await walk(dir);
		return out;
	}
	async function fullBackup(): Promise<void> {
		dbState.tables.set("users", [{ id: "u1", username: "diego" }]);
		dbState.tables.set("sessions", [{ session_id: "s1", user_id: "u1", status: "stopped" }]);
		await seedWorkspace("s1", { "s1/hello.txt": "hola" });
		await runBackup(outDir);
	}

	it("without BACKUP_GROUP_GID every entry is 0700/0600: nothing for group or others", async () => {
		vi.stubEnv("BACKUP_GROUP_GID", "");
		await fullBackup();
		const all = await entries(outDir);
		expect(all.some((e) => e.p.endsWith(".tar.gz"))).toBe(true);
		expect(all.some((e) => e.p === "manifest.json")).toBe(true);
		for (const e of all) expect([e.p, e.mode]).toEqual([e.p, e.dir ? 0o700 : 0o600]);
	});

	it("with BACKUP_GROUP_GID every entry is 0750/0640 in that group", async () => {
		// A supplementary group when the runner has one (CI does), so a missing
		// chown shows; and a 077 umask, under which every create lands at
		// 0700/0600, so a missing chmod shows on every single entry.
		const primary = process.getgid?.() ?? 0;
		const gid = (process.getgroups?.() ?? []).find((g) => g !== primary) ?? primary;
		vi.stubEnv("BACKUP_GROUP_GID", String(gid));
		const prev = process.umask(0o077);
		try {
			await fullBackup();
		} finally {
			process.umask(prev);
		}
		for (const e of await entries(outDir)) {
			expect([e.p, e.mode, e.gid]).toEqual([e.p, e.dir ? 0o750 : 0o640, gid]);
		}
	});

	it("a malformed BACKUP_GROUP_GID refuses before anything is created", async () => {
		vi.stubEnv("BACKUP_GROUP_GID", "backup");
		await expect(runBackup(outDir)).rejects.toThrow(/numeric group id/);
		await expect(fs.access(outDir)).rejects.toThrow();
		expect(dbState.selected).toHaveLength(0);
	});

	it("secures the parent it creates, and leaves an existing parent alone", async () => {
		vi.stubEnv("BACKUP_GROUP_GID", "");
		const parent = path.join(outDir, ".backups");
		await runBackup(path.join(parent, "a"));
		expect((await fs.lstat(parent)).mode & 0o7777).toBe(0o700);
		await fs.chmod(parent, 0o755);
		await runBackup(path.join(parent, "b"));
		expect((await fs.lstat(parent)).mode & 0o7777).toBe(0o755);
		expect((await fs.lstat(path.join(parent, "b"))).mode & 0o7777).toBe(0o700);
	});

	it("the backup dir is closed before anything is written into it", async () => {
		vi.stubEnv("BACKUP_GROUP_GID", "");
		let seen: { mode: number; entries: string[] } | null = null;
		dbState.onSchemaRead = async () => {
			seen ??= {
				mode: (await fs.lstat(outDir)).mode & 0o7777,
				entries: (await fs.readdir(outDir)).sort(),
			};
		};
		await fullBackup();
		expect(seen).toEqual({ mode: 0o700, entries: ["workspaces"] });
	});

	it("refuses an outDir owned by someone else", async () => {
		vi.stubEnv("BACKUP_GROUP_GID", "");
		await fs.mkdir(outDir);
		const me = process.getuid?.() ?? 0;
		const spy = vi.spyOn(process, "getuid").mockReturnValue(me + 1);
		try {
			await expect(runBackup(outDir)).rejects.toThrow(/not owned by uid/);
		} finally {
			spy.mockRestore();
		}
		expect(await fs.readdir(outDir)).toEqual([]);
	});

	it("warns when the parent is open to others but the output is root-only", async () => {
		const parent = path.join(outDir, ".backups");
		await fs.mkdir(parent, { recursive: true });
		await fs.chmod(parent, 0o755);
		const warn = vi.spyOn(logger, "warn");
		try {
			vi.stubEnv("BACKUP_GROUP_GID", "");
			await runBackup(path.join(parent, "a"));
			expect(
				warn.mock.calls.some((c) =>
					/readable by others but BACKUP_GROUP_GID is unset/.test(String(c[0])),
				),
			).toBe(true);
			warn.mockClear();
			vi.stubEnv("BACKUP_GROUP_GID", String(process.getgid?.() ?? 0));
			await runBackup(path.join(parent, "b"));
			expect(warn.mock.calls.some((c) => /BACKUP_GROUP_GID is unset/.test(String(c[0])))).toBe(
				false,
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("a secured backup restores as before", async () => {
		vi.stubEnv("BACKUP_GROUP_GID", "");
		await fullBackup();
		dbState.tables.clear();
		await fs.rm(path.join(WORKSPACE_ROOT, "s1"), { recursive: true });
		await runRestore(outDir);
		expect(dbState.inserts.some((i) => /INTO users /.test(i.sql))).toBe(true);
		expect(await fs.readFile(path.join(WORKSPACE_ROOT, "s1", "hello.txt"), "utf-8")).toBe("hola");
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

	it("warns for a table the backup's schema has but its files lack (backup by an older backend)", async () => {
		await makeBackup();
		// A rollback backend writes the D1 ledger's version (v19) but exports
		// only the tables it knows. This fixture's source is v12, so the v16
		// and v18 tables are absent too: every one of them must be named.
		const manifestPath = path.join(outDir, "manifest.json");
		const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
		await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, schemaVersion: 19 }));
		dbState.schemaVersion = 19;
		const warn = vi.spyOn(logger, "warn");
		try {
			await runRestore(outDir);
			const missing = warn.mock.calls
				.map((c) => String(c[0]))
				.filter((m) => /no \w+\.jsonl although/.test(m));
			expect(missing.map((m) => /\[restore\] (\w+):/.exec(m)?.[1])).toEqual([
				"claude_conversations",
				"conversation_user_meta",
				"projects",
				"project_agents",
				"agent_bindings",
				"project_agent_creations",
			]);
		} finally {
			warn.mockRestore();
		}
	});

	it("does not warn for tables newer than the backup's schema", async () => {
		await makeBackup(); // schema v12: every table since v16+ is legitimately absent
		const warn = vi.spyOn(logger, "warn");
		try {
			await runRestore(outDir);
			expect(warn.mock.calls.some((c) => /although/.test(String(c[0])))).toBe(false);
		} finally {
			warn.mockRestore();
		}
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

// ── Control evidence: attestations and revocations across a restore ───────
describe("restore of the control evidence (.st-control + revocation markers)", () => {
	const SID = "a7246fa7-5c1e-4a52-9a5e-2b8f3f1d0c11";
	const CID = "7101d5ae".padEnd(64, "a");
	const IMG = `sha256:${"e".repeat(64)}`;
	const TOKEN = "c".repeat(64);
	const LABELS = {
		"io.shared-terminal.conversation-relay": "2",
		"io.shared-terminal.session": SID,
	};
	const key = () => deriveSubkey(ATTESTATION_KEY_INFO);
	const live = (...p: string[]) => path.join(WORKSPACE_ROOT, ...p);
	const has = (p: string) =>
		fs.lstat(p).then(
			() => true,
			() => false,
		);
	const hooks = () => live(".claude-managed", SID, "conversation.json");

	function attestation(k: Buffer = key(), basis: "recreate" | "history" = "recreate") {
		return signAttestation(
			{ sessionId: SID, containerId: CID, imageId: IMG, basis, attemptId: "att-1" },
			k,
		);
	}

	/** The authority the boot reconcile uses, on the restored disk; image GONE (the incident). */
	function authority() {
		const view: ContainerView = {
			exists: true,
			running: true,
			token: TOKEN,
			managedMount: true,
			controlMount: true,
			imageId: IMG,
			imageRelay2: false,
			id: CID,
			imageExists: false,
			labels: { ...LABELS },
		};
		return new CaptureAuthority({
			workspaceRoot: WORKSPACE_ROOT,
			enabled: true,
			docker: {
				inspectCapture: async () => view,
				currentImage: async () => ({ imageId: "sha256:new", relay2: true }),
				probeRelay: async () => true,
			},
			// Same Docker host: `/start` re-adopted the session's own container by
			// name, so D1 points at it again.
			getRow: async () => ({
				status: "running",
				conversation_requested: 1,
				ingest_token_hash: hashIngestToken(TOKEN),
				ingest_token_hash_suspended: null,
				user_id: "u1",
				container_id: CID,
			}),
			checkRevocation: (sid) => checkRevocation(WORKSPACE_ROOT, sid),
			isRecreateUnresolved: async () => false,
			writeHooksFile: async () => {
				await fs.mkdir(path.dirname(hooks()), { recursive: true });
				await fs.writeFile(hooks(), "{}");
			},
			removeHooksFile: async () => {
				await fs.rm(hooks(), { force: true });
			},
			hooksFileExists: () => has(hooks()),
			readAttestation: (sid, cid) => readAttestation(WORKSPACE_ROOT, sid, cid),
			attestationKey: key,
			sleep: async () => undefined,
			identifyWaitMs: 10,
		});
	}

	async function backupThenLoseWorkspaceRoot(): Promise<void> {
		dbState.tables.set("users", [{ id: "u1", username: "diego" }]);
		dbState.tables.set("sessions", [{ session_id: SID, user_id: "u1", status: "running" }]);
		await runBackup(outDir);
		for (const e of await fs.readdir(WORKSPACE_ROOT))
			await fs.rm(live(e), { recursive: true, force: true });
		dbState.tables.clear();
	}

	async function seedSource(): Promise<void> {
		await seedWorkspace(SID, {
			[`${SID}/notes.md`]: "x",
			[`.conversations/${SID}/c1.events.jsonl`]: '{"seq":1}\n',
			[`.st-control/${SID}/recreate-attempt.json`]: '{"state":"open"}',
			[`.st-control/${SID}/relay.enabled`]: "",
			[`.st-control/${SID}/defer-skill-seed`]: "",
			[`.st-control/${SID}/composer/1.json`]: '{"phase":"active"}',
		});
		await writeAttestation(WORKSPACE_ROOT, attestation());
	}

	it("recovery after losing WORKSPACE_ROOT on the same Docker host: the attestation comes back, capture converges, nothing stale goes live", async () => {
		await seedSource();
		await backupThenLoseWorkspaceRoot();
		const listing = execFileSync("tar", [
			"-tzf",
			path.join(outDir, "workspaces", `${SID}.tar.gz`),
		]).toString();
		expect(listing).toContain(`.st-control/${SID}/capture-attestation.${CID}.json`);

		await runRestore(outDir);

		// Installed, and it verifies with this deployment's key.
		const read = await readAttestation(WORKSPACE_ROOT, SID, CID);
		expect(read.kind).toBe("present");
		expect(
			classifyAttestation(read, { sessionId: SID, containerId: CID, imageId: IMG }, key()),
		).toBe("valid");
		// The source's operational state is evidence only — never live.
		for (const f of ["recreate-attempt.json", "relay.enabled", "defer-skill-seed", "composer"])
			expect(await has(live(".st-control", SID, f))).toBe(false);
		const ev = await fs.readdir(live(".restore-evidence"));
		expect(ev).toHaveLength(1);
		const evDir = live(".restore-evidence", ev[0]!);
		expect(
			await fs.readFile(path.join(evDir, ".st-control", SID, "recreate-attempt.json"), "utf8"),
		).toBe('{"state":"open"}');
		expect(await has(path.join(evDir, ".st-control", SID, "composer", "1.json"))).toBe(true);
		// The rest of the session restored as before.
		expect(await fs.readFile(live(".conversations", SID, "c1.events.jsonl"), "utf8")).toBe(
			'{"seq":1}\n',
		);

		// The boot reconcile on the restored disk, image gone: capture is
		// re-established (relay identified first) instead of withdrawn.
		const a = authority();
		expect(await a.converge(SID)).toBe("written");
		expect((await a.capture(SID)).effective).toBe(true);
	});

	it("without the attestation in the backup (pre-fix backups) the same restore leaves capture off — the gap this closes", async () => {
		await seedSource();
		await fs.rm(live(".st-control", SID, `capture-attestation.${CID}.json`));
		await backupThenLoseWorkspaceRoot();
		await runRestore(outDir);
		const a = authority();
		expect(await a.converge(SID)).toBe("nothing");
		const block = await a.capture(SID);
		expect(block.effective).toBe(false);
		expect(block.pendingReasons).toContain("image-without-relay");
	});

	it("an attestation that does not verify with this key is not installed; one on the destination is never replaced", async () => {
		await writeAttestation(WORKSPACE_ROOT, attestation(Buffer.alloc(32, 1)));
		await backupThenLoseWorkspaceRoot();
		await runRestore(outDir);
		expect(await has(live(".st-control", SID, `capture-attestation.${CID}.json`))).toBe(false);

		// Destination already holds its own (valid) record of the container.
		await fs.rm(outDir, { recursive: true, force: true });
		for (const e of await fs.readdir(WORKSPACE_ROOT))
			await fs.rm(live(e), { recursive: true, force: true });
		await writeAttestation(WORKSPACE_ROOT, attestation(key(), "recreate"));
		await backupThenLoseWorkspaceRoot();
		const mine = attestation(key(), "history");
		await writeAttestation(WORKSPACE_ROOT, mine);
		const before = await fs.readFile(
			live(".st-control", SID, `capture-attestation.${CID}.json`),
			"utf8",
		);
		await runRestore(outDir);
		expect(
			await fs.readFile(live(".st-control", SID, `capture-attestation.${CID}.json`), "utf8"),
		).toBe(before);
	});

	it("a tarball with a link under the control or conversations dir is refused before anything is extracted", async () => {
		for (const planted of [
			`.st-control/${SID}/capture-attestation.${CID}.json`,
			`.conversations/${SID}`,
		]) {
			await seedWorkspace(SID, { [`${SID}/a.txt`]: "a" });
			await backupThenLoseWorkspaceRoot();
			const src = mkdtempSync(path.join(os.tmpdir(), "st-evil-ctl-"));
			const outside = mkdtempSync(path.join(os.tmpdir(), "st-outside-"));
			await fs.mkdir(path.join(src, SID), { recursive: true });
			await fs.mkdir(path.dirname(path.join(src, planted)), { recursive: true });
			await fs.writeFile(path.join(outside, "real.json"), JSON.stringify(attestation()));
			await fs.symlink(path.join(outside, "real.json"), path.join(src, planted));
			execFileSync("tar", [
				"-czf",
				path.join(outDir, "workspaces", `${SID}.tar.gz`),
				"-C",
				src,
				SID,
				planted.split("/").slice(0, 2).join("/"),
			]);
			await expect(runRestore(outDir)).rejects.toThrow(/not a plain file or directory/);
			expect(await has(live(".st-control", SID, `capture-attestation.${CID}.json`))).toBe(false);
			expect(await has(live(".conversations", SID))).toBe(false);
			await fs.rm(src, { recursive: true, force: true });
			await fs.rm(outside, { recursive: true, force: true });
			await fs.rm(outDir, { recursive: true, force: true });
		}
	});

	it.each([
		["<sid>//", (sid: string) => `${sid}//`],
		[".uploads/<sid>//", (sid: string) => `.uploads/${sid}//`],
		["<sid>/./", (sid: string) => `${sid}/./`],
		["./<sid>", (sid: string) => `./${sid}`],
	])("a non-canonical member name (%s) is refused — it would dodge the root-type rule", async (_n, nameOf) => {
		await seedWorkspace(SID, { [`${SID}/a.txt`]: "a" });
		await backupThenLoseWorkspaceRoot();
		const src = mkdtempSync(path.join(os.tmpdir(), "st-evil-canon-"));
		const outside = mkdtempSync(path.join(os.tmpdir(), "st-outside-"));
		await fs.mkdir(path.join(src, SID), { recursive: true });
		await fs.mkdir(path.join(src, ".uploads", SID), { recursive: true });
		const lnk = path.join(src, "lnk");
		await fs.symlink(outside, lnk);
		// GNU tar: --transform renames the symlink member to the odd name.
		const odd = nameOf(SID);
		execFileSync("tar", [
			"-czf",
			path.join(outDir, "workspaces", `${SID}.tar.gz`),
			"-C",
			src,
			SID,
			`.uploads/${SID}`,
			`--transform=s,^lnk$,${odd.replace(/,/g, "\\,")},`,
			"lnk",
		]);
		const listing = execFileSync("tar", ["-tzf", path.join(outDir, "workspaces", `${SID}.tar.gz`)])
			.toString()
			.split("\n");
		expect(listing).toContain(odd);
		await expect(runRestore(outDir)).rejects.toThrow(/non-canonical member/);
		expect((await fs.lstat(live(SID)).catch(() => null))?.isSymbolicLink() ?? false).toBe(false);
		await fs.rm(src, { recursive: true, force: true });
		await fs.rm(outside, { recursive: true, force: true });
	});

	it("a tarball not named after a session of this backup is refused before any write (no `.conversations.tar.gz`)", async () => {
		await seedWorkspace(SID, { [`${SID}/a.txt`]: "a" });
		await backupThenLoseWorkspaceRoot();
		const src = mkdtempSync(path.join(os.tmpdir(), "st-evil-name-"));
		await fs.mkdir(path.join(src, ".conversations", "victim"), { recursive: true });
		await fs.writeFile(path.join(src, ".conversations", "victim", "LIFTED"), '{"lifts":"x"}');
		execFileSync("tar", [
			"-czf",
			path.join(outDir, "workspaces", ".conversations.tar.gz"),
			"-C",
			src,
			".conversations",
		]);
		await expect(runRestore(outDir)).rejects.toThrow(/not a session of this backup/);
		expect(dbState.inserts).toHaveLength(0);
		expect(await has(live(".conversations", "victim", "LIFTED"))).toBe(false);
		await fs.rm(src, { recursive: true, force: true });
	});

	it("a global emergency cut (REVOKED_ALL) is carried and comes back in effect; never replaces the destination's", async () => {
		await seedWorkspace(SID, { [`${SID}/a.txt`]: "a" });
		await writeGlobalRevocation(WORKSPACE_ROOT, { at: "t", by: "cli" });
		const bytes = await fs.readFile(revokedAllPath(WORKSPACE_ROOT), "utf8");
		await backupThenLoseWorkspaceRoot();
		const m = JSON.parse(await fs.readFile(path.join(outDir, "manifest.json"), "utf8"));
		expect(m.globalRevocation).toBe(true);
		await runRestore(outDir);
		expect(await fs.readFile(revokedAllPath(WORKSPACE_ROOT), "utf8")).toBe(bytes);
		expect(await checkRevocation(WORKSPACE_ROOT, SID)).toBe("global");

		// Destination with its own marker: kept byte for byte.
		await fs.writeFile(revokedAllPath(WORKSPACE_ROOT), '{"mine":1}');
		await runRestore(outDir, { force: true });
		expect(await fs.readFile(revokedAllPath(WORKSPACE_ROOT), "utf8")).toBe('{"mine":1}');
	});

	it("never writes a revocation through a destination `.conversations/<sid>` that is a link", async () => {
		const ev = mkdtempSync(path.join(os.tmpdir(), "st-ev-"));
		const outside = mkdtempSync(path.join(os.tmpdir(), "st-outside-"));
		await writeSessionRevocation(ev, SID, { at: "t", by: "cli" }); // in effect in the "backup"
		await fs.mkdir(live(".conversations"), { recursive: true });
		await fs.symlink(outside, live(".conversations", SID));
		const r = await installControlEvidence(ev, SID);
		expect(r.revocation).toBe("destination-kept");
		expect(await fs.readdir(outside)).toEqual([]);
		await fs.rm(ev, { recursive: true, force: true });
		await fs.rm(outside, { recursive: true, force: true });
	});

	it("no REVOKED_ALL at backup time ⇒ none restored, none in the manifest", async () => {
		await seedWorkspace(SID, { [`${SID}/a.txt`]: "a" });
		await backupThenLoseWorkspaceRoot();
		expect(
			JSON.parse(await fs.readFile(path.join(outDir, "manifest.json"), "utf8")).globalRevocation,
		).toBeUndefined();
		await runRestore(outDir);
		expect(await has(revokedAllPath(WORKSPACE_ROOT))).toBe(false);
	});

	describe("revocations: never undone, never resurrected", () => {
		const revoked = () => live(".conversations", SID, "REVOKED");

		it("a revocation LIFTED in the backup is not brought back", async () => {
			await writeSessionRevocation(WORKSPACE_ROOT, SID, { at: "t", by: "api" });
			const bytes = await fs.readFile(revoked(), "utf8");
			expect(await retireSessionRevocation(WORKSPACE_ROOT, SID, bytes)).toBe("removed");
			await backupThenLoseWorkspaceRoot();
			await runRestore(outDir);
			expect(await has(revoked())).toBe(false);
			expect(await checkRevocation(WORKSPACE_ROOT, SID)).toBe("none");
		});

		it("a revocation IN EFFECT in the backup comes back in effect on a fresh destination (fail-closed)", async () => {
			await writeSessionRevocation(WORKSPACE_ROOT, SID, { at: "t", by: "cli" });
			const bytes = await fs.readFile(revoked(), "utf8");
			await backupThenLoseWorkspaceRoot();
			await runRestore(outDir);
			expect(await fs.readFile(revoked(), "utf8")).toBe(bytes);
			expect(await checkRevocation(WORKSPACE_ROOT, SID)).toBe("session");
			// …and the official enable can lift exactly it.
			expect(await retireSessionRevocation(WORKSPACE_ROOT, SID, bytes)).toBe("removed");
		});

		it("over a destination that LIFTED a later revocation, the backup's old in-effect one is NOT reactivated", async () => {
			await writeSessionRevocation(WORKSPACE_ROOT, SID, { at: "old", by: "cli" });
			await backupThenLoseWorkspaceRoot(); // backup: X in effect
			await writeSessionRevocation(WORKSPACE_ROOT, SID, { at: "new", by: "api" });
			const y = await fs.readFile(revoked(), "utf8");
			await retireSessionRevocation(WORKSPACE_ROOT, SID, y); // destination: Y lifted
			await runRestore(outDir);
			expect(await fs.readFile(revoked(), "utf8")).toBe(y);
			expect(await checkRevocation(WORKSPACE_ROOT, SID)).toBe("none");
		});

		it("over a destination with a revocation IN EFFECT, a backup whose one was lifted does NOT undo it", async () => {
			await writeSessionRevocation(WORKSPACE_ROOT, SID, { at: "old", by: "api" });
			await retireSessionRevocation(WORKSPACE_ROOT, SID, await fs.readFile(revoked(), "utf8"));
			await backupThenLoseWorkspaceRoot(); // backup: X lifted (REVOKED + LIFTED)
			await writeSessionRevocation(WORKSPACE_ROOT, SID, { at: "emergency", by: "cli" });
			const y = await fs.readFile(revoked(), "utf8");
			await runRestore(outDir);
			expect(await fs.readFile(revoked(), "utf8")).toBe(y);
			expect(await has(live(".conversations", SID, "LIFTED"))).toBe(false);
			expect(await checkRevocation(WORKSPACE_ROOT, SID)).toBe("session");
		});
	});
});
