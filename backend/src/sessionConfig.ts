/**
 * sessionConfig.ts — typed session configuration: Zod schema + D1 persistence.
 *
 * Foundation for the session-creation overhaul tracked under epic #184.
 * Each child issue (#186 env vars/secrets, #188 repo clone, #190 ports,
 * #191 lifecycle hooks, #194 resource caps, #195 templates) plugs into
 * the shape defined here:
 *
 *   - the Zod `SessionConfigSchema` is the single source of truth for
 *     what `POST /api/sessions` accepts under `body.config`;
 *   - the `session_configs` D1 table is 1:1 with `sessions.session_id`
 *     and stores the validated payload alongside `bootstrapped_at`
 *     (gating one-shot postCreate hooks — wired up in PR 185b).
 *
 * Field validation is deliberately MINIMAL in this PR — children harden
 * their respective fields when they wire the actual feature. Today every
 * sub-field is optional and a bare `POST /sessions` with no `config`
 * keeps working exactly as before.
 */

import { z } from "zod";
import { d1Query } from "./db.js";
import { EnvVarValidationError, validateEnvVars } from "./envVarValidation.js";
import { logger } from "./logger.js";

// ── Bounds (shape-level only; children tighten) ─────────────────────────────

// Hook command bodies. Generous enough for a multi-line shell script
// (postCreate / postStart) without becoming a vector for ballooning the
// session_configs row. #191 is free to lower this when the form lands.
const MAX_HOOK_LEN = 8 * 1024;
// Absolute upper bounds on resource caps — only here to refuse obviously-
// bogus input (negative, NaN, TB-class memory). #194 introduces the real
// per-deployment bounds tied to operator config.
const MAX_CPU_NANO = 64_000_000_000; // 64 vCPU equivalent
const MAX_MEM_BYTES = 1024 * 1024 * 1024 * 1024; // 1 TiB
const MAX_IDLE_TTL_S = 30 * 24 * 60 * 60; // 30 days
// Cap repeating sub-records so a single create can't write a multi-MB
// JSON blob into D1. Children may lower these when their forms cap by
// product UX.
const MAX_REPOS = 10;
const MAX_PORTS = 20;

// ── Zod schemas ─────────────────────────────────────────────────────────────

// Minimal placeholder for #188. Just shape today: the URL / ref pair.
// Auth method, replace-workspace flag, etc. land with the repo-clone child.
//
// URL scheme allowlist is enforced at INGEST so a stored value can never
// reach the #188 git-clone consumer with a `file://` (clone from arbitrary
// host paths including the bind-mounted workspace) or `ssh://attacker/`
// (SSRF / host-key confusion) URL. The schema is the right enforcement
// point — once a row is in D1, the child issue has no obvious place to
// re-validate without a duplicate codebase. `git+...` variants stay out
// pending a real reason to need them.
const REPO_URL_SCHEME = /^(?:https?|git):\/\//;
const RepoSpec = z
	.object({
		url: z
			.string()
			.min(1)
			.max(500)
			.refine((u) => REPO_URL_SCHEME.test(u), {
				message: "url must use https://, http://, or git:// scheme",
			}),
		ref: z.string().max(200).optional(),
	})
	.strict();

// Minimal placeholder for #190. Topology (subdomain vs path, auth gate)
// lands with the port-exposure child.
const PortSpec = z
	.object({
		port: z.number().int().min(1).max(65535),
		protocol: z.enum(["http", "tcp"]).optional(),
	})
	.strict();

/**
 * The shape `POST /api/sessions` accepts under `body.config`. Every field
 * is optional — bare POSTs (no `config`) stay valid. `.strict()` rejects
 * unknown keys so client-side typos surface as a 400 instead of being
 * silently dropped during the round-trip.
 */
export const SessionConfigSchema = z
	.object({
		// #188 — populated by the repo-clone form
		workspaceStrategy: z.enum(["preserve", "clone"]).optional(),
		repos: z.array(RepoSpec).max(MAX_REPOS).optional(),
		// #194 — populated by the resources form
		cpuLimit: z.number().int().positive().max(MAX_CPU_NANO).optional(),
		memLimit: z.number().int().positive().max(MAX_MEM_BYTES).optional(),
		idleTtlSeconds: z.number().int().positive().max(MAX_IDLE_TTL_S).optional(),
		// #191 — populated by the hooks form. `.min(1)` so a stored
		// empty string can never be confused with "no hook configured":
		// the bootstrap runner in PR 185b can use `post_create_cmd IS
		// NOT NULL` (or the reverse-mapped `postCreateCmd !== undefined`)
		// as the canonical "should this hook run?" predicate without
		// having to also defend against `""`.
		postCreateCmd: z.string().min(1).max(MAX_HOOK_LEN).optional(),
		postStartCmd: z.string().min(1).max(MAX_HOOK_LEN).optional(),
		// #190 — populated by the ports form
		ports: z.array(PortSpec).max(MAX_PORTS).optional(),
		// #186 — populated by the env/secrets form. Loose Record-of-strings
		// today so callers that only need plain env can use it; #186 swaps
		// in the typed { name, value, secret } entry shape with AES-GCM
		// secret encryption.
		envVars: z.record(z.string(), z.string()).optional(),
	})
	.strict();

