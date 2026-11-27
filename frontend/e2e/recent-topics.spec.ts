// «Seguir donde estabas» and «Recientes» (revisión 2 §7): the last topic or
// Herramientas address is offered on the home (a phone's row above
// Proyectos, a wide screen's empty area) and in the project selector; it
// never opens by itself, a pick is a new history entry, and what is gone
// (an archived project, a topic no longer live) is skipped and dropped.

import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { CONV_IDS, type MockBackend, PROJECT_IDS } from "./mockBackend.js";

const HZ = PROJECT_IDS.hz;
const OTRO = "6b1f2c3d-0000-4000-8000-0000000000a2";
const PLAN = "c0000000-0000-4000-8000-0000000000a1";
const topic = (p: string, id: string) => `#/projects/${p}/c/${id}`;
const THREAD = "#project-view .ps-topic .acp-chat-thread";
const SHOTS = process.env.ACP_SHOTS;

/** A second project, «Otro», with one topic «Plan de pruebas». */
function addOtro(backend: MockBackend): void {
	backend.projects.push({
		projectId: OTRO,
		ownerUserId: "u-alice",
		name: "Otro",
		createdAt: new Date(Date.parse("2026-10-31T08:00:00Z")).toISOString(),
	});
	backend.acpConversations.push({
		id: PLAN,
		projectId: OTRO,
		title: "Plan de pruebas",
		createdAt: "2026-10-31T09:00:00Z",
		archivedAt: null,
		readAt: null,
		recipients: null,
	});
}

/** What the home offers: the phone's row, or the wide empty area's card. */
const resume = (page: Page, mobile: boolean) =>
	page.locator(mobile ? "#resume-row" : "#empty-state .resume-card");

const stored = (page: Page) =>
	page.evaluate(() => JSON.parse(localStorage.getItem("st.recent") ?? "[]") as { hash: string }[]);

async function goHome(page: Page): Promise<void> {
	await page.goto("/");
	await expect(page.locator("#app-view")).toBeVisible();
}

