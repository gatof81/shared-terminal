import { SESSION_IDS } from "./mockBackend.js";
import { expect, test } from "./fixtures.js";

test.describe("navigation", () => {
	test("opening a running session attaches the terminal and reflects the deep link", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		expect(page.url()).toContain(`#/sessions/${SESSION_IDS.running}`);
		await expect(page.locator("#terminal-status-badge")).toHaveText("running");
		await expect(page.locator("#terminal-tabs .tab-chip")).toHaveCount(2);
	});

	test("a deep link opens the session after login", async ({ app, page }) => {
		await app.login("alice", `#/sessions/${SESSION_IDS.running}`);
		await expect(page.locator("#terminal-session-name")).toHaveText("my-project");
		await app.expectTerminalReady();
	});

	test("Terminal ⇄ Files ⇄ Git ⇄ Chat keep the same session", async ({ app, page }) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();

		await app.switchView("files");
		await expect(page.locator("#files-tree")).toContainText("README.md");
		await expect(page.locator("#files-tree")).toContainText("src");

		await app.switchView("git");
		await expect(page.locator("#git-summary")).toContainText("main");
		await expect(page.locator("#git-list .git-row")).toHaveCount(2);

		await app.switchView("chat");
		await expect(page.locator("#chat-list .chat-conv-row")).toHaveCount(2);

		await app.switchView("terminal");
		await expect(page.locator("#terminal-session-name")).toHaveText("my-project");
		await expect(page.locator("#terminal-container .tab-pane.active")).toContainText("Welcome");
	});

	test("a stopped session opens in Files with the Terminal disabled and explained", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("docs");
		await app.expectView("files");
		const terminalBtn = page.locator("#view-terminal-btn");
		await expect(terminalBtn).toBeDisabled();
		await expect(terminalBtn).toHaveAttribute("title", /Start the session/);
		await app.switchView("git");
		await expect(page.locator("#git-list")).toContainText("isn't running");
		await expect(page.locator("#git-list button", { hasText: "Start session" })).toBeVisible();
	});

	test("Files: open a file, preview it, breadcrumbs follow; a restricted file is refused", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("files");
		await page.locator("#files-tree .files-row", { hasText: "src" }).click();
		await page.locator("#files-tree .files-row", { hasText: "auth.ts" }).click();
		await expect(page.locator("#files-preview")).toContainText("export function login");
		await expect(page.locator("#files-breadcrumbs")).toContainText("auth.ts");
		if (app.mobile) {
			await page.locator("#files-preview button", { hasText: "Files" }).click();
		}
		await page.locator("#files-tree .files-row", { hasText: ".env" }).click();
		await expect(page.locator("#files-preview")).toContainText("restricted");
	});

	test("Git: selecting a change shows its diff", async ({ app, page }) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("git");
		await page.locator("#git-list .git-row", { hasText: "auth.ts" }).click();
		await expect(
			page.locator("#git-diff .git-diff-row.kind-add", { hasText: "cookie === null" }),
		).toHaveCount(1);
	});
});
