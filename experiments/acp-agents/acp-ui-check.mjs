// Browser acceptance of Entrega 3B in the real web UI against a real backend
// (the lab) with the deterministic agent (runtime st-test-agent), desktop and
// phone: two agents created from the new-session form → a topic created from
// the rail → a post to two agents and to «Todo el equipo» (one state row per
// recipient, chips kept in the topic) → a question answered in the thread → an
// interruption (the agent's runner killed) reviewed from Pendientes without
// requeueing → Herramientas of a work (only `work=<id>`, never `.st/`; «Sesión
// completa»; a work that is not there) → the terminal invariant measured on the
// real socket (topic ⇄ Herramientas ⇄ Pendientes: 0 resize) → the Archive
// (read-only, «Continuar en una conversación nueva») → the phone's stack.
//
// Made to be run blind (by the lab operator): every FAIL line says the step,
// what was checked, the selector and the page's URL, and leaves fail-NN.png;
// every step leaves NN-<step>.png in <shots>. The last line is ALL PASS or
// "N FAILED"; exit code 0 / 1.
//
// In the lab (as run for OPS-RESULT 7): inside CI's Playwright image
// (mcr.microsoft.com/playwright:v1.52.0-noble, --network host), after
// `cd frontend && npm ci && VITE_API_URL=http://localhost:3101 npm run build`
// and the build served by `lab-st.sh web dist` on :5174:
//   WEB=http://localhost:5174 API=http://localhost:3101 node experiments/acp-agents/acp-ui-check.mjs <shots>
// (@playwright/test is resolved from frontend/node_modules, whatever the cwd.)
// KEEP=1 keeps the sessions and the project it creates.
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

// @playwright/test is frontend/'s dependency: resolved from there, so the
// script runs as it is from any cwd (Node resolves bare imports from the
// file's own directory, not the cwd).
const require = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { chromium, devices } = require("@playwright/test");

const shots = process.argv[2] ?? "./ui-check-shots";
mkdirSync(shots, { recursive: true });
const WEB = process.env.WEB ?? "http://localhost:5174";
const API = process.env.API ?? "http://localhost:3101";
const P = process.env.PREFIX ?? `u${Math.random().toString(16).slice(2, 6)}`;
const ARQ = `${P}-arq`;
const DEV = `${P}-dev`;
const WORK = `w${P}`;
const WS = "/home/developer/workspace";
const RUNNER = "^node --no-warnings /opt/st-acp/st/runner.mjs$";

// ── Reporting ────────────────────────────────────────────────────────────────
let failures = 0;
let stepNo = 0;
let stepName = "start";
let failShot = 0;
const errors = [];

async function step(page, name, fn) {
	stepNo++;
	stepName = `${String(stepNo).padStart(2, "0")} ${name}`;
	console.log(`── ${stepName}`);
	try {
		await fn();
	} catch (err) {
		await fail(page, "the step threw", String(err?.message ?? err).split("\n")[0], "");
	}
	await page
		.screenshot({ path: `${shots}/${String(stepNo).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/gi, "-")}.png` })
		.catch(() => {});
}

async function fail(page, what, evidence, sel) {
	failures++;
	failShot++;
	const file = `fail-${String(failShot).padStart(2, "0")}.png`;
	await page?.screenshot({ path: `${shots}/${file}` }).catch(() => {});
	console.log(`FAIL [${stepName}] ${what}${evidence ? ` — ${evidence}` : ""}`);
	console.log(`     selector: ${sel || "(none)"} · url: ${page?.url() ?? "(no page)"} · shot: ${file}`);
}

async function check(page, what, ok, evidence = "", sel = "") {
	if (ok) console.log(`PASS [${stepName}] ${what}${evidence ? ` — ${evidence}` : ""}`);
	else await fail(page, what, evidence, sel);
	return ok;
}

/** Waits for `sel` (optionally with `text`) to be visible; a FAIL names it. */
async function sees(page, what, sel, { text, timeout = 20_000 } = {}) {
	const loc = text === undefined ? page.locator(sel).first() : page.locator(sel, { hasText: text }).first();
	const ok = await loc
		.waitFor({ state: "visible", timeout })
		.then(() => true)
		.catch(() => false);
	return check(page, what, ok, text === undefined ? "" : `text ${JSON.stringify(String(text))}`, sel);
}

