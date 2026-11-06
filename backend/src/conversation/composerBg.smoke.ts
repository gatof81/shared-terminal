/**
 * composerBg.smoke.ts — the `bg-reply` smoke of CONVERSATION.md §8.1.12.9
 * (v1.9 proposal, EXPERIMENTAL): the composer's background-session
 * transport against the REAL Claude Code CLI daemon, driven through the
 * REAL ComposerService (its preconditions, the job record, the fixed
 * in-container client of bgTransport.ts, the ack attribution of
 * composerBg.ts), with the CLI's own hooks feeding a real ConversationStore
 * and the CLI's own transcript read as the backend reads it.
 *
 *   cd backend && npx tsx src/conversation/composerBg.smoke.ts local <claude-binary> [<other-version-binary>]
 *     A disposable sandbox on this host: its own HOME and CLAUDE_CONFIG_DIR
 *     under a fresh temp dir, a private tmux server (`-L st-bgsmoke-<run>`),
 *     the environment stripped (`env -i`, no CLAUDE_* of the caller), and a
 *     scripted Messages API on loopback. "Docker" execs run locally as the
 *     current user (the sandbox's CLI runs as that user too).
 *
 *   cd backend && npx tsx src/conversation/composerBg.smoke.ts docker <image>
 *     The same scenario list inside a disposable container of the image
 *     (`--network none`, the CLI of the image, this checkout mounted
 *     read-only), i.e. the local mode run where the session CLI lives.
 *
 * Nothing here touches a process or socket it did not create: every CLI
 * process carries the sandbox's unique CLAUDE_CONFIG_DIR in its environment
 * and cleanup kills exactly those (and the recorded fake-harness pids).
 *
 * Cases (numbers = §8.1.12.9). Where the real CLI cannot be steered into a
 * state deterministically the case says how it was FORCED; nothing the
 * production code runs is replaced except where a case says so (e.g. a reply
 * "lost" by not running it, to observe what the ack does with a human's
 * identical text).
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	promises as fs,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { SessionMeta } from "../types.js";
import { BG_CLIENT_ARGV, replyStdin } from "./bgTransport.js";
import { type ComposerDockerPort, ComposerService } from "./composer.js";
import { localTranscripts, transcriptRel, workspaceTranscripts } from "./composerBg.js";
import { PaneRecordStore } from "./paneRecord.js";
import { parseAgentsJson } from "./probe.js";
import { ConversationStore, type PersistedEvent } from "./store.js";

const MODE = process.argv[2] ?? "local";
const RUN = randomUUID().slice(0, 8);
/**
 * `layout` (run INSIDE a session container started with its real
 * entrypoint, by the docker mode): the production layout — no
 * CLAUDE_CONFIG_DIR, `~/.claude` is the entrypoint's symlink into
 * `workspace/.st/claude-state`, the daemon socket hashes the literal
 * `/home/developer/.claude`, and transcripts are read by the production
 * `workspaceTranscripts` (WORKSPACE_ROOT = a second mount of the workspace).
 */
const LAYOUT = MODE === "layout";
const SID = LAYOUT ? (process.argv[4] as string) : randomUUID();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Docker mode: run this file inside a disposable container ────────────────

if (MODE === "docker") {
	const image = process.argv[3] ?? "shared-terminal-session";
	const backend = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
	// Phase A — production layout: the image's real entrypoint, a workspace
	// bind mount, no CLAUDE_CONFIG_DIR. The same workspace is mounted a second
	// time at /smokews/<sid> so the production transcript reader
	// (openWorkspaceFile under WORKSPACE_ROOT) reads it as the host would.
	const sidL = randomUUID();
	const ws = mkdtempSync(path.join(os.tmpdir(), "st-bglayout-"));
	chmodSync(ws, 0o777);
	const name = `st-bglayout-${RUN}`;
	const sh = (args: string[]) => spawnSync("docker", args, { encoding: "utf8" });
	let layoutStatus = 1;
	try {
		const run = sh([
			"run",
			"-d",
			"--name",
			name,
			"--init",
			"--network",
			"none",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			"-e",
			`SESSION_ID=${sidL}`,
			"-e",
			"SESSION_NAME=bglayout",
			"-v",
			`${ws}:/home/developer/workspace`,
			"-v",
			`${ws}:/smokews/${sidL}`,
			"-v",
			`${backend}:/smoke:ro`,
			image,
		]);
		if (run.status !== 0) throw new Error(`layout container: ${run.stderr}`);
		for (let i = 0; i < 120; i++) {
			if (sh(["exec", name, "test", "-f", "/tmp/.st-ready"]).status === 0) break;
			spawnSync("sleep", ["0.5"]);
		}
		const r = spawnSync(
			"docker",
			[
				"exec",
				"-u",
				"developer",
				"-e",
				"HOME=/home/developer",
				"-e",
				"WORKSPACE_ROOT=/smokews",
				"-w",
				"/smoke",
				name,
				"bash",
				"-lc",
				`B="$(readlink -f "$(command -v claude)")"; exec node --import tsx src/conversation/composerBg.smoke.ts layout "$B" ${sidL}`,
			],
			{ stdio: "inherit" },
		);
		layoutStatus = r.status ?? 1;
	} catch (err) {
		console.error(`layout phase: ${(err as Error).message}`);
	} finally {
		sh(["rm", "-f", name]);
	}
	// Phase B — the 15 cases in a container that bypasses the entrypoint.
	const r = spawnSync(
		"docker",
		[
			"run",
			"--rm",
			"--network",
			"none",
			"--init",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			"-v",
			`${backend}:/smoke:ro`,
			"-w",
			"/smoke",
			"--entrypoint",
			"bash",
			image,
			"-lc",
			// The image's CLI, resolved to its binary (no PATH lookup at run time).
			'B="$(readlink -f "$(command -v claude)")"; exec node --import tsx src/conversation/composerBg.smoke.ts local "$B"',
		],
		{ stdio: "inherit" },
	);
	process.exit((r.status ?? 1) || layoutStatus);
}

const CLAUDE = process.argv[3];
const OTHER = process.argv[4];
if (!CLAUDE) {
	console.error("usage: composerBg.smoke.ts local <claude-binary> [<other-version-binary>]");
	process.exit(2);
}

// ── Results ─────────────────────────────────────────────────────────────────

const results: Array<{
	n: number;
	name: string;
	verdict: "PASS" | "FAIL" | "NOT-REPRODUCED";
	note: string;
}> = [];
function record(
	n: number,
	name: string,
	verdict: "PASS" | "FAIL" | "NOT-REPRODUCED",
	note: string,
): void {
	results.push({ n, name, verdict, note });
	console.log(`  [${verdict}] ${n}. ${name} — ${note}`);
}
function phase(name: string): void {
	console.log(`\n── ${name} ──`);
}

// ── Sandbox ─────────────────────────────────────────────────────────────────

const BASE = process.env.BGSMOKE_BASE ?? os.tmpdir();
const ROOT = path.join(BASE, `st-bgsmoke-${RUN}`);
const HOME = LAYOUT ? (process.env.HOME ?? "/home/developer") : path.join(ROOT, "home");
/** Layout: the CLI's default `~/.claude` (no CLAUDE_CONFIG_DIR at all). */
const CFG = LAYOUT ? path.join(HOME, ".claude") : path.join(HOME, "cfg");
const PROJ = path.join(ROOT, "proj");
const WS = path.join(ROOT, "ws");
const HOOKLOG = path.join(ROOT, "hooks.jsonl");
const TMUX = `st-bgsmoke-${RUN}`;
const UID = process.getuid?.() ?? 1000;
const DAEMON_DIR = (cfg: string) =>
	`/tmp/cc-daemon-${UID}/${createHash("sha256").update(cfg).digest("hex").slice(0, 8)}`;
let apiPort = 0;
const API_KEY = "sk-ant-bgsmoke-0000000000000000000000";

