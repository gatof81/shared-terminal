import { expect, test } from "./fixtures.js";
import { PROJECT_IDS, SESSION_IDS } from "./mockBackend.js";

/**
 * The phone's home (docs/design/revision-ui.md §8): an address that names
 * nothing shows the main list as the screen — the sidebar itself, the one the
 * ☰ opens. A pick from it is a new entry; Back returns to it. The session
 * underneath stays attached: entering and leaving the list sends nothing.
 */
test.describe("phone home", () => {
	test.beforeEach(({ app }) => {
		test.skip(!app.mobile, "the home is the list on a phone only");
	});

	test("no route ⇒ the list; a session ⇒ its terminal; Back ⇒ the list, without a resize", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		const body = page.locator("body");
		await expect(body).toHaveClass(/\bhome-on\b/);
		const sidebar = page.locator("#sidebar");
		await expect(sidebar.locator(".sgroup-projects")).toBeInViewport();
		await expect(sidebar.locator(".sgroup-sessions")).toBeInViewport();
		// The list is the whole width, with no drawer backdrop and no ☰ to open it.
		const width = await page.evaluate(() => window.innerWidth);
		expect((await sidebar.boundingBox())?.width).toBe(width);
		await expect(page.locator("#sidebar-backdrop")).toBeHidden();
		await expect(page.locator("#sidebar-toggle")).toBeHidden();
		expect(await app.sidebarOpen()).toBe(false);
		// Showing the list opens no terminal.
		expect(backend.terminalSockets).toHaveLength(0);

		await app.sessionRow("my-project").click();
		await app.expectTerminalReady();
		await expect(body).not.toHaveClass(/\bhome-on\b/);
		expect(page.url()).toContain(`#/sessions/${SESSION_IDS.running}`);
		await expect(sidebar).not.toBeInViewport();
		await page.waitForTimeout(400);
		const sock = backend.terminalSockets[0]!;
		const frames = sock.sent.length;

		await page.goBack();
		await expect(body).toHaveClass(/\bhome-on\b/);
		expect(new URL(page.url()).hash).toBe("");
		await expect(sidebar.locator(".sgroup-sessions")).toBeInViewport();
		// The terminal under the list is covered, not taken down.
		await expect(page.locator("#terminal-area")).toHaveJSProperty("inert", true);

		// The same session again: a new entry, the same attach.
		await app.sessionRow("my-project").click();
		await expect(body).not.toHaveClass(/\bhome-on\b/);
		expect(page.url()).toContain(`#/sessions/${SESSION_IDS.running}`);
		await page.waitForTimeout(400);
		expect(backend.terminalSockets, "no new terminal socket").toHaveLength(1);
		expect(sock.closed).toBe(false);
		expect(sock.sent.length - frames, "no frame — no resize — entering or leaving the list").toBe(
			0,
		);

		// Back again: the list (the first entry — one more Back leaves the app).
		await page.goBack();
		await expect(body).toHaveClass(/\bhome-on\b/);
	});

	test("a project from the list; Back returns to the list, and the ☰ there is the same list", async ({
		app,
		backend,
		page,
	}) => {
		backend.enableProjects();
		await app.login("alice");
		await page.locator(`#session-list a.project-row[data-project-id="${PROJECT_IDS.hz}"]`).click();
		await expect(page).toHaveURL(new RegExp(`#/projects/${PROJECT_IDS.hz}`));
		await expect(page.locator("body")).not.toHaveClass(/\bhome-on\b/);
		await page.goBack();
		await expect(page.locator("body")).toHaveClass(/\bhome-on\b/);
		// Out of the home (a session), the ☰ opens that same element as a drawer.
		await app.sessionRow("my-project").click();
		await app.expectTerminalReady();
		await app.openSidebar();
		await expect(page.locator("#sidebar .sgroup-sessions")).toBeInViewport();
		await expect(page.locator("#sidebar-backdrop")).toBeVisible();
	});
});
