/**
 * composer.smoke.ts — the composer's terminal assumptions (CONVERSATION.md
 * §8.2.6 revalidation list, §8.1.3 input region, §8.1.5 delivery incl. the
 * paste-consumption step 2b) against a REAL tmux and the REAL Claude Code
 * CLI, driven through the SAME argv builders and the same consumption rule
 * the backend uses (`composerText.ts`), so the smoke cannot drift from what
 * the service executes. The model is the scripted stand-in
 * `session-image/test/mock-anthropic.mjs` (no key, no egress).
 *
 * Two drivers, one scenario list:
 *
 *   cd backend && npx tsx src/conversation/composer.smoke.ts docker <image>
 *     Session Image workflow: a disposable container from the image on a
 *     private network with the mock as `mock-api`, the CLI of the image.
 *
 *   cd backend && npx tsx src/conversation/composer.smoke.ts local
 *     A private tmux server (`-L st-composer-smoke-*`) on this host with the
 *     installed `claude`, the mock on loopback, a private CLAUDE_CONFIG_DIR.
 *     Nothing touches the host's own tmux server or any session. This is how
 *     the evidence for a version in COMPOSER_CLI_VERSIONS is produced.
 *
 * The hooks are the CLI's own (project settings in the disposable project
 * dir): `UserPromptSubmit` appends its payload to a log, so "what the CLI
 * received as the prompt" is read from the CLI itself, byte for byte.
 *
 * Checks (numbers from §8.2.6):
 *   pane state parses; the ancestry script answers yes for the CLI and no
 *   for an unrelated pid; input region: empty at the idle prompt (ghost
 *   suggestion included), text after a paste without Enter, empty again
 *   after Ctrl-U; (1) one line ⇒ identical prompt, no `source`; (2) three
 *   lines with an empty one, segmented ⇒ identical; (3) an 850-code-point
 *   line, chunked at 800 ⇒ identical; (4) a leading `/` produces no
 *   UserPromptSubmit and the pane recovers; (5) a send while busy is queued
 *   and arrives identical; (8) normalize is idempotent on every received
 *   prompt; 2b: the hazard behind the consumption rule (a CSI u in the same
 *   read as the paste submits) is reproduced as evidence, and every delivery
 *   here waits for consumption exactly as the executor does. Paste →
 *   UserPromptSubmit latency is printed per case.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	ancestryArgv,
	CONSUME_MAX_POLLS,
	CONSUME_POLL_MS,
	captureArgv,
	inputRegion,
	inputRegionPlain,
	normalizeText,
	paneStateArgv,
	parsePaneState,
	pasteConsumed,
	segment,
	stepArgv,
} from "./composerText.js";

const MODE = process.argv[2] ?? "local";
const IMAGE = process.argv[3] ?? "shared-terminal-session";
const RUN = randomUUID().slice(0, 8);
const ROOT = path.join(os.tmpdir(), `st-composer-smoke-${RUN}`);
const PROJECT = path.join(ROOT, "project");
const HOOK_LOG_HOST = path.join(ROOT, "hooks.jsonl");
const TAB = "tab-composer";
const SOCK = `st-composer-smoke-${RUN}`;
const MOCK_PORT = 18080 + (process.pid % 1000);
const MOCK_REPLY_MARKER = "· done";
const SMOKE_KEY = "sk-ant-smoke-key-00000000000000000000";

let failures = 0;
function check(what: string, ok: boolean, detail?: unknown): void {
	if (ok) console.log(`  ok: ${what}`);
	else {
		failures++;
		console.error(`  FAIL: ${what}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
	}
}
function note(what: string): void {
	console.log(`  note: ${what}`);
}
function phase(name: string): void {
	console.log(`\n── ${name} ──`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Driver ──────────────────────────────────────────────────────────────────

interface Run {
	code: number;
	out: string;
}
interface Driver {
	/** Run an argv (the backend's exact shapes) with optional stdin. */
	exec(argv: string[], stdin?: string): Promise<Run>;
	/** The hook log's lines so far. */
	hookLines(): Promise<string[]>;
	/** Project path as the CLI sees it. */
	projectPath: string;
	cliVersion(): Promise<string>;
	/** `claude agents --json` reduced to kind/status/waitingFor for the smoke's CLI. */
	probeSummary(): Promise<string>;
	start(): Promise<void>;
	stop(): Promise<void>;
}

