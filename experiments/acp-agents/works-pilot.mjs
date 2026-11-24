#!/usr/bin/env node
// Pilot of parallel works (Entrega 2, #750) against the LAB (experiments/acp-agents/lab-st.sh, ACP_TEST_RUNTIME=1).
// ONE scenario, in order, with the owner's 13 points (#924) plus resources:
//   W1  @arq creates two works for @dev with `st work new` (st-a, st-b);
//   W2  @arq delegates them to @dev with `st send --work`;
//   W3  each worktree exists (row + `git worktree list`) before the work's first ACP message is claimed;
//   W4  both works run in parallel (overlap from the backend's own started_at/finished_at);
//   W5  meanwhile slot 1 answers a consult in the default context;
//   W6  each work has its own branch (work/<id>), directory (.st/ctx/<id>) and ACP session;
//   W7  independent results: one commit per branch, pushed to the lab's bare remote ("PR"), one file each;
//   W8  @rev (the lab's qa) asks @dev for a correction on st-a with `st send --work`;
//   W9  it lands in st-a's context and ACP session; the reply comes back to @rev's context;
//   W10 a controlled interruption (kill of the slot's runner) leaves st-b's message uncertain, not re-run, and
//       st-a's concurrent message done;
//   W11 one server per work in its own range (ST_PORT_BASE); `st port check` tells mine from the other's;
//       a bind on a taken port is detected;
//   W12 a useful ignored file (.env) or a live process keep `st work clean` from removing (cleanup-pending + reason);
//       an agent outside the project is refused;
//   W13 a disposable work (st-c) is closed and cleaned: worktree gone, branch and ACP session kept, main checkout
//       untouched;
//   P6  memory.peak / oom / oom_kill of @dev's container, and disk before/after.
// Run the lab with MAX_RUNNING >= 4:
//   SRC=<checkout> MAX_RUNNING=4 ./experiments/acp-agents/lab-st.sh up
//   ST=http://127.0.0.1:3101 node experiments/acp-agents/works-pilot.mjs
// Removes the sessions and the project it created (KEEP=1 keeps them). One PASS/FAIL line per check; exit 1 on
// any failure.
//
// Written for #751 + #752: the agents act through the test agent's `st: <args>`, `servidor`, `commit` and `ocupá`.
import { randomBytes, randomUUID } from "node:crypto";

const ST = process.env.ST ?? "http://127.0.0.1:3101";
const PREFIX = process.env.PREFIX ?? `w${randomBytes(2).toString("hex")}`;
const ARQ = `${PREFIX}-arq`;
const DEV = `${PREFIX}-dev`;
const REV = `${PREFIX}-rev`;
// An agent of no project: close/clean of another project's work must be refused (D7: any agent of the SAME project).
const OUT = `${PREFIX}-out`;
const [WA, WB, WC] = [`${PREFIX}-st-a`, `${PREFIX}-st-b`, `${PREFIX}-st-c`];
const WS = "/home/developer/workspace";
// The lab's "remote": a bare repo inside @dev's container, outside the workspace (a push there is the "PR").
const REMOTE = "/home/developer/works-remote.git";
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
const projectRows = async (pid) => (await api("GET", `/api/acp/projects/${pid}/feed`)).body?.messages ?? [];
// The person's view of the works (#751: GET /api/acp/works, workView fields: id, agent, state, branch, dir,
// portBase, note — the cleanup-pending reasons —, createdAt…), filtered to one agent.
const works = async (agent) => {
	const r = await api("GET", "/api/acp/works");
	return (Array.isArray(r.body) ? r.body : []).filter((w) => w.agent === agent);
};
const work = async (agent, id) => (await works(agent)).find((w) => w.id === id) ?? null;
// The work a message row runs in (#751: the row keeps `context` = the work's id; the person POSTs `work`).
const workOf = (m) => m?.context ?? null;
const short = (s, n = 110) => (s ?? "").replace(/\s+/g, " ").slice(0, n);
// The LAST occurrence is the answering agent's own context line: an answer to a reply first quotes the other
// agent's text, which carries that agent's context line (lab #750 OPS-RESULT 2, W9).
const last = (re, text) => [...(text ?? "").matchAll(re)].at(-1)?.[1] ?? null;
const sessionCount = (text) => Number(last(/sesión ACP: (\d+) mensajes/g, text) ?? Number.NaN);
// The test agent's context line: «… · cwd <dir> · trabajo <ST_WORK|->[ · desde el trabajo <id>])» (#752).
const cwdOf = (text) => last(/cwd (\S+) · trabajo /g, text);
const ms = (iso) => Date.parse(iso);

