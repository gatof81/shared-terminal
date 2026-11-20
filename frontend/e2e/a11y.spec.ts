import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS, SESSION_IDS } from "./mockBackend.js";

/**
 * Accessibility sweep (UX audit A1–A4): axe-core over the main views, in
 * every project (both shells, desktop and phone). The bar is "no critical
 * or serious violation" — the WCAG A/AA rules a screen-reader or keyboard
 * user actually trips on. A new violation fails here with its rule and the
 * element, instead of waiting for the next manual audit.
 */

const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

interface Violation {
	id: string;
	impact: string | null;
	nodes: string[];
}

async function violations(page: Page, include?: string[]): Promise<Violation[]> {
	await page.evaluate(AXE);
	return page.evaluate(async (inc) => {
		// biome-ignore lint/suspicious/noExplicitAny: axe is injected as a page global.
		const res = await (window as any).axe.run(inc ? { include: inc.map((x) => [x]) } : document, {
			runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
		});
		// biome-ignore lint/suspicious/noExplicitAny: axe's result shape.
		return res.violations.map((v: any) => ({
			id: v.id,
			impact: v.impact,
			// biome-ignore lint/suspicious/noExplicitAny: axe's result shape.
			nodes: v.nodes.map((n: any) => n.target.join(" ")),
		}));
	}, include);
}

async function expectClean(page: Page, view: string, include?: string[]): Promise<void> {
	const bad = (await violations(page, include)).filter(
		(v) => v.impact === "critical" || v.impact === "serious",
	);
	expect(bad, `axe on ${view}`).toEqual([]);
}

