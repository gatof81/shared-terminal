// «Sin conexión en vivo · reintentando…» (revisión 2 §10): a line under the
// project's header (and in Pendientes) only when /ws/acp stays down 3 s, then
// «Conectado» for 1 s when it comes back. A short blip shows nothing.

import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { CONV_IDS, PROJECT_IDS } from "./mockBackend.js";

const topic = `#/projects/${PROJECT_IDS.hz}/c/${CONV_IDS.ui}`;
const DOWN = "Sin conexión en vivo · reintentando…";
const SHOTS = process.env.ACP_SHOTS;

/** Every text any banner showed since the call (a flicker included). */
async function recordBanners(page: Page): Promise<() => Promise<string[]>> {
	await page.evaluate(() => {
		const w = window as unknown as { bannerTexts: string[] };
		w.bannerTexts = [];
		new MutationObserver(() => {
			for (const b of document.querySelectorAll(".acp-live-banner"))
				if (b.textContent) w.bannerTexts.push(b.textContent);
		}).observe(document.body, { subtree: true, childList: true, characterData: true });
	});
	return () => page.evaluate(() => (window as unknown as { bannerTexts: string[] }).bannerTexts);
}

test.describe("the live connection's banner", () => {
	test.beforeEach(({ backend }) => backend.enableConversations());

	test("a sustained outage: shown after 3 s under the header, then «Conectado»", async ({
		app,
		page,
		backend,
	}, info) => {
		const shot = async (name: string) =>
			SHOTS && (await page.screenshot({ path: `${SHOTS}/${info.project.name}-${name}.png` }));
		await app.login("alice", topic);
		await expect(page.locator("#project-view .ps-topic .acp-chat-thread")).toContainText(
			"¿qué falta del prototipo?",
		);
		const banner = page.locator(".acp-live-banner").filter({ hasText: DOWN });
		await expect(page.locator(".acp-live-banner").first()).toHaveText("");

		backend.acpRefuseSockets = true;
		backend.dropAcpSockets();
		const since = Date.now();
		await expect(banner).toBeVisible({ timeout: 8_000 });
		expect(Date.now() - since).toBeGreaterThanOrEqual(2_900);
		await expect(banner).toHaveAttribute("role", "status");
		const box = (await banner.boundingBox())!;
		expect(box.height).toBeGreaterThanOrEqual(23);
		expect(box.height).toBeLessThanOrEqual(26);
		// Under the project's header: the app header on a phone, the rail's head wide.
		const head = page.locator(app.mobile ? "#header-project" : "#project-rail .rail-head");
		const headBox = (await head.boundingBox())!;
		expect(box.y).toBeGreaterThanOrEqual(headBox.y + headBox.height - 1);
		// Not on top of the terminal: the banner is the project's, inside its views.
		expect(await banner.evaluate((b) => !!b.closest("#terminal-container"))).toBe(false);
		await shot("live-down");

		// Pendientes says it too.
		await page.locator("#inbox-btn").click();
		await expect(page.locator(".acp-inbox-card .acp-live-banner")).toHaveText(DOWN);
		await shot("live-down-inbox");
		await page.locator(".acp-inbox-card .modal-close").click();

		backend.acpRefuseSockets = false;
		const back = page.locator(".acp-live-banner").filter({ hasText: "Conectado" }).first();
		await expect(back).toBeVisible({ timeout: 15_000 });
		await shot("live-back");
		await expect(page.locator(".acp-live-banner").first()).toHaveText("", { timeout: 2_500 });
	});

	test("a blip that reconnects within 3 s shows nothing", async ({ app, page, backend }) => {
		await app.login("alice", topic);
		await expect(page.locator("#project-view .ps-topic .acp-chat-thread")).toContainText(
			"¿qué falta del prototipo?",
		);
		const texts = await recordBanners(page);
		const sockets = backend.acpSockets.length;
		backend.dropAcpSockets();
		// The first retry comes 1 s later and says hello.
		await expect.poll(() => backend.acpSockets.length, { timeout: 5_000 }).toBe(sockets);
		await page.waitForTimeout(3_500);
		expect(await texts()).toEqual([]);
	});
});
