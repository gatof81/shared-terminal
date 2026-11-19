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
//   esperá <N>               → a tool call that takes N seconds
//   segundo plano <N>        → an async task that ends N seconds after the turn
//   preguntá: <q> | a | b    → asks the person (ACP elicitation/create, the form
//                              claude-agent-acp makes of AskUserQuestion) and
//                              continues with the answer
//   anything else            → an echo of the first line
// A reply from another agent ("Respuesta de @x a tu mensaje #n: …") is
// acknowledged. Every answer carries how many prompts this ACP session has
// seen and the session's model — the session (count and model) survives runner
// and container restarts, which is what the tests check continuity with.
import { execFile } from "node:child_process";
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
const FILE = `${DIR}/sessions.json`;
mkdirSync(DIR, { recursive: true });
const sessions = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
const save = () => {
	writeFileSync(`${FILE}.tmp`, JSON.stringify(sessions));
	renameSync(`${FILE}.tmp`, FILE);
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
	const ctx = `(sesión ACP: ${s.prompts} mensajes · modelo ${s.model ?? process.env.ANTHROPIC_MODEL ?? "default"})`;
	let m;
	if (/^\[st-recovery\]/.test(header) || /^\[st-recovery\]/.test(body) || header.includes("de @system")) {
		await say(`Reporte de @${ME}: no repetí nada; el mensaje interrumpido quedó sin rehacer. ${ctx}`);
	} else if ((m = /^Respuesta de @([a-z][a-z0-9-]*) a tu mensaje #(\d+):\s*([\s\S]*)$/.exec(body))) {
		await say(`Recibí la respuesta de @${m[1]} a #${m[2]}: «${m[3].trim().split("\n")[0].slice(0, 160)}» ${ctx}`);
	} else if ((m = /consult[aá] a @([a-z][a-z0-9-]*):\s*([\s\S]+)$/i.exec(body))) {
		const id = `t${++tool}`;
		update(sessionId, { sessionUpdate: "tool_call", toolCallId: id, title: `st send @${m[1]}`, kind: "execute", status: "pending" });
		const result = await new Promise((resolve) =>
			execFile("st", ["send", `@${m[1]}`, m[2].trim()], { timeout: 30_000 }, (err, stdout, stderr) =>
				resolve(err ? `error: ${stderr || err.message}` : stdout.trim()),
			),
		);
		update(sessionId, {
			sessionUpdate: "tool_call_update",
			toolCallId: id,
			status: result.startsWith("error") ? "failed" : "completed",
			rawInput: { command: `st send @${m[1]} …` },
		});
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
			result = { sessionId };
		} else if (method === "session/resume") {
			if (!sessions[params.sessionId]) throw Object.assign(new Error("unknown session"), { code: -32002 });
			result = {};
		} else if (method === "session/set_mode") result = {};
		else if (method === "session/set_config_option" && params.configId === "model") {
			// Like claude-agent-acp: the session's model, kept with the session
			// (it survives a resume), reported back as the option's current value.
			if (!sessions[params.sessionId]) throw Object.assign(new Error("unknown session"), { code: -32002 });
			sessions[params.sessionId].model = String(params.value);
			save();
			result = { configOptions: [{ id: "model", type: "select", currentValue: String(params.value), options: [] }] };
		}
		else if (method === "session/prompt" && existsSync(`${DIR}/require-auth`) && !existsSync(CREDS))
			throw Object.assign(new Error("Authentication required"), { code: -32000 });
		else if (method === "session/prompt") result = await prompt(params.sessionId, params.prompt.map((b) => b.text ?? "").join("\n"));
		else throw Object.assign(new Error(`unsupported ${method}`), { code: -32601 });
		out({ id, result });
	} catch (err) {
		out({ id, error: { code: err.code ?? -32603, message: err.message } });
	}
});
