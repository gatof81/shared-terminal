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
import { checkEnvVarSafety, EnvVarValidationError } from "./envVarValidation.js";
import { logger } from "./logger.js";
import { decryptSecret, type EncryptedSecret, encryptSecret } from "./secrets.js";

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
// #186 env-var entry caps. Per-entry value at 16 KiB matches the
// spec; aggregate budget below caps the whole serialised list so a
// caller can't blow past D1-friendly sizes by stuffing 64 entries at
// the per-entry max. Worst-case JSON envelope under 1 MiB, well
// inside D1 row limits.
const MAX_ENV_ENTRIES = 64;
const MAX_ENV_VALUE_BYTES = 16 * 1024;
// Aggregate cap on the serialised typed-entry list. 256 KiB lets a
// realistic config (a few dozen plain entries + a handful of
// secrets) breathe while still bounding the row size and the bytes
// echoed on every list response.
const MAX_ENV_VARS_TOTAL_BYTES = 256 * 1024;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const MAX_ENV_NAME_LEN = 256;

// ── Zod schemas ─────────────────────────────────────────────────────────────

// Minimal placeholder for #188. Just shape today: the URL / ref pair.
// Auth method, replace-workspace flag, etc. land with the repo-clone child.
//
// URL scheme allowlist is enforced at INGEST so a stored value can never
// reach the #188 git-clone consumer with a problematic scheme:
//   - `file://`              clone from arbitrary host paths (incl. the
//                            bind-mounted workspace)
//   - `ssh://attacker/`      SSRF / host-key confusion
//   - `git://attacker:9418/` unauthenticated git protocol; same SSRF
//                            shape as ssh, GitHub deprecated/removed
//                            support in 2021
//   - `http://`              cleartext: a MITM (corporate proxy, captive
//                            portal, hostile WiFi) can inject repo
//                            content which then executes inside the
//                            container as postCreate/postStart hooks.
//                            Blast radius is the session container, not
//                            the host, but the product runs the Claude
//                            CLI inside these containers — material risk.
// The schema is the right enforcement point: once a row is in D1, the
// child issue has no obvious place to re-validate without a duplicate
// codebase. `git+...` variants stay out pending a real reason to need
// them. If a future deployment needs cleartext intranet mirrors, #188
// can add an opt-in form affordance with a UI warning instead of
// silently storing the URL.
const REPO_URL_SCHEME = /^https:\/\//;
const RepoSpec = z
	.object({
		url: z
			.string()
			.min(1)
			.max(500)
			.refine((u) => REPO_URL_SCHEME.test(u), {
				message: "url must use https:// scheme",
			}),
		// `.min(1)` matches the postCreateCmd/postStartCmd rule: a stored
		// empty string is indistinguishable from "no ref supplied" once
		// it lands in D1, so refusing it at ingest lets the #188 git-
		// clone consumer use a presence-only check instead of also
		// defending against `git clone --branch ""`.
		ref: z.string().min(1).max(200).optional(),
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

// #186 — typed env-var entries replace the loose Record<string,string>
// shape. Three variants:
//   - `plain`       : visible value, stored verbatim in D1.
//   - `secret`      : value encrypted before persistence; never returned
//                     by listing endpoints (see the redact path).
//   - `secret-slot` : a placeholder a #195 template surfaces to the
//                     recipient as "you must fill this in"; rejected
//                     at POST /sessions because there's no value to
//                     persist for the slot itself.
//
// The schema describes the WIRE shape (what clients send): both
// `plain` and `secret` carry a plaintext `value` field. The persisted
// shape on `secret` rows replaces `value` with `{ ciphertext, iv, tag }`
// (see `encryptSecretEntries`). The two shapes are kept separate
// because the wire-side validators (Zod) and the storage-side
// validators (rowToRecord rehydration) have different invariants.
const ENV_NAME_REJECT = "name must match /^[A-Z_][A-Z0-9_]*$/ (uppercase POSIX env var)";
const PlainEnvEntry = z
	.object({
		name: z.string().regex(ENV_NAME_PATTERN, ENV_NAME_REJECT).max(MAX_ENV_NAME_LEN),
		type: z.literal("plain"),
		value: z.string().refine((v) => Buffer.byteLength(v, "utf-8") <= MAX_ENV_VALUE_BYTES, {
			message: `value exceeds ${MAX_ENV_VALUE_BYTES} bytes`,
		}),
	})
	.strict();
const SecretEnvEntry = z
	.object({
		name: z.string().regex(ENV_NAME_PATTERN, ENV_NAME_REJECT).max(MAX_ENV_NAME_LEN),
		type: z.literal("secret"),
		value: z
			.string()
			.min(1, "secret value must not be empty")
			.refine((v) => Buffer.byteLength(v, "utf-8") <= MAX_ENV_VALUE_BYTES, {
				message: `value exceeds ${MAX_ENV_VALUE_BYTES} bytes`,
			}),
	})
	.strict();
// `secret-slot` is wire-only on the template-load path (#195); we
// declare it here so the schema knows about all three variants and
// `validateSessionConfig` can reject it explicitly with a clear
// message rather than dropping it through a permissive union check.
const SecretSlotEnvEntry = z
	.object({
		name: z.string().regex(ENV_NAME_PATTERN, ENV_NAME_REJECT).max(MAX_ENV_NAME_LEN),
		type: z.literal("secret-slot"),
	})
	.strict();
const EnvVarEntry = z.discriminatedUnion("type", [
	PlainEnvEntry,
	SecretEnvEntry,
	SecretSlotEnvEntry,
]);
export type EnvVarEntryInput = z.infer<typeof EnvVarEntry>;
/** Storage shape after encryption — secret entries lose `value` and gain
 *  `{ ciphertext, iv, tag }`. Plain entries are unchanged. */
export type EnvVarEntryStored =
	| { name: string; type: "plain"; value: string }
	| { name: string; type: "secret"; ciphertext: string; iv: string; tag: string };
/** Public/redacted shape returned by listing endpoints — secret values
 *  collapse to `{ isSet: true }`. Used by routes' serializer. */
export type EnvVarEntryPublic =
	| { name: string; type: "plain"; value: string }
	| { name: string; type: "secret"; isSet: true };

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
		// #186 — typed entry list. `plain` values stored verbatim;
		// `secret` values encrypted before D1 write (see
		// `encryptSecretEntries`) and redacted in listing endpoints.
		// `secret-slot` is template-load-only and rejected on POST.
		envVars: z.array(EnvVarEntry).max(MAX_ENV_ENTRIES).optional(),
	})
	.strict();

