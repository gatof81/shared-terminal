// Browser check of an ACP session in the real Shared Terminal web (Pages + API), read-only: opens the session's
// Chat, Terminal, Files and Git views and takes screenshots. Auth: a short-lived owner token passed on stdin, set as
// the API's cookie in this throwaway browser context only. Sends nothing.
// Run from frontend/: node ../experiments/acp-agents/prod-ui-check.mjs <sessionId> <agent> <shots-dir> < token
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const [sid, agent, shots] = process.argv.slice(2);
const token = readFileSync(0, "utf8").trim();
const WEB = "https://shared-terminal.pages.dev";
const API_HOST = "shared-terminal.lamia.casa";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, bypassCSP: true });
await ctx.addCookies([{ name: "st_token", value: token, domain: API_HOST, path: "/", secure: true, httpOnly: true, sameSite: "None" }]);
const page = await ctx.newPage();
let failures = 0;
const check = (name, ok, ev) => {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${ev ? ` — ${ev}` : ""}`);
};

await page.goto(`${WEB}/#/sessions/${sid}/chat`);
await page.waitForSelector("#acp-chat:not([hidden]) .acp-chat-header strong", { timeout: 30_000 });
check("Chat: agent Chat for the ACP session", (await page.textContent(".acp-chat-header strong")) === `@${agent}`);
await page.waitForTimeout(3_000);
check("Chat: input enabled", await page.locator(".acp-chat-input").isEnabled());
const msgs = await page.locator(".acp-msg .acp-badge").allTextContents();
console.log(`  messages: ${msgs.join(", ") || "(none)"}`);
const notice = await page.locator(".acp-chat-error").allTextContents();
console.log(`  notice: ${notice.join(" | ").slice(0, 160) || "(none)"}`);
await page.screenshot({ path: `${shots}/prod-1-chat.png` });

for (const view of ["terminal", "files", "git"]) {
	await page.click(`#view-${view}-btn`);
	await page.waitForTimeout(3_500);
	const selector = view === "terminal" ? "#terminal-container .xterm" : view === "files" ? "#files-view:not([hidden])" : "#git-view:not([hidden])";
	const visible = await page.locator(selector).first().isVisible().catch(() => false);
	check(`${view}: view opens`, visible);
	await page.screenshot({ path: `${shots}/prod-2-${view}.png` });
}
await browser.close();
console.log(failures ? `${failures} FAILED` : "ALL PASS");
process.exit(failures ? 1 : 0);
