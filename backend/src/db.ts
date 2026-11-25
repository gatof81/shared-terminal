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

import { createHash } from "node:crypto";
import { logger } from "./logger.js";

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? "";
const DATABASE_ID = process.env.D1_DATABASE_ID ?? "";
// Lab/test seam only: points the client at a D1-compatible endpoint (e.g. the
// SQLite shim in experiments/acp-agents/d1-shim.mjs) so an experimental backend
// can run without touching a real D1. Unset ⇒ Cloudflare, byte-identical.
const D1_API_BASE = (process.env.D1_API_BASE ?? "https://api.cloudflare.com").replace(/\/+$/, "");

interface D1QueryResult<T = Record<string, unknown>> {
	results: T[];
	success: boolean;
	meta: { changes: number; duration: number; last_row_id: number; rows_read?: number };
}

interface D1ApiResponse<T = Record<string, unknown>> {
	result: D1QueryResult<T>[];
	success: boolean;
	errors: Array<{ code: number; message: string }>;
}

// Process-local counter of every `d1Query` call, surfaced via
// `GET /api/admin/stats` (#241). Resets on every backend restart.
// CLAUDE.md flags D1 round-trips as the expensive thing on hot
// paths — exposing the count gives operators a way to spot a
// runaway D1-spammer (e.g. an in-flight request loop) without
// SSHing the host.
//
// Bumped at the top of `d1Query` so retried/failed calls are
// counted too — a 500 from D1 still consumed quota, and that's
// what the operator wants to see.
//
// Non-zero baseline is EXPECTED on a fresh boot: `migrateDb()`
// issues its ledger check (and, when migrations are pending, their
// DDL) before the first operator request lands. Steady-state boots
// read ~2 (#349 ledger: CREATE IF NOT EXISTS + SELECT); a first boot
// on a fresh or pre-ledger DB spikes to ~30+ while the recorded
// migrations apply. Either is the migration baseline, not unexpected
// activity.
let d1CallsSinceBoot = 0;

/** Read-only counter accessor for the admin stats endpoint. */
export function getD1CallsSinceBoot(): number {
	return d1CallsSinceBoot;
}

/** Test seam: reset the counter so cases don't bleed into each
 *  other. Production code never calls this. */
export function __resetD1CallsForTests(): void {
	d1CallsSinceBoot = 0;
	rowsReadSinceBoot = 0;
	readsByStatement.clear();
}

// Rows read, as D1 reports them in each answer's `meta.rows_read` — the unit
// Cloudflare's daily read limit counts, not the number of calls. The total and
// a per-statement breakdown, process-local like the call counter, are what
// tell which query spends the quota. Statements are keyed by their normalised
// text (never params: those can carry secrets): an ~80-char readable prefix
// plus a short hash of the whole text, since many statements share a prefix
// (`SELECT c.*, (SELECT COUNT(*) …` is both a topic and the topic list). The
// map is bounded: past READS_MAX_KEYS a new statement lands in one "(other)"
// bucket, so a caller building SQL dynamically cannot grow it without limit.
let rowsReadSinceBoot = 0;
const READS_MAX_KEYS = 200;
const READS_OTHER = "(other)";
const readsByStatement = new Map<string, { queries: number; rowsRead: number }>();

function recordRowsRead(sql: string, rowsRead: unknown): void {
	if (typeof rowsRead !== "number" || !Number.isFinite(rowsRead) || rowsRead < 0) return;
	rowsReadSinceBoot += rowsRead;
	const norm = sql.replace(/\s+/g, " ").trim();
	let key = `${norm.slice(0, 80)} #${createHash("sha1").update(norm).digest("hex").slice(0, 8)}`;
	if (!readsByStatement.has(key) && readsByStatement.size >= READS_MAX_KEYS) key = READS_OTHER;
	const e = readsByStatement.get(key) ?? { queries: 0, rowsRead: 0 };
	e.queries++;
	e.rowsRead += rowsRead;
	readsByStatement.set(key, e);
}

/** Rows read since boot and the `top` statements by rows read, for the admin stats endpoint. */
export function getD1RowsRead(top = 10): {
	rowsReadSinceBoot: number;
	topStatements: Array<{ statement: string; queries: number; rowsRead: number }>;
} {
	return {
		rowsReadSinceBoot,
		topStatements: [...readsByStatement]
			.map(([statement, e]) => ({ statement, ...e }))
			.sort((a, b) => b.rowsRead - a.rowsRead)
			.slice(0, top),
	};
}

// Hard ceiling on every D1 round-trip (#343). Without a signal, a
// hung-but-accepting endpoint (stalled CF edge, half-open TCP — distinct
// from a fast connection-refused, which fails immediately) pins each call
// to undici's default header timeout of ~300 s. Everything hot funnels
// through d1Query — dispatcher lookups, login, ownership-cache misses,
// the idle sweeper's SELECT — so during a D1 brown-out those requests
// would hold sockets for minutes instead of failing fast into their
// callers' existing catch/degrade paths. 10 s is ~2 orders of magnitude
// above healthy D1 latency (tens of ms) yet short enough that a wedged
// dependency surfaces as a burst of sourced errors, not a stalled server.
// The signal also covers the response BODY reads below — undici ties the
// whole request lifecycle to it, so a body that stalls mid-stream aborts
// too.
const D1_TIMEOUT_MS = 10_000;

/**
 * Execute a single SQL statement against D1.
 * Returns the results array for SELECT, or meta for INSERT/UPDATE/DELETE.
 */
/**
 * D1 answered and said the statement failed: it was not applied. Every
 * other error from `d1Query` (timeout, network, a non-2xx without that
 * answer) leaves it unknown whether the statement ran — callers whose
 * correctness depends on that distinction must treat those as ambiguous.
 */
export class D1StatementError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "D1StatementError";
	}
}

export async function d1Query<T = Record<string, unknown>>(
	sql: string,
	params?: unknown[],
): Promise<D1QueryResult<T>> {
	d1CallsSinceBoot++;
	const url = `${D1_API_BASE}/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;

	let data: D1ApiResponse<T>;
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${API_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ sql, params: params ?? [] }),
			signal: AbortSignal.timeout(D1_TIMEOUT_MS),
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`D1 API error (${res.status}): ${text}`);
		}

		data = (await res.json()) as D1ApiResponse<T>;
	} catch (err) {
		// Rewrap the abort as a sourced error: undici surfaces the fired
		// timeout signal as a DOMException named "TimeoutError", whose
		// message ("The operation was aborted due to timeout") says nothing
		// about D1 or the statement. Callers log err.message, so name the
		// dependency and the query. SQL text only — never params, which can
		// carry decrypted secret values on the session_configs paths.
		if (err instanceof DOMException && err.name === "TimeoutError") {
			throw new Error(`D1 API timeout after ${D1_TIMEOUT_MS} ms for: ${sql.slice(0, 120)}`);
		}
		throw err;
	}

	if (!data.success) {
		throw new D1StatementError(`D1 query failed: ${data.errors.map((e) => e.message).join(", ")}`);
	}

	// Guard the empty/absent result array. D1's `/query` returns one
	// `D1QueryResult` per statement, so a single-statement query always
	// yields `result[0]`. But a malformed `success: true` response with an
	// empty (or entirely absent) `result` would otherwise return `undefined`
	// — or throw on the absent case — and every caller immediately reads
	// `.results`, surfacing as an opaque `Cannot read properties of
	// undefined (reading 'results')` in an unrelated module rather than at
	// the source. The `?.` covers the absent-key case too. Fail loud and
	// sourced.
	// `=== undefined` rather than `!first`: `first` is `D1QueryResult | undefined`
	// (always an object when present), so the precise absent-check reads right
	// and won't widen the throw surface if the type ever gains a falsy member.
	const first = data.result?.[0];
	if (first === undefined) {
		throw new Error(`D1 returned no result set for: ${sql}`);
	}
	recordRowsRead(sql, first.meta?.rows_read);
	return first;
}

/**
 * Execute multiple SQL statements (for migrations).
 *
 * Sequential one-statement-per-request. The D1 REST `/query` endpoint
 * does have undocumented multi-statement shapes (semicolon-joined SQL,
 * `{ batch: [...] }` body), but neither has been empirically verified
 * here. Five DDL round-trips at cold start is negligible; trading
 * proven reliability for that tiny optimisation regresses the only
 * code path that runs at every boot. See PR #141 review history.
 */
export async function d1Batch(statements: string[]): Promise<void> {
	for (const sql of statements) {
		const trimmed = sql.trim();
		if (!trimmed) continue;
		await d1Query(trimmed);
	}
}

