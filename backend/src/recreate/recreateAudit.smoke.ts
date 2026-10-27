/**
 * recreateAudit.smoke.ts — the 3.0d integral audit's smoke extension
 * (docs/design/phase3-3.0d-audit.md §10), run by the Session Image workflow:
 *
 *   cd backend && npx tsx src/recreate/recreateAudit.smoke.ts <image>
 *
 * Against the CI runner's REAL dockerd: the real session image (relay,
 * supervisor, entrypoint), the real CLI 2.1.308 with the scripted model
 * (session-image/test/mock-anthropic.mjs), the backend's real recreation
 * engine and capture authority, the real ingest stack
 * (session-image/test/st-receiver.mts), the real port dispatcher
 * (session-image/test/st-dispatcher.mts) and the real emergency CLI. What is
 * NOT real is stated per scenario and in the closing coverage matrix:
 * chiefly D1, which is a JSON file per session ($ROOT/.smoke-d1/<sid>.json)
 * shared by this process, its child processes and the dispatcher.
 *
 * Isolation: a temp WORKSPACE_ROOT, a private Docker network, a fresh
 * session id per scenario, and only containers this run creates (sessions
 * named `st-<sid12>…`, fixtures labelled), all removed on exit. Secrets are
 * compared by hash and never printed; on failure each container's own log
 * is dumped, never `inspect` (its Env holds the token and the secret).
 *
 * `--child <state> <cut>` is the mode a scenario runs in a separate
 * backend process that is SIGKILLed at the cut (S2).
 */

import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fs, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Dockerode from "dockerode";
import { measureRelayRecovery } from "./relayRecovery.testutil.js";

const CHILD = process.argv[2] === "--child";
const SELF = path.resolve(process.argv[1]);
const REPO = path.resolve(path.dirname(SELF), "../../..");
const ROOT =
	process.env.ST_AUDIT_ROOT ?? path.join(os.tmpdir(), `st-recreate-audit-${process.pid}`);
const IMAGE = CHILD
	? (process.env.ST_AUDIT_IMAGE ?? "")
	: (process.argv[2] ?? "shared-terminal-session");
const TAG = process.env.ST_AUDIT_TAG ?? String(process.pid);
process.env.WORKSPACE_ROOT = ROOT;
process.env.SESSION_IMAGE = IMAGE;
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "warn";

const NET = `st-audit-${TAG}`;
const FIXTURE_LABEL = "io.shared-terminal.audit-smoke";
const D1_DIR = path.join(ROOT, ".smoke-d1");
const STATE_DIR = path.join(ROOT, ".smoke-state");
const OUT = path.join(ROOT, ".smoke-out");
const BASE_DOMAIN = "smoke.test";
const OWNER = "u1";

const docker = new Dockerode();
const sids: string[] = [];
let failures = 0;

// ── Reporting ───────────────────────────────────────────────────────────────

interface Scenario {
	id: string;
	title: string;
	real: string;
	simulated: string;
	checks: number;
	fails: number;
}
const matrix: Scenario[] = [];
let current: Scenario | null = null;

function scenario(id: string, title: string, real: string, simulated: string): void {
	current = { id, title, real, simulated, checks: 0, fails: 0 };
	matrix.push(current);
	console.log(`\n── ${id}: ${title} ──\n  real:      ${real}\n  simulated: ${simulated}`);
}
function check(what: string, ok: boolean, detail?: unknown): void {
	if (current) current.checks++;
	if (ok) console.log(`  ok: ${what}`);
	else {
		failures++;
		if (current) current.fails++;
		console.error(`  FAIL: ${what}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
	}
}
function note(what: string): void {
	console.log(`  · ${what}`);
}
/** Synchronous: a child about to SIGKILL itself must not lose its last line. */
function say(line: string): void {
	writeSync(1, `${line}\n`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

// ── Docker helpers ──────────────────────────────────────────────────────────

interface ShOpts {
	user?: string;
	privileged?: boolean;
	workdir?: string;
}
/** Exit code and stdout of `bash -c cmd` (default user: the image's, developer). Never printed here. */
async function sh(
	id: string,
	cmd: string,
	o: ShOpts = {},
): Promise<{ code: number; out: string; err: string }> {
	const e = await docker.getContainer(id).exec({
		Cmd: ["bash", "-c", cmd],
		AttachStdout: true,
		AttachStderr: true,
		...(o.user ? { User: o.user } : {}),
		...(o.privileged ? { Privileged: true } : {}),
		...(o.workdir ? { WorkingDir: o.workdir } : {}),
	});
	const s = await e.start({});
	const out: Buffer[] = [];
	const err: Buffer[] = [];
	await new Promise<void>((r) => {
		docker.modem.demuxStream(
			s,
			{ write: (c: Buffer) => out.push(c) } as unknown as NodeJS.WritableStream,
			{ write: (c: Buffer) => err.push(c) } as unknown as NodeJS.WritableStream,
		);
		s.on("end", () => r());
		s.on("close", () => r());
	});
	return {
		code: (await e.inspect()).ExitCode ?? -1,
		out: Buffer.concat(out).toString("utf8"),
		err: Buffer.concat(err).toString("utf8"),
	};
}
async function waitFor(
	what: string,
	fn: () => Promise<boolean>,
	ms: number,
	every = 250,
): Promise<boolean> {
	const end = performance.now() + ms;
	while (performance.now() < end) {
		if (await fn().catch(() => false)) return true;
		await sleep(every);
	}
	note(`gave up waiting for ${what} after ${ms} ms`);
	return false;
}
async function waitReady(id: string): Promise<void> {
	if (
		!(await waitFor(
			"readiness",
			async () => (await sh(id, "test -f /tmp/.st-ready")).code === 0,
			60_000,
		))
	) {
		throw new Error("container never became ready");
	}
}
async function stopIfRunning(id: string): Promise<void> {
	await docker
		.getContainer(id)
		.stop()
		.catch((err: { statusCode?: number }) => {
			if (err.statusCode !== 304) throw err;
		});
}
async function inspectOrNull(id: string) {
	return docker
		.getContainer(id)
		.inspect()
		.catch(() => null);
}
async function logsHave(id: string, text: string): Promise<boolean> {
	const l = await docker.getContainer(id).logs({ stdout: true, stderr: true });
	return l.toString("utf8").includes(text);
}
/** Ids and states of every container this run made for `sid`, by name. */
async function containersOf(sid: string): Promise<string> {
	const all = await docker.listContainers({ all: true });
	return all
		.filter((c) => (c.Names?.[0] ?? "").startsWith(`/st-${sid.slice(0, 12)}`))
		.map((c) => `${c.Id}:${c.Names?.[0]}:${c.State}`)
		.sort()
		.join(",");
}
function dockerCli(args: string[]): Promise<{ code: number; out: string }> {
	return new Promise((r) =>
		execFile("docker", args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
			r({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` }),
		),
	);
}

