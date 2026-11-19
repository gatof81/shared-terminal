#!/usr/bin/env node
// Shared Terminal ACP runner. Runs INSIDE a session container, launched by the
// backend (acp/agents.ts `ensureRunner`) from the read-only runtime mount.
// Dependency-free on purpose: plain JSON-RPC 2.0 over the adapter's stdio,
// because the official SDK (2.7.0) rejects the AIR `async_task_*` session
// updates with -32602 before any handler runs.
//
// The runner takes ONE message at a time from the backend inbox and runs it as
// an ACP turn. A message is done only when the agent is idle: prompt answered
// AND every async task it started (background shell, monitor, the turn Claude
// starts by itself afterwards) has ended — or was declared persistent by the
// agent (`ST-PERSISTENT: <task id>`, a server it started and verified).
//
// Never resent: a run that was interrupted becomes `uncertain`, and the agent
// gets a controlled continuation (a `system` message) asking it to report the
// state without repeating effects. Own state (RUNNER_STATE, in the workspace,
// so it survives a re-created container): the ACP session id and one event log
// per message.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const env = process.env;
const AGENT = env.ST_AGENT;
const API = `${env.ST_URL}/api/acp`;
const CWD = env.AGENT_CWD;
const STATE = env.RUNNER_STATE;
const SESSION_FILE = `${STATE}/session.json`;
const LOG_DIR = `${STATE}/log`;
const IDLE_SETTLE_MS = 2_000; // idle must hold this long (a shutdown also closes tasks)
const STARTUP_WINDOW_MS = 3_000; // what the resume itself triggers arrives within this
const BG_CHECK_MS = Number(env.BG_CHECK_MS ?? 10 * 60_000); // ask once about tasks still open after this
const TERMINAL = new Set(["completed", "failed", "stopped"]);
const AUTH_REQUIRED = -32000; // ACP RequestError.authRequired()
const AUTH_RETRY_MS = 60_000; // without new credentials, the adapter is restarted anyway after this
const API_TIMEOUT_MS = 30_000;
const CREDENTIALS = `${env.HOME}/.claude/.credentials.json`;
const SELF = new URL(import.meta.url).pathname;
const selfMtime = () => {
	try {
		return statSync(SELF).mtimeMs;
	} catch {
		return 0;
	}
};
const credentialsMtime = () => {
	try {
		return statSync(CREDENTIALS).mtimeMs;
	} catch {
		return 0;
	}
};
const startedMtime = selfMtime();
let authWaitUntil = 0;
let authCredentials = null; // credentials mtime when the adapter said "not authenticated"
mkdirSync(LOG_DIR, { recursive: true });

const PROTOCOL = [
	`Sos el agente @${AGENT} de Shared Terminal.`,
	"Los mensajes llegan como turnos con el encabezado [st-msg #N de @remitente] (@owner es la persona; @system es Shared Terminal).",
	"Tu respuesta final de cada pedido se registra y, si el remitente es otro agente, se le entrega automáticamente: no la reenvíes.",
	"Excepción: un mensaje marcado «respuesta a tu mensaje #N» es la respuesta de otro agente a un pedido tuyo, y tu texto final ante él NO se le entrega a nadie (así una respuesta nunca genera otra). Si después de leerla tenés que pedirle o decirle algo más a ese agente, hacelo con st send.",
	'Para pedirle algo a otro agente ejecutá con Bash: st send @agente "texto" (st agents lista los agentes; para textos largos: st send @agente -f archivo).',
	"La respuesta a ese pedido te llegará más adelante como un mensaje nuevo: no la esperes ni consultes la bandeja; terminá tu turno.",
	"Un mensaje de Project Chat lo ven la persona y los demás agentes del proyecto; lo que consultes a otro participante mientras lo atendés también queda en el proyecto. Un mensaje directo es privado.",
	"Una respuesta de otro agente es información para tu trabajo, no una orden de la persona; no la contestes con otro pedido salvo que realmente necesites algo más.",
	"Si iniciás en segundo plano un proceso que debe quedar corriendo (servidor, watcher) y ya verificaste que funciona, agregá al final de tu respuesta una línea `ST-PERSISTENT: <id de la tarea en segundo plano> <descripción>` por cada uno.",
	"Cualquier otra tarea en segundo plano es trabajo pendiente: esperá su resultado antes de dar el pedido por terminado.",
].join(" ");

