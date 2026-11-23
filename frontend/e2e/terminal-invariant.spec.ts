import { expect, test } from "./fixtures.js";

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
