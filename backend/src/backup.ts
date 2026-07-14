/**
 * backup.ts — operator-level backup + restore of the whole deployment (#240).
 *
 * A backup is a directory containing:
 *   - <table>.jsonl        one JSON row per line, deterministic PK order
 *   - workspaces/<sid>.tar.gz   the session workspace AND its uploads dir
 *                               (paths relative to WORKSPACE_ROOT, so restore
 *                               is a plain untar at the same root)
 *   - manifest.json        written LAST — its presence marks a complete run
 *
 * Restore replays the tables in FK-dependency order into a target D1 that
 * `migrateDb()` has just brought to current schema, then untars workspaces.
 * Two guards:
 *   - refuses a non-empty target unless --force (users OR sessions rows);
 *   - refuses a SECRETS_ENCRYPTION_KEY that can't decrypt a sample
 *     `secret`-typed blob from the dump — NO --force override, because a
 *     mismatched key silently corrupts every secret entry with no rotation
 *     path (see docs/SECRETS_ENCRYPTION_KEY.md). One decrypt round-trip up
 *     front, before any D1 write.
 *
 * Both directions are host-shell tools (npm run backup / restore inside the
 * backend container), NOT API surface — dumping every credential hash and
 * ciphertext over HTTP would be a new attack surface for zero operational
 * gain. gzip, not zstd as #240 sketched: the session image and the backend
 * image both ship tar+gzip already, and adding a zstd dependency for the
 * compression delta on code-heavy workspaces isn't worth a new binary.
 *
 * Running sessions are NOT quiesced: rows exported mid-write and workspaces
 * tar'd under load are point-in-time-ish, same caveat every file-level
 * backup has. Restore lands every previously-`running` session as `stopped`
 * with container_id NULL — the destination host has none of the source's
 * containers, which is exactly what reconcile() would conclude at next boot.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { d1Query, migrateDb } from "./db.js";
import { logger } from "./logger.js";
import { decryptSecret, type EncryptedSecret } from "./secrets.js";

const execFileP = promisify(execFile);

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/var/shared-terminal/workspaces";

// FK-dependency order — restore replays top to bottom. Each entry names
// its deterministic ORDER BY so two backups of identical data are
// byte-identical (diffable).
const TABLES: ReadonlyArray<{ name: string; orderBy: string }> = [
	{ name: "users", orderBy: "id" },
	{ name: "user_groups", orderBy: "id" },
	{ name: "user_group_members", orderBy: "group_id, user_id" },
	{ name: "sessions", orderBy: "session_id" },
	{ name: "session_configs", orderBy: "session_id" },
	{ name: "sessions_port_mappings", orderBy: "session_id, container_port" },
	{ name: "templates", orderBy: "id" },
	{ name: "invite_codes", orderBy: "code_hash" },
	{ name: "session_observe_log", orderBy: "id" },
];

export interface BackupManifest {
	version: 1;
	createdAt: string;
	schemaVersion: number;
	tables: Record<string, number>;
	workspaces: Record<string, { fileCount: number; tarBytes: number }>;
}

// ── Backup ──────────────────────────────────────────────────────────────────

export async function runBackup(outDir: string): Promise<BackupManifest> {
	await fs.mkdir(outDir, { recursive: true });
	if ((await fs.readdir(outDir)).length > 0) {
		throw new Error(`backup dir ${outDir} is not empty — refusing to mix with an existing backup`);
	}
	await fs.mkdir(path.join(outDir, "workspaces"));

	const versionRow = await d1Query<{ v: number | null }>(
		"SELECT MAX(version) AS v FROM schema_migrations",
	);
	const schemaVersion = versionRow.results[0]?.v ?? 0;

	const manifest: BackupManifest = {
		version: 1,
		createdAt: new Date().toISOString(),
		schemaVersion,
		tables: {},
		workspaces: {},
	};

	for (const t of TABLES) {
		const rows = await d1Query<Record<string, unknown>>(
			`SELECT * FROM ${t.name} ORDER BY ${t.orderBy}`,
		);
		const lines = rows.results.map((r) => JSON.stringify(r)).join("\n");
		await fs.writeFile(path.join(outDir, `${t.name}.jsonl`), lines === "" ? "" : `${lines}\n`);
		manifest.tables[t.name] = rows.results.length;
		logger.info(`[backup] ${t.name}: ${rows.results.length} row(s)`);
	}

	// Tar every session's workspace (and uploads dir when present) that
	// exists on disk. Sessions whose dir is gone (hard-deleted out-of-band,
	// different host) are skipped — the D1 row still travels, and /start
	// on the restored deployment recreates an empty workspace.
	const sessionRows = await d1Query<{ session_id: string }>(
		"SELECT session_id FROM sessions ORDER BY session_id",
	);
	for (const { session_id } of sessionRows.results) {
		const members: string[] = [];
		for (const rel of [session_id, path.join(".uploads", session_id)]) {
			try {
				await fs.access(path.join(WORKSPACE_ROOT, rel));
				members.push(rel);
			} catch {
				/* absent — fine */
			}
		}
		if (members.length === 0) continue;
		const tarPath = path.join(outDir, "workspaces", `${session_id}.tar.gz`);
		// -v lists one line per archived file on stdout — that IS the
		// manifest's file count, no second pass over the tree.
		const { stdout } = await execFileP(
			"tar",
			["-czvf", tarPath, "-C", WORKSPACE_ROOT, ...members],
			{ maxBuffer: 64 * 1024 * 1024 },
		);
		const fileCount = stdout.split("\n").filter((l) => l.trim() !== "").length;
		const tarBytes = (await fs.stat(tarPath)).size;
		manifest.workspaces[session_id] = { fileCount, tarBytes };
		logger.info(`[backup] workspace ${session_id}: ${fileCount} entries, ${tarBytes} bytes`);
	}

	// Manifest last: an interrupted run leaves a dir without manifest.json,
	// which restore refuses — no half-backup can be replayed by accident.
	await fs.writeFile(
		path.join(outDir, "manifest.json"),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);
	logger.info(`[backup] complete → ${outDir}`);
	return manifest;
}