export type SessionConfig = z.infer<typeof SessionConfigSchema>;

/**
 * Domain shape returned by `getSessionConfig`. Mirrors the schema above
 * plus the row-only `bootstrappedAt` field that the bootstrap runner
 * (PR 185b) writes once postCreate has succeeded — exposed here so the
 * runner can read it without going back through `d1Query` directly.
 */
export interface SessionConfigRecord extends Omit<SessionConfig, "envVars"> {
	sessionId: string;
	bootstrappedAt: Date | null;
	// Storage-shape env vars: `secret` rows carry ciphertext + iv +
	// tag (no plaintext value). DockerManager.spawn decrypts via
	// `decryptStoredEntries` before handing them to `docker run`.
	envVars?: EnvVarEntryStored[];
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
	// Apply the denylist + NUL-byte rules from envVarValidation per
	// entry. Zod already handled shape (Zod regex on the typed
	// EnvVarEntry name, byte cap on value via .refine, discriminated-
	// union variant). The legacy `validateEnvVars` bundles its own
	// length/count caps that DO NOT match the typed-path spec
	// (#186 requires 256-char name + 16 KiB value vs the legacy
	// 128/4096) — calling the full function silently overrode the
	// caps Zod advertised. Round-1 review caught this. Going through
	// the targeted `checkEnvVarSafety` helper instead so the new
	// path's caps are the only ones in force.
	//
	// `secret-slot` is rejected outright — template-load wire shape
	// only, never valid on POST. Dedup by name + aggregate-byte guard
	// fire here too; the per-entry helper can't see either.
	if (result.data.envVars !== undefined) {
		const seen = new Set<string>();
		for (const entry of result.data.envVars) {
			if (seen.has(entry.name)) {
				throw new SessionConfigValidationError(
					"config.envVars",
					`config.envVars: duplicate entry name '${entry.name}'`,
				);
			}
			seen.add(entry.name);
			if (entry.type === "secret-slot") {
				throw new SessionConfigValidationError(
					"config.envVars",
					`config.envVars[${entry.name}]: 'secret-slot' is template-load only; provide a 'secret' or 'plain' entry instead`,
				);
			} else {
				// Explicit `else` so TS narrows via the structural
				// branch rather than relying on the throw above —
				// future refactors that change `throw` to `continue`
				// would otherwise hand `entry.value: undefined` to
				// `checkEnvVarSafety`. PR #210 round 3 review.
				try {
					checkEnvVarSafety(entry.name, entry.value);
				} catch (err) {
					if (err instanceof EnvVarValidationError) {
						throw new SessionConfigValidationError(
							"config.envVars",
							`config.envVars[${entry.name}]: ${err.message}`,
						);
					}
					throw err;
				}
			}
		}
		// Aggregate-bytes guard. 64 × 16 KiB worst case is ~1 MiB,
		// which D1 handles but bloats every list response and ties up
		// a row that didn't need to be that large. 256 KiB ceiling
		// covers any realistic config without letting a hostile
		// caller pin the column at MB scale. Buffer.byteLength counts
		// multi-byte UTF-8 correctly.
		//
		// NOTE: this measures the WIRE shape (secret rows still carry
		// `value`); the post-encryption STORAGE shape replaces `value`
		// with `{ ciphertext, iv, tag }`, where ciphertext+iv+tag
		// base64 encoding adds ~37% overhead per secret row. So a
		// payload right at the 256 KiB cap can land at ~350 KiB in
		// `env_vars_json` after encryption. Bounded by the per-entry +
		// count caps (still well under 1 MiB worst case), so this
		// approximation is acceptable; moving the check post-encrypt
		// would tie validation to the route's encryption step.
		const serialisedBytes = Buffer.byteLength(JSON.stringify(result.data.envVars), "utf-8");
		if (serialisedBytes > MAX_ENV_VARS_TOTAL_BYTES) {
			throw new SessionConfigValidationError(
				"config.envVars",
				`config.envVars total size (${serialisedBytes} bytes) exceeds ${MAX_ENV_VARS_TOTAL_BYTES} bytes`,
			);
		}
	}
	return result.data;
}

