#!/usr/bin/env node
// Acceptance of ACP tasks (Etapa 4A, issue #794) against a LAB Shared Terminal — never
// production: it refuses any ST that is not loopback. Deterministic: agents run the test
// adapter (runtime `st-test-agent`, backend with ACP_TEST_RUNTIME=1), no model.
// Complements acp-acceptance.mjs step 6i (team ⇒ one goal; goal-budget) — not repeated here.
//
//   S7  concurrency: two writes on one `version` ⇒ one 200, the other 409 `stale` with the
//       current row and lastEvent; `st task move --version <old>` says so.
//   S8  other project: an agent of project B reads/writes a task of A ⇒ the same 404 as a
//       missing one; an agent in no project ⇒ 409 `no-project` (API and `st task`).
//   S9  the assignee never approves (`st task done` ⇒ 403 self-approval); the reviewer, the
//       coordinator and the person do; an ex-assignee does not (`done`), a non-coordinator
//       ex-assignee cannot declare `scope-approved`.
//   S10 runner killed while a message of a task runs ⇒ `uncertain`, not resent; the task's
//       status/version/children/links unchanged; derived `uncertain` («interrumpido sin
//       revisar» in `st task show`) until reviewed.
//   S11 a loop inside a task is cut by `task-budget`; an agent cannot raise (403); the person
//       raises ⇒ the next request passes; `budget-exhausted` once per limit.
//   S12 /ws/acp: one `task` frame per write to the owner; nothing to another owner.
//   S13 board with ~50 and ~500 tasks: page ≤ 200 (150 open + 50 done); D1 cost of one load
//       (delta of GET /api/admin/stats → d1). Real D1 (rows_read reported): rows ≤
//       ROWS_PER_TASK × returned + ROWS_SLACK (6: real D1 counts a read row per id that
//       `json_each(?)` yields, so the per-page statements over the page's ids add ~5.3 rows
//       per task returned, measured in OPS-RESULT 3; what is guarded is that the cost is
//       linear in the page and has no scan, not a fixed per-task figure). Shim (no rows_read): same number of statements
//       with 50 and 500. The EXPLAIN QUERY PLAN of the board is pinned by
//       backend/src/acp/acp.sqlite.test.ts ("D1 reads: the board goes by index (v29)").
//   S17 the agent-request INSERT in a task (trigger trg_task_request_counted): rows read by
//       that statement constant with 50 and 500 tasks (real D1 only; the shim has no
//       rows_read). Its trigger's plan is pinned by the same test file ("the request counter
//       trigger updates tasks by key").
//   S15 backup (lab A) → restore (lab B: own D1 and WORKSPACE_ROOT, same
//       SECRETS_ENCRYPTION_KEY and ACP_*_BUDGET) ⇒ tasks, links, events, agent_messages.task_id
//       1:1; a second restore without --force is refused.
//   S14 IDLE_MS at rest with idle agents and /ws/acp open: no statement on tasks/task_links/
//       task_events, total D1 calls (and rows) under the thresholds printed below.
//
// Needs Node ≥ 22 (the global WebSocket of S12; Node 18 has none): it refuses to start otherwise.
// Run (one pass; Docker on this host for S10, S15):
//   ACP_GOAL_BUDGET=150 ACP_TASK_BUDGET=3 ./lab-st.sh up                         # lab A :3101
//   LAB=$HOME/acp-lab2 LAB_NAME=acplab2 PORT=3102 ENV_FILE=$HOME/acp-lab/backend.env \
//     ACP_GOAL_BUDGET=150 ACP_TASK_BUDGET=3 ./lab-st.sh up                       # lab B :3102, empty
//   ST=http://127.0.0.1:3101 LAB_LOGIN=1 node tasks-acceptance.mjs
// Lab B must be FRESH (no user registered): the restore refuses a non-empty target, which is
// the point of the second half of S15. Do not log into it before the run. S15 stops it after
// comparing (same session ids as A on one Docker daemon); `LAB=$HOME/acp-lab2 LAB_NAME=acplab2
// ./lab-st.sh down` removes it.
//
// Variables (defaults in brackets; the run prints them):
//   ST [http://127.0.0.1:3101]  LAB_LOGIN=1 (registers/logs in labowner; lab only)  PREFIX  KEEP=1
//   ONLY=S7,S13,…  (sections to run; default all)   D1_VARIANT=rows|calls (default: detected)
//   SEED_SMALL [50] SEED_BIG [500] SEED_CONCURRENCY [6] ROWS_PER_TASK [6] ROWS_SLACK [50]
//   S17_SLACK [0] (rows the INSERT may grow from 50 to 500 tasks)  ROUND_MS [30000] (per round, S11)
//   IDLE_MS [600000] IDLE_MAX_CALLS_PER_MIN [60] IDLE_MAX_ROWS_PER_MIN [3000]
//   LAB_B_ST [http://127.0.0.1:3102] LAB_A_CONTAINER [acplab-backend] LAB_B_CONTAINER [acplab2-backend]
//   BACKUP_CMD / RESTORE_CMD / COPY_CMD / RESTART_B_CMD / STOP_B_CMD: shell templates for S15
//     ({dir} = backup dir in lab A, {dirB} = the same in lab B, both under <WORKSPACE_ROOT>/.backups/,
//     {name} = its name; with BACKUP_CMD/RESTORE_CMD set, build paths from {name}); defaults drive
//     the two containers with docker.
// Prints one PASS/FAIL line per check (SKIP = not measurable in this variant, said why); exit 0
// only when nothing failed.
import { execSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";

if (typeof WebSocket !== "function") {
	console.log(`FAIL refusing to run: Node ${process.version} has no global WebSocket (S12 needs it) — use Node 22 or later`);
	console.log("1 FAILED");
	process.exit(1);
}
const env = process.env;
const ST = env.ST ?? "http://127.0.0.1:3101";
const LAB_B_ST = env.LAB_B_ST ?? "http://127.0.0.1:3102";
const PREFIX = env.PREFIX ?? `k${randomBytes(2).toString("hex")}`;
const ARQ = `${PREFIX}-arq`;
const DEV = `${PREFIX}-dev`;
const REV = `${PREFIX}-rev`;
const num = (k, d) => (env[k] === undefined || env[k] === "" ? d : Number(env[k]));
const CFG = {
	SEED_SMALL: num("SEED_SMALL", 50),
	SEED_BIG: num("SEED_BIG", 500),
	SEED_CONCURRENCY: num("SEED_CONCURRENCY", 6),
	ROWS_PER_TASK: num("ROWS_PER_TASK", 6),
	ROWS_SLACK: num("ROWS_SLACK", 50),
	S17_SLACK: num("S17_SLACK", 0),
	ROUND_MS: num("ROUND_MS", 30_000),
	IDLE_MS: num("IDLE_MS", 600_000),
	IDLE_MAX_CALLS_PER_MIN: num("IDLE_MAX_CALLS_PER_MIN", 60),
	IDLE_MAX_ROWS_PER_MIN: num("IDLE_MAX_ROWS_PER_MIN", 3000),
};
const A_C = env.LAB_A_CONTAINER ?? "acplab-backend";
const B_C = env.LAB_B_CONTAINER ?? "acplab2-backend";
const ALL = ["S7", "S8", "S9", "S10", "S11", "S12", "S13", "S17", "S15", "S14"];
const ONLY = env.ONLY ? env.ONLY.split(",").map((s) => s.trim().toUpperCase()) : ALL;
const on = (s) => ONLY.includes(s);
const NEEDS_AGENTS = ["S7", "S8", "S9", "S10", "S11", "S17"].some(on);

for (const [k, u] of [["ST", ST], ["LAB_B_ST", LAB_B_ST]]) {
	const h = new URL(u).hostname;
	if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(h)) {
		console.log(`FAIL refusing to run: ${k}=${u} is not loopback (lab only, never production)`);
		process.exit(1);
	}
}