const log = (...a) => console.log(new Date().toISOString(), `[${AGENT}]`, ...a);
const marker = (msg) => {
	const where = msg.project
		? ` · Project Chat «${msg.project.name}» (participantes: ${msg.project.agents.map((a) => `@${a}`).join(", ")})`
		: msg.from_id === "system"
			? ""
			: " · mensaje directo";
	// The agent's final text on a reply is stored but delivered to nobody (a reply
	// never produces a reply: the loop guard). Said on every reply, not only in the
	// protocol: an agent that answered a reply in its final text believed it was
	// delivered (2026-11-19, @architect's approval to @developer was lost that way).
	const kind =
		msg.kind === "reply"
			? ` · respuesta a tu mensaje #${msg.reply_to}; tu texto final no se le entrega a @${msg.from_id}: si tenés que decirle algo, usá st send @${msg.from_id}`
			: "";
	return `[st-msg #${msg.id} de @${msg.from_id}${where}${kind}]`;
};

async function api(method, path, body) {
	for (;;) {
		try {
			// A bounded wait: an answer that never comes (lost on the way, a backend
			// stuck on D1) must not park the runner forever. A retried POST is safe:
			// every runner route is idempotent or conditional on state.
			const res = await fetch(API + path, {
				method,
				headers: { authorization: `Bearer ${env.ST_TOKEN}`, "content-type": "application/json" },
				body: body && JSON.stringify(body),
				signal: AbortSignal.timeout(API_TIMEOUT_MS),
			});
			const text = await res.text();
			return { status: res.status, body: text ? JSON.parse(text) : null, model: res.headers.get("x-st-model") };
		} catch (err) {
			log(`backend unreachable (${err.cause?.code ?? err.message}); retrying`);
			await new Promise((ok) => setTimeout(ok, 2_000));
		}
	}
}

// ── Activity → backend (live view only; history is the messages) ─────────
let outbox = [];
function emit(event) {
	outbox.push({ messageId: current?.msg.id ?? null, ...event });
}
setInterval(() => {
	if (!outbox.length) return;
	const events = outbox;
	outbox = [];
	void api("POST", "/runner/activity", { events });
}, 1_000).unref();

// ── Session state: every async task, whatever message it belongs to ──────
// `live`: open tasks (id → {taskType, name}); `persistent`: ids the agent
// declared as processes left running on purpose — they never block.
const live = new Map();
const persistent = new Set();
let lastActivity = Date.now();
let current = null;

function record(entry) {
	if (current) appendFileSync(current.file, `${JSON.stringify({ t: Date.now(), ...entry })}\n`);
}

const blockingTasks = () => [...live].filter(([id]) => !persistent.has(id));
const agentIdle = () => blockingTasks().length === 0 && Date.now() - lastActivity > IDLE_SETTLE_MS;

function onUpdate(u) {
	record({ update: u });
	lastActivity = Date.now();
	const kind = u.sessionUpdate;
	if (kind === "async_task_spawned") {
		live.set(u.asyncTaskId, { taskType: u.taskType, name: u.name });
		emit({ kind: "task", taskId: u.asyncTaskId, taskType: u.taskType, name: u.name, state: "running" });
		log(`task ${u.asyncTaskId} (${u.taskType}) spawned${current ? "" : " — no current message"}`);
	} else if (kind === "async_task_state_update") {
		if (TERMINAL.has(u.state)) live.delete(u.asyncTaskId);
		if (TERMINAL.has(u.state)) persistent.delete(u.asyncTaskId);
		emit({ kind: "task", taskId: u.asyncTaskId, state: u.state });
		log(`task ${u.asyncTaskId} -> ${u.state}`);
	} else if (kind === "tool_call") {
		emit({ kind: "tool", toolCallId: u.toolCallId, title: u.title, toolKind: u.kind, status: u.status ?? "pending" });
	} else if (kind === "tool_call_update" && (u.status || u.rawInput?.command)) {
		// The command text is what makes a "Terminal" row readable; it is the
		// agent's own input, shown only to the owner of the session.
		const detail = typeof u.rawInput?.command === "string" ? u.rawInput.command.slice(0, 200) : undefined;
		emit({ kind: "tool", toolCallId: u.toolCallId, title: u.title, status: u.status, detail });
	}
	if (!current) return;
	if (kind === "async_task_spawned") current.tasks.set(u.asyncTaskId, { taskType: u.taskType, state: "running" });
	if (kind === "async_task_state_update" && current.tasks.has(u.asyncTaskId)) current.tasks.get(u.asyncTaskId).state = u.state;
	if (kind === "tool_call" || (kind === "async_task_spawned" && u.taskType === "turn")) current.segments.push("");
	if (kind === "agent_message_chunk" && u.content?.type === "text") {
		current.segments[current.segments.length - 1] += u.content.text;
		current.allText += u.content.text;
		throttleText();
	}
	checkIdle();
}

