import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { PROJECT_IDS } from "./mockBackend.js";

/**
 * "Agentes del proyecto" → the message an agent works on: its state is a
 * button that puts that message of Project Chat in view (loading back up to
 * three pages), flashes it and gives it the focus; on a phone the list
 * closes. The reader is then away from the end like any reader: "Ir al
 * final" shows and news does not move them (chat-scroll.spec's rules).
 * A message that is not this chat's keeps the state as plain text.
 */

const THREAD = "#project-view .acp-chat-thread";

async function openList(page: Page): Promise<Locator> {
	await page.locator("#project-view .acp-agents-group").click();
	const list = page.locator("#acp-agents-list");
	await expect(list).toBeVisible();
	return list;
}

/** The row showing message `id`, and where its top sits in the thread. */
const rowTop = (page: Page, id: number) =>
	page.evaluate(
		([sel, id]) => {
			const t = document.querySelector<HTMLElement>(sel as string)!;
			const row = t.querySelector<HTMLElement>(`[data-ids~="${id}"]`);
			if (!row) return Number.NaN;
			return Math.round(row.getBoundingClientRect().top - t.getBoundingClientRect().top);
		},
		[THREAD, id] as const,
	);

test.describe("Project Chat: to an agent's running message", () => {
	test.beforeEach(({ backend }) => backend.enableAcp());

	test("the state goes to the message: at a quarter of the thread, flashed, focused; the list closes; news does not move it", async ({
		app,
		backend,
		page,
	}) => {
		let running = 0;
		for (let i = 1; i <= 30; i++) {
			const m = backend.addAcpMessage({
				to_id: "arq",
				body: `@arq tema ${i}`,
				state: i === 6 ? "running" : "done",
				result_text: i === 6 ? null : `Tema ${i} resuelto.\n\nCon otra línea.`,
				project_id: PROJECT_IDS.hz,
			});
			if (i === 6) running = m.id;
		}
		backend.acpAgents.find((a) => a.name === "arq")!.running = running;
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		await expect(page.locator(THREAD)).toContainText("Tema 30 resuelto.");
		const list = await openList(page);
		const go = list.getByRole("button", { name: /^Ir al mensaje en curso de @arq/ });
		await expect(go).toContainText(`trabajando en #${running}`);
		// A chip with its fill and "›" — told from a plain state without colour.
		await expect(go).toHaveClass(/\bchip\b/);
		await expect(go).not.toHaveClass(/\bbare\b/);
		await expect(go.locator(".acp-agents-list-goto-mark")).toHaveText("›");
		await go.click();
		await expect(list).toBeHidden();
		// At a quarter of the thread's height (±8 px); the focus on it.
		const h = await page.locator(THREAD).evaluate((e) => e.clientHeight);
		await expect.poll(() => rowTop(page, running)).toBeGreaterThanOrEqual(0);
		const top = await rowTop(page, running);
		expect(Math.abs(top - Math.round(h * 0.25))).toBeLessThanOrEqual(8);
		expect(
			await page.evaluate(
				(id) => document.activeElement?.getAttribute("data-ids")?.split(" ").includes(String(id)),
				running,
			),
		).toBe(true);
		const target = page.locator(`${THREAD} [data-ids~="${running}"]`);
		await expect(target).toHaveClass(/acp-msg-flash/);
		// A ring, not a border: nothing in the layout moves.
		expect(await target.evaluate((e) => getComputedStyle(e).boxShadow)).toContain("2px");
		await expect(target).not.toHaveClass(/acp-msg-flash/, { timeout: 4_000 });
		// Away from the end: "Ir al final"; a new message does not move the reader.
		await expect(page.locator("#project-view .chat-end")).toBeVisible();
		const row = backend.addAcpMessage({
			to_id: "owner",
			from_id: "dev",
			kind: "reply",
			body: "Llegó después",
			project_id: PROJECT_IDS.hz,
		});
		backend.pushAcp({ type: "message", message: row });
		await expect(page.locator(THREAD)).toContainText("Llegó después");
		await page.waitForTimeout(200);
		expect(Math.abs((await rowTop(page, running)) - top)).toBeLessThanOrEqual(1);
	});

	test("a message on an earlier page is loaded back and shown", async ({ app, backend, page }) => {
		let running = 0;
		for (let i = 1; i <= 110; i++) {
			const m = backend.addAcpMessage({
				to_id: "arq",
				body: `@arq tema ${i}`,
				state: i === 2 ? "running" : "done",
				result_text: i === 2 ? null : `Tema ${i} resuelto.`,
				project_id: PROJECT_IDS.hz,
			});
			if (i === 2) running = m.id;
		}
		backend.acpAgents.find((a) => a.name === "arq")!.running = running;
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		await expect(page.locator(THREAD)).toContainText("Tema 110 resuelto.");
		await expect(page.locator(`${THREAD} [data-ids~="${running}"]`)).toHaveCount(0);
		const list = await openList(page);
		await list.getByRole("button", { name: /^Ir al mensaje en curso de @arq/ }).click();
		await expect(page.locator(`${THREAD} [data-ids~="${running}"]`)).toBeInViewport();
	});

	test("a message that is not this chat's: the state stays text; one not found is said in the row", async ({
		app,
		backend,
		page,
	}) => {
		// @arq on an old direct message, older than the project's page: it may
		// be on an earlier page, so it is looked for — and not found.
		const old = backend.addAcpMessage({ to_id: "arq", body: "viejo", state: "running" });
		for (let i = 1; i <= 110; i++)
			backend.addAcpMessage({
				to_id: "arq",
				body: `@arq tema ${i}`,
				state: "done",
				result_text: `Tema ${i} resuelto.`,
				project_id: PROJECT_IDS.hz,
			});
		backend.acpAgents.find((a) => a.name === "arq")!.running = old.id;
		// @dev works on a DIRECT message newer than the project's page (so not
		// on an earlier one): not this chat's, nothing to go to.
		const direct = backend.addAcpMessage({ to_id: "dev", body: "privado", state: "running" });
		backend.acpAgents.find((a) => a.name === "dev")!.running = direct.id;
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		await expect(page.locator(THREAD)).toContainText("Tema 110 resuelto.");
		const list = await openList(page);
		const devRow = list.locator(".acp-agents-list-item", { hasText: "@dev" });
		await expect(devRow.locator(".acp-agents-list-state")).toHaveText(`trabajando en #${direct.id}`);
		await expect(devRow.locator("button.acp-agents-list-state")).toHaveCount(0);
		await list.getByRole("button", { name: /^Ir al mensaje en curso de @arq/ }).click();
		await expect(page.locator("#acp-agents-list .acp-agents-list-note")).toContainText(
			`No se encontró el mensaje #${old.id}`,
		);
	});
});