/** sha256 over the sorted (relative path, bytes) of every regular file under `dir`. */
async function treeHash(dir: string): Promise<string> {
	const out: string[] = [];
	async function walk(d: string): Promise<void> {
		for (const e of await fs.readdir(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) await walk(p);
			else if (e.isFile()) out.push(`${path.relative(dir, p)}\0${sha(await fs.readFile(p))}`);
			else if (e.isSymbolicLink()) out.push(`${path.relative(dir, p)}\0->${await fs.readlink(p)}`);
		}
	}
	await walk(dir);
	return sha(out.sort().join("\n"));
}

// ── Modules and the simulated D1 ────────────────────────────────────────────

async function load() {
	const dmMod = await import("../dockerManager.js");
	return {
		...dmMod,
		...(await import("../recreateAttempt.js")),
		...(await import("../sessionLifecycleLock.js")),
		...(await import("./engine.js")),
		activation: await import("../conversation/activation.js"),
		cap: await import("../conversation/captureAuth.js"),
		...(await import("./capturePort.js")),
		...(await import("../conversation/revocation.js")),
		...(await import("../conversation/registry.js")),
		...(await import("../portMappings.js")),
	};
}
type Mods = Awaited<ReturnType<typeof load>>;
type Ports = Array<{ container: number; public: boolean }>;
interface Row {
	status: string;
	container_id: string | null;
	container_name: string;
	conversation_requested: number;
	ingest_token_hash: string | null;
	ingest_token_hash_suspended: string | null;
	user_id: string;
}
interface D1State {
	row: Row;
	mappings: Array<{ containerPort: number; isPublic: boolean }>;
	config: {
		ports: Ports;
		gitIdentity: { name: string; email: string } | null;
		hasDotfiles: boolean;
		postStartCmd: null;
	};
}
const d1File = (sid: string) => path.join(D1_DIR, `${sid}.json`);
function d1Read(sid: string): D1State {
	return JSON.parse(readFileSync(d1File(sid), "utf8")) as D1State;
}
/** Atomic replace, so the dispatcher (another process) never reads half a file. */
function d1Write(sid: string, s: D1State): void {
	const tmp = `${d1File(sid)}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(s));
	renameSync(tmp, d1File(sid));
}
function d1Update(sid: string, f: (s: D1State) => void): void {
	const s = d1Read(sid);
	f(s);
	d1Write(sid, s);
}

/** What a separate backend process needs to drive the same session. */
interface SessionState {
	sid: string;
	label: string;
	canonical: string;
	ws: string;
	uploads: string;
	O: string;
	userEnv: string[];
	imageId: string;
}
const stateFile = (sid: string) => path.join(STATE_DIR, `${sid}.json`);

// ── The engine around one session ───────────────────────────────────────────

function harness(M: Mods, st: SessionState) {
	const { sid, canonical, ws, uploads } = st;
	const dm = new M.DockerManager({} as import("../sessionManager.js").SessionManager);
	const real = dm.recreatePort();
	const deps = { workspaceRoot: ROOT, enabled: true, port: 3001 };
	const captureDocker = {
		inspectCapture: (cid: string) => dm.inspectCapture(cid),
		currentImage: () => dm.currentSessionImage(),
		probeRelay: (s: string, cid: string) => dm.probeRelay(s, cid),
	};
	const hooks: {
		afterRenameN?: () => Promise<void>;
		afterCas?: () => Promise<void>;
		onReadiness?: (id: string) => Promise<void>;
	} = {};
	const starts: string[] = [];
	const d1: import("./d1.js").RecreateD1Port = {
		getRow: async () => ({ ...d1Read(sid).row }),
		sessionIdByContainerName: async (name) => (name === canonical ? sid : null),
		cas: async (_s, oId, nId, h) => {
			const s = d1Read(sid);
			if (s.row.container_id !== oId || s.row.conversation_requested !== 1) return "not-applied";
			s.row.container_id = nId;
			s.row.ingest_token_hash = h;
			d1Write(sid, s);
			await hooks.afterCas?.();
			return "applied";
		},
		getConfig: async () => d1Read(sid).config,
		setStatus: async (_s, status) =>
			d1Update(sid, (s) => {
				s.row.status = status;
			}),
		// The real config → mapping helper; only the table is a file.
		setPorts: async (_s, ports) =>
			d1Update(sid, (s) => {
				s.mappings = M.mappingsFromConfig(ports).map((m) => ({
					containerPort: m.containerPort,
					isPublic: m.isPublic,
				}));
			}),
	};
	const authorityDeps = (mayWrite: () => boolean, dockerPort = captureDocker) => ({
		workspaceRoot: ROOT,
		enabled: true,
		docker: dockerPort,
		getRow: async () => ({ ...d1Read(sid).row }),
		checkRevocation: (x: string) => M.checkRevocation(ROOT, x),
		isRecreateUnresolved: async () => false,
		writeHooksFile: (x: string) => M.activation.writeHooksFile(deps, x),
		removeHooksFile: (x: string) => M.activation.removeHooksFile(ROOT, x),
		hooksFileExists: (x: string) => M.activation.hooksFileExists(ROOT, x),
		mayWrite,
	});
	const authority = (mayAct: () => boolean = () => true) =>
		new M.cap.CaptureAuthority(authorityDeps(mayAct));
	const capture: import("./engine.js").RecreateCapturePort = {
		enabled: true,
		checkRevocation: (s) => M.checkRevocation(ROOT, s),
		prepare: (s, mayAct) => M.activation.prepareRecreateCapture(deps, s, mayAct),
		snapshot: async () => ({ marker: false, hooksFile: false }),
		restore: async () => "not-authorized",
		authorize: async (s, run) => {
			const a = new M.cap.CaptureAuthority(
				authorityDeps(() => run.epochOpen, {
					inspectCapture: (cid) => run.call("inspect N", () => captureDocker.inspectCapture(cid)),
					currentImage: () => run.call("image", () => captureDocker.currentImage()),
					probeRelay: (x, cid) => run.call("probe", () => captureDocker.probeRelay(x, cid)),
				}),
			);
			const w = await a.applyWriteDetailed(s);
			return a.capture(s, { identified: w.identified });
		},
		converge: (s, mayAct) => authority(mayAct).converge(s),
		converged: (s) => M.captureFilesConverged(authority(), ROOT, s),
		deferSeedExists: (s) => M.cap.deferSeedExists(ROOT, s),
		removeDeferSeed: (s) => M.cap.removeDeferSeed(ROOT, s),
	};
	const hostConfig = (binds: string[]) => ({
		Binds: [`${ws}:/home/developer/workspace`, `${uploads}:/home/developer/uploads:ro`, ...binds],
		Init: true,
		CapDrop: ["ALL"],
		SecurityOpt: ["no-new-privileges:true"],
		NetworkMode: NET,
	});
	const port = {
		...real,
		buildCreate: async (_s: string, spec: Parameters<typeof real.buildCreate>[1]) => ({
			Image: spec.imageId,
			name: spec.name,
			Labels: spec.labels,
			Env: M.buildContainerEnv(sid, st.label, st.userEnv, spec.env),
			HostConfig: hostConfig(spec.binds),
			OpenStdin: true,
			Tty: true,
		}),
		rename: async (id: string, name: string) => {
			await real.rename(id, name);
			if (name === canonical && id !== st.O) await hooks.afterRenameN?.();
		},
		start: async (id: string) => {
			starts.push(id);
			await real.start(id);
		},
		exec: async (id: string, cmd: string[], t: number, mayAct?: () => boolean) => {
			if (cmd[0] === "test" && hooks.onReadiness) {
				const h = hooks.onReadiness;
				hooks.onReadiness = undefined;
				await h(id);
			}
			return real.exec(id, cmd, t, mayAct);
		},
	};
	const make = () => {
		const attempts = new M.RecreateAttemptStore(ROOT);
		const lock = new M.SessionLifecycleLock();
		lock.setGuard((s) => attempts.assertResolved(s));
		const engine = new M.RecreationEngine({
			workspaceRoot: ROOT,
			docker: port,
			d1,
			attempts,
			lock,
			capture,
			config: { resolveRetryMs: 1_500 },
		});
		return { attempts, lock, engine };
	};
	return { ...st, hostConfig, authority, hooks, starts, make, row: () => d1Read(sid).row };
}
type Harness = ReturnType<typeof harness>;

// ── Child mode: a backend process that dies at the cut ──────────────────────

async function child(): Promise<void> {
	const M = await load();
	const st = JSON.parse(readFileSync(process.argv[3], "utf8")) as SessionState;
	const cut = process.argv[4];
	const h = harness(M, st);
	const die = async () => {
		say(`  · backend process ${process.pid}: SIGKILL at the cut (${cut})`);
		process.kill(process.pid, "SIGKILL");
		await new Promise(() => undefined);
	};
	if (cut === "rename") h.hooks.afterRenameN = die;
	else h.hooks.afterCas = die;
	const r = await h.make().engine.recreate(st.sid, st.imageId);
	say(`  FAIL: the backend process returned before its cut: ${JSON.stringify(r)}`);
	process.exit(3);
}

// ── Parent ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const M = await load();
	const imageId = (await docker.getImage(IMAGE).inspect()).Id;
	const apiKey = `sk-ant-api03-smoke-${randomBytes(12).toString("hex")}`;
	for (const d of [D1_DIR, STATE_DIR, OUT]) await fs.mkdir(d, { recursive: true });
	await fs.chmod(OUT, 0o777);
	await docker.createNetwork({ Name: NET, Labels: { [FIXTURE_LABEL]: TAG } });

	const fixture = async (name: string, alias: string, spec: Dockerode.ContainerCreateOptions) => {
		const c = await docker.createContainer({
			...spec,
			name: `st-audit-${TAG}-${name}`,
			Labels: { [FIXTURE_LABEL]: TAG },
			NetworkingConfig: { EndpointsConfig: { [NET]: { Aliases: [alias] } } },
			HostConfig: { ...spec.HostConfig, NetworkMode: NET },
		});
		await c.start();
		return c.id;
	};
	const repoNode = (script: string, env: string[], name: string, alias: string) =>
		fixture(name, alias, {
			Image: IMAGE,
			User: "0",
			Entrypoint: ["node"],
			Cmd: ["node_modules/tsx/dist/cli.mjs", script],
			WorkingDir: "/repo/backend",
			Env: env,
			HostConfig: { Binds: [`${REPO}:/repo:ro`, `${ROOT}:/wr`] },
		});
	const MOCK = await fixture("mock", "mock-api", {
		Image: IMAGE,
		Entrypoint: ["node"],
		Cmd: ["/t/mock-anthropic.mjs", "8080", "/out/model-requests.jsonl"],
		HostConfig: { Binds: [`${REPO}/session-image/test:/t:ro`, `${OUT}:/out`] },
	});
	const DISPATCHER = await repoNode(
		"../session-image/test/st-dispatcher.mts",
		[
			"D1_STATE_DIR=/wr/.smoke-d1",
			"TOKENS_OUT=/wr/.smoke-out/dispatcher-tokens.json",
			`JWT_SECRET=${randomBytes(24).toString("hex")}`,
			`BASE_DOMAIN=${BASE_DOMAIN}`,
			`OWNER_USER_ID=${OWNER}`,
		],
		"dispatcher",
		"st-dispatcher",
	);
	const fixturesUp =
		(await waitFor("mock model", () => logsHave(MOCK, "listening"), 30_000)) &&
		(await waitFor("dispatcher", () => logsHave(DISPATCHER, "listening"), 60_000));
	if (!fixturesUp) throw new Error("fixtures did not start");

	/** A stopped O booted once, its D1 row in the simulated store. */
	async function createSession(
		label: string,
		o: { gitIdentity?: { name: string; email: string }; ports?: Ports; secret?: string } = {},
	): Promise<Harness> {
		const sid = randomUUID();
		sids.push(sid);
		const canonical = `st-${sid.slice(0, 12)}`;
		const ws = path.join(ROOT, sid);
		const uploads = path.join(ROOT, ".uploads", sid);
		await fs.mkdir(ws, { recursive: true });
		await fs.chmod(ws, 0o777);
		await fs.mkdir(uploads, { recursive: true });
		const userEnv = [
			"ANTHROPIC_BASE_URL=http://mock-api:8080",
			`ANTHROPIC_API_KEY=${apiKey}`,
			"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
			"DISABLE_AUTOUPDATER=1",
			...(o.secret ? [`ST_SMOKE_SECRET=${o.secret}`] : []),
		];
		const st: SessionState = { sid, label, canonical, ws, uploads, O: "", userEnv, imageId };
		const h0 = harness(M, st);
		const c = await docker.createContainer({
			Image: IMAGE,
			name: canonical,
			Env: M.buildContainerEnv(sid, label, userEnv),
			HostConfig: h0.hostConfig([]),
			OpenStdin: true,
			Tty: true,
		});
		st.O = c.id;
		d1Write(sid, {
			row: {
				status: "stopped",
				container_id: c.id,
				container_name: canonical,
				conversation_requested: 1,
				ingest_token_hash: null,
				ingest_token_hash_suspended: null,
				user_id: OWNER,
			},
			mappings: [],
			config: {
				ports: o.ports ?? [],
				gitIdentity: o.gitIdentity ?? null,
				hasDotfiles: false,
				postStartCmd: null,
			},
		});
		writeFileSync(stateFile(sid), JSON.stringify(st));
		return harness(M, st);
	}
	async function bootOnce(id: string, fn: () => Promise<unknown> = async () => undefined) {
		await docker.getContainer(id).start();
		await waitReady(id);
		try {
			await fn();
		} finally {
			await stopIfRunning(id);
		}
	}
	async function seedUserData(id: string) {
		const r = await sh(
			id,
			[
				"set -e",
				"mkdir -p ~/workspace/project ~/workspace/data",
				"cd ~/workspace/project && git init -q && echo hola > README && git add README",
				"git -c user.name=Seed -c user.email=seed@x commit -qm first",
				"head -c 1048576 /dev/urandom > ~/workspace/data/blob.bin",
			].join("\n"),
		);
		check("user data written in O", r.code === 0, r);
	}
	const userTree = async (ws: string) =>
		[await treeHash(path.join(ws, "project")), await treeHash(path.join(ws, "data"))].join(":");
	const asRoot = (cmd: string) => sh(DISPATCHER, cmd); // a root shell with $ROOT at /wr
	const fileState = async (sid: string) =>
		(
			await asRoot(
				`cd /wr && for d in .st-control/${sid} .claude-managed/${sid} .conversations/${sid}; do echo "[$d]"; [ -d "$d" ] && find "$d" -printf '%P %s %m\\n' | sort; done`,
			)
		).out;
	const relayPid = async (id: string) =>
		(
			await sh(
				id,
				'for p in /proc/[0-9]*; do c=$(tr "\\0" " " <"$p/cmdline" 2>/dev/null); case "$c" in "python3 -IS /opt/st/hooks/relay.py"*) basename "$p";; esac; done | head -n 1',
			)
		).out.trim();
	const tokenOf = async (id: string) =>
		((await docker.getContainer(id).inspect()).Config.Env ?? [])
			.find((e) => e.startsWith("ST_INGEST_TOKEN="))
			?.slice("ST_INGEST_TOKEN=".length);

	// The real CLI in a session container: headless and interactive.
	const claudeP = async (id: string, args: string) => {
		const r = await sh(id, `timeout 120 claude -p ${args} --output-format json </dev/null`, {
			workdir: "/home/developer/workspace",
		});
		let j: { result?: string; session_id?: string; is_error?: boolean } = {};
		try {
			j = JSON.parse(r.out.trim().split("\n").pop() ?? "{}");
		} catch {}
		return { ...r, json: j };
	};
	const MOCK_REPLY = "Hello from the mock.\nSecond line.";
	// Onboarding, API-key approval, trust and the bypass warning, plus the
	// user's own Stop/UserPromptSubmit hooks that mark a turn's end — as in
	// conversation-smoke.sh's seed_claude_state.
	const seedClaudeState = (id: string) =>
		sh(
			id,
			`set -e
f=~/.claude.json; [ -s "$f" ] || echo "{}" > "$f"
jq --arg k "${apiKey.slice(-20)}" '. + {hasCompletedOnboarding: true, theme: "dark",
	customApiKeyResponses: {approved: [$k], rejected: []},
	projects: {"/home/developer/workspace": {hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true}}}' "$f" > /tmp/cj