/** Polls `fn` until it returns a truthy value (or the time runs out): the value or null. */
async function until(fn, timeout = 30_000, every = 1_000) {
	const end = Date.now() + timeout;
	for (;;) {
		const v = await fn().catch(() => null);
		if (v) return v;
		if (Date.now() > end) return null;
		await new Promise((r) => setTimeout(r, every));
	}
}

// ── Browser and API (the page's own cookie) ─────────────────────────────────
const browser = await chromium.launch();
async function context(opts) {
	// bypassCSP: the app's CSP forbids the eval Playwright's waitForFunction uses.
	return browser.newContext({ ...opts, bypassCSP: true });
}
function watch(page) {
	page.on("pageerror", (e) => errors.push(`${page.url()} · ${e.message}`));
}
async function login(page) {
	await page.goto(`${WEB}/`);
	await page.fill("#auth-username", "labowner");
	await page.fill("#auth-password", "lab-password-1234");
	await page.press("#auth-password", "Enter");
	await page.waitForSelector("#new-session-btn", { state: "attached", timeout: 30_000 });
	await page.waitForTimeout(1_500);
}
const json = (page, path, init) =>
	page.evaluate(
		async ([api, path, init]) => {
			const r = await fetch(api + path, { credentials: "include", headers: { "content-type": "application/json" }, ...init });
			return { status: r.status, body: await r.json().catch(() => null) };
		},
		[API, path, init],
	);
/** `sh -c` in a session's container (exec API, NDJSON): stdout. */
const sh = (page, sid, script) =>
	page.evaluate(
		async ([api, sid, script]) => {
			const r = await fetch(`${api}/api/sessions/${sid}/exec`, {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ cmd: ["sh", "-c", script] }),
			});
			let out = "";
			for (const line of (await r.text()).split("\n"))
				try {
					const e = JSON.parse(line);
					if (e.type === "output" && e.stream === "stdout") out += e.data;
				} catch {}
			return out;
		},
		[API, sid, script],
	);
const agentRow = async (page, name) => (await json(page, "/api/acp/agents")).body?.find((a) => a.name === name) ?? null;
const convFeed = async (page, cid) => (await json(page, `/api/acp/conversations/${cid}/feed`)).body?.messages ?? [];
const inboxCount = async (page) => (await json(page, "/api/acp/inbox")).body?.count ?? -1;
const hashOf = (page) => new URL(page.url()).hash;

