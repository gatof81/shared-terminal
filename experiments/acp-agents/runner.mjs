#!/usr/bin/env node
// Agent runner (ACP PoC): takes ONE message at a time from the durable inbox, runs
// it as an ACP turn through acpx, and records the turn's result. Agent-agnostic:
// everything agent-specific is ACP_AGENT_CMD (a stable wrapper path, so the acpx
// session scope — which includes the command string — survives adapter upgrades).
//
// acpx owns the session, its context, resume and the event log. This file only
// decides what to send next and what the outcome of a turn was. It never uses
// `--no-wait`: acpx's queue lives in its owner's memory and is lost on a crash.
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";

const env = process.env;
const AGENT = env.ST_AGENT;
const ST_URL = env.ST_URL ?? "http://st:8080";
const ACPX = env.ACPX ?? "/opt/st-acp/current/node_modules/.bin/acpx";
const SESSION = env.ACP_SESSION ?? "main";
const LOG_DIR = env.RUNNER_LOG_DIR ?? `${env.HOME}/runner-log`;
const IDLE_MS = 5_000;
mkdirSync(LOG_DIR, { recursive: true });

// Protocol only — no role or project instructions.
const PROTOCOL = [
	`Sos el agente @${AGENT} de Shared Terminal.`,
	"Los mensajes llegan como turnos con el encabezado [st-msg #N de @remitente].",
	"Tu respuesta final de cada turno se registra y, si el remitente es otro agente, se le entrega automáticamente: no la reenvíes.",
	`Para pedirle algo a otro agente ejecutá con Bash: st send @agente "texto" (agentes: ${env.ST_AGENTS ?? "?"}).`,
	"La respuesta a ese pedido te llegará más adelante como un mensaje nuevo: no la esperes con sleep ni consultes la bandeja; terminá tu turno.",
].join(" ");

const common = [
	"--agent", env.ACP_AGENT_CMD,
	"--cwd", env.AGENT_CWD,
	"--approve-all",
	"--model", env.AGENT_MODEL,
	"--append-system-prompt", PROTOCOL,
	"--format", "json",
];

const log = (...a) => console.log(new Date().toISOString(), `[${AGENT}]`, ...a);
const marker = (id) => `[st-msg #${id} de @`;

// The inbox may be restarting: a network error is retried (a lost result POST
// would otherwise leave the message `running` until the next recovery).
async function api(method, path, body) {
	let res;
	for (;;) {
		try {
			res = await fetch(ST_URL + path, {
				method,
				headers: { authorization: `Bearer ${env.ST_TOKEN}`, "content-type": "application/json" },
				body: body && JSON.stringify(body),
			});
			break;
		} catch (err) {
			log(`inbox unreachable (${err.cause?.code ?? err.message}); retrying`);
			await new Promise((ok) => setTimeout(ok, 2_000));
		}
	}
	const text = await res.text();
	return { status: res.status, body: text ? JSON.parse(text) : null };
}

function acpx(args, { stdin, onLine, logFile } = {}) {
	return new Promise((resolve) => {
		const child = spawn(ACPX, [...common, ...args], { stdio: ["pipe", "pipe", "pipe"] });
		const out = logFile ? createWriteStream(logFile, { flags: "a" }) : null;
		let stderr = "";
		child.stderr.on("data", (d) => (stderr += d));
		createInterface({ input: child.stdout }).on("line", (line) => {
			out?.write(`${line}\n`);
			let obj;
			try {
				obj = JSON.parse(line);
			} catch {
				return;
			}
			onLine?.(obj, child);
		});
		child.on("close", (code) => {
			out?.end();
			resolve({ code, stderr });
		});
		child.stdin.end(stdin ?? "");
	});
}

// Final answer = the text after the turn's last tool call.
function textCollector() {
	let segments = [""];
	return {
		feed(update) {
			if (update?.sessionUpdate === "tool_call") segments.push("");
			if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text")
				segments[segments.length - 1] += update.content.text;
		},
		final: () => segments.filter((s) => s.trim()).at(-1)?.trim() ?? "",
	};
}

