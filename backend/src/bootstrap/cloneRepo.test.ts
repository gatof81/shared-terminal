import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Set the encryption key BEFORE importing the module — `decryptStoredAuth`
// (called transitively from runCloneRepo) imports `secrets.js` at module-
// load time, and that module reads SECRETS_ENCRYPTION_KEY from env.
process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 0x42).toString("base64");

import type { DockerManager } from "../dockerManager.js";
import { encryptAuthCredentials, type SessionConfigRecord } from "../sessionConfig.js";
import {
	buildCloneArgv,
	CloneCredentialMissingError,
	NOAUTH_CLONE_SCRIPT,
	PAT_CLONE_SCRIPT,
	patEnv,
	resolveTargetAbsPath,
	runCloneRepo,
	SSH_CLONE_SCRIPT,
	sshEnv,
} from "./cloneRepo.js";
import { KNOWN_HOSTS_DEFAULT_BUNDLE } from "./knownHosts.js";

// ── buildCloneArgv ───────────────────────────────────────────────────────

describe("buildCloneArgv", () => {
	it("emits the minimal `git clone -- <url> <target>` form when no ref/depth", () => {
		expect(
			buildCloneArgv("https://example.com/r", undefined, undefined, "/home/developer/workspace"),
		).toEqual(["git", "clone", "--", "https://example.com/r", "/home/developer/workspace"]);
	});

	it("appends --branch when ref is non-empty", () => {
		expect(
			buildCloneArgv("https://example.com/r", "main", undefined, "/home/developer/workspace/sub"),
		).toEqual([
			"git",
			"clone",
			"--branch",
			"main",
			"--",
			"https://example.com/r",
			"/home/developer/workspace/sub",
		]);
	});

	// `ref === ""` is a wire-shape signal for "use remote HEAD". Must NOT
	// produce `--branch ""` — that crashes git with "fatal: Remote branch
	// not found". The runner reads the absent flag as "skip --branch",
	// matching the schema's intent.
	it("treats empty ref as 'use remote HEAD' (no --branch)", () => {
		expect(
			buildCloneArgv("https://example.com/r", "", undefined, "/home/developer/workspace"),
		).toEqual(["git", "clone", "--", "https://example.com/r", "/home/developer/workspace"]);
	});

	it("appends --depth when depth is set", () => {
		expect(
			buildCloneArgv("https://example.com/r", undefined, 1, "/home/developer/workspace"),
		).toEqual([
			"git",
			"clone",
			"--depth",
			"1",
			"--",
			"https://example.com/r",
			"/home/developer/workspace",
		]);
	});

	// `null` and `undefined` are both "no shallow"; both must skip the
	// --depth flag. The schema models depth as `nullable().optional()`
	// so both shapes can land in the runner.
	it("skips --depth for both null and undefined", () => {
		const noDepthForNull = buildCloneArgv(
			"https://example.com/r",
			undefined,
			null,
			"/home/developer/workspace",
		);
		const noDepthForUndef = buildCloneArgv(
			"https://example.com/r",
			undefined,
			undefined,
			"/home/developer/workspace",
		);
		expect(noDepthForNull).toEqual(noDepthForUndef);
		expect(noDepthForNull).not.toContain("--depth");
	});

	// `--` separator must precede positional args so a future ref like
	// `--evil` (already blocked at the schema layer with a leading `-`
	// reject, but defence-in-depth) cannot be re-interpreted as a flag.
	it("places '--' before the URL/target positional pair", () => {
		const argv = buildCloneArgv("https://example.com/r", "main", 5, "/path");
		const dashIdx = argv.indexOf("--");
		const urlIdx = argv.indexOf("https://example.com/r");
		expect(dashIdx).toBeGreaterThan(-1);
		expect(urlIdx).toBeGreaterThan(dashIdx);
	});
});

// ── resolveTargetAbsPath ─────────────────────────────────────────────────

