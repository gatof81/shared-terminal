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

		if (app.mobile && app.shell === "v1") {
			// v1 mobile: the ONLY way from the Terminal into an overlay is the
			// chrome drawer (header pill → toolbar + tabs), and showing/hiding
			// that drawer changes the terminal's box — so this first hop does
			// resize. It is the layout cost the shell v2 (roadmap PR 6: view
			// tabs in a one-line session bar, no drawer) removes; the number
			// below is the target it must bring to zero.
			await app.switchView("files");
			await page.waitForTimeout(400);
			test.info().annotations.push({
				type: "v1-mobile-drawer-resizes",
				description: `${resizes()} resize frame(s) during Terminal → Files via the chrome drawer`,
			});
			expect(resizes(), "the drawer hop resizes in v1 mobile").toBeGreaterThan(0);
		}

		// From here on: pure view switches. Nothing may reach the terminal.
		const framesBefore = sock.sent.length;
		const rowsBefore = await page.locator(".tab-pane.active .xterm-rows > div").count();
		const r0 = resizes();
		const i0 = inputs();
		// Overlay ⇄ overlay and overlay → Terminal are pure on both layouts;
		// Terminal → overlay is pure on desktop and on shell v2 (the view tabs
		// are always on screen) — on v1 mobile it is the drawer hop above.
		const pureEntry = !app.mobile || app.shell === "v2";
		if (pureEntry) await app.switchView("files");
		await app.switchView("git");
		await app.switchView("chat");
		await app.switchView("terminal");
		if (pureEntry) {
			await app.switchView("chat");
			await app.switchView("terminal");
		}
		await page.waitForTimeout(400);

		expect(backend.terminalSockets.length, "no new terminal socket").toBe(sockets);
		expect(sock.closed, "the attach stayed open").toBe(false);
		expect(resizes() - r0, "no resize sent by a view switch").toBe(0);
		expect(inputs() - i0, "no input sent by a view switch").toBe(0);
		expect(sock.sent.length - framesBefore, "no frame of any kind").toBe(0);
		expect(await page.locator(".tab-pane.active .xterm-rows > div").count()).toBe(rowsBefore);
		// Output that arrives while an overlay is up still lands in the terminal.
		await app.switchView("chat");
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
		await app.openChrome();
		await page.locator("#terminal-tabs .tab-chip", { hasText: "Tab 2" }).click();
		await expect
			.poll(() => backend.terminalSockets.map((s) => `${s.tabId}:${s.closed}`))
			.toEqual(["tab-1:false", "tab-2:false"]);
		await expect(page.locator(".tab-pane.active")).toContainText("(tab-2)");
	});
});
