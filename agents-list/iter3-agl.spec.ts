import { mkdirSync, appendFileSync } from "node:fs";
import { test, expect } from "../e2e/fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS } from "../e2e/mockBackend.js";
const OUT = "/home/developer/audit/iter3/agents-list";
mkdirSync(OUT, { recursive: true });
const rec = (name: string, d: any) => appendFileSync(`${OUT}/measure.jsonl`, JSON.stringify({ p: test.info().project.name, name, ...d }) + "\n");
const shot = async (page: any, n: string) => { await page.addStyleTag({ content: "#toast{display:none!important}" }).catch(() => {}); await page.waitForTimeout(300); await page.screenshot({ path: `${OUT}/${n}-${test.info().project.name}.png` }); };
function seed(backend: any, many: boolean) {
	backend.enableAcp();
	const [arq, dev] = backend.acpAgents;
	arq.waitingInput = true; dev.running = 12;
	if (many) {
		const names = ["documentacion-tecnica-larga", "qa", "frontend-mobile-responsive", "seguridad", "infraestructura-y-despliegues"];
		names.forEach((n, i) => backend.acpAgents.push({ ...dev, name: n, sessionId: [PROJECT_SESSION_IDS.architect, PROJECT_SESSION_IDS.developer2][i % 2], running: i === 0 ? 7 : null, pending: i === 2 ? 3 : 0, authRequired: i === 3, runnerSeenAt: i === 4 ? "2026-10-31T08:00:00Z" : dev.runnerSeenAt }));
	}
	for (let i = 0; i < 12; i++) backend.addAcpMessage({ to_id: "arq", body: `@arq tema ${i}`, state: "done", result_text: `Tema ${i}.`, project_id: PROJECT_IDS.hz });
}
const measure = () => {
	const vis = (e: Element | null) => !!e && (e as HTMLElement).offsetParent !== null;
	const R = (e: Element | null) => (vis(e) ? (({ left, top, width, height, bottom, right }) => ({ x: Math.round(left), y: Math.round(top), w: Math.round(width), h: Math.round(height), b: Math.round(bottom), r: Math.round(right) }))(e!.getBoundingClientRect()) : null);
	const list = document.getElementById("acp-agents-list")!;
	const rows = [...list.querySelectorAll(".acp-agents-list-item")].map((li) => {
		const who = li.querySelector(".acp-agents-list-who"), st = li.querySelector(".acp-status"), a = li.querySelector("a");
		const rw = R(who), rs = R(st), ra = R(a), rl = R(li);
		const ov = (p: any, q: any) => p && q && p.x < q.r && q.x < p.r && p.y < q.b && q.y < p.b;
		return { li: rl && [rl.w, rl.h], who: rw && [rw.w, rw.h, rw.y - rl!.y], st: rs && [rs.w, rs.h, rs.y - rl!.y, st!.textContent], link: ra && [ra.w, ra.h], overlap: !!(ov(rw, rs) || ov(rs, ra) || ov(rw, ra)), cut: who ? (who as HTMLElement).scrollWidth > (who as HTMLElement).clientWidth + 1 : false, outside: rl ? [rw, rs, ra].some((q) => q && (q.r > rl.r + 1 || q.x < rl.x - 1)) : false };
	});
	const head = document.querySelector("header");
	const comp = [...document.querySelectorAll("#project-view .acp-chat-composer")].find(vis) ?? null;
	const th = [...document.querySelectorAll("#project-view .acp-chat-thread")].find(vis) ?? null;
	const close = list.querySelector(".acp-agents-panel-close");
	return { vh: innerHeight, header: R(head), panel: R(list), scrollH: list.scrollHeight, clientH: list.clientHeight, overflowY: getComputedStyle(list).overflowY, composer: R(comp), thread: R(th), close: R(close), group: R(document.querySelector(".acp-agents-group")), rows };
};
for (const many of [false, true]) test(`list ${many ? 7 : 2}`, async ({ page, app, backend }) => {
	seed(backend, many);
	await app.login("alice", `#/projects/${PROJECT_IDS.hz}/chat`);
	await expect(page.locator("#project-view")).toContainText("Tema 11.");
	await page.locator(".acp-agents-group").click();
	await page.waitForTimeout(400);
	const n = `list${many ? 7 : 2}`;
	rec(n, await page.evaluate(measure)); await shot(page, n);
	if (many) { await page.evaluate(() => { const l = document.getElementById("acp-agents-list")!; l.scrollTop = l.scrollHeight; }); await shot(page, n + "-scrolled"); }
});
