/**
 * sessionStartScript.test.ts — the image's SessionStart registration hook
 * (`session-image/hooks/session-start.sh`, docs/CONVERSATION.md §2.3), run
 * as the real bash script with stand-ins for `tmux` and the receiver on
 * PATH / localhost, under a PARENT `claude` process.
 *
 * v1.8.2: the script asks the binary of the claude process that fired it
 * (`/proc/<pid>/exe --version`), never PATH's `claude`. A bash stand-in can't
 * play that parent (its exe would be bash), so a tiny C program named
 * `claude` is compiled once: `claude --version` answers per a `mode` file
 * next to it (ok / fail / hang / bad), and `claude <script> [flags…]` runs
 * the hook as its child — as the CLI does. PATH's `claude` is a liar that
 * answers 9.9.9: the recorded version must never be it.
 *
 * `curl` is the real binary. Where the test needs the request to land on a
 * local server, a `curl` shim earlier on PATH rewrites the fixed relay URL
 * `http://127.0.0.1:47613` (§2.6) to it and execs the real curl with every
 * other argument untouched, so the flags under test are the script's own.
 * Without the shim nothing listens on 47613 on a test host, which is exactly
 * the "relay absent" case.
 *
 * The docker-level counterpart (managed settings, the real CLI firing the
 * hook) is session-image/conversation-smoke.sh.
 */

import { execFileSync, spawn } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "../../../session-image/hooks/session-start.sh");
const TOKEN = "a".repeat(64);
const ST_SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e";
const INPUT = {
	session_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
	transcript_path: "/home/developer/.claude/projects/x/7c9e.jsonl",
	cwd: "/home/developer/workspace",
	hook_event_name: "SessionStart",
	source: "startup",
	model: "claude-opus-5-5",
};

let dir: string;
let bin: string;
let curlLog: string;
let server: http.Server | null;
let received: { headers: http.IncomingHttpHeaders; body: string }[];

function which(cmd: string): string {
	for (const d of (process.env.PATH ?? "").split(":")) {
		const p = path.join(d, cmd);
		try {
			readFileSync(p);
			return p;
		} catch {}
	}
	throw new Error(`${cmd} not found on PATH`);
}
const REAL_CURL = which("curl");