// ── Migrations ──────────────────────────────────────────────────────────────
//
// #349 — versioned, ledger-tracked migrations. Earlier revisions replayed
// every statement on every boot (CREATE TABLE IF NOT EXISTS + try/catch'd
// ALTERs). That stayed correct only for as long as every statement was
// hand-audited to be idempotent, burned ~30 D1 round-trips per boot, and
// couldn't distinguish "applied" from "not yet applied" for anything
// imperative. Each migration now runs once and is recorded in
// `schema_migrations`.
//
// Rules for authors:
//   - APPEND ONLY. Never renumber, reorder, or edit an entry that has
//     shipped — deployed ledgers already reference those versions.
//   - Versions 1–11 predate the ledger and MUST STAY IDEMPOTENT: a
//     pre-ledger deployment upgrading to this code already has the whole
//     schema in place but an EMPTY ledger, so every one of them re-runs
//     exactly once against the existing schema before being recorded.
//   - Keep NEW migrations idempotent too where feasible: D1 over HTTP has
//     no multi-statement transaction, so a crash between apply() and the
//     ledger INSERT re-runs that migration on the next boot.
//
// The table/column design rationale comments live with the migration that
// introduced them — they are the durable documentation for the schema.

interface Migration {
	version: number;
	description: string;
	apply: () => Promise<void>;
}

/** ALTER TABLE … ADD COLUMN, tolerating "already exists". SQLite has no
 *  ADD COLUMN IF NOT EXISTS, so the swallowed duplicate-column error IS
 *  the idempotency mechanism for the pre-ledger migrations (see rules
 *  above). Any other error propagates. */
