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

	it("invokes streamExec with the cloning argv for repo.auth='none'", async () => {
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
		expect(opts.cmd).toEqual([
			"git",
			"clone",
			"--branch",
			"main",
			"--depth",
			"1",
			"--",
			"https://example.com/r",
			"/home/developer/workspace",
		]);
		expect(opts.workingDir).toBe("/home/developer/workspace");
	});

	// The runner is argv-mode (no `bash -c`) so a hostile-but-schema-
	// passing URL like one containing a literal `;` would reach git as a
	// single positional argument, NOT as a shell command separator. The
	// schema regex blocks `;` in URLs as of #213, but the argv-only
	// invocation is the load-bearing layer that defangs values that slip
	// past the regex.
	it("never wraps the command in a shell layer", async () => {
		await runCloneRepo({
			sessionId: "sess-1",
			config: makeConfig({
				repo: { url: "https://example.com/r", auth: "none" },
			}),
			docker: docker as unknown as DockerManager,
		});
		const [, opts] = docker.streamExec.mock.calls[0]!;
		// argv[0] must be `git`, not `bash` or `sh`.
		expect(opts.cmd[0]).toBe("git");
		expect(opts.cmd).not.toContain("bash");
		expect(opts.cmd).not.toContain("-c");
	});

	it("clones into a subdir when target is set", async () => {
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
		expect(opts.cmd[opts.cmd.length - 1]).toBe("/home/developer/workspace/services/api");
	});

	// Empty target → workspace root. Documented as the replace-workspace
	// mode signal. Test pins the resolution rather than the side-effects
	// of git cloning into a non-empty workspace, which is git's job.
	it("clones into the workspace root when target is empty", async () => {
		await runCloneRepo({
			sessionId: "sess-1",
			config: makeConfig({
				repo: { url: "https://example.com/r", target: "", auth: "none" },
			}),
			docker: docker as unknown as DockerManager,
		});
		const [, opts] = docker.streamExec.mock.calls[0]!;
		expect(opts.cmd[opts.cmd.length - 1]).toBe("/home/developer/workspace");
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
