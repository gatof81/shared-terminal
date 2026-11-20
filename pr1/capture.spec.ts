import { mkdirSync } from "node:fs";
import { expect, test } from "../e2e/fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS } from "../e2e/mockBackend.js";
const OUT = process.env.CAP_OUT!;
async function shot(page: any, name: string) {
	mkdirSync(OUT, { recursive: true });
	await page.addStyleTag({ content: "#toast{display:none!important}" }).catch(() => {});
	await page.waitForTimeout(450);
	await page.screenshot({ path: `${OUT}/${name}-${test.info().project.name}.png` });
}
const up = (page: any, sel: string, frac = 0.35) =>
	page.evaluate(([s, f]: [string, number]) => { const t = document.querySelector(s) as HTMLElement; t.style.scrollBehavior = "auto"; t.scrollTop = (t.scrollHeight - t.clientHeight) * f; t.dispatchEvent(new Event("scroll")); }, [sel, frac]);
function fill(backend: any) {
	backend.enableAcp();
	for (let i = 1; i <= 24; i++) {
		backend.addAcpMessage({ to_id: "solo", body: `Pedido ${i}: revisá el módulo ${i}`, state: "done", result_text: `Respuesta ${i}.\n\nEl módulo ${i} está bien; cambiaría dos nombres y agregaría un test.` });
		backend.addAcpMessage({ to_id: "arq", body: `@arq tema ${i}`, state: "done", result_text: `Tema ${i} resuelto.\n\nCon una segunda línea.`, project_id: PROJECT_IDS.hz });
	}
}
test("acp chat: end button", async ({ page, app, backend }) => {
	fill(backend);
	await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`);
	const t = "#acp-chat .acp-chat-thread";
	await expect(page.locator(t)).toContainText("Respuesta 24.");
	await page.waitForTimeout(400);
	await up(page, t);
	await shot(page, "pr1-acp-arrow");
	for (let i = 0; i < 3; i++) { const r = backend.addAcpMessage({ to_id: "solo", from_id: "arq", body: `Nuevo ${i}` }); backend.pushAcp({ type: "message", message: r }); }
	await expect(page.locator(t)).toContainText("Nuevo 2");
	await shot(page, "pr1-acp-count");
});
test("project chat: end button", async ({ page, app, backend }) => {
	fill(backend);
	await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
	const t = "#project-view .acp-chat-thread";
	await expect(page.locator(t)).toContainText("Tema 24 resuelto.");
	await page.waitForTimeout(400);
	await up(page, t);
	const r = backend.addAcpMessage({ to_id: "owner", from_id: "arq", kind: "reply", body: "Listo", project_id: PROJECT_IDS.hz });
	backend.pushAcp({ type: "message", message: r });
	await page.waitForTimeout(300);
	await shot(page, "pr1-project-count");
});
test("capture chat: end button", async ({ page, app, backend }) => {
	const conv = backend.conversations[0]!;
	for (let i = 0; i < 60; i++) conv.events.push({ seq: (conv.events.at(-1)?.seq ?? 0) + 1, ts: conv.events.at(-1)!.ts, ev: "assistant_delta", prompt_id: `p${i}`, turn_id: `t${i}`, agent_id: null, pane: "%1", data: { message_id: `mf${i}`, index: 0, delta: `Filler message ${i}`, final: true } });
	await app.login("alice");
	await app.openSession("my-project");
	await app.switchView("chat");
	await page.locator("#chat-list .chat-conv-row", { hasText: "Refactor auth flow" }).click();
	const t = "#chat-thread .chat-scroll";
	await expect(page.locator(t)).toContainText("Filler message 59");
	await page.waitForTimeout(400);
	await up(page, t, 0.5);
	backend.pushConversationEvent("conv-1", { ts: new Date().toISOString(), ev: "assistant_delta", prompt_id: "pn", turn_id: "tn", agent_id: null, pane: "%1", data: { message_id: "mn", index: 0, delta: "Arrived", final: true } });
	await page.waitForTimeout(300);
	await shot(page, "pr1-capture-count");
});