async function writeExe(name: string, body: string) {
	const p = path.join(bin, name);
	await fs.writeFile(p, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
	return p;
}

// ── The parent `claude` (a real executable) ─────────────────────────────
const HELPER_C = `#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <stdlib.h>
#include <libgen.h>
#include <sys/wait.h>
int main(int argc, char **argv) {
	if (argc == 2 && strcmp(argv[1], "--version") == 0) {
		char exe[4096]; ssize_t n = readlink("/proc/self/exe", exe, sizeof exe - 1);
		if (n < 0) return 2; exe[n] = 0;
		char *d = dirname(exe); char p[4300]; char mode[64] = {0};
		snprintf(p, sizeof p, "%s/mode", d);
		FILE *f = fopen(p, "r"); if (f) { if (!fgets(mode, sizeof mode, f)) mode[0] = 0; fclose(f); }
		if (!strncmp(mode, "fail", 4)) { fprintf(stderr, "boom\\n"); return 1; }
		if (!strncmp(mode, "bad", 3)) { puts("Update available"); return 0; }
		if (!strncmp(mode, "hang", 4)) {
			snprintf(p, sizeof p, "%s/hang.pid", d);
			f = fopen(p, "w"); if (f) { fprintf(f, "%d", (int)getpid()); fclose(f); }
			for (;;) pause();
		}
		snprintf(p, sizeof p, "%s/env.dump", d);
		f = fopen(p, "w"); if (f) { extern char **environ; for (char **e = environ; *e; e++) fprintf(f, "%s\\n", *e); fclose(f); }
		puts("2.1.308 (Claude Code)"); return 0;
	}
	if (argc < 2) return 2;
	pid_t c = fork();
	if (c == 0) { execl("/bin/bash", "bash", argv[1], (char *)0); _exit(127); }
	int st; waitpid(c, &st, 0); return 0;
}
`;
let helperDir: string;
let helper: string;
beforeAll(async () => {
	helperDir = await fs.mkdtemp(path.join(os.tmpdir(), "st-ss-helper-"));
	await fs.writeFile(path.join(helperDir, "claude.c"), HELPER_C);
	helper = path.join(helperDir, "claude");
	execFileSync("cc", ["-O0", "-o", helper, path.join(helperDir, "claude.c")]);
	// The same binary under the name `node`, reached through a `claude`
	// symlink: argv0 says claude, the exe is a node runtime.
	await fs.mkdir(path.join(helperDir, "rt"));
	await fs.copyFile(helper, path.join(helperDir, "rt", "node"));
	await fs.chmod(path.join(helperDir, "rt", "node"), 0o755);
	await fs.symlink(path.join(helperDir, "rt", "node"), path.join(helperDir, "rt", "claude"));
});
afterAll(async () => {
	await fs.rm(helperDir, { recursive: true, force: true });
});
async function parentMode(mode: "ok" | "fail" | "hang" | "bad") {
	await fs.writeFile(path.join(helperDir, "mode"), mode);
	await fs.rm(path.join(helperDir, "hang.pid"), { force: true });
	return path.join(helperDir, "hang.pid");
}

/** PATH's `claude`: a liar (Educación HZ: PATH named another installation). */
async function pathClaude() {
	await writeExe("claude", 'echo "9.9.9 (Claude Code)"');
}

/** Point the script's fixed URL at `port` (or leave it alone with null). */
async function curlShim(port: number | null) {
	await writeExe(
		"curl",
		`printf '%s\\n' "$@" >> ${curlLog}
args=()
for a in "$@"; do args+=("\${a//http:\\/\\/127.0.0.1:47613/http://127.0.0.1:${port ?? 0}}"); done
${port === null ? `exec ${REAL_CURL} "$@"` : `exec ${REAL_CURL} "\${args[@]}"`}`,
	);
}

async function listen(mode: "ok" | "hang"): Promise<number> {
	server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
			if (mode === "ok") {
				res.statusCode = 204;
				res.end();
			}
		});
	});
	await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
	return (server.address() as AddressInfo).port;
}

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	ms: number;
}

function run(
	env: Record<string, string>,
	stdin = JSON.stringify(INPUT),
	argv0?: string[],
	parent: true | false | "node" = true,
): Promise<RunResult> {
	return new Promise((resolve) => {
		const t0 = performance.now();
		// The hook runs as a child of the `claude` process, as the CLI fires
		// it; `parent: false` runs it with no claude above (by hand).
		const [cmd, args] =
			parent === false
				? ["bash", [SCRIPT]]
				: [
						parent === "node" ? path.join(helperDir, "rt", "claude") : helper,
						[SCRIPT, ...(argv0 ?? [])],
					];
		const child = spawn(cmd, args as string[], {
			env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, ...env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c) => {
			stdout += c;
		});
		child.stderr.on("data", (c) => {
			stderr += c;
		});
		child.on("close", (code) => resolve({ code, stdout, stderr, ms: performance.now() - t0 }));
		// The script may exit before reading its input (no token ⇒ exit 0 at
		// once): the write then fails with EPIPE, which is the expected outcome.
		child.stdin.on("error", () => undefined);
		child.stdin.end(stdin);
	});
}

const withToken = { ST_INGEST_TOKEN: TOKEN, SESSION_ID: ST_SESSION, TMUX_PANE: "%3" };
const isAlive = (pid: number) => {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return !/^\d+ \(.*\) Z/.test(stat);
	} catch {
		return false;
	}
};

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "st-ss-"));
	bin = path.join(dir, "bin");
	await fs.mkdir(bin);
	curlLog = path.join(dir, "curl.argv");
	server = null;
	received = [];
	await pathClaude();
	await parentMode("ok");
});
afterEach(async () => {
	await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
	server?.closeAllConnections?.();
	await fs.rm(dir, { recursive: true, force: true });
});

