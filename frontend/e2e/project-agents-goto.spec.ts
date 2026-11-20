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

	test("the state goes to the message: in view, flashed, focused; the phone's list closes; news does not move it", async ({
		app,
		backend,
		page,
	}, info) => {
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
		await expect(go).toHaveText(`trabajando en #${running}`);
		await go.click();
		if (info.project.use.isMobile) await expect(list).toBeHidden();
		// In view, near the thread's top; the focus on it.
		await expect.poll(() => rowTop(page, running)).toBeGreaterThanOrEqual(0);
		const top = await rowTop(page, running);
		expect(top).toBeLessThan(40);
		expect(
			await page.evaluate(
				(id) => document.activeElement?.getAttribute("data-ids")?.split(" ").includes(String(id)),
				running,
			),
		).toBe(true);
		await expect(page.locator(`${THREAD} [data-ids~="${running}"]`)).toHaveClass(/acp-msg-flash/);
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
		await expect(devRow.locator(".acp-status")).toHaveText(`trabajando en #${direct.id}`);
		await expect(devRow.locator("button.acp-status")).toHaveCount(0);
		await list.getByRole("button", { name: /^Ir al mensaje en curso de @arq/ }).click();
		await expect(page.locator("#acp-agents-list .acp-agents-list-note")).toContainText(
			`No se encontró el mensaje #${old.id}`,
		);
	});
});
