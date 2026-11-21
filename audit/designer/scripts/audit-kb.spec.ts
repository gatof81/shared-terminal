import { appendFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "../e2e/fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS } from "../e2e/mockBackend.js";
const OUT = "/home/developer/audit/a2611/kb";
// iOS-like keyboard: the layout viewport keeps its height, the visual one shrinks
// (and Safari may pan it by offsetTop). Same stand-in as e2e/keyboard.spec.ts.
test.beforeEach(async ({ page, backend }) => {
	await page.addInitScript(() => {
		const t = new EventTarget() as EventTarget & Record<string, number>;
		Object.assign(t, { width: innerWidth, height: innerHeight, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 });
		Object.defineProperty(window, "visualViewport", { configurable: true, value: t });
		(window as any).__kb = (h: number, top: number) => { t.height = h; t.offsetTop = top; t.pageTop = top; t.dispatchEvent(new Event("resize")); t.dispatchEvent(new Event("scroll")); };
	});
	backend.enableAcp();
	for (let i = 1; i <= 30; i++) {
		backend.addAcpMessage({ to_id: "solo", body: `pregunta ${i}`, state: "done", result_text: `Respuesta ${i}.\n\nUna línea más para que ocupe lugar.\n\nY otra.` });
		backend.addAcpMessage({ to_id: "arq", body: `@arq tema ${i}`, state: "done", result_text: `Tema ${i} resuelto.\n\nCon una segunda línea.`, project_id: PROJECT_IDS.hz });
	}
});
let PG: Page; const frame = () => PG.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
async function snap(page: Page, root: string, anchor: string | null) {
	return page.evaluate(([root, anchor]) => {
		const vv = window.visualViewport as any; const off = vv.offsetTop as number;
		const r = (s: string, base: ParentNode = document) => { const e = base.querySelector(s) as HTMLElement | null; if (!e || !e.getClientRects().length) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top - off), bottom: Math.round(b.bottom - off), h: Math.round(b.height) }; };
		const th = document.querySelector(`${root} .acp-chat-thread`) as HTMLElement;
		let anchorTop: number | null = null;
		if (anchor && th) { const row = [...th.children].find((c) => c.textContent?.includes(anchor)); if (row) anchorTop = Math.round(row.getBoundingClientRect().top - th.getBoundingClientRect().top); }
		const nav = document.getElementById("view-nav");
		return { scrollY: Math.round(scrollY), docScroll: document.scrollingElement!.scrollHeight - innerHeight, vvH: Math.round(vv.height), vvTop: off, kb: document.documentElement.dataset.kb ?? null,
			header: r("header"), bar: r("#terminal-toolbar"), pvHead: r(`${root} .pv-header`) ?? r(`${root} .acp-chat-header`), thread: th ? { ...r(`${root} .acp-chat-thread`)!, gap: Math.round(th.scrollHeight - th.clientHeight - th.scrollTop) } : null,
			composer: r(`${root} .acp-chat-composer`), input: r(`${root} .acp-chat-input`), nav: nav && !nav.hidden ? r("#view-nav") : null, endBtn: r(`${root} .chat-end-btn`) ?? r(".chat-jump"), scrolled: [...document.querySelectorAll("*")].filter((e) => (e as HTMLElement).scrollTop > 0 && !e.classList.contains("acp-chat-thread")).map((e) => (e.id ? "#" + e.id : e.tagName.toLowerCase() + "." + [...e.classList].join(".")) + ":" + Math.round((e as HTMLElement).scrollTop)), focusIn: document.activeElement?.classList.contains("acp-chat-input") ?? false, anchorTop };
	}, [root, anchor] as const);
}
async function readAt(page: Page, root: string, text: string) {
	await page.locator(`${root} .acp-chat-thread`).evaluate((el, text) => { const row = [...el.children].find((c) => c.textContent?.includes(text))!; el.style.scrollBehavior = "auto"; el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - 20; el.style.scrollBehavior = ""; }, text);
	await frame();
}
const kb = (page: Page, h: number, top: number) => page.evaluate(([h, t]) => (window as any).__kb(h, t), [h, top] as const);