async function addColumnIfMissing(table: string, columnDef: string): Promise<void> {
	try {
		await d1Query(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
	} catch (err) {
		if (!/duplicate column name|already exists/i.test((err as Error).message)) {
			throw err;
		}
	}
}

/** Exported for tests (ledger bookkeeping asserts against the count).
 *  Order within the array is the application order for a fresh DB and
 *  mirrors the pre-ledger boot sequence exactly. */
export const MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		description:
			"baseline schema: users, sessions, invite_codes, sessions_port_mappings, templates, groups, observe log, session_configs",
		apply: async () => {
			await d1Batch([
				// `is_admin` (0/1) gates invite-mint and revoke (#50). The
				// bootstrap-register path INSERTs is_admin=1; every other account
				// defaults to 0. Auto-promotion of an existing earliest-created
				// user happens AFTER the d1Batch (see migration block below) so a
				// pre-existing single-user deploy doesn't get locked out of
				// minting after the column is added.
				`CREATE TABLE IF NOT EXISTS users (
		                        id          TEXT PRIMARY KEY,
		                        username    TEXT UNIQUE NOT NULL,
		                        password_hash TEXT NOT NULL,
		                        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
		                        is_admin    INTEGER NOT NULL DEFAULT 0
		                )`,
				// `sessions` must follow `users` — the FK on user_id references
				// users(id), and these statements run sequentially. Don't reorder
				// without also handling deferred-FK semantics on D1.
				// FK on user_id (#20): D1 enables foreign-key enforcement on every
				// connection by default, so this is load-bearing once user
				// deletion lands. ON DELETE CASCADE: deleting a user purges their
				// sessions atomically, no orphan rows. Pre-existing tables
				// (created before this migration) won't pick up the FK — SQLite
				// has no ADD CONSTRAINT, only table rebuild — so existing
				// deployments need a manual rebuild if they want enforcement on
				// rows that already exist. Documented as a known limitation in
				// the issue.
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
		                        last_connected_at TEXT,
		                        bootstrap_log   TEXT,
		                        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		                )`,
				`CREATE INDEX IF NOT EXISTS idx_sessions_user
		                        ON sessions(user_id, status)`,
				// Invite-only registration. The first user is allowed to register
				// without an invite (bootstrap); every subsequent register must
				// claim a row here. Atomic claim is enforced by an UPDATE …
				// WHERE used_at IS NULL with `meta.changes === 1` check, so two
				// concurrent registers can't redeem the same code. expires_at
				// bounds how long an unredeemed code stays valid (NULL = never).
				//
				// `code_hash` (SHA-256 hex of the plaintext) is stored at rest;
				// the plaintext is only returned to the minter once at creation
				// time and never persisted (#49). `code_prefix` is the first
				// 4 hex chars of the plaintext — leaks 16 bits but lets the
				// minter recognise their own codes in the list ("oh, the one
				// starting `ab12` is for bob"); 48 bits of secret remain.
				`CREATE TABLE IF NOT EXISTS invite_codes (
		                        code_hash   TEXT PRIMARY KEY,
		                        code_prefix TEXT NOT NULL,
		                        created_by  TEXT NOT NULL,
		                        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
		                        used_by     TEXT,
		                        used_at     TEXT,
		                        expires_at  TEXT
		                )`,
				`CREATE INDEX IF NOT EXISTS idx_invite_codes_creator
		                        ON invite_codes(created_by)`,
				// Session configuration is 1:1 with `sessions.session_id` and is
				// bound at create time (see epic #184 / issue #185). Every column
				// is nullable so a bare `POST /api/sessions` with no config still
				// produces a valid sessions row without forcing a config row to
				// exist; today there's no FK from sessions → session_configs, only
				// the reverse, so a missing config row is the legitimate "no
				// config supplied" state. ON DELETE CASCADE on the FK keeps the
				// table garbage-free when a hard-delete drops the parent.
				//
				// Structured columns where the field has a defined scalar shape;
				// JSON columns for repeating sub-records (repos, ports, env vars)
				// because storing them relationally would require a child table
				// per shape and #184 deliberately defers that scope. Each child
				// issue (#186 env, #188 repos, #190 ports, #191 hooks, #194
				// resources) hardens validation when its UI lands.
				//
				// `bootstrapped_at` gates the one-shot postCreate hook (PR 185b):
				// NULL = not yet run; set to an ISO timestamp on success. The
				// runner uses an UPDATE … WHERE bootstrapped_at IS NULL with
				// `meta.changes === 1` to make the gate atomic across concurrent
				// `start()` calls (e.g. two browser tabs racing to revive a stopped
				// session). See PR 185b for the runner.
				//
				// IMPORTANT — `bootstrapped_at` MUST stay nullable with no
				// DEFAULT. If a `DEFAULT (datetime('now'))` were added (or `NOT
				// NULL` without an explicit insert column), every freshly-
				// persisted config row would land with `bootstrapped_at` already
				// set, the runner's `WHERE bootstrapped_at IS NULL` predicate
				// would never match, and the one-shot postCreate hook would
				// silently never fire — a data-loss-class silent failure for
				// users who expected their repo to be cloned / bootstrap to have
				// run. `created_at` directly below is the only column on this
				// table that legitimately uses `NOT NULL DEFAULT (datetime('now'))`.
				// `persistSessionConfig` deliberately omits `bootstrapped_at`
				// from its INSERT column list to preserve the NULL-on-create
				// invariant; `sessionConfig.test.ts` locks this with an explicit
				// SQL-shape assertion.
				// #190 PR 190b — runtime port mappings, distinct from the
				// declarative `session_configs.ports_json` config. The kernel
				// hands Docker a random ephemeral host port at `container.start()`
				// (we pass `-p 0:<container>`); we read it back via `inspect`
				// and persist it here so the dispatcher (190c) can answer
				// `Host: p<container>-<sessionId>.<base>` requests without
				// re-inspecting on every hit.
				//
				// Rebuilt on every container start (including reconcile() after
				// a backend restart — the host port is still bound by the
				// running container, we just need to re-discover the mapping).
				// ON DELETE CASCADE on the FK keeps the table garbage-free
				// when a hard-delete drops the parent. Composite primary key
				// (session_id, container_port) catches a duplicate container_port
				// at the DB layer if validation ever lets one through (the
				// schema's `superRefine` already rejects it at ingest, but
				// defence-in-depth is cheap here).
				`CREATE TABLE IF NOT EXISTS sessions_port_mappings (
		                        session_id      TEXT NOT NULL,
		                        container_port  INTEGER NOT NULL,
		                        host_port       INTEGER NOT NULL,
		                        is_public       INTEGER NOT NULL DEFAULT 0,
		                        PRIMARY KEY (session_id, container_port),
		                        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
		                )`,
				`CREATE INDEX IF NOT EXISTS idx_port_mappings_session
		                        ON sessions_port_mappings(session_id)`,
				// Templates: per-user reusable session-config presets. The
				// `config` column is a JSON blob with the same shape as
				// `session_configs` minus secret values — `secret`-typed env
				// entries collapse to `secret-slot` markers, and `auth.pat` /
				// `auth.ssh.privateKey` ciphertexts are dropped (only the
				// "isSet" intent is preserved). `Use template` flow re-prompts
				// for those values; the schema's existing `secret-slot`
				// rejection on `POST /sessions` (added in #186) is the
				// regression guard if a client misbehaves and submits a
				// template-shape config directly.
				//
				// `owner_user_id` has no FK to `users` because cross-table
				// joins on D1 are HTTP round-trips and the listing endpoint
				// already filters on `owner_user_id`. A future user-deletion
				// path will need to drop owned templates explicitly (same
				// shape as `session_configs.session_id`'s lack-of-CASCADE in
				// the early sessions table).
				`CREATE TABLE IF NOT EXISTS templates (
		                        id              TEXT PRIMARY KEY,
		                        owner_user_id   TEXT NOT NULL,
		                        name            TEXT NOT NULL,
		                        description     TEXT,
		                        config          TEXT NOT NULL,
		                        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
		                        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
		                )`,
				`CREATE INDEX IF NOT EXISTS idx_templates_owner
		                        ON templates(owner_user_id)`,
				// User groups for the tech-lead role (#201). A group is an admin-
				// created collection of users with one designated "lead" who can
				// observe (read-only) the sessions of every member. The lead is
				// implicitly inserted into `user_group_members` on group create
				// so "sessions visible to user X" reduces to "X's own ∪ sessions
				// of any group where X is the lead" with a single JOIN.
				//
				// `lead_user_id` carries `ON DELETE RESTRICT` rather than
				// CASCADE: deleting a user who's still leading a group should
				// fail loudly at the DB layer so an admin has to reassign the
				// lead before the user can be removed — silent CASCADE would
				// leave the group leaderless (lead_user_id NULL would require
				// a nullable column we don't want) or orphaned. v1 has no
				// user-deletion API, so this is forward-looking defense.
				//
				// `user_group_members` rows CASCADE on either side: deleting a
				// group nukes its membership rows; deleting a user removes them
				// from every group they were in. Composite primary key catches
				// duplicate (group, user) at the DB layer (defence-in-depth
				// against a future racy add-member path).
				//
				// idx_group_members_user covers the lead-of-which-groups lookup
				// — `WHERE user_id = ?` in `assertCanObserve` (#201b). Without
				// it that becomes a table scan per auth check on the observe
				// path; same shape as the other per-user indexes in this file.
				`CREATE TABLE IF NOT EXISTS user_groups (
		                        id              TEXT PRIMARY KEY,
		                        name            TEXT NOT NULL,
		                        description     TEXT,
		                        lead_user_id    TEXT NOT NULL,
		                        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
		                        updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
		                        FOREIGN KEY (lead_user_id) REFERENCES users(id) ON DELETE RESTRICT
		                )`,
				`CREATE INDEX IF NOT EXISTS idx_user_groups_lead
		                        ON user_groups(lead_user_id)`,
				`CREATE TABLE IF NOT EXISTS user_group_members (
		                        group_id        TEXT NOT NULL,
		                        user_id         TEXT NOT NULL,
		                        added_at        TEXT NOT NULL DEFAULT (datetime('now')),
		                        PRIMARY KEY (group_id, user_id),
		                        FOREIGN KEY (group_id) REFERENCES user_groups(id) ON DELETE CASCADE,
		                        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		                )`,
				`CREATE INDEX IF NOT EXISTS idx_group_members_user
		                        ON user_group_members(user_id)`,
				// Observe-mode audit log (#201d). One row per WS observe-attach:
				// INSERT on attach open, UPDATE ended_at on close. The owner can
				// see who watched their session, admins / leads can see their
				// own observation history. Without this trail, the role would be
				// the kind of design that gets called out a year later when an
				// incident asks "who else was in this user's session?" Cost is
				// two D1 calls per observe attach (INSERT open, UPDATE close)
				// + the index reads behind the two list endpoints.
				//
				// `owner_user_id` is DENORMALISED at insert time — not a FK.
				// Rationale: the owner is recoverable via `session_id → sessions.user_id`
				// at read time, but storing it here preserves audit fidelity if
				// the session row is later hard-deleted (CASCADE below) and
				// preserves it for forensic queries that JOIN on observer + owner
				// without re-resolving the session.
				//
				// `ON DELETE CASCADE` on `session_id` is the locked-in tradeoff
				// from the issue: hard-deleting a session purges its observe log
				// too. Favours operational tidiness over retention. If retention
				// matters for compliance, switch to `ON DELETE SET NULL` and add
				// a periodic purge; revisit only when a real requirement surfaces.
				//
				// `ON DELETE CASCADE` on `observer_user_id` is forward-looking
				// (v1 has no user-delete API). When that lands, a deleted user's
				// observation history vanishes with them — same shape as the
				// session FK above. The owner-side denormalised column is
				// deliberately unaffected: an observer who watched a session
				// owned by a since-deleted user still has their own log entry
				// preserved, with `owner_user_id` as a tombstone reference.
				//
				// Two indexes cover both list endpoints:
				//   - `idx_observe_log_session` powers `GET /api/sessions/:id/observe-log`
				//   - `idx_observe_log_observer` powers a forward-looking
				//     "history of sessions I've observed" view per observer.
				// `listAll` (admin cross-user) walks the table newest-first
				// without an index hit — fine at v1 scale; revisit if the log
				// grows past the hard cap.
				`CREATE TABLE IF NOT EXISTS session_observe_log (
		                        id                TEXT PRIMARY KEY,
		                        observer_user_id  TEXT NOT NULL,
		                        session_id        TEXT NOT NULL,
		                        owner_user_id     TEXT NOT NULL,
		                        started_at        TEXT NOT NULL DEFAULT (datetime('now')),
		                        ended_at          TEXT,
		                        FOREIGN KEY (observer_user_id) REFERENCES users(id) ON DELETE CASCADE,
		                        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
		                )`,
				`CREATE INDEX IF NOT EXISTS idx_observe_log_session
		                        ON session_observe_log(session_id)`,
				`CREATE INDEX IF NOT EXISTS idx_observe_log_observer
		                        ON session_observe_log(observer_user_id)`,
				`CREATE TABLE IF NOT EXISTS session_configs (
		                        session_id              TEXT PRIMARY KEY,
		                        workspace_strategy      TEXT,
		                        cpu_limit               INTEGER,
		                        mem_limit               INTEGER,
		                        idle_ttl_seconds        INTEGER,
		                        post_create_cmd         TEXT,
		                        post_start_cmd          TEXT,
		                        repos_json              TEXT,
		                        ports_json              TEXT,
		                        allow_privileged_ports  INTEGER,
		                        env_vars_json           TEXT,
		                        auth_json               TEXT,
		                        git_identity_json       TEXT,
		                        dotfiles_json           TEXT,
		                        agent_seed_json         TEXT,
		                        write_env_file          INTEGER,
		                        bootstrapped_at         TEXT,
		                        created_at              TEXT NOT NULL DEFAULT (datetime('now')),
		                        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
		                )`,
			]);
		},
	},
	{
		// ALTER for any table that pre-dates the expires_at column (e.g. a
		// dev DB that ran the original migration before this column
		// existed). CREATE TABLE in v1 already includes the column for
		// fresh deploys, so this is a no-op there.
		version: 2,
		description: "invite_codes.expires_at",
		apply: () => addColumnIfMissing("invite_codes", "expires_at TEXT"),
	},
	{
		// #50 — `is_admin` gates invite mint/revoke. The auto-promotion of
		// an existing earliest-created user is v10, kept AFTER the column
		// ALTERs (same relative order as the pre-ledger boot sequence) so
		// a pre-existing single-user deploy isn't locked out of minting.
		version: 3,
		description: "users.is_admin (#50)",
		apply: () => addColumnIfMissing("users", "is_admin INTEGER NOT NULL DEFAULT 0"),
	},
	{
		// #188 PR 188b — encrypted repo-clone credentials (PAT / SSH key +
		// known_hosts) on session_configs.
		version: 4,
		description: "session_configs.auth_json (#188)",
		apply: () => addColumnIfMissing("session_configs", "auth_json TEXT"),
	},
	{
		// #191 PR 191a — lifecycle-hook columns: gitIdentity / dotfiles /
		// agentSeed JSON blobs. The bootstrap stages that consume these
		// landed in 191b.
		version: 5,
		description: "session_configs lifecycle-hook columns (#191)",
		apply: async () => {
			for (const column of ["git_identity_json", "dotfiles_json", "agent_seed_json"] as const) {
				await addColumnIfMissing("session_configs", `${column} TEXT`);
			}
		},
	},
	{
		// #190 PR 190c — the dispatcher's auth gate, stored per-row
		// (rather than re-derived from `session_configs.ports_json` on
		// every request) so the dispatcher's hot path is one indexed point
		// read. Pre-existing rows default to 0 (auth required) — the
		// safest fallback for rows written before the column existed.
		version: 6,
		description: "sessions_port_mappings.is_public (#190)",
		apply: () =>
			addColumnIfMissing("sessions_port_mappings", "is_public INTEGER NOT NULL DEFAULT 0"),
	},
	{
		// #190 PR 190a — 0/1 toggle read at spawn to grant
		// CAP_NET_BIND_SERVICE. NULL on pre-existing rows rehydrates to
		// undefined, identical to the post-migration "off" state.
		version: 7,
		description: "session_configs.allow_privileged_ports (#190)",
		apply: () => addColumnIfMissing("session_configs", "allow_privileged_ports INTEGER"),
	},
	{
		// #274 — captures the last bootstrap pipeline output so the user
		// can inspect a failed session after the WS modal closes. Lives on
		// `sessions` (not `session_configs`) because bare-create sessions
		// with no config row still benefit from capturing postCreate
		// output.
		version: 8,
		description: "sessions.bootstrap_log (#274)",
		apply: () => addColumnIfMissing("sessions", "bootstrap_log TEXT"),
	},
	{
		// #277 — when 1, the bootstrap stage materialises a `.env` file in
		// the container workspace from config.envVars. Default NULL = off.
		version: 9,
		description: "session_configs.write_env_file (#277)",
		apply: () => addColumnIfMissing("session_configs", "write_env_file INTEGER"),
	},
	{
		// Auto-promote the earliest-created user when no admin exists yet
		// (#50). Idempotent by construction (the NOT EXISTS guard). On a
		// truly empty users table the inner SELECT is null → no-op, and
		// the bootstrap-register path sets is_admin=1 directly when the
		// first account lands. Behavioural note vs the pre-ledger world:
		// this used to re-run on EVERY boot; as a recorded migration it
		// runs once. The only scenario that loses anything is an operator
		// manually demoting every admin in D1 and expecting a restart to
		// re-promote — which was surprising magic, not a contract.
		version: 10,
		description: "auto-promote earliest user to admin when none exists (#50)",
		apply: async () => {
			await d1Query(
				"UPDATE users SET is_admin = 1 " +
					"WHERE NOT EXISTS (SELECT 1 FROM users WHERE is_admin = 1) " +
					"AND id = (SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1)",
			);
		},
	},
	{
		// #49 — pre-existing `invite_codes` tables with the old plaintext
		// `code` column need a rebuild. Cloudflare D1 has no built-in
		// sha256(), so a non-empty table can't be migrated purely in SQL:
		//   - Empty old shape: drop + recreate inline with the new
		//     (code_hash, code_prefix, …) shape.
		//   - Non-empty old shape: refuse and log recovery steps. This
		//     codebase had no production invites at migration time, so the
		//     loud-fail path is never expected to trip.
		// `PRAGMA table_info` is SELECT-shaped in SQLite; D1 returns its
		// rows under `results`.
		version: 11,
		description: "rebuild empty pre-#49 invite_codes to hashed-at-rest shape",
		apply: async () => {
			const cols = await d1Query<{ name: string }>("PRAGMA table_info(invite_codes)");
			const colNames = new Set(cols.results.map((r) => r.name));
			const isOldShape = colNames.has("code") && !colNames.has("code_hash");
			// Empty PRAGMA = the table doesn't exist AT ALL. Reachable when a
			// prior run of this migration crashed between the DROP and the
			// CREATE below (D1-over-HTTP has no transaction to make them
			// atomic). Pre-ledger, the every-boot baseline replay recreated
			// the table on the next boot; with the ledger, v1 never re-runs,
			// so v11 itself must self-heal or invite_codes stays gone forever
			// and every invite call fails with "no such table" (review
			// round-1 BLOCKER).
			const isMissing = colNames.size === 0;
			if (!isOldShape && !isMissing) return;
			if (isMissing) {
				logger.warn(
					"[db] invite_codes table missing (prior v11 crash between DROP and CREATE?) — recreating",
				);
			} else {
				const rowCount = await d1Query<{ n: number }>("SELECT COUNT(*) AS n FROM invite_codes");
				const n = rowCount.results[0]?.n ?? 0;
				if (n > 0) {
					throw new Error(
						`invite_codes still has the pre-#49 schema with ${n} row(s). ` +
							"Rebuild manually: dump the rows, hash each `code` to SHA-256 hex, " +
							"and re-INSERT into the new (code_hash, code_prefix, …) shape.",
					);
				}
				logger.warn("[db] migrating empty pre-#49 invite_codes table to hashed-at-rest shape");
			}
			await d1Query("DROP TABLE IF EXISTS invite_codes");
			await d1Query(
				`CREATE TABLE invite_codes (
                                code_hash   TEXT PRIMARY KEY,
                                code_prefix TEXT NOT NULL,
                                created_by  TEXT NOT NULL,
                                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                                used_by     TEXT,
                                used_at     TEXT,
                                expires_at  TEXT
                        )`,
			);
			await d1Query(
				"CREATE INDEX IF NOT EXISTS idx_invite_codes_creator ON invite_codes(created_by)",
			);
		},
	},
	{
		// #202 — per-user quota overrides. NULL means "use the deployment
		// default" (MAX_ACTIVE_SESSIONS_PER_USER for the count; the
		// USER_MAX_TOTAL_CPU / USER_MAX_TOTAL_MEM env vars for the
		// budgets, unlimited when those are unset). Units mirror the
		// session_configs columns: nano-CPUs and bytes, so the admin
		// PATCH and the create-time check never unit-convert.
		version: 12,
		description: "per-user quota override columns on users (#202)",
		apply: async () => {
			// PRAGMA-guarded like v11: the three ALTERs are independent D1
			// round-trips with no transaction, so a transient between them
			// leaves the version unrecorded with SOME columns present. An
			// unguarded re-run would then fail forever on "duplicate
			// column" — bricking startup until someone hand-repairs the
			// schema. Skipping the already-present columns makes the
			// re-run converge instead.
			const info = await d1Query<{ name: string }>("PRAGMA table_info(users)");
			const cols = new Set(info.results.map((c) => c.name));
			if (!cols.has("max_sessions")) {
				await d1Query("ALTER TABLE users ADD COLUMN max_sessions INTEGER");
			}
			if (!cols.has("max_total_cpu")) {
				await d1Query("ALTER TABLE users ADD COLUMN max_total_cpu INTEGER");
			}
			if (!cols.has("max_total_mem")) {
				await d1Query("ALTER TABLE users ADD COLUMN max_total_mem INTEGER");
			}
		},
	},
	{
		version: 13,
		description:
			"session_observe_log.mode — distinguish observe from admin-operate (#admin-operate)",
		apply: async () => {
			// The observe-log is now dual-purpose: read-only observation
			// (mode='observe') AND an admin driving someone else's session
			// (mode='operate'). Backfill existing rows to 'observe' — every
			// row written before this migration was a read-only attach.
			// PRAGMA-guarded so a re-run after a transient converges instead
			// of failing forever on duplicate-column (same shape as v12).
			const info = await d1Query<{ name: string }>("PRAGMA table_info(session_observe_log)");
			const cols = new Set(info.results.map((c) => c.name));
			if (!cols.has("mode")) {
				await d1Query(
					"ALTER TABLE session_observe_log ADD COLUMN mode TEXT NOT NULL DEFAULT 'observe'",
				);
			}
		},
	},
	{
		version: 14,
		description: "push_subscriptions — Web Push endpoints per user (#355)",
		apply: async () => {
			// One row per (user, browser endpoint). `endpoint` is UNIQUE so
			// re-subscribing upserts (pushSubscriptions.upsertSubscription).
			// No FK to users: a subscription outliving a user row is harmless
			// (sends just find no user); the DELETE-on-410 prune keeps it
			// clean. CREATE TABLE IF NOT EXISTS is idempotent, so a re-run
			// after a transient is safe.
			await d1Query(
				`CREATE TABLE IF NOT EXISTS push_subscriptions (
					id         TEXT PRIMARY KEY,
					user_id    TEXT NOT NULL,
					endpoint   TEXT NOT NULL UNIQUE,
					p256dh     TEXT NOT NULL,
					auth       TEXT NOT NULL,
					created_at TEXT NOT NULL DEFAULT (datetime('now'))
				)`,
			);
			await d1Query(
				"CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id)",
			);
		},
	},
	{
		// #418 — opaque external reference (e.g. an Agent Hub project
		// binding). Client data, never interpreted by the backend; NULL =
		// unset. No index: the exact-match list filter is a rare
		// reconcile-shaped read over tables that are hundreds of rows at
		// v1 scale, not a hot path. addColumnIfMissing's swallowed
		// duplicate-column error makes a re-run after a transient converge.
		version: 15,
		description: "sessions.external_ref — opaque client metadata (#418)",
		apply: () => addColumnIfMissing("sessions", "external_ref TEXT"),
	},
	{
		// Phase 3 (docs/CONVERSATION.md §3.3, §2.4) — conversation metadata
		// and the per-session capture columns. `claude_conversations` holds
		// what the list endpoint and a cold backend need; the events file
		// on the host is the source of truth and is never mirrored here.
		// The three `sessions` columns carry the REQUESTED capture state
		// and the ingest token hash (plus the suspended copy a hot
		// disable keeps so a re-enable without restart can restore it).
		// All statements idempotent (IF NOT EXISTS / addColumnIfMissing) so
		// a crash between apply() and the ledger INSERT converges.
		version: 16,
		description: "claude_conversations + sessions capture columns (Phase 3 / 3.0b)",
		apply: async () => {
			await d1Query(
				`CREATE TABLE IF NOT EXISTS claude_conversations (
					session_id        TEXT PRIMARY KEY,
					st_session_id     TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
					kind              TEXT NOT NULL,
					parent_session_id TEXT,
					parent_inferred   INTEGER NOT NULL DEFAULT 0,
					title             TEXT,
					tab_id            TEXT,
					pane_id           TEXT,
					status            TEXT NOT NULL,
					status_evidence   TEXT NOT NULL,
					status_at         TEXT NOT NULL,
					started_at        TEXT NOT NULL,
					ended_at          TEXT,
					end_reason        TEXT,
					last_event_at     TEXT NOT NULL,
					last_prompt_id    TEXT,
					last_seq          INTEGER NOT NULL DEFAULT 0,
					claude_version    TEXT,
					events_bytes      INTEGER NOT NULL DEFAULT 0,
					events_count      INTEGER NOT NULL DEFAULT 0,
					gaps_count        INTEGER NOT NULL DEFAULT 0
				)`,
			);
			await d1Query(
				"CREATE INDEX IF NOT EXISTS idx_claude_conv_st ON claude_conversations(st_session_id, last_event_at)",
			);
			await addColumnIfMissing("sessions", "ingest_token_hash TEXT");
			await addColumnIfMissing("sessions", "ingest_token_hash_suspended TEXT");
			await addColumnIfMissing("sessions", "conversation_requested INTEGER NOT NULL DEFAULT 0");
		},
	},
	{
		// 3.0d audit A1: every revocation (API disable, emergency CLI, `--all`)
		// increments it in the same statement, and `PATCH {enabled:true}`
		// writes D1 only if it is still the value it read at its start — so
		// a revocation that lands while an enable is in flight is never
		// overwritten, across processes, without a lock.
		version: 17,
		description: "sessions.revocation_seq — revocations vs a concurrent enable (3.0d)",
		apply: () => addColumnIfMissing("sessions", "revocation_seq INTEGER NOT NULL DEFAULT 0"),
	},
	{
		// CONVERSATION.md §6.2 (v1.8): the owner's custom title and archive
		// flag. A table of its own, never columns on claude_conversations:
		// the capture upserts those rows (creation, heartbeat, releases) and
		// must not be able to touch — or race — what the owner wrote. Keyed
		// per ST session, so a CLI `--resume` (same cid) keeps it and a
		// recreation of the container does not matter.
		version: 18,
		description: "conversation_user_meta — owner rename/archive (contract v1.8 §6.2)",
		apply: async () => {
			await d1Query(
				`CREATE TABLE IF NOT EXISTS conversation_user_meta (
					st_session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
					cid           TEXT NOT NULL,
					custom_title  TEXT,
					archived_at   TEXT,
					updated_at    TEXT NOT NULL,
					PRIMARY KEY (st_session_id, cid)
				)`,
			);
		},
	},
	{
		// P3a — project & agent directory (docs/PROJECTS.md). Additive: four
		// new tables, two triggers, no existing column touched, so an older
		// backend that later boots on this schema just ignores it.
		version: 19,
		description: "projects, project_agents, agent_bindings (P3a directory)",
		apply: async () => {
			for (const sql of PROJECT_DIRECTORY_DDL) await d1Query(sql);
		},
	},
	{
		// CONVERSATION.md §2.7.4 (v1.9.4, #627): the recreation's commit fence.
		// The step-4 CAS and the rollback's `casBack` apply only while the row
		// still carries the generation the attempt recorded BEFORE sending
		// them, and bump it when they apply. A recovery that must decide
		// "D1 is still on O, so N can go" first bumps the generation in its
		// own statement: from then on a statement the dead process left in
		// flight can no longer land, so removing N can never leave D1
		// pointing at a removed container. Additive, default 0: an older
		// backend never reads or writes it (its CAS ignores the fence — the
		// reason a record it wrote stays blocked, §2.7.7).
		version: 20,
		description: "sessions.recreate_fence — recreation commit fence (contract v1.9.4, #627)",
		apply: () => addColumnIfMissing("sessions", "recreate_fence INTEGER NOT NULL DEFAULT 0"),
	},
	{
		// Additive: two new tables, no existing column touched.
		version: 21,
		description: "acp_agents + agent_messages — ACP agents and their durable inbox (experimental)",
		apply: () => d1Batch([...ACP_AGENTS_DDL]),
	},
	{
		// Additive like v21: columns NULL/0 on existing rows mean exactly what
		// v21 did (no project, a person's message, no idempotency key).
		version: 22,
		description: "ACP agents in projects — message scope, hop depth, client ids; agent questions",
		apply: async () => {
			await addColumnIfMissing("acp_agents", "project_id TEXT");
			await addColumnIfMissing("agent_messages", "project_id TEXT");
			await addColumnIfMissing("agent_messages", "depth INTEGER NOT NULL DEFAULT 0");
			await addColumnIfMissing("agent_messages", "client_id TEXT");
			await d1Batch([...ACP_PROJECTS_DDL]);
		},
	},
	{
		// Additive: NULL on existing rows = "default" (the CLI decides), which
		// is what every agent ran before the column existed.
		version: 23,
		description: "acp_agents.effort — per-agent reasoning effort (applied by the runner)",
		apply: () => addColumnIfMissing("acp_agents", "effort TEXT"),
	},
	{
		// Additive: NULL context = the default one (the workspace checkout, the
		// only one there was), max_concurrency 1 = one slot (what every agent ran).
		// A message running across the upgrade was taken by the only runner there
		// was: slot 1, so that runner's restart judges it as its own.
		version: 24,
		description: "ACP slots — execution context per message, the slot that took it, per-agent cap",
		apply: async () => {
			await addColumnIfMissing("acp_agents", "max_concurrency INTEGER NOT NULL DEFAULT 1");
			await addColumnIfMissing("agent_messages", "context TEXT");
			await addColumnIfMissing("agent_messages", "from_context TEXT");
			await addColumnIfMissing("agent_messages", "slot INTEGER");
			await d1Batch([...ACP_SLOTS_DDL]);
		},
	},
	{
		// Additive: NULL root_id = the message is its own root (every row before
		// it was a chain of its own for the new budget, which only counts rows
		// that carry a root).
		version: 25,
		description:
			"ACP chains — root message of an agent chain; a reply returns to the asker's depth",
		apply: async () => {
			await addColumnIfMissing("agent_messages", "root_id INTEGER");
			await d1Batch([...ACP_CHAIN_DDL]);
		},
	},
	{
		version: 26,
		description: "agent_works — a named execution context is a work: worktree, branch, ports",
		apply: () => d1Batch([...ACP_WORKS_DDL]),
	},
	{
		// Additive: NULL conversation_id = what every message was before (the
		// Archive: direct chats and the old Project Chat), team 0, not reviewed.
		version: 27,
		description: "ACP conversations — topics per project; a message's conversation, team, review",
		apply: async () => {
			await addColumnIfMissing("agent_messages", "conversation_id TEXT");
			await addColumnIfMissing("agent_messages", "team INTEGER NOT NULL DEFAULT 0");
			await addColumnIfMissing("agent_messages", "reviewed_at TEXT");
			await addColumnIfMissing("agent_messages", "recovery_of INTEGER");
			await addColumnIfMissing("agent_works", "conversation_id TEXT");
			await d1Batch([...ACP_CONVERSATIONS_DDL]);
		},
	},
	{
		version: 28,
		description:
			"ACP read indexes — unread, needs-action and open questions without the owner's history",
		apply: () => d1Batch([...ACP_READ_INDEXES_DDL]),
	},
];

