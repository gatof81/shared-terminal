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
import { parseD1Utc } from "./d1Time.js";
import { d1Query } from "./db.js";
import { checkEnvVarSafety, EnvVarValidationError } from "./envVarValidation.js";
import { logger } from "./logger.js";
import { decryptSecret, encryptSecret } from "./secrets.js";

// ── Bounds (shape-level only; children tighten) ─────────────────────────────

// Hook command bodies. Generous enough for a multi-line shell script
// (postCreate / postStart) without becoming a vector for ballooning the
// session_configs row. #191 is free to lower this when the form lands.
const MAX_HOOK_LEN = 8 * 1024;
// Per-session resource bounds:
//   - CPU: 0.25 → 8 cores. Stored as nano-CPUs (Docker's HostConfig
//     unit) to keep the wire shape integer-only and avoid the
//     float-precision foot-gun JSON Number has at the high end.
//   - Memory: 256 MiB → 16 GiB.
//   - Idle TTL: 60 s → 24 h. OMIT the field (undefined) to disable
//     auto-stop; `null` is NOT accepted — the schema is `.optional()`,
//     not `.nullable()`, so sending `null` returns 400.
//
// `dockerManager.ts`'s `DEFAULT_NANO_CPUS` (2 cores) and
// `DEFAULT_MEMORY_BYTES` (2 GiB) both fall comfortably INSIDE these
// bands — a session created without explicit caps spawns with a
// resource allocation that's still a legal "user-supplied" entry,
// keeping the schema and the spawn defaults coherent. The defaults
// are not AT the lower bounds — the 0.25-core / 256-MiB floors are
// 8× below them — so a future operator-override layer should not
// anchor its caps to the defaults.
const CPU_NANO_MIN = 250_000_000; // 0.25 cores
const CPU_NANO_MAX = 8_000_000_000; // 8 cores
const MEM_BYTES_MIN = 256 * 1024 * 1024; // 256 MiB
const MEM_BYTES_MAX = 16 * 1024 * 1024 * 1024; // 16 GiB
const IDLE_TTL_S_MIN = 60; // 1 minute
const IDLE_TTL_S_MAX = 24 * 60 * 60; // 24 hours
// Cap repeating sub-records so a single create can't write a multi-MB
// JSON blob into D1. Children may lower these when their forms cap by
// product UX.
const MAX_PORTS = 20;
// #188 — repo + auth bounds. Refs are git refnames (branch, tag, or
// raw SHA). 200 chars covers any realistic name (Git itself imposes a
// 255-byte filename cap on packed refs). Target is a workspace-
// relative path; 256 chars matches the env-var name cap shape.
// known_hosts is bundled-or-paste; 32 KiB lets a paranoid operator
// drop in a corp-wide trust list without becoming a DoS surface.
const MAX_REPO_REF_LEN = 200;
const MAX_REPO_TARGET_LEN = 256;
const MAX_REPO_DEPTH = 10_000;
const MAX_PAT_LEN = 4 * 1024;
const MAX_SSH_KEY_LEN = 16 * 1024;
const MAX_KNOWN_HOSTS_LEN = 32 * 1024;
// #191 lifecycle-hook bounds. Names + emails fit in 256 chars (RFC
// 5321 caps the localpart at 64 + domain at 255 — 256 is comfortably
// over the realistic max). Dotfiles install-script paths use the same
// shape as repo target. Agent-seed file bodies are user-generated
// content (settings.json, CLAUDE.md) — 256 KiB matches the env-vars
// total cap so a single create can't push a multi-MB row to D1.
const MAX_GIT_NAME_LEN = 256;
const MAX_GIT_EMAIL_LEN = 256;
const MAX_DOTFILES_INSTALL_SCRIPT_LEN = 256;
const MAX_AGENT_SEED_BYTES = 256 * 1024;
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

