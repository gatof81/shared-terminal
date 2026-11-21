import { appendFileSync } from "node:fs";
import { test } from "../e2e/fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS } from "../e2e/mockBackend.js";
const OUT = "/home/developer/audit/a2611/shots";
test("x-from-session", async ({ app, page, backend }) => {
	backend.enableAcp(); const P = test.info().project.name;
	await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`); await page.waitForTimeout(600);
	if (test.info().project.name.startsWith("14")) { await page.locator(".sidebar-tree").getByText("Educación HZ").first().click(); } else { await app.openSidebar(); await page.locator(".sidebar-tree").getByText("Educación HZ").first().click(); } await page.waitForTimeout(600); const hashOnProject = await page.evaluate(() => location.hash);
	const onProject = await page.locator("#project-view").isVisible();
	await page.locator(".pv-header .pv-close").click(); await page.waitForTimeout(500);
	await page.screenshot({ path: `${OUT}/x-from-session-${P}.png` });
	const view = await page.evaluate(() => ({ hash: location.hash, chat: !!document.querySelector("#acp-chat:not([hidden])")?.getClientRects().length }));
	await page.reload(); await page.waitForTimeout(900); const afterReload = await page.evaluate(() => ({ hash: location.hash, chat: !!document.querySelector("#acp-chat:not([hidden])")?.getClientRects().length, empty: document.body.innerText.includes("Select or create a session") })); await page.screenshot({ path: `${OUT}/x-reload-${P}.png` });
	appendFileSync(`${OUT}/x2.jsonl`, JSON.stringify({ p: P, hashOnProject, onProject, afterX: view, afterReload }) + "\n");
});