test.describe("«Seguir donde estabas» and «Recientes»", () => {
	test.beforeEach(({ backend }) => backend.enableConversations());

	test("the home offers the last topic, never opens it, and a tap is a new entry", async ({
		app,
		page,
	}, info) => {
		await app.login("alice", topic(HZ, CONV_IDS.ci));
		await expect(page.locator(THREAD)).toContainText("implementalo");
		await goHome(page);
		const row = resume(page, app.mobile);
		await expect(row).toHaveText(/Seguir en «Optimización de CI» · Educación HZ\s*›/);
		const box = (await row.boundingBox())!;
		expect(box.height).toBeGreaterThanOrEqual(56);
		if (app.mobile) {
			const projects = (await page.locator("#session-list .sgroup-projects").boundingBox())!;
			expect(box.y + box.height).toBeLessThanOrEqual(projects.y);
		} else await expect(page.locator("#empty-state")).not.toContainText("Elegí un proyecto");
		// Nothing opened by itself: the home is still the home.
		await page.waitForTimeout(500);
		expect(new URL(page.url()).hash).toBe("");
		if (SHOTS) await page.screenshot({ path: `${SHOTS}/${info.project.name}-resume.png` });
		await row.click();
		await expect(page).toHaveURL(new RegExp(`${topic(HZ, CONV_IDS.ci)}$`));
		await expect(page.locator(THREAD)).toContainText("implementalo");
		await page.goBack();
		await expect.poll(() => new URL(page.url()).hash).toBe("");
	});

	test("a long project name is cut after the topic's title, never before it", async ({
		app,
		page,
		backend,
	}, info) => {
		backend.projects[0]!.name = "Educación HZ — plataforma de cursos y evaluaciones";
		await app.login("alice", topic(HZ, CONV_IDS.ci));
		await expect(page.locator(THREAD)).toContainText("implementalo");
		await goHome(page);
		const row = resume(page, app.mobile);
		await expect(row).toBeVisible();
		// «Seguir en «Optimización de CI»» fits whole.
		// Measured unrounded: a fraction of a pixel is enough for the «…».
		const fits = await row.locator(".resume-text").evaluate((e) => {
			const r = document.createRange();
			r.selectNodeContents(e);
			return r.getBoundingClientRect().width <= e.getBoundingClientRect().width + 0.01;
		});
		expect(fits).toBe(true);
		if (SHOTS) await page.screenshot({ path: `${SHOTS}/${info.project.name}-resume-long.png` });
	});

	test("Herramientas is resumed where it was", async ({ app, page }) => {
		const git = `${topic(HZ, CONV_IDS.ci)}/tools/dev/~/git`;
		await app.login("alice", git);
		await expect(page.locator(".tools-bar")).toBeVisible();
		await goHome(page);
		const row = resume(page, app.mobile);
		await expect(row).toHaveText(/Seguir en Git de @dev · Educación HZ/);
		await row.click();
		await expect(page).toHaveURL(new RegExp(`${git}$`));
	});

	test("the selector's «Recientes»: another project's topic in one pick", async ({
		app,
		page,
		backend,
	}, info) => {
		addOtro(backend);
		await app.login("alice", topic(OTRO, PLAN));
		await expect(page.locator(".ps-topic-title")).toHaveText("Plan de pruebas");
		// Into Educación HZ's screen (the rail: where the selector is on a phone too).
		await page.evaluate((h) => {
			window.location.hash = h;
		}, `#/projects/${HZ}`);
		await expect(page.locator(".rail-project-name")).toHaveText("Educación HZ");
		await page.locator(".rail-project").click();
		const menu = page.locator('[role="menu"].action-menu');
		await expect(menu.locator(".action-menu-caption").first()).toHaveText("Recientes");
		await expect(menu.locator(".action-menu-caption").nth(1)).toHaveText("Cambiar de proyecto");
		const recent = menu.locator('[data-action^="r:"]');
		await expect(recent).toHaveCount(1);
		// The place, with its project as the quiet hint (as «Seguir…» shows it).
		await expect(recent.locator(".actions-menu-item-title")).toHaveText("«Plan de pruebas»");
		await expect(recent.locator(".actions-menu-item-hint")).toHaveText("Otro");
		await expect(recent).toHaveAccessibleName("«Plan de pruebas» · Otro");
		if (SHOTS) await page.screenshot({ path: `${SHOTS}/${info.project.name}-recientes.png` });
		await recent.click();
		await expect(page).toHaveURL(new RegExp(`${topic(OTRO, PLAN)}$`));
		await page.goBack();
		await expect(page).toHaveURL(new RegExp(`/projects/${HZ}(/c/[^/]+)?$`));
	});

	test("an archived project and a topic no longer live are skipped and dropped", async ({
		app,
		page,
		backend,
	}) => {
		addOtro(backend);
		await app.login("alice", topic(HZ, CONV_IDS.ui));
		await expect(page.locator(THREAD)).toContainText("¿qué falta del prototipo?");
		// Older visits: Otro's topic, and an HZ topic that is gone now.
		await page.evaluate(
			([a, b]) => {
				const list = JSON.parse(localStorage.getItem("st.recent") ?? "[]");
				list.unshift({ hash: a, title: "Plan de pruebas" }, { hash: b, title: "Viejo" });
				localStorage.setItem("st.recent", JSON.stringify(list));
			},
			[topic(OTRO, PLAN), topic(HZ, "c0000000-0000-4000-8000-0000000000ff")],
		);
		backend.projects.find((p) => p.projectId === OTRO)!.archivedAt = "2026-11-01T00:00:00Z";
		// The rail re-reads HZ's live topics (a new topic is one more): «Viejo» is not there.
		await page.reload();
		await expect(page.locator(THREAD)).toContainText("¿qué falta del prototipo?");
		await expect
			.poll(async () => (await stored(page)).map((e) => e.hash))
			.toEqual([topic(HZ, CONV_IDS.ui)]);
		await page
			.locator(app.mobile ? ".ps-back" : ".rail-project")
			.first()
			.isVisible();
	});

	test("a topic archived elsewhere (a live frame) leaves the list at once", async ({
		app,
		page,
		backend,
	}) => {
		addOtro(backend);
		await app.login("alice", topic(OTRO, PLAN));
		await expect(page.locator(".ps-topic-title")).toHaveText("Plan de pruebas");
		await page.evaluate(
			(h) => {
				window.location.hash = h;
			},
			topic(HZ, CONV_IDS.ui),
		);
		await expect(page.locator(THREAD)).toContainText("¿qué falta del prototipo?");
		expect((await stored(page)).map((e) => e.hash)).toContain(topic(OTRO, PLAN));
		const plan = backend.acpConversations.find((c) => c.id === PLAN)!;
		backend.pushAcp({
			type: "conversation",
			conversation: { ...plan, archivedAt: "2026-11-01T00:00:00Z", lastActivityAt: plan.createdAt },
		});
		await expect
			.poll(async () => (await stored(page)).map((e) => e.hash))
			.toEqual([topic(HZ, CONV_IDS.ui)]);
	});
});