// #188 — repo specification. URL scheme allowlist is enforced at INGEST
// so a stored value can never reach the git-clone consumer with a
// problematic scheme:
//   - `file://`              clone from arbitrary host paths (incl. the
//                            bind-mounted workspace).
//   - `ssh://attacker/`      SSRF / host-key confusion. The SSH auth
//                            path uses the conventional `git@host:path`
//                            URL form instead, NOT `ssh://`.
//   - `git://attacker:9418/` unauthenticated git protocol; same SSRF
//                            shape as ssh, GitHub deprecated/removed
//                            support in 2021.
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
//
// Two URL forms are allowed:
//   - `https://host/owner/repo[.git]`        — for `auth: "none"|"pat"`
//   - `git@host:owner/repo[.git]`            — for `auth: "ssh"`
// Cross-field validation in `validateSessionConfig` enforces the
// auth↔scheme pairing — a `git@…` URL with `auth: "none"` would clone
// over a missing identity and fail mysteriously inside the container;
// we reject it at the route boundary instead.
//
// `[^@\s]` in REPO_URL_HTTPS is the round-1 SHOULD-FIX. Without it the
// regex accepted `https://user:ghp_TOKEN@github.com/o/p`, which would
// store the PAT verbatim in `repos_json` (the whole point of
// `auth_json` / `encryptAuthCredentials` is that secrets never land
// in plaintext anywhere on disk). The form forces credentials through
// `auth.pat` instead, where the route encrypts before persist. The
// SSH form's regex deliberately starts with the `git@` user prefix
// — that's the canonical SSH-clone shape, not a credential — and
// the host/path char class on the other side excludes `@` already.
//
// `..` in either side is rejected by the explicit `.includes("..")`
// check below; the regex alone allows it because `.` and `/` are
// valid path chars. The runner in 188c will pass the URL to `git
// clone` via argv (no shell), but blocking `..` here keeps the
// invariant uniform across `repo.url` / `repo.ref` / `repo.target`
// so the 188c author doesn't trip over an asymmetric foot-gun.
const REPO_URL_HTTPS = /^https:\/\/[^@\s]+$/;
// First path char must be alphanumeric / `.` / `_` so `git@host:/etc/passwd`
// (an absolute-path SSH clone target) doesn't slip through. Standard SCP-form
// SSH URLs use a relative path after the colon — `git@github.com:owner/repo`
// — and a leading `/` widens the SSRF surface against self-hosted intranet
// Git servers reachable from the container network. Mirrors the
// alphanumeric-leading rule already on `REPO_TARGET_PATTERN`. PR #213 round 3.
const REPO_URL_SSH = /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._][A-Za-z0-9._/-]*$/;
// Refnames: branches, tags, raw SHAs. Allow the standard refname
// charset (per `git check-ref-format`) plus `/` for nested branches.
// Reject `..` and leading `-` so the value can never be misinterpreted
// as a `git clone` flag (e.g. `--upload-pack=…`) when the runner in
// 188c shells out. The runner will pass `--branch <ref>` via argv (no
// shell), but this is the cheap, declarative belt-and-suspenders.
const REPO_REF_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._/+@-]*$/;
// Target: workspace-relative path. Empty string = workspace root
// (signals replace-workspace mode for 188c). Non-empty must be a
// relative path with no `..` traversal segments and no leading `/`.
// Same conservative charset as refnames, no spaces.
const REPO_TARGET_PATTERN = /^(|[A-Za-z0-9_][A-Za-z0-9._/-]*)$/;
const RepoSpec = z
	.object({
		url: z
			.string()
			.min(1)
			.max(500)
			.refine((u) => REPO_URL_HTTPS.test(u) || REPO_URL_SSH.test(u), {
				message: "url must be https://… or git@host:path form",
			})
			// Belt-and-suspenders against `..` in either URL form. The
			// HTTPS regex blocks `@` (creds-in-URL); the SSH path char
			// class allows `.` and `/` (so `git@host:org/../etc` would
			// otherwise pass shape validation). Argv-only invocation by
			// the runner means this isn't a local RCE concern, but the
			// uniform `..` rejection across url/ref/target keeps the
			// invariant readable for the 188c author.
			.refine((u) => !u.includes(".."), {
				message: "url must not contain '..'",
			}),
		// Empty `""` = remote HEAD (no `--branch` flag). Non-empty is
		// validated against the refname allowlist below. Stored as the
		// literal user input; the runner decides whether to pass
		// `--branch`.
		ref: z
			.string()
			.max(MAX_REPO_REF_LEN)
			.refine((r) => r === "" || (REPO_REF_PATTERN.test(r) && !r.includes("..")), {
				message: "ref must match refname rules and not contain '..'",
			})
			.optional(),
		// Empty `""` = workspace root (replace-workspace mode). Non-empty
		// is a relative subpath validated below.
		target: z
			.string()
			.max(MAX_REPO_TARGET_LEN)
			.refine(
				(t) =>
					REPO_TARGET_PATTERN.test(t) &&
					!t.includes("..") &&
					!t.includes("//") &&
					!t.startsWith("/"),
				{
					message:
						"target must be empty or a workspace-relative path (no '..', no leading '/', no '//')",
				},
			)
			.optional(),
		// `"none"` = anonymous clone (must be https://). `"pat"` = HTTPS
		// with a personal access token from `auth.pat`. `"ssh"` = SSH
		// with private key + known_hosts from `auth.ssh`. Cross-field
		// requirements enforced in `validateSessionConfig`.
		auth: z.enum(["none", "pat", "ssh"]),
		// Shallow clone depth. `null`/omitted = full history. Capped at
		// MAX_REPO_DEPTH so a typo can't request a depth value that
		// becomes effectively infinite in the runner.
		depth: z.number().int().min(1).max(MAX_REPO_DEPTH).nullable().optional(),
	})
	.strict();
// #188 — credential blob. Wire shape carries plaintext from the form;
// the route encrypts before persistence (same boundary as envVars).
// Fields are independently optional — a config with `auth.pat` set
// but no `auth.ssh` (and vice-versa) is valid and common. The
// cross-field check in `validateSessionConfig` requires the right
// blob to be present given `repo.auth`.
const KNOWN_HOSTS_DEFAULT_SENTINEL = "default";
const WireAuthSpec = z
	.object({
		// PAT plaintext. AES-256-GCM encrypted before the row hits D1;
		// the storage shape replaces this string with `{ ciphertext, iv,
		// tag }` (see `encryptAuthCredentials`). 4 KiB ceiling is
		// generous: GitHub fine-grained PATs are ~93 chars, classic ~40,
		// GitLab/Bitbucket similar.
		pat: z.string().min(1).max(MAX_PAT_LEN).optional(),
		// SSH credentials: private key (encrypted at persistence) +
		// known_hosts. `knownHosts === "default"` is a sentinel that
		// 188d's runner will resolve to the bundled github/gitlab/
		// bitbucket fingerprints; any other value is treated as a
		// custom paste and stored verbatim (it's public information,
		// no need to encrypt).
		ssh: z
			.object({
				privateKey: z.string().min(1).max(MAX_SSH_KEY_LEN),
				knownHosts: z.string().min(1).max(MAX_KNOWN_HOSTS_LEN),
			})
			.strict()
			.optional(),
	})
	.strict();

