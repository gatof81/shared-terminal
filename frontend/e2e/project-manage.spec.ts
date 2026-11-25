// Managing a project from its rail's selector ▾ (projectRail.openSelector):
// rename without a reload, and an archive dialog that says it cannot be undone.

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

		await openMenuItem(page, "Renombrar este proyecto");
		const field = page.locator(".dialog-card .modal-field input");
		await expect(field).toHaveValue("Educación HZ");
		await field.fill("HZ 2026");
		if (SHOTS) await page.screenshot({ path: `${SHOTS}/${info.project.name}-rename.png` });
		await page.locator(".dialog-card .modal-primary-action").click();
		await expect(page.locator(".dialog-card")).toHaveCount(0);
		await expect(name).toHaveText("HZ 2026");
		await expect(page).toHaveTitle(/HZ 2026/);
		await expect(page.locator(".sgroup-head", { hasText: "HZ 2026" })).toHaveCount(1);

		// The project was archived elsewhere meanwhile: the error is by the field.
		backend.projects[0]!.archivedAt = "2026-11-19T00:00:00Z";
		await openMenuItem(page, "Renombrar este proyecto");
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
		await openMenuItem(page, "Archivar este proyecto");
		const body = page.locator(".dialog-card .dialog-body");
		await expect(body).toContainText("no se puede deshacer desde la app");
		await expect(body).toContainText("Sus agentes quedan sin proyecto");
		if (SHOTS) await page.screenshot({ path: `${SHOTS}/${info.project.name}-archive-dialog.png` });
		await page.locator(".dialog-card .dialog-cancel").click();
		await expect(page.locator(".rail-project-name")).toHaveText("Educación HZ");
	});
});