// ── The run ─────────────────────────────────────────────────────────────────
const ctx = await context({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
watch(page);
const created = [];
let pid = null;
let cid = null;
let others = null;
const chips = "#project-view .acp-to-chips";
const field = "#project-view .ps-topic .acp-chat-input";
const sendBtn = "#project-view .ps-topic .acp-chat-send";
const thread = "#project-view .ps-topic .acp-chat-thread";

/**
 * Adds `label` to «Para» with "+". A row that is already checked is a recipient
 * already there, and a tap REMOVES it: the step fails here, naming it, instead
 * of later at a send that has no recipients.
 */
async function pick(page, label) {
	await page.locator("#project-view .acp-pick-btn").click();
	const row = page.getByRole("menuitemcheckbox", { name: label });
	const before = await row.getAttribute("aria-checked");
	await row.click();
	const after = await row.getAttribute("aria-checked");
	if (after !== "true") await fail(page, `«Para» did not get ${label}`, `aria-checked ${before} → ${after}`, "#project-view .acp-pick-menu [role=menuitemcheckbox]");
	await page.keyboard.press("Escape");
}
async function clearChips(page) {
	for (let i = 0; i < 6 && (await page.locator(`${chips} .acp-chip-x`).count()); i++)
		await page.locator(`${chips} .acp-chip-x`).first().click();
}
/** Posts `text` from the topic's box; the request body (null when none left). */
async function post(page, text) {
	await page.fill(field, text);
	const req = page.waitForRequest((r) => r.url().endsWith("/api/acp/messages") && r.method() === "POST", { timeout: 10_000 }).catch(() => null);
	await page.click(sendBtn);
	return (await req)?.postDataJSON() ?? null;
}
const postRow = (page, text) => page.locator(`${thread} .acp-post`, { hasText: text }).first();
/**
 * Recipients that answered a post: a «respondió» row each while others are
 * still on their way, and — the design fixed in #757 (§F2) — one compact line
 * «✓ @a ✓ @b» once every recipient answered.
 */
const answered = async (row) =>
	(await row.locator(".acp-rs", { hasText: "respondió" }).count()) + (await row.locator(".acp-rs-all .acp-rs-check").count());
const stateText = async (row) => (await row.locator(".acp-rs, .acp-rs-all").allTextContents()).join(" | ");

try {
	await login(page);
	others = (await json(page, "/api/acp/agents")).body.filter((a) => !a.name.startsWith(`${P}-`)).map((a) => [a.name, a.projectId]);

	await step(page, "agents-from-the-form", async () => {
		async function createAgent(agent, projectChoice) {
			await page.click("#new-session-btn");
			// The form focuses its first field once more on the next frame
			// (newSession.ts, a requestAnimationFrame) and fill() does not wait for
			// frames: that focus landing inside the agent field's fill sent its text
			// to the session's name («acp X» + «X», agent empty). rAF callbacks run in
			// the order they were asked for, so once ours runs the form's has.
			await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
			await page.fill("#new-session-input", `acp ${agent}`);
			await page.fill("#new-session-acp-agent", agent);
			const typed = await page.evaluate(() => [document.querySelector("#new-session-input")?.value, document.querySelector("#new-session-acp-agent")?.value]);
			if (typed[0] !== `acp ${agent}` || typed[1] !== agent)
				await fail(page, "the form holds what was typed", JSON.stringify(typed), "#new-session-input, #new-session-acp-agent");
			await page.waitForFunction(() => document.querySelector("#new-session-acp-project")?.options.length > 1, null, { timeout: 10_000 });
			if (projectChoice.new) {
				await page.selectOption("#new-session-acp-project", "__new__");
				await page.fill("#new-session-acp-new-project", projectChoice.new);
			} else await page.selectOption("#new-session-acp-project", projectChoice.id);
			await page.selectOption("#new-session-acp-runtime", "st-test-agent");
			await page.click("#new-session-submit");
			// The API has the agent as soon as the POST lands, while the form still
			// waits for its own reads before closing: the next "+ New session" goes
			// after the form closed, not into it.
			const closed = await page
				.waitForFunction(() => !document.querySelector("#new-session-modal")?.classList.contains("open"), null, { timeout: 60_000 })
				.then(() => true)
				.catch(() => false);
			if (!closed) await fail(page, "the form closed after «Crear»", "", "#new-session-modal.open");
			const a = await until(() => agentRow(page, agent), 60_000);
			await check(page, `session with @${agent} created from the form`, !!a, a && `${a.runtime} project ${a.projectId}`, "#new-session-submit");
			if (a) created.push(a.sessionId);
			return a;
		}
		const arq = await createAgent(ARQ, { new: `Proyecto UI ${P}` });
		pid = arq?.projectId ?? null;
		await check(page, "'+ Proyecto nuevo…' created the project with the agent in it", !!pid);
		const dev = await createAgent(DEV, { id: pid });
		await check(page, "the second agent joined that project", dev?.projectId === pid, dev?.projectId);
		// Both runners up (they claim nothing before their bootstrap ends).
		const up = await until(async () => {
			const rows = (await json(page, "/api/acp/agents")).body.filter((a) => a.name === ARQ || a.name === DEV);
			return rows.length === 2 && rows.every((a) => a.runnerSeenAt) ? rows : null;
		}, 120_000, 3_000);
		await check(page, "both runners online", !!up);
		// @dev can hold a work: two slots, and its workspace a repo with one commit.
		const mc = await json(page, `/api/acp/agents/${DEV}`, { method: "PATCH", body: JSON.stringify({ maxConcurrency: 2 }) });
		await check(page, `@${DEV} has 2 slots`, mc.status === 200, String(mc.status));
		await sh(
			page,
			dev.sessionId,
			`set -e; cd ${WS}; git init -q -b main; git config user.name lab; git config user.email lab@lab.invalid; ` +
				`printf '.st/\\nnode_modules/\\n' > .gitignore; echo base > README.md; git add -A; git commit -qm base`,
		);
		const head = (await sh(page, dev.sessionId, `git -C ${WS} log --oneline -1`)).trim();
		await check(page, `@${DEV}'s workspace is a repo`, /base$/.test(head), head);
		// What the Archive will show: a direct message of before topics (no project, no conversation).
		const dm = await json(page, "/api/acp/messages", { method: "POST", body: JSON.stringify({ to: DEV, body: `directo de antes ${P}` }) });
		await check(page, "a direct message (the Archive's) was accepted", dm.status === 201, String(dm.status));
	});

	await step(page, "topic-from-the-rail", async () => {
		await page.goto(`${WEB}/#/projects/${pid}`);
		await sees(page, "the project's rail", ".rail-body");
		await page.locator(".rail-body").getByRole("button", { name: "Nueva conversación" }).click();
		await page.locator(".dialog-card .modal-field input").fill(`Tema ${P}`);
		await page.locator(".dialog-card .modal-primary-action").click();
		await sees(page, "the new topic is open", "#ps-topic-title", { text: `Tema ${P}` });
		cid = /\/c\/([^/?#]+)/.exec(hashOf(page))?.[1] ?? null;
		await check(page, "its address names the topic", !!cid, hashOf(page));
		await check(page, "a new topic starts with no recipients", (await page.locator(`${chips} .acp-chip`).count()) === 0, "", `${chips} .acp-chip`);
	});

	await step(page, "post-to-two-agents", async () => {
		await pick(page, new RegExp(`@${ARQ}\\b`));
		await pick(page, new RegExp(`@${DEV}\\b`));
		const body = await post(page, "esperá 4");
		await check(page, "one post: the topic and both agents", body?.conversationId === cid && JSON.stringify(body?.to) === JSON.stringify([ARQ, DEV]), JSON.stringify(body), sendBtn);
		const row = postRow(page, "esperá 4");
		await check(page, "two state rows, one per recipient", (await until(async () => (await row.locator(".acp-rs").count()) === 2, 15_000)) !== null, `${await row.locator(".acp-rs").count()} rows`, `${thread} .acp-post .acp-rs`);
		const both = await until(async () => (await answered(row)) === 2, 60_000);
		await check(page, "both recipients answered (rows, then «✓ @a ✓ @b»)", !!both, await stateText(row), `${thread} .acp-post .acp-rs, .acp-rs-all`);
	});

	await step(page, "post-to-the-team", async () => {
		await clearChips(page);
		await pick(page, /Todo el equipo · 2/);
		await sees(page, "the chip says «Todo el equipo · 2»", chips, { text: "Todo el equipo · 2" });
		const body = await post(page, "hola equipo");
		await check(page, "sent as team: true", body?.team === true && body?.to === undefined && body?.conversationId === cid, JSON.stringify(body));
		const row = postRow(page, "hola equipo");
		await sees(page, "the post says → Todo el equipo (2)", `${thread} .acp-post .acp-team-to`, { text: "Todo el equipo (2)" });
		const done = await until(async () => (await answered(row)) === 2, 60_000);
		await check(page, "both team recipients answered", !!done, await stateText(row), `${thread} .acp-post .acp-rs, .acp-rs-all`);
		// The chips belong to the topic: away (the rail) and back, still there.
		await page.goto(`${WEB}/#/projects/${pid}`);
		await page.goto(`${WEB}/#/projects/${pid}/c/${cid}`);
		await sees(page, "back in the topic, its chips are kept", chips, { text: "Todo el equipo · 2" });
	});

	await step(page, "question-answered-in-the-thread", async () => {
		await clearChips(page);
		await pick(page, new RegExp(`@${ARQ}\\b`));
		const before = await inboxCount(page);
		await post(page, "preguntá: ¿Qué base de datos usamos? | SQLite | Postgres");
		const card = page.locator(`${thread} .acp-question-open`).first();
		await sees(page, "the question's card is in the thread", `${thread} .acp-question-open`, { timeout: 45_000 });
		await check(page, "…and counts in Pendientes", (await until(async () => (await inboxCount(page)) > before, 15_000)) !== null, `before ${before}`, "#inbox-btn");
		await card.getByLabel("SQLite").check();
		await card.getByRole("button", { name: "Responder" }).click();
		await sees(page, "the agent continued with the answer", thread, { text: "Elegiste: SQLite", timeout: 45_000 });
		await check(page, "no open question left in the thread", (await until(async () => (await page.locator(`${thread} .acp-question-open`).count()) === 0, 20_000)) !== null, "", `${thread} .acp-question-open`);
	});

	await step(page, "interruption-reviewed-from-pendientes", async () => {
		// @arq alone in «Para:» (kept from the question).
		await post(page, "esperá 90");
		const row = postRow(page, "esperá 90");
		await check(page, "the row says it is working", (await until(async () => (await row.locator(".acp-rs", { hasText: "trabajando" }).count()) === 1, 30_000)) !== null, (await row.locator(".acp-rs").allTextContents()).join(" | "), `${thread} .acp-rs`);
		const arq = await agentRow(page, ARQ);
		await sh(page, arq.sessionId, `pkill -KILL -f '${RUNNER}'; true`);
		const cut = await until(async () => (await row.locator(".acp-rs", { hasText: "interrumpida" }).count()) === 1, 150_000, 3_000);
		await check(page, "the killed run reads «interrumpida» (the watchdog relaunched the runner)", !!cut, (await row.locator(".acp-rs").allTextContents()).join(" | "), `${thread} .acp-rs`);
		const mine = async () => (await convFeed(page, cid)).filter((m) => m.from_id === "owner").length;
		const before = await mine();
		const countBefore = await inboxCount(page);
		await page.click("#inbox-btn");
		const item = page.locator(".acp-inbox-card .acp-ib-item.is-interrupted", { hasText: "esperá 90" }).first();
		await sees(page, "Pendientes lists the interruption", ".acp-inbox-card .acp-ib-item.is-interrupted", { text: "esperá 90" });
		await item.getByRole("button", { name: "Revisar interrupción" }).click();
		const review = page.locator(".acp-review-card");
		await sees(page, "«Revisar interrupción» opens", ".acp-review-card");
		await review.getByText("Reencolar el mensaje original…").click();
		const requeue = review.getByRole("button", { name: "Reencolar", exact: true });
		await check(page, "«Reencolar» is off until acknowledged", await requeue.isDisabled().catch(() => false), "", ".acp-review-card button «Reencolar»");
		await review.getByRole("button", { name: "Dar por revisada, sin reencolar" }).click();
		await check(page, "«Dar por revisada» lowers the count", (await until(async () => (await inboxCount(page)) === countBefore - 1, 15_000)) !== null, `before ${countBefore}, now ${await inboxCount(page)}`, "#inbox-btn");
		await page.keyboard.press("Escape").catch(() => {});
		await page.waitForTimeout(3_000);
		await check(page, "…and sends nothing", (await mine()) === before, `${before} → ${await mine()}`);
		const m = (await convFeed(page, cid)).find((x) => x.body === "esperá 90");
		await check(page, "the message stays uncertain, reviewed", m?.state === "uncertain" && !!m?.reviewed_at, `${m?.state} reviewed_at ${m?.reviewed_at}`);
	});

	await step(page, "herramientas-of-a-work", async () => {
		const w = await json(page, "/api/acp/works", { method: "POST", body: JSON.stringify({ agent: DEV, id: WORK }) });
		await check(page, `work ${WORK} created`, w.status === 201 || w.status === 200, `${w.status} ${JSON.stringify(w.body)?.slice(0, 120)}`);
		const urls = [];
		const onReq = (r) => {
			if (/\/api\/sessions\/[^/]+\/(fs|files|git)\b/.test(r.url())) urls.push(r.url());
		};
		page.on("request", onReq);
		await page.goto(`${WEB}/#/projects/${pid}/c/${cid}/tools/${DEV}/${WORK}/files`);
		await sees(page, "Herramientas' bar", ".tools-bar");
		await sees(page, "the strip: the work's branch", "#files-view #tools-strip", { text: `work/${WORK}` });
		await sees(page, "the strip: the work's directory", "#files-view #tools-strip", { text: `.st/ctx/${WORK}` });
		await sees(page, "Files lists the worktree", "#files-view", { text: "README.md" });
		await page.click("#view-git-btn");
		await sees(page, "Git of the work: its branch", "#git-view #tools-strip", { text: `work/${WORK}` });
		await page.waitForTimeout(2_000);
		await page.click("#view-terminal-btn");
		const ws = await until(async () => {
			const t = await page.locator(".tools-ws").evaluate((s) => s.selectedOptions[0]?.textContent ?? "");
			return t === "Sesión completa" ? t : null;
		}, 10_000);
		await check(page, "Terminal: the workspace reads «Sesión completa»", !!ws, "", ".tools-ws (selected option)");
		page.off("request", onReq);
		const bad = urls.filter((u) => !u.includes(`work=${WORK}`) || /\.st(\/|%2F)/i.test(u));
		await check(page, "every Files/Git request carried work=<id> and no .st/ path", urls.length > 0 && bad.length === 0, `${urls.length} requests${bad.length ? `; bad: ${bad.slice(0, 3).join(" ")}` : ""}`);
		// A work that is not there: one state, no retry.
		await page.goto(`${WEB}/#/projects/${pid}/c/${cid}/tools/${DEV}/ghost${P}/files`);
		await sees(page, "a missing work: «ya no está disponible»", "#files-view .tools-gone-state", { text: "Ver workspace principal" });
		await check(page, "…with no retry button", (await page.locator("#files-view .tools-gone-state").getByRole("button", { name: /Reintentar|Retry|↻/ }).count()) === 0);
	});

	await step(page, "terminal-invariant-on-the-real-socket", async () => {
		const sockets = [];
		page.on("websocket", (ws) => {
			if (!ws.url().includes("/ws/acp")) {
				const s = { url: ws.url(), resize: 0 };
				ws.on("framesent", (f) => {
					if (typeof f.payload === "string" && /"type"\s*:\s*"resize"/.test(f.payload)) s.resize++;
				});
				sockets.push(s);
			}
		});
		// Herramientas opened from the topic, as a person does (the agent's menu):
		// a history entry, so ‹ Tema and Forward walk it. (Entered by a deep link
		// instead, ‹ Tema replaces the entry by design — F4 — and there is no Forward.)
		await page.goto(`${WEB}/#/projects/${pid}/c/${cid}`);
		await sees(page, "the topic", "#ps-topic-title", { text: `Tema ${P}` });
		await page.locator(`#project-view .acp-agent-id[data-agent="${DEV}"]`).first().click();
		await page.locator('[role="menu"].action-menu').getByRole("menuitem", { name: /^Terminal de la sesión/ }).click();
		await sees(page, "Herramientas of the agent, Terminal", ".tools-bar");
		// A session created by the form has no tmux tab yet: open one, as a person would.
		const open = page.getByRole("button", { name: /Open a tab/ });
		if (await open.isVisible().catch(() => false)) await open.click();
		await sees(page, "the agent's terminal", "#terminal-container .xterm");
		await page.waitForTimeout(4_000);
		await check(page, "its terminal socket is open", sockets.length > 0, `${sockets.length} socket(s)`);
		const n0 = sockets.length;
		const r0 = sockets.reduce((a, s) => a + s.resize, 0);
		await page.locator(".tools-back").click();
		await sees(page, "‹ back to the topic", "#ps-topic-title", { text: `Tema ${P}` });
		await page.goForward();
		await sees(page, "Forward: Herramientas again", ".tools-bar");
		await page.click("#inbox-btn");
		await sees(page, "Pendientes over Herramientas", ".acp-inbox-card");
		await page.keyboard.press("Escape");
		await page.click("#view-files-btn");
		await page.click("#view-git-btn");
		await page.click("#view-terminal-btn");
		await page.goBack();
		await page.goForward();
		await page.waitForTimeout(3_000);
		const r1 = sockets.reduce((a, s) => a + s.resize, 0);
		await check(page, "topic ⇄ Herramientas ⇄ Pendientes ⇄ views: 0 resize frames", r1 === r0, `${r1 - r0} resize frame(s)`);
		await check(page, "…and no new terminal socket", sockets.length === n0, `${n0} → ${sockets.length}`);
	});

	await step(page, "the-archive", async () => {
		await page.goto(`${WEB}/#/projects/${pid}`);
		await page.locator(".rail-body .rail-archive-row").click();
		await sees(page, "the Archive's page", "#ps-archive-title", { text: "Archivo · solo lectura" });
		await page.locator("#project-view .ps-archive .ps-archive-row", { hasText: `@${DEV}` }).first().click();
		await sees(page, "@dev's previous direct messages", "#ps-archive-title", { text: `@${DEV} · chat individual` });
		await sees(page, "…with the direct message", "#project-view .ps-archive .acp-chat-thread", { text: `directo de antes ${P}` });
		await check(page, "read only: no message box", (await page.locator("#project-view .ps-archive .acp-chat-input").isVisible().catch(() => false)) === false, "", "#project-view .ps-archive .acp-chat-input");
		await page.getByRole("button", { name: "Continuar en una conversación nueva" }).click();
		await page.locator(".dialog-card .modal-primary-action").click();
		await sees(page, "«Continuar…» opens a new topic", "#ps-topic-title", { text: "Continuación" });
		await sees(page, "…with @dev in «Para:»", chips, { text: `@${DEV}` });
	});

	const errs = errors.splice(0);
	await check(page, "desktop: no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
} catch (err) {
	await fail(page, "desktop run aborted", String(err?.message ?? err).split("\n")[0], "");
}

// ── The phone ───────────────────────────────────────────────────────────────
const mctx = await context({ ...devices["iPhone 13"], defaultBrowserType: undefined });
const m = await mctx.newPage();
watch(m);
try {
	await login(m);
	await step(m, "phone-stack", async () => {
		await m.goto(`${WEB}/#/projects/${pid}`);
		await sees(m, "the project's screen (its rail)", ".rail-body");
		await sees(m, "Pendientes from the project's screen", "#inbox-btn");
		await m.locator(".rail-body .rail-conv", { has: m.locator(".rail-row-title", { hasText: `Tema ${P}` }) }).click();
		await sees(m, "the topic", "#ps-topic-title", { text: `Tema ${P}` });
		await sees(m, "Pendientes from the topic", "#inbox-btn");
		const box = await m.locator(field).boundingBox();
		await check(m, "the message box on screen", !!box && box.y > 0 && box.y + box.height <= 844, JSON.stringify(box), field);
		const overflow = await m.evaluate(() => {
			const v = document.querySelector("#project-view");
			return { page: document.documentElement.scrollWidth - innerWidth, view: v ? v.scrollWidth - v.clientWidth : 0 };
		});
		await check(m, "no horizontal overflow", overflow.page <= 1 && overflow.view <= 1, JSON.stringify(overflow));
		// The title comes from the rail's list, the topic's recipients with its
		// feed, which may land later: cleared before it, «Para» was still empty,
		// then showed @arq (the desktop's last post) checked in "+", and the tap
		// removed it. The feed's own content says it landed.
		await sees(m, "the topic's thread (the desktop's last post)", `${thread} .acp-post`, { text: "esperá 90" });
		await clearChips(m);
		await pick(m, new RegExp(`@${ARQ}\\b`));
		await post(m, "hola desde el móvil");
		await check(m, "a post from the phone is answered", (await until(async () => (await answered(postRow(m, "hola desde el móvil"))) === 1, 60_000)) !== null, await stateText(postRow(m, "hola desde el móvil")), `${thread} .acp-rs, .acp-rs-all`);
		// Herramientas → Back → the topic at the same place → Back → the project.
		const top = await m.locator(thread).evaluate((t) => {
			t.scrollTop = Math.max(0, t.scrollTop - 200);
			return t.scrollTop;
		});
		await m.waitForTimeout(500);
		await m.goto(`${WEB}/#/projects/${pid}/c/${cid}/tools/${ARQ}/~/git`);
		await sees(m, "Herramientas on the phone: only ‹ and the agent", ".tools-back");
		await sees(m, "Pendientes from Herramientas", "#inbox-btn");
		await m.goBack();
		await sees(m, "Back: the topic", "#ps-topic-title", { text: `Tema ${P}` });
		await m.waitForTimeout(800);
		const after = await m.locator(thread).evaluate((t) => t.scrollTop);
		await check(m, "…at the same place", Math.abs(after - top) <= 2, `${top} → ${after}`, thread);
		await m.goBack();
		await sees(m, "Back: the project's screen", ".rail-body");
	});
	const errs = errors.splice(0);
	await check(m, "phone: no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
} catch (err) {
	await fail(m, "phone run aborted", String(err?.message ?? err).split("\n")[0], "");
}

// ── Cleanup ─────────────────────────────────────────────────────────────────
stepName = "cleanup";
try {
	const after = (await json(page, "/api/acp/agents")).body.filter((a) => !a.name.startsWith(`${P}-`)).map((a) => [a.name, a.projectId]);
	await check(page, "agents outside this run kept their project", others === null || JSON.stringify(after) === JSON.stringify(others), JSON.stringify(after).slice(0, 160));
	// This run's leftovers in Pendientes: it interrupts a run on purpose and reviews it from
	// Pendientes, but a failed step leaves it (or an open question) there, and the owner
	// would see it forever under agents that no longer exist. Taken from the inbox itself.
	const mine = (name) => typeof name === "string" && name.startsWith(`${P}-`);
	const leftovers = async () => {
		const inbox = (await json(page, "/api/acp/inbox")).body;
		return {
			questions: (inbox?.action?.questions ?? []).filter((q) => mine(q.agent)),
			interrupted: (inbox?.action?.interrupted ?? []).filter((x) => mine(x.from_id) || mine(x.to_id)),
		};
	};
	if (process.env.KEEP !== "1") {
		// Before the sessions go: a question is cancelled while its runner can still hear it,
		// and that first, so its message finishes instead of being interrupted.
		const left = await leftovers();
		for (const q of left.questions) await json(page, `/api/acp/questions/${q.id}/answer`, { method: "POST", body: JSON.stringify({ action: "cancel" }) });
		for (const x of left.interrupted) await json(page, `/api/acp/messages/${x.id}/review`, { method: "POST" });
		const after = await leftovers();
		await check(
			page,
			"no interrupted run or open question of this test is left in the inbox",
			after.questions.length === 0 && after.interrupted.length === 0,
			`reviewed ${left.interrupted.map((x) => `#${x.id}`).join(" ") || "none"}, cancelled ${left.questions.map((q) => `#${q.id}`).join(" ") || "none"}; left ${after.interrupted.length + after.questions.length}`,
		);
		for (const sid of created) {
			const d = await json(page, `/api/sessions/${sid}?hard=true`, { method: "DELETE" });
			await check(page, `session ${sid.slice(0, 8)} removed`, d.status < 300, String(d.status));
		}
		if (pid) {
			const a = await json(page, `/api/projects/${pid}`, { method: "DELETE" });
			await check(page, "the run's project archived", a.status < 300, String(a.status));
		}
	} else {
		const left = await leftovers();
		console.log(`kept: inbox not reviewed (KEEP=1): ${left.interrupted.length} interrupted, ${left.questions.length} open questions of this run`);
	}
} catch (err) {
	await fail(page, "cleanup aborted", String(err?.message ?? err).split("\n")[0], "");
}
await browser.close();
console.log(failures ? `${failures} FAILED` : "ALL PASS");
process.exit(failures ? 1 : 0);
