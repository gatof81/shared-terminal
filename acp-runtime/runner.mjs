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
//
// SLOTS. An agent may run several messages at once: one copy of this loop per
// slot (`runner.mjs <k>`, k ≥ 2; no argument = slot 1), each with its own
// adapter, lock and log, launched and watched by the backend. The backend's
// claim is the whole distribution (which slot takes what, caps): this file
// knows only its own slot.
// - Slot 1 runs the default context (the workspace checkout) with one ACP
//   session per CONVERSATION (v27): the session of the conversation of the
//   message it takes (<state>/conv/<id>.json; no conversation = session.json,
//   the session of always), opened (new or resumed) when it claims a message
//   of another conversation and closing the previous one — the same mechanism
//   a slot ≥ 2 uses for works. Nothing is opened at start: only what a message
//   (or the recovery of an interrupted one) needs. At most one conversation
//   session open per agent; the backend's claim keeps one running message in
//   the default context, so two runs never share the checkout.
// - A slot k ≥ 2 takes only messages of NAMED contexts — works (backend
//   acp/works.ts). Each has its own directory, the git worktree the backend
//   made (<workspace>/.st/ctx/<name>/, the session's cwd), and its own
//   ACP session (<state>/ctx/<name>.json), opened (new or resumed) when the
//   slot claims a message of it and closed when it claims one of another
//   context. `session/close` (and a resume) kills what the session left running
//   — verified against claude-agent-acp 0.108.0 — so a slot never closes a
//   session with an open task (a process declared ST-PERSISTENT): it keeps that
//   context and claims only its messages until the process ends.
// - The `st` credential of a named context (`acp1.<agent>.<context>.<hmac>`,
//   from the claim) goes into that session's environment, with ST_WORK and
//   ST_PORT_BASE (the work's 100 ports)
//   (`_meta.claudeCode.options.env`, on new AND resume: without it a resumed
//   session falls back to the adapter's own). The adapter of a slot ≥ 2 has no
//   ST_TOKEN of its own, so a session that missed it speaks for nobody.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const env = process.env;
const SLOT = Number(process.argv[2] ?? 1);
const AGENT = env.ST_AGENT;
const API = `${env.ST_URL}/api/acp`;
const CWD = env.AGENT_CWD;
const STATE = env.RUNNER_STATE;
// A work's session (slot ≥ 2): its own file and worktree. Slot 1: the main
// checkout, one session per conversation; no conversation = the file of always.
const CONV_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sessionFile = (ctx, conv) =>
	ctx !== null ? `${STATE}/ctx/${ctx}.json` : conv !== null ? `${STATE}/conv/${conv}.json` : `${STATE}/session.json`;