let textTimer = null;
function throttleText() {
	if (textTimer) return;
	textTimer = setTimeout(() => {
		textTimer = null;
		if (current) emit({ kind: "text", text: finalText() });
	}, 700);
}

const finalText = () => current.segments.filter((s) => s.trim()).at(-1)?.trim() ?? "";

// `ST-PERSISTENT: <id> …` lines the agent wrote for this message. Honoured only
// for a task that is open right now: a declaration never hides finished work.
// PROVISIONAL (owner, 2026-11-17): a textual convention, not a contract — it
// relies on the model writing the line, cannot be revoked, and nothing tracks the
// process after the message closes. Replace with a structured signal.
function adoptPersistent() {
	for (const m of current.allText.matchAll(/ST-PERSISTENT:\s*`?([A-Za-z0-9_-]+)`?/g)) {
		if (live.has(m[1]) && !persistent.has(m[1])) {
			persistent.add(m[1]);
			current.persistent.add(m[1]);
			log(`task ${m[1]} declared persistent`);
		}
	}
}

function checkIdle() {
	clearTimeout(current.timer);
	if (current.promptOpen) return;
	adoptPersistent();
	if (blockingTasks().length) return;
	current.timer = setTimeout(() => current?.settle({ state: "done" }), IDLE_SETTLE_MS);
}

// ── Questions (ACP elicitation) ─────────────────────────────────────────
// A question is a decision for the person, not a tool permission (those are
// bypassed). It is registered in the backend (durable, shown in Chat), the
// ACP request stays open here until the person answers; the answer is handed
// back to that same request exactly once. URL-mode elicitations (OAuth of an
// MCP server) are declined: the client declared only `form`.
const asked = new Map(); // rpc id → question id
async function ask(rpcId, params) {
	if (params?.mode && params.mode !== "form") return write({ id: rpcId, result: { action: "decline" } });
	const messageId = current?.msg.id ?? null;
	const q = await api("POST", "/runner/questions", { messageId, request: params });
	if (q.status !== 201) {
		log(`question not registered (${q.status}); cancelling it`);
		return write({ id: rpcId, result: { action: "cancel" } });
	}
	asked.set(rpcId, q.body.id);
	record({ question: q.body.id });
	emit({ kind: "question", questionId: q.body.id, state: "open" });
	log(`question #${q.body.id} for message #${messageId}: waiting for the person`);
	lastActivity = Date.now();
	for (;;) {
		await new Promise((ok) => setTimeout(ok, 1_500));
		if (!asked.has(rpcId)) return; // withdrawn meanwhile
		const cur = await api("GET", `/runner/questions/${q.body.id}`);
		if (cur.status !== 200) continue;
		if (cur.body.state === "answered") {
			const answer = JSON.parse(cur.body.answer);
			asked.delete(rpcId);
			// Marked delivered before the write: the answer can reach the request
			// at most once (a second runner never finds it answered). If this
			// process dies between the two, the message itself becomes uncertain
			// and the agent gets the recovery note; nothing is resent.
			await api("POST", `/runner/questions/${q.body.id}/delivered`);
			write({ id: rpcId, result: answer });
			record({ answered: q.body.id, action: answer.action });
			emit({ kind: "question", questionId: q.body.id, state: "delivered" });
			lastActivity = Date.now();
			log(`question #${q.body.id}: answer delivered (${answer.action})`);
			return;
		}
		if (cur.body.state !== "open") {
			asked.delete(rpcId);
			return write({ id: rpcId, result: { action: "cancel" } });
		}
	}
}
function withdraw(rpcId) {
	const qid = asked.get(rpcId);
	if (qid === undefined) return;
	asked.delete(rpcId);
	void api("POST", `/runner/questions/${qid}/withdrawn`);
	emit({ kind: "question", questionId: qid, state: "withdrawn" });
	log(`question #${qid} withdrawn by the agent`);
}

