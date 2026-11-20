import { mkdirSync } from "node:fs";
import { expect, test } from "../e2e/fixtures.js";
import { PROJECT_SESSION_IDS } from "../e2e/mockBackend.js";
const OUT = process.env.CAP_OUT!;
async function shot(page: any, name: string) {
	mkdirSync(OUT, { recursive: true });
	await page.addStyleTag({ content: "#toast{display:none!important}" }).catch(() => {});
	await page.waitForTimeout(450);
	await page.screenshot({ path: `${OUT}/${name}-${test.info().project.name}.png` });
}
test("agent session: chat", async ({ page, app, backend }) => {
	backend.enableAcp();
	const solo = backend.acpAgents.find((a: any) => a.name === "arq")!;
	solo.model = "claude-opus-5-5"; solo.modelApplied = { requested: "claude-opus-5-5", current: null, error: "no disponible" };
	await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.architect}/chat`);
	await expect(page.locator("#acp-chat")).toBeVisible();
	await shot(page, "pr5-agent-chat");
	await app.switchView("terminal").catch(() => {});
	await shot(page, "pr5-agent-terminal");
});
test("traditional session: terminal and files", async ({ page, app, backend }) => {
	backend.enableAcp();
	await app.login("alice");
	await app.openSession("my-project");
	await shot(page, "pr5-plain-terminal");
	await app.switchView("files");
	await shot(page, "pr5-plain-files");
});
