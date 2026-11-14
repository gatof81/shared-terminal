/**
 * relay.smoke.ts — one whole D3 consult between two REAL Claude Code CLIs in
 * two real session containers (docs/PROJECT_CONVERSATION.md §7.2–§7.5). Run
 * by the Session Image workflow:
 *
 *   cd backend && npx tsx src/projects/conversation/relay.smoke.ts <image>
 *
 * relayOrigin.smoke.ts proves the admission rule on hook bodies it writes
 * itself. This one closes the loop with nothing hand-written in between:
 *
 *   the person's task + grant ──typed into A's pane──▶ A's CLI
 *   A's CLI: Write .st-outbox/mock-ask.md ──its own PreToolUse/PostToolUse
 *     hooks──▶ the container's relay (hooks/relay.py) ──▶ the real ingest
 *   origin `match` from A's container ⇒ admitted ⇒ queued ⇒ B is free ⇒
 *     the relay text ──typed into B's pane──▶ B's CLI
 *   B's CLI: Write .st-outbox/mock-reply.md ⇒ admitted ⇒ typed into A's pane
 *   last message of the budget delivered ⇒ grant{ended, budget}
 *
 * Real: the image's entrypoint, managed hooks file (activation.ts
 * `buildHooksSettings`), session-start.sh, relay.py, tmux and CLI; the ingest
 * handler, ConversationService with the origin verifier in observe mode over
 * production's `inspectSessionNetworkWith`, both stores, the fan-out, collab
 * and outbox watcher, and `openWorkspaceFile` reading what the CLI wrote
 * through the bind mount.
 *
 * Faked: D1 (in-memory, st-receiver.mts's approach), the directory's
 * `bindings()`, the model (session-image/test/mock-anthropic.mjs: it answers
 * a consult header block with one Write of exactly that block), and the
 * Composer's decision layer — `composerSend` here types the text with the
 * SAME steps the executor uses (composerText.ts `segment` / `stepArgv` and
 * the consumption wait of §8.1.5 2b, as composer.smoke.ts does) but checks
 * none of the Composer's preconditions; those have their own smoke.
 *
 * The harness listens on the host; `st-backend` in each container resolves
 * to the bridge gateway, so the peer the ingest sees is the container's own
 * address (printed next to `docker inspect`).
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import Dockerode from "dockerode";

const IMAGE = process.argv[2] ?? "shared-terminal-session";
const RUN = randomBytes(4).toString("hex");
const ROOT = path.join(os.tmpdir(), `st-d3-relay-${RUN}`);
// Before any backend module is loaded: workspaceFiles.ts reads it at import.
process.env.WORKSPACE_ROOT = ROOT;
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "warn";
process.env.CLOUDFLARE_ACCOUNT_ID ??= "smoke";
process.env.CLOUDFLARE_API_TOKEN ??= "smoke";
process.env.D1_DATABASE_ID ??= "smoke";

const docker = new Dockerode();
const REPO = path.resolve(__dirname, "../../../..");
const NET = `st-d3r-${RUN}-net`;
const NAME = (role: string) => `st-d3r-${RUN}-${role}`;
const LABEL = `io.shared-terminal.smoke=d3-relay-${RUN}`;
const OUT = path.join(ROOT, ".smoke-out");
const API_KEY = `sk-ant-api03-smoke-${randomBytes(12).toString("hex")}`;
const TAB = "tab1";

const PID = randomUUID();
const OWNER = "smoke-owner";
const A = randomUUID();
const B = randomUUID();
const SA = randomUUID();
const SB = randomUUID();
const TOKEN: Record<string, string> = {
	[SA]: randomBytes(32).toString("hex"),
	[SB]: randomBytes(32).toString("hex"),
};
const CONTAINER: Record<string, string> = { [SA]: NAME("a"), [SB]: NAME("b") };
const WHO: Record<string, string> = { [SA]: "A", [SB]: "B" };

let failures = 0;
let n = 0;
function check(what: string, ok: boolean, detail?: unknown): boolean {
	n++;
	if (ok) console.log(`  ${n} ok: ${what}`);
	else {
		failures++;
		console.error(
			`  ${n} FAIL: ${what}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`,
		);
	}
	return ok;
}
function phase(name: string): void {
	console.log(`\n── ${name} ──`);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(what: string, fn: () => boolean | Promise<boolean>, ms = 60_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return true;
		await sleep(150);
	}
	console.error(`  (timed out waiting for: ${what})`);
	return false;
}

// ── Docker (the CLI, as the other smokes drive it) ────────────────────────

interface Run {
	code: number;
	out: string;
}
function sh(args: string[], stdin?: string): Run {
	const r = spawnSync("docker", args, { input: stdin, maxBuffer: 64 * 1024 * 1024 });
	return {
		code: r.status ?? -1,
		out: `${r.stdout?.toString() ?? ""}${r.stderr?.toString() ?? ""}`,
	};
}
function must(what: string, r: Run): string {
	if (r.code !== 0) throw new Error(`${what}: ${r.out.trim()}`);
	return r.out.trim();
}
/** `docker exec -i <container> argv…` with optional stdin (a paste's text). */
function dexec(container: string, argv: string[], stdin?: string): Promise<Run> {
	return new Promise((resolve) => {
		const p = spawn("docker", ["exec", "-i", container, ...argv]);
		const out: Buffer[] = [];
		p.stdout.on("data", (c: Buffer) => out.push(c));
		p.stderr.on("data", (c: Buffer) => out.push(c));
		p.on("close", (code) =>
			resolve({ code: code ?? -1, out: Buffer.concat(out).toString("utf8") }),
		);
		p.stdin.end(stdin ?? "");
	});
}
/** Files under ROOT end up owned by root and by the image's user: only root removes them. */
const asRoot = (script: string, stdin?: string) =>
	sh(
		[
			"run",
			"--rm",
			"-i",
			"--user",
			"0",
			"-v",
			`${ROOT}:/wr`,
			"--entrypoint",
			"bash",
			IMAGE,
			"-c",
			script,
		],
		stdin,
	);

