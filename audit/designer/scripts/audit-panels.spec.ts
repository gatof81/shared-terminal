import { test } from "../e2e/fixtures.js";
import { PROJECT_IDS } from "../e2e/mockBackend.js";
const OUT = "/home/developer/audit/a2611/shots";
test("panels", async ({ app, page, backend }) => {
	await page.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = "#toast{display:none!important}"; document.head.append(s); }));
	backend.enableAcp(); const P = test.info().project.name;
	await app.login("alice", `#/projects/${PROJECT_IDS.hz}/chat`); await page.waitForTimeout(600);
	await page.locator(".acp-agents-group").click(); await page.waitForTimeout(300);
	await page.screenshot({ path: `${OUT}/panel-list-${P}.png` });
	await page.keyboard.press("Escape"); await page.waitForTimeout(200);
	await page.locator(".pv-menu-btn").click(); await page.waitForTimeout(200);
	await page.screenshot({ path: `${OUT}/panel-menu-${P}.png` });
	await page.getByRole("menuitem", { name: "Administrar agentes" }).click(); await page.waitForTimeout(300);
	await page.screenshot({ path: `${OUT}/panel-manage-${P}.png` });
});
