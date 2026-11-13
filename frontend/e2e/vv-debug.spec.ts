// The opt-in keyboard diagnostic (vvDebug.ts) — the iPhone data for #616 comes from it.
import { expect, test } from "./fixtures.js";
import { PROJECT_IDS, PROJECT_MSG_IDS } from "./mockBackend.js";
test("vvdebug (#616): off by default, on with ?vvdebug=1, records the focus; ?vvdebug=0 turns it off", async ({ app, backend, page }) => {
	await backend.enableProjectConversation();
	await app.login("alice", `#/projects/${PROJECT_IDS.hz}/threads/${PROJECT_MSG_IDS.polling}`);
	await expect(page.locator("#vv-debug")).toHaveCount(0);
	await page.goto(`/?vvdebug=1#/projects/${PROJECT_IDS.hz}/threads/${PROJECT_MSG_IDS.polling}`);
	await expect(page.locator("#vv-debug")).toBeVisible();
	await page.locator("#project-view .tw-composer textarea").filter({ visible: true }).click();
	// The event name, not the always-present "focusBox=" label.
	await expect(page.locator("#vv-debug")).toContainText(/^focus(in|\+\d+) /m);
	await page.goto(`/?vvdebug=0#/projects/${PROJECT_IDS.hz}`);
	await expect(page.locator("#vv-debug")).toHaveCount(0);
});
