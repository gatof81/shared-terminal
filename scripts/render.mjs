import { chromium } from "/home/developer/workspace/frontend/node_modules/playwright/index.mjs";
const base = "file:///home/developer/audit/iter3/mock/";
const out = "/home/developer/audit/iter3/after/";
const jobs = JSON.parse(process.argv[2]);
const b = await chromium.launch({ args: ["--disable-dev-shm-usage"] });
for (const [name, file, params, w, h, mobile] of jobs) {
	const ctx = await b.newContext({ viewport: { width: w, height: h }, isMobile: !!mobile, hasTouch: !!mobile, deviceScaleFactor: 1, colorScheme: "dark", reducedMotion: "reduce" });
	const p = await ctx.newPage();
	await p.goto(`${base}${file}?${params}`);
	await p.waitForTimeout(250);
	await p.screenshot({ path: `${out}${name}.png` });
	await ctx.close();
}
await b.close();
console.log("rendered", jobs.length);
