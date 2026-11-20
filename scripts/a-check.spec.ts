import { mkdirSync } from "node:fs";
import { test, expect } from "../e2e/fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS } from "../e2e/mockBackend.js";
const OUT = "/home/developer/audit/a-check";
const shot = async (page: any, n: string) => { mkdirSync(OUT, { recursive: true }); await page.waitForTimeout(350); await page.screenshot({ path: `${OUT}/${test.info().project.name}-${n}.png` }); };
const col = (page: any, sels: string[]) => page.evaluate((ss: string[]) => ss.map((s) => { const e = document.querySelector(s) as HTMLElement | null; if (!e || !e.offsetParent) return `${s}: -`; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); const l = r.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth); const rr = r.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth); return `${s}: ${Math.round(l)}–${Math.round(rr)}`; }).join(" | "), sels);
test("nested panels", async ({ page, app, backend }) => {
	backend.enableAcp();
	await page.setViewportSize({ width: 1920, height: 1080 });
	await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`);
	await page.locator("#acp-chat .acp-settings-btn").click();
	console.log("SOLO", await col(page, ["#acp-chat .acp-chat-header", "#acp-chat .acp-settings", "#acp-chat .acp-chat-thread", "#acp-chat .acp-chat-composer"]));
	await shot(page, "solo-settings");
	await app.login("alice", `#/projects/${PROJECT_IDS.hz}/chat`);
	await page.locator(".acp-agents-group").click();
	console.log("LIST", await col(page, [".acp-project .pv-header", ".acp-project .acp-agents-list", ".acp-project .acp-chat-thread", ".acp-project .acp-chat-composer"]));
	await shot(page, "project-list");
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Acciones del proyecto" }).click();
	await page.locator('[role="menu"] [data-action="agents"]').click();
	console.log("PANEL", await col(page, [".acp-project .acp-agents-panel", ".acp-project .acp-chat-thread"]));
	await shot(page, "project-panel");
});
for (const w of [1280, 1920]) test(`states ${w}`, async ({ page, app, backend }) => {
	backend.enableAcp();
	await page.setViewportSize({ width: w, height: 900 });
	backend.projects.push({ projectId: "6b1f2c3d-0000-4000-8000-0000000000aa", ownerUserId: "u-alice", name: "Viejo", createdAt: "2026-10-01T00:00:00Z", archivedAt: "2026-10-20T00:00:00Z" });
	await app.login("alice", `#/projects/6b1f2c3d-0000-4000-8000-0000000000aa/chat`);
	await page.waitForTimeout(800); await shot(page, `archived-${w}`);
	await app.login("alice", `#/projects/6b1f2c3d-0000-4000-8000-0000000000ff/chat`);
	await page.waitForTimeout(800); await shot(page, `missing-${w}`);
	backend.projectFeedFailure = 500;
	await app.login("alice", `#/projects/${PROJECT_IDS.hz}/chat`);
	await page.waitForTimeout(800); await shot(page, `error-${w}`);
});
for (const w of [641, 700, 820, 900]) test(`mid ${w}`, async ({ page, app, backend }) => {
	backend.enableAcp();
	await page.setViewportSize({ width: w, height: 900 });
	for (const [k, h] of [["solo", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`], ["proj", `#/projects/${PROJECT_IDS.hz}/chat`]]) {
		await app.login("alice", h);
		await page.waitForTimeout(500);
		await shot(page, `${k}-${w}-sidebar`);
		console.log(test.info().project.name, w, k, "sidebar", await col(page, [".acp-chat-thread:not([hidden])", "#acp-chat .acp-chat-thread", ".acp-project .acp-chat-thread", ".acp-chat-composer"]));
		const t = page.locator("#sidebar-toggle"); if (await t.isVisible()) { await t.click(); await page.waitForTimeout(400); await shot(page, `${k}-${w}-nosidebar`); await t.click(); }
	}
});
