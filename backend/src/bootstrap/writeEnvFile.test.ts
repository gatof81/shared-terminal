import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DockerManager } from "../dockerManager.js";
import { renderEnvFile, runWriteEnvFile, WRITE_ENV_FILE_SCRIPT } from "./writeEnvFile.js";

describe("renderEnvFile", () => {
	it("emits one KEY='value' line per entry with trailing newline", () => {
		const out = renderEnvFile({ FOO: "bar", BAZ: "qux" });
		expect(out).toBe("FOO='bar'\nBAZ='qux'\n");
	});

	it("escapes embedded single quotes via the '\\'' POSIX idiom", () => {
		// The standard close-escape-reopen pattern: `'` → `'\''`.
		// dotenv parsers and `set -a; . .env` both consume this
		// shape identically — the value's literal bytes are `a'b`.
		const out = renderEnvFile({ FOO: "a'b" });
		expect(out).toBe("FOO='a'\\''b'\n");
	});

	it("preserves dollar signs, backticks, and backslashes verbatim", () => {
		// The whole point of single quotes is to suppress interpolation
		// so the user's literal bytes survive. A future edit that
		// switches to double quotes (which DO interpolate) would break
		// this assertion — the test is the regression guard.
		const out = renderEnvFile({ FOO: "$VAR `cmd` \\n" });
		expect(out).toBe("FOO='$VAR `cmd` \\n'\n");
	});

	it("preserves insertion order", () => {
		const out = renderEnvFile({ C: "3", A: "1", B: "2" });
		expect(out).toBe("C='3'\nA='1'\nB='2'\n");
	});

	it("renders empty object to a bare newline", () => {
		// Defensive: runWriteEnvFile short-circuits on empty, so this
		// path isn't reached in practice — but pinning the shape keeps
		// renderEnvFile a pure function callers can rely on.
		expect(renderEnvFile({})).toBe("\n");
	});
});

describe("runWriteEnvFile", () => {
	let docker: { streamExec: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		docker = { streamExec: vi.fn(async () => ({ exitCode: 0 })) };
	});

	it("skips when enabled is false / undefined", async () => {
		const r1 = await runWriteEnvFile({
			sessionId: "sess-1",
			enabled: false,
			envVars: { FOO: "bar" },
			docker: docker as unknown as DockerManager,
		});
		expect(r1).toEqual({ exitCode: 0 });
		expect(docker.streamExec).not.toHaveBeenCalled();

		const r2 = await runWriteEnvFile({
			sessionId: "sess-1",
			enabled: undefined,
			envVars: { FOO: "bar" },
			docker: docker as unknown as DockerManager,
		});
		expect(r2).toEqual({ exitCode: 0 });
		expect(docker.streamExec).not.toHaveBeenCalled();
	});

	it("skips when enabled but envVars is empty / undefined (no clobber)", async () => {
		// A toggle-on session with no envVars MUST NOT touch the file —
		// the bind-mounted workspace may carry a user-curated .env that
		// a respawn shouldn't overwrite with an empty body.
		const r1 = await runWriteEnvFile({
			sessionId: "sess-1",
			enabled: true,
			envVars: undefined,
			docker: docker as unknown as DockerManager,
		});
		expect(r1).toEqual({ exitCode: 0 });
		expect(docker.streamExec).not.toHaveBeenCalled();

		const r2 = await runWriteEnvFile({
			sessionId: "sess-1",
			enabled: true,
			envVars: {},
			docker: docker as unknown as DockerManager,
		});
		expect(r2).toEqual({ exitCode: 0 });
		expect(docker.streamExec).not.toHaveBeenCalled();
	});

	it("invokes bash with WRITE_ENV_FILE_SCRIPT when toggle on + envVars set", async () => {
		await runWriteEnvFile({
			sessionId: "sess-1",
			enabled: true,
			envVars: { FOO: "bar" },
			docker: docker as unknown as DockerManager,
		});
		const [, opts] = docker.streamExec.mock.calls[0]!;
		expect(opts.cmd[0]).toBe("bash");
		expect(opts.cmd[1]).toBe("-c");
		expect(opts.cmd[2]).toBe(WRITE_ENV_FILE_SCRIPT);
	});

	it("passes rendered content via env, never argv", async () => {
		// Secret values must NOT land on the docker exec argv (visible
		// in `ps` / audit logs); they travel through env only, and the
		// bash script `unset`s the var after the write. Mirrors the
		// same invariant agentSeed enforces.
		const secret = "DO_NOT_LEAK_PASSWORD";
		await runWriteEnvFile({
			sessionId: "sess-1",
			enabled: true,
			envVars: { API_KEY: secret },
			docker: docker as unknown as DockerManager,
		});
		const [, opts] = docker.streamExec.mock.calls[0]!;
		const argvJoined = (opts.cmd as string[]).join(" ");
		expect(argvJoined).not.toContain(secret);
		expect(opts.env).toEqual({ ST_ENV_CONTENT: `API_KEY='${secret}'\n` });
	});

	it("writes to the workspace root with 0600 perms and unsets after", () => {
		// Pin the script-shape markers so a future edit can't silently
		// move the path, drop the chmod, or skip the unset.
		expect(WRITE_ENV_FILE_SCRIPT).toContain("/home/developer/workspace/.env");
		expect(WRITE_ENV_FILE_SCRIPT).toContain("chmod 600 /home/developer/workspace/.env");
		expect(WRITE_ENV_FILE_SCRIPT).toContain("unset ST_ENV_CONTENT");
		// `printf '%s'` (no trailing \n) — renderEnvFile already
		// emits the final newline. Switching to `echo` would
		// double-newline every file.
		expect(WRITE_ENV_FILE_SCRIPT).toContain("printf '%s'");
	});

	it("forwards the abort signal to streamExec", async () => {
		const ac = new AbortController();
		await runWriteEnvFile({
			sessionId: "sess-1",
			enabled: true,
			envVars: { FOO: "bar" },
			docker: docker as unknown as DockerManager,
			signal: ac.signal,
		});
		const [, opts] = docker.streamExec.mock.calls[0]!;
		expect(opts.signal).toBe(ac.signal);
	});

	it("returns the streamExec exit code", async () => {
		docker.streamExec.mockResolvedValueOnce({ exitCode: 7 });
		const result = await runWriteEnvFile({
			sessionId: "sess-1",
			enabled: true,
			envVars: { FOO: "bar" },
			docker: docker as unknown as DockerManager,
		});
		expect(result).toEqual({ exitCode: 7 });
	});
});
