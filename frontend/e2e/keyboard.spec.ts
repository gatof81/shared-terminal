import { expect, test } from "./fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS } from "./mockBackend.js";

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
		// A pan alone: offsetTop (and the zoom scale) change, the height does
		// not, and Safari fires only `scroll`.
		(window as unknown as { __pan: (top: number, scale?: number) => void }).__pan = (
			top,
			scale = 1,
		) => {
			target.offsetTop = top;
			target.pageTop = top;
			target.scale = scale;
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

async function pan(page: import("@playwright/test").Page, offsetTop: number, scale = 1) {
	await page.evaluate(
		([t, s]) => {
			(window as unknown as { __pan: (top: number, scale?: number) => void }).__pan(t, s);
		},
		[offsetTop, scale] as const,
	);
}

test.describe("soft keyboard (simulated visual viewport)", () => {
	test.skip(({ isMobile }) => !isMobile, "mobile layouts");

	test("a pan alone (only `scroll`, same height) moves the app with it", async ({ app, page }) => {
		await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`);
		await app.expectView("chat");
		const viewport = page.viewportSize()!;
		await keyboard(page, viewport.height - 380, 0);
		const top = () => page.locator("body").evaluate((b) => Math.round(b.getBoundingClientRect().y));
		expect(await top()).toBe(0);
		// Focus moves to another field: Safari pans 120 px, no resize event.
		await pan(page, 120);
		await expect.poll(top).toBe(120);
		await pan(page, 0);
		await expect.poll(top).toBe(0);
	});

	test("a stale offset after the keyboard closes cannot push the app down", async ({
		app,
		page,
	}) => {
		await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`);
		await app.expectView("chat");
		const viewport = page.viewportSize()!;
		const top = () => page.locator("body").evaluate((b) => Math.round(b.getBoundingClientRect().y));
		await keyboard(page, viewport.height - 380, 300);
		await expect.poll(top).toBe(300);
		// Keyboard closed, full height back, but the offset is still reported.
		await keyboard(page, viewport.height, 300);
		await expect.poll(top, "bounded by innerHeight - height = 0").toBe(0);
		await expect(page.locator("html")).not.toHaveAttribute("data-kb", "open");
	});

	test("under a pinch zoom the offset is the reader panning: the app is not translated", async ({
		app,
		page,
	}) => {
		await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`);
		await app.expectView("chat");
		const top = () => page.locator("body").evaluate((b) => Math.round(b.getBoundingClientRect().y));
		await pan(page, 250, 2);
		await page.waitForTimeout(200);
		expect(await top(), "zoomed pan must not move the layout").toBe(0);
		expect(
			await page.evaluate(() =>
				getComputedStyle(document.documentElement).getPropertyValue("--app-top").trim(),
			),
		).toBe("0px");
		// Back to scale 1 with the keyboard up: the offset counts again.
		await pan(page, 0, 1);
		await keyboard(page, page.viewportSize()!.height - 380, 80);
		await expect.poll(top).toBe(80);
		await keyboard(page, page.viewportSize()!.height, 0);
	});

	test("the app lays out in the visible band: body follows the panned viewport, no bottom safe-area strip", async ({
		app,
		page,
	}) => {
		await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`);
		// The chat's last element (the message box) is what must stay above the keyboard.
		const ta = page.locator("#acp-chat .acp-chat-composer");
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
		const keyboardTop = 300 + visible;
		expect(
			taBox!.y + taBox!.height,
			"the thread's end is inside the visible band",
		).toBeLessThanOrEqual(keyboardTop + 1);

		// Keyboard down: back to the full height, no offset, flag cleared.
		await keyboard(page, viewport.height, 0);
		await expect(page.locator("html")).not.toHaveAttribute("data-kb", "open");
		expect(Math.round((await page.locator("body").boundingBox())!.y)).toBe(0);
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

	for (const chat of [
		{
			name: "the agent's chat",
			hash: `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`,
			root: "#acp-chat",
		},
		{ name: "Project Chat", hash: `#/projects/${PROJECT_IDS.hz}`, root: "#project-view" },
	])
		test(`${chat.name}: with 150 px visible the layout fits its box — the thread gives way, the message box is whole`, async ({
			app,
			page,
		}) => {
			await app.login("alice", chat.hash);
			const input = page.locator(`${chat.root} .acp-chat-input`);
			await expect(input).toBeVisible();
			await input.focus();
			await keyboard(page, 150, 0);
			const vh = 150;
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
