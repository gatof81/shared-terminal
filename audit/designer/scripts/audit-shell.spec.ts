import { appendFileSync } from "node:fs";
import { test } from "../e2e/fixtures.js";
import { SESSION_IDS, PROJECT_SESSION_IDS } from "../e2e/mockBackend.js";
const OUT = "/home/developer/audit/a2611/shots";
test("shell-terminal", async ({ app, page, backend, isMobile }) => { await page.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = "#toast{display:none!important}"; document.head.append(s); }));
	backend.enableAcp(); const P = test.info().project.name;
	await app.login("alice", `#/sessions/${SESSION_IDS.running}/terminal`); await page.waitForTimeout(900);
	await page.screenshot({ path: `${OUT}/terminal-${P}.png` });
	const m = await page.evaluate(() => { const b = (s: string) => { const e = document.querySelector(s) as HTMLElement | null; if (!e || !e.getClientRects().length || getComputedStyle(e).visibility === "hidden") return null; const r = e.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; }; return { header: b("header"), bar: b("#terminal-toolbar"), tabs: b("#terminal-tabs"), term: b("#terminal-container"), keybar: b("#key-bar"), nav: b("#view-nav"), chrome: b("#chrome-toggle") }; });
	appendFileSync(`${OUT}/terminal.jsonl`, JSON.stringify({ p: P, ...m }) + "\n");
	await app.openSidebar().catch(() => {}); await page.waitForTimeout(400);
	await page.screenshot({ path: `${OUT}/sidebar-${P}.png` });
	if (isMobile) { await page.keyboard.press("Escape"); }
});
