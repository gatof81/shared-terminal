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
 * backup has. Files tar reports as changed/removed/shrunk while it read
 * them are tolerated and listed per workspace in the manifest
 * (`concurrentChanges`) — see createTarball for exactly what is accepted.
 * Restore lands every previously-`running` session as `stopped` with
 * container_id NULL — the destination host has none of the source's
 * containers, which is exactly what reconcile() would conclude at next boot.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
	ATTESTATION_FILE_PREFIX,
	ATTESTATION_KEY_INFO,
	classifyAttestation,
	readAttestation,
	writeAttestation,
} from "./conversation/captureAttestation.js";
import {
	LIFTED_FILE,
	REVOKED_ALL_FILE,
	REVOKED_FILE,
	readSessionRevocation,
	revokedAllPath,
} from "./conversation/revocation.js";
import { d1Query, migrateDb } from "./db.js";
import { logger } from "./logger.js";
import { CONTROL_DIR, fsyncDir } from "./recreateAttempt.js";
import { decryptSecret, deriveSubkey, type EncryptedSecret } from "./secrets.js";

const execFileP = promisify(execFile);

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/var/shared-terminal/workspaces";
// The shape of a session id as a path component (conversation/ids.ts).
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

// FK-dependency order — restore replays top to bottom. Each entry names
// its deterministic ORDER BY so two backups of identical data are
// byte-identical (diffable).
//
// `sinceSchema` = the migration that creates the table. A backup taken
// from a D1 older than that (the pre-deploy backup of an upgrade) skips
// it instead of failing on "no such table"; at or past that version a
// missing table still fails loudly. Restore reads a missing .jsonl as
// zero rows, and its migrateDb() creates the table on the target; it warns
// when the manifest's schema says the table should have been exported.
const TABLES: ReadonlyArray<{ name: string; orderBy: string; sinceSchema?: number }> = [
	{ name: "users", orderBy: "id" },
	{ name: "user_groups", orderBy: "id" },
	{ name: "user_group_members", orderBy: "group_id, user_id" },
	{ name: "sessions", orderBy: "session_id" },
	{ name: "session_configs", orderBy: "session_id" },
	// Phase 3 — FK → sessions. The events files ride the per-session
	// workspace tarball (`.conversations/<sid>` is added below);
	// `.claude-managed/` is NOT backed up: reconcile regenerates it.
	{ name: "claude_conversations", orderBy: "session_id", sinceSchema: 16 },
	// §6.2 — FK → sessions; owner data, not reconstructible from the events.
	{ name: "conversation_user_meta", orderBy: "st_session_id, cid", sinceSchema: 18 },
	{ name: "sessions_port_mappings", orderBy: "session_id, container_port" },
	{ name: "templates", orderBy: "id" },
	{ name: "invite_codes", orderBy: "code_hash" },
	{ name: "session_observe_log", orderBy: "id" },
	// P3a — in FK order. `agent_bindings.st_session_id` references no table
	// (history outlives a hard-deleted session), and the creation records go
	// LAST: their trigger skips an agent that already exists, so replaying
	// them after the agents re-creates nothing.
	{ name: "projects", orderBy: "project_id", sinceSchema: 19 },
	{ name: "project_agents", orderBy: "agent_id", sinceSchema: 19 },
	{ name: "agent_bindings", orderBy: "binding_id", sinceSchema: 19 },
	{ name: "project_agent_creations", orderBy: "owner_user_id, client_request_id", sinceSchema: 19 },
];

export interface BackupManifest {
	version: 1;
	createdAt: string;
	schemaVersion: number;
	tables: Record<string, number>;
	workspaces: Record<string, WorkspaceEntry>;
	/** `.conversations/REVOKED_ALL` existed: copied to `<backup>/REVOKED_ALL`. */
	globalRevocation?: true;
}

export interface WorkspaceEntry {
	fileCount: number;
	tarBytes: number;
	/** Present only when tar reported files changing under it (a live
	 *  session): the tarball is structurally valid and restorable, but
	 *  the listed paths may hold a mix of old and new content, a
	 *  zero-padded tail, or be missing. Absent ⇔ no change was reported. */
	concurrentChanges?: {
		count: number;
		/** First CONCURRENT_PATHS_MAX entries, in tar's report order. */
		paths: Array<{ path: string; kind: ConcurrentChangeKind }>;
		truncated: boolean;
	};
}

