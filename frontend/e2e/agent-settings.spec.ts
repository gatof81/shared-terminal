// «Ajustes del agente» (acpSettings.ts, 3B F5): a dialog from the ⋯ of the
// agent's session and from the agent's menu in its project — model, effort,
// project and «Conectar cuenta» survive the individual chat they lived in.
// What the settings need is flagged on the ⋯; an agent without a project
// is told where it gets one.

import { expect, test } from "./fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS } from "./mockBackend.js";

const SOLO = `#/sessions/${PROJECT_SESSION_IDS.scratch}`; // @solo: no project
const ARQ = `#/sessions/${PROJECT_SESSION_IDS.architect}`; // @arq: in Educación HZ
const DIALOG = ".acp-settings-dialog";

test.describe("agent settings", () => {
	test.beforeEach(({ backend }) => backend.enableAcp());

	test("a dialog from the session's ⋯; Escape gives the focus back to the ⋯", async ({
		app,
		page,
	}) => {
		await app.login("alice", ARQ);
		const more = await app.openAgentSettings();
		const dialog = page.locator(DIALOG);
		await expect(dialog.getByRole("dialog")).toBeVisible();
		await expect(dialog.locator("h2")).toHaveText("Ajustes de @arq");
		await expect(dialog.locator(".acp-project-select")).toHaveValue(PROJECT_IDS.hz);
		await app.escape();
		await expect(dialog.getByRole("dialog")).toBeHidden();
		await expect(more).toBeFocused();
	});

	test("the model changes there and reads pending until applied", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice", ARQ);
		await app.openAgentSettings();
		const select = page.locator(`${DIALOG} .acp-model-select`);
		await expect(select).toHaveValue("");
		await select.selectOption({ label: "Claude Opus 5.5" });
		await page.locator(`${DIALOG} .acp-chat-model button`, { hasText: "Cambiar modelo" }).click();
		await expect(page.locator(`${DIALOG} .acp-model-state`)).toContainText(
			"Se aplica cuando @arq esté libre",
		);
		await expect(select).toHaveValue("claude-opus-5-5");
		expect(backend.acpAgents.find((a) => a.name === "arq")?.model).toBe("claude-opus-5-5");
		expect(
			backend.requests.filter((r) => r.method === "PATCH" && r.path === "/acp/agents/arq"),
		).toHaveLength(1);
	});

	test("effort: exactly the reported levels; a change reads pending until applied", async ({
		app,
		backend,
		page,
	}) => {
		backend.acpAgents.find((a) => a.name === "arq")!.effortApplied = {
			model: null,
			requested: "default",
			current: "default",
			levels: ["default", "low", "extra_high"],
			error: null,
		};
		await app.login("alice", ARQ);
		await app.openAgentSettings();
		const select = page.locator(`${DIALOG} .acp-effort-select`);
		const state = page.locator(`${DIALOG} .acp-effort-state`);
		expect(await select.locator("option").allTextContents()).toEqual([
			"Por defecto",
			"Low",
			"Extra High",
		]);
		await expect(state).toHaveText("Aplicado.");
		await select.selectOption("extra_high");
		await page
			.locator(`${DIALOG} .acp-chat-effort button`, { hasText: "Cambiar esfuerzo" })
			.click();
		await expect(state).toContainText("Se aplica cuando @arq esté libre");
		expect(backend.acpAgents.find((a) => a.name === "arq")?.effort).toBe("extra_high");
	});

	test("a refused model or effort is flagged on the ⋯ and said in the dialog", async ({
		app,
		backend,
		page,
	}) => {
		const arq = backend.acpAgents.find((a) => a.name === "arq")!;
		arq.model = "claude-opus-5-5";
		arq.modelApplied = {
			requested: "claude-opus-5-5",
			current: null,
			error: "modelo no disponible",
		};
		await app.login("alice", ARQ);
		const more = page.locator("#session-menu-btn");
		await expect(more).toHaveAccessibleName("Acciones de la sesión (el modelo no se aplicó)");
		await expect(more.locator(".bar-menu-flag")).toBeVisible();
		await app.openAgentSettings();
		await expect(page.locator(`${DIALOG} .acp-model-state`)).toContainText("modelo no disponible");
	});

	test("a login missing: «Conectar cuenta» opens the login in a terminal tab of its session", async ({
		app,
		backend,
		page,
	}) => {
		const arq = backend.acpAgents.find((a) => a.name === "arq")!;
		arq.authRequired = true;
		arq.loginMethods = [{ id: "claude-ai", name: "Claude.ai", description: "Cuenta de Claude.ai" }];
		await app.login("alice", ARQ);
		await expect(page.locator("#session-menu-btn")).toHaveAccessibleName(
			"Acciones de la sesión (falta conectar una cuenta)",
		);
		await app.openAgentSettings();
		await page.locator(DIALOG).getByRole("button", { name: "Conectar cuenta · Claude.ai" }).click();
		await expect
			.poll(() =>
				backend.requests.some((r) => r.method === "POST" && r.path === "/acp/agents/arq/login"),
			)
			.toBe(true);
		await expect(page.locator(`${DIALOG} [role=dialog]`)).toBeHidden();
	});

	test("an agent without a project: the ⋯ says so; assigned there, it is in the project's team", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice", SOLO);
		await expect(page.locator("#session-menu-btn")).toHaveAccessibleName(
			"Acciones de la sesión (Sin proyecto · Asignale uno para conversar)",
		);
		await app.openAgentSettings();
		const dialog = page.locator(DIALOG);
		await expect(dialog).toContainText(
			"Sin proyecto no tiene conversaciones ni Archivo. Asignale un proyecto para hablarle en sus temas; sus mensajes anteriores pasan al Archivo de ese proyecto.",
		);
		await dialog.locator(".acp-project-select").selectOption(PROJECT_IDS.hz);
		await dialog.getByRole("button", { name: "Guardar" }).click();
		await expect
			.poll(() => backend.acpAgents.find((a) => a.name === "solo")?.projectId)
			.toBe(PROJECT_IDS.hz);
		await expect(dialog).not.toContainText("Sin proyecto no tiene conversaciones");
		// And back to «Sin proyecto» with the same select.
		await dialog.locator(".acp-project-select").selectOption("");
		await dialog.getByRole("button", { name: "Guardar" }).click();
		await expect.poll(() => backend.acpAgents.find((a) => a.name === "solo")?.projectId).toBeNull();
		await expect(dialog).toContainText("Sin proyecto no tiene conversaciones ni Archivo");
		await dialog.locator(".acp-project-select").selectOption(PROJECT_IDS.hz);
		await dialog.getByRole("button", { name: "Guardar" }).click();
		await expect(dialog).not.toContainText("Sin proyecto no tiene conversaciones");
		await app.escape();
		await expect(page.locator("#session-menu-btn")).toHaveAccessibleName("Acciones de la sesión");
	});

	test("from the project: the agent's menu has «Ajustes del agente»", async ({ app, page }) => {
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		await page.getByRole("button", { name: "Más acciones de @arq" }).click();
		await page.getByRole("menuitem", { name: /^Ajustes del agente/ }).click();
		await expect(page.locator(`${DIALOG} h2`)).toHaveText("Ajustes de @arq");
	});
});

