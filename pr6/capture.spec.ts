import { appendFileSync, mkdirSync } from "node:fs";
import { expect, test } from "../e2e/fixtures.js";
import { PROJECT_IDS } from "../e2e/mockBackend.js";
const OUT = process.env.CAP_OUT!;
test("project chat header", async ({ page, app, backend }) => {
	backend.enableAcp();
	for (let i = 1; i <= 16; i++) backend.addAcpMessage({ to_id: "arq", body: `@arq tema ${i}`, state: "done", result_text: `Tema ${i} resuelto.`, project_id: PROJECT_IDS.hz });
	backend.acpAgents.find((a: any) => a.name === "arq")!.waitingInput = true;
	await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
	await expect(page.locator("#project-view .acp-chat-thread")).toContainText("Tema 16");
	await page.waitForTimeout(500);
	mkdirSync(OUT, { recursive: true });
	const m = await page.evaluate(() => ({ thread: (document.querySelector("#project-view .acp-chat-thread") as HTMLElement).clientHeight, threadTop: Math.round(document.querySelector("#project-view .acp-chat-thread")!.getBoundingClientRect().top) }));
	appendFileSync(`${OUT}/measure.jsonl`, `${JSON.stringify({ size: test.info().project.name, ...m })}\n`);
	await page.addStyleTag({ content: "#toast{display:none!important}" });
	await page.screenshot({ path: `${OUT}/pr6-project-${test.info().project.name}.png` });
});