// ── Encryption helpers ──────────────────────────────────────────────────

/**
 * Convert validated wire entries (with plaintext on secret rows) into
 * the storage shape that lands in `session_configs.env_vars_json`.
 * Plain entries pass through; `secret` entries get
 * `{ name, type, ciphertext, iv, tag }` after AES-256-GCM encrypt.
 *
 * Caller (route) MUST invoke this between `validateSessionConfig` and
 * `persistSessionConfig`. Encrypting at the route boundary means
 * plaintext is in scope only inside the request handler — the D1
 * column never sees secret plaintext, and a future serialization
 * mistake leaks ciphertext at worst.
 */
export function encryptSecretEntries(entries: EnvVarEntryInput[]): EnvVarEntryStored[] {
	return entries.map((entry) => {
		if (entry.type === "plain") return entry;
		// Already filtered by validateSessionConfig, but keep the type
		// guard tight — a future caller bypassing validation would
		// otherwise silently drop secret-slot here.
		if (entry.type === "secret") {
			const blob = encryptSecret(entry.value);
			return {
				name: entry.name,
				type: "secret",
				ciphertext: blob.ciphertext,
				iv: blob.iv,
				tag: blob.tag,
			};
		}
		throw new Error(`encryptSecretEntries: unexpected variant ${(entry as { type: string }).type}`);
	});
}

/**
 * Decrypt a stored entry list into the `KEY=VALUE` plaintext array
 * Docker's `Env` field wants. Used by `DockerManager.spawn` at the
 * single point where plaintext has to be in memory.
 *
 * `decryptSecret` throws on tag mismatch (tampered ciphertext, wrong
 * key after rotation, D1 corruption) — the throw must NOT be
 * swallowed at the call site. Spawn fails loudly rather than starting
 * a container with a missing or wrong-valued env var.
 */
