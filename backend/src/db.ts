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

import { logger } from "./logger.js";

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? "";
const DATABASE_ID = process.env.D1_DATABASE_ID ?? "";

interface D1QueryResult<T = Record<string, unknown>> {
	results: T[];
	success: boolean;
	meta: { changes: number; duration: number; last_row_id: number };
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
export async function d1Query<T = Record<string, unknown>>(
	sql: string,
	params?: unknown[],
): Promise<D1QueryResult<T>> {
	d1CallsSinceBoot++;
	const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;

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
		throw new Error(`D1 query failed: ${data.errors.map((e) => e.message).join(", ")}`);
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
