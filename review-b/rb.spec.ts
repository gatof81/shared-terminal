import { appendFileSync } from "node:fs";
import { expect, test } from "../e2e/fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS, SESSION_IDS } from "../e2e/mockBackend.js";
const OUT = "/home/developer/audit/simp-b";
const P = () => test.info().project.name;
const rec = (n: string, d: unknown) => appendFileSync(`${OUT}/m.jsonl`, JSON.stringify({ p: P(), n, d }) + "\n");
const shot = async (page: any, n: string) => { await page.waitForTimeout(350); await page.screenshot({ path: `${OUT}/${n}-${P()}.png` }); };
test.beforeEach(async ({ page }) => { await page.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = "#toast{display:none!important}"; document.head.append(s); })); });
function seed(backend: any, many: boolean) {
	const [arq, dev] = backend.acpAgents; arq.waitingInput = true; dev.running = 12;
	if (many) ["documentacion-tecnica-larga", "qa", "frontend-mobile-responsive", "seguridad", "infraestructura-y-despliegues"].forEach((n, i) => backend.acpAgents.push({ ...dev, name: n, sessionId: [PROJECT_SESSION_IDS.architect, PROJECT_SESSION_IDS.developer2][i % 2], running: i === 0 ? 7 : null, pending: i === 2 ? 3 : 0, authRequired: i === 3, runnerSeenAt: i === 4 ? "2026-10-31T08:00:00Z" : dev.runnerSeenAt }));
	for (let i = 0; i < 14; i++) backend.addAcpMessage({ to_id: "arq", body: `@arq tema ${i}`, state: "done", result_text: `Tema ${i} resuelto.`, project_id: PROJECT_IDS.hz });
}
const M = () => {
	const vis = (e: Element | null) => !!e && (e as HTMLElement).getClientRects().length > 0 && getComputedStyle(e as HTMLElement).visibility !== "hidden";
	const R = (e: Element | null) => { if (!vis(e)) return null; const b = e!.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
	const q = (s: string) => [...document.querySelectorAll(s)].find(vis) ?? null;
	const ctl = [...document.querySelectorAll("header button, header a, .pv-header button, #project-view .acp-agents button, #project-view .acp-agents a")].filter(vis).map((e) => [(e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 26), ...R(e)!]);
	const rows = [...document.querySelectorAll("#project-view .acp-agents-row")].filter(vis).map((r) => { const kids = [...r.querySelectorAll("a,button,.chip,.acp-agents-name")].filter(vis).map((k) => k.getBoundingClientRect()); let ov = false; for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) { const a = kids[i], b = kids[j]; if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5 && !(r.contains(document.activeElement))) ov = ov || (a.width > 0 && b.width > 0 && !(a.left <= b.left && a.right >= b.right && a.top <= b.top && a.bottom >= b.bottom) && !(b.left <= a.left && b.right >= a.right && b.top <= a.top && b.bottom >= a.bottom)); } const nm = r.querySelector(".acp-agents-name") as HTMLElement | null; return { h: Math.round(r.getBoundingClientRect().height), ov, cut: nm ? nm.scrollWidth > nm.clientWidth : null, chip: r.querySelector(".chip")?.tagName }; });
	const th = q("#project-view .acp-chat-thread"); const tb = th as HTMLElement | null;
	return { vh: innerHeight, hash: location.hash, header: R(document.querySelector("header")), pvh: R(q(".pv-header")), panel: R(q("#project-view .acp-agents")), composer: R(q("#project-view .acp-chat-composer")), thread: R(th), threadTop: tb?.scrollTop, rows, ctl };
};
test("project", async ({ app, page, backend }) => {
	seed(backend, true);
	await app.login("alice", `#/sessions/${SESSION_IDS.running}/terminal`);
	await page.waitForTimeout(500);
	rec("terminal", await page.evaluate(M));
	await page.goto(`/#/projects/${PROJECT_IDS.hz}/chat`);
	await expect(page.locator("#project-view")).toContainText("Tema 13 resuelto.");
	await shot(page, "page"); rec("page", await page.evaluate(M));
	await page.locator(".acp-agents-group").click(); await shot(page, "panel"); rec("panel", await page.evaluate(M));
	await page.locator("#project-view .acp-agents-rows, #project-view .acp-agents").first().evaluate((e) => { const s = e.querySelector(".acp-agents-rows") ?? e; s.scrollTop = 9999; }); await shot(page, "panel-scrolled");
	await page.locator("#project-view .acp-agents-more").first().click(); await shot(page, "row-menu"); await page.keyboard.press("Escape");
	await page.keyboard.press("Escape"); await page.waitForTimeout(200);
	await page.locator(".pv-header button[aria-haspopup=menu], header button[aria-label='Acciones del proyecto']").first().click().catch(() => {}); await shot(page, "project-menu"); await page.keyboard.press("Escape");
	await page.locator(".acp-agents-group").click(); await page.waitForTimeout(200);
	const chip = page.locator("#project-view .acp-agents-row button.chip").nth(1);
	if (await chip.count()) { await chip.click(); await page.waitForTimeout(250); await shot(page, "jump"); rec("jump", await page.evaluate(M)); }
	if (page.viewportSize()!.width <= 768) { await page.locator("#sidebar-toggle").click(); await shot(page, "drawer"); }
});
for (const st of ["archived", "missing"]) test(st, async ({ app, page, backend }) => {
	seed(backend, false);
	await app.login("alice", st === "missing" ? `#/projects/00000000-0000-4000-8000-00000000dead` : `#/projects/${PROJECT_IDS.hz}`);
	if (st === "archived") { await page.waitForTimeout(500); await page.locator(".pv-header button[aria-haspopup=menu], header button[aria-label='Acciones del proyecto']").first().click(); await page.getByRole("menuitem", { name: "Archivar" }).click(); await page.getByRole("button", { name: "Archivar" }).last().click(); }
	await shot(page, st); rec(st, await page.evaluate(M));
});