function hookSettings(logPath: string): string {
	// `cat` the payload, then a newline: one JSON object per line.
	const cmd = `cat >> ${logPath}; echo >> ${logPath}`;
	return `${JSON.stringify(
		{ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: cmd, timeout: 10 }] }] } },
		null,
		2,
	)}\n`;
}

function collect(p: ReturnType<typeof spawn>, stdin?: string): Promise<Run> {
	return new Promise((resolve) => {
		const out: Buffer[] = [];
		p.stdout?.on("data", (c: Buffer) => out.push(c));
		p.stderr?.on("data", (c: Buffer) => out.push(c));
		p.on("close", (code) =>
			resolve({ code: code ?? -1, out: Buffer.concat(out).toString("utf8") }),
		);
		if (stdin !== undefined) p.stdin?.end(stdin);
		else p.stdin?.end();
	});
}

/** Local driver: a private tmux server, the installed `claude`, the mock on loopback. */
class LocalDriver implements Driver {
	projectPath = PROJECT;
	private mock: ReturnType<typeof spawn> | null = null;
	private tmux(args: string[], stdin?: string): Promise<Run> {
		return collect(spawn("tmux", ["-L", SOCK, ...args]), stdin);
	}
	async exec(argv: string[], stdin?: string): Promise<Run> {
		// Drop the backend's `timeout -k 2 5` prefix; tmux runs on our socket.
		const i = argv.indexOf("tmux");
		if (i >= 0) return this.tmux(argv.slice(i + 1), stdin);
		const b = argv.indexOf("bash");
		return collect(spawn(argv[b]!, argv.slice(b + 1)), stdin);
	}
	async hookLines(): Promise<string[]> {
		const t = await fs.readFile(HOOK_LOG_HOST, "utf8").catch(() => "");
		return t.split("\n").filter((l) => l.trim().length > 0);
	}
	async cliVersion(): Promise<string> {
		return spawnSync("claude", ["--version"]).stdout.toString().trim();
	}
	async probeSummary(): Promise<string> {
		const r = spawnSync("claude", ["agents", "--json"], {
			env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(ROOT, "claude-config") },
			timeout: 20_000,
		});
		return summarizeProbe(r.stdout?.toString() ?? "");
	}
	async start(): Promise<void> {
		const mockPath = path.resolve(__dirname, "../../../session-image/test/mock-anthropic.mjs");
		this.mock = spawn("node", [mockPath, String(MOCK_PORT)], { stdio: "ignore" });
		await fs.mkdir(path.join(PROJECT, ".claude"), { recursive: true });
		await fs.writeFile(path.join(PROJECT, ".claude", "settings.json"), hookSettings(HOOK_LOG_HOST));
		await fs.writeFile(path.join(PROJECT, "CLAUDE.md"), "# composer smoke\n");
		// Every nested-CLI marker stripped so the lab CLI is a top-level one;
		// the project is pre-trusted in a private config dir so no dialog
		// (onboarding, trust, key approval) stands between us and the prompt.
		const cfg = path.join(ROOT, "claude-config");
		await fs.mkdir(cfg, { recursive: true });
		await fs.writeFile(
			path.join(cfg, ".claude.json"),
			JSON.stringify({
				hasCompletedOnboarding: true,
				theme: "dark",
				// The CLI matches the approval on the key's LAST 20 characters.
				customApiKeyResponses: { approved: [SMOKE_KEY.slice(-20)], rejected: [] },
				projects: {
					[PROJECT]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
				},
			}),
		);
		const unset = Object.keys(process.env)
			.filter((k) => /^(CLAUDE[A-Z_]*|AI_AGENT)/.test(k))
			.map((k) => `-u ${k}`)
			.join(" ");
		const env = [
			`ANTHROPIC_BASE_URL=http://127.0.0.1:${MOCK_PORT}`,
			`ANTHROPIC_API_KEY=${SMOKE_KEY}`,
			"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
			`CLAUDE_CONFIG_DIR=${cfg}`,
			"NO_PROXY=127.0.0.1",
		].join(" ");
		const r = await this.tmux([
			"new-session",
			"-d",
			"-s",
			TAB,
			"-x",
			"160",
			"-y",
			"45",
			"-c",
			PROJECT,
			`exec env ${unset} ${env} claude`,
		]);
		if (r.code !== 0) throw new Error(`tmux new-session failed: ${r.out}`);
	}
	async stop(): Promise<void> {
		await this.tmux(["kill-server"]);
		this.mock?.kill();
	}
}