export type ConcurrentChangeKind = "changed" | "removed" | "shrank";

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
		if (t.sinceSchema !== undefined && schemaVersion < t.sinceSchema) {
			logger.info(
				`[backup] ${t.name}: skipped (source schema v${schemaVersion} predates v${t.sinceSchema})`,
			);
			continue;
		}
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
		for (const rel of [
			session_id,
			path.join(".uploads", session_id),
			// Phase 3 — the conversation event log (docs/CONVERSATION.md §9).
			path.join(".conversations", session_id),
			// The session's control dir (capture attestations, recreation
			// record, composer pane records, relay.enabled …). Carried as
			// EVIDENCE: restore installs only the attestations from it, and
			// only after verifying them — see installControlEvidence.
			path.join(CONTROL_DIR, session_id),
		]) {
			try {
				await fs.access(path.join(WORKSPACE_ROOT, rel));
				members.push(rel);
			} catch {
				/* absent — fine */
			}
		}
		if (members.length === 0) continue;
		const tarPath = path.join(outDir, "workspaces", `${session_id}.tar.gz`);
		const changes = await createTarball(tarPath, members);
		// Structural check of what was just written: gzip CRC + every tar
		// header, end to end. The listing is also the manifest's count.
		const fileCount = (await verifyTarball(tarPath)).length;
		const tarBytes = (await fs.stat(tarPath)).size;
		const entry: WorkspaceEntry = { fileCount, tarBytes };
		if (changes.length > 0) {
			entry.concurrentChanges = {
				count: changes.length,
				paths: changes.slice(0, CONCURRENT_PATHS_MAX),
				truncated: changes.length > CONCURRENT_PATHS_MAX,
			};
			logger.warn(
				`[backup] workspace ${session_id}: ${changes.length} file(s) changed while being archived — ` +
					"tarball is valid but not a consistent snapshot of them (see manifest concurrentChanges)",
			);
		}
		manifest.workspaces[session_id] = entry;
		logger.info(`[backup] workspace ${session_id}: ${fileCount} entries, ${tarBytes} bytes`);
	}

	// The global emergency cut is not inside any session's tarball.
	try {
		await fs.copyFile(revokedAllPath(WORKSPACE_ROOT), path.join(outDir, REVOKED_ALL_FILE));
		manifest.globalRevocation = true;
		logger.warn("[backup] global conversation revocation (REVOKED_ALL) is in effect — carried");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
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

// ── Tar ─────────────────────────────────────────────────────────────────────

const CONCURRENT_PATHS_MAX = 100;

// GNU tar's --create exit status: 0 = clean, 1 = "some files differ" (a
// file changed, shrank or vanished while being read — the archive itself
// is complete and well-formed), 2 = fatal (unreadable file, write error,
// …). A live session (Claude Code rewriting ~/.claude) routinely produces
// 1, so 1 is accepted — but ONLY when every stderr line is one of the
// three concurrent-change diagnostics below. Anything else on stderr, any
// other exit status, a signal, or a 1 with no recognised line fails the
// backup: an unreadable file must never pass as "changed". LC_ALL=C pins
// the message text these patterns match.
const CONCURRENT_PATTERNS: ReadonlyArray<{ re: RegExp; kind: ConcurrentChangeKind }> = [
	{ re: /^tar: (.+): file changed as we read it$/, kind: "changed" },
	{ re: /^tar: (.+): File removed before we read it$/, kind: "removed" },
	{ re: /^tar: (.+): File shrank by \d+ bytes; padding with zeros$/, kind: "shrank" },
];

/** Classify tar's stderr. `unknown` holds every line that is not a
 *  concurrent-change diagnostic; the caller fails on any of them. */
export function classifyTarStderr(stderr: string): {
	changes: Array<{ path: string; kind: ConcurrentChangeKind }>;
	unknown: string[];
} {
	const changes: Array<{ path: string; kind: ConcurrentChangeKind }> = [];
	const unknown: string[] = [];
	for (const line of stderr.split("\n")) {
		if (line.trim() === "") continue;
		const hit = CONCURRENT_PATTERNS.map((p) => ({ m: p.re.exec(line), kind: p.kind })).find(
			(x) => x.m !== null,
		);
		if (hit?.m) changes.push({ path: hit.m[1]!, kind: hit.kind });
		else unknown.push(line);
	}
	return { changes, unknown };
}

const tarEnv = (): NodeJS.ProcessEnv => ({ ...process.env, LC_ALL: "C" });
const TAR_MAX_BUFFER = 64 * 1024 * 1024;

async function createTarball(
	tarPath: string,
	members: string[],
): Promise<Array<{ path: string; kind: ConcurrentChangeKind }>> {
	try {
		await execFileP("tar", ["-czf", tarPath, "-C", WORKSPACE_ROOT, ...members], {
			env: tarEnv(),
			maxBuffer: TAR_MAX_BUFFER,
		});
		return [];
	} catch (err) {
		const e = err as { code?: unknown; signal?: unknown; stderr?: unknown };
		const stderr = typeof e.stderr === "string" ? e.stderr : "";
		if (e.code === 1 && e.signal == null) {
			const { changes, unknown } = classifyTarStderr(stderr);
			if (unknown.length === 0 && changes.length > 0) return changes;
		}
		throw new Error(
			`tar failed for ${path.basename(tarPath)} (exit ${String(e.code)}${e.signal ? `, signal ${String(e.signal)}` : ""}): ${stderr.trim() || (err as Error).message}`,
		);
	}
}

/** Full read of the tarball (decompression + every header). Throws on
 *  any error; returns the entry list. */
export async function verifyTarball(tarPath: string): Promise<string[]> {
	const { stdout } = await execFileP("tar", ["-tzf", tarPath], {
		env: tarEnv(),
		maxBuffer: TAR_MAX_BUFFER,
	}).catch((err: { stderr?: unknown; message?: string }) => {
		throw new Error(
			`tarball ${path.basename(tarPath)} failed verification: ${String(err.stderr ?? err.message).trim()}`,
		);
	});
	return stdout.split("\n").filter((l) => l !== "");
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

	// Every tarball must be a session of THIS backup, named by a session id.
	// The name becomes the allowlist prefix and the exclusion patterns below:
	// a tarball named `.conversations.tar.gz` would otherwise turn
	// `.conversations/<victim>/LIFTED` into an in-scope entry that no
	// exclusion matches. Checked before any write.
	const wsDir = path.join(inDir, "workspaces");
	const tarballs = await fs.readdir(wsDir).catch(() => [] as string[]);
	for (const file of tarballs) {
		if (!file.endsWith(".tar.gz")) continue;
		const sid = file.slice(0, -".tar.gz".length);
		if (!SESSION_ID_RE.test(sid) || !Object.keys(manifest.workspaces ?? {}).includes(sid)) {
			throw new Error(`workspace tarball ${file} is not a session of this backup — refusing`);
		}
	}

	// A global emergency cut (`conversation:disable -- --all`) in effect at
	// the backup comes back in effect (fail-closed, like a per-session one:
	// dropping it would end the cut without anyone running enable-all). Never
	// replaces the destination's own marker. Installed before any D1 write.
	if (manifest.globalRevocation === true) {
		const bytes = await fs.readFile(path.join(inDir, REVOKED_ALL_FILE), "utf8");
		const installed = await publishNoClobber(revokedAllPath(WORKSPACE_ROOT), bytes);
		logger.warn(
			`[restore] global conversation revocation (REVOKED_ALL) ${installed ? "installed" : "already present on the destination — kept"}; lift with conversation:enable-all`,
		);
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
		// A table the backup's schema already had but whose .jsonl is absent was
		// not exported: a backend older than the table took the backup after a
		// rollback (manifest = the D1 ledger, e.g. v19, while its TABLES list
		// stops at v18). It restores as zero rows; say so instead of hiding it.
		if (
			(t.sinceSchema ?? 0) <= manifest.schemaVersion &&
			!(await fs.stat(path.join(inDir, `${t.name}.jsonl`)).then(
				() => true,
				() => false,
			))
		) {
			logger.warn(
				`[restore] ${t.name}: no ${t.name}.jsonl although the backup is schema v${manifest.schemaVersion} — ` +
					"taken by a backend that does not export this table; restored as 0 rows",
			);
		}
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
	let evidenceDir: string | undefined;
	for (const file of tarballs) {
		if (!file.endsWith(".tar.gz")) continue;
		const sid = file.slice(0, -".tar.gz".length);
		const tarPath = path.join(wsDir, file);
		const { stdout } = await execFileP("tar", ["-tzf", tarPath], {
			maxBuffer: 64 * 1024 * 1024,
		});
		const entries = stdout.split("\n").filter((l) => l.trim() !== "");
		// Canonical names only: `<sid>//` or `<sid>/./` is the same path to
		// tar but would slip past the root-type rule below as "not a root"
		// (2nd review of #520: a symlink member `<sid>//` replaced the live
		// workspace root, which Docker then bind-mounts read-write).
		const odd = entries.find((e) => path.posix.normalize(e) !== e);
		if (odd !== undefined) {
			throw new Error(
				`workspace tarball ${file}: non-canonical member ${JSON.stringify(odd)} — refusing`,
			);
		}
		const ok = entries.every(
			(e) =>
				(e === sid ||
					e.startsWith(`${sid}/`) ||
					e.startsWith(`.uploads/${sid}/`) ||
					e === `.uploads/${sid}` ||
					e.startsWith(`.conversations/${sid}/`) ||
					e === `.conversations/${sid}` ||
					e.startsWith(`${CONTROL_DIR}/${sid}/`) ||
					e === `${CONTROL_DIR}/${sid}`) &&
				!e.includes(".."),
		);
		if (!ok) {
			throw new Error(`workspace tarball ${file} contains out-of-scope paths — refusing`);
		}
		// Member TYPES, from the verbose listing (same order, one line per
		// member). The session's root dirs must be directories and nothing
		// under its conversations or control dir may be a link: tar never
		// writes through a symlink it created itself, but the install step
		// below does write under `.conversations/<sid>/` — a planted
		// `.conversations/<sid> -> /elsewhere` would make it write there.
		// Workspace content (`<sid>/…`, uploads) keeps its links.
		const { stdout: verbose } = await execFileP("tar", ["-tvzf", tarPath], {
			maxBuffer: 64 * 1024 * 1024,
		});
		const types = verbose
			.split("\n")
			.filter((l) => l.trim() !== "")
			.map((l) => l[0]);
		if (types.length !== entries.length) {
			throw new Error(`workspace tarball ${file}: listing mismatch — refusing`);
		}
		const roots = new Set([
			sid,
			`.uploads/${sid}`,
			`.conversations/${sid}`,
			`${CONTROL_DIR}/${sid}`,
		]);
		entries.forEach((e, i) => {
			const name = e.replace(/\/$/, "");
			const t = types[i];
			const bad = roots.has(name)
				? t !== "d"
				: (name.startsWith(`.conversations/${sid}/`) ||
						name.startsWith(`${CONTROL_DIR}/${sid}/`)) &&
					t !== "-" &&
					t !== "d";
			if (bad) {
				throw new Error(
					`workspace tarball ${file}: ${JSON.stringify(name)} is not a plain file or directory — refusing`,
				);
			}
		});
		// Everything EXCEPT the session's control dir and its revocation
		// markers goes to its live place. Those must never be overwritten by
		// an older copy: a backup's `.st-control` would bring back a recreation
		// record, pane records or `relay.enabled` that no longer describe any
		// container, and a backup's REVOKED/LIFTED pair would, over a newer
		// destination state, either undo a revocation in effect (its LIFTED
		// replaced) or put an already-lifted one back in effect (its LIFTED
		// left in place, REVOKED replaced). `--anchored` keeps the patterns
		// from matching the same names inside the workspace itself.
		await execFileP("tar", [
			"-xzf",
			tarPath,
			"-C",
			WORKSPACE_ROOT,
			"--anchored",
			`--exclude=${CONTROL_DIR}`,
			`--exclude=.conversations/${sid}/${REVOKED_FILE}`,
			`--exclude=.conversations/${sid}/${LIFTED_FILE}`,
		]);
		const held = entries.filter(
			(e) =>
				e.replace(/\/$/, "") === `${CONTROL_DIR}/${sid}` ||
				e === `.conversations/${sid}/${REVOKED_FILE}` ||
				e === `.conversations/${sid}/${LIFTED_FILE}`,
		);
		if (held.length > 0) {
			evidenceDir ??= await makeEvidenceDir(manifest.createdAt);
			await execFileP("tar", [
				"-xzf",
				tarPath,
				"-C",
				evidenceDir,
				"--",
				...held.map((e) => e.replace(/\/$/, "")),
			]);
			const r = await installControlEvidence(evidenceDir, sid);
			logger.info(
				`[restore] control ${sid}: attestations installed=${r.installed} kept=${r.kept} rejected=${r.rejected}; revocation ${r.revocation}`,
			);
		}
		logger.info(`[restore] workspace ${sid}: ${entries.length} entries`);
	}
	if (evidenceDir) {
		logger.info(
			`[restore] the backup's control dirs and revocation markers are kept as evidence in ${evidenceDir} (nothing there is live)`,
		);
	}

	logger.info(`[restore] complete from ${inDir} (backup of ${manifest.createdAt})`);
}

// ── Control evidence (restore) ──────────────────────────────────────────────

/**
 * `<WORKSPACE_ROOT>/.restore-evidence/<backup>-<random>/`: where a restore
 * extracts the backup's `.st-control/<sid>` and REVOKED/LIFTED. Never read by
 * the backend; kept for the operator (a recreation record or a pane record
 * is what an investigation after a disaster needs) until removed by hand.
 */
async function makeEvidenceDir(createdAt: string): Promise<string> {
	const parent = path.join(WORKSPACE_ROOT, ".restore-evidence");
	await fs.mkdir(parent, { recursive: true, mode: 0o700 });
	const dir = path.join(
		parent,
		`${createdAt.replace(/[^0-9A-Za-z]/g, "-")}-${randomBytes(4).toString("hex")}`,
	);
	await fs.mkdir(dir, { mode: 0o700 });
	return dir;
}

/** `p` is a directory (not a link to one) whose real path is `expected`. */
async function isRealDir(p: string, expected: string): Promise<boolean> {
	try {
		if (!(await fs.lstat(p)).isDirectory()) return false;
		return (await fs.realpath(p)) === (await fs.realpath(expected).catch(() => expected));
	} catch {
		return false;
	}
}

async function isRegularFile(p: string): Promise<boolean> {
	try {
		return (await fs.lstat(p)).isFile();
	} catch {
		return false;
	}
}

export interface ControlInstall {
	installed: number;
	/** The destination already held an attestation of that container (never replaced). */
	kept: number;
	/** Did not verify with this deployment's key, malformed, or not a regular file. */
	rejected: number;
	revocation: "none" | "installed" | "destination-kept" | "lifted-in-backup";
}

/**
 * What a restore takes from the backup's control evidence, and nothing more:
 *
 * - **Capture attestations** (docs/CONVERSATION.md §2.7.5.1): each one that
 *   verifies with THIS deployment's key and names this session and the
 *   container its file name names is published at its live path, without
 *   replacing one already there. Installing one cannot grant anything by
 *   itself: it is a fact the backend signed about one container's creation
 *   (bound to its immutable id and image id), and capture still requires
 *   that container to be D1's, running, with both mounts, the token ↔ hash
 *   match, no revocation and a fresh relay probe. On a new host none of
 *   those containers exist and the files are inert; restored onto the same
 *   Docker host after losing WORKSPACE_ROOT, they are what keeps a session
 *   whose image was removed capable without a recreation — the recreation
 *   record that `conversation:attest` would need is not restored (below).
 * - **The per-session revocation**: the one IN EFFECT in the backup (REVOKED
 *   not named by LIFTED, the receiver's own rule) is installed only when the
 *   destination has no REVOKED of its own — a destination marker is always
 *   the newer state and is never touched. A revocation already lifted in the
 *   backup is not installed (nothing to bring back). One still in effect at
 *   the backup comes back in effect (fail-closed; the official enable lifts
 *   it like any other), because dropping it would silently undo an emergency
 *   disable.
 * - Everything else (`recreate-attempt.json`, composer pane records,
 *   `relay.enabled`, `defer-skill-seed`) stays in the evidence dir only: each
 *   describes containers or in-flight operations of the SOURCE, and the
 *   gates that read them (recreate-unresolved, retained-pending,
 *   send-in-progress) would act on that stale state. Restore lands every
 *   session stopped with no container (the same conclusion), and capture is
 *   re-established by the official procedure.
 */
export async function installControlEvidence(
	evidenceDir: string,
	sessionId: string,
	workspaceRoot: string = WORKSPACE_ROOT,
): Promise<ControlInstall> {
	const out: ControlInstall = { installed: 0, kept: 0, rejected: 0, revocation: "none" };
	const stagedControl = path.join(evidenceDir, CONTROL_DIR, sessionId);
	const names = (await isRealDir(stagedControl, path.join(evidenceDir, CONTROL_DIR, sessionId)))
		? await fs.readdir(stagedControl).catch(() => [] as string[])
		: [];
	const attestationName = new RegExp(
		`^${ATTESTATION_FILE_PREFIX.replace(/\./g, "\\.")}([0-9a-f]{64})\\.json$`,
	);
	let key: Buffer | null = null;
	for (const name of names) {
		const m = attestationName.exec(name);
		if (!m) continue;
		const containerId = m[1] as string;
		if (!(await isRegularFile(path.join(stagedControl, name)))) {
			out.rejected++;
			continue;
		}
		const read = await readAttestation(evidenceDir, sessionId, containerId);
		if (read.kind !== "present") {
			out.rejected++;
			continue;
		}
		try {
			key ??= deriveSubkey(ATTESTATION_KEY_INFO);
		} catch (err) {
			logger.warn(
				`[restore] control ${sessionId}: no attestation key (${(err as Error).message}) — attestations not installed`,
			);
			out.rejected++;
			continue;
		}
		const verdict = classifyAttestation(
			read,
			{ sessionId, containerId, imageId: read.record.imageId },
			key,
		);
		if (verdict !== "valid") {
			out.rejected++;
			continue;
		}
		if (await writeAttestation(workspaceRoot, read.record, () => true, { noClobber: true }))
			out.installed++;
		else out.kept++;
	}
	if (out.rejected > 0) {
		logger.warn(
			`[restore] control ${sessionId}: ${out.rejected} attestation(s) did not verify — not installed (a different SECRETS_ENCRYPTION_KEY, or a damaged/tampered backup)`,
		);
	}

	const stagedConv = path.join(evidenceDir, ".conversations", sessionId);
	const stagedRevoked = path.join(stagedConv, REVOKED_FILE);
	const stagedLifted = path.join(stagedConv, LIFTED_FILE);
	if (await isRegularFile(stagedRevoked)) {
		const liveRevoked = path.join(workspaceRoot, ".conversations", sessionId, REVOKED_FILE);
		const liftedOk =
			!(await fs.lstat(stagedLifted).catch(() => null)) || (await isRegularFile(stagedLifted));
		// A non-regular LIFTED lifts nothing: read the backup as "in effect".
		const inEffect = liftedOk
			? await readSessionRevocation(evidenceDir, sessionId)
			: await fs.readFile(stagedRevoked, "utf8");
		const liveDir = path.dirname(liveRevoked);
		const expectedDir = path.join(await fs.realpath(workspaceRoot), ".conversations", sessionId);
		if (inEffect === null) out.revocation = "lifted-in-backup";
		else if (
			(await fs.lstat(liveDir).catch(() => null)) !== null &&
			!(await isRealDir(liveDir, expectedDir))
		) {
			// Not the real directory (a link): never write through it.
			logger.warn(
				`[restore] control ${sessionId}: ${liveDir} is not a plain directory — revocation not installed`,
			);
			out.revocation = "destination-kept";
		} else {
			// link(2) decides atomically: any destination REVOKED (the newer
			// state, whatever its LIFTED says) is never replaced.
			out.revocation = (await publishNoClobber(liveRevoked, inEffect))
				? "installed"
				: "destination-kept";
		}
	}
	return out;
}

/** temp + fsync + link(2): creates `file` with exactly `bytes`, never replaces it. */
async function publishNoClobber(file: string, bytes: string): Promise<boolean> {
	const dir = path.dirname(file);
	await fs.mkdir(dir, { recursive: true });
	const tmp = `${file}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
	try {
		const fh = await fs.open(tmp, "wx", 0o600);
		try {
			await fh.writeFile(bytes);
			await fh.sync();
		} finally {
			await fh.close();
		}
		try {
			await fs.link(tmp, file);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw err;
		}
	} finally {
		await fs.rm(tmp, { force: true });
	}
	await fsyncDir(dir);
	return true;
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