/**
 * v28. Indexes only (D1 bills rows READ, and the hot reads walked whole
 * histories). Each serves a read that runs on every change of a message:
 *
 * - `(owner, conversation, created_at)` / `(owner, conversation, finished_at)`:
 *   a topic's unread count (conversations.ts `UNREAD`) is two counts, each a
 *   range after `read_at` — a topic already read reads ≈ 0 rows instead of
 *   all of its messages. The second one also drives the inbox's results.
 * - the partial `uncertain` index: `needsAction`'s first EXISTS and the
 *   inbox's interrupted runs read only runs nobody reviewed yet.
 * - `agent_questions(owner, state)`: the open questions (`/agents`, inbox,
 *   `needsAction`) without every question the owner ever got.
 */
export const ACP_READ_INDEXES_DDL: readonly string[] = [
	"CREATE INDEX IF NOT EXISTS idx_agent_messages_conv_created ON agent_messages(owner_user_id, conversation_id, created_at)",
	"CREATE INDEX IF NOT EXISTS idx_agent_messages_conv_finished ON agent_messages(owner_user_id, conversation_id, finished_at)",
	`CREATE INDEX IF NOT EXISTS idx_agent_messages_unreviewed ON agent_messages(owner_user_id, conversation_id)
		WHERE state = 'uncertain' AND reviewed_at IS NULL`,
	"CREATE INDEX IF NOT EXISTS idx_agent_questions_state ON agent_questions(owner_user_id, state)",
];