export type SessionConfig = z.infer<typeof SessionConfigSchema>;

/**
 * Domain shape returned by `getSessionConfig`. Mirrors the schema above
 * plus the row-only `bootstrappedAt` field that the bootstrap runner
 * (PR 185b) writes once postCreate has succeeded — exposed here so the
 * runner can read it without going back through `d1Query` directly.
 */
export interface SessionConfigRecord extends SessionConfig {
	sessionId: string;
	bootstrappedAt: Date | null;
}

// ── Validation helper ──────────────────────────────────────────────────────

export class SessionConfigValidationError extends Error {
	/** Dot-joined Zod path of the first offending field, e.g. "config.cpuLimit". */
	readonly path: string;

	constructor(path: string, message: string) {
		super(message);
		this.name = "SessionConfigValidationError";
		this.path = path;
	}
}

/**
 * Validate a raw `body.config` value. Returns a typed config on success
 * (including `undefined` when the caller didn't send one — bare-POST
 * compatibility). Throws `SessionConfigValidationError` with the first
 * Zod issue's path/message on failure so the route can return a precise
 * 400 telling the client exactly which field is wrong.
 */
export function validateSessionConfig(raw: unknown): SessionConfig | undefined {
	if (raw === undefined || raw === null) return undefined;
	const result = SessionConfigSchema.safeParse(raw);
	if (!result.success) {
		// Surface the first issue. Returning every issue would be richer
		// but the existing 400 format in routes.ts is `{ error: string }` —
		// a list would force a wider API change for marginal product
		// value. Clients that hit a multi-field error fix one, retry,
		// fix the next; same UX as the existing single-message pattern
		// in envVarValidation.
		const issue = result.error.issues[0]!;
		const path = ["config", ...issue.path.map(String)].join(".");
		throw new SessionConfigValidationError(path, `${path}: ${issue.message}`);
	}
	// Run `config.envVars` through the same `validateEnvVars` guards the
	// legacy top-level `body.envVars` path uses — POSIX key format,
	// per-key/value caps, total-size cap, NUL-byte rejection, and the
	// LD_PRELOAD/NODE_OPTIONS-style injection denylist. PR 185b will
	// hand `session_configs.env_vars_json` straight to `docker run` /
	// `docker exec`, so a value that bypasses these rules at INGEST
	// would reach the consumer unchecked. Z is on shape; envVarValidation
	// is on contents; both are needed.
	if (result.data.envVars !== undefined) {
		try {
			result.data.envVars = validateEnvVars(result.data.envVars);
		} catch (err) {
			if (err instanceof EnvVarValidationError) {
				throw new SessionConfigValidationError("config.envVars", `config.envVars: ${err.message}`);
			}
			throw err;
		}
	}
	return result.data;
}

// ── D1 persistence ─────────────────────────────────────────────────────────

interface SessionConfigRow {
	session_id: string;
	workspace_strategy: string | null;
	cpu_limit: number | null;
	mem_limit: number | null;
	idle_ttl_seconds: number | null;
	post_create_cmd: string | null;
	post_start_cmd: string | null;
	repos_json: string | null;
	ports_json: string | null;
	env_vars_json: string | null;
	bootstrapped_at: string | null;
}

function rowToRecord(row: SessionConfigRow): SessionConfigRecord {
	return {
		sessionId: row.session_id,
		workspaceStrategy:
			row.workspace_strategy === "preserve" || row.workspace_strategy === "clone"
				? row.workspace_strategy
				: undefined,
		cpuLimit: row.cpu_limit ?? undefined,
		memLimit: row.mem_limit ?? undefined,
		idleTtlSeconds: row.idle_ttl_seconds ?? undefined,
		postCreateCmd: row.post_create_cmd ?? undefined,
		postStartCmd: row.post_start_cmd ?? undefined,
		repos: parseJsonColumn<SessionConfig["repos"]>(row.session_id, "repos_json", row.repos_json),
		ports: parseJsonColumn<SessionConfig["ports"]>(row.session_id, "ports_json", row.ports_json),
		envVars: parseJsonColumn<SessionConfig["envVars"]>(
			row.session_id,
			"env_vars_json",
			row.env_vars_json,
		),
		bootstrappedAt: row.bootstrapped_at ? parseD1Utc(row.bootstrapped_at) : null,
	};
}