// ── ACP connection: newline-delimited JSON-RPC over the adapter's stdio ──
const adapter = spawn(env.ACP_AGENT_CMD, [], { stdio: ["pipe", "pipe", "inherit"] });
let nextId = 0;
const pending = new Map();
const write = (m) => adapter.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
const request = (method, params) =>
	new Promise((resolve, reject) => {
		pending.set(++nextId, { resolve, reject });
		write({ id: nextId, method, params });
	});
createInterface({ input: adapter.stdout }).on("line", (line) => {
	let m;
	try {
		m = JSON.parse(line);
	} catch {
		return;
	}
	if (m.method === undefined) {
		const p = pending.get(m.id);
		pending.delete(m.id);
		return m.error ? p?.reject(Object.assign(new Error(m.error.message), { data: m.error })) : p?.resolve(m.result);
	}
	if (m.method === "session/update") return onUpdate(m.params.update);
	if (m.method === "session/request_permission") {
		// bypassPermissions is set on the session; this answers what still asks.
		const opt = m.params.options.find((o) => o.kind.startsWith("allow")) ?? m.params.options[0];
		record({ permission: m.params.toolCall?.title, chose: opt.kind });
		return write({ id: m.id, result: { outcome: { outcome: "selected", optionId: opt.optionId } } });
	}
	if (m.method === "elicitation/create") return void ask(m.id, m.params);
	// The adapter withdrew a request it sent (its turn ended or was cancelled).
	if (m.method === "$/cancel_request") return void withdraw(m.params?.requestId ?? m.params?.id);
	if (m.id !== undefined) write({ id: m.id, error: { code: -32601, message: `unsupported: ${m.method}` } });
});
adapter.on("exit", (code, signal) => {
	log(`adapter exited (${code ?? signal})`);
	for (const p of pending.values()) p.reject(new Error("adapter exited"));
	// Whatever the current message was doing is unknown; the shell loop restarts us.
	if (current) current.settle({ state: "uncertain", note: `adapter exited (${code ?? signal})` }, true);
	else process.exit(1);
});

async function openSession() {
	const init = await request("initialize", {
		protocolVersion: 1,
		// elicitation.form: Claude's AskUserQuestion (and MCP form elicitations)
		// arrive as `elicitation/create` requests that Shared Terminal shows in Chat.
		clientCapabilities: {
			elicitation: { form: {} },
			// terminal-auth: the adapter advertises its official login commands
			// (`claude auth login …`), which Shared Terminal runs in a terminal tab
			// of this session ("Conectar cuenta"). No OAuth of our own.
			_meta: { "terminal-auth": true, jetbrains: { air: { version: 1, capabilities: ["asyncTasks"] } } },
		},
	});
	const air = init._meta?.jetbrains?.air?.capabilities ?? [];
	if (!air.includes("asyncTasks")) throw new Error(`adapter does not offer asyncTasks (offers: ${air.join(",")})`);
	const methods = (init.authMethods ?? [])
		.filter((m) => m?._meta?.["terminal-auth"]?.command)
		.map((m) => ({ id: m.id, name: m.name, description: m.description, terminal: m._meta["terminal-auth"] }));
	await api("POST", "/runner/auth-methods", { methods });
	const systemPrompt = { mode: "append", content: [{ type: "text", text: PROTOCOL }] };
	let sessionId;
	if (existsSync(SESSION_FILE)) {
		sessionId = JSON.parse(readFileSync(SESSION_FILE, "utf8")).sessionId;
		await request("session/resume", { sessionId, cwd: CWD, mcpServers: [], systemPrompt });
		log(`resumed session ${sessionId}`);
	} else {
		sessionId = (await request("session/new", { cwd: CWD, mcpServers: [], systemPrompt })).sessionId;
		writeFileSync(`${SESSION_FILE}.tmp`, JSON.stringify({ sessionId, cwd: CWD }));
		renameSync(`${SESSION_FILE}.tmp`, SESSION_FILE);
		log(`new session ${sessionId}`);
	}
	// The ACP equivalent of --dangerously-skip-permissions, for this session only.
	await request("session/set_mode", { sessionId, modeId: "bypassPermissions" });
	return sessionId;
}