export function decryptStoredEntries(entries: EnvVarEntryStored[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const entry of entries) {
		if (entry.type === "plain") {
			out[entry.name] = entry.value;
		} else {
			out[entry.name] = decryptSecret({
				ciphertext: entry.ciphertext,
				iv: entry.iv,
				tag: entry.tag,
			});
		}
	}
	return out;
}

/**
 * Redact stored entries for listing endpoints. Plain entries pass
 * through; secret entries collapse to `{ name, type, isSet: true }`
 * so neither plaintext nor ciphertext leaks via `GET /api/sessions/:id`
 * or list. Belt-and-suspenders against a future serializer change
 * forgetting to redact — the encryption already keeps plaintext out
 * of the response, but `isSet` is the contract clients code against.
 */
export function redactStoredEntries(entries: EnvVarEntryStored[]): EnvVarEntryPublic[] {
	return entries.map((entry) => {
		if (entry.type === "plain") return entry;
		return { name: entry.name, type: "secret", isSet: true };
	});
}

/** Storage-shape blob of a stored secret entry, exported for type
 *  parity with EncryptedSecret. */
export type StoredSecretEntry = Extract<EnvVarEntryStored, { type: "secret" }>;
// Local widening for tests that want to construct the EncryptedSecret
// half of a stored entry without rebuilding the whole shape.
export const _testOnly_storedFromEncrypted = (
	name: string,
	blob: EncryptedSecret,
): StoredSecretEntry => ({
	name,
	type: "secret",
	ciphertext: blob.ciphertext,
	iv: blob.iv,
	tag: blob.tag,
});

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
		envVars: parseEnvVarsColumn(row.session_id, row.env_vars_json),
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

/**
 * Backward-compat env-vars rehydrator (#186 / PR 210 round 2 review).
 *
 * `session_configs.env_vars_json` had two on-disk shapes across this
 * epic:
 *
 *   - Pre-PR-210: a JSON object — `{"FOO":"bar","BAR":"baz"}` — the
 *     loose Record-of-strings shape that PR #205 (185a) introduced.
 *   - Post-PR-210: a JSON array of typed entries —
 *     `[{"name":"FOO","type":"plain","value":"bar"}, …]`.
 *
 * Without this shim, a row written by the pre-PR-210 code parses
 * cleanly through `JSON.parse` (no error), but the resulting object
 * has no `.length`, so `DockerManager.spawn`'s
 * `config.envVars && config.envVars.length > 0` check silently
 * skips decrypt+merge and the user's container respawns missing
 * every config-supplied env var. That's silent data loss on a
 * deploy with existing rows.
 *
 * Convert the legacy object shape into typed `plain` entries on the
 * fly. Secret entries can't have existed in the legacy shape (PR
 * 186a/210 introduced encryption), so promoting all old keys to
 * `plain` is correct. Once a session is recycled (DELETE + POST
 * /start) its row gets rewritten in the new shape and this branch
 * stops firing for it.
 */
