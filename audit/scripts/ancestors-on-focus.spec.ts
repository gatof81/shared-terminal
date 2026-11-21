import { expect, test } from "./fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS } from "./mockBackend.js";

// AUDIT EXPERIMENT (assets/audit-2026-11-developer, never merged): which
// ancestors of the chat input scroll when the input is focused the way a
// browser reveals a field (focus() without preventScroll), at a short
// visible height. Every ancestor of the textarea up to <html>, with its
// overflow and scrollTop/scrollHeight/clientHeight, plus window.scrollY.
const dump = () =>
	document.activeElement
		? (() => {
				const out: string[] = [`scrollY=${Math.round(window.scrollY)}`];
				for (let e: Element | null = document.activeElement; e; e = e.parentElement) {
					const h = e as HTMLElement;
					const cs = getComputedStyle(h);
					if (h.scrollHeight > h.clientHeight + 1 || h.scrollTop > 0)
						out.push(
							`${h.tagName.toLowerCase()}${h.id ? `#${h.id}` : ""}${h.className && typeof h.className === "string" ? `.${h.className.split(" ").join(".")}` : ""} ovf=${cs.overflowY} st=${Math.round(h.scrollTop)} sh=${h.scrollHeight} ch=${h.clientHeight}`,
						);
				}
				return out.join("\n");
			})()
		: "no focus";

for (const where of ["agent", "project"] as const)
	for (const h of [844, 500, 400, 330])
		test(`${where} chat, ${h} px tall: ancestors that scroll when the input is focused`, async ({
			app,
			backend,
			page,
		}, info) => {
			test.skip(!info.project.use.isMobile, "phones");
			backend.enableAcp();
			for (let i = 1; i <= 40; i++)
				backend.addAcpMessage({
					to_id: "solo",
					body: `pregunta ${i}`,
					state: "done",
					result_text: `Respuesta ${i}.`,
					project_id: where === "project" ? PROJECT_IDS.hz : undefined,
				});
			await page.setViewportSize({ width: 390, height: h });
			await app.login(
				"alice",
				where === "agent"
					? `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`
					: `#/projects/${PROJECT_IDS.hz}`,
			);
			const sel = where === "agent" ? "#acp-chat .acp-chat-input" : "#project-view .acp-chat-input";
			await expect(page.locator(sel)).toBeVisible();
			await page.waitForTimeout(300);
			const before = await page.evaluate(() => {
				const el = document.querySelector<HTMLElement>(".acp-chat-input:not([hidden])")!;
				const out: string[] = [];
				for (let e: Element | null = el; e; e = e.parentElement) {
					const x = e as HTMLElement;
					if (x.scrollHeight > x.clientHeight + 1) out.push(`${x.tagName}#${x.id}.${String(x.className).split(" ")[0]} sh=${x.scrollHeight} ch=${x.clientHeight} ovf=${getComputedStyle(x).overflowY}`);
				}
				return out.join(" | ");
			});
			await page.evaluate((s) => document.querySelector<HTMLElement>(s)!.focus(), sel);
			await page.waitForTimeout(300);
			console.log(`[${info.project.name}] ${where} ${h}px\n overflowing ancestors before focus: ${before || "none"}\n after focus:\n${await page.evaluate(dump)}`);
		});
