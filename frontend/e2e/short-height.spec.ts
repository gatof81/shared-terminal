import { expect, test } from "./fixtures.js";
import { AGENT_IDS, PROJECT_IDS, PROJECT_MSG_IDS } from "./mockBackend.js";

/**
 * Owner report 2026-11-13: on the phone, focusing the Project Chat input
 * "sends it to the top". With the keyboard up an iPhone shows ~300–380 px
 * of the app; the thread's title and composer took it all — the
 * conversation shrank to 28 px and at 290 px the composer did not fit.
 * (The visual-viewport pan itself needs a real iPhone; the space problem
 * reproduces at these heights.)
 */
test.describe("project chat — short heights (phone keyboard)", () => {
	test.beforeEach(async ({ backend }) => {
		await backend.enableProjectConversation();
		for (let i = 0; i < 8; i++)
			backend.projectTask(
				`c9000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
				[AGENT_IDS.developer],
				`Follow-up ${i}\n${"details ".repeat(30)}`,
				{ in_reply_to: PROJECT_MSG_IDS.polling },
			);
	});

	for (const height of [380, 330, 290])
		test(`${height} px: the conversation keeps room and the composer fits`, async ({ app, page, isMobile }) => {
			test.skip(!isMobile, "the soft keyboard is a phone concern");
			await app.login("alice", `#/projects/${PROJECT_IDS.hz}/threads/${PROJECT_MSG_IDS.polling}`);
			const textarea = page.locator("#project-view .tw-composer textarea").filter({ visible: true });
			await textarea.tap();
			await page.setViewportSize({ width: 390, height });
			// The app follows the new height on a resize event (main.ts --app-vh):
			// measure only once it has, or the old layout would pass.
			await expect
				.poll(() => page.evaluate(() => document.body.getBoundingClientRect().height))
				.toBeLessThanOrEqual(height + 1);
			const timeline = page.locator("#project-view .tw-timeline");
			await expect
				.poll(() => timeline.evaluate((e) => e.clientHeight))
				.toBeGreaterThanOrEqual(height >= 330 ? 90 : 60);
			const composer = page.locator("#project-view .tw-composer").filter({ visible: true });
			await expect
				.poll(async () => {
					const b = (await composer.boundingBox())!;
					return b.y + b.height;
				})
				.toBeLessThanOrEqual(height + 1);
			await expect(textarea).toBeInViewport({ ratio: 1 });
			await expect(textarea).toBeFocused();
			// The folded head stays one short line (the phone density rules once
			// came later in the CSS and undid it).
			const head = (await page.locator("#project-view .tw-main-head").boundingBox())!;
			expect(head.height).toBeLessThanOrEqual(42);
			// "@" opens the recipient picker above the field: the field stays on screen.
			await textarea.pressSequentially("@");
			await expect(page.locator("#project-view .tw-picker").filter({ visible: true })).toBeVisible();
			await expect(textarea).toBeInViewport({ ratio: 1 });
		});
});
