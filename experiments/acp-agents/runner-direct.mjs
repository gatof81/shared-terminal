#!/usr/bin/env node
// Agent runner over a DIRECT ACP client (plain JSON-RPC over stdio, ACP v1),
// replacing acpx. Same inbox protocol as runner.mjs. The adapter
// (claude-agent-acp) still does everything agent-side: Claude, tools, session
// files, resume.
//
// Why direct: acpx does not declare the adapter's AIR `asyncTasks` capability,
// so background work and the turn Claude starts by itself after it are
// invisible to it. Declared here, the adapter reports both as async tasks, and a
// message is done only when the agent is idle: prompt answered AND no open task.
//
// Own state: the session id (one small file) and one append-only event log per
// message, which is what recovery reads after a crash.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const env = process.env;
const AGENT = env.ST_AGENT;
const ST_URL = env.ST_URL ?? "http://st:8080";
const CWD = env.AGENT_CWD;
const STATE = `${env.HOME}/.st-agent`;
const SESSION_FILE = `${STATE}/session.json`;
const LOG_DIR = `${STATE}/log`;
const IDLE_SETTLE_MS = 2_000; // the idle state must hold this long (shutdown also closes tasks)
const BG_MAX_MS = Number(env.BG_MAX_MS ?? 30 * 60_000); // background work still open after this ⇒ settled with a note
mkdirSync(LOG_DIR, { recursive: true });

const log = (...a) => console.log(new Date().toISOString(), `[${AGENT}]`, ...a);
const marker = (id) => `[st-msg #${id} de @`;
const TERMINAL = new Set(["completed", "failed", "stopped"]);

async function api(method, path, body) {
	for (;;) {
		try {
			const res = await fetch(ST_URL + path, {
				method,
				headers: { authorization: `Bearer ${env.ST_TOKEN}`, "content-type": "application/json" },
				body: body && JSON.stringify(body),
			});
			const text = await res.text();
			return { status: res.status, body: text ? JSON.parse(text) : null };
		} catch (err) {
			log(`inbox unreachable (${err.cause?.code ?? err.message}); retrying`);
			await new Promise((ok) => setTimeout(ok, 2_000));
		}
	}
}

// ── Activity of the current message ───────────────────────────────────────
// One message at a time, so everything the session does while it is current —
// its turn, the tasks the turn started, the turn Claude starts after them —
// belongs to it.
let current = null; // { msg, file, promptOpen, stopReason, tasks: Map, segments, timer, bgTimer, settle }

function record(entry) {
	if (current) appendFileSync(current.file, `${JSON.stringify({ t: Date.now(), ...entry })}\n`);
}

// Open async tasks of the session whatever message they belong to. Claude can be
// busy with no message at all: after a resume it takes the "didn't finish before
// the previous session ended" notification of a killed task in a turn of its own,
// and a prompt sent then is swallowed by that turn. No claim while this is not empty.
const live = new Map();
let lastActivity = Date.now();
// Exception, seen on adapter 0.108.0 / Claude 2.1.326: the autonomous turn opened
// by that resume notification never runs and never ends (no model output, task
// left `running` for minutes); only a prompt taking the turn in closes it. So an
// open `turn` task stops blocking after QUIET_TURN_MS without any session update.
// Cost: a real autonomous turn quiet that long (one long foreground tool) gets
// the next prompt merged into it — the adapter queues it, nothing is lost.
const QUIET_TURN_MS = 15_000;
const agentIdle = () => {
	const quiet = Date.now() - lastActivity;
	const blocking = [...live.values()].filter((type) => type !== "turn" || quiet < QUIET_TURN_MS);
	return blocking.length === 0 && quiet > IDLE_SETTLE_MS;
};

