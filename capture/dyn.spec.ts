import { test } from "@playwright/test";
test("async", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  const errs: string[] = []; page.on("pageerror", e => errs.push(String(e)));
  await page.goto("file:///home/developer/design/3a/index.html");
  await page.locator("#thread").evaluate(t => t.scrollTop = 200);
  await page.waitForTimeout(38000);
  console.log("ci row:", await page.locator('#conv-list [data-conv="ci"]').innerText());
  console.log("pill:", await page.locator("#new-pill").isVisible(), await page.locator("#new-pill").textContent());
  console.log("team dev:", await page.locator('#team-list [data-agent-menu="developer"]').innerText());
  await page.screenshot({ path: "/home/developer/audit/d3a/shots/desktop-16-async.png" });
  await page.locator('#conv-list [data-conv="ci"]').click();
  await page.screenshot({ path: "/home/developer/audit/d3a/shots/desktop-17-ci-divider.png" });
  console.log("errors", JSON.stringify(errs));
});