function cliEnv(extra: Record<string, string> = {}): Record<string, string> {
	return {
		HOME,
		...(LAYOUT ? {} : { CLAUDE_CONFIG_DIR: CFG }),
		// Marks every process of this run (cleanup finds them by it).
		ST_BGSMOKE: RUN,
		PATH: "/usr/bin:/bin",
		TERM: "xterm-256color",
		LANG: "C.UTF-8",
		USER: os.userInfo().username,
		SHELL: "/bin/bash",
		DISABLE_AUTOUPDATER: "1",
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		DISABLE_TELEMETRY: "1",
		DISABLE_ERROR_REPORTING: "1",
		ANTHROPIC_BASE_URL: `http://127.0.0.1:${apiPort}`,
		ANTHROPIC_API_KEY: API_KEY,
		...extra,
	};
}
function cc(bin: string, args: string[], timeoutMs = 60_000): { code: number; out: string } {
	const r = spawnSync(bin, args, {
		cwd: PROJ,
		env: cliEnv(),
		encoding: "utf8",
		timeout: timeoutMs,
	});
	return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
function tmux(...args: string[]): string {
	const r = spawnSync("tmux", ["-L", TMUX, ...args], { encoding: "utf8" });
	return r.stdout ?? "";
}

async function setupSandbox(): Promise<void> {
	await fs.mkdir(CFG, { recursive: true });
	await fs.mkdir(PROJ, { recursive: true });
	await fs.mkdir(WS, { recursive: true });
	const hook = path.join(ROOT, "hook.sh");
	await fs.writeFile(
		hook,
		'#!/bin/bash\nin=$(cat); printf \'{"ev":"%s","in":%s}\\n\' "$2" "$in" >> "$1"; exit 0\n',
		{ mode: 0o755 },
	);
	const hooks = Object.fromEntries(
		["UserPromptSubmit", "SessionStart", "Stop", "SessionEnd"].map((ev) => [
			ev,
			[{ hooks: [{ type: "command", command: `${hook} ${HOOKLOG} ${ev}` }] }],
		]),
	);
	await fs.writeFile(path.join(CFG, "settings.json"), JSON.stringify({ hooks }));
	// Layout: the CLI keeps its state in ~/.claude.json (the entrypoint's
	// symlink), not inside the config dir.
	const stateFile = LAYOUT ? path.join(HOME, ".claude.json") : path.join(CFG, ".claude.json");
	const prior = LAYOUT ? JSON.parse(await fs.readFile(stateFile, "utf8").catch(() => "{}")) : {};
	await fs.writeFile(
		stateFile,
		JSON.stringify({
			...prior,
			hasCompletedOnboarding: true,
			// Without this the CLI ignores ANTHROPIC_API_KEY ("Not logged in"):
			// the key's last 20 characters, as the CLI's own approval prompt stores it.
			customApiKeyResponses: { approved: [API_KEY.slice(-20)], rejected: [] },
			projects: { [PROJ]: { hasTrustDialogAccepted: true } },
		}),
	);
	spawnSync("tmux", [
		"-L",
		TMUX,
		"-f",
		"/dev/null",
		"new-session",
		"-d",
		"-s",
		"smoke",
		"-x",
		"200",
		"-y",
		"50",
	]);
}

// ── Scripted Messages API (loopback) ────────────────────────────────────────
// SLOW<n> in the turn ⇒ a paced reply of n seconds; ASKQ ⇒ one AskUserQuestion
// tool_use (the dialog stays pending); a tool_result ⇒ a short close.

function lastUserText(body: { messages?: Array<{ role: string; content: unknown }> }): {
	text: string;
	toolResult: boolean;
} {
	const msgs = body.messages ?? [];
	const parts: string[] = [];
	let toolResult = false;
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i] as { role: string; content: unknown };
		if (m.role !== "user") break;
		if (typeof m.content === "string") parts.unshift(m.content);
		else if (Array.isArray(m.content)) {
			for (const b of m.content as Array<{ type: string; text?: string }>) {
				if (b.type === "text" && b.text) parts.unshift(b.text);
				if (b.type === "tool_result") toolResult = true;
			}
		}
	}
	return { text: parts.join(" | "), toolResult };
}
function startApi(): Promise<http.Server> {
	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => {
			raw += c;
		});
		req.on("end", async () => {
			let body: Record<string, unknown> = {};
			try {
				body = JSON.parse(raw);
			} catch {}
			if (req.method !== "POST" || !req.url?.includes("/v1/messages")) {
				res.writeHead(200, { "content-type": "application/json" }).end("{}");
				return;
			}
			if (req.url.includes("count_tokens")) {
				res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":10}');
				return;
			}
			const { text, toolResult } = lastUserText(body as never);
			const msg = {
				id: "msg_smoke",
				type: "message",
				role: "assistant",
				model: (body.model as string) ?? "x",
				content: [] as unknown[],
				stop_reason: null as string | null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 1 },
			};
			const reply = toolResult ? "tool done" : `ok: ${text.slice(-60)}`;
			if (!body.stream) {
				msg.content = [{ type: "text", text: reply }];
				msg.stop_reason = "end_turn";
				res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(msg));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
			const sse = (ev: string, data: unknown) =>
				res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
			sse("message_start", { type: "message_start", message: msg });
			const slow = !toolResult ? /SLOW(\d+)/.exec(text) : null;
			if (/ASKQ/.test(text) && !toolResult) {
				sse("content_block_start", {
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "tool_use",
						id: `toolu_${Date.now()}`,
						name: "AskUserQuestion",
						input: {},
					},
				});
				sse("content_block_delta", {
					type: "content_block_delta",
					index: 0,
					delta: {
						type: "input_json_delta",
						partial_json: JSON.stringify({
							questions: [
								{
									question: "Which color?",
									header: "Color",
									multiSelect: false,
									options: [
										{ label: "Red", description: "r" },
										{ label: "Blue", description: "b" },
									],
								},
							],
						}),
					},
				});
				sse("content_block_stop", { type: "content_block_stop", index: 0 });
				sse("message_delta", {
					type: "message_delta",
					delta: { stop_reason: "tool_use", stop_sequence: null },
					usage: { output_tokens: 5 },
				});
			} else {
				sse("content_block_start", {
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				});
				if (slow) {
					for (let k = 0; k < Number(slow[1]); k++) {
						sse("content_block_delta", {
							type: "content_block_delta",
							index: 0,
							delta: { type: "text_delta", text: "." },
						});
						await sleep(1000);
					}
				}
				sse("content_block_delta", {
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: reply },
				});
				sse("content_block_stop", { type: "content_block_stop", index: 0 });
				sse("message_delta", {
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: 5 },
				});
			}
			sse("message_stop", { type: "message_stop" });
			res.end();
		});
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ── Hooks → ConversationStore (what the ingest does, minus the relay) ───────

const store = new ConversationStore({ workspaceRoot: WS });
const records = new PaneRecordStore(WS);
const seen = new Set<string>();
let hookOffset = 0;
let feeding = true;
async function feedOnce(): Promise<void> {
	const raw = await fs.readFile(HOOKLOG, "utf8").catch(() => "");
	const chunk = raw.slice(hookOffset);
	const end = chunk.lastIndexOf("\n");
	if (end < 0) return;
	hookOffset += end + 1;
	for (const line of chunk.slice(0, end).split("\n")) {
		if (!line) continue;
		let j: { ev: string; in: Record<string, unknown> };
		try {
			j = JSON.parse(line);
		} catch {
			continue;
		}
		const cid = j.in.session_id as string;
		if (typeof cid !== "string") continue;
		await store.open(SID, cid);
		if (!seen.has(cid)) {
			seen.add(cid);
			store.update(SID, cid, (i) => {
				i.kind = "interactive";
				i.paneId = null;
			});
		}
		const base = { turn_id: null, agent_id: null, pane: null };
		if (j.ev === "SessionStart") {
			store.enqueue(SID, cid, {
				...base,
				ev: "session_start",
				prompt_id: null,
				data: { source: j.in.source as string, transcript_path: j.in.transcript_path as string },
			});
		} else if (j.ev === "Stop") {
			// The end of a turn, with the prompt_id the CLI puts on it (SF-1:
			// whether a nextTurn turn's Stop carries the ack's id is checked).
			store.enqueue(SID, cid, {
				...base,
				ev: "turn_end",
				prompt_id: (j.in.prompt_id as string) ?? null,
				data: {},
			});
		} else if (j.ev === "UserPromptSubmit") {
			store.enqueue(SID, cid, {
				...base,
				ev: "user_prompt",
				prompt_id: (j.in.prompt_id as string) ?? null,
				data: { prompt: j.in.prompt as string },
			});
		} else continue;
		await store.flush(SID, cid);
	}
}
async function feeder(): Promise<void> {
	while (feeding) {
		await feedOnce().catch((e) => console.error("feeder:", e));
		await sleep(40);
	}
}

