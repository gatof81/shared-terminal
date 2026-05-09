import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock d1Query before importing the module under test so the persistence
// helpers exercise the same code path as production without hitting D1.
const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({
		results: [] as unknown[],
		success: true as const,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	})),
}));
vi.mock("./db.js", () => dbStubs);

import {
	type AuthStored,
	decryptStoredAuth,
	decryptStoredEntries,
	encryptAuthCredentials,
	encryptSecretEntries,
	getSessionConfig,
	isEmptyConfig,
	persistSessionConfig,
	redactStoredAuth,
	redactStoredEntries,
	type SessionConfig,
	SessionConfigSchema,
	SessionConfigValidationError,
	validateSessionConfig,
} from "./sessionConfig.js";

beforeEach(() => {
	dbStubs.d1Query.mockReset();
	dbStubs.d1Query.mockImplementation(async () => ({
		results: [],
		success: true,
		meta: { changes: 0, duration: 0, last_row_id: 0 },
	}));
});

// Set the encryption key so encrypt/decrypt helpers exercise the real
// AES-GCM primitive in the round-trip tests below. 32 bytes of `0x42`
// is the same deterministic key the secrets.test.ts suite uses.
process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 0x42).toString("base64");

// ── Schema validation ─────────────────────────────────────────────────────

