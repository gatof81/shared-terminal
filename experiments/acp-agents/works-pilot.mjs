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
// SKELETON: written against the contract in #926 before the PRs. Every API path, row field and test-agent
// directive that the PRs fix is marked `CONTRACT:` — adjust those lines, not the checks.
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
		...(work ? { work } : {}), // CONTRACT: the person's field for a work (`context` is gone)
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
// CONTRACT: the works of an agent (rows of agent_works: id, state, branch, dir, created_at, cleanup reasons).
const works = async (agent) => {
	const r = await api("GET", `/api/acp/agents/${agent}/works`);
	return Array.isArray(r.body) ? r.body : (r.body?.works ?? []);
};
const work = async (agent, id) => (await works(agent)).find((w) => w.id === id || w.name === id) ?? null;
// CONTRACT: which work a message row belongs to.
const workOf = (m) => m?.work ?? m?.context ?? null;
const short = (s, n = 110) => (s ?? "").replace(/\s+/g, " ").slice(0, n);
const sessionCount = (text) => Number(/sesión ACP: (\d+) mensajes/.exec(text ?? "")?.[1] ?? Number.NaN);
const cwdOf = (text) => /cwd (\S+)\)/.exec(text ?? "")?.[1] ?? null;
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
const exitOfAny = (m) => {
	const x = /exit (\d+)/.exec(m?.result_text ?? "");
	return x ? Number(x[1]) : null;
};
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
	const consultOf = (text) => short(text, 160);

	// W1. @arq creates both works for @dev (`st work new`). CONTRACT: test-agent directive `trabajo nuevo @x <id>`.
	for (const w of [WA, WB]) {
		const m = await waitMsg((await send(ARQ, `trabajo nuevo @${DEV} ${w}`, pid)).id);
		check(`W1 @${ARQ} created ${w} for @${DEV}`, m.state === "done" && !/error|rechaz|refused/i.test(m.result_text ?? ""), consultOf(m.result_text));
	}
	const rowsAfterNew = { [WA]: await work(DEV, WA), [WB]: await work(DEV, WB) };
	const treesAfterNew = await sh(dev, `cd ${WS} && git worktree list --porcelain`);
	for (const w of [WA, WB])
		check(`W1 ${w} is an active work row of @${DEV}`, rowsAfterNew[w]?.state === "active", JSON.stringify(rowsAfterNew[w]));
	// Idempotent: the same `new` again is not a second work and not an error that leaves debris.
	const again = await waitMsg((await send(ARQ, `trabajo nuevo @${DEV} ${WA}`, pid)).id);
	check(`W1 ${WA} again: idempotent (same row, no second worktree)`, (await works(DEV)).filter((x) => (x.id ?? x.name) === WA).length === 1, consultOf(again.result_text));

	// W2. @arq delegates both to @dev, each with `st send --work`; each task runs long enough to overlap.
	// CONTRACT: directive `delegá <id> a @x: <texto>` → `st send @x --work <id> "<texto>"`.
	const delegate = async (from, w, text) => {
		const m = await waitMsg((await send(from, `delegá ${w} a @${DEV}: ${text}`, pid)).id);
		return { sent: m, req: m.state === "done" ? await requestTo(pid, from, w, text, m.id - 1, false) : null };
	};
	const da = await delegate(ARQ, WA, "esperá 20");
	const db = await delegate(ARQ, WB, "esperá 20");
	check("W2 two requests @arq → @dev, one per work", !!da.req && !!db.req && da.req.id !== db.req.id, `${consultOf(da.sent.result_text)} | ${consultOf(db.sent.result_text)}`);
	if (!da.req || !db.req) return;

	// W5. While both run: a consult in @dev's default context, answered by slot 1.
	await sleep(3_000);
	const q1 = await send(DEV, "consulta rápida mientras trabajás", pid);
	const [ma, mb, mq] = await Promise.all([waitMsg(da.req.id), waitMsg(db.req.id), waitMsg(q1.id)]);
	check("W2 both work messages done", ma.state === "done" && mb.state === "done", `${ma.state}/${mb.state}`);

	// W3. Worktree before the first ACP message: the row and the worktree existed when the request was claimed.
	for (const [w, m] of [[WA, ma], [WB, mb]]) {
		const row = rowsAfterNew[w];
		check(
			`W3 ${w}: worktree created before its first ACP message`,
			!!row && ms(row.created_at ?? row.createdAt) <= ms(m.started_at) && treesAfterNew.includes(`${WS}/.st/ctx/${w}`),
			`created ${row?.created_at ?? row?.createdAt} · first claim ${m.started_at}`,
		);
	}
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

	// W7. Independent results: a commit per branch, pushed to the bare remote. CONTRACT: directive
	// `commit <archivo>: <texto>` (write, add, commit, `git push origin HEAD`) run in the work's cwd.
	const ca = await delegate(ARQ, WA, "commit a.txt: resultado A");
	const cb = await delegate(ARQ, WB, "commit b.txt: resultado B");
	const [cad, cbd] = [ca.req && (await waitMsg(ca.req.id)), cb.req && (await waitMsg(cb.req.id))];
	const refs = await sh(dev, `git -C ${REMOTE} for-each-ref --format='%(refname:short)' refs/heads/work/`);
	check("W7 both branches pushed to the remote", refs.includes(`work/${WA}`) && refs.includes(`work/${WB}`), `${short(refs, 120)} · ${consultOf(cad?.result_text)} | ${consultOf(cbd?.result_text)}`);
	const files = async (w) => (await sh(dev, `git -C ${REMOTE} diff --name-only main work/${w} 2>&1`)).trim();
	const [fa, fb] = [await files(WA), await files(WB)];
	check("W7 each branch carries only its own file", fa === "a.txt" && fb === "b.txt", `${fa} | ${fb}`);

	// W8/W9. @rev (the lab's qa) asks @dev for a correction on st-a with `st send --work`. It must run in st-a's
	// context and ACP session; as part of it @dev consults @rev back FROM st-a, so @rev's header names the work
	// and @rev's reply lands in st-a's context — and the reply to @rev's own request lands in @rev's default context.
	const countA = sessionCount(ma.result_text);
	const fix = await delegate(REV, WA, `consultá a @${REV}: corregido`);
	const corr = fix.req ? await waitMsg(fix.req.id) : null;
	check("W8 @rev's correction reached @dev on st-a", corr?.state === "done", consultOf(fix.sent.result_text));
	check(
		"W9 the correction ran in st-a's context and ACP session",
		!!corr && workOf(corr) === WA && cwdOf(corr.result_text) === `${WS}/.st/ctx/${WA}` && (await acpSession(WA)) === sa && sessionCount(corr.result_text) > countA,
		`${workOf(corr)} ${cwdOf(corr?.result_text)} count ${countA}→${sessionCount(corr?.result_text)}`,
	);
	const back = corr
		? await waitFor(async () => (await projectRows(pid)).find((m) => m.kind === "request" && m.id > corr.id && m.from_id === DEV && m.to_id === REV) ?? null, 30_000)
		: null;
	const backDone = back ? await waitMsg(back.id) : null;
	// CONTRACT: the test agent echoes the header's work line (e.g. «desde el trabajo <id>»).
	check("W9 @dev's consult from st-a: @rev's header names the work", new RegExp(`trabajo ${WA}`).test(backDone?.result_text ?? ""), short(backDone?.result_text, 160));
	const replyToDev = back ? await waitFor(async () => (await projectRows(pid)).find((m) => m.kind === "reply" && m.reply_to === back.id && m.state === "done") ?? null, 60_000) : null;
	check("W9 @rev's reply came back to @dev's st-a context", !!replyToDev && workOf(replyToDev) === WA && cwdOf(replyToDev.result_text) === `${WS}/.st/ctx/${WA}`, `${workOf(replyToDev)} ${cwdOf(replyToDev?.result_text)}`);
	const replyToRev = corr ? await waitFor(async () => (await projectRows(pid)).find((m) => m.kind === "reply" && m.reply_to === corr.id && m.state === "done") ?? null, 60_000) : null;
	check("W9 the reply to @rev's request came back to @rev's default context", !!replyToRev && replyToRev.to_id === REV && !workOf(replyToRev), `${replyToRev?.to_id} ${workOf(replyToRev)}`);

	// W11. One server per work, each in its range; `st port check` tells mine from the other's; a bind on a taken
	// port is detected. CONTRACT: directives `servidor <n>` (a process `st-work-server` on ST_PORT_BASE+n, cwd =
	// the work, declared ST-PERSISTENT, answers «puerto <p>»), `puerto <p>` (`st port check <p>`, answers its output
	// and «exit <code>»), `ocupá <p>` (tries to bind p and answers the error or «bound»).
	const onWork = async (w, text) => {
		const d = await delegate(ARQ, w, text);
		return d.req ? await waitMsg(d.req.id) : null;
	};
	const sva = await onWork(WA, "servidor 1");
	const svb = await onWork(WB, "servidor 1");
	const [pa, pb] = [sva, svb].map((m) => Number(/puerto (\d+)/.exec(m?.result_text ?? "")?.[1] ?? Number.NaN));
	check("W11 two servers, each in its own range (100 apart or more)", Number.isFinite(pa) && Number.isFinite(pb) && Math.abs(pa - pb) >= 100, `${pa} | ${pb} (${consultOf(sva?.result_text)} | ${consultOf(svb?.result_text)})`);
	check("W11 both servers' messages closed (ST-PERSISTENT)", sva?.state === "done" && svb?.state === "done", `${sva?.state}/${svb?.state}`);
	const exitOf = (m) => Number(/exit (\d+)/.exec(m?.result_text ?? "")?.[1] ?? Number.NaN);
	const own = await onWork(WA, `puerto ${pa}`);
	const foreign = await onWork(WA, `puerto ${pb}`);
	const free = await onWork(WA, `puerto ${pa + 50}`);
	check("W11 st port check from st-a: its own server ⇒ exit 0", exitOf(own) === 0, short(own?.result_text, 160));
	check("W11 st port check from st-a: st-b's server ⇒ not mine (non-zero, distinct from free)", exitOf(foreign) > 0 && exitOf(foreign) !== exitOf(free), `${short(foreign?.result_text, 120)} | free: ${short(free?.result_text, 80)}`);
	const bind = await onWork(WA, `ocupá ${pb}`);
	check("W11 a bind on st-b's taken port is detected (EADDRINUSE)", /EADDRINUSE/.test(bind?.result_text ?? ""), short(bind?.result_text, 160));

	// W10. Controlled interruption: st-a and st-b run at once; st-b's slot runner is killed. st-b's message is
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

	// W12. Cleanup is conservative. st-b still has its server (W11) ⇒ cleanup-pending with a process reason; after
	// the pilot stops that server, a useful ignored `.env` ⇒ cleanup-pending naming it. Nothing removed either
	// time. CONTRACT: directives `cerrá trabajo @x <id>` / `limpiá trabajo @x <id>` (`st work close|clean`); the
	// reasons as the row reports them.
	const op = async (text) => waitMsg((await send(ARQ, text, pid)).id);
	// An agent outside the project cannot close or clean the work (its own `st` gets the refusal).
	for (const verb of ["cerrá", "limpiá"]) {
		const o = await waitMsg((await send(OUT, `${verb} trabajo @${DEV} ${WB}`)).id);
		check(`W12 @${OUT} (outside the project): «${verb}» on st-b refused`, (exitOfAny(o) ?? 0) !== 0 && (await work(DEV, WB))?.state === "active", short(o.result_text, 120));
	}
	const reasons = (row, m) => JSON.stringify(row?.reasons ?? row?.cleanupReasons ?? row?.cleanup_reasons ?? m?.result_text ?? "");
	const cl1 = await op(`cerrá trabajo @${DEV} ${WB}`);
	const cn1 = await op(`limpiá trabajo @${DEV} ${WB}`);
	const rowB1 = await work(DEV, WB);
	check(
		"W12 a live process in st-b ⇒ cleanup-pending (process), worktree kept",
		rowB1?.state === "cleanup-pending" && /process|proceso|cwd/i.test(reasons(rowB1, cn1)) && (await sh(dev, `test -d ${WS}/.st/ctx/${WB} && echo y`)).includes("y"),
		`${short(cl1.result_text, 60)} | ${short(cn1.result_text, 80)} | ${reasons(rowB1, cn1)}`,
	);
	await sh(dev, `for p in $(pgrep -f st-work-server); do readlink /proc/$p/cwd | grep -q '/.st/ctx/${WB}' && kill $p; done; sleep 1; echo SECRET=1 > ${WS}/.st/ctx/${WB}/.env`);
	const cn2 = await op(`limpiá trabajo @${DEV} ${WB}`);
	const rowB2 = await work(DEV, WB);
	check(
		// Each attempt re-evaluates everything and returns every reason in force: require each, never "only".
		"W12 a useful ignored .env in st-b ⇒ cleanup-pending naming .env, file kept",
		rowB2?.state === "cleanup-pending" && /\.env/.test(reasons(rowB2, cn2)) && (await sh(dev, `test -f ${WS}/.st/ctx/${WB}/.env && echo y`)).includes("y"),
		`${short(cn2.result_text, 80)} | ${reasons(rowB2, cn2)}`,
	);
	check("W12 st-a untouched by st-b's cleanup", (await work(DEV, WA))?.state === "active" && (await branch(WA)) === `work/${WA}`, JSON.stringify(await work(DEV, WA)));

	// W13. A disposable work: created, one commit pushed, closed and cleaned ⇒ worktree gone, branch and ACP
	// session record kept, main checkout identical, and the idle slot closed st-c's ACP session.
	await op(`trabajo nuevo @${DEV} ${WC}`);
	const cc = await onWork(WC, "commit c.txt: descartable");
	const sc = await acpSession(WC);
	const cl3 = await op(`cerrá trabajo @${DEV} ${WC}`);
	const cn3 = await op(`limpiá trabajo @${DEV} ${WC}`);
	const rowC = await work(DEV, WC);
	const goneC = (await sh(dev, `cd ${WS}; test -e .st/ctx/${WC} && echo dir; git worktree list --porcelain | grep -c '/.st/ctx/${WC}$'`)).trim();
	check("W13 st-c cleaned: worktree removed (dir and git's list)", goneC === "0", `${goneC} · ${short(cc?.result_text, 50)} | ${short(cl3.result_text, 50)} | ${short(cn3.result_text, 50)} | ${JSON.stringify(rowC)}`);
	const brC = (await sh(dev, `git -C ${WS} branch --list work/${WC}; git -C ${REMOTE} branch --list work/${WC}`)).split("\n").filter(Boolean);
	check("W13 st-c's branch kept (local and remote)", brC.length === 2, brC.join(" | "));
	check("W13 st-c's ACP session record kept", !!sc && (await acpSession(WC)) === sc, short(sc, 60));
	// CONTRACT: how a closed work's idle slot shows it closed the ACP session (runner log line / slot field).
	const closedLog = await sh(dev, `grep -h 'closed the session of context ${WC}' ${WS}/.st/acp/*.log 2>/dev/null | tail -1`);
	check("W13 the idle slot closed st-c's ACP session", closedLog.trim() !== "", short(closedLog, 120));
	const mainAfter = await sh(dev, `cd ${WS} && git rev-parse HEAD && git status --porcelain=v1 --ignored`);
	check("W13 main checkout untouched (HEAD, status, ignored files)", mainAfter === mainBefore, `${short(mainBefore, 80)} → ${short(mainAfter, 80)}`);

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