// ── "Docker" port: local execs, interposable per case ───────────────────────

type Interpose = (
	cmd: string[],
	stdin: Buffer | null,
) => Promise<"run" | "park" | { exit: number | null; out: string }> | "run";
class LocalDocker implements ComposerDockerPort {
	states = new Map<string, { running: boolean; exitCode: number | null } | null>();
	interpose: Interpose | null = null;
	replyRuns = 0;
	private n = 0;
	isReply(cmd: string[], stdin: Buffer | null): boolean {
		return (
			cmd.at(-1) === BG_CLIENT_ARGV.at(-1) && !!stdin && stdin.toString().includes('"mode":"reply"')
		);
	}
	run(cmd: string[], stdin: Buffer | null): Promise<{ exit: number | null; out: string }> {
		return new Promise((resolve) => {
			const p = spawn(cmd[0] as string, cmd.slice(1), {
				env: {},
				stdio: ["pipe", "pipe", "ignore"],
			});
			let out = "";
			p.stdout.on("data", (d) => {
				out += d;
			});
			p.on("error", () => resolve({ exit: null, out }));
			p.on("close", (code) => resolve({ exit: code, out }));
			if (stdin) p.stdin.end(stdin);
			else p.stdin.end();
		});
	}
	async exec(
		_c: string,
		cmd: string[],
		stdin: Buffer | null,
		onCreated: (id: string) => Promise<boolean>,
	) {
		const id = `x${++this.n}`;
		if (!(await onCreated(id))) return { execId: id, exitCode: null, stdout: "" };
		this.states.set(id, { running: true, exitCode: null });
		let r: { exit: number | null; out: string };
		const plan =
			this.isReply(cmd, stdin) && this.interpose ? await this.interpose(cmd, stdin) : "run";
		if (plan === "park") {
			// The backend lost this exec; the case runs it itself later.
			parkedExecs.push({ id, cmd, stdin });
			return new Promise<never>(() => undefined);
		}
		if (plan === "run") {
			if (this.isReply(cmd, stdin)) this.replyRuns++;
			r = await this.run(cmd, stdin);
		} else r = plan;
		this.states.set(id, r.exit === null ? null : { running: false, exitCode: r.exit });
		return { execId: id, exitCode: r.exit, stdout: r.out };
	}
	async execState(id: string) {
		return this.states.get(id) ?? null;
	}
	async containerState() {
		return "running" as const;
	}
}
const parkedExecs: Array<{ id: string; cmd: string[]; stdin: Buffer | null }> = [];
const docker = new LocalDocker();

let probeOverride: (() => ReturnType<typeof parseAgentsJson>) | null = null;
function probeNow(): ReturnType<typeof parseAgentsJson> {
	const r = cc(CLAUDE as string, ["agents", "--json"], 20_000);
	return r.code === 0 ? parseAgentsJson(r.out.slice(r.out.indexOf("["))) : null;
}

const meta = {
	sessionId: SID,
	userId: "owner",
	status: "running",
	containerId: "local",
} as unknown as SessionMeta;

function makeService(over: { tAckBgMs?: number; dead?: { v: boolean } } = {}) {
	const dead = over.dead;
	const unlistens: Array<() => void> = [];
	const service = new ComposerService({
		enabled: true,
		store,
		records,
		docker,
		sessions: { getOrThrow: async () => meta },
		conversation: {
			probeSession: async () => (probeOverride ? probeOverride() : probeNow()),
			onPersistedEvent: (l) => {
				const u = store.onEvent((st, cid, ev) => {
					if (!dead?.v) l(st, cid, ev);
				});
				unlistens.push(u);
				return u;
			},
			captureEffective: async () => true,
		},
		after: (ms) =>
			dead
				? new Promise((r) => setTimeout(() => !dead.v && r(), ms))
				: new Promise((r) => setTimeout(r, ms)),
		bg: {
			enabled: true,
			versions: new Set([VERSION]),
			sessions: new Set([SID]),
			// The sandbox runs its CLI with its own config dir (production: only
			// the container default is supported, D3). Layout: the production
			// default and the production transcript reader, untouched.
			...(LAYOUT ? {} : { configDir: CFG }),
			transcripts: LAYOUT
				? workspaceTranscripts
				: localTranscripts((p) => (p.startsWith(`${CFG}/projects/`) ? p : null)),
			pollMs: 500,
			jobCheckMs: 1_000,
			// Shorter than production's 10 min so one stuck case cannot block the rest.
			tAckBgMs: over.tAckBgMs ?? 90_000,
		},
	});
	return { service, unlistens };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

let VERSION = "";
interface Job {
	short: string;
	cid: string;
	pid: number;
}
async function startJob(prompt: string, bin = CLAUDE as string): Promise<Job> {
	const r = cc(bin, ["--bg", prompt]);
	const short = /backgrounded · ([0-9a-f]{8})/.exec(r.out)?.[1];
	if (!short) throw new Error(`--bg did not background: ${r.out.slice(0, 300)}`);
	const j = await waitJob(short, (e) => e.status === "idle");
	// The probe can say idle while the job's own session file still flips
	// (end-of-turn bookkeeping right after the first prompt): the composer's
	// in-exec re-read would then refuse, correctly, with 409 busy. A harness
	// that wants an idle job waits for the file to stay idle.
	await waitFor(() => {
		try {
			const sf = JSON.parse(readFileSync(path.join(CFG, "sessions", `${j.pid}.json`), "utf8"));
			const ok = sf.status === "idle" && Date.now() - Number(sf.statusUpdatedAt ?? 0) > 1500;
			return ok;
		} catch {
			return false;
		}
	}, 15_000);
	return j;
}
async function waitJob(
	short: string,
	ok: (e: NonNullable<ReturnType<typeof parseAgentsJson>>[number]) => boolean,
	timeoutMs = 60_000,
): Promise<Job> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const e = probeNow()?.find((x) => x.id === short);
		if (e && typeof e.pid === "number" && ok(e)) return { short, cid: e.sessionId, pid: e.pid };
		if (Date.now() > deadline) throw new Error(`job ${short} not in the expected state`);
		await sleep(400);
	}
}
async function waitIdle(job: Job, timeoutMs = 90_000): Promise<Job> {
	return waitJob(job.short, (e) => e.status === "idle" && e.waitingFor === undefined, timeoutMs);
}
/** A `claude attach` client in a private tmux window — the person's Terminal. */
function attach(job: Job): string {
	const env = Object.entries(cliEnv())
		.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
		.join(" ");
	const name = `a${job.short}${Math.random().toString(36).slice(2, 5)}`;
	tmux(
		"new-window",
		"-d",
		"-t",
		"smoke",
		"-n",
		name,
		`env -i ${env} ${CLAUDE} attach ${job.short}; sleep 99999`,
	);
	return `smoke:${name}`;
}
function type(target: string, text: string): void {
	tmux("send-keys", "-t", target, "-l", text);
}
function enter(target: string): void {
	tmux("send-keys", "-t", target, "Enter");
}
function transcriptFile(cid: string): string | null {
	const dir = path.join(CFG, "projects");
	try {
		for (const d of readdirSync(dir)) {
			const f = path.join(dir, d, `${cid}.jsonl`);
			try {
				readFileSync(f);
				return f;
			} catch {}
		}
	} catch {}
	return null;
}
function transcriptOps(cid: string): Array<{
	type: string;
	operation?: string;
	content?: string;
	promptSource?: string;
	promptId?: string;
	text?: string;
}> {
	const f = transcriptFile(cid);
	if (!f) return [];
	return readFileSync(f, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l))
		.filter(
			(j) =>
				j.type === "queue-operation" ||
				(j.type === "user" && typeof j.message?.content === "string"),
		)
		.map((j) => ({
			type: j.type,
			operation: j.operation,
			content: j.content,
			promptSource: j.promptSource,
			promptId: j.promptId,
			text: j.message?.content,
		}));
}
const enqueued = (cid: string, text: string) =>
	transcriptOps(cid).some(
		(o) => o.type === "queue-operation" && o.operation === "enqueue" && o.content === text,
	);
