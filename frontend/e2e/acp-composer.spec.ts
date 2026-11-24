import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS } from "./mockBackend.js";

/**
 * The ACP message box as ONE surface (UX iter3 §3): a grid `[+] [field]
 * [arrow]` aligned at the bottom, the focus drawn on the surface, its states
 * (empty, text, sending, error, locked), and the line above it that says who
 * a Project Chat message goes to — only when its leading mentions name
 * someone. What is sent is still the text (recipientsOf): acp-recipients.spec.ts.
 */

const PROJECT = `#/projects/${PROJECT_IDS.hz}/chat`;
const P = "#project-view";

const box = async (l: Locator) => (await l.boundingBox())!;
/** Distance from an element's bottom edge to the surface's. */
const fromBottom = async (surface: Locator, l: Locator) => {
	const s = await box(surface);
	const b = await box(l);
	return Math.round(s.y + s.height - (b.y + b.height));
};

async function openProject(page: Page, app: { login: (u: "alice", h: string) => Promise<void> }) {
	await app.login("alice", PROJECT);
	await expect(page.locator(`${P} .acp-chat-input`)).toBeEnabled();
	return {
		surface: page.locator(`${P} .acp-chat-field`),
		input: page.locator(`${P} .acp-chat-input`),
		plus: page.locator(`${P} .acp-pick-btn`),
		send: page.locator(`${P} .acp-chat-send`),
		line: page.locator(`${P} .acp-chat-hint`),
	};
}

test.describe("ACP composer: one surface", () => {
	test.beforeEach(({ backend }) => backend.enableAcp());

	test("44 px at rest; '+' and the arrow sit at the bottom, the same distance from the edge, at any height", async ({
		app,
		page,
	}) => {
		const { surface, input, plus, send } = await openProject(page, app);
		await expect(plus).toBeVisible();
		expect(Math.round((await box(surface)).height)).toBe(44);
		const rest = [await fromBottom(surface, plus), await fromBottom(surface, send)];
		expect(rest[0]).toBe(rest[1]);
		// Both visible circles are 30 px.
		for (const b of [plus, send])
			expect(Math.round((await box(b.locator(".acp-cbtn-face"))).width)).toBe(30);

		await input.fill(Array.from({ length: 5 }, (_, i) => `línea ${i}`).join("\n"));
		await expect.poll(async () => Math.round((await box(surface)).height)).toBeGreaterThan(100);
		// Grown: the buttons did not move from the bottom edge.
		expect([await fromBottom(surface, plus), await fromBottom(surface, send)]).toEqual(rest);
		// The field fills its column: nothing to the left of "+" or right of the arrow.
		const s = await box(surface);
		expect(Math.round((await box(plus)).x - s.x)).toBeLessThanOrEqual(1);
		expect(
			Math.round(s.x + s.width - ((await box(send)).x + (await box(send)).width)),
		).toBeLessThanOrEqual(1);
	});

	test("the individual chat: no '+' column, the field starts 12 px in; the same surface", async ({
		app,
		page,
	}) => {
		await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`);
		const surface = page.locator("#acp-chat .acp-chat-field");
		const input = page.locator("#acp-chat .acp-chat-input");
		await expect(input).toBeVisible();
		await expect(page.locator("#acp-chat .acp-pick-btn")).toBeHidden();
		expect(Math.round((await box(surface)).height)).toBe(44);
		expect(Math.round((await box(input)).x - (await box(surface)).x)).toBe(13);
	});

	test("the focus is drawn once, on the surface; the field has no ring of its own", async ({
		app,
		page,
	}) => {
		const { surface, input } = await openProject(page, app);
		await input.focus();
		const look = await page.evaluate(() => {
			const s = document.querySelector<HTMLElement>("#project-view .acp-chat-field")!;
			const i = document.querySelector<HTMLElement>("#project-view .acp-chat-input")!;
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

	test("the individual chat too: one ring on the surface, and the arrow's ring only on its circle", async ({
		app,
		page,
	}) => {
		// Inside #chat-view, whose own :focus-visible rule outweighs a class.
		await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`);
		const input = page.locator("#acp-chat .acp-chat-input");
		await input.fill("hola");
		await input.focus();
		expect(await input.evaluate((e) => getComputedStyle(e).outlineStyle)).toBe("none");
		// The arrow from the keyboard: its cell draws nothing, its circle the ring.
		await page.keyboard.press("Tab");
		const send = page.locator("#acp-chat .acp-chat-send");
		await expect(send).toBeFocused();
		expect(await send.evaluate((e) => getComputedStyle(e).outlineStyle)).toBe("none");
		expect(
			await send.locator(".acp-cbtn-face").evaluate((e) => getComputedStyle(e).outlineStyle),
		).toBe("solid");
	});

	test("'Para @a · @b' shows only while the text names its recipients (recipientsOf), in Project Chat only", async ({
		app,
		page,
	}) => {
		const { input, line, send } = await openProject(page, app);
		// At rest it says only the notices (the seeded queue), no recipients.
		await expect(line).not.toContainText("Para");
		await expect(send).toBeDisabled();
		await input.fill("@arq @dev revisen el módulo de pagos");
		await expect(line).toHaveText("Para @arq · @dev");
		await expect(send).toBeEnabled();
		await expect(page.locator(`${P} .acp-chat-field`)).toHaveClass(/has-text/);
		// It says what recipientsOf will send: one agent named anywhere is the
		// recipient; nobody named (two agents) is nobody yet.
		await input.fill("revisen el módulo de @arq");
		await expect(line).toHaveText("Para @arq");
		await input.fill("revisen el módulo de pagos");
		await expect(line).not.toContainText("Para");
		await input.fill("");
		await expect(line).not.toContainText("Para");

		await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`);
		const agentInput = page.locator("#acp-chat .acp-chat-input");
		await agentInput.fill("@arq hola");
		await expect(page.locator("#acp-chat .acp-chat-hint")).toBeHidden();
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
		const { surface, input, send, line } = await openProject(page, app);
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
		const { surface, input } = await openProject(page, app);
		await input.fill("@arq revisá esto");
		await input.press("Control+Enter");
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

	test("locked while the project is confirmed: says why, no buttons", async ({
		app,
		backend,
		page,
	}) => {
		// Every read of the project list held: the page cannot confirm the project yet.
		let open = false;
		const waiting: Array<() => void> = [];
		backend.override = async (method, path) => {
			if (open || method !== "GET" || path !== "/projects") return false;
			await new Promise<void>((r) => waiting.push(r));
			return false;
		};
		await app.login("alice", PROJECT);
		const input = page.locator(`${P} .acp-chat-input`);
		await expect(input).toBeDisabled();
		await expect(input).toHaveAttribute("placeholder", "Cargando el proyecto…");
		await expect(page.locator(`${P} .acp-chat-field`)).toHaveClass(/is-disabled/);
		await expect(page.locator(`${P} .acp-chat-send .acp-cbtn-face`)).toBeHidden();
		open = true;
		for (const r of waiting) r();
		await expect(input).toBeEnabled();
		await expect(page.locator(`${P} .acp-chat-send .acp-cbtn-face`)).toBeVisible();
	});
});
