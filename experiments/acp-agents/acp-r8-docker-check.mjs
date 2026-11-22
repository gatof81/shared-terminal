#!/usr/bin/env node
// Real-Docker release check for #679, on DISPOSABLE sessions of a LAB backend:
//   B. hard-deleting an ACTIVE agent session closes its queue, tells an agent
//      that asked it something (once), and its token stops working;
//   C. an interrupted agent → agent request is reported to the requester once
//      and is NOT run again by anyone.
// Agents use the deterministic test adapter (ACP_TEST_RUNTIME=1): no model, no
// credentials. Run it ON the Docker host of the lab (it uses the `docker` CLI).
//
// (Part A, the admin container recreation, was removed with that feature.)
//
// Lab backend needs: ACP_TEST_RUNTIME=1 and a login.
//   LAB=1 ST=http://127.0.0.1:3101 LAB_LOGIN=1 node acp-r8-docker-check.mjs
// It creates and hard-deletes its own sessions only (names `<PREFIX>-…`),
// and refuses to run without LAB=1. KEEP=1 keeps them. Exit 1 on any FAIL.
import { execFileSync, execSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";

if (process.env.LAB !== "1") {
	console.error("refusing: set LAB=1 — this script hard-deletes sessions (its own, but only on a lab)");
	process.exit(2);
}
const ST = process.env.ST ?? "http://127.0.0.1:3101";
const PREFIX = process.env.PREFIX ?? `r${randomBytes(2).toString("hex")}`;
const ASK = `${PREFIX}-ask`;
const DEL = `${PREFIX}-del`;
const SLOW = `${PREFIX}-slow`;
let cookie = "";
let failures = 0;
const created = [];
const t0 = Date.now();
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const at = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
function check(name, ok, evidence) {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"} [${at()}] ${name}${evidence ? ` — ${evidence}` : ""}`);
	return ok;
}

async function auth() {
	if (cookie) return;
	if (process.env.MINT_CMD) {
		cookie = `st_token=${execSync(process.env.MINT_CMD, { encoding: "utf8" }).trim()}`;
		return;
	}
	const body = JSON.stringify({ username: "labowner", password: "lab-password-1234" });
	for (const p of ["/api/auth/register", "/api/auth/login"]) {
		const r = await fetch(ST + p, { method: "POST", headers: { "content-type": "application/json" }, body });
		const set = r.headers.get("set-cookie");
		if (set) return void (cookie = set.split(";")[0]);
	}
	throw new Error("no lab login");
}
async function api(method, path, body, bearer) {
	if (!bearer) await auth();
	const res = await fetch(ST + path, {
		method,
		headers: {
			"content-type": "application/json",
			...(bearer ? { authorization: `Bearer ${bearer}` } : { cookie, origin: process.env.ORIGIN ?? "" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let json = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {}
	return { status: res.status, body: json ?? text };
}
const send = async (to, body) => {
	const r = await api("POST", "/api/acp/messages", { to, body, clientId: randomUUID() });
	if (r.status !== 201) throw new Error(`send ${to}: ${r.status} ${JSON.stringify(r.body)}`);
	return r.body;
};
const get = async (id) => (await api("GET", `/api/acp/messages/${id}`)).body;
async function waitFor(fn, ms = 120_000) {
	const end = Date.now() + ms;
	for (;;) {
		const v = await fn();
		if (v || Date.now() > end) return v;
		await sleep(1_500);
	}
}
const waitMsg = (id, states = ["done", "failed", "uncertain"], ms) =>
	waitFor(async () => {
		const m = await get(id);
		return states.includes(m.state) ? m : null;
	}, ms);
const runnerOnline = async (name) =>
	(await api("GET", "/api/acp/agents")).body.find(
		(a) => a.name === name && a.runnerSeenAt && Date.now() - Date.parse(a.runnerSeenAt) < 15_000,
	);
const container = (sid) => `st-${sid.slice(0, 12)}`;
const all = async () => (await api("GET", "/api/acp/messages")).body;

async function agentSession(name) {
	const r = await api("POST", "/api/sessions", { name: `acp ${name}`, acpAgent: { name, runtime: "st-test-agent" } });
	if (!check(`session with @${name} created`, r.status === 201, `${r.status}`)) throw new Error("create");
	created.push(r.body.sessionId);
	check(`runner of @${name} online`, !!(await waitFor(() => runnerOnline(name), 90_000)));
	return r.body.sessionId;
}

async function partB() {
	console.log("— B. hard delete of an active agent session");
	const delSid = await agentSession(DEL);
	await agentSession(ASK);
	const token = execFileSync(
		"docker",
		["exec", container(delSid), "sh", "-c", "tr '\\0' '\\n' < /proc/$(pgrep -f '^node --no-warnings /opt/st-acp/st/runner.mjs' | head -1)/environ | sed -n 's/^ST_TOKEN=//p'"],
		{ encoding: "utf8" },
	).trim();
	check("agent token works before the delete", (await api("GET", "/api/acp/agents", undefined, token)).status === 200);
	const busy = await send(DEL, "esperá 120");
	await waitMsg(busy.id, ["running"], 30_000);
	const queued = await send(DEL, "en cola");
	const ask = await waitMsg((await send(ASK, `consultá a @${DEL}: pregunta para borrar`)).id);
	const consult = await waitFor(async () => (await all()).find((m) => m.from_id === ASK && m.to_id === DEL));
	check("@ask's request to @del is queued", consult?.state === "pending", consult && `#${consult.id}`);
	const del = await api("DELETE", `/api/sessions/${delSid}?hard=true`);
	check("hard delete of the active session", del.status === 204, String(del.status));
	created.splice(created.indexOf(delSid), 1);
	for (const [what, id] of [["running", busy.id], ["queued", queued.id], ["agent's request", consult?.id]])
		check(`${what} message closed as failed`, (await get(id))?.state === "failed", (await get(id))?.note);
	const notices = (await all()).filter((m) => m.reply_to === consult?.id && m.kind === "reply");
	check("@ask told once that its request did not finish", notices.length === 1, notices.map((m) => m.note).join());
	check("the deleted agent's token is refused", (await api("GET", "/api/acp/agents", undefined, token)).status === 401);
	let gone = false;
	try {
		execFileSync("docker", ["inspect", container(delSid)], { stdio: "ignore" });
	} catch {
		gone = true;
	}
	check("its container is gone", gone);
	void ask;
}

async function partC() {
	console.log("— C. an interrupted agent request is reported, not repeated");
	const slowSid = await agentSession(SLOW);
	const asker = ASK;
	await send(asker, `consultá a @${SLOW}: esperá 60`);
	const req = await waitFor(async () => (await all()).find((m) => m.from_id === asker && m.to_id === SLOW));
	await waitMsg(req.id, ["running"], 60_000);
	await api("POST", `/api/sessions/${slowSid}/stop`);
	await api("POST", `/api/sessions/${slowSid}/start`);
	const u = await waitMsg(req.id, ["uncertain", "failed", "done"], 120_000);
	check("the interrupted request is uncertain", u?.state === "uncertain", u?.note);
	const notice = await waitFor(async () => (await all()).find((m) => m.reply_to === req.id && m.kind === "reply"));
	check("@ask got one notice", !!notice && notice.note === "unfinished:uncertain");
	check("…telling it not to repeat the request", String(notice?.body).includes("No lo repitas"));
	await waitMsg(notice.id, ["done", "failed", "uncertain"], 60_000);
	await sleep(15_000);
	const again = await get(req.id);
	const repeats = (await all()).filter((m) => m.from_id === asker && m.to_id === SLOW && m.id !== req.id);
	check("nothing ran it again", again.state === "uncertain" && again.attempts === 1 && repeats.length === 0, `${again.state} attempts=${again.attempts} repeats=${repeats.length}`);
}

async function main() {
	console.log(`R8 Docker check against ${ST} — prefix ${PREFIX}`);
	const rt = await api("GET", "/api/acp/runtimes");
	if (!check("runtime st-test-agent installed", rt.body?.available?.includes("st-test-agent"), JSON.stringify(rt.body))) return;
	for (const part of [partB, partC]) {
		try {
			await part();
		} catch (err) {
			check(`${part.name} aborted`, false, err.message);
		}
	}
}

main()
	.catch((err) => check("aborted", false, err.message))
	.finally(async () => {
		if (process.env.KEEP !== "1")
			for (const sid of created) await api("DELETE", `/api/sessions/${sid}?hard=true`).catch(() => {});
		console.log(failures ? `${failures} FAILED` : "ALL PASS");
		process.exit(failures ? 1 : 0);
	});
