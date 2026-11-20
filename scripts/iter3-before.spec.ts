import { mkdirSync } from "node:fs";
import { test, expect } from "../e2e/fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS, SESSION_IDS } from "../e2e/mockBackend.js";
const OUT = "/home/developer/audit/iter3/before";
async function shot(page: any, name: string) {
	mkdirSync(OUT, { recursive: true });
	await page.addStyleTag({ content: "#toast{display:none!important}" }).catch(() => {});
	await page.waitForTimeout(400);
	await page.screenshot({ path: `${OUT}/${name}-${test.info().project.name}.png` });
}
function richAgents(backend: any) {
	backend.enableAcp();
	// A richer sidebar: one agent working, one waiting for the person, one without signal.
	const [arq, dev, solo] = backend.acpAgents;
	dev.running = 3; dev.pending = 1;
	arq.waitingInput = true;
	solo.runnerSeenAt = "2026-10-31T09:00:00Z";
	for (let i = 0; i < 14; i++) backend.addAcpMessage({ to_id: "solo", body: `Pedido ${i}: revisá el módulo ${i} y contame qué cambiarías`, state: "done", result_text: `Respuesta ${i}.\n\nEl módulo ${i} está bien; cambiaría dos nombres y agregaría un test.` });
}
test("sidebar", async ({ page, app, backend }) => {
	richAgents(backend);
	await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`);
	await expect(page.locator("#acp-chat")).toBeVisible();
	if (app.mobile) { await app.openSidebar(); }
	await shot(page, "sidebar");
});
test("project chat + composer", async ({ page, app, backend }) => {
	richAgents(backend);
	await app.login("alice", `#/projects/${PROJECT_IDS.hz}/chat`);
	await page.waitForTimeout(500);
	await shot(page, "project-chat");
	const box = page.locator(".acp-project .acp-chat-input");
	await box.click(); await box.fill("@arq @dev revisen esto:\nlínea 2\nlínea 3\nlínea 4\nlínea 5\nlínea 6\nlínea 7\nlínea 8\nlínea 9\nlínea 10");
	await shot(page, "project-composer-multiline");
});
test("acp chat + pill", async ({ page, app, backend }) => {
	richAgents(backend);
	await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`);
	await expect(page.locator("#acp-chat .acp-msg").first()).toBeVisible();
	await page.waitForTimeout(500);
	await shot(page, "acp-chat");
	// The "new" pill as it renders today (forced visible over a scrolled-up thread).
	await page.evaluate(() => { const t = document.querySelector("#acp-chat .acp-chat-thread") as HTMLElement; t.scrollTop = 0; const p = document.querySelector("#acp-chat .acp-new-pill") as HTMLElement | null; if (p) { p.hidden = false; p.textContent = "↓ 3 nuevos"; } });
	await shot(page, "acp-pill");
	const box = page.locator("#acp-chat .acp-chat-input"); await box.click(); await box.fill("Texto en el campo");
	await shot(page, "acp-composer-focus");
});
test("session views", async ({ page, app, backend }) => {
	backend.enableAcp();
	await app.login("alice", `#/sessions/${SESSION_IDS.running}`);
	await app.expectTerminalReady().catch(() => {});
	await shot(page, "terminal");
	for (const v of ["files", "git", "chat"] as const) { try { await app.switchView(v); await shot(page, v); } catch {} }
});
