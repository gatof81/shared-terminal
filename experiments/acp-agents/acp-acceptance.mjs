#!/usr/bin/env node
// End-to-end acceptance of ACP agents + project conversations, through the same HTTP
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

// The project's conversation the scenario posts in (v27); `inProject` = post there.
let CONV = null;
const send = async (to, body, inProject, work, conversationId = CONV) => {
	const r = await api("POST", "/api/acp/messages", {
		to,
		body,
		...(inProject ? { conversationId } : {}),
		...(work ? { work } : {}),
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
// `running` is the claim, not the prompt: between the two the runner may still open the
// message's ACP session (a switch of topic or work) and apply model/effort. A stop in that
// window is a message never sent to the agent, which recovery rightly puts back to
// pending (a second, complete attempt). A step that interrupts a TURN waits for the
// runner's own `turn`/`start` activity event of that message instead: the runner records
// the prompt in the message's log (what recovery reads) synchronously before emitting it.
const waitTurnStarted = (n, id, ms = 30_000) =>
	waitFor(`turn of #${id}`, async () => (await agentFeed(n)).activity?.[n]?.some((e) => e.kind === "turn" && e.phase === "start" && e.messageId === id), ms);
const projectFeed = async (pid) => (await api("GET", `/api/acp/projects/${pid}/feed`)).body;
const convFeed = async (id = CONV) => (await api("GET", `/api/acp/conversations/${id}/feed`)).body;
// Everything to or from an agent, any conversation (the Archive feed shows none of them).
const msgsOf = async (n) => ({ messages: (await api("GET", `/api/acp/messages?agent=${n}`)).body });
// The test agent's count of prompts in its ACP session: the LAST one (a reply quotes the other agent's).
const countOf = (text) => Number([...(text ?? "").matchAll(/sesión ACP: (\d+)/g)].at(-1)?.[1] ?? 0);
const newConv = async (pid, title) => {
	const r = await api("POST", "/api/acp/conversations", { projectId: pid, title, clientRequestId: randomUUID() });
	if (r.status !== 201) throw new Error(`conversation: ${r.status} ${JSON.stringify(r.body)}`);
	return r.body.id;
};
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
	check("the project lists both agents", JSON.stringify(pf0.agents.map((a) => a.name).sort()) === JSON.stringify([ARQ, DEV].sort()));
	CONV = await newConv(pid, `Aceptación ${PREFIX}`);
	check("a conversation in the project", !!CONV, CONV);

	// 2. A conversation → @arq, who consults @dev (st send) and gets the answer.
	const m1 = await send(ARQ, `@${ARQ} consultá a @${DEV}: ¿qué versión de Node hay en tu sesión?`, pid);
	check("message persisted at once (pending, in the conversation and its project)", m1.state === "pending" && m1.project_id === pid && m1.conversation_id === CONV);
	const d1 = await waitMsg(m1.id);
	check("@arq finished its turn", d1.state === "done", short(d1.result_text));
	const consult = await waitFor("consult", async () =>
		(await convFeed()).messages.find((m) => m.from_id === ARQ && m.to_id === DEV && m.kind === "request"),
	);
	check("@arq's consult to @dev is in the conversation (st send, depth 1)", !!consult && consult.depth === 1 && consult.conversation_id === CONV, consult && `#${consult.id}`);
	const c2 = consult && (await waitMsg(consult.id));
	check("@dev answered the consult", c2?.state === "done", short(c2?.result_text));
	const reply = await waitFor("reply", async () =>
		(await convFeed()).messages.find((m) => m.kind === "reply" && m.reply_to === consult?.id),
	);
	check("the answer came back to @arq as a reply correlated to the consult, in the conversation", !!reply && reply.to_id === ARQ && reply.conversation_id === CONV);
	const r2 = reply && (await waitMsg(reply.id));
	check("@arq processed the answer", r2?.state === "done" && /Recibí la respuesta de @/.test(r2?.result_text ?? ""), short(r2?.result_text));
	const loopFree = await waitFor("no loop", async () => {
		await sleep(4_000);
		const ms = (await convFeed()).messages;
		return ms.every((m) => m.state === "done") && !ms.some((m) => m.kind === "reply" && m.reply_to === reply?.id) ? ms : null;
	}, 30_000);
	check("the exchange ended by itself (no reply to a reply)", !!loopFree, loopFree && `${loopFree.length} messages in the conversation`);

	// 3. Individual chat: a direct message stays private.
	const dm = await send(DEV, "Mensaje directo: decime algo corto.");
	const dmd = await waitMsg(dm.id);
	check("direct message answered", dmd.state === "done" && dmd.project_id === null, short(dmd.result_text));
	check("…and it is not in the conversation", !(await convFeed()).messages.some((m) => m.id === dm.id));
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
	const before = await msgsOf(ARQ);
	const countBefore = countOf(before.messages.filter((m) => m.to_id === ARQ && m.conversation_id === CONV && m.result_text).at(-1)?.result_text);
	const work = await send(ARQ, "esperá 60", pid);
	await waitTurnStarted(ARQ, work.id);
	const p1 = await send(ARQ, "pendiente 1 tras el reinicio", pid);
	const p2 = await send(ARQ, "pendiente 2 tras el reinicio", pid);
	const stop = await api("POST", `/api/sessions/${sids[ARQ]}/stop`);
	check("session of @arq stopped mid-turn", stop.status < 300, String(stop.status));
	const st = await api("POST", `/api/sessions/${sids[ARQ]}/start`);
	check("session of @arq started again", st.status < 300, String(st.status));
	const unc = await waitMsg(work.id, ["uncertain", "failed", "done"], 120_000);
	check("the interrupted message is uncertain", unc.state === "uncertain", short(unc.note));
	const recov = await waitFor("recovery", async () =>
		(await msgsOf(ARQ)).messages.find((m) => m.from_id === "system" && m.id > work.id && m.state === "done"),
	);
	check("Shared Terminal asked @arq for a read-only report (no redo)", !!recov, short(recov?.result_text));
	const pp = [await waitMsg(p1.id), await waitMsg(p2.id)];
	check("pending messages survived the restart and ran", pp.every((m) => m.state === "done" && m.attempts === 1), pp.map((m) => `${m.state}/${m.attempts}`).join(" "));
	await sleep(3_000);
	const again = await get(work.id);
	check("the uncertain message was not run again", again.state === "uncertain" && again.attempts === 1, `${again.state} attempts=${again.attempts}`);
	const countAfter = countOf(pp[1].result_text);
	check("ACP context kept across the container restart (same ACP session)", countAfter > countBefore, `${countBefore} → ${countAfter} prompts`);

	// 6c. Questions (ACP elicitation): asked, visible after any "browser close", answered once, delivered once.
	const openQ = async (msgId) =>
		(await convFeed()).questions?.find((q) => q.message_id === msgId && q.state === "open");
	const ask1 = await send(ARQ, "preguntá: ¿Qué base de datos usamos? | SQLite | Postgres", pid);
	const q1 = await waitFor("question", () => openQ(ask1.id), 60_000);
	check("the agent's question is registered and shown in the conversation (open)", !!q1, q1 && `#${q1.id}`);
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
	const q1d = (await convFeed()).questions.find((q) => q.id === q1?.id);
	check("…the question reads delivered", q1d?.state === "delivered");

	// 6d. Restart during a question: no false answer, no duplicate run.
	const ask2 = await send(ARQ, "preguntá: ¿Deployamos hoy? | sí | no", pid);
	const q2 = await waitFor("question 2", () => openQ(ask2.id), 60_000);
	await api("POST", `/api/sessions/${sids[ARQ]}/stop`);
	await api("POST", `/api/sessions/${sids[ARQ]}/start`);
	const u2 = await waitMsg(ask2.id, ["uncertain", "failed", "done"], 120_000);
	check("the message interrupted during the question is uncertain, not done", u2.state === "uncertain", short(u2.note));
	const q2o = await waitFor("orphaned", async () => (await convFeed()).questions.find((q) => q.id === q2?.id && q.state === "orphaned"), 60_000);
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
	// The same, with what it printed and its exit code.
	const execOut = async (sid, script) => {
		const r = await fetch(`${ST}/api/sessions/${sid}/exec`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({ cmd: ["sh", "-c", script] }),
		});
		let out = "";
		let code = null;
		for (const line of (await r.text()).split("\n").filter(Boolean)) {
			const e = JSON.parse(line);
			if (e.type === "output") out += e.data;
			if (e.type === "exit") code = e.exitCode;
		}
		return { code, out: out.trim() };
	};
	const taDir = "/home/developer/workspace/.st/acp/test-agent";
	check("test agent set to require credentials (none present)", await execIn(sids[DEV], ["sh", "-c", `mkdir -p ${taDir} && touch ${taDir}/require-auth && rm -f $HOME/.claude/.credentials.json`]));
	const needs = await send(DEV, "¿estás conectado?", pid);
	const waiting = await waitFor("auth required", async () => (await agents()).find((a) => a.name === DEV && a.authRequired), 60_000);
	check("the agent reports it needs a login; the message waits (not failed, not uncertain)", !!waiting && (await get(needs.id)).state !== "uncertain", waiting && JSON.stringify(waiting.loginMethods));
	const ctxBefore = countOf((await msgsOf(DEV)).messages.filter((m) => m.to_id === DEV && m.conversation_id === CONV && !m.context && m.result_text).at(-1)?.result_text);
	const method = waiting?.loginMethods?.[0]?.id;
	const login = await api("POST", `/api/acp/agents/${DEV}/login`, { methodId: method });
	check("Conectar cuenta opens a terminal tab running the adapter's login", login.status === 201 && /^tab-/.test(login.body?.tabId ?? ""), JSON.stringify(login.body));
	const resumed = await waitMsg(needs.id, ["done", "uncertain", "failed"], 120_000);
	check("after the login the agent resumes by itself and answers the waiting message", resumed.state === "done" && resumed.attempts >= 1, short(resumed.result_text));
	const ctxAfter = countOf(resumed.result_text);
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

	// 6c. Model (#683): the owner changes @dev's model; the runner switches the live ACP session while
	// idle (session/set_config_option) and the next message runs on it — same ACP session, nothing restarted.
	const sw = await api("PATCH", `/api/acp/agents/${DEV}`, { model: "claude-opus-5-5" });
	check("model change accepted and stored", sw.status === 200 && sw.body?.model === "claude-opus-5-5", JSON.stringify(sw.body?.model));
	const onOpus = await waitMsg((await send(DEV, "¿qué modelo usás?", pid)).id);
	check("the next message runs on the new model", onOpus.state === "done" && /modelo claude-opus-5-5 ·/.test(onOpus.result_text ?? ""), short(onOpus.result_text));
	const applied = (await agents()).find((a) => a.name === DEV)?.modelApplied;
	check("the runner reports the switch as applied, no error", applied?.requested === "claude-opus-5-5" && !applied?.error, JSON.stringify(applied));

	// 6d. Effort: same path as the model. The levels are the adapter's for the current model (the test
	// agent offers five on opus, three on sonnet); a model switch re-applies the effort and a level the
	// new model lacks is reported as an error, never replaced by another one.
	const ef = await api("PATCH", `/api/acp/agents/${DEV}`, { effort: "xhigh" });
	check("effort change accepted and stored", ef.status === 200 && ef.body?.effort === "xhigh", JSON.stringify(ef.body?.effort));
	const onXhigh = await waitMsg((await send(DEV, "¿qué effort usás?", pid)).id);
	check("the next message runs on the new effort", onXhigh.state === "done" && /effort xhigh( ·|\))/.test(onXhigh.result_text ?? ""), short(onXhigh.result_text));
	const efApplied = (await agents()).find((a) => a.name === DEV)?.effortApplied;
	check(
		"the runner reports the effort as applied with the adapter's levels",
		efApplied?.requested === "xhigh" && efApplied?.current === "xhigh" && !efApplied?.error && efApplied?.levels?.includes("max"),
		JSON.stringify(efApplied),
	);
	await api("PATCH", `/api/acp/agents/${DEV}`, { model: "claude-sonnet-5-5" });
	const onSonnet = await waitMsg((await send(DEV, "¿y ahora?", pid)).id);
	check("a model without that level drops it (effort default)", /effort default( ·|\))/.test(onSonnet.result_text ?? ""), short(onSonnet.result_text));
	const efFailed = (await agents()).find((a) => a.name === DEV)?.effortApplied;
	check(
		"the runner reports the missing level as an error, with the new model's levels",
		efFailed?.requested === "xhigh" && efFailed?.current === "default" && !!efFailed?.error && !efFailed?.levels?.includes("xhigh"),
		JSON.stringify(efFailed),
	);
	await api("PATCH", `/api/acp/agents/${DEV}`, { effort: null });

	// 6f. Slots (v24) and works (v26): @dev with max_concurrency 2 runs its default context (slot 1)
	// and a work (slot 2) at once — each work its own worktree, made by the backend; one context never twice at once; each run's `st send` — from the
	// turn or from background — is attributed by its context's credential and the reply comes back
	// to that context; a process that outlived its message cannot send; killing slot 2 leaves only
	// its own message uncertain and the report runs in that context.
	const cap = await api("PATCH", `/api/acp/agents/${DEV}`, { maxConcurrency: 2 });
	check("max_concurrency 2 accepted", cap.status === 200 && cap.body?.maxConcurrency === 2, JSON.stringify(cap.body?.maxConcurrency));
	// Works need a git repo in the agent's workspace, with a remote (a bare one in the container's
	// /tmp: "commits preserved" is checked against it).
	const repo = await execOut(
		sids[DEV],
		"cd /home/developer/workspace && git init -q -b main && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init && rm -rf /tmp/acc-remote.git && git init -q --bare -b main /tmp/acc-remote.git && git remote add origin /tmp/acc-remote.git && git push -q origin main && git remote set-head origin main && git rev-parse HEAD",
	);
	check("a git repo with a remote in @dev's workspace", repo.code === 0, short(repo.out));
	// Work ids are never reused: one set per run.
	const S1 = `${PREFIX}-s1`;
	const S2 = `${PREFIX}-s2`;
	const works = {};
	for (const id of [S1, S2]) {
		const w = await api("POST", "/api/acp/works", { agent: DEV, id });
		works[id] = w.body;
		check(`work ${id} created: worktree on work/${id}, its ports`, w.status === 201 && w.body?.state === "active" && w.body?.branch === `work/${id}` && w.body?.baseSha === repo.out.split("\n").at(-1), JSON.stringify(w.body));
	}
	check("creating it again returns it", (await api("POST", "/api/acp/works", { agent: DEV, id: S1 })).status === 200);
	const running = async () => (await msgsOf(DEV)).messages.filter((m) => m.to_id === DEV && m.state === "running");
	const peak = { n: 0 };
	const watch = setInterval(async () => {
		peak.n = Math.max(peak.n, (await running().catch(() => [])).length);
	}, 500);
	const ov = [await send(DEV, "esperá 6", pid), await send(DEV, "esperá 6", pid, S1)];
	const both = await waitFor("both running", async () => ov.every((m) => m) && (await Promise.all(ov.map((m) => get(m.id)))).every((m) => m.state === "running"), 60_000);
	check("default and work s1 run at the same time (slots 1 and 2)", !!both);
	const ovDone = await Promise.all(ov.map((m) => waitMsg(m.id)));
	check(
		"both done; s1 ran in its own worktree and slot",
		ovDone.every((m) => m.state === "done") && ovDone[1].slot === 2 && (ovDone[1].result_text ?? "").includes(`cwd /home/developer/workspace/.st/ctx/${S1} · trabajo ${S1}`),
		short(ovDone[1].result_text),
	);
	const same = [await send(DEV, "esperá 2", pid, S2), await send(DEV, "esperá 2", pid, S2)];
	const sameDone = await Promise.all(same.map((m) => waitMsg(m.id)));
	check("two messages of one context never overlap", Date.parse(sameDone[1].started_at) >= Date.parse(sameDone[0].finished_at), sameDone.map((m) => `${m.started_at}→${m.finished_at}`).join(" "));
	const bgS1 = await send(DEV, `segundo plano 3: consultá a @${ARQ}: desde s1 en segundo plano`, pid, S1);
	const bgDone = await waitMsg(bgS1.id);
	const fromS1 = (await msgsOf(ARQ)).messages.find((m) => m.body === "desde s1 en segundo plano");
	check("a background st send of s1 is attributed to its run (from_context s1, depth 1)", bgDone.state === "done" && fromS1?.from_id === DEV && fromS1?.from_context === S1 && fromS1?.depth === 1, JSON.stringify(fromS1 && { fc: fromS1.from_context, d: fromS1.depth }));
	const back = await waitFor("reply in s1", async () => (await msgsOf(DEV)).messages.find((m) => m.kind === "reply" && m.reply_to === fromS1?.id && m.state === "done"), 90_000);
	check("…and the reply came back to context s1, processed by slot 2", back?.context === S1 && back?.slot === 2, back && `${back.context} slot ${back.slot}`);
	const pers = await send(DEV, `persistente 6: consultá a @${ARQ}: tarde desde s1`, pid, S1);
	check("a message that leaves a persistent process closes", (await waitMsg(pers.id)).state === "done");
	await sleep(9_000);
	check("…and that process's later st send is refused (nothing written)", !(await msgsOf(ARQ)).messages.some((m) => m.body === "tarde desde s1"));
	const k = [await send(DEV, "esperá 10", pid), await send(DEV, "esperá 10", pid, S1)];
	await waitFor("both running", async () => (await Promise.all(k.map((m) => get(m.id)))).every((m) => m.state === "running"), 60_000);
	check("slot 2's runner killed", await execIn(sids[DEV], ["sh", "-c", "pkill -KILL -f '^node --no-warnings /opt/st-acp/st/runner.mjs 2$'; true"]));
	const kDone = await Promise.all(k.map((m) => waitMsg(m.id)));
	check("slot 1's message finished normally", kDone[0].state === "done", kDone[0].state);
	check("only slot 2's message is uncertain, not rerun", kDone[1].state === "uncertain" && kDone[1].attempts === 1, `${kDone[1].state}/${kDone[1].attempts} ${short(kDone[1].note)}`);
	const rep2 = await waitFor("recovery in s1", async () => (await msgsOf(DEV)).messages.find((m) => m.from_id === "system" && m.id > k[1].id && m.state === "done"), 90_000);
	check("the read-only report ran in slot 2, context s1", rep2?.slot === 2 && rep2?.context === S1, rep2 && `slot ${rep2.slot} ${rep2.context}`);
	clearInterval(watch);
	check("never more than max_concurrency running", peak.n <= 2, `peak ${peak.n}`);

	// 6g. Works (v26): ports, close, clean. A server in s1's port range is s1's (st port check from
	// s1: exit 0; from s2: exit 1, naming s1). Closing refuses --work; cleaning is held by the live
	// server (a process of the work), and the slot releases s1's session only once it is gone; then
	// the worktree is removed (without --force) and the branch stays. Uncommitted changes hold it.
	await api("PATCH", `/api/acp/agents/${DEV}`, { maxConcurrency: 3 });
	const port = works[S1].portBase;
	const srv = await waitMsg((await send(DEV, "servidor", pid, S1)).id);
	check("a server started in work s1, on its ST_PORT_BASE", srv.state === "done" && srv.result_text?.includes(`puerto ${port}`), short(srv.result_text));
	const own = await waitMsg((await send(DEV, `st: port check ${port}`, pid, S1)).id);
	check("st port check from s1: it is its own (exit 0)", own.result_text?.includes("exit 0"), short(own.result_text, 160));
	const other = await waitMsg((await send(DEV, `st: port check ${port}`, pid, S2)).id);
	check("st port check from s2: someone else's, naming s1 (exit 1)", other.result_text?.includes("exit 1") && other.result_text?.includes(`«${S1}»`), short(other.result_text, 160));
	const closed = await api("POST", `/api/acp/works/${S1}/close`);
	check("work s1 closed", closed.status === 200 && closed.body?.state === "closed", JSON.stringify(closed.body?.state));
	const into = await api("POST", "/api/acp/messages", { to: DEV, body: "x", work: S1 });
	check("--work into a closed work: 409 work-not-active", into.status === 409 && into.body?.error === "work-not-active", JSON.stringify(into.body));
	const held = await api("POST", `/api/acp/works/${S1}/clean`);
	check("cleaning s1 with its server alive: cleanup-pending, the process named", held.status === 409 && held.body?.error === "cleanup-pending" && held.body.reasons.some((r) => r.startsWith("proceso")), JSON.stringify(held.body));
	await execIn(sids[DEV], ["sh", "-c", "pkill -f 'st-work-server$'; true"]);
	const released = await waitFor("s1's session released", async () => (await execOut(sids[DEV], `grep -h 'released the session of work ${S1}' /tmp/st-acp-runner-*.log`)).code === 0, 90_000);
	check("…with the server gone, the slot released s1's ACP session", !!released);
	const cleaned = await api("POST", `/api/acp/works/${S1}/clean`);
	check("then s1 is cleaned", cleaned.status === 200 && cleaned.body?.state === "cleaned", JSON.stringify(cleaned.body?.state ?? cleaned.body));
	const after = await execOut(sids[DEV], `cd /home/developer/workspace && test ! -e .st/ctx/${S1} && git rev-parse --verify --quiet work/${S1}`);
	check("…the worktree is gone and branch work/s1 stays", after.code === 0, short(after.out));
	await execIn(sids[DEV], ["sh", "-c", `echo x > /home/developer/workspace/.st/ctx/${S2}/sin-commit.txt`]);
	await api("POST", `/api/acp/works/${S2}/close`);
	const dirty = await api("POST", `/api/acp/works/${S2}/clean`);
	check("uncommitted changes hold s2 (cleanup-pending)", dirty.status === 409 && dirty.body?.reasons?.some((r) => r.includes("sin-commit.txt")), JSON.stringify(dirty.body));
	await execIn(sids[DEV], ["sh", "-c", `rm /home/developer/workspace/.st/ctx/${S2}/sin-commit.txt`]);
	const s2Clean = await waitFor("s2 cleaned", async () => (await api("POST", `/api/acp/works/${S2}/clean`)).body?.state === "cleaned", 90_000);
	check("once removed, s2 is cleaned (its session released first)", !!s2Clean);
	await api("PATCH", `/api/acp/agents/${DEV}`, { maxConcurrency: 1 });

	// 6h. Conversations (v27, B2): slot 1 keeps one ACP session per conversation. Two topics with @arq
	// keep their own count when alternating; what a message sets off (consult, reply, question, an
	// interrupted run and its report) stays in its topic; a message to @arq busy in another topic waits
	// pending and runs after; a session with a live task is never closed (the other topic waits).
	const TA = await newConv(pid, `Tema A ${PREFIX}`);
	const TB = await newConv(pid, `Tema B ${PREFIX}`);
	const inA = (body) => send(ARQ, body, true, undefined, TA);
	const inB = (body) => send(ARQ, body, true, undefined, TB);
	const seq = [];
	for (const [send1, body] of [[inA, "uno A"], [inB, "uno B"], [inA, "dos A"], [inB, "dos B"]]) seq.push(await waitMsg((await send1(body)).id));
	check(
		"two conversations with @arq keep their own ACP session count when alternating",
		seq.every((m) => m.state === "done") && countOf(seq[2].result_text) === countOf(seq[0].result_text) + 1 && countOf(seq[3].result_text) === countOf(seq[1].result_text) + 1,
		seq.map((m) => countOf(m.result_text)).join(","),
	);
	check("…and a new topic starts a new session (count 1)", countOf(seq[0].result_text) === 1 && countOf(seq[1].result_text) === 1);
	const cB = await waitMsg((await inB(`consultá a @${DEV}: ¿algo del tema B?`)).id);
	const consultB = (await convFeed(TB)).messages.find((m) => m.from_id === ARQ && m.to_id === DEV && m.kind === "request");
	check("a consult from topic B stays in B", cB.state === "done" && consultB?.conversation_id === TB, consultB && `#${consultB.id}`);
	const replyB = await waitFor("reply in B", async () => (await convFeed(TB)).messages.find((m) => m.kind === "reply" && m.reply_to === consultB?.id && m.state === "done"), 90_000);
	check("…its reply comes back in B and runs in B's session", !!replyB && countOf(replyB.result_text) === countOf(cB.result_text) + 1, replyB && `${countOf(cB.result_text)} → ${countOf(replyB.result_text)}`);
	check("…and none of it is in topic A", !(await convFeed(TA)).messages.some((m) => m.id === consultB?.id || m.id === replyB?.id));
	const askA = await inA("preguntá: ¿Seguimos? | sí | no");
	const qA = await waitFor("question in A", async () => (await convFeed(TA)).questions?.find((q) => q.message_id === askA.id && q.state === "open"), 60_000);
	check("a question asked in topic A is in A, not in B", !!qA && !(await convFeed(TB)).questions.some((q) => q.id === qA.id));
	const inboxQ = (await api("GET", "/api/acp/inbox")).body;
	check("…and in the inbox, with its conversation", inboxQ.action?.questions?.some((q) => q.id === qA?.id && q.conversation_id === TA), `count ${inboxQ.count}`);
	const waitB = await inB("en cola mientras A espera");
	await sleep(3_000);
	const arqState = (await agents()).find((a) => a.name === ARQ);
	check(
		"a message to @arq busy in another topic waits pending; the agent's state says where it works and what is queued",
		(await get(waitB.id)).state === "pending" && arqState?.runningIn?.[0]?.conversationId === TA && arqState?.queue?.some((q) => q.id === waitB.id && q.conversationId === TB) && arqState?.question?.conversationId === TA,
		JSON.stringify({ runningIn: arqState?.runningIn, queue: arqState?.queue, question: arqState?.question }),
	);
	await api("POST", `/api/acp/questions/${qA?.id}/answer`, { action: "accept", content: { question_0: "sí" } });
	const [aDone, bDone] = [await waitMsg(askA.id), await waitMsg(waitB.id)];
	check("…and runs after A's message, in B's session", bDone.state === "done" && Date.parse(bDone.started_at) >= Date.parse(aDone.finished_at) && countOf(bDone.result_text) > countOf(seq[3].result_text), `${aDone.finished_at} → ${bDone.started_at}`);
	const persA = await waitMsg((await inA(`persistente 8: consultá a @${DEV}: tarde desde A`)).id);
	const afterPers = await inB("tras el proceso de A");
	await sleep(4_000);
	check("a live task in A's session keeps @arq in A: B's message still waits", persA.state === "done" && (await get(afterPers.id)).state === "pending");
	const ap = await waitMsg(afterPers.id);
	check("…and runs once the task ended", ap.state === "done" && Date.parse(ap.started_at) - Date.parse(persA.finished_at) >= 6_000, `${(Date.parse(ap.started_at) - Date.parse(persA.finished_at)) / 1000}s`);
	const longA = await inA("esperá 60");
	await waitTurnStarted(ARQ, longA.id);
	await api("POST", `/api/sessions/${sids[ARQ]}/stop`);
	await api("POST", `/api/sessions/${sids[ARQ]}/start`);
	const uA = await waitMsg(longA.id, ["uncertain", "failed", "done"], 120_000);
	const repA = await waitFor("report in A", async () => (await convFeed(TA)).messages.find((m) => m.recovery_of === longA.id && m.state === "done"), 120_000);
	check("an interrupted run in A is uncertain; its read-only report is in A, linked, in A's session", uA.state === "uncertain" && !!repA && repA.from_id === "system" && countOf(repA.result_text) > countOf(persA.result_text), repA && `#${repA.id} ${countOf(repA.result_text)}`);
	const inboxU = (await api("GET", "/api/acp/inbox")).body;
	check("…it is in the inbox with its report", inboxU.action?.interrupted?.some((m) => m.id === longA.id) && inboxU.reports?.some((m) => m.recovery_of === longA.id));
	const rv = await api("POST", `/api/acp/messages/${longA.id}/review`);
	const inboxR = (await api("GET", "/api/acp/inbox")).body;
	check("reviewed: out of the inbox, still uncertain, not run again", rv.status === 200 && !inboxR.action.interrupted.some((m) => m.id === longA.id) && (await get(longA.id)).attempts === 1 && (await get(longA.id)).state === "uncertain");
	const bLast = await waitMsg((await inB("sigo en B")).id);
	check("topic B's session continues after the restart", bLast.state === "done" && countOf(bLast.result_text) > countOf(ap.result_text), `${countOf(ap.result_text)} → ${countOf(bLast.result_text)}`);

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
		// Archive the test project: earlier runs left one "Aceptación ACP …" per run in the sidebar.
		if (created.project) {
			const a = await api("DELETE", `/api/projects/${created.project}`);
			check("test project archived", a.status < 300, String(a.status));
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
