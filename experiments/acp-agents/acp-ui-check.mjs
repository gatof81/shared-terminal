// Browser acceptance of ACP agents + Project Chat in the real web UI, desktop
// and mobile. Creates two agent sessions THROUGH THE UI (new-session form: agent
// name, "+ Proyecto nuevo…", runtime st-test-agent), uses Project Chat with
// mentions, the individual chat, Terminal, Files and Git, then removes the
// sessions it created (KEEP=1 keeps them).
//
// Run from frontend/ (for @playwright/test):
//   lab:  WEB=http://localhost:5174 API=http://localhost:3101 node ../experiments/acp-agents/acp-ui-check.mjs <shots>
//   prod: WEB=https://… API=https://… API_HOST=… node …/acp-ui-check.mjs <shots> < token   (short-lived owner token)
import { readFileSync } from "node:fs";
import { chromium, devices } from "@playwright/test";

const shots = process.argv[2] ?? ".";
const WEB = process.env.WEB ?? "http://localhost:5174";
const API = process.env.API ?? "http://localhost:3101";
const API_HOST = process.env.API_HOST;
const token = API_HOST ? readFileSync(0, "utf8").trim() : null;
const P = process.env.PREFIX ?? `u${Math.random().toString(16).slice(2, 6)}`;
const ARQ = `${P}-arq`;
const DEV = `${P}-dev`;
let failures = 0;
const check = (name, ok, ev) => {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${ev ? ` — ${ev}` : ""}`);
	return ok;
};

const browser = await chromium.launch();
async function context(opts) {
	// bypassCSP: the app's CSP forbids the eval Playwright's waitForFunction uses.
	const ctx = await browser.newContext({ ...opts, bypassCSP: true });
	if (token)
		await ctx.addCookies([
			{ name: "st_token", value: token, domain: API_HOST, path: "/", secure: true, httpOnly: true, sameSite: "None" },
		]);
	return ctx;
}
async function login(page) {
	await page.goto(`${WEB}/`);
	if (!token) {
		await page.fill("#auth-username", "labowner");
		await page.fill("#auth-password", "lab-password-1234");
		await page.press("#auth-password", "Enter");
	}
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

const ctx = await context({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
const created = [];
try {
	await login(page);
	// Agents that are not this run's: their project must not move (a regression once moved one).
	var others = (await json(page, "/api/acp/agents")).body.filter((a) => !a.name.startsWith(`${P}-`)).map((a) => [a.name, a.projectId]);

	// ── 1. Two agent sessions created from the new-session form, the first in a NEW project.
	async function createAgent(agent, projectChoice) {
		await page.click("#new-session-btn");
		await page.fill("#new-session-input", `acp ${agent}`);
		await page.fill("#new-session-acp-agent", agent);
		await page.waitForFunction(() => document.querySelector("#new-session-acp-project")?.options.length > 1, null, { timeout: 10_000 });
		if (projectChoice.new) {
			await page.selectOption("#new-session-acp-project", "__new__");
			await page.fill("#new-session-acp-new-project", projectChoice.new);
		} else await page.selectOption("#new-session-acp-project", projectChoice.id);
		await page.selectOption("#new-session-acp-runtime", "st-test-agent");
		await page.click("#new-session-submit");
		// The address may already name the previous session: wait for the agent itself.
		let a = null;
		for (let i = 0; i < 60 && !a; i++) {
			await page.waitForTimeout(1_000);
			a = (await json(page, "/api/acp/agents")).body.find((x) => x.name === agent) ?? null;
		}
		await page.waitForFunction((sid) => location.hash.includes(sid), a?.sessionId ?? "", { timeout: 30_000 }).catch(() => {});
		check(`UI: session with @${agent} created`, !!a, a && `${a.runtime} project ${a.projectId}`);
		if (a) created.push(a.sessionId);
		return a;
	}
	const arq = await createAgent(ARQ, { new: `Proyecto UI ${P}` });
	const pid = arq?.projectId;
	var runProject = pid; // archived at the end (var: read outside this block)
	check("UI: '+ Proyecto nuevo…' created the project and put the agent in it", !!pid);
	const dev = await createAgent(DEV, { id: pid });
	check("UI: second agent joined the existing project", dev?.projectId === pid);
	await page.screenshot({ path: `${shots}/ui-1-created.png` });
	const side = await page.locator(`.sgroup-project:has-text("Proyecto UI ${P}")`).textContent().catch(() => "");
	check("sidebar: both agent sessions listed under their project", side.includes(`acp ${ARQ}`) && side.includes(`acp ${DEV}`), side.replace(/\s+/g, " ").slice(0, 120));

	// ── 2. Project Chat with mentions.
	await page.goto(`${WEB}/#/projects/${pid}`);
	await page.waitForSelector(".acp-project .acp-agent-chip", { timeout: 20_000 });
	const chips = await page.locator(".acp-agent-chip .acp-agent-name").allTextContents();
	check("Project Chat is the project's page and lists both agents", chips.sort().join(",") === [`@${ARQ}`, `@${DEV}`].sort().join(","), chips.join(" "));
	await page.waitForFunction(() => [...document.querySelectorAll(".acp-agent-chip .acp-status")].every((s) => /libre/.test(s.textContent)), null, { timeout: 45_000 }).catch(() => {});
	check("both runners online", (await page.locator(".acp-agent-chip .acp-status").allTextContents()).every((s) => /libre/.test(s)));
	const input = page.locator(".acp-project .acp-chat-input");
	const send = page.locator(".acp-project .acp-chat-send");
	await page.click(`.acp-mention:has-text("@${ARQ}")`);
	await input.type(`consultá a @${DEV}: ¿listo para revisar?`);
	// The mention inside the text is part of the instruction: only @arq receives it.
	await send.click();
	await page.waitForFunction(() => /Recibí la respuesta de @/.test(document.querySelector(".acp-project .acp-chat-thread")?.textContent ?? ""), null, { timeout: 60_000 }).catch(() => {});
	const text = await page.locator(".acp-project .acp-chat-thread").textContent();
	check("agent consulted the other (st send) and the consult is visible in Project Chat", text.includes(`@${ARQ} consulta a @${DEV}`));
	check("a mention inside the text did not make @dev a recipient", !text.includes("error: st: 400"));
	check("the answer came back to the first agent, shown in Project Chat", /recibe la respuesta de @/.test(text) && /Recibí la respuesta de @/.test(text));
	await page.screenshot({ path: `${shots}/ui-2-project-chat.png` });

	// ── 3. Sending while busy, several recipients in one post.
	await input.fill(`@${DEV} esperá 10`);
	await send.click();
	await page.waitForTimeout(1_500);
	await input.fill(`@${ARQ} @${DEV} los dos: ¿siguen ahí?\n\`\`\`\nlínea 1\n  línea 2\n\`\`\``);
	await send.click();
	await page.waitForTimeout(800);
	check("input free right after sending while an agent works", (await input.isEnabled()) && (await input.inputValue()) === "");
	const post = page.locator(".acp-project article.acp-msg", { hasText: "los dos: ¿siguen ahí?" });
	await page.waitForFunction(() => [...document.querySelectorAll(".acp-project article.acp-msg")].some((a) => /los dos: ¿siguen ahí\?/.test(a.textContent) && a.querySelectorAll(".acp-sub").length === 2), null, { timeout: 30_000 }).catch(() => {});
	check("a post to two agents is one bubble with one row per agent", (await post.locator(".acp-sub").count()) === 2);
	const badges = await post.locator(".acp-sub .acp-badge").allTextContents();
	check("…the busy agent's copy waits (pending) while the other proceeds", badges.includes("pendiente") || badges.includes("en curso"), badges.join(","));
	await page.screenshot({ path: `${shots}/ui-3-busy.png` });
	await page.waitForFunction(() => [...document.querySelectorAll(".acp-project .acp-badge")].every((b) => b.textContent === "hecho"), null, { timeout: 60_000 }).catch(() => {});
	const allBadges = await page.locator(".acp-project .acp-badge").allTextContents();
	check("everything in Project Chat done", allBadges.every((b) => b === "hecho"), allBadges.join(","));
	const codeShown = await post.locator(".acp-msg-body").textContent();
	check("multi-line code kept as typed", codeShown.includes("```\nlínea 1\n  línea 2\n```"));

	// ── 3b. A question from an agent, answered from Project Chat.
	await input.fill(`@${ARQ} preguntá: ¿Qué framework de tests? | vitest | jest`);
	await send.click();
	const card = page.locator(".acp-project .acp-question-open");
	await card.waitFor({ timeout: 60_000 }).catch(() => {});
	check("the agent's question appears in Project Chat with its options", (await card.locator(".acp-option").count()) === 2);
	check("…its message says it waits for me", (await page.locator(".acp-project .acp-badge-waiting").count()) >= 1);
	await page.screenshot({ path: `${shots}/ui-3b-question.png` });
	await card.locator(".acp-option", { hasText: "vitest" }).click();
	await card.locator(".acp-question-send").click();
	await page.waitForFunction(() => /Elegiste: vitest/.test(document.querySelector(".acp-project .acp-chat-thread")?.textContent ?? ""), null, { timeout: 60_000 }).catch(() => {});
	check("answered from Chat; the agent continued with the answer", /Elegiste: vitest/.test(await page.locator(".acp-project .acp-chat-thread").textContent()));
	check("…the question shows my answer, no input left", (await page.locator(".acp-project .acp-question-delivered").count()) >= 1 && (await page.locator(".acp-project .acp-question-open").count()) === 0);

	// ── 4. Individual chat: direct and private.
	await page.click(`.acp-agent-chip a:has-text("@${DEV}")`);
	await page.waitForSelector("#acp-chat:not([hidden]) .acp-chat-header strong", { timeout: 20_000 });
	check("chip opens the agent's individual chat", (await page.textContent("#acp-chat .acp-chat-header strong")) === `@${DEV}`);
	const own = page.locator("#acp-chat .acp-chat-input");
	await own.fill("mensaje directo desde la web");
	await page.click("#acp-chat .acp-chat-send");
	await page.waitForFunction(() => [...document.querySelectorAll("#acp-chat article.acp-msg")].some((a) => /mensaje directo desde la web/.test(a.textContent) && a.querySelector(".acp-badge")?.textContent === "hecho"), null, { timeout: 30_000 }).catch(() => {});
	const ownText = await page.locator("#acp-chat .acp-chat-thread").textContent();
	check("direct message answered in the individual chat", /Recibido por @.*mensaje directo desde la web/.test(ownText));
	check("individual chat also shows the agent's Project Chat work, tagged", ownText.includes("· en el proyecto") && ownText.includes("· directo"));
	await page.screenshot({ path: `${shots}/ui-4-individual.png` });
	const pf = (await json(page, `/api/acp/projects/${pid}/feed`)).body;
	check("the direct message is not in Project Chat", !pf.messages.some((m) => m.body === "mensaje directo desde la web"));

	// ── 5. Terminal, Files, Git of the same session, then Chat again.
	for (const view of ["terminal", "files", "git"]) {
		await page.click(`#view-${view}-btn`);
		await page.waitForTimeout(2_500);
		// A new session has no tmux tab yet: open one like a person would.
		if (view === "terminal") {
			const open = page.locator("button:has-text('Open a tab')");
			if (await open.isVisible().catch(() => false)) await open.click();
			await page.waitForTimeout(2_500);
		}
		const sel = view === "terminal" ? "#terminal-container .xterm" : `#${view}-view:not([hidden])`;
		check(`${view} view opens on the agent session`, await page.locator(sel).first().isVisible().catch(() => false));
		await page.screenshot({ path: `${shots}/ui-5-${view}.png` });
	}
	await page.click("#view-chat-btn");
	await page.waitForTimeout(1_000);
	check("back to Chat: still the agent chat", await page.locator("#acp-chat:not([hidden]) .acp-chat-input").isVisible());
} catch (err) {
	check(`desktop run aborted: ${err.message}`, false);
	await page.screenshot({ path: `${shots}/ui-error.png` }).catch(() => {});
}

