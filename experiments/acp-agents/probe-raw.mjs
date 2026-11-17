#!/usr/bin/env node
// Raw ACP probe (no SDK): what does the adapter actually send around a backgrounded
// command? Prints every session/update kind with a timestamp, for 70 s after the
// prompt answer. Usage: node probe-raw.mjs "<prompt>"
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const t0 = Date.now();
const p = spawn(process.env.ACP_AGENT_CMD, [], { stdio: ["pipe", "pipe", "ignore"] });
let id = 0;
const pending = new Map();
const send = (method, params) =>
	new Promise((ok) => {
		pending.set(++id, ok);
		p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	});
const out = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6), ...a);
createInterface({ input: p.stdout }).on("line", (line) => {
	const m = JSON.parse(line);
	if (m.id !== undefined && !m.method) return pending.get(m.id)?.(m.result ?? m.error);
	if (m.method === "session/update") {
		const u = m.params.update;
		const extra =
			u.sessionUpdate.startsWith("async_task") ? JSON.stringify({ ...u, sessionUpdate: undefined })
			: u.sessionUpdate === "agent_message_chunk" ? JSON.stringify(u.content?.text)
			: u._meta?.jetbrains ? JSON.stringify(u._meta.jetbrains)
			: "";
		return out(u.sessionUpdate, extra.slice(0, 220));
	}
	if (m.method === "session/request_permission") {
		p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: m.params.options[0].optionId } } })}\n`);
	}
	out("method", m.method);
});

const init = await send("initialize", {
	protocolVersion: 1,
	clientCapabilities: { _meta: { jetbrains: { air: { version: 1, capabilities: ["asyncTasks"] } } } },
});
out("init AIR:", JSON.stringify(init._meta?.jetbrains?.air?.capabilities));
const { sessionId } = await send("session/new", { cwd: process.env.AGENT_CWD, mcpServers: [] });
out("session", sessionId);
const r = await send("session/prompt", { sessionId, prompt: [{ type: "text", text: process.argv[2] }] });
out("PROMPT ANSWERED", JSON.stringify(r).slice(0, 120));
if (process.argv[3] === "kill") {
	// Interruption: SIGTERM the adapter while the background task runs, then watch.
	setTimeout(() => {
		out("SIGTERM adapter");
		p.kill("SIGTERM");
	}, 5_000);
	p.on("exit", (c, s) => out("adapter exit", c, s));
}
setTimeout(() => {
	p.kill();
	process.exit(0);
}, Number(process.env.WAIT_MS ?? 70_000));