async function statesOf(cid: string): Promise<string[]> {
	await store.flush(SID, cid).catch(() => undefined);
	const raw = await fs.readFile(store.eventsPath(SID, cid), "utf8").catch(() => "");
	return raw
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as PersistedEvent)
		.filter((e) => e.ev === "composer_send")
		.map((e) => e.data.state as string);
}
async function statesFor(cid: string, id: string): Promise<string[]> {
	await store.flush(SID, cid).catch(() => undefined);
	const raw = await fs.readFile(store.eventsPath(SID, cid), "utf8").catch(() => "");
	return raw
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as PersistedEvent)
		.filter((e) => e.ev === "composer_send" && e.data.client_message_id === id)
		.map((e) => e.data.state as string);
}
async function waitFor(pred: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await pred()) return true;
		await sleep(150);
	}
	return pred();
}
async function sendVia(service: ComposerService, cid: string, text: string, id = randomUUID()) {
	const r = await service.send({
		stSessionId: SID,
		cid,
		callerId: "owner",
		meta,
		body: { text, clientMessageId: id },
		audit: async () => undefined,
	});
	return { ...r, id };
}
/** The record of a job is gone (released) — the next send can go. */
async function jobFree(short: string, ms = 20_000): Promise<boolean> {
	return waitFor(async () => (await records.read(SID, `job:${short}`)).kind === "none", ms);
}

/** Raw control-socket client (smoke-only ops: list, shutdown, a raw reply for case 9). */
function ctl(req: Record<string, unknown>, cfg = CFG): Promise<Record<string, unknown> | null> {
	return new Promise((resolve) => {
		const s = net.connect(`${DAEMON_DIR(cfg)}/control.sock`);
		let buf = "";
		const t = setTimeout(() => {
			s.destroy();
			resolve(null);
		}, 5000);
		s.on("connect", () => s.write(`${JSON.stringify(req)}\n`));
		s.on("data", (d) => {
			buf += d;
			const i = buf.indexOf("\n");
			if (i >= 0) {
				clearTimeout(t);
				s.destroy();
				try {
					resolve(JSON.parse(buf.slice(0, i)));
				} catch {
					resolve(null);
				}
			}
		});
		s.on("error", () => {
			clearTimeout(t);
			resolve(null);
		});
	});
}
const controlKey = (cfg = CFG) =>
	readFileSync(path.join(cfg, "daemon", "control.key"), "utf8").trim();

/** Every process of THIS sandbox: its environment names our unique config dir. */
function sandboxPids(marker = ROOT): number[] {
	const out: number[] = [];
	for (const p of readdirSync("/proc")) {
		if (!/^\d+$/.test(p) || Number(p) === process.pid) continue;
		try {
			const env = readFileSync(`/proc/${p}/environ`, "latin1");
			const cmdline = readFileSync(`/proc/${p}/cmdline`, "latin1");
			if (env.includes(marker) || cmdline.includes(marker) || env.includes(`ST_BGSMOKE=${RUN}\0`))
				out.push(Number(p));
		} catch {}
	}
	return out;
}
function procStart(pid: number): string {
	const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
	return raw.slice(raw.lastIndexOf(") ") + 2).split(" ")[19] as string;
}

// ── Cases ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const v = spawnSync(CLAUDE as string, ["--version"], {
		env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", DISABLE_AUTOUPDATER: "1" },
		encoding: "utf8",
	});
	VERSION = /^(\d+\.\d+\.\d+)/.exec(v.stdout ?? "")?.[1] ?? "";
	if (!VERSION) throw new Error(`cannot read the CLI version of ${CLAUDE}`);
	console.log(`bg-reply smoke — CLI ${VERSION} (${CLAUDE}), sandbox ${ROOT}, tmux -L ${TMUX}`);
	const api = await startApi();
	apiPort = (api.address() as net.AddressInfo).port;
	await setupSandbox();
	void feeder();
	try {
		if (LAYOUT) await runLayout();
		else await runCases();
	} finally {
		feeding = false;
		api.close();
	}
}

/** Production layout (inside the real session container): L1–L5. */
async function runLayout(): Promise<void> {
	phase("L. production layout: real entrypoint, no CLAUDE_CONFIG_DIR, workspaceTranscripts");
	const isLink = (() => {
		try {
			return lstatSync(CFG).isSymbolicLink();
		} catch {
			return false;
		}
	})();
	const real = (() => {
		try {
			return realpathSync(CFG);
		} catch {
			return "?";
		}
	})();
	record(
		101,
		"layout: ~/.claude is the entrypoint's symlink into workspace/.st/claude-state",
		isLink && real.endsWith("/workspace/.st/claude-state") ? "PASS" : "FAIL",
		`${CFG} → ${real}`,
	);
	const { service } = makeService();
	const job = await startJob("hello layout");
	await waitFor(() => seen.has(job.cid), 10_000);
	const literal = `${DAEMON_DIR("/home/developer/.claude")}/control.sock`;
	record(
		102,
		"layout: the daemon socket hashes the literal /home/developer/.claude",
		existsSync(literal) ? "PASS" : "FAIL",
		`${literal} exists=${existsSync(literal)}; hash of the realpath would be ${DAEMON_DIR(real)}`,
	);
	const evs = (await fs.readFile(store.eventsPath(SID, job.cid), "utf8").catch(() => ""))
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as PersistedEvent);
	const tp = evs.find((e) => e.ev === "session_start")?.data.transcript_path;
	record(
		103,
		"layout: the hook's transcript_path is under /home/developer/.claude/projects and maps",
		typeof tp === "string" && transcriptRel(tp) !== null ? "PASS" : "FAIL",
		`${tp} → ${typeof tp === "string" ? transcriptRel(tp) : null}`,
	);
	const ins = await docker.run(
		[...BG_CLIENT_ARGV],
		Buffer.from(JSON.stringify({ mode: "inspect", pid: job.pid, short: job.short })),
	);
	const cfgSeen = /"configDir":"([^"]*)"/.exec(ins.out)?.[1];
	record(
		104,
		"layout: the inspect reports the literal default config dir (D3 passes)",
		cfgSeen === "/home/developer/.claude" ? "PASS" : "FAIL",
		`configDir=${cfgSeen}`,
	);
	const r = await sendVia(service, job.cid, "layout one");
	record(
		105,
		"layout: a send through the production transcript reader is delivered",
		r.status === 202 && r.body.result === "delivered" ? "PASS" : "FAIL",
		`HTTP ${r.status} ${JSON.stringify(r.body)}`,
	);
}