describe("validateSessionConfig", () => {
	it("returns undefined for an absent config (bare POST compatibility)", () => {
		expect(validateSessionConfig(undefined)).toBeUndefined();
		expect(validateSessionConfig(null)).toBeUndefined();
	});

	it("accepts a fully-populated config and returns the typed shape", () => {
		const raw = {
			workspaceStrategy: "clone",
			cpuLimit: 2_000_000_000,
			memLimit: 4 * 1024 * 1024 * 1024,
			idleTtlSeconds: 3600,
			postCreateCmd: "npm install",
			postStartCmd: "npm run dev",
			repo: {
				url: "https://github.com/example/repo",
				ref: "main",
				target: "frontend",
				auth: "none",
				depth: 1,
			},
			ports: [{ container: 3000, public: false }],
			envVars: [{ name: "FOO", type: "plain", value: "bar" }],
		};
		const got = validateSessionConfig(raw);
		expect(got).toEqual(raw);
	});

	it("accepts an empty config object", () => {
		expect(validateSessionConfig({})).toEqual({});
	});

	it("rejects unknown top-level keys with a precise error path", () => {
		expect(() => validateSessionConfig({ totallyBogusField: 1 })).toThrowError(
			SessionConfigValidationError,
		);
		try {
			validateSessionConfig({ totallyBogusField: 1 });
		} catch (err) {
			// `.strict()` on the schema flags unknown keys; we don't
			// pin the exact Zod message but assert the path includes
			// the offending key so a future Zod upgrade rephrasing
			// the message doesn't break this test.
			expect((err as SessionConfigValidationError).message).toMatch(/totallyBogusField/);
		}
	});

	it("rejects negative cpuLimit", () => {
		expect(() => validateSessionConfig({ cpuLimit: -1 })).toThrowError(
			SessionConfigValidationError,
		);
		try {
			validateSessionConfig({ cpuLimit: -1 });
		} catch (err) {
			expect((err as SessionConfigValidationError).path).toBe("config.cpuLimit");
		}
	});

	it("rejects an absurd memLimit", () => {
		expect(() => validateSessionConfig({ memLimit: Number.MAX_SAFE_INTEGER })).toThrowError(
			SessionConfigValidationError,
		);
	});

	it("rejects out-of-range port numbers", () => {
		expect(() => validateSessionConfig({ ports: [{ container: 0, public: false }] })).toThrowError(
			SessionConfigValidationError,
		);
		expect(() =>
			validateSessionConfig({ ports: [{ container: 70000, public: false }] }),
		).toThrowError(SessionConfigValidationError);
	});

	it("rejects port entries missing the public flag (no implicit default)", () => {
		expect(() => validateSessionConfig({ ports: [{ container: 3000 }] })).toThrowError(
			SessionConfigValidationError,
		);
	});

	it("rejects duplicate container ports with a precise per-element path", () => {
		try {
			validateSessionConfig({
				ports: [
					{ container: 3000, public: false },
					{ container: 3000, public: true },
				],
			});
			expect.fail("expected duplicate-container-port rejection");
		} catch (err) {
			expect(err).toBeInstanceOf(SessionConfigValidationError);
			// Path points at the duplicate index (1), not the original (0),
			// so the form can highlight the offending row.
			expect((err as SessionConfigValidationError).path).toBe("config.ports.1.container");
		}
	});

	it("rejects privileged ports without allowPrivilegedPorts: true", () => {
		expect(() => validateSessionConfig({ ports: [{ container: 80, public: false }] })).toThrowError(
			/privileged|allowPrivilegedPorts/,
		);
		expect(() =>
			validateSessionConfig({
				ports: [{ container: 80, public: false }],
				allowPrivilegedPorts: false,
			}),
		).toThrowError(/privileged|allowPrivilegedPorts/);
	});

	it("accepts privileged ports when allowPrivilegedPorts: true", () => {
		const got = validateSessionConfig({
			ports: [{ container: 80, public: true }],
			allowPrivilegedPorts: true,
		});
		expect(got?.ports).toEqual([{ container: 80, public: true }]);
		expect(got?.allowPrivilegedPorts).toBe(true);
	});

	it("allowPrivilegedPorts: true does not retroactively permit out-of-range ports", () => {
		// The toggle relaxes the < 1024 floor only. The 1-65535 range
		// stays enforced — a stray 0 / 70000 still fails on the field
		// validator before the cross-field refine is reached.
		expect(() =>
			validateSessionConfig({
				ports: [{ container: 70000, public: false }],
				allowPrivilegedPorts: true,
			}),
		).toThrowError(SessionConfigValidationError);
	});

	it("rejects unknown enum values for workspaceStrategy", () => {
		expect(() => validateSessionConfig({ workspaceStrategy: "wipe" })).toThrowError(
			SessionConfigValidationError,
		);
	});

	it("caps the number of ports", () => {
		const tooManyPorts = Array.from({ length: 21 }, (_, i) => ({
			container: 3000 + i,
			public: false,
		}));
		expect(() => validateSessionConfig({ ports: tooManyPorts })).toThrowError(
			SessionConfigValidationError,
		);
	});

	it("rejects a postCreateCmd above the size cap", () => {
		expect(() => validateSessionConfig({ postCreateCmd: "x".repeat(8 * 1024 + 1) })).toThrowError(
			SessionConfigValidationError,
		);
	});

	// Empty hook commands are indistinguishable from "no hook configured"
	// once stored — refuse them at ingest so the bootstrap runner in PR
	// 185b can use a presence-only check instead of a truthy check.
	it("rejects an empty postCreateCmd / postStartCmd", () => {
		expect(() => validateSessionConfig({ postCreateCmd: "" })).toThrowError(
			SessionConfigValidationError,
		);
		expect(() => validateSessionConfig({ postStartCmd: "" })).toThrowError(
			SessionConfigValidationError,
		);
	});

	// Empty `""` ref is now meaningful (= remote HEAD, no `--branch` flag).
	// The clone runner uses presence + non-empty as the predicate for
	// passing `--branch`, so an empty ref is a valid declarative value.
	it("accepts an empty repo ref (= remote HEAD)", () => {
		expect(
			validateSessionConfig({
				repo: { url: "https://example.com/r", ref: "", auth: "none" },
			}),
		).toBeDefined();
	});

	// Refnames that fail `git check-ref-format` (or look like a CLI flag
	// the runner could mis-interpret) are rejected — defence-in-depth
	// alongside the runner's argv-only invocation.
	it("rejects refs with traversal '..' or leading '-'", () => {
		for (const ref of ["..", "main/..", "-fexec", "--upload-pack=evil"]) {
			expect(() =>
				validateSessionConfig({
					repo: { url: "https://example.com/r", ref, auth: "none" },
				}),
			).toThrowError(SessionConfigValidationError);
		}
	});

	// Repo URL scheme allowlist — closes the file:// / ssh://-scheme hole.
	// The runner will hand these straight to `git clone`, so refusing them
	// at ingest is the only place this can be blocked without a duplicate
	// validator downstream.
	it("rejects repo URLs with disallowed schemes", () => {
		for (const url of [
			"http://example.com/r",
			"file:///etc/passwd",
			"ssh://attacker.example/r",
			"git://attacker.example:9418/r",
			"javascript:alert(1)",
		]) {
			expect(() => validateSessionConfig({ repo: { url, auth: "none" } })).toThrowError(
				SessionConfigValidationError,
			);
		}
	});

	it("rejects repo URLs that are not URLs at all", () => {
		expect(() =>
			validateSessionConfig({ repo: { url: "just-a-name", auth: "none" } }),
		).toThrowError(SessionConfigValidationError);
	});

	// PR #213 round 1 SHOULD-FIX: a URL like
	// `https://user:ghp_xxxx@github.com/o/p` would otherwise store the
	// PAT verbatim in `repos_json`, bypassing the AES-GCM encrypt-on-
	// persist that `auth_json` enforces. Reject `@` in HTTPS URLs at
	// the regex layer; users must put credentials through `auth.pat`.
	it("rejects HTTPS URLs with embedded user:password credentials", () => {
		for (const url of [
			"https://user:ghp_token@github.com/o/p",
			"https://user@github.com/o/p",
			"https://:secret@github.com/o/p",
		]) {
			for (const auth of ["none", "pat"] as const) {
				const config: { repo: { url: string; auth: "none" | "pat" }; auth?: object } = {
					repo: { url, auth },
				};
				if (auth === "pat") config.auth = { pat: "ghp_orphan" };
				expect(() => validateSessionConfig(config)).toThrowError(SessionConfigValidationError);
			}
		}
	});

	// PR #213 round 1 NIT: SSH URL path component allowed `..`
	// (`git@github.com:o/../etc`) — same uniform rejection as ref/target.
	it("rejects SSH URLs containing '..'", () => {
		expect(() =>
			validateSessionConfig({
				repo: { url: "git@github.com:o/../etc", auth: "ssh" },
				auth: { ssh: { privateKey: "k", knownHosts: "default" } },
			}),
		).toThrowError(SessionConfigValidationError);
	});

	// PR #213 round 3 NIT: `git@host:/abs/path` is an absolute-path
	// SSH clone target. Against a self-hosted intranet Git server
	// reachable from the container network, this is an SSRF widener
	// the regex previously accepted. Standard SCP-form URLs use a
	// relative path after the colon.
	it("rejects SSH URLs with leading '/' in the path component", () => {
		expect(() =>
			validateSessionConfig({
				repo: { url: "git@github.com:/etc/passwd", auth: "ssh" },
				auth: { ssh: { privateKey: "k", knownHosts: "default" } },
			}),
		).toThrowError(SessionConfigValidationError);
	});

	it("accepts https:// repo URLs", () => {
		expect(
			validateSessionConfig({
				repo: { url: "https://github.com/o/p", auth: "none" },
			}),
		).toBeDefined();
	});

	// #188: target validation — workspace-relative paths only. `..` and
	// leading `/` would let a clone target escape the bind-mounted
	// workspace; `//` is rejected as a defence-in-depth against a runner
	// that doesn't normalise.
	it("rejects target paths with '..' / leading '/' / '//'", () => {
		for (const target of ["../escape", "/abs", "a//b", "../"]) {
			expect(() =>
				validateSessionConfig({
					repo: { url: "https://example.com/r", target, auth: "none" },
				}),
			).toThrowError(SessionConfigValidationError);
		}
	});

	it("accepts an empty target (= workspace root) and a clean subpath", () => {
		for (const target of ["", "frontend", "services/api", "a/b/c.x"]) {
			expect(
				validateSessionConfig({
					repo: { url: "https://example.com/r", target, auth: "none" },
				}),
			).toBeDefined();
		}
	});

	// Cross-field repo↔auth consistency. The route reads these decisions
	// directly: a `git@…` URL with `auth: "none"` would fail mysteriously
	// inside the container, and PAT/SSH credentials with no matching
	// `repo` block would silently never be used.
	it("rejects repo.auth='pat' without auth.pat or with non-https URL", () => {
		expect(() =>
			validateSessionConfig({
				repo: { url: "https://example.com/r", auth: "pat" },
				// missing auth.pat
			}),
		).toThrowError(SessionConfigValidationError);
		expect(() =>
			validateSessionConfig({
				repo: { url: "git@github.com:o/p", auth: "pat" },
				auth: { pat: "ghp_xxx" },
			}),
		).toThrowError(SessionConfigValidationError);
	});

	it("rejects repo.auth='ssh' without auth.ssh or with non-git@ URL", () => {
		expect(() =>
			validateSessionConfig({
				repo: { url: "git@github.com:o/p", auth: "ssh" },
				// missing auth.ssh
			}),
		).toThrowError(SessionConfigValidationError);
		expect(() =>
			validateSessionConfig({
				repo: { url: "https://example.com/r", auth: "ssh" },
				auth: { ssh: { privateKey: "k", knownHosts: "default" } },
			}),
		).toThrowError(SessionConfigValidationError);
	});

	it("rejects credentials present when repo.auth='none'", () => {
		expect(() =>
			validateSessionConfig({
				repo: { url: "https://example.com/r", auth: "none" },
				auth: { pat: "ghp_orphan" },
			}),
		).toThrowError(SessionConfigValidationError);
	});

	// PR #213 round 3 NIT: `repo.auth='pat'` with a co-present
	// `auth.ssh` (or vice versa) would persist a stale credential
	// the runner never uses. Reject so the operator gets a clear
	// error instead of an undiagnosable encrypted blob.
	it("rejects co-present auth.ssh when repo.auth='pat'", () => {
		expect(() =>
			validateSessionConfig({
				repo: { url: "https://example.com/r", auth: "pat" },
				auth: {
					pat: "ghp_x",
					ssh: { privateKey: "k", knownHosts: "default" },
				},
			}),
		).toThrowError(SessionConfigValidationError);
	});

	it("rejects co-present auth.pat when repo.auth='ssh'", () => {
		expect(() =>
			validateSessionConfig({
				repo: { url: "git@github.com:o/p", auth: "ssh" },
				auth: {
					pat: "ghp_x",
					ssh: { privateKey: "k", knownHosts: "default" },
				},
			}),
		).toThrowError(SessionConfigValidationError);
	});

	it("rejects orphan credentials with no repo block", () => {
		expect(() => validateSessionConfig({ auth: { pat: "ghp_orphan" } })).toThrowError(
			SessionConfigValidationError,
		);
	});

	// PR #213 round 4 NIT: `repo: null` (explicit) and `repo` omitted
	// are semantically distinct on the wire, but the cross-field guard's
	// `if (result.data.repo)` predicate is falsy for both. Pin the
	// behaviour with a separate test so a future edit that swaps the
	// predicate for `if (result.data.repo !== undefined)` doesn't
	// silently start persisting orphan credentials when the client
	// sends `null` explicitly.
	it("rejects explicit repo:null with credentials", () => {
		expect(() => validateSessionConfig({ repo: null, auth: { pat: "ghp_x" } })).toThrowError(
			SessionConfigValidationError,
		);
	});

	// #188 PR 188d: PAT and SSH credential paths are now wired in the
	// runner. The 188c temporary guard that rejected `auth !== "none"`
	// at the route is removed; structurally-valid PAT/SSH configs flow
	// through validation and into the clone runner.
	it("accepts repo.auth='ssh' with matching git@ URL and ssh creds", () => {
		expect(
			validateSessionConfig({
				repo: { url: "git@github.com:o/p", auth: "ssh", target: "" },
				auth: {
					ssh: {
						privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\n…",
						knownHosts: "default",
					},
				},
			}),
		).toBeDefined();
	});

	it("accepts repo.auth='pat' with https:// URL and a PAT", () => {
		expect(
			validateSessionConfig({
				repo: { url: "https://example.com/r", auth: "pat" },
				auth: { pat: "ghp_validtoken" },
			}),
		).toBeDefined();
	});

	// ── #191 — gitIdentity / dotfiles / agentSeed ────────────────────────

	it("accepts gitIdentity with name + email", () => {
		expect(
			validateSessionConfig({
				gitIdentity: { name: "Ada Lovelace", email: "ada@example.com" },
			}),
		).toBeDefined();
	});

	it("rejects gitIdentity with malformed email", () => {
		for (const email of ["", "notanemail", "user@", "@host", "spaces in@email.com"]) {
			expect(() =>
				validateSessionConfig({
					gitIdentity: { name: "X", email },
				}),
			).toThrowError(SessionConfigValidationError);
		}
	});

	it("rejects gitIdentity with empty name", () => {
		expect(() =>
			validateSessionConfig({
				gitIdentity: { name: "", email: "a@b.com" },
			}),
		).toThrowError(SessionConfigValidationError);
	});

	// PR #217 round 1 SHOULD-FIX: a `\n` in `name` would corrupt
	// `~/.gitconfig` (INI format, newline-delimited records) when the
	// 191b stage runs `git config --global user.name "<name>"`. Reject
	// at the schema boundary so the runner doesn't need to defend at
	// the write site.
	it("rejects gitIdentity.name containing control characters", () => {
		for (const name of ["Ada\nuser.email = evil@evil.com", "X\rY", "X\tY", "X Y", "XY"]) {
			expect(() =>
				validateSessionConfig({
					gitIdentity: { name, email: "a@b.com" },
				}),
			).toThrowError(SessionConfigValidationError);
		}
	});

	// Defence: regular space (0x20) and printable Unicode are NOT
	// control chars. Names like "Ada Lovelace" or "François" must
	// keep working past the new control-char regex.
	it("accepts gitIdentity.name with spaces and printable Unicode", () => {
		for (const name of ["Ada Lovelace", "François", "李雷"]) {
			expect(
				validateSessionConfig({
					gitIdentity: { name, email: "a@b.com" },
				}),
			).toBeDefined();
		}
	});

	it("accepts dotfiles with bare URL (clone-only, no install script)", () => {
		expect(
			validateSessionConfig({
				dotfiles: { url: "https://github.com/user/dotfiles.git" },
			}),
		).toBeDefined();
	});

	it("accepts dotfiles with git@ URL + ref + installScript", () => {
		expect(
			validateSessionConfig({
				dotfiles: {
					url: "git@github.com:user/dotfiles.git",
					ref: "main",
					installScript: "install.sh",
				},
			}),
		).toBeDefined();
	});

	it("rejects dotfiles URL with disallowed scheme", () => {
		for (const url of ["http://example.com/r", "file:///etc", "ssh://attacker/r"]) {
			expect(() => validateSessionConfig({ dotfiles: { url } })).toThrowError(
				SessionConfigValidationError,
			);
		}
	});

	it("rejects dotfiles URL with embedded credentials (defends encryption boundary)", () => {
		expect(() =>
			validateSessionConfig({
				dotfiles: { url: "https://user:token@github.com/user/dotfiles" },
			}),
		).toThrowError(SessionConfigValidationError);
	});

	// Same path-traversal defence as `repo.target`. installScript ends
	// up as `/home/developer/dotfiles/<installScript>` inside the
	// container; `..` would let it escape the dotfiles tree.
	it("rejects dotfiles installScript with '..' / leading '/' / '//'", () => {
		for (const installScript of ["../escape", "/abs/path", "a//b", "../"]) {
			expect(() =>
				validateSessionConfig({
					dotfiles: { url: "https://example.com/r", installScript },
				}),
			).toThrowError(SessionConfigValidationError);
		}
	});

	it("accepts agentSeed with valid JSON settings + markdown CLAUDE.md", () => {
		expect(
			validateSessionConfig({
				agentSeed: {
					settings: '{"theme":"dark","editor":{"tabSize":2}}',
					claudeMd: "# Project notes\n- Use TS strict mode.\n",
				},
			}),
		).toBeDefined();
	});

	it("rejects agentSeed.settings that is not valid JSON", () => {
		expect(() =>
			validateSessionConfig({
				agentSeed: { settings: "{not json" },
			}),
		).toThrowError(SessionConfigValidationError);
	});

	it("accepts agentSeed.settings that is an empty string (no file written)", () => {
		// Empty string = wire-shape signal for "leave the file alone".
		// The bootstrap stage's `if (settings)` guard skips the write.
		expect(
			validateSessionConfig({
				agentSeed: { settings: "" },
			}),
		).toBeDefined();
	});

	it("rejects agentSeed bodies above the 256 KiB cap", () => {
		const big = "x".repeat(257 * 1024);
		expect(() => validateSessionConfig({ agentSeed: { settings: big } })).toThrowError(
			SessionConfigValidationError,
		);
		expect(() => validateSessionConfig({ agentSeed: { claudeMd: big } })).toThrowError(
			SessionConfigValidationError,
		);
	});

	// PR #217 round 1 SHOULD-FIX: Zod's `.max()` counts UTF-16 code
	// units, NOT UTF-8 bytes. A 4-byte-per-char string of 100 K
	// codepoints (e.g. 💥) is 400 K UTF-8 bytes (over the 256 KiB
	// cap) but only 200 K UTF-16 code units (under any naive
	// char-count cap). The Buffer.byteLength refine catches this
	// where `.max()` would have let it through.
	it("rejects agentSeed bodies whose UTF-8 byte size exceeds the cap (4-byte chars)", () => {
		const bigEmoji = "💥".repeat(100 * 1024); // 400 KiB UTF-8 bytes
		expect(() => validateSessionConfig({ agentSeed: { claudeMd: bigEmoji } })).toThrowError(
			SessionConfigValidationError,
		);
		expect(() => validateSessionConfig({ agentSeed: { settings: bigEmoji } })).toThrowError(
			SessionConfigValidationError,
		);
	});

	it("accepts null for gitIdentity / dotfiles / agentSeed (explicit-not-configured)", () => {
		expect(
			validateSessionConfig({
				gitIdentity: null,
				dotfiles: null,
				agentSeed: null,
			}),
		).toBeDefined();
	});

	// Depth bounds — out of [1, 10000]. A missing `depth` is allowed
	// (full history), so the lower bound has to fire on `0` and `-1`.
	it("rejects repo.depth out of bounds", () => {
		for (const depth of [0, -1, 10_001]) {
			expect(() =>
				validateSessionConfig({
					repo: { url: "https://example.com/r", auth: "none", depth },
				}),
			).toThrowError(SessionConfigValidationError);
		}
	});

	// envVars contents flow through validateEnvVars per-entry — POSIX
	// name format is also enforced by Zod regex (uppercase only), but
	// the denylist (PATH/LD_*/SESSION_ID/etc.) and NUL-byte rejection
	// fire from the existing `validateEnvVars` routine reused on the
	// new typed-array shape.
	it("rejects config.envVars entries with denylisted names (LD_PRELOAD)", () => {
		expect(() =>
			validateSessionConfig({
				envVars: [{ name: "LD_PRELOAD", type: "plain", value: "/evil.so" }],
			}),
		).toThrowError(SessionConfigValidationError);
	});

	it("rejects entry names that fail the uppercase POSIX regex", () => {
		// "BAD-KEY" has a dash and lowercase — fails the Zod regex
		// `/^[A-Z_][A-Z0-9_]*$/` enforced on each entry's name.
		expect(() =>
			validateSessionConfig({ envVars: [{ name: "BAD-KEY", type: "plain", value: "x" }] }),
		).toThrowError(SessionConfigValidationError);
	});

	it("rejects entry values containing NUL bytes", () => {
		expect(() =>
			validateSessionConfig({
				envVars: [{ name: "GOOD_NAME", type: "plain", value: "value\0withnul" }],
			}),
		).toThrowError(SessionConfigValidationError);
	});

	it("rejects entries exceeding the 64-entry cap", () => {
		const big = Array.from({ length: 65 }, (_, i) => ({
			name: `KEY_${i}`,
			type: "plain" as const,
			value: "v",
		}));
		expect(() => validateSessionConfig({ envVars: big })).toThrowError(
			SessionConfigValidationError,
		);
	});

	// Duplicate-name dedup fires inside validateSessionConfig (not in
	// Zod itself — discriminated unions don't dedup by a shared key).
	it("rejects duplicate entry names", () => {
		expect(() =>
			validateSessionConfig({
				envVars: [
					{ name: "FOO", type: "plain", value: "a" },
					{ name: "FOO", type: "plain", value: "b" },
				],
			}),
		).toThrowError(/duplicate entry name 'FOO'/);
	});

	// `secret-slot` is the template-load wire shape; never valid on
	// POST /sessions because there's no value to persist.
	it("rejects 'secret-slot' entries (template-load only)", () => {
		expect(() =>
			validateSessionConfig({ envVars: [{ name: "FOO", type: "secret-slot" }] }),
		).toThrowError(/secret-slot/);
	});

	it("rejects an empty secret value", () => {
		// Plain values can be empty (POSIX `KEY=`); secret values must
		// have content — an "empty secret" is meaningless and was
		// almost certainly a UX bug at the form layer.
		expect(() =>
			validateSessionConfig({ envVars: [{ name: "FOO", type: "secret", value: "" }] }),
		).toThrowError(SessionConfigValidationError);
	});

	it("attributes envVars validation errors to the config.envVars path", () => {
		try {
			validateSessionConfig({ envVars: [{ name: "PATH", type: "plain", value: "x" }] });
		} catch (err) {
			expect((err as SessionConfigValidationError).path).toBe("config.envVars");
			return;
		}
		throw new Error("expected throw");
	});

	// PR #210 round 1: legacy validateEnvVars enforces 128-char name
	// and 4096-char value caps; the typed path advertises 256 / 16 KiB
	// per the #186 spec. Pin that the typed caps actually take effect
	// (i.e. the targeted checkEnvVarSafety helper isn't re-applying
	// the legacy length limits).
	it("accepts entry names up to 256 chars (typed path cap, not legacy 128)", () => {
		const longName = "A".repeat(256);
		expect(
			validateSessionConfig({
				envVars: [{ name: longName, type: "plain", value: "x" }],
			}),
		).toBeDefined();
	});

	it("accepts entry values up to 16 KiB (typed path cap, not legacy 4096)", () => {
		// 5000 ASCII chars exceeds the legacy 4096 char cap but is
		// well under the typed-path 16 KiB byte cap. Validation must
		// accept; if validateEnvVars's length cap leaks into the
		// typed path again, this trips immediately.
		const fiveK = "x".repeat(5000);
		expect(
			validateSessionConfig({
				envVars: [{ name: "FOO", type: "plain", value: fiveK }],
			}),
		).toBeDefined();
	});

	it("rejects an entry list that exceeds the 256 KiB aggregate ceiling", () => {
		// Each entry: name ~3 chars + ~16 KiB value = ~16 KiB. 17
		// entries lands at ~272 KiB, over the cap. Lower-numbered
		// names so the regex passes (`E0`–`E9`, `EA`–`EG`).
		const entries = Array.from({ length: 17 }, (_, i) => ({
			name: `E${String.fromCharCode(0x41 + i)}`,
			type: "plain" as const,
			value: "x".repeat(16 * 1024),
		}));
		expect(() => validateSessionConfig({ envVars: entries })).toThrowError(/total size .+ exceeds/);
	});

	it("accepts a mixed plain + secret entry list", () => {
		const got = validateSessionConfig({
			envVars: [
				{ name: "FOO", type: "plain", value: "bar" },
				{ name: "API_KEY", type: "secret", value: "sk-test-1234" },
			],
		});
		expect(got?.envVars).toHaveLength(2);
	});
});