/**
 * v27. A CONVERSATION is a topic of a project (acp/conversations.ts): the
 * person's messages are posted in one, and everything they set off — the
 * agents' consults, the replies, the notices of an unfinished request, the
 * questions to the person (through their message) and the recovery report
 * after an interrupted run — stays in it. `agent_messages.conversation_id`
 * NULL = the Archive (direct chats and the old Project Chat), read-only.
 *
 * - The reply trigger copies the request's conversation, as it copies its scope.
 * - `last_activity_at` is moved by triggers on every row written in the
 *   conversation and every terminal state, so no write path can forget it.
 * - `read_at`: the newest thing the person has seen in it (an ISO time, see
 *   conversations.ts for why a time and not a message id); it only advances.
 * - `recipients`: the recipients of the person's last post in it (JSON
 *   `{"agents":[…]}` or `{"team":true}`), shown again as the next post's.
 * - `team` on a message: it was sent to "the whole team", resolved at send
 *   into one row per agent of the project.
 * - `reviewed_at`: the person reviewed an `uncertain` run and chose NOT to
 *   requeue it (a requeue clears it). `recovery_of`: on the runner's system
 *   message after a restart, the interrupted message it reports on.
 */
export const ACP_CONVERSATIONS_DDL: readonly string[] = [
	`CREATE TABLE IF NOT EXISTS conversations (
		id                TEXT PRIMARY KEY,
		owner_user_id     TEXT NOT NULL REFERENCES users(id),
		project_id        TEXT NOT NULL REFERENCES projects(project_id),
		title             TEXT NOT NULL,
		client_request_id TEXT NOT NULL,
		request_hash      TEXT NOT NULL,
		created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		last_activity_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		archived_at       TEXT,
		read_at           TEXT,
		recipients        TEXT,
		UNIQUE (owner_user_id, client_request_id)
	)`,
	"CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(owner_user_id, project_id, last_activity_at)",
	"CREATE INDEX IF NOT EXISTS idx_agent_messages_conversation ON agent_messages(owner_user_id, conversation_id, id)",
	"CREATE INDEX IF NOT EXISTS idx_agent_messages_recovery ON agent_messages(owner_user_id, recovery_of)",
	`CREATE TRIGGER IF NOT EXISTS trg_conversation_activity_insert
	AFTER INSERT ON agent_messages WHEN NEW.conversation_id IS NOT NULL
	BEGIN
		UPDATE conversations SET last_activity_at = MAX(last_activity_at, NEW.created_at)
		WHERE id = NEW.conversation_id AND owner_user_id = NEW.owner_user_id;
	END`,
	`CREATE TRIGGER IF NOT EXISTS trg_conversation_activity_state
	AFTER UPDATE OF state ON agent_messages
	WHEN NEW.conversation_id IS NOT NULL AND OLD.state != NEW.state AND NEW.state IN ('done', 'failed', 'uncertain')
	BEGIN
		UPDATE conversations SET last_activity_at = MAX(last_activity_at, COALESCE(NEW.finished_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
		WHERE id = NEW.conversation_id AND owner_user_id = NEW.owner_user_id;
	END`,
	"DROP TRIGGER IF EXISTS trg_agent_message_reply",
	`CREATE TRIGGER IF NOT EXISTS trg_agent_message_reply
	AFTER UPDATE OF state ON agent_messages
	WHEN OLD.state = 'running' AND NEW.state = 'done' AND NEW.kind = 'request'
		AND EXISTS (SELECT 1 FROM acp_agents WHERE owner_user_id = NEW.owner_user_id AND name = NEW.from_id)
	BEGIN
		INSERT INTO agent_messages (owner_user_id, from_id, to_id, kind, reply_to, body, state, project_id, depth, context, root_id, conversation_id)
		VALUES (NEW.owner_user_id, NEW.to_id, NEW.from_id, 'reply', NEW.id,
			'Respuesta de @' || NEW.to_id || ' a tu mensaje #' || NEW.id || ':' || char(10) || char(10) || COALESCE(NEW.result_text, '(sin texto)'),
			'pending', NEW.project_id, MAX(NEW.depth - 1, 0), NEW.from_context, NEW.root_id, NEW.conversation_id);
	END`,
];

