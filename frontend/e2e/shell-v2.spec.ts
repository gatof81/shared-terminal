import { expect, test } from "./fixtures.js";

/**
 * Shell v2 (docs/design/ui-unificada.md §5.2 / §5.3), behind the runtime
 * flag: the session bar carries the view tabs on every view, the ⋯ menu
 * and — on mobile — stays on screen with the terminal focused; the
 * terminal-only controls live in the tab strip; the header cluster is one
 * user menu. Runs only on the v2 projects.
 */
test.describe("shell v2", () => {
	test.skip(({ shell }) => shell !== "v2", "v2 only");

	test("the view tabs are in the session bar on every view, and stay with the terminal focused", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		const tabs = page.locator("#view-switch");
		await expect(tabs).toBeVisible();
		await expect(page.locator("#chrome-toggle")).toBeHidden();
		await expect(page.locator("#view-nav")).toBeHidden();
		// Terminal focused (on a phone this is when the soft keyboard is up).
		await page.locator(".tab-pane.active .xterm-helper-textarea").focus();
		await expect(tabs).toBeVisible();
		await expect(page.locator("#view-files-btn")).toBeVisible();
		for (const v of ["files", "git", "chat", "terminal"] as const) {
			await app.switchView(v);
			await expect(tabs).toBeVisible();
			await expect(page.locator("#terminal-toolbar")).toBeVisible();
		}
		if (app.mobile) {
			// Icons only, the active one labelled.
			await expect(page.locator("#view-terminal-btn .view-label")).toBeVisible();
			await expect(page.locator("#view-files-btn .view-label")).toBeHidden();
		}
	});

	test("terminal-only controls live in the tab strip; the bar holds the session's ⋯ menu", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await expect(page.locator("#tab-tools #font-size-btn")).toBeVisible();
		await expect(page.locator("#tab-tools #terminal-search-btn")).toBeVisible();
		await expect(page.locator("#terminal-toolbar #observers-btn")).toBeHidden();
		await expect(page.locator("#terminal-toolbar #ports-btn")).toBeHidden();
		await page.click("#session-menu-btn");
		const menu = page.locator('[role="menu"].action-menu');
		await expect(menu).toContainText("my-project");
		await expect(menu.locator('[data-action="observers"]')).toBeVisible();
		await expect(menu.locator('[data-action="ports"]')).toBeVisible();
		await expect(menu.locator('[data-action="terminate"]')).toBeVisible();
		await app.escape();
		await expect(page.locator("#session-menu-btn")).toBeFocused();
		// The strip's controls survive a session switch (the chips are rebuilt, the slot stays).
		await app.openSession("docs");
		await app.expectView("files");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await expect(page.locator("#tab-tools #font-size-btn")).toBeVisible();
	});

	test("desktop: the header cluster is one user menu with the role's entries", async ({
		app,
		page,
	}) => {
		test.skip(app.mobile, "the user menu replaces the desktop header cluster");
		await app.login("admin");
		await expect(page.locator("#admin-btn")).toBeHidden();
		await page.click("#user-menu-btn");
		const menu = page.locator('[role="menu"].action-menu');
		await expect(menu.locator('[role="menuitem"]')).toHaveText([
			/Templates/,
			/Invites/,
			/Admin/,
			/Logout/,
		]);
		await menu.locator('[data-action="admin-btn"]').click();
		await expect(page.locator("#admin-modal")).toHaveClass(/open/);
		await app.escape();
		await expect(page.locator("#user-menu-btn")).toBeFocused();
	});

	test("a stopped session: the bar's tabs reach Terminal (state panel), Files, Git and Chat", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("docs");
		await app.expectView("files");
		await app.switchView("terminal");
		await expect(page.locator("#terminal-state")).toContainText("stopped");
		await app.switchView("chat");
		await expect(page.locator("#chat-list .chat-conv-row")).toHaveCount(2);
	});
});
