// The project's Archive (3B F5, acpArchive.ts): what was written before
// topics, read where it is — the previous Project Chat and each agent's
// previous direct messages, listed only when they have any; their thread
// is the topic's, without a message box or any action that writes;
// «Continuar en una conversación nueva» creates an empty topic and opens
// it; an interruption that lives there is still in Pendientes and is
// reviewed from there; a phone's stack project → Archivo → chat.

import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { CONV_IDS, PROJECT_IDS, PROJECT_SESSION_IDS } from "./mockBackend.js";

const HZ = PROJECT_IDS.hz;
const LIST = `#/projects/${HZ}/archive`;
const PAGE = "#project-view .ps-archive";
const rows = (page: Page) => page.locator(`${PAGE} .ps-archive-row`);

test.describe("the Archive", () => {
	test.beforeEach(({ backend }) => {
		backend.enableConversations();
		backend.enableArchive();
	});

	test("its list: the previous Project Chat and the agents' direct messages that exist, from the rail", async ({
		app,
		page,
	}) => {
		await app.login("alice", `#/projects/${HZ}`);
		await page.locator(".rail-body .rail-archive-row").click();
		await expect(page).toHaveURL(new RegExp(`${LIST}$`));
		await expect(page.locator("#ps-archive-title")).toHaveText("Archivo · solo lectura");
		// @dev has nothing outside topics: no entry. @solo is in no project.
		await expect(rows(page)).toHaveText([
			/Project Chat anterior.*hasta 31\/10\/2026 · solo lectura/,
			/@arq · chat individual.*solo lectura/,
		]);
		if (!app.mobile)
			await expect(page.locator(".rail-body .rail-archive-row")).toHaveAttribute(
				"aria-current",
				"page",
			);
	});

	test("a chat is read only: the topic's thread, no message box; an interruption reviewed as in a topic", async ({
		app,
		backend,
		page,
	}) => {
		backend.addAcpMessage({
			to_id: "arq",
			body: "Migrá la tabla de sesiones",
			state: "uncertain",
			note: "El runner se reinició.",
			created_at: "2026-10-31T10:06:00Z",
		});
		await app.login("alice", LIST);
		await rows(page).filter({ hasText: "@arq" }).click();
		await expect(page).toHaveURL(new RegExp(`${LIST}/@arq$`));
		await expect(page.locator("#ps-archive-title")).toHaveText("@arq · chat individual");
		const thread = page.locator(`${PAGE} .acp-chat-thread`);
		// Only its direct messages (the Project Chat's «@arq revisá el diseño» is the other chat).
		await expect(thread.locator(".acp-post")).toHaveCount(3);
		await expect(thread).not.toContainText("revisá el diseño");
		await expect(thread.locator(".acp-result")).toContainText("OAuth con PKCE");
		// No box, no chips: the strip says so, with «Continuar…».
		await expect(page.locator(`${PAGE} .acp-chat-input`)).toBeHidden();
		await expect(page.locator(`${PAGE} .acp-to-row`)).toBeHidden();
		// The same «Revisar interrupción» as in a topic, the same dialog.
		await thread.getByRole("button", { name: "Revisar interrupción" }).click();
		await expect(page.locator(".acp-review-card")).toBeVisible();
		await app.escape();
		const strip = page.locator(`${PAGE} .ps-readonly`);
		await expect(strip).toContainText("Archivo · solo lectura");
		await expect(strip.getByRole("button")).toHaveText("Continuar en una conversación nueva");
	});

	test("«Continuar en una conversación nueva»: an empty topic, its title proposed, opened", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice", `${LIST}/project`);
		await expect(page.locator("#ps-archive-title")).toHaveText("Project Chat anterior");
		await page.getByRole("button", { name: "Continuar en una conversación nueva" }).click();
		const field = page.locator(".dialog-card .modal-field input");
		await expect(field).toHaveValue("Continuación de Project Chat anterior");
		await field.fill("Login: segunda vuelta");
		await page.locator(".dialog-card .modal-primary-action").click();
		await expect(page.locator("#ps-topic-title")).toHaveText("Login: segunda vuelta");
		const created = backend.acpConversations.find((c) => c.title === "Login: segunda vuelta")!;
		expect(created.projectId).toBe(HZ);
		await expect(page).toHaveURL(new RegExp(`#/projects/${HZ}/c/${created.id}$`));
		// Nothing copied: no message, no recipient, an empty box.
		expect(backend.acpMessages.filter((m) => m.conversation_id === created.id)).toEqual([]);
		await expect(page.locator("#project-view .ps-topic .acp-msg")).toHaveCount(0);
		await expect(page.locator("#project-view .ps-topic .acp-chat-input")).toHaveValue("");
		await expect(page.locator("#project-view .ps-topic .acp-to-chips .acp-chip")).toHaveCount(0);
		// Back: the archived chat, where it was.
		await page.goBack();
		await expect(page.locator("#ps-archive-title")).toHaveText("Project Chat anterior");
	});

	test("continuing an agent's chat: «Para:» comes with that agent; the box is empty", async ({
		app,
		page,
	}) => {
		await app.login("alice", `${LIST}/@arq`);
		await page.getByRole("button", { name: "Continuar en una conversación nueva" }).click();
		await expect(page.locator(".dialog-card .modal-field input")).toHaveValue(
			"Continuación de @arq · chat individual",
		);
		await expect(page.locator(".dialog-card .dialog-cancel")).toHaveText("Cancelar");
		await page.locator(".dialog-card .modal-primary-action").click();
		await expect(page.locator("#ps-topic-title")).toHaveText(
			"Continuación de @arq · chat individual",
		);
		const chips = page.locator("#project-view .ps-topic .acp-to-chips .acp-chip");
		await expect(chips).toHaveCount(1);
		await expect(chips).toContainText("@arq");
		await expect(page.locator("#project-view .ps-topic .acp-chat-input")).toHaveValue("");
	});

	test("an open question in the Archive: «Responder en Pendientes» opens Pendientes", async ({
		app,
		backend,
		page,
	}) => {
		const asking = backend.addAcpMessage({
			to_id: "arq",
			body: "Elegí el proveedor",
			state: "running",
		});
		backend.acpQuestions = [
			{
				id: 7,
				agent: "arq",
				message_id: asking.id,
				request: JSON.stringify({
					message: "¿Qué proveedor?",
					requestedSchema: { type: "object", properties: {} },
				}),
				state: "open",
				answer: null,
				created_at: "2026-10-31T10:29:30Z",
				answered_at: null,
				delivered_at: null,
				note: null,
			},
		];
		await app.login("alice", `${LIST}/@arq`);
		const card = page.locator(`${PAGE} .acp-question-open`);
		await expect(card).toContainText("espera tu respuesta · Responder en Pendientes");
		await expect(card.locator("form")).toHaveCount(0);
		await card.getByRole("button", { name: "Responder en Pendientes" }).click();
		await expect(page.locator(".acp-inbox-card")).toBeVisible();
	});

	test("an interruption in the Archive is in Pendientes: reviewed there, seen in its chat", async ({
		app,
		backend,
		page,
	}) => {
		const cut = backend.addAcpMessage({
			to_id: "arq",
			body: "Migrá la tabla de sesiones",
			state: "uncertain",
			note: "El runner se reinició.",
			created_at: "2026-10-31T10:06:00Z",
		});
		await app.login("alice", `#/projects/${HZ}`);
		await expect(page.locator("#inbox-btn .inbox-count")).toHaveText("1");
		await page.locator("#inbox-btn").click();
		const item = page.locator(".acp-inbox-card .acp-ib-item.is-interrupted");
		await expect(item.locator(".acp-ib-where")).toHaveText(
			"Educación HZ › Archivo › @arq · chat individual",
		);
		// «Ver en el Archivo»: the agent's chat, the message highlighted.
		await item.getByRole("button", { name: "Ver en el Archivo" }).click();
		await expect(page).toHaveURL(new RegExp(`${LIST}/@arq$`));
		await expect(
			page.locator(`${PAGE} [data-ids~="${cut.id}"]`).filter({ hasText: "Migrá la tabla" }),
		).toBeFocused();
		// Reviewed from Pendientes: it leaves the count.
		await page.locator("#inbox-btn").click();
		await item.getByRole("button", { name: "Revisar interrupción" }).click();
		await page
			.locator(".acp-review-card")
			.getByRole("button", { name: "Dar por revisada, sin reencolar" })
			.click();
		await expect
			.poll(() => backend.acpMessages.find((m) => m.id === cut.id)?.reviewed_at)
			.toBeTruthy();
		await expect(page.locator("#inbox-btn .inbox-count")).toBeHidden();
	});

	test("an agent without a project: its interruption is in Pendientes, with no place to go", async ({
		app,
		backend,
		page,
	}) => {
		backend.addAcpMessage({ to_id: "solo", body: "Ordená el README", state: "uncertain" });
		await app.login("alice", `#/projects/${HZ}`);
		await page.locator("#inbox-btn").click();
		const item = page.locator(".acp-inbox-card .acp-ib-item.is-interrupted");
		await expect(item).toContainText("Ordená el README");
		await expect(item.getByRole("button", { name: "Revisar interrupción" })).toBeVisible();
		await expect(item.getByRole("button", { name: /^Ver en/ })).toHaveCount(0);
	});

	test("a phone: leaving a topic or the Archive for a session hides the header's project slot", async ({
		app,
		page,
	}) => {
		test.skip(!app.mobile, "a phone");
		for (const hash of [`${LIST}/@arq`, `#/projects/${HZ}/c/${CONV_IDS.ci}`]) {
			await app.login("alice", hash);
			await expect(page.locator("#header-project")).toBeVisible();
			await page.goto(`/#/sessions/${PROJECT_SESSION_IDS.architect}/terminal`);
			await expect(page.locator("#header-project")).toBeHidden();
			// The session bar's ⋯ is reachable (nothing covers it).
			await page.locator("#session-menu-btn").click();
			await expect(page.getByRole("menuitem", { name: /^Ajustes del agente/ })).toBeVisible();
			await app.escape();
		}
	});

	test("a phone's stack: project → Archivo → chat, one ‹ in the header at each step", async ({
		app,
		page,
	}) => {
		test.skip(!app.mobile, "a phone");
		await app.login("alice", `#/projects/${HZ}`);
		await page.locator(".rail-body .rail-archive-row").click();
		const back = page.locator("#header-project .ps-back");
		await expect(back).toHaveAccessibleName("Volver al proyecto");
		await rows(page).filter({ hasText: "Project Chat" }).click();
		await expect(back).toHaveAccessibleName("Volver al Archivo");
		await expect(page.locator("#header-project #ps-archive-title")).toHaveText(
			"Project Chat anterior",
		);
		// The only way back on screen is the header's ‹ (no second one in the page).
		await expect(page.locator("#project-view .ps-back")).toHaveCount(0);
		await back.click();
		await expect(page.locator("#ps-archive-title")).toHaveText("Archivo · solo lectura");
		await back.click();
		await expect(page.locator(".rail-body")).toBeVisible();
		await expect(page).toHaveURL(new RegExp(`#/projects/${HZ}$`));
	});
});