async function cleanup(): Promise<void> {
	const ids = sh(["ps", "-aq", "--filter", `label=${LABEL}`])
		.out.split("\n")
		.filter(Boolean);
	if (ids.length > 0) sh(["rm", "-f", ...ids]);
	sh(["network", "rm", NET]);
	asRoot("rm -rf /wr/* /wr/.[!.]*");
	await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
}

async function main(): Promise<void> {
	// ── D1: the only backend dependency that is emulated ──────────────────
	const { hashIngestToken } = await import("../../conversation/registry.js");
	const rows = new Map<string, Record<string, unknown>>();
	const owners = new Map<string, string>();
	const ok = (results: unknown[] = []) =>
		new Response(
			JSON.stringify({ success: true, errors: [], result: [{ results, success: true, meta: {} }] }),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
		const { sql, params = [] } = JSON.parse(String(init?.body ?? "{}")) as {
			sql: string;
			params?: unknown[];
		};
		if (/FROM sessions WHERE session_id = \?/.test(sql)) {
			const row = rows.get(String(params[0]));
			return ok(row ? [row] : []);
		}
		if (/FROM sessions WHERE status = 'running'/.test(sql)) {
			return ok(
				[...rows].map(([session_id, r]) => ({
					session_id,
					conversation_requested: 1,
					ingest_token_hash: r.ingest_token_hash,
				})),
			);
		}
		if (/^INSERT OR IGNORE INTO claude_conversations/.test(sql)) {
			if (!owners.has(String(params[0]))) owners.set(String(params[0]), String(params[1]));
			return ok();
		}
		if (/^SELECT st_session_id FROM claude_conversations/.test(sql)) {
			const owner = owners.get(String(params[0]));
			return ok(owner ? [{ st_session_id: owner }] : []);
		}
		return ok();
	}) as typeof fetch;

	const { ConversationService } = await import("../../conversation/service.js");
	const { ConversationStore } = await import("../../conversation/store.js");
	const { createIngestHandler } = await import("../../conversation/ingestRoute.js");
	const { IngestOriginVerifier } = await import("../../conversation/ingestOrigin.js");
	const { buildHooksSettings } = await import("../../conversation/activation.js");
	const ct = await import("../../conversation/composerText.js");
	const { inspectSessionNetworkWith } = await import("../../dockerManager.js");
	const { openWorkspaceFile, listWorkspaceDir } = await import("../../workspaceFiles.js");
	const { ProjectConversationStore } = await import("./store.js");
	const { ProjectFanout } = await import("./fanout.js");
	const { ProjectCollab } = await import("./collab.js");
	const { OutboxWatcher } = await import("./outbox.js");
	const { parseOutbox } = await import("./collabText.js");
	const { LOG_FILE } = await import("./log.js");
	const { checkLog } = await import("./logCheck.js");
	const { projectDir } = await import("./paths.js");
	type RecipientState = import("./collab.js").RecipientState;
	type ProjectBindings = import("./fanout.js").ProjectBindings;
	type LogLine = import("./log.js").LogLine;
	type PersistedEvent = import("../../conversation/store.js").PersistedEvent;
	type EventMeta = import("../../conversation/store.js").EventMeta;

	// ── The real ingest stack, listening before any container exists ──────
	const verifier = new IngestOriginVerifier({
		inspectSessionNetwork: (cid) => inspectSessionNetworkWith(docker, cid, NET),
	});
	const captureStore = new ConversationStore({ workspaceRoot: ROOT });
	const service = new ConversationService({
		workspaceRoot: ROOT,
		enabled: true,
		port: 0,
		store: captureStore,
		ingestOrigin: verifier,
		ingestOriginMode: "observe",
	});
	const handler = createIngestHandler({ service });
	const peers = new Map<string, Set<string>>();
	const server = http.createServer((req, res) => {
		const sid = String(req.headers["x-st-session"] ?? "?");
		peers.set(sid, (peers.get(sid) ?? new Set()).add(String(req.socket.remoteAddress)));
		void handler(req, res, () => {
			res.statusCode = 404;
			res.end();
		});
	});
	await new Promise<void>((r) => server.listen(0, "0.0.0.0", () => r()));
	const port = (server.address() as AddressInfo).port;

	// Every live capture event with its origin verdict, in arrival order.
	const events: Array<{ sid: string; cid: string; ev: PersistedEvent; origin: string }> = [];
	service.onPersistedEvent((sid: string, cid: string, ev: PersistedEvent, meta?: EventMeta) => {
		events.push({ sid, cid, ev, origin: meta?.origin ?? "none" });
	});
	const trace = (sid: string) =>
		events
			.filter((e) => e.sid === sid)
			.map(
				(e) =>
					`${e.ev.ev}${e.ev.ev.startsWith("tool") ? `(${e.ev.data?.tool_name})` : ""}:${e.origin}`,
			)
			.join(" ");

	// ── The project side ──────────────────────────────────────────────────
	const bindings = async (): Promise<ProjectBindings> =>
		new Map([
			[A, { removed: false, binding: { bindingId: "bind-a", epoch: 1, sessionId: SA } }],
			[B, { removed: false, binding: { bindingId: "bind-b", epoch: 1, sessionId: SB } }],
		]);
	// index.ts `soleConversation`, verbatim (index.ts cannot be imported).
	const soleConversation = async (sid: string): Promise<RecipientState> => {
		const { conversations, meta } = await service.summariesWithMeta(sid);
		if (meta !== "ok") return { kind: "none" };
		const live = conversations.filter(
			(c) => c.kind === "interactive" && c.paneId !== null && !c.endedAt,
		);
		if (live.length === 0) return { kind: "none" };
		if (live.length > 1) return { kind: "ambiguous" };
		const only = live[0] as (typeof live)[number];
		return { kind: only.status === "waiting_input" ? "ready" : "busy", cid: only.sessionId };
	};

	// ── Typing into a pane, with the executor's own steps ─────────────────
	const pane: Record<string, string> = {};
	const screen = async (sid: string) =>
		(await dexec(CONTAINER[sid] as string, ct.captureArgv(pane[sid] as string))).out;
	const plainScreen = async (sid: string) =>
		(
			await dexec(CONTAINER[sid] as string, [
				"tmux",
				"capture-pane",
				"-p",
				"-t",
				pane[sid] ?? TAB,
				"-S",
				"-60",
			])
		).out;
	async function dumpScreen(sid: string, label: string): Promise<void> {
		const s = (await plainScreen(sid))
			.split("\n")
			.filter((l) => l.trim().length > 0)
			.slice(-24);
		console.log(`  screen of ${WHO[sid]} (${label}):\n${s.map((l) => `    | ${l}`).join("\n")}`);
	}
	const atPrompt = (sid: string, ms = 90_000) =>
		waitFor(
			`${WHO[sid]}'s prompt`,
			async () => ct.inputRegion(await screen(sid)).kind === "empty",
			ms,
		);
	/** composer.smoke.ts `deliver`: every step a fresh exec; after a paste, wait until it is consumed. */
	async function typeInto(
		sid: string,
		text: string,
	): Promise<{ ok: boolean; steps: number; ms: number }> {
		const container = CONTAINER[sid] as string;
		const t0 = Date.now();
		let steps = 0;
		for (const step of ct.segment(ct.normalizeText(text)).steps) {
			const before = step.kind === "paste" ? ct.inputRegionPlain(await screen(sid)) : null;
			const r = await dexec(
				container,
				ct.stepArgv(step, pane[sid] as string, `st-d3r-${RUN}`),
				step.kind === "paste" ? step.text : undefined,
			);
			steps++;
			if (r.code !== 0) {
				console.error(`  (step ${step.kind} exited ${r.code}: ${r.out.trim()})`);
				return { ok: false, steps, ms: Date.now() - t0 };
			}
			if (step.kind !== "paste") continue;
			let consumed = false;
			for (let i = 0; i < ct.CONSUME_MAX_POLLS && !consumed; i++) {
				const after = ct.inputRegionPlain(await screen(sid));
				consumed = after !== null && ct.pasteConsumed(before, after, step.text);
				if (!consumed) await sleep(ct.CONSUME_POLL_MS);
			}
			if (!consumed) {
				await dumpScreen(sid, "paste not consumed");
				return { ok: false, steps, ms: Date.now() - t0 };
			}
		}
		return { ok: true, steps, ms: Date.now() - t0 };
	}

	const composed: Array<{ sid: string; cid: string; text: string }> = [];
	// WORKSPACE_ROOT exists before the store starts, as in a deployment: the
	// store creates `.projects/` under it, not the root itself.
	await fs.mkdir(ROOT, { recursive: true });
	const store = await ProjectConversationStore.start({
		workspaceRoot: ROOT,
		bootId: randomUUID(),
		log: {
			info: () => {},
			warn: (m: string) => console.log(`    [log] ${m}`),
			error: (m: string) => console.error(`    [log] ${m}`),
		},
	});
	if (store.unavailable) throw new Error(`project store unavailable: ${store.unavailable}`);
	const fanout = new ProjectFanout({
		store,
		relay: true,
		// Typing ~12 lines through `docker exec` takes seconds, not the 30 s
		// of an HTTP answer; nothing here is about that budget.
		tHttpMs: 180_000,
		bindings,
		target: async (sid) => {
			const c = await soleConversation(sid);
			return c.kind === "ready" || c.kind === "busy"
				? { kind: "ok", cid: c.cid }
				: { kind: "none" };
		},
		sessionMeta: async () => ({ userId: OWNER }),
		composerSend: async (input) => {
			const sid = input.stSessionId;
			composed.push({ sid, cid: input.cid, text: input.body.text });
			const promptsBefore = events.filter((e) => e.sid === sid && e.ev.ev === "user_prompt").length;
			if (!(await atPrompt(sid))) return { status: 409, body: { error: "composer-not-empty" } };
			const typed = await typeInto(sid, input.body.text);
			console.log(
				`    typed into ${WHO[sid]}'s pane: ${typed.steps} steps, ${typed.ms} ms, ok=${typed.ok}`,
			);
			if (!typed.ok) return { status: 502, body: { error: "delivery-failed" } };
			// The Composer's ack (§8.1.5): the CLI's own UserPromptSubmit for it.
			const acked = await waitFor(
				`${WHO[sid]}'s UserPromptSubmit`,
				() =>
					events.filter((e) => e.sid === sid && e.ev.ev === "user_prompt").length > promptsBefore,
				20_000,
			);
			const p = events.filter((e) => e.sid === sid && e.ev.ev === "user_prompt").at(-1);
			return {
				status: 202,
				body: acked
					? { result: "delivered", promptId: p?.ev.prompt_id ?? "p", seq: p?.ev.seq ?? 1 }
					: { result: "unconfirmed" },
			};
		},
		onDelivered: () => {},
		onUncertain: () => {},
	});
	const log = {
		info: (m: string) => console.log(`    [log] ${m}`),
		warn: (m: string) => console.log(`    [log] ${m}`),
	};
	const collab = new ProjectCollab({
		store,
		fanout,
		bindings,
		recipient: soleConversation,
		onCaptureEvent: (l) => service.onPersistedEvent((sid: string) => l(sid)),
		gateIntervalMs: 1000,
		log,
	});
	await collab.start(await store.openAll());
	const outbox = new OutboxWatcher({
		collab,
		onCaptureEvent: (l) => service.onPersistedEvent(l),
		bindings,
		conversation: soleConversation,
		openFile: (sid, rel, o) => openWorkspaceFile(sid, rel, o),
		listDir: (sid, rel, o) => listWorkspaceDir(sid, rel, o),
		sweepIntervalMs: 3_600_000,
		log,
	});
	outbox.start();
	const lines = async (): Promise<LogLine[]> =>
		(await fs.readFile(path.join(projectDir(ROOT, PID), LOG_FILE), "utf8").catch(() => ""))
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as LogLine);

	try {
		phase(`setup: network, the scripted model, two session containers (run ${RUN})`);
		await fs.mkdir(OUT, { recursive: true });
		await fs.chmod(OUT, 0o777);
		const hooksFile = path.join(ROOT, "conversation.json");
		await fs.writeFile(hooksFile, buildHooksSettings());
		for (const sid of [SA, SB]) {
			await fs.mkdir(path.join(ROOT, sid), { recursive: true });
			// The image's user writes its state and the outbox into the bind mount.
			await fs.chmod(path.join(ROOT, sid), 0o777);
			// Root-owned, 0644, as writeHooksFile() leaves it.
			must(
				"hooks file",
				asRoot(
					`install -d -m 0755 /wr/.claude-managed /wr/.claude-managed/${sid} && install -m 0644 /wr/conversation.json /wr/.claude-managed/${sid}/conversation.json`,
				),
			);
		}
		let gateway = "";
		for (let i = 0; i < 4 && !gateway; i++) {
			const s3 = `10.${200 + (randomBytes(1).readUInt8(0) % 50)}.${randomBytes(1).readUInt8(0)}`;
			const r = sh([
				"network",
				"create",
				"--label",
				LABEL,
				"--subnet",
				`${s3}.0/24`,
				"--gateway",
				`${s3}.1`,
				NET,
			]);
			if (r.code === 0) gateway = `${s3}.1`;
			else if (i === 3) must("network", r);
		}
		must(
			"mock",
			sh([
				"run",
				"-d",
				"--name",
				NAME("api"),
				"--label",
				LABEL,
				"--network",
				NET,
				"--network-alias",
				"mock-api",
				"-v",
				`${path.join(REPO, "session-image/test")}:/t:ro`,
				"-v",
				`${OUT}:/out`,
				"--entrypoint",
				"node",
				IMAGE,
				"/t/mock-anthropic.mjs",
				"8080",
				"/out/model-requests.jsonl",
			]),
		);
		for (const sid of [SA, SB]) {
			// DockerManager.spawn's flags, as conversation-smoke.sh mirrors them;
			// `st-backend` is this process, through the bridge gateway.
			must(
				`session ${WHO[sid]}`,
				sh([
					"run",
					"-d",
					"--name",
					CONTAINER[sid] as string,
					"--label",
					LABEL,
					"--init",
					"--cap-drop",
					"ALL",
					"--security-opt",
					"no-new-privileges",
					"--pids-limit",
					"512",
					"--network",
					NET,
					"--add-host",
					`st-backend:${gateway}`,
					"-e",
					`SESSION_ID=${sid}`,
					"-e",
					"SESSION_NAME=smoke",
					"-e",
					"ANTHROPIC_BASE_URL=http://mock-api:8080",
					"-e",
					`ANTHROPIC_API_KEY=${API_KEY}`,
					"-e",
					"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
					"-e",
					"DISABLE_AUTOUPDATER=1",
					// The relay's own log (counters only, never bodies or the token):
					// printed when the consult does not end.
					"-e",
					"ST_HOOKS_DEBUG=1",
					"-e",
					`ST_INGEST_TOKEN=${TOKEN[sid]}`,
					"-e",
					`ST_BACKEND_PORT=${port}`,
					"-v",
					`${path.join(ROOT, sid)}:/home/developer/workspace`,
					"-v",
					`${path.join(ROOT, ".claude-managed", sid)}:/etc/claude-code/managed-settings.d:ro`,
					IMAGE,
				]),
			);
			const id = must("id", sh(["inspect", "-f", "{{.Id}}", CONTAINER[sid] as string]));
			rows.set(sid, {
				status: "running",
				conversation_requested: 1,
				ingest_token_hash: hashIngestToken(TOKEN[sid] as string),
				ingest_token_hash_suspended: null,
				user_id: OWNER,
				container_id: id,
				revocation_seq: 0,
			});
		}
		for (const sid of [SA, SB]) {
			const c = CONTAINER[sid] as string;
			check(
				`${WHO[sid]}'s container is ready`,
				await waitFor(
					"ready",
					async () => (await dexec(c, ["test", "-f", "/tmp/.st-ready"])).code === 0,
				),
			);
			// What the first launch would otherwise ask (conversation-smoke.sh's seed).
			const seed = `set -e
f=~/.claude.json; [ -s "$f" ] || echo "{}" > "$f"
jq --arg k "${API_KEY.slice(-20)}" '. + {hasCompletedOnboarding: true, theme: "dark", customApiKeyResponses: {approved: [$k], rejected: []}, projects: {"/home/developer/workspace": {hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true}}}' "$f" > /tmp/cj
cat /tmp/cj > "$f"
mkdir -p ~/.claude
printf '{"skipDangerousModePermissionPrompt": true}\\n' > ~/.claude/settings.json`;
			must("seed", await dexec(c, ["bash", "-c", seed]));
			// An interactive tab as the backend creates one. Bypass mode: a
			// consulted agent's Write must not stop at a permission dialog.
			must(
				"tab",
				await dexec(c, [
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
					"/home/developer/workspace",
					"claude --dangerously-skip-permissions",
				]),
			);
			pane[sid] = (await dexec(c, ["tmux", "display", "-p", "-t", TAB, "#{pane_id}"])).out.trim();
		}
		for (const sid of [SA, SB]) {
			const up = await atPrompt(sid);
			check(`${WHO[sid]}'s CLI reaches its prompt in pane ${pane[sid]}`, up);
			if (!up) await dumpScreen(sid, "no prompt");
		}

		phase("a first turn each: the capture sees both conversations, from their containers");
		for (const sid of [SA, SB]) {
			const t = await typeInto(sid, "hola");
			const ready = await waitFor(
				`${WHO[sid]} waiting for input`,
				async () => (await soleConversation(sid)).kind === "ready",
			);
			check(
				`${WHO[sid]}: one interactive conversation with a pane, waiting for input after its turn`,
				t.ok && ready,
				{
					typed: t,
					state: await soleConversation(sid),
					trace: trace(sid),
				},
			);
			if (!ready) await dumpScreen(sid, "first turn");
			const view = await inspectSessionNetworkWith(
				docker,
				String(rows.get(sid)?.container_id),
				NET,
			);
			const inspected = view.exists ? view.addresses : [];
			const seenPeers = [...(peers.get(sid) ?? [])];
			console.log(
				`    peer of ${WHO[sid]}'s hook requests: ${seenPeers} · docker inspect on ${NET}: ${inspected}`,
			);
			check(
				`${WHO[sid]}: every hook request came from its container's address, verdict match`,
				seenPeers.length === 1 &&
					inspected.includes(seenPeers[0] as string) &&
					events.filter((e) => e.sid === sid).every((e) => e.origin === "match"),
				trace(sid),
			);
		}

		phase("the person's task to A, with a consult grant for B (2 messages)");
		const sent = await fanout.send(OWNER, PID, {
			clientMessageId: randomUUID(),
			text: "Averiguá con el otro agente qué versión usa el servicio.",
			to: [A],
			collab: { mode: "ask", with: B, maxMessages: 2 },
		});
		const grantId = String((sent.body as { grantId?: string }).grantId ?? "");
		check(
			"the grant was created and the task typed into A's pane",
			/^c-[0-9a-f]{12}$/.test(grantId) && composed.length >= 1 && composed[0]?.sid === SA,
			sent,
		);

		phase("A asks, B replies, the budget ends the consult");
		const done = await waitFor(
			"grant ended",
			async () =>
				(await lines()).some(
					(l) => l.ev === "grant" && l.event === "ended" && l.grant_id === grantId,
				),
			180_000,
		);
		// Let both CLIs finish their last turn before reading the screens/logs.
		await waitFor(
			"both idle",
			async () =>
				(await soleConversation(SA)).kind === "ready" &&
				(await soleConversation(SB)).kind === "ready",
			30_000,
		);
		await outbox.idle();
		const all = await lines();
		if (!done) {
			for (const sid of [SA, SB]) {
				await dumpScreen(sid, "consult did not end");
				console.log(`    capture of ${WHO[sid]}: ${trace(sid)}`);
				const relayLog = await dexec(CONTAINER[sid] as string, [
					"tail",
					"-n",
					"15",
					"/tmp/st-relay.log",
				]);
				console.log(`    relay log of ${WHO[sid]}:\n${relayLog.out.replace(/^/gm, "      ")}`);
			}
			console.log(`    project log:\n${all.map((l) => `      ${JSON.stringify(l)}`).join("\n")}`);
			const reqs = (
				await fs.readFile(path.join(OUT, "model-requests.jsonl"), "utf8").catch(() => "")
			)
				.split("\n")
				.filter(Boolean);
			console.log(`    model requests: ${reqs.length}; last user text of each of the last 6:`);
			for (const r of reqs.slice(-6)) {
				const m =
					(JSON.parse(r) as { messages?: Array<{ role: string; content: unknown }> }).messages ??
					[];
				console.log(
					`      ${JSON.stringify(m.filter((x) => x.role === "user").at(-1)?.content).slice(0, 600)}`,
				);
			}
		}
		const accepted = all.filter((l) => l.ev === "outbox" && l.event === "accepted");
		const rel = (l: LogLine) =>
			typeof l.authorized_by === "string" && l.authorized_by === `collab:${grantId}`;
		const relayDeliveries = all.filter((l) => l.ev === "delivery" && rel(l));
		const ended = all.find(
			(l) => l.ev === "grant" && l.event === "ended" && l.grant_id === grantId,
		);
		check(
			"two outbox{accepted}, both origin match: A's ask, then B's reply",
			accepted.length === 2 &&
				accepted.every((l) => l.origin === "match") &&
				(accepted[0]?.from as { sid?: string })?.sid === SA &&
				accepted[0]?.kind === "ask" &&
				(accepted[1]?.from as { sid?: string })?.sid === SB &&
				accepted[1]?.kind === "reply",
			accepted,
		);
		for (const l of accepted) console.log(`    ${JSON.stringify(l)}`);
		check(
			"no outbox line was rejected or unverified",
			all.filter((l) => l.ev === "outbox").length === 2,
		);
		check(
			"both relays were delivered, once each",
			relayDeliveries.filter((l) => l.state === "delivered").length === 2 &&
				relayDeliveries.filter((l) => l.state === "sending").length === 2,
			relayDeliveries.map((l) => [l.agent_id, l.state, l.reason]),
		);
		check(`the grant ended by budget: ${JSON.stringify(ended)}`, ended?.reason === "budget");
		const report = checkLog(all);
		check("checkLog finds no violation", report.violations.length === 0, report.violations);
		check(
			"the Composer was called three times: the task (A), the ask (B), the reply (A)",
			composed.map((c) => c.sid).join() === [SA, SB, SA].join(),
			composed.map((c) => WHO[c.sid]),
		);
		check(
			"B received A's body between the delimiters, with the reply header to use",
			/<<<ST-MSG [0-9a-f]{8}\nMock ask for c-[0-9a-f]{12}\.\nST-MSG [0-9a-f]{8}>>>$/.test(
				composed[1]?.text ?? "",
			) && (composed[1]?.text ?? "").includes("kind: reply"),
			composed[1]?.text,
		);
		check(
			"A received B's reply",
			(composed[2]?.text ?? "").includes(`Mock reply for ${grantId}.`),
			composed[2]?.text,
		);

		phase("the files the CLIs wrote, and the capture events that admitted them");
		for (const [i, sid] of [SA, SB].entries()) {
			const o = accepted[i];
			const name = i === 0 ? "mock-ask.md" : "mock-reply.md";
			const bytes = await fs
				.readFile(path.join(ROOT, sid, ".st-outbox", name))
				.catch(() => Buffer.alloc(0));
			const parsed = parseOutbox(bytes);
			check(
				`${WHO[sid]}'s CLI wrote a valid .st-outbox/${name} (${bytes.length} bytes) naming the grant`,
				parsed.ok && parsed.header.collab === grantId,
				parsed,
			);
			const cid = (o?.from as { cid?: string } | undefined)?.cid ?? "";
			// No accepted line ⇒ no conversation id to read: the check below says so.
			const read = cid ? await captureStore.readEvents(sid, cid, 0, 100_000) : [];
			const persisted = read.filter(
				(e) =>
					(e.ev === "tool_start" || e.ev === "tool_end") && e.data?.tool_use_id === o?.tool_use_id,
			);
			check(
				`${WHO[sid]}: the capture file holds the Write's tool_start and tool_end{ok} for ${String(o?.tool_use_id)}`,
				persisted.length === 2 &&
					persisted[0]?.ev === "tool_start" &&
					persisted[1]?.ev === "tool_end" &&
					persisted.every((e) => e.data?.tool_name === "Write" && e.agent_id === null) &&
					(persisted[0]?.data?.summary as { file_path?: string })?.file_path ===
						`/home/developer/workspace/.st-outbox/${name}` &&
					persisted[1]?.data?.ok === true,
				persisted,
			);
			console.log(`    real Write events of ${WHO[sid]} (verbatim, as persisted):`);
			for (const e of persisted) console.log(`    ${JSON.stringify(e)}`);
			console.log(`    capture of ${WHO[sid]}: ${trace(sid)}`);
		}
		check(
			"every event of both sessions carried origin match",
			events.length > 0 && events.every((e) => e.origin === "match"),
			[...new Set(events.map((e) => e.origin))],
		);
		check(
			`the watcher refused nothing on origin: ${JSON.stringify(outbox.stats)}`,
			outbox.stats.originNotMatched === 0 && outbox.stats.admitted.accepted === 2,
		);
	} finally {
		outbox.stop();
		collab.stop();
		server.close();
		server.closeAllConnections();
		await service.shutdown().catch(() => {});
		await store.close().catch(() => {});
	}
}

main()
	.catch((err) => {
		failures++;
		console.error(`  FAIL: ${(err as Error).stack ?? err}`);
	})
	.finally(async () => {
		await cleanup();
		console.log(
			failures === 0 ? "\nD3 relay smoke: all ok" : `\nD3 relay smoke: ${failures} failure(s)`,
		);
		process.exit(failures === 0 ? 0 : 1);
	});
