// Managing a project from its page: rename without a reload, an archive dialog
// that says it cannot be undone, and an archived project's history read-only
// at its own address — told apart from "not found" and from a failed load.

import { expect, test } from "./fixtures.js";
import { PROJECT_IDS } from "./mockBackend.js";

const SHOTS = process.env.PROJECT_SHOTS;
const HZ = PROJECT_IDS.hz;

/** Renombrar / Archivar live in the project's ⋯ menu. */
async function openMenuItem(page: import("@playwright/test").Page, item: string): Promise<void> {
	await page.getByRole("button", { name: "Acciones del proyecto" }).click();
	await page.getByRole("menuitem", { name: item }).click();
}

test.describe("project management", () => {
	test.beforeEach(({ backend }) => {
		backend.enableAcp();
		backend.addAcpMessage({
			to_id: "arq",
			body: "@arq ¿cómo encaramos el login?",
			project_id: HZ,
			state: "done",
			result_text: "Con OAuth y PKCE.",
		});
	});

	test("rename: header, tab title and sidebar follow without a reload; an error leaves the name", async ({
		page,
		app,
		backend,
	}, info) => {
		await app.login("alice", `#/projects/${HZ}`);
		const title = page.locator("#pv-title");
		await expect(title).toHaveText("Educación HZ");
		await expect(page.locator(".acp-project .acp-chat-input")).toBeEnabled();

		await openMenuItem(page, "Renombrar");
		const field = page.locator(".dialog-card .modal-field input");
		await expect(field).toHaveValue("Educación HZ");
		await field.fill("HZ 2026");
		if (SHOTS) await page.screenshot({ path: `${SHOTS}/${info.project.name}-rename.png` });
		await page.locator(".dialog-card .modal-primary-action").click();
		await expect(page.locator(".dialog-card")).toHaveCount(0);
		await expect(title).toHaveText("HZ 2026");
		await expect(page).toHaveTitle(/HZ 2026/);
		await expect(page.locator(".sgroup-head", { hasText: "HZ 2026" })).toHaveCount(1);

		// The project was archived elsewhere meanwhile: the error is by the field.
		backend.projects[0]!.archivedAt = "2026-11-19T00:00:00Z";
		await openMenuItem(page, "Renombrar");
		await field.fill("Otro");
		await page.locator(".dialog-card .modal-primary-action").click();
		await expect(page.locator(".dialog-card .modal-field-error")).toHaveText(
			"El proyecto ya no existe o fue archivado.",
		);
		await page.locator(".dialog-card .dialog-cancel").click();
		await expect(title).toHaveText("HZ 2026");
	});

	test("the archive dialog says it cannot be undone and where the history stays", async ({
		page,
		app,
	}, info) => {
		await app.login("alice", `#/projects/${HZ}`);
		await openMenuItem(page, "Archivar");
		const body = page.locator(".dialog-card .dialog-body");
		await expect(body).toContainText("no se puede deshacer desde la app");
		await expect(body).toContainText("chat de cada agente");
		await expect(body).toContainText("URL de este proyecto");
		if (SHOTS) await page.screenshot({ path: `${SHOTS}/${info.project.name}-archive-dialog.png` });
		await page.locator(".dialog-card .dialog-cancel").click();
		await expect(page.locator("#pv-title")).toHaveText("Educación HZ");
	});

	test("an archived project's address shows its history read-only, under its real name", async ({
		page,
		app,
		backend,
	}, info) => {
		backend.projects[0]!.archivedAt = "2026-11-19T00:00:00Z";
		for (const a of backend.acpAgents) if (a.projectId === HZ) a.projectId = null;
		await app.login("alice", `#/projects/${HZ}`);
		await expect(page.locator("#pv-title")).toHaveText("Educación HZ");
		await expect(page.locator(".pv-status-archived")).toHaveText(
			"Proyecto archivado · solo lectura",
		);
		await expect(
			page.locator(".acp-project .acp-msg", { hasText: "Con OAuth y PKCE." }),
		).toBeVisible();
		await expect(page.locator(".acp-project .acp-chat-input")).toBeHidden();
		await expect(page.locator(".acp-project .acp-chat-send")).toBeHidden();
		await expect(page.getByRole("button", { name: "Acciones del proyecto" })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "+ Nueva sesión con agente" })).toHaveCount(0);
		if (SHOTS) await page.screenshot({ path: `${SHOTS}/${info.project.name}-archived.png` });
	});

	test("a project that does not exist is 'not found'", async ({ page, app }) => {
		await app.login("alice", "#/projects/6b1f2c3d-0000-4000-8000-000000000999");
		await expect(page.locator(".pv-status-error")).toHaveText("Proyecto no encontrado.");
		await expect(page.locator(".pv-status-archived")).toHaveCount(0);
		await expect(page.locator(".acp-project .acp-chat-input")).toBeHidden();
	});

	test("a re-read that fails keeps the history on screen, the box locked, and Reintentar recovers", async ({
		page,
		app,
		backend,
	}) => {
		await app.login("alice", `#/projects/${HZ}`);
		const said = page.locator(".acp-project .acp-msg", { hasText: "Con OAuth y PKCE." });
		await expect(said).toBeVisible();
		await expect(page.locator(".acp-project .acp-chat-input")).toBeEnabled();
		// The live socket drops; its reconnect re-reads the feed, which now fails.
		backend.projectFeedFailure = 503;
		backend.dropAcpSockets();
		const status = page.locator(".pv-status-error");
		await expect(status).toContainText("No se pudo actualizar el proyecto.");
		await expect(said).toBeVisible();
		// The header says it, once: the message box does not repeat it (with the server's code).
		await expect(page.locator(".acp-project .acp-chat-error")).toBeHidden();
		await expect(
			page.locator(".acp-project").getByText(/No se pudo actualizar (el chat|:)/),
		).toBeHidden();
		await expect(page.locator(".acp-project .acp-chat-input")).toBeDisabled();
		await expect(page.getByRole("button", { name: "Acciones del proyecto" })).toHaveCount(0);
		backend.projectFeedFailure = 0;
		await status.getByRole("button", { name: "Reintentar" }).click();
		await expect(page.locator(".acp-project .acp-chat-input")).toBeEnabled();
		await expect(status).toHaveCount(0);
	});

	test("a failed feed is an error with Reintentar — never 'archived' or 'not found'", async ({
		page,
		app,
		backend,
	}) => {
		backend.projectFeedFailure = 500;
		await app.login("alice", `#/projects/${HZ}`);
		const status = page.locator(".pv-status-error");
		await expect(status).toContainText("No se pudo cargar el proyecto.");
		await expect(page.locator(".pv-status-archived")).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Acciones del proyecto" })).toHaveCount(0);
		await expect(page.locator(".acp-project .acp-chat-input")).toBeHidden();
		// One message: no thread under it — not its "no messages yet" (unknown, the
		// feed never answered) nor its own copy of the error with the server's code.
		await expect(page.locator(".acp-project .acp-thread")).toBeHidden();
		const project = page.locator(".acp-project");
		await expect(project.getByText(/Sin mensajes/)).toBeHidden();
		await expect(project.getByText(/internal/)).toBeHidden();
		backend.projectFeedFailure = 0;
		await status.getByRole("button", { name: "Reintentar" }).click();
		await expect(page.locator(".acp-project .acp-chat-input")).toBeEnabled();
		await expect(page.getByRole("button", { name: "Acciones del proyecto" })).toBeVisible();
	});
});
