#!/usr/bin/env node
// Pilot of Entrega 3B — conversations per project (#757) — against the LAB (experiments/acp-agents/lab-st.sh,
// ACP_TEST_RUNTIME=1). ONE scenario, in order, with the owner's minimum points that the API can show:
//   C1  several independent conversations (topics) in one project: each message carries its conversation_id and
//       each topic's feed holds only its own;
//   C2  ACP continuity per (agent, topic) while alternating: the slot 1 resumes each topic's own session (count),
//       always in the main checkout, never two runs at once there;
//   C3  an agent busy in another topic ⇒ the message waits `pending` (the agent's status says busy in which topic)
//       and runs after, in its own topic's session; a process left running in a topic holds slot 1 there (heldBy);
//   C4  a send to several agents: one row per recipient under one send, each with its own state; the "whole team"
//       mark is kept;
//   C5  a topic's recipients are saved with each owner send (the last set, or the team mark); a new topic starts
//       with none;
//   C6  a late answer is linked: a consult's reply carries reply_to and the topic of its request (inheritance:
//       request → reply → question → interrupted run → system report);
//   C7  global inbox (open questions + unreviewed interruptions) and a persistent read mark per topic;
//   C8  an interruption is `uncertain`, never re-run, and "reviewed" takes it out of the inbox without creating a
//       message (requeue stays the explicit owner verb);
//   C9  Files/Git rooted at a work's worktree without exposing `.st/` (the security cases of B3 that the API shows);
//   C10 isolation between projects: another project's topic can't be posted into, listed or read through the
//       first project's agents;
//   C11 a restarted slot-1 runner resumes each topic's session (no message re-run);
//   C12 works keep working: run `works-pilot.mjs` unchanged after this script (not repeated here).
// Run the lab with MAX_RUNNING >= 4:
//   SRC=<checkout> MAX_RUNNING=4 ./experiments/acp-agents/lab-st.sh up
//   ST=http://127.0.0.1:3101 node experiments/acp-agents/conversations-pilot.mjs
//   ST=http://127.0.0.1:3101 node experiments/acp-agents/works-pilot.mjs            (C12)
// Removes the sessions and the projects it created (KEEP=1 keeps them). One PASS/FAIL line per check; exit 1 on
// any failure.
//
// Routes and fields: docs/ACP_AGENTS.md §4b (B1, #759) and `?work=` on Files/Git (B3, #758). What B2 (the slot-1
// session per conversation) shows is checked through the test agent's context line (session count, cwd).
import { randomBytes, randomUUID } from "node:crypto";

const ST = process.env.ST ?? "http://127.0.0.1:3101";
const PREFIX = process.env.PREFIX ?? `c${randomBytes(2).toString("hex")}`;
const A = `${PREFIX}-a`; // the agent whose topics alternate (slot 1)
const B = `${PREFIX}-b`;
const C = `${PREFIX}-c`;
const X = `${PREFIX}-x`; // an agent of ANOTHER project (C10)
const WS = "/home/developer/workspace";
const WORK = `${PREFIX}-w1`;
let cookie = "";
let failures = 0;
const created = { sessions: [], projects: [] };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
function check(name, ok, evidence) {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"} [${at()}] ${name}${evidence ? ` — ${evidence}` : ""}`);
	return ok;
}

// ── Lab API ───────────────────────────────────────────────────────────────────