// #191 — git identity. Used by the bootstrap stage to run
// `git config --global user.{name,email}` inside the container BEFORE
// any commit-producing operation (clone with rebase, dotfiles install
// running git, postCreate scripts that auto-commit). Both fields
// required when the block is set — a half-configured identity would
// produce a less-helpful `git config` error at the wrong layer.
//
// Email validation is deliberately permissive: a single `@` with at
// least one char on each side. RFC 5322's full grammar is overkill —
// the bootstrap stage just hands the string to `git config`; git
// itself accepts anything. The regex catches obvious typos
// ("user@", "@example.com", whitespace-only) without the false
// negatives a strict spec would produce.
//
// `name` rejects control characters (PR #217 round 1 SHOULD-FIX).
// `git config --global user.name "<name>"` writes the value into
// `~/.gitconfig`, which is INI-format with newlines as record
// separators. A `\n` in `name` would corrupt the file — even with
// argv-only invocation, the bytes land in the INI verbatim and could
// inject additional config keys (e.g. `\n[user]\nemail = evil@…`)
// that subsequent git operations honor. Reject at the schema boundary
// so the runner doesn't need to defend at the write site.
const GIT_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate — the whole point of this regex is to reject control bytes that would corrupt INI-format git config when written by `git config --global`.
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
const GitIdentitySpec = z
	.object({
		name: z
			.string()
			.min(1)
			.max(MAX_GIT_NAME_LEN)
			.refine((n) => !CONTROL_CHAR_PATTERN.test(n), {
				message: "name must not contain control characters (would corrupt ~/.gitconfig)",
			}),
		email: z
			.string()
			.min(1)
			.max(MAX_GIT_EMAIL_LEN)
			.refine((e) => GIT_EMAIL_PATTERN.test(e), {
				message: "email must be of the form local@domain",
			}),
	})
	.strict();

// #191 — dotfiles repo. Same URL allowlist as the main repo (#188)
// so the auth↔scheme pairing rules from `RepoSpec` carry over. Auth
// is shared with the main repo by design (issue spec): the user has
// one PAT / SSH identity per session; a per-repo identity is a
// follow-up (#189). `installScript` is a path INSIDE the cloned
// dotfiles repo; same path-traversal defence as `repo.target`.
//
// NOTE: unlike `RepoSpec`, this schema has NO `auth` selector and
// NO cross-field validation against `config.auth.ssh` / `config.auth.pat`.
// The auth blob is shared with the main repo, so a `git@…` dotfiles
// URL relies on `config.auth.ssh` being populated by the main-repo
// path. 191b's bootstrap runner is the right place to enforce that
// pairing — at validation time we'd need access to whichever of
// `repo.auth: "ssh"` or a future "dotfiles only uses SSH" intent
// signals it. Kept light here; the runner fails loudly if the auth
// blob is missing when it tries to clone (PR #217 round 1 NIT
// flagged the gap; this comment is the holding pattern until 191b).
const DOTFILES_INSTALL_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
const DotfilesSpec = z
	.object({
		url: z
			.string()
			.min(1)
			.max(500)
			.refine((u) => REPO_URL_HTTPS.test(u) || REPO_URL_SSH.test(u), {
				message: "url must be https://… or git@host:path form",
			})
			.refine((u) => !u.includes(".."), {
				message: "url must not contain '..'",
			}),
		// Empty/null = remote HEAD; same shape as `RepoSpec.ref`.
		ref: z
			.string()
			.max(MAX_REPO_REF_LEN)
			.refine((r) => r === "" || (REPO_REF_PATTERN.test(r) && !r.includes("..")), {
				message: "ref must match refname rules and not contain '..'",
			})
			.nullable()
			.optional(),
		// Path inside the cloned dotfiles repo, e.g. "install.sh" or
		// "scripts/setup". `null`/omitted = clone-only (no install
		// script run). The pattern enforces no leading `/`, no `..`,
		// and the leading-alnum/`_` rule from the target pattern so a
		// future field never mis-resolves to "../etc/passwd".
		installScript: z
			.string()
			.max(MAX_DOTFILES_INSTALL_SCRIPT_LEN)
			.refine(
				(s) =>
					s === "" || (DOTFILES_INSTALL_PATTERN.test(s) && !s.includes("..") && !s.includes("//")),
				{
					message: "installScript must be a relative path with no '..', no leading '/', no '//'",
				},
			)
			.nullable()
			.optional(),
	})
	.strict();

// #191 — agent config seed. Two optional file bodies that the
// bootstrap stage writes verbatim into `~/.claude/`. Validation
// is shape-only here: `settings`, when set, must parse as JSON
// (Zod refine), since writing invalid JSON to settings.json would
// crash the agent on next start with no signal that the operator
// pasted invalid content. `claudeMd` is free markdown.
//
// Byte-cap (NOT char-cap) on both fields. Zod's `.max()` counts
// UTF-16 code units, NOT UTF-8 bytes — a 256K-codepoint string of
// 4-byte chars (e.g. emoji) would be 1 MiB on disk, four times the
// intended cap. Mirror the env-var pattern (`MAX_ENV_VALUE_BYTES`)
// and use `Buffer.byteLength(v, "utf-8")` explicitly so the cap
// matches the column-size budget. PR #217 round 1 SHOULD-FIX.
const agentSeedByteCap = (label: string) =>
	z.string().refine((s) => Buffer.byteLength(s, "utf-8") <= MAX_AGENT_SEED_BYTES, {
		message: `${label} must not exceed ${MAX_AGENT_SEED_BYTES} bytes`,
	});
const AgentSeedSpec = z
	.object({
		settings: agentSeedByteCap("settings")
			.refine(
				(s) => {
					if (s === "") return true; // empty = "don't write the file"
					try {
						JSON.parse(s);
						return true;
					} catch {
						return false;
					}
				},
				{ message: "settings must be valid JSON" },
			)
			.nullable()
			.optional(),
		claudeMd: agentSeedByteCap("claudeMd").nullable().optional(),
	})
	.strict();

