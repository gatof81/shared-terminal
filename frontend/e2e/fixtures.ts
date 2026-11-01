/**
 * fixtures.ts — the e2e test base: a fresh MockBackend per test, the
 * page's clock pinned to the seed's "now" (relative dates stay stable),
 * the vendored fonts forced on every element (identical rendering on
 * every machine), and an `app` helper that knows how to drive the two
 * layouts — desktop and the mobile drawers — so a spec reads the same
 * for both projects.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect, type Page } from "@playwright/test";
import { MockBackend, SESSION_IDS, type USERS } from "./mockBackend.js";

/** The seed data is stamped around 2026-10-31T10:00Z; the page's clock sits 30 min later. */
export const FIXED_NOW = "2026-10-31T10:30:00Z";

export type View = "terminal" | "files" | "git" | "chat";

/** Project option: which shell the app mounts (uiShell.ts override). */
export interface ShellOptions {
	shell: "v1" | "v2";
	/** Shell v2's mobile bar (uiShell.ts): null = the default (merged), "stacked" = the alternative. */
	bar: "stacked" | null;
	/**
	 * What the browser remembers about the seeded sessions' views
	 * (viewPolicy.ts). "legacy" (default) seeds the pre-policy landings —
	 * Terminal for the running session, Files for the others — so the
	 * suite's expectations hold under both shells; "none" starts clean, for
	 * the landing policy's own spec.
	 */
	landing: "legacy" | "none";
}

const FONTS_DIR = fileURLToPath(new URL("./fonts/", import.meta.url));
const FONT_CSS = `
@font-face { font-family: "E2E Sans"; src: url(/e2e-fonts/LiberationSans-Regular.ttf); font-weight: 400; }
@font-face { font-family: "E2E Sans"; src: url(/e2e-fonts/LiberationSans-Bold.ttf); font-weight: 500 800; }
@font-face { font-family: "E2E Mono"; src: url(/e2e-fonts/LiberationMono-Regular.ttf); }
* { font-family: "E2E Sans" !important; }
pre, code, kbd, [class*="code"], [class*="diff"], [class*="mono"], .xterm, #key-bar button { font-family: "E2E Mono" !important; }
`;

async function installFonts(page: Page): Promise<void> {
	await page.route("**/e2e-fonts/*", (route) => {
		const name = path.basename(new URL(route.request().url()).pathname);
		route.fulfill({
			status: 200,
			contentType: "font/ttf",
			body: readFileSync(path.join(FONTS_DIR, name)),
		});
	});
	await page.addInitScript((css: string) => {
		const inject = () => {
			const style = document.createElement("style");
			style.id = "e2e-fonts";
			style.textContent = css;
			document.head.appendChild(style);
		};
		if (document.head) inject();
		else document.addEventListener("DOMContentLoaded", inject);
	}, FONT_CSS);
}

export class App {
	readonly errors: string[] = [];

	constructor(
		readonly page: Page,
		readonly backend: MockBackend,
		readonly mobile: boolean,
		readonly shell: "v1" | "v2",
	) {
		page.on("pageerror", (err) => this.errors.push(String(err)));
	}

	/** v1 mobile only: the chrome drawer (toolbar + tabs) must be open to reach them. */
	async openChrome(): Promise<void> {
		if (!this.mobile || this.shell === "v2") return;
		const main = this.page.locator("main");
		if (!(await main.evaluate((el) => el.classList.contains("chrome-open")))) {
			await this.page.click("#chrome-toggle");
		}
	}

	/**
	 * Activate one of the header cluster's buttons by id (templates-btn,
	 * admin-btn, logout-btn, …): the button itself in v1 (header on
	 * desktop, sidebar footer on mobile), the user menu's entry in v2.
	 */
	async appMenu(id: string): Promise<void> {
		if (this.shell === "v2") {
			// The user menu is in the header on both layouts in v2.
			await this.page.click("#user-menu-btn");
			await this.page.locator(`[role="menu"].action-menu [data-action="${id}"]`).click();
			return;
		}
		if (this.mobile) {
			await this.openSidebar();
			await this.page.click(`#sidebar-${id}`);
			return;
		}
		await this.page.click(`#${id}`);
	}

	/** Load the app at `/` (optionally with a hash) already authenticated as `user`. */
	async login(user: keyof typeof USERS, hash = ""): Promise<void> {
		this.backend.loginAs(user);
		await this.page.goto(`/${hash}`);
		await expect(this.page.locator("#app-view")).toBeVisible();
		// The session list is the first thing the app loads after auth; a
		// deep link is consumed right after it lands.
		await expect
			.poll(() =>
				this.backend.requests.some((r) => r.method === "GET" && r.path.startsWith("/sessions")),
			)
			.toBe(true);
	}

	/** The login form, as a person would use it. */
	async loginViaForm(username: string, password = "pw"): Promise<void> {
		await this.page.goto("/");
		await expect(this.page.locator("#auth-view")).toBeVisible();
		await this.page.fill("#auth-username", username);
		await this.page.fill("#auth-password", password);
		await this.page.click("#auth-submit");
	}

