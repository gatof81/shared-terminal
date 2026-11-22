import { expect, test } from "./fixtures.js";

test.describe("tab title", () => {
	test("names the project and the view; logout restores the app title", async ({ app, page }) => {
		await app.login("alice");
		await expect(page).toHaveTitle("Shared Terminal");
		await app.openSession("my-project");
		await expect(page).toHaveTitle(/^my-project( · \w+)? — Shared Terminal$/);
		await app.switchView("git");
		await expect(page).toHaveTitle("my-project · Git — Shared Terminal");
		await app.switchView("files");
		await expect(page).toHaveTitle("my-project · Files — Shared Terminal");
		await app.appMenu("logout");
		await expect(page.locator("#auth-view")).toBeVisible();
		await expect(page).toHaveTitle("Shared Terminal");
	});
});