async function auth() {
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
		headers: { "content-type": "application/json", cookie },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let json = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {}
	return { status: res.status, body: json ?? text };
}
// Topics (docs/ACP_AGENTS.md §4b): POST /api/acp/conversations {projectId, title, clientRequestId};
// GET /api/acp/projects/:pid/conversations; GET /api/acp/conversations/:id/feed → {conversation, messages, …};
// POST /api/acp/conversations/:id/read {at}; GET /api/acp/inbox; POST /api/acp/messages/:id/review.
const newTopic = async (pid, title) => api("POST", "/api/acp/conversations", { projectId: pid, title, clientRequestId: randomUUID() });
const topics = async (pid) => (await api("GET", `/api/acp/projects/${pid}/conversations`)).body;
const feed = async (cid) => (await api("GET", `/api/acp/conversations/${cid}/feed`)).body;
const topic = async (cid) => (await feed(cid))?.conversation ?? null;
const topicRows = async (cid) => (await feed(cid))?.messages ?? [];
// A post in a topic: one recipient (`to` a name) → the row; several (`to` a list) or `team: true` → {messages}.
async function post(to, body, pid, cid, extra = {}) {
	const r = await api("POST", "/api/acp/messages", { ...(to === null ? {} : { to }), body, conversationId: cid, clientId: randomUUID(), ...extra });
	if (r.status !== 201) throw new Error(`send ${JSON.stringify(to)}: ${r.status} ${JSON.stringify(r.body)}`);
	return r.body;
}
const get = async (id) => (await api("GET", `/api/acp/messages/${id}`)).body;
async function waitMsg(id, states = ["done", "uncertain", "failed"], ms = 120_000) {
	const end = Date.now() + ms;
	for (;;) {
		const m = await get(id);
		if (states.includes(m.state) || Date.now() > end) return m;
		await sleep(1_000);
	}
}
async function waitFor(fn, ms = 90_000) {
	const end = Date.now() + ms;
	for (;;) {
		const v = await fn();
		if (v || Date.now() > end) return v;
		await sleep(1_000);
	}
}
const agents = async () => (await api("GET", "/api/acp/agents")).body;
const short = (s, n = 110) => (s ?? "").replace(/\s+/g, " ").slice(0, n);
// The answering agent's own context line is the LAST one (an answer to a reply quotes the other agent's first).
const last = (re, text) => [...(text ?? "").matchAll(re)].at(-1)?.[1] ?? null;
const sessionCount = (text) => Number(last(/sesión ACP: (\d+) mensajes/g, text) ?? Number.NaN);
const cwdOf = (text) => last(/cwd (\S+) · trabajo /g, text);
const topicOf = (m) => m?.conversation_id ?? null;
const ms = (iso) => Date.parse(iso);

async function exec(sid, cmd) {
	await auth();
	const r = await fetch(`${ST}/api/sessions/${sid}/exec`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie },
		body: JSON.stringify({ cmd }),
	});
	let out = "";
	for (const line of (await r.text()).split("\n")) {
		try {
			const e = JSON.parse(line);
			if (e.type === "output" && e.stream === "stdout") out += e.data;
		} catch {}
	}
	return out;
}
const sh = (sid, script) => exec(sid, ["sh", "-c", script]);
const cgroup = async (sid) => {
	const out = await sh(sid, "cat /sys/fs/cgroup/memory.peak; cat /sys/fs/cgroup/memory.events");
	const kv = Object.fromEntries(out.split("\n").filter((l) => l.includes(" ")).map((l) => l.trim().split(/\s+/)));
	return { peakMiB: Math.round(Number(out.split("\n")[0]) / 1048576), oom: Number(kv.oom ?? Number.NaN), oomKill: Number(kv.oom_kill ?? Number.NaN) };
};
// No two runs overlap among the given rows (backend timestamps).
const overlaps = (rows) => {
	const r = rows.filter((m) => m.started_at && m.finished_at).sort((x, y) => ms(x.started_at) - ms(y.started_at));
	return r.some((m, i) => i > 0 && ms(m.started_at) < ms(r[i - 1].finished_at));
};

// ── Scenario ──────────────────────────────────────────────────────────────────