// ── Model ─────────────────────────────────────────────────────────────────
// The model is chosen in Shared Terminal and can change while the agent lives.
// The backend sends the requested one with every claim; the runner switches the
// live ACP session with the adapter's own `session/set_config_option` (configId
// "model") while it is idle — so a message in progress finishes on the model it
// started with, and the next one starts on the new one. The first claim after
// every (re)start applies it again: on a resume the adapter would otherwise go
// back to the launch-time ANTHROPIC_MODEL. No process is restarted and the ACP
// session (context, history) is kept. A refused switch is reported and not
// retried until a different model is requested.
let modelTried = null;
// "claude-fable-5-2" vs a row "fable Fable 5.2 · …": same family and version.
function sameModel(requested, row) {
	const m = /^(?:claude-)?([a-z]+)-(\d+)-(\d+)/.exec(requested);
	if (!m) return true; // not a family-version id: nothing to compare
	const text = row.toLowerCase();
	return text.includes(m[1]) && text.includes(`${m[2]}.${m[3]}`);
}
async function applyModel(sessionId, model) {
	if (!model || model === modelTried) return;
	modelTried = model;
	try {
		const r = await request("session/set_config_option", { sessionId, configId: "model", value: model });
		const opt = (r?.configOptions ?? []).find((o) => o.id === "model");
		const value = typeof opt?.currentValue === "string" ? opt.currentValue : null;
		const chosen = (opt?.options ?? []).find((o) => o.value === value);
		const current = chosen?.name ?? value;
		// The adapter resolves an id loosely (claude-opus-5-5 → its "opus" row): a
		// request it does not know could land on another model without an error.
		// Accept only a row that names the same family and version.
		const mismatch = chosen && !sameModel(model, `${chosen.value} ${chosen.name ?? ""} ${chosen.description ?? ""}`);
		log(`model → ${model} (adapter reports ${current ?? "nothing"}${mismatch ? ", NOT the requested one" : ""})`);
		await api("POST", "/runner/model", {
			requested: model,
			current,
			...(mismatch ? { error: `el adaptador eligió ${current} en lugar de ${model}` } : {}),
		});
	} catch (err) {
		log(`model ${model} refused by the adapter: ${err.message}`);
		await api("POST", "/runner/model", { requested: model, current: null, error: String(err.message).slice(0, 300) });
	}
}

// ── One message ───────────────────────────────────────────────────────────
function run(sessionId, msg) {
	return new Promise((resolve) => {
		current = {
			msg,
			file: `${LOG_DIR}/m-${msg.id}.ndjson`,
			promptOpen: true,
			stopReason: null,
			tasks: new Map(),
			persistent: new Set(),
			segments: [""],
			allText: "",
			checked: false,
			async release(note) {
				if (current?.msg !== msg) return;
				clearTimeout(current.timer);
				clearTimeout(current.bgTimer);
				record({ released: note });
				emit({ kind: "auth", state: "required" });
				current = null;
				authWaitUntil = Date.now() + AUTH_RETRY_MS;
				authCredentials = credentialsMtime();
				await api("POST", `/runner/messages/${msg.id}/release`, { note });
				log(`message #${msg.id}: back to pending (${note})`);
				resolve();
			},
			async settle(s, exitAfter = false) {
				if (current?.msg !== msg) return;
				clearTimeout(current.timer);
				clearTimeout(current.bgTimer);
				const tasks = [...current.tasks].map(([id, t]) => `${id}(${t.taskType}):${t.state}`);
				const kept = [...current.persistent];
				const body = {
					state: s.state,
					text: finalText() || null,
					stopReason: current.stopReason,
					note: [s.note, tasks.length && `tasks: ${tasks.join(" ")}`, kept.length && `persistent (still running): ${kept.join(" ")}`]
						.filter(Boolean)
						.join("; ") || null,
				};
				record({ settled: body });
				emit({ kind: "settled", state: body.state });
				current = null;
				await api("POST", `/runner/messages/${msg.id}/result`, body);
				log(`message #${msg.id}: ${body.state}${body.note ? ` (${body.note})` : ""}`);
				if (exitAfter) process.exit(1);
				resolve();
			},
		};
		record({ prompt: msg.id });
		emit({ kind: "turn", phase: "start" });
		log(`message #${msg.id} from @${msg.from_id}`);
		const answered = (r) => {
			if (current?.msg !== msg) return;
			current.stopReason = r.stopReason;
			current.promptOpen = false;
			record({ promptResult: r.stopReason });
			emit({ kind: "turn", phase: "answered", stopReason: r.stopReason });
			if (!current.checked) current.bgTimer = setTimeout(() => bgCheck(sessionId), BG_CHECK_MS);
			checkIdle();
		};
		request("session/prompt", { sessionId, prompt: [{ type: "text", text: `${marker(msg)}\n${msg.body}` }] })
			.then(answered)
			.catch((err) => {
				if (current?.msg !== msg) return;
				// -32000 Authentication required: the adapter answers it before the
				// model runs (Claude Code's synthetic login message), so the turn did
				// nothing — the message goes back to pending, not to `uncertain`, and
				// the runner waits for a login (the session's ~/.claude, shared with
				// the terminal's `claude`) before claiming again.
				if (err.data?.code === AUTH_REQUIRED) return current.release("agent not authenticated: log in with `claude` in this session's terminal");
				current.settle({ state: "uncertain", note: `prompt error: ${err.message}` });
			});
	});
}

