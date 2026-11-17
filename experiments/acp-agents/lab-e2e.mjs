#!/usr/bin/env node
// Functional scenarios against a LAB backend with ACP agents (lab-st.sh), through
// the same HTTP API the web Chat uses. Runs on the Docker host (needs `docker`
// for the kill/recreate cases). Node >= 18.
//   ST=http://127.0.0.1:3101 TOKEN_FILE=.tok node lab-e2e.mjs [scenario…]
// Prints one PASS/FAIL line per check and the evidence behind it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const ST = process.env.ST ?? "http://127.0.0.1:3101";
const OAUTH = readFileSync(process.env.TOKEN_FILE, "utf8").trim();
let cookie = "";
let failures = 0;

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const now = () => new Date().toISOString().slice(11, 19);
function check(name, ok, evidence) {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${evidence ? ` — ${evidence}` : ""}`);
}

async function api(method, path, body) {
	const res = await fetch(ST + path, {
		method,
		headers: { "content-type": "application/json", cookie },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const set = res.headers.get("set-cookie");
	if (set) cookie = set.split(";")[0];
	const text = await res.text();
	let json = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {}
	return { status: res.status, body: json ?? text };
}

async function login() {
	const r = await api("POST", "/api/auth/register", { username: "labowner", password: "lab-password-1234" });
	if (r.status >= 300) await api("POST", "/api/auth/login", { username: "labowner", password: "lab-password-1234" });
	if (!cookie) throw new Error(`no auth cookie (${r.status} ${JSON.stringify(r.body)})`);
}

async function agentSession(name) {
	const agents = (await api("GET", "/api/acp/agents")).body;
	const found = agents.find((a) => a.name === name);
	if (found) return found.sessionId;
	const r = await api("POST", "/api/sessions", {
		name: `agent-${name}`,
		config: { envVars: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", type: "secret", value: OAUTH }] },
		acpAgent: { name },
	});
	if (r.status !== 201) throw new Error(`create ${name}: ${r.status} ${JSON.stringify(r.body)}`);
	return r.body.sessionId;
}

const send = async (to, body) => {
	const r = await api("POST", "/api/acp/messages", { to, body });
	if (r.status !== 201) throw new Error(`send: ${r.status} ${JSON.stringify(r.body)}`);
	return r.body;
};
const get = async (id) => (await api("GET", `/api/acp/messages/${id}`)).body;
async function waitFor(id, states = ["done", "uncertain", "failed"], ms = 240_000) {
	const end = Date.now() + ms;
	for (;;) {
		const m = await get(id);
		if (states.includes(m.state) || Date.now() > end) return m;
		await sleep(2_000);
	}
}
const all = async () => (await api("GET", "/api/acp/messages")).body;
const shell = (args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const inAgent = (sid, cmd) => shell(["exec", `st-${sid.slice(0, 12)}`, "bash", "-lc", cmd]);
const short = (s, n = 90) => (s ?? "").replace(/\s+/g, " ").slice(0, n);

// ── Scenarios ─────────────────────────────────────────────────────────────

const scenarios = {
	async chat() {
		const m = await send("developer", "Respondé exactamente: HOLA-ACP");
		check("send: persisted before ack", m.state === "pending" && m.id > 0, `#${m.id} ${m.state}`);
		const done = await waitFor(m.id);
		check("reply from the chat", done.state === "done" && /HOLA-ACP/.test(done.result_text ?? ""), `#${m.id} ${done.state}: ${short(done.result_text)}`);
	},

	async collab() {
		const m = await send(
			"arquitecto",
			"Necesitamos slugify(texto) en Python. No la escribas vos: pedile a @developer que la implemente en su workspace (slugify.py con un test mínimo que ejecute) e incluya el código en su respuesta. Después de enviar el pedido terminá tu turno. Cuando recibas su respuesta, revisala y contestá en una línea: APROBADO o RECHAZADO y el motivo.",
		);
		await waitFor(m.id);
		const end = Date.now() + 300_000;
		let reply;
		while (Date.now() < end) {
			reply = (await all()).find((x) => x.kind === "reply" && x.to_id === "arquitecto" && x.id > m.id);
			if (reply && ["done", "uncertain", "failed"].includes(reply.state)) break;
			await sleep(3_000);
		}
		const msgs = (await all()).filter((x) => x.id >= m.id);
		const req = msgs.find((x) => x.from_id === "arquitecto" && x.to_id === "developer");
		check("agent → agent via st send", Boolean(req), req && `#${req.id} @arquitecto→@developer ${req.state}`);
		check("automatic reply from the ACP result", reply?.reply_to === req?.id, reply && `#${reply.id} reply to #${reply.reply_to}`);
		check("arquitecto continues on the reply", reply?.state === "done" && /APROBADO|RECHAZADO/.test(reply?.result_text ?? ""), short(reply?.result_text));
	},

	async background() {
		const m = await send(
			"developer",
			"Con Bash, en segundo plano (run_in_background: true): python3 -c \"import time; time.sleep(20)\" && echo bg-fin >> bg.txt. No esperes: terminá tu turno ahora respondiendo LANZADO. Cuando te llegue la notificación de que terminó, verificá bg.txt y respondé exactamente: BG-LISTO",
		);
		const after = await send("developer", "Respondé exactamente: DESPUES-BG");
		await sleep(12_000);
		const mid = await get(m.id);
		const afterMid = await get(after.id);
		check("turn answered, background open ⇒ still running", mid.state === "running" && afterMid.state === "pending", `#${m.id} ${mid.state}, #${after.id} ${afterMid.state}`);
		const done = await waitFor(m.id);
		check("done only after the task and Claude's own turn", done.state === "done" && /BG-LISTO/.test(done.result_text ?? ""), `${short(done.result_text)} | ${short(done.note, 160)}`);
		const a = await waitFor(after.id);
		check("queued message after it", a.state === "done" && a.started_at >= done.finished_at, `#${after.id} started ${a.started_at?.slice(11, 19)} ≥ ${done.finished_at?.slice(11, 19)}`);
	},

	async persistent() {
		const m = await send(
			"developer",
			"Iniciá en segundo plano (run_in_background: true) un servidor HTTP: python3 -m http.server 8765 --directory /tmp. Verificá con curl que responde y terminá. Es un proceso que debe quedar corriendo.",
		);
		const done = await waitFor(m.id, undefined, 180_000);
		check("server started, message done", done.state === "done" && /persistent/.test(done.note ?? ""), `${done.state} | ${short(done.note, 160)}`);
		const t0 = Date.now();
		const next = await send("developer", "Con Bash: curl -s -o /dev/null -w '%{http_code}' localhost:8765 y respondé solo el código.");
		const n = await waitFor(next.id, undefined, 120_000);
		check("next message not blocked by the server", n.state === "done" && /200/.test(n.result_text ?? ""), `${short(n.result_text)} in ${Math.round((Date.now() - t0) / 1000)}s`);
	},

	async longmsg() {
		const lines = [];
		for (let i = 0; i < 2500; i++) lines.push(`línea ${i}: ${"x".repeat(30)} \`código\` ${i % 7 === 0 ? "\t" : ""}`);
		const body = `Mensaje largo de prueba. Más abajo hay un bloque de código.\n\n\`\`\`js\nfunction f(a, b) {\n\treturn a + b; // ${"ñ".repeat(10)}\n}\n\`\`\`\n\n${lines.join("\n")}\nTOKEN-FINAL-7Q2\n\nRespondé solo con el texto de la última línea que empieza con TOKEN-FINAL y la cantidad de líneas que empiezan con "línea".`;
		const m = await send("developer", body);
		const stored = await get(m.id);
		const h = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
		check("long message stored byte-exact", stored.body === body, `${Buffer.byteLength(body)} bytes, sha ${h(body)} = ${h(stored.body)}`);
		const done = await waitFor(m.id);
		check("agent read it whole", /TOKEN-FINAL-7Q2/.test(done.result_text ?? "") && /2500/.test(done.result_text ?? ""), short(done.result_text));
		const big = await api("POST", "/api/acp/messages", { to: "developer", body: "y".repeat(300 * 1024) });
		check("over the limit ⇒ 413 (UI sends it as an attachment)", big.status === 413, JSON.stringify(big.body));
	},

	async busy() {
		const m1 = await send("developer", 'Con Bash, en primer plano: python3 -c "import time; time.sleep(30)" && echo uno >> orden.txt. Respondé UNO.');
		await sleep(5_000);
		const sent = [];
		for (const k of ["DOS", "TRES", "CUATRO"]) {
			const t = Date.now();
			const r = await send("developer", `Con Bash: echo ${k.toLowerCase()} >> orden.txt. Respondé ${k}.`);
			sent.push({ ...r, ms: Date.now() - t });
		}
		const mid = await Promise.all(sent.map((s) => get(s.id)));
		check("messages accepted while busy", sent.every((s) => s.ms < 2_000) && mid.every((x) => x.state === "pending"), sent.map((s) => `#${s.id} ${s.ms}ms`).join(", "));
		const done = [await waitFor(m1.id), ...(await Promise.all(sent.map((s) => waitFor(s.id))))];
		const ordered = done.every((d, i) => i === 0 || d.started_at >= done[i - 1].finished_at);
		check("processed one by one, in order", done.every((d) => d.state === "done") && ordered, done.map((d) => `#${d.id} ${d.started_at?.slice(11, 19)}→${d.finished_at?.slice(11, 19)}`).join(" "));
	},

	async quietturn() {
		const m = await send(
			"developer",
			"Con Bash, en segundo plano (run_in_background: true): python3 -c \"import time; time.sleep(5)\". Terminá tu turno ya respondiendo LANZADO-Q. Cuando te llegue la notificación de que terminó, ejecutá EN PRIMER PLANO (sin run_in_background) python3 -c \"import time; time.sleep(35)\" y recién después respondé exactamente: LISTO-Q",
		);
		const next = await send("developer", "Respondé exactamente: DESPUES-Q");
		const done = await waitFor(m.id);
		const n = await waitFor(next.id);
		check("legit quiet turn (>15 s) not taken for finished", done.state === "done" && /LISTO-Q/.test(done.result_text ?? "") && n.started_at >= done.finished_at, `#${m.id} ${short(done.result_text)}; #${next.id} started ${n.started_at?.slice(11, 19)} ≥ ${done.finished_at?.slice(11, 19)}`);
	},

	async interrupted() {
		const sid = (await api("GET", "/api/acp/agents")).body.find((a) => a.name === "developer").sessionId;
		inAgent(sid, "rm -f ~/workspace/efectos.txt");
		const m = await send("developer", 'Con Bash, en primer plano: echo inicio >> efectos.txt && python3 -c "import time; time.sleep(40)" && echo fin >> efectos.txt. Respondé HECHO.');
		const queued = await send("developer", "Respondé exactamente: DESPUES-CAIDA");
		await sleep(15_000);
		console.log(`  ${now()} docker kill st-${sid.slice(0, 12)}`);
		shell(["kill", `st-${sid.slice(0, 12)}`]);
		const st = await api("POST", `/api/sessions/${sid}/start`);
		console.log(`  ${now()} POST /start → ${st.status}`);
		const r = await waitFor(m.id, ["uncertain", "done", "failed"], 120_000);
		check("interrupted run ⇒ uncertain, not resent", r.state === "uncertain" && r.attempts === 1, `#${m.id} ${r.state} attempts=${r.attempts} | ${short(r.note, 160)}`);
		// The runner creates it after its startup window (~3 s after the resume).
		let sys;
		for (let i = 0; i < 30 && !sys; i++) {
			sys = (await all()).find((x) => x.from_id === "system" && x.id > queued.id);
			if (!sys) await sleep(2_000);
		}
		const s = sys && (await waitFor(sys.id));
		check("controlled continuation (system message) answered", s?.state === "done", s && `#${s.id}: ${short(s.result_text, 160)}`);
		const q = await waitFor(queued.id);
		check("pending message survived and ran after", q.state === "done" && /DESPUES-CAIDA/.test(q.result_text ?? ""), `#${queued.id} ${q.state}`);
		const eff = inAgent(sid, "cat ~/workspace/efectos.txt");
		check("no repetition of effects", eff === "inicio", JSON.stringify(eff));
	},

	async recreate() {
		const sid = (await api("GET", "/api/acp/agents")).body.find((a) => a.name === "developer").sessionId;
		const before = shell(["inspect", "-f", "{{.Id}}", `st-${sid.slice(0, 12)}`]).slice(0, 12);
		const del = await api("DELETE", `/api/sessions/${sid}`);
		const st = await api("POST", `/api/sessions/${sid}/start`);
		const after = shell(["inspect", "-f", "{{.Id}}", `st-${sid.slice(0, 12)}`]).slice(0, 12);
		console.log(`  container ${before} → ${after} (DELETE ${del.status}, /start ${st.status})`);
		const m = await send("developer", "Sin herramientas, respondé de memoria en una línea: qué función te pidió implementar @arquitecto y qué contenía el mensaje largo al final (el token).");
		const r = await waitFor(m.id);
		check("context survives a new container", before !== after && r.state === "done" && /slugify/i.test(r.result_text ?? "") && /TOKEN-FINAL-7Q2/.test(r.result_text ?? ""), short(r.result_text, 200));
	},
};

await login();
await agentSession("developer");
await agentSession("arquitecto");
for (let i = 0; i < 90; i++) {
	const agents = (await api("GET", "/api/acp/agents")).body;
	if (agents.every((a) => a.runnerSeenAt)) break;
	await sleep(2_000);
}
const which = process.argv.slice(2);
for (const name of which.length ? which : Object.keys(scenarios)) {
	console.log(`\n== ${name} (${now()})`);
	try {
		await scenarios[name]();
	} catch (err) {
		check(name, false, err.message);
	}
}
console.log(`\n${failures ? `${failures} FAILED` : "ALL PASS"}`);
process.exit(failures ? 1 : 0);