// #190 PR 190a — typed port-exposure entries. `container` is the in-
// container listening port; `public` decides whether the dispatcher
// (190c) requires the `st_token` cookie before reverse-proxying to the
// container. Privileged ports (< 1024) are rejected at the schema
// level unless the session-level `allowPrivilegedPorts` toggle below
// is on — see the `superRefine` on `SessionConfigSchema` for the
// cross-field check, anchored there because the per-port refine has
// no access to siblings on the parent object.
//
// `protocol` is intentionally absent in v1: every port goes through the
// HTTP/WS dispatcher in 190c (`http-proxy` handles upgrades). Raw-TCP
// exposure would need a different topology (no Tunnel ingress, no
// per-host-header dispatch) and is out of scope for the umbrella.
const PortSpec = z
	.object({
		container: z.number().int().min(1).max(65535),
		// `public: false` is the default in the issue spec, but Zod's
		// boolean has no default and we want the wire shape to be
		// explicit — clients must say which side of the auth gate they
		// want, no implicit fallthrough. Form code in 190d sets `false`
		// for fresh rows.
		public: z.boolean(),
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
		// #188 — populated by the repo-clone form. Single-repo today
		// (multi-repo is deferred to #197). `repo: null` is wire-
		// compatible with omitting the field entirely; both rehydrate
		// to `undefined` and the bootstrap runner skips the clone step.
		workspaceStrategy: z.enum(["preserve", "clone"]).optional(),
		repo: RepoSpec.nullable().optional(),
		// Credential blob for `repo.auth` ∈ {pat, ssh}. Omitted entirely
		// for `auth: "none"`. The route encrypts before persistence —
		// plaintext is in scope only inside the request handler.
		auth: WireAuthSpec.optional(),
		// #194 — populated by the resources form
		cpuLimit: z.number().int().min(CPU_NANO_MIN).max(CPU_NANO_MAX).optional(),
		memLimit: z.number().int().min(MEM_BYTES_MIN).max(MEM_BYTES_MAX).optional(),
		idleTtlSeconds: z.number().int().min(IDLE_TTL_S_MIN).max(IDLE_TTL_S_MAX).optional(),
		// #191 — populated by the hooks form. `.min(1)` so a stored
		// empty string can never be confused with "no hook configured":
		// the bootstrap runner in PR 185b can use `post_create_cmd IS
		// NOT NULL` (or the reverse-mapped `postCreateCmd !== undefined`)
		// as the canonical "should this hook run?" predicate without
		// having to also defend against `""`.
		postCreateCmd: z.string().min(1).max(MAX_HOOK_LEN).optional(),
		postStartCmd: z.string().min(1).max(MAX_HOOK_LEN).optional(),
		// #191 — git identity / dotfiles / agent config seed. All three
		// are independent and skippable; the bootstrap runner walks each
		// stage in declared order and runs only the configured ones.
		// `null` is the wire-shape signal for "explicitly not configured"
		// and is treated identically to omission on persistence (both
		// rehydrate to `undefined`).
		gitIdentity: GitIdentitySpec.nullable().optional(),
		dotfiles: DotfilesSpec.nullable().optional(),
		agentSeed: AgentSeedSpec.nullable().optional(),
		// #190 — populated by the ports form
		ports: z.array(PortSpec).max(MAX_PORTS).optional(),
		// #190 — session-level toggle that re-grants
		// `CAP_NET_BIND_SERVICE` (and only that capability) on `docker
		// run` so the in-container process can bind to ports < 1024.
		// 190b owns the cap-add wiring; 190a only validates the toggle
		// shape and gates the privileged-port rejection on it. The
		// frontend (190d) marks this as advanced because it loosens
		// the container's default capability set.
		allowPrivilegedPorts: z.boolean().optional(),
		// #186 — typed entry list. `plain` values stored verbatim;
		// `secret` values encrypted before D1 write (see
		// `encryptSecretEntries`) and redacted in listing endpoints.
		// `secret-slot` is template-load-only and rejected on POST.
		envVars: z.array(EnvVarEntry).max(MAX_ENV_ENTRIES).optional(),
	})
	.strict()
	// #190 — cross-field invariants on `ports` / `allowPrivilegedPorts`
	// that the per-field refines can't express:
	//   1. `ports[].container` must be unique. Duplicates would either
	//      collide at the Docker `-p` step (the second `-p 0:N` silently
	//      replaces the first under some Docker versions) or land two
	//      rows in `sessions_port_mappings` with the same container
	//      port — neither is a valid state. Catch at ingest with a
	//      precise per-element path so the form can highlight the
	//      duplicate row directly.
	//   2. Privileged ports (< 1024) require the session-level
	//      `allowPrivilegedPorts: true` toggle. Done as a cross-field
	//      refine because the per-PortSpec refine has no access to its
	//      sibling `allowPrivilegedPorts` field. The container's
	//      bounding capability set is dropped to nothing by default in
	//      `dockerManager.ts`; without the toggle, the in-container
	//      process literally cannot bind to a privileged port even if
	//      we let the config through, so failing here is more useful
	//      than a confusing runtime EACCES inside the container.
	.superRefine((data, ctx) => {
		if (!data.ports) return;
		const seenContainers = new Map<number, number>(); // container -> first index
		for (let i = 0; i < data.ports.length; i++) {
			const port = data.ports[i]!;
			const prior = seenContainers.get(port.container);
			if (prior !== undefined) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["ports", i, "container"],
					message: `duplicate container port ${port.container} (also at index ${prior})`,
				});
				// `continue` so we don't also fire the privileged-port
				// issue against an index that's already rejected for a
				// different reason. Today's `safeParse` consumers only
				// surface `issues[0]` so the doubling has no UX effect,
				// but a future caller iterating all issues would see
				// two messages pointing at the same row — confusing, and
				// obscures the duplicate as the root cause. PR #221
				// round 1 NIT.
				continue;
			}
			seenContainers.set(port.container, i);
			if (port.container < 1024 && data.allowPrivilegedPorts !== true) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["ports", i, "container"],
					message: `port ${port.container} is privileged (< 1024); set allowPrivilegedPorts: true to permit`,
				});
			}
		}
	});

export type SessionConfig = z.infer<typeof SessionConfigSchema>;
export type RepoSpecInput = z.infer<typeof RepoSpec>;
export type AuthInput = z.infer<typeof WireAuthSpec>;
export type GitIdentityInput = z.infer<typeof GitIdentitySpec>;
export type DotfilesInput = z.infer<typeof DotfilesSpec>;
export type AgentSeedInput = z.infer<typeof AgentSeedSpec>;