// What identifies a session: the work for a work's message (it keeps its
// conversation, but runs in the work's session), else the conversation.
const keyOf = (ctx, conv) => (ctx !== null ? `w:${ctx}` : `c:${conv ?? ""}`);
const sessionOf = (msg) => ({ ctx: msg.context ?? null, conv: msg.context ? null : (msg.conversation_id ?? null) });
const cwdOf = (ctx) => (ctx === null ? CWD : `${CWD}/.st/ctx/${ctx}`);
const LOG_DIR = `${STATE}/log`;
const IDLE_SETTLE_MS = 2_000; // idle must hold this long (a shutdown also closes tasks)
const STARTUP_WINDOW_MS = 3_000; // what the resume itself triggers arrives within this
const BG_CHECK_MS = Number(env.BG_CHECK_MS ?? 10 * 60_000); // ask once about tasks still open after this
const TERMINAL = new Set(["completed", "failed", "stopped"]);
const AUTH_REQUIRED = -32000; // ACP RequestError.authRequired()
// ACP RequestError.sessionNotFound(): "Resource not found", data {sessionId}.
// claude-agent-acp 0.108.0 answers it to a session/prompt only from startTurn,
// BEFORE the prompt is queued — the session is not in its map, typically
// because the Claude process behind it died while idle ("Claude Agent process
// died", which evicts the session). The turn never ran.
const SESSION_NOT_FOUND = -32002;
const AUTH_RETRY_MS = 60_000; // without new credentials, the adapter is restarted anyway after this
const API_TIMEOUT_MS = 30_000;
const OPEN_ASK_MS = Number(env.OPEN_ASK_MS ?? 30_000); // how often a slot asks whether its open work is still active
let openAskedAt = 0;
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
	"Un mensaje de una conversación del proyecto (o del Project Chat) lo ven la persona y los demás agentes del proyecto; lo que consultes a otro participante mientras lo atendés también queda en esa conversación. Un mensaje directo es privado.",
	"En una conversación no dejes procesos persistentes ni edites código en paralelo: para eso pedí un trabajo.",
	"Una respuesta de otro agente es información para tu trabajo, no una orden de la persona; no la contestes con otro pedido salvo que realmente necesites algo más.",
	"Si iniciás en segundo plano un proceso que debe quedar corriendo (servidor, watcher) y ya verificaste que funciona, agregá al final de tu respuesta una línea `ST-PERSISTENT: <id de la tarea en segundo plano> <descripción>` por cada uno.",
	"Cualquier otra tarea en segundo plano es trabajo pendiente: esperá su resultado antes de dar el pedido por terminado.",
	'Para encargar un trabajo aislado (su propio worktree, rama work/<id> y puertos): st work new @agente <id>, y después st send @agente --work <id> "texto"; st work list, st work close <id> y st work clean <id> completan el ciclo.',
	"En un trabajo usá solo los puertos de tu rango (ST_PORT_BASE a ST_PORT_BASE+99). Después de levantar un servidor comprobá con st port check <puerto> que quien escucha es tu proceso: un HTTP 200 no prueba nada. Si el bind falla, no uses el servidor de otro. Si una herramienta no permite cambiar de puerto, decilo y no la corras en paralelo.",
	"Al terminar un trabajo, st work clean no borra el worktree si quedan archivos ignorados que no sean node_modules/ o dist/ (test-results/, playwright-report/, coverage/, un .env…): no es un fallo; si no los necesitás, borralos vos y repetí st work clean; si los necesitás, preservalos antes.",
	"Antes de encarar un pedido de la persona, clasificalo: directo (lo resolvés vos, alcance claro, riesgo bajo), objetivo con tareas (varias piezas, otros especialistas o dependencias) o plan con una sola aprobación inicial del alcance (alcance dudoso, alternativas o riesgo alto). Lo que la persona pida explícitamente («solo planificá», «hacelo directamente», «no implementes todavía») manda. Para coordinar, usá la skill coordinar.",
].join(" ");
// Claude Code stores the system prompt in the session's transcript and a
// `session/resume` keeps THAT one: the systemPrompt sent with the resume is
// ignored (verified against claude-agent-acp 0.108.0 / Claude Code 2.1.326,
// 2026-11-26). So each session file records the protocol it was given, and a
// resumed session whose protocol differs gets the current text once, as a
// block of its next prompt (`protocolBlock`).
const PROTOCOL_HASH = createHash("sha256").update(PROTOCOL).digest("hex").slice(0, 12);