async function main() {
	console.log(`conversations pilot against ${ST} — agents @${A}, @${B}, @${C} (+ @${X} elsewhere)`);
	const p = await api("POST", "/api/projects", { name: `Piloto temas ${PREFIX}`, clientRequestId: randomUUID() });
	const p2 = await api("POST", "/api/projects", { name: `Otro proyecto ${PREFIX}`, clientRequestId: randomUUID() });
	if (!check("two projects created", p.status === 201 && p2.status === 201, `${p.status} ${p2.status}`)) return;
	const [pid, pid2] = [p.body.projectId, p2.body.projectId];
	created.projects.push(pid, pid2);
	const sids = {};
	for (const [name, project] of [[A, pid], [B, pid], [C, pid], [X, pid2]]) {
		const r = await api("POST", "/api/sessions", { name: `3b ${name}`, acpAgent: { name, runtime: "st-test-agent", projectId: project } });
		check(`session with @${name}`, r.status === 201, `${r.status}`);
		sids[name] = r.body.sessionId;
		created.sessions.push(r.body.sessionId);
	}
	for (const name of [A, B, C, X])
		check(`runner of @${name} online`, !!(await waitFor(async () => (await agents()).find((a) => a.name === name && a.runnerSeenAt))));
	const cgBefore = await cgroup(sids[A]);

	// C1. Two topics; each message carries its topic and each feed holds only its own.
	const t1 = await newTopic(pid, "Tema uno");
	const t2 = await newTopic(pid, "Tema dos");
	if (!check("C1 two topics created", t1.status === 201 && t2.status === 201, `${t1.status} ${t2.status} ${short(JSON.stringify(t1.body))}`)) return;
	const [T1, T2] = [t1.body.id, t2.body.id];
	const listed = await topics(pid);
	check("C1 both topics listed in the project", Array.isArray(listed) && [T1, T2].every((id) => listed.some((t) => t.id === id)), short(JSON.stringify(listed), 160));

	// C2. Alternating topics on @A: T1, T2, T1, T2 — each topic counts only its own messages; all in slot 1, in the
	// main checkout, never overlapping.
	const seq = [];
	for (const [cid, text] of [[T1, "hola uno"], [T2, "hola dos"], [T1, "otra vez uno"], [T2, "otra vez dos"]]) seq.push(await waitMsg((await post(A, text, pid, cid)).id));
	check("C2 the four messages done", seq.every((m) => m.state === "done"), seq.map((m) => m.state).join(","));
	check("C2 each message carries its topic", seq.map(topicOf).join(",") === [T1, T2, T1, T2].join(","), seq.map(topicOf).join(","));
	check("C2 T1's session continues across T2 (count +1)", sessionCount(seq[2].result_text) === sessionCount(seq[0].result_text) + 1, `${sessionCount(seq[0].result_text)} → ${sessionCount(seq[2].result_text)}`);
	check("C2 T2's session continues across T1 (count +1)", sessionCount(seq[3].result_text) === sessionCount(seq[1].result_text) + 1, `${sessionCount(seq[1].result_text)} → ${sessionCount(seq[3].result_text)}`);
	check("C2 all in slot 1, in the main checkout", seq.every((m) => m.slot === 1 && cwdOf(m.result_text) === WS), seq.map((m) => `${m.slot}:${cwdOf(m.result_text)}`).join(" "));

	// C3. @A busy in T1 (a long run) ⇒ a message in T2 waits pending, the agent says busy in T1, then it runs.
	const long = await post(A, "esperá 15", pid, T1);
	await waitFor(async () => (await get(long.id)).state === "running", 30_000);
	const queued = await post(A, "cuando puedas", pid, T2);
	await sleep(3_000);
	const q0 = await get(queued.id);
	const status = (await agents()).find((a) => a.name === A);
	check("C3 the T2 message waits pending while @A runs T1", q0.state === "pending", q0.state);
	// The agent's state in the UI's words (/agents: runningIn, queue — never slots).
	check("C3 @A's status: running in T1, queued in T2", status?.runningIn?.some((r) => r.id === long.id && r.conversationId === T1) && status?.queue?.some((q) => q.id === queued.id && q.conversationId === T2), short(JSON.stringify({ runningIn: status?.runningIn, queue: status?.queue }), 200));
	const [ld, qd] = [await waitMsg(long.id), await waitMsg(queued.id)];
	check("C3 the queued message ran after, in slot 1, in T2's session", qd.state === "done" && ms(qd.started_at) >= ms(ld.finished_at) && qd.slot === 1 && sessionCount(qd.result_text) === sessionCount(seq[3].result_text) + 1, `${ld.finished_at} → ${qd.started_at} count ${sessionCount(qd.result_text)}`);

	// C3b. A process left running in T1 holds slot 1 there (heldBy, #761): the test agent's `persistente N:` declares
	// ST-PERSISTENT on a task that stays open N s. While it lives, /agents says "held in T1", a message to @A in T2
	// waits pending, and once the task ends the slot is released and T2's message runs.
	const hold = await waitMsg((await post(A, `persistente 25: consultá a @${B}: tarde`, pid, T1)).id);
	const t2wait = await post(A, "mientras retiene", pid, T2);
	const heldNow = await waitFor(async () => {
		const a = (await agents()).find((x) => x.name === A);
		return (a?.heldBy ?? []).some((h) => h.conversationId === T1) ? a : null;
	}, 20_000);
	check("C3b a live process in T1: @A is held there (heldBy)", hold.state === "done" && !!heldNow, short(JSON.stringify(heldNow?.heldBy), 120));
	check("C3b …and the T2 message waits pending meanwhile", (await get(t2wait.id)).state === "pending", (await get(t2wait.id)).state);
	const t2ran = await waitMsg(t2wait.id, ["done", "uncertain", "failed"], 120_000);
	const heldAfter = (await agents()).find((x) => x.name === A)?.heldBy ?? [];
	check("C3b after the process ended: the T2 message ran in T2 and the hold is gone", t2ran.state === "done" && topicOf(t2ran) === T2 && !heldAfter.some((h) => h.conversationId === T1), `${t2ran.state} ${short(JSON.stringify(heldAfter), 80)}`);

	// C4. A send to three agents ("whole team") in a new topic T3: one row per recipient under one send, each with
	// its own state, the team mark kept on the rows and as the topic's recipients.
	const t3 = await newTopic(pid, "Tema tres");
	check("C5 a new topic starts with no recipients", t3.status === 201 && t3.body?.recipients === null, short(JSON.stringify(t3.body), 120));
	const T3 = t3.body?.id;
	// One body for the whole team: "esperá 8" keeps each agent busy for 8 s; @A also has the rest of its queue, so
	// the rows end at different times — each row's state is its own.
	const sent4 = await post(null, "esperá 8", pid, T3, { team: true });
	const rows4 = [A, B, C].map((n) => (sent4.messages ?? []).find((m) => m.to_id === n)).filter(Boolean);
	await waitMsg(rows4[0]?.id ?? 0);
	const b4 = await get(rows4[1]?.id ?? 0);
	const a4 = await get(rows4[0]?.id ?? 0);
	check("C4 three rows under one send", new Set(rows4.map((m) => m.id)).size === 3, rows4.map((m) => m.id).join(","));
	const c4 = await waitMsg(rows4[2]?.id ?? 0);
	check("C4 one row per agent, each ending on its own (states independent)", rows4.length === 3 && [a4, b4, c4].every((m) => m.state === "done") && new Set([a4, b4, c4].map((m) => m.finished_at)).size === 3, [a4, b4, c4].map((m) => `${m.to_id}:${m.state}@${m.finished_at}`).join(" "));
	check("C4 the 'whole team' mark is kept on every row", rows4.every((m) => m.team === 1 || m.team === true), short(JSON.stringify(rows4[0]), 160));
	check("C5 T3 remembers the whole team", (await topic(T3))?.recipients?.team === true, short(JSON.stringify(await topic(T3)), 160));

	// C5. A topic's recipients are saved with each send of the owner (the last set): {A,B} in T1, {C} in T2 ⇒
	// reading T1 gives {A,B} and T2 gives {C}; there is no client PATCH for them.
	const sent5 = (await post([A, B], "para los dos", pid, T1)).messages ?? [];
	const sent5c = await post(C, "solo para c", pid, T2);
	await Promise.all([...sent5, sent5c].map((m) => waitMsg(m.id)));
	const recipsOf = async (cid) => ((await topic(cid))?.recipients?.agents ?? []).slice().sort().join(",");
	check("C5 T1 keeps {A,B}", (await recipsOf(T1)) === [A, B].sort().join(","), short(JSON.stringify(await topic(T1)), 160));
	check("C5 T2 keeps {C}", (await recipsOf(T2)) === C, short(JSON.stringify(await topic(T2)), 160));

	// C6. A late answer: @A consults @B from T2; the request and its reply carry T2, the reply has reply_to.
	const cons = await waitMsg((await post(A, `consultá a @${B}: dato`, pid, T2)).id);
	const reqAB = await waitFor(async () => (await topicRows(T2)).find((m) => m.kind === "request" && m.from_id === A && m.to_id === B) ?? null, 30_000);
	const repAB = reqAB ? await waitFor(async () => (await topicRows(T2)).find((m) => m.kind === "reply" && m.reply_to === reqAB.id && m.state === "done") ?? null, 60_000) : null;
	check("C6 the consult inherits T2", cons.state === "done" && topicOf(reqAB) === T2, `${topicOf(reqAB)}`);
	check("C6 the late reply is linked (reply_to) and in T2", !!repAB && topicOf(repAB) === T2 && repAB.reply_to === reqAB.id, `${repAB?.id} re ${repAB?.reply_to} in ${topicOf(repAB)}`);
	check("C1 T1's feed holds none of T2's rows", !(await topicRows(T1)).some((m) => topicOf(m) !== T1), "");

	// C7. Inbox: an open question shows up; answering removes it. Read mark persists.
	const qq = await post(B, "preguntá: ¿base? | Postgres | SQLite", pid, T1);
	const inboxQ = await waitFor(async () => {
		const inbox = (await api("GET", "/api/acp/inbox")).body;
		return (inbox?.action?.questions ?? []).some((q) => q.message_id === qq.id) ? inbox : null;
	}, 30_000);
	check("C7 the open question is in the global inbox (with its topic) and counts", !!inboxQ && inboxQ.action.questions.some((q) => q.message_id === qq.id && q.conversation_id === T1) && inboxQ.count >= 1, short(JSON.stringify(inboxQ?.action?.questions), 160));
	check("C7 T1 needs action while the question is open", (await topic(T1))?.needsAction === true, "");
	// The question's id from the inbox (the project feed serves only the Archive since B1). Not finding it is a
	// FAIL, never a silent skip: an unanswered question keeps @B's only slot busy and starves what follows.
	const openQ = (inboxQ?.action?.questions ?? []).find((q) => q.message_id === qq.id && q.state === "open");
	if (check("C7 the open question is answerable (found in the inbox)", !!openQ, short(JSON.stringify(openQ), 80)))
		await api("POST", `/api/acp/questions/${openQ.id}/answer`, { action: "accept", content: { question_0: "SQLite" } });
	const qDone = await waitMsg(qq.id);
	check("C6 the question's run inherits T1", qDone.state === "done" && topicOf(qDone) === T1 && /Elegiste: SQLite/.test(qDone.result_text ?? ""), short(qDone.result_text, 60));
	// Read mark by time (§4b): the newest event on screen (finished_at of a person's result, else created_at).
	const evt = (m) => (m.from_id === "owner" && m.state === "done" && m.result_text ? m.finished_at : m.created_at);
	const at = (await topicRows(T1)).map(evt).sort().at(-1);
	check("C7 T1 has unread before the mark", ((await topic(T1))?.unread ?? 0) > 0, String((await topic(T1))?.unread));
	const rd = await api("POST", `/api/acp/conversations/${T1}/read`, { at });
	const afterRead = await topic(T1);
	check("C7 the read mark persists on the server and clears unread", rd.status < 300 && afterRead?.readAt === at && afterRead?.unread === 0, `${rd.status} readAt ${afterRead?.readAt} unread ${afterRead?.unread}`);
	const back = await api("POST", `/api/acp/conversations/${T1}/read`, { at: "2020-01-01T00:00:00.000Z" });
	check("C7 the read mark only advances", back.status < 300 && (await topic(T1))?.readAt === at, String((await topic(T1))?.readAt));

	// C8. An interruption: kill @A's slot-1 runner during a long run in T2 ⇒ uncertain, not re-run, its system
	// report in T2; in the inbox until "reviewed"; review creates no message.
	const cut = await post(A, "esperá 30", pid, T2);
	await waitFor(async () => (await get(cut.id)).state === "running", 30_000);
	await sleep(3_000);
	// Slot 1's runner has no slot argument (acp/agents.ts runnerCommand).
	await sh(sids[A], "pkill -KILL -f '^node --no-warnings /opt/st-acp/st/runner.mjs$'; true");
	const unc = await waitMsg(cut.id, ["uncertain", "failed", "done"], 180_000);
	check("C8 the interrupted run is uncertain", unc.state === "uncertain", `${unc.state} ${short(unc.note)}`);
	await sleep(15_000);
	const again = await get(cut.id);
	check("C8 not re-run", again.state === "uncertain" && again.attempts === 1, `${again.state}/${again.attempts}`);
	const sys = await waitFor(async () => (await topicRows(T2)).find((m) => m.from_id === "system" && m.recovery_of === cut.id) ?? null, 60_000);
	check("C6 the recovery report is linked (recovery_of) and lives in T2", !!sys && topicOf(sys) === T2, `${sys?.id} ${topicOf(sys)}`);
	const inboxU = (await api("GET", "/api/acp/inbox")).body;
	check("C7 the unreviewed interruption is in the inbox, with its report", (inboxU?.action?.interrupted ?? []).some((m) => m.id === cut.id) && (inboxU?.reports ?? []).some((m) => m.recovery_of === cut.id), short(JSON.stringify({ i: inboxU?.action?.interrupted?.map((m) => m.id), r: inboxU?.reports?.map((m) => m.recovery_of) }), 160));
	const rowsBefore = (await topicRows(T2)).length;
	const rv = await api("POST", `/api/acp/messages/${cut.id}/review`);
	const afterRv = await get(cut.id);
	check("C8 'reviewed': still uncertain, marked, no new message", rv.status < 300 && afterRv.state === "uncertain" && !!afterRv.reviewed_at && (await topicRows(T2)).length === rowsBefore, `${rv.status} ${afterRv.state} ${afterRv.reviewed_at}`);
	check("C8 the reviewed interruption left the inbox", !((await api("GET", "/api/acp/inbox")).body?.action?.interrupted ?? []).some((m) => m.id === cut.id), "");
	const notU = await api("POST", `/api/acp/messages/${qq.id}/review`);
	check("C8 review refuses a message that is not uncertain (409)", notU.status === 409, String(notU.status));

	// C11. The restarted runner resumes each topic's session.
	const r1 = await waitMsg((await post(A, "tras reinicio uno", pid, T1)).id);
	const r2 = await waitMsg((await post(A, "tras reinicio dos", pid, T2)).id);
	const lastT1 = Math.max(...[seq[0], seq[2]].map((m) => sessionCount(m.result_text)));
	check("C11 after the restart T1 resumes its own session", r1.state === "done" && sessionCount(r1.result_text) > lastT1 && cwdOf(r1.result_text) === WS, `${lastT1} → ${sessionCount(r1.result_text)}`);
	check("C11 after the restart T2 resumes its own session", r2.state === "done" && sessionCount(r2.result_text) > sessionCount(qd.result_text), `${sessionCount(qd.result_text)} → ${sessionCount(r2.result_text)}`);
	const aRows = (await Promise.all([T1, T2, T3].map(topicRows))).flat().filter((m) => m.to_id === A && m.slot === 1);
	check("C2 slot 1 never ran two messages of @A at once (main checkout)", !overlaps(aRows), `${aRows.length} runs`);

	// C9. Files/Git rooted at a work's worktree. @A gets a repo and a work; the worktree is browsable, `.st/` and
	// escapes are not (`?work=<id>` on every Files and Git entry, #758).
	await api("PATCH", `/api/acp/agents/${A}`, { maxConcurrency: 2 });
	await sh(sids[A], `cd ${WS} && git init -q -b main && printf '.st/\\n' > .gitignore && echo hola > README.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm base`);
	// The work is created by @B from T1 (`st work new`): its origin topic is T1 (agent_works.conversation_id).
	const wn = await waitMsg((await post(B, `st: work new @${A} ${WORK}`, pid, T1)).id);
	const wrow = ((await api("GET", "/api/acp/works")).body ?? []).find?.((x) => x.id === WORK);
	check("C9 a work for @A, created from T1", /→ exit 0/.test(wn.result_text ?? "") && wrow?.state === "active", short(wn.result_text, 120));
	check("C6 the work remembers its origin topic (T1)", wrow?.conversationId === T1, short(JSON.stringify(wrow), 160));
	// A `--work` message sent from a topic carries both: the topic of the run that sent it and the work.
	const wd = await waitMsg((await post(B, `st: send @${A} --work ${WORK} "hola trabajo"`, pid, T1)).id);
	const wreq = await waitFor(async () => (await topicRows(T1)).find((m) => m.kind === "request" && m.from_id === B && m.to_id === A && m.context === WORK) ?? null, 30_000);
	const wdone = wreq ? await waitMsg(wreq.id) : null;
	check("C6 a --work message keeps its topic and runs in the work", !!wdone && topicOf(wdone) === T1 && wdone.context === WORK && cwdOf(wdone.result_text) === `${WS}/.st/ctx/${WORK}`, `${short(wd.result_text, 60)} | ${topicOf(wdone)} ${wdone?.context} ${cwdOf(wdone?.result_text)}`);
	if (wrow?.state === "active") {
		const sid = sids[A];
		await sh(sid, `cd ${WS}/.st/ctx/${WORK} && echo SECRET=1 > .env && ln -s ../../acp acp-link && ln -s ${WS} main-link && ln -s /etc etc-link`);
		const fs = (path, work = WORK) => api("GET", `/api/sessions/${sid}/fs/list?work=${encodeURIComponent(work)}&path=${encodeURIComponent(path)}`);
		const root = await fs("");
		check("C9 the work's root lists the worktree", root.status === 200 && (root.body?.entries ?? []).some((e) => e.name === "README.md"), `${root.status} ${short(JSON.stringify(root.body), 120)}`);
		for (const [what, path] of [["..", ".."], ["../..", "../.."], [".git", ".git"], [".env", ".env"], ["a symlink to .st/acp", "acp-link"], ["a symlink to the main checkout", "main-link"], ["a symlink out of the workspace", "etc-link"]]) {
			const r = await fs(path);
			check(`C9 ${what} under the work's root is refused`, r.status === 400 || r.status === 403 || r.status === 404, `${r.status} ${short(JSON.stringify(r.body), 80)}`);
		}
		// Every entry takes `work` (Files list/preview/raw/download, Git status/diff/log) and refuses the same things.
		for (const [route, q] of [["fs/preview", "path=.env"], ["fs/raw", "path=.env"], ["files", "path=.env"], ["fs/preview", "path=acp-link"], ["fs/raw", "path=main-link"], ["files", "path=etc-link"], ["files", "path=.."]]) {
			const r = await api("GET", `/api/sessions/${sid}/${route}?work=${WORK}&${q}`);
			check(`C9 ${route} ${q} under the work's root is refused`, r.status === 400 || r.status === 403 || r.status === 404, `${r.status}`);
		}
		const ok = await api("GET", `/api/sessions/${sid}/fs/preview?work=${WORK}&path=README.md`);
		check("C9 a plain file of the worktree is previewed", ok.status === 200, String(ok.status));
		const glog = await api("GET", `/api/sessions/${sid}/git/log?work=${WORK}`);
		check("C9 Git log at the work's root", glog.status === 200, String(glog.status));
		const gdir = await api("GET", `/api/sessions/${sid}/git/status?work=${WORK}&dir=..`);
		check("C9 with `work`, the client's `dir` is refused or ignored (never the main checkout)", gdir.status >= 400 || JSON.stringify(gdir.body).includes(`work/${WORK}`), `${gdir.status} ${short(JSON.stringify(gdir.body), 100)}`);
		const gdiff = await api("GET", `/api/sessions/${sid}/git/diff?work=${WORK}&area=untracked&path=.env`);
		check("C9 Git diff of .env in the worktree is refused", gdiff.status === 403 || gdiff.status === 400, String(gdiff.status));
		for (const [what, work] of [["an unknown work", `${PREFIX}-nope`], ["`.st` as a work id", ".st"], ["a traversal as work id", "../acp"]]) {
			const r = await fs("", work);
			check(`C9 ${what} is refused`, r.status >= 400, `${r.status}`);
		}
		const gs = await api("GET", `/api/sessions/${sid}/git/status?work=${WORK}`);
		check("C9 Git status at the work's root (branch work/<id>)", gs.status === 200 && JSON.stringify(gs.body).includes(`work/${WORK}`), `${gs.status} ${short(JSON.stringify(gs.body), 120)}`);
		const plain = await api("GET", `/api/sessions/${sid}/fs/list?path=${encodeURIComponent(`.st/ctx/${WORK}`)}`);
		check("C9 without `work`, .st/ stays closed", plain.status === 403, String(plain.status));
		const foreign = await api("GET", `/api/sessions/${sids[B]}/fs/list?work=${WORK}&path=`);
		check("C9 another agent's session can't open @A's work", foreign.status >= 400, String(foreign.status));
		await sh(sid, `cd ${WS}/.st/ctx/${WORK} && rm -f .env acp-link main-link etc-link`);
		await api("POST", `/api/acp/works/${WORK}/close`);
		await api("POST", `/api/acp/works/${WORK}/clean`);
		const gone = await fs("");
		check("C9 a cleaned work can't be opened", gone.status >= 400, `${gone.status} ${(await api("GET", "/api/acp/works")).body?.find?.((x) => x.id === WORK)?.state}`);
	}

	// C10. Isolation between projects.
	const tx = await newTopic(pid2, "Tema ajeno");
	const into = await api("POST", "/api/acp/messages", { to: A, body: "hola", conversationId: tx.body?.id, clientId: randomUUID() });
	check("C10 a topic of another project can't carry a message to this project's agent (not-in-project)", into.status === 400 && into.body?.error === "not-in-project", `${into.status} ${short(JSON.stringify(into.body))}`);
	const cross = await api("POST", "/api/acp/messages", { to: X, body: "hola", conversationId: T1, clientId: randomUUID() });
	check("C10 an agent of another project can't be addressed in T1 (not-in-project)", cross.status === 400 && cross.body?.error === "not-in-project", `${cross.status}`);
	const mism = await api("POST", "/api/acp/messages", { to: A, body: "hola", projectId: pid2, conversationId: T1, clientId: randomUUID() });
	check("C10 a projectId that is not the topic's is refused (project-mismatch)", mism.status === 400 && mism.body?.error === "project-mismatch", `${mism.status}`);
	const l2 = await topics(pid2);
	check("C10 the other project's list has only its topic", Array.isArray(l2) && l2.length === 1 && l2[0].id === tx.body?.id, short(JSON.stringify(l2), 120));
	const xr = await waitMsg((await post(X, `consultá a @${A}: hola`, pid2, tx.body?.id)).id);
	// A run working in a topic cannot consult an agent of another project: 409 recipient-other-project, no row.
	check("C10 @X (other project) can't consult @A from its topic (recipient-other-project)", /recipient-other-project/.test(xr.result_text ?? ""), short(xr.result_text, 120));
	check("C10 …and nothing was written for @A", !(await api("GET", `/api/acp/agents/${A}/feed`)).body?.messages?.some((m) => m.from_id === X), "");

	// Resources.
	const cg = await cgroup(sids[A]);
	check(`P6 @${A}: no OOM in its container`, cg.oom === cgBefore.oom && cg.oomKill === 0, `memory.peak ${cgBefore.peakMiB}→${cg.peakMiB} MiB, oom ${cg.oom}, oom_kill ${cg.oomKill}`);
}

main()
	.catch((err) => {
		failures++;
		console.log(`FAIL [${at()}] aborted: ${err.message}`);
	})
	.finally(async () => {
		if (!process.env.KEEP) {
			for (const sid of created.sessions) await api("DELETE", `/api/sessions/${sid}?hard=true`).catch(() => {});
			for (const pid of created.projects) await api("DELETE", `/api/projects/${pid}`).catch(() => {});
		}
		console.log(failures ? `${failures} FAILED` : "ALL PASS");
		process.exit(failures ? 1 : 0);
	});