test.describe("a new agent's model and effort", () => {
	test.beforeEach(({ backend }) => backend.enableAcp());

	test("creating an agent with Opus sends its model id; Sonnet stays the default", async ({
		page,
		app,
		backend,
	}) => {
		const created: Array<Record<string, unknown>> = [];
		backend.override = async (method, path, route) => {
			if (method !== "POST" || path !== "/sessions") return false;
			created.push(JSON.parse(route.request().postData() ?? "{}"));
			await route.fulfill({
				status: 400,
				contentType: "application/json",
				body: '{"error":"stop here"}',
			});
			return true;
		};
		await app.login("alice");
		await app.openSidebar();
		await page.click("#new-session-btn");
		await page.fill("#new-session-input", "arquitectura");
		await page.fill("#new-session-acp-agent", "architect");
		const model = page.locator("#new-session-acp-model");
		await expect(model).toHaveValue("claude-sonnet-5-5");
		expect(await model.locator("option").allTextContents()).toEqual([
			"Claude Sonnet 5.5",
			"Claude Opus 5.5",
			"Claude Fable 5.2",
		]);
		await model.selectOption({ label: "Claude Opus 5.5" });
		await page.click("#new-session-submit");
		await expect.poll(() => created.length).toBe(1);
		expect(created[0]?.acpAgent).toMatchObject({ name: "architect", model: "claude-opus-5-5" });
	});

	test("its levels are the ones reported for the chosen model; Default is not sent", async ({
		page,
		app,
		backend,
	}) => {
		backend.acpAgents.find((a) => a.name === "arq")!.effortApplied = {
			model: "claude-opus-5-5",
			requested: "default",
			current: "default",
			levels: ["default", "low", "max"],
			error: null,
		};
		const created: Array<Record<string, unknown>> = [];
		backend.override = async (method, path, route) => {
			if (method !== "POST" || path !== "/sessions") return false;
			created.push(JSON.parse(route.request().postData() ?? "{}"));
			await route.fulfill({
				status: 400,
				contentType: "application/json",
				body: '{"error":"stop here"}',
			});
			return true;
		};
		await app.login("alice");
		await app.openSidebar();
		await page.click("#new-session-btn");
		await page.fill("#new-session-input", "arquitectura");
		await page.fill("#new-session-acp-agent", "architect");
		const effort = page.locator("#new-session-acp-effort");
		await expect.poll(() => effort.locator("option").allTextContents()).toEqual(["Por defecto"]);
		await page.locator("#new-session-acp-model").selectOption("claude-opus-5-5");
		expect(await effort.locator("option").allTextContents()).toEqual(["Por defecto", "Low", "Max"]);
		await page.click("#new-session-submit");
		await expect.poll(() => created.length).toBe(1);
		expect(created[0]?.acpAgent).not.toHaveProperty("effort");
		await effort.selectOption("max");
		await page.click("#new-session-submit");
		await expect.poll(() => created.length).toBe(2);
		expect(created[1]?.acpAgent).toMatchObject({ model: "claude-opus-5-5", effort: "max" });
	});
});