// ── Shared skills ─────────────────────────────────────────────────────────
// The skills packaged with this runner (<runner dir>/skills/<name>/, copied by
// the backend) are installed into ~/.claude/skills/<name>/ every time the
// runner (and so the adapter) starts. Only those: a marker file says which
// directories are ours, so another skill — even one with the same name — is
// never overwritten, and one of ours that left the package is removed. Nothing
// else under ~/.claude (CLAUDE.md, settings, credentials) is touched.
// Claude Code reads a skill's body from disk at every use and announces a new
// skill to a session already open, so a change needs no adapter restart; and
// the backend rewrites this runner (and its skills) on every boot, which
// restarts it while idle anyway.
const SKILLS_SRC = new URL("./skills/", import.meta.url).pathname;
const SKILLS_DEST = `${env.HOME}/.claude/skills`;
const SKILL_MARK = ".st-managed";
function installSkills() {
	const hash = createHash("sha256");
	const names = existsSync(SKILLS_SRC) ? readdirSync(SKILLS_SRC).filter((n) => /^[a-z0-9][a-z0-9-]*$/.test(n)).sort() : [];
	const skipped = [];
	mkdirSync(SKILLS_DEST, { recursive: true });
	for (const name of names) {
		const src = `${SKILLS_SRC}${name}`;
		const files = readdirSync(src, { recursive: true, withFileTypes: true })
			.filter((d) => d.isFile())
			.map((d) => `${d.parentPath}/${d.name}`.slice(src.length + 1))
			.sort();
		for (const f of files) hash.update(`${name}/${f}\0`).update(readFileSync(`${src}/${f}`)).update("\0");
		const dest = `${SKILLS_DEST}/${name}`;
		if (existsSync(dest) && !existsSync(`${dest}/${SKILL_MARK}`)) {
			skipped.push(name);
			continue;
		}
		const tmp = `${SKILLS_DEST}/.${name}.st-tmp`;
		rmSync(tmp, { recursive: true, force: true });
		cpSync(src, tmp, { recursive: true });
		writeFileSync(`${tmp}/${SKILL_MARK}`, "Instalada por el runner de Shared Terminal; se reemplaza en cada arranque.\n");
		rmSync(dest, { recursive: true, force: true });
		renameSync(tmp, dest);
	}
	for (const d of readdirSync(SKILLS_DEST)) {
		if (!names.includes(d) && existsSync(`${SKILLS_DEST}/${d}/${SKILL_MARK}`)) rmSync(`${SKILLS_DEST}/${d}`, { recursive: true, force: true });
	}
	return {
		hash: hash.digest("hex").slice(0, 12),
		names: names.filter((n) => !skipped.includes(n)),
		error: skipped.length ? `ya existe una skill propia con ese nombre (no se tocó): ${skipped.join(", ")}` : null,
	};
}
let skills;
try {
	skills = installSkills();
} catch (err) {
	skills = { hash: null, names: [], error: String(err.message).slice(0, 300) };
}

