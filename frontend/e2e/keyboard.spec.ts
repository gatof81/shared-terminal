import { expect, test } from "./fixtures.js";
import { CONV_IDS, PROJECT_IDS } from "./mockBackend.js";

/** A topic: its message box is the one a soft keyboard comes up for. */
const TOPIC = `#/projects/${PROJECT_IDS.hz}/c/${CONV_IDS.backend}`;
const ROOT = "#project-view .ps-topic";

/**
 * The mobile soft keyboard, as far as Chromium can reproduce it. Playwright
 * cannot raise a real keyboard nor make Chromium pan the visual viewport
 * the way iOS Safari does, so `window.visualViewport` is replaced before the
 * app loads by an EventTarget whose height/offsetTop the test sets — the
 * same two numbers Safari reports with the keyboard up and the view panned
 * to the focused field. What this proves: the app follows the height
 * (layout in the visible band, no safe-area strip, the keyboard flag read
 * against the layout viewport), a scrolled document is put back at 0, and
 * the covered terminal sends nothing to tmux while an overlay is shown. What only
 * the device proves: Safari's own scroll and its timing (validated on an
 * iPhone, Safari 27.2, #767).
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
	test.beforeEach(({ backend }) => backend.enableConversations());

	test("keyboard up: the app is as tall as the visible band, the message box stays inside it, no bottom safe-area strip", async ({
		app,
		page,
	}) => {
		await app.login("alice", TOPIC);
		const ta = page.locator(`${ROOT} .acp-chat-composer`);
		await expect(ta).toBeVisible();
		const viewport = page.viewportSize()!;
		const visible = viewport.height - 380;
		// As in the iPhone log: `innerHeight` shrinks with the visible area, so
		// only the layout viewport (clientHeight) tells the keyboard is up.
		await page.evaluate(() =>
			Object.defineProperty(window, "innerHeight", {
				configurable: true,
				get: () => window.visualViewport!.height,
			}),
		);
		await keyboard(page, visible, 0);
		await expect(page.locator("html")).toHaveAttribute("data-kb", "open");
		const body = await page.locator("body").boundingBox();
		expect(Math.round(body!.y)).toBe(0);
		expect(Math.round(body!.height)).toBe(visible);
		const taBox = await ta.boundingBox();
		expect(taBox!.y + taBox!.height, "the message box is above the keyboard").toBeLessThanOrEqual(
			visible + 1,
		);

		await keyboard(page, viewport.height, 0);
		await expect(page.locator("html")).not.toHaveAttribute("data-kb", "open");
		expect(Math.round((await page.locator("body").boundingBox())!.height)).toBe(viewport.height);
	});

	test("a scrolled document is put back at 0 (iOS Safari scrolls it by the keyboard's height to reveal the field)", async ({
		app,
		page,
	}) => {
		await app.login("alice", TOPIC);
		await expect(page.locator(`${ROOT} .acp-chat-composer`)).toBeVisible();
		await keyboard(page, page.viewportSize()!.height - 380, 0);
		// Chromium has nothing to scroll: give the document the extent Safari's
		// full-height layout viewport gives it, then scroll it like Safari does.
		await page.evaluate(() => {
			const pad = document.createElement("div");
			pad.id = "kb-test-extent";
			pad.style.cssText = "position:absolute;top:0;left:0;width:1px;height:3000px";
			document.documentElement.append(pad);
			window.scrollTo(0, 380);
		});
		await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
		expect(Math.round((await page.locator("body").boundingBox())!.y)).toBe(0);
		await page.evaluate(() => document.getElementById("kb-test-extent")?.remove());
	});

	test("the covered terminal sends no resize while the keyboard opens and closes over an overlay; one controlled sync on return", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await app.switchView("files");
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
		expect(resizes() - r0, "keyboard churn over Files reached tmux").toBe(0);
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

	// 160 px, not the retired chat's 150: a topic's box carries its «Para:» row
	// (3B F2), and header + box measure 156 px — the band below that is open (F5 report).
	for (const chat of [{ name: "a topic", hash: TOPIC, root: ROOT }])
		test(`${chat.name}: with 160 px visible the layout fits its box — the thread gives way, the message box is whole`, async ({
			app,
			page,
		}) => {
			await app.login("alice", chat.hash);
			const input = page.locator(`${chat.root} .acp-chat-input`);
			await expect(input).toBeVisible();
			await input.focus();
			await keyboard(page, 160, 0);
			const vh = 160;
			const composer = (await page.locator(`${chat.root} .acp-chat-composer`).boundingBox())!;
			expect(composer.y, "the message box starts inside the band").toBeGreaterThanOrEqual(0);
			expect(composer.y + composer.height, "and ends inside it").toBeLessThanOrEqual(vh + 1);
			const box = (await input.boundingBox())!;
			expect(box.height, "the field keeps its resting line").toBeGreaterThanOrEqual(42);
			// Nothing in the chat is taller than its box: no scroll outside the thread.
			const overflow = await page.evaluate((sel) => {
				const out: string[] = [];
				for (const el of [
					document.documentElement,
					document.body,
					...document.querySelectorAll(`${sel}, ${sel} *`),
				]) {
					const cs = getComputedStyle(el);
					if (el.classList.contains("acp-chat-thread") || el.classList.contains("acp-chat-input"))
						continue;
					if (
						/(auto|scroll)/.test(cs.overflowY) &&
						el.scrollHeight > el.clientHeight + 1 &&
						el.scrollTop > 0
					)
						out.push(el.className || el.tagName);
				}
				return out;
			}, chat.root);
			expect(overflow, "nothing but the thread scrolled").toEqual([]);
			await keyboard(page, page.viewportSize()!.height, 0);
		});
});
