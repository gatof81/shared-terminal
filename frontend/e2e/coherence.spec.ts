import type { Page } from "@playwright/test";
import { expect, FIXED_NOW, test } from "./fixtures.js";
import { CONV_IDS, PROJECT_IDS, SESSION_IDS } from "./mockBackend.js";

/**
 * What the keyboard reaches and what the address says agree with the
 * screen: a phone's closed drawer is out of Tab's reach (inert), a topic of
 * a project that is gone has no message box (its draft kept), and an
 * address that names nothing is said and replaced by what is shown.
 */

/** Tab `n` times from the top of the page; whether the focus ever landed in the sidebar. */
async function tabReachesSidebar(page: Page, n = 40): Promise<boolean> {
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	for (let i = 0; i < n; i++) {
		await page.keyboard.press("Tab");
		if (
			await page.evaluate(() =>
				document.getElementById("sidebar")!.contains(document.activeElement),
			)
		)
			return true;
	}
	return false;
}

const sidebarInert = (page: Page) =>
	page.locator("#sidebar").evaluate((el) => (el as HTMLElement).inert);

test.describe("the phone's drawer and the keyboard", () => {
	test("closed: nothing of it takes the focus; open, or as the home, it does", async ({
		app,
		page,
	}) => {
		test.skip(!app.mobile, "a phone's drawer");
		await app.login("alice", `#/sessions/${SESSION_IDS.stopped}/files`);
		await app.expectView("files");
		expect(await app.sidebarOpen()).toBe(false);
		expect(await sidebarInert(page)).toBe(true);
		expect(await tabReachesSidebar(page)).toBe(false);

		await app.openSidebar();
		expect(await sidebarInert(page)).toBe(false);
		expect(await tabReachesSidebar(page)).toBe(true);

		// The home: the list is the screen.
		await page.goto("/");
		await expect(page.locator("body")).toHaveClass(/home-on/);
		expect(await sidebarInert(page)).toBe(false);
		expect(await tabReachesSidebar(page)).toBe(true);
	});

	test("phone ⇄ wide with the drawer open or closed never leaves it inert", async ({
		app,
		page,
	}) => {
		test.skip(!app.mobile, "starts on a phone");
		const phone = page.viewportSize()!;
		await app.login("alice", `#/sessions/${SESSION_IDS.stopped}/files`);
		await app.expectView("files");
		expect(await sidebarInert(page)).toBe(true);
		await page.setViewportSize({ width: 1280, height: 800 });
		await expect.poll(() => sidebarInert(page)).toBe(false);
		await page.setViewportSize(phone);
		await expect.poll(() => sidebarInert(page)).toBe(true);

		await app.openSidebar();
		expect(await sidebarInert(page)).toBe(false);
		await page.setViewportSize({ width: 1280, height: 800 });
		await expect.poll(() => sidebarInert(page)).toBe(false);
		expect(await tabReachesSidebar(page)).toBe(true);
	});

	test("a wide screen's sidebar is a column of the layout: never inert", async ({ app, page }) => {
		test.skip(app.mobile, "wide screen");
		await app.login("alice", `#/sessions/${SESSION_IDS.stopped}/files`);
		await app.expectView("files");
		expect(await sidebarInert(page)).toBe(false);
		expect(await tabReachesSidebar(page)).toBe(true);
	});
});

test.describe("a topic of a project archived elsewhere", () => {
	test("its message box goes off with its note, and the draft stays", async ({
		app,
		backend,
		page,
	}) => {
		backend.enableAcp();
		backend.enableConversations();
		// The project list is re-read on a 60 s clock: the page's clock runs.
		await page.clock.install({ time: new Date(FIXED_NOW) });
		const P = "#project-view .ps-topic";
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}/c/${CONV_IDS.backend}`);
		const input = page.locator(`${P} .acp-chat-input`);
		await expect(input).toBeEnabled();
		await input.fill("borrador sin enviar");

		// Archived from another tab: only the backend knows.
		const p = backend.projects.find((x) => x.projectId === PROJECT_IDS.hz)!;
		p.archivedAt = new Date(FIXED_NOW).toISOString();
		for (let left = 61_000; left > 0; left -= 1_000) {
			await page.clock.runFor(1_000);
			await page.waitForTimeout(5);
		}

		await expect(page.locator(`${P} .acp-chat-composer`)).toHaveClass(/acp-composer-off/);
		await expect(input).toBeHidden();
		await expect(page.locator(`${P} .pv-status`)).toHaveText(
			"Proyecto archivado o inexistente · solo lectura",
		);
		await expect(input).toHaveValue("borrador sin enviar");
	});
});

test.describe("an address that names nothing", () => {
	test("an unknown session with a session open: the bar names the session shown", async ({
		app,
		page,
	}) => {
		await app.login("alice", `#/sessions/${SESSION_IDS.stopped}/files`);
		await app.expectView("files");
		await page.evaluate((h) => {
			window.location.hash = h;
		}, `#/sessions/${SESSION_IDS.bob}/files`);
		await expect(app.toast("No se encontró la sesión")).toBeVisible();
		await expect.poll(() => page.url()).not.toContain(SESSION_IDS.bob);
		if (app.mobile) {
			// A phone: no address is its home, the list as the screen.
			await expect.poll(() => new URL(page.url()).hash).toBe("");
			await expect(page.locator("body")).toHaveClass(/home-on/);
		} else {
			await expect
				.poll(() => new URL(page.url()).hash)
				.toBe(`#/sessions/${SESSION_IDS.stopped}/files`);
			await expect(page.locator("#terminal-session-name")).toHaveText("docs");
		}
	});

	test("a garbage address is said and leaves the bar", async ({ app, page }) => {
		await app.login("alice", "#/garbage/x");
		await expect(app.toast("No se encontró la dirección")).toBeVisible();
		await expect.poll(() => new URL(page.url()).hash).toBe("");

		// Typed while a session is open: replaced by that session's address.
		await app.openSession("docs");
		await expect.poll(() => new URL(page.url()).hash).toMatch(/^#\/sessions\//);
		await page.evaluate(() => {
			window.location.hash = "#/garbage/y";
		});
		await expect(app.toast("No se encontró la dirección").first()).toBeVisible();
		if (app.mobile) await expect.poll(() => new URL(page.url()).hash).toBe("");
		else
			await expect
				.poll(() => new URL(page.url()).hash)
				.toMatch(new RegExp(`^#/sessions/${SESSION_IDS.stopped}`));
	});
});