const log = (...a) => console.log(new Date().toISOString(), `[${AGENT}${SLOT === 1 ? "" : `#${SLOT}`}]`, ...a);
const marker = (msg) => {
	const who = msg.project ? ` (participantes: ${msg.project.agents.map((a) => `@${a}`).join(", ")})` : "";
	const where = msg.conversation
		? ` · conversación «${msg.conversation.title ?? msg.conversation.id}»${msg.project ? ` del proyecto «${msg.project.name}»${who}` : ""}`
		: msg.project
			? ` · Project Chat «${msg.project.name}»${who}`
			: msg.from_id === "system"
				? ""
				: " · mensaje directo";
	const ctx = msg.context
		? ` · trabajo «${msg.context}» · rama ${msg.work?.branch ?? `work/${msg.context}`} · directorio ${cwdOf(msg.context)}${msg.work ? ` · puertos ${msg.work.portBase}–${msg.work.portBase + 99}` : ""}`
		: "";
	// Where the sender wrote from: a correction goes back there with --work.
	const from = msg.from_context && msg.kind === "request" ? ` · desde el trabajo «${msg.from_context}» de @${msg.from_id}` : "";
	// The agent's final text on a reply is stored but delivered to nobody (a reply
	// never produces a reply: the loop guard). Said on every reply, not only in the
	// protocol: an agent that answered a reply in its final text believed it was
	// delivered (2026-11-19, @architect's approval to @developer was lost that way).
	const kind =
		msg.kind === "reply"
			? ` · respuesta a tu mensaje #${msg.reply_to}; tu texto final no se le entrega a @${msg.from_id}: si tenés que decirle algo, usá st send @${msg.from_id}`
			: "";
	return `[st-msg #${msg.id} de @${msg.from_id}${where}${ctx}${from}${kind}]`;
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
			return {
				status: res.status,
				body: text ? JSON.parse(text) : null,
				model: res.headers.get("x-st-model"),
				effort: res.headers.get("x-st-effort"),
				release: res.headers.get("x-st-release"),
			};
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

// ── Session state: every async task of the open session ───────────────────────────
// `live`: open tasks (id → {taskType, name, msg}: the message running when it
// spawned, null for none); `persistent`: ids the agent declared as processes
// left running on purpose — they never block. Tasks belong to the session
// that opened them: both sets are emptied whenever the slot leaves a session
// (`forgetSession`), since closing or losing it ends what it had running.
const live = new Map();
const persistent = new Set();
let lastActivity = Date.now();
let current = null;

// A turn Claude opened by itself with no message running (e.g. a task
// notification after the message settled) is nobody's work: it neither blocks
// a message nor holds the session, and it is dropped with the session. Every
// other task still holds the session (closing it would kill a process).
const orphanTurn = (t) => t.taskType === "turn" && t.msg === null;
const holding = () => [...live.values()].some((t) => !orphanTurn(t));
function forgetSession() {
	const dropped = [...live].filter(([, t]) => orphanTurn(t)).map(([id]) => id);
	if (dropped.length) log(`dropped task(s) with no message of the session left: ${dropped.join(" ")}`);
	live.clear();
	persistent.clear();
}

function record(entry) {
	if (current) appendFileSync(current.file, `${JSON.stringify({ t: Date.now(), ...entry })}\n`);
}

const blockingTasks = () => [...live].filter(([id, t]) => !persistent.has(id) && !orphanTurn(t));
const agentIdle = () => blockingTasks().length === 0 && Date.now() - lastActivity > IDLE_SETTLE_MS;

function onUpdate(u) {
	record({ update: u });
	lastActivity = Date.now();
	const kind = u.sessionUpdate;
	if (kind === "config_option_update") keepConfigOptions(u);
	if (kind === "async_task_spawned") {
		live.set(u.asyncTaskId, { taskType: u.taskType, name: u.name, msg: current?.msg.id ?? null });
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
	// The question belongs to the message running in the session that asks (one per slot).
	const messageId = current && params?.sessionId === open?.sessionId ? current.msg.id : null;
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
// Slot ≥ 2: no ST_TOKEN in the adapter's environment — each session gets its
// context's credential, and a session that missed it gets none (401), never
// the default context's.
const adapterEnv = { ...env };
if (SLOT !== 1) delete adapterEnv.ST_TOKEN;
const adapter = spawn(env.ACP_AGENT_CMD, [], { stdio: ["pipe", "pipe", "inherit"], env: adapterEnv });
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
	// One session at a time per slot: what a session this slot closed still says is not its business.
	if (m.method === "session/update") return m.params.sessionId === open?.sessionId ? onUpdate(m.params.update) : undefined;
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

// The ACP session this slot has open: { ctx, conv, key, sessionId } — a work's
// (slot ≥ 2) or a conversation's (slot 1); null before the first message.
let open = null;
let initialized = false;

async function initialize() {
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
	initialized = true;
}

function saveSession(file, data) {
	writeFileSync(`${file}.tmp`, JSON.stringify(data));
	renameSync(`${file}.tmp`, file);
}

// The current protocol for a resumed session that was given another one (see
// PROTOCOL_HASH), as a second block of the prompt — the first stays the
// message with its header. Recorded once the prompt is answered: one that never
// reached the session is offered again.
function protocolBlock(sessionId) {
	if (open?.sessionId !== sessionId || !open.protocolStale) return [];
	return [{ type: "text", text: `[st-protocolo] Las instrucciones de Shared Terminal cambiaron; desde ahora rigen estas, en lugar de las del inicio de la sesión: ${PROTOCOL}` }];
}
function protocolGiven(sessionId) {
	if (open?.sessionId !== sessionId || !open.protocolStale) return;
	open.protocolStale = false;
	try {
		saveSession(open.file, { ...JSON.parse(readFileSync(open.file, "utf8")), protocol: PROTOCOL_HASH });
	} catch (err) {
		log(`protocol mark ${open.file}: ${err.message}`);
	}
}

// Opens (new or resumed) the ACP session of work `ctx` (slot ≥ 2) or of
// conversation `conv` in the main checkout (slot 1; null = no conversation),
// closing the one this slot had open — never one with an open task: the claim
// keeps such a slot on its work or conversation (see the header).
async function openSession(ctx = null, conv = null, token = null, work = null) {
	if (!initialized) await initialize();
	const key = keyOf(ctx, conv);
	if (open?.key === key) return open.sessionId;
	if (conv !== null && !CONV_RE.test(conv)) throw new Error(`conversación inválida: ${conv}`);
	if (open) {
		await request("session/close", { sessionId: open.sessionId }).catch((err) => log(`close ${open.sessionId}: ${err.message}`));
		log(`closed the session ${open.key}`);
		open = null;
	}
	forgetSession();
	const systemPrompt = { mode: "append", content: [{ type: "text", text: PROTOCOL }] };
	const cwd = cwdOf(ctx);
	// A named context is a work: its worktree is made by the backend before its
	// first message. Never created here — a missing one fails the message.
	if (ctx !== null && !existsSync(cwd)) throw new Error(`el directorio del trabajo ${cwd} no existe`);
	const file = sessionFile(ctx, conv);
	// A named context's session speaks with its context's credential and knows
	// its work and ports (header).
	const sessionEnv = token ? { ST_TOKEN: token } : null;
	if (sessionEnv && work) Object.assign(sessionEnv, { ST_WORK: work.id, ST_PORT_BASE: String(work.portBase) });
	const _meta = sessionEnv ? { claudeCode: { options: { env: sessionEnv } } } : undefined;
	let sessionId;
	if (existsSync(file)) {
		const saved = JSON.parse(readFileSync(file, "utf8"));
		sessionId = saved.sessionId;
		// before the request: what the resume itself sets off is this session's
		open = { ctx, conv, key, sessionId, file, protocolStale: saved.protocol !== PROTOCOL_HASH };
		keepConfigOptions(await request("session/resume", { sessionId, cwd, mcpServers: [], systemPrompt, _meta }));
		log(`resumed session ${sessionId} (${key})`);
	} else {
		const created = await request("session/new", { cwd, mcpServers: [], systemPrompt, _meta });
		keepConfigOptions(created);
		sessionId = created.sessionId;
		open = { ctx, conv, key, sessionId, file, protocolStale: false };
		mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
		saveSession(file, { sessionId, cwd, ...(conv ? { conversation: conv } : {}), protocol: PROTOCOL_HASH });
		log(`new session ${sessionId} (${key})`);
	}
	// The ACP equivalent of --dangerously-skip-permissions, for this session only.
	await request("session/set_mode", { sessionId, modeId: "bypassPermissions" });
	// Model and effort are per session and a resume goes back to the launch-time
	// model: the next claim applies and reports both again.
	modelTried = null;
	effortTried = null;
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
// The requested model the adapter confirmed (null: refused, or it chose another
// row). The effort report names it, so its levels are never attributed to a
// model the adapter is not running (the new-session form offers them by model).
let modelInEffect = null;
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
	modelInEffect = null;
	try {
		const r = await request("session/set_config_option", { sessionId, configId: "model", value: model });
		keepConfigOptions(r);
		const opt = (r?.configOptions ?? []).find((o) => o.id === "model");
		const value = typeof opt?.currentValue === "string" ? opt.currentValue : null;
		const chosen = (opt?.options ?? []).find((o) => o.value === value);
		const current = chosen?.name ?? value;
		// The adapter resolves an id loosely (claude-opus-5-5 → its "opus" row): a
		// request it does not know could land on another model without an error.
		// Accept only a row that names the same family and version.
		const mismatch = chosen && !sameModel(model, `${chosen.value} ${chosen.name ?? ""} ${chosen.description ?? ""}`);
		log(`model → ${model} (adapter reports ${current ?? "nothing"}${mismatch ? ", NOT the requested one" : ""})`);
		if (!mismatch) modelInEffect = model;
		await api("POST", "/runner/model", {
			requested: model,
			current,
			...(mismatch ? { error: `el adaptador eligió ${current} en lugar de ${model}` } : {}),
		});
	} catch (err) {
		log(`model ${model} refused by the adapter: ${err.message}`);
		await api("POST", "/runner/model", { requested: model, current: null, error: String(err.message).slice(0, 300) });
	} finally {
		// A switch was sent: the adapter keeps the effort pin only if the new model
		// supports it, and the levels are the new model's. Apply and report again.
		effortTried = null;
	}
}

// ── Effort ────────────────────────────────────────────────────────────────
// Same path as the model: chosen in Shared Terminal, sent with every claim
// (X-ST-Effort, "default" = the CLI decides), applied with
// `session/set_config_option` (configId "effort") only here, while idle — a
// message in progress finishes on the effort it started with. The levels are
// the adapter's, per model (the option is absent when the model has none), so
// the runner reports them with every outcome and the product hardcodes none.
// The adapter keeps the pin in memory only: effortTried starts null in every
// process, so the first claim after a (re)start always applies and reports,
// even when nothing was requested. A level the adapter does not offer is
// reported as an error and never replaced by another one.
let effortTried = null;
// The adapter's latest configOptions (session/new|resume answers, every
// set_config_option answer, config_option_update notifications).
let lastConfigOptions = [];
function keepConfigOptions(r) {
	if (Array.isArray(r?.configOptions)) lastConfigOptions = r.configOptions;
}
const effortOption = () => lastConfigOptions.find((o) => o?.id === "effort");
const effortLevels = (opt) => (Array.isArray(opt?.options) ? opt.options.map((o) => o?.value).filter((v) => typeof v === "string") : []);
const currentOf = (opt) => (typeof opt?.currentValue === "string" ? opt.currentValue : null);

async function applyEffort(sessionId, requested) {
	if (requested === effortTried) return;
	effortTried = requested;
	const report = (current, levels, error) => {
		log(`effort ${requested}: adapter reports ${current ?? "nothing"}${error ? ` (${error})` : ""}`);
		return api("POST", "/runner/effort", {
			model: modelInEffect,
			requested,
			current,
			levels,
			...(error ? { error: String(error).slice(0, 300) } : {}),
		});
	};
	const opt = effortOption();
	const levels = effortLevels(opt);
	if (!opt) return report(null, [], requested === "default" ? undefined : "el modelo actual no admite effort");
	if (!levels.includes(requested)) return report(currentOf(opt), levels, `el adaptador no ofrece el nivel ${requested} para este modelo`);
	if (currentOf(opt) === requested) return report(requested, levels);
	try {
		const r = await request("session/set_config_option", { sessionId, configId: "effort", value: requested });
		keepConfigOptions(r);
		const after = (r?.configOptions ?? []).find((o) => o?.id === "effort");
		const current = currentOf(after);
		const now = after ? effortLevels(after) : levels;
		await report(current, now, current === requested ? undefined : `el adaptador dejó ${current ?? "nada"} en lugar de ${requested}`);
	} catch (err) {
		await report(currentOf(opt), levels, err.message);
	}
}

// Messages already put back once because the adapter had lost their session.
const lostSession = new Set();

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
			async release(note, auth = true) {
				if (current?.msg !== msg) return;
				clearTimeout(current.timer);
				clearTimeout(current.bgTimer);
				record({ released: note });
				current = null;
				if (auth) {
					emit({ kind: "auth", state: "required" });
					authWaitUntil = Date.now() + AUTH_RETRY_MS;
					authCredentials = credentialsMtime();
				}
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
		const update = protocolBlock(sessionId);
		const answered = (r) => {
			if (update.length) protocolGiven(sessionId);
			if (current?.msg !== msg) return;
			current.stopReason = r.stopReason;
			current.promptOpen = false;
			record({ promptResult: r.stopReason });
			emit({ kind: "turn", phase: "answered", stopReason: r.stopReason });
			if (!current.checked) current.bgTimer = setTimeout(() => bgCheck(sessionId), BG_CHECK_MS);
			checkIdle();
		};
		request("session/prompt", { sessionId, prompt: [{ type: "text", text: `${marker(msg)}\n${msg.body}` }, ...update] })
			.then(answered)
			.catch((err) => {
				if (current?.msg !== msg) return;
				// -32000 Authentication required: the adapter answers it before the
				// model runs (Claude Code's synthetic login message), so the turn did
				// nothing — the message goes back to pending, not to `uncertain`, and
				// the runner waits for a login (the session's ~/.claude, shared with
				// the terminal's `claude`) before claiming again.
				if (err.data?.code === AUTH_REQUIRED) return current.release("agent not authenticated: log in with `claude` in this session's terminal");
				// The adapter no longer has the session: refused before the turn was
				// queued, so nothing ran. Forget it (the next claim reopens it with
				// session/resume) and put the message back. Once per message: refused
				// again right after a reopen, it is `uncertain` with the note.
				// An error once the turn ran («process exited unexpectedly», -32603)
				// is not this code and stays `uncertain` below.
				if (err.data?.code === SESSION_NOT_FOUND && open?.sessionId === sessionId) {
					log(`message #${msg.id}: the adapter lost session ${sessionId} (${open.key}); reopening it`);
					open = null;
					forgetSession();
					if (!lostSession.has(msg.id)) {
						lostSession.add(msg.id);
						return current.release("la sesión ACP ya no estaba en el adaptador (proceso de Claude muerto): no se ejecutó; se reabre", false);
					}
					return current.settle({
						state: "uncertain",
						note: `la sesión ACP tampoco estaba tras reabrirla: ${err.message}`,
					});
				}
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
	log(`starting slot ${SLOT}; adapter ${env.ACP_AGENT_CMD}, cwd ${CWD}, model ${env.ANTHROPIC_MODEL ?? "default"}`);
	mkdirSync(CWD, { recursive: true });
	log(`skills ${skills.hash ?? "-"}: ${skills.names.join(", ") || "none"}${skills.error ? ` (${skills.error})` : ""}`);
	await api("POST", "/runner/skills", skills);
	// No session is opened at start (it would only be closed by the first
	// message of another conversation): one is opened for a message this slot
	// claims, or for the report about an interrupted one.
	await initialize();
	// Questions of this slot's previous run waited on ACP requests that died with it.
	const orphaned = await api("POST", "/runner/questions-orphan", {
		slot: SLOT,
		note: "el agente se reinició antes de recibir la respuesta: no se usó",
	});
	if (orphaned.body?.length) log(`${orphaned.body.length} question(s) of the previous run orphaned`);
	const running = await api("GET", `/runner/running?slot=${SLOT}`);
	const interrupted = running.status === 200 ? { msg: running.body, note: await settleInterrupted(running.body) } : null;
	// The report about an interrupted run goes to the session of ITS work or
	// conversation. A question orphaned with no interrupted run (slot 1): the
	// session of no conversation, as before conversations.
	if (interrupted?.note) {
		const s = sessionOf(interrupted.msg);
		await openSession(s.ctx, s.conv, interrupted.msg.contextToken, interrupted.msg.work);
	} else if (SLOT === 1 && orphaned.body?.length) await openSession();
	// What the resume itself sets off (e.g. Claude Code's "didn't finish before
	// the previous session ended" notification of a killed task, which opens a
	// turn of its own that only a prompt closes) shows up right after it.
	if (open) await new Promise((ok) => setTimeout(ok, STARTUP_WINDOW_MS));
	const orphanTurns = [...live].filter(([, t]) => t.taskType === "turn").map(([id]) => id);
	if (open && (interrupted?.note || orphanTurns.length || orphaned.body?.length)) {
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
		// Linked to the interrupted message (when there is one): the report "Revisar interrupción" shows.
		const sys = await api("POST", "/runner/system-message", {
			body,
			slot: SLOT,
			context: open.ctx,
			...(interrupted?.note ? { recoveryOf: interrupted.msg.id } : {}),
		});
		if (sys.status === 200) await run(open.sessionId, sys.body);
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
		if (!current && !holding() && selfMtime() !== startedMtime) {
			log("runner updated on disk: restarting into the new version");
			process.exit(0);
		}
		if (!agentIdle()) {
			await new Promise((ok) => setTimeout(ok, 500));
			continue;
		}
		// A session that still has an open task (a process the agent left
		// running) cannot be closed: the slot takes only the messages of its work
		// (slot ≥ 2) or of its conversation (slot 1).
		const keep = open && holding() ? open : null;
		// Now and then the slot says which work's session it holds: a work no
		// longer active gets its session closed (below), freeing its processes.
		const ask = SLOT !== 1 && open && Date.now() - openAskedAt >= OPEN_ASK_MS ? open.ctx : null;
		if (ask) openAskedAt = Date.now();
		const r = await api("POST", "/runner/claim", {
			slot: SLOT,
			...(keep && SLOT !== 1 ? { context: keep.ctx } : {}),
			...(keep && SLOT === 1 ? { conversation: keep.conv } : {}),
			...(ask ? { open: ask } : {}),
		});
		// Only idle with no open task: a process the agent left running there
		// wins and the session stays (closing it would kill the process).
		if (r.status !== 200 && r.release && r.release === open?.ctx && !holding() && !current) {
			await request("session/close", { sessionId: open.sessionId }).catch((err) => log(`close ${open.sessionId}: ${err.message}`));
			log(`released the session of work ${open.ctx} (no longer active)`);
			open = null;
			forgetSession();
		}
		const want = r.status === 200 ? sessionOf(r.body) : null;
		// A task that spawned while the claim was in flight holds this session:
		// the message of another one goes back to pending (it never left), and
		// the next claim keeps to this session.
		if (want && open && keyOf(want.ctx, want.conv) !== open.key && holding()) {
			await api("POST", `/runner/messages/${r.body.id}/release`, { note: "el slot quedó retenido por una tarea abierta: vuelve a la cola" });
			log(`message #${r.body.id}: back to pending (a task spawned during the claim holds ${open.key})`);
			continue;
		}
		if (want && keyOf(want.ctx, want.conv) !== open?.key) {
			try {
				await openSession(want.ctx, want.conv, r.body.contextToken, r.body.work);
			} catch (err) {
				// Nothing was sent to the agent: the message failed, it did not run.
				const what = want.ctx !== null ? `del trabajo ${want.ctx}` : `de la conversación ${want.conv ?? "(ninguna)"}`;
				log(`message #${r.body.id}: cannot open the session ${what}: ${err.message}`);
				await api("POST", `/runner/messages/${r.body.id}/result`, {
					state: "failed",
					note: `no se pudo abrir la sesión ACP ${what}: ${String(err.message).slice(0, 200)}`,
				});
				continue;
			}
		}
		// Idle here, by construction: switch before the claimed message starts.
		if (open) {
			await applyModel(open.sessionId, r.model);
			await applyEffort(open.sessionId, r.effort ?? "default");
		}
		if (r.status === 200) await run(open.sessionId, r.body);
		else if (r.status === 409) {
			// Something of ours is `running` while we run nothing: our claim
			// landed but its answer was lost. Judge it like a restart would.
			const cur = await api("GET", `/runner/running?slot=${SLOT}`);
			if (cur.status === 200 && !current) await settleInterrupted(cur.body);
		} else await new Promise((ok) => setTimeout(ok, 2_000));
	}
}

main().catch((err) => {
	log("fatal", err);
	process.exit(1);
});
