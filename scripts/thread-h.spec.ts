import { appendFileSync } from "node:fs";
import { test, expect } from "../e2e/fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS } from "../e2e/mockBackend.js";
for (const [w, h] of [[320, 568], [390, 844], [390, 450]] as const) {
	test(`thread ${w}x${h}`, async ({ page, app, backend }) => {
		backend.enableAcp();
		await page.setViewportSize({ width: w, height: h });
		const out: Record<string, number> = {};
		for (const [k, hash, root] of [["agent", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`, "#acp-chat"], ["project", `#/projects/${PROJECT_IDS.hz}/chat`, ".acp-project"]] as const) {
			await app.login("alice", hash);
			const t = page.locator(`${root} .acp-chat-thread`);
			await expect(t.locator(".acp-msg").first()).toBeVisible();
			await page.waitForTimeout(300);
			out[k] = await t.evaluate((e) => Math.round(e.getBoundingClientRect().height * 10) / 10);
		}
		appendFileSync(process.env.OUT!, `${process.env.LABEL} ${test.info().project.name} ${w}x${h} agent=${out.agent} project=${out.project}\n`);
	});
}
