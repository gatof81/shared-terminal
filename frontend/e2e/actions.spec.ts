import { expect, test } from "./fixtures.js";
import { SESSION_IDS } from "./mockBackend.js";

/**
 * Session actions (docs/design/ui-unificada.md §5.5, PR 4): one registry
 * behind the sidebar rows, their ⋯ menu, the terminal's state panel and
 * the Git view; rows and tabs operable by keyboard; explicit Terminate /
 * Delete entries instead of Shift-click; Reconnect after a lost socket.
 */
test.describe("session actions", () => {
	test("session rows are buttons: arrow keys move, Enter opens", async ({ app, page }) => {
		await app.login("alice");
		await app.openSidebar();
		const rows = page.locator("#session-list .session-select");
		await expect(rows).toHaveCount(2);
		await rows.first().focus();
		await expect(rows.first()).toHaveAttribute("aria-label", /my-project, running/);
		await page.keyboard.press("ArrowDown");
		await expect(rows.nth(1)).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(page.locator("#terminal-session-name")).toHaveText("docs");
		await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
	});

	test("tabs are a tablist: arrows move between tabs, Enter opens, × closes", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		if (app.mobile) await page.click("#chrome-toggle");
		const tabs = page.locator('#terminal-tabs [role="tab"]');
		await expect(tabs).toHaveCount(2);
		await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
		await tabs.first().focus();
		await page.keyboard.press("ArrowRight");
		await expect(tabs.nth(1)).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
		await expect
			.poll(() => backend.terminalSockets.map((s) => s.tabId))
			.toEqual(["tab-1", "tab-2"]);
		// Close the second tab from its own button (confirmed in a dialog). On
		// mobile, picking a tab collapses the chrome drawer; reopen it first.
		if (app.mobile) await page.click("#chrome-toggle");
		await page.locator('#terminal-tabs .tab-chip[data-tab-id="tab-2"] .tab-close').click();
		await page.locator('[role="alertdialog"] .modal-danger-action').click();
		await expect(tabs).toHaveCount(1);
		await expect
			.poll(() =>
				backend.requests.some((r) => r.method === "DELETE" && r.path.endsWith("/tabs/tab-2")),
			)
			.toBe(true);
	});

	test("the ⋯ menu lists the session's actions with explicit Terminate and Delete", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSidebar();
		await app.sessionRow("my-project").locator(".session-menu-btn").click();
		const menu = page.locator('[role="menu"].action-menu');
		await expect(menu).toBeVisible();
		const items = menu.locator('[role="menuitem"]');
		await expect(items).toHaveText([
			/Stop session/,
			/Exposed ports/,
			/Observers/,
			/Terminate session/,
			/Delete permanently/,
		]);
		await expect(items.first()).toBeFocused();
		await page.keyboard.press("ArrowDown");
		await expect(items.nth(1)).toBeFocused();
		await app.escape();
		await expect(menu).toHaveCount(0);
		await expect(app.sessionRow("my-project").locator(".session-menu-btn")).toBeFocused();
	});

	test("Stop from the menu stops the session; the row's quick action becomes Start", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSidebar();
		await app.sessionRow("my-project").locator(".session-menu-btn").click();
		await page.locator('[role="menuitem"][data-action="stop"]').click();
		await expect
			.poll(() => backend.requests.some((r) => r.method === "POST" && r.path.endsWith("/stop")))
			.toBe(true);
		await expect(app.sessionRow("my-project").locator('[data-action="start"]')).toBeVisible();
		await expect(app.sessionRow("my-project").locator('[data-action="stop"]')).toHaveCount(0);
	});

	test("a stopped session: Start from the terminal's state panel attaches the terminal", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("docs");
		await app.switchView("terminal");
		await page.locator('#terminal-state button[data-action="start"]').click();
		await expect
			.poll(() => backend.requests.some((r) => r.method === "POST" && r.path.endsWith("/start")))
			.toBe(true);
		// The poll sees it running → tabs listed → a tab is opened, or the
		// "no tabs yet" state offers one.
		await expect(page.locator("#terminal-state")).toContainText("No tabs yet", { timeout: 10_000 });
		await page.locator('#terminal-state button[data-action="newTab"]').click();
		await app.expectTerminalReady();
		await expect(page.locator("#terminal-state")).toBeHidden();
	});

	test("a terminated session offers Restore and Delete permanently in its state", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSidebar();
		await page.check("#show-terminated-toggle");
		await app.openSession("old-poc");
		await app.switchView("terminal");
		const panel = page.locator("#terminal-state");
		await expect(panel).toContainText("terminated");
		await expect(panel.locator('button[data-action="restore"]')).toBeEnabled();
		await expect(panel.locator('button[data-action="delete"]')).toBeEnabled();
	});

	test("a lost socket shows Reconnect; Reconnect attaches again", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		backend.dropTerminalSockets(SESSION_IDS.running);
		const panel = page.locator("#terminal-state");
		await expect(panel).toContainText("Connection lost");
		await expect(page.locator("#terminal-status-badge")).toHaveText("disconnected");
		await expect(page.locator("#terminal-container")).toBeHidden();
		await panel.locator('button[data-action="reconnect"]').click();
		await expect(panel).toBeHidden();
		await expect.poll(() => backend.terminalSockets.filter((s) => !s.closed).length).toBe(1);
		await expect(backend.terminalSockets.at(-1)?.tabId ?? "").toBe("tab-1");
		await app.expectTerminalReady();
		await expect(page.locator("#terminal-status-badge")).toHaveText("running");
	});

	test("the state panel never shares the box with a live terminal", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await expect(page.locator("#terminal-state")).toBeHidden();
		await app.switchView("files");
		await app.switchView("terminal");
		await expect(page.locator("#terminal-state")).toBeHidden();
		expect(backend.terminalSockets.filter((s) => !s.closed)).toHaveLength(1);
	});
});
