import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

/**
 * Screenshot baselines of the main screens, per project (desktop / mobile).
 * The terminal canvas is masked: its glyphs come from xterm's own renderer
 * (WebGL or DOM, GPU-dependent), and the mock's prompt text is asserted in
 * the functional specs anyway. Toasts are masked too (timing-dependent).
 * Regenerate with `npm run test:e2e:update` after an intended visual change.
 */
function shot(page: Page, name: string) {
	return expect(page).toHaveScreenshot(`${name}.png`, {
		mask: [page.locator("#terminal-container"), page.locator("#toast")],
		fullPage: false,
	});
}

test.describe("visual", () => {
	test("login", async ({ app, page }) => {
		await page.goto("/");
		await expect(page.locator("#auth-view")).toBeVisible();
		await shot(page, "login");
		void app;
	});

	test("terminal", async ({ app, page }) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await shot(page, "terminal");
	});

	test("files", async ({ app, page }) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("files");
		await page.locator("#files-tree .files-row", { hasText: "README.md" }).click();
		await expect(page.locator("#files-preview")).toContainText("sample workspace");
		await shot(page, "files");
	});

	test("git", async ({ app, page }) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("git");
		await page.locator("#git-list .git-row", { hasText: "auth.ts" }).click();
		await expect(page.locator("#git-diff")).toContainText("cookie === null");
		await shot(page, "git");
	});

	test("chat", async ({ app, page }) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("chat");
		await page.locator("#chat-list .chat-conv-row", { hasText: "Refactor auth flow" }).click();
		await expect(page.locator("#chat-thread .chat-assistant")).toContainText("cookie check");
		await shot(page, "chat");
	});

	test("new session dialog", async ({ app, page }) => {
		await app.login("alice");
		await app.openSidebar();
		await page.click("#new-session-btn");
		await expect(page.locator("#new-session-modal")).toHaveClass(/open/);
		await shot(page, "new-session");
	});
});