describe("resolveTargetAbsPath", () => {
	it("maps undefined target to the workspace root", () => {
		expect(resolveTargetAbsPath(undefined)).toBe("/home/developer/workspace");
	});

	it("maps empty target to the workspace root (replace-workspace mode)", () => {
		expect(resolveTargetAbsPath("")).toBe("/home/developer/workspace");
	});

	it("appends a non-empty target to the workspace root", () => {
		expect(resolveTargetAbsPath("frontend")).toBe("/home/developer/workspace/frontend");
		expect(resolveTargetAbsPath("services/api")).toBe("/home/developer/workspace/services/api");
	});
});

// ── runCloneRepo ─────────────────────────────────────────────────────────

describe("runCloneRepo", () => {
	let docker: { streamExec: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		docker = { streamExec: vi.fn(async () => ({ exitCode: 0 })) };
	});

	function makeConfig(overrides: Partial<SessionConfigRecord> = {}): SessionConfigRecord {
		return {
			sessionId: "sess-1",
			bootstrappedAt: null,
			...overrides,
		};
	}

	it("returns exitCode 0 and never calls streamExec when no repo configured", async () => {
		const result = await runCloneRepo({
			sessionId: "sess-1",
			config: makeConfig(),
			docker: docker as unknown as DockerManager,
		});
		expect(result).toEqual({ exitCode: 0 });
		expect(docker.streamExec).not.toHaveBeenCalled();
	});

	it("invokes streamExec with the no-auth clone bash script and env-encoded values (#254)", async () => {
		await runCloneRepo({
			sessionId: "sess-1",
			config: makeConfig({
				repo: { url: "https://example.com/r", ref: "main", auth: "none", depth: 1 },
			}),
			docker: docker as unknown as DockerManager,
		});
		expect(docker.streamExec).toHaveBeenCalledTimes(1);
		const [sessionId, opts] = docker.streamExec.mock.calls[0]!;
		expect(sessionId).toBe("sess-1");
		// Shell-mode (#254): no-auth now uses `bash -c <NOAUTH_CLONE_SCRIPT>`
		// so the clone-into-temp + move-into-target flow works even when the
		// workspace is non-empty (entrypoint.sh seeds .npm-global before
		// bootstrap runs).
		expect(opts.cmd[0]).toBe("bash");
		expect(opts.cmd[1]).toBe("-c");
		// User values reach git via env vars, NOT via shell-interpolated
		// argv strings — same security model as PAT/SSH. A schema regex
		// already blocks `;` in URLs (#213), but env-encoding is the
		// load-bearing layer for any value that slips past the regex.
		expect(opts.env).toEqual({
			ST_URL: "https://example.com/r",
			ST_REF: "main",
			ST_DEPTH: "1",
			ST_TARGET_ABS: "/home/developer/workspace",
		});
		expect(opts.workingDir).toBe("/home/developer/workspace");
	});

	it("env-encodes user values (no shell-interpolation in argv)", async () => {
		// Switched to shell-mode (#254) but the security model is the same:
		// user values land in env, the script references them double-quoted,
		// so shell-meta is inert. argv contains only `bash -c <script>` —
		// no user-controlled strings.
		await runCloneRepo({
			sessionId: "sess-1",
			config: makeConfig({
				repo: { url: "https://example.com/r", auth: "none" },
			}),
			docker: docker as unknown as DockerManager,
		});
		const [, opts] = docker.streamExec.mock.calls[0]!;
		// argv has exactly 3 entries — bash, -c, the static script body.
		// Anything else would indicate a regression that re-introduced
		// shell-interpolated argv.
		expect(opts.cmd).toHaveLength(3);
		expect(opts.cmd[0]).toBe("bash");
		expect(opts.cmd[1]).toBe("-c");
		expect(opts.cmd[2]).not.toContain("https://example.com/r");
		expect(opts.env?.ST_URL).toBe("https://example.com/r");
	});

	it("env-encodes the target as a subdir when target is set", async () => {
		await runCloneRepo({
			sessionId: "sess-1",
			config: makeConfig({
				repo: {
					url: "https://example.com/r",
					target: "services/api",
					auth: "none",
				},
			}),
			docker: docker as unknown as DockerManager,
		});
		const [, opts] = docker.streamExec.mock.calls[0]!;
		expect(opts.env?.ST_TARGET_ABS).toBe("/home/developer/workspace/services/api");
	});

	// Empty target → workspace root. The clone-then-move script (#254)
	// makes this case work even though the workspace is non-empty due to
	// the entrypoint-seeded .npm-global directory.
	it("env-encodes the target as the workspace root when target is empty", async () => {
		await runCloneRepo({
			sessionId: "sess-1",
			config: makeConfig({
				repo: { url: "https://example.com/r", target: "", auth: "none" },
			}),
			docker: docker as unknown as DockerManager,
		});
		const [, opts] = docker.streamExec.mock.calls[0]!;
		expect(opts.env?.ST_TARGET_ABS).toBe("/home/developer/workspace");
	});

	// ── #188 PR 188d — PAT auth path ───────────────────────────────────────

	// PAT must NEVER appear in the bash command argv (process listings)
	// or in the resulting `.git/config`. The runner uses a `GIT_ASKPASS`
	// shim that reads the token from an env var; the env block is the
	// ONLY place the plaintext is allowed.
	it("PAT auth: token lands in env, never in argv", async () => {
		const stored = encryptAuthCredentials({ pat: "ghp_test_TOKEN_DEADBEEF" });
		await runCloneRepo({
			sessionId: "sess-1",
			config: makeConfig({
				repo: { url: "https://example.com/r", auth: "pat" },
				auth: stored,
			}),
			docker: docker as unknown as DockerManager,
		});
		expect(docker.streamExec).toHaveBeenCalledTimes(1);
		const [, opts] = docker.streamExec.mock.calls[0]!;
		// PAT must NOT appear in argv anywhere — argv is what shows up in
		// host-side `ps` output via dockerd's exec subprocess.
		const argvJoined = (opts.cmd as string[]).join(" ");
		expect(argvJoined).not.toContain("ghp_test_TOKEN_DEADBEEF");
		// PAT lives in env (visible to operators with `docker inspect`,
		// not to host `ps`). This is the documented trade-off.
		expect(opts.env).toMatchObject({ ST_PAT: "ghp_test_TOKEN_DEADBEEF" });
	});

	// argv shape: bash + script. The runner's PAT path is shell-mode
	// (multi-step setup) but every user-controlled value reaches the
	// shell via env var, NOT via shell-interpolation, so shell-meta
	// in any of them is inert.
	it("PAT auth: invokes bash with the canonical PAT_CLONE_SCRIPT", async () => {
		const stored = encryptAuthCredentials({ pat: "ghp_x" });
		await runCloneRepo({
			sessionId: "sess-1",
			config: makeConfig({
				repo: { url: "https://example.com/r", auth: "pat" },
				auth: stored,
			}),
			docker: docker as unknown as DockerManager,
		});
		const [, opts] = docker.streamExec.mock.calls[0]!;
		expect(opts.cmd[0]).toBe("bash");
		expect(opts.cmd[1]).toBe("-c");
		expect(opts.cmd[2]).toBe(PAT_CLONE_SCRIPT);
	});

	// User values reach the bash script via env. The script reads each
	// with `"$ST_*"` double-quoted, so even if a value contained shell
	// meta the shell would treat it as a single argument.
	it("PAT auth: env block contains all user values + target absolute path", async () => {
		const stored = encryptAuthCredentials({ pat: "ghp_x" });
		await runCloneRepo({
			sessionId: "sess-1",
			config: makeConfig({
				repo: {
					url: "https://example.com/r",
					ref: "main",
					depth: 1,
					target: "frontend",
					auth: "pat",
				},
				auth: stored,
			}),
			docker: docker as unknown as DockerManager,
		});
		const [, opts] = docker.streamExec.mock.calls[0]!;
		expect(opts.env).toEqual({
			ST_PAT: "ghp_x",
			ST_URL: "https://example.com/r",
			ST_REF: "main",
			ST_DEPTH: "1",
			ST_TARGET_ABS: "/home/developer/workspace/frontend",
		});
	});

	// Defence-in-depth: a config where `repo.auth: "pat"` was persisted
	// but `auth.pat` is missing (e.g. direct D1 write that bypassed the
	// route's cross-field check) must throw rather than silently fall
	// back to anonymous.
	it("PAT auth: throws CloneCredentialMissingError when auth.pat absent", async () => {
		await expect(
			runCloneRepo({
				sessionId: "sess-1",
				config: makeConfig({
					repo: { url: "https://example.com/r", auth: "pat" },
					auth: undefined,
				}),
				docker: docker as unknown as DockerManager,
			}),
		).rejects.toBeInstanceOf(CloneCredentialMissingError);
		expect(docker.streamExec).not.toHaveBeenCalled();
	});

	// Script integrity check: the PAT script must include the cleanup
	// trap that shreds the askpass file on exit. Pinning the marker so a
	// future edit that drops it (and lets the PAT-printing shim survive
	// past the clone) trips this assertion immediately.
	it("PAT_CLONE_SCRIPT contains the askpass-cleanup trap", () => {
		expect(PAT_CLONE_SCRIPT).toContain("trap cleanup EXIT");
		expect(PAT_CLONE_SCRIPT).toContain('rm -f "$ASKPASS_PATH"');
		// `GIT_TERMINAL_PROMPT=0` so a remote that rejects the PAT can't
		// hang the bootstrap on a stdin prompt. Pinning so the PR
		// doesn't accidentally remove the env it sets.
		expect(PAT_CLONE_SCRIPT).toContain("GIT_TERMINAL_PROMPT=0");
	});

	// ── #254 — clone-and-move shape on all three scripts ───────────────────
	//
	// The temp-clone + mv-into-target flow is what makes a clone-into-
	// workspace-root succeed when entrypoint.sh has already seeded
	// .npm-global. Pin the marker fragments so a future edit that drops
	// the temp redirection (and re-introduces `git clone <url> $TARGET`
	// against a non-empty workspace) trips this assertion immediately.

	it("all three clone scripts use temp+move into target (#254)", () => {
		for (const script of [NOAUTH_CLONE_SCRIPT, PAT_CLONE_SCRIPT, SSH_CLONE_SCRIPT]) {
			// Clone destination is the temp dir, NOT the target — git
			// can't refuse the temp because we just created it.
			expect(script).toContain('"$TMP_CLONE/repo"');
			// `mv` into the target rather than letting `git clone`
			// write directly there.
			expect(script).toContain('mv "$f" "$ST_TARGET_ABS/"');
			// Skip-on-conflict so the entrypoint-seeded .npm-global
			// survives. A regression that overwrote silently would
			// drop this branch.
			expect(script).toMatch(/already exists in target/);
			// dotglob so .git, .gitignore, etc. are part of the move.
			expect(script).toContain("shopt -s dotglob nullglob");
		}
	});

	it("NOAUTH_CLONE_SCRIPT is the minimal temp+move shape (no auth setup)", () => {
		// No askpass, no SSH key write — just temp + clone + move.
		expect(NOAUTH_CLONE_SCRIPT).not.toContain("ASKPASS_PATH");
		expect(NOAUTH_CLONE_SCRIPT).not.toContain("GIT_SSH_COMMAND");
		expect(NOAUTH_CLONE_SCRIPT).not.toContain("ST_PAT");
		expect(NOAUTH_CLONE_SCRIPT).not.toContain("ST_SSH_KEY");
		// `set -e` so any step in the move loop hard-fails the bootstrap
		// rather than silently producing a half-populated workspace.
		expect(NOAUTH_CLONE_SCRIPT).toMatch(/^set -e/);
	});

	// ── #188 PR 188d — SSH auth path ───────────────────────────────────────

	it("SSH auth: invokes bash with the canonical SSH_CLONE_SCRIPT", async () => {
		const stored = encryptAuthCredentials({
			ssh: { privateKey: "KEYDATA", knownHosts: "default" },
		});
		await runCloneRepo({
			sessionId: "sess-1",
			config: makeConfig({
				repo: { url: "git@github.com:o/p", auth: "ssh" },
				auth: stored,
			}),
			docker: docker as unknown as DockerManager,
		});
		const [, opts] = docker.streamExec.mock.calls[0]!;
		expect(opts.cmd[0]).toBe("bash");
		expect(opts.cmd[1]).toBe("-c");
		expect(opts.cmd[2]).toBe(SSH_CLONE_SCRIPT);
	});

	// `knownHosts === "default"` → resolve to the bundled github/gitlab/
	// bitbucket fingerprints. Any other string is a custom paste, used
	// verbatim. The user's choice between these is captured in the
	// schema; the runner just resolves the sentinel.
	it("SSH auth: knownHosts='default' resolves to the bundled fingerprints", async () => {
		const stored = encryptAuthCredentials({
			ssh: { privateKey: "KEYDATA", knownHosts: "default" },
		});
		await runCloneRepo({
			sessionId: "sess-1",
			config: makeConfig({
				repo: { url: "git@github.com:o/p", auth: "ssh" },
				auth: stored,
			}),
			docker: docker as unknown as DockerManager,
		});
		const [, opts] = docker.streamExec.mock.calls[0]!;
		expect(opts.env).toMatchObject({ ST_KNOWN_HOSTS: KNOWN_HOSTS_DEFAULT_BUNDLE });
	});

	it("SSH auth: knownHosts custom-paste is passed through verbatim", async () => {
		const customHosts = "intranet.example.com ssh-ed25519 AAAA…";
		const stored = encryptAuthCredentials({
			ssh: { privateKey: "KEYDATA", knownHosts: customHosts },
		});
		await runCloneRepo({
			sessionId: "sess-1",
			config: makeConfig({
				repo: { url: "git@intranet.example.com:o/p", auth: "ssh" },
				auth: stored,
			}),
			docker: docker as unknown as DockerManager,
		});
		const [, opts] = docker.streamExec.mock.calls[0]!;
		expect(opts.env).toMatchObject({ ST_KNOWN_HOSTS: customHosts });
	});

	// SSH key + known_hosts must NEVER appear in argv — same shape as
	// the PAT defence. Both are env-only.
	it("SSH auth: privateKey and knownHosts land in env, never in argv", async () => {
		const stored = encryptAuthCredentials({
			ssh: {
				privateKey: "-----BEGIN OPENSSH KEY-----\nSECRETBYTES",
				knownHosts: "github.com ssh-ed25519 PUBLICKEY",
			},
		});
		await runCloneRepo({
			sessionId: "sess-1",
			config: makeConfig({
				repo: { url: "git@github.com:o/p", auth: "ssh" },
				auth: stored,
			}),
			docker: docker as unknown as DockerManager,
		});
		const [, opts] = docker.streamExec.mock.calls[0]!;
		const argvJoined = (opts.cmd as string[]).join(" ");
		expect(argvJoined).not.toContain("SECRETBYTES");
		expect(argvJoined).not.toContain("PUBLICKEY");
	});

	it("SSH auth: throws CloneCredentialMissingError when auth.ssh absent", async () => {
		await expect(
			runCloneRepo({
				sessionId: "sess-1",
				config: makeConfig({
					repo: { url: "git@github.com:o/p", auth: "ssh" },
					auth: undefined,
				}),
				docker: docker as unknown as DockerManager,
			}),
		).rejects.toBeInstanceOf(CloneCredentialMissingError);
		expect(docker.streamExec).not.toHaveBeenCalled();
	});

	// Script integrity check: the SSH script must chmod 600 the key file
	// (ssh refuses keys with looser perms) and write known_hosts to the
	// canonical path so subsequent `git pull` / `git push` work without
	// further setup.
	it("SSH_CLONE_SCRIPT chmods the key 600 and persists to canonical paths", () => {
		expect(SSH_CLONE_SCRIPT).toContain("chmod 600 ~/.ssh/id_ed25519");
		expect(SSH_CLONE_SCRIPT).toContain("~/.ssh/known_hosts");
		// `unset` the secret env vars after the on-disk write so a
		// child process started by git doesn't inherit them.
		expect(SSH_CLONE_SCRIPT).toContain("unset ST_SSH_KEY ST_KNOWN_HOSTS");
	});

	// PR #215 round 1 SHOULD-FIX: the JSDoc claimed StrictHostKeyChecking=yes
	// but the script body lacked the GIT_SSH_COMMAND that enforces it. Pin
	// the explicit setting so a future edit can't silently revert to the
	// 'ask' default and accept a swapped-in attacker host key.
	it("SSH_CLONE_SCRIPT enforces StrictHostKeyChecking=yes via GIT_SSH_COMMAND", () => {
		expect(SSH_CLONE_SCRIPT).toContain('export GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=yes"');
	});

	// ── Bash syntax checks (PR #215 round 1 NIT) ───────────────────────────

	// `bash -n` (parse-only) catches broken quoting, malformed heredoc
	// delimiters, mismatched braces — exactly the class of breakage the
	// string-presence tests above don't notice. `streamExec` is mocked
	// in these tests, so a syntactically broken script body would
	// otherwise reach production unblocked.
	it("PAT_CLONE_SCRIPT parses cleanly under bash -n", () => {
		const r = spawnSync("bash", ["-n"], {
			input: PAT_CLONE_SCRIPT,
			encoding: "utf8",
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
	});

	it("SSH_CLONE_SCRIPT parses cleanly under bash -n", () => {
		const r = spawnSync("bash", ["-n"], {
			input: SSH_CLONE_SCRIPT,
			encoding: "utf8",
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
	});

	// ── env helpers (PR 188d) ──────────────────────────────────────────────

	// `patEnv` and `sshEnv` produce strings (not numbers / undefined)
	// for every field — Docker's exec API only accepts string-valued
	// env. The empty-string convention is what the bash script's
	// `[ -n ]` guards check; a literal "undefined" would pass the
	// guard and produce `git clone --branch undefined`.
	it("patEnv produces string-only values, with empty strings for absent ref/depth", () => {
		const env = patEnv("ghp_x", { url: "https://example.com/r" });
		for (const v of Object.values(env)) {
			expect(typeof v).toBe("string");
		}
		expect(env.ST_REF).toBe("");
		expect(env.ST_DEPTH).toBe("");
		expect(env.ST_TARGET_ABS).toBe("/home/developer/workspace");
	});

	it("sshEnv produces string-only values and resolves target", () => {
		const env = sshEnv("KEYDATA", "HOSTSDATA", {
			url: "git@github.com:o/p",
			depth: 5,
			target: "sub",
		});
		expect(env).toEqual({
			ST_SSH_KEY: "KEYDATA",
			ST_KNOWN_HOSTS: "HOSTSDATA",
			ST_URL: "git@github.com:o/p",
			ST_REF: "",
			ST_DEPTH: "5",
			ST_TARGET_ABS: "/home/developer/workspace/sub",
		});
	});

	// Output streaming — the runner just forwards the callback. Pin the
	// pass-through so a future refactor that adds intermediate
	// processing (filtering, redaction) makes a deliberate choice.
	it("forwards onOutput to streamExec verbatim", async () => {
		const onOutput = vi.fn();
		await runCloneRepo({
			sessionId: "sess-1",
			config: makeConfig({
				repo: { url: "https://example.com/r", auth: "none" },
			}),
			docker: docker as unknown as DockerManager,
			onOutput,
		});
		expect(docker.streamExec).toHaveBeenCalledTimes(1);
		const [, , passedCallback] = docker.streamExec.mock.calls[0]!;
		expect(passedCallback).toBe(onOutput);
	});
});