/** Storage shape for the `auth` blob — same `{ ciphertext, iv, tag }`
 *  envelope as encrypted env-var entries. Mirrors the wire shape's
 *  optional fields exactly: `pat` is replaced by an envelope; `ssh`'s
 *  private key is replaced by an envelope but `knownHosts` (public
 *  information) stays plaintext. */
export type AuthStored = {
	pat?: { ciphertext: string; iv: string; tag: string };
	ssh?: {
		privateKey: { ciphertext: string; iv: string; tag: string };
		knownHosts: string;
	};
};
/** Public/redacted `auth` for listing endpoints — collapses any
 *  encrypted credential to `{ isSet: true }`. `knownHosts` stays
 *  visible (it's public). */
export type AuthPublic = {
	pat?: { isSet: true };
	ssh?: { isSet: true; knownHosts: string };
};
/** Sentinel known_hosts value resolved by 188d's runner to the
 *  bundled fingerprints. Exported so the runner and the frontend can
 *  agree without copying the literal string. */
export const KNOWN_HOSTS_DEFAULT = KNOWN_HOSTS_DEFAULT_SENTINEL;

/**
 * Domain shape returned by `getSessionConfig`. Mirrors the schema above
 * plus the row-only `bootstrappedAt` field that the bootstrap runner
 * (PR 185b) writes once postCreate has succeeded — exposed here so the
 * runner can read it without going back through `d1Query` directly.
 */