describe("session-start.sh — activation", () => {
	it("without ST_INGEST_TOKEN: exit 0, no output, no request", async () => {
		await curlShim(await listen("ok"));
		const r = await run({ SESSION_ID: ST_SESSION });
		expect(r).toMatchObject({ code: 0, stdout: "", stderr: "" });
		await expect(fs.stat(curlLog)).rejects.toThrow();
		expect(received).toHaveLength(0);
		const empty = await run({ ST_INGEST_TOKEN: "", SESSION_ID: ST_SESSION });
		expect(empty).toMatchObject({ code: 0, stdout: "", stderr: "" });
		expect(received).toHaveLength(0);
	});

	it("posts the input plus the st block with the pane header, no credential; never writes stdout", async () => {
		await curlShim(await listen("ok"));
		const r = await run(withToken);
		expect(r).toMatchObject({ code: 0, stdout: "", stderr: "" });
		expect(received).toHaveLength(1);
		const { headers, body } = received[0];
		// The relay adds the token and the session (§2.6); the script sends neither.
		expect(headers.authorization).toBeUndefined();
		expect(headers["x-st-session"]).toBeUndefined();
		expect(headers["x-st-tmux-pane"]).toBe("%3");
		expect(headers["content-type"]).toBe("application/json");
		// session_id stays the first key: the relay reads it from there.
		expect(body.startsWith(`{"session_id":"${INPUT.session_id}"`)).toBe(true);
		// The PARENT process's binary answered 2.1.308; PATH's claude says 9.9.9.
		expect(JSON.parse(body)).toEqual({
			...INPUT,
			st: {
				claude_version: "2.1.308 (Claude Code)",
				tmux_session: null,
				pane: "%3",
				argv_flags: [],
			},
		});
	});

	it("keeps the token out of curl's argv and ignores ~/.curlrc and proxy variables", async () => {
		await curlShim(await listen("ok"));
		await fs.writeFile(path.join(dir, ".curlrc"), "proxy = http://127.0.0.1:9\n");
		const r = await run({
			...withToken,
			http_proxy: "http://127.0.0.1:9",
			HTTP_PROXY: "http://127.0.0.1:9",
		});
		expect(r.code).toBe(0);
		expect(received).toHaveLength(1);
		const argv = await fs.readFile(curlLog, "utf8");
		expect(argv).not.toContain(TOKEN);
		expect(argv.split("\n")).toEqual(
			expect.arrayContaining(["-q", "--noproxy", "*", "--max-time", "2"]),
		);
	});

	it("asks tmux for the pane's own session only inside tmux", async () => {
		await curlShim(await listen("ok"));
		const tmuxLog = path.join(dir, "tmux.argv");
		await writeExe("tmux", `printf '%s\\n' "$@" > ${tmuxLog}; echo st-tab-1`);
		await run(withToken);
		await expect(fs.stat(tmuxLog)).rejects.toThrow(); // no $TMUX ⇒ tmux not asked
		await run({ ...withToken, TMUX: "/tmp/tmux-1000/default,1,0" });
		expect((await fs.readFile(tmuxLog, "utf8")).split("\n")).toEqual([
			"display-message",
			"-p",
			"-t",
			"%3",
			"#S",
			"",
		]);
		expect(JSON.parse(received[1].body).st.tmux_session).toBe("st-tab-1");
	});

	it("forwards only allowlisted flags of the parent claude, values only for the four name flags", async () => {
		await curlShim(await listen("ok"));
		await run(withToken, undefined, [
			"--print",
			"--agent-name",
			"reviewer",
			"--append-system-prompt",
			"SECRET-PROMPT",
			"--permission-mode=plan",
			"--resume",
			"6f1c-session",
			"--model",
			"opus",
			"--teammate-mode",
			"x".repeat(65),
			"--dangerously-skip-permissions",
		]);
		expect(received).toHaveLength(1);
		const { argv_flags } = JSON.parse(received[0].body).st;
		expect(argv_flags).toEqual([
			"--print",
			"--agent-name=reviewer",
			"--permission-mode=plan",
			"--resume",
			"--teammate-mode",
			"--dangerously-skip-permissions",
		]);
		expect(received[0].body).not.toContain("SECRET-PROMPT");
		expect(received[0].body).not.toContain("6f1c-session");
	});

	it("unparseable or non-object input: no request", async () => {
		await curlShim(await listen("ok"));
		for (const stdin of ["{not json", "[1,2]", ""]) {
			expect(await run(withToken, stdin)).toMatchObject({ code: 0, stdout: "", stderr: "" });
		}
		expect(received).toHaveLength(0);
	});
});

