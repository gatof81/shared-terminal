import { appendFileSync, mkdirSync } from "node:fs";
import { expect, test } from "../e2e/fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS } from "../e2e/mockBackend.js";
const OUT = process.env.CAP_OUT!;
async function shot(page: any, name: string) {
	mkdirSync(OUT, { recursive: true });
	await page.addStyleTag({ content: "#toast{display:none!important}" }).catch(() => {});
	await page.waitForTimeout(450);
	await page.screenshot({ path: `${OUT}/${name}-${test.info().project.name}.png` });
}
function fill(backend: any) {
	backend.enableAcp();
	for (let i = 1; i <= 16; i++) {
		backend.addAcpMessage({ to_id: "solo", body: `Pedido ${i}: revisá el módulo ${i}`, state: "done", result_text: `Respuesta ${i}.\n\nEl módulo ${i} está bien.` });
		backend.addAcpMessage({ to_id: "arq", body: `@arq tema ${i}`, state: "done", result_text: `Tema ${i} resuelto.`, project_id: PROJECT_IDS.hz });
	}
}
async function measure(page: any, chat: string, state: string, root: string) {
	const m = await page.evaluate((r: string) => {
		const q = (s: string) => document.querySelector(`${r} ${s}`) as HTMLElement | null;
		return { thread: q(".acp-chat-thread")?.clientHeight ?? 0, composer: Math.round(q(".acp-chat-composer")?.getBoundingClientRect().height ?? 0), field: Math.round(q(".acp-chat-input")?.getBoundingClientRect().height ?? 0) };
	}, root);
	mkdirSync(OUT, { recursive: true });
	appendFileSync(`${OUT}/measure.jsonl`, `${JSON.stringify({ size: test.info().project.name, chat, state, ...m })}\n`);
}
const LONG = "@arq @dev revisen esto:\nlínea 2\nlínea 3\nlínea 4\nlínea 5\nlínea 6\nlínea 7\nlínea 8\nlínea 9\nlínea 10";
test("individual chat composer", async ({ page, app, backend }) => {
	fill(backend);
	await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`);
	const r = "#acp-chat";
	await expect(page.locator(`${r} .acp-chat-thread`)).toContainText("Respuesta 16.");
	await page.waitForTimeout(400);
	await measure(page, "agent", "rest", r);
	await shot(page, "pr2-agent-rest");
	const box = page.locator(`${r} .acp-chat-input`);
	await box.click();
	await box.fill("Texto en el campo");
	await shot(page, "pr2-agent-focus-text");
	await box.fill(LONG.replace("@arq @dev ", ""));
	await page.waitForTimeout(200);
	await measure(page, "agent", "multiline", r);
	await shot(page, "pr2-agent-multiline");
});
test("project chat composer", async ({ page, app, backend }) => {
	fill(backend);
	await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
	const r = "#project-view";
	await expect(page.locator(`${r} .acp-chat-thread`)).toContainText("Tema 16 resuelto.");
	await page.waitForTimeout(400);
	await measure(page, "project", "rest", r);
	await shot(page, "pr2-project-rest");
	const box = page.locator(`${r} .acp-chat-input`);
	await box.click();
	await box.fill("@arq @dev revisen el módulo de pagos");
	await shot(page, "pr2-project-to");
	await box.fill(LONG);
	await page.waitForTimeout(200);
	await measure(page, "project", "multiline", r);
	await shot(page, "pr2-project-multiline");
	// A refused send: the error state.
	backend.override = async (method: string, path: string, route: any) => {
		if (method !== "POST" || !path.startsWith("/acp/messages")) return false;
		await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "internal" }) });
		return true;
	};
	await box.fill("@arq revisá esto");
	await box.press("Control+Enter");
	await page.waitForTimeout(500);
	await shot(page, "pr2-project-error");
});
