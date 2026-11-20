import { test } from "../e2e/fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS } from "../e2e/mockBackend.js";
test("measure", async ({ page, app, backend }) => {
	backend.enableAcp();
	const h = (sels: string[]) => page.evaluate((ss) => ss.map((s) => { const e = document.querySelector(s) as HTMLElement | null; if (!e) return `${s}: -`; const r = e.getBoundingClientRect(); return `${s}: ${Math.round(r.width)}x${Math.round(r.height)}`; }), sels);
	await app.login("alice", `#/projects/${PROJECT_IDS.hz}/chat`); await page.waitForTimeout(600);
	console.log(test.info().project.name, (await h(["#templates-btn", "#logout-btn", "#user-menu-btn", "#new-project-btn", "#new-session-btn", "#project-view button[aria-haspopup]", "#project-view .acp-composer button", "#sidebar-refresh-btn"])).join(" | "));
	await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`); await page.waitForTimeout(600);
	console.log(test.info().project.name, (await h(["#acp-chat .acp-settings-btn", "#session-menu-btn", "#view-chat-btn"])).join(" | "));
});
