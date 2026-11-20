import { expect, test } from "./fixtures.js";
import { PROJECT_IDS, PROJECT_SESSION_IDS } from "./mockBackend.js";

/**
 * The session bar as the context bar (UX iter3 §2 and E): one identity zone
 * — the session's name and state, or for an ACP agent's session "@agent",
 * its state and "sesión X · proyecto ↗" — the view tabs and the ⋯ last.
 * Its height is part of the terminal's box: the same in the four views and
 * for both kinds of session (terminal-invariant.spec.ts counts the resizes).
 */
test.describe("context bar", () => {
	test.beforeEach(({ backend }) => backend.enableAcp());

	test("the bar is as tall in Terminal, Files, Git and Chat, for a traditional session and an agent's", async ({
		app,
	}) => {
		await app.login("alice");
		const heights: number[] = [];
		for (const name of ["my-project", "hz-architect"]) {
			await app.openSession(name);
			for (const view of ["terminal", "files", "git", "chat"] as const) {
				await app.switchView(view);
				await app.expectView(view);
				heights.push(
					await app.page
						.locator("#terminal-toolbar")
						.evaluate((e) => (e as HTMLElement).offsetHeight),
				);
			}
		}
		expect(new Set(heights).size, `heights: ${heights.join(", ")}`).toBe(1);
	});

	test("an agent's session: '@agent', its state, 'sesión X · proyecto ↗'; the chat has no header row of its own", async ({
		app,
		page,
	}, info) => {
		test.skip(info.project.use.isMobile === true, "wide screens (the subtitle is ≥ 1100 px)");
		await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.architect}/chat`);
		await expect(page.locator("#terminal-session-name")).toHaveText("@arq");
		await expect(page.locator("#terminal-status-badge")).toHaveClass(/\bchip\b/);
		await expect(page.locator("#terminal-status-badge")).toHaveAttribute("title", /^Agente: /);
		await expect(page.locator("#terminal-session-sub")).toHaveText(
			"sesión hz-architect · Educación HZ ↗",
		);
		await expect(page.locator("#acp-chat .acp-chat-header")).toBeHidden();
		// The subtitle's project opens Project Chat.
		await page.locator("#terminal-session-sub a").click();
		await expect(page).toHaveURL(new RegExp(`#/projects/${PROJECT_IDS.hz}`));
	});

	test("a long session name gives way in the subtitle; the project's link stays whole", async ({
		app,
		backend,
		page,
	}, info) => {
		test.skip(info.project.use.isMobile === true, "wide screens (the subtitle is ≥ 1100 px)");
		backend.sessions.find((s) => s.sessionId === PROJECT_SESSION_IDS.architect)!.name =
			"hz-architect-with-a-session-name-far-too-long-for-the-bar";
		await page.setViewportSize({ width: 1180, height: 800 });
		await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.architect}/chat`);
		const sub = page.locator("#terminal-session-sub");
		await expect(sub).toContainText("Educación HZ ↗");
		const box = (await sub.boundingBox())!;
		const link = (await sub.locator("a").boundingBox())!;
		expect(link.x + link.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
	});

	test("'Ajustes del agente' is the ⋯'s first entry; what the settings need is flagged on the ⋯", async ({
		app,
		backend,
		page,
		shell,
	}, info) => {
		test.skip(
			info.project.use.isMobile === true && shell !== "v2",
			"a v1 phone keeps the agent's own row and its Ajustes button",
		);
		const solo = backend.acpAgents.find((a) => a.name === "solo")!;
		solo.model = "claude-opus-5-5";
		solo.modelApplied = { requested: "claude-opus-5-5", current: null, error: "no disponible" };
		await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}/terminal`);
		const more = page.locator("#session-menu-btn");
		await expect(more).toHaveAccessibleName("Session actions (el modelo no se aplicó)");
		await expect(more.locator(".bar-menu-flag")).toHaveText("!");
		// The mark sits inside the button, clear of its edge (a fixed icon
		// width left it touching the edge: it read as outside the button).
		const btn = (await more.boundingBox())!;
		const mark = (await more.locator(".bar-menu-flag").boundingBox())!;
		expect(btn.x + btn.width - (mark.x + mark.width)).toBeGreaterThanOrEqual(4);
		await more.click();
		const first = page.getByRole("menuitem").first();
		await expect(first).toContainText("Ajustes del agente");
		await first.click();
		// From another view too: the agent's Chat, with the panel open and the focus in it.
		await app.expectView("chat");
		await expect(page.locator("#acp-chat .acp-settings")).toBeVisible();
		await expect(page.locator("#acp-chat .acp-model-state")).toContainText("no disponible");
		expect(
			await page.evaluate(() =>
				document.getElementById("acp-settings")!.contains(document.activeElement),
			),
		).toBe(true);
		// A traditional session's ⋯ has no such entry, and no flag.
		await app.openSession("my-project");
		if (await more.isVisible()) {
			await expect(more).toHaveAccessibleName("Session actions");
			await more.click();
			await expect(page.getByRole("menuitem", { name: /Ajustes del agente/ })).toHaveCount(0);
		}
	});

	test("the overlays' own bars are one height with the refresh as an icon button", async ({
		app,
	}, info) => {
		test.skip(info.project.use.isMobile === true, "desktop measures");
		await app.login("alice");
		await app.openSession("my-project");
		for (const view of ["files", "git", "chat"] as const) {
			await app.switchView(view);
			const bar = app.page.locator(`#${view}-header`);
			expect(Math.round((await bar.boundingBox())!.height)).toBe(36);
			await expect(app.page.locator(`#${view}-refresh-btn`)).toHaveClass(/\bbtn-icon\b/);
		}
	});
});

test.describe("context bar on a v2 phone", () => {
	for (const width of [320, 390]) {
		test(`${width} px: 44-px tall targets, tabs at least 40 wide, nothing covered, the title keeps its letters`, async ({
			app,
			backend,
			page,
			shell,
		}, info) => {
			test.skip(!(info.project.use.isMobile && shell === "v2"), "shell v2 on a phone");
			backend.enableAcp();
			await page.setViewportSize({ width, height: 700 });
			await app.login("alice", `#/sessions/${PROJECT_SESSION_IDS.scratch}/chat`);
			await expect(page.locator("#terminal-session-name")).toHaveText("@solo");
			for (const b of await page.locator("header #view-switch button").all()) {
				const r = (await b.boundingBox())!;
				expect(Math.round(r.height)).toBeGreaterThanOrEqual(44);
				expect(Math.round(r.width)).toBeGreaterThanOrEqual(40);
			}
			const more = (await page.locator("#session-menu-btn").boundingBox())!;
			expect(Math.round(more.height)).toBeGreaterThanOrEqual(44);
			// The ⋯ is the topmost thing at its centre (the account does not cover it).
			expect(
				await page.evaluate(
					([x, y]) => document.elementFromPoint(x!, y!)?.closest("#session-menu-btn") !== null,
					[more.x + more.width / 2, more.y + more.height / 2],
				),
			).toBe(true);
			const bar = page.locator("#terminal-toolbar");
			expect(await bar.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
			// "@solo" whole: shorter than the floor, so nothing is cut.
			expect(
				await page
					.locator("#terminal-session-name")
					.evaluate((e) => e.scrollWidth <= e.clientWidth),
			).toBe(true);
		});
	}
});