/** Docker driver: a session container from the image on a private network with the mock. */
class DockerDriver implements Driver {
	projectPath = "/home/developer/workspace";
	private net = `st-composer-${RUN}`;
	private api = `st-composer-api-${RUN}`;
	private sess = `st-composer-sess-${RUN}`;
	private sh(cmd: string): Run {
		const r = spawnSync("bash", ["-c", cmd], { maxBuffer: 64 * 1024 * 1024 });
		return {
			code: r.status ?? -1,
			out: `${r.stdout?.toString() ?? ""}${r.stderr?.toString() ?? ""}`,
		};
	}
	private dexec(args: string[], stdin?: string): Promise<Run> {
		return collect(spawn("docker", ["exec", "-i", this.sess, ...args]), stdin);
	}
	exec(argv: string[], stdin?: string): Promise<Run> {
		return this.dexec(argv, stdin);
	}
	async hookLines(): Promise<string[]> {
		const t = await fs.readFile(path.join(ROOT, "ws", "hooks.jsonl"), "utf8").catch(() => "");
		return t.split("\n").filter((l) => l.trim().length > 0);
	}
	async cliVersion(): Promise<string> {
		return (await this.dexec(["claude", "--version"])).out.trim();
	}
	async probeSummary(): Promise<string> {
		return summarizeProbe((await this.dexec(["timeout", "20", "claude", "agents", "--json"])).out);
	}
	async start(): Promise<void> {
		const ws = path.join(ROOT, "ws");
		await fs.mkdir(path.join(ws, ".claude"), { recursive: true });
		await fs.writeFile(
			path.join(ws, ".claude", "settings.json"),
			hookSettings(`${this.projectPath}/hooks.jsonl`),
		);
		await fs.writeFile(path.join(ws, "CLAUDE.md"), "# composer smoke\n");
		// The container's `developer` user writes the hook log into the bind mount.
		await fs.chmod(ws, 0o777);
		await fs.chmod(path.join(ws, ".claude"), 0o777);
		const mock = path.resolve(__dirname, "../../../session-image/test/mock-anthropic.mjs");
		let r = this.sh(`docker network create ${this.net}`);
		if (r.code !== 0) throw new Error(`network: ${r.out}`);
		r = this.sh(
			`docker run -d --name ${this.api} --network ${this.net} --network-alias mock-api -v ${path.dirname(mock)}:/t:ro --entrypoint node ${IMAGE} /t/mock-anthropic.mjs 8080`,
		);
		if (r.code !== 0) throw new Error(`mock: ${r.out}`);
		const key = SMOKE_KEY;
		r = this.sh(
			`docker run -d --name ${this.sess} --init --cap-drop ALL --security-opt no-new-privileges --pids-limit 512 --network ${this.net} -e SESSION_ID=${randomUUID()} -e SESSION_NAME=smoke -e ANTHROPIC_BASE_URL=http://mock-api:8080 -e ANTHROPIC_API_KEY=${key} -e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 -v ${ws}:/home/developer/workspace ${IMAGE}`,
		);
		if (r.code !== 0) throw new Error(`session: ${r.out}`);
		for (let i = 0; i < 120; i++) {
			if ((await this.dexec(["test", "-f", "/tmp/.st-ready"])).code === 0) break;
			await sleep(500);
		}
		// Same onboarding seed as conversation-smoke.sh (through the ~/.claude* symlinks).
		const seed = `set -e
f=~/.claude.json; [ -s "$f" ] || echo "{}" > "$f"
jq --arg k "${key.slice(-20)}" '. + {hasCompletedOnboarding: true, theme: "dark", customApiKeyResponses: {approved: [$k], rejected: []}, projects: {"/home/developer/workspace": {hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true}}}' "$f" > /tmp/cj
cat /tmp/cj > "$f"`;
		r = await this.dexec(["bash", "-c", seed]);
		if (r.code !== 0) throw new Error(`seed: ${r.out}`);
		r = await this.dexec([
			"tmux",
			"new-session",
			"-d",
			"-s",
			TAB,
			"-x",
			"160",
			"-y",
			"45",
			"-c",
			this.projectPath,
			"claude",
		]);
		if (r.code !== 0) throw new Error(`tmux: ${r.out}`);
	}
	async stop(): Promise<void> {
		this.sh(
			`docker rm -f ${this.sess} ${this.api} >/dev/null 2>&1; docker network rm ${this.net} >/dev/null 2>&1`,
		);
	}
}

