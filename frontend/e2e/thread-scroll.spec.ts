import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { AGENT_IDS, type MockBackend, PROJECT_IDS, PROJECT_MSG_IDS } from "./mockBackend.js";

/**
 * Project Chat thread scroll (ThreadScroll in teamView.ts). Owner report
 * 2026-11-12: the conversation lost the reader's place. Before the fix the
 * thread opened at its OLDEST message, a live reply at the end was not
 * followed, and the phone keyboard pushed the end out of view.
 */

const PID = PROJECT_IDS.hz;
const TL = "#project-view .tw-timeline";
const followUp = (i: number) => `c9000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`;

function longThread(backend: MockBackend, n = 12): void {
	for (let i = 0; i < n; i++)
		backend.projectTask(
			followUp(i),
			[AGENT_IDS.developer],
			`Follow-up ${i}\n${"details ".repeat(30)}`,
			{ in_reply_to: PROJECT_MSG_IDS.polling },
		);
}

const metrics = (page: Page) =>
	page.locator(TL).evaluate((e) => ({ top: e.scrollTop, max: e.scrollHeight - e.clientHeight }));
const atEnd = async (page: Page) => {
	const m = await metrics(page);
	return m.max - m.top < 64;
};
/** Scroll like a reader (instant), to a fraction of the way down. */
const scrollTo = (page: Page, f: number) =>
	page.locator(TL).evaluate((e, f) => {
		e.style.scrollBehavior = "auto";
		e.scrollTop = Math.round((e.scrollHeight - e.clientHeight) * f);
		e.style.scrollBehavior = "";
		e.dispatchEvent(new Event("scroll"));
	}, f);
/** Where a row's top edge sits inside the timeline. */
const rowTop = (page: Page, text: string) =>
	page
		.locator(`${TL} > li`, { hasText: text })
		.first()
		.evaluate(
			(li) => li.getBoundingClientRect().top - li.parentElement!.getBoundingClientRect().top,
		);

test.describe("project chat — thread scroll", () => {
	test.beforeEach(async ({ backend }) => {
		await backend.enableProjectConversation();
		longThread(backend);
	});

	test("opens at the newest message and follows a live reply while the reader is at the end", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice", `#/projects/${PID}/threads/${PROJECT_MSG_IDS.polling}`);
		await expect(page.locator(TL)).toContainText("Follow-up 11");
		await expect.poll(() => atEnd(page)).toBe(true);
		await backend.projectReply(followUp(11), AGENT_IDS.developer, "A live reply.\n".repeat(10));
		await expect(page.locator(TL)).toContainText("A live reply.");
		await expect.poll(() => atEnd(page)).toBe(true);
		await expect(page.locator("#project-view .tw-newer")).toBeHidden();
	});

	test("a reader of earlier messages keeps their place; new rows are announced, not jumped to", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice", `#/projects/${PID}/threads/${PROJECT_MSG_IDS.polling}`);
		await expect(page.locator(TL)).toContainText("Follow-up 11");
		await scrollTo(page, 0.3);
		const reading = await page.locator(`${TL} > li`).evaluateAll((lis) => {
			const top = lis[0]!.parentElement!.getBoundingClientRect().top;
			const li = lis.find((l) => l.getBoundingClientRect().bottom > top + 1)!;
			return (
				li.querySelector(".tw-bubble")?.textContent?.split("\n")[0] ?? li.textContent!.slice(0, 20)
			);
		});
		const before = await rowTop(page, reading);
		await backend.projectReply(followUp(11), AGENT_IDS.developer, "A live reply.\n".repeat(10));
		await expect(page.locator(TL)).toContainText("A live reply.");
		expect(Math.abs((await rowTop(page, reading)) - before)).toBeLessThan(2);
		const pill = page.locator("#project-view .tw-newer");
		await expect(pill).toBeVisible();
		await expect(pill).toContainText("new");
		await pill.click();
		await expect.poll(() => atEnd(page)).toBe(true);
		await expect(pill).toBeHidden();
	});

	test("leaving a thread and coming back lands where the reader was", async ({ app, page }) => {
		await app.login("alice", `#/projects/${PID}/threads/${PROJECT_MSG_IDS.polling}`);
		await expect(page.locator(TL)).toContainText("Follow-up 11");
		await scrollTo(page, 0.25);
		const top = (await metrics(page)).top;
		await page.goto(`/#/projects/${PID}/threads/${PROJECT_MSG_IDS.backup}`);
		await expect(page.locator(TL)).toContainText("Check the VM backups");
		await page.goBack();
		await expect(page.locator(TL)).toContainText("Follow-up 11");
		await expect.poll(async () => Math.abs((await metrics(page)).top - top)).toBeLessThan(2);
	});

	test("leaving the workspace (Manage agents) and coming back keeps the place (independent review of #611)", async ({
		app,
		page,
	}) => {
		await app.login("alice", `#/projects/${PID}/threads/${PROJECT_MSG_IDS.polling}`);
		await expect(page.locator(TL)).toContainText("Follow-up 11");
		await scrollTo(page, 0.25);
		const top = (await metrics(page)).top;
		await page.goto(`/#/projects/${PID}/agents`);
		await expect(page.locator(TL)).toHaveCount(0);
		await page.goBack();
		await expect(page.locator(TL)).toContainText("Follow-up 11");
		await expect.poll(async () => Math.abs((await metrics(page)).top - top)).toBeLessThan(2);
	});

	test("phone keyboard: opening it keeps the end of the thread in view", async ({
		app,
		page,
		isMobile,
	}) => {
		test.skip(!isMobile, "the soft keyboard is a phone concern");
		await app.login("alice", `#/projects/${PID}/threads/${PROJECT_MSG_IDS.polling}`);
		await expect(page.locator(TL)).toContainText("Follow-up 11");
		await expect.poll(() => atEnd(page)).toBe(true);
		const textarea = page.locator("#project-view .tw-composer textarea").filter({ visible: true });
		await textarea.tap();
		// Android Chrome resizes the layout viewport for the keyboard; iOS
		// Safari pans the visual one instead (that needs a real device).
		const vp = page.viewportSize()!;
		await page.setViewportSize({ width: vp.width, height: 420 });
		await expect.poll(() => atEnd(page)).toBe(true);
		await expect(textarea).toBeInViewport();
		await expect(textarea).toBeFocused();
	});
});