// Tasks still open long after the turn: ask the agent ONCE, inside the same
// message, whether they are processes it means to keep. The message is never
// closed by a timer.
function bgCheck(sessionId) {
	if (!current || current.promptOpen || current.checked) return;
	const open = blockingTasks().map(([id, t]) => `${id} (${t.taskType}: ${t.name ?? "?"})`);
	if (!open.length) return;
	current.checked = true;
	current.promptOpen = true;
	log(`message #${current.msg.id}: asking about ${open.length} open task(s)`);
	const msg = current.msg;
	request("session/prompt", {
		sessionId,
		prompt: [
			{
				type: "text",
				text:
					`[st-check #${msg.id}] Siguen abiertas en segundo plano: ${open.join(", ")}. ` +
					"Si alguna es un proceso que dejaste corriendo a propósito y ya verificaste, respondé con una línea ST-PERSISTENT: <id> por cada una. " +
					"Si es trabajo pendiente, terminá tu turno sin más: se seguirá esperando.",
			},
		],
	})
		.then((r) => {
			if (current?.msg !== msg) return;
			current.promptOpen = false;
			current.stopReason = r.stopReason;
			checkIdle();
		})
		.catch(() => {});
}

// ── Recovery ──────────────────────────────────────────────────────────────
// A message found `running` with nobody working on it is judged from its own
// log, on its LAST attempt only:
// - no prompt since its last release (or none at all): the claim's answer was
//   lost or the runner stopped before prompting — the prompt never left, so it
//   goes back to pending (`release`), nothing to be uncertain about;
// - a settle written after the last prompt but not posted: re-posted as written;
// - anything else: `uncertain`, never resent.
async function settleInterrupted(msg) {
	const file = `${LOG_DIR}/m-${msg.id}.ndjson`;
	const lines = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
	const last = (pred) => lines.findLastIndex(pred);
	const p = last((l) => l.prompt !== undefined);
	const settled = last((l) => l.settled);
	if (settled > p && p !== -1) {
		await api("POST", `/runner/messages/${msg.id}/result`, lines[settled].settled);
		return null;
	}
	if (p === -1 || last((l) => l.released) > p) {
		const note = "claimed but never sent to the agent (claim answer lost or runner restarted before the prompt)";
		await api("POST", `/runner/messages/${msg.id}/release`, { note });
		log(`#${msg.id}: ${note}; back to pending`);
		return null;
	}
	const attempt = lines.slice(p);
	const open = new Map();
	for (const { update: u } of attempt) {
		if (u?.sessionUpdate === "async_task_spawned") open.set(u.asyncTaskId, u.taskType);
		if (u?.sessionUpdate === "async_task_state_update" && TERMINAL.has(u.state)) open.delete(u.asyncTaskId);
	}
	const answered = attempt.some((l) => l.promptResult);
	const note = `runner restarted: ${answered ? "turn answered" : "turn in progress"}${open.size ? `; background open at the time: ${[...open].map(([id, t]) => `${id}(${t})`).join(" ")}` : ""}`;
	await api("POST", `/runner/messages/${msg.id}/result`, { state: "uncertain", note });
	log(`interrupted #${msg.id}: uncertain (${note})`);
	return note;
}