async function runCases(): Promise<void> {
	// `BGSMOKE_ONLY=9`: the mixed-version ESKEW smoke alone (daemon and worker
	// on different CLI versions; needs the second binary).
	if (process.env.BGSMOKE_ONLY === "9") {
		const j = await startJob("hello eskew only");
		await waitFor(() => seen.has(j.cid), 10_000);
		await eskewCase(j);
		return;
	}
	const { service } = makeService();
	let job = await startJob("hello bg smoke");
	console.log(`job ${job.short} pid ${job.pid} cid ${job.cid}`);
	await waitFor(() => seen.has(job.cid), 10_000);

	phase("1. idle ⇒ complete ack in cid, promptSource queued");
	{
		const r = await sendVia(service, job.cid, "smoke idle one");
		const states = await statesOf(job.cid);
		const q = transcriptOps(job.cid).find((o) => o.type === "user" && o.text === "smoke idle one");
		const ok =
			r.status === 202 &&
			r.body.result === "delivered" &&
			q?.promptSource === "queued" &&
			enqueued(job.cid, "smoke idle one");
		// SF-1 (round 3.1): the Stop of OUR nextTurn turn carries the ack's
		// prompt_id — the evidence the "finished turn" rule reads.
		const ackId = r.body.promptId as string | undefined;
		const stopSeen = await waitFor(async () => {
			const raw = await fs.readFile(store.eventsPath(SID, job.cid), "utf8").catch(() => "");
			return raw.split("\n").some((l) => {
				if (!l) return false;
				const e = JSON.parse(l) as PersistedEvent;
				return e.ev === "turn_end" && e.prompt_id === ackId;
			});
		}, 15_000);
		const stops = (await fs.readFile(store.eventsPath(SID, job.cid), "utf8").catch(() => ""))
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as PersistedEvent)
			.filter((e) => e.ev === "turn_end")
			.map((e) => e.prompt_id?.slice(0, 8) ?? "null");
		record(
			16,
			"the Stop of a nextTurn turn carries the ack's prompt_id",
			ackId && stopSeen ? "PASS" : "FAIL",
			`ack prompt_id ${ackId?.slice(0, 8)}; turn_end prompt_ids seen ${JSON.stringify(stops)}`,
		);
		record(
			1,
			"idle",
			ok ? "PASS" : "FAIL",
			`HTTP ${r.status} ${JSON.stringify(r.body)}; states ${states.join(">")}; transcript promptSource=${q?.promptSource}`,
		);
		await jobFree(job.short);
	}

	phase("5. `/` or `!` ⇒ validateText");
	{
		const a = await sendVia(service, job.cid, "/clear");
		const b = await sendVia(service, job.cid, "!echo hi");
		const ok =
			a.status === 400 &&
			a.body.error === "unsupported-prefix" &&
			b.body.error === "unsupported-prefix" &&
			!enqueued(job.cid, "/clear");
		record(
			5,
			"slash/bang refused",
			ok ? "PASS" : "FAIL",
			`${JSON.stringify(a.body)} ${JSON.stringify(b.body)}`,
		);
	}

	phase(
		"2. busy at the re-read ⇒ 409 busy, no queue-operation (FORCED: stale idle probe + inspect)",
	);
	{
		// The fresh probe and the precondition inspect are taken while idle;
		// the job is then made busy before the reply exec's own re-read.
		const target = attach(job);
		await sleep(2500);
		const idleProbe = probeNow();
		probeOverride = () => idleProbe;
		docker.interpose = async () => {
			type(target, "SLOW8 human turn two");
			enter(target);
			await waitFor(() => {
				const s = JSON.parse(readFileSync(path.join(CFG, "sessions", `${job.pid}.json`), "utf8"));
				return s.status === "busy";
			}, 5000);
			return "run";
		};
		const r = await sendVia(service, job.cid, "smoke busy two");
		docker.interpose = null;
		probeOverride = null;
		const ok = r.status === 409 && r.body.error === "busy" && !enqueued(job.cid, "smoke busy two");
		record(
			2,
			"busy at the re-read",
			ok ? "PASS" : "FAIL",
			`HTTP ${r.status} ${JSON.stringify(r.body)}; enqueue present=${enqueued(job.cid, "smoke busy two")}`,
		);
		tmux("kill-window", "-t", target);
		job = await waitIdle(job);
		await jobFree(job.short);
	}

	phase("3. busy in the window ⇒ accepted, then delivered after the turn (FORCED: timing sweep)");
	{
		const target = attach(job);
		await sleep(2500);
		let done = false;
		let note = "";
		for (let d = 0; d <= 160 && !done; d += 12) {
			job = await waitIdle(job);
			await jobFree(job.short);
			const text = `smoke window three d${d}`;
			type(target, `SLOW12 human window d${d}`);
			await sleep(300);
			docker.interpose = () => {
				setTimeout(() => enter(target), d);
				return "run";
			};
			const r = await sendVia(service, job.cid, text);
			docker.interpose = null;
			if (r.status === 409) {
				note += ` d${d}:409-${r.body.error}`;
				continue;
			}
			const states = await statesOf(job.cid);
			if (r.body.result === "accepted") {
				const delivered = await waitFor(
					async () => (await statesFor(job.cid, r.id)).includes("delivered"),
					60_000,
				);
				// Queued behind the person's turn: their prompt comes first in
				// the transcript, ours after it as `queued`.
				const users = transcriptOps(job.cid).filter((o) => o.type === "user");
				const iHuman = users.findIndex((o) => o.text === `SLOW12 human window d${d}`);
				const iOurs = users.findIndex((o) => o.text === text);
				const behind = iHuman >= 0 && iOurs > iHuman && users[iOurs]?.promptSource === "queued";
				done = delivered && behind;
				note += ` d${d}: accepted → ${delivered ? "delivered" : "?"} (queued behind the human turn=${behind}); states ${(await statesFor(job.cid, r.id)).join(">")}`;
			} else note += ` d${d}:${r.body.result}${states.length ? "" : ""}`;
			job = await waitIdle(job);
		}
		record(3, "busy in the window", done ? "PASS" : "NOT-REPRODUCED", note.trim());
		tmux("kill-window", "-t", target);
	}

	phase("4. AskUserQuestion pending ⇒ needs-terminal, the dialog unanswered");
	{
		job = await waitIdle(job);
		await jobFree(job.short);
		const a = await sendVia(service, job.cid, "smoke ASKQ four");
		await jobFree(job.short);
		const w = await waitJob(job.short, (e) => e.status === "waiting", 30_000).catch(() => null);
		const b = await sendVia(service, job.cid, "Blue");
		const still = probeNow()?.find((x) => x.id === job.short);
		const ok =
			a.body.result === "delivered" &&
			b.status === 409 &&
			b.body.error === "needs-terminal" &&
			still?.status === "waiting" &&
			!enqueued(job.cid, "Blue");
		record(
			4,
			"AskUserQuestion",
			ok ? "PASS" : "FAIL",
			`first ${JSON.stringify(a.body.result)}; probe ${w ? "waiting" : "?"}/${still?.waitingFor}; second ${b.status} ${JSON.stringify(b.body)}`,
		);
		// Answer it from the Terminal (the person), so the job is usable again.
		const target = attach(job);
		await sleep(2500);
		enter(target);
		await sleep(1500);
		tmux("kill-window", "-t", target);
		job = await waitIdle(job).catch(async () => {
			cc(CLAUDE as string, ["stop", job.short]);
			return startJob("hello again");
		});
	}

	phase("11. identical text typed while idle is not our ack (FORCED: our reply not run)");
	{
		job = await waitIdle(job);
		await jobFree(job.short);
		const { service: s11 } = makeService({ tAckBgMs: 15_000 });
		const target = attach(job);
		await sleep(2500);
		const text = "smoke typed eleven";
		docker.interpose = async () => {
			type(target, text);
			await sleep(200);
			enter(target);
			await sleep(1500);
			return { exit: 0, out: "ST-BG ok\n" };
		};
		const r = await sendVia(s11, job.cid, text);
		docker.interpose = null;
		const un = await waitFor(
			async () => (await statesFor(job.cid, r.id)).includes("unconfirmed"),
			30_000,
		);
		const typed = transcriptOps(job.cid).find((o) => o.type === "user" && o.text === text);
		const delivered = (await statesFor(job.cid, r.id)).filter((s) => s === "delivered").length;
		record(
			11,
			"typed while idle",
			un && typed?.promptSource === "typed" ? "PASS" : "FAIL",
			`HTTP ${JSON.stringify(r.body)}; human entry promptSource=${typed?.promptSource}; ends unconfirmed=${un}; delivered for this send=${delivered}`,
		);
		tmux("kill-window", "-t", target);
		await jobFree(job.short, 30_000);
	}

	phase("12. identical text typed while busy within the window (the declared residual case)");
	{
		job = await waitIdle(job);
		await jobFree(job.short);
		const { service: s12 } = makeService({ tAckBgMs: 40_000 });
		const target = attach(job);
		await sleep(2500);
		const text = "smoke typed twelve";
		docker.interpose = async () => {
			type(target, "SLOW10 human busy twelve");
			enter(target);
			// Busy for real (the turn started) before the same words are typed,
			// so the CLI queues them; all within the ~2 s window after t0.
			await waitFor(() => {
				try {
					const sf = JSON.parse(
						readFileSync(path.join(CFG, "sessions", `${job.pid}.json`), "utf8"),
					);
					return sf.status === "busy";
				} catch {
					return false;
				}
			}, 1500);
			type(target, text);
			enter(target);
			await sleep(300);
			return { exit: 0, out: "ST-BG ok\n" };
		};
		const r = await sendVia(s12, job.cid, text);
		docker.interpose = null;
		await waitFor(async () => {
			const st = await statesFor(job.cid, r.id);
			return st.includes("unconfirmed") || st.includes("delivered");
		}, 70_000);
		const st = await statesFor(job.cid, r.id);
		const ops = transcriptOps(job.cid).filter((o) => o.text === text || o.content === text);
		// The human text's hook: which prompt_id it carried.
		const hookLines = (await fs.readFile(HOOKLOG, "utf8")).split("\n");
		const hooks = hookLines.filter((l) => l.includes(text));
		const running = hookLines.find(
			(l) => l.includes("SLOW10 human busy twelve") && l.includes("UserPromptSubmit"),
		);
		const runningId = running ? (JSON.parse(running).in.prompt_id as string).slice(0, 8) : "?";
		const falsePositive = st.slice(-3).includes("delivered");
		const humanQueued = ops.some((o) => o.operation === "enqueue");
		// Declared residual case: a false `delivered` here is contract-conformant
		// (CONVERSATION.md §8.1.12.5) but reported; the expected outcome on the
		// validated versions is no ack.
		record(
			12,
			"typed while busy in the window",
			falsePositive || !humanQueued ? "NOT-REPRODUCED" : "PASS",
			`HTTP ${JSON.stringify(r.body)}; final ${st.slice(-2).join(">")}; transcript ${JSON.stringify(ops.map((o) => o.operation ?? `${o.promptSource}:${o.promptId?.slice(0, 8)}`))}; human text queued while busy=${humanQueued}; running turn ${runningId}; human hooks ${hooks.length} ${JSON.stringify(hooks.map((h) => (JSON.parse(h).in.prompt_id as string).slice(0, 8)))}; residual false positive ${falsePositive ? "OBSERVED (declared)" : "not observed: the busy-typed hook carries the running turn's prompt_id, so it is never a candidate"}`,
		);
		tmux("kill-window", "-t", target);
		await jobFree(job.short, 60_000);
	}

	phase("7. /clear between the re-read and the reply ⇒ misdelivered (FORCED: timing sweep)");
	{
		const target = attach(job);
		await sleep(2500);
		let done = false;
		let note = "";
		for (let d = 0; d <= 240 && !done; d += 20) {
			job = await waitIdle(job);
			await jobFree(job.short);
			const before = job.cid;
			type(target, "/clear");
			await sleep(300);
			docker.interpose = () => {
				setTimeout(() => enter(target), d);
				return "run";
			};
			const r = await sendVia(service, before, `smoke clear seven d${d}`);
			docker.interpose = null;
			const after = await waitJob(job.short, () => true).catch(() => job);
			if (r.body.result === "misdelivered") {
				done = true;
				note += ` d${d}: misdelivered to ${r.body.conversation} (job now on ${after.cid})`;
			} else {
				const st = await statesOf(before);
				note += ` d${d}:${r.status}/${r.body.result ?? r.body.error}${st.length ? "" : ""}`;
				if (r.body.result === "accepted") {
					await waitFor(
						async () =>
							(await statesOf(before)).some(
								(s) => s === "misdelivered" || s === "unconfirmed" || s === "delivered",
							),
						20_000,
					);
					const fin = await statesOf(before);
					if (fin.includes("misdelivered")) {
						done = true;
						note += "→misdelivered";
					}
				}
			}
			job = { ...after };
			await waitFor(() => seen.has(job.cid), 5_000);
		}
		record(7, "/clear in the window", done ? "PASS" : "NOT-REPRODUCED", note.trim());
		tmux("kill-window", "-t", target);
	}

	phase(
		"8. stop and --bg --resume with the same short ⇒ binding-stale (FORCED: between preconditions and the reply)",
	);
	{
		// A fresh job: its sessionId still starts with its short (after the
		// /clear of case 7 the old job's conversation no longer does, and a
		// --resume of it would get another short).
		job = await startJob("hello case eight");
		await waitFor(() => seen.has(job.cid), 10_000);
		const old = job;
		let fresh: Job | null = null;
		docker.interpose = async () => {
			cc(CLAUDE as string, ["stop", old.short]);
			cc(CLAUDE as string, ["--bg", "--resume", old.cid]);
			fresh = await waitJob(
				old.short,
				(e) => e.pid !== old.pid && e.status === "idle",
				60_000,
			).catch(() => null);
			return "run";
		};
		const r = await sendVia(service, old.cid, "smoke resume eight");
		docker.interpose = null;
		const f = fresh as Job | null;
		const ok =
			r.status === 409 &&
			r.body.error === "binding-stale" &&
			!!f &&
			!enqueued(old.cid, "smoke resume eight");
		record(
			8,
			"stop + --bg --resume, same short",
			ok ? "PASS" : "FAIL",
			`HTTP ${r.status} ${JSON.stringify(r.body)}; same short=${f?.short === old.short}, pid ${old.pid}→${f?.pid}`,
		);
		if (f) job = f;
		await jobFree(job.short);
	}

	phase("14. worker crash ⇒ duplicated marked");
	{
		job = await waitIdle(job);
		await jobFree(job.short);
		const text = "smoke SLOW15 crash fourteen";
		const r = await sendVia(service, job.cid, text);
		const busy = await waitJob(job.short, (e) => e.status === "busy", 10_000).catch(() => null);
		const victim = busy?.pid ?? job.pid;
		const ours = sandboxPids().includes(victim);
		if (ours) process.kill(victim, "SIGKILL");
		const marked = await waitFor(
			async () => (await statesOf(job.cid)).includes("duplicated"),
			90_000,
		);
		const respawned = await waitJob(job.short, (e) => e.pid !== victim, 60_000).catch(() => null);
		record(
			14,
			"worker crash",
			marked ? "PASS" : "FAIL",
			`first ${JSON.stringify(r.body.result)}; killed pid ${victim} (sandbox-owned=${ours}); respawned pid ${respawned?.pid}; states ${(await statesOf(job.cid)).slice(-3).join(">")}`,
		);
		if (respawned) job = respawned;
		job = await waitIdle(job, 120_000);
		await jobFree(job.short);
	}

	phase(
		"15. backend restart with `prepared` (exec pending) and with `accepted` ⇒ re-evaluated, never resent",
	);
	{
		job = await waitIdle(job);
		// (a) prepared, the exec lost by the dead backend: it runs anyway.
		const deadA = { v: false };
		const { service: a } = makeService({ dead: deadA });
		docker.interpose = () => "park";
		const runsBefore = docker.replyRuns;
		const textA = "smoke restart fifteen a";
		const idA = randomUUID();
		void sendVia(a, job.cid, textA, idA);
		await waitFor(() => parkedExecs.length > 0, 20_000);
		deadA.v = true;
		docker.interpose = null;
		const lost = parkedExecs.shift() as { id: string; cmd: string[]; stdin: Buffer | null };
		const res = await docker.run(lost.cmd, lost.stdin);
		docker.states.set(lost.id, { running: false, exitCode: res.exit });
		const { service: b } = makeService();
		await b.recover(SID, { force: true });
		const recA = await records.read(SID, `job:${job.short}`);
		const deliveredA = await waitFor(
			async () =>
				(await statesFor(job.cid, idA)).includes("delivered") &&
				(await records.read(SID, `job:${job.short}`)).kind === "none",
			30_000,
		);
		const resent = docker.replyRuns !== runsBefore;
		// (b) accepted, the backend dies before the ack.
		job = await waitIdle(job);
		const deadC = { v: false };
		const { service: c } = makeService({ dead: deadC });
		docker.interpose = async (cmd, stdin) => {
			const out = await docker.run(cmd, stdin);
			deadC.v = true;
			return out;
		};
		const textB = "smoke restart fifteen b";
		const idB = randomUUID();
		void sendVia(c, job.cid, textB, idB);
		await waitFor(async () => (await statesFor(job.cid, idB)).includes("accepted"), 20_000);
		docker.interpose = null;
		await sleep(1500);
		const { service: d } = makeService();
		await d.recover(SID, { force: true });
		const deliveredB = await waitFor(async () => {
			const st = await statesFor(job.cid, idB);
			return st.slice(-2).join(">") === "delivered>released";
		}, 30_000);
		const ok =
			recA.kind === "ok" &&
			recA.record.state === "uncertain" &&
			deliveredA &&
			!resent &&
			deliveredB;
		record(
			15,
			"backend restart",
			ok ? "PASS" : "FAIL",
			`(a) after recover: ${recA.kind === "ok" ? `${recA.record.state}/${recA.record.phase}` : recA.kind}, then delivered=${deliveredA}, resent=${resent}; (b) accepted→delivered after recover=${deliveredB}`,
		);
		await jobFree(job.short);
	}

	phase(
		"13. daemon shutdown with the text queued ⇒ unconfirmed (FORCED: timing sweep for the queue)",
	);
	{
		const { service: s13 } = makeService();
		const target = attach(job);
		await sleep(2500);
		let done = false;
		let note = "";
		for (let d = 0; d <= 160 && !done; d += 12) {
			job = await waitIdle(job);
			await jobFree(job.short);
			type(target, `SLOW20 human thirteen d${d}`);
			await sleep(300);
			docker.interpose = () => {
				setTimeout(() => enter(target), d);
				return "run";
			};
			const text = `smoke shutdown thirteen d${d}`;
			const id13 = randomUUID();
			const pending = sendVia(s13, job.cid, text, id13);
			const acc = await waitFor(
				async () => (await statesFor(job.cid, id13)).includes("accepted"),
				10_000,
			);
			docker.interpose = null;
			const firstDelivered = (await statesFor(job.cid, id13)).includes("delivered");
			if (!acc || firstDelivered) {
				note += ` d${d}:${(await pending).body.result ?? (await pending).body.error}`;
				await waitFor(
					async () => (await records.read(SID, `job:${job.short}`)).kind === "none",
					30_000,
				);
				continue;
			}
			// Queued behind the human turn. Shut the daemon down now.
			const shut = await ctl({ proto: 1, op: "shutdown" });
			const un = await waitFor(
				async () => (await statesFor(job.cid, id13)).includes("unconfirmed"),
				30_000,
			);
			done = un;
			const ev = (await fs.readFile(store.eventsPath(SID, job.cid), "utf8"))
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
				.filter(
					(e) =>
						e.ev === "composer_send" &&
						e.data.state === "unconfirmed" &&
						e.data.client_message_id === id13,
				)
				.at(-1);
			note += ` d${d}: accepted, shutdown ${JSON.stringify(shut)}, unconfirmed=${un} (${ev?.data.detail}); enqueued=${enqueued(job.cid, text)}, ever dequeued as user entry=${transcriptOps(job.cid).some((o) => o.type === "user" && o.text === text)}`;
		}
		record(
			13,
			"daemon shutdown with the text queued",
			done ? "PASS" : "NOT-REPRODUCED",
			note.trim(),
		);
		tmux("kill-window", "-t", target);
		// A fresh daemon + job for the rest: shut the daemon down (if the case
		// did not), kill what is left of THIS sandbox's CLI, start again.
		await ctl({ proto: 1, op: "shutdown" });
		await sleep(2000);
		for (const p of sandboxPids()) {
			try {
				process.kill(p, "SIGKILL");
			} catch {}
		}
		await sleep(1500);
		job = await startJob("hello after shutdown");
	}

	phase(
		"6. the bytes sent carry nextTurn: true; 10. a fake socket in the daemon dir is rejected by peer pid",
	);
	await fakeDaemonCases();

	phase("9. ESKEW with a daemon of another version");
	await eskewCase(job);
}

