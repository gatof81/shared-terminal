import type { Route } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { PROJECT_IDS } from "./mockBackend.js";

/**
 * "+ Nueva sesión con agente" opens the new-session dialog in agent mode
 * (newSession.ts): "Nuevo agente", the agent's name first and required, the
 * session named after it. Both modes check the session name and the agent's
 * name before sending, with the message next to the field. The sidebar's
 * "+ New session" stays the ordinary dialog.
 */
test.describe("new agent form", () => {
	let posts: Array<Record<string, unknown>> = [];
	test.beforeEach(({ backend }) => {
		backend.enableAcp();
		posts = [];
		backend.override = async (method: string, path: string, route: Route) => {
			if (method !== "POST" || path !== "/sessions") return false;
			const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
			posts.push(body);
			// The backend's answer for a name already taken (acp agents are unique per owner).
			if ((body.acpAgent as { name?: string } | undefined)?.name === "arq") {
				await route.fulfill({
					status: 409,
					contentType: "application/json",
					body: '{"error":"agent-name-taken"}',
				});
				return true;
			}
			const sid = `7c1f2c3d-0000-4000-8000-${String(posts.length).padStart(12, "0")}`;
			backend.sessions.push({
				sessionId: sid,
				ownerUserId: "u-alice",
				name: String(body.name),
				status: "running",
				tabs: [],
				createdAt: backend.sessions[0]!.createdAt,
			});
			await route.fulfill({
				status: 201,
				contentType: "application/json",
				body: JSON.stringify({
					...backend.serialize(backend.sessions.at(-1)!),
					bootstrapping: false,
				}),
			});
			return true;
		};
	});

	async function openFromProjectChat(page: import("@playwright/test").Page): Promise<void> {
		await page.getByRole("button", { name: "+ Nueva sesión con agente" }).click();
		await expect(page.locator("#new-session-modal-title")).toBeVisible();
	}

	test("from Project Chat: one field and one click create the agent in that project", async ({
		app,
		page,
	}) => {
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		await openFromProjectChat(page);
		await expect(page.locator("#new-session-modal-title")).toHaveText(
			"Nuevo agente en Educación HZ",
		);
		await expect(page.locator("#new-session-submit")).toHaveText("Crear agente");
		const agent = page.locator("#new-session-acp-agent");
		await expect(agent).toBeFocused();
		await expect(agent).toHaveAttribute("required", "");
		// The agent's field comes first.
		const agentY = (await agent.boundingBox())!.y;
		expect(agentY).toBeLessThan((await page.locator("#new-session-input").boundingBox())!.y);
		await expect(page.locator("#new-session-acp-project")).toHaveValue(PROJECT_IDS.hz);
		await agent.fill("developer");
		await expect(page.locator("#new-session-input")).toHaveValue("developer");
		await page.click("#new-session-submit");
		await expect.poll(() => posts.length).toBe(1);
		expect(posts[0]).toMatchObject({
			name: "developer",
			acpAgent: { name: "developer", projectId: PROJECT_IDS.hz },
		});
		await expect(app.toast("Agente @developer creado")).toBeVisible();
	});

	test("a session name written by hand stops following the agent's", async ({ app, page }) => {
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		await openFromProjectChat(page);
		const agent = page.locator("#new-session-acp-agent");
		const session = page.locator("#new-session-input");
		await agent.fill("dev");
		await expect(session).toHaveValue("dev");
		await session.fill("mi-sesion");
		await agent.fill("developer");
		await expect(session).toHaveValue("mi-sesion");
	});

	test("an invalid agent name is said next to the field and nothing is sent; an empty one too", async ({
		app,
		page,
	}) => {
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		await openFromProjectChat(page);
		const agent = page.locator("#new-session-acp-agent");
		await agent.fill("Dev_1");
		await page.click("#new-session-submit");
		const error = page.locator("#new-session-acp-agent-error");
		await expect(error).toHaveText(/Minúsculas, números y guiones/);
		await expect(agent).toHaveAttribute("aria-invalid", "true");
		await expect(agent).toHaveAttribute("aria-describedby", "new-session-acp-agent-error");
		await expect(agent).toBeFocused();
		// Fixing it clears the message.
		await agent.fill("dev-1");
		await expect(error).toHaveText("");
		await expect(agent).not.toHaveAttribute("aria-invalid", "true");
		await agent.fill("");
		await page.locator("#new-session-input").fill("");
		await page.click("#new-session-submit");
		await expect(error).toHaveText("Escribí el nombre del agente.");
		await expect(page.locator("#new-session-input-error")).toHaveText(
			"Escribí un nombre para la sesión.",
		);
		await expect(agent).toBeFocused();
		await page.waitForTimeout(200);
		expect(posts).toEqual([]);
	});

	test("the sidebar's + New session stays the ordinary dialog, also after agent mode", async ({
		app,
		page,
	}) => {
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		await openFromProjectChat(page);
		await expect(page.locator("#new-session-modal-title")).toHaveText(/Nuevo agente/);
		await page.keyboard.press("Escape");
		await expect(page.locator("#new-session-modal-title")).toBeHidden();
		await app.openSidebar();
		await page.click("#new-session-btn");
		await expect(page.locator("#new-session-modal-title")).toHaveText("New session");
		await expect(page.locator("#new-session-submit")).toHaveText("Create session");
		const session = page.locator("#new-session-input");
		await expect(session).toBeFocused();
		const agent = page.locator("#new-session-acp-agent");
		await expect(agent).not.toHaveAttribute("required", "");
		await expect(page.locator("label", { has: agent })).toContainText("Agente ACP (opcional)");
		expect((await session.boundingBox())!.y).toBeLessThan((await agent.boundingBox())!.y);
		// Empty name: said next to the field, nothing sent.
		await page.click("#new-session-submit");
		await expect(page.locator("#new-session-input-error")).toHaveText("Enter a session name.");
		await expect(session).toHaveAttribute("aria-invalid", "true");
		await expect(session).toBeFocused();
		// An optional agent name is still checked when written.
		await session.fill("plain");
		await agent.fill("X");
		await page.click("#new-session-submit");
		await expect(page.locator("#new-session-acp-agent-error")).toHaveText(/Minúsculas/);
		expect(posts).toEqual([]);
		// Without an agent it creates a session, as before.
		await agent.fill("");
		await page.click("#new-session-submit");
		await expect.poll(() => posts.length).toBe(1);
		expect(posts[0]).toEqual({ name: "plain" });
		await expect(app.toast('Session "plain" created')).toBeVisible();
	});

	test("a name already taken is said next to the field; what was written stays", async ({
		app,
		page,
	}) => {
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		await openFromProjectChat(page);
		// Agent mode in Spanish: the session's label and the progress toast.
		await expect(page.locator("#new-session-input-label")).toHaveText("Nombre de la sesión");
		const agent = page.locator("#new-session-acp-agent");
		await agent.fill("arq");
		await page.click("#new-session-submit");
		await expect(app.toast("Creando agente…")).toBeVisible();
		await expect(page.locator("#new-session-acp-agent-error")).toHaveText(
			"Ya hay un agente @arq; elegí otro nombre.",
		);
		await expect(agent).toHaveAttribute("aria-invalid", "true");
		await expect(agent).toBeFocused();
		await expect(agent).toHaveValue("arq");
		await expect(page.locator("#new-session-input")).toHaveValue("arq");
		await expect(app.toast("agent-name-taken")).toHaveCount(0);
		await expect(page.locator("#new-session-submit")).toBeEnabled();
	});

	test("closing gives the focus back to the button that opened it (or the project's title)", async ({
		app,
		page,
	}) => {
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		const opener = page.getByRole("button", { name: "+ Nueva sesión con agente" });
		for (const close of ["Escape", "cancel", "x"] as const) {
			await openFromProjectChat(page);
			if (close === "Escape") await page.keyboard.press("Escape");
			else if (close === "cancel")
				await page
					.locator("#new-session-modal button[data-close-modal]", { hasText: "Cancel" })
					.click();
			else await page.locator("#new-session-modal .modal-close").click();
			await expect(page.locator("#new-session-modal-title")).toBeHidden();
			await expect(opener, `after ${close}`).toBeFocused();
		}
		// The opener left the page while the dialog was open: the project's title.
		await openFromProjectChat(page);
		await opener.evaluate((b) => b.remove());
		await page.keyboard.press("Escape");
		await expect(page.locator("#pv-title")).toBeFocused();
		// The sidebar's dialog keeps its English label.
		await app.openSidebar();
		await page.click("#new-session-btn");
		await expect(page.locator("#new-session-input-label")).toHaveText("Session name");
	});
});
