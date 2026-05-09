import { beforeEach, describe, expect, it, vi } from "vitest";

// Set the encryption key BEFORE importing the module — `decryptStoredAuth`
// imports `secrets.js` at module-load time which reads the env var.
process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 0x42).toString("base64");

import type { DockerManager } from "../dockerManager.js";
import { encryptAuthCredentials } from "../sessionConfig.js";
import {
	DOTFILES_NONE_SCRIPT,
	DOTFILES_PAT_SCRIPT,
	DOTFILES_SSH_SCRIPT,
	DotfilesAuthMismatchError,
	runDotfiles,
} from "./dotfiles.js";

describe("runDotfiles", () => {
	let docker: { streamExec: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		docker = { streamExec: vi.fn(async () => ({ exitCode: 0 })) };
	});

	it("returns exitCode 0 and skips when dotfiles is null", async () => {
		const result = await runDotfiles({
			sessionId: "sess-1",
			dotfiles: null,
			storedAuth: null,
			docker: docker as unknown as DockerManager,
		});
		expect(result).toEqual({ exitCode: 0 });
		expect(docker.streamExec).not.toHaveBeenCalled();
	});

	it("anonymous-https path: bash invokes DOTFILES_NONE_SCRIPT, env carries url+ref", async () => {
		await runDotfiles({
			sessionId: "sess-1",
			dotfiles: { url: "https://github.com/u/d.git", ref: "main" },
			storedAuth: null,
			docker: docker as unknown as DockerManager,
		});
		const [, opts] = docker.streamExec.mock.calls[0]!;
		expect(opts.cmd[2]).toBe(DOTFILES_NONE_SCRIPT);
		expect(opts.env).toEqual({
			ST_URL: "https://github.com/u/d.git",
			ST_REF: "main",
			ST_TARGET_DIR: "/home/developer/dotfiles",
		});
	});

	// PAT-https: token comes from the SHARED auth blob (auth.pat), not
	// a dotfiles-specific field. Same encryption boundary as
	// cloneRepo.PAT_CLONE_SCRIPT.
	it("PAT-https path: token from shared auth.pat, never in argv", async () => {
		const stored = encryptAuthCredentials({ pat: "ghp_dotfiles_TOKEN" });
		await runDotfiles({
			sessionId: "sess-1",
			dotfiles: { url: "https://github.com/u/d.git" },
			storedAuth: stored,
			docker: docker as unknown as DockerManager,
		});
		const [, opts] = docker.streamExec.mock.calls[0]!;
		expect(opts.cmd[2]).toBe(DOTFILES_PAT_SCRIPT);
		const argvJoined = (opts.cmd as string[]).join(" ");
		expect(argvJoined).not.toContain("ghp_dotfiles_TOKEN");
		expect(opts.env).toMatchObject({ ST_PAT: "ghp_dotfiles_TOKEN" });
	});

	// SSH: key + known_hosts come from auth.ssh. "default" knownHosts
	// resolves to the bundled fingerprints; custom paste verbatim.
	it("SSH path: key + known_hosts via env, NOT argv", async () => {
		const stored = encryptAuthCredentials({
			ssh: { privateKey: "SECRETKEY", knownHosts: "default" },
		});
		await runDotfiles({
			sessionId: "sess-1",
			dotfiles: { url: "git@github.com:u/d.git" },
			storedAuth: stored,
			docker: docker as unknown as DockerManager,
		});
		const [, opts] = docker.streamExec.mock.calls[0]!;
		expect(opts.cmd[2]).toBe(DOTFILES_SSH_SCRIPT);
		const argvJoined = (opts.cmd as string[]).join(" ");
		expect(argvJoined).not.toContain("SECRETKEY");
		expect(opts.env?.ST_SSH_KEY).toBe("SECRETKEY");
	});

	// Mismatched URL/auth: the schema doesn't cross-validate dotfiles
	// against config.auth (per the DotfilesSpec note). The runner is
	// the place that surfaces the mismatch with a loud throw rather
	// than a silent fall-through to anonymous (which would 404 against
	// a private repo with no signal).
	it("throws DotfilesAuthMismatchError when git@ URL has no SSH credential available", async () => {
		await expect(
			runDotfiles({
				sessionId: "sess-1",
				dotfiles: { url: "git@github.com:u/d.git" },
				storedAuth: null,
				docker: docker as unknown as DockerManager,
			}),
		).rejects.toBeInstanceOf(DotfilesAuthMismatchError);
		expect(docker.streamExec).not.toHaveBeenCalled();
	});

	it("runs the install script after a successful clone", async () => {
		await runDotfiles({
			sessionId: "sess-1",
			dotfiles: {
				url: "https://github.com/u/d.git",
				installScript: "install.sh",
			},
			storedAuth: null,
			docker: docker as unknown as DockerManager,
		});
		expect(docker.streamExec).toHaveBeenCalledTimes(2);
		const [, secondOpts] = docker.streamExec.mock.calls[1]!;
		// argv-mode + workingDir pinned to the dotfiles tree so the
		// installScript's relative paths resolve there.
		expect(secondOpts.cmd).toEqual(["bash", "--", "install.sh"]);
		expect(secondOpts.workingDir).toBe("/home/developer/dotfiles");
	});

	it("skips the install script when the clone fails", async () => {
		docker.streamExec.mockImplementationOnce(async () => ({ exitCode: 128 }));
		const result = await runDotfiles({
			sessionId: "sess-1",
			dotfiles: {
				url: "https://github.com/u/d.git",
				installScript: "install.sh",
			},
			storedAuth: null,
			docker: docker as unknown as DockerManager,
		});
		expect(result).toEqual({ exitCode: 128 });
		expect(docker.streamExec).toHaveBeenCalledTimes(1);
	});

	it("skips the install script when installScript is omitted", async () => {
		await runDotfiles({
			sessionId: "sess-1",
			dotfiles: { url: "https://github.com/u/d.git" },
			storedAuth: null,
			docker: docker as unknown as DockerManager,
		});
		expect(docker.streamExec).toHaveBeenCalledTimes(1);
	});

	it("forwards the abort signal to both clone + install streamExec calls", async () => {
		const ac = new AbortController();
		await runDotfiles({
			sessionId: "sess-1",
			dotfiles: {
				url: "https://github.com/u/d.git",
				installScript: "install.sh",
			},
			storedAuth: null,
			docker: docker as unknown as DockerManager,
			signal: ac.signal,
		});
		for (const call of docker.streamExec.mock.calls) {
			const [, opts] = call;
			expect(opts.signal).toBe(ac.signal);
		}
	});
});