test.describe("accessibility — axe on the main views", () => {
	test("session views: Terminal, Files, Git, Chat", async ({ app, page }) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		// Phones (v1): the tabs live in the chrome drawer.
		await app.openChrome();
		await expect(page.locator("#terminal-tabs .tab-chip-btn")).toHaveCount(2);
		await expectClean(page, "terminal");
		for (const view of ["files", "git", "chat"]) {
			await page.goto(`/#/sessions/${SESSION_IDS.running}/${view}`);
			await expect(page.locator(`#${view}-view`)).toBeVisible();
			await expectClean(page, view);
		}
	});

	test("sidebar tree and a project page", async ({ app, backend, page }) => {
		backend.enableProjects();
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		await expect(page.locator("#project-view .pv-title")).toBeVisible();
		await expectClean(page, "project page");
		await app.openSidebar();
		await expect(app.sessionRow("hz-architect")).toBeVisible();
		await expectClean(page, "sidebar");
	});

	test("ACP chats: settings and the manage panel open, a refused model flagged", async ({
		app,
		backend,
		page,
	}) => {
		backend.enableAcp();
		const solo = backend.acpAgents.find((a) => a.name === "solo")!;
		solo.projectId = PROJECT_IDS.hz;
		solo.model = "claude-opus-5-5";
		solo.modelApplied = { requested: "claude-opus-5-5", current: null, error: "no disponible" };
		await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`);
		await expect(page.locator("#acp-chat .acp-settings-btn")).toBeVisible();
		// The whole page: the threads' text passes too (#380).
		await expectClean(page, "ACP chat, settings closed");
		await page.locator("#acp-chat .acp-settings-btn").click();
		await expect(page.locator("#acp-chat .acp-model-select")).toBeVisible();
		await expectClean(page, "ACP chat, settings open");
		await page.goto(`/#/projects/${PROJECT_IDS.hz}`);
		await page.getByRole("button", { name: "Acciones del proyecto" }).click();
		await page.getByRole("menuitem", { name: "Administrar agentes" }).click();
		await expect(page.locator("#project-view .acp-agents-panel")).toBeVisible();
		await expectClean(page, "Project Chat, manage panel open");
		// The recipients menu and the agents' list open.
		await page.keyboard.press("Escape");
		await page.getByRole("button", { name: "Elegir destinatarios" }).click();
		await expect(page.getByRole("menu", { name: "Destinatarios" })).toBeVisible();
		await expectClean(page, "Project Chat, recipients menu open");
		await page.keyboard.press("Escape");
		await page.locator("#project-view .acp-agents-group").click();
		await expect(page.locator("#project-view .acp-agents-list")).toBeVisible();
		await expectClean(page, "Project Chat, agents list open");
	});

	test("ACP threads, every kind of row, on the whole page (no exclusions)", async ({
		app,
		backend,
		page,
	}) => {
		backend.enableAcp();
		const hz = PROJECT_IDS.hz;
		// The project's thread: a post to two agents, a consult and its delivered
		// reply, a reply whose consult is elsewhere, work with activity, a question,
		// a queued message.
		backend.addAcpMessage({
			to_id: "arq",
			body: "@arq @dev ¿cómo encaramos el login?",
			client_id: "p1",
			project_id: hz,
			state: "done",
			result_text: "Propongo **OAuth**.",
		});
		backend.addAcpMessage({
			to_id: "dev",
			body: "@arq @dev ¿cómo encaramos el login?",
			client_id: "p1",
			project_id: hz,
			state: "done",
			result_text: "Falta el callback.",
		});
		const consult = backend.addAcpMessage({
			from_id: "arq",
			to_id: "dev",
			body: "¿El callback está?",
			project_id: hz,
			depth: 1,
			state: "done",
			result_text: "Todavía no.",
		});
		backend.addAcpMessage({
			from_id: "dev",
			to_id: "arq",
			kind: "reply",
			reply_to: consult.id,
			body: "Todavía no.",
			project_id: hz,
			depth: 1,
			state: "done",
			result_text: "Anotado.",
		});
		backend.addAcpMessage({
			from_id: "dev",
			to_id: "arq",
			kind: "reply",
			reply_to: 999,
			body: "El refresh sigue rojo.",
			project_id: hz,
			depth: 1,
			state: "done",
			result_text: "Lo miro.",
		});
		const running = backend.addAcpMessage({
			to_id: "dev",
			body: "@dev implementá el callback",
			project_id: hz,
			state: "running",
		});
		backend.acpActivity = {
			dev: [
				{
					seq: 1,
					at: "2026-10-31T10:29:00Z",
					messageId: running.id,
					kind: "tool",
					toolCallId: "t1",
					title: "Read",
					detail: "auth/session.ts",
					status: "completed",
				},
			],
		};
		const asking = backend.addAcpMessage({
			to_id: "arq",
			body: "@arq elegí el proveedor",
			project_id: hz,
			state: "running",
		});
		backend.acpQuestions = [
			{
				id: 1,
				agent: "arq",
				message_id: asking.id,
				request: JSON.stringify({
					message: "¿Qué proveedor?",
					requestedSchema: {
						type: "object",
						properties: { p: { type: "string", title: "Proveedor", enum: ["GitHub", "Google"] } },
						required: ["p"],
					},
				}),
				state: "open",
				answer: null,
				created_at: "2026-10-31T10:29:30Z",
				answered_at: null,
				delivered_at: null,
				note: null,
			},
		];
		backend.addAcpMessage({ to_id: "dev", body: "@dev después los tests", project_id: hz });
		// A direct chat: done, uncertain (with its note and Volver a encolar), failed, queued.
		backend.addAcpMessage({
			to_id: "solo",
			body: "Interrumpido",
			state: "uncertain",
			note: "El runner se reinició.",
		});
		backend.addAcpMessage({
			to_id: "solo",
			body: "Falló",
			state: "failed",
			note: "Error del adaptador.",
		});
		backend.addAcpMessage({ to_id: "solo", body: "En cola" });
		await app.login("alice", `#/projects/${hz}`);
		await expect(page.locator("#project-view .acp-question-open")).toBeVisible();
		await expectClean(page, "Project Chat thread");
		await page.goto(`/#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`);
		await expect(page.locator("#acp-chat .acp-msg", { hasText: "Interrumpido" })).toBeVisible();
		await expectClean(page, "individual chat thread");
	});
});