function onUpdate(update) {
	record({ update });
	lastActivity = Date.now();
	if (update.sessionUpdate === "async_task_spawned") live.set(update.asyncTaskId, update.taskType);
	if (update.sessionUpdate === "async_task_state_update" && TERMINAL.has(update.state)) live.delete(update.asyncTaskId);
	if (!current) {
		if (update.sessionUpdate?.startsWith("async_task")) log("activity with no current message:", update.sessionUpdate);
		return;
	}
	const u = update;
	if (u.sessionUpdate === "tool_call") current.segments.push("");
	if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text")
		current.segments[current.segments.length - 1] += u.content.text;
	if (u.sessionUpdate === "async_task_spawned") {
		current.tasks.set(u.asyncTaskId, { name: u.name, taskType: u.taskType, toolCallId: u.toolCallId, state: "running" });
		if (u.taskType === "turn") current.segments.push(""); // Claude's own turn: its text is the newest answer
		log(`task spawned ${u.asyncTaskId} (${u.taskType}) toolCall=${u.toolCallId ?? "-"}`);
	}
	if (u.sessionUpdate === "async_task_state_update") {
		const task = current.tasks.get(u.asyncTaskId);
		if (task) task.state = u.state;
		log(`task ${u.asyncTaskId} -> ${u.state}`);
	}
	checkIdle();
}

const openTasks = () => [...current.tasks].filter(([, t]) => !TERMINAL.has(t.state));
const finalText = () => current.segments.filter((s) => s.trim()).at(-1)?.trim() ?? "";

function checkIdle() {
	clearTimeout(current.timer);
	if (current.promptOpen || openTasks().length) return;
	current.timer = setTimeout(() => current.settle({ state: "done" }), IDLE_SETTLE_MS);
}

// ── ACP connection: newline-delimited JSON-RPC 2.0 over the adapter's stdio ──
// Not the official SDK on purpose: @agentclientprotocol/sdk 2.7.0 validates
// every session/update against its v1 schema and rejects the AIR variants
// (async_task_*) with -32602 before any handler runs — typed, custom-parser and
// "*" registrations alike. Those are exactly the events this client exists for.
const adapter = spawn(env.ACP_AGENT_CMD, [], { stdio: ["pipe", "pipe", "inherit"] });
let nextId = 0;
const pending = new Map();
const write = (m) => adapter.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
const agent = {
	request: (method, params) =>
		new Promise((resolve, reject) => {
			pending.set(++nextId, { resolve, reject });
			write({ id: nextId, method, params });
		}),
};
createInterface({ input: adapter.stdout }).on("line", (line) => {
	const m = JSON.parse(line);
	if (m.method === undefined) {
		// a response to one of our requests
		const p = pending.get(m.id);
		pending.delete(m.id);
		return m.error ? p?.reject(Object.assign(new Error(m.error.message), { data: m.error })) : p?.resolve(m.result);
	}
	if (m.method === "session/update") return onUpdate(m.params.update);
	if (m.method === "session/request_permission") {
		// bypassPermissions is set in settings; this only answers what still asks.
		const opt = m.params.options.find((o) => o.kind.startsWith("allow")) ?? m.params.options[0];
		record({ permission: m.params.toolCall?.title, chose: opt.kind });
		return write({ id: m.id, result: { outcome: { outcome: "selected", optionId: opt.optionId } } });
	}
	if (m.id !== undefined) write({ id: m.id, error: { code: -32601, message: `unsupported: ${m.method}` } });
});
adapter.on("exit", (code, signal) => {
	// The adapter is gone: whatever the current message was doing is unknown.
	log(`adapter exited (${code ?? signal})`);
	for (const p of pending.values()) p.reject(new Error("adapter exited"));
	if (current) current.settle({ state: "uncertain", note: `adapter exited (${code ?? signal})` }, true);
	else process.exit(1);
});

async function openSession() {
	const init = await agent.request("initialize", {
		protocolVersion: 1,
		clientCapabilities: { _meta: { jetbrains: { air: { version: 1, capabilities: ["asyncTasks"] } } } },
	});
	const airCaps = init._meta?.jetbrains?.air?.capabilities ?? [];
	log(`initialized; agent AIR capabilities: ${airCaps.join(",") || "none"}`);
	if (!airCaps.includes("asyncTasks")) throw new Error("agent does not offer asyncTasks");
	if (existsSync(SESSION_FILE)) {
		const { sessionId } = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
		await agent.request("session/resume", { sessionId, cwd: CWD, mcpServers: [] });
		log(`resumed session ${sessionId}`);
		return sessionId;
	}
	const { sessionId } = await agent.request("session/new", { cwd: CWD, mcpServers: [] });
	writeFileSync(SESSION_FILE, JSON.stringify({ sessionId, cwd: CWD }));
	log(`new session ${sessionId}`);
	return sessionId;
}

