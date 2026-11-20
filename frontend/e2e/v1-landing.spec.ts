import { expect, test } from "./fixtures.js";
import { PROJECT_SESSION_IDS, SESSION_IDS } from "./mockBackend.js";

const S = SESSION_IDS.running;

/**
 * Shell v1 is production: the landing policy (viewPolicy.ts) is v2 only
 * and must leave v1 exactly as main had it before #501 (measured there
 * with a probe, desktop and mobile): a running session opens in Terminal;
 * a stopped or terminated one opens in Files whatever view was up, and
 * the next running one comes back to Terminal; nothing the browser
 * remembers about views is read.
 */
test.describe("shell v1 landing (unchanged)", () => {
	test.skip(({ shell }) => shell !== "v1", "v1 only");
	test.use({ landing: "none" });

	test("Files, Chat or Git open → a stopped session shows Files → a running one Terminal; a remembered view is ignored", async ({
		app,
		page,
	}) => {
		await page.addInitScript((k: string) => {
			try {
				localStorage.setItem(k, "chat");
			} catch {
				/* ignore */
			}
		}, `st.view.${S}`);
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		expect(page.url()).toContain(`#/sessions/${S}/terminal/tab-1`);
		for (const open of ["files", "chat", "git"] as const) {
			await app.switchView(open);
			await app.openSession("docs");
			await app.expectView("files");
			await app.openSession("my-project");
			await app.expectTerminalReady();
		}
		await app.switchView("chat");
		await app.openSidebar();
		await page.locator("#show-terminated-toggle").check();
		await app.openSession("old-poc");
		await app.expectView("files");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		// v1 wrote nothing of its own: the seeded value is untouched.
		expect(await page.evaluate((k) => localStorage.getItem(k), `st.view.${S}`)).toBe("chat");
	});

	test("#/sessions/<id> on a fresh load opens the terminal; the address names the tab; no entry is added", async ({
		app,
		page,
	}) => {
		await app.login("alice");
		const base = await page.evaluate(() => history.length);
		await page.goto(`/#/sessions/${S}`);
		await app.expectTerminalReady();
		await expect.poll(() => page.url()).toContain(`#/sessions/${S}/terminal/tab-1`);
		// The navigation itself is the one entry.
		expect(await page.evaluate(() => history.length)).toBe(base + 1);
	});

	test("with ACP agents on: an agent's session opens on its Chat, a traditional one exactly as before", async ({
		app,
		backend,
		page,
	}) => {
		backend.enableAcp();
		// A remembered Chat for the traditional session is still ignored by v1.
		await page.addInitScript((k: string) => {
			try {
				localStorage.setItem(k, "chat");
			} catch {
				/* ignore */
			}
		}, `st.view.${S}`);
		await app.login("alice");
		await app.openSession("scratch");
		await app.expectView("chat");
		await expect.poll(() => page.url()).toContain(`#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`);
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await app.openSession("docs");
		await app.expectView("files");
	});
});
