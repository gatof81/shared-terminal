import { SESSION_IDS } from "./mockBackend.js";
import { expect, test } from "./fixtures.js";

test.describe("dialogs", () => {
	test("New session: Escape closes it and focus returns to the opener", async ({ app, page }) => {
		await app.login("alice");
		await app.openSidebar();
		await page.click("#new-session-btn");
		const modal = page.locator("#new-session-modal");
		await expect(modal).toHaveClass(/open/);
		await expect(page.locator("#new-session-input")).toBeFocused();
		await expect(page.locator("#app-view")).toHaveAttribute("inert", "");
		await app.escape();
		await expect(modal).not.toHaveClass(/open/);
		await expect(page.locator("#app-view")).not.toHaveAttribute("inert", "");
		await expect(page.locator("#new-session-btn")).toBeFocused();
	});

	test("nested dialogs close one per Escape (Save as template over New session)", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSidebar();
		await page.click("#new-session-btn");
		await page.click("#save-as-template-btn");
		await expect(page.locator("#save-template-modal")).toHaveClass(/open/);
		await expect(page.locator("#new-session-modal")).toHaveAttribute("inert", "");
		await app.escape();
		await expect(page.locator("#save-template-modal")).not.toHaveClass(/open/);
		await expect(page.locator("#new-session-modal")).toHaveClass(/open/);
		await expect(page.locator("#save-as-template-btn")).toBeFocused();
		await app.escape();
		await expect(page.locator("#new-session-modal")).not.toHaveClass(/open/);
	});

	test("mobile: with the sidebar drawer and a dialog open, one Escape closes only the dialog", async ({
		app,
		page,
	}) => {
		test.skip(!app.mobile, "the drawer only exists on mobile");
		await app.login("alice");
		await app.openSidebar();
		await page.click("#new-session-btn");
		await expect(page.locator("#new-session-modal")).toHaveClass(/open/);
		await app.escape();
		await expect(page.locator("#new-session-modal")).not.toHaveClass(/open/);
		expect(await app.sidebarOpen(), "the drawer survives the first Escape").toBe(true);
		await app.escape();
		await expect.poll(() => app.sidebarOpen()).toBe(false);
	});

	test("mobile: the Insert (+) menu is a dialog; Escape closes it and nothing else", async ({
		app,
		page,
	}) => {
		test.skip(!app.mobile, "the (+) menu is in the mobile header");
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await page.click("#actions-btn");
		await expect(page.locator("#actions-menu")).toHaveClass(/open/);
		await expect(page.locator("#actions-paste-btn")).toBeFocused();
		await app.escape();
		await expect(page.locator("#actions-menu")).not.toHaveClass(/open/);
		await expect(page.locator("#actions-btn")).toBeFocused();
		await expect(page.locator("#terminal-session-name")).toHaveText("my-project");
	});

	test("deleting a terminated session permanently requires typing its name", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSidebar();
		await page.check("#show-terminated-toggle");
		await app.sessionRow("old-poc").locator(".session-kill").click();
		const dialog = page.locator('[role="alertdialog"]');
		await expect(dialog).toBeVisible();
		await expect(dialog).toContainText("Delete permanently");
		const confirm = dialog.locator(".modal-danger-action");
		await expect(confirm).toBeDisabled();
		await dialog.locator("input").fill("old-po");
		await expect(confirm).toBeDisabled();
		await dialog.locator("input").fill("old-poc");
		await expect(confirm).toBeEnabled();
		await confirm.click();
		await expect
			.poll(() => backend.requests.filter((r) => r.method === "DELETE").map((r) => r.path))
			.toEqual([`/sessions/${SESSION_IDS.terminated}?hard=true`]);
		await expect(app.sessionRow("old-poc")).toHaveCount(0);
	});

	test("terminating a running session asks a plain (reversible) confirmation; Cancel does nothing", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSidebar();
		await app.sessionRow("my-project").locator(".session-kill").click();
		const dialog = page.locator('[role="alertdialog"]');
		await expect(dialog).toContainText("Terminate");
		await expect(dialog.locator("input")).toHaveCount(0);
		await expect(dialog.locator(".dialog-cancel")).toBeFocused();
		await dialog.locator(".dialog-cancel").click();
		await expect(dialog).toHaveCount(0);
		expect(backend.requests.filter((r) => r.method === "DELETE")).toEqual([]);
	});

	test("Tab is trapped inside the open dialog", async ({ app, page }) => {
		await app.login("alice");
		await app.openSidebar();
		await page.click("#new-session-btn");
		for (let i = 0; i < 40; i++) {
			await page.keyboard.press("Tab");
			const inside = await page.evaluate(
				() => !!document.activeElement?.closest("#new-session-modal"),
			);
			expect(inside, `focus left the dialog after ${i + 1} Tabs`).toBe(true);
		}
	});
});