// stdout + exit code of a command in a session container (exec API, NDJSON events).
async function exec(sid, cmd) {
	await auth();
	const r = await fetch(`${ST}/api/sessions/${sid}/exec`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie },
		body: JSON.stringify({ cmd }),
	});
	let out = "";
	let code = null;
	for (const line of (await r.text()).split("\n")) {
		try {
			const e = JSON.parse(line);
			if (e.type === "output" && e.stream === "stdout") out += e.data;
			if (e.type === "exit") code = e.exitCode ?? e.code ?? null;
		} catch {}
	}
	return { out, code };
}
const sh = async (sid, script) => (await exec(sid, ["sh", "-c", script])).out;
const cgroup = async (sid) => {
	const out = await sh(sid, "cat /sys/fs/cgroup/memory.peak; cat /sys/fs/cgroup/memory.events");
	const kv = Object.fromEntries(out.split("\n").filter((l) => l.includes(" ")).map((l) => l.trim().split(/\s+/)));
	return { peakMiB: Math.round(Number(out.split("\n")[0]) / 1048576), oom: Number(kv.oom ?? Number.NaN), oomKill: Number(kv.oom_kill ?? Number.NaN) };
};
const diskFreeMiB = async (sid) => Number((await sh(sid, `df -Pm ${WS} | awk 'NR==2{print $4}'`)).trim());
// A request an agent sent to @dev on a work, after message `afterId`, whose body contains `text`; waited to its end.
async function requestTo(pid, from, w, text, afterId, wait = true) {
	const row = await waitFor(
		async () => (await projectRows(pid)).find((m) => m.kind === "request" && m.id > afterId && m.from_id === from && m.to_id === DEV && workOf(m) === w && (m.body ?? "").includes(text)) ?? null,
		30_000,
	);
	return row && wait ? await waitMsg(row.id, 180_000) : row;
}
const overlapMs = (a, b) => Math.min(ms(a.finished_at), ms(b.finished_at)) - Math.max(ms(a.started_at), ms(b.started_at));

// ── Scenario ──────────────────────────────────────────────────────────────────