describe("session-start.sh — bounded in time (≤ 6 s whatever happens)", () => {
	it("relay absent (connection refused): exit 0 quickly, nothing on stdout/stderr", async () => {
		await curlShim(null); // real curl, real URL
		const r = await run(withToken);
		expect(r).toMatchObject({ code: 0, stdout: "", stderr: "" });
		expect(r.ms).toBeLessThan(6000);
	});

	it("a receiver that accepts and never answers: curl gives up at 2 s", async () => {
		await curlShim(await listen("hang"));
		const r = await run(withToken);
		expect(r.code).toBe(0);
		expect(received).toHaveLength(1);
		expect(r.ms).toBeGreaterThanOrEqual(1900);
		expect(r.ms).toBeLessThan(6000);
	}, 15_000);

	it("the parent's `--version` fails: claude_version null, the event is still sent", async () => {
		await parentMode("fail");
		await curlShim(await listen("ok"));
		const r = await run(withToken);
		expect(r).toMatchObject({ code: 0, stdout: "", stderr: "" });
		expect(JSON.parse(received[0].body).st.claude_version).toBeNull();
	});

	it("the parent's `--version` hangs: capped at 3 s, claude_version null, event sent, no survivor", async () => {
		const pidFile = await parentMode("hang");
		await curlShim(await listen("ok"));
		const r = await run(withToken);
		expect(r.code).toBe(0);
		expect(r.ms).toBeLessThan(6000);
		expect(received).toHaveLength(1);
		expect(JSON.parse(received[0].body).st.claude_version).toBeNull();
		expect(isAlive(Number(await fs.readFile(pidFile, "utf8")))).toBe(false);
	}, 15_000);

	it("the parent hangs AND the receiver hangs: the outer timeout ends everything within 6 s", async () => {
		const pidFile = await parentMode("hang");
		await curlShim(await listen("hang"));
		const r = await run(withToken);
		expect(r.ms).toBeLessThan(6000);
		expect(r.stdout).toBe("");
		expect(isAlive(Number(await fs.readFile(pidFile, "utf8")))).toBe(false);
	}, 15_000);
});

describe("session-start.sh — the version is the firing process's, never PATH's (v1.8.2)", () => {
	it("Educación HZ: PATH's claude says 9.9.9, the process is 2.1.308 ⇒ 2.1.308", async () => {
		await curlShim(await listen("ok"));
		const lie = execFileSync(path.join(bin, "claude"), ["--version"]).toString().trim();
		expect(lie).toBe("9.9.9 (Claude Code)");
		await run(withToken);
		expect(JSON.parse(received[0].body).st.claude_version).toBe("2.1.308 (Claude Code)");
	});
	it.each([
		["output that is not exactly `X.Y.Z (Claude Code)`", "bad", true],
		["no claude process above the script (run by hand)", "ok", false],
		["a node runtime (argv0 claude, exe node)", "ok", "node"],
	] as const)("%s ⇒ null, never PATH's 9.9.9", async (_n, mode, parent) => {
		await parentMode(mode);
		await curlShim(await listen("ok"));
		const r = await run(withToken, undefined, undefined, parent);
		expect(r).toMatchObject({ code: 0, stdout: "" });
		expect(received).toHaveLength(1);
		expect(JSON.parse(received[0].body).st.claude_version).toBeNull();
	});
	it("the query runs with an empty environment: no token, no proxy, no HOME reaches the binary", async () => {
		await curlShim(await listen("ok"));
		await run({ ...withToken, http_proxy: "http://127.0.0.1:9", SECRET_X: "s3cr3t" });
		const env = (await fs.readFile(path.join(helperDir, "env.dump"), "utf8"))
			.trim()
			.split("\n")
			.sort();
		expect(env).toEqual([
			"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
			"DISABLE_AUTOUPDATER=1",
			"HOME=/nonexistent",
			"PATH=/usr/bin:/bin",
		]);
	});
});
