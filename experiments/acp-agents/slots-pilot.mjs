#!/usr/bin/env node
// Pilot of ACP slots (Entrega 1, #741) against the LAB (experiments/acp-agents/lab-st.sh, ACP_TEST_RUNTIME=1),
// complementing acp-acceptance.mjs §6f. What it adds:
//   P1 global cap (ACP_MAX_RUNNING): two agents with max_concurrency 2 each, 4 long messages at once — the
//      backend never runs more than MAX_RUNNING, and the 4th starts only when one ends;
//   P2 independent ACP contexts: the default context and a work (v26, its own worktree .st/ctx/<id>) keep their
//      own ACP session (message count and cwd reported by the test agent), never the other's;
//   P3 questions: two open at once (default + work), each answered in its own message;
//   P4 caps refused at the API: maxConcurrency out of range, a work for a one-slot agent, a bad work id;
//   P4b processes: one runner + one adapter per slot (cap 1 → 1, cap 2 → 2);
//   P5 lowering the cap: after maxConcurrency → 1 a message into a work is refused and the default context keeps working; the
//      idle slot 2 stays until the container restarts (known limit of #744, checked as such);
//   P7 depth (#746): a recursive chain of consults is cut — 6 nested requests at depths 1..6, the 7th refused
//      with depth-limit, every request answered at its depth − 1;
//   P8 rounds (#746): `rondas 8` — 8 consults of one agent to another under one person's message, all at depth 1,
//      one root, none refused (neither depth-limit nor chain-budget), and no 9th;
//   P6 resources: memory.events (oom/oom_kill) of the agents' session containers stays 0, memory.peak printed.
// Named contexts exist only as works (`POST /api/acp/works`, a git worktree made by the backend), so each agent's
// workspace gets a git repo first; work ids are never reused, so they carry the run's PREFIX.
// Run the lab with MAX_RUNNING=3:
//   SRC=<checkout> MAX_RUNNING=3 ./experiments/acp-agents/lab-st.sh up
//   ST=http://127.0.0.1:3101 MAX_RUNNING=3 node experiments/acp-agents/slots-pilot.mjs
// Removes the sessions and the project it created (KEEP=1 keeps them). One PASS/FAIL line per check; exit 1 on
// any failure.
import { randomBytes, randomUUID } from "node:crypto";

