import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { test, expect } from "../e2e/fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS, SESSION_IDS } from "../e2e/mockBackend.js";

const OUT = process.env.SHOTS ?? "/home/developer/audit/before";
const settle = (page: any) => page.waitForTimeout(500);

async function shot(page: any, name: string) {
	const dir = `${OUT}/${test.info().project.name}`;
	mkdirSync(dir, { recursive: true });
	await settle(page);
	await page.screenshot({ path: `${dir}/${name}.png` });
}

// Box metrics: how much of the viewport the main content gets.
async function metrics(page: any, name: string, sel: string) {
	const m = await page.evaluate((s: string) => {
		const r = (q: string) => { const e = document.querySelector(q) as HTMLElement | null; if (!e || !e.offsetParent && getComputedStyle(e).position !== "fixed") return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
		return { vw: innerWidth, vh: innerHeight, content: r(s), header: r("header"), sidebar: r("#sidebar"), toolbar: r("#terminal-toolbar") };
	}, sel);
	mkdirSync(OUT, { recursive: true });
	appendFileSync(`${OUT}/metrics.jsonl`, JSON.stringify({ project: test.info().project.name, name, sel, ...m }) + "\n");
}

test.describe("audit", () => {
	test("01 home (acp)", async ({ page, app, backend }) => {
		backend.enableAcp();
		await app.login("alice");
		await shot(page, "01-home");
		if (app.mobile) { await app.openSidebar(); await shot(page, "01b-sidebar-open"); }
	});
	test("02 project chat", async ({ page, app, backend }) => {
		backend.enableAcp();
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}/chat`);
		await settle(page);
		await shot(page, "02-project-chat");
		await metrics(page, "project-chat", "#project-view .acp-thread, #project-view");
		const box = page.locator("#project-view textarea").first();
		if (await box.count()) { await box.click(); await box.fill("@"); await shot(page, "02b-project-chat-mention"); }
	});
	test("03 acp chat", async ({ page, app, backend }) => {
		backend.enableAcp();
		await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`);
		await expect(page.locator("#acp-chat")).toBeVisible();
		await shot(page, "03-acp-chat");
		await metrics(page, "acp-chat", "#acp-chat .acp-thread-list, #acp-chat");
		const s = page.locator("#acp-chat .acp-settings-btn");
		if (await s.count()) { await s.click(); await shot(page, "03b-acp-settings"); await page.keyboard.press("Escape"); }
		await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.architect}/chat`);
		await shot(page, "03c-acp-chat-arq");
	});
	test("04 terminal/files/git/chat", async ({ page, app, backend }) => {
		backend.enableAcp();
		await app.login("alice", `#/sessions/${SESSION_IDS.running}`);
		await app.expectTerminalReady().catch(() => {});
		await shot(page, "04-terminal");
		await metrics(page, "terminal", "#terminal-container");
		if (app.mobile && app.shell === "v1") { await app.openChrome(); await shot(page, "04b-terminal-chrome"); await page.click("#chrome-toggle"); }
		for (const v of ["files", "git", "chat"] as const) {
			try { await app.switchView(v); await shot(page, `05-${v}`); await metrics(page, v, `#${v}-view`); } catch (e) { console.log(test.info().project.name, v, String(e).slice(0, 200)); }
		}
		await page.goto(`/#/sessions/${SESSION_IDS.running}/files/README.md`); await settle(page); await shot(page, "05b-files-readme");
		await page.goto(`/#/sessions/${SESSION_IDS.running}/git`); await settle(page);
		const f = page.locator("#git-list button, #git-list [role=button], #git-list li").first();
		if (await f.count()) { await f.click(); await shot(page, "05c-git-diff"); }
	});
	test("06 new session", async ({ page, app, backend }) => {
		backend.enableAcp();
		await app.login("alice");
		await app.openSidebar();
		await page.click("#new-session-btn");
		await expect(page.locator("#new-session-modal")).toBeVisible();
		await shot(page, "06-new-session");
		for (const t of ["repo", "env", "ports", "advanced"]) { await page.click(`#session-tab-${t}-tab`); await shot(page, `06-new-session-${t}`); }
	});
	test("07 new project + menus", async ({ page, app, backend }) => {
		backend.enableAcp();
		await app.login("alice");
		await app.openSidebar();
		const np = page.locator("#new-project-btn");
		if (await np.isVisible()) { await np.click(); await shot(page, "07-new-project"); await page.keyboard.press("Escape"); }
		if (app.shell === "v2") { await page.click("#user-menu-btn"); await shot(page, "07b-user-menu"); await page.keyboard.press("Escape"); }
		await app.login("alice", `#/sessions/${SESSION_IDS.running}`);
		const sm = page.locator("#session-menu-btn");
		if (await sm.isVisible()) { await sm.click(); await shot(page, "07c-session-menu"); await page.keyboard.press("Escape"); }
		const ab = page.locator("#actions-btn");
		if (await ab.isVisible()) { await ab.click(); await shot(page, "07d-actions-menu"); await page.keyboard.press("Escape"); }
	});
	test("08 templates/admin", async ({ page, app, backend }) => {
		await app.login("admin");
		await shot(page, "08-home-admin-noacp");
		try { await app.appMenu("admin-btn"); await shot(page, "08b-admin"); } catch (e) { console.log("admin", String(e).slice(0, 200)); }
		await page.keyboard.press("Escape");
		await app.login("alice");
		try { await app.appMenu("templates-btn"); await shot(page, "08c-templates"); } catch (e) { console.log("tpl", String(e).slice(0, 200)); }
	});
	test("09 stopped/terminated + auth", async ({ page, app, backend }) => {
		await app.login("alice", `#/sessions/${SESSION_IDS.stopped}`);
		await shot(page, "09-stopped");
		await page.goto(`/#/sessions/${SESSION_IDS.stopped}/git`); await settle(page); await shot(page, "09b-stopped-git");
		await page.goto(`/#/sessions/${SESSION_IDS.running}/terminal`); await settle(page);
		backend.dropTerminalSockets(SESSION_IDS.running); await page.waitForTimeout(800); await shot(page, "09c-terminal-dropped");
		backend.current = null;
		await page.goto("/"); await settle(page); await shot(page, "09d-login");
	});
	test("10 project page (no acp agents?) + archived", async ({ page, app, backend }) => {
		backend.enableAcp();
		backend.projectFeedFailure = 500;
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}/chat`);
		await shot(page, "10-project-feed-error");
	});
});
