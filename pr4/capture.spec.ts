import { mkdirSync } from "node:fs";
import { expect, test } from "../e2e/fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS } from "../e2e/mockBackend.js";
const OUT = process.env.CAP_OUT!;
async function shot(page: any, name: string) {
	mkdirSync(OUT, { recursive: true });
	await page.addStyleTag({ content: "#toast{display:none!important}" }).catch(() => {});
	await page.waitForTimeout(450);
	await page.screenshot({ path: `${OUT}/${name}-${test.info().project.name}.png` });
}
function rich(backend: any) {
	backend.enableAcp();
	const FRESH = "2026-10-31T10:29:58Z";
	for (const a of backend.acpAgents) a.runnerSeenAt = FRESH;
	const [arq, dev, solo] = backend.acpAgents;
	arq.waitingInput = true; dev.running = 3; solo.runnerSeenAt = "2026-10-31T09:00:00Z";
}
test("sidebar tree", async ({ page, app, backend }) => {
	rich(backend);
	await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`);
	await expect(page.locator("#acp-chat")).toBeVisible();
	if (app.mobile) await app.openSidebar();
	await page.waitForTimeout(600);
	await shot(page, "pr4-sidebar-agent-selected");
});
test("sidebar tree, folded project, project page", async ({ page, app, backend }) => {
	rich(backend);
	await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
	if (app.mobile) await app.openSidebar();
	const head = page.locator(`.sgroup[data-group="${PROJECT_IDS.hz}"] .sgroup-toggle`);
	await head.click();
	await page.waitForTimeout(400);
	await shot(page, "pr4-sidebar-folded");
});