// ── isEmptyConfig ─────────────────────────────────────────────────────────

describe("isEmptyConfig", () => {
	it("returns true for an object with no defined fields", () => {
		expect(isEmptyConfig({} as SessionConfig)).toBe(true);
	});

	it("returns false when any field is defined", () => {
		expect(isEmptyConfig({ cpuLimit: 1 })).toBe(false);
		// An empty array is itself a defined value (jsonOrNull will
		// collapse it to NULL on the way to D1, but isEmptyConfig is
		// only the "skip the INSERT entirely" predicate).
		expect(isEmptyConfig({ envVars: [] })).toBe(false);
	});
});

// ── Persistence ──────────────────────────────────────────────────────────

describe("persistSessionConfig", () => {
	it("issues an UPSERT with the right column set", async () => {
		const config: SessionConfig = {
			cpuLimit: 1_000_000_000,
			postCreateCmd: "echo hi",
			repo: { url: "https://example.com/r", auth: "none" },
		};
		await persistSessionConfig("sess-1", config);
		expect(dbStubs.d1Query).toHaveBeenCalledTimes(1);
		const [sql, params] = dbStubs.d1Query.mock.calls[0]!;
		expect(sql).toMatch(/INSERT INTO session_configs/);
		expect(sql).toMatch(/ON CONFLICT\(session_id\) DO UPDATE/);
		// First param is the session id; structured fields land as their
		// scalar values; sub-records are JSON-serialised; absent fields
		// are passed as NULL so the UPSERT clears them on a re-bind.
		expect(params).toEqual([
			"sess-1",
			null, // workspace_strategy
			1_000_000_000, // cpu_limit
			null, // mem_limit
			null, // idle_ttl_seconds
			"echo hi", // post_create_cmd
			null, // post_start_cmd
			JSON.stringify({ url: "https://example.com/r", auth: "none" }),
			null, // ports_json
			null, // allow_privileged_ports (#190 PR 190a)
			null, // env_vars_json
			null, // auth_json
			null, // git_identity_json
			null, // dotfiles_json
			null, // agent_seed_json
		]);
	});

	// Invariant lock for the `bootstrapped_at` NULL-on-create gate that
	// PR 185b's bootstrap runner depends on. The column is nullable in
	// the DDL with no DEFAULT, and the INSERT column list deliberately
	// omits it — both must stay that way or the one-shot postCreate hook
	// would silently never fire (a data-loss-class regression).
	it("must NOT include bootstrapped_at in the INSERT column list", async () => {
		await persistSessionConfig("sess-bootstrap", { cpuLimit: 1 });
		const [sql, params] = dbStubs.d1Query.mock.calls[0]!;
		expect(sql).not.toMatch(/bootstrapped_at/);
		// Defensive cross-check: the params length must match the column
		// count, so a future caller adding bootstrapped_at to either side
		// without updating the other trips this assertion immediately.
		// 15 = sessionId + 14 column values (allow_privileged_ports
		// added in #190 PR 190a; git_identity_json / dotfiles_json /
		// agent_seed_json added in 191a).
		expect((params as unknown[]).length).toBe(15);
	});

	it("collapses empty array sub-records to NULL (no D1 row bloat)", async () => {
		await persistSessionConfig("sess-empty", {
			ports: [],
			envVars: [],
		});
		const [, params] = dbStubs.d1Query.mock.calls[0]!;
		// Position layout (post-#190 PR 190a):
		//   [7] repos_json, [8] ports_json, [9] allow_privileged_ports,
		//   [10] env_vars_json, [11] auth_json
		expect(params?.[7]).toBeNull();
		expect(params?.[8]).toBeNull();
		expect(params?.[9]).toBeNull();
		expect(params?.[10]).toBeNull();
		expect(params?.[11]).toBeNull();
	});

	it("serialises envVars + ports JSON columns (storage shape)", async () => {
		await persistSessionConfig("sess-2", {
			ports: [{ container: 3000, public: false }],
			// Already-encrypted storage shape — the route encrypts
			// before calling persistSessionConfig.
			envVars: [
				{ name: "FOO", type: "plain", value: "bar" },
				{
					name: "API_KEY",
					type: "secret",
					ciphertext: "ZW5jcnlwdGVk",
					iv: "MTIzNDU2Nzg5MDEy",
					tag: "MTIzNDU2Nzg5MDEyMzQ1Ng==",
				},
			],
		});
		const [, params] = dbStubs.d1Query.mock.calls[0]!;
		expect(params?.[8]).toBe(JSON.stringify([{ container: 3000, public: false }]));
		const envJson = JSON.parse(params?.[10] as string) as unknown[];
		expect(envJson).toHaveLength(2);
		expect(envJson[0]).toMatchObject({ name: "FOO", type: "plain", value: "bar" });
		expect(envJson[1]).toMatchObject({
			name: "API_KEY",
			type: "secret",
			ciphertext: "ZW5jcnlwdGVk",
		});
		// Critical: no `value` field on the secret row — only
		// ciphertext + iv + tag. A future serializer mistake that
		// re-introduces plaintext would trip this.
		expect(envJson[1]).not.toHaveProperty("value");
	});

	// PR #217 round 1 NIT: pin the wire shape of the three new
	// 191a columns. Without this, a future rename of a TS field
	// (`gitIdentity` → `identity`) would produce `jsonOrNull(undefined)
	// → null` — silent data loss while every existing test passes
	// because they all use null fixtures.
	it("serialises gitIdentity / dotfiles / agentSeed JSON columns (191a)", async () => {
		await persistSessionConfig("sess-191a", {
			gitIdentity: { name: "Ada Lovelace", email: "ada@example.com" },
			dotfiles: {
				url: "https://github.com/u/dotfiles.git",
				ref: "main",
				installScript: "install.sh",
			},
			agentSeed: { settings: '{"theme":"dark"}', claudeMd: "# notes" },
		});
		const [, params] = dbStubs.d1Query.mock.calls[0]!;
		// Post-#190 PR 190a positions:
		//   git_identity_json [12], dotfiles_json [13], agent_seed_json [14]
		// (allow_privileged_ports inserted at [9] shifts these by 1).
		expect(JSON.parse(params?.[12] as string)).toEqual({
			name: "Ada Lovelace",
			email: "ada@example.com",
		});
		expect(JSON.parse(params?.[13] as string)).toEqual({
			url: "https://github.com/u/dotfiles.git",
			ref: "main",
			installScript: "install.sh",
		});
		expect(JSON.parse(params?.[14] as string)).toEqual({
			settings: '{"theme":"dark"}',
			claudeMd: "# notes",
		});
	});

	// #190 PR 190a — pin the column position + 0/1 storage idiom for
	// `allow_privileged_ports` so a future column reordering or a sloppy
	// `Boolean(...)` (which would emit `false` and write 0 instead of
	// NULL) trips this.
	it("persists allowPrivilegedPorts as 1 only when explicitly true", async () => {
		await persistSessionConfig("sess-priv-on", {
			ports: [{ container: 80, public: true }],
			allowPrivilegedPorts: true,
		});
		expect(dbStubs.d1Query.mock.calls[0]?.[1]?.[9]).toBe(1);

		dbStubs.d1Query.mockClear();
		await persistSessionConfig("sess-priv-off", {
			ports: [{ container: 3000, public: false }],
			allowPrivilegedPorts: false,
		});
		expect(dbStubs.d1Query.mock.calls[0]?.[1]?.[9]).toBeNull();

		dbStubs.d1Query.mockClear();
		await persistSessionConfig("sess-priv-omitted", {
			ports: [{ container: 3000, public: false }],
		});
		expect(dbStubs.d1Query.mock.calls[0]?.[1]?.[9]).toBeNull();
	});
});

