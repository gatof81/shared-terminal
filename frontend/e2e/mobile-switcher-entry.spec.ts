import { expect, test } from "./fixtures.js";

test.describe("switcher from the Chat list", () => {
	test("on a phone the Chat list opens the switcher in one tap; on a desktop the header button is the way in", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("chat");
		const entry = page.locator("#chat-list .chat-switcher-entry");
		if (!app.mobile) {
			await expect(entry).toHaveCount(0);
			return;
		}
		await expect(entry).toBeVisible();
		await entry.click();
		await expect(page.locator(".switcher-card")).toBeVisible();
		await expect(page.locator("#switcher-input")).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(page.locator(".switcher-card")).toHaveCount(0);
	});
});