function summarizeProbe(json: string): string {
	try {
		const arr = JSON.parse(json) as Array<Record<string, unknown>>;
		return JSON.stringify(
			arr
				.filter(
					(a) =>
						String(a.cwd ?? "").includes("st-composer-smoke") ||
						String(a.cwd ?? "") === "/home/developer/workspace",
				)
				.map((a) => ({ kind: a.kind, status: a.status, waitingFor: a.waitingFor })),
		);
	} catch {
		return `unparsed (${json.length} bytes)`;
	}
}

// ── Scenario helpers ────────────────────────────────────────────────────────

let drv: Driver;
let paneId = "%0";

async function screen(): Promise<string> {
	return (await drv.exec(captureArgv(paneId))).out;
}
async function plainScreen(lines = 60): Promise<string> {
	const r = await drv.exec([
		"timeout",
		"5",
		"tmux",
		"capture-pane",
		"-p",
		"-t",
		paneId,
		"-S",
		`-${lines}`,
	]);
	return r.out;
}
async function dumpScreen(label: string): Promise<void> {
	const s = (await plainScreen(20))
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.slice(-14);
	console.log(`  screen (${label}):\n${s.map((l) => `    | ${l}`).join("\n")}`);
}
/** The CLI is at its prompt: a located, empty input region. */
async function waitPrompt(ms = 60_000): Promise<boolean> {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		if (inputRegion(await screen()).kind === "empty") return true;
		await sleep(300);
	}
	return false;
}
interface Hook {
	hook_event_name?: string;
	prompt?: string;
	source?: string;
	prompt_id?: string;
	session_id?: string;
}
async function hooks(): Promise<Hook[]> {
	return (await drv.hookLines()).map((l) => {
		try {
			return JSON.parse(l) as Hook;
		} catch {
			return {};
		}
	});
}
const prompts = async () => (await hooks()).filter((h) => h.hook_event_name === "UserPromptSubmit");
const replies = async () => (await plainScreen(400)).split(MOCK_REPLY_MARKER).length - 1;
async function waitCount(f: () => Promise<number>, n: number, ms = 20_000): Promise<boolean> {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		if ((await f()) >= n) return true;
		await sleep(100);
	}
	return false;
}

/** The turn is over: the prompt is empty again and a reply marker is on screen (the CLI may clear tmux history, so no counting). */
async function waitTurnEnd(ms = 60_000): Promise<boolean> {
	return waitCount(
		async () => (inputRegion(await screen()).kind === "empty" && (await replies()) > 0 ? 1 : 0),
		1,
		ms,
	);
}

/** The executor's consumption wait (§8.1.5 paso 2b), same rule and bounds. */
async function awaitConsumed(before: string | null, chunk: string): Promise<boolean> {
	for (let i = 0; i < CONSUME_MAX_POLLS; i++) {
		const after = inputRegionPlain(await screen());
		if (after !== null && pasteConsumed(before, after, chunk)) return true;
		await sleep(CONSUME_POLL_MS);
	}
	return false;
}

/**
 * Deliver `text` exactly as the executor does: the plan's steps in order,
 * each a fresh exec, and after every paste the consumption wait before the
 * next byte. `gapless` skips that wait (the hazard reproduction only).
 */
async function deliver(
	text: string,
	opts: { enter?: boolean; gapless?: boolean } = {},
): Promise<{ ms: number; steps: number; consumed: boolean }> {
	const plan = segment(normalizeText(text));
	const t0 = Date.now();
	let n = 0;
	let consumed = true;
	for (const step of plan.steps) {
		if (step.kind === "enter" && opts.enter === false) continue;
		const before = step.kind === "paste" && !opts.gapless ? inputRegionPlain(await screen()) : null;
		const r = await drv.exec(
			stepArgv(step, paneId, `st-composer-${RUN}`),
			step.kind === "paste" ? step.text : undefined,
		);
		n++;
		if (r.code !== 0) {
			check(`step ${step.kind} exit 0`, false, r.out);
			break;
		}
		if (step.kind === "paste" && !opts.gapless && !(await awaitConsumed(before, step.text))) {
			consumed = false;
			check("paste consumed before the next byte (2b)", false, { chunk: step.text.slice(0, 40) });
			await dumpScreen("paste not consumed");
			break;
		}
	}
	return { ms: Date.now() - t0, steps: n, consumed };
}

