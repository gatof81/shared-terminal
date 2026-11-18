// ACP chats (individual + Project Chat) against the mock's /acp routes and
// /ws/acp: what a person must not lose or misdirect while agents work.

import { expect, test } from "./fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS } from "./mockBackend.js";

const chatOf = (sid: string) => `#/sessions/${sid}/chat`;
const activity = (agent: string, seq: number) => ({
	type: "activity",
	agent,
	events: [{ seq, at: "2026-10-31T10:29:59Z", messageId: null, kind: "turn" }],
});

test.describe("ACP chat", () => {
	test.beforeEach(({ backend }) => backend.enableAcp());

	test("an answer reads as Markdown, and a live event keeps the reader's selection", async ({
		page,
		app,
		backend,
	}) => {
		await app.login("alice", chatOf(PROJECT_SESSION_IDS.scratch));
		const result = page.locator("#acp-chat .acp-msg-result");
		await expect(result.locator("h2")).toHaveText("Resumen");
		await expect(result.locator("strong")).toHaveText("dos");
		await expect(result.locator(".chat-pre .chat-copy")).toHaveCount(1);
		await page.evaluate(() => {
			const r = document.createRange();
			r.selectNodeContents(document.querySelector("#acp-chat .acp-msg-result h2")!);
			getSelection()!.removeAllRanges();
			getSelection()!.addRange(r);
		});
		backend.pushAcp(activity("solo", 1));
		backend.addAcpMessage({ to_id: "solo", body: "otra cosa" });
		backend.pushAcp({ type: "message", message: backend.acpMessages.at(-1) });
		await expect(page.locator("#acp-chat .acp-msg")).toHaveCount(2);
		expect(await page.evaluate(() => String(getSelection()))).toBe("Resumen");
	});

	test("an unsaved project choice and its focus survive live updates", async ({
		page,
		app,
		backend,
	}) => {
		await app.login("alice", chatOf(PROJECT_SESSION_IDS.scratch));
		const select = page.locator("#acp-chat .acp-project-select");
		await select.selectOption({ label: "Educación HZ" });
		await select.focus();
		backend.pushAcp(activity("solo", 1));
		backend.pushAcp(activity("solo", 2));
		await page.waitForTimeout(300);
		await expect(select).toHaveValue(PROJECT_IDS.hz);
		await expect(select).toBeFocused();
		await page.locator("#acp-chat .acp-chat-project button", { hasText: "Guardar" }).click();
		await expect(
			page.locator("#acp-chat .acp-link", { hasText: "Abrir Project Chat" }),
		).toBeVisible();
		expect(backend.acpAgents.find((a) => a.name === "solo")?.projectId).toBe(PROJECT_IDS.hz);
	});

	test("a draft stays with its agent", async ({ page, app }) => {
		await app.login("alice", chatOf(PROJECT_SESSION_IDS.scratch));
		const input = page.locator("#acp-chat .acp-chat-input");
		await input.fill("solo para @solo");
		await page.evaluate((h) => {
			location.hash = h;
		}, chatOf(PROJECT_SESSION_IDS.architect));
		await expect(page.locator("#acp-chat .acp-chat-title")).toContainText("@arq");
		await expect(input).toHaveValue("");
		await page.evaluate((h) => {
			location.hash = h;
		}, chatOf(PROJECT_SESSION_IDS.scratch));
		await expect(page.locator("#acp-chat .acp-chat-title")).toContainText("@solo");
		await expect(input).toHaveValue("solo para @solo");
	});

	test("Project Chat refuses an unknown leading mention, next to the field", async ({
		page,
		app,
		backend,
	}) => {
		await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
		const input = page.locator("#project-view .acp-chat-input");
		await expect(page.locator("#project-view .acp-agent-chip")).toHaveCount(2);
		await input.fill("@devv revisá con @arq");
		await page.locator("#project-view .acp-chat-send").click();
		const error = page.locator("#project-view .acp-chat-composer .acp-chat-error");
		await expect(error).toContainText("@devv");
		await expect(error).toBeInViewport();
		await expect(input).toHaveValue("@devv revisá con @arq");
		expect(
			backend.requests.filter((r) => r.method === "POST" && r.path === "/acp/messages"),
		).toEqual([]);
		// Fixed, it goes to exactly the named agent.
		await input.fill("@dev revisá con @arq");
		await page.locator("#project-view .acp-chat-send").click();
		await expect(input).toHaveValue("");
		await expect(error).toBeHidden();
		expect(backend.acpMessages.at(-1)).toMatchObject({ to_id: "dev", project_id: PROJECT_IDS.hz });
	});
});