let failures = 0;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
function check(name, ok, evidence) {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"} [${at()}] ${name}${evidence ? ` — ${evidence}` : ""}`);
	return ok;
}
const skip = (name, why) => console.log(`SKIP [${at()}] ${name} — ${why}`);
const short = (s, n = 140) => (typeof s === "string" ? s : JSON.stringify(s ?? null)).replace(/\s+/g, " ").slice(0, n);
const J = (v) => JSON.stringify(v);

// ── HTTP clients ─────────────────────────────────────────────────────────

/** A person's client on one lab: cookie login (register first when LAB_LOGIN=1). */
function client(base, username = "labowner", inviteCode, register = env.LAB_LOGIN === "1") {
	let cookie = "";
	async function auth() {
		if (cookie) return;
		const body = (extra) => JSON.stringify({ username, password: "lab-password-1234", ...extra });
		const tries = register ? [["/api/auth/register", { inviteCode }], ["/api/auth/login", {}]] : [["/api/auth/login", {}]];
		for (const [path, extra] of tries) {
			const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: body(extra) });
			const set = r.headers.get("set-cookie");
			if (r.ok && set) {
				cookie = set.split(";")[0];
				return;
			}
		}
		throw new Error(`no login as ${username} on ${base}`);
	}
	async function api(method, path, body) {
		await auth();
		return raw(base, method, path, body, { cookie });
	}
	return { api, auth, cookie: () => cookie, base };
}
async function raw(base, method, path, body, headers = {}) {
	const res = await fetch(base + path, {
		method,
		headers: { "content-type": "application/json", ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let json = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {}
	return { status: res.status, body: json ?? text };
}
const A = client(ST);
const api = A.api;
/** An agent's own API calls (its runner's token, `Bearer acp1.…`). */
const asAgent = (token) => (method, path, body) => raw(ST, method, `/api/acp${path}`, body, { authorization: `Bearer ${token}` });

// ── ACP helpers (same shapes as acp-acceptance.mjs) ─────────────────────

const get = async (id) => (await api("GET", `/api/acp/messages/${id}`)).body;
async function waitMsg(id, states = ["done", "uncertain", "failed"], ms = 120_000) {
	const end = Date.now() + ms;
	for (;;) {
		const m = await get(id);
		if (states.includes(m?.state) || Date.now() > end) return m;
		await sleep(1_000);
	}
}
async function waitFor(fn, ms = 120_000, every = 1_500) {
	const end = Date.now() + ms;
	for (;;) {
		const v = await fn();
		if (v || Date.now() > end) return v;
		await sleep(every);
	}
}
const agents = async () => (await api("GET", "/api/acp/agents")).body;
const agentFeed = async (n) => (await api("GET", `/api/acp/agents/${n}/feed`)).body;
const waitTurnStarted = (n, id, ms = 30_000) =>
	waitFor(async () => (await agentFeed(n)).activity?.[n]?.some((e) => e.kind === "turn" && e.phase === "start" && e.messageId === id), ms, 500);
const msgsOf = async (n) => (await api("GET", `/api/acp/messages?agent=${n}`)).body ?? [];
const runnerOnline = async (name) =>
	(await agents()).find((a) => a.name === name && a.runnerSeenAt && Date.now() - Date.parse(a.runnerSeenAt) < 15_000);
const send = async (to, body, extra = {}) => {
	const r = await api("POST", "/api/acp/messages", { to, body, clientId: randomUUID(), ...extra });
	if (r.status !== 201) throw new Error(`send ${to}: ${r.status} ${J(r.body)}`);
	return r.body;
};
/** Every agent of the run idle: nothing running, nothing pending. */
const waitIdle = (names, ms = 180_000) =>
	waitFor(async () => {
		const all = await agents();
		return names.every((n) => {
			const a = all.find((x) => x.name === n);
			return a && !a.running?.length && !a.pending;
		});
	}, ms);
async function execOut(sid, script) {
	await A.auth();
	const r = await fetch(`${ST}/api/sessions/${sid}/exec`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie: A.cookie() },
		body: J({ cmd: ["sh", "-c", script] }),
	});
	let out = "";
	let code = null;
	for (const line of (await r.text()).split("\n").filter(Boolean)) {
		let e;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (e.type === "output") out += e.data;
		if (e.type === "exit") code = e.exitCode;
	}
	return { code, out: out.trim() };
}

// ── Tasks helpers ───────────────────────────────────────────────────────

const show = async (id, call = api) => (await call("GET", call === api ? `/api/acp/tasks/${id}` : `/tasks/${id}`));
const taskOf = async (id) => (await show(id)).body?.task;
async function mkTask(body) {
	const r = await api("POST", "/api/acp/tasks", body);
	if (r.status !== 201) throw new Error(`task ${J(body)}: ${r.status} ${J(r.body)}`);
	return r.body;
}
const patch = (id, body, call = api) => call("PATCH", call === api ? `/api/acp/tasks/${id}` : `/tasks/${id}`, body);
const link = (id, body, call = api) => call("POST", call === api ? `/api/acp/tasks/${id}/links` : `/tasks/${id}/links`, body);
/** The test agent runs `st <args>` as a tool call and answers `st … → exit N: <output>`. */
async function stBy(agent, args, extra = {}) {
	const m = await waitMsg((await send(agent, `st: ${args}`, extra)).id);
	const code = Number(/→ exit (\d+)/.exec(m?.result_text ?? "")?.[1] ?? -1);
	return { m, code, text: m?.result_text ?? "" };
}

// ── D1 counters (GET /api/admin/stats → d1) ─────────────────────────────

async function d1() {
	// Every statement key the backend keeps (≤ 200), not the default top 10: S14 and S17 look for
	// statements with few rows. A backend without `?top=` ignores it and answers its 10.
	const r = await api("GET", "/api/admin/stats?top=200");
	if (r.status !== 200) throw new Error(`admin stats: ${r.status} (the lab owner must be admin)`);
	const d = r.body.d1;
	return {
		calls: d.callsSinceBoot,
		rows: d.rowsReadSinceBoot ?? 0,
		top: new Map((d.topStatements ?? []).map((s) => [s.statement, s])),
	};
}
function delta(a, b) {
	const top = [];
	for (const [k, s] of b.top) {
		const p = a.top.get(k);
		const q = s.queries - (p?.queries ?? 0);
		const r = s.rowsRead - (p?.rowsRead ?? 0);
		// A statement new in the top may have run before (it was under the cut): its delta is an upper bound.
		if (q > 0 || r > 0) top.push({ statement: k, queries: q, rows: r, wasInTop: !!p });
	}
	return { calls: b.calls - a.calls, rows: b.rows - a.rows, top };
}
/**
 * D1 spent by `fn` alone: stats, stats (the stats read's own cost + background), fn, stats —
 * minus the empty pair. Best (lowest) of `n` tries: background (an idle runner's claim) only adds.
 */
async function measure(fn, n = 3) {
	let best = null;
	for (let i = 0; i < n; i++) {
		const s0 = await d1();
		const s1 = await d1();
		const result = await fn();
		const s2 = await d1();
		const base = delta(s0, s1);
		const d = delta(s1, s2);
		const m = { calls: d.calls - base.calls, rows: d.rows - base.rows, top: d.top, result };
		if (!best || m.calls < best.calls || (m.calls === best.calls && m.rows < best.rows)) best = m;
	}
	return best;
}
const TASK_SQL = /\b(tasks|task_links|task_events)\b/;

// ── Main ────────────────────────────────────────────────────────────────

const created = { sessions: [], projects: [] };
const ctx = {}; // ids shared between sections (S15 compares them)
const msgIds = new Set();

async function main() {
	console.log(`Tasks acceptance against ${ST} — prefix ${PREFIX}, sections ${ONLY.join(",")}`);
	// No backend answering is a FAIL, never a quiet exit (OPS-RESULT 3: a run
	// against a backend still migrating printed its header and nothing else).
	const status = await fetch(`${ST}/api/auth/status`, { signal: AbortSignal.timeout(15_000) }).catch((err) => err);
	if (!(status instanceof Response) || !status.ok)
		throw new Error(`cannot reach the backend at ${ST}/api/auth/status: ${status instanceof Response ? status.status : status.message}`);
	console.log(`config: ${J({ ...CFG, LAB_B_ST, LAB_A_CONTAINER: A_C, LAB_B_CONTAINER: B_C, D1_VARIANT: env.D1_VARIANT ?? "auto" })}`);
	const s0 = await d1();
	const rowsMode = env.D1_VARIANT ? env.D1_VARIANT === "rows" : s0.rows > 0 || s0.top.size > 0;
	console.log(`D1 variant: ${rowsMode ? "rows (rows_read reported: real D1)" : "calls (no rows_read: shim)"}`);

	const newProject = async (name) => {
		const p = await api("POST", "/api/projects", { name, clientRequestId: randomUUID() });
		if (p.status !== 201) throw new Error(`project: ${p.status} ${J(p.body)}`);
		created.projects.push(p.body.projectId);
		return p.body.projectId;
	};
	const PA = await newProject(`Tareas A ${PREFIX}`);
	const PB = await newProject(`Tareas B ${PREFIX}`);
	ctx.PA = PA;
	check("projects A and B created", !!PA && !!PB, `${PA} ${PB}`);

	const sids = {};
	const tok = {};
	if (NEEDS_AGENTS) {
		const rt = await api("GET", "/api/acp/runtimes");
		if (!check("runtime st-test-agent installed", rt.body?.available?.includes("st-test-agent"), J(rt.body))) return;
		for (const name of [ARQ, DEV, REV]) {
			const r = await api("POST", "/api/sessions", { name: `tasks ${name}`, acpAgent: { name, runtime: "st-test-agent", projectId: PA } });
			check(`session with agent @${name} in project A`, r.status === 201, `${r.status} ${r.body?.sessionId ?? J(r.body)}`);
			sids[name] = r.body.sessionId;
			created.sessions.push(r.body.sessionId);
		}
		for (const name of [ARQ, DEV, REV]) check(`runner of @${name} online`, !!(await waitFor(() => runnerOnline(name), 120_000)));
		// The agent's own credential, as its `st` has it: the default context's token in its
		// runner's environment (recomputable by the backend, never stored).
		for (const name of [ARQ, DEV, REV]) {
			const r = await execOut(
				sids[name],
				"for p in /proc/[0-9]*; do tr '\\0' '\\n' < $p/environ 2>/dev/null | grep -m1 -E '^ST_TOKEN=acp1\\.[0-9a-f-]{36}\\.[A-Za-z0-9_-]{43}$'; done | sort -u | head -1",
			);
			tok[name] = asAgent(r.out.replace(/^ST_TOKEN=/, ""));
			check(`token of @${name} read from its runner`, /^ST_TOKEN=acp1\./.test(r.out), r.out ? "acp1.…" : `exit ${r.code}`);
		}
	}

	// ── S12 first: its socket stays open for the whole run (S14 uses it) ──
	const frames = { a: [], b: [] };
	let wsA = null;
	let wsB = null;
	if (on("S12") || on("S14")) {
		const openWs = (base, cookie, into) =>
			new Promise((ok, ko) => {
				const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws/acp`, { headers: { cookie } });
				ws.onmessage = (e) => into.push({ at: Date.now(), ...JSON.parse(String(e.data)) });
				ws.onopen = () => ok(ws);
				ws.onerror = (e) => ko(new Error(`ws: ${e.message ?? "error"}`));
			});
		await A.auth();
		wsA = await openWs(ST, A.cookie(), frames.a);
		await waitFor(async () => frames.a.some((f) => f.type === "hello"), 5_000, 100);
		check("/ws/acp open for the owner (hello)", frames.a.some((f) => f.type === "hello"));
	}

	if (on("S12")) {
		console.log("── S12 live task events");
		// A second owner: invited by the lab owner (admin), or the one an earlier run made.
		const inv = await api("POST", "/api/invites");
		const B2 = client(ST, "labother", inv.body?.code);
		await B2.auth();
		wsB = await new Promise((ok, ko) => {
			const ws = new WebSocket(`${ST.replace(/^http/, "ws")}/ws/acp`, { headers: { cookie: B2.cookie() } });
			ws.onmessage = (e) => frames.b.push({ at: Date.now(), ...JSON.parse(String(e.data)) });
			ws.onopen = () => ok(ws);
			ws.onerror = (e) => ko(new Error(`ws: ${e.message ?? "error"}`));
		});
		await waitFor(async () => frames.b.length > 0, 5_000, 100);
		const helloB = frames.b.length;
		const t = await mkTask({ projectId: PA, title: "S12 en vivo" });
		ctx.s12 = t.id;
		const writes = [["created", null]];
		let v = t.version;
		for (const [what, body] of [
			["title", { title: "S12 en vivo (renombrada)" }],
			["priority", { priority: "high" }],
			["status", { status: "doing" }],
		]) {
			const r = await patch(t.id, { version: v, ...body });
			v = r.body?.version ?? v;
			writes.push([what, r.status]);
		}
		for (const body of [{ kind: "external", ref: "proveedor S12" }, { kind: "pr", ref: "12" }]) {
			const r = await link(t.id, { version: v, ...body });
			v = r.body?.version ?? v;
			writes.push([`link ${body.kind}`, r.status]);
		}
		const raise = await api("POST", `/api/acp/tasks/${t.id}/budget`, { add: 1 });
		writes.push(["budget", raise.status]);
		check("S12 writes accepted", writes.slice(1).every(([, s]) => s === 200), writes.map(([w, s]) => `${w}:${s ?? 201}`).join(" "));
		await sleep(1_500);
		const mine = frames.a.filter((f) => f.type === "task" && f.task?.id === t.id);
		check(
			"S12 the owner's socket got exactly one `task` frame per write, in order",
			mine.length === writes.length && mine.every((f, i) => i === 0 || f.task.version >= mine[i - 1].task.version),
			`${mine.length} frames for ${writes.length} writes; versions ${mine.map((f) => f.task.version).join(",")}`,
		);
		check("S12 the last frame carries the task as it is now", mine.at(-1)?.task?.title === "S12 en vivo (renombrada)" && mine.at(-1)?.task?.priority === "high", short(mine.at(-1)?.task));
		check("S12 another owner's socket got nothing", frames.b.length === helloB && frames.b.every((f) => f.type === "hello"), `${frames.b.length - helloB} frames after hello`);
		const foreign = await B2.api("GET", `/api/acp/tasks/${t.id}`);
		check("S12 …and another owner reads the task as missing (404)", foreign.status === 404, `${foreign.status} ${J(foreign.body)}`);
		wsB.close();
	}

	if (NEEDS_AGENTS) {
		// One goal coordinated by @arq for S7–S9 (the person creates it; budgets far away).
		const G = await mkTask({ projectId: PA, title: "Objetivo S7–S9", coordinator: ARQ, budgetLimit: 1000 });
		ctx.goal = G.id;
		check("goal coordinated by @arq", G.coordinator === ARQ && G.parentId === null, `#${G.id}`);

		if (on("S7")) {
			console.log("── S7 concurrency");
			const c = await mkTask({ parentId: G.id, title: "S7 carrera", assignee: DEV });
			const v = c.version;
			// Same version, the person and the coordinator, at once.
			const [p, a] = await Promise.all([patch(c.id, { version: v, priority: "high" }), patch(c.id, { version: v, priority: "low" }, tok[ARQ])]);
			const ok = [p, a].filter((r) => r.status === 200);
			const stale = [p, a].find((r) => r.status === 409);
			check("S7 two writes on one version: one 200, one 409 stale", ok.length === 1 && stale?.body?.error === "stale", `${p.status} ${a.status}`);
			const winner = ok[0]?.body;
			check(
				"S7 …the 409 carries the current row (version + 1, the winner's value)",
				stale?.body?.task?.id === c.id && stale.body.task.version === v + 1 && stale.body.task.priority === winner?.priority,
				short(stale?.body?.task && { v: stale.body.task.version, prio: stale.body.task.priority }),
			);
			check(
				"S7 …and lastEvent says who changed what",
				stale?.body?.lastEvent?.actor === (winner?.updatedBy ?? "?") && stale.body.lastEvent.data?.priority?.[1] === winner?.priority,
				short(stale?.body?.lastEvent),
			);
			const now = await taskOf(c.id);
			check("S7 only one write landed", now.version === v + 1, `v${now.version} ${now.priority}`);
			const cli = await stBy(DEV, `task move ${c.id} doing --version ${v}`);
			check("S7 `st task move --version <old>`: exit 1, stale, with the task as it is now", cli.code === 1 && /\(stale/.test(cli.text) && cli.text.includes(`ahora: #${c.id}`), short(cli.text, 220));
			check("S7 …and nothing changed", (await taskOf(c.id)).version === v + 1);
			ctx.s7 = c.id;
		}

		if (on("S8")) {
			console.log("── S8 other project");
			const c = await mkTask({ parentId: G.id, title: "S8 ajena", assignee: DEV });
			ctx.s8 = c.id;
			const mv = await api("PATCH", `/api/acp/agents/${REV}`, { projectId: PB });
			check("S8 @rev moved to project B", mv.status === 200 && mv.body?.projectId === PB, J(mv.body?.projectId));
			const R = tok[REV];
			const missing = 999_999_999;
			const reads = {
				show: await R("GET", `/tasks/${c.id}`),
				showMissing: await R("GET", `/tasks/${missing}`),
				patch: await R("PATCH", `/tasks/${c.id}`, { version: c.version, status: "doing" }),
				patchMissing: await R("PATCH", `/tasks/${missing}`, { version: 1, status: "doing" }),
				link: await R("POST", `/tasks/${c.id}/links`, { version: c.version, kind: "external", ref: "x" }),
				child: await R("POST", "/tasks", { parentId: G.id, title: "x" }),
			};
			check(
				"S8 an agent of B reads/writes a task of A ⇒ 404, the same body as a missing one",
				["show", "patch", "link", "child"].every((k) => reads[k].status === 404 && J(reads[k].body) === J(reads.showMissing.body)) && J(reads.patchMissing.body) === J(reads.show.body),
				`${Object.entries(reads).map(([k, r]) => `${k}:${r.status}`).join(" ")} ${J(reads.show.body)}`,
			);
			const boardA = await R("GET", `/tasks?projectId=${PA}`);
			const boardB = await R("GET", "/tasks");
			check("S8 …A's board is 404 for it, its own (B) answers", boardA.status === 404 && boardB.status === 200 && boardB.body.projectId === PB, `${boardA.status} ${boardB.status}`);
			const send8 = await stBy(REV, `send @${DEV} --task ${c.id} "de otro proyecto"`);
			check("S8 …`st send --task` a task of A ⇒ refused, nothing sent", send8.code === 1 && /task-not-found|404/.test(send8.text), short(send8.text, 200));
			check("S8 …the task did not change", (await taskOf(c.id)).version === c.version);
			const out = await api("PATCH", `/api/acp/agents/${REV}`, { projectId: null });
			check("S8 @rev in no project", out.status === 200 && out.body?.projectId === null);
			const np = [await R("GET", "/tasks"), await R("GET", `/tasks/${c.id}`), await R("POST", "/tasks", { title: "x" })];
			check("S8 an agent in no project ⇒ 409 no-project (board, show, create)", np.every((r) => r.status === 409 && r.body?.error === "no-project"), np.map((r) => `${r.status} ${r.body?.error}`).join(" | "));
			const cliNp = await stBy(REV, "task list");
			check("S8 …and `st task list` says so (exit 1, no-project)", cliNp.code === 1 && /no-project/.test(cliNp.text), short(cliNp.text, 200));
			const back = await api("PATCH", `/api/acp/agents/${REV}`, { projectId: PA });
			check("S8 @rev back in project A", back.status === 200 && back.body?.projectId === PA);
		}

		if (on("S9")) {
			console.log("── S9 the assignee never approves");
			const a = await mkTask({ parentId: G.id, title: "S9 con reviewer", assignee: DEV, reviewer: REV });
			const self = await stBy(DEV, `task done ${a.id}`);
			check("S9 the assignee's `st task done` ⇒ exit 1, 403 self-approval", self.code === 1 && /self-approval/.test(self.text), short(self.text, 200));
			check("S9 …still not done", (await taskOf(a.id)).status !== "done");
			const byRev = await patch(a.id, { version: (await taskOf(a.id)).version, status: "done" }, tok[REV]);
			check("S9 the reviewer approves ⇒ 200, done by @rev", byRev.status === 200 && byRev.body?.status === "done" && byRev.body?.doneBy === REV, `${byRev.status} ${byRev.body?.doneBy ?? J(byRev.body)}`);
			const ev = (await show(a.id)).body?.events?.filter((e) => e.kind === "approved") ?? [];
			check("S9 …recorded as approved by @rev", ev.length === 1 && ev[0].actor === REV, short(ev));

			const b = await mkTask({ parentId: G.id, title: "S9 la persona", assignee: DEV });
			const byOwner = await patch(b.id, { version: b.version, status: "done" });
			check("S9 the person approves ⇒ 200, done by owner", byOwner.status === 200 && byOwner.body?.doneBy === "owner", `${byOwner.status} ${byOwner.body?.doneBy}`);

			const c = await mkTask({ parentId: G.id, title: "S9 ex responsable", assignee: REV });
			const re = await patch(c.id, { version: c.version, assignee: DEV, reviewer: REV }, tok[ARQ]);
			check("S9 the coordinator reassigns @rev's task to @dev, @rev reviews", re.status === 200 && re.body?.assignee === DEV && re.body?.reviewer === REV, `${re.status}`);
			const exA = await patch(c.id, { version: re.body.version, status: "done" }, tok[REV]);
			check("S9 an ex-assignee (now reviewer) cannot approve ⇒ 403 self-approval", exA.status === 403 && exA.body?.error === "self-approval", `${exA.status} ${J(exA.body)}`);
			const coord = await patch(c.id, { version: re.body.version, status: "done" }, tok[ARQ]);
			check("S9 the coordinator (never its assignee) approves ⇒ 200", coord.status === 200 && coord.body?.doneBy === ARQ, `${coord.status} ${coord.body?.doneBy ?? J(coord.body)}`);

			// The goal itself: @rev was its assignee, now @dev is; neither coordinates it.
			let gv = (await taskOf(G.id)).version;
			for (const who of [REV, DEV]) gv = (await patch(G.id, { version: gv, assignee: who })).body.version;
			const sa = await tok[REV]("POST", `/tasks/${G.id}/scope-approved`, { version: gv });
			const sd = await tok[DEV]("POST", `/tasks/${G.id}/scope-approved`, { version: gv });
			check(
				"S9 scope-approved: the goal's ex-assignee and its assignee ⇒ 403 not-coordinator",
				sa.status === 403 && sa.body?.error === "not-coordinator" && sd.status === 403 && sd.body?.error === "not-coordinator",
				`${sa.status} ${sa.body?.error} / ${sd.status} ${sd.body?.error}`,
			);
			const gdone = await patch(G.id, { version: gv, status: "done" }, tok[REV]);
			check("S9 …nor `done` on the goal by its ex-assignee (403)", gdone.status === 403, `${gdone.status} ${gdone.body?.error}`);
			ctx.s9 = [a.id, b.id, c.id];
		}

		if (on("S10")) {
			console.log("── S10 interruption");
			const g = await mkTask({ projectId: PA, title: "Objetivo S10", coordinator: ARQ, budgetLimit: 1000 });
			const c = await mkTask({ parentId: g.id, title: "S10 interrumpida", assignee: DEV });
			const sib = await mkTask({ parentId: g.id, title: "S10 hermana", assignee: REV });
			let v = c.version;
			for (const l of [{ kind: "pr", ref: "10" }, { kind: "external", ref: "espera S10" }, { kind: "dep", ref: String(sib.id) }]) v = (await link(c.id, { version: v, ...l })).body.version;
			v = (await patch(c.id, { version: v, status: "doing" })).body.version;
			const snap = async () => {
				const s = (await show(g.id)).body;
				const t = (await show(c.id)).body.task;
				return J({ status: t.status, version: t.version, links: t.links.map((l) => [l.kind, l.ref]), children: s.children.map((x) => [x.id, x.version, x.status]) });
			};
			const before = await snap();
			const m = await send(DEV, "esperá 60", { task: c.id, projectId: PA });
			msgIds.add(m.id);
			check("S10 a message of the task to @dev (task_id set)", m.task_id === c.id, `#${m.id} task ${m.task_id}`);
			check("S10 …its turn started", !!(await waitTurnStarted(DEV, m.id, 60_000)));
			const k = await execOut(sids[DEV], "pkill -KILL -f '^node --no-warnings /opt/st-acp/st/runner.mjs$'; echo killed");
			check("S10 @dev's slot-1 runner killed", k.out.includes("killed"), short(k.out));
			const u = await waitMsg(m.id, ["uncertain", "failed", "done"], 180_000);
			check("S10 the interrupted message is uncertain", u?.state === "uncertain", `${u?.state} ${short(u?.note)}`);
			const rep = await waitFor(async () => (await msgsOf(DEV)).find((x) => x.recovery_of === m.id && x.state === "done"), 120_000);
			if (rep) msgIds.add(rep.id);
			check("S10 …the read-only report ran, in the same task", !!rep && rep.task_id === c.id, rep && `#${rep.id} task ${rep.task_id}`);
			await sleep(4_000);
			const again = await get(m.id);
			check("S10 …and the message was not run again", again.state === "uncertain" && again.attempts === 1, `${again.state}/${again.attempts}`);
			const after = await snap();
			check("S10 the task's status, version, links and the goal's children are unchanged", after === before, after === before ? short(after, 200) : `${before} → ${after}`);
			const t = (await show(c.id)).body.task;
			check("S10 derived state: uncertain for that message", t.activity?.some((a) => a.kind === "uncertain" && a.messageId === m.id && a.agent === DEV), short(t.activity));
			const cli = await stBy(ARQ, `task show ${c.id}`);
			check("S10 …`st task show` says «interrumpido sin revisar»", cli.text.includes(`interrumpido sin revisar: @${DEV} (#${m.id})`), short(cli.text, 240));
			const rv = await api("POST", `/api/acp/messages/${m.id}/review`);
			const t2 = (await show(c.id)).body.task;
			check("S10 reviewed ⇒ derived uncertain gone, status/version still the same", rv.status === 200 && !t2.activity?.some((a) => a.kind === "uncertain") && t2.version === t.version && t2.status === t.status, `${rv.status} ${short(t2.activity)}`);
			ctx.s10 = [g.id, c.id, sib.id];
		}

		if (on("S11")) {
			console.log("── S11 task budget");
			const g = await mkTask({ projectId: PA, title: "Objetivo S11", coordinator: ARQ, budgetLimit: 10_000 });
			const c = await mkTask({ parentId: g.id, title: "S11 bucle", assignee: ARQ });
			const limit = c.taskBudget?.limit ?? (await taskOf(c.id)).taskBudget.limit;
			console.log(`   task cap (ACP_TASK_BUDGET) = ${limit}`);
			const settled = async (used) => {
				const s = (await show(c.id)).body;
				const busy = s.task.activity?.some((a) => a.kind === "running" || a.kind === "queued");
				return s.task.taskBudget.used === used && !busy ? s : null;
			};
			const exhausted = (s) => s.events.filter((e) => e.kind === "budget-exhausted");
			const loop = await send(ARQ, `rondas ${limit + 3}: consultá a @${DEV}: una ronda en la tarea`, { task: c.id, projectId: PA });
			msgIds.add(loop.id);
			const cut = await waitFor(async () => {
				const s = await settled(limit);
				return s && exhausted(s).length ? s : null;
			}, CFG.ROUND_MS * (limit + 3));
			check(
				`S11 a loop of ${limit + 3} rounds in a task is cut at its cap (${limit}) by task-budget`,
				!!cut && cut.task.taskBudget.exhausted && exhausted(cut).length === 1 && exhausted(cut)[0].data?.budget === "task" && exhausted(cut)[0].data?.limit === limit,
				cut ? short({ taskBudget: cut.task.taskBudget, events: exhausted(cut).map((e) => e.data) }) : "not settled",
			);
			check("S11 …the goal was not what cut it", !!cut && !(await taskOf(g.id)).budget.exhausted);
			const told = await waitFor(async () => (await msgsOf(ARQ)).find((m) => m.to_id === ARQ && m.task_id === c.id && /task-budget/.test(m.result_text ?? "")));
			check("S11 …@arq was told by st why nothing was sent (task-budget)", !!told, told && short(told.result_text));
			const byAgent = await tok[ARQ]("POST", `/tasks/${c.id}/budget`, { add: 5 });
			check("S11 an agent cannot raise a budget ⇒ 403", byAgent.status === 403, `${byAgent.status} ${J(byAgent.body)}`);
			const raise = await api("POST", `/api/acp/tasks/${c.id}/budget`, { add: 1 });
			check("S11 the person raises the task's cap by 1", raise.status === 200 && raise.body?.taskBudget?.limit === limit + 1 && !raise.body.taskBudget.exhausted, short(raise.body?.taskBudget));
			const ev = (await show(c.id)).body.events.filter((e) => e.kind === "budget");
			check("S11 …recorded (budget event, requestsLimit [null, limit+1])", ev.length === 1 && ev[0].actor === "owner" && ev[0].data?.requestsLimit?.[1] === limit + 1, short(ev));
			// The next request (to @rev, whose answer does not continue @arq's rounds) passes.
			const next = await waitMsg((await send(ARQ, `consultá a @${REV}: después de ampliar`, { task: c.id, projectId: PA })).id);
			const req = await waitFor(async () => (await msgsOf(REV)).find((m) => m.from_id === ARQ && m.task_id === c.id && m.body === "después de ampliar"));
			check("S11 …the next request passes, in the task", next.state === "done" && !!req, req && `#${req.id}`);
			const used1 = await waitFor(() => settled(limit + 1), 90_000);
			check("S11 …and spends it (used = limit + 1)", !!used1, used1 && short(used1.task.taskBudget));
			for (const n of [1, 2]) await waitMsg((await send(ARQ, `consultá a @${REV}: otra ${n}`, { task: c.id, projectId: PA })).id);
			await waitIdle([ARQ, DEV, REV]);
			const fin = (await show(c.id)).body;
			const ex = exhausted(fin).map((e) => e.data?.limit);
			check(
				"S11 two more refusals at the new cap record ONE more event: one per limit",
				J(ex) === J([limit, limit + 1]) && fin.task.taskBudget.used === limit + 1,
				`budget-exhausted limits ${J(ex)}, used ${fin.task.taskBudget.used}/${fin.task.taskBudget.limit}`,
			);
			for (const m of await msgsOf(ARQ)) if (m.task_id === c.id) msgIds.add(m.id);
			ctx.s11 = [g.id, c.id];
		}
	}

	// ── S13 (+ S17): the board at ~50 and ~500 tasks ──
	if (on("S13") || on("S17")) {
		console.log("── S13 board load (and S17 the request INSERT)");
		const seed = async (pid, n) => {
			const doneN = Math.round(n * 0.4);
			const ids = [];
			let next = 0;
			const worker = async () => {
				for (;;) {
					const i = next++;
					if (i >= n) return;
					const t = await mkTask({ projectId: pid, title: `carga ${i}` });
					if (i < doneN) await patch(t.id, { version: t.version, status: "done" });
					// Same link shape in both projects: the board reads the same statements.
					if (i % 10 === 5) await link(t.id, { version: (await taskOf(t.id)).version, kind: "pr", ref: String(i) });
					ids.push(t.id);
				}
			};
			await Promise.all(Array.from({ length: CFG.SEED_CONCURRENCY }, worker));
			const s = await api("GET", `/api/acp/tasks/summary?project=${pid}`);
			return { ids, open: s.body?.open, done: doneN };
		};
		const board = async (pid) => (await api("GET", `/api/acp/tasks?projectId=${pid}`)).body;
		// S17: one agent request in a task, end to end (the person → @arq, its `st send` → @rev, reply).
		let s17Task = null;
		const s17 = async (label) => {
			if (!on("S17") || !NEEDS_AGENTS) return null;
			if (!s17Task) {
				const g = await mkTask({ projectId: PA, title: "Objetivo S17", coordinator: ARQ, budgetLimit: 10_000 });
				s17Task = await mkTask({ parentId: g.id, title: "S17 contador", assignee: ARQ });
				await api("POST", `/api/acp/tasks/${s17Task.id}/budget`, { add: 100 });
				ctx.s17 = [g.id, s17Task.id];
			}
			await waitIdle([ARQ, DEV, REV]);
			const m = await measure(async () => {
				const before = (await taskOf(s17Task.id)).taskBudget.used;
				const msg = await send(ARQ, `consultá a @${REV}: S17 ${label}`, { task: s17Task.id, projectId: PA });
				msgIds.add(msg.id);
				await waitFor(async () => {
					const t = await taskOf(s17Task.id);
					return t.taskBudget.used === before + 1 && !t.activity.some((a) => a.kind === "running" || a.kind === "queued");
				}, 90_000);
				await waitIdle([ARQ, DEV, REV]);
				return (await taskOf(s17Task.id)).taskBudget.used - before;
			}, 1);
			// Every key of that INSERT (the person's send and the agent's request run the same text).
			const keys = m.top.filter((s) => s.statement.startsWith("INSERT OR IGNORE INTO agent_messages"));
			const ins = keys.length ? { statement: keys[0].statement, rows: keys.reduce((n, s) => n + s.rows, 0), queries: keys.reduce((n, s) => n + s.queries, 0) } : null;
			// Only a key already in the top before the round has an exact delta (see delta()).
			if (ins && !keys.every((s) => s.wasInTop)) return { ...m, ins: null };
			return { ...m, ins };
		};

		const small = await seed(PB, CFG.SEED_SMALL);
		check(`S13 seeded ${CFG.SEED_SMALL} tasks in project B by the API`, small.ids.length === CFG.SEED_SMALL, `open ${small.open}, done ${small.done}`);
		const b50 = await measure(() => board(PB));
		const r17a = await s17("50");
		const PC = await newProject(`Tareas C ${PREFIX}`);
		const big = await seed(PC, CFG.SEED_BIG);
		check(`S13 seeded ${CFG.SEED_BIG} tasks in project C by the API`, big.ids.length === CFG.SEED_BIG, `open ${big.open}, done ${big.done}`);
		const b500 = await measure(() => board(PC));
		const r17b = await s17("500");

		const n50 = b50.result.open.length + b50.result.done.length;
		const n500 = b500.result.open.length + b500.result.done.length;
		check(`S13 ${CFG.SEED_SMALL} tasks: the whole board in one page`, n50 === CFG.SEED_SMALL && !b50.result.nextOpen && !b50.result.nextDone, `${b50.result.open.length} open + ${b50.result.done.length} done`);
		check(
			`S13 ${CFG.SEED_BIG} tasks: one page ≤ 200 (150 open + 50 done), cursors for the rest`,
			b500.result.open.length === Math.min(150, big.open) && b500.result.done.length === Math.min(50, big.done) && n500 <= 200 && (big.open <= 150 || !!b500.result.nextOpen),
			`${b500.result.open.length} open + ${b500.result.done.length} done, nextOpen ${b500.result.nextOpen}, nextDone ${b500.result.nextDone}`,
		);
		const taskTop = (m) => m.top.filter((s) => TASK_SQL.test(s.statement)).map((s) => `${s.queries}q/${s.rows}r ${s.statement.slice(0, 60)}`);
		console.log(`   board ${CFG.SEED_SMALL}: ${b50.calls} statements, ${b50.rows} rows; board ${CFG.SEED_BIG}: ${b500.calls} statements, ${b500.rows} rows`);
		if (rowsMode) {
			for (const [n, b, ret] of [[CFG.SEED_SMALL, b50, n50], [CFG.SEED_BIG, b500, n500]]) {
				const cap = CFG.ROWS_PER_TASK * ret + CFG.ROWS_SLACK;
				check(`S13 board with ${n} tasks: rows read ≤ ${CFG.ROWS_PER_TASK} × ${ret} + ${CFG.ROWS_SLACK} = ${cap}`, b.rows <= cap, `${b.rows} rows in ${b.calls} statements; top: ${taskTop(b).join(" | ") || "—"}`);
			}
		}
		check(
			"S13 statements per board load do not grow with the tasks (50 vs 500)",
			b50.calls === b500.calls,
			`${b50.calls} vs ${b500.calls}`,
		);
		if (on("S17") && NEEDS_AGENTS) {
			check("S17 one request in the task spent the task's budget, both times", r17a?.result === 1 && r17b?.result === 1, `${r17a?.result} ${r17b?.result}`);
			if (!rowsMode) skip("S17 rows of the request INSERT, 50 vs 500 tasks", "shim reports no rows_read; the trigger's plan is pinned locally (acp.sqlite.test.ts)");
			else if (r17a?.ins && r17b?.ins)
				check(
					"S17 rows read by the request INSERT (with trg_task_request_counted) do not grow from 50 to 500 tasks",
					r17b.ins.rows / r17b.ins.queries <= r17a.ins.rows / r17a.ins.queries + CFG.S17_SLACK,
					`${short(r17a.ins.statement, 60)}: ${r17a.ins.rows}r/${r17a.ins.queries}q → ${r17b.ins.rows}r/${r17b.ins.queries}q`,
				);
			else
				// The round's total includes the waiting polls (a variable number): it proves nothing.
				skip(
					"S17 rows read by the request INSERT, 50 vs 500 tasks",
					`the INSERT is not among the statements admin stats lists (?top=200; a backend without it lists 10) before and after both rounds; round totals ${r17a?.rows} → ${r17b?.rows} rows, ${r17a?.calls} → ${r17b?.calls} statements, polling included`,
				);
		}
		ctx.PB = PB;
		ctx.PC = PC;
	}

	// ── S15 backup (lab A) → restore (lab B) ──
	if (on("S15")) {
		console.log("── S15 backup → restore");
		if (NEEDS_AGENTS) await waitIdle([ARQ, DEV, REV]);
		// A goal with every kind of link (work: a real work of @dev's) and its history.
		const g = await mkTask({ projectId: PA, title: "Objetivo S15", ...(NEEDS_AGENTS ? { coordinator: ARQ } : {}), budgetLimit: 77 });
		const c1 = await mkTask({ parentId: g.id, title: "S15 hija 1", ...(NEEDS_AGENTS ? { assignee: DEV, reviewer: REV } : {}), priority: "high" });
		const c2 = await mkTask({ parentId: g.id, title: "S15 hija 2", ...(NEEDS_AGENTS ? { assignee: REV } : {}) });
		let v = c1.version;
		for (const l of [{ kind: "dep", ref: String(c2.id) }, { kind: "pr", ref: "https://example.invalid/pr/15" }, { kind: "external", ref: "S15 espera" }]) v = (await link(c1.id, { version: v, ...l })).body.version;
		if (NEEDS_AGENTS) {
			await api("PATCH", `/api/acp/agents/${DEV}`, { maxConcurrency: 2 });
			const repo = await execOut(
				sids[DEV],
				"cd /home/developer/workspace && (git rev-parse -q --verify HEAD >/dev/null 2>&1 || (git init -q -b main && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init)) && rm -rf /tmp/s15-remote.git && git init -q --bare -b main /tmp/s15-remote.git && (git remote remove origin 2>/dev/null; git remote add origin /tmp/s15-remote.git) && git push -q origin main && git remote set-head origin main && echo ok",
			);
			const wid = `${PREFIX}-s15`;
			const w = await api("POST", "/api/acp/works", { agent: DEV, id: wid });
			const wl = await link(c1.id, { version: v, kind: "work", ref: wid });
			check("S15 a work of @dev linked to the task", repo.out.endsWith("ok") && w.status === 201 && wl.status === 200, `${short(repo.out, 60)} ${w.status} ${wl.status}`);
			v = wl.body?.version ?? v;
			await api("POST", `/api/acp/works/${wid}/close`);
			await api("PATCH", `/api/acp/agents/${DEV}`, { maxConcurrency: 1 });
			const sm = await send(DEV, `consultá a @${REV}: S15 en la hija`, { task: c1.id, projectId: PA });
			msgIds.add(sm.id);
			await waitFor(async () => (await taskOf(c1.id)).taskBudget.used === 1, 90_000);
			await waitIdle([ARQ, DEV, REV]);
			for (const n of [ARQ, DEV, REV]) for (const m of await msgsOf(n)) if (m.task_id !== null) msgIds.add(m.id);
		}
		v = (await patch(c1.id, { version: v, status: "doing" })).body?.version ?? v;
		await patch(c2.id, { version: c2.version, status: "done" });
		await api("POST", `/api/acp/tasks/${g.id}/budget`, { add: 3 });
		ctx.s15 = [g.id, c1.id, c2.id];

		// Everything of project A (all the sections' tasks), as lab A answers it.
		const ids = async (call, pid) => {
			const b = (await call("GET", `/api/acp/tasks?projectId=${pid}`)).body;
			return [...(b?.open ?? []), ...(b?.done ?? [])].map((t) => t.id).sort((x, y) => x - y);
		};
		const KEEP = ["id", "projectId", "parentId", "title", "description", "assignee", "reviewer", "coordinator", "priority", "status", "blockedReason", "version", "originKey", "originMessageId", "conversationId", "requestsUsed", "createdBy", "updatedBy", "createdAt", "updatedAt", "doneAt", "doneBy", "links", "taskBudget", "budget"];
		const pick = (t) => Object.fromEntries(KEEP.map((k) => [k, t?.[k]]));
		const snapshot = async (call, pid) => {
			const out = {};
			for (const id of await ids(call, pid)) {
				const s = (await call("GET", `/api/acp/tasks/${id}`)).body;
				out[id] = { task: pick(s.task), children: s.children.map((c) => [c.id, c.version]), events: s.events };
			}
			const msgs = {};
			for (const id of [...msgIds].sort((x, y) => x - y)) {
				const m = (await call("GET", `/api/acp/messages/${id}`)).body;
				msgs[id] = m && { task_id: m.task_id, kind: m.kind, from: m.from_id, to: m.to_id, reply_to: m.reply_to, root_id: m.root_id, state: m.state };
			}
			return { tasks: out, msgs };
		};
		const before = await snapshot(api, PA);
		const nT = Object.keys(before.tasks).length;
		const nE = Object.values(before.tasks).reduce((n, t) => n + t.events.length, 0);
		const nL = Object.values(before.tasks).reduce((n, t) => n + t.task.links.length, 0);
		const kinds = new Set(Object.values(before.tasks).flatMap((t) => t.task.links.map((l) => l.kind)));
		const withTask = Object.values(before.msgs).filter((m) => m?.task_id != null).length;
		console.log(`   lab A, project A: ${nT} tasks, ${nL} links (${[...kinds].join(",")}), ${nE} events, ${withTask} messages with task_id`);

		const sh = (cmd) => {
			try {
				return { code: 0, out: execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: "/bin/bash" }) };
			} catch (e) {
				return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
			}
		};
		const fill = (t, vars) => t.replace(/\{(\w+)\}/g, (_, k) => vars[k]);
		const rootA = env.BACKUP_CMD ? "" : sh(`docker exec ${A_C} printenv WORKSPACE_ROOT`).out.trim();
		const rootB = env.RESTORE_CMD ? "" : sh(`docker exec ${B_C} printenv WORKSPACE_ROOT`).out.trim();
		const name = `s15-${PREFIX}-${Date.now()}`;
		const vars = { dir: `${rootA}/.backups/${name}`, dirB: `${rootB}/.backups/${name}`, name };
		const T = {
			backup: env.BACKUP_CMD ?? `docker exec -w /app ${A_C} npm run -s backup -- {dir}`,
			copy: env.COPY_CMD ?? `docker exec ${B_C} mkdir -p ${rootB}/.backups && docker cp ${A_C}:{dir} - | docker cp - ${B_C}:${rootB}/.backups/`,
			restore: env.RESTORE_CMD ?? `docker exec -w /app ${B_C} npm run -s restore -- {dirB}`,
			restart: env.RESTART_B_CMD ?? `docker restart ${B_C}`,
			stop: env.STOP_B_CMD ?? `docker stop ${B_C}`,
		};
		const bk = sh(fill(T.backup, vars));
		check("S15 backup in lab A", bk.code === 0, short(bk.code === 0 ? bk.out.split("\n").filter((l) => /task|manifest/i.test(l)).join(" | ") : bk.out.trim().split("\n").slice(-3).join(" | "), 300));
		const cp = sh(fill(T.copy, vars));
		check("S15 backup copied to lab B", cp.code === 0, short(cp.out) || "ok");
		const rs = sh(fill(T.restore, vars));
		check("S15 restore into an empty lab B", rs.code === 0, short(rs.code === 0 ? rs.out.split("\n").filter((l) => /task/i.test(l)).join(" | ") : rs.out.trim().split("\n").slice(-3).join(" | "), 300));
		const again = sh(fill(T.restore, vars));
		check("S15 a second restore without --force is refused (target not empty)", again.code !== 0 && /not empty|--force/.test(again.out), short(again.out.split("\n").find((l) => /not empty|--force/.test(l)) ?? again.out, 200));
		sh(fill(T.restart, vars));
		// Login only: registering here would make an empty lab B non-empty (and a failed
		// restore would then be indistinguishable from the refusal checked above).
		const B = client(LAB_B_ST, "labowner", undefined, false);
		const up = await waitFor(async () => (await fetch(`${LAB_B_ST}/api/auth/status`).catch(() => null))?.ok, 120_000);
		check("S15 lab B up after the restore", !!up);
		const after = await snapshot(B.api, PA);
		// Lab B holds the same session ids as A on the same Docker daemon: its watchdog acts on
		// containers by name, so it must not stay up while A runs (S14). Its data dirs stay.
		const stopB = sh(fill(T.stop, vars));
		check("S15 lab B stopped after the comparison", stopB.code === 0, short(stopB.out) || "ok");
		const diffs = [];
		for (const id of new Set([...Object.keys(before.tasks), ...Object.keys(after.tasks)])) {
			for (const part of ["task", "children", "events"])
				if (J(before.tasks[id]?.[part]) !== J(after.tasks[id]?.[part])) diffs.push(`task #${id} ${part}: ${short(before.tasks[id]?.[part], 120)} ≠ ${short(after.tasks[id]?.[part], 120)}`);
		}
		check(
			"S15 tasks, children, links (dep/pr/work/external), events, budget_used, requests_used and version 1:1",
			nT > 0 && diffs.length === 0,
			diffs.length ? diffs.slice(0, 3).join(" ‖ ") : `${nT} tasks, ${nL} links, ${nE} events identical`,
		);
		const mdiff = Object.keys(before.msgs).filter((id) => J(before.msgs[id]) !== J(after.msgs[id]));
		check(
			"S15 agent_messages.task_id (and reply/root/state) 1:1",
			mdiff.length === 0,
			mdiff.length ? mdiff.slice(0, 3).map((id) => `#${id}: ${J(before.msgs[id])} ≠ ${J(after.msgs[id])}`).join(" ‖ ") : `${Object.keys(before.msgs).length} messages, ${withTask} with task_id`,
		);
		if (NEEDS_AGENTS) check("S15 the restored set has every link kind", ["dep", "pr", "work", "external"].every((k) => kinds.has(k)), [...kinds].join(","));
	}

	// ── S14 at rest ──
	if (on("S14")) {
		console.log(`── S14 at rest for ${CFG.IDLE_MS / 1000} s`);
		if (NEEDS_AGENTS) await waitIdle([ARQ, DEV, REV]);
		const frames0 = frames.a.length;
		const a = await d1();
		await sleep(CFG.IDLE_MS);
		const b = await d1();
		const d = delta(a, b);
		const min = CFG.IDLE_MS / 60_000;
		const taskStmts = d.top.filter((s) => TASK_SQL.test(s.statement));
		console.log(`   at rest: ${d.calls} D1 statements, ${d.rows} rows in ${min} min; top: ${d.top.map((s) => `${s.queries}q/${s.rows}r ${s.statement.slice(0, 50)}`).join(" | ") || "—"}`);
		check(`S14 D1 statements at rest ≤ ${CFG.IDLE_MAX_CALLS_PER_MIN}/min (${Math.round(CFG.IDLE_MAX_CALLS_PER_MIN * min)})`, d.calls <= CFG.IDLE_MAX_CALLS_PER_MIN * min, `${d.calls} (${(d.calls / min).toFixed(1)}/min)`);
		if (rowsMode) {
			check(`S14 rows read at rest ≤ ${CFG.IDLE_MAX_ROWS_PER_MIN}/min (${Math.round(CFG.IDLE_MAX_ROWS_PER_MIN * min)})`, d.rows <= CFG.IDLE_MAX_ROWS_PER_MIN * min, `${d.rows} (${(d.rows / min).toFixed(1)}/min)`);
			check("S14 no statement on tasks/task_links/task_events among the statements that ran (the statements admin stats lists: ?top=200, 10 on a backend without it)", taskStmts.length === 0, taskStmts.map((s) => s.statement).join(" | ") || "none");
		} else skip("S14 no statement on tasks at rest, per statement", "shim reports no rows_read, so admin stats has no per-statement view; totals above");
		const liveTask = frames.a.slice(frames0).filter((f) => f.type === "task");
		check("S14 …and no task event on the open /ws/acp meanwhile", liveTask.length === 0, `${frames.a.length - frames0} frames, ${liveTask.length} task`);
	}
	wsA?.close();

	if (env.KEEP !== "1") {
		for (const s of created.sessions) {
			const d = await api("DELETE", `/api/sessions/${s}?hard=true`);
			check(`test session ${s.slice(0, 8)} removed`, d.status < 300, String(d.status));
		}
		for (const p of created.projects) await api("DELETE", `/api/projects/${p}`);
		console.log(`archived ${created.projects.length} test projects (their tasks stay, like any archived project's)`);
	} else console.log(`kept: projects ${created.projects.join(" ")}, sessions ${created.sessions.join(" ")}`);
}

// The verdict is the last line, ALL PASS or N FAILED. Should the process end
// without reaching it (the event loop drained with main() still pending),
// that is a failure, never exit 0.
let verdict = false;
process.on("exit", (code) => {
	if (verdict || code !== 0) return;
	console.log(`FAIL [${at()}] ended without a verdict`);
	console.log("1 FAILED");
	process.exitCode = 1;
});

main()
	.catch((err) => {
		failures++;
		console.log(`FAIL [${at()}] aborted: ${err.stack ?? err.message}`);
	})
	.finally(() => {
		verdict = true;
		console.log(failures ? `${failures} FAILED` : "ALL PASS");
		process.exit(failures ? 1 : 0);
	});
