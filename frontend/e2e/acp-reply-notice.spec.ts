// «@dev respondió en «…» · Ver» (revisión 2 §8): a live answer to the
// person in a topic that is not on screen. Grouped when several arrive, gone
// after 6 s, Ver is a history entry (Back returns). Never for the topic on
// screen, a (re)load, or over the terminal.

import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { CONV_IDS, type MockBackend, PROJECT_IDS } from "./mockBackend.js";

const HZ = PROJECT_IDS.hz;
const topic = (id: string) => `#/projects/${HZ}/c/${id}`;
const THREAD = "#project-view .ps-topic .acp-chat-thread";
const NOTICE = ".acp-reply-notice";
const SHOTS = process.env.ACP_SHOTS;

/** @dev's running message in «Optimización de CI» finishes (pushed live). */
function finishCi(backend: MockBackend): void {
	const run = backend.acpMessages.find((m) => m.body.includes("implementalo"))!;
	backend.updateAcpMessage(run.id, {
		state: "done",
		result_text: "Listo: caché de navegadores en el job.",
		finished_at: new Date().toISOString(),
	});
}

async function openUi(page: Page, app: { login: (u: "alice", h: string) => Promise<void> }) {
	await app.login("alice", topic(CONV_IDS.ui));
	await expect(page.locator(THREAD)).toContainText("¿qué falta del prototipo?");
}

test.describe("an answer in another topic", () => {
	test.beforeEach(({ backend }) => backend.enableConversations());

	test("says who answered where; Ver opens it as a new entry and Back returns", async ({
		app,
		page,
		backend,
	}, info) => {
		await openUi(page, app);
		const scroller = page.locator(THREAD);
		const before = await scroller.evaluate((t) => [t.scrollTop, t.clientHeight]);
		finishCi(backend);
		const notice = page.locator(NOTICE);
		await expect(notice).toHaveText(/@dev respondió en «Optimización de CI»\s*·\s*Ver/);
		await expect(page.locator(".acp-reply-anchor")).toHaveAttribute("role", "status");
		const box = (await notice.boundingBox())!;
		expect(box.height).toBeGreaterThanOrEqual(44);
		if (app.mobile) {
			// Right above the message box, over the thread: nothing in it moved.
			const composer = (await page.locator("#project-view .acp-chat-composer").boundingBox())!;
			expect(box.y + box.height).toBeLessThanOrEqual(composer.y + 1);
			expect(composer.y - (box.y + box.height)).toBeLessThanOrEqual(12);
		} else {
			// Top right, under the topic's header: its ⋯ stays clear.
			const vw = page.viewportSize()!.width;
			expect(box.x + box.width).toBeGreaterThan(vw - 40);
			const head = (await page.locator(".ps-topic-head").boundingBox())!;
			expect(box.y).toBeGreaterThanOrEqual(head.y + head.height);
			expect(box.y).toBeLessThan(head.y + head.height + 40);
		}
		expect(await scroller.evaluate((t) => [t.scrollTop, t.clientHeight])).toEqual(before);
		if (SHOTS) await page.screenshot({ path: `${SHOTS}/${info.project.name}-reply-notice.png` });

		await notice.click();
		await expect(page).toHaveURL(new RegExp(`${topic(CONV_IDS.ci)}$`));
		await expect(page.locator(THREAD)).toContainText("caché de navegadores");
		await expect(notice).toHaveCount(0);
		await page.goBack();
		await expect(page).toHaveURL(new RegExp(`${topic(CONV_IDS.ui)}$`));
		await expect(page.locator(THREAD)).toContainText("¿qué falta del prototipo?");
	});

	test("several group into one line, and it leaves after 6 s", async ({
		app,
		page,
		backend,
	}, info) => {
		await openUi(page, app);
		finishCi(backend);
		const other = backend.addAcpMessage({
			to_id: "arq",
			body: "@arq mirá el endpoint",
			state: "running",
			project_id: HZ,
			conversation_id: CONV_IDS.backend,
		});
		backend.pushAcp({ type: "message", message: other });
		backend.updateAcpMessage(other.id, { state: "done", result_text: "Visto." });
		const notice = page.locator(NOTICE);
		await expect(notice).toHaveText(/2 respuestas nuevas\s*·\s*Ver/);
		if (SHOTS) await page.screenshot({ path: `${SHOTS}/${info.project.name}-reply-notice-2.png` });
		await expect(notice).toHaveCount(0, { timeout: 8_000 });
	});

	test("nothing for the topic on screen, a reload, a reconnect or Herramientas", async ({
		app,
		page,
		backend,
	}) => {
		await app.login("alice", topic(CONV_IDS.ci));
		await expect(page.locator(THREAD)).toContainText("implementalo");
		// The topic on screen: the thread shows it, no notice.
		finishCi(backend);
		await expect(page.locator(THREAD)).toContainText("caché de navegadores");
		await expect(page.locator(NOTICE)).toHaveCount(0);
		// A reconnect re-reads every page: done rows there are not news.
		backend.dropAcpSockets();
		await expect.poll(() => backend.acpSockets.length, { timeout: 5_000 }).toBeGreaterThan(0);
		await page.reload();
		await expect(page.locator(THREAD)).toContainText("caché de navegadores");
		// Herramientas (the terminal's place): no notice there.
		const q = backend.addAcpMessage({
			to_id: "arq",
			body: "@arq una más",
			state: "running",
			project_id: HZ,
			conversation_id: CONV_IDS.ui,
		});
		await page.evaluate(
			(h) => {
				window.location.hash = h;
			},
			`${topic(CONV_IDS.ci)}/tools/dev/~/terminal`,
		);
		await expect(page.locator(".tools-bar")).toBeVisible();
		backend.updateAcpMessage(q.id, { state: "done", result_text: "Hecho." });
		await page.waitForTimeout(1_000);
		await expect(page.locator(NOTICE)).toHaveCount(0);
	});
});
