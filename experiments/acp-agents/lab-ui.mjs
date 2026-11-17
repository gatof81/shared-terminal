// Browser check of the ACP agent Chat against the lab (lab-st.sh up + web),
// through an ssh tunnel: web on localhost:5174, API on localhost:3101.
// Run from frontend/ (for @playwright/test): node ../experiments/acp-agents/lab-ui.mjs <shots-dir>
import { chromium } from "@playwright/test";

const shots = process.argv[2] ?? ".";
const browser = await chromium.launch();
// bypassCSP: the app's CSP forbids the eval Playwright's waitForFunction uses.
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, bypassCSP: true });
let failures = 0;
const check = (name, ok, ev) => {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${ev ? ` — ${ev}` : ""}`);
};

await page.goto("http://localhost:5174/");
await page.fill("#auth-username", "labowner");
await page.fill("#auth-password", "lab-password-1234");
await page.press("#auth-password", "Enter");
await page.waitForSelector(".session-item", { timeout: 20_000 });

// New-session form: the agent field exists (feature on).
await page.click("#new-session-btn");
const field = await page.waitForSelector("#new-session-acp-agent", { timeout: 5_000 }).catch(() => null);
check("new-session form has the ACP agent field", Boolean(field));
await page.screenshot({ path: `${shots}/1-new-session.png` });
await page.keyboard.press("Escape");

const agents = await page.evaluate(async () => (await fetch("http://localhost:3101/api/acp/agents", { credentials: "include" })).json());
const dev = agents.find((a) => a.name === "developer");
await page.goto(`http://localhost:5174/#/sessions/${dev.sessionId}/chat`);
await page.waitForSelector("#acp-chat:not([hidden]) .acp-chat-header strong", { timeout: 20_000 });
check("agent session opens the ACP Chat", (await page.textContent(".acp-chat-header strong")) === "@developer");

const input = page.locator(".acp-chat-input");
const sendBtn = page.locator(".acp-chat-send");
const lastBody = () => page.locator(".acp-msg-body").last().textContent();

// Multi-line message with a code block, sent verbatim.
const code = 'Revisá este bloque y respondé solo "VISTO" y el número de líneas del bloque:\n```ts\nfunction suma(a: number, b: number) {\n\treturn a + b; // ñandú\n}\n```';
await input.fill(code);
await sendBtn.click();
await page.waitForFunction((t) => [...document.querySelectorAll(".acp-msg-body")].some((n) => n.textContent === t), code, { timeout: 10_000 });
check("multi-line + code block shown byte-exact", (await lastBody()) === code);

// A long task, then two more messages while it runs: input never blocked.
await input.fill('Con Bash, en primer plano: python3 -c "import time; time.sleep(25)". Respondé LARGA.');
await sendBtn.click();
await page.waitForTimeout(6_000);
const enabledWhileBusy = await input.isEnabled();
await input.fill("Respondé exactamente: SEGUNDO");
await sendBtn.click();
await input.fill("Respondé exactamente: TERCERO");
await sendBtn.click();
await page.waitForTimeout(2_500);
const badges = await page.locator(".acp-msg .acp-badge").allTextContents();
check("input usable while the agent works", enabledWhileBusy && (await input.inputValue()) === "", `badges now: ${badges.slice(-4).join(", ")}`);
check("new messages wait as pending", badges.slice(-2).every((b) => b === "pendiente") && badges.includes("en curso"));
await page.screenshot({ path: `${shots}/2-busy.png` });
await page.waitForFunction(() => [...document.querySelectorAll(".acp-msg")].slice(-1)[0]?.querySelector(".acp-badge")?.textContent === "hecho", null, { timeout: 180_000 });
const results = await page.locator(".acp-msg-result").allTextContents();
check("all answered in order", /LARGA/.test(results.at(-3) ?? "") && /SEGUNDO/.test(results.at(-2) ?? "") && /TERCERO/.test(results.at(-1) ?? ""), results.slice(-3).map((r) => r.slice(0, 20)).join(" | "));
await page.screenshot({ path: `${shots}/3-done.png` });

// Over the limit: goes as an attachment in the agent's session.
const big = `${"contenido largo ".repeat(20_000)}\nAl final de este adjunto: respondé exactamente TOKEN-ADJUNTO-9`;
await input.fill(big);
await sendBtn.click();
await page.waitForFunction(() => /\/home\/developer\/uploads\//.test([...document.querySelectorAll(".acp-msg-body")].at(-1)?.textContent ?? ""), null, { timeout: 20_000 });
check("over-limit text sent as attachment", true, (await lastBody())?.slice(0, 120));
await page.waitForFunction(() => /TOKEN-ADJUNTO-9/.test([...document.querySelectorAll(".acp-msg-result")].at(-1)?.textContent ?? ""), null, { timeout: 180_000 }).catch(() => {});
check("agent read the attachment", /TOKEN-ADJUNTO-9/.test((await page.locator(".acp-msg-result").last().textContent()) ?? ""));
await page.screenshot({ path: `${shots}/4-attachment.png`, fullPage: false });

// Mobile width: same view usable.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${shots}/5-mobile.png` });

await browser.close();
console.log(failures ? `${failures} FAILED` : "ALL PASS");
process.exit(failures ? 1 : 0);
