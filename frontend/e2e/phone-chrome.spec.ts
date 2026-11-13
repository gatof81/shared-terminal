import { expect, test } from "./fixtures.js";

/**
 * Phone chrome (UX audit 2026-11-13, N3 / M6): the drawer uses the screen
 * it has, and a toast never sits on the controls at the bottom edge.
 */
test.describe("phone chrome", () => {
	test.beforeEach(({ app }) => {
		test.skip(!app.mobile, "the narrow-screen layout");
	});

	test("the drawer is as wide as the phone allows, minus a 44-px strip to tap it closed", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		for (const width of [320, 390, 430]) {
			await page.setViewportSize({ width, height: 800 });
			await app.openSidebar();
			const box = (await page.locator("#sidebar").boundingBox())!;
			expect(box.width, `drawer at ${width}px`).toBe(Math.min(380, width - 44));
			// The strip beside it is the backdrop: a tap there closes the drawer.
			await page.mouse.click(width - 20, 400);
			await expect.poll(() => app.sidebarOpen()).toBe(false);
		}
	});

	test("a toast shows under the header, clear of the key bar", async ({ app, page }) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		// The harness has no WebGL: opening a terminal raises the renderer notice.
		const toast = page.locator("#toast .toast-item").first();
		await expect(toast).toBeVisible();
		const t = (await toast.boundingBox())!;
		const keys = (await page.locator("#key-bar").boundingBox())!;
		expect(t.y + t.height).toBeLessThanOrEqual(keys.y);
		expect(t.y).toBeLessThan(200);
		// Inside the screen on both sides.
		const vw = page.viewportSize()!.width;
		expect(t.x).toBeGreaterThanOrEqual(0);
		expect(t.x + t.width).toBeLessThanOrEqual(vw);
	});
});