/**
 * v25. Depth measures NESTING only: a request an agent sends while working on
 * a message of depth d has depth d + 1, and the reply brings the asker back to
 * d (request.depth − 1) — so rounds of consult and answer between two agents
 * never pile up depth, while a chain where each consult starts another still
 * stops at ACP_MAX_DEPTH.
 *
 * `root_id` is the person's message a chain started from (copied to every
 * request and reply of the chain; NULL on the root itself and on system
 * messages). It bounds the ROUNDS: past ACP_MAX_CHAIN agent requests under one
 * root, an agent's send is refused (acp/agents.ts). A new message from the
 * person is a new root.
 */
/**
 * v26. A named execution context exists only as a WORK (acp/works.ts): the
 * backend creates its git worktree `.st/ctx/<id>` on branch `work/<id>` in the
 * agent's container before its first message. Rows are never deleted — an id
 * is never reused, not even after `cleaned`, so no old ACP session of that
 * context (`.st/acp/ctx/<id>.json`) is ever picked up again. `port_base`: the
 * work's 100 ports (20000 + 100·k), unique among the agent's works that are
 * not `cleaned` (the partial index is what makes the allocation atomic).
 */
export const ACP_WORKS_DDL: readonly string[] = [
	`CREATE TABLE IF NOT EXISTS agent_works (
		owner_user_id TEXT NOT NULL REFERENCES users(id),
		id            TEXT NOT NULL,
		agent_id      TEXT NOT NULL REFERENCES acp_agents(agent_id) ON DELETE CASCADE,
		project_id    TEXT,
		branch        TEXT NOT NULL,
		base_sha      TEXT,
		port_base     INTEGER NOT NULL,
		state         TEXT NOT NULL CHECK (state IN ('creating', 'active', 'closed', 'cleanup-pending', 'cleaned')),
		note          TEXT,
		created_by    TEXT NOT NULL,
		created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		closed_at     TEXT,
		cleaned_at    TEXT,
		PRIMARY KEY (owner_user_id, id)
	)`,
	"CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_works_port ON agent_works(agent_id, port_base) WHERE state != 'cleaned'",
];

export const ACP_CHAIN_DDL: readonly string[] = [
	"CREATE INDEX IF NOT EXISTS idx_agent_messages_root ON agent_messages(owner_user_id, root_id)",
	"DROP TRIGGER IF EXISTS trg_agent_message_reply",
	`CREATE TRIGGER IF NOT EXISTS trg_agent_message_reply
	AFTER UPDATE OF state ON agent_messages
	WHEN OLD.state = 'running' AND NEW.state = 'done' AND NEW.kind = 'request'
		AND EXISTS (SELECT 1 FROM acp_agents WHERE owner_user_id = NEW.owner_user_id AND name = NEW.from_id)
	BEGIN
		INSERT INTO agent_messages (owner_user_id, from_id, to_id, kind, reply_to, body, state, project_id, depth, context, root_id)
		VALUES (NEW.owner_user_id, NEW.to_id, NEW.from_id, 'reply', NEW.id,
			'Respuesta de @' || NEW.to_id || ' a tu mensaje #' || NEW.id || ':' || char(10) || char(10) || COALESCE(NEW.result_text, '(sin texto)'),
			'pending', NEW.project_id, MAX(NEW.depth - 1, 0), NEW.from_context, NEW.root_id);
	END`,
];

