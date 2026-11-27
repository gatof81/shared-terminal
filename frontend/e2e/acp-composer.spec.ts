import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { CONV_IDS, type MockBackend, PROJECT_IDS } from "./mockBackend.js";

/**
 * A topic's message box as ONE surface (UX iter3 §3): `[field] [arrow]`
 * aligned at the bottom (its "+" is «Para:»'s, acp-topic.spec.ts), the
 * focus drawn on the surface, its states (empty, text, sending, error).
 */

const TOPIC = `#/projects/${PROJECT_IDS.hz}/c/${CONV_IDS.backend}`;
const P = "#project-view .ps-topic";

const box = async (l: Locator) => (await l.boundingBox())!;
/** Distance from an element's bottom edge to the surface's. */
const fromBottom = async (surface: Locator, l: Locator) => {
	const s = await box(surface);
	const b = await box(l);
	return Math.round(s.y + s.height - (b.y + b.height));
};

async function openTopic(page: Page, app: { login: (u: "alice", h: string) => Promise<void> }) {
	await app.login("alice", TOPIC);
	await expect(page.locator(`${P} .acp-chat-input`)).toBeEnabled();
	return {
		surface: page.locator(`${P} .acp-chat-field`),
		input: page.locator(`${P} .acp-chat-input`),
		send: page.locator(`${P} .acp-chat-send`),
		line: page.locator(`${P} .acp-chat-hint`),
	};
}

test.describe("ACP composer: one surface", () => {
	test.beforeEach(({ backend }) => {
		backend.enableAcp();
		backend.enableConversations();
	});

	test("44 px at rest; the arrow sits at the bottom at any height; the field starts 12 px in", async ({
		app,
		page,
	}) => {
		const { surface, input, send } = await openTopic(page, app);
		expect(Math.round((await box(surface)).height)).toBe(44);
		expect(Math.round((await box(input)).x - (await box(surface)).x)).toBe(13);
		const rest = await fromBottom(surface, send);
		expect(Math.round((await box(send.locator(".acp-cbtn-face"))).width)).toBe(30);

		await input.fill(Array.from({ length: 5 }, (_, i) => `línea ${i}`).join("\n"));
		await expect.poll(async () => Math.round((await box(surface)).height)).toBeGreaterThan(100);
		// Grown: the arrow did not move from the bottom edge.
		expect(await fromBottom(surface, send)).toEqual(rest);
		// The field fills its column: nothing right of the arrow.
		const s = await box(surface);
		expect(
			Math.round(s.x + s.width - ((await box(send)).x + (await box(send)).width)),
		).toBeLessThanOrEqual(1);
	});

	test("the focus is drawn once, on the surface; the field has no ring of its own", async ({
		app,
		page,
	}) => {
		const { surface, input } = await openTopic(page, app);
		await input.focus();
		const look = await page.evaluate(() => {
			const s = document.querySelector<HTMLElement>("#project-view .ps-topic .acp-chat-field")!;
			const i = document.querySelector<HTMLElement>("#project-view .ps-topic .acp-chat-input")!;
			const accent = getComputedStyle(document.documentElement).getPropertyValue("--c-accent");
			const probe = document.createElement("i");
			probe.style.color = accent;
			document.body.append(probe);
			const want = getComputedStyle(probe).color;
			probe.remove();
			return {
				border: getComputedStyle(s).borderTopColor === want,
				halo: getComputedStyle(s).boxShadow !== "none",
				outline: getComputedStyle(i).outlineStyle,
			};
		});
		expect(look).toEqual({ border: true, halo: true, outline: "none" });
		await expect(surface).toBeVisible();
	});

	test("the arrow's keyboard ring is drawn only on its circle", async ({ app, page }) => {
		const { input } = await openTopic(page, app);
		await input.fill("hola");
		await input.focus();
		// The arrow from the keyboard: its cell draws nothing, its circle the ring.
		await page.keyboard.press("Tab");
		const send = page.locator(`${P} .acp-chat-send`);
		await expect(send).toBeFocused();
		expect(await send.evaluate((e) => getComputedStyle(e).outlineStyle)).toBe("none");
		expect(
			await send.locator(".acp-cbtn-face").evaluate((e) => getComputedStyle(e).outlineStyle),
		).toBe("solid");
	});

	test("sending: a spinner in the arrow while the field is empty; new text brings the arrow back", async ({
		app,
		backend,
		page,
	}) => {
		let release: (() => void) | null = null;
		backend.override = async (method, path) => {
			if (method !== "POST" || !path.startsWith("/acp/messages") || release) return false;
			await new Promise<void>((r) => (release = r));
			return false;
		};
		const { surface, input, send, line } = await openTopic(page, app);
		await input.fill("@arq revisá esto");
		await send.click();
		await expect.poll(() => release !== null).toBe(true);
		await expect(input).toHaveValue("");
		await expect(surface).toHaveClass(/is-sending/);
		await expect(send.locator(".acp-send-spin")).toBeVisible();
		await expect(line).toContainText("Enviando…");
		// Another message can be written and sent meanwhile, as always.
		await input.fill("@dev y vos esto");
		await expect(send.locator(".acp-send-spin")).toBeHidden();
		await expect(send.locator("svg")).toBeVisible();
		await expect(send).toBeEnabled();
		release!();
		await expect(surface).not.toHaveClass(/is-sending/);
	});

	test("a refused send: red border and fixed words under the surface, never the server's code", async ({
		app,
		backend,
		page,
	}) => {
		backend.override = async (method, path, route) => {
			if (method !== "POST" || !path.startsWith("/acp/messages")) return false;
			await route.fulfill({
				status: 503,
				contentType: "application/json",
				body: JSON.stringify({ error: "internal" }),
			});
			return true;
		};
		const { surface, input, send } = await openTopic(page, app);
		await input.fill("@arq revisá esto");
		await send.click();
		const error = page.locator(`${P} .acp-chat-error`);
		await expect(error).toHaveText("No se envió a @arq.");
		await expect(surface).toHaveClass(/is-error/);
		// Under the surface, not inside it.
		expect((await box(error)).y).toBeGreaterThanOrEqual(
			(await box(surface)).y + (await box(surface)).height,
		);
		// The text came back into the field (it was empty).
		await expect(input).toHaveValue("@arq revisá esto");
	});
});