// ── 6. Mobile.
const mctx = await context({ ...devices["iPhone 13"], defaultBrowserType: undefined });
const m = await mctx.newPage();
try {
	await login(m);
	const pid = (await json(m, "/api/acp/agents")).body.find((a) => a.name === ARQ)?.projectId;
	await m.goto(`${WEB}/#/projects/${pid}`);
	await m.waitForSelector(".acp-project .acp-agent-chip", { timeout: 20_000 });
	const mi = m.locator(".acp-project .acp-chat-input");
	await mi.fill(`@${ARQ} hola desde el móvil`);
	await m.locator(".acp-project .acp-chat-send").click();
	await m.waitForFunction(() => [...document.querySelectorAll(".acp-project article.acp-msg")].some((a) => /hola desde el móvil/.test(a.textContent) && a.querySelector(".acp-badge")?.textContent === "hecho"), null, { timeout: 30_000 }).catch(() => {});
	check("mobile: Project Chat send and answer", /Recibido por @.*hola desde el móvil/.test(await m.locator(".acp-project .acp-chat-thread").textContent()));
	const overflow = await m.evaluate(() => {
		const v = document.querySelector("#project-view");
		return { page: document.documentElement.scrollWidth - innerWidth, view: v ? v.scrollWidth - v.clientWidth : 0 };
	});
	check("mobile: no horizontal overflow", overflow.page <= 1 && overflow.view <= 1, JSON.stringify(overflow));
	const box = await mi.boundingBox();
	check("mobile: composer on screen", !!box && box.y + box.height <= 844 && box.y > 0, JSON.stringify(box));
	await m.screenshot({ path: `${shots}/ui-6-mobile-project.png` });
	const sid = (await json(m, "/api/acp/agents")).body.find((a) => a.name === DEV)?.sessionId;
	await m.goto(`${WEB}/#/sessions/${sid}/chat`);
	await m.waitForSelector("#acp-chat:not([hidden]) .acp-chat-input", { timeout: 20_000 });
	check("mobile: individual chat opens", true);
	await m.screenshot({ path: `${shots}/ui-7-mobile-chat.png` });
	await m.goto(`${WEB}/#/sessions/${sid}/terminal`);
	await m.waitForTimeout(3_000);
	const mopen = m.locator("button:has-text('Open a tab')");
	if (await mopen.isVisible().catch(() => false)) await mopen.click();
	await m.waitForTimeout(2_500);
	check("mobile: terminal opens", await m.locator("#terminal-container .xterm").first().isVisible().catch(() => false));
	await m.screenshot({ path: `${shots}/ui-8-mobile-terminal.png` });
} catch (err) {
	check(`mobile run aborted: ${err.message}`, false);
	await m.screenshot({ path: `${shots}/ui-mobile-error.png` }).catch(() => {});
}

{
	const after = (await json(page, "/api/acp/agents")).body.filter((a) => !a.name.startsWith(`${P}-`)).map((a) => [a.name, a.projectId]);
	check("agents outside this run kept their project", JSON.stringify(after) === JSON.stringify(typeof others === "undefined" ? after : others), JSON.stringify(after));
}
if (process.env.KEEP !== "1")
	for (const sid of created) {
		const d = await json(page, `/api/sessions/${sid}?hard=true`, { method: "DELETE" });
		check(`cleanup: session ${sid.slice(0, 8)} removed`, d.status < 300, String(d.status));
	}
// The run's project: archived, or every run leaves one more "Proyecto UI …" in the sidebar.
if (process.env.KEEP !== "1" && typeof runProject !== "undefined" && runProject) {
	const a = await json(page, `/api/projects/${runProject}`, { method: "DELETE" });
	check("cleanup: test project archived", a.status < 300, String(a.status));
}
await browser.close();
console.log(failures ? `${failures} FAILED` : "ALL PASS");
process.exit(failures ? 1 : 0);
