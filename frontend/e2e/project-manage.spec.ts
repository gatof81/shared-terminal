// Managing a project from its rail's selector (projectRail.openSelector, a
// menu anchored under the rail's head): rename without a reload, an archive
// dialog that says it cannot be undone, and the menu itself — its project
// list as radios, the keyboard, and the phone's variant.

import { expect, test } from "./fixtures.js";
import { PROJECT_IDS } from "./mockBackend.js";

const SHOTS = process.env.PROJECT_SHOTS;
const HZ = PROJECT_IDS.hz;

/** Renombrar / Archivar live in the selector's menu. */
async function openMenuItem(page: import("@playwright/test").Page, item: string): Promise<void> {
	await page.locator(".rail-project").click();
	await page.getByRole("menuitem", { name: item }).click();
}

test.describe("project management", () => {
	test("rename: the selector, tab title and sidebar follow without a reload; an error leaves the name", async ({
		page,
		app,
		backend,
	}, info) => {
		await app.login("alice", `#/projects/${HZ}`);
		const name = page.locator(".rail-project-name");
		await expect(name).toHaveText("Educación HZ");

		await openMenuItem(page, "Renombrar…");
		const field = page.locator(".dialog-card .modal-field input");
		await expect(field).toHaveValue("Educación HZ");
		await field.fill("HZ 2026");
		if (SHOTS) await page.screenshot({ path: `${SHOTS}/${info.project.name}-rename.png` });
		await page.locator(".dialog-card .modal-primary-action").click();
		await expect(page.locator(".dialog-card")).toHaveCount(0);
		await expect(name).toHaveText("HZ 2026");
		await expect(page).toHaveTitle(/HZ 2026/);
		await expect(page.locator("a.project-row", { hasText: "HZ 2026" })).toHaveCount(1);

		// The project was archived elsewhere meanwhile: the error is by the field.
		backend.projects[0]!.archivedAt = "2026-11-19T00:00:00Z";
		await openMenuItem(page, "Renombrar…");
		await field.fill("Otro");
		await page.locator(".dialog-card .modal-primary-action").click();
		await expect(page.locator(".dialog-card .modal-field-error")).toHaveText(
			"El proyecto ya no existe o fue archivado.",
		);
		await page.locator(".dialog-card .dialog-cancel").click();
		await expect(name).toHaveText("HZ 2026");
	});

	test("the archive dialog says it cannot be undone", async ({ page, app }, info) => {
		await app.login("alice", `#/projects/${HZ}`);
		await openMenuItem(page, "Archivar proyecto…");
		const body = page.locator(".dialog-card .dialog-body");
		await expect(body).toContainText("no se puede deshacer desde la app");
		await expect(body).toContainText("Sus agentes quedan sin proyecto");
		if (SHOTS) await page.screenshot({ path: `${SHOTS}/${info.project.name}-archive-dialog.png` });
		await page.locator(".dialog-card .dialog-cancel").click();
		await expect(page.locator(".rail-project-name")).toHaveText("Educación HZ");
	});

	test("the selector is a menu anchored under the head: radios, ✓ on the current one, keyboard, a switch", async ({
		page,
		app,
		backend,
	}) => {
		backend.projects.push({
			projectId: "p-otro",
			ownerUserId: "u-alice",
			name: "Otro proyecto",
			createdAt: "2026-10-31T08:00:00Z",
		});
		await app.login("alice", `#/projects/${HZ}`);
		const selector = page.locator(".rail-project");
		await expect(selector).toHaveAttribute("aria-expanded", "false");
		await selector.click();
		const menu = page.locator('[role="menu"].action-menu-anchored');
		await expect(menu).toBeVisible();
		await expect(selector).toHaveAttribute("aria-expanded", "true");
		await expect(menu).toHaveAccessibleName("Cambiar de proyecto");
		const radios = menu.getByRole("menuitemradio");
		await expect(radios).toHaveCount(2);
		const current = radios.filter({ hasText: "Educación HZ" });
		await expect(current).toHaveAttribute("aria-checked", "true");
		await expect(current.locator(".action-menu-check")).toHaveText("✓");
		await expect(radios.filter({ hasText: "Otro proyecto" })).toHaveAttribute(
			"aria-checked",
			"false",
		);
		// The focus starts on the current project; the arrows walk every item.
		await expect(current).toBeFocused();
		await page.keyboard.press("ArrowDown");
		await expect(radios.filter({ hasText: "Otro proyecto" })).toBeFocused();
		await page.keyboard.press("ArrowDown");
		await expect(menu.getByRole("menuitem", { name: "+ Proyecto nuevo" })).toBeFocused();
		// The actions in their order, the destructive one last.
		await expect(menu.getByRole("menuitem")).toHaveText([
			"+ Proyecto nuevo",
			"Renombrar…",
			"Archivar proyecto…",
		]);
		// Anchored, not a centred card: right under the head (wide) or the app's header (phone).
		const box = (await menu.boundingBox())!;
		const under = app.mobile
			? (await page.locator("header").boundingBox())!
			: (await page.locator("#project-rail .rail-head").boundingBox())!;
		expect(Math.abs(box.y - (under.y + under.height + (app.mobile ? 0 : 4)))).toBeLessThanOrEqual(
			2,
		);
		if (app.mobile) {
			const vw = await page.evaluate(() => document.documentElement.clientWidth);
			expect(Math.round(box.x)).toBe(8);
			expect(Math.round(box.width)).toBe(vw - 16);
		}
		// Escape closes it and gives the focus back to the selector.
		await page.keyboard.press("Escape");
		await expect(menu).toHaveCount(0);
		await expect(selector).toBeFocused();
		await expect(selector).toHaveAttribute("aria-expanded", "false");
		// Tab out closes it too.
		await selector.click();
		await expect(current).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(menu).toHaveCount(0);
		// Another project: its page.
		await selector.click();
		await radios.filter({ hasText: "Otro proyecto" }).click();
		await expect(page).toHaveURL(/#\/projects\/p-otro/);
		await expect(page.locator(".rail-project-name")).toHaveText("Otro proyecto");
	});
});
