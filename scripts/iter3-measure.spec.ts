import { appendFileSync } from "node:fs";
import { test, expect } from "../e2e/fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS } from "../e2e/mockBackend.js";
test("measure", async ({ page, app, backend }) => {
	backend.enableAcp();
	const m = async (root: string) => page.evaluate((r) => {
		const b = (s: string) => { const e = document.querySelector(s) as HTMLElement | null; if (!e || !e.getClientRects().length) return null; const x = e.getBoundingClientRect(); return { y: Math.round(x.top), h: Math.round(x.height), w: Math.round(x.width) }; };
		return { thread: b(`${r} .acp-chat-thread`), composer: b(`${r} .acp-chat-composer`), field: b(`${r} .acp-chat-input`), send: b(`${r} .acp-chat-send`), pick: b(`${r} .acp-pick-btn`), header: b("header"), bar: b("#terminal-toolbar"), agentHead: b(`${r} .acp-chat-header`), pvHead: b(`${r} .pv-header`) };
	}, root);
	await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`);
	await expect(page.locator("#acp-chat .acp-msg").first()).toBeVisible(); await page.waitForTimeout(300);
	const a = await m("#acp-chat");
	await app.login("alice", `#/projects/${PROJECT_IDS.hz}/chat`); await page.waitForTimeout(500);
	const p = await m(".acp-project");
	appendFileSync("/home/developer/audit/iter3/measure.jsonl", JSON.stringify({ p: test.info().project.name, acp: a, project: p }) + "\n");
});