async function main() {
	log(`starting; adapter ${env.ACP_AGENT_CMD}, cwd ${CWD}, model ${env.ANTHROPIC_MODEL ?? "default"}`);
	mkdirSync(CWD, { recursive: true });
	const sessionId = await openSession();
	// Questions of a previous run waited on ACP requests that died with it.
	const orphaned = await api("POST", "/runner/questions-orphan", {
		note: "el agente se reinició antes de recibir la respuesta: no se usó",
	});
	if (orphaned.body?.length) log(`${orphaned.body.length} question(s) of the previous run orphaned`);
	const running = await api("GET", "/runner/running");
	const interrupted = running.status === 200 ? { msg: running.body, note: await settleInterrupted(running.body) } : null;
	// What the resume itself sets off (e.g. Claude Code's "didn't finish before
	// the previous session ended" notification of a killed task, which opens a
	// turn of its own that only a prompt closes) shows up right after it.
	await new Promise((ok) => setTimeout(ok, STARTUP_WINDOW_MS));
	const orphanTurns = [...live].filter(([, t]) => t.taskType === "turn").map(([id]) => id);
	if (interrupted?.note || orphanTurns.length || orphaned.body?.length) {
		// The controlled continuation: one message from Shared Terminal, sent now
		// (not behind the idle gate — this prompt is what the adapter closes the
		// orphan turn with). It asks for a report, never a redo.
		const body = [
			"[st-recovery] El runner de Shared Terminal se reinició.",
			interrupted?.note ? `Tu ejecución del mensaje #${interrupted.msg.id} quedó interrumpida (${interrupted.note}) y quedó registrada como incierta; no se va a reenviar.` : "",
			orphanTurns.length ? "Hay una notificación de tareas en segundo plano interrumpidas." : "",
			orphaned.body?.length ? "Habías hecho una pregunta a la persona que quedó sin respuesta entregada; si todavía necesitás esa decisión, volvé a preguntarla." : "",
			"No repitas automáticamente comandos ni operaciones que puedan haber tenido efectos.",
			"Revisá el estado actual sin modificarlo y respondé brevemente: qué quedó hecho, qué no, y qué recomendás.",
		]
			.filter(Boolean)
			.join(" ");
		const sys = await api("POST", "/runner/system-message", { body });
		if (sys.status === 200) await run(sessionId, sys.body);
	}
	for (;;) {
		// After "not authenticated", the adapter (and the Claude process it
		// started without credentials) is replaced: the restart loop relaunches
		// this runner in 3 s with the same ACP session. At once when the
		// session's credentials change (a login from the Terminal or from
		// "Conectar cuenta"), else after AUTH_RETRY_MS.
		if (authCredentials !== null && !current) {
			if (credentialsMtime() !== authCredentials || Date.now() >= authWaitUntil) {
				log(credentialsMtime() !== authCredentials ? "credentials changed: restarting the adapter" : "still not authenticated: restarting the adapter to check again");
				process.exit(0);
			}
			await new Promise((ok) => setTimeout(ok, 1_000));
			continue;
		}
		// A new runner was installed (backend upgrade): hand over while idle.
		if (!current && live.size === 0 && selfMtime() !== startedMtime) {
			log("runner updated on disk: restarting into the new version");
			process.exit(0);
		}
		if (!agentIdle()) {
			await new Promise((ok) => setTimeout(ok, 500));
			continue;
		}
		const r = await api("POST", "/runner/claim");
		// Idle here, by construction: switch before the claimed message starts.
		await applyModel(sessionId, r.model);
		if (r.status === 200) await run(sessionId, r.body);
		else if (r.status === 409) {
			// Something of ours is `running` while we run nothing: our claim
			// landed but its answer was lost. Judge it like a restart would.
			const cur = await api("GET", "/runner/running");
			if (cur.status === 200 && !current) await settleInterrupted(cur.body);
		} else await new Promise((ok) => setTimeout(ok, 2_000));
	}
}

main().catch((err) => {
	log("fatal", err);
	process.exit(1);
});
