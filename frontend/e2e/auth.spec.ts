import { expect, test } from "./fixtures.js";

test.describe("auth", () => {
	test("unauthenticated visit shows the login form; a wrong password is explained", async ({
		app,
		page,
	}) => {
		await app.loginViaForm("alice", "nope");
		await expect(page.locator("#auth-error")).toHaveText("Invalid credentials");
		await expect(page.locator("#app-view")).toBeHidden();
	});

	test("login lists the person's sessions; terminated ones only on request", async ({
		app,
		page,
	}) => {
		await app.loginViaForm("alice");
		await expect(page.locator("#app-view")).toBeVisible();
		await app.openSidebar();
		await expect(app.sessionRow("my-project")).toBeVisible();
		await expect(app.sessionRow("docs")).toBeVisible();
		await expect(app.sessionRow("old-poc")).toHaveCount(0);
		await page.check("#show-terminated-toggle");
		await expect(app.sessionRow("old-poc")).toBeVisible();
	});

	test("logout returns to the login form; logging back in reloads the list", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSidebar();
		await page.click(app.mobile ? "#sidebar-logout-btn" : "#logout-btn");
		await expect(page.locator("#auth-view")).toBeVisible();
		await expect(page.locator("#app-view")).toBeHidden();
		expect(backend.current, "the server saw the logout").toBeNull();
		// Nothing of the previous person stays in the DOM behind the login view.
		await expect(page.locator("#session-list .session-item")).toHaveCount(0);
		await expect(page.locator("#terminal-toolbar")).toBeHidden();
		// Logging back in reloads the list from the server.
		await app.loginViaForm("alice");
		await expect(page.locator("#app-view")).toBeVisible();
		await app.openSidebar();
		await expect(app.sessionRow("my-project")).toBeVisible();
	});

	test("an expired cookie (401 on a poll) sends the person back to login with one message", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		backend.current = null; // the server stopped accepting the cookie
		await expect(page.locator("#auth-view")).toBeVisible({ timeout: 10_000 });
		await expect(app.toast(/session has expired/)).toHaveCount(1);
	});
});
