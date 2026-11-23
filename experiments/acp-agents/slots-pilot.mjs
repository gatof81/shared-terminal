#!/usr/bin/env node
// Pilot of ACP slots (Entrega 1, #741) against the LAB (experiments/acp-agents/lab-st.sh, ACP_TEST_RUNTIME=1),
// complementing acp-acceptance.mjs §6f. What it adds:
//   P1 global cap (ACP_MAX_RUNNING): two agents with max_concurrency 2 each, 4 long messages at once — the
//      backend never runs more than MAX_RUNNING, and the 4th starts only when one ends;
//   P2 independent ACP contexts: the default context and context "a" keep their own ACP session (message count
//      and cwd reported by the test agent), never the other's;
//   P3 questions: two open at once (default + "a"), each answered in its own message;
//   P4 caps refused at the API: maxConcurrency out of range, a context for a one-slot agent;
//   P5 lowering the cap: after maxConcurrency → 1 nothing more runs in slot 2;
//   P6 resources: memory.events (oom/oom_kill) of the agents' session containers stays 0, memory.peak printed.
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
const send = async (to, body, projectId, context) => {
	const r = await api("POST", "/api/acp/messages", {
		to,
		body,
		...(projectId ? { projectId } : {}),
		...(context ? { context } : {}),
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
const runningOf = async (n) => (await agentFeed(n)).messages.filter((m) => m.to_id === n && m.state === "running");
const short = (s, n = 110) => (s ?? "").replace(/\s+/g, " ").slice(0, n);
const sessionCount = (text) => Number(/sesión ACP: (\d+) mensajes/.exec(text ?? "")?.[1] ?? Number.NaN);
const cwdOf = (text) => /cwd (\S+)\)/.exec(text ?? "")?.[1] ?? null;
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

	// P4. Caps refused at the API.
	const ctx1 = await api("POST", "/api/acp/messages", { to: A1, body: "hola", projectId: pid, context: "a", clientId: randomUUID() });
	check("P4 a context for a one-slot agent is refused (400 context-needs-slots)", ctx1.status === 400 && ctx1.body?.error === "context-needs-slots", `${ctx1.status} ${JSON.stringify(ctx1.body)}`);
	for (const bad of [0, 5, 1.5, "2"]) {
		const r = await api("PATCH", `/api/acp/agents/${A1}`, { maxConcurrency: bad });
		check(`P4 maxConcurrency ${JSON.stringify(bad)} refused`, r.status === 400, String(r.status));
	}
	const badCtx = await api("POST", "/api/acp/messages", { to: A1, body: "hola", projectId: pid, context: "../x", clientId: randomUUID() });
	check("P4 a context name outside [a-z0-9-] is refused", badCtx.status === 400, String(badCtx.status));
	for (const name of [A1, A2]) {
		const r = await api("PATCH", `/api/acp/agents/${name}`, { maxConcurrency: 2 });
		check(`@${name} max_concurrency 2`, r.status === 200 && r.body?.maxConcurrency === 2, String(r.status));
	}
	const before = { [A1]: await cgroup(sids[A1]), [A2]: await cgroup(sids[A2]) };

	// P1. Global cap: 4 long runs that could all start (2 agents × 2 slots), at most MAX_RUNNING at once.
	let peak = 0;
	const watch = setInterval(async () => {
		const n = (await runningOf(A1).catch(() => [])).length + (await runningOf(A2).catch(() => [])).length;
		peak = Math.max(peak, n);
	}, 400);
	const four = [await send(A1, "esperá 12", pid), await send(A1, "esperá 12", pid, "a"), await send(A2, "esperá 12", pid), await send(A2, "esperá 12", pid, "a")];
	const fourDone = await Promise.all(four.map((m) => waitMsg(m.id)));
	clearInterval(watch);
	check("P1 all four done", fourDone.every((m) => m.state === "done"), fourDone.map((m) => m.state).join(","));
	check(`P1 never more than MAX_RUNNING=${MAX_RUNNING} running at once, and the cap was reached`, peak <= MAX_RUNNING && peak === Math.min(4, MAX_RUNNING), `peak ${peak}`);
	if (MAX_RUNNING < 4) {
		const starts = fourDone.map((m) => Date.parse(m.started_at)).sort((a, b) => a - b);
		const firstEnd = Math.min(...fourDone.map((m) => Date.parse(m.finished_at)));
		check("P1 the run over the cap started only after another ended", starts[MAX_RUNNING] >= firstEnd - 1000, `start ${new Date(starts[MAX_RUNNING]).toISOString()} first end ${new Date(firstEnd).toISOString()}`);
	}

	// P2. Independent ACP contexts: each keeps its own session (message count) and directory.
	const d1 = await waitMsg((await send(A1, "hola default", pid)).id);
	const a1 = await waitMsg((await send(A1, "hola a", pid, "a")).id);
	const a2 = await waitMsg((await send(A1, "hola a otra vez", pid, "a")).id);
	const d2 = await waitMsg((await send(A1, "hola default otra vez", pid)).id);
	check("P2 context a counts only its own messages", sessionCount(a2.result_text) === sessionCount(a1.result_text) + 1, `${short(a1.result_text, 60)} → ${short(a2.result_text, 60)}`);
	check("P2 the default context counts only its own", sessionCount(d2.result_text) === sessionCount(d1.result_text) + 1, `${sessionCount(d1.result_text)} → ${sessionCount(d2.result_text)}`);
	check("P2 cwd: default = workspace, a = .st/ctx/a", cwdOf(d1.result_text) === "/home/developer/workspace" && /\/\.st\/ctx\/a$/.test(cwdOf(a1.result_text) ?? ""), `${cwdOf(d1.result_text)} | ${cwdOf(a1.result_text)}`);
	check("P2 slots: default in 1, a in 2", d1.slot === 1 && d2.slot === 1 && a1.slot === 2 && a2.slot === 2, [d1, a1, a2, d2].map((m) => m.slot).join(","));

	// P3. Two questions open at once, one per context; each answer lands in its own message.
	const qd = await send(A1, "preguntá: ¿base? | Postgres | SQLite", pid);
	const qa = await send(A1, "preguntá: ¿color? | rojo | verde", pid, "a");
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

	// P5. Lowering the cap: slot 2 takes nothing more; a new context message is refused.
	const low = await api("PATCH", `/api/acp/agents/${A1}`, { maxConcurrency: 1 });
	check("P5 max_concurrency back to 1", low.status === 200 && low.body?.maxConcurrency === 1, String(low.status));
	const after = await api("POST", "/api/acp/messages", { to: A1, body: "hola", projectId: pid, context: "a", clientId: randomUUID() });
	check("P5 a context message is refused once the cap is 1", after.status === 400, String(after.status));
	const dflt = await waitMsg((await send(A1, "hola", pid)).id);
	check("P5 the default context keeps working in slot 1", dflt.state === "done" && dflt.slot === 1, `${dflt.state} slot ${dflt.slot}`);

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
