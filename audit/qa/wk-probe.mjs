// Experimento aislado (no es parte del repo): ¿Playwright WebKit simula el teclado de iOS?
// Correr desde frontend/ (resuelve 'playwright'): node ../audit/qa/wk-probe.mjs
// Requiere la copia aislada de WebKit en /tmp/wk-iso (ver QA.md §Q1.3).
import { webkit, devices } from 'playwright';
const b = await webkit.launch({ executablePath: "/tmp/wk-iso/webkit-2158/pw_run.sh" });
const c = await b.newContext({ ...devices['iPhone 13'] });
const p = await c.newPage();
await p.setContent('<meta name=viewport content="width=device-width,initial-scale=1"><div style="height:600px"></div><input id=i><div style="height:2000px"></div>');
const m = () => p.evaluate(() => ({ ih: innerHeight, vvh: visualViewport?.height, top: visualViewport?.offsetTop, sy: Math.round(scrollY), focus: document.activeElement?.id }));
console.log('before', JSON.stringify(await m()));
await p.locator('#i').tap();
await p.waitForTimeout(800);
console.log('after-tap', JSON.stringify(await m()), await p.evaluate(() => navigator.userAgent));
await b.close();
