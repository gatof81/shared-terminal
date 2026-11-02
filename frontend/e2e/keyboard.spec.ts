import { expect, test } from "./fixtures.js";

/**
 * The mobile soft keyboard, as far as Chromium can reproduce it. Playwright
 * cannot raise a real keyboard nor make Chromium pan the visual viewport
 * the way iOS Safari does, so `window.visualViewport` is replaced before the
 * app loads by an EventTarget whose height/offsetTop the test sets — the
 * same two numbers Safari reports with the keyboard up and the view panned
 * to the focused field. What this proves: the app follows those numbers
 * (layout in the visible band, no safe-area strip), and the covered
 * terminal sends nothing to tmux while Chat is shown. What only the device
 * proves: Safari's own pan and its timing — see docs/MOBILE_KEYBOARD.md.
 */

test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => {
		const target = new EventTarget() as EventTarget & {
			width: number;
			height: number;
			offsetTop: number;
			offsetLeft: number;
			pageTop: number;
			pageLeft: number;
			scale: number;
		};
		Object.assign(target, {
			width: window.innerWidth,
			height: window.innerHeight,
			offsetTop: 0,
			offsetLeft: 0,
			pageTop: 0,
			pageLeft: 0,
			scale: 1,
		});
		Object.defineProperty(window, "visualViewport", { configurable: true, value: target });
		(window as unknown as { __kb: (h: number, top: number) => void }).__kb = (h, top) => {
			target.height = h;
			target.offsetTop = top;
			target.pageTop = top;
			target.dispatchEvent(new Event("resize"));
			target.dispatchEvent(new Event("scroll"));
		};
	});
});

async function keyboard(page: import("@playwright/test").Page, height: number, offsetTop: number) {
	await page.evaluate(
		([h, t]) => {
			(window as unknown as { __kb: (h: number, top: number) => void }).__kb(h, t);
		},
		[height, offsetTop] as const,
	);
}

