// Project Chat's recipients menu ("+"): it edits only the leading @mentions
// of the text, so what is sent is exactly what typing them would send.

import { expect, test } from "./fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS } from "./mockBackend.js";

const project = `#/projects/${PROJECT_IDS.hz}/chat`;

test.describe("Project Chat: recipients menu", () => {
	test.beforeEach(({ backend }) => backend.enableAcp());

	test("two recipients picked from the menu send what '@arq @dev text' typed by hand sends", async ({
		page,
		app,
		backend,
	}) => {
		await app.login("alice", project);
		const input = page.locator("#project-view .acp-chat-input");
		const plus = page.getByRole("button", { name: "Elegir destinatarios" });
		const menu = page.getByRole("menu", { name: "Destinatarios" });
		await input.fill("hola equipo");
		await plus.click();
		await expect(plus).toHaveAttribute("aria-expanded", "true");
		await menu.getByRole("menuitemcheckbox", { name: /@arq/ }).click();
		await menu.getByRole("menuitemcheckbox", { name: /@dev/ }).click();
		// Multi-selection: the menu stays open; the text carries the recipients.
		await expect(menu).toBeVisible();
		await expect(input).toHaveValue("@arq @dev hola equipo");
		await expect(menu.getByRole("menuitemcheckbox", { name: /@arq/ })).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await page.getByRole("button", { name: "Enviar" }).click();
		await expect(menu).toBeHidden();
		// Said to a screen reader (the hint line is not live: its queue counts would be read too).
		await expect(page.locator("#project-view .acp-chat-composer [role=status]")).toHaveText(
			"Enviado a @arq, @dev",
		);
		await expect
			.poll(() => backend.acpMessages.filter((m) => m.body === "@arq @dev hola equipo").length)
			.toBe(2);
		const viaMenu = backend.acpMessages.filter((m) => m.body === "@arq @dev hola equipo");
		expect(viaMenu.map((m) => m.to_id).sort()).toEqual(["arq", "dev"]);
		expect(new Set(viaMenu.map((m) => m.client_id)).size).toBe(1);
		expect(viaMenu.every((m) => m.project_id === PROJECT_IDS.hz)).toBe(true);

		// Typed by hand: the same bodies and recipients.
		await input.fill("@arq @dev hola equipo");
		await page.getByRole("button", { name: "Enviar" }).click();
		await expect
			.poll(() => backend.acpMessages.filter((m) => m.body === "@arq @dev hola equipo").length)
			.toBe(4);
		const byHand = backend.acpMessages.filter((m) => m.body === "@arq @dev hola equipo").slice(2);
		expect(byHand.map((m) => [m.to_id, m.body, m.project_id]).sort()).toEqual(
			viaMenu.map((m) => [m.to_id, m.body, m.project_id]).sort(),
		);
	});

	test("unchecking takes the mention out of the leading group only; a mention inside stays and says so", async ({
		page,
		app,
	}) => {
		await app.login("alice", project);
		const input = page.locator("#project-view .acp-chat-input");
		await input.fill("@arq @dev revisen");
		await page.getByRole("button", { name: "Elegir destinatarios" }).click();
		const row = (n: string) => page.getByRole("menuitemcheckbox", { name: new RegExp(`@${n}`) });
		await row("arq").click();
		await expect(input).toHaveValue("@dev revisen");
		await expect(row("arq")).toHaveAttribute("aria-checked", "false");
		await expect(row("dev")).toHaveAttribute("aria-checked", "true");
		// What is typed shows live: a single mention inside the text is a recipient.
		await input.fill("revisá con @dev");
		await expect(row("dev")).toHaveAttribute("aria-checked", "true");
		await expect(row("dev")).toContainText("mencionado en el mensaje");
		await expect(row("dev")).toHaveAttribute("aria-disabled", "true");
		await row("dev").click({ force: true });
		await expect(input).toHaveValue("revisá con @dev");
		// Checking another one keeps @dev: both explicit now.
		await row("arq").click();
		await expect(input).toHaveValue("@dev @arq revisá con @dev");
		// An unknown leading mention: nobody checked, its error at send.
		await input.fill("@devv hola");
		await expect(row("arq")).toHaveAttribute("aria-checked", "false");
		await expect(row("dev")).toHaveAttribute("aria-checked", "false");
		// …and the menu says why, before any send.
		const note = page.locator("#project-view .acp-pick-note");
		await expect(note).toContainText("@devv no es un agente");
		await row("dev").click();
		await expect(input).toHaveValue("@devv @dev hola");
		await expect(note).toBeVisible();
		await expect(page.getByRole("menu", { name: "Destinatarios" })).toHaveAccessibleDescription(
			/@devv no es un agente/,
		);
		await input.fill("@dev hola");
		await expect(note).toBeHidden();
	});

	test("from the keyboard: arrows, Space, Escape back to the field", async ({ page, app }) => {
		await app.login("alice", project);
		const input = page.locator("#project-view .acp-chat-input");
		await input.fill("hola");
		const plus = page.getByRole("button", { name: "Elegir destinatarios" });
		await plus.focus();
		await page.keyboard.press("Enter");
		const rows = page.getByRole("menuitemcheckbox");
		await expect(rows.first()).toBeFocused();
		await page.keyboard.press("ArrowDown");
		await expect(rows.nth(1)).toBeFocused();
		await page.keyboard.press("Space");
		await expect(rows.nth(1)).toHaveAttribute("aria-checked", "true");
		await expect(rows.nth(1)).toBeFocused();
		await expect(input).toHaveValue("@dev hola");
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press("Enter");
		await expect(input).toHaveValue("@dev @arq hola");
		await page.keyboard.press("Escape");
		await expect(page.getByRole("menu", { name: "Destinatarios" })).toBeHidden();
		await expect(input).toBeFocused();
		await expect(plus).toHaveAttribute("aria-expanded", "false");
	});

	test("on a phone a tap on + and on a row leaves the focus (and keyboard) in the field", async ({
		page,
		app,
	}, info) => {
		test.skip(!info.project.use.isMobile, "touch");
		await app.login("alice", project);
		const input = page.locator("#project-view .acp-chat-input");
		await input.tap();
		await input.fill("hola");
		await expect(input).toBeFocused();
		// A touch tap whose click arrives with detail 0, like a keyboard
		// activation's (measured on Chromium touch; this harness's taps say 1):
		// a pointer went down first, so it is not the keyboard.
		const plus = page.getByRole("button", { name: "Elegir destinatarios" });
		await plus.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true });
		await plus.dispatchEvent("click", { detail: 0 });
		await expect(page.getByRole("menu", { name: "Destinatarios" })).toBeVisible();
		// The tap opened it; the focus did not move into it.
		await expect(input).toBeFocused();
		const row = page.getByRole("menuitemcheckbox", { name: /@arq/ });
		await row.tap();
		await expect(input).toBeFocused();
		await expect(input).toHaveValue("@arq hola");
		// A tap outside closes it.
		await page.locator("#project-view .acp-chat-thread").tap();
		await expect(page.getByRole("menu", { name: "Destinatarios" })).toBeHidden();
	});

	test("the recipients go with the draft to another chat and back, and with an unsent message", async ({
		page,
		app,
		backend,
	}) => {
		await app.login("alice", project);
		const input = page.locator("#project-view .acp-chat-input");
		await input.fill("borrador");
		await page.getByRole("button", { name: "Elegir destinatarios" }).click();
		await page.getByRole("menuitemcheckbox", { name: /@dev/ }).click();
		await page.evaluate(
			(h) => (location.hash = h),
			`#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`,
		);
		await expect(page.locator("#acp-chat .acp-chat-input")).toBeVisible();
		await page.goBack();
		await expect(input).toHaveValue("@dev borrador");
		await page.getByRole("button", { name: "Elegir destinatarios" }).click();
		await expect(page.getByRole("menuitemcheckbox", { name: /@dev/ })).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await page.keyboard.press("Escape");

		// The send fails: the text comes back with its recipients.
		backend.override = async (method, path, route) => {
			if (method !== "POST" || path !== "/acp/messages") return false;
			await route.fulfill({
				status: 500,
				contentType: "application/json",
				body: '{"error":"internal"}',
			});
			return true;
		};
		await page.getByRole("button", { name: "Enviar" }).click();
		await expect(page.locator("#project-view .acp-chat-error")).toContainText("No se envió");
		await expect(input).toHaveValue("@dev borrador");
		await page.getByRole("button", { name: "Elegir destinatarios" }).click();
		await expect(page.getByRole("menuitemcheckbox", { name: /@dev/ })).toHaveAttribute(
			"aria-checked",
			"true",
		);
	});

	test("the arrow: off with an empty or blank field, on with text; no + in an individual chat", async ({
		page,
		app,
	}) => {
		await app.login("alice", project);
		const input = page.locator("#project-view .acp-chat-input");
		const send = page.locator("#project-view").getByRole("button", { name: "Enviar" });
		await expect(send).toBeDisabled();
		await input.fill("   ");
		await expect(send).toBeDisabled();
		await input.fill("@arq hola");
		await expect(send).toBeEnabled();
		await page.evaluate(
			(h) => (location.hash = h),
			`#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`,
		);
		await expect(page.locator("#acp-chat .acp-chat-input")).toBeVisible();
		await expect(page.locator("#acp-chat .acp-pick-btn")).toBeHidden();
		await expect(page.locator("#acp-chat").getByRole("button", { name: "Enviar" })).toBeDisabled();
	});
});