export interface SessionConfigRecord extends Omit<SessionConfig, "envVars" | "auth"> {
	sessionId: string;
	bootstrappedAt: Date | null;
	// Storage-shape env vars: `secret` rows carry ciphertext + iv +
	// tag (no plaintext value). DockerManager.spawn decrypts via
	// `decryptStoredEntries` before handing them to `docker run`.
	envVars?: EnvVarEntryStored[];
	// Storage-shape auth credentials: `pat` and `ssh.privateKey` are
	// encrypted envelopes. The 188c+ clone runner decrypts at use
	// site via `decryptStoredAuth`.
	auth?: AuthStored;
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
export function validateSessionConfig(
	raw: unknown,
	opts?: {
		/**
		 * When true, `secret-slot` env-var entries (the third variant
		 * of `EnvVarEntry`) pass validation instead of being rejected
		 * with the "template-load only" error. The templates flow
		 * (#195) needs this: saving a config as a template strips
		 * `secret`-typed values down to slots so the secret never
		 * lands in `templates.config`. Default `false` — `POST
		 * /api/sessions` MUST reject slots (no value to spawn the
		 * container with), so the standard call site stays strict.
		 */
		allowSecretSlots?: boolean;
		/**
		 * When true, the repo↔auth cross-field check tolerates a
		 * `repo.auth: "pat"` / `"ssh"` declaration without the
		 * matching `auth.pat` / `auth.ssh` credential. Templates
		 * need this: a save-as-template flow strips PAT / SSH key
		 * material before persist, but preserves the *intent*
		 * ("this template wants PAT auth") so the `Use template`
		 * UI can re-prompt. Without this, every saved template
		 * with a private repo would 400 on the cross-field rule.
		 * Default `false` — `POST /api/sessions` MUST require the
		 * credential (the clone runner needs it).
		 */
		allowMissingAuth?: boolean;
	},
): SessionConfig | undefined {
	const allowSecretSlots = opts?.allowSecretSlots === true;
	const allowMissingAuth = opts?.allowMissingAuth === true;
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
				if (allowSecretSlots) {
					// Template path: slot is a placeholder for a value
					// the recipient will fill in via the `Use template`
					// flow. `checkEnvVarSafety` doesn't apply — there's
					// no value to scan; the dedup check above is the
					// only invariant that fires for slots.
					continue;
				}
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
		// with `{ ciphertext, iv, tag }`, where AES-GCM ciphertext is
		// the same byte-length as plaintext, base64 encoding adds
		// ~33%, and IV (12 B → 16 chars b64) + tag (16 B → 24 chars
		// b64) add ~40 chars per secret entry. So 64 secret entries
		// each at the 16 KiB per-entry cap could yield roughly
		// 64 × ~22 KiB ≈ 1.4 MiB stored — still inside D1 row limits
		// but larger than the wire-shape cap. The approximation is
		// acceptable: the per-entry + count caps cap absolute size,
		// and moving this check post-encrypt would tie validation to
		// the route's encryption step. PR #210 round 4 review noted
		// the earlier ~350 KiB estimate was wrong arithmetic.
		const serialisedBytes = Buffer.byteLength(JSON.stringify(result.data.envVars), "utf-8");
		if (serialisedBytes > MAX_ENV_VARS_TOTAL_BYTES) {
			throw new SessionConfigValidationError(
				"config.envVars",
				`config.envVars total size (${serialisedBytes} bytes) exceeds ${MAX_ENV_VARS_TOTAL_BYTES} bytes`,
			);
		}
	}
	// #188 — repo↔auth cross-field consistency. Zod can't express these
	// in a clean way (the `auth` blob is a sibling of `repo`, not nested
	// inside it), so they're enforced here:
	//   - `repo.auth: "pat"` ⇒ url MUST be https://, `auth.pat` MUST be set.
	//     A `git@…` URL with PAT auth would fail mysteriously inside the
	//     container; reject at the route boundary instead.
	//   - `repo.auth: "ssh"` ⇒ url MUST be the `git@host:path` form,
	//     `auth.ssh` MUST be set. The runner relies on the URL form to
	//     pick the right `git clone` invocation.
	//   - `repo.auth: "none"` ⇒ url MUST be https://. No credentials
	//     allowed in `auth` for an anonymous clone — silently dropping
	//     orphan credentials would leave the operator confused about
	//     where their token "went".
	// `repo === null` / undefined: skip — empty `auth` already meaningless.
	if (result.data.repo) {
		const repo = result.data.repo;
		const authBlob = result.data.auth ?? {};
		const isHttps = REPO_URL_HTTPS.test(repo.url);
		const isSsh = REPO_URL_SSH.test(repo.url);
		if (repo.auth === "none") {
			if (!isHttps) {
				throw new SessionConfigValidationError(
					"config.repo.url",
					"config.repo.url: anonymous clone requires an https:// URL",
				);
			}
			if (authBlob.pat !== undefined || authBlob.ssh !== undefined) {
				throw new SessionConfigValidationError(
					"config.auth",
					"config.auth: credentials must not be set when config.repo.auth is 'none'",
				);
			}
		} else if (repo.auth === "pat") {
			if (!isHttps) {
				throw new SessionConfigValidationError(
					"config.repo.url",
					"config.repo.url: PAT auth requires an https:// URL",
				);
			}
			if (authBlob.pat === undefined && !allowMissingAuth) {
				throw new SessionConfigValidationError(
					"config.auth.pat",
					"config.auth.pat: required when config.repo.auth is 'pat'",
				);
			}
			// Reject a co-present SSH credential. Without this, the
			// route encrypts and persists the SSH key into `auth_json`
			// even though the runner ignores it, leaving a stale blob
			// no operator can reason about post-rotation (PR #213
			// round 3 NIT).
			if (authBlob.ssh !== undefined) {
				throw new SessionConfigValidationError(
					"config.auth.ssh",
					"config.auth.ssh: not valid when config.repo.auth is 'pat'",
				);
			}
		} else if (repo.auth === "ssh") {
			if (!isSsh) {
				throw new SessionConfigValidationError(
					"config.repo.url",
					"config.repo.url: SSH auth requires a git@host:path URL",
				);
			}
			if (authBlob.ssh === undefined && !allowMissingAuth) {
				throw new SessionConfigValidationError(
					"config.auth.ssh",
					"config.auth.ssh: required when config.repo.auth is 'ssh'",
				);
			}
			// Mirror the `pat` branch: stale unused-credential blobs
			// in D1 are credential confusion, not a security issue,
			// but expensive to diagnose later (PR #213 round 3 NIT).
			if (authBlob.pat !== undefined) {
				throw new SessionConfigValidationError(
					"config.auth.pat",
					"config.auth.pat: not valid when config.repo.auth is 'ssh'",
				);
			}
		}
	} else if (result.data.auth !== undefined) {
		// Orphan `auth` block with no `repo`. Same disposition as the
		// `auth: "none"` + creds case — refuse rather than silently
		// drop, so the operator gets a clear error message.
		const a = result.data.auth;
		if (a.pat !== undefined || a.ssh !== undefined) {
			throw new SessionConfigValidationError(
				"config.auth",
				"config.auth: credentials require config.repo to be set",
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
	// `Object.create(null)` so a write-capable D1 attacker can't smuggle
	// a `__proto__` / `constructor` / `prototype` named entry past
	// `parseEnvVarsColumn` and trip the JS engine's Object.prototype
	// setter when we assign by name. Concrete risk is low (the polluted
	// key wouldn't survive the downstream `Object.entries` iteration in
	// `mergeEnvForSpawn` either), but the WIRE-path denylist in
	// `checkEnvVarSafety` doesn't fire on the rehydration path; this
	// closes the defence-in-depth gap at the layer closest to D1.
	// PR #210 round 5 review.
	const out = Object.create(null) as Record<string, string>;
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
 * Encrypt the wire-shape `auth` blob into the storage shape the
 * `session_configs.auth_json` column persists. Mirrors the env-vars
 * pattern: plaintext credentials are in scope only inside the request
 * handler. Returns `undefined` when the input has no credentials at
 * all so the column collapses to NULL via `jsonOrNull`.
 *
 * `ssh.knownHosts` is NOT encrypted — known_hosts entries are public
 * keys (the bundled-or-pasted equivalent of a published TLS root cert);
 * encrypting them would be wasted CPU and would force the runner to
 * decrypt before it knows whether to use the bundled defaults.
 */
export function encryptAuthCredentials(auth: AuthInput | undefined): AuthStored | undefined {
	if (auth === undefined) return undefined;
	if (auth.pat === undefined && auth.ssh === undefined) return undefined;
	const out: AuthStored = {};
	if (auth.pat !== undefined) {
		out.pat = encryptSecret(auth.pat);
	}
	if (auth.ssh !== undefined) {
		const keyBlob = encryptSecret(auth.ssh.privateKey);
		out.ssh = {
			privateKey: keyBlob,
			knownHosts: auth.ssh.knownHosts,
		};
	}
	return out;
}

/**
 * Decrypt a stored auth blob into a wire-shape value the 188c+ clone
 * runner can hand to `git clone`. `decryptSecret` throws on tag
 * mismatch (tampered ciphertext, wrong key after rotation, D1
 * corruption) — clone fails loudly rather than running with an empty
 * credential string, which would silently fall back to anonymous and
 * either leak the URL or 404 on a private repo.
 */
export function decryptStoredAuth(stored: AuthStored): AuthInput {
	const out: AuthInput = {};
	if (stored.pat !== undefined) {
		out.pat = decryptSecret(stored.pat);
	}
	if (stored.ssh !== undefined) {
		out.ssh = {
			privateKey: decryptSecret(stored.ssh.privateKey),
			knownHosts: stored.ssh.knownHosts,
		};
	}
	return out;
}

/**
 * Redact stored auth credentials for listing endpoints. Encrypted
 * blobs collapse to `{ isSet: true }`; `knownHosts` (public) stays
 * visible so a client showing the Repo tab can still display "using
 * default known_hosts" vs "custom paste".
 */
export function redactStoredAuth(stored: AuthStored | undefined): AuthPublic | undefined {
	if (stored === undefined) return undefined;
	const out: AuthPublic = {};
	if (stored.pat !== undefined) out.pat = { isSet: true };
	if (stored.ssh !== undefined) {
		out.ssh = { isSet: true, knownHosts: stored.ssh.knownHosts };
	}
	// Mirror `parseAuthColumn`: an `AuthStored` with neither field set
	// collapses to undefined so listing-endpoint callers can rely on
	// `auth !== undefined` as the "are credentials configured?"
	// predicate (PR #213 round 1 NIT). `parseAuthColumn` already drops
	// rows that come back as `{}`, but a future code path that
	// constructs an `AuthStored` directly (e.g. a partial-edit endpoint)
	// would otherwise leak `{}` here.
	return out.pat === undefined && out.ssh === undefined ? undefined : out;
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
		// Copy plain entries rather than returning the stored object by
		// reference. The two variant shapes are structurally identical,
		// so TS accepts the by-reference return silently — but a future
		// GET-endpoint caller that mutates an element of the public
		// array (a reasonable thing to do before serialization) would
		// also mutate the corresponding stored entry it came from. The
		// secret branch already constructs a fresh object; mirror that
		// shape here so both variants are defensive. See #210 round 1
		// NIT.
		if (entry.type === "plain") {
			return { name: entry.name, type: "plain", value: entry.value };
		}
		return { name: entry.name, type: "secret", isSet: true };
	});
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
	// #190 PR 190a — INTEGER 0/1 (SQLite has no boolean type). Null
	// rehydrates to undefined so the schema's optional shape round-trips
	// (a row predating the column reads as null and behaves identically
	// to "no toggle ever set").
	allow_privileged_ports: number | null;
	env_vars_json: string | null;
	auth_json: string | null;
	git_identity_json: string | null;
	dotfiles_json: string | null;
	agent_seed_json: string | null;
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
		repo: parseRepoColumn(row.session_id, row.repos_json),
		ports: parseJsonColumn<SessionConfig["ports"]>(row.session_id, "ports_json", row.ports_json),
		// SQLite boolean idiom: 1 → true, anything else (including 0
		// and NULL) → undefined. We don't return `false` for stored 0
		// because the schema's `.optional()` shape means absent /
		// unset and explicit-false rehydrate to the same downstream
		// behaviour, and keeping the rehydrated record's shape narrow
		// (only `true | undefined`) lets the dispatcher and cap-add
		// consumers do `=== true` checks without thinking about 0/false.
		allowPrivilegedPorts: row.allow_privileged_ports === 1 ? true : undefined,
		envVars: parseEnvVarsColumn(row.session_id, row.env_vars_json),
		auth: parseAuthColumn(row.session_id, row.auth_json),
		gitIdentity: parseJsonColumn<SessionConfig["gitIdentity"]>(
			row.session_id,
			"git_identity_json",
			row.git_identity_json,
		),
		dotfiles: parseJsonColumn<SessionConfig["dotfiles"]>(
			row.session_id,
			"dotfiles_json",
			row.dotfiles_json,
		),
		agentSeed: parseJsonColumn<SessionConfig["agentSeed"]>(
			row.session_id,
			"agent_seed_json",
			row.agent_seed_json,
		),
		bootstrappedAt: row.bootstrapped_at ? parseD1Utc(row.bootstrapped_at, "session_configs") : null,
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
function parseJsonColumn<T>(
	sessionId: string,
	column: string,
	raw: string | null | undefined,
): T | undefined {
	// `undefined` shows up in tests whose mock rows omit a newly-added
	// column (e.g. pre-#188 fixtures that don't set `auth_json`). Treat
	// it the same as null — "column is absent" — rather than crashing
	// the read with a `JSON.parse(undefined)` SyntaxError. Production
	// rows always have the column after the ALTER TABLE migration runs.
	if (raw === null || raw === undefined) return undefined;
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

/**
 * Backward-compat repo-column rehydrator. The `repos_json` column was
 * introduced in PR #205 (185a) for an array shape `[{url, ref?}, …]`
 * but never populated by any frontend (no Repo tab UI shipped). #188
 * narrows the data model to a single repo (multi-repo deferred to
 * #197). Three shapes can be in the column at read time:
 *
 *   - `null`                          — no repo configured (common).
 *   - `{url, ref?, target?, …}`       — current single-object shape.
 *   - `[{url, ref?}, …]`              — legacy array placeholder. Take
 *                                       the first element if it
 *                                       conforms; otherwise drop.
 *
 * The single-object shape is NOT re-validated by Zod here — the row
 * was written by `persistSessionConfig` after the route ran
 * `validateSessionConfig`, so any object that landed in the column
 * already passed validation at that time. A future schema tightening
 * that invalidates an old row should ride a migration, not a silent
 * read-side reject.
 *
 * The `auth` presence check below is the only structural guard. It is
 * deliberately MINIMAL — sufficient for 188c's branching to find a
 * valid enum value, NOT sufficient to vouch for `url` / `target` /
 * `ref` having survived the wire-path schema (a row injected by a
 * direct D1 write or a partial-edit code path could carry e.g. a
 * `file://` URL that the route would have rejected). Treat the shape
 * returned here as "well-typed enough for the runner's switch
 * statement"; do not pass `repo.url` to `git clone` without
 * re-validating against `RepoSpec` if you are touching this on a path
 * that bypasses `validateSessionConfig`. PR #213 round 4 NIT.
 */
function parseRepoColumn(sessionId: string, raw: string | null): SessionConfig["repo"] | undefined {
	const parsed = parseJsonColumn<unknown>(sessionId, "repos_json", raw);
	if (parsed === undefined || parsed === null) return undefined;
	if (Array.isArray(parsed)) {
		// Legacy array shape. The placeholder allowed multiple repos
		// but no production data exercises it; promote first element
		// or drop. Defensive: a non-object element should not crash.
		const first = parsed[0];
		if (first && typeof first === "object") {
			// Default `auth: "none"` so the post-#188 RepoSpec invariant
			// (auth is required) holds at runtime, not just at the
			// type-checker layer. The legacy placeholder predates the
			// auth field; the only URL form the old allowlist accepted
			// was `https://` with no credentials, so `"none"` is the
			// semantically correct default. Spread order lets a future
			// migration that backfills `auth` win without further code
			// changes (PR #213 round 2 NIT).
			return { auth: "none", ...first } as SessionConfig["repo"];
		}
		logger.warn(
			`[sessionConfig] legacy repos_json array for session ${sessionId} has no usable first element; dropping`,
		);
		return undefined;
	}
	if (typeof parsed === "object") {
		// Defence-in-depth against a row written outside `persistSessionConfig`
		// (direct D1 write during incident response, future code path that
		// constructs the object partially). The legacy-array branch above
		// already drops malformed rows with a `logger.warn`; the post-#188
		// single-object branch should hold the same line. `auth` is the
		// only field required by the new schema, so its presence is the
		// minimal structural check (PR #213 round 3 NIT).
		if (!("auth" in (parsed as object))) {
			logger.warn(
				`[sessionConfig] repos_json for session ${sessionId} missing required 'auth' field; dropping`,
			);
			return undefined;
		}
		return parsed as SessionConfig["repo"];
	}
	logger.warn(
		`[sessionConfig] repos_json for session ${sessionId} parsed to non-array, non-object value; skipping`,
	);
	return undefined;
}

/**
 * Rehydrator for `auth_json`. Same defensive structural validation as
 * `parseEnvVarsColumn`: a write-capable D1 attacker who could tamper
 * with this column otherwise feeds garbage straight into
 * `decryptSecret`, which would throw on every spawn (effective DoS for
 * the session). Drop malformed entries with a logger warning instead.
 */
function parseAuthColumn(sessionId: string, raw: string | null): AuthStored | undefined {
	const parsed = parseJsonColumn<unknown>(sessionId, "auth_json", raw);
	if (parsed === undefined || parsed === null) return undefined;
	if (typeof parsed !== "object") {
		logger.warn(`[sessionConfig] auth_json for session ${sessionId} is not an object; skipping`);
		return undefined;
	}
	const obj = parsed as { pat?: unknown; ssh?: unknown };
	const out: AuthStored = {};
	if (obj.pat !== undefined) {
		if (isEncryptedBlob(obj.pat)) {
			out.pat = obj.pat;
		} else {
			logger.warn(
				`[sessionConfig] auth_json.pat for session ${sessionId} has wrong shape; dropping`,
			);
		}
	}
	if (obj.ssh !== undefined) {
		const ssh = obj.ssh as { privateKey?: unknown; knownHosts?: unknown };
		if (
			ssh !== null &&
			typeof ssh === "object" &&
			isEncryptedBlob(ssh.privateKey) &&
			typeof ssh.knownHosts === "string"
		) {
			out.ssh = {
				privateKey: ssh.privateKey,
				knownHosts: ssh.knownHosts,
			};
		} else {
			logger.warn(
				`[sessionConfig] auth_json.ssh for session ${sessionId} has wrong shape; dropping`,
			);
		}
	}
	return out.pat === undefined && out.ssh === undefined ? undefined : out;
}

function isEncryptedBlob(v: unknown): v is { ciphertext: string; iv: string; tag: string } {
	if (v === null || typeof v !== "object") return false;
	const o = v as { ciphertext?: unknown; iv?: unknown; tag?: unknown };
	return typeof o.ciphertext === "string" && typeof o.iv === "string" && typeof o.tag === "string";
}

/**
 * Shape `persistSessionConfig` accepts. Most fields match `SessionConfig`
 * directly; `envVars` is the post-encryption storage shape so the route
 * is the only place plaintext lives. Callers MUST run `validateSessionConfig`
 * + `encryptSecretEntries` first; this module's serializer trusts both.
 */
export type PersistableSessionConfig = Omit<SessionConfig, "envVars" | "auth"> & {
	envVars?: EnvVarEntryStored[];
	auth?: AuthStored;
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
                         repos_json, ports_json, allow_privileged_ports,
                         env_vars_json, auth_json,
                         git_identity_json, dotfiles_json, agent_seed_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(session_id) DO UPDATE SET
                        workspace_strategy     = excluded.workspace_strategy,
                        cpu_limit              = excluded.cpu_limit,
                        mem_limit              = excluded.mem_limit,
                        idle_ttl_seconds       = excluded.idle_ttl_seconds,
                        post_create_cmd        = excluded.post_create_cmd,
                        post_start_cmd         = excluded.post_start_cmd,
                        repos_json             = excluded.repos_json,
                        ports_json             = excluded.ports_json,
                        allow_privileged_ports = excluded.allow_privileged_ports,
                        env_vars_json          = excluded.env_vars_json,
                        auth_json              = excluded.auth_json,
                        git_identity_json      = excluded.git_identity_json,
                        dotfiles_json          = excluded.dotfiles_json,
                        agent_seed_json        = excluded.agent_seed_json`,
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
			//
			// `repo` lands in the `repos_json` column (singular value in
			// a column whose name pre-dates #188's data-model narrowing
			// from array to single — column kept to avoid a migration).
			jsonOrNull(config.repo),
			jsonOrNull(config.ports),
			// Only persist the toggle when explicitly set to true;
			// `false` and `undefined` both store NULL so we don't grow
			// the row with a column that defaults to "off everywhere"
			// for the 99 % of sessions that never expose privileged
			// ports. Mirrors the `=== 1 ? true : undefined` round-trip
			// in `rowToRecord`.
			config.allowPrivilegedPorts === true ? 1 : null,
			jsonOrNull(config.envVars),
			jsonOrNull(config.auth),
			jsonOrNull(config.gitIdentity),
			jsonOrNull(config.dotfiles),
			jsonOrNull(config.agentSeed),
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