describe("getSessionConfig", () => {
	it("returns null when no row exists", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [],
			success: true,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		await expect(getSessionConfig("missing")).resolves.toBeNull();
	});

	it("rehydrates a stored row into the typed shape", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [
				{
					session_id: "sess-3",
					workspace_strategy: "preserve",
					cpu_limit: 2_000_000_000,
					mem_limit: null,
					idle_ttl_seconds: null,
					post_create_cmd: "npm i",
					post_start_cmd: null,
					repos_json: JSON.stringify({
						url: "https://example.com/r",
						auth: "none",
					}),
					ports_json: null,
					env_vars_json: JSON.stringify([{ name: "FOO", type: "plain", value: "bar" }]),
					auth_json: null,
					git_identity_json: null,
					dotfiles_json: null,
					agent_seed_json: null,
					bootstrapped_at: "2026-05-08 12:00:00",
				},
			],
			success: true as const,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		const got = await getSessionConfig("sess-3");
		expect(got).not.toBeNull();
		expect(got?.workspaceStrategy).toBe("preserve");
		expect(got?.cpuLimit).toBe(2_000_000_000);
		expect(got?.repo).toEqual({ url: "https://example.com/r", auth: "none" });
		expect(got?.envVars).toEqual([{ name: "FOO", type: "plain", value: "bar" }]);
		expect(got?.auth).toBeUndefined();
		// D1 returns suffix-less UTC; getter must not interpret as local.
		expect(got?.bootstrappedAt?.toISOString()).toBe("2026-05-08T12:00:00.000Z");
	});

	// #188 PR 188b — backward compat. The pre-188 `repos_json` column
	// stored an array placeholder; no production data uses it (no Repo
	// tab UI ever shipped before #188), but the rehydrator promotes a
	// legacy array to a single repo object so any pre-existing row from
	// a dev DB stays usable.
	it("promotes a legacy repos_json array to a single repo object", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [
				{
					session_id: "sess-legacy-repo",
					workspace_strategy: null,
					cpu_limit: null,
					mem_limit: null,
					idle_ttl_seconds: null,
					post_create_cmd: null,
					post_start_cmd: null,
					repos_json: JSON.stringify([
						{ url: "https://example.com/r", ref: "main" },
						{ url: "https://example.com/second" },
					]),
					ports_json: null,
					env_vars_json: null,
					auth_json: null,
					git_identity_json: null,
					dotfiles_json: null,
					agent_seed_json: null,
					bootstrapped_at: null,
				},
			],
			success: true as const,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		const got = await getSessionConfig("sess-legacy-repo");
		// First element wins; second is silently dropped (was a
		// placeholder shape that never populated in production).
		// `auth: "none"` is defaulted on promotion — pre-#188 rows had
		// no auth field, and the runtime invariant on `RepoSpec` requires
		// it to be set (PR #213 round 2 NIT).
		expect(got?.repo).toEqual({ url: "https://example.com/r", ref: "main", auth: "none" });
	});

	// PR #213 round 3 NIT: `parseRepoColumn` blind-cast a single-object
	// row even when it lacked the now-required `auth` field. Direct D1
	// writes (e.g. incident response) are the realistic source of such
	// rows. The runner would read `repo.auth: undefined` and silently
	// fall through every credential branch. Drop with a logger.warn.
	it("drops single-object repos_json missing the required 'auth' field", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [
				{
					session_id: "sess-repo-noauth",
					workspace_strategy: null,
					cpu_limit: null,
					mem_limit: null,
					idle_ttl_seconds: null,
					post_create_cmd: null,
					post_start_cmd: null,
					// Single-object shape but missing `auth` — could
					// happen via direct D1 write or a partial-edit code
					// path that doesn't go through validateSessionConfig.
					repos_json: JSON.stringify({ url: "https://example.com/r" }),
					ports_json: null,
					env_vars_json: null,
					auth_json: null,
					git_identity_json: null,
					dotfiles_json: null,
					agent_seed_json: null,
					bootstrapped_at: null,
				},
			],
			success: true as const,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		const got = await getSessionConfig("sess-repo-noauth");
		expect(got?.repo).toBeUndefined();
	});

	it("rehydrates auth_json with encrypted blobs intact", async () => {
		const encrypted: AuthStored = {
			pat: { ciphertext: "Y3Q=", iv: "MTIzNDU2Nzg5MDEy", tag: "MTIzNDU2Nzg5MDEyMzQ1Ng==" },
			ssh: {
				privateKey: {
					ciphertext: "a2V5",
					iv: "MTIzNDU2Nzg5MDEy",
					tag: "MTIzNDU2Nzg5MDEyMzQ1Ng==",
				},
				knownHosts: "default",
			},
		};
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [
				{
					session_id: "sess-auth",
					workspace_strategy: null,
					cpu_limit: null,
					mem_limit: null,
					idle_ttl_seconds: null,
					post_create_cmd: null,
					post_start_cmd: null,
					repos_json: null,
					ports_json: null,
					env_vars_json: null,
					auth_json: JSON.stringify(encrypted),
					bootstrapped_at: null,
				},
			],
			success: true as const,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		const got = await getSessionConfig("sess-auth");
		expect(got?.auth).toEqual(encrypted);
	});

	// Defence-in-depth: a hand-edited D1 row that drops one of
	// ciphertext/iv/tag must NOT reach the decrypt path — that would be
	// an effective DoS for the session (every spawn throws). Drop the
	// malformed credential with a logger warn instead.
	it("drops auth_json entries with missing iv/tag fields", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [
				{
					session_id: "sess-auth-bad",
					workspace_strategy: null,
					cpu_limit: null,
					mem_limit: null,
					idle_ttl_seconds: null,
					post_create_cmd: null,
					post_start_cmd: null,
					repos_json: null,
					ports_json: null,
					env_vars_json: null,
					auth_json: JSON.stringify({
						pat: { ciphertext: "Y3Q=" /* missing iv + tag */ },
					}),
					bootstrapped_at: null,
				},
			],
			success: true as const,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		const got = await getSessionConfig("sess-auth-bad");
		expect(got?.auth).toBeUndefined();
	});

	// PR 191a — gitIdentity / dotfiles / agentSeed rehydrate via the
	// generic `parseJsonColumn` (no special-case shim like repos_json
	// / env_vars_json have). Pin the round-trip so a future column
	// rename or schema-shape change can't silently drop them.
	it("rehydrates gitIdentity / dotfiles / agentSeed JSON blobs", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [
				{
					session_id: "sess-191",
					workspace_strategy: null,
					cpu_limit: null,
					mem_limit: null,
					idle_ttl_seconds: null,
					post_create_cmd: null,
					post_start_cmd: null,
					repos_json: null,
					ports_json: null,
					env_vars_json: null,
					auth_json: null,
					git_identity_json: JSON.stringify({
						name: "Ada Lovelace",
						email: "ada@example.com",
					}),
					dotfiles_json: JSON.stringify({
						url: "https://github.com/u/dotfiles.git",
						ref: "main",
						installScript: "install.sh",
					}),
					agent_seed_json: JSON.stringify({
						settings: '{"theme":"dark"}',
						claudeMd: "# notes\n",
					}),
					bootstrapped_at: null,
				},
			],
			success: true as const,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		const got = await getSessionConfig("sess-191");
		expect(got?.gitIdentity).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
		expect(got?.dotfiles).toEqual({
			url: "https://github.com/u/dotfiles.git",
			ref: "main",
			installScript: "install.sh",
		});
		expect(got?.agentSeed).toEqual({
			settings: '{"theme":"dark"}',
			claudeMd: "# notes\n",
		});
	});

	// PR #210 round 2 fix: `session_configs.env_vars_json` had a
	// pre-typed-shape that wrote `{"FOO":"bar"}` (plain Record). On
	// deploy with existing rows, the new code casted that object to
	// EnvVarEntryStored[] and dropped every env var because objects
	// have no `.length`. Backward-compat shim promotes legacy Records
	// to typed `plain` entries on the fly.
	// PR #210 round 3 fix: a hand-crafted D1 row that snuck a
	// `secret-slot` entry into storage, or a `secret` entry missing
	// ciphertext/iv/tag, must NOT reach the decrypt path — that
	// would let a write-capable D1 attacker DoS the session by
	// causing every spawn to throw. Filter at rehydration; log +
	// drop the bad entry; keep the good ones.
	it("filters out structurally-invalid array entries (defence against crafted D1 rows)", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [
				{
					session_id: "sess-bad-array",
					workspace_strategy: null,
					cpu_limit: null,
					mem_limit: null,
					idle_ttl_seconds: null,
					post_create_cmd: null,
					post_start_cmd: null,
					repos_json: null,
					ports_json: null,
					env_vars_json: JSON.stringify([
						// Valid plain — kept.
						{ name: "FOO", type: "plain", value: "bar" },
						// Valid secret — kept.
						{
							name: "API_KEY",
							type: "secret",
							ciphertext: "Y3Q=",
							iv: "MTIzNDU2Nzg5MDEy",
							tag: "MTIzNDU2Nzg5MDEyMzQ1Ng==",
						},
						// secret-slot in storage — must be dropped (the
						// decryptor would crash on the missing fields).
						{ name: "STRAY_SLOT", type: "secret-slot" },
						// Secret missing tag — must be dropped (the GCM
						// auth check would throw on every spawn).
						{ name: "BROKEN_SECRET", type: "secret", ciphertext: "Y3Q=", iv: "x" },
						// Plain missing value — must be dropped.
						{ name: "BROKEN_PLAIN", type: "plain" },
						// Wrong shape (no name) — dropped.
						{ type: "plain", value: "x" },
					]),
					bootstrapped_at: null,
				},
			],
			success: true as const,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		const got = await getSessionConfig("sess-bad-array");
		expect(got?.envVars).toHaveLength(2);
		expect(got?.envVars?.[0]).toMatchObject({ name: "FOO", type: "plain", value: "bar" });
		expect(got?.envVars?.[1]).toMatchObject({ name: "API_KEY", type: "secret" });
	});

	it("rehydrates legacy Record<string,string> env_vars_json into typed plain entries", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [
				{
					session_id: "sess-legacy",
					workspace_strategy: null,
					cpu_limit: null,
					mem_limit: null,
					idle_ttl_seconds: null,
					post_create_cmd: null,
					post_start_cmd: null,
					repos_json: null,
					ports_json: null,
					// Pre-typed shape: Record<string,string>.
					env_vars_json: JSON.stringify({ FOO: "bar", BAR: "baz" }),
					bootstrapped_at: null,
				},
			],
			success: true as const,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		const got = await getSessionConfig("sess-legacy");
		expect(got?.envVars).toEqual([
			{ name: "FOO", type: "plain", value: "bar" },
			{ name: "BAR", type: "plain", value: "baz" },
		]);
	});

	it("skips non-string values in legacy Record env_vars_json without throwing", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [
				{
					session_id: "sess-mixed",
					workspace_strategy: null,
					cpu_limit: null,
					mem_limit: null,
					idle_ttl_seconds: null,
					post_create_cmd: null,
					post_start_cmd: null,
					repos_json: null,
					ports_json: null,
					env_vars_json: JSON.stringify({ FOO: "bar", BAD: 42 }),
					bootstrapped_at: null,
				},
			],
			success: true as const,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		const got = await getSessionConfig("sess-mixed");
		// FOO survives; BAD (numeric) is logged + skipped rather than
		// crashing the spawn path. Defensive against a future migration
		// that wrote a non-string by mistake.
		expect(got?.envVars).toEqual([{ name: "FOO", type: "plain", value: "bar" }]);
	});

	it("degrades malformed JSON columns to undefined instead of throwing", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [
				{
					session_id: "sess-bad-json",
					workspace_strategy: null,
					cpu_limit: null,
					mem_limit: null,
					idle_ttl_seconds: null,
					post_create_cmd: null,
					post_start_cmd: null,
					// All four JSON columns deliberately broken — a direct
					// SQL write or migration corruption is the only way to
					// reach this state, and the row should still be readable.
					repos_json: "{not json",
					ports_json: "[oh no",
					env_vars_json: "definitely not",
					auth_json: "}also broken",
					bootstrapped_at: null,
				},
			],
			success: true as const,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		const got = await getSessionConfig("sess-bad-json");
		expect(got).not.toBeNull();
		expect(got?.repo).toBeUndefined();
		expect(got?.ports).toBeUndefined();
		expect(got?.envVars).toBeUndefined();
		expect(got?.auth).toBeUndefined();
	});

	it("treats unknown workspace_strategy values as undefined (defence-in-depth)", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [
				{
					session_id: "sess-4",
					workspace_strategy: "weird-future-value",
					cpu_limit: null,
					mem_limit: null,
					idle_ttl_seconds: null,
					post_create_cmd: null,
					post_start_cmd: null,
					repos_json: null,
					ports_json: null,
					env_vars_json: null,
					auth_json: null,
					git_identity_json: null,
					dotfiles_json: null,
					agent_seed_json: null,
					bootstrapped_at: null,
				},
			],
			success: true as const,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		const got = await getSessionConfig("sess-4");
		expect(got?.workspaceStrategy).toBeUndefined();
	});

	// #190 PR 190a — round-trip allow_privileged_ports through D1.
	// Stored 1 → rehydrates as `true`; stored 0 (a possible value if a
	// future operator runs `UPDATE … SET allow_privileged_ports = 0`)
	// or NULL both rehydrate as `undefined` so consumers can rely on
	// `=== true` checks.
	it("rehydrates allow_privileged_ports: 1 to allowPrivilegedPorts: true", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [
				{
					session_id: "sess-priv",
					workspace_strategy: null,
					cpu_limit: null,
					mem_limit: null,
					idle_ttl_seconds: null,
					post_create_cmd: null,
					post_start_cmd: null,
					repos_json: null,
					ports_json: JSON.stringify([{ container: 80, public: true }]),
					allow_privileged_ports: 1,
					env_vars_json: null,
					auth_json: null,
					git_identity_json: null,
					dotfiles_json: null,
					agent_seed_json: null,
					bootstrapped_at: null,
				},
			],
			success: true as const,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		const got = await getSessionConfig("sess-priv");
		expect(got?.allowPrivilegedPorts).toBe(true);
		expect(got?.ports).toEqual([{ container: 80, public: true }]);
	});

	it("rehydrates allow_privileged_ports: null to undefined", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [
				{
					session_id: "sess-priv-null",
					workspace_strategy: null,
					cpu_limit: null,
					mem_limit: null,
					idle_ttl_seconds: null,
					post_create_cmd: null,
					post_start_cmd: null,
					repos_json: null,
					ports_json: null,
					allow_privileged_ports: null,
					env_vars_json: null,
					auth_json: null,
					git_identity_json: null,
					dotfiles_json: null,
					agent_seed_json: null,
					bootstrapped_at: null,
				},
			],
			success: true as const,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		const got = await getSessionConfig("sess-priv-null");
		expect(got?.allowPrivilegedPorts).toBeUndefined();
	});

	it("rehydrates allow_privileged_ports: 0 to undefined (=== true safety)", async () => {
		dbStubs.d1Query.mockImplementationOnce(async () => ({
			results: [
				{
					session_id: "sess-priv-zero",
					workspace_strategy: null,
					cpu_limit: null,
					mem_limit: null,
					idle_ttl_seconds: null,
					post_create_cmd: null,
					post_start_cmd: null,
					repos_json: null,
					ports_json: null,
					allow_privileged_ports: 0,
					env_vars_json: null,
					auth_json: null,
					git_identity_json: null,
					dotfiles_json: null,
					agent_seed_json: null,
					bootstrapped_at: null,
				},
			],
			success: true as const,
			meta: { changes: 0, duration: 0, last_row_id: 0 },
		}));
		const got = await getSessionConfig("sess-priv-zero");
		expect(got?.allowPrivilegedPorts).toBeUndefined();
	});
});

