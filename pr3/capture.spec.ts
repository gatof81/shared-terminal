import { mkdirSync } from "node:fs";
import { expect, test } from "../e2e/fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS } from "../e2e/mockBackend.js";
const OUT = process.env.CAP_OUT!;
async function shot(page: any, name: string, clip?: string) {
	mkdirSync(OUT, { recursive: true });
	await page.addStyleTag({ content: "#toast{display:none!important}" }).catch(() => {});
	await page.waitForTimeout(400);
	const opts: any = { path: `${OUT}/${name}-${test.info().project.name}.png` };
	if (clip) { const b = await page.locator(clip).first().boundingBox(); if (b) opts.clip = { x: 0, y: Math.max(0, b.y - 4), width: page.viewportSize().width, height: b.height + 8 }; }
	await page.screenshot(opts);
}
test("session bar state", async ({ page, app }) => {
	await app.login("alice");
	await app.openSession("my-project");
	await expect(page.locator("#terminal-status-badge")).toHaveText("running");
	await shot(page, "pr3-bar-running", "#terminal-toolbar");
	await app.openSession("docs");
	await expect(page.locator("#terminal-status-badge")).toHaveText("stopped");
	await shot(page, "pr3-bar-stopped", "#terminal-toolbar");
});
test("acp chat buttons", async ({ page, app, backend }) => {
	backend.enableAcp();
	const solo = backend.acpAgents.find((a: any) => a.name === "solo")!;
	solo.authRequired = true;
	await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`);
	await expect(page.locator("#acp-chat .acp-settings-btn")).toBeVisible();
	await page.locator("#acp-chat .acp-settings-btn").click();
	await shot(page, "pr3-acp-settings");
});
test("project manage panel", async ({ page, app, backend }) => {
	backend.enableAcp();
	await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
	await expect(page.locator("#project-view .acp-chat-thread")).toBeVisible();
	const more = page.locator("#project-view .pv-menu-btn");
	await more.click();
	const item = page.getByRole("menuitem", { name: /Administrar agentes/ });
	if (await item.count()) await item.click();
	await page.waitForTimeout(300);
	await shot(page, "pr3-project-manage");
});
