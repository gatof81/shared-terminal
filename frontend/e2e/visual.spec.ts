import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { CONV_IDS, PROJECT_IDS } from "./mockBackend.js";

/**
 * Screenshot baselines of the main screens, per project (desktop / mobile).
 * The terminal canvas is masked: its glyphs come from xterm's own renderer
 * (WebGL or DOM, GPU-dependent), and the mock's prompt text is asserted in
 * the functional specs anyway. Toasts are hidden (timing-dependent).
 * Regenerate with `npm run test:e2e:update` after an intended visual change
 * (it runs `--update-snapshots=all`: the default "changed" mode keeps any
 * baseline that still passes the comparison, stale toast included).
 */
async function shot(page: Page, name: string): Promise<void> {
	// The overlays sit absolutely over the terminal's box, so masking the
	// terminal would paint over Files / Git / Chat too: mask it only when it
	// is the view on screen.
	const terminalShown = !(await page
		.locator("#files-view, #git-view, #chat-view")
		.filter({ visible: true })
		.count());
	const mask = terminalShown ? [page.locator("#terminal-container")] : [];
	await expect(page).toHaveScreenshot(`${name}.png`, {
		mask,
		fullPage: false,
		// Toasts are timing-dependent (the GPU-fallback notice, a copy chip):
		// hidden rather than masked, so no block covers what sits under them.
		stylePath: fileURLToPath(new URL("./screenshot.css", import.meta.url)),
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

	test("terminal stopped state", async ({ app, page }) => {
		await app.login("alice");
		await app.openSession("docs");
		await app.switchView("terminal");
		await expect(page.locator("#terminal-state")).toContainText("stopped");
		await shot(page, "terminal-stopped");
	});

	test("project rail", async ({ app, backend, page }) => {
		backend.enableConversations();
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		await expect(page.locator(".rail-body .rail-agent")).toHaveCount(2);
		await expect(page.locator(".rail-body .rail-unread")).toHaveText("1");
		await shot(page, "project-rail");
	});

	test("topic with unread", async ({ app, backend, page }) => {
		backend.enableConversations();
		backend.addAcpMessage({
			from_id: "dev",
			to_id: "arq",
			body: "¿Los tokens nuevos ya están en `tokens.css`?",
			project_id: PROJECT_IDS.hz,
			conversation_id: CONV_IDS.ui,
		});
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}/c/${CONV_IDS.ui}`);
		await expect(page.locator("#project-view .acp-divider")).toBeVisible();
		await expect(page.locator("#ps-topic-title")).toHaveText("Rediseño de UI/UX");
		await shot(page, "project-topic");
	});

	test("new session dialog", async ({ app, page }) => {
		await app.login("alice");
		await app.openSidebar();
		await page.click("#new-session-btn");
		await expect(page.locator("#new-session-modal")).toHaveClass(/open/);
		await shot(page, "new-session");
	});
});