// ── Restore ─────────────────────────────────────────────────────────────────

/** Deep-scan a parsed JSON value for the first {ciphertext, iv, tag}
 *  triple — the EncryptedSecret shape both env-var secrets and auth
 *  credentials persist. Used to pick the key-check sample. */
export function findEncryptedBlob(value: unknown): EncryptedSecret | null {
	if (value === null || typeof value !== "object") return null;
	const obj = value as Record<string, unknown>;
	if (
		typeof obj.ciphertext === "string" &&
		typeof obj.iv === "string" &&
		typeof obj.tag === "string"
	) {
		return { ciphertext: obj.ciphertext, iv: obj.iv, tag: obj.tag };
	}
	for (const v of Object.values(obj)) {
		const found = findEncryptedBlob(v);
		if (found !== null) return found;
	}
	return null;
}

async function readJsonl(dir: string, table: string): Promise<Record<string, unknown>[]> {
	const raw = await fs.readFile(path.join(dir, `${table}.jsonl`), "utf-8").catch(() => "");
	return raw
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

export async function runRestore(inDir: string, opts: { force?: boolean } = {}): Promise<void> {
	const manifestRaw = await fs.readFile(path.join(inDir, "manifest.json"), "utf-8").catch(() => {
		throw new Error(
			`${inDir} has no manifest.json — not a complete backup (interrupted run?); refusing`,
		);
	});
	const manifest = JSON.parse(manifestRaw) as BackupManifest;

	// Bring the target to current schema FIRST — a fresh D1 gets every
	// table; an existing one no-ops. The dump's rows INSERT by explicit
	// column list, so columns added by migrations newer than the backup
	// simply stay NULL (the additive-migration convention).
	await migrateDb();
	const versionRow = await d1Query<{ v: number | null }>(
		"SELECT MAX(version) AS v FROM schema_migrations",
	);
	const currentVersion = versionRow.results[0]?.v ?? 0;
	if (manifest.schemaVersion > currentVersion) {
		throw new Error(
			`backup schema v${manifest.schemaVersion} is NEWER than this code's v${currentVersion} — ` +
				"restore with a backend at least as new as the one that produced the backup",
		);
	}

	// Non-empty guard: users OR sessions present means this target is (or
	// was) a live deployment. --force is the explicit "yes, merge/clobber".
	const counts = await d1Query<{ u: number; s: number }>(
		"SELECT (SELECT COUNT(*) FROM users) AS u, (SELECT COUNT(*) FROM sessions) AS s",
	);
	const { u = 0, s = 0 } = counts.results[0] ?? {};
	if ((u > 0 || s > 0) && opts.force !== true) {
		throw new Error(
			`target D1 is not empty (${u} user(s), ${s} session(s)) — pass --force to restore anyway`,
		);
	}

	// SECRETS_ENCRYPTION_KEY check — NO force override (a wrong key
	// corrupts every secret with no rotation path). One decrypt
	// round-trip on the first encrypted blob found in the dump; a dump
	// with no secrets has nothing at stake and skips.
	const configRows = await readJsonl(inDir, "session_configs");
	let sample: EncryptedSecret | null = null;
	for (const row of configRows) {
		for (const col of ["env_vars_json", "auth_json"]) {
			const raw = row[col];
			if (typeof raw !== "string" || raw === "") continue;
			try {
				sample = findEncryptedBlob(JSON.parse(raw));
			} catch {
				/* unparseable column — the insert below will carry it verbatim */
			}
			if (sample) break;
		}
		if (sample) break;
	}
	if (sample) {
		try {
			decryptSecret(sample);
			logger.info("[restore] SECRETS_ENCRYPTION_KEY verified against a sample secret");
		} catch {
			throw new Error(
				"SECRETS_ENCRYPTION_KEY does not decrypt the backup's secrets — restore aborted " +
					"before any write. The destination must run the SOURCE deployment's key; see " +
					"docs/SECRETS_ENCRYPTION_KEY.md. (Deliberately not overridable with --force.)",
			);
		}
	}

	// Replay in FK order. INSERT OR REPLACE so a --force re-run over a
	// partially-restored target converges instead of dying on PK dupes.
	//
	// Column names come from the DUMP (Object.keys of parsed JSONL) and
	// are interpolated into the SQL — values ride parameters, names
	// can't. The same tampered-backup adversary the tarball allowlist
	// defends against could otherwise smuggle SQL through a key like
	// `id) SELECT ... --`, firing at the INSERT layer AFTER both the
	// --force and key guards have passed. Every legitimate column in
	// this schema is \w+; anything else in a dump is malformed, full stop.
	const SAFE_COL = /^\w+$/;
	for (const t of TABLES) {
		const rows = await readJsonl(inDir, t.name);
		for (const row of rows) {
			const cols = Object.keys(row);
			for (const col of cols) {
				if (!SAFE_COL.test(col)) {
					throw new Error(
						`unsafe column name in backup JSONL for ${t.name}: ${JSON.stringify(col)} — refusing`,
					);
				}
			}
			const placeholders = cols.map(() => "?").join(", ");
			await d1Query(
				`INSERT OR REPLACE INTO ${t.name} (${cols.join(", ")}) VALUES (${placeholders})`,
				cols.map((c) => row[c] as string | number | null),
			);
		}
		logger.info(`[restore] ${t.name}: ${rows.length} row(s)`);
	}

	// The destination host has none of the source's containers — land
	// previously-running rows exactly where reconcile() would put them.
	await d1Query(
		"UPDATE sessions SET status = 'stopped', container_id = NULL WHERE status = 'running'",
	);

	// Untar workspaces. Entry allowlist first: a tampered tarball must not
	// be able to write outside <sid>/ or .uploads/<sid>/ under
	// WORKSPACE_ROOT (classic tar path traversal).
	const wsDir = path.join(inDir, "workspaces");
	const tarballs = await fs.readdir(wsDir).catch(() => [] as string[]);
	for (const file of tarballs) {
		if (!file.endsWith(".tar.gz")) continue;
		const sid = file.slice(0, -".tar.gz".length);
		const tarPath = path.join(wsDir, file);
		const { stdout } = await execFileP("tar", ["-tzf", tarPath], {
			maxBuffer: 64 * 1024 * 1024,
		});
		const entries = stdout.split("\n").filter((l) => l.trim() !== "");
		const ok = entries.every(
			(e) =>
				(e === sid ||
					e.startsWith(`${sid}/`) ||
					e.startsWith(`.uploads/${sid}/`) ||
					e === `.uploads/${sid}`) &&
				!e.includes(".."),
		);
		if (!ok) {
			throw new Error(`workspace tarball ${file} contains out-of-scope paths — refusing`);
		}
		await execFileP("tar", ["-xzf", tarPath, "-C", WORKSPACE_ROOT]);
		logger.info(`[restore] workspace ${sid}: ${entries.length} entries`);
	}

	logger.info(`[restore] complete from ${inDir} (backup of ${manifest.createdAt})`);
}

// ── CLI ─────────────────────────────────────────────────────────────────────

/* c8 ignore start — argv shell exercised manually / on the host, the
 * logic above is what the tests pin. `typeof require` guard: tsc emits
 * CommonJS (require defined, main-check works) but vitest imports this
 * file as ESM where bare `require` would throw at import time. */
if (typeof require !== "undefined" && require.main === module) {
	const [mode, dir, ...rest] = process.argv.slice(2);
	const force = rest.includes("--force");
	const usage = "usage: node dist/backup.js backup [outDir] | restore <inDir> [--force]";
	const run = async (): Promise<void> => {
		if (mode === "backup") {
			const out =
				dir ??
				path.join(WORKSPACE_ROOT, ".backups", new Date().toISOString().replace(/[:.]/g, "-"));
			await runBackup(out);
		} else if (mode === "restore") {
			if (!dir) throw new Error(usage);
			await runRestore(dir, { force });
		} else {
			throw new Error(usage);
		}
	};
	run().catch((err) => {
		console.error((err as Error).message);
		process.exit(1);
	});
}
/* c8 ignore stop */
