import { expect, test } from "./fixtures.js";
import { PROJECT_IDS } from "./mockBackend.js";

/**
 * The terminal invariant (docs/design/ui-unificada.md §5.1): switching
 * views must not reconnect, resize or disturb the terminal. The mock
 * records every socket and every frame the app sends, so the assertion
 * is on the wire, not on pixels.
 */
test.describe("terminal invariant", () => {
	test("switching views opens no socket and sends no resize or input", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		// Let the attach settle (fit → possible initial resize) before measuring.
		await page.waitForTimeout(400);
		const sockets = backend.terminalSockets.length;
		const sock = backend.terminalSockets[0]!;
		const resizes = () => sock.sent.filter((f) => f.type === "resize").length;
		const inputs = () => sock.sent.filter((f) => f.type === "input").length;

		// From here on: pure view switches. Nothing may reach the terminal.
		const framesBefore = sock.sent.length;
		const rowsBefore = await page.locator(".tab-pane.active .xterm-rows > div").count();
		const r0 = resizes();
		const i0 = inputs();
		// Every switch is pure on both layouts: the view tabs are always on screen.
		await app.switchView("files");
		await app.switchView("git");
		await app.switchView("terminal");
		await app.switchView("files");
		await app.switchView("terminal");
		await page.waitForTimeout(400);

		expect(backend.terminalSockets.length, "no new terminal socket").toBe(sockets);
		expect(sock.closed, "the attach stayed open").toBe(false);
		expect(resizes() - r0, "no resize sent by a view switch").toBe(0);
		expect(inputs() - i0, "no input sent by a view switch").toBe(0);
		expect(sock.sent.length - framesBefore, "no frame of any kind").toBe(0);
		const rowsAfter = await page.locator(".tab-pane.active .xterm-rows > div").count();
		expect(rowsAfter).toBe(rowsBefore);
		// Output that arrives while an overlay is up still lands in the terminal.
		await app.switchView("git");
		backend.pushTerminalOutput(sock.sessionId, "\r\nstill here\r\n");
		await app.switchView("terminal");
		await expect(page.locator(".tab-pane.active")).toContainText("still here");
	});

	test("rail ⇄ topic ⇄ Pendientes ⇄ menus ⇄ terminal: nothing touches the terminal", async ({
		app,
		backend,
		page,
	}) => {
		backend.enableConversations();
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await page.waitForTimeout(400);
		const sockets = backend.terminalSockets.length;
		const sock = backend.terminalSockets[0]!;
		const framesBefore = sock.sent.length;
		const rowsBefore = await page.locator(".tab-pane.active .xterm-rows > div").count();
		const topicRow = (title: string) => page.locator(".rail-body .rail-conv", { hasText: title });

		// The project from its heading in the sidebar: its rail.
		await app.openSidebar();
		await page.locator(`.sgroup[data-group="${PROJECT_IDS.hz}"] a.sgroup-title`).click();
		await expect(page.locator(".rail-body")).toBeVisible();
		// Topic, another topic, back to the rail.
		await topicRow("Optimización de CI").click();
		await expect(page.locator("#ps-topic-title")).toHaveText("Optimización de CI");
		if (app.mobile) await page.locator(".ps-back").click();
		await topicRow("Rediseño de UI/UX").click();
		await expect(page.locator("#ps-topic-title")).toHaveText("Rediseño de UI/UX");
		// Pendientes and the topic's menu over the topic.
		const inbox = page.locator(".acp-inbox-card");
		await page.locator("#inbox-btn").click();
		await expect(inbox).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(inbox).toBeHidden();
		await page.locator(".ps-topic-head .pv-menu-btn").click();
		await expect(page.locator('[role="menu"].action-menu')).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.locator('[role="menu"].action-menu')).toBeHidden();
		await page.goBack();
		await expect(page.locator(".rail-body")).toBeVisible();
		// The sessions from the rail's foot: the terminal again; Back to the rail.
		await page.locator(".rail-foot").getByRole("button", { name: "Sesiones" }).click();
		if (app.mobile) {
			await expect(page.locator("main")).toHaveClass(/sidebar-open/);
			await app.sessionRow("my-project").locator(".session-select").click();
		}
		await expect(page.locator("#project-view")).toBeHidden();
		await page.goBack();
		await expect(page.locator(".rail-body")).toBeVisible();
		await page.goForward();
		await expect(page.locator("#project-view")).toBeHidden();
		// Pendientes and the account's menu with the terminal on screen.
		await page.locator("#inbox-btn").click();
		await expect(inbox).toBeVisible();
		await inbox.getByRole("button", { name: "Cerrar Pendientes" }).click();
		await expect(inbox).toBeHidden();
		await app.openUserMenu();
		await page.keyboard.press("Escape");
		await page.waitForTimeout(400);

		expect(backend.terminalSockets.length, "no new terminal socket").toBe(sockets);
		expect(sock.closed, "the attach stayed open").toBe(false);
		expect(sock.sent.length - framesBefore, "no frame of any kind (no resize)").toBe(0);
		expect(await page.locator(".tab-pane.active .xterm-rows > div").count()).toBe(rowsBefore);
		expect(app.errors).toEqual([]);
	});

	test("typing reaches the session and the echo renders", async ({ app, backend, page }) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await page.locator(".tab-pane.active .xterm-helper-textarea").focus();
		await page.keyboard.type("ls");
		await expect
			.poll(() =>
				backend.terminalSockets[0]!.sent.filter((f) => f.type === "input").map((f) => f.data),
			)
			.toEqual(["l", "s"]);
		await expect(page.locator(".tab-pane.active")).toContainText("$ ls");
	});

	test("switching tabs attaches the other tab without dropping the first", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await page.locator("#terminal-tabs .tab-chip", { hasText: "Tab 2" }).click();
		await expect
			.poll(() => backend.terminalSockets.map((s) => `${s.tabId}:${s.closed}`))
			.toEqual(["tab-1:false", "tab-2:false"]);
		await expect(page.locator(".tab-pane.active")).toContainText("(tab-2)");
	});
});
