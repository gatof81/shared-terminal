/**
 * relayOrigin.smoke.ts — the acceptance criterion of
 * docs/PROJECT_CONVERSATION.md §7.3.1 (cases a–f, M6) against a REAL dockerd
 * and the real session image. Run by the Session Image workflow:
 *
 *   cd backend && npx tsx src/projects/conversation/relayOrigin.smoke.ts <image>
 *
 * The question only a real daemon answers: does the TCP peer the ingest sees
 * identify the container a request left from, and does D3 admit an agent
 * message on exactly that and nothing else? So everything on the decision
 * path is the production code: `createIngestHandler` on a real HTTP server
 * (the peer is the socket's own `remoteAddress`), `ConversationService` with
 * an `IngestOriginVerifier` in OBSERVE mode whose port is the production
 * `inspectSessionNetworkWith` (a real `docker inspect` by container id),
 * `ConversationStore`, `ProjectConversationStore` (real writer lock),
 * `ProjectFanout{relay: true}`, `ProjectCollab` and `OutboxWatcher` over the
 * real `openWorkspaceFile` / `listWorkspaceDir`.
 *
 * Faked, and only these: D1 (an in-memory emulator over `globalThis.fetch`,
 * the st-receiver.mts approach: two running sessions with their REAL
 * container ids and token hashes), the project directory's `bindings()`, and
 * the Composer (`composerSend` records the text and answers `delivered`).
 *
 * How a request leaves a container and reaches this process: the harness
 * listens on the host; each container is on a user-defined bridge network
 * created here and posts to that network's GATEWAY address. Traffic from a
 * bridge to the host's own bridge address is not masqueraded, so the peer is
 * the container's address — which the log prints next to what
 * `docker inspect` says, as the evidence. The containers run the session
 * image with a trivial command (no entrypoint, no CLI): what is under test
 * is the network namespace a request comes from, and `curl` is the image's.
 * They carry production's `CapDrop: ALL` + no-new-privileges, the property
 * ingestOrigin.ts relies on for the address to be trustworthy.
 *
 * Isolated: a unique run id in every resource name, a temp WORKSPACE_ROOT,
 * everything removed in `finally`.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import Dockerode from "dockerode";

const IMAGE = process.argv[2] ?? "shared-terminal-session";
const RUN = randomBytes(4).toString("hex");
const ROOT = path.join(os.tmpdir(), `st-d3-origin-${RUN}`);
// A second root for case (f)'s receiver without a verifier: two capture
// stores must never write the same events files.
const ROOT_OFF = path.join(os.tmpdir(), `st-d3-origin-${RUN}-off`);
// Before any backend module is loaded: workspaceFiles.ts reads it at import.
process.env.WORKSPACE_ROOT = ROOT;
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "warn";
process.env.CLOUDFLARE_ACCOUNT_ID ??= "smoke";
process.env.CLOUDFLARE_API_TOKEN ??= "smoke";
process.env.D1_DATABASE_ID ??= "smoke";

const docker = new Dockerode();
const NET = `st-d3s-${RUN}-net`;
const NAME = (role: string) => `st-d3s-${RUN}-${role}`;
const LABEL = { "io.shared-terminal.smoke": `d3-origin-${RUN}` };

const PID = randomUUID();
const OWNER = "smoke-owner";
const A = randomUUID();
const B = randomUUID();
const SA = randomUUID();
const SB = randomUUID();
const TOKEN_A = randomBytes(32).toString("hex");
const TOKEN_B = randomBytes(32).toString("hex");
const OUTBOX_ABS = "/home/developer/workspace/.st-outbox/";

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
async function waitFor(what: string, fn: () => boolean | Promise<boolean>, ms = 15_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return true;
		await sleep(50);
	}
	console.error(`  (timed out waiting for: ${what})`);
	return false;
}

// ── Docker helpers ────────────────────────────────────────────────────────

let subnet3 = "";
async function createNetwork(): Promise<void> {
	// An explicit subnet is what lets a container be given a chosen address
	// (case e needs a container on the address the replaced one had).
	let last: unknown;
	for (let i = 0; i < 4; i++) {
		subnet3 = `10.${200 + (randomBytes(1).readUInt8(0) % 50)}.${randomBytes(1).readUInt8(0)}`;
		try {
			await docker.createNetwork({
				Name: NET,
				Driver: "bridge",
				Labels: LABEL,
				IPAM: { Config: [{ Subnet: `${subnet3}.0/24`, Gateway: `${subnet3}.1` }] },
			});
			return;
		} catch (err) {
			last = err; // overlapping pool on this host: draw again
		}
	}
	throw last;
}

async function startContainer(role: string, host: number, workspace: string): Promise<string> {
	const c = await docker.createContainer({
		name: NAME(role),
		Image: IMAGE,
		Entrypoint: ["sleep"],
		Cmd: ["infinity"],
		Labels: LABEL,
		HostConfig: {
			NetworkMode: NET,
			Binds: [`${workspace}:/home/developer/workspace`],
			// dockerManager.ts spawn: without NET_RAW/NET_ADMIN a container can
			// neither forge a source address on the bridge nor change its own.
			CapDrop: ["ALL"],
			SecurityOpt: ["no-new-privileges"],
		},
		NetworkingConfig: {
			EndpointsConfig: { [NET]: { IPAMConfig: { IPv4Address: `${subnet3}.${host}` } } },
		},
	});
	await c.start();
	return c.id;
}

async function execOut(id: string, cmd: string[]): Promise<{ code: number; out: string }> {
	const e = await docker
		.getContainer(id)
		.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
	const s = await e.start({});
	const out: Buffer[] = [];
	await new Promise<void>((r) => {
		docker.modem.demuxStream(
			s,
			{ write: (c: Buffer) => out.push(c) } as unknown as NodeJS.WritableStream,
			{ write: (c: Buffer) => out.push(c) } as unknown as NodeJS.WritableStream,
		);
		s.on("end", () => r());
		s.on("close", () => r());
	});
	return { code: (await e.inspect()).ExitCode ?? -1, out: Buffer.concat(out).toString("utf8") };
}

async function cleanup(): Promise<void> {
	const mine = await docker
		.listContainers({
			all: true,
			filters: { label: [`io.shared-terminal.smoke=d3-origin-${RUN}`] },
		})
		.catch(() => []);
	for (const c of mine) {
		await docker
			.getContainer(c.Id)
			.remove({ force: true })
			.catch(() => {});
	}
	await docker
		.getNetwork(NET)
		.remove()
		.catch(() => {});
	await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
	await fs.rm(ROOT_OFF, { recursive: true, force: true }).catch(() => {});
}

// ── The hook bodies, in the shape the real CLI posts them ─────────────────
// (conversation-smoke.sh's raw capture; normalize.ts is what reads them.)

const common = (cid: string) => ({
	session_id: cid,
	transcript_path: `/home/developer/.claude/projects/-home-developer-workspace/${cid}.jsonl`,
	cwd: "/home/developer/workspace",
});
const sessionStart = (cid: string) => ({
	...common(cid),
	hook_event_name: "SessionStart",
	source: "startup",
	model: "claude-smoke",
	// What hooks/session-start.sh adds: the pane the CLI runs in.
	st: { claude_version: "2.1.308", tmux_session: "main", pane: "%0", argv: ["claude"] },
});
const promptSubmit = (cid: string) => ({
	...common(cid),
	permission_mode: "default",
	hook_event_name: "UserPromptSubmit",
	prompt: "hola",
});
const stop = (cid: string) => ({
	...common(cid),
	permission_mode: "default",
	hook_event_name: "Stop",
	stop_hook_active: false,
	last_assistant_message: "Listo.",
});
function writeHooks(cid: string, name: string, content: string, toolUseId: string) {
	const tool = {
		...common(cid),
		permission_mode: "default",
		tool_name: "Write",
		tool_input: { file_path: OUTBOX_ABS + name, content },
		tool_use_id: toolUseId,
	};
	return [
		{ ...tool, hook_event_name: "PreToolUse" },
		{
			...tool,
			hook_event_name: "PostToolUse",
			tool_response: {
				type: "create",
				filePath: OUTBOX_ABS + name,
				content,
				structuredPatch: [],
				originalFile: null,
			},
			duration_ms: 7,
		},
	];
}

async function main(): Promise<void> {
	// ── D1: the only backend dependency that is emulated ──────────────────
	const { hashIngestToken } = await import("../../conversation/registry.js");
	const rows = new Map<string, Record<string, unknown>>();
	const session = (token: string, containerId: string) => ({
		status: "running",
		conversation_requested: 1,
		ingest_token_hash: hashIngestToken(token),
		ingest_token_hash_suspended: null,
		user_id: OWNER,
		container_id: containerId,
		revocation_seq: 0,
	});
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
	const { INGEST_PATH } = await import("../../conversation/activation.js");
	const { ORIGIN_INSPECT_TIMEOUT_MS } = await import("../../conversation/limits.js");
	const { inspectSessionNetworkWith } = await import("../../dockerManager.js");
	const { openWorkspaceFile, listWorkspaceDir } = await import("../../workspaceFiles.js");
	const { ProjectConversationStore } = await import("./store.js");
	const { ProjectFanout } = await import("./fanout.js");
	const { ProjectCollab } = await import("./collab.js");
	const { OutboxWatcher } = await import("./outbox.js");
	const { LOG_FILE } = await import("./log.js");
	const { checkLog } = await import("./logCheck.js");
	const { projectDir } = await import("./paths.js");
	type RecipientState = import("./collab.js").RecipientState;
	type ProjectBindings = import("./fanout.js").ProjectBindings;
	type LogLine = import("./log.js").LogLine;
	type PersistedEvent = import("../../conversation/store.js").PersistedEvent;
	type EventMeta = import("../../conversation/store.js").EventMeta;

	phase(`setup: network, two session containers (run ${RUN})`);
	for (const sid of [SA, SB]) {
		await fs.mkdir(path.join(ROOT, sid, ".st-outbox"), { recursive: true });
		await fs.chmod(path.join(ROOT, sid), 0o777);
	}
	await fs.mkdir(ROOT_OFF, { recursive: true });
	await createNetwork();
	const gateway = `${subnet3}.1`;
	let aId = await startContainer("a", 10, path.join(ROOT, SA));
	const bId = await startContainer("b", 11, path.join(ROOT, SB));
	rows.set(SA, session(TOKEN_A, aId));
	rows.set(SB, session(TOKEN_B, bId));

	// ── The real ingest stack, origin check in OBSERVE mode ───────────────
	// The verifier's port is production's own inspection (dockerManager.ts
	// `inspectSessionNetwork` is this function on SESSIONS_NETWORK). The
	// wrapper only counts calls and, for case (d) alone, answers late.
	let inspectDelayMs = 0;
	let inspections = 0;
	const verifier = new IngestOriginVerifier({
		inspectSessionNetwork: async (cid) => {
			inspections++;
			const view = await inspectSessionNetworkWith(docker, cid, NET);
			if (inspectDelayMs > 0) await sleep(inspectDelayMs);
			return view;
		},
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
	// Case (f): the same stack with the origin flag OFF — no verifier at all.
	const captureStoreOff = new ConversationStore({ workspaceRoot: ROOT_OFF });
	const serviceOff = new ConversationService({
		workspaceRoot: ROOT_OFF,
		enabled: true,
		port: 0,
		store: captureStoreOff,
	});

	// Every request's TCP peer, as the socket reports it (what the handler
	// itself reads), tagged by a header the ingest ignores.
	const peers: Array<{ tag: string; peer: string }> = [];
	const serve = (svc: InstanceType<typeof ConversationService>) => {
		const handler = createIngestHandler({ service: svc });
		const server = http.createServer((req, res) => {
			peers.push({
				tag: String(req.headers["x-smoke-case"] ?? "?"),
				peer: String(req.socket.remoteAddress),
			});
			void handler(req, res, () => {
				res.statusCode = 404;
				res.end();
			});
		});
		return new Promise<http.Server>((resolve) =>
			server.listen(0, "0.0.0.0", () => resolve(server)),
		);
	};
	const server = await serve(service);
	const serverOff = await serve(serviceOff);
	const port = (server.address() as AddressInfo).port;
	const portOff = (serverOff.address() as AddressInfo).port;
	const peerOf = (tag: string) => [
		...new Set(peers.filter((p) => p.tag === tag).map((p) => p.peer)),
	];

	// What each live event carried to in-process observers (store.ts EventMeta).
	const seen = new Map<
		string,
		{ sid: string; cid: string; ev: string; origin: string; seq: number }[]
	>();
	const record = (sid: string, cid: string, ev: PersistedEvent, meta?: EventMeta) => {
		const id = typeof ev.data?.tool_use_id === "string" ? ev.data.tool_use_id : `${cid}:${ev.ev}`;
		const list = seen.get(id) ?? [];
		list.push({ sid, cid, ev: ev.ev, origin: meta?.origin ?? "none", seq: ev.seq });
		seen.set(id, list);
	};
	service.onPersistedEvent(record);
	serviceOff.onPersistedEvent(record);
	const origins = (toolUseId: string) => {
		const l = seen.get(toolUseId) ?? [];
		return `${l.find((e) => e.ev === "tool_start")?.origin ?? "-"}/${l.find((e) => e.ev === "tool_end")?.origin ?? "-"}`;
	};
	const bothSeen = (toolUseId: string) => (seen.get(toolUseId) ?? []).length >= 2;

	// ── Posting a hook from a container's network namespace ───────────────
	async function postFrom(
		containerId: string,
		tag: string,
		body: unknown,
		o: { token?: string; sid?: string; port?: number } = {},
	): Promise<string> {
		const r = await execOut(containerId, [
			"curl",
			"-q",
			"-s",
			"-o",
			"/dev/null",
			"-w",
			"%{http_code}",
			"-m",
			"8",
			"--noproxy",
			"*",
			"-X",
			"POST",
			`http://${gateway}:${o.port ?? port}${INGEST_PATH}`,
			"-H",
			"content-type: application/json",
			"-H",
			`authorization: Bearer ${o.token ?? TOKEN_A}`,
			"-H",
			`x-st-session: ${o.sid ?? SA}`,
			"-H",
			"x-st-tmux-pane: %0",
			"-H",
			`x-smoke-case: ${tag}`,
			"--data-binary",
			JSON.stringify(body),
		]);
		return r.code === 0 ? r.out.trim() : `curl exit ${r.code}: ${r.out.trim()}`;
	}
	/** The same request from this process (the "backend host"), to `host`. */
	function postFromHost(host: string, tag: string, body: unknown): Promise<string> {
		const data = Buffer.from(JSON.stringify(body));
		return new Promise((resolve) => {
			const req = http.request(
				{
					host,
					port,
					path: INGEST_PATH,
					method: "POST",
					headers: {
						"content-type": "application/json",
						"content-length": data.length,
						authorization: `Bearer ${TOKEN_A}`,
						"x-st-session": SA,
						"x-st-tmux-pane": "%0",
						"x-smoke-case": tag,
					},
				},
				(res) => {
					res.resume();
					res.on("end", () => resolve(String(res.statusCode)));
				},
			);
			req.setTimeout(8000, () => req.destroy(new Error("timeout")));
			req.on("error", (e) => resolve(`error: ${e.message}`));
			req.end(data);
		});
	}

	// ── The project side: real store, fan-out, collab, watcher ────────────
	const bindings = async (): Promise<ProjectBindings> =>
		new Map([
			[A, { removed: false, binding: { bindingId: "bind-a", epoch: 1, sessionId: SA } }],
			[B, { removed: false, binding: { bindingId: "bind-b", epoch: 1, sessionId: SB } }],
		]);
	// index.ts `soleConversation`, verbatim (index.ts cannot be imported: it
	// boots the server): a participant session has ONE interactive
	// conversation with a pane, read from the REAL capture.
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
	const composed: Array<{ sid: string; cid: string; text: string }> = [];
	const store = await ProjectConversationStore.start({ workspaceRoot: ROOT, bootId: randomUUID() });
	const fanout = new ProjectFanout({
		store,
		relay: true,
		bindings,
		target: async (sid) => {
			const c = await soleConversation(sid);
			return c.kind === "ready" || c.kind === "busy"
				? { kind: "ok", cid: c.cid }
				: { kind: "none" };
		},
		sessionMeta: async () => ({ userId: OWNER }),
		// The Composer is the one effect that is faked: it records and says delivered.
		composerSend: async (input) => {
			composed.push({ sid: input.stSessionId, cid: input.cid, text: input.body.text });
			return {
				status: 202,
				body: { result: "delivered", promptId: `p-${composed.length}`, seq: 1 },
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
		onCaptureEvent: (l) => service.onPersistedEvent((sid) => l(sid)),
		gateIntervalMs: 500,
		log,
	});
	await collab.start(await store.openAll());
	const outbox = new OutboxWatcher({
		collab,
		// Both receivers feed the one watcher: case (f) is "the same write, on
		// events that carry no verdict".
		onCaptureEvent: (l) => {
			const u1 = service.onPersistedEvent(l);
			const u2 = serviceOff.onPersistedEvent(l);
			return () => {
				u1();
				u2();
			};
		},
		bindings,
		conversation: soleConversation,
		openFile: (sid, rel, o) => openWorkspaceFile(sid, rel, o),
		listDir: (sid, rel, o) => listWorkspaceDir(sid, rel, o),
		sweepIntervalMs: 3_600_000,
		log,
	});
	outbox.start();

	const lines = async (): Promise<LogLine[]> =>
		(await fs.readFile(path.join(projectDir(ROOT, PID), LOG_FILE), "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as LogLine);
	const outboxLine = async (name: string) =>
		(await lines()).find((l) => l.ev === "outbox" && l.path === `.st-outbox/${name}`);
	const relaysTo = (sid: string, body: string) =>
		composed.filter((c) => c.sid === sid && c.text.includes("<<<ST-MSG") && c.text.includes(body));
	const quiet = async () => {
		await outbox.idle();
		await sleep(700); // > one gate interval: a queued relay would have left
		await outbox.idle();
	};
	const addresses = async (cid: string) => {
		const v = await inspectSessionNetworkWith(docker, cid, NET);
		return v.exists ? v.addresses : [];
	};

	try {
		phase("the capture knows both sessions' conversations (real SessionStart shape)");
		let cidA = randomUUID();
		const cidB = randomUUID();
		check(
			"SessionStart of A from A's container answers 204",
			(await postFrom(aId, "boot-a", sessionStart(cidA))) === "204",
		);
		const fromB = { token: TOKEN_B, sid: SB };
		let bCodes = "";
		for (const body of [sessionStart(cidB), promptSubmit(cidB), stop(cidB)]) {
			bCodes += await postFrom(bId, "boot-b", body, fromB);
			// One at a time, as a CLI emits them: the state machine is ingest-ordered.
			await sleep(150);
		}
		check(
			"SessionStart, UserPromptSubmit, Stop of B from B's container answer 204",
			bCodes === "204204204",
			bCodes,
		);
		check(
			"the harness sees each CONTAINER's address as the TCP peer (no NAT in between)",
			(await waitFor("boot events", async () => (await soleConversation(SB)).kind === "ready")) &&
				peerOf("boot-a").join() === (await addresses(aId)).join() &&
				peerOf("boot-b").join() === (await addresses(bId)).join(),
			{ a: [peerOf("boot-a"), await addresses(aId)], b: [peerOf("boot-b"), await addresses(bId)] },
		);
		console.log(
			`    peer of A's requests: ${peerOf("boot-a")} · docker inspect ${aId.slice(0, 12)} on ${NET}: ${await addresses(aId)}`,
		);
		console.log(
			`    peer of B's requests: ${peerOf("boot-b")} · docker inspect ${bId.slice(0, 12)} on ${NET}: ${await addresses(bId)}`,
		);
		check(
			"A has one interactive conversation with a pane; B's is waiting for input",
			(await soleConversation(SA)).kind !== "none" && (await soleConversation(SB)).kind === "ready",
			[await soleConversation(SA), await soleConversation(SB)],
		);

		phase("the person sends A a task with a consult grant (ProjectFanout.send)");
		const sent = await fanout.send(OWNER, PID, {
			clientMessageId: randomUUID(),
			text: "Averiguá la versión del servicio.",
			to: [A],
			collab: { mode: "ask", with: B, maxMessages: 4 },
		});
		const grantId = String((sent.body as { grantId?: string }).grantId ?? "");
		check(
			"a live grant exists and the task reached A's session",
			/^c-[0-9a-f]{12}$/.test(grantId) &&
				(await waitFor("task", () =>
					composed.some((c) => c.sid === SA && c.text.includes(grantId)),
				)),
			sent,
		);
		await waitFor("grant indexed", () => collab.grantOfSession(SA) !== null);

		const fileOf = (body: string) =>
			`---\nst: 1\ncollab: ${grantId}\nto: ${B}\nkind: ask\n---\n${body}\n`;
		const put = async (name: string, body: string) => {
			const content = fileOf(body);
			await fs.writeFile(path.join(ROOT, SA, ".st-outbox", name), content);
			return content;
		};
		type Row = { id: string; what: string; origins: string; admitted: boolean; pass: boolean };
		const table: Row[] = [];
		/** One outbox write: the file on the host side, then the two hook events. */
		async function write(
			tag: string,
			cid: string,
			send: (body: unknown) => Promise<string>,
		): Promise<{
			name: string;
			body: string;
			toolUseId: string;
			codes: string;
			notMatchedFrom: number;
		}> {
			const notMatchedFrom = outbox.stats.originNotMatched;
			const name = `${tag}-${RUN}.md`;
			const body = `Consulta del caso ${tag} (${RUN}).`;
			const toolUseId = `toolu_${tag}${randomBytes(9).toString("hex")}`;
			const [pre, post] = writeHooks(cid, name, await put(name, body), toolUseId);
			const codes = `${await send(pre)}${await send(post)}`;
			await waitFor(`both events of ${tag}`, () => bothSeen(toolUseId));
			await quiet();
			return { name, body, toolUseId, codes, notMatchedFrom };
		}
		/** The checks every refused case shares: captured, not a message, nothing sent. */
		async function refused(
			id: string,
			what: string,
			w: Awaited<ReturnType<typeof write>>,
			expected: RegExp,
			sidForCapture = SA,
		): Promise<void> {
			const got = origins(w.toolUseId);
			const evs = seen.get(w.toolUseId) ?? [];
			const ok = [
				check(
					`(${id}) both requests answered 204 — the hook never sees a refusal`,
					w.codes === "204204",
					w.codes,
				),
				check(
					`(${id}) the two events' verdicts are ${expected} — got ${got}`,
					expected.test(got),
					got,
				),
				check(
					`(${id}) the capture DID persist both events (observe keeps them): seq ${evs.map((e) => e.seq).join(", ")}`,
					evs.length === 2 && evs.every((e) => e.sid === sidForCapture && e.seq > 0),
					evs,
				),
				check(
					`(${id}) no outbox line at all for ${w.name}`,
					(await outboxLine(w.name)) === undefined,
				),
				check(`(${id}) nothing was delivered to B`, relaysTo(SB, w.body).length === 0),
				// outbox.ts drops a Write whose START is not `match` right there
				// (counted, nothing kept): exactly one more refusal, by origin.
				check(
					`(${id}) the watcher refused it on origin: originNotMatched ${w.notMatchedFrom} → ${outbox.stats.originNotMatched}`,
					outbox.stats.originNotMatched === w.notMatchedFrom + 1,
				),
			].every(Boolean);
			table.push({ id, what, origins: got, admitted: false, pass: ok });
		}
		async function admitted(id: string, what: string, w: Awaited<ReturnType<typeof write>>) {
			const got = origins(w.toolUseId);
			const delivered = await waitFor(`relay of ${id}`, () => relaysTo(SB, w.body).length === 1);
			const line = await outboxLine(w.name);
			const ok = [
				check(
					`(${id}) the two events' verdicts are match/match — got ${got}`,
					got === "match/match",
					got,
				),
				check(
					`(${id}) outbox{accepted} with origin "match": ${JSON.stringify(line)}`,
					line?.event === "accepted" && line.origin === "match" && line.tool_use_id === w.toolUseId,
				),
				check(
					`(${id}) the Composer received the body for B's session, once`,
					delivered,
					composed.map((c) => c.sid),
				),
			].every(Boolean);
			table.push({ id, what, origins: got, admitted: true, pass: ok });
		}

		phase("(a) the Write's two events from the session's own container");
		const a = await write("a", cidA, (b) => postFrom(aId, "a", b));
		console.log(
			`    peer ${peerOf("a")} · inspected addresses of A's container: ${await addresses(aId)}`,
		);
		check(
			"(a) peer = an inspected address of A's current container",
			peerOf("a").join() === (await addresses(aId)).join(),
		);
		await admitted("a", "from the session's container", a);

		phase("(b) the same two events from ANOTHER session's container, with A's token");
		const b = await write("b", cidA, (body) => postFrom(bId, "b", body));
		console.log(
			`    peer ${peerOf("b")} (B's container) · inspected addresses of A's container: ${await addresses(aId)}`,
		);
		check(
			"(b) the peer is B's address, on the same network, and not one of A's",
			peerOf("b").join() === (await addresses(bId)).join() &&
				!(await addresses(aId)).includes(peerOf("b")[0] ?? ""),
		);
		check(
			"(b) and the events are in A's capture file on disk",
			(await captureStore.readEvents(SA, cidA, 0, 10_000)).filter(
				(e) => e.data?.tool_use_id === b.toolUseId,
			).length === 2,
		);
		await refused("b", "from another session's container, A's token", b, /^mismatch\/mismatch$/);

		phase("(c) from the backend host itself");
		const c = await write("c", cidA, (body) => postFromHost("127.0.0.1", "c", body));
		console.log(`    peer ${peerOf("c")}`);
		await refused("c", "from the backend's loopback", c, /^loopback\/loopback$/);
		// Not in the contract's list, same rule: the host reaching its own
		// listener through the bridge is the gateway's address, not A's.
		const c2 = await write("c2", cidA, (body) => postFromHost(gateway, "c2", body));
		console.log(`    peer ${peerOf("c2")} (the bridge gateway)`);
		await refused("c2", "from the host through the bridge", c2, /^mismatch\/mismatch$/);

		phase(`(d) Docker's inspect answers after more than ${ORIGIN_INSPECT_TIMEOUT_MS} ms`);
		// A's addresses are cached from (a); production drops that cache with
		// the token cache (activation, teardown, revocation). Without this the
		// case would not reach Docker at all.
		service.invalidateToken(SA);
		inspectDelayMs = ORIGIN_INSPECT_TIMEOUT_MS + 1000;
		const before = inspections;
		const d = await write("d", cidA, (body) => postFrom(aId, "d", body));
		inspectDelayMs = 0;
		check(
			"(d) the request did go to Docker, from A's own container",
			inspections > before && peerOf("d").join() === (await addresses(aId)).join(),
			peerOf("d"),
		);
		// The second event finds the first one's call still unsettled
		// (`inspect_pending`) or opens its own late one: neither is `match`.
		await refused(
			"d",
			`inspect slower than ${ORIGIN_INSPECT_TIMEOUT_MS} ms`,
			d,
			/^inspect_timeout\/inspect_(timeout|pending)$/,
		);
		await sleep(ORIGIN_INSPECT_TIMEOUT_MS + 1200); // let the late calls settle

		phase("(e) A's container is replaced; another container takes its old address");
		const oldId = aId;
		const oldAddr = (await addresses(oldId)).join();
		await docker.getContainer(oldId).remove({ force: true });
		// What production runs on that transition: stop/kill → onSessionDown
		// (DockerManager's ConversationLifecycleHooks) …
		await service.onSessionDown(SA);
		aId = await startContainer("a2", 12, path.join(ROOT, SA));
		// … the new container id lands in D1, and activation invalidates.
		rows.set(SA, session(TOKEN_A, aId));
		service.invalidateToken(SA);
		const impostor = await startContainer("x", 10, path.join(ROOT, SB));
		const impostorAddr = (await addresses(impostor)).join();
		check(
			`(e) the impostor holds the replaced container's address ${oldAddr}; A's new container is at ${await addresses(aId)}`,
			impostorAddr === oldAddr && !(await addresses(aId)).includes(oldAddr),
			{ oldAddr, impostorAddr },
		);
		// The new container's CLI starts a conversation of its own.
		cidA = randomUUID();
		check(
			"(e) SessionStart from A's new container answers 204",
			(await postFrom(aId, "boot-a2", sessionStart(cidA))) === "204",
		);
		await waitFor("A's new conversation", async () => {
			const s = await soleConversation(SA);
			return s.kind !== "none" && s.kind !== "ambiguous" && s.cid === cidA;
		});
		const e1 = await write("e-old", cidA, (body) => postFrom(impostor, "e-old", body));
		console.log(
			`    peer ${peerOf("e-old")} (old address) · inspected addresses of A's CURRENT container: ${await addresses(aId)}`,
		);
		check("(e) the request came from the old address", peerOf("e-old").join() === oldAddr);
		await refused("e", "after a replacement, from the old address", e1, /^mismatch\/mismatch$/);
		const e2 = await write("e-new", cidA, (body) => postFrom(aId, "e-new", body));
		console.log(
			`    peer ${peerOf("e-new")} · inspected addresses of A's CURRENT container: ${await addresses(aId)}`,
		);
		await admitted("e'", "after a replacement, from the new container", e2);

		phase("(f) origin flag off: no verifier ⇒ no verdict ⇒ nothing to admit on");
		// index.ts keeps PROJECT_RELAY_ENABLED off unless the origin mode is
		// observe|true (relayFlag.test.ts pins that expression). This is the
		// reason: from A's own container, with A's token, the same write.
		const cidF = randomUUID();
		const f = await write("f", cidF, (body) => postFrom(aId, "f", body, { port: portOff }));
		const fEvents = seen.get(f.toolUseId) ?? [];
		const fGot = origins(f.toolUseId);
		const fOk = [
			check(
				"(f) both requests answered 204 from A's own container",
				f.codes === "204204" && peerOf("f").join() === (await addresses(aId)).join(),
				[f.codes, peerOf("f")],
			),
			check(
				`(f) the events reached the observers with NO verdict — got ${fGot}`,
				fEvents.length === 2 && fGot === "none/none",
				fEvents,
			),
			check(
				`(f) no outbox line for ${f.name}, nothing delivered`,
				(await outboxLine(f.name)) === undefined && relaysTo(SB, f.body).length === 0,
			),
			check(
				`(f) the watcher refused it on origin: originNotMatched ${f.notMatchedFrom} → ${outbox.stats.originNotMatched}`,
				outbox.stats.originNotMatched === f.notMatchedFrom + 1,
			),
		].every(Boolean);
		table.push({
			id: "f",
			what: "origin check off (no verifier)",
			origins: fGot,
			admitted: false,
			pass: fOk,
		});

		phase("the project log as a whole");
		const all = await lines();
		const accepted = all.filter((l) => l.ev === "outbox" && l.event === "accepted");
		check(
			"exactly the two admitted writes are in the log, both origin match",
			accepted.length === 2 && accepted.every((l) => l.origin === "match"),
			accepted,
		);
		check(
			"every relay message has its admitted outbox line",
			all
				.filter((l) => l.ev === "message" && l.kind === "relay")
				.every((m) => accepted.some((o) => o.msg_id === m.msg_id)),
		);
		check(
			"the Composer was called for B exactly twice",
			composed.filter((x) => x.sid === SB).length === 2,
			composed.map((x) => x.sid),
		);
		check(
			`the watcher counted the refused writes: ${outbox.stats.originNotMatched}`,
			outbox.stats.originNotMatched === 6,
			outbox.stats,
		);
		const report = checkLog(all);
		check("checkLog finds no violation", report.violations.length === 0, report.violations);

		console.log(
			"\n  §7.3.1  case                                             verdicts (start/end)               admitted  result",
		);
		for (const r of table) {
			console.log(
				`  (${r.id})`.padEnd(10) +
					r.what.padEnd(49) +
					r.origins.padEnd(35) +
					String(r.admitted).padEnd(10) +
					(r.pass ? "PASS" : "FAIL"),
			);
		}
	} finally {
		outbox.stop();
		collab.stop();
		server.close();
		serverOff.close();
		server.closeAllConnections();
		serverOff.closeAllConnections();
		await service.shutdown().catch(() => {});
		await serviceOff.shutdown().catch(() => {});
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
			failures === 0 ? "\nD3 origin smoke: all ok" : `\nD3 origin smoke: ${failures} failure(s)`,
		);
		process.exit(failures === 0 ? 0 : 1);
	});
