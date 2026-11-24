import { test, expect } from "@playwright/test";
const URL = "file:///home/developer/design/3a/index.html?freeze";
const OUT = "/home/developer/audit/d3a/shots";
test("flows", async ({ page }, info) => {
  const p = info.project.name, mob = p === "mobile";
  const errs: string[] = []; page.on("pageerror", e => errs.push(String(e))); page.on("console", m => m.type()==="error" && errs.push(m.text()));
  const shot = (n: string) => page.screenshot({ path: `${OUT}/${p}-${n}.png` });
  await page.goto(URL); await page.waitForTimeout(300);
  await shot("01-home");
  if (mob) { await page.locator('#conv-list [data-conv="ui"]').click(); }
  await shot("02-conv-ui");
  await page.locator("#thread").evaluate(t => t.scrollTop = 300);
  const pos = await page.locator("#thread").evaluate(t => t.scrollTop);
  await page.locator("#input").fill("@");
  await shot("03-mention");
  await page.keyboard.press("Escape"); await page.locator("#input").fill("");
  await page.locator("[data-open-inbox]").filter({ visible: true }).first().click();
  await shot("04-inbox");
  await page.locator('#inbox-body [data-goto-msg="qst"]').first().click(); await page.waitForTimeout(200);
  await shot("05-question");
  // volver a ui
  if (mob) { await page.locator("[data-go-home]").click(); }
  await page.locator('#conv-list [data-conv="ui"]').click();
  const pos2 = await page.locator("#thread").evaluate(t => t.scrollTop);
  console.log(p, "scroll restore", pos, pos2);
  // herramientas desde work chip
  await page.locator('#thread [data-work="ui-tokens"]').first().scrollIntoViewIfNeeded();
  await page.locator('#thread [data-agent-menu="developer"]').first().click();
  const posBefore = await page.locator("#thread").evaluate(t => t.scrollTop);
  await shot("06-agent-menu");
  await page.locator('#menu [data-tools="developer|ci-cache|git"]').click();
  await shot("07-tools-git-work");
  await page.locator('#tool-body [data-change]').first().click();
  await shot("08-diff");
  await page.locator("#sel-ws").selectOption("main");
  await page.locator('[data-tool="files"]').click();
  await shot("09-files-main");
  await page.locator('[data-tool="terminal"]').click();
  await page.locator("[data-open-inbox]").filter({ visible: true }).first().click(); await page.waitForTimeout(150);
  await page.keyboard.press("Escape"); await page.waitForTimeout(150);
  await shot("10-terminal");
  console.log(p, "rz", await page.locator("#rz").textContent());
  await page.locator("#tools-back").click();
  const pos3 = await page.locator("#thread").evaluate(t => t.scrollTop);
  console.log(p, "after tools", posBefore, pos3);
  await shot("11-back");
  if (mob) { await page.locator("[data-go-home]").click(); }
  await page.locator("#new-conv").click();
  await page.locator("#nd-title").fill("Rediseño de notificaciones");
  await page.locator('#nd-team input[value="designer"]').check();
  await shot("12-new-dialog");
  await page.locator("#nd-body").fill("Quiero menos ruido: solo lo que requiere acción.");
  await page.getByRole("button", { name: "Crear" }).click();
  await shot("13-new-conv");
  await page.locator('#conv-list [data-conv="arch-pc"], #archive-list [data-conv="arch-pc"]').count();
  if (mob) { await page.locator("[data-go-home]").click(); }
  await page.locator('#archive-list [data-conv="arch-pc"]').click();
  await shot("14-archive");
  if (mob) { await page.locator("[data-go-home]").click(); }
  await page.locator("#project-btn").click();
  await shot("15-projects");
  console.log(p, "errors", JSON.stringify(errs));
});