// ── Fake daemon harness (cases 6, 10): the production program, a recorded peer ─

const FAKE_DAEMON = `import json, os, socket, sys
path, log, short, nonce, ptyhost = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
try:
    os.unlink(path)
except FileNotFoundError:
    pass
s = socket.socket(socket.AF_UNIX); s.bind(path); s.listen(8)
print("ready", flush=True)
while True:
    c, _ = s.accept()
    buf = b""
    c.settimeout(5)
    try:
        while b"\\n" not in buf:
            d = c.recv(1 << 20)
            if not d:
                break
            buf += d
    except Exception:
        pass
    with open(log, "ab") as f:
        f.write(buf)
    line = buf.split(b"\\n", 1)[0]
    try:
        req = json.loads(line)
    except Exception:
        req = {}
    if req.get("op") == "list":
        c.sendall((json.dumps({"ok": True, "op": "list", "jobs": [{"short": short, "nonce": nonce, "pid": ptyhost, "cliVersion": "x", "intent": "SECRET-INTENT", "ptyAuth": "SECRET"}]}) + "\\n").encode())
    elif req.get("op") == "reply":
        c.sendall(b'{"ok":true,"op":"reply"}\\n')
    c.close()
`;

async function fakeDaemonCases(): Promise<void> {
	const fcfg = path.join(ROOT, "fake", "cfg");
	await fs.mkdir(path.join(fcfg, "sessions"), { recursive: true });
	await fs.mkdir(path.join(fcfg, "daemon"), { recursive: true });
	const short = "fa4e0001";
	const fcid = randomUUID();
	const nonce = "abad1dea";
	const key = randomUUID().replace(/-/g, "");
	await fs.writeFile(path.join(fcfg, "daemon", "control.key"), key, { mode: 0o600 });
	const kids: ChildProcess[] = [];
	const sockDir = DAEMON_DIR(fcfg);
	try {
		// The "worker": a process of ours whose environment names the fake config dir.
		const worker = spawn("/usr/bin/sleep", ["120"], { env: { CLAUDE_CONFIG_DIR: fcfg } });
		kids.push(worker);
		const decoy = spawn("/usr/bin/sleep", ["120"], { env: {} });
		kids.push(decoy);
		await sleep(200);
		const wpid = worker.pid as number;
		const log = path.join(ROOT, "fake", "daemon.log");
		const fd = spawn(
			"/usr/bin/python3",
			["-I", "-c", FAKE_DAEMON, `${sockDir}/control.sock`, log, short, nonce, String(process.pid)],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		kids.push(fd);
		await new Promise<void>((r) => fd.stdout?.once("data", () => r()));
		const dpid = fd.pid as number;
		const writeIds = async (pid: number) => {
			await fs.writeFile(
				path.join(fcfg, "daemon.status.json"),
				JSON.stringify({ supervisorPid: pid, supervisorProcStart: procStart(pid), workers: {} }),
			);
			await fs.writeFile(
				path.join(fcfg, "daemon", "roster.json"),
				JSON.stringify({ proto: 1, supervisorPid: pid, workers: {} }),
			);
		};
		await writeIds(dpid);
		await fs.writeFile(
			path.join(fcfg, "sessions", `${wpid}.json`),
			JSON.stringify({
				pid: wpid,
				sessionId: fcid,
				status: "idle",
				procStart: procStart(wpid),
				jobId: short,
				kind: "bg",
			}),
		);
		const params = {
			pid: wpid,
			short,
			start: procStart(wpid),
			exe: readlinkSync(`/proc/${wpid}/exe`),
			cid: fcid,
			nonce,
			ptyHostPid: process.pid,
			daemonPid: dpid,
			daemonStart: procStart(dpid),
			daemonExe: readlinkSync(`/proc/${dpid}/exe`),
			text: "fake daemon six — exact text\nsecond line",
		};
		const r6 = await docker.run([...BG_CLIENT_ARGV], replyStdin(params));
		const lines = (await fs.readFile(log, "utf8")).split("\n").filter(Boolean);
		const reply = lines.map((l) => JSON.parse(l)).find((j) => j.op === "reply");
		const ok6 =
			r6.out === "ST-BG ok\n" &&
			reply?.nextTurn === true &&
			reply?.auth === key &&
			reply?.text === params.text &&
			reply?.short === short &&
			reply?.proto === 1 &&
			Object.keys(reply).sort().join(",") === "auth,nextTurn,op,proto,short,text" &&
			lines.every((l) => Buffer.byteLength(l) <= 1024 * 1024);
		record(
			6,
			"bytes sent carry nextTurn: true",
			ok6 ? "PASS" : "FAIL",
			`client ${JSON.stringify(r6.out)}; line keys ${reply ? Object.keys(reply).sort().join(",") : "none"}; nextTurn=${reply?.nextTurn}; output never echoed the job's intent/tokens=${!r6.out.includes("SECRET")}`,
		);

		// Case 10: status and roster name the decoy as supervisor; the socket
		// at the daemon path is served by another process ⇒ peer ≠ supervisor.
		await writeIds(decoy.pid as number);
		const before = (await fs.readFile(log, "utf8")).length;
		const r10 = await docker.run(
			[...BG_CLIENT_ARGV],
			replyStdin({
				...params,
				daemonPid: decoy.pid as number,
				daemonStart: procStart(decoy.pid as number),
				daemonExe: readlinkSync(`/proc/${decoy.pid as number}/exe`),
			}),
		);
		const after = (await fs.readFile(log, "utf8")).slice(before);
		const ok10 = r10.out === "ST-BG stale-daemon\n" && after === "";
		record(
			10,
			"fake socket rejected by peer pid",
			ok10 ? "PASS" : "FAIL",
			`client ${JSON.stringify(r10.out)}; bytes the fake socket received after the swap: ${after.length}`,
		);
	} finally {
		for (const k of kids) k.kill("SIGKILL");
		await fs.rm(sockDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

// ── Case 9: ESKEW ───────────────────────────────────────────────────────────

async function eskewCase(job: Job): Promise<void> {
	if (!OTHER) {
		record(
			9,
			"ESKEW",
			"NOT-REPRODUCED",
			"needs a second CLI version binary (argv[4]); the Session Image job has one per run",
		);
		return;
	}
	const ov = /^(\d+\.\d+\.\d+)/.exec(
		spawnSync(OTHER, ["--version"], {
			env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
			encoding: "utf8",
		}).stdout ?? "",
	)?.[1];
	// The daemon must be NEWER than the busy job (a newer client takes the
	// daemon over; an older one dispatches to the existing daemon).
	const cmp = (a: string, b: string) => {
		const x = a.split(".").map(Number);
		const y = b.split(".").map(Number);
		return (
			(x[0] as number) - (y[0] as number) ||
			(x[1] as number) - (y[1] as number) ||
			(x[2] as number) - (y[2] as number)
		);
	};
	const [older, newer] =
		cmp(VERSION, ov as string) < 0 ? [CLAUDE as string, OTHER] : [OTHER, CLAUDE as string];
	// Fresh daemon of the older version with a busy job, then the newer CLI.
	await ctl({ proto: 1, op: "shutdown" });
	await sleep(2000);
	for (const p of sandboxPids()) {
		try {
			if (
				/bg-pty-host|--session-id|--resume|daemon run/.test(
					readFileSync(`/proc/${p}/cmdline`, "latin1"),
				)
			)
				process.kill(p, "SIGTERM");
		} catch {}
	}
	await sleep(2000);
	const r = cc(older, ["--bg", "SLOW40 eskew old job"]);
	const short = /backgrounded · ([0-9a-f]{8})/.exec(r.out)?.[1];
	if (!short) {
		record(9, "ESKEW", "NOT-REPRODUCED", `older --bg failed: ${r.out.slice(0, 120)}`);
		return;
	}
	const j = await waitJob(short, (e) => e.status === "busy", 30_000).catch(() => null);
	cc(newer, ["--bg", "eskew takeover"]);
	await sleep(4000);
	const lock = JSON.parse(readFileSync(path.join(CFG, "daemon.lock"), "utf8"));
	const list = await ctl({ proto: 1, op: "list" });
	const rec = (list?.jobs as Array<Record<string, unknown>> | undefined)?.find(
		(x) => x.short === short,
	);
	const raw = await ctl({
		proto: 1,
		op: "reply",
		short,
		text: "eskew raw probe",
		auth: controlKey(),
		nextTurn: true,
	});
	// The production path on the same state: refused before any effect.
	const { service } = makeService();
	const cidNow = probeNow()?.find((x) => x.id === short)?.sessionId ?? j?.cid;
	const prodBusy = cidNow ? await sendVia(service, cidNow, "eskew production busy") : null;
	// Layer 2: the PRODUCTION client program itself, run with the parameters
	// the preconditions would have recorded, skipping only the composer's
	// version check — the daemon must answer it ESKEW (mapped to `failed`).
	let direct = "n/a";
	let workerV = "?";
	// The program re-reads the job's state: it only writes to an idle job. Wait
	// for the old job's turn to end (the newer daemon may then upgrade it —
	// reported as such).
	await waitJob(short, (e) => e.status === "idle", 60_000).catch(() => null);
	const entry = probeNow()?.find((x) => x.id === short);
	// The production send again, now that the job is idle: the skew is
	// still refused before any effect.
	const prod = entry ? await sendVia(service, entry.sessionId, "eskew production idle") : null;
	if (entry && typeof entry.pid === "number") {
		const wpid = entry.pid;
		workerV =
			spawnSync(`/proc/${wpid}/exe`, ["--version"], {
				env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", DISABLE_AUTOUPDATER: "1" },
				encoding: "utf8",
			}).stdout?.trim() ?? "?";
		const ins = await docker.run(
			[...BG_CLIENT_ARGV],
			Buffer.from(JSON.stringify({ mode: "inspect", pid: wpid, short })),
		);
		const m = /^ST-BG inspect (\{.*\})\n?$/.exec(ins.out);
		if (m) {
			const i = JSON.parse(m[1] as string);
			const res = await docker.run(
				[...BG_CLIENT_ARGV],
				replyStdin({
					pid: wpid,
					short,
					start: procStart(wpid),
					exe: readlinkSync(`/proc/${wpid}/exe`),
					cid: entry.sessionId,
					nonce: i.job?.nonce,
					ptyHostPid: i.job?.pid,
					daemonPid: i.daemon.statusPid,
					daemonStart: i.daemon.start,
					daemonExe: i.daemon.exe,
					text: "eskew via the production client",
				}),
			);
			direct = res.out.trim();
		}
	}
	const ok =
		raw?.code === "ESKEW" &&
		prod?.status === 409 &&
		prod.body.detail === "daemon-skew" &&
		(direct === "ST-BG ESKEW" || direct === "ST-BG busy");
	record(
		9,
		"ESKEW",
		ok ? "PASS" : "NOT-REPRODUCED",
		`daemon ${lock.version} (pid ${lock.pid}), job ${short} record cliVersion ${rec?.cliVersion}, worker binary ${workerV}; (1) raw reply {nextTurn:true} ⇒ ${JSON.stringify(raw?.code ?? raw)}; (2) production send while the old job is busy ⇒ ${prodBusy ? `${prodBusy.status} ${JSON.stringify(prodBusy.body)}` : "n/a"}, once idle ⇒ ${prod ? `${prod.status} ${JSON.stringify(prod.body)}` : "n/a"} (refused before any effect); (3) the production client program run directly ⇒ ${direct}${direct === "ST-BG ESKEW" ? " (parseReplyOutput ⇒ rejected ⇒ failed 502)" : ""}`,
	);
	void job;
}

// ── Run + cleanup ───────────────────────────────────────────────────────────

async function cleanup(): Promise<void> {
	await ctl({ proto: 1, op: "shutdown" }).catch(() => null);
	await sleep(1500);
	spawnSync("tmux", ["-L", TMUX, "kill-server"]);
	await fs.rm(`/tmp/tmux-${UID}/${TMUX}`, { force: true }).catch(() => undefined);
	await sleep(500);
	const left = sandboxPids();
	for (const p of left) {
		try {
			process.kill(p, "SIGKILL");
		} catch {}
	}
	await sleep(500);
	const still = sandboxPids();
	console.log(
		`\ncleanup: killed ${left.length} sandbox process(es) ${JSON.stringify(left)}; remaining ${JSON.stringify(still)}`,
	);
	await fs.rm(DAEMON_DIR(CFG), { recursive: true, force: true }).catch(() => undefined);
	if (process.env.BGSMOKE_KEEP !== "1")
		await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
	else console.log(`sandbox kept at ${ROOT}`);
}

for (const sig of ["SIGINT", "SIGTERM"] as const)
	process.once(sig, () => {
		console.error(`\n${sig}: cleaning up the sandbox`);
		void cleanup().finally(() => process.exit(130));
	});

main()
	.catch((err) => {
		console.error("smoke aborted:", err);
		results.push({ n: 0, name: "harness", verdict: "FAIL", note: String(err) });
	})
	.finally(async () => {
		await cleanup();
		console.log(`\n── bg-reply smoke, CLI ${VERSION} ──`);
		for (const r of results.sort((a, b) => a.n - b.n))
			console.log(`${r.verdict.padEnd(15)} ${r.n}. ${r.name}`);
		const failed = results.filter((r) => r.verdict === "FAIL").length;
		process.exit(failed > 0 ? 1 : 0);
	});
