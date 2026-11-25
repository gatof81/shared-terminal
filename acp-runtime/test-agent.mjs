#!/usr/bin/env node
// st-test-agent — a deterministic ACP agent for Shared Terminal's automated
// end-to-end tests. Installed as the runtime `st-test-agent` only when the
// backend runs with ACP_TEST_RUNTIME=1. It speaks the same ACP v1 subset the
// runner uses (initialize with AIR asyncTasks, session/new|resume|set_mode,
// session/prompt with streamed updates), needs no model and no credentials,
// and acts only through what a real agent would use: the `st` CLI.
//
// What a message body asks (one directive per message):
//   consultá a @x: <texto>   → runs `st send @x "<texto>"`, ends the turn
//   rondas <N>: consultá a @x: <texto>
//                            → the same consult, and N − 1 more: each reply of
//                              @x sends it again while rounds are left (kept
//                              with the session), then is only acknowledged
//   esperá <N>               → a tool call that takes N seconds
//   segundo plano <N>        → an async task that ends N seconds after the turn
//   segundo plano <N>: consultá a @x: <texto>
//                            → the same task runs `st send` when it ends (a
//                              background process speaking for its message)
//   persistente <N>: consultá a @x: <texto>
//                            → the task is declared ST-PERSISTENT (the message
//                              closes) and runs `st send` N s later: a process
//                              that outlived its message
//   st: <args>               → runs `st <args>` (st work new|list|close|clean,
//                              st send --work, st port check …) as a tool call
//                              and answers with its exit code and output
//   servidor [n]             → starts an HTTP server on ST_PORT_BASE + n (n = 0
//                              by default) in the session's cwd and environment
//                              (argv ends in st-work-server, it answers its
//                              ST_WORK), declared ST-PERSISTENT; it lives until
//                              it is killed or the session closes
//   trabajo nuevo @x <id>    → st work new @x <id>
//   delegá <id> a @x: <t>    → st send @x --work <id> "<t>"
//   puerto <p>               → st port check <p>
//   cerrá|limpiá trabajo @x <id> → st work close|clean <id>
//   ocupá <p>                → tries to listen on p: EADDRINUSE / bound (freed)
//   commit <archivo>: <t>    → writes it, git add + commit + push origin HEAD
// The st ones answer with the output and `exit <code>`. Every answer ends with
// the session's context: prompts, model, effort, cwd, `trabajo <ST_WORK|->` and,
// when the header says so, `desde el trabajo <id>`.
//   preguntá: <q> | a | b    → asks the person (ACP elicitation/create, the form
//                              claude-agent-acp makes of AskUserQuestion) and
//                              continues with the answer
//   morí                     → answers, then drops the session from memory
//                              (like claude-agent-acp when the Claude process
//                              dies while idle): its next prompt gets -32002
//                              until it is resumed
//   turno huérfano           → answers, and 4 s later (the message settled)
//                              opens a `turn` task of its own that never ends
//                              while the session is loaded
//   anything else            → an echo of the first line
// With `<state>/test-agent/lose-sessions` present, every prompt drops its
// session and is refused with -32002 (a session that dies again on reopen).
// A reply from another agent ("Respuesta de @x a tu mensaje #n: …") is
// acknowledged. Every answer carries how many prompts this ACP session has
// seen and the session's model and effort — the session (count, model, effort)
// survives runner and container restarts, which is what the tests check
// continuity with. Like claude-agent-acp, each LOADED session has its own
// environment (`_meta.claudeCode.options.env` of new/resume, over the
// adapter's) and cwd — what its `st` runs with; `session/close` unloads it
// and stops its background tasks. Effort levels per model are test-only (opus: five, sonnet or
// no model: three, haiku: none — the option is absent, like the real adapter).
import { execFile, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const ME = process.env.ST_AGENT ?? "test";
// Login like a real adapter: `--login` is the command it advertises as its
// terminal-auth method; it writes the session's credentials file and exits.
// Credentials are required only when `<state>/test-agent/require-auth` exists.
const CREDS = `${process.env.HOME}/.claude/.credentials.json`;
if (process.argv.includes("--login")) {
	const { mkdirSync: mk, writeFileSync: wf } = await import("node:fs");
	mk(`${process.env.HOME}/.claude`, { recursive: true });
	wf(CREDS, JSON.stringify({ test: true, at: new Date().toISOString() }), { mode: 0o600 });
	console.log("Login de prueba completo: credenciales guardadas en ~/.claude.");
	process.exit(0);
}
const DIR = `${process.env.RUNNER_STATE ?? `${process.env.HOME}/.st-test-agent`}/test-agent`;
// One file per session: the adapters of an agent's slots share this directory,
// each with the sessions it has loaded (like the real one: a file per session).
const fileOf = (id) => `${DIR}/session-${id}.json`;
mkdirSync(DIR, { recursive: true });
const sessions = new Proxy(
	{},
	{
		get(cache, id) {
			if (typeof id === "string" && !(id in cache) && existsSync(fileOf(id))) cache[id] = JSON.parse(readFileSync(fileOf(id), "utf8"));
			return cache[id];
		},
	},
);
const save = () => {
	for (const [id, s] of Object.entries(sessions)) {
		writeFileSync(`${fileOf(id)}.tmp`, JSON.stringify(s));
		renameSync(`${fileOf(id)}.tmp`, fileOf(id));
	}
};

const out = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
const update = (sessionId, u) => out({ method: "session/update", params: { sessionId, update: u } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tool = 0;
let rpc = 0;
const waiting = new Map();
/** A request to the client (the runner); resolves with its result. */
const ask = (method, params) =>
	new Promise((resolve, reject) => {
		const id = `ta-${++rpc}`;
		waiting.set(id, { resolve, reject });
		out({ id, method, params });
	});

// Loaded sessions: id → { env, cwd, timers }. Not persisted (a resume brings them again).
const loaded = new Map();
const load = (params, sessionId) =>
	loaded.set(sessionId, { env: params._meta?.claudeCode?.options?.env ?? {}, cwd: params.cwd, timers: new Set(), procs: new Set() });
/** What a session left running stops with it (close or resume), like the real adapter. */
const unload = (sessionId) => {
	const l = loaded.get(sessionId);
	for (const t of l?.timers ?? []) clearTimeout(t);
	for (const p of l?.procs ?? []) p.kill();
};
/** `st <args>` with the session's environment and cwd: {code, out}. */
const stRun = (sessionId, args) =>
	new Promise((resolve) => {
		const l = loaded.get(sessionId);
		execFile("st", args, { timeout: 60_000, env: { ...process.env, ...l?.env }, cwd: l?.cwd }, (err, stdout, stderr) =>
			resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: `${stdout}${stderr}`.trim() }),
		);
	});
// "a b \"c d\"" → ["a", "b", "c d"]
const argv = (line) => [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
const stSend = (sessionId, to, text) =>
	new Promise((resolve) => {
		const l = loaded.get(sessionId);
		execFile("st", ["send", `@${to}`, text], { timeout: 30_000, env: { ...process.env, ...l?.env }, cwd: l?.cwd }, (err, stdout, stderr) =>
			resolve(err ? `error: ${stderr || err.message}` : stdout.trim()),
		);
	});
/** `st send` as a tool call of the turn, like an agent's Bash. */
async function consult(sessionId, to, text) {
	const id = `t${++tool}`;
	update(sessionId, { sessionUpdate: "tool_call", toolCallId: id, title: `st send @${to}`, kind: "execute", status: "pending" });
	const result = await stSend(sessionId, to, text);
	update(sessionId, {
		sessionUpdate: "tool_call_update",
		toolCallId: id,
		status: result.startsWith("error") ? "failed" : "completed",
		rawInput: { command: `st send @${to} …` },
	});
	return result;
}
const later = (sessionId, ms, fn) => {
	const timers = loaded.get(sessionId)?.timers;
	const t = setTimeout(() => {
		timers?.delete(t);
		fn();
	}, ms);
	timers?.add(t);
};

const modelOf = (s) => s.model ?? process.env.ANTHROPIC_MODEL ?? null;
function levelsOf(model) {
	const m = (model ?? "").toLowerCase();
	if (m.includes("haiku")) return [];
	if (m.includes("opus")) return ["low", "medium", "high", "xhigh", "max"];
	return ["low", "medium", "high"];
}
/** The session's configOptions, shaped like claude-agent-acp's. */
function configOptions(s) {
	const model = modelOf(s);
	const opts = [{ id: "model", category: "model", type: "select", currentValue: model ?? "default", options: [] }];
	const levels = levelsOf(model);
	if (levels.length)
		opts.push({
			id: "effort",
			category: "thought_level",
			type: "select",
			currentValue: s.effort ?? "default",
			options: [{ value: "default", name: "Default" }, ...levels.map((l) => ({ value: l, name: l[0].toUpperCase() + l.slice(1) }))],
		});
	return opts;
}

async function prompt(sessionId, text) {
	const s = sessions[sessionId];
	s.prompts += 1;
	save();
	const [header, ...rest] = text.split("\n");
	const body = rest.join("\n").trim();
	const say = async (t) => {
		const half = Math.ceil(t.length / 2);
		update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t.slice(0, half) } });
		await sleep(150);
		update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t.slice(half) } });
	};
	const fromWork = /desde el trabajo «([^»]+)»/.exec(header)?.[1];
	const ctx = `(sesión ACP: ${s.prompts} mensajes · modelo ${modelOf(s) ?? "default"} · effort ${s.effort ?? "default"} · cwd ${loaded.get(sessionId)?.cwd ?? "?"} · trabajo ${loaded.get(sessionId)?.env?.ST_WORK ?? "-"}${fromWork ? ` · desde el trabajo ${fromWork}` : ""})`;
	/** `st <args>` as a tool call; the answer carries its output and exit code. */
	const stTool = async (args) => {
		const id = `t${++tool}`;
		update(sessionId, { sessionUpdate: "tool_call", toolCallId: id, title: `st ${args.join(" ")}`, kind: "execute", status: "in_progress" });
		const r = await stRun(sessionId, args);
		update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: id, status: r.code === 0 ? "completed" : "failed" });
		await say(`st ${args.join(" ")} → exit ${r.code}: ${r.out} ${ctx}`);
	};
	let m;
	if (/^\[st-recovery\]/.test(header) || /^\[st-recovery\]/.test(body) || header.includes("de @system")) {
		await say(`Reporte de @${ME}: no repetí nada; el mensaje interrumpido quedó sin rehacer. ${ctx}`);
	} else if ((m = /^Respuesta de @([a-z][a-z0-9-]*) a tu mensaje #(\d+):\s*([\s\S]*)$/.exec(body))) {
		const got = `Recibí la respuesta de @${m[1]} a #${m[2]}: «${m[3].trim().split("\n")[0].slice(0, 160)}»`;
		const r = s.rounds;
		if (r && r.to === m[1] && r.left > 0) {
			r.left -= 1;
			save();
			const result = await consult(sessionId, r.to, r.text);
			await say(`${got}. Otra ronda (quedan ${r.left}): ${result}. ${ctx}`);
		} else {
			if (r && r.to === m[1]) delete s.rounds;
			save();
			await say(`${got} ${ctx}`);
		}
	} else if ((m = /^st:\s*(.+)$/im.exec(body))) {
		await stTool(argv(m[1]));
	} else if ((m = /^trabajo nuevo (@[a-z][a-z0-9-]*) ([a-z0-9][a-z0-9-]*)\s*$/im.exec(body))) {
		await stTool(["work", "new", m[1], m[2]]);
	} else if ((m = /^deleg[aá] ([a-z0-9][a-z0-9-]*) a (@[a-z][a-z0-9-]*):\s*([\s\S]+)$/im.exec(body))) {
		await stTool(["send", m[2], "--work", m[1], m[3].trim()]);
	} else if ((m = /^puerto (\d+)\s*$/im.exec(body))) {
		await stTool(["port", "check", m[1]]);
	} else if ((m = /^(cerr[aá]|limpi[aá]) trabajo @[a-z][a-z0-9-]* ([a-z0-9][a-z0-9-]*)\s*$/im.exec(body))) {
		await stTool(["work", /^cerr/i.test(m[1]) ? "close" : "clean", m[2]]);
	} else if ((m = /^ocup[aá] (\d+)\s*$/im.exec(body))) {
		const res = await new Promise((resolve) => {
			const srv = createServer();
			srv.once("error", (err) => resolve(err.code ?? err.message));
			srv.listen(Number(m[1]), () => srv.close(() => resolve("bound")));
		});
		await say(`ocupá ${m[1]}: ${res} ${ctx}`);
	} else if ((m = /^commit ([^:\n]+):\s*([\s\S]+)$/im.exec(body))) {
		const l = loaded.get(sessionId);
		const opts = { cwd: l?.cwd, env: { ...process.env, ...l?.env, GIT_TERMINAL_PROMPT: "0" }, encoding: "utf8" };
		const git = (...a) => execFileSync("git", ["-c", "user.name=st-test-agent", "-c", "user.email=st-test-agent@invalid", ...a], opts).trim();
		let answer;
		try {
			writeFileSync(`${l?.cwd}/${m[1].trim()}`, `${m[2].trim()}\n`);
			git("add", "--", m[1].trim());
			git("commit", "-q", "-m", m[2].trim().split("\n")[0]);
			const branch = git("symbolic-ref", "--short", "HEAD");
			const sha = git("rev-parse", "HEAD");
			const push = await new Promise((resolve) =>
				execFile("git", ["push", "-q", "origin", "HEAD"], opts, (err, _o, e) => resolve(err ? `${err.code ?? 1} ${e.trim()}` : "0")),
			);
			answer = `commit en la rama ${branch}, sha ${sha}, push exit ${push}`;
		} catch (err) {
			answer = `commit falló: ${String(err.stderr ?? err.message).trim()}`;
		}
		await say(`${answer} ${ctx}`);
	} else if ((m = /^servidor(?: (\d+))?\s*$/im.exec(body))) {
		const l = loaded.get(sessionId);
		const port = Number(l?.env?.ST_PORT_BASE) + Number(m[1] ?? 0);
		const taskId = `srv-${randomUUID().slice(0, 8)}`;
		const srv = spawn(process.execPath, ["-e", "require('http').createServer((q, r) => r.end(`trabajo ${process.env.ST_WORK ?? '-'}`)).listen(Number(process.argv[1]))", String(port), "st-work-server"], {
			cwd: l?.cwd,
			env: { ...process.env, ...l?.env },
			stdio: "ignore",
		});
		l?.procs.add(srv);
		update(sessionId, { sessionUpdate: "async_task_spawned", asyncTaskId: taskId, taskType: "shell", name: `servidor en ${port}` });
		srv.on("exit", () => {
			l?.procs.delete(srv);
			update(sessionId, { sessionUpdate: "async_task_state_update", asyncTaskId: taskId, state: "completed" });
		});
		await sleep(500);
		await say(`Servidor en el puerto ${port} (pid ${srv.pid}). puerto ${port} ${ctx}\nST-PERSISTENT: ${taskId} servidor en ${port}`);
	} else if ((m = /rondas (\d+):\s*consult[aá] a @([a-z][a-z0-9-]*):\s*([\s\S]+)$/i.exec(body))) {
		const [, n, to, text] = m;
		s.rounds = { to, text: text.trim(), left: Math.max(Number(n) - 1, 0) };
		save();
		const result = await consult(sessionId, to, s.rounds.text);
		await say(`Ronda 1 de ${n} con @${to} (${result}). Sigo cuando responda. ${ctx}`);
	} else if ((m = /(segundo plano|persistente) (\d+):\s*consult[aá] a @([a-z][a-z0-9-]*):\s*([\s\S]+)$/i.exec(body))) {
		const [, how, secs, to, text] = m;
		const taskId = `bg-${randomUUID().slice(0, 8)}`;
		update(sessionId, { sessionUpdate: "async_task_spawned", asyncTaskId: taskId, taskType: "shell", name: `st send en ${secs} s` });
		later(sessionId, Number(secs) * 1000, async () => {
			const result = await stSend(sessionId, to, text.trim());
			console.error(`[test-agent] ${taskId}: st send → ${result}`);
			update(sessionId, { sessionUpdate: "async_task_state_update", asyncTaskId: taskId, state: "completed" });
		});
		await say(
			how.toLowerCase() === "persistente"
				? `Dejé un proceso corriendo que va a consultar a @${to}. ${ctx}\nST-PERSISTENT: ${taskId} st send diferido`
				: `En segundo plano (${taskId}) voy a consultar a @${to} en ${secs} s. ${ctx}`,
		);
	} else if ((m = /consult[aá] a @([a-z][a-z0-9-]*):\s*([\s\S]+)$/i.exec(body))) {
		const result = await consult(sessionId, m[1], m[2].trim());
		await say(`Le consulté a @${m[1]} (${result}). Sigo cuando responda. ${ctx}`);
	} else if ((m = /pregunt[aá]:\s*([^|\n]+)((?:\|[^|\n]+)+)/i.exec(body))) {
		const question = m[1].trim();
		const options = m[2].split("|").map((o) => o.trim()).filter(Boolean);
		const id = `t${++tool}`;
		update(sessionId, { sessionUpdate: "tool_call", toolCallId: id, title: "AskUserQuestion", kind: "other", status: "pending" });
		const res = await ask("elicitation/create", {
			mode: "form",
			sessionId,
			toolCallId: id,
			message: question,
			requestedSchema: {
				type: "object",
				properties: {
					question_0: { type: "string", oneOf: options.map((o) => ({ const: o, title: o })) },
					question_0_custom: { type: "string", title: "Other", description: "Type your own answer (optional)." },
				},
			},
		}).catch((err) => ({ action: "cancel", error: err.message }));
		update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: id, status: res.action === "accept" ? "completed" : "failed" });
		const pick = res.action === "accept" ? res.content?.question_0_custom?.trim() || res.content?.question_0 : null;
		await say(pick ? `Elegiste: ${pick}. Sigo con eso. ${ctx}` : `Sin respuesta (${res.action}); no elijo por vos. ${ctx}`);
	} else if ((m = /esper[aá] (\d+)/i.exec(body))) {
		const id = `t${++tool}`;
		update(sessionId, { sessionUpdate: "tool_call", toolCallId: id, title: `sleep ${m[1]}`, kind: "execute", status: "in_progress" });
		await sleep(Number(m[1]) * 1000);
		update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" });
		await say(`Esperé ${m[1]} s. ${ctx}`);
	} else if ((m = /segundo plano (\d+)/i.exec(body))) {
		const taskId = `bg-${randomUUID().slice(0, 8)}`;
		update(sessionId, { sessionUpdate: "async_task_spawned", asyncTaskId: taskId, taskType: "shell", name: `trabajo de ${m[1]} s` });
		setTimeout(() => update(sessionId, { sessionUpdate: "async_task_state_update", asyncTaskId: taskId, state: "completed" }), Number(m[1]) * 1000);
		await say(`Dejé un trabajo en segundo plano (${taskId}, ${m[1]} s). ${ctx}`);
	} else if (/^mor[ií]\s*$/im.test(body)) {
		await say(`Me muero en reposo. ${ctx}`);
		setTimeout(() => {
			unload(sessionId);
			loaded.delete(sessionId);
			console.error(`[test-agent] session ${sessionId}: Claude Agent process died (simulated)`);
		}, 300);
	} else if (/^turno hu[ée]rfano\s*$/im.test(body)) {
		await say(`Después voy a abrir un turno propio. ${ctx}`);
		later(sessionId, 4_000, () => {
			const taskId = `turn-${randomUUID().slice(0, 8)}`;
			update(sessionId, { sessionUpdate: "async_task_spawned", asyncTaskId: taskId, taskType: "turn", name: "autonomous-turn" });
		});
	} else {
		await say(`Recibido por @${ME}: ${body.split("\n")[0].slice(0, 200)} ${ctx}`);
	}
	return { stopReason: "end_turn" };
}

