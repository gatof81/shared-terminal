import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DockerManager } from "../dockerManager.js";
import type { SessionConfigRecord } from "../sessionConfig.js";
import {
	buildCloneArgv,
	CloneAuthNotImplementedError,
	resolveTargetAbsPath,
	runCloneRepo,
} from "./cloneRepo.js";

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

	// PAT/SSH paths land in 188d. Throwing rather than silently running
	// an anonymous clone means a deploy that lands 188b+188c without
	// 188d won't quietly fall back to anonymous against a private URL
	// (which would 404 with no signal that the credential was ignored).
	it("throws CloneAuthNotImplementedError for repo.auth='pat'", async () => {
		await expect(
			runCloneRepo({
				sessionId: "sess-1",
				config: makeConfig({
					repo: { url: "https://example.com/r", auth: "pat" },
				}),
				docker: docker as unknown as DockerManager,
			}),
		).rejects.toBeInstanceOf(CloneAuthNotImplementedError);
		expect(docker.streamExec).not.toHaveBeenCalled();
	});

	it("throws CloneAuthNotImplementedError for repo.auth='ssh'", async () => {
		await expect(
			runCloneRepo({
				sessionId: "sess-1",
				config: makeConfig({
					repo: { url: "git@github.com:o/p", auth: "ssh" },
				}),
				docker: docker as unknown as DockerManager,
			}),
		).rejects.toBeInstanceOf(CloneAuthNotImplementedError);
		expect(docker.streamExec).not.toHaveBeenCalled();
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