/**
 * `JSON.parse` wrapper for the three JSON-shaped columns on `session_configs`.
 *
 * Rows are only written by `persistSessionConfig` (which uses `JSON.stringify`),
 * so a malformed value would have to come from a direct SQL write, a future
 * migration that rewrites the column, or D1 corruption. Any of those is rare
 * enough that throwing would be a real bug — but a `SyntaxError` bubbling
 * through `getSessionConfig` would crash whatever request triggered the read
 * (and on session-attach paths that's a 500 the user just sees as "session
 * broken"). Degrade to `undefined` + a loud `logger.warn` so the rest of the
 * row stays usable and the operator sees the inconsistency.
 */
function parseJsonColumn<T>(sessionId: string, column: string, raw: string | null): T | undefined {
	if (raw === null) return undefined;
	try {
		return JSON.parse(raw) as T;
	} catch (err) {
		logger.warn(
			`[sessionConfig] malformed JSON in ${column} for session ${sessionId}: ${(err as Error).message}`,
		);
		return undefined;
	}
}

// Mirrors sessionManager.parseD1UtcTimestamp — D1's `datetime('now')` lacks
// any timezone suffix and Node's Date treats suffix-less ISO strings as
// LOCAL time. Append 'Z' unless the value already carries one (a future
// migration could add it explicitly).
function parseD1Utc(raw: string): Date {
	const hasSuffix = /[zZ]$/.test(raw) || /[+-]\d{2}:?\d{2}$/.test(raw);
	const d = new Date(hasSuffix ? raw : `${raw}Z`);
	if (Number.isNaN(d.getTime())) {
		throw new Error(`session_configs returned unparseable timestamp: ${raw}`);
	}
	return d;
}

/**
 * Persist a validated config for `sessionId`. Idempotent on the primary
 * key — a second call with the same sessionId replaces the row, which
 * matches "config is bound at create time" since callers only ever
 * invoke this from the create path. PR 185b will gate `bootstrapped_at`
 * on a separate write path.
 */
export async function persistSessionConfig(
	sessionId: string,
	config: SessionConfig,
): Promise<void> {
	await d1Query(
		`INSERT INTO session_configs
                        (session_id, workspace_strategy, cpu_limit, mem_limit,
                         idle_ttl_seconds, post_create_cmd, post_start_cmd,
                         repos_json, ports_json, env_vars_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(session_id) DO UPDATE SET
                        workspace_strategy = excluded.workspace_strategy,
                        cpu_limit          = excluded.cpu_limit,
                        mem_limit          = excluded.mem_limit,
                        idle_ttl_seconds   = excluded.idle_ttl_seconds,
                        post_create_cmd    = excluded.post_create_cmd,
                        post_start_cmd     = excluded.post_start_cmd,
                        repos_json         = excluded.repos_json,
                        ports_json         = excluded.ports_json,
                        env_vars_json      = excluded.env_vars_json`,
		[
			sessionId,
			config.workspaceStrategy ?? null,
			config.cpuLimit ?? null,
			config.memLimit ?? null,
			config.idleTtlSeconds ?? null,
			config.postCreateCmd ?? null,
			config.postStartCmd ?? null,
			config.repos ? JSON.stringify(config.repos) : null,
			config.ports ? JSON.stringify(config.ports) : null,
			config.envVars ? JSON.stringify(config.envVars) : null,
		],
	);
}

/** Read the config row for `sessionId`, or `null` if no row exists. */
export async function getSessionConfig(sessionId: string): Promise<SessionConfigRecord | null> {
	const result = await d1Query<SessionConfigRow>(
		"SELECT * FROM session_configs WHERE session_id = ?",
		[sessionId],
	);
	return result.results.length > 0 ? rowToRecord(result.results[0]!) : null;
}

/**
 * Returns true iff every member of `config` is undefined.
 *
 * Used by `POST /sessions` to skip a no-op `session_configs` INSERT when
 * the client sends `config: {}` — it's a production guard, not a test
 * helper. Tests reuse it for the same shape check.
 */
export function isEmptyConfig(config: SessionConfig): boolean {
	return Object.values(config).every((v) => v === undefined);
}
