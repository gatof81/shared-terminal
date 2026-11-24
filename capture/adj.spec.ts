import { test, expect } from "@playwright/test";
const URL = "file:///home/developer/design/3a/index.html?freeze";
const OUT = "/home/developer/audit/d3a/shots2";
test("ajustes", async ({ page }, info) => {
  const p = info.project.name, mob = p === "mobile";
  const errs: string[] = []; page.on("pageerror", e => errs.push(String(e)));
  const shot = (n: string) => page.screenshot({ path: `${OUT}/${p}-${n}.png` });
  const open = async (id: string) => { if (mob && await page.locator("[data-go-home]").isVisible()) await page.locator("[data-go-home]").click(); await page.locator(`#conv-list [data-conv="${id}"]`).click(); };
  await page.goto(URL);
  await open("ui");
  // 2. destinatarios: chip de equipo + estados por destinatario
  await expect(page.locator("#to-chips .chip")).toContainText("@developer");
  await page.locator("#to-add").click(); await page.locator('#mention-pop [data-pick="*"]').click();
  await expect(page.locator("#to-chips .team-chip")).toContainText("Todo el equipo · 4");
  await page.locator("#thread .rs-list").last().scrollIntoViewIfNeeded();
  await shot("01-team-and-states");
  // composer en móvil: mención con chip de equipo quitado
  await page.locator('[data-unchip="*"]').click();
  await expect(page.locator("#to-chips .chip")).toHaveCount(0);
  await page.locator("#input").click(); await page.locator("#input").pressSequentially("@de");
  await shot("02-mention");
  await page.keyboard.press("Enter");
  await expect(page.locator("#to-chips .chip")).toHaveCount(1);
  const comp = await page.locator("#composer").boundingBox(); console.log(p, "composer h", comp!.height, "y", comp!.y);
  // 1. interrupción desde la bandeja
  await page.locator("[data-open-inbox]").filter({ visible: true }).first().click();
  await page.locator('#inbox-body [data-review]').first().click();
  await expect(page.locator("#unc-requeue")).toBeDisabled();
  await shot("03-review");
  await page.locator("#unc-more summary").click();
  await page.locator("#unc-ack").check();
  await expect(page.locator("#unc-requeue")).toBeEnabled();
  await page.locator("#unc-ack").uncheck();
  await page.locator("#unc-more").evaluate((d: HTMLDetailsElement) => d.scrollIntoView());
  await shot("04-review-requeue");
  await page.locator("#unc-reviewed").click();
  await expect(page.locator("[data-badge]").filter({ visible: true }).first()).toHaveText("2");
  // 3. respuesta tardía como referencia
  await open("be");
  await page.locator("#thread .sys.late").scrollIntoViewIfNeeded();
  await shot("05-late-ref");
  await expect(page.locator("#thread .sys.late")).not.toContainText("afinidad sigue");
  await page.locator('#thread .sys.late [data-goto-msg]').click();
  await expect(page.locator("#c3r")).toBeInViewport();
  await shot("06-late-jump");
  // un tema nuevo no hereda destinatarios
  await open("ui"); await page.locator("#to-chips").waitFor();
  if (mob) await page.locator("[data-go-home]").click();
  await page.locator("#new-conv").click();
  await page.locator("#nd-title").fill("Tema nuevo");
  await page.getByRole("button", { name: "Crear" }).click();
  await expect(page.locator("#to-chips .chip")).toHaveCount(0);
  await shot("07-new-empty");
  // navegación móvil: tema → herramientas → atrás (gesto) → tema → inicio
  await open("ci");
  await page.locator("#thread").evaluate(t => t.scrollTop = 120);
  await page.locator('#thread [data-work="ci-cache"]').first().click();
  await expect(page.locator("#tools")).toBeVisible();
  await page.goBack();
  await expect(page.locator("#chat")).toBeVisible();
  console.log(p, "scroll after back", await page.locator("#thread").evaluate(t => t.scrollTop));
  if (mob) { await page.goBack(); await expect(page.locator("#conv-list")).toBeVisible(); await shot("08-home-after-back"); }
  console.log(p, "errors", JSON.stringify(errs));
});
