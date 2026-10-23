/**
 * sessionStartScript.test.ts — the image's SessionStart registration hook
 * (`session-image/hooks/session-start.sh`, docs/CONVERSATION.md §2.3), run
 * as the real bash script with stand-ins for `claude`, `tmux` and the
 * receiver on PATH / localhost.
 *
 * `curl` is the real binary. Where the test needs the request to land on a
 * local server, a `curl` shim earlier on PATH rewrites the fixed
 * `http://st-backend:3001` to it and execs the real curl with every other
 * argument untouched, so the flags under test are the script's own. Without
 * the shim, `st-backend` does not resolve on a test host, which is exactly
 * the "backend absent" case.
 *
 * The docker-level counterpart (managed settings, the real CLI firing the
 * hook) is session-image/conversation-smoke.sh.
 */

import { spawn } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

/** A `claude` whose `--version` answers, fails or hangs. */
async function fakeClaude(mode: "ok" | "fail" | "hang") {
	const pidFile = path.join(dir, "claude.pid");
	const body = {
		ok: 'echo "2.1.308 (Claude Code)"',
		fail: "echo boom >&2; exit 1",
		// `exec` so the recorded pid IS the hanging process.
		hang: `echo $$ > ${pidFile}; exec sleep 30`,
	}[mode];
	await writeExe("claude", body);
	return pidFile;
}

/** Point the script's fixed URL at `port` (or leave it alone with null). */
async function curlShim(port: number | null) {
	await writeExe(
		"curl",
		`printf '%s\\n' "$@" >> ${curlLog}
args=()
for a in "$@"; do args+=("\${a//http:\\/\\/st-backend:3001/http://127.0.0.1:${port ?? 0}}"); done
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
): Promise<RunResult> {
	return new Promise((resolve) => {
		const t0 = performance.now();
		// argv0: run the script under a parent process whose argv[0] is
		// `claude`, as the CLI is when it fires the hook.
		const [cmd, args] = argv0
			? ["bash", ["-c", 'exec -a claude bash -c "bash \\"$0\\"; true" "$@"', SCRIPT, ...argv0]]
			: ["bash", [SCRIPT]];
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
	await fakeClaude("ok");
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

	it("posts the input plus the st block with the correlation headers; never writes stdout", async () => {
		await curlShim(await listen("ok"));
		const r = await run(withToken);
		expect(r).toMatchObject({ code: 0, stdout: "", stderr: "" });
		expect(received).toHaveLength(1);
		const { headers, body } = received[0];
		expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
		expect(headers["x-st-session"]).toBe(ST_SESSION);
		expect(headers["x-st-tmux-pane"]).toBe("%3");
		expect(headers["content-type"]).toBe("application/json");
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
	it("st-backend does not resolve: exit 0 quickly, nothing on stdout/stderr", async () => {
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

	it("`claude --version` fails: claude_version null, the event is still sent", async () => {
		await fakeClaude("fail");
		await curlShim(await listen("ok"));
		const r = await run(withToken);
		expect(r).toMatchObject({ code: 0, stdout: "", stderr: "" });
		expect(JSON.parse(received[0].body).st.claude_version).toBeNull();
	});

	it("`claude --version` hangs: capped at 3 s, claude_version null, event sent, no survivor", async () => {
		const pidFile = await fakeClaude("hang");
		await curlShim(await listen("ok"));
		const r = await run(withToken);
		expect(r.code).toBe(0);
		expect(r.ms).toBeLessThan(6000);
		expect(received).toHaveLength(1);
		expect(JSON.parse(received[0].body).st.claude_version).toBeNull();
		expect(isAlive(Number(await fs.readFile(pidFile, "utf8")))).toBe(false);
	}, 15_000);

	it("claude hangs AND the receiver hangs: the outer timeout ends everything within 6 s", async () => {
		const pidFile = await fakeClaude("hang");
		await curlShim(await listen("hang"));
		const r = await run(withToken);
		expect(r.ms).toBeLessThan(6000);
		expect(r.stdout).toBe("");
		expect(isAlive(Number(await fs.readFile(pidFile, "utf8")))).toBe(false);
	}, 15_000);
});