// ── Schema export ────────────────────────────────────────────────────────

describe("SessionConfigSchema export", () => {
	it("is reusable for fragment validation in tests / future child issues", () => {
		// Smoke check: parsing through the bare schema (skipping the
		// validateSessionConfig wrapper) yields the same data shape.
		const r = SessionConfigSchema.safeParse({ cpuLimit: 1 });
		expect(r.success).toBe(true);
	});
});

// ── Encrypt / decrypt / redact round-trip (PR #210 round 4) ──────────────

describe("encryptSecretEntries / decryptStoredEntries / redactStoredEntries", () => {
	it("round-trips secret values via real AES-GCM (no hardcoded ciphertext)", () => {
		// The secrets.test.ts suite covers the raw AES-GCM primitive;
		// this test pins the wiring — encryptSecretEntries produces a
		// shape decryptStoredEntries can rehydrate, and the recovered
		// plaintext matches.
		const stored = encryptSecretEntries([
			{ name: "FOO", type: "plain", value: "bar" },
			{ name: "API_KEY", type: "secret", value: "sk-test-1234" },
			{ name: "DB_PASSWORD", type: "secret", value: "p@ssw0rd!" },
		]);
		expect(stored).toHaveLength(3);
		// Plain pass-through.
		expect(stored[0]).toEqual({ name: "FOO", type: "plain", value: "bar" });
		// Secret rows: no `value`, all three crypto fields populated.
		expect(stored[1]).toMatchObject({ name: "API_KEY", type: "secret" });
		expect(stored[1]).not.toHaveProperty("value");
		expect((stored[1] as { ciphertext?: string }).ciphertext).toBeTruthy();
		expect((stored[1] as { iv?: string }).iv).toBeTruthy();
		expect((stored[1] as { tag?: string }).tag).toBeTruthy();
		// Round-trip: recovered plaintext map matches the original
		// inputs across both plain and secret rows.
		const decrypted = decryptStoredEntries(stored);
		expect(decrypted).toEqual({
			FOO: "bar",
			API_KEY: "sk-test-1234",
			DB_PASSWORD: "p@ssw0rd!",
		});
	});

	it("redactStoredEntries collapses secret rows to { name, type, isSet: true }", () => {
		const stored = encryptSecretEntries([
			{ name: "FOO", type: "plain", value: "bar" },
			{ name: "API_KEY", type: "secret", value: "sk-test-1234" },
		]);
		const publicShape = redactStoredEntries(stored);
		expect(publicShape).toHaveLength(2);
		// Plain entry passes through verbatim.
		expect(publicShape[0]).toEqual({ name: "FOO", type: "plain", value: "bar" });
		// Secret entry: NO ciphertext, iv, or tag in the public shape.
		expect(publicShape[1]).toEqual({ name: "API_KEY", type: "secret", isSet: true });
		expect(publicShape[1]).not.toHaveProperty("ciphertext");
		expect(publicShape[1]).not.toHaveProperty("iv");
		expect(publicShape[1]).not.toHaveProperty("tag");
		expect(publicShape[1]).not.toHaveProperty("value");
	});

	it("decryptStoredEntries throws on a tampered secret entry (GCM auth tag)", () => {
		const stored = encryptSecretEntries([{ name: "K", type: "secret", value: "v" }]);
		const tampered = stored.map((e) => {
			if (e.type !== "secret") return e;
			// Flip the last byte of the tag — auth check fails.
			const tagBytes = Buffer.from(e.tag, "base64");
			tagBytes[tagBytes.length - 1] ^= 0x01;
			return { ...e, tag: tagBytes.toString("base64") };
		});
		expect(() => decryptStoredEntries(tampered)).toThrow();
	});
});