createInterface({ input: process.stdin }).on("line", async (line) => {
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}
	const { id, method, params } = msg;
	if (!method && waiting.has(id)) {
		const w = waiting.get(id);
		waiting.delete(id);
		return msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result);
	}
	if (id === undefined || !method) return;
	try {
		let result;
		if (method === "initialize")
			result = {
				protocolVersion: 1,
				agentCapabilities: {},
				authMethods: [
					{
						id: "test-login",
						name: "Login de prueba",
						description: "Escribe credenciales de prueba en ~/.claude",
						_meta: { "terminal-auth": { command: process.execPath, args: [new URL(import.meta.url).pathname, "--login"], label: "Login de prueba" } },
					},
				],
				_meta: { jetbrains: { air: { version: 1, capabilities: ["asyncTasks"] } } },
			};
		else if (method === "session/new") {
			const sessionId = randomUUID();
			sessions[sessionId] = { prompts: 0 };
			save();
			load(params, sessionId);
			result = { sessionId, configOptions: configOptions(sessions[sessionId]) };
		} else if (method === "session/resume") {
			if (!sessions[params.sessionId]) throw Object.assign(new Error("unknown session"), { code: -32002 });
			// Like the real adapter: reloading restarts the session — what it left running stops.
			unload(params.sessionId);
			load(params, params.sessionId);
			result = { configOptions: configOptions(sessions[params.sessionId]) };
		} else if (method === "session/close") {
			unload(params.sessionId);
			loaded.delete(params.sessionId);
			result = {};
		} else if (method === "session/set_mode") result = {};
		else if (method === "session/set_config_option" && params.configId === "model") {
			// Like claude-agent-acp: the session's model, kept with the session
			// (it survives a resume), reported back as the option's current value.
			// The effort pin survives only if the new model offers that level.
			const s = sessions[params.sessionId];
			if (!s) throw Object.assign(new Error("unknown session"), { code: -32002 });
			s.model = String(params.value);
			if (s.effort && !levelsOf(s.model).includes(s.effort)) delete s.effort;
			save();
			result = { configOptions: configOptions(s) };
		} else if (method === "session/set_config_option" && params.configId === "effort") {
			const s = sessions[params.sessionId];
			if (!s) throw Object.assign(new Error("unknown session"), { code: -32002 });
			const value = String(params.value);
			if (value !== "default" && !levelsOf(modelOf(s)).includes(value))
				throw Object.assign(new Error(`Invalid value for config option effort: ${value}`), { code: -32602 });
			if (value === "default") delete s.effort;
			else s.effort = value;
			save();
			result = { configOptions: configOptions(s) };
		}
		else if (method === "session/prompt" && existsSync(`${DIR}/require-auth`) && !existsSync(CREDS))
			throw Object.assign(new Error("Authentication required"), { code: -32000 });
		else if (method === "session/prompt" && (!loaded.has(params.sessionId) || existsSync(`${DIR}/lose-sessions`))) {
			// Like claude-agent-acp's startTurn for a session not in its map.
			loaded.delete(params.sessionId);
			throw Object.assign(new Error("Resource not found"), { code: -32002, data: { sessionId: params.sessionId } });
		} else if (method === "session/prompt") result = await prompt(params.sessionId, params.prompt.map((b) => b.text ?? "").join("\n"));
		else throw Object.assign(new Error(`unsupported ${method}`), { code: -32601 });
		out({ id, result });
	} catch (err) {
		out({ id, error: { code: err.code ?? -32603, message: err.message, ...(err.data ? { data: err.data } : {}) } });
	}
});
