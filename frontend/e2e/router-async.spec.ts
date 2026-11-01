import { expect, test } from "./fixtures.js";
import { SESSION_IDS } from "./mockBackend.js";

const S = SESSION_IDS.running;

/**
 * The router against slow answers (PR #499 follow-up): a route that names
 * a file or a diff while the listing / the git status is still loading
 * must keep the address as it is (no transient URL without the detail, no
 * history entry when the view lands it), a newer route or the person's own
 * click must win over an older one still in flight, and none of it may
 * touch the terminal.
 */
test.describe("router with delayed answers", () => {
	test("a deep link into a file keeps its address while the listing loads; landing it adds no entry", async ({
		app,
		backend,
		page,
	}) => {
		backend.delays = { fsList: 700, fsPreview: 300 };
		await app.login("alice", `#/sessions/${S}/files/src/auth.ts`);
		const wanted = `#/sessions/${S}/files/src/auth.ts`;
		const length = await page.evaluate(() => history.length);
		// While the listings arrive (two levels, 700 ms each) the address never changes.
		for (let i = 0; i < 8; i++) {
			expect(page.url(), `tick ${i}`).toContain(wanted);
			await page.waitForTimeout(150);
		}
		await expect(page.locator("#files-preview")).toContainText("export function login", {
			timeout: 10_000,
		});
		expect(page.url()).toContain(wanted);
		expect(await page.evaluate(() => history.length), "no entry added by the landing").toBe(length);
		await expect(page.locator("#files-breadcrumbs")).toContainText("auth.ts");
	});

	test("a deep link into a diff waits for the git status without touching the address", async ({
		app,
		backend,
		page,
	}) => {
		backend.delays = { gitStatus: 700, gitLog: 200, gitDiff: 300 };
		await app.login("alice", `#/sessions/${S}/git/unstaged:src/auth.ts`);
		const wanted = `#/sessions/${S}/git/unstaged:src/auth.ts`;
		const length = await page.evaluate(() => history.length);
		for (let i = 0; i < 6; i++) {
			expect(page.url(), `tick ${i}`).toContain(wanted);
			await page.waitForTimeout(150);
		}
		await expect(page.locator("#git-diff")).toContainText("cookie === null", { timeout: 10_000 });
		await expect(page.locator("#git-list .git-row.selected")).toContainText("auth.ts");
		expect(page.url()).toContain(wanted);
		expect(await page.evaluate(() => history.length)).toBe(length);
	});

	test("two routes in quick succession: the newer one wins, the older one has no effect", async ({
		app,
		backend,
		page,
	}) => {
		backend.delays = { fsList: 500, fsPreview: 200 };
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("files");
		await expect(page.locator("#files-tree .files-row").first()).toBeVisible({ timeout: 10_000 });
		// Two hash navigations before the first can resolve (src/ must load).
		await page.evaluate((h) => {
			window.location.hash = h;
		}, `#/sessions/${S}/files/src/index.ts`);
		await page.waitForTimeout(100);
		await page.evaluate((h) => {
			window.location.hash = h;
		}, `#/sessions/${S}/files/README.md`);
		await expect(page.locator("#files-preview")).toContainText("sample workspace", {
			timeout: 10_000,
		});
		await page.waitForTimeout(900); // long enough for the older reveal to have landed, if it did
		await expect(page.locator("#files-preview")).toContainText("sample workspace");
		await expect(page.locator("#files-preview")).not.toContainText("hello");
		expect(page.url()).toContain("/files/README.md");
		await expect(app.toast(/Not found/)).toHaveCount(0);
	});

	test("the person's own click wins over a route still loading", async ({ app, backend, page }) => {
		backend.delays = { fsList: 600, fsPreview: 100 };
		await app.login("alice");
		await app.openSession("my-project");
		await app.switchView("files");
		await expect(page.locator("#files-tree .files-row").first()).toBeVisible({ timeout: 10_000 });
		await page.evaluate((h) => {
			window.location.hash = h;
		}, `#/sessions/${S}/files/src/auth.ts`);
		await page.locator("#files-tree .files-row", { hasText: "package.json" }).click();
		await expect(page.locator("#files-preview")).toContainText('"name": "my-project"');
		await page.waitForTimeout(900);
		await expect(page.locator("#files-preview")).toContainText('"name": "my-project"');
		await expect(page.locator("#files-preview")).not.toContainText("export function login");
		expect(page.url()).toContain("/files/package.json");
	});

	test("switching session while a reveal is pending shows nothing of the old one", async ({
		app,
		backend,
		page,
	}) => {
		backend.delays = { fsList: 700 };
		await app.login("alice", `#/sessions/${SESSION_IDS.stopped}/files/README.md`);
		await expect(page.locator("#terminal-session-name")).toHaveText("docs");
		await app.openSession("my-project");
		await expect(page.locator("#terminal-session-name")).toHaveText("my-project");
		await page.waitForTimeout(1200);
		await expect(page.locator("#terminal-session-name")).toHaveText("my-project");
		expect(page.url()).toContain(`#/sessions/${S}/`);
		expect(page.url()).not.toContain("README.md");
		await expect(app.toast(/Not found/)).toHaveCount(0);
	});

	test("deep link, then another tab of the same session before the tabs arrive: the last one wins", async ({
		app,
		backend,
		page,
	}) => {
		// Long enough that the hash assignment below always precedes the tabs, under CI load too.
		backend.delays = { tabs: 2500 };
		await app.login("alice", `#/sessions/${S}/terminal/tab-1`);
		await expect(page.locator("#terminal-session-name")).toHaveText("my-project");
		const length = await page.evaluate(() => history.length);
		// The person moves on while the tab list is still loading.
		await page.waitForTimeout(200);
		expect(backend.terminalSockets, "tabs not landed yet").toHaveLength(0);
		await page.evaluate((h) => {
			window.location.hash = h;
		}, `#/sessions/${S}/terminal/tab-2`);
		await expect(page.locator("#terminal-container .tab-pane.active")).toContainText("(tab-2)", {
			timeout: 10_000,
		});
		await page.waitForTimeout(500);
		await expect(page.locator("#terminal-container .tab-pane.active")).toContainText("(tab-2)");
		await expect(page.locator("#terminal-tabs .tab-chip.active")).toHaveAttribute("data-tab-id", "tab-2");
		expect(page.url()).toContain(`#/sessions/${S}/terminal/tab-2`);
		// One attach, for the tab on screen; the first route opened nothing.
		expect(backend.terminalSockets.map((s) => s.tabId)).toEqual(["tab-2"]);
		// The hash assignment is the one entry; landing the tabs added none.
		expect(await page.evaluate(() => history.length)).toBe(length + 1);
	});

	test("deep link, then another view of the same session before the tabs arrive: the view wins", async ({
		app,
		backend,
		page,
	}) => {
		backend.delays = { tabs: 2500 };
		await app.login("alice", `#/sessions/${S}/terminal/tab-2`);
		await expect(page.locator("#terminal-session-name")).toHaveText("my-project");
		const length = await page.evaluate(() => history.length);
		await page.waitForTimeout(200);
		expect(backend.terminalSockets, "tabs not landed yet").toHaveLength(0);
		await page.evaluate((h) => {
			window.location.hash = h;
		}, `#/sessions/${S}/files`);
		await app.expectView("files");
		await expect(page.locator("#files-tree .files-row").first()).toBeVisible({ timeout: 10_000 });
		// The tabs land underneath: the route's tab attaches, the address stays.
		await expect.poll(() => backend.terminalSockets.length, { timeout: 10_000 }).toBe(1);
		await page.waitForTimeout(300);
		await app.expectView("files");
		expect(page.url()).toContain(`#/sessions/${S}/files`);
		expect(page.url()).not.toContain("terminal");
		expect(backend.terminalSockets.map((s) => s.tabId)).toEqual(["tab-2"]);
		expect(await page.evaluate(() => history.length)).toBe(length + 1);
	});

	test("deep link, then a manual selection of another session before the tabs arrive: the address follows the selection", async ({
		app,
		backend,
		page,
	}) => {
		// Long enough for the mobile drawer hop that the selection goes through.
		backend.delays = { tabs: 2500 };
		await app.login("alice", `#/sessions/${S}/terminal/tab-1`);
		await expect(page.locator("#terminal-session-name")).toHaveText("my-project");
		const length = await page.evaluate(() => history.length);
		await page.waitForTimeout(200);
		await app.openSession("docs");
		expect(backend.terminalSockets, "tabs not landed yet").toHaveLength(0);
		await app.expectView("files");
		expect(page.url()).toContain(`#/sessions/${SESSION_IDS.stopped}/files`);
		// The deep-linked session's tabs land after the switch: nothing of it shows or attaches.
		await page.waitForTimeout(2800);
		await expect(page.locator("#terminal-session-name")).toHaveText("docs");
		await app.expectView("files");
		expect(page.url()).toContain(`#/sessions/${SESSION_IDS.stopped}/files`);
		expect(page.url()).not.toContain(S);
		expect(backend.terminalSockets).toHaveLength(0);
		// A selection replaces the entry; no entry from the abandoned route.
		expect(await page.evaluate(() => history.length)).toBe(length);
		await expect(app.toast(/Not found/)).toHaveCount(0);
	});

	test("Back and Forward over slow details: the final state matches the final address; the terminal untouched", async ({
		app,
		backend,
		page,
	}) => {
		await app.login("alice");
		await app.openSession("my-project");
		await app.expectTerminalReady();
		await app.switchView("files");
		// Measured from here: entering Files on v1 mobile goes through the
		// chrome drawer (its known resize cost, terminal-invariant.spec.ts);
		// everything that follows must send nothing.
		await page.waitForTimeout(300);
		const sock = backend.terminalSockets[0]!;
		const frames = sock.sent.length;
		const sockets = backend.terminalSockets.length;

		await page.locator("#files-tree .files-row", { hasText: "README.md" }).click();
		await expect(page.locator("#files-preview")).toContainText("sample workspace");
		// The second file by address (on mobile the tree is behind the
		// preview); a hash assignment is a history entry like a click.
		await page.evaluate((h) => {
			window.location.hash = h;
		}, `#/sessions/${S}/files/package.json`);
		await expect(page.locator("#files-preview")).toContainText("my-project");
		backend.delays = { fsPreview: 500 };
		await page.goBack(); // README (slow preview)
		await page.goForward(); // package.json before README's preview landed
		await expect(page.locator("#files-preview")).toContainText('"name": "my-project"', {
			timeout: 10_000,
		});
		await page.waitForTimeout(800);
		await expect(page.locator("#files-preview")).toContainText('"name": "my-project"');
		expect(page.url()).toContain("/files/package.json");

		expect(backend.terminalSockets.length).toBe(sockets);
		expect(sock.closed).toBe(false);
		expect(sock.sent.length - frames, "no frame sent to the terminal").toBe(0);
		await app.switchView("terminal");
		await expect(page.locator(".tab-pane.active")).toContainText("Welcome");
	});
});