/** Send `text`, wait for its UserPromptSubmit and the model's reply; compare what the CLI got. */
async function sendAndReceive(label: string, text: string): Promise<void> {
	const before = (await prompts()).length;
	const repliesBefore = await replies();
	const t0 = Date.now();
	const d = await deliver(text);
	const got = await waitCount(async () => (await prompts()).length, before + 1);
	const tHook = Date.now() - t0;
	const p = (await prompts())[before];
	const expected = normalizeText(text);
	check(
		`${label}: UserPromptSubmit received (${d.steps} steps, ${d.ms} ms delivery, +${tHook} ms hook)`,
		got,
	);
	if (!got) await dumpScreen(label);
	check(`${label}: prompt identical to the normalized text`, p?.prompt === expected, {
		expected: expected.slice(0, 120),
		got: p?.prompt?.slice(0, 120),
	});
	check(
		`${label}: no \`source\` on the hook (a typed prompt, not a resume)`,
		p !== undefined && !("source" in p),
	);
	check(
		`${label}: normalize idempotent on the received prompt (§8.2.6 (8))`,
		p?.prompt !== undefined && normalizeText(p.prompt) === p.prompt,
	);
	// The CLI redraws and may clear tmux's history, so reply markers are not
	// counted: the turn is over when the prompt is empty again and a reply is on screen.
	check(
		`${label}: the turn ends (prompt empty again, the model's reply on screen)`,
		await waitTurnEnd(),
		{
			repliesBefore,
			replies: await replies(),
		},
	);
}

