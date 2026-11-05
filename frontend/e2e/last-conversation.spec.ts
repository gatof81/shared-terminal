import { expect, test } from "./fixtures.js";
import { SESSION_IDS } from "./mockBackend.js";

/**
 * The sidebar's "↳ last conversation" link: once a conversation was opened in
 * a project, one click from anywhere returns to it in Chat — named from what
 * Chat remembered (no request), following a rename.
 */
test.describe("sidebar: back to each project's last conversation", () => {
	test("appears after opening a conversation and returns to it from another view", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSidebar();
		const link = app.sessionRow("my-project").locator(".session-last-conv");
		await expect(link).toHaveCount(0);

		await app.openSession("my-project");
		await app.switchView("chat");
		await page.locator("#chat-list .chat-conv-row", { hasText: "Fix tests" }).click();
		await expect(page.locator("#chat-thread .chat-user")).toContainText("Fix the failing tests");

		await app.switchView("terminal");
		await app.openSidebar();
		await expect(link).toHaveText("↳ Fix tests");
		await link.click();
		await expect(page).toHaveURL(new RegExp(`#/sessions/${SESSION_IDS.running}/chat/conv-2$`));
		await expect(page.locator("#chat-thread .chat-user")).toContainText("Fix the failing tests");
	});

	test("follows a rename of that conversation", async ({ app, backend, page }) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("chat");
		await page.locator("#chat-list .chat-conv-row", { hasText: "Fix tests" }).click();
		backend.conversations.find((c) => c.cid === "conv-2")!.customTitle = "Tests verdes";
		await page.click("#chat-refresh-btn");
		await app.openSidebar();
		await expect(app.sessionRow("my-project").locator(".session-last-conv")).toHaveText(
			"↳ Tests verdes",
		);
	});
});