	sessionRow(name: string) {
		return this.page.locator("#session-list .session-item", {
			has: this.page.locator(".session-name", { hasText: new RegExp(`^${name}$`) }),
		});
	}

	async openSidebar(): Promise<void> {
		if (!this.mobile) return;
		const main = this.page.locator("main");
		if (!(await main.evaluate((el) => el.classList.contains("sidebar-open")))) {
			await this.page.click("#sidebar-toggle");
		}
		await expect(main).toHaveClass(/sidebar-open/);
		// The drawer slides in (0.2 s): a row clicked mid-slide is "not stable".
		await expect(this.page.locator("#sidebar")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
	}

	async sidebarOpen(): Promise<boolean> {
		return this.page.locator("main").evaluate((el) => el.classList.contains("sidebar-open"));
	}

	/** Select a session from the sidebar and wait for it to become active. */
	async openSession(name: string): Promise<void> {
		await this.openSidebar();
		await this.sessionRow(name).click();
		await expect(this.page.locator("#terminal-session-name")).toHaveText(name);
	}

	/** Wait until the active session's terminal has attached and painted the mock's prompt. */
	async expectTerminalReady(): Promise<void> {
		await expect(this.page.locator("#terminal-container .tab-pane.active .xterm")).toBeVisible();
		await expect
			.poll(() => this.backend.terminalSockets.filter((s) => !s.closed).length)
			.toBeGreaterThan(0);
		// The welcome banner the mock writes on attach, rendered by xterm.
		await expect(this.page.locator("#terminal-container .tab-pane.active")).toContainText(
			"Welcome",
		);
	}

	async currentView(): Promise<View> {
		for (const v of ["files", "git", "chat"] as const) {
			if (await this.page.locator(`#${v}-view`).isVisible()) return v;
		}
		return "terminal";
	}

	/**
	 * Switch views the way the current layout offers it: the toolbar
	 * segmented control on desktop; on mobile the toolbar lives in the
	 * chrome drawer (opened from the header pill) while the terminal is
	 * shown, and the bottom nav takes over once an overlay is up.
	 */
	async switchView(view: View): Promise<void> {
		const current = await this.currentView();
		if (current === view) return;
		if (!this.mobile || this.shell === "v2") {
			// v2: the view tabs are in the session bar on every view.
			await this.page.click(`#view-${view}-btn`);
		} else if (current === "terminal") {
			const main = this.page.locator("main");
			if (!(await main.evaluate((el) => el.classList.contains("chrome-open")))) {
				await this.page.click("#chrome-toggle");
			}
			await this.page.click(`#view-${view}-btn`);
		} else {
			await this.page.click(`#view-nav button[data-view="${view}"]`);
		}
		await this.expectView(view);
	}

	async expectView(view: View): Promise<void> {
		for (const v of ["files", "git", "chat"] as const) {
			const overlay = this.page.locator(`#${v}-view`);
			if (v === view) await expect(overlay).toBeVisible();
			else await expect(overlay).toBeHidden();
		}
		if (view === "terminal") {
			// Either a live pane or the state panel (stopped / no tabs / lost socket).
			await expect(
				this.page.locator("#terminal-container, #terminal-state").filter({ visible: true }),
			).toHaveCount(1);
		}
	}

	toast(text: string | RegExp) {
		return this.page.locator("#toast .toast-item", { hasText: text });
	}

	/** Escape, as a keyboard user presses it (on whatever has focus). */
	async escape(): Promise<void> {
		await this.page.keyboard.press("Escape");
	}
}

export const test = base.extend<ShellOptions & { backend: MockBackend; app: App }>({
	shell: ["v1", { option: true }],
	bar: [null, { option: true }],
	landing: ["legacy", { option: true }],
	backend: async ({ page, shell, bar, landing }, use) => {
		const backend = new MockBackend();
		await backend.install(page);
		await installFonts(page);
		await page.clock.setFixedTime(FIXED_NOW);
		if (shell === "v2") {
			// The per-browser override, as `?ui=v2` (and `?bar=stacked`) would have stored it.
			await page.addInitScript((stacked: boolean) => {
				try {
					localStorage.setItem("st.uiShell", "v2");
					if (stacked) localStorage.setItem("st.uiShellBar", "stacked");
				} catch {
					/* ignore */
				}
			}, bar === "stacked");
		}
		if (landing === "legacy") {
			await page.addInitScript(
				(prefs: Record<string, string>) => {
					try {
						for (const [k, v] of Object.entries(prefs)) localStorage.setItem(k, v);
					} catch {
						/* ignore */
					}
				},
				{
					[`st.view.${SESSION_IDS.running}`]: "terminal",
					[`st.view.${SESSION_IDS.stopped}`]: "files",
					[`st.view.${SESSION_IDS.terminated}`]: "files",
				},
			);
		}
		await use(backend);
	},
	app: async ({ page, backend, isMobile, shell }, use) => {
		const app = new App(page, backend, isMobile === true, shell);
		await use(app);
		expect(app.errors, "uncaught errors in the page").toEqual([]);
	},
});

export { expect };