async function main(): Promise<void> {
	await fs.mkdir(ROOT, { recursive: true });
	drv = MODE === "docker" ? new DockerDriver() : new LocalDriver();
	let version = "?";
	try {
		phase(`start (${MODE})`);
		await drv.start();
		version = await drv.cliVersion();
		note(`CLI under test: ${version}`);
		const pid = await drv.exec(["timeout", "5", "tmux", "display", "-p", "-t", TAB, "#{pane_id}"]);
		paneId = pid.out.trim() || "%0";
		note(`pane ${paneId}`);
		check("the CLI reaches its prompt", await waitPrompt());
		await dumpScreen("idle");

		phase("pane state, ancestry, input region");
		const st = parsePaneState((await drv.exec(paneStateArgv(paneId))).out);
		check("pane state parses", st !== null, st);
		check("pane not in copy mode, not dead", st?.inMode === false && st?.dead === false, st);
		note(`pane_current_command = ${st?.command}`);
		if (st) {
			const yes = (await drv.exec(ancestryArgv(st.panePid, st.panePid))).out.trim();
			check("ancestry: the pane pid itself ⇒ yes", yes === "yes", yes);
			const no = (await drv.exec(ancestryArgv(1, st.panePid))).out.trim();
			check("ancestry: pid 1 ⇒ no", no === "no", no);
			const child = (await drv.exec(["bash", "-c", `pgrep -P ${st.panePid} | head -1`])).out.trim();
			if (child) {
				const r = (await drv.exec(ancestryArgv(Number(child), st.panePid))).out.trim();
				check(`ancestry: the pane's child ${child} ⇒ yes`, r === "yes", r);
			}
		}
		const idle = inputRegion(await screen());
		check(
			"input region at the idle prompt ⇒ empty (ghost suggestion must not count)",
			idle.kind === "empty",
			idle,
		);
		await deliver("typed but not sent", { enter: false });
		await sleep(300);
		const typed = inputRegion(await screen());
		check("input region after a paste without Enter ⇒ text", typed.kind === "text", typed);
		await drv.exec(["timeout", "5", "tmux", "send-keys", "-t", paneId, "C-u"]);
		await sleep(400);
		const cleared = inputRegion(await screen());
		check("input region after Ctrl-U ⇒ empty", cleared.kind === "empty", cleared);

		phase("§8.2.6 (1): one line");
		await sendAndReceive("one line", "hello from the composer smoke");

		phase("§8.2.6 (2): three lines with an empty one, segmented");
		await sendAndReceive("three lines", "first line\n\nthird line after an empty one");

		phase("§8.2.6 (3): an 850-code-point line chunked at 800");
		await sendAndReceive("850 cps", `${"x".repeat(799)}Y${"z".repeat(50)}`);

		phase("§8.2.6 (2 again): identical consecutive lines (count-based consumption)");
		await sendAndReceive("same lines", "same\nsame\nsame");

		phase("§8.1.5 2b: the hazard — a CSI u in the same read as the paste");
		{
			const before = (await prompts()).length;
			// Paste + CSI u + paste with NO consumption wait and no Enter: what the
			// executor must never do. If the CLI submits, the hazard is real for
			// this version; either way the input is cleared afterwards.
			await deliver("hazard-a\nhazard-b", { enter: false, gapless: true });
			await sleep(2500);
			const submitted = (await prompts()).length - before;
			note(
				`gapless paste→CSI u→paste: ${submitted} prompt(s) submitted without Enter (${
					submitted > 0
						? "hazard reproduced — step 2b is load-bearing"
						: "not reproduced on this version"
				})`,
			);
			if (submitted > 0) {
				note(
					`submitted text: ${JSON.stringify((await prompts()).slice(before).map((p) => p.prompt))}`,
				);
				check(
					"the hazard turn ends",
					(await waitCount(replies, (await replies()) + 0, 1_000)) || (await waitPrompt(60_000)),
				);
			}
			await drv.exec(["timeout", "5", "tmux", "send-keys", "-t", paneId, "C-u"]);
			await sleep(300);
			await drv.exec(["timeout", "5", "tmux", "send-keys", "-t", paneId, "C-u"]);
			check("input cleared after the hazard check", await waitPrompt(10_000));
		}

		phase("§8.2.6 (5): a send while the CLI is busy is queued and arrives identical");
		{
			const before = (await prompts()).length;
			const repliesBefore = await replies();
			await deliver("ST_SCENARIO=slow:12:400 keep streaming");
			check(
				"first prompt received",
				await waitCount(async () => (await prompts()).length, before + 1),
			);
			await sleep(600); // the model is now streaming (≈ 5 s)
			const text = "queued while busy";
			const d = await deliver(text);
			check(
				"delivery while busy: pastes consumed (the input is usable while streaming)",
				d.consumed,
			);
			check(
				"second (queued) prompt received",
				await waitCount(async () => (await prompts()).length, before + 2, 30_000),
			);
			const p2 = (await prompts())[before + 1];
			check("queued prompt identical", p2?.prompt === text, p2?.prompt);
			// The streaming turn and the queued one both end: the prompt is empty
			// again and at least one more reply marker is on screen.
			check("both turns end", await waitTurnEnd());
			note(`reply markers on screen: ${await replies()} (before: ${repliesBefore})`);
		}

		phase("§8.2.6 (4): a leading / is a command, never a prompt");
		{
			const before = (await prompts()).length;
			// The API refuses `/…` (unsupported-prefix); this proves WHY: delivered
			// raw, the CLI treats it as a command.
			await deliver("/help", { gapless: true });
			await sleep(2500);
			check("no UserPromptSubmit for /help", (await prompts()).length === before);
			note(`screen after /help: input region ${JSON.stringify(inputRegion(await screen()))}`);
			note(`probe while the /help dialog is open: ${await drv.probeSummary()}`);
			await drv.exec(["timeout", "5", "tmux", "send-keys", "-t", paneId, "Escape"]);
			await sleep(800);
			const back = await waitPrompt(10_000);
			check("the pane recovers after Escape (prompt visible again)", back);
			if (!back) await dumpScreen("after /help + Escape");
		}

		phase("§8.2.6 (4b): a leading ! is shell mode, never a prompt");
		{
			const before = (await prompts()).length;
			await deliver("!echo composer-smoke-bang", { gapless: true });
			await sleep(2500);
			check("no UserPromptSubmit for !…", (await prompts()).length === before);
			await dumpScreen("after !… + Enter");
			await drv.exec(["timeout", "5", "tmux", "send-keys", "-t", paneId, "Escape"]);
			await sleep(800);
			await drv.exec(["timeout", "5", "tmux", "send-keys", "-t", paneId, "C-u"]);
			const back = await waitPrompt(20_000);
			check("the pane recovers after Escape + Ctrl-U (prompt visible again)", back);
			if (!back) await dumpScreen("after !… + Escape");
		}

		phase("summary");
		const all = await prompts();
		note(
			`${all.length} UserPromptSubmit in total; session ids: ${[...new Set(all.map((p) => p.session_id?.slice(0, 8)))].join(",")}`,
		);
	} catch (err) {
		failures++;
		console.error(`  FAIL: ${(err as Error).stack ?? err}`);
		await dumpScreen("at error").catch(() => undefined);
	} finally {
		await drv.stop().catch(() => undefined);
		await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
	}
	console.log(`\nCLI ${version}: ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILED`}`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