const ST = process.env.ST ?? "http://127.0.0.1:3101";
const MAX_RUNNING = Number(process.env.MAX_RUNNING ?? 3);
const PREFIX = process.env.PREFIX ?? `p${randomBytes(2).toString("hex")}`;
const A1 = `${PREFIX}-a1`;
const A2 = `${PREFIX}-a2`;
const W = { [A1]: `${A1}-w`, [A2]: `${A2}-w` };
let cookie = "";
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
const send = async (to, body, projectId, work) => {
	const r = await api("POST", "/api/acp/messages", {
		to,
		body,
		...(projectId ? { projectId } : {}),
		...(work ? { work } : {}),
		clientId: randomUUID(),
	});
	if (r.status !== 201) throw new Error(`send ${to}: ${r.status} ${JSON.stringify(r.body)}`);
	return r.body;
};
const get = async (id) => (await api("GET", `/api/acp/messages/${id}`)).body;
async function waitMsg(id, ms = 120_000) {
	const end = Date.now() + ms;
	for (;;) {
		const m = await get(id);
		if (["done", "uncertain", "failed"].includes(m.state) || Date.now() > end) return m;
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
const agentFeed = async (n) => (await api("GET", `/api/acp/agents/${n}/feed`)).body;
const short = (s, n = 110) => (s ?? "").replace(/\s+/g, " ").slice(0, n);
const sessionCount = (text) => Number(/sesión ACP: (\d+) mensajes/.exec(text ?? "")?.[1] ?? Number.NaN);
const cwdOf = (text) => /cwd (\S+)/.exec(text ?? "")?.[1] ?? null;
// stdout of a command in a session container (exec API, NDJSON events).
async function execOut(sid, cmd) {
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
const cgroup = async (sid) => {
	const out = await execOut(sid, ["sh", "-c", "cat /sys/fs/cgroup/memory.peak; cat /sys/fs/cgroup/memory.events; cat /sys/fs/cgroup/cpu.stat"]);
	const kv = Object.fromEntries(out.split("\n").filter((l) => l.includes(" ")).map((l) => l.trim().split(/\s+/)));
	return { peakMiB: Math.round(Number(out.split("\n")[0]) / 1048576), oom: Number(kv.oom ?? Number.NaN), oomKill: Number(kv.oom_kill ?? Number.NaN), throttled: Number(kv.nr_throttled ?? Number.NaN) };
};

async function main() {
	console.log(`slots pilot against ${ST} — agents @${A1}, @${A2}, MAX_RUNNING=${MAX_RUNNING}`);
	const p = await api("POST", "/api/projects", { name: `Piloto slots ${PREFIX}`, clientRequestId: randomUUID() });
	if (!check("project created", p.status === 201, String(p.status))) return;
	const pid = p.body.projectId;
	created.project = pid;
	const sids = {};
	for (const name of [A1, A2]) {
		const r = await api("POST", "/api/sessions", { name: `pilot ${name}`, acpAgent: { name, runtime: "st-test-agent", projectId: pid } });
		check(`session with @${name}`, r.status === 201, `${r.status}`);
		sids[name] = r.body.sessionId;
		created.sessions.push(r.body.sessionId);
	}
	for (const name of [A1, A2])
		check(`runner of @${name} online`, !!(await waitFor(async () => (await agents()).find((a) => a.name === name && a.runnerSeenAt))));

	// Works need a git repo in the agent's workspace (no remote: the base falls back to HEAD; nothing here cleans).
	for (const name of [A1, A2]) {
		const out = await execOut(sids[name], [
			"sh",
			"-c",
			"cd /home/developer/workspace && git init -q -b main && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init && echo repo-ok",
		]);
		check(`a git repo in @${name}'s workspace`, out.includes("repo-ok"), short(out));
	}

	// P4. Caps refused at the API.
	const oneSlot = await api("POST", "/api/acp/works", { agent: A1, id: W[A1] });
	check("P4 a work for a one-slot agent is refused (400 context-needs-slots)", oneSlot.status === 400 && oneSlot.body?.error === "context-needs-slots", `${oneSlot.status} ${JSON.stringify(oneSlot.body)}`);
	for (const bad of [0, 5, 1.5, "2"]) {
		const r = await api("PATCH", `/api/acp/agents/${A1}`, { maxConcurrency: bad });
		check(`P4 maxConcurrency ${JSON.stringify(bad)} refused`, r.status === 400, String(r.status));
	}
	const badId = await api("POST", "/api/acp/works", { agent: A1, id: "../x" });
	check("P4 a work id outside [a-z0-9-] is refused (400 bad-work-id)", badId.status === 400 && badId.body?.error === "bad-work-id", `${badId.status} ${JSON.stringify(badId.body)}`);
	// A refusal writes nothing: no row and no worktree. W[A1] is created later with this same id, and a leftover
	// `creating` row would be absorbed silently by that create's idempotent path.
	const list = await api("GET", "/api/acp/works");
	const left = Array.isArray(list.body) ? list.body.filter((w) => w.agent === A1 || w.id === W[A1]) : null;
	check("P4 the refused creations left no work row", list.status === 200 && left?.length === 0, `${list.status} ${JSON.stringify(left ?? list.body)}`);
	const dir = await execOut(sids[A1], ["sh", "-c", `test -e /home/developer/workspace/.st/ctx/${W[A1]} && echo present || echo absent`]);
	check(`P4 …nor a .st/ctx/${W[A1]} directory`, dir.trim() === "absent", dir.trim());
	// P4b. A one-slot agent runs exactly one runner and one adapter (no extra slot's resources).
	const procs = async (sid) => {
		const out = await execOut(sid, ["sh", "-c", "pgrep -fc '^node --no-warnings /opt/st-acp/st/runner\\.mjs'; pgrep -fc 'test-agent\\.mjs'"]);
		const [runners, adapters] = out.trim().split("\n").map(Number);
		return { runners, adapters };
	};
	for (const name of [A1, A2]) {
		const c = await procs(sids[name]);
		check(`P4b @${name} with max_concurrency 1: one runner, one adapter`, c.runners === 1 && c.adapters === 1, JSON.stringify(c));
	}
	for (const name of [A1, A2]) {
		const r = await api("PATCH", `/api/acp/agents/${name}`, { maxConcurrency: 2 });
		check(`@${name} max_concurrency 2`, r.status === 200 && r.body?.maxConcurrency === 2, String(r.status));
	}
	const two = await waitFor(async () => {
		const c = await procs(sids[A1]);
		return c.runners === 2 && c.adapters === 2 ? c : null;
	}, 60_000);
	check("P4b @A1 with max_concurrency 2: two runners, two adapters", !!two, JSON.stringify(two ?? (await procs(sids[A1]))));
	for (const name of [A1, A2]) {
		const w = await api("POST", "/api/acp/works", { agent: name, id: W[name] });
		if (!check(`work ${W[name]} of @${name} created (worktree on work/${W[name]})`, w.status === 201 && w.body?.state === "active" && w.body?.branch === `work/${W[name]}`, `${w.status} ${JSON.stringify(w.body)}`)) return;
	}
	const before = { [A1]: await cgroup(sids[A1]), [A2]: await cgroup(sids[A2]) };

	// P1. Global cap: 4 long runs that could all start (2 agents × 2 slots), at most MAX_RUNNING at once. The peak
	// comes from the backend's own started_at/finished_at (two separate feed reads could add up a run that ended
	// between them and the one that replaced it).
	const four = [await send(A1, "esperá 12", pid), await send(A1, "esperá 12", pid, W[A1]), await send(A2, "esperá 12", pid), await send(A2, "esperá 12", pid, W[A2])];
	const fourDone = await Promise.all(four.map((m) => waitMsg(m.id)));
	check("P1 all four done", fourDone.every((m) => m.state === "done"), fourDone.map((m) => m.state).join(","));
	const edges = fourDone.flatMap((m) => [[Date.parse(m.started_at), 1], [Date.parse(m.finished_at), -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	let peak = 0;
	let now = 0;
	for (const [, d] of edges) peak = Math.max(peak, (now += d));
	check(`P1 never more than MAX_RUNNING=${MAX_RUNNING} running at once, and the cap was reached`, peak <= MAX_RUNNING && peak === Math.min(4, MAX_RUNNING), `peak ${peak}`);
	if (MAX_RUNNING < 4) {
		const starts = fourDone.map((m) => Date.parse(m.started_at)).sort((a, b) => a - b);
		const firstEnd = Math.min(...fourDone.map((m) => Date.parse(m.finished_at)));
		check("P1 the run over the cap started only after another ended", starts[MAX_RUNNING] >= firstEnd - 1000, `start ${new Date(starts[MAX_RUNNING]).toISOString()} first end ${new Date(firstEnd).toISOString()}`);
	}

	// P2. Independent ACP contexts (default and the work): each keeps its own session (message count) and directory.
	const d1 = await waitMsg((await send(A1, "hola default", pid)).id);
	const a1 = await waitMsg((await send(A1, "hola a", pid, W[A1])).id);
	const a2 = await waitMsg((await send(A1, "hola a otra vez", pid, W[A1])).id);
	const d2 = await waitMsg((await send(A1, "hola default otra vez", pid)).id);
	check("P2 the work counts only its own messages", sessionCount(a2.result_text) === sessionCount(a1.result_text) + 1, `${short(a1.result_text, 60)} → ${short(a2.result_text, 60)}`);
	check("P2 the default context counts only its own", sessionCount(d2.result_text) === sessionCount(d1.result_text) + 1, `${sessionCount(d1.result_text)} → ${sessionCount(d2.result_text)}`);
	check(`P2 cwd: default = workspace, the work = .st/ctx/${W[A1]}`, cwdOf(d1.result_text) === "/home/developer/workspace" && cwdOf(a1.result_text) === `/home/developer/workspace/.st/ctx/${W[A1]}`, `${cwdOf(d1.result_text)} | ${cwdOf(a1.result_text)}`);
	check("P2 slots: default in 1, the work in 2", d1.slot === 1 && d2.slot === 1 && a1.slot === 2 && a2.slot === 2, [d1, a1, a2, d2].map((m) => m.slot).join(","));

	// P3. Two questions open at once, one per context (default and the work); each answer lands in its own message.
	const qd = await send(A1, "preguntá: ¿base? | Postgres | SQLite", pid);
	const qa = await send(A1, "preguntá: ¿color? | rojo | verde", pid, W[A1]);
	const open = await waitFor(async () => {
		const qs = (await (await api("GET", `/api/acp/projects/${pid}/feed`)).body)?.questions?.filter((q) => q.state === "open") ?? [];
		const byMsg = Object.fromEntries(qs.map((q) => [q.message_id, q]));
		return byMsg[qd.id] && byMsg[qa.id] ? byMsg : null;
	});
	check("P3 both questions open at once, each linked to its own message", !!open);
	if (open) {
		await api("POST", `/api/acp/questions/${open[qa.id].id}/answer`, { action: "accept", content: { question_0: "verde" } });
		await api("POST", `/api/acp/questions/${open[qd.id].id}/answer`, { action: "accept", content: { question_0: "SQLite" } });
		const [rd, ra] = [await waitMsg(qd.id), await waitMsg(qa.id)];
		check("P3 each answer reached its own run", /Elegiste: SQLite/.test(rd.result_text ?? "") && /Elegiste: verde/.test(ra.result_text ?? ""), `${short(rd.result_text, 40)} | ${short(ra.result_text, 40)}`);
	}

	// P5. Lowering the cap: slot 2 takes nothing more; a new message into the (still active) work is refused.
	const low = await api("PATCH", `/api/acp/agents/${A1}`, { maxConcurrency: 1 });
	check("P5 max_concurrency back to 1", low.status === 200 && low.body?.maxConcurrency === 1, String(low.status));
	const after = await api("POST", "/api/acp/messages", { to: A1, body: "hola", projectId: pid, work: W[A1], clientId: randomUUID() });
	check("P5 a message into the work is refused once the cap is 1 (400 context-needs-slots)", after.status === 400 && after.body?.error === "context-needs-slots", `${after.status} ${JSON.stringify(after.body)}`);
	const dflt = await waitMsg((await send(A1, "hola", pid)).id);
	check("P5 the default context keeps working in slot 1", dflt.state === "done" && dflt.slot === 1, `${dflt.state} slot ${dflt.slot}`);
	// #744: lowering the cap leaves the extra slot idle (it claims nothing) until the container restarts — a known
	// limit: two processes are expected here, and the check says so.
	const lowered = await procs(sids[A1]);
	check(`P5 after lowering to 1, @${A1} keeps the idle slot 2 until its container restarts (known limit, #744): two runners, two adapters`, lowered.runners === 2 && lowered.adapters === 2, JSON.stringify(lowered));

	// P7. A recursive chain is cut at ACP_MAX_DEPTH (6): seven nested consults alternating @A1 ⇄ @A2 — each agent
	// unwraps one "consultá a @x:" and sends the rest. Requests land at depths 1..6; the 7th is refused.
	const projectRows = async () => (await api("GET", `/api/acp/projects/${pid}/feed`)).body?.messages ?? [];
	const ofRoot = (rows, root) => rows.filter((m) => m.root_id === root);
	let nested = "fin de la cadena";
	for (let i = 7; i >= 1; i--) nested = `consultá a @${i % 2 ? A2 : A1}: ${nested}`;
	const r7 = await send(A1, nested, pid);
	const chain = await waitFor(async () => {
		const rows = ofRoot(await projectRows(), r7.id);
		const reqs = rows.filter((m) => m.kind === "request");
		const reps = rows.filter((m) => m.kind === "reply");
		const deepest = reqs.find((m) => m.depth === 6);
		return reqs.length >= 6 && reps.length >= 6 && deepest?.state === "done" && reps.every((m) => m.state === "done") ? { reqs, reps, deepest } : null;
	}, 180_000);
	if (check("P7 the chain settled (6 requests and 6 replies done)", !!chain)) {
		const depths = chain.reqs.map((m) => m.depth).sort((a, b) => a - b);
		check("P7 requests at depths 1..6 under the person's message, no 7th", depths.join(",") === "1,2,3,4,5,6", depths.join(","));
		check("P7 the 7th consult was refused with depth-limit", /depth-limit/.test(chain.deepest.result_text ?? ""), short(chain.deepest.result_text, 160));
		const byId = Object.fromEntries(chain.reqs.map((m) => [m.id, m]));
		check(
			"P7 each reply comes back at its request's depth − 1",
			chain.reps.every((r) => byId[r.reply_to] && r.depth === byId[r.reply_to].depth - 1),
			chain.reps.map((r) => `${byId[r.reply_to]?.depth}→${r.depth}`).join(" "),
		);
	}

	// P8. Rounds are not nesting: 8 consults of @A1 to @A2, one per reply, all at depth 1 under one root.
	const r8 = await send(A1, `rondas 8: consultá a @${A2}: ronda`, pid);
	const rounds = await waitFor(async () => {
		const rows = ofRoot(await projectRows(), r8.id);
		const reqs = rows.filter((m) => m.kind === "request");
		const reps = rows.filter((m) => m.kind === "reply");
		return reqs.length >= 8 && reps.length >= 8 && [...reqs, ...reps].every((m) => m.state === "done") ? { reqs, reps } : null;
	}, 240_000);
	if (check("P8 eight rounds settled (8 requests and 8 replies done)", !!rounds)) {
		await sleep(5_000);
		const rows = ofRoot(await projectRows(), r8.id);
		const reqs = rows.filter((m) => m.kind === "request");
		check("P8 exactly 8 requests, all @A1 → @A2 at depth 1", reqs.length === 8 && reqs.every((m) => m.from_id === A1 && m.to_id === A2 && m.depth === 1), reqs.map((m) => `${m.from_id}→${m.to_id}@${m.depth}`).join(" "));
		const refused = rows.filter((m) => /depth-limit|chain-budget/.test(m.result_text ?? ""));
		check("P8 no round refused (depth-limit / chain-budget)", refused.length === 0, refused.map((m) => `#${m.id}: ${short(m.result_text, 80)}`).join(" | "));
	}

	// P6. Resources of the two session containers.
	for (const name of [A1, A2]) {
		const c = await cgroup(sids[name]);
		check(`P6 @${name}: no OOM in its container`, c.oom === before[name].oom && c.oomKill === before[name].oomKill && c.oomKill === 0, `memory.peak ${c.peakMiB} MiB, oom ${c.oom}, oom_kill ${c.oomKill}, nr_throttled ${before[name].throttled}→${c.throttled}`);
	}
}

main()
	.catch((err) => {
		failures++;
		console.log(`FAIL [${at()}] aborted: ${err.message}`);
	})
	.finally(async () => {
		if (!process.env.KEEP) {
			for (const sid of created.sessions) await api("DELETE", `/api/sessions/${sid}?hard=true`).catch(() => {});
			if (created.project) await api("DELETE", `/api/projects/${created.project}`).catch(() => {});
		}
		console.log(failures ? `${failures} FAILED` : "ALL PASS");
		process.exit(failures ? 1 : 0);
	});