async function deliver(msg) {
	const prompt = `${marker(msg.id)}${msg.from_id}]\n${msg.body}`;
	const text = textCollector();
	let stopReason = null;
	let error = null;
	log(`turn start #${msg.id} from @${msg.from_id}`);
	const { code, stderr } = await acpx(["prompt", "-s", SESSION, "-f", "-"], {
		stdin: prompt,
		logFile: `${LOG_DIR}/m-${msg.id}.ndjson`,
		onLine(o) {
			if (o.method === "session/update") text.feed(o.params?.update);
			if (o.result?.stopReason) stopReason = o.result.stopReason;
			if (o.error) error = o.error;
		},
	});
	const why = `acpx exit ${code}: ${error ? `${error.data?.detailCode ?? ""} ${error.message}` : stderr.slice(-300)}`;
	// The only failure that proves the prompt never left: the queue owner died
	// before binding its socket, so no client could have handed it the prompt.
	// (Not seeing our session/prompt echo proves nothing — acpx echoes it before
	// writing it, and the echo travels over IPC.) Give the message back and stop:
	// a runner that cannot start its agent must not burn the rest of the inbox.
	if (!stopReason && /before binding its socket/.test(`${error?.message ?? ""} ${stderr}`)) {
		await api("POST", `/v1/messages/${msg.id}/release`, { note: why });
		throw new Error(`agent did not start; #${msg.id} released: ${why}`);
	}
	const settled = stopReason
		? { state: "done", text: text.final(), stopReason }
		: {
				// No settled result: the turn may have run tools. Never retried.
				state: "uncertain",
				text: text.final() || null,
				note: why,
			};
	const r = await api("POST", `/v1/messages/${msg.id}/result`, settled);
	log(`turn end #${msg.id}: ${settled.state}${r.body?.reply ? ` -> reply #${r.body.reply.id} to @${r.body.reply.to_id}` : ""}`);
}

// After a restart: settle the message that was `running` from acpx's own durable
// event log (sessions watch replays it). A completed turn is recorded as done; a
// turn with no settled result, or no trace at all, becomes `uncertain`.
async function recover(msg) {
	log(`recovering #${msg.id} from acpx evidence`);
	const want = marker(msg.id);
	let cur = null;
	let target = null;
	let result = null;
	let timer = null;
	const text = textCollector();
	await acpx(["sessions", "watch", "-s", SESSION], {
		logFile: `${LOG_DIR}/m-${msg.id}.recover.ndjson`,
		onLine(o, child) {
			clearTimeout(timer);
			timer = setTimeout(() => child.kill(), IDLE_MS);
			if (o.type === "turn_started") cur = o.requestId;
			const m = o.type === "message" ? o.message : null;
			if (m?.method === "session/prompt" && m.params?.prompt?.some((b) => b.text?.startsWith(want))) target = cur;
			if (target && target === cur && m?.method === "session/update") text.feed(m.params?.update);
			if (target && o.type === "turn_result" && o.requestId === target) {
				result = o.result;
				child.kill();
			}
		},
	});
	clearTimeout(timer);
	// A replay with no new line for IDLE_MS ends the watch; if the owner is still
	// running that turn we would wait for it — the PoC kills everything together.
	const settled =
		result?.status === "completed"
			? { state: "done", text: text.final(), stopReason: result.stopReason, requestId: target, note: "settled from acpx evidence after runner restart" }
			: {
					state: "uncertain",
					text: text.final() || null,
					requestId: target,
					note: target
						? `turn ${target} started; acpx: ${result?.error?.message ?? "no settled result"}`
						: "no trace of this message in the acpx session log",
				};
	await api("POST", `/v1/messages/${msg.id}/result`, settled);
	log(`recovered #${msg.id}: ${settled.state} (${settled.note})`);
}

async function main() {
	log(`starting; acpx session '${SESSION}' cwd ${env.AGENT_CWD} model ${env.AGENT_MODEL}`);
	mkdirSync(env.AGENT_CWD, { recursive: true });
	// acpx keeps its queue-owner lease in ~/.acpx/queues, which lives on the
	// persistent volume. The runner is the container's main process, so at this
	// point every process of the previous container run is gone — but acpx cannot
	// prove it: in the new PID namespace the old pid may belong to another process,
	// and it refuses to take over (QUEUE_OWNER_IDENTITY_UNVERIFIED). The lease is
	// runtime state only; the session record and event log stay untouched.
	rmSync(`${env.HOME}/.acpx/queues`, { recursive: true, force: true });
	const ensured = await acpx(["sessions", "ensure", "--name", SESSION]);
	if (ensured.code !== 0) throw new Error(`sessions ensure failed: ${ensured.stderr}`);
	const running = await api("GET", `/v1/agents/${AGENT}/running`);
	if (running.status === 200) await recover(running.body);
	for (;;) {
		const r = await api("POST", `/v1/agents/${AGENT}/claim`);
		if (r.status === 200) await deliver(r.body);
		else await new Promise((ok) => setTimeout(ok, 2_000));
	}
}

main().catch((err) => {
	log("fatal", err);
	process.exit(1);
});