test.describe("Project Chat: the agents list on a phone", () => {
	test.beforeEach(({ backend }) => backend.enableAcp());

	test("over the thread (it does not move), clear of the message box; 64-px rows; a tap outside only closes it", async ({
		app,
		backend,
		page,
	}, info) => {
		test.skip(!info.project.use.isMobile, "a phone");
		for (let i = 1; i <= 20; i++)
			backend.addAcpMessage({
				to_id: "arq",
				body: `@arq tema ${i}`,
				state: "done",
				result_text: `Tema ${i} resuelto.`,
				project_id: PROJECT_IDS.hz,
			});
		const dev = backend.acpAgents.find((a) => a.name === "dev")!;
		for (const name of ["infraestructura-y-despliegues", "qa", "seguridad"])
			backend.acpAgents.push({ ...dev, name, running: null });
		await page.setViewportSize({ width: 390, height: 450 });
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		const thread = page.locator(THREAD);
		await expect(thread).toContainText("Tema 20 resuelto.");
		const where = () =>
			thread.evaluate((e) => [
				Math.round(e.getBoundingClientRect().top),
				e.clientHeight,
				Math.round(e.scrollTop),
			]);
		const before = await where();
		const group = page.locator("#project-view .acp-agents-group");
		await group.click();
		const list = page.locator("#acp-agents-list");
		await expect(list).toBeVisible();
		expect(await where()).toEqual(before);
		const panel = (await list.boundingBox())!;
		const composer = (await page.locator("#project-view .acp-chat-composer").boundingBox())!;
		expect(panel.y + panel.height).toBeLessThanOrEqual(composer.y - 8 + 1);
		expect(Math.round(panel.height)).toBeLessThanOrEqual(270);
		for (const row of await list.locator(".acp-agents-list-item").all())
			expect(Math.abs(Math.round((await row.boundingBox())!.height) - 64)).toBeLessThanOrEqual(1);
		// The long name on one line, cut with an ellipsis, whole in its tooltip.
		const long = list.locator(".acp-agents-list-name", { hasText: "@infraestructura" });
		await expect(long).toHaveAttribute("title", "@infraestructura-y-despliegues");
		expect(Math.round((await long.boundingBox())!.height)).toBeLessThanOrEqual(21);
		// A tap outside (on the thread) only closes it; the focus back on the group.
		await page.mouse.click(3, Math.round(panel.y + 40));
		await expect(list).toBeHidden();
		await expect(group).toBeFocused();
		expect(await where()).toEqual(before);
	});
});

test.describe("Project Chat: to an agent's open question", () => {
	test.beforeEach(({ backend }) => backend.enableAcp());

	test("'esperando tu respuesta' with a running message goes to the question's card, its first control focused", async ({
		app,
		backend,
		page,
	}) => {
		for (let i = 1; i <= 20; i++)
			backend.addAcpMessage({
				to_id: "arq",
				body: `@arq tema ${i}`,
				state: "done",
				result_text: `Tema ${i} resuelto.`,
				project_id: PROJECT_IDS.hz,
			});
		const asking = backend.addAcpMessage({
			to_id: "arq",
			body: "@arq elegí el proveedor",
			state: "running",
			project_id: PROJECT_IDS.hz,
		});
		for (let i = 21; i <= 30; i++)
			backend.addAcpMessage({
				to_id: "dev",
				body: `@dev tema ${i}`,
				state: "done",
				result_text: `Tema ${i} resuelto.`,
				project_id: PROJECT_IDS.hz,
			});
		backend.acpQuestions = [
			{
				id: 1,
				agent: "arq",
				message_id: asking.id,
				request: JSON.stringify({
					message: "¿Qué proveedor usamos?",
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
		const arq = backend.acpAgents.find((a) => a.name === "arq")!;
		arq.running = asking.id;
		arq.waitingInput = true;
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		await expect(page.locator(THREAD)).toContainText("Tema 30 resuelto.");
		const list = await openList(page);
		const go = list.getByRole("button", { name: /^Ir al mensaje en curso de @arq/ });
		await expect(go).toContainText("esperando tu respuesta");
		await go.click();
		const card = page.locator(`${THREAD} .acp-question-open`);
		await expect(card).toHaveClass(/acp-msg-flash-warn/);
		expect(
			await page.evaluate(() => document.activeElement?.closest(".acp-question-open") !== null),
		).toBe(true);
	});
});
