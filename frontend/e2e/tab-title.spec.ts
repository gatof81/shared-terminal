import { expect, test } from "./fixtures.js";

test.describe("tab title", () => {
	test("names the project and the view, never a conversation's title; logout restores the app title", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await expect(page).toHaveTitle("Shared Terminal");
		await app.openSession("my-project");
		await expect(page).toHaveTitle(/^my-project( · \w+)? — Shared Terminal$/);
		await app.switchView("chat");
		await expect(page).toHaveTitle("my-project · Chat — Shared Terminal");
		await page
			.locator("#chat-list .chat-conv-row", { hasText: "Refactor auth flow" })
			.first()
			.click();
		await expect(page.locator("#chat-thread .chat-user").first()).toBeVisible();
		// Content stays out of the title (browser history outlives a logout).
		expect(await page.title()).not.toContain("Refactor");
		await app.switchView("files");
		await expect(page).toHaveTitle("my-project · Files — Shared Terminal");
		await app.appMenu("logout-btn");
		await expect(page.locator("#auth-view")).toBeVisible();
		await expect(page).toHaveTitle("Shared Terminal");
	});
});