test.describe("ACP composer: the keys", () => {
	test.beforeEach(({ backend }) => {
		backend.enableAcp();
		backend.enableConversations();
	});

	/** Counts the message POSTs (the mock still answers them). */
	function countSends(backend: MockBackend) {
		const sent = { n: 0 };
		backend.override = async (method, path) => {
			if (method === "POST" && path.startsWith("/acp/messages")) sent.n++;
			return false;
		};
		return sent;
	}

	test("Enter sends on a keyboard; on a touch screen it breaks the line and the arrow sends", async ({
		app,
		backend,
		page,
		isMobile,
	}) => {
		const sent = countSends(backend);
		const { input, send } = await openTopic(page, app);
		await input.fill("@arq revisá esto");
		await input.press("Enter");
		if (!isMobile) {
			await expect(input).toHaveValue("");
			await expect.poll(() => sent.n).toBe(1);
			await expect(send).toHaveAttribute("title", "Enviar (Enter)");
			await expect(input).not.toHaveAttribute("enterkeyhint");
			return;
		}
		await expect(input).toHaveValue("@arq revisá esto\n");
		await expect(input).toHaveAttribute("enterkeyhint", "enter");
		await expect(send).toHaveAttribute("title", "Enviar");
		expect(sent.n).toBe(0);
		await send.click();
		await expect(input).toHaveValue("");
		await expect.poll(() => sent.n).toBe(1);
	});

	test("Ctrl+Enter and Cmd+Enter break the line at the caret (undoable) and send nothing", async ({
		app,
		backend,
		page,
	}) => {
		const sent = countSends(backend);
		const { input, send } = await openTopic(page, app);
		await input.fill("@arq uno dos");
		// The caret after "uno", " dos" selected: replaced by the break.
		await input.evaluate((e: HTMLTextAreaElement) => e.setSelectionRange(8, 12));
		await input.press("Control+Enter");
		await expect(input).toHaveValue("@arq uno\n");
		await input.press("Meta+Enter");
		await expect(input).toHaveValue("@arq uno\n\n");
		// Undoable like typing (Chromium folds the two breaks into one step).
		await page.keyboard.press("Control+z");
		await expect(input).toHaveValue("@arq uno dos");
		await expect(send).toBeEnabled();
		// Empty field: nothing, not even a break.
		await input.fill("");
		await input.press("Control+Enter");
		await input.press("Enter");
		await expect(input).toHaveValue("");
		expect(sent.n).toBe(0);
	});

	test("Enter with the @ menu open picks the mention and sends nothing", async ({
		app,
		backend,
		page,
	}) => {
		const sent = countSends(backend);
		const { input } = await openTopic(page, app);
		await input.click();
		await input.pressSequentially("hola @ar");
		await expect(page.locator(`${P} .acp-mention-menu`)).toBeVisible();
		await page.keyboard.press("Enter");
		await expect(page.locator(`${P} .acp-mention-menu`)).toBeHidden();
		await expect(input).not.toHaveValue("");
		expect(sent.n).toBe(0);
	});

	test("Enter while an IME composes, and a multi-line paste, send nothing", async ({
		app,
		backend,
		page,
	}) => {
		const sent = countSends(backend);
		const { input } = await openTopic(page, app);
		await input.fill("@arq こんにちは");
		const defaulted = await input.evaluate((e) =>
			[{ isComposing: true }, { keyCode: 229 }].map(
				(extra) =>
					!e.dispatchEvent(
						new KeyboardEvent("keydown", {
							key: "Enter",
							bubbles: true,
							cancelable: true,
							...extra,
						}),
					),
			),
		);
		// Left to the IME: not prevented, not sent.
		expect(defaulted).toEqual([false, false]);
		await expect(input).toHaveValue("@arq こんにちは");
		// A paste goes through no keydown (insertText: what a paste does to the
		// field, without a clipboard): the lines land in the field.
		await input.fill("");
		await input.focus();
		await page.keyboard.insertText("@arq uno\ndos\n");
		await expect(input).toHaveValue("@arq uno\ndos\n");
		await page.waitForTimeout(200);
		expect(sent.n).toBe(0);
	});
});
