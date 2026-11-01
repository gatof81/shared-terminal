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
		bar,
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
		if (app.mobile && bar === "stacked") {
			// Icons only, the active one labelled.
			await expect(page.locator("#view-terminal-btn .view-label")).toBeVisible();
			await expect(page.locator("#view-files-btn .view-label")).toBeHidden();
		} else if (app.mobile) {
			// Merged bar at 390 px: icons only; the active one is told by aria-pressed and its underline.
			await expect(page.locator("#view-switch .view-label:visible")).toHaveCount(0);
			await expect(page.locator("#view-terminal-btn")).toHaveAttribute("aria-pressed", "true");
		}
	});

	test("merged bar on a 390-px phone: one line, a legible name, four tabs, Insert in the tab strip; with the keyboard's height too", async ({
		app,
		page,
		bar,
	}) => {
		test.skip(!app.mobile || bar === "stacked", "the merged bar is the mobile default");
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		const header = page.locator("header");
		const box = async (sel: string) => (await page.locator(sel).boundingBox())!;
		const h = await box("header");
		expect(h.height, "header and session bar share one line").toBeLessThanOrEqual(48);
		expect((await box("#terminal-toolbar")).y, "the bar is inside the header").toBeLessThan(
			h.height,
		);
		const name = await box("#terminal-session-name");
		expect(name.width, "the session name keeps room to read").toBeGreaterThanOrEqual(72);
		await expect(page.locator("#terminal-session-name")).toHaveText("my-project");
		for (const v of ["terminal", "files", "git", "chat"] as const) {
			const b = await box(`#view-${v}-btn`);
			expect(b.width, `${v} tab is a touch target`).toBeGreaterThanOrEqual(34);
			expect(b.height, `${v} tab is a touch target`).toBeGreaterThanOrEqual(34);
			expect(b.y + b.height, `${v} tab is in the header line`).toBeLessThanOrEqual(
				h.y + h.height + 1,
			);
		}
		// Insert (+) is a terminal control: in the tab strip on the Terminal view, gone under an overlay.
		await expect(page.locator("#tab-tools #actions-btn")).toBeVisible();
		await expect(header.locator("#actions-btn")).toHaveCount(0);
		await app.switchView("chat");
		await expect(page.locator("#tab-tools #actions-btn")).toBeHidden();
		// The soft keyboard takes about half the height: the bar stays one line and the composer is reachable.
		await page.locator("#chat-list .chat-conv-row", { hasText: "Refactor auth flow" }).click();
		await page.setViewportSize({ width: 390, height: 420 });
		await expect(page.locator(".chat-composer textarea")).toBeInViewport();
		expect((await box("header")).height).toBeLessThanOrEqual(48);
		await expect(page.locator("#view-terminal-btn")).toBeInViewport();
		await page.setViewportSize({ width: 390, height: 844 });
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
