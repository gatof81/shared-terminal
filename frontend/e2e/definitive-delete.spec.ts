// Definitive deletion (#13): an ARCHIVED topic from its ⋯ in «Conversaciones
// archivadas», and an Archive chat with «Vaciar…» — never one tap: the
// person types the topic's title, the project's name or the @agent. What is
// still in course stays (the server refuses a topic in use with its reasons).

import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { CONV_IDS, PROJECT_IDS } from "./mockBackend.js";

const HZ = PROJECT_IDS.hz;
const rail = (page: Page) => page.locator(".rail-body");
const archivedRow = (page: Page, title: string) =>
	rail(page)
		.locator("li")
		.filter({ has: page.locator(".rail-conv.is-archived", { hasText: title }) });
const dialog = (page: Page) => page.locator(".dialog-card");

test.describe("definitive deletion", () => {
	test.beforeEach(({ backend }) => {
		backend.enableConversations();
		backend.enableArchive();
	});

	test("an archived topic: ⋯ → «Eliminar definitivamente…», confirmed by typing its title", async ({
		app,
		backend,
		page,
	}) => {
		const c = backend.acpConversations.find((x) => x.id === CONV_IDS.backend)!;
		c.archivedAt = "2026-10-31T11:00:00Z";
		await app.login("alice", `#/projects/${HZ}`);
		await rail(page).getByRole("button", { name: "Conversaciones archivadas" }).click();
		const row = archivedRow(page, "Mejoras del backend");
		await row.getByRole("button", { name: "Más acciones de «Mejoras del backend»" }).click();
		await page.getByRole("menuitem", { name: "Eliminar definitivamente…" }).click();
		await expect(dialog(page)).toContainText("Se borran para siempre");
		const confirm = dialog(page).locator(".modal-danger-action");
		await expect(confirm).toBeDisabled();
		const field = dialog(page).locator(".dialog-require input");
		await field.fill("Mejoras");
		await expect(confirm).toBeDisabled();
		await field.fill("Mejoras del backend");
		await confirm.click();
		await expect(row).toHaveCount(0);
		expect(backend.acpConversations.some((x) => x.id === CONV_IDS.backend)).toBe(false);
		expect(backend.requests.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual([
			`/acp/conversations/${CONV_IDS.backend}`,
		]);
		expect(app.errors).toEqual([]);
	});

	test("a topic still in use is not deleted: the reasons are said", async ({
		app,
		backend,
		page,
	}) => {
		const c = backend.acpConversations.find((x) => x.id === CONV_IDS.ci)!;
		c.archivedAt = "2026-10-31T11:00:00Z";
		await app.login("alice", `#/projects/${HZ}`);
		await rail(page).getByRole("button", { name: "Conversaciones archivadas" }).click();
		await archivedRow(page, "Optimización de CI")
			.getByRole("button", { name: "Más acciones de «Optimización de CI»" })
			.click();
		await page.getByRole("menuitem", { name: "Eliminar definitivamente…" }).click();
		await dialog(page).locator(".dialog-require input").fill("Optimización de CI");
		await dialog(page).locator(".modal-danger-action").click();
		await expect(page.locator("#toast")).toContainText(
			"Todavía no se puede eliminar: tiene un mensaje pendiente o en curso.",
		);
		expect(backend.acpConversations.some((x) => x.id === CONV_IDS.ci)).toBe(true);
		await expect(archivedRow(page, "Optimización de CI")).toHaveCount(1);
	});

	test("an Archive chat: «Vaciar…», confirmed by typing @agent; what is in course stays", async ({
		app,
		backend,
		page,
	}) => {
		const running = backend.addAcpMessage({
			to_id: "arq",
			body: "Sigue en curso",
			state: "running",
		});
		await app.login("alice", `#/projects/${HZ}/archive/@arq`);
		await page.getByRole("button", { name: "Vaciar…" }).click();
		await expect(dialog(page)).toContainText("historial del chat individual de @arq");
		await expect(dialog(page)).toContainText("con otros agentes");
		const confirm = dialog(page).locator(".modal-danger-action");
		await dialog(page).locator(".dialog-require input").fill("arq");
		await expect(confirm).toBeDisabled();
		await dialog(page).locator(".dialog-require input").fill("@arq");
		await confirm.click();
		await expect(page.locator("#toast")).toContainText("quedan 1 en curso");
		const thread = page.locator("#project-view .ps-archive .acp-chat-thread");
		await expect(thread).not.toContainText("OAuth con PKCE");
		await expect(thread).toContainText("Sigue en curso");
		expect(
			backend.acpMessages.filter((m) => !m.conversation_id && !m.project_id && m.to_id === "arq"),
		).toEqual([running]);
	});

	test("the previous Project Chat: «Vaciar…» typing the project's name, then back to the list", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice", `#/projects/${HZ}/archive/project`);
		await page.getByRole("button", { name: "Vaciar…" }).click();
		await expect(dialog(page)).toContainText("Project Chat anterior");
		await dialog(page).locator(".dialog-require input").fill("Educación HZ");
		await dialog(page).locator(".modal-danger-action").click();
		await expect(page).toHaveURL(new RegExp(`#/projects/${HZ}/archive$`));
		expect(backend.acpMessages.filter((m) => !m.conversation_id && m.project_id === HZ)).toEqual(
			[],
		);
		await expect(page.locator("#project-view .ps-archive-row")).toHaveText([
			/@arq · chat individual/,
		]);
	});
});