// ── Auth-blob encrypt / decrypt / redact round-trip (#188 PR 188b) ───────

describe("encryptAuthCredentials / decryptStoredAuth / redactStoredAuth", () => {
	it("returns undefined for an empty / absent input (column collapses to NULL)", () => {
		expect(encryptAuthCredentials(undefined)).toBeUndefined();
		expect(encryptAuthCredentials({})).toBeUndefined();
	});

	it("round-trips a PAT credential via real AES-GCM", () => {
		const stored = encryptAuthCredentials({ pat: "ghp_secrettoken_1234567890" });
		expect(stored).toBeDefined();
		expect(stored?.pat).toBeDefined();
		// Storage shape: only ciphertext + iv + tag — no plaintext.
		expect(stored?.pat).not.toHaveProperty("value");
		expect(stored?.pat?.ciphertext).toBeTruthy();
		expect(stored?.pat?.iv).toBeTruthy();
		expect(stored?.pat?.tag).toBeTruthy();
		// Round-trip recovers the original plaintext.
		const back = decryptStoredAuth(stored!);
		expect(back.pat).toBe("ghp_secrettoken_1234567890");
		expect(back.ssh).toBeUndefined();
	});

	it("round-trips an SSH credential and preserves knownHosts verbatim", () => {
		const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nbase64bytes\n-----END\n";
		const knownHosts = "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5...";
		const stored = encryptAuthCredentials({
			ssh: { privateKey, knownHosts },
		});
		expect(stored?.ssh).toBeDefined();
		// knownHosts is public — stored verbatim, NOT encrypted.
		expect(stored?.ssh?.knownHosts).toBe(knownHosts);
		// privateKey is encrypted: ciphertext envelope, no plaintext.
		expect(stored?.ssh?.privateKey).toMatchObject({
			ciphertext: expect.any(String),
			iv: expect.any(String),
			tag: expect.any(String),
		});
		const back = decryptStoredAuth(stored!);
		expect(back.ssh?.privateKey).toBe(privateKey);
		expect(back.ssh?.knownHosts).toBe(knownHosts);
	});

	it("decryptStoredAuth throws on a tampered ciphertext (GCM auth tag)", () => {
		const stored = encryptAuthCredentials({ pat: "ghp_token" });
		// Flip the last byte of the tag — auth check fails.
		const tagBytes = Buffer.from(stored!.pat!.tag, "base64");
		tagBytes[tagBytes.length - 1] ^= 0x01;
		const tampered: AuthStored = {
			pat: { ...stored!.pat!, tag: tagBytes.toString("base64") },
		};
		expect(() => decryptStoredAuth(tampered)).toThrow();
	});

	it("redactStoredAuth collapses pat / ssh.privateKey to { isSet: true } and keeps knownHosts visible", () => {
		const stored = encryptAuthCredentials({
			pat: "ghp_token",
			ssh: { privateKey: "secretkey", knownHosts: "default" },
		});
		const redacted = redactStoredAuth(stored);
		expect(redacted).toEqual({
			pat: { isSet: true },
			ssh: { isSet: true, knownHosts: "default" },
		});
		// Defensive: no encrypted material survives the redact.
		expect(JSON.stringify(redacted)).not.toMatch(/ciphertext|iv|tag|secretkey/);
	});

	it("redactStoredAuth returns undefined for undefined input", () => {
		expect(redactStoredAuth(undefined)).toBeUndefined();
	});

	// PR #213 round 1 NIT: parity with `parseAuthColumn`. An `AuthStored`
	// with neither `pat` nor `ssh` set must collapse to undefined so a
	// future GET-config endpoint can use `auth !== undefined` as the
	// "credentials configured?" predicate.
	it("redactStoredAuth collapses an empty AuthStored to undefined", () => {
		expect(redactStoredAuth({})).toBeUndefined();
	});
});