test.describe("soft keyboard (simulated visual viewport)", () => {
	test.skip(({ isMobile }) => !isMobile, "mobile layouts");

	test("the app lays out in the visible band: body follows the panned viewport, no bottom safe-area strip", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("chat");
		await page.locator("#chat-list .chat-conv-row", { hasText: "Refactor auth flow" }).click();
		const ta = page.locator(".chat-composer textarea");
		await expect(ta).toBeVisible();

		// Keyboard up, Safari panned the view 300 px down to reveal the field.
		const viewport = page.viewportSize()!;
		const visible = viewport.height - 380;
		await keyboard(page, visible, 300);
		await expect(page.locator("html")).toHaveAttribute("data-kb", "open");
		const body = await page.locator("body").boundingBox();
		expect(Math.round(body!.y), "body starts at the top of the visible band").toBe(300);
		expect(Math.round(body!.height)).toBe(visible);
		const taBox = await ta.boundingBox();
		// v1 keeps its bottom view bar (#view-nav) above the keyboard: the
		// composer ends at the bar, not at the keyboard (a known v1 cost).
		const nav = page.locator("#view-nav");
		const keyboardTop = (await nav.isVisible()) ? (await nav.boundingBox())!.y : 300 + visible;
		expect(taBox!.y + taBox!.height, "the composer is inside the visible band").toBeLessThanOrEqual(
			keyboardTop + 1,
		);
		expect(
			keyboardTop - (taBox!.y + taBox!.height),
			"no gap above the keyboard beyond the composer's own padding",
		).toBeLessThan(24);

		// Keyboard down: back to the full height, no offset, flag cleared.
		await keyboard(page, viewport.height, 0);
		await expect(page.locator("html")).not.toHaveAttribute("data-kb", "open");
		expect(Math.round((await page.locator("body").boundingBox())!.y)).toBe(0);
	});

	test("a reader at the bottom stays at the bottom when the keyboard shrinks the thread; one reading earlier keeps their place", async ({
		app,
		backend,
		page,
	}) => {
		// Enough messages for the thread to scroll.
		const conv = backend.conversations[0]!;
		for (let i = 0; i < 40; i++) {
			conv.events.push({
				seq: (conv.events.at(-1)?.seq ?? 0) + 1,
				ts: conv.events.at(-1)!.ts,
				ev: "assistant_delta",
				prompt_id: `p-k${i}`,
				turn_id: `t-k${i}`,
				agent_id: null,
				pane: "%1",
				data: { message_id: `mk${i}`, index: 0, delta: `Filler message ${i}`, final: true },
			});
		}
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("chat");
		await page.locator("#chat-list .chat-conv-row", { hasText: "Refactor auth flow" }).click();
		const sc = page.locator("#chat-thread .chat-scroll");
		await expect(sc).toContainText("Filler message 39");
		const gap = () =>
			sc.evaluate((el) => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop));
		await expect.poll(gap).toBeLessThan(4);

		const viewport = page.viewportSize()!;
		await keyboard(page, viewport.height - 380, 0);
		await expect.poll(gap, "the last message stayed in view").toBeLessThan(4);
		// With the keyboard up, a new message still sticks to the bottom.
		backend.pushConversationEvent(conv.cid, {
			ts: conv.events.at(-1)!.ts,
			ev: "assistant_delta",
			prompt_id: "p-live",
			turn_id: "t-live",
			agent_id: null,
			pane: "%1",
			data: { message_id: "m-live", index: 0, delta: "Arrived with the keyboard up", final: true },
		});
		await expect(sc).toContainText("Arrived with the keyboard up");
		await expect.poll(gap, "a live message sticks while the keyboard is up").toBeLessThan(4);
		await expect(page.locator("#chat-thread .chat-float")).toBeHidden();
		await keyboard(page, viewport.height, 0);
		await expect.poll(gap).toBeLessThan(4);

		// Reading earlier messages: the keyboard does not yank the reader down.
		await sc.evaluate((el) => {
			el.style.scrollBehavior = "auto";
			el.scrollTop = 200;
			el.dispatchEvent(new Event("scroll"));
		});
		const before = await sc.evaluate((el) => el.scrollTop);
		const firstVisible = () =>
			sc.evaluate((el) => {
				const top = el.getBoundingClientRect().top;
				const items = [...el.querySelectorAll<HTMLElement>(".chat-assistant, .chat-user")];
				return items.find((i) => i.getBoundingClientRect().bottom > top + 1)?.textContent ?? "";
			});
		const readingAt = await firstVisible();
		await keyboard(page, viewport.height - 380, 0);
		await page.waitForTimeout(300);
		expect(await sc.evaluate((el) => el.scrollTop), "keyboard up: not yanked down").toBe(before);
		expect(await firstVisible(), "the same message is still at the top").toBe(readingAt);
		await keyboard(page, viewport.height, 0);
		await page.waitForTimeout(300);
		expect(await sc.evaluate((el) => el.scrollTop), "keyboard down: still in place").toBe(before);
		expect(await firstVisible()).toBe(readingAt);
	});

	test("the covered terminal sends no resize while the keyboard opens and closes in Chat; one controlled sync on return", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await app.switchView("chat");
		await page.waitForTimeout(300);
		const sock = backend.terminalSockets[0]!;
		const resizes = () => sock.sent.filter((f) => f.type === "resize").length;
		const r0 = resizes();
		const viewport = page.viewportSize()!;
		for (let i = 0; i < 3; i++) {
			await keyboard(page, viewport.height - 380, 300);
			await page.waitForTimeout(250);
			await keyboard(page, viewport.height, 0);
			await page.waitForTimeout(250);
		}
		expect(resizes() - r0, "keyboard churn in Chat reached tmux").toBe(0);
		// Keyboard left up when going back: the terminal fits once to the new size.
		await keyboard(page, viewport.height - 380, 0);
		await page.waitForTimeout(250);
		expect(resizes() - r0).toBe(0);
		await app.switchView("terminal");
		await expect.poll(() => resizes() - r0).toBe(1);
		await page.waitForTimeout(400);
		expect(resizes() - r0, "one sync, not a cascade").toBe(1);
		expect(backend.terminalSockets, "no new socket").toHaveLength(1);
	});
});