function parseEnvVarsColumn(
	sessionId: string,
	raw: string | null,
): EnvVarEntryStored[] | undefined {
	const parsed = parseJsonColumn<unknown>(sessionId, "env_vars_json", raw);
	if (parsed === undefined) return undefined;
	if (Array.isArray(parsed)) {
		// Structurally validate each element rather than blanket-cast
		// (PR #210 round 3 review). A D1 row hand-edited to carry a
		// `secret-slot` row, or a `secret` row missing one of
		// ciphertext/iv/tag, would otherwise reach `decryptSecret` and
		// throw on every spawn — an effective DoS for that session
		// from a write-capable D1 attacker. Per-element filter logs +
		// drops anything off-shape; the rest of the row stays usable.
		const out: EnvVarEntryStored[] = [];
		for (const e of parsed) {
			if (e === null || typeof e !== "object") {
				logger.warn(
					`[sessionConfig] env_vars_json entry for session ${sessionId} is not an object; skipping`,
				);
				continue;
			}
			const entry = e as { name?: unknown; type?: unknown; [k: string]: unknown };
			if (typeof entry.name !== "string") {
				logger.warn(
					`[sessionConfig] env_vars_json entry for session ${sessionId} missing/typed-wrong name; skipping`,
				);
				continue;
			}
			if (entry.type === "plain" && typeof entry.value === "string") {
				out.push({ name: entry.name, type: "plain", value: entry.value });
			} else if (
				entry.type === "secret" &&
				typeof entry.ciphertext === "string" &&
				typeof entry.iv === "string" &&
				typeof entry.tag === "string"
			) {
				out.push({
					name: entry.name,
					type: "secret",
					ciphertext: entry.ciphertext,
					iv: entry.iv,
					tag: entry.tag,
				});
			} else {
				logger.warn(
					`[sessionConfig] env_vars_json entry '${entry.name}' for session ${sessionId} has unknown / incomplete shape (type=${String(entry.type)}); skipping`,
				);
			}
		}
		return out;
	}
	if (parsed !== null && typeof parsed === "object") {
		// Legacy Record<string,string> shape; promote to typed plain.
		// Defensive: skip non-string values rather than throw — a
		// future migration that wrote a numeric metric in here by
		// mistake shouldn't take a session offline.
		const entries: EnvVarEntryStored[] = [];
		for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof value !== "string") {
				logger.warn(
					`[sessionConfig] legacy env_vars_json entry '${name}' for session ${sessionId} is not a string; skipping`,
				);
				continue;
			}
			entries.push({ name, type: "plain", value });
		}
		return entries;
	}
	// JSON parsed to something exotic (number, string, null) — log and
	// degrade. Same shape of fault-tolerance the rest of parseJsonColumn
	// applies for malformed JSON.
	logger.warn(
		`[sessionConfig] env_vars_json for session ${sessionId} parsed to non-array, non-object value; skipping`,
	);
	return undefined;
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
 * Shape `persistSessionConfig` accepts. Most fields match `SessionConfig`
 * directly; `envVars` is the post-encryption storage shape so the route
 * is the only place plaintext lives. Callers MUST run `validateSessionConfig`
 * + `encryptSecretEntries` first; this module's serializer trusts both.
 */
export type PersistableSessionConfig = Omit<SessionConfig, "envVars"> & {
	envVars?: EnvVarEntryStored[];
};

/**
 * Persist a validated + encrypted config for `sessionId`. Idempotent on
 * the primary key — a second call with the same sessionId replaces the
 * row, which matches "config is bound at create time" since callers
 * only ever invoke this from the create path. PR 185b gates
 * `bootstrapped_at` on a separate write path.
 *
 * `envVars` (if present) is already in storage shape — secret rows
 * carry `ciphertext` + `iv` + `tag` instead of `value`. The route
 * encrypts before calling here so plaintext never appears in the D1
 * column.
 */
export async function persistSessionConfig(
	sessionId: string,
	config: PersistableSessionConfig,
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
			// Empty containers (`[]`, `{}`) collapse to NULL so the row
			// doesn't carry no-op JSON literals — `getSessionConfig` would
			// rehydrate them as undefined anyway, and PR 185b's runner
			// uses `IS NOT NULL` semantics on these columns to decide
			// whether the corresponding feature was configured.
			jsonOrNull(config.repos),
			jsonOrNull(config.ports),
			jsonOrNull(config.envVars),
		],
	);
}

/**
 * Serialise a sub-record column for D1 insertion. Returns null for
 * undefined and for empty containers (`[]`, `{}`); JSON-stringifies
 * everything else. The bare-truthy form would write `"{}"` for an empty
 * envVars object, which is row bloat with no semantic difference.
 */
function jsonOrNull(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (Array.isArray(value) && value.length === 0) return null;
	if (typeof value === "object" && Object.keys(value as object).length === 0) return null;
	return JSON.stringify(value);
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
export function isEmptyConfig(config: SessionConfig | PersistableSessionConfig): boolean {
	return Object.values(config).every((v) => v === undefined);
}