/**
 * v24. An agent runs up to `max_concurrency` messages at once, one per SLOT
 * (a copy of the runner loop with its own adapter). A message's `context`
 * says where it runs: NULL = the default context (the workspace checkout, the
 * agent's ACP session of always, slot 1 only); a name = its own directory
 * `.st/ctx/<name>/` and its own ACP session (slots ≥ 2). The claim keeps one
 * running message per (agent, context), so two runs never share a checkout.
 *
 * `from_context` is the context an agent's request was sent FROM (taken from
 * its credential, never from the body): the reply goes back there, so the
 * continuation lands in the ACP session that asked. The recipient gets the
 * request in its default context.
 */
export const ACP_SLOTS_DDL: readonly string[] = [
	"UPDATE agent_messages SET slot = 1 WHERE state = 'running' AND slot IS NULL",
	"CREATE INDEX IF NOT EXISTS idx_agent_messages_running ON agent_messages(state, owner_user_id, to_id)",
	"DROP TRIGGER IF EXISTS trg_agent_message_reply",
	`CREATE TRIGGER IF NOT EXISTS trg_agent_message_reply
	AFTER UPDATE OF state ON agent_messages
	WHEN OLD.state = 'running' AND NEW.state = 'done' AND NEW.kind = 'request'
		AND EXISTS (SELECT 1 FROM acp_agents WHERE owner_user_id = NEW.owner_user_id AND name = NEW.from_id)
	BEGIN
		INSERT INTO agent_messages (owner_user_id, from_id, to_id, kind, reply_to, body, state, project_id, depth, context)
		VALUES (NEW.owner_user_id, NEW.to_id, NEW.from_id, 'reply', NEW.id,
			'Respuesta de @' || NEW.to_id || ' a tu mensaje #' || NEW.id || ':' || char(10) || char(10) || COALESCE(NEW.result_text, '(sin texto)'),
			'pending', NEW.project_id, NEW.depth, NEW.from_context);
	END`,
];

/**
 * v22. A message's `project_id` is its SCOPE, not a property of its agents:
 * NULL = a direct message (shown only in the individual chats of its two
 * ends), set = posted in that project's Project Chat. The reply the trigger
 * writes keeps the request's scope and depth, so an agent ↔ agent exchange
 * started from Project Chat stays in Project Chat, and one started in a
 * direct chat stays private.
 *
 * `depth` is the loop guard: a person's message is 0, a request an agent
 * sends while working on message M is M.depth + 1 (acp/agents.ts refuses past
 * the cap), and a reply never produces a reply — that is what ends a chain.
 *
 * `client_id` makes a send idempotent per recipient: Project Chat sends one
 * row per mentioned agent under one id, and a retried POST finds its row.
 */
export const ACP_PROJECTS_DDL: readonly string[] = [
	"CREATE INDEX IF NOT EXISTS idx_agent_messages_project ON agent_messages(owner_user_id, project_id, id)",
	"CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_client ON agent_messages(owner_user_id, client_id, to_id) WHERE client_id IS NOT NULL",
	"CREATE INDEX IF NOT EXISTS idx_acp_agents_project ON acp_agents(owner_user_id, project_id)",
	// A question an agent asks while working on a message (ACP `elicitation/create`,
	// e.g. Claude's AskUserQuestion). `request` is the form as the adapter sent it;
	// only the person answers (`answered`, one conditional UPDATE: a second answer
	// finds nothing open). `delivered` = the runner handed it to the waiting ACP
	// request. A runner restart loses that request: whatever was open or answered
	// but not delivered becomes `orphaned` — never treated as answered.
	`CREATE TABLE IF NOT EXISTS agent_questions (
		id            INTEGER PRIMARY KEY AUTOINCREMENT,
		owner_user_id TEXT NOT NULL,
		agent         TEXT NOT NULL,
		message_id    INTEGER,
		request       TEXT NOT NULL,
		state         TEXT NOT NULL CHECK (state IN ('open', 'answered', 'delivered', 'withdrawn', 'orphaned')),
		answer        TEXT,
		created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		answered_at   TEXT,
		delivered_at  TEXT,
		note          TEXT
	)`,
	"CREATE INDEX IF NOT EXISTS idx_agent_questions_agent ON agent_questions(owner_user_id, agent, state)",
	"CREATE INDEX IF NOT EXISTS idx_agent_questions_message ON agent_questions(owner_user_id, message_id)",
	"DROP TRIGGER IF EXISTS trg_agent_message_reply",
	`CREATE TRIGGER IF NOT EXISTS trg_agent_message_reply
	AFTER UPDATE OF state ON agent_messages
	WHEN OLD.state = 'running' AND NEW.state = 'done' AND NEW.kind = 'request'
		AND EXISTS (SELECT 1 FROM acp_agents WHERE owner_user_id = NEW.owner_user_id AND name = NEW.from_id)
	BEGIN
		INSERT INTO agent_messages (owner_user_id, from_id, to_id, kind, reply_to, body, state, project_id, depth)
		VALUES (NEW.owner_user_id, NEW.to_id, NEW.from_id, 'reply', NEW.id,
			'Respuesta de @' || NEW.to_id || ' a tu mensaje #' || NEW.id || ':' || char(10) || char(10) || COALESCE(NEW.result_text, '(sin texto)'),
			'pending', NEW.project_id, NEW.depth);
	END`,
];

/**
 * v21. `agent_messages` is the ONE store of agent messages — person → agent
 * and agent → agent alike; the chat and (later) Project Chat read it.
 *
 * - The reply to an agent's request is written by a trigger in the same
 *   statement that records the request's result: D1 over HTTP has no
 *   transaction across calls, and a death between two calls would leave a
 *   finished request whose sender never hears back.
 * - "One running message per agent" is the claim statement's own guard
 *   (acp/agents.ts), not a pre-check.
 * - `acp_agents.session_id` cascades: the agent row is the session's
 *   configuration, it goes with a hard delete. Messages carry names, not
 *   FKs, so their history survives.
 */
export const ACP_AGENTS_DDL: readonly string[] = [
	`CREATE TABLE IF NOT EXISTS acp_agents (
		agent_id      TEXT PRIMARY KEY,
		session_id    TEXT NOT NULL UNIQUE REFERENCES sessions(session_id) ON DELETE CASCADE,
		owner_user_id TEXT NOT NULL REFERENCES users(id),
		name          TEXT NOT NULL,
		runtime       TEXT NOT NULL,
		model         TEXT,
		created_at    TEXT NOT NULL DEFAULT (datetime('now')),
		UNIQUE (owner_user_id, name)
	)`,
	`CREATE TABLE IF NOT EXISTS agent_messages (
		id            INTEGER PRIMARY KEY AUTOINCREMENT,
		owner_user_id TEXT NOT NULL,
		from_id       TEXT NOT NULL,
		to_id         TEXT NOT NULL,
		kind          TEXT NOT NULL CHECK (kind IN ('request', 'reply')),
		reply_to      INTEGER,
		body          TEXT NOT NULL,
		state         TEXT NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed', 'uncertain')),
		attempts      INTEGER NOT NULL DEFAULT 0,
		created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		started_at    TEXT,
		finished_at   TEXT,
		result_text   TEXT,
		stop_reason   TEXT,
		note          TEXT
	)`,
	"CREATE INDEX IF NOT EXISTS idx_agent_messages_inbox ON agent_messages(owner_user_id, to_id, state, id)",
	"CREATE INDEX IF NOT EXISTS idx_agent_messages_from ON agent_messages(owner_user_id, from_id, id)",
	`CREATE TRIGGER IF NOT EXISTS trg_agent_message_reply
	AFTER UPDATE OF state ON agent_messages
	WHEN OLD.state = 'running' AND NEW.state = 'done' AND NEW.kind = 'request'
		AND EXISTS (SELECT 1 FROM acp_agents WHERE owner_user_id = NEW.owner_user_id AND name = NEW.from_id)
	BEGIN
		INSERT INTO agent_messages (owner_user_id, from_id, to_id, kind, reply_to, body, state)
		VALUES (NEW.owner_user_id, NEW.to_id, NEW.from_id, 'reply', NEW.id,
			'Respuesta de @' || NEW.to_id || ' a tu mensaje #' || NEW.id || ':' || char(10) || char(10) || COALESCE(NEW.result_text, '(sin texto)'),
			'pending');
	END`,
];