cat /tmp/cj > "$f"
mkdir -p ~/.claude
cat > ~/.claude/settings.json <<"EOF"
{
  "skipDangerousModePermissionPrompt": true,
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "echo submit $(date +%s%3N) >> /tmp/user-hooks.log" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "echo stop $(date +%s%3N) >> /tmp/user-hooks.log" }] }]
  }
}
EOF`,
		);
	const tabStart = async (id: string, tab: string) => {
		await sh(
			id,
			`tmux new-session -d -s ${tab} -x 220 -y 50 -c /home/developer/workspace "claude --dangerously-skip-permissions"`,
		);
		return waitFor(
			`${tab} prompt`,
			async () =>
				/for shortcuts|bypass permissions on|for agents/.test(
					(await sh(id, `tmux capture-pane -p -t ${tab}`)).out,
				),
			60_000,
			500,
		);
	};
	const tabTurn = async (id: string, tab: string, text: string) => {
		await sh(id, ": > /tmp/user-hooks.log");
		await sh(id, `tmux send-keys -t ${tab} ${JSON.stringify(text)} Enter`);
		return waitFor(
			`${tab} turn`,
			async () => (await sh(id, "grep -q '^stop' /tmp/user-hooks.log")).code === 0,
			30_000,
			100,
		);
	};
	const hookErrors = async (id: string, tab: string) =>
		(await sh(id, `tmux capture-pane -p -S -500 -t ${tab}`)).out
			.split("\n")
			.filter((l) => /hook error/i.test(l)).length;

	// The real ingest stack; started once N's token exists.
	let RECEIVER = "";
	const receiverLines = async (file: string) =>
		(await asRoot(`cat /wr/.smoke-out/${file} 2>/dev/null`)).out
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as Record<string, unknown>);
	const promptsReceived = async (prompt: string) =>
		(await receiverLines("receiver.jsonl")).filter(
			(l) => l.event === "UserPromptSubmit" && (l.body as { prompt?: string })?.prompt === prompt,
		).length;
	const accepted = async () =>
		(await receiverLines("receiver.outcomes.jsonl")).filter(
			(l) => l.step === "ingest" && (l.outcome as { accepted?: boolean })?.accepted === true,
		).length;
	const persistedPrompt = async (sid: string, prompt: string) =>
		(
			await asRoot(
				`cat /wr/.conversations/${sid}/*.events.jsonl 2>/dev/null | jq -c 'select(.ev == "user_prompt") | .data.prompt'`,
			)
		).out
			.split("\n")
			.includes(JSON.stringify(prompt));

	// ── S1 ──────────────────────────────────────────────────────────────────
	scenario(
		"S1",
		"full recreation with workspace, git, secret, ports and a resumable conversation",
		"dockerd, image, engine, capture authority, relay; CLI 2.1.308 (`claude -p`, `--resume`) with the scripted model; dispatcher + http-proxy + Docker DNS; receiver ingest",
		"D1 row and the mapping table (a JSON file read by the real lookupDispatchTarget SQL)",
	);
	const secret = randomUUID();
	const s1 = await createSession("s1", {
		gitIdentity: { name: "Ada", email: "ada@example.test" },
		ports: [
			{ container: 8080, public: true },
			{ container: 8081, public: false },
		],
		secret,
	});
	let convId = "";
	await bootOnce(s1.O, async () => {
		await seedUserData(s1.O);
		await sh(
			s1.O,
			"git config --global user.name Ada && git config --global user.email ada@example.test",
		);
		const first = await claudeP(s1.O, "'resume probe: first prompt'");
		convId = first.json.session_id ?? "";
		check(
			"O: claude -p answers and reports its conversation id",
			first.code === 0 && first.json.result === MOCK_REPLY && /^[0-9a-f-]{36}$/.test(convId),
			{ code: first.code, result: first.json.result, err: first.err.slice(-400) },
		);
	});
	const transcript = path.join(
		s1.ws,
		".st/claude-state/projects/-home-developer-workspace",
		`${convId}.jsonl`,
	);
	const s1Before = await userTree(s1.ws);
	const transcriptBefore = await fs.readFile(transcript).catch(() => null);
	check(
		"the conversation is persisted in the workspace",
		transcriptBefore !== null && transcriptBefore.length > 0,
	);
	const e1 = s1.make();
	const pre1 = (await e1.engine.preflight(s1.sid)) as { recreatable?: boolean; blockers?: unknown };
	check("preflight after real CLI use in O: recreatable", pre1.recreatable === true, pre1);
	if (pre1.recreatable !== true)
		console.error(JSON.stringify(await docker.getContainer(s1.O).changes(), null, 1));
	const r1 = await e1.engine.recreate(s1.sid, imageId);
	const n1 = (r1 as { nContainerId?: string }).nContainerId as string;
	check(
		"committed, resolved in the request",
		(r1 as { ok?: boolean }).ok === true && !("unresolved" in r1),
		r1,
	);
	check(
		"capture effective",
		(r1 as { capture?: { effective?: boolean } }).capture?.effective === true,
	);
	const n1Token = (await tokenOf(n1)) ?? "";
	RECEIVER = await repoNode(
		"../session-image/test/st-receiver.mts",
		[
			"WORKSPACE_ROOT=/wr",
			`ST_TEST_TOKEN=${n1Token}`,
			`ST_TEST_SESSION=${s1.sid}`,
			"RAW_OUT=/wr/.smoke-out/receiver.jsonl",
		],
		"receiver",
		"st-backend",
	);
	if (!(await waitFor("receiver", () => logsHave(RECEIVER, "listening"), 60_000)))
		throw new Error("receiver did not start");
	check("workspace user data byte-identical (repo, blob)", (await userTree(s1.ws)) === s1Before);
	check(
		"the transcript byte-identical before the resume",
		transcriptBefore !== null &&
			sha((await fs.readFile(transcript)) as Buffer) === sha(transcriptBefore),
	);
	check(
		"git history intact in N",
		(await sh(n1, "git -C ~/workspace/project log --oneline | wc -l")).out.trim() === "1",
	);
	check(
		"git identity re-applied in N",
		(await sh(n1, "git config --global user.email")).out.trim() === "ada@example.test",
	);
	check(
		"the secret env var reaches N (compared by hash)",
		(await sh(n1, 'printf %s "$ST_SMOKE_SECRET" | sha256sum | cut -d" " -f1')).out.trim() ===
			sha(secret),
	);
	check("O removed", (await inspectOrNull(s1.O)) === null);
	// claude --resume on N, with the conversation O persisted.
	const resumed = await claudeP(n1, `--resume ${convId} 'resume probe: second prompt'`);
	check(
		"N: claude -p --resume answers in the same conversation",
		resumed.code === 0 && resumed.json.result === MOCK_REPLY && resumed.json.session_id === convId,
		{
			code: resumed.code,
			result: resumed.json.result,
			sameId: resumed.json.session_id === convId,
			err: resumed.err.slice(-400),
		},
	);
	const modelSaw = (await fs.readFile(path.join(OUT, "model-requests.jsonl"), "utf8"))
		.split("\n")
		.filter((l) => l.includes("resume probe: second prompt"))
		.pop();
	check(
		"the model was sent the previous turn with the resumed prompt",
		!!modelSaw && modelSaw.includes("resume probe: first prompt"),
	);
	check(
		"the transcript now holds both turns",
		(
			await sh(
				n1,
				`grep -c 'resume probe: ' ~/.claude/projects/-home-developer-workspace/${convId}.jsonl`,
			)
		).out.trim() !== "0" &&
			(
				await sh(
					n1,
					`grep -q 'resume probe: second prompt' ~/.claude/projects/-home-developer-workspace/${convId}.jsonl`,
				)
			).code === 0,
	);
	check(
		"the resumed turn was captured: received and persisted by the real ingest stack",
		(await waitFor(
			"resumed prompt persisted",
			() => persistedPrompt(s1.sid, "resume probe: second prompt"),
			10_000,
		)) && (await promptsReceived("resume probe: second prompt")) >= 1,
	);
	// Declared ports through the real dispatcher, by N's canonical name.
	check(
		"mappings = the declared ports",
		JSON.stringify(d1Read(s1.sid).mappings) ===
			JSON.stringify([
				{ containerPort: 8080, isPublic: true },
				{ containerPort: 8081, isPublic: false },
			]),
	);
	const nonce = randomBytes(8).toString("hex");
	await sh(
		n1,
		`mkdir -p /tmp/www && echo ${nonce} > /tmp/www/nonce && cd /tmp/www && for p in 8080 8081; do setsid nohup python3 -m http.server $p --bind 0.0.0.0 >/dev/null 2>&1 & done`,
	);
	await waitFor(
		"N's HTTP servers",
		async () => (await sh(n1, "curl -fs http://127.0.0.1:8081/nonce")).code === 0,
		10_000,
	);
	const tokens = JSON.parse((await asRoot("cat /wr/.smoke-out/dispatcher-tokens.json")).out) as {
		owner: string;
		other: string;
	};
	const via = async (p: number, cookie?: string) => {
		const r = await sh(
			DISPATCHER,
			`curl -s -o /tmp/body -w '%{http_code}' -H 'Host: p${p}-${s1.sid}.${BASE_DOMAIN}' ${cookie ? `-H 'Cookie: st_token=${cookie}'` : ""} http://127.0.0.1:3000/nonce; echo; cat /tmp/body`,
		);
		const [code, body] = r.out.split("\n");
		return { code, body };
	};
	const pub = await via(8080);
	check(
		"dispatcher: public 8080 reaches N's server",
		pub.code === "200" && pub.body === nonce,
		pub.code,
	);
	check("dispatcher: private 8081 without a cookie ⇒ 401", (await via(8081)).code === "401");
	check(
		"dispatcher: private 8081 with another user's cookie ⇒ 403",
		(await via(8081, tokens.other)).code === "403",
	);
	const own = await via(8081, tokens.owner);
	check(
		"dispatcher: private 8081 with the owner's cookie reaches N",
		own.code === "200" && own.body === nonce,
		own.code,
	);
	check("dispatcher: an undeclared port ⇒ 404", (await via(8082)).code === "404");

	// ── S4 ──────────────────────────────────────────────────────────────────
	scenario(
		"S4",
		"relay killed (-9) after activation: detection and recovery ≤ 3 s",
		"relay and its supervisor in N, the capture authority's probe (docker exec)",
		"D1 row (read by the authority)",
	);
	const pid = await relayPid(n1);
	check("the relay runs in N", pid !== "", pid);
	let killCode = -1;
	let firstCapture: { effective: boolean; pendingReasons: string[] } | null = null;
	const rec = await measureRelayRecovery({
		// As developer, the relay's owner: with CapDrop ALL, root in the
		// container has no CAP_KILL and its kill fails with EPERM.
		kill: async () => {
			killCode = (await sh(n1, `kill -KILL ${pid}`)).code;
		},
		probe: async () => {
			const c = await s1.authority().capture(s1.sid);
			firstCapture ??= c;
			return c.effective;
		},
		limitMs: 3_000,
		pollMs: 200,
	});
	check("kill -9 delivered", killCode === 0, killCode);
	check(
		"detected: the first capture query is not effective, relay-unavailable",
		rec.firstProbeIdentified === false &&
			(firstCapture as { pendingReasons: string[] } | null)?.pendingReasons.includes(
				"relay-unavailable",
			) === true,
		firstCapture,
	);
	check(
		`effective again ≤ 3 s after the kill was issued, probes and waits included (${rec.recoveredAfterMs?.toFixed(0)} ms)`,
		rec.withinLimit,
		rec.probes,
	);
	check(
		"the marker and the hooks file were never touched by the crash",
		(await M.cap.relayEnabledExists(ROOT, s1.sid)) &&
			(await M.activation.hooksFileExists(ROOT, s1.sid)),
	);

	// ── S5 ──────────────────────────────────────────────────────────────────
	scenario(
		"S5",
		"data, marks and authorizations across stop/start of N",
		"dockerd stop/start, entrypoint and relay supervisor at boot, capture authority on the files",
		"D1 row",
	);
	await stopIfRunning(n1);
	const stopped = await s1.authority().capture(s1.sid);
	check(
		"stopped: marker and hooks file kept",
		(await M.cap.relayEnabledExists(ROOT, s1.sid)) &&
			(await M.activation.hooksFileExists(ROOT, s1.sid)),
	);
	check("stopped: effectiveAfterRestart true", stopped.effectiveAfterRestart === true, stopped);
	await docker.getContainer(n1).start();
	await waitReady(n1);
	check(
		"started again: effective without PATCH or recreation",
		await waitFor(
			"effective after start",
			async () => (await s1.authority().capture(s1.sid)).effective,
			5_000,
			200,
		),
	);
	check(
		"D1's hash is the hash of N's own token",
		M.hashIngestToken((await tokenOf(n1)) ?? "") === s1.row().ingest_token_hash,
	);
	check("no revocation in effect", (await M.checkRevocation(ROOT, s1.sid)) === "none");
	check("workspace user data still identical", (await userTree(s1.ws)) === s1Before);

	// ── S6 ──────────────────────────────────────────────────────────────────
	scenario(
		"S6",
		"PATCH {enabled:true} on a running container: a tab already open and a new one",
		"CaptureAuthority convergence (disable retires file then marker) and write procedure (marker → relay identified → hooks file); the real CLI in two tmux tabs; receiver ingest",
		"D1 transitions of disable/enable (requested, suspended hash); the PATCH route and lock (covered by routes.conversationAdmin tests)",
	);
	d1Update(s1.sid, (s) => {
		s.row.conversation_requested = 0;
		s.row.ingest_token_hash_suspended = s.row.ingest_token_hash;
		s.row.ingest_token_hash = null;
	});
	await s1.authority().converge(s1.sid);
	check(
		"disabled: hooks file and marker retired",
		!(await M.activation.hooksFileExists(ROOT, s1.sid)) &&
			!(await M.cap.relayEnabledExists(ROOT, s1.sid)),
	);
	await seedClaudeState(n1);
	check("a tab opened while capture is off", await tabStart(n1, "open"));
	d1Update(s1.sid, (s) => {
		s.row.conversation_requested = 1;
		s.row.ingest_token_hash = s.row.ingest_token_hash_suspended;
		s.row.ingest_token_hash_suspended = null;
	});
	const w = await s1.authority().applyWriteDetailed(s1.sid);
	check("PATCH: the write procedure wrote (relay identified)", w.outcome === "written", w.outcome);
	const afterPatch = await s1.authority().capture(s1.sid, { identified: w.identified });
	check(
		"PATCH: effective:true, no recreation",
		afterPatch.effective && !afterPatch.requiresRecreate,
		afterPatch,
	);
	await sleep(3_000); // the CLI's settings watcher
	check("open tab: the turn completes", await tabTurn(n1, "open", "patch probe: open tab"));
	check("a new tab after the PATCH", await tabStart(n1, "new"));
	check("new tab: the turn completes", await tabTurn(n1, "new", "patch probe: new tab"));
	check("open tab: no 'hook error'", (await hookErrors(n1, "open")) === 0);
	check("new tab: no 'hook error'", (await hookErrors(n1, "new")) === 0);
	check(
		"new tab: its prompt delivered and persisted",
		await waitFor("new-tab prompt", () => persistedPrompt(s1.sid, "patch probe: new tab"), 10_000),
	);
	// Hot reload is informative (CONVERSATION.md §2.4), so only reported.
	note(
		`open tab after the PATCH (hot reload, informative): ${(await persistedPrompt(s1.sid, "patch probe: open tab")) ? "delivered" : "not delivered"}`,
	);

	// ── S7 ──────────────────────────────────────────────────────────────────
	scenario(
		"S7",
		"end-to-end revocation with the real emergency CLI",
		"`conversation:disable` in another process, revocation markers, the receiver's per-event check, the relay and CLI in N, dockerd stop/start, the engine's preflight and POST",
		"D1: the emergency CLI's D1 statements go to a stub, and this process's D1 row is not changed by it — the cut is proved by the marker the receiver reads on every event",
	);
	const acceptedBefore = await accepted();
	const stub =
		'globalThis.fetch = async () => new Response(JSON.stringify({ success: true, errors: [], result: [{ results: [], success: true, meta: {} }] }), { status: 200, headers: { "content-type": "application/json" } });';
	const cli = await dockerCli([
		"run",
		"--rm",
		"--user",
		"0",
		"--network",
		NET,
		"-v",
		`${REPO}:/repo:ro`,
		"-v",
		`${ROOT}:/wr`,
		"-w",
		"/repo/backend",
		"-e",
		"WORKSPACE_ROOT=/wr",
		"-e",
		"CONVERSATION_ENABLED=true",
		"-e",
		"CLOUDFLARE_ACCOUNT_ID=x",
		"-e",
		"CLOUDFLARE_API_TOKEN=x",
		"-e",
		"D1_DATABASE_ID=x",
		"-e",
		`NODE_OPTIONS=--import data:text/javascript,${encodeURIComponent(stub)}`,
		"--entrypoint",
		"node",
		IMAGE,
		"node_modules/tsx/dist/cli.mjs",
		"src/conversation/cli.ts",
		"disable",
		s1.sid,
	]);
	check(
		"conversation:disable ran and reported the session revoked",
		cli.code === 0 && cli.out.includes(`revoked ${s1.sid}`),
		cli.out.slice(-600),
	);
	check(
		"revocation in effect (REVOKED on disk)",
		(await M.checkRevocation(ROOT, s1.sid)) !== "none",
	);
	check(
		"hooks file and marker retired by the CLI",
		!(await M.activation.hooksFileExists(ROOT, s1.sid)) &&
			!(await M.cap.relayEnabledExists(ROOT, s1.sid)),
	);
	check("open tab: the next turn completes", await tabTurn(n1, "open", "revoke probe: open tab"));
	await sleep(1_500);
	check("nothing accepted after the CLI returned", (await accepted()) === acceptedBefore, {
		before: acceptedBefore,
		after: await accepted(),
	});
	check("revoke probe never persisted", !(await persistedPrompt(s1.sid, "revoke probe: open tab")));
	const revokedCapture = await s1.authority().capture(s1.sid);
	check("capture: not effective", !revokedCapture.effective, revokedCapture);
	const tokenHashBefore = sha((await tokenOf(n1)) ?? "");
	await sh(n1, "tmux kill-server");
	await stopIfRunning(n1);
	await docker.getContainer(n1).start();
	await waitReady(n1);
	await sleep(2_000);
	check(
		"next start: the token is the same one, none minted",
		sha((await tokenOf(n1)) ?? "") === tokenHashBefore,
	);
	check("next start: no relay launched", (await relayPid(n1)) === "");
	const after = await claudeP(n1, "'revoke probe: after start'");
	await sleep(1_500);
	check(
		"next start: claude -p works and sends nothing",
		after.json.result === MOCK_REPLY && (await promptsReceived("revoke probe: after start")) === 0,
	);
	await stopIfRunning(n1);
	const pre7 = (await e1.engine.preflight(s1.sid)) as { blockers?: Array<{ code: string }> };
	check(
		"preflight: blocked by the revocation",
		pre7.blockers?.some((b) => b.code === "revoked") === true,
		pre7,
	);
	const before7 = await containersOf(s1.sid);
	const post7 = await e1.engine.recreate(s1.sid, imageId);
	check(
		"POST refused (409): no recreation, no new token",
		(post7 as { status?: number }).status === 409,
		post7,
	);
	check("…and no container created", (await containersOf(s1.sid)) === before7);
	e1.engine.stop();

	// ── S2 ──────────────────────────────────────────────────────────────────
	for (const cut of ["rename", "commit"] as const) {
		scenario(
			`S2-${cut}`,
			`backend process killed ${cut === "rename" ? "between steps 2 and 4" : "right after the step 4 CAS applied"} (D8)`,
			"a separate backend process SIGKILLed at the cut; a new process's recoverOnBoot + bootPass; dockerd, the durable attempt record, the lifecycle lock's guard",
			"D1 (a file both processes read)",
		);
		const s = await createSession(`s2-${cut}`);
		await bootOnce(s.O, () => seedUserData(s.O));
		const skillBefore = await treeHash(path.join(s.ws, ".st/claude-state/skills"));
		const userBefore = await userTree(s.ws);
		const proc = spawn(
			process.execPath,
			["--import", "tsx", SELF, "--child", stateFile(s.sid), cut],
			{
				cwd: process.cwd(),
				stdio: "inherit",
				env: { ...process.env, ST_AUDIT_ROOT: ROOT, ST_AUDIT_IMAGE: IMAGE, ST_AUDIT_TAG: TAG },
			},
		);
		const death = await Promise.race([
			new Promise<{ code: number | null; signal: string | null }>((r) =>
				proc.on("exit", (code, signal) => r({ code, signal })),
			),
			sleep(180_000).then(() => ({ code: null, signal: "timeout" })),
		]);
		check("the backend process died by SIGKILL at the cut", death.signal === "SIGKILL", death);
		const next = s.make();
		await next.attempts.recoverOnBoot();
		await next.engine.bootPass();
		await sleep(2_000); // longer than resolveRetryMs: nothing resolves it anyway
		const rec2 = await next.attempts.read(s.sid);
		check(
			"record uncertain and orphaned after the restart",
			rec2.kind === "ok" && rec2.record.state === "uncertain" && !!rec2.record.orphanedAt,
			rec2,
		);
		for (const op of ["start", "stop", "delete"] as const) {
			const refused = await next.lock
				.run(s.sid, op, async () => "ran")
				.then(
					() => false,
					(e) => e instanceof M.RecreateUnresolvedError,
				);
			check(`${op} refused (recreate-unresolved)`, refused);
		}
		const d1c = s.row().container_id as string;
		check("D1 names a container that exists", (await inspectOrNull(d1c)) !== null, d1c);
		check(
			cut === "rename" ? "D1 still on O" : "D1 on N (the commit applied)",
			cut === "rename" ? d1c === s.O : d1c !== s.O,
		);
		check("O was not removed", (await inspectOrNull(s.O)) !== null);
		check("defer-skill-seed kept", await M.cap.deferSeedExists(ROOT, s.sid));
		check(
			"skills untouched",
			(await treeHash(path.join(s.ws, ".st/claude-state/skills"))) === skillBefore,
		);
		check("workspace user data intact", (await userTree(s.ws)) === userBefore);
		next.engine.stop();
	}

	// ── S3 ──────────────────────────────────────────────────────────────────
	scenario(
		"S3",
		"relay unavailable during activation (its port taken when step 5 runs)",
		"engine step 5 through the capture authority, relay + supervisor back-off, dockerd",
		"D1 row",
	);
	const s3 = await createSession("s3");
	await bootOnce(s3.O);
	const occupant =
		"setsid nohup python3 -c 'import socket,time;s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind((\"127.0.0.1\",47613));s.listen();time.sleep(900)' st-occupant >/dev/null 2>&1 &";
	s3.hooks.onReadiness = async (nId) => {
		await waitReady(nId);
		await sh(nId, occupant);
	};
	const e3 = s3.make();
	const r3 = await e3.engine.recreate(s3.sid, imageId);
	const n3 = (r3 as { nContainerId?: string }).nContainerId as string;
	check(
		"committed but unresolved, authorize pending",
		(r3 as { ok?: boolean }).ok === true &&
			(r3 as { unresolved?: boolean }).unresolved === true &&
			((r3 as { pending?: string[] }).pending ?? []).some((p) => p.startsWith("authorize")),
		r3,
	);
	const c3 = (r3 as { capture?: { effective: boolean; pendingReasons: string[] } }).capture;
	check(
		"capture not effective with its reason",
		!!c3 && !c3.effective && c3.pendingReasons.length > 0,
		c3,
	);
	check("no hooks file written", !(await M.activation.hooksFileExists(ROOT, s3.sid)));
	check("no marker left", !(await M.cap.relayEnabledExists(ROOT, s3.sid)));
	const rec3 = await e3.attempts.read(s3.sid);
	check("the record is not resolved", rec3.kind === "ok" && rec3.record.state !== "resolved", rec3);
	// As developer (the occupant's owner; root has no CAP_KILL here). The
	// bracket keeps pkill from matching this very `bash -c`.
	const freed = await sh(n3, "pkill -f 'st-occupan[t]'");
	check("the occupant was killed", freed.code === 0, freed.code);
	// The supervisor backs off while the relay keeps dying on the taken port
	// (1, 2, 4 … 32 s), so the next launch can be half a minute away.
	check(
		"resolved once the relay could identify itself",
		await waitFor(
			"resolution",
			async () => {
				const r = await e3.attempts.read(s3.sid);
				return r.kind === "ok" && r.record.state === "resolved";
			},
			90_000,
			500,
		),
	);
	check(
		"then: marker and hooks file",
		(await M.cap.relayEnabledExists(ROOT, s3.sid)) &&
			(await M.activation.hooksFileExists(ROOT, s3.sid)),
	);
	check("then: capture effective", (await s3.authority().capture(s3.sid)).effective);
	e3.engine.stop();

	// ── S8 ──────────────────────────────────────────────────────────────────
	scenario(
		"S8",
		"a package installed in O's layer blocks: preflight and POST, with no effect",
		"real `apt-get install` in the container layer, the real `docker diff`, the engine's preconditions and POST, dockerd",
		"D1 row (compared byte for byte before and after)",
	);
	const s8 = await createSession("s8");
	await bootOnce(s8.O, async () => {
		await seedUserData(s8.O);
		check(
			"bc not installed in the image",
			(await sh(s8.O, "dpkg -s bc >/dev/null 2>&1")).code !== 0,
		);
		const apt = await sh(
			s8.O,
			"export DEBIAN_FRONTEND=noninteractive; apt-get -o APT::Sandbox::User=root update -qq && apt-get -o APT::Sandbox::User=root install -y -qq --no-install-recommends bc",
			{ user: "0", privileged: true },
		);
		check(
			"apt-get install bc in O's layer",
			apt.code === 0 && (await sh(s8.O, "dpkg -s bc >/dev/null")).code === 0,
			{
				code: apt.code,
				err: apt.err.slice(-600),
			},
		);
	});
	const snap = async () => ({
		d1: readFileSync(d1File(s8.sid), "utf8"),
		containers: await containersOf(s8.sid),
		files: await fileState(s8.sid),
		user: await userTree(s8.ws),
	});
	const before8 = await snap();
	const e8 = s8.make();
	const pre8 = (await e8.engine.preflight(s8.sid)) as {
		recreatable?: boolean;
		blockers?: Array<{ code: string }>;
	};
	check(
		"preflight: layer-system",
		pre8.recreatable === false && pre8.blockers?.some((b) => b.code === "layer-system") === true,
		pre8,
	);
	let beforeEffectsRan = false;
	const post8 = await e8.engine.recreate(s8.sid, imageId, {
		beforeEffects: async () => {
			beforeEffectsRan = true;
		},
	});
	check(
		"POST: 409 layer-system",
		(post8 as { status?: number; code?: string }).status === 409 &&
			(post8 as { code?: string }).code === "layer-system",
		post8,
	);
	check(
		"no audit hook, no attempt record",
		!beforeEffectsRan && (await e8.attempts.read(s8.sid)).kind === "none",
	);
	const after8 = await snap();
	check("D1 row byte-identical", after8.d1 === before8.d1);
	check("same containers, same states", after8.containers === before8.containers, {
		before: before8.containers,
		after: after8.containers,
	});
	check("control, managed and conversation dirs unchanged", after8.files === before8.files, {
		before: before8.files,
		after: after8.files,
	});
	check("workspace user data unchanged", after8.user === before8.user);
	check(
		"the package is still in O (nothing was touched)",
		((await docker.getContainer(s8.O).changes()) as Array<{ Path: string }>).some(
			(c) => c.Path === "/usr/bin/bc",
		),
	);
	e8.engine.stop();
}

// ── Cleanup and the coverage matrix ─────────────────────────────────────────

async function cleanup(): Promise<void> {
	const all = await docker.listContainers({ all: true });
	for (const c of all) {
		const name = (c.Names?.[0] ?? "").replace(/^\//, "");
		const ours =
			c.Labels?.[FIXTURE_LABEL] === TAG ||
			sids.some(
				(s) =>
					name.startsWith(`st-${s.slice(0, 12)}`) || c.Labels?.["io.shared-terminal.session"] === s,
			);
		if (!ours) continue;
		// Failure context for the job log: each container's own output.
		// Never `inspect`: its Env holds the ingest token and the secret.
		if (failures > 0) {
			const log = await docker
				.getContainer(c.Id)
				.logs({ stdout: true, stderr: true, tail: 300 })
				.catch((err: Error) => Buffer.from(`(logs unavailable: ${err.message})`));
			console.error(`\n── docker logs ${name} (${c.State}) ──\n${log.toString("utf8")}`);
		}
		await docker
			.getContainer(c.Id)
			.remove({ force: true })
			.catch(() => undefined);
	}
	if (failures > 0) {
		// Outcomes carry no token (the raw request log does, and stays unprinted).
		const outcomes = await fs
			.readFile(path.join(OUT, "receiver.outcomes.jsonl"), "utf8")
			.catch(() => "(none)");
		console.error(
			`\n── receiver outcomes (last 40) ──\n${outcomes.split("\n").slice(-40).join("\n")}`,
		);
	}
	await docker
		.getNetwork(NET)
		.remove()
		.catch(() => undefined);
	await docker
		.run(IMAGE, ["bash", "-c", "rm -rf /t/* /t/.[!.]* 2>/dev/null; true"], process.stdout, {
			User: "0",
			Entrypoint: [],
			HostConfig: { Binds: [`${ROOT}:/t`], AutoRemove: true },
		})
		.catch(() => undefined);
	await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
}

function printMatrix(): void {
	const lines = [
		"| Scenario | Result | Real | Simulated |",
		"| --- | --- | --- | --- |",
		...matrix.map(
			(s) =>
				`| ${s.id} ${s.title} | ${s.fails === 0 ? `ok (${s.checks})` : `**${s.fails} FAIL** / ${s.checks}`} | ${s.real} | ${s.simulated} |`,
		),
	];
	console.log(`\n── Coverage matrix ──\n${lines.join("\n")}`);
	if (process.env.GITHUB_STEP_SUMMARY) {
		writeFileSync(
			process.env.GITHUB_STEP_SUMMARY,
			`## Recreation audit smoke\n\n${lines.join("\n")}\n`,
			{
				flag: "a",
			},
		);
	}
}

if (CHILD) {
	child().catch((err) => {
		say(`  FAIL: backend process: ${(err as Error).stack ?? err}`);
		process.exit(4);
	});
} else {
	main()
		.catch((err) => {
			failures++;
			if (current) current.fails++;
			console.error(`  FAIL: ${(err as Error).stack ?? err}`);
		})
		.finally(async () => {
			await cleanup();
			printMatrix();
			console.log(
				failures === 0
					? "\nrecreation audit smoke: all ok"
					: `\nrecreation audit smoke: ${failures} failure(s)`,
			);
			process.exit(failures === 0 ? 0 : 1);
		});
}