for (const [kind, url, root, prefix] of [["agent", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`, "#acp-chat", ""], ["project", `#/projects/${PROJECT_IDS.hz}/chat`, "#project-view", "@arq "]] as const) {
	test(`kb-${kind}`, async ({ app, page, isMobile }) => { PG = page;
		const P = test.info().project.name; const vp = page.viewportSize()!;
		const rec = (step: string, d: unknown) => appendFileSync(`${OUT}/kb.jsonl`, JSON.stringify({ p: P, kind, step, ...(d as object) }) + "\n");
		const shot = (step: string) => page.screenshot({ path: `${OUT}/${kind}-${P}-${step}.png` });
		await app.login("alice", url);
		const input = page.locator(`${root} .acp-chat-input`);
		await expect(input).toBeVisible(); await kb(page, vp.height, 0); await page.waitForTimeout(400);
		rec("0-rest", await snap(page, root, null)); await shot("0-rest");
		// keyboard height: 336 portrait phone, 200 landscape phone, 313 tablet (Safari-typical heights); none on desktop
		const K = ({ "se-safari": 260, "13-safari": 336, "13-pwa": 336, "13-land": 208, "320": 260, ipad: 313 } as Record<string, number>)[P.replace(/-v[12]$/, "")] ?? 0;
		await input.focus(); await frame();
		if (K) {
			// iOS A: Safari pans the visual viewport so the field shows (offsetTop = K, bounded)
			await kb(page, vp.height - K, K); await frame(); await page.waitForTimeout(150);
			rec("1-kb-pan", await snap(page, root, null)); await shot("1-kb-pan");
			// iOS B: no pan
			await kb(page, vp.height - K, 0); await frame(); await page.waitForTimeout(150);
			rec("2-kb-nopan", await snap(page, root, null));
		}
		// consecutive sends with the keyboard up
		for (let i = 1; i <= 3; i++) {
			await input.fill(`${prefix}seguido ${i}`);
			await page.locator(`${root} .acp-chat-send`).click();
			await frame(); await page.waitForTimeout(250);
			rec(`3-send${i}`, { ...(await snap(page, root, null)), value: await input.inputValue() });
		}
		await shot("3-sent");
		// growing field to 6 lines
		await input.fill(prefix + Array.from({ length: 6 }, (_, i) => `línea ${i}`).join("\n")); await frame();
		rec("4-grow6", await snap(page, root, null)); await shot("4-grow6");
		await input.fill(""); await frame();
		// reading further up, then keyboard close/reopen
		await readAt(page, root, kind === "agent" ? "pregunta 20" : "tema 20");
		const A = kind === "agent" ? "pregunta 20" : "tema 20";
		rec("5-reading-kb", await snap(page, root, A)); await shot("5-reading-kb");
		if (K) { await input.blur(); await kb(page, vp.height, 0); await frame(); await page.waitForTimeout(150); rec("6-reading-kbclosed", await snap(page, root, A));
			await input.focus(); await kb(page, vp.height - K, K); await frame(); await page.waitForTimeout(150); rec("7-reading-kbreopen", await snap(page, root, A)); }
		// send while reading above
		await input.fill(`${prefix}desde arriba`); await page.locator(`${root} .acp-chat-send`).click(); await frame(); await page.waitForTimeout(400);
		rec("7b-send-from-above", await snap(page, root, null));
		await readAt(page, root, A);
		// Android-like: the layout viewport itself shrinks (interactive-widget=resizes-content)
		if (K) { await kb(page, vp.height, 0); await page.setViewportSize({ width: vp.width, height: vp.height - K }); await page.evaluate(() => { const t = window.visualViewport as any; t.height = innerHeight; t.dispatchEvent(new Event("resize")); }); await frame(); await page.waitForTimeout(200);
			rec("8-android-reading", await snap(page, root, A));
			await page.locator(`${root} .acp-chat-thread`).evaluate((el) => { el.scrollTop = el.scrollHeight; }); await frame(); await page.waitForTimeout(200);
			rec("9-android-bottom", await snap(page, root, null)); await shot("9-android-bottom");
			await page.setViewportSize(vp); await page.evaluate(() => { const t = window.visualViewport as any; t.height = innerHeight; t.dispatchEvent(new Event("resize")); }); await frame(); await page.waitForTimeout(200);
			rec("10-android-closed", await snap(page, root, null)); }
	});
}
