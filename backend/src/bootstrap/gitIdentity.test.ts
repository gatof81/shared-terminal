import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DockerManager } from "../dockerManager.js";
import { runGitIdentity } from "./gitIdentity.js";

describe("runGitIdentity", () => {
	let docker: { streamExec: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		docker = { streamExec: vi.fn(async () => ({ exitCode: 0 })) };
	});

	it("returns exitCode 0 and skips entirely when identity is null", async () => {
		const result = await runGitIdentity({
			sessionId: "sess-1",
			identity: null,
			docker: docker as unknown as DockerManager,
		});
		expect(result).toEqual({ exitCode: 0 });
		expect(docker.streamExec).not.toHaveBeenCalled();
	});

	it("returns exitCode 0 and skips when identity is undefined", async () => {
		const result = await runGitIdentity({
			sessionId: "sess-1",
			identity: undefined,
			docker: docker as unknown as DockerManager,
		});
		expect(result).toEqual({ exitCode: 0 });
		expect(docker.streamExec).not.toHaveBeenCalled();
	});

	it("issues two argv-mode `git config --global` calls in name-then-email order", async () => {
		await runGitIdentity({
			sessionId: "sess-1",
			identity: { name: "Ada Lovelace", email: "ada@example.com" },
			docker: docker as unknown as DockerManager,
		});
		expect(docker.streamExec).toHaveBeenCalledTimes(2);
		const [, firstOpts] = docker.streamExec.mock.calls[0]!;
		const [, secondOpts] = docker.streamExec.mock.calls[1]!;
		// argv-mode (no shell) so user-controlled values reach `git
		// config` as positional args, not shell tokens.
		expect(firstOpts.cmd).toEqual(["git", "config", "--global", "user.name", "Ada Lovelace"]);
		expect(secondOpts.cmd).toEqual(["git", "config", "--global", "user.email", "ada@example.com"]);
		// argv-only — no shell wrapping at all.
		expect(firstOpts.cmd).not.toContain("bash");
		expect(secondOpts.cmd).not.toContain("bash");
	});

	it("returns the first non-zero exit code without running the second call", async () => {
		// `git config user.name` fails (e.g. read-only home) — we want
		// the runner to surface that immediately and not paper over it
		// with a successful user.email call.
		docker.streamExec.mockResolvedValueOnce({ exitCode: 0 }).mockResolvedValueOnce({ exitCode: 0 });
		// Override only the first call:
		docker.streamExec.mockReset();
		docker.streamExec.mockImplementationOnce(async () => ({ exitCode: 128 }));

		const result = await runGitIdentity({
			sessionId: "sess-1",
			identity: { name: "X", email: "x@y.com" },
			docker: docker as unknown as DockerManager,
		});
		expect(result).toEqual({ exitCode: 128 });
		expect(docker.streamExec).toHaveBeenCalledTimes(1);
	});

	it("forwards the abort signal to streamExec on each call", async () => {
		const ac = new AbortController();
		await runGitIdentity({
			sessionId: "sess-1",
			identity: { name: "X", email: "x@y.com" },
			docker: docker as unknown as DockerManager,
			signal: ac.signal,
		});
		for (const call of docker.streamExec.mock.calls) {
			const [, opts] = call;
			expect(opts.signal).toBe(ac.signal);
		}
	});
});
