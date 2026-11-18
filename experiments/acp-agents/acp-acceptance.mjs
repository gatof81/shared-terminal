#!/usr/bin/env node
// End-to-end acceptance of ACP agents + Project Chat, through the same HTTP
// API the web uses, against a REAL Shared Terminal (lab or production). Agents
// run the deterministic test adapter (runtime `st-test-agent`, backend with
// ACP_TEST_RUNTIME=1): no model, no credentials; everything else is real —
// session containers, runner, `st` CLI, D1 store, recovery.
//
// No browser is open during the run: agents work with the web closed.
//
//   ST=https://api.example MINT_CMD='…prints a short-lived owner token…' node acp-acceptance.mjs
//   ST=http://127.0.0.1:3101 LAB_LOGIN=1 node acp-acceptance.mjs        (lab: registers labowner)
// Optional: PREFIX (default "t<4 hex>"), KEEP=1 keeps the test sessions and project.
// Prints one PASS/FAIL line per check; exit 1 on any failure.
import { execSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const ST = process.env.ST ?? "http://127.0.0.1:3101";
const PREFIX = process.env.PREFIX ?? `t${randomBytes(2).toString("hex")}`;
const ARQ = `${PREFIX}-arq`;
const DEV = `${PREFIX}-dev`;
let cookie = "";
let mintedAt = 0;
let failures = 0;
const created = { sessions: [], project: null };

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
function check(name, ok, evidence) {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"} [${at()}] ${name}${evidence ? ` — ${evidence}` : ""}`);
	return ok;
}

async function auth() {
	if (process.env.MINT_CMD) {
		if (Date.now() - mintedAt < 60_000) return;
		cookie = `st_token=${execSync(process.env.MINT_CMD, { encoding: "utf8" }).trim()}`;
		mintedAt = Date.now();
		return;
	}
	if (cookie) return;
	const body = JSON.stringify({ username: "labowner", password: "lab-password-1234" });
	for (const path of ["/api/auth/register", "/api/auth/login"]) {
		const r = await fetch(ST + path, { method: "POST", headers: { "content-type": "application/json" }, body });
		const set = r.headers.get("set-cookie");
		if (set) {
			cookie = set.split(";")[0];
			return;
		}
	}
	throw new Error("no lab login");
}

async function api(method, path, body) {
	await auth();
	const res = await fetch(ST + path, {
		method,
		headers: { "content-type": "application/json", cookie, origin: process.env.ORIGIN ?? "" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let json = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {}
	return { status: res.status, body: json ?? text };
}

const send = async (to, body, projectId) => {
	const r = await api("POST", "/api/acp/messages", {
		to,
		body,
		...(projectId ? { projectId } : {}),
		clientId: randomUUID(),
	});
	if (r.status !== 201) throw new Error(`send ${to}: ${r.status} ${JSON.stringify(r.body)}`);
	return r.body;
};
const get = async (id) => (await api("GET", `/api/acp/messages/${id}`)).body;
async function waitMsg(id, states = ["done", "uncertain", "failed"], ms = 120_000) {
	const end = Date.now() + ms;
	for (;;) {
		const m = await get(id);
		if (states.includes(m.state) || Date.now() > end) return m;
		await sleep(1_000);
	}
}
async function waitFor(what, fn, ms = 120_000) {
	const end = Date.now() + ms;
	for (;;) {
		const v = await fn();
		if (v || Date.now() > end) return v;
		await sleep(1_500);
	}
}
const agents = async () => (await api("GET", "/api/acp/agents")).body;
const agentFeed = async (n) => (await api("GET", `/api/acp/agents/${n}/feed`)).body;
const projectFeed = async (pid) => (await api("GET", `/api/acp/projects/${pid}/feed`)).body;
const short = (s, n = 110) => (s ?? "").replace(/\s+/g, " ").slice(0, n);
const runnerOnline = async (name) =>
	(await agents()).find((a) => a.name === name && a.runnerSeenAt && Date.now() - Date.parse(a.runnerSeenAt) < 15_000);
const sessionStatus = async (sid) => (await api("GET", `/api/sessions/${sid}`)).body?.status;

async function main() {
	console.log(`ACP acceptance against ${ST} — agents @${ARQ}, @${DEV}`);
	const rt = await api("GET", "/api/acp/runtimes");
	if (!check("runtime st-test-agent installed", rt.body?.available?.includes("st-test-agent"), JSON.stringify(rt.body)))
		return;

	// 1. A project and two ACP sessions in it.
	const p = await api("POST", "/api/projects", { name: `Aceptación ACP ${PREFIX}`, clientRequestId: randomUUID() });
	check("project created", p.status === 201, `${p.status} ${p.body?.projectId ?? JSON.stringify(p.body)}`);
	const pid = p.body.projectId;
	created.project = pid;
	const sids = {};
	for (const name of [ARQ, DEV]) {
		const r = await api("POST", "/api/sessions", {
			name: `acp ${name}`,
			acpAgent: { name, runtime: "st-test-agent", projectId: pid },
		});
		check(`session with agent @${name} created in the project`, r.status === 201, `${r.status} ${r.body?.sessionId ?? JSON.stringify(r.body)}`);
		sids[name] = r.body.sessionId;
		created.sessions.push(r.body.sessionId);
	}
	for (const name of [ARQ, DEV])
		check(`runner of @${name} online`, !!(await waitFor(`runner ${name}`, () => runnerOnline(name), 90_000)));
	const pf0 = await projectFeed(pid);
	check("Project Chat lists both agents", JSON.stringify(pf0.agents.map((a) => a.name).sort()) === JSON.stringify([ARQ, DEV].sort()));

	// 2. Project Chat → @arq, who consults @dev (st send) and gets the answer.
	const m1 = await send(ARQ, `@${ARQ} consultá a @${DEV}: ¿qué versión de Node hay en tu sesión?`, pid);
	check("Project Chat message persisted at once (pending, project scope)", m1.state === "pending" && m1.project_id === pid);
	const d1 = await waitMsg(m1.id);
	check("@arq finished its turn", d1.state === "done", short(d1.result_text));
	const consult = await waitFor("consult", async () =>
		(await projectFeed(pid)).messages.find((m) => m.from_id === ARQ && m.to_id === DEV && m.kind === "request"),
	);
	check("@arq's consult to @dev is in Project Chat (st send, depth 1)", !!consult && consult.depth === 1, consult && `#${consult.id}`);
	const c2 = consult && (await waitMsg(consult.id));
	check("@dev answered the consult", c2?.state === "done", short(c2?.result_text));
	const reply = await waitFor("reply", async () =>
		(await projectFeed(pid)).messages.find((m) => m.kind === "reply" && m.reply_to === consult?.id),
	);
	check("the answer came back to @arq as a reply correlated to the consult, in Project Chat", !!reply && reply.to_id === ARQ && reply.project_id === pid);
	const r2 = reply && (await waitMsg(reply.id));
	check("@arq processed the answer", r2?.state === "done" && /Recibí la respuesta de @/.test(r2?.result_text ?? ""), short(r2?.result_text));
	const loopFree = await waitFor("no loop", async () => {
		await sleep(4_000);
		const ms = (await projectFeed(pid)).messages;
		return ms.every((m) => m.state === "done") && !ms.some((m) => m.kind === "reply" && m.reply_to === reply?.id) ? ms : null;
	}, 30_000);
	check("the exchange ended by itself (no reply to a reply)", !!loopFree, loopFree && `${loopFree.length} messages in Project Chat`);

	// 3. Individual chat: a direct message stays private.
	const dm = await send(DEV, "Mensaje directo: decime algo corto.");
	const dmd = await waitMsg(dm.id);
	check("direct message answered", dmd.state === "done" && dmd.project_id === null, short(dmd.result_text));
	check("…and it is not in Project Chat", !(await projectFeed(pid)).messages.some((m) => m.id === dm.id));
	check("…but it is in @dev's individual chat", (await agentFeed(DEV)).messages.some((m) => m.id === dm.id));

	// 4. Sending while busy: never blocked, processed in order.
	const long = await send(DEV, "esperá 12", pid);
	await waitMsg(long.id, ["running"], 30_000);
	const code = `Varias líneas y código:\n\n\`\`\`js\nconst x = ${JSON.stringify("ü€".repeat(10))};\n${"// relleno\n".repeat(9000)}\`\`\`\nfin`;
	const qs = [];
	for (const body of ["primero en cola", code, "tercero en cola"]) {
		const s = Date.now();
		qs.push(await send(DEV, body, pid));
		check(`sent while @dev is busy, accepted in ${Date.now() - s} ms`, qs.at(-1).state === "pending");
	}
	const big = await get(qs[1].id);
	const h = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
	check(`long multi-line message with code kept byte-identical (${Buffer.byteLength(code)} bytes)`, h(big.body) === h(code), h(big.body));
	const doneQ = [];
	for (const q of [long, ...qs]) doneQ.push(await waitMsg(q.id));
	check("queued messages all done", doneQ.every((m) => m.state === "done"), doneQ.map((m) => m.state).join(","));
	const order = doneQ.map((m) => Date.parse(m.started_at));
	check("…in the order they were sent", order.every((v, i) => i === 0 || v >= order[i - 1]));

	// 5. Background work: no false completion.
	const bg = await send(ARQ, "segundo plano 10", pid);
	await sleep(6_000);
	const bgMid = await get(bg.id);
	check("a message whose background task is still open stays running", bgMid.state === "running", bgMid.state);
	const bgEnd = await waitMsg(bg.id);
	check("…and is done when the task ends", bgEnd.state === "done", `${(Date.parse(bgEnd.finished_at) - Date.parse(bgEnd.started_at)) / 1000}s`);

	// 6. Restart while working: pending survives, the interrupted one is uncertain and NOT repeated.
	const before = await agentFeed(ARQ);
	const countBefore = Number(/sesión ACP: (\d+)/.exec(before.messages.filter((m) => m.result_text).at(-1)?.result_text ?? "")?.[1] ?? 0);
	const work = await send(ARQ, "esperá 60", pid);
	await waitMsg(work.id, ["running"], 30_000);
	const p1 = await send(ARQ, "pendiente 1 tras el reinicio", pid);
	const p2 = await send(ARQ, "pendiente 2 tras el reinicio", pid);
	const stop = await api("POST", `/api/sessions/${sids[ARQ]}/stop`);
	check("session of @arq stopped mid-turn", stop.status < 300, String(stop.status));
	const st = await api("POST", `/api/sessions/${sids[ARQ]}/start`);
	check("session of @arq started again", st.status < 300, String(st.status));
	const unc = await waitMsg(work.id, ["uncertain", "failed", "done"], 120_000);
	check("the interrupted message is uncertain", unc.state === "uncertain", short(unc.note));
	const recov = await waitFor("recovery", async () =>
		(await agentFeed(ARQ)).messages.find((m) => m.from_id === "system" && m.id > work.id && m.state === "done"),
	);
	check("Shared Terminal asked @arq for a read-only report (no redo)", !!recov, short(recov?.result_text));
	const pp = [await waitMsg(p1.id), await waitMsg(p2.id)];
	check("pending messages survived the restart and ran", pp.every((m) => m.state === "done" && m.attempts === 1), pp.map((m) => `${m.state}/${m.attempts}`).join(" "));
	await sleep(3_000);
	const again = await get(work.id);
	check("the uncertain message was not run again", again.state === "uncertain" && again.attempts === 1, `${again.state} attempts=${again.attempts}`);
	const countAfter = Number(/sesión ACP: (\d+)/.exec(pp[1].result_text ?? "")?.[1] ?? 0);
	check("ACP context kept across the container restart (same ACP session)", countAfter > countBefore, `${countBefore} → ${countAfter} prompts`);

	// 6c. Questions (ACP elicitation): asked, visible after any "browser close", answered once, delivered once.
	const openQ = async (msgId) =>
		(await projectFeed(pid)).questions?.find((q) => q.message_id === msgId && q.state === "open");
	const ask1 = await send(ARQ, "preguntá: ¿Qué base de datos usamos? | SQLite | Postgres", pid);
	const q1 = await waitFor("question", () => openQ(ask1.id), 60_000);
	check("the agent's question is registered and shown in Project Chat (open)", !!q1, q1 && `#${q1.id}`);
	check("…the agent shows as waiting for the person", (await agents()).find((a) => a.name === ARQ)?.waitingInput === true);
	check("…the message stays running while it waits", (await get(ask1.id)).state === "running");
	await sleep(8_000); // nobody looking: the question just waits, durable
	check("…still open after a while with no browser", (await openQ(ask1.id))?.id === q1?.id);
	const byAgent = await fetch(`${ST}/api/acp/questions/${q1?.id}/answer`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer acp1.x.y" }, body: "{}" });
	check("an agent's token cannot answer the person's question", byAgent.status === 401 || byAgent.status === 403, String(byAgent.status));
	const ans = await api("POST", `/api/acp/questions/${q1?.id}/answer`, { action: "accept", content: { question_0: "Postgres" } });
	const dup = await api("POST", `/api/acp/questions/${q1?.id}/answer`, { action: "accept", content: { question_0: "SQLite" } });
	check("answered once; a second answer is refused", ans.status === 200 && dup.status === 409, `${ans.status} ${dup.status}`);
	const a1 = await waitMsg(ask1.id);
	check("the agent got the answer in the same turn and continued", a1.state === "done" && /Elegiste: Postgres/.test(a1.result_text ?? ""), short(a1.result_text));
	const q1d = (await projectFeed(pid)).questions.find((q) => q.id === q1?.id);
	check("…the question reads delivered", q1d?.state === "delivered");

	// 6d. Restart during a question: no false answer, no duplicate run.
	const ask2 = await send(ARQ, "preguntá: ¿Deployamos hoy? | sí | no", pid);
	const q2 = await waitFor("question 2", () => openQ(ask2.id), 60_000);
	await api("POST", `/api/sessions/${sids[ARQ]}/stop`);
	await api("POST", `/api/sessions/${sids[ARQ]}/start`);
	const u2 = await waitMsg(ask2.id, ["uncertain", "failed", "done"], 120_000);
	check("the message interrupted during the question is uncertain, not done", u2.state === "uncertain", short(u2.note));
	const q2o = await waitFor("orphaned", async () => (await projectFeed(pid)).questions.find((q) => q.id === q2?.id && q.state === "orphaned"), 60_000);
	check("the question is marked 'not delivered' (orphaned), never answered", !!q2o, short(q2o?.note));
	const late = await api("POST", `/api/acp/questions/${q2?.id}/answer`, { action: "accept", content: { question_0: "sí" } });
	check("answering it afterwards is refused (nothing to deliver to)", late.status === 409, JSON.stringify(late.body));
	await sleep(5_000);
	const u2b = await get(ask2.id);
	check("the interrupted message was not run again", u2b.state === "uncertain" && u2b.attempts === 1, `${u2b.state}/${u2b.attempts}`);

	// 6e. Login: an agent that needs credentials waits ("esperando login"), "Conectar cuenta" runs the adapter's
	// own advertised login in a terminal tab of the session, and the agent resumes by itself — same session,
	// same ACP context, nothing recreated.
	const execIn = async (sid, cmd) => {
		const r = await fetch(`${ST}/api/sessions/${sid}/exec`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({ cmd }),
		});
		return (await r.text()).includes('"exit"');
	};
	const taDir = "/home/developer/workspace/.st/acp/test-agent";
	check("test agent set to require credentials (none present)", await execIn(sids[DEV], ["sh", "-c", `mkdir -p ${taDir} && touch ${taDir}/require-auth && rm -f $HOME/.claude/.credentials.json`]));
	const needs = await send(DEV, "¿estás conectado?", pid);
	const waiting = await waitFor("auth required", async () => (await agents()).find((a) => a.name === DEV && a.authRequired), 60_000);
	check("the agent reports it needs a login; the message waits (not failed, not uncertain)", !!waiting && (await get(needs.id)).state !== "uncertain", waiting && JSON.stringify(waiting.loginMethods));
	const ctxBefore = Number(/sesión ACP: (\d+)/.exec((await agentFeed(DEV)).messages.filter((m) => m.result_text).at(-1)?.result_text ?? "")?.[1] ?? 0);
	const method = waiting?.loginMethods?.[0]?.id;
	const login = await api("POST", `/api/acp/agents/${DEV}/login`, { methodId: method });
	check("Conectar cuenta opens a terminal tab running the adapter's login", login.status === 201 && /^tab-/.test(login.body?.tabId ?? ""), JSON.stringify(login.body));
	const resumed = await waitMsg(needs.id, ["done", "uncertain", "failed"], 120_000);
	check("after the login the agent resumes by itself and answers the waiting message", resumed.state === "done" && resumed.attempts >= 1, short(resumed.result_text));
	const ctxAfter = Number(/sesión ACP: (\d+)/.exec(resumed.result_text ?? "")?.[1] ?? 0);
	check("same ACP session (context kept) across the adapter restart", ctxAfter > ctxBefore, `${ctxBefore} → ${ctxAfter}`);
	check("the agent no longer reports a missing login", !(await agents()).find((a) => a.name === DEV)?.authRequired);
	await execIn(sids[DEV], ["sh", "-c", `rm -f ${taDir}/require-auth`]);

	// 6b. Backend restart (RESTART_CMD): queued messages are D1 rows; runners retry until it is back.
	if (process.env.RESTART_CMD) {
		const busy = await send(DEV, "esperá 8", pid);
		await waitMsg(busy.id, ["running"], 30_000);
		const queued = [await send(DEV, "en cola durante el reinicio 1", pid), await send(DEV, "en cola durante el reinicio 2", pid)];
		execSync(process.env.RESTART_CMD, { stdio: "ignore" });
		check("backend restarted", !!(await waitFor("backend up", async () => (await fetch(`${ST}/api/auth/status`).catch(() => null))?.ok, 120_000)));
		const after = [await waitMsg(busy.id), ...(await Promise.all(queued.map((q) => waitMsg(q.id))))];
		check("the running message and the queue survived the backend restart, each once", after.every((m) => m.state === "done" && m.attempts === 1), after.map((m) => `${m.state}/${m.attempts}`).join(" "));
	}

	// 7. Terminal, Files and Git of the same agent session still answer.
	const sid = sids[DEV];
	check("Files: list answers", (await api("GET", `/api/sessions/${sid}/fs/list?path=`)).status === 200);
	check("Git: status answers", (await api("GET", `/api/sessions/${sid}/git/status`)).status === 200);
	check("session still running", (await sessionStatus(sid)) === "running");
	check("runner of @dev online after everything", !!(await runnerOnline(DEV)));

	if (process.env.KEEP !== "1") {
		for (const s of created.sessions) {
			const d = await api("DELETE", `/api/sessions/${s}?hard=true`);
			check(`test session ${s.slice(0, 8)} removed`, d.status < 300, String(d.status));
		}
	} else console.log(`kept: project ${pid}, sessions ${created.sessions.join(" ")}`);
}

main()
	.catch((err) => {
		failures++;
		console.log(`FAIL [${at()}] aborted: ${err.message}`);
	})
	.finally(() => {
		console.log(failures ? `${failures} FAILED` : "ALL PASS");
		process.exit(failures ? 1 : 0);
	});
