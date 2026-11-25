// The project's rail and its topics (3B F1): the rail as a project's entry
// (the sidebar on a wide screen, the project's screen on a phone), topics
// created / renamed / archived, a topic's own thread (isolated from the
// others, posting with its conversationId), the divider and the pill, the
// reader's place kept across visits, the read mark of what was seen, and
// the phone's stack project → topic under Back.

import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { CONV_IDS, type MockBackend, PROJECT_IDS } from "./mockBackend.js";

const HZ = PROJECT_IDS.hz;
const RAIL = `#/projects/${HZ}`;
const topic = (id: string) => `#/projects/${HZ}/c/${id}`;
const THREAD = "#project-view .ps-topic .acp-chat-thread";
const T0 = Date.parse("2026-10-31T10:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

/** The rail's body: in the sidebar (wide) or the project's screen (phone). */
const rail = (page: Page) => page.locator(".rail-body");
const convRow = (page: Page, title: string) =>
	rail(page).locator(".rail-conv", { has: page.locator(".rail-row-title", { hasText: title }) });

/** `n` answered requests to @arq in «Rediseño de UI/UX», all after its read mark. */
function longUnread(backend: MockBackend, n: number): void {
	for (let i = 0; i < n; i++)
		backend.addAcpMessage({
			to_id: "arq",
			body: `@arq punto ${i}: revisá esta parte del prototipo.\n\nCon detalle, línea por línea.`,
			state: "done",
			result_text: `Revisado el punto ${i}.\n\nTodo bien salvo un detalle de espaciado en el borde.`,
			project_id: HZ,
			conversation_id: CONV_IDS.ui,
			created_at: at(610 + i),
			finished_at: at(1000 + i * 10),
		});
}

async function scrollThread(page: Page, top: number): Promise<void> {
	await page.locator(THREAD).evaluate((t, y) => {
		t.scrollTop = y;
		t.dispatchEvent(new Event("scroll"));
	}, top);
}

test.describe("project rail and topics", () => {
	test.beforeEach(({ backend }) => backend.enableConversations());

	test("the rail: topics with their unread and state, the team in words, works, the Archive", async ({
		app,
		backend,
		page,
	}) => {
		backend.acpWorks = [
			{
				id: "ci-cache",
				agent: "dev",
				projectId: HZ,
				conversationId: CONV_IDS.ci,
				branch: "work/ci-cache",
				state: "active",
				createdAt: at(700),
				closedAt: null,
			},
			{
				id: "old-try",
				agent: "arq",
				projectId: HZ,
				conversationId: null,
				branch: "work/old-try",
				state: "closed",
				createdAt: at(100),
				closedAt: at(200),
			},
		];
		// Wide, the rail sits beside a topic («Optimización de CI» here, so the
		// unread one stays unread); a phone's project screen is the rail.
		await app.login("alice", app.mobile ? RAIL : topic(CONV_IDS.ci));
		await expect(rail(page)).toBeVisible();
		await expect(page.locator(".rail-project-name")).toHaveText("Educación HZ");
		// Most recently active first; «Rediseño» has an answer not seen yet.
		await expect(rail(page).locator(".rail-conv .rail-row-title")).toHaveText([
			"Rediseño de UI/UX",
			"Optimización de CI",
			"Mejoras del backend",
		]);
		await expect(convRow(page, "Rediseño de UI/UX").locator(".rail-unread")).toHaveText("1");
		await expect(convRow(page, "Optimización de CI")).toContainText("@dev trabajando…");
		// The seven words, never slots.
		const team = rail(page).locator(".rail-agent");
		await expect(team.filter({ hasText: "@arq" })).toContainText("disponible");
		await expect(team.filter({ hasText: "@dev" })).toContainText(
			app.mobile ? "ocupado en «Optimización de CI» · 1 en cola" : "trabajando aquí · 1 en cola",
		);
		// Works: the active one; the closed ones on demand.
		await expect(rail(page).locator(".rail-work")).toHaveCount(1);
		await expect(rail(page).locator(".rail-work")).toContainText("ci-cache");
		await expect(rail(page).locator(".rail-work")).toContainText("@dev · activo");
		await rail(page).getByRole("button", { name: "Ver cerrados (1)" }).click();
		await expect(rail(page).locator(".rail-work")).toHaveCount(2);
		await expect(rail(page).locator(".rail-archive-row")).toHaveAttribute(
			"href",
			`#/projects/${HZ}/archive`,
		);
		// Pendientes: wired to the inbox (an interruption to review counts).
		backend.addAcpMessage({
			to_id: "arq",
			body: "@arq migrá la tabla",
			state: "uncertain",
			project_id: HZ,
			conversation_id: CONV_IDS.backend,
		});
		backend.pushAcp({ type: "agents" });
		backend.pushAcp({ type: "message", message: backend.acpMessages.at(-1) });
		await expect(page.locator("#inbox-btn")).toHaveAttribute(
			"aria-label",
			"Pendientes: 1 te espera",
		);
		// The unseen answer of «Rediseño de UI/UX» is counted apart, never in the badge.
		await expect(page.locator(".rail-attention")).toHaveText("1 te espera · 1 resultado nuevo");
		await expect(team.filter({ hasText: "@arq" })).toContainText("ejecución interrumpida");
		expect(app.errors).toEqual([]);
	});

	test("a slot held by a process: the rail says «ocupado», the queue shown, the whole state on hover", async ({
		app,
		backend,
		page,
	}) => {
		const dev = backend.acpAgents.find((a) => a.name === "dev")!;
		dev.running = [];
		dev.runningIn = [];
		dev.heldBy = [{ conversationId: CONV_IDS.ci, work: null, since: at(1700) }];
		await app.login("alice", app.mobile ? RAIL : topic(CONV_IDS.backend));
		const state = rail(page).locator(".rail-agent", { hasText: "@dev" }).locator(".rail-state");
		await expect(state).toHaveText("ocupado · 1 en cola");
		await expect(state).toHaveAttribute(
			"title",
			"ocupado en «Optimización de CI» · proceso en curso · 1 en cola",
		);
	});

	test("create, rename and archive a topic", async ({ app, backend, page }) => {
		await app.login("alice", RAIL);
		await rail(page).getByRole("button", { name: "Nueva conversación" }).click();
		const field = page.locator(".dialog-card .modal-field input");
		await field.fill("Pruebas de carga");
		await page.locator(".dialog-card .modal-primary-action").click();
		await expect(page).toHaveURL(/#\/projects\/[^/]+\/c\/c0000000-/);
		const title = page.locator("#ps-topic-title");
		await expect(title).toHaveText("Pruebas de carga");
		// A new topic starts empty, with nobody chosen.
		await expect(page.locator(THREAD)).toContainText("Sin mensajes en esta conversación");
		const created = backend.acpConversations.at(-1)!;
		expect(created.title).toBe("Pruebas de carga");

		await page.getByRole("button", { name: "Acciones de la conversación" }).click();
		await page.getByRole("menuitem", { name: "Renombrar" }).click();
		await expect(field).toHaveValue("Pruebas de carga");
		await field.fill("Carga y estrés");
		await page.locator(".dialog-card .modal-primary-action").click();
		await expect(title).toHaveText("Carga y estrés");
		if (app.mobile) await page.locator(".ps-back").click();
		await expect(convRow(page, "Carga y estrés")).toHaveCount(1);
		if (app.mobile) await convRow(page, "Carga y estrés").click();

		await page.getByRole("button", { name: "Acciones de la conversación" }).click();
		await page.getByRole("menuitem", { name: "Archivar" }).click();
		await page.locator(".dialog-card .modal-danger-action").click();
		// The topic leaves the list (a phone goes back up to the rail; a wide
		// screen opens the project's most recent topic), readable on demand.
		if (app.mobile) await expect(page).toHaveURL(new RegExp(`${RAIL}$`));
		else await expect(page).toHaveURL(new RegExp(`/c/${CONV_IDS.ui}$`));
		await expect(convRow(page, "Carga y estrés")).toHaveCount(0);
		expect(created.archivedAt).not.toBeNull();
		await rail(page).getByRole("button", { name: "Conversaciones archivadas" }).click();
		await convRow(page, "Carga y estrés").click();
		await expect(page.locator("#project-view .ps-topic")).toContainText(
			"Conversación archivada · solo lectura",
		);
		await expect(page.locator("#project-view .acp-chat-input")).toBeHidden();
		expect(app.errors).toEqual([]);
	});

	test("a topic's thread is its own: what is posted there goes with its conversationId", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice", topic(CONV_IDS.ci));
		const thread = page.locator(THREAD);
		await expect(thread).toContainText("el job de e2e tarda 14 minutos");
		await expect(thread).not.toContainText("¿qué falta del prototipo?");
		// Live rows of another topic never show here.
		const other = backend.addAcpMessage({
			from_id: "arq",
			to_id: "dev",
			body: "Consulta en otro tema",
			project_id: HZ,
			conversation_id: CONV_IDS.ui,
		});
		backend.pushAcp({ type: "message", message: other });

		// No invisible routing: without a recipient nothing leaves.
		const input = page.locator("#project-view .acp-chat-input");
		await input.fill("sin destinatario");
		await page.locator("#project-view .acp-chat-send").click();
		await expect(page.locator("#project-view .acp-chat-error")).toHaveText(
			"Elegí a quién con + o @",
		);
		await input.fill("@arq @dev ¿cuánto cuesta el caché?");
		const post = page.waitForRequest(
			(r) => r.url().endsWith("/api/acp/messages") && r.method() === "POST",
		);
		await page.locator("#project-view .acp-chat-send").click();
		const body = (await post).postDataJSON() as Record<string, unknown>;
		expect(body).toMatchObject({
			conversationId: CONV_IDS.ci,
			to: ["arq", "dev"],
			body: "@arq @dev ¿cuánto cuesta el caché?",
		});
		expect(typeof body.clientId).toBe("string");
		await expect(thread.locator(".acp-mine").last()).toContainText("¿cuánto cuesta el caché?");
		await expect(thread).not.toContainText("Consulta en otro tema");
		// …and the other topic has it, not this post.
		if (app.mobile) await page.locator(".ps-back").click();
		await convRow(page, "Rediseño de UI/UX").click();
		await expect(thread).toContainText("Consulta en otro tema");
		await expect(thread).not.toContainText("¿cuánto cuesta el caché?");
		expect(app.errors).toEqual([]);
	});

	test("divider and pill on return; the read mark is only what was seen", async ({
		app,
		backend,
		page,
	}) => {
		longUnread(backend, 12);
		await app.login("alice", topic(CONV_IDS.ui));
		const divider = page.locator(`${THREAD} .acp-divider`);
		await expect(divider).toHaveText("Nuevos desde tu última visita");
		await expect(divider).toBeInViewport();
		// What is new below the view: «↓ N nuevos».
		const pill = page.locator("#project-view .ps-topic .chat-end");
		await expect(pill).toBeVisible();
		await expect(pill).toContainText(/^\d+ nuevos$/);
		// Only what reached the screen was marked: not the newest answer.
		const newest = at(1000 + 11 * 10);
		await expect.poll(() => backend.readMarks[CONV_IDS.ui]?.length ?? 0).toBeGreaterThan(0);
		expect(backend.readMarks[CONV_IDS.ui]!.every((m) => m < newest)).toBe(true);
		await pill.click();
		await expect(pill).toBeHidden();
		await expect.poll(() => backend.readMarks[CONV_IDS.ui]?.at(-1)).toBe(newest);
		// A new message while the reader is further up never moves them.
		await scrollThread(page, 200);
		await page.waitForTimeout(200);
		const top = await page.locator(THREAD).evaluate((t) => t.scrollTop);
		backend.addAcpMessage({
			from_id: "arq",
			to_id: "dev",
			body: "Nueva consulta",
			project_id: HZ,
			conversation_id: CONV_IDS.ui,
			created_at: at(1795),
		});
		backend.pushAcp({ type: "message", message: backend.acpMessages.at(-1) });
		await expect(pill).toContainText("1 nuevos");
		expect(await page.locator(THREAD).evaluate((t) => t.scrollTop)).toBe(top);
		expect(app.errors).toEqual([]);
	});

	test("leaving a topic and coming back keeps the reading place", async ({
		app,
		backend,
		page,
	}) => {
		longUnread(backend, 12);
		await app.login("alice", topic(CONV_IDS.ui));
		await expect(page.locator(`${THREAD} .acp-divider`)).toBeVisible();
		await scrollThread(page, 600);
		await page.waitForTimeout(300);
		const place = () =>
			page.locator(THREAD).evaluate((t) => {
				const top = t.getBoundingClientRect().top;
				const row = [...t.querySelectorAll<HTMLElement>(":scope > [data-anchor]")].find(
					(r) => r.getBoundingClientRect().bottom > top,
				)!;
				return {
					anchor: row.dataset.anchor,
					offset: Math.round(row.getBoundingClientRect().top - top),
				};
			});
		const before = await place();
		// Another topic, from the rail (a phone goes up the stack first).
		if (app.mobile) await page.locator(".ps-back").click();
		await convRow(page, "Optimización de CI").click();
		await expect(page.locator(THREAD)).toContainText("el job de e2e tarda");
		if (app.mobile) await page.locator(".ps-back").click();
		await convRow(page, "Rediseño de UI/UX").click();
		await expect(page.locator(THREAD)).toContainText("¿qué falta del prototipo?");
		await expect.poll(place).toEqual(before);
		expect(app.errors).toEqual([]);
	});

	test("wide: entering a project opens its last topic, else the most recent one", async ({
		app,
		page,
	}) => {
		test.skip(app.mobile, "a phone's project screen is the rail");
		await app.login("alice", RAIL);
		// Most recently active, in the project's place (no entry of its own).
		await expect(page).toHaveURL(new RegExp(`${topic(CONV_IDS.ui)}$`));
		await convRow(page, "Mejoras del backend").click();
		await expect(page.locator("#ps-topic-title")).toHaveText("Mejoras del backend");
		await page.goto(`/${RAIL}`);
		await expect(page).toHaveURL(new RegExp(`${topic(CONV_IDS.backend)}$`));
		expect(app.errors).toEqual([]);
	});

	test("a long topic title is cut in its row and in Equipo; the queue and the rail stay in the screen", async ({
		app,
		backend,
		page,
	}) => {
		const long = "Optimización del pipeline de CI: caché de navegadores y paralelismo de e2e";
		backend.acpConversations.find((c) => c.id === CONV_IDS.ci)!.title = long;
		await app.login("alice", app.mobile ? RAIL : topic(CONV_IDS.ui));
		const dev = rail(page).locator(".rail-agent", { hasText: "@dev" }).locator(".rail-state");
		await expect(dev).toContainText("1 en cola");
		const width = page.viewportSize()!.width;
		for (const box of [
			await rail(page).boundingBox(),
			await convRow(page, long).boundingBox(),
			await dev.locator(".rail-state-fixed").last().boundingBox(),
		])
			expect(box!.x + box!.width).toBeLessThanOrEqual(width);
		expect(app.errors).toEqual([]);
	});

	test("wide: a project without topics says so, with its one action", async ({
		app,
		backend,
		page,
	}) => {
		test.skip(app.mobile, "a phone's project screen is the rail");
		backend.acpConversations = [];
		await app.login("alice", RAIL);
		await expect(page.locator(".ps-home-title")).toHaveText("Sin conversaciones todavía");
		await expect(
			page.locator(".ps-home").getByRole("button", { name: "Nueva conversación" }),
		).toBeVisible();
	});

	test("a project that is not there says so, with no empty rail", async ({ app, page }) => {
		await app.login("alice", "#/projects/6b1f2c3d-0000-4000-8000-000000000999");
		await expect(page.locator(".ps-home-title")).toHaveText("Proyecto no encontrado");
		await expect(page.locator(".rail-body")).toBeHidden();
		await expect(page.getByRole("button", { name: "Nueva conversación" })).toBeHidden();
	});

	test("phone: Back follows the stack project → topic", async ({ app, page }) => {
		test.skip(!app.mobile, "the stack is the phone's");
		await app.login("alice", RAIL);
		await expect(page.locator(".ps-rail-slot .rail-body")).toBeVisible();
		await expect(page.locator("#header-project .rail-head")).toBeVisible();
		await convRow(page, "Optimización de CI").click();
		await expect(page).toHaveURL(new RegExp(`${topic(CONV_IDS.ci)}$`));
		await expect(page.locator(".ps-rail-slot .rail-body")).toBeHidden();
		await expect(page.locator("#header-project #ps-topic-title")).toHaveText("Optimización de CI");
		await page.goBack();
		await expect(page).toHaveURL(new RegExp(`${RAIL}$`));
		await expect(page.locator(".ps-rail-slot .rail-body")).toBeVisible();
		// ‹ is the same Back: no entry piles up.
		await convRow(page, "Mejoras del backend").click();
		await page.locator(".ps-back").click();
		await expect(page).toHaveURL(new RegExp(`${RAIL}$`));
		await page.goForward();
		await expect(page).toHaveURL(new RegExp(`${topic(CONV_IDS.backend)}$`));
		// Every target of the project's screen is at least 44 px tall.
		await page.goBack();
		const small = await page
			.locator(".ps-rail-slot a.rail-row, .ps-rail-slot button")
			.evaluateAll((els) =>
				els
					.filter((e) => (e as HTMLElement).offsetParent !== null)
					.filter((e) => e.getBoundingClientRect().height < 44)
					.map((e) => e.textContent),
			);
		expect(small).toEqual([]);
		expect(app.errors).toEqual([]);
	});
});
