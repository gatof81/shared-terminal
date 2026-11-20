import { appendFileSync, mkdirSync } from "node:fs";
import { expect, test } from "../e2e/fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS } from "../e2e/mockBackend.js";
const OUT = process.env.CAP_OUT!;
mkdirSync(OUT, { recursive: true });
const rec = (name: string, d: unknown) => appendFileSync(`${OUT}/measure.jsonl`, `${JSON.stringify({ p: test.info().project.name, name, ...(d as object) })}\n`);
const shot = async (page: any, n: string) => { await page.addStyleTag({ content: "#toast{display:none!important}" }).catch(() => {}); await page.waitForTimeout(350); await page.screenshot({ path: `${OUT}/${n}-${test.info().project.name}.png` }); };
function seed(backend: any, many: boolean) {
	backend.enableAcp();
	const [arq, dev] = backend.acpAgents;
	arq.waitingInput = true;
	for (let i = 0; i < 12; i++) backend.addAcpMessage({ to_id: "arq", body: `@arq tema ${i}`, state: "done", result_text: `Tema ${i}.\n\nCon otra línea.`, project_id: PROJECT_IDS.hz });
	const run = backend.addAcpMessage({ to_id: "dev", body: "@dev revisá el despliegue", state: "running", project_id: PROJECT_IDS.hz });
	for (let i = 12; i < 16; i++) backend.addAcpMessage({ to_id: "arq", body: `@arq tema ${i}`, state: "done", result_text: `Tema ${i}.`, project_id: PROJECT_IDS.hz });
	dev.running = run.id;
	if (many) {
		const names = ["documentacion-tecnica-larga", "qa", "frontend-mobile-responsive", "seguridad", "infraestructura-y-despliegues"];
		names.forEach((n, i) => backend.acpAgents.push({ ...dev, name: n, sessionId: [PROJECT_SESSION_IDS.architect, PROJECT_SESSION_IDS.developer2][i % 2], running: null, pending: i === 2 ? 3 : 0, authRequired: i === 3, runnerSeenAt: i === 4 ? "2026-10-31T08:00:00Z" : dev.runnerSeenAt }));
	}
}
const measure = () => {
	const R = (e: Element | null) => { if (!e) return null; const r = e.getBoundingClientRect(); return r.width === 0 && r.height === 0 ? null : { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), b: Math.round(r.bottom), r: Math.round(r.right) }; };
	const list = document.getElementById("acp-agents-list")!;
	const ov = (p: any, q: any) => p && q && p.x < q.r && q.x < p.r && p.y < q.b && q.y < p.b;
	const rows = [...list.querySelectorAll(".acp-agents-list-item")].map((li) => {
		const f = R(li.querySelector(".acp-agents-list-face")), n = R(li.querySelector(".acp-agents-list-name")), s = R(li.querySelector(".acp-agents-list-state")), a = R(li.querySelector(".acp-agents-list-link")), l = R(li)!;
		const name = li.querySelector(".acp-agents-list-name") as HTMLElement;
		return { h: l.h, overlap: !!(ov(f, n) || ov(n, s) || ov(s, a) || ov(n, a) || ov(f, s)), outside: [f, n, s, a].some((q) => q && (q.r > l.r + 1 || q.x < l.x - 1 || q.b > l.b + 1)), nameOneLine: name.getBoundingClientRect().height <= 21, link: a && [a.w, a.h], state: s && [s.w, s.h] };
	});
	const comp = document.querySelector("#project-view .acp-chat-composer");
	const th = document.querySelector("#project-view .acp-chat-thread") as HTMLElement;
	return { panel: R(list), composer: R(comp), opener: R(document.querySelector("#project-view .pv-header")), thread: { y: Math.round(th.getBoundingClientRect().top), h: th.clientHeight, st: Math.round(th.scrollTop) }, rows, scroll: list.scrollHeight > list.clientHeight, pos: getComputedStyle(list).position };
};
for (const many of [false, true]) test(`list ${many ? 7 : 2}`, async ({ page, app, backend }) => {
	seed(backend, many);
	await app.login("alice", `#/projects/${PROJECT_IDS.hz}`);
	await expect(page.locator("#project-view")).toContainText("Tema 15.");
	await page.waitForTimeout(300);
	const th = page.locator("#project-view .acp-chat-thread");
	const before = await th.evaluate((e) => [Math.round(e.getBoundingClientRect().top), e.clientHeight, Math.round(e.scrollTop)]);
	await page.locator(".acp-agents-group").click();
	await page.waitForTimeout(400);
	const m = await page.evaluate(measure).catch(() => ({}));
	rec(`list${many ? 7 : 2}`, { ...m, threadBefore: before });
	await shot(page, `pr7-list${many ? 7 : 2}`);
	if (many) {
		const go = page.locator(".acp-agents-list-goto").first();
		if (await go.count()) { await go.click(); await page.waitForTimeout(250); await shot(page, "pr7-goto"); }
	}
});
