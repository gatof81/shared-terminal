import { expect, test } from "./fixtures.js";

/**
 * The interface (docs/design/ui-unificada.md §5.2 / §5.3):
 * the session bar carries the view tabs on every view, the ⋯ menu
 * and — on mobile — stays on screen with the terminal focused; the
 * terminal-only controls live in the tab strip; the header cluster is one
 * user menu.
 */
test.describe("the bar layout", () => {
	test("the view tabs are in the session bar on every view, and stay with the terminal focused", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		const tabs = page.locator("#view-switch");
		await expect(tabs).toBeVisible();
		// Terminal focused (on a phone this is when the soft keyboard is up).
		await page.locator(".tab-pane.active .xterm-helper-textarea").focus();
		await expect(tabs).toBeVisible();
		await expect(page.locator("#view-files-btn")).toBeVisible();
		for (const v of ["files", "git", "terminal"] as const) {
			await app.switchView(v);
			await expect(tabs).toBeVisible();
			await expect(page.locator("#terminal-toolbar")).toBeVisible();
		}
		if (app.mobile) {
			// Merged bar at 390 px: icons only; the active one is told by aria-pressed and its underline.
			await expect(page.locator("#view-switch .view-label:visible")).toHaveCount(0);
			await expect(page.locator("#view-terminal-btn")).toHaveAttribute("aria-pressed", "true");
		}
	});

	test("merged bar on a 390-px phone: one line, a legible name, three tabs, Insert in the tab strip; with the keyboard's height too", async ({
		app,
		page,
	}) => {
		test.skip(!app.mobile, "a phone");
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
		await expect(page.locator("#view-chat-btn"), "a traditional session has no Chat").toBeHidden();
		for (const v of ["terminal", "files", "git"] as const) {
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
		await app.switchView("files");
		await expect(page.locator("#tab-tools #actions-btn")).toBeHidden();
		// The soft keyboard takes about half the height: the bar stays one line.
		await page.setViewportSize({ width: 390, height: 420 });
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

	test("no session open: neither the bar nor the terminal's tools show, then both appear with one", async ({
		app,
		page,
	}) => {
		// On a phone the bar and strip were forced visible (no drawer in v2),
		// which left ⎕ / Aa 14 floating over the empty state.
		await app.login("alice");
		await expect(page.locator("#empty-state")).toBeVisible();
		await expect(page.locator("#terminal-tabs")).toBeHidden();
		await expect(page.locator("#tab-tools #font-size-btn")).toBeHidden();
		await expect(page.locator("#terminal-toolbar")).toBeHidden();
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await expect(page.locator("#terminal-toolbar")).toBeVisible();
		await expect(page.locator("#tab-tools #font-size-btn")).toBeVisible();
		// A stopped session has no terminal: the bar stays (view tabs, ⋯), the
		// strip with the terminal's tools does not — on a phone as on desktop —
		// and Start is reachable.
		await app.openSession("docs");
		await app.switchView("terminal");
		await expect(page.locator("#terminal-toolbar")).toBeVisible();
		await expect(page.locator("#session-menu-btn")).toBeVisible();
		await expect(page.locator("#terminal-tabs")).toBeHidden();
		await expect(page.locator("#terminal-state")).toContainText("stopped");
		await expect(
			page.locator("#terminal-state").getByRole("button", { name: "Start session" }),
		).toBeEnabled();
	});

	test("a phone hides the tab row from the ⋯ (U-1 B): first item, one resize each way, none on a view switch, remembered", async ({
		app,
		backend,
		page,
	}) => {
		test.skip(!app.mobile, "a phone");
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await page.waitForTimeout(400);
		const sock = backend.terminalSockets[0]!;
		const resizes = () => sock.sent.filter((f) => f.type === "resize").length;
		const termH = async () => (await page.locator("#terminal-container").boundingBox())!.height;
		const firstItem = page.locator('[role="menu"].action-menu [role="menuitem"]').first();
		const r0 = resizes();
		const h0 = await termH();
		await page.click("#session-menu-btn");
		await expect(firstItem).toHaveText(/^Hide tabs/);
		await firstItem.click();
		await expect(page.locator("#terminal-tabs")).toBeHidden();
		await expect.poll(resizes, "one resize").toBe(r0 + 1);
		const h1 = await termH();
		expect(Math.abs(h1 - h0 - 40), "the terminal gains the row's height").toBeLessThanOrEqual(4);
		for (const v of ["files", "git", "terminal"] as const) {
			await app.switchView(v);
			if (v !== "terminal") {
				// Off the Terminal view the item is not offered.
				await page.click("#session-menu-btn");
				await expect(page.getByRole("menuitem", { name: /^(Hide|Show) tabs/ })).toHaveCount(0);
				await app.escape();
			}
		}
		await page.waitForTimeout(400);
		expect(resizes(), "a view switch resizes nothing").toBe(r0 + 1);
		expect(await termH()).toBe(h1);
		await page.reload();
		await app.expectTerminalReady();
		await expect(page.locator("#terminal-tabs")).toBeHidden();
		await page.waitForTimeout(400);
		const sock2 = backend.terminalSockets.at(-1)!;
		const resizes2 = () => sock2.sent.filter((f) => f.type === "resize").length;
		const r1 = resizes2();
		await page.click("#session-menu-btn");
		await expect(firstItem).toHaveText(/^Show tabs/);
		await firstItem.click();
		await expect(page.locator("#terminal-tabs")).toBeVisible();
		await expect.poll(resizes2, "one resize back").toBe(r1 + 1);
		await page.waitForTimeout(400);
		expect(resizes2()).toBe(r1 + 1);
		// On a wide screen the row shows and the item is not offered, whatever is stored.
		await page.click("#session-menu-btn");
		await page.getByRole("menuitem", { name: /^Hide tabs/ }).click();
		await page.setViewportSize({ width: 1280, height: 800 });
		await expect(page.locator("#terminal-tabs")).toBeVisible();
		await page.click("#session-menu-btn");
		await expect(page.getByRole("menuitem", { name: /^(Hide|Show) tabs/ })).toHaveCount(0);
	});

	test("the user menu (U-1 A): the role's entries in order, a line before Logout; each acts; the focus goes back", async ({
		app,
		page,
	}) => {
		await app.login("admin");
		await app.openUserMenu();
		const menu = page.locator('[role="menu"].action-menu');
		await expect(menu.locator('[role="menuitem"]')).toHaveText([
			/Templates/,
			/Invites/,
			/Admin/,
			/Logout/,
		]);
		await expect(menu.locator('[data-action="logout"]')).toHaveCSS("border-top-style", "solid");
		await menu.locator('[data-action="admin"]').click();
		await expect(page.locator("#admin-modal")).toHaveClass(/open/);
		await app.escape();
		// Back to the opener: the avatar, or under 400 px the ☰ (the drawer row's drawer is closed).
		const avatar = page.locator("#user-menu-btn");
		await expect(
			(await avatar.isVisible()) ? avatar : page.locator("#sidebar-toggle"),
		).toBeFocused();
		// No copy of the old buttons left.
		await expect(
			page.locator(
				"#templates-btn, #invites-btn, #my-groups-btn, #admin-btn, #notifications-btn, #logout-btn, [id^='sidebar-'][id$='-btn']:not(#sidebar-toggle):not(#sidebar-refresh-btn):not(#sidebar-account-btn)",
			),
		).toHaveCount(0);
	});

	for (const width of [1280, 768, 400, 399, 360, 320])
		test(`the user menu's one opener at ${width} px`, async ({ app, page }) => {
			await page.setViewportSize({ width, height: 800 });
			await app.login("alice");
			const avatar = page.locator("#user-menu-btn");
			if (width >= 400) {
				await expect(avatar).toBeVisible();
			} else {
				await expect(avatar).toBeHidden();
				await app.openSidebar();
				await expect(page.locator("#sidebar-account-btn")).toBeVisible();
			}
		});

	test("a stopped session: the bar's tabs reach Terminal (state panel), Files and Git", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("docs");
		await app.expectView("files");
		await app.switchView("terminal");
		await expect(page.locator("#terminal-state")).toContainText("stopped");
		await app.switchView("git");
		await expect(page.locator("#view-chat-btn")).toBeHidden();
	});
});