/**
 * v19's statements, in order; each is idempotent (IF NOT EXISTS) so a crash
 * between two of them, or between apply() and the ledger INSERT, converges
 * on the next boot. Exported for the migration tests.
 *
 * Load-bearing choices (PROJECTS.md §2):
 *
 * - `agent_bindings.st_session_id` has NO foreign key to `sessions`. D1
 *   enforces foreign keys, so a reference would make every hard delete of a
 *   session that was ever bound fail (history is never deleted), and
 *   `ON DELETE CASCADE` would erase the history the agent page shows. The
 *   live-binding guard on hard delete lives in the routes instead.
 *
 * - D1 over HTTP has no transaction across calls, so an agent and its first
 *   binding are created by ONE statement: the INSERT into
 *   `project_agent_creations` (the durable idempotency record of the
 *   request) fires `trg_project_agent_creation`, which checks the
 *   preconditions and inserts the agent and the binding. SQLite runs a
 *   trigger inside its statement: any failure (a RAISE, the handle UNIQUE,
 *   the live-session index) rolls back the record, the agent and the
 *   binding together. There is no state "agent without its binding".
 *   The trigger's WHEN skips an agent that already exists, so a restore
 *   (which replays the agents and bindings before this table) inserts the
 *   records without re-running the creation.
 *
 * - Removing an agent is likewise one statement: the UPDATE that sets
 *   `removed_at` fires `trg_project_agent_removed`, which retires its live
 *   binding in the same statement.
 *
 * - The two partial unique indexes ARE the MVP rule "one live binding per
 *   agent and per session" (AD2): two concurrent creations on one session
 *   cannot both commit, whatever the application checked before.
 */
export const PROJECT_DIRECTORY_DDL: readonly string[] = [
	`CREATE TABLE IF NOT EXISTS projects (
		project_id        TEXT PRIMARY KEY,
		owner_user_id     TEXT NOT NULL REFERENCES users(id),
		name              TEXT NOT NULL,
		client_request_id TEXT NOT NULL,
		request_hash      TEXT NOT NULL,
		created_at        TEXT NOT NULL DEFAULT (datetime('now')),
		archived_at       TEXT
	)`,
	"CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_request ON projects(owner_user_id, client_request_id)",
	`CREATE TABLE IF NOT EXISTS project_agents (
		agent_id         TEXT PRIMARY KEY,
		project_id       TEXT NOT NULL REFERENCES projects(project_id),
		handle           TEXT NOT NULL,
		provider         TEXT NOT NULL DEFAULT 'claude-code' CHECK (provider IN ('claude-code')),
		role             TEXT,
		template_id      TEXT,
		template_version INTEGER,
		created_at       TEXT NOT NULL DEFAULT (datetime('now')),
		removed_at       TEXT,
		UNIQUE (project_id, handle)
	)`,
	`CREATE TABLE IF NOT EXISTS agent_bindings (
		binding_id    TEXT PRIMARY KEY,
		agent_id      TEXT NOT NULL REFERENCES project_agents(agent_id),
		epoch         INTEGER NOT NULL,
		st_session_id TEXT NOT NULL,
		state         TEXT NOT NULL CHECK (state IN ('active','draining','retired')),
		created_at    TEXT NOT NULL DEFAULT (datetime('now')),
		retired_at    TEXT,
		retire_reason TEXT,
		UNIQUE (agent_id, epoch)
	)`,
	"CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_bindings_live_agent ON agent_bindings(agent_id) WHERE state IN ('active','draining')",
	"CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_bindings_live_session ON agent_bindings(st_session_id) WHERE state IN ('active','draining')",
	`CREATE TABLE IF NOT EXISTS project_agent_creations (
		owner_user_id     TEXT NOT NULL,
		client_request_id TEXT NOT NULL,
		request_hash      TEXT NOT NULL,
		project_id        TEXT NOT NULL,
		agent_id          TEXT NOT NULL,
		binding_id        TEXT NOT NULL,
		st_session_id     TEXT NOT NULL,
		handle            TEXT NOT NULL,
		role              TEXT,
		created_at        TEXT NOT NULL DEFAULT (datetime('now')),
		PRIMARY KEY (owner_user_id, client_request_id)
	)`,
	// The limit (32 live agents per project) is MAX_AGENTS_PER_PROJECT in
	// projects/directory.ts; a change there needs a new migration that
	// re-creates this trigger.
	`CREATE TRIGGER IF NOT EXISTS trg_project_agent_creation
	AFTER INSERT ON project_agent_creations
	WHEN NOT EXISTS (SELECT 1 FROM project_agents WHERE agent_id = NEW.agent_id)
	BEGIN
		SELECT RAISE(ABORT, 'st:project-not-found') WHERE NOT EXISTS (
			SELECT 1 FROM projects
			WHERE project_id = NEW.project_id AND owner_user_id = NEW.owner_user_id AND archived_at IS NULL
		);
		SELECT RAISE(ABORT, 'st:session-not-found') WHERE NOT EXISTS (
			SELECT 1 FROM sessions
			WHERE session_id = NEW.st_session_id AND user_id = NEW.owner_user_id AND status != 'terminated'
		);
		SELECT RAISE(ABORT, 'st:agent-limit') WHERE (
			SELECT COUNT(*) FROM project_agents WHERE project_id = NEW.project_id AND removed_at IS NULL
		) >= 32;
		INSERT INTO project_agents (agent_id, project_id, handle, role, created_at)
		VALUES (NEW.agent_id, NEW.project_id, NEW.handle, NEW.role, NEW.created_at);
		INSERT INTO agent_bindings (binding_id, agent_id, epoch, st_session_id, state, created_at)
		VALUES (NEW.binding_id, NEW.agent_id, 1, NEW.st_session_id, 'active', NEW.created_at);
	END`,
	`CREATE TRIGGER IF NOT EXISTS trg_project_agent_removed
	AFTER UPDATE OF removed_at ON project_agents
	WHEN OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL
	BEGIN
		UPDATE agent_bindings SET state = 'retired', retired_at = NEW.removed_at, retire_reason = 'agent-removed'
		WHERE agent_id = NEW.agent_id AND state IN ('active','draining');
	END`,
];

/**
 * Apply every migration not yet recorded in `schema_migrations`.
 * Call once on server startup. Steady-state cost is two D1 round-trips
 * (the ledger CREATE IF NOT EXISTS + one SELECT) — down from ~30
 * replayed statements per boot pre-#349.
 */
export async function migrateDb(): Promise<void> {
	logger.info("[db] running D1 migrations…");
	// The ledger itself is the one statement that still replays every
	// boot — IF NOT EXISTS makes it a cheap no-op after the first.
	await d1Query(
		`CREATE TABLE IF NOT EXISTS schema_migrations (
                        version     INTEGER PRIMARY KEY,
                        description TEXT NOT NULL,
                        applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
                )`,
	);
	const appliedRows = await d1Query<{ version: number }>("SELECT version FROM schema_migrations");
	const applied = new Set(appliedRows.results.map((r) => r.version));
	let ran = 0;
	for (const m of MIGRATIONS) {
		if (applied.has(m.version)) continue;
		logger.info(`[db] applying migration ${m.version}: ${m.description}`);
		await m.apply();
		// INSERT OR IGNORE, not plain INSERT: two overlapping boots (rolling
		// restart, `npm run db:migrate` racing the server, tsx-watch double
		// start) both read the same ledger snapshot and both apply the
		// pending set — harmless for the migrations themselves (idempotent,
		// see rules above), but the second ledger write would hit the
		// PRIMARY KEY and crash that process's startup. OR IGNORE turns the
		// loser's write into a no-op (review round-1 SHOULD-FIX).
		await d1Query("INSERT OR IGNORE INTO schema_migrations (version, description) VALUES (?, ?)", [
			m.version,
			m.description,
		]);
		ran++;
	}
	logger.info(
		ran > 0
			? `[db] migrations complete (${ran} applied)`
			: "[db] migrations complete (schema up to date)",
	);
}

/** Validate that D1 credentials are configured. */
export function validateD1Config(): void {
	if (!ACCOUNT_ID || !API_TOKEN || !DATABASE_ID) {
		throw new Error(
			"Missing Cloudflare D1 config. Set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, and D1_DATABASE_ID env vars.",
		);
	}
}
