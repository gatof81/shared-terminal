import { appendFileSync } from "node:fs";
import { expect, test } from "../e2e/fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS } from "../e2e/mockBackend.js";
const OUT = "/home/developer/audit/a2611/shots";
test.beforeEach(async ({ page, backend }) => { await page.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = "#toast{display:none!important}"; document.head.append(s); })); backend.enableAcp(); for (let i = 1; i <= 6; i++) backend.addAcpMessage({ to_id: "arq", body: `@arq tema ${i}`, state: "done", result_text: `Tema ${i} resuelto.`, project_id: PROJECT_IDS.hz }); });
const boxes = (page: import("@playwright/test").Page) => page.evaluate(() => {
	const vis = (e: Element) => { const h = e as HTMLElement; const cs = getComputedStyle(h); return h.getClientRects().length > 0 && cs.visibility !== "hidden"; };
	const out: Record<string, unknown>[] = [];
	for (const e of document.querySelectorAll("header button, header a, #terminal-toolbar button, #terminal-toolbar a, .pv-header button, .pv-header a, .acp-chat-header button, .acp-chat-header a, #view-nav button, #sidebar-toggle, #chrome-toggle")) {
		if (!vis(e)) continue; const b = e.getBoundingClientRect(); if (b.width === 0) continue;
		out.push({ zone: e.closest(".pv-header") ? "pv" : e.closest("#terminal-toolbar") ? "bar" : e.closest("header") ? "header" : e.closest("#view-nav") ? "nav" : "other", id: e.id || null, cls: (e as HTMLElement).className.toString().slice(0, 40), label: e.getAttribute("aria-label") || e.textContent?.trim().slice(0, 24), x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) });
	}
	return out;
});
for (const [name, url] of [["project", `#/projects/${PROJECT_IDS.hz}/chat`], ["agent", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`], ["home", ""]] as const) {
	test(`nav-${name}`, async ({ app, page }) => {
		const P = test.info().project.name;
		await app.login("alice", url || undefined); await page.waitForTimeout(700);
		await page.screenshot({ path: `${OUT}/${name}-${P}.png` });
		appendFileSync(`${OUT}/controls.jsonl`, JSON.stringify({ p: P, view: name, controls: await boxes(page) }) + "\n");
		if (name === "project") {
			// how to leave: × → where? ; then Back
			const before = page.url();
			const x = page.locator(".pv-header .pv-close");
			const xVis = await x.isVisible();
			if (xVis) { await x.click(); await page.waitForTimeout(500); }
			const afterX = page.url(); await page.screenshot({ path: `${OUT}/project-afterX-${P}.png` });
			await page.goBack(); await page.waitForTimeout(500);
			appendFileSync(`${OUT}/leave.jsonl`, JSON.stringify({ p: P, xVis, before: before.split("#")[1], afterX: afterX.split("#")[1], afterBack: page.url().split("#")[1], projectShownAfterBack: await page.locator("#project-view").isVisible() }) + "\n");
		}
	});
}
