import { test, expect } from "../e2e/fixtures.js";
import { PROJECT_IDS } from "../e2e/mockBackend.js";
const OUT = process.env.SHOTS ?? "/home/developer/audit/b";
test("stale + error", async ({ page, app, backend }) => {
	backend.enableAcp();
	backend.projectFeedFailure = 500;
	await app.login("alice", `#/projects/${PROJECT_IDS.hz}/chat`);
	await expect(page.locator(".pv-status-error")).toBeVisible();
	await page.waitForTimeout(400);
	await page.screenshot({ path: `${OUT}/${test.info().project.name}-error.png` });
	backend.projectFeedFailure = 0;
	await page.locator(".pv-status-error button").click();
	await expect(page.locator(".acp-project .acp-chat-input")).toBeEnabled();
	backend.projectFeedFailure = 503;
	backend.dropAcpSockets();
	await expect(page.locator(".pv-status-error")).toContainText("No se pudo actualizar");
	await page.waitForTimeout(400);
	await page.screenshot({ path: `${OUT}/${test.info().project.name}-stale.png` });
});
