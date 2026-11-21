import { appendFileSync } from "node:fs";
import { expect, test } from "../e2e/fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS, SESSION_IDS } from "../e2e/mockBackend.js";
const TAG = process.env.TAG ?? "new";
const OUT = `/home/developer/audit/simp-a/boxes-${TAG}.jsonl`;
test.beforeEach(async ({ page, backend }) => {
	await page.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = "#toast{display:none!important} *{transition:none!important;animation:none!important}"; document.head.append(s); }));
	if (TAG === "old") backend.enableAcp();
});
const boxes = (page: import("@playwright/test").Page) => page.evaluate(() => {
	const vis = (e: Element) => { const h = e as HTMLElement; return h.getClientRects().length > 0 && getComputedStyle(h).visibility !== "hidden"; };
	const out: Record<string, unknown> = {};
	for (const s of ["header", "#terminal-toolbar", "#terminal-tabs", "#terminal-container", "#key-bar", "#sidebar", ".pv-header", ".acp-thread", ".acp-composer", "#project-view", "#chat-view", "#files-view", "#git-view"]) {
		const e = document.querySelector(s); if (!e || !vis(e)) continue; const b = e.getBoundingClientRect(); out[s] = [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)];
	}
	const ctl: unknown[] = [];
	for (const e of document.querySelectorAll("header button, #terminal-toolbar button, #terminal-tabs button, .pv-header button, #key-bar button")) {
		if (!vis(e)) continue; const b = e.getBoundingClientRect(); if (!b.width) continue;
		const cs = getComputedStyle(e);
		ctl.push([e.id || (e as HTMLElement).className.toString().slice(0, 30), (e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 20), Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height), cs.fontSize, cs.color, cs.backgroundColor, cs.borderTopColor, cs.borderRadius]);
	}
	out.controls = ctl;
	return out;
});
async function shot(page: import("@playwright/test").Page, name: string) {
	await page.waitForTimeout(500);
	appendFileSync(OUT, JSON.stringify({ p: test.info().project.name, v: name, ...(await boxes(page)) }) + "\n");
	await expect(page).toHaveScreenshot(`${name}.png`, { mask: [page.locator(".xterm-cursor-layer, time, .acp-time, .msg-time")] }).catch((e) => { appendFileSync(`/home/developer/audit/simp-a/fails-${TAG}.txt`, `${test.info().project.name} ${name} ${String(e.message).split("\n").filter((l: string) => /pixels|image/.test(l)).join(" ").replace(/\x1b\[[0-9;]*m/g, "")}\n`); if (TAG === "old") throw e; });
}
const views: Array<[string, string]> = [
	["terminal", `#/sessions/${SESSION_IDS.running}/terminal`],
	["stopped", `#/sessions/${SESSION_IDS.stopped}`],
	["files", `#/sessions/${SESSION_IDS.running}/files`],
	["git", `#/sessions/${SESSION_IDS.running}/git`],
	["agent", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`],
	["project", `#/projects/${PROJECT_IDS.hz}/chat`],
	["home", ""],
];
for (const [name, url] of views) {
	test(name, async ({ app, page, isMobile }) => {
		await app.login("alice", url || undefined);
		await shot(page, name);
		if (name === "terminal") {
			if (page.viewportSize()!.width <= 768) { await app.openSidebar(); await shot(page, "drawer"); await page.keyboard.press("Escape"); await page.locator("#sidebar-toggle").click().catch(() => {}); await page.waitForTimeout(300); }
			const um = page.locator("#user-menu-btn");
			if (await um.isVisible()) { await um.click(); await shot(page, "usermenu"); await page.keyboard.press("Escape"); }
			const sm = page.locator("#session-menu-btn");
			if (await sm.isVisible()) { await sm.click(); await shot(page, "sessionmenu"); await page.keyboard.press("Escape"); }
		}
		if (name === "project") {
			const g = page.locator(".acp-agents-group"); if (await g.isVisible()) { await g.click(); await shot(page, "project-list"); await page.keyboard.press("Escape"); }
			const m = page.locator(".pv-menu-btn"); if (await m.isVisible()) { await m.click(); await shot(page, "project-menu"); await page.keyboard.press("Escape"); }
		}
	});
}
test("new-session", async ({ app, page }) => {
	await app.login("alice", `#/sessions/${SESSION_IDS.running}/terminal`);
	if (page.viewportSize()!.width <= 768) await app.openSidebar();
	await page.locator("#new-session-btn").click();
	await shot(page, "new-session");
});
