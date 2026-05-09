import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DockerManager } from "../dockerManager.js";
import { AGENT_SEED_SCRIPT, runAgentSeed } from "./agentSeed.js";

describe("runAgentSeed", () => {
	let docker: { streamExec: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		docker = { streamExec: vi.fn(async () => ({ exitCode: 0 })) };
	});

	it("returns exitCode 0 and skips when agentSeed is null", async () => {
		const result = await runAgentSeed({
			sessionId: "sess-1",
			agentSeed: null,
			docker: docker as unknown as DockerManager,
		});
		expect(result).toEqual({ exitCode: 0 });
		expect(docker.streamExec).not.toHaveBeenCalled();
	});

	it("skips when both fields are absent (e.g. agentSeed: {})", async () => {
		const result = await runAgentSeed({
			sessionId: "sess-1",
			agentSeed: {},
			docker: docker as unknown as DockerManager,
		});
		expect(result).toEqual({ exitCode: 0 });
		expect(docker.streamExec).not.toHaveBeenCalled();
	});

	it("invokes bash with AGENT_SEED_SCRIPT when at least one field is set", async () => {
		await runAgentSeed({
			sessionId: "sess-1",
			agentSeed: { settings: '{"theme":"dark"}' },
			docker: docker as unknown as DockerManager,
		});
		const [, opts] = docker.streamExec.mock.calls[0]!;
		expect(opts.cmd[0]).toBe("bash");
		expect(opts.cmd[1]).toBe("-c");
		expect(opts.cmd[2]).toBe(AGENT_SEED_SCRIPT);
	});

	// Both file bodies travel via env vars, never argv. The schema's
	// 256 KiB byte cap (PR 191a + #217 round 1) keeps the env block
	// within kernel limits.
	it("passes user content via env, never argv", async () => {
		const settings = '{"secret_marker":"DO_NOT_LEAK"}';
		const claudeMd = "# notes\nDO_NOT_LEAK\n";
		await runAgentSeed({
			sessionId: "sess-1",
			agentSeed: { settings, claudeMd },
			docker: docker as unknown as DockerManager,
		});
		const [, opts] = docker.streamExec.mock.calls[0]!;
		const argvJoined = (opts.cmd as string[]).join(" ");
		expect(argvJoined).not.toContain("DO_NOT_LEAK");
		expect(opts.env).toEqual({ ST_SETTINGS: settings, ST_CLAUDE_MD: claudeMd });
	});

	it("converts null fields to empty strings in the env block", async () => {
		// `null` is the explicit-not-configured sentinel; the script's
		// `[ -n "$VAR" ]` guards skip the corresponding write.
		await runAgentSeed({
			sessionId: "sess-1",
			agentSeed: { settings: '{"a":1}', claudeMd: null },
			docker: docker as unknown as DockerManager,
		});
		const [, opts] = docker.streamExec.mock.calls[0]!;
		expect(opts.env).toEqual({ ST_SETTINGS: '{"a":1}', ST_CLAUDE_MD: "" });
	});

	// Script integrity check: the `mkdir -p ~/.claude` is critical —
	// without it the file write fails on a fresh container. Pin the
	// script-shape markers so a future edit can't drop them.
	it("AGENT_SEED_SCRIPT contains mkdir + conditional write guards + unset", () => {
		expect(AGENT_SEED_SCRIPT).toContain("mkdir -p ~/.claude");
		expect(AGENT_SEED_SCRIPT).toContain('[ -n "$ST_SETTINGS" ]');
		expect(AGENT_SEED_SCRIPT).toContain('[ -n "$ST_CLAUDE_MD" ]');
		expect(AGENT_SEED_SCRIPT).toContain("unset ST_SETTINGS ST_CLAUDE_MD");
	});

	it("forwards the abort signal to streamExec", async () => {
		const ac = new AbortController();
		await runAgentSeed({
			sessionId: "sess-1",
			agentSeed: { claudeMd: "# x" },
			docker: docker as unknown as DockerManager,
			signal: ac.signal,
		});
		const [, opts] = docker.streamExec.mock.calls[0]!;
		expect(opts.signal).toBe(ac.signal);
	});
});