async function main() {
	console.log(`works pilot against ${ST} — agents @${ARQ}, @${DEV}, @${REV}; works ${WA}, ${WB}, ${WC}`);
	const p = await api("POST", "/api/projects", { name: `Piloto trabajos ${PREFIX}`, clientRequestId: randomUUID() });
	if (!check("project created", p.status === 201, String(p.status))) return;
	const pid = p.body.projectId;
	created.project = pid;
	const sids = {};
	for (const name of [ARQ, DEV, REV]) {
		const r = await api("POST", "/api/sessions", { name: `works ${name}`, acpAgent: { name, runtime: "st-test-agent", projectId: pid } });
		check(`session with @${name}`, r.status === 201, `${r.status}`);
		sids[name] = r.body.sessionId;
		created.sessions.push(r.body.sessionId);
	}
	const ro = await api("POST", "/api/sessions", { name: `works ${OUT}`, acpAgent: { name: OUT, runtime: "st-test-agent" } });
	check(`session with @${OUT} (no project)`, ro.status === 201, `${ro.status}`);
	sids[OUT] = ro.body.sessionId;
	created.sessions.push(ro.body.sessionId);
	for (const name of [ARQ, DEV, REV, OUT])
		check(`runner of @${name} online`, !!(await waitFor(async () => (await agents()).find((a) => a.name === name && a.runnerSeenAt))));
	const dev = sids[DEV];
	const mc = await api("PATCH", `/api/acp/agents/${DEV}`, { maxConcurrency: 3 });
	check(`@${DEV} max_concurrency 3`, mc.status === 200 && mc.body?.maxConcurrency === 3, String(mc.status));

	// @dev's workspace becomes a repo with one commit and a bare "origin"; the main checkout's state is recorded
	// to compare at the end (W13).
	await sh(
		dev,
		`set -e; git init -q --bare ${REMOTE}; cd ${WS}; git init -q -b main; git config user.name lab; git config user.email lab@lab.invalid; ` +
			`printf '.st/\\nnode_modules/\\ndist/\\n.env\\n' > .gitignore; echo base > README.md; git add -A; git commit -qm base; ` +
			`git remote add origin ${REMOTE}; git push -q origin main`,
	);
	const mainBefore = await sh(dev, `cd ${WS} && git rev-parse HEAD && git status --porcelain=v1 --ignored`);
	const diskBefore = await diskFreeMiB(dev);
	const cgBefore = await cgroup(dev);

	// The test agent acts only through `st`: `st: <args>` runs `st <args>` with the session's environment and cwd
	// and answers «st … → exit N: <output>» (#752). A person's message to @from with that body:
	const st = async (from, args, projectId = pid) => {
		const m = await waitMsg((await send(from, `st: ${args}`, projectId)).id);
		const x = /→ exit (\d+): ([\s\S]*)$/.exec(m.result_text ?? "");
		return { m, code: x ? Number(x[1]) : null, out: x ? x[2] : (m.result_text ?? "") };
	};
	// @from delegates `text` to @dev on work w; returns the request row it created (not waited).
	const delegate = async (from, w, text) => {
		const r = await st(from, `send @${DEV} --work ${w} "${text}"`);
		return { ...r, req: r.code === 0 ? await requestTo(pid, from, w, text, r.m.id - 1, false) : null };
	};
	const onWork = async (w, text) => {
		const d = await delegate(ARQ, w, text);
		return d.req ? await waitMsg(d.req.id, 180_000) : null;
	};

	// W1. @arq creates both works for @dev (`st work new`), before any message of them.
	const newMsg = {};
	for (const w of [WA, WB]) {
		const r = await st(ARQ, `work new @${DEV} ${w}`);
		newMsg[w] = r.m;
		check(`W1 @${ARQ} created ${w} for @${DEV}`, r.code === 0, short(r.out, 160));
	}
	const rowsAfterNew = { [WA]: await work(DEV, WA), [WB]: await work(DEV, WB) };
	const treesAfterNew = await sh(dev, `cd ${WS} && git worktree list --porcelain`);
	for (const w of [WA, WB])
		check(`W1 ${w} is an active work of @${DEV} on work/${w}`, rowsAfterNew[w]?.state === "active" && rowsAfterNew[w]?.branch === `work/${w}`, JSON.stringify(rowsAfterNew[w]));
	const again = await st(ARQ, `work new @${DEV} ${WA}`);
	check(`W1 ${WA} again: idempotent (exit 0, one row, one worktree)`, again.code === 0 && (await works(DEV)).filter((x) => x.id === WA).length === 1 && (await sh(dev, `cd ${WS} && git worktree list --porcelain | grep -c '/.st/ctx/${WA}$'`)).trim() === "1", short(again.out, 120));

	// W2. @arq delegates both to @dev with `st send --work`; each task runs long enough to overlap.
	const da = await delegate(ARQ, WA, "esperá 20");
	const db = await delegate(ARQ, WB, "esperá 20");
	check("W2 two requests @arq → @dev, one per work", !!da.req && !!db.req && da.req.id !== db.req.id, `${short(da.out, 80)} | ${short(db.out, 80)}`);
	if (!da.req || !db.req) return;

	// W5. While both run: a consult in @dev's default context, answered by slot 1.
	await sleep(3_000);
	const q1 = await send(DEV, "consulta rápida mientras trabajás", pid);
	const [ma, mb, mq] = await Promise.all([waitMsg(da.req.id), waitMsg(db.req.id), waitMsg(q1.id)]);
	check("W2 both work messages done", ma.state === "done" && mb.state === "done", `${ma.state}/${mb.state}`);

	// W3. Worktree before the first ACP message: `st work new` answers only once git made the worktree (the row
	// turns active after it), and the message that ran it ended before @dev claimed the work's first message.
	for (const [w, m] of [[WA, ma], [WB, mb]])
		check(
			`W3 ${w}: worktree created before its first ACP message`,
			ms(newMsg[w].finished_at) <= ms(m.started_at) && treesAfterNew.includes(`${WS}/.st/ctx/${w}`),
			`st work new ended ${newMsg[w].finished_at} · first claim ${m.started_at}`,
		);
	// W4. Real parallelism, from the backend's timestamps.
	check("W4 the two works overlapped (≥ 10 s)", overlapMs(ma, mb) >= 10_000, `overlap ${overlapMs(ma, mb)} ms, slots ${ma.slot}/${mb.slot}`);
	// W5. Slot 1 answered inside that window.
	check(
		"W5 slot 1 answered a consult while both works ran",
		mq.state === "done" && mq.slot === 1 && !workOf(mq) && ms(mq.finished_at) <= Math.min(ms(ma.finished_at), ms(mb.finished_at)),
		`slot ${mq.slot} ${mq.started_at}→${mq.finished_at}`,
	);

	// W6. Own branch, directory and ACP session.
	const branch = async (w) => (await sh(dev, `git -C ${WS}/.st/ctx/${w} branch --show-current`)).trim();
	const acpSession = async (w) => (await sh(dev, `cat ${WS}/.st/acp/ctx/${w}.json 2>/dev/null`)).trim();
	const sa = await acpSession(WA);
	const sb = await acpSession(WB);
	check("W6 cwd of each work = its worktree", cwdOf(ma.result_text) === `${WS}/.st/ctx/${WA}` && cwdOf(mb.result_text) === `${WS}/.st/ctx/${WB}`, `${cwdOf(ma.result_text)} | ${cwdOf(mb.result_text)}`);
	const [ba, bb] = [await branch(WA), await branch(WB)];
	check("W6 branch of each work = work/<id>", ba === `work/${WA}` && bb === `work/${WB}`, `${ba} | ${bb}`);
	check("W6 each work has its own ACP session", !!sa && !!sb && sa !== sb, `${short(sa, 60)} | ${short(sb, 60)}`);
	check("W6 slots: works not in slot 1 and not in the same slot", ma.slot > 1 && mb.slot > 1 && ma.slot !== mb.slot, `${ma.slot}/${mb.slot}`);

	// W7. Independent results: @dev commits in each work and pushes it to the bare remote ("PR"), with the test
	// agent's `commit <archivo>: <texto>` (write, add, commit, push origin HEAD in the session's cwd).
	const cma = await onWork(WA, "commit a.txt: resultado A");
	const cmb = await onWork(WB, "commit b.txt: resultado B");
	check("W7 each commit on its own branch, push exit 0", new RegExp(`rama work/${WA},.*push exit 0`).test(cma?.result_text ?? "") && new RegExp(`rama work/${WB},.*push exit 0`).test(cmb?.result_text ?? ""), `${short(cma?.result_text, 90)} | ${short(cmb?.result_text, 90)}`);
	const refs = await sh(dev, `git -C ${REMOTE} for-each-ref --format='%(refname:short)' refs/heads/work/`);
	check("W7 both branches pushed to the remote", refs.includes(`work/${WA}`) && refs.includes(`work/${WB}`), short(refs, 160));
	const files = async (w) => (await sh(dev, `git -C ${REMOTE} diff --name-only main work/${w} 2>&1`)).trim();
	const [fa, fb] = [await files(WA), await files(WB)];
	check("W7 each branch carries only its own file", fa === "a.txt" && fb === "b.txt", `${fa} | ${fb}`);
	check("W7 the main checkout's branch did not move", (await sh(dev, `git -C ${WS} branch --show-current`)).trim() === "main");

	// W8/W9. @rev (the lab's qa) asks @dev for a correction on st-a with `st send --work`. It must run in st-a's
	// context and ACP session; as part of it @dev consults @rev back FROM st-a (the request carries from_context,
	// which the runner turns into «desde el trabajo …» in @rev's header) and @rev's reply lands in st-a's context;
	// the reply to @rev's own request lands in @rev's default context.
	const countA = sessionCount(ma.result_text);
	const fix = await delegate(REV, WA, `consultá a @${REV}: corregido`);
	const corr = fix.req ? await waitMsg(fix.req.id) : null;
	check("W8 @rev's correction reached @dev on st-a", corr?.state === "done", short(fix.out, 120));
	check(
		"W9 the correction ran in st-a's context and ACP session",
		!!corr && workOf(corr) === WA && cwdOf(corr.result_text) === `${WS}/.st/ctx/${WA}` && (await acpSession(WA)) === sa && sessionCount(corr.result_text) > countA,
		`${workOf(corr)} ${cwdOf(corr?.result_text)} count ${countA}→${sessionCount(corr?.result_text)}`,
	);
	const back = corr
		? await waitFor(async () => (await projectRows(pid)).find((m) => m.kind === "request" && m.id > corr.id && m.from_id === DEV && m.to_id === REV) ?? null, 30_000)
		: null;
	check("W9 @dev's consult from st-a is marked as coming from st-a (from_context)", back?.from_context === WA, `${back?.id} from_context ${back?.from_context}`);
	const backDone = back ? await waitMsg(back.id) : null;
	check("W9 @rev's header named the work («desde el trabajo …»)", (backDone?.result_text ?? "").includes(`desde el trabajo ${WA}`), short(backDone?.result_text, 160));
	const replyToDev = back ? await waitFor(async () => (await projectRows(pid)).find((m) => m.kind === "reply" && m.reply_to === back.id && m.state === "done") ?? null, 60_000) : null;
	check("W9 @rev's reply came back to @dev's st-a context", !!replyToDev && workOf(replyToDev) === WA && cwdOf(replyToDev.result_text) === `${WS}/.st/ctx/${WA}`, `${workOf(replyToDev)} ${cwdOf(replyToDev?.result_text)}`);
	const replyToRev = corr ? await waitFor(async () => (await projectRows(pid)).find((m) => m.kind === "reply" && m.reply_to === corr.id && m.state === "done") ?? null, 60_000) : null;
	check("W9 the reply to @rev's request came back to @rev's default context", !!replyToRev && replyToRev.to_id === REV && !workOf(replyToRev), `${replyToRev?.to_id} ${workOf(replyToRev)}`);

	// W11. One server per work, each on its own ST_PORT_BASE; `st port check` tells mine (0) from the other's (1)
	// and from a free port (2); a bind from st-a on st-b's taken port fails with EADDRINUSE (`ocupá <p>`).
	const sva = await onWork(WA, "servidor");
	const svb = await onWork(WB, "servidor");
	const portOf = (m) => Number(/puerto (\d+)/.exec(m?.result_text ?? "")?.[1] ?? Number.NaN);
	const [pa, pb] = [portOf(sva), portOf(svb)];
	check("W11 two servers, each on its work's base (100 apart or more)", pa === rowsAfterNew[WA]?.portBase && pb === rowsAfterNew[WB]?.portBase && Math.abs(pa - pb) >= 100, `${pa} | ${pb}`);
	check("W11 both servers' messages closed (ST-PERSISTENT)", sva?.state === "done" && svb?.state === "done", `${sva?.state}/${svb?.state}`);
	const portCheck = async (w, port) => {
		const m = await onWork(w, `st: port check ${port}`);
		return { code: Number(/→ exit (\d+)/.exec(m?.result_text ?? "")?.[1] ?? Number.NaN), text: m?.result_text ?? "" };
	};
	const own = await portCheck(WA, pa);
	const foreign = await portCheck(WA, pb);
	const free = await portCheck(WA, pa + 50);
	check("W11 st port check from st-a: its own server ⇒ exit 0", own.code === 0, short(own.text, 140));
	check("W11 st port check from st-a: st-b's server ⇒ exit 1 (not yours)", foreign.code === 1, short(foreign.text, 140));
	check("W11 st port check from st-a: a free port ⇒ exit 2", free.code === 2, short(free.text, 140));
	const clash = await onWork(WA, `ocupá ${pb}`);
	check("W11 a bind from st-a on st-b's taken port is detected (EADDRINUSE)", /ocupá \d+: EADDRINUSE/.test(clash?.result_text ?? ""), short(clash?.result_text, 120));
	const srvCount = Number((await sh(dev, "pgrep -fc 'st-work-server$'")).trim());
	check("W11 exactly the two servers run", srvCount === 2, String(srvCount));

	// W10. Controlled interruption: st-a and st-b run at once; st-b's slot runner is killed (-9). st-b's message is
	// uncertain and not re-run; st-a's ends done in its own context; st-a's session is untouched.
	const la = await delegate(ARQ, WA, "esperá 25");
	const lb = await delegate(ARQ, WB, "esperá 25");
	const both = la.req && lb.req ? await waitFor(async () => ((await get(la.req.id)).state === "running" && (await get(lb.req.id)).state === "running" ? true : null), 60_000) : null;
	if (check("W10 both long runs started", !!both)) {
		const xb = await get(lb.req.id);
		await sleep(3_000);
		await sh(dev, `pkill -KILL -f '^node --no-warnings /opt/st-acp/st/runner.mjs ${xb.slot}$'; true`);
		const [ya, yb] = [await waitMsg(la.req.id, 180_000), await waitMsg(lb.req.id, 180_000)];
		check("W10 st-b's message is uncertain", yb.state === "uncertain", `${yb.state} ${short(yb.note)}`);
		await sleep(20_000);
		const zb = await get(lb.req.id);
		check("W10 st-b's message was not run again", zb.state === "uncertain" && zb.attempts === 1, `${zb.state}/${zb.attempts}`);
		check("W10 st-a's concurrent message ended done, in its own context", ya.state === "done" && workOf(ya) === WA && cwdOf(ya.result_text) === `${WS}/.st/ctx/${WA}`, `${ya.state} ${cwdOf(ya.result_text)}`);
		check("W10 st-a's ACP session unchanged", (await acpSession(WA)) === sa, short(await acpSession(WA), 60));
	}
	// Let the recovery report of the interrupted run (a system message in st-b's context) settle first.
	await waitFor(async () => !(await projectRows(pid)).concat((await api("GET", `/api/acp/agents/${DEV}/feed`)).body?.messages ?? []).some((m) => workOf(m) === WB && ["pending", "running"].includes(m.state)), 120_000);

	// W12. Cleanup is conservative and checked by the backend, not by permission. An agent outside the project is
	// refused. st-b (closed; its server from W11 still alive, the uncertain message does not block) ⇒
	// cleanup-pending naming the process; after the pilot stops that server and leaves a useful ignored `.env`,
	// the same verb again ⇒ cleanup-pending naming `.env`. Each attempt returns every reason in force: each is
	// required, never "only". Nothing is removed either time.
	for (const verb of ["close", "clean"]) {
		const o = await st(OUT, `work ${verb} ${WB}`, null);
		check(`W12 @${OUT} (outside the project): st work ${verb} ${WB} refused`, o.code !== null && o.code !== 0 && /work-other-project|work-not-found/.test(o.out) && (await work(DEV, WB))?.state === "active", short(o.out, 120));
	}
	const cl1 = await st(ARQ, `work close ${WB}`);
	check("W12 st-b closed (an uncertain message does not block)", cl1.code === 0 && (await work(DEV, WB))?.state === "closed", short(cl1.out, 120));
	const cn1 = await st(ARQ, `work clean ${WB}`);
	const rowB1 = await work(DEV, WB);
	check(
		"W12 a live process in st-b ⇒ cleanup-pending naming it, worktree kept",
		cn1.code !== 0 && rowB1?.state === "cleanup-pending" && /proceso \d+ .*(cwd en el trabajo|ST_WORK)/.test(rowB1?.note ?? "") && (await sh(dev, `test -d ${WS}/.st/ctx/${WB} && echo y`)).includes("y"),
		short(rowB1?.note, 200),
	);
	await sh(dev, `for p in $(pgrep -f 'st-work-server$'); do readlink /proc/$p/cwd | grep -q '/.st/ctx/${WB}$' && kill $p; done; sleep 1; echo SECRET=1 > ${WS}/.st/ctx/${WB}/.env`);
	const cn2 = await st(ARQ, `work clean ${WB}`);
	const rowB2 = await work(DEV, WB);
	check(
		"W12 a useful ignored .env in st-b ⇒ cleanup-pending naming .env, file kept",
		cn2.code !== 0 && rowB2?.state === "cleanup-pending" && /ignorados.*\.env/.test(rowB2?.note ?? "") && (await sh(dev, `test -f ${WS}/.st/ctx/${WB}/.env && echo y`)).includes("y"),
		short(rowB2?.note, 200),
	);
	check("W12 st-a untouched by st-b's cleanup", (await work(DEV, WA))?.state === "active" && (await branch(WA)) === `work/${WA}`, JSON.stringify(await work(DEV, WA)));
	// st-a's server keeps its slot on st-a (a session with an open task is not closed): stop it so W13 has a slot.
	await sh(dev, "pkill -f 'st-work-server$'; true");

	// W13. A disposable work: created, one commit pushed, closed and cleaned ⇒ worktree gone, branch and ACP
	// session record kept, main checkout identical, and the idle slot closed st-c's ACP session (it asks every
	// OPEN_ASK_MS, 30 s, whether its open work is still active).
	await st(ARQ, `work new @${DEV} ${WC}`);
	const cc = await onWork(WC, "commit c.txt: descartable");
	const sc = await acpSession(WC);
	const cl3 = await st(ARQ, `work close ${WC}`);
	const released = await waitFor(async () => (await sh(dev, `grep -h 'released the session of work ${WC} ' /tmp/st-acp-runner*.log 2>/dev/null | tail -1`)).trim() || null, 120_000);
	check("W13 the idle slot closed st-c's ACP session after the close", !!released, short(released ?? "", 140));
	const cn3 = await st(ARQ, `work clean ${WC}`);
	const rowC = await work(DEV, WC);
	const goneC = (await sh(dev, `cd ${WS}; test -e .st/ctx/${WC} && echo dir; git worktree list --porcelain | grep -c '/.st/ctx/${WC}$'`)).trim();
	check("W13 st-c cleaned: state cleaned, worktree removed (dir and git's list)", cn3.code === 0 && rowC?.state === "cleaned" && goneC === "0", `${goneC} · ${short(cc?.result_text, 40)} | ${short(cl3.out, 50)} | ${short(cn3.out, 80)} | ${rowC?.state} ${short(rowC?.note, 80)}`);
	const brC = (await sh(dev, `git -C ${WS} branch --list work/${WC}; git -C ${REMOTE} branch --list work/${WC}`)).split("\n").filter(Boolean);
	check("W13 st-c's branch kept (local and remote)", brC.length === 2, brC.join(" | "));
	check("W13 st-c's ACP session record kept", !!sc && (await acpSession(WC)) === sc, short(sc, 60));
	const mainAfter = await sh(dev, `cd ${WS} && git rev-parse HEAD && git status --porcelain=v1 --ignored`);
	check("W13 main checkout untouched (HEAD, status, ignored files)", mainAfter === mainBefore, `${short(mainBefore, 80)} → ${short(mainAfter, 80)}`);
	const reuse = await st(ARQ, `work new @${DEV} ${WC}`);
	check("W13 a cleaned work's id is not reused", reuse.code !== 0 && /work-exists/.test(reuse.out), short(reuse.out, 120));

	// P6. Resources and disk.
	const cg = await cgroup(dev);
	check(`P6 @${DEV}: no OOM in its container`, cg.oom === cgBefore.oom && cg.oomKill === 0, `memory.peak ${cgBefore.peakMiB}→${cg.peakMiB} MiB, oom ${cg.oom}, oom_kill ${cg.oomKill}`);
	const diskAfter = await diskFreeMiB(dev);
	const du = await sh(dev, `du -sm ${WS}/.st/ctx/* 2>/dev/null`);
	console.log(`INFO disk free ${diskBefore} → ${diskAfter} MiB; works: ${short(du, 200)}`);
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