function run(sessionId, msg) {
	return new Promise((resolve) => {
		current = {
			msg,
			file: `${LOG_DIR}/m-${msg.id}.ndjson`,
			promptOpen: true,
			stopReason: null,
			tasks: new Map(),
			segments: [""],
			async settle(s, exitAfter = false) {
				if (current?.msg !== msg) return;
				clearTimeout(current.timer);
				clearTimeout(current.bgTimer);
				const open = openTasks();
				const body = {
					state: s.state,
					text: finalText() || null,
					stopReason: current.stopReason,
					note: [s.note, current.tasks.size && `tasks: ${[...current.tasks].map(([id, t]) => `${id}(${t.taskType}):${t.state}`).join(" ")}`, open.length && `open: ${open.length}`]
						.filter(Boolean)
						.join("; ") || null,
				};
				record({ settled: body });
				current = null;
				await api("POST", `/v1/messages/${msg.id}/result`, body);
				log(`message #${msg.id}: ${body.state}${body.note ? ` (${body.note})` : ""}`);
				if (exitAfter) process.exit(1);
				resolve();
			},
		};
		record({ prompt: msg.id });
		log(`turn start #${msg.id} from @${msg.from_id}`);
		agent
			.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: `${marker(msg.id)}${msg.from_id}]\n${msg.body}` }],
			})
			.then((r) => {
				if (current?.msg !== msg) return;
				current.stopReason = r.stopReason;
				current.promptOpen = false;
				record({ promptResult: r.stopReason });
				log(`prompt answered #${msg.id}: ${r.stopReason}; open tasks: ${openTasks().length}`);
				current.bgTimer = setTimeout(() => current?.settle({ state: "done", note: `background still open after ${BG_MAX_MS} ms` }), BG_MAX_MS);
				checkIdle();
			})
			.catch((err) => current?.settle({ state: "uncertain", note: `prompt error: ${err.message}` }));
	});
}

// ── Recovery: the per-message log decides, never a resend ─────────────────
async function recover(msg) {
	const file = `${LOG_DIR}/m-${msg.id}.ndjson`;
	const lines = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
	const settled = lines.find((l) => l.settled)?.settled;
	const answered = lines.some((l) => l.promptResult);
	const tasks = new Map();
	for (const { update: u } of lines) {
		if (u?.sessionUpdate === "async_task_spawned") tasks.set(u.asyncTaskId, u.taskType);
		if (u?.sessionUpdate === "async_task_state_update" && TERMINAL.has(u.state)) tasks.delete(u.asyncTaskId);
	}
	// A settle that was written but not posted is re-posted as it was; anything
	// else that did not reach idle is uncertain.
	const body = settled ?? {
		state: "uncertain",
		note: `runner restarted: ${lines.length ? (answered ? "prompt answered" : "prompt sent, no answer") : "no log"}${tasks.size ? `; open tasks at crash: ${[...tasks].map(([id, t]) => `${id}(${t})`).join(" ")}` : ""}`,
	};
	await api("POST", `/v1/messages/${msg.id}/result`, body);
	log(`recovered #${msg.id}: ${body.state} (${body.note ?? ""})`);
}

async function main() {
	log(`starting; adapter ${env.ACP_AGENT_CMD}, cwd ${CWD}, model ${env.ANTHROPIC_MODEL ?? "default"}`);
	mkdirSync(CWD, { recursive: true });
	const sessionId = await openSession();
	const running = await api("GET", `/v1/agents/${AGENT}/running`);
	if (running.status === 200) await recover(running.body);
	for (;;) {
		if (!agentIdle()) {
			await new Promise((ok) => setTimeout(ok, 500));
			continue;
		}
		const r = await api("POST", `/v1/agents/${AGENT}/claim`);
		if (r.status === 200) await run(sessionId, r.body);
		else await new Promise((ok) => setTimeout(ok, 2_000));
	}
}

main().catch((err) => {
	log("fatal", err);
	process.exit(1);
});
