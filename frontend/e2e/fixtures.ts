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
import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { MockBackend, type USERS } from "./mockBackend.js";

/** The seed data is stamped around 2026-10-31T10:00Z; the page's clock sits 30 min later. */
export const FIXED_NOW = "2026-10-31T10:30:00Z";

export type View = "terminal" | "files" | "git";

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
	) {
		page.on("pageerror", (err) => this.errors.push(String(err)));
	}

	/** Open the user menu: the avatar, or under 400 px the drawer's «Cuenta» row. */
	async openUserMenu(): Promise<void> {
		if (await this.page.locator("#user-menu-btn").isVisible()) {
			await this.page.click("#user-menu-btn");
		} else {
			await this.openSidebar();
			await this.page.click("#sidebar-account-btn");
		}
		await expect(this.page.locator('[role="menu"].action-menu')).toBeVisible();
	}

	/**
	 * Pick an entry of the user menu by its id (templates, invites,
	 * my-groups, admin, notifications, logout): from the avatar, or under
	 * 400 px from the drawer's «Cuenta» row.
	 */
	async appMenu(id: string): Promise<void> {
		await this.openUserMenu();
		await this.page.locator(`[role="menu"].action-menu [data-action="${id}"]`).click();
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

	/**
	 * A session's row by the session's name: shown on a session's row; on an
	 * agent's row (the tree, UX iter3 §1) the row shows "@agent" and the
	 * session's name is its `data-session-name` (tooltip, accessible name).
	 */
	sessionRow(name: string) {
		return this.page
			.locator("#session-list .session-item", {
				has: this.page.locator(".session-name", { hasText: new RegExp(`^${name}$`) }),
			})
			.or(
				this.page.locator("#session-list .session-item", {
					has: this.page.locator(`.session-select[data-session-name="${name}"]`),
				}),
			);
	}

	async openSidebar(): Promise<void> {
		if (!this.mobile) return;
		// The phone's home (an address that names nothing): the list is the screen.
		if (await this.page.locator("body").evaluate((b) => b.classList.contains("home-on"))) return;
		const main = this.page.locator("main");
		if (!(await main.evaluate((el) => el.classList.contains("sidebar-open")))) {
			await this.page.click("#sidebar-toggle");
		}
		await expect(main).toHaveClass(/sidebar-open/);
		// The drawer slides in (0.2 s): a row clicked mid-slide is "not stable".
		await expect(this.page.locator("#sidebar")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
	}

	/** The Sessions section's ⋯ (the sidebar tree): Show/Hide terminated. */
	async showTerminated(): Promise<void> {
		await this.openSidebar();
		await this.page.locator(".sgroup-sessions .ssection-menu").click();
		await this.page.getByRole("menuitem", { name: /^Show terminated/ }).click();
		await expect(this.page.locator("#show-terminated-toggle")).toBeChecked();
	}

	/** The Sessions section's ⋯ → Refresh: re-reads the session list. */
	async refreshSessions(): Promise<void> {
		await this.openSidebar();
		await this.page.locator(".sgroup-sessions .ssection-menu").click();
		await this.page.getByRole("menuitem", { name: /^Refresh/ }).click();
	}

	async sidebarOpen(): Promise<boolean> {
		return this.page.locator("main").evaluate((el) => el.classList.contains("sidebar-open"));
	}

	/**
	 * Select a session from the sidebar and wait for it to become active (the
	 * bar names it; an agent's session shows "@agent" there, the session's
	 * name being its `data-session-name`).
	 */
	async openSession(name: string): Promise<void> {
		await this.openSidebar();
		await this.sessionRow(name).click();
		await expect(this.page.locator("#terminal-toolbar")).toHaveAttribute("data-session-name", name);
	}

	/**
	 * An ACP agent's settings dialog, from the bar's ⋯ ("Ajustes del agente",
	 * acpSettings.ts). Returns the ⋯ (Escape gives the focus back to it).
	 */
	async openAgentSettings(): Promise<Locator> {
		const more = this.page.locator("#session-menu-btn");
		await more.click();
		await this.page.getByRole("menuitem", { name: /^Ajustes del agente/ }).click();
		return more;
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
		for (const v of ["files", "git"] as const) {
			if (await this.page.locator(`#${v}-view`).isVisible()) return v;
		}
		return "terminal";
	}

	/** Switch views with the session bar's view tabs (on screen on every view). */
	async switchView(view: View): Promise<void> {
		const current = await this.currentView();
		if (current === view) return;
		await this.page.click(`#view-${view}-btn`);
		await this.expectView(view);
	}

	async expectView(view: View): Promise<void> {
		for (const v of ["files", "git"] as const) {
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

export const test = base.extend<{ backend: MockBackend; app: App }>({
	backend: async ({ page }, use) => {
		const backend = new MockBackend();
		await backend.install(page);
		await installFonts(page);
		await page.clock.setFixedTime(FIXED_NOW);
		await use(backend);
	},
	app: async ({ page, backend, isMobile }, use) => {
		const app = new App(page, backend, isMobile === true);
		await use(app);
		expect(app.errors, "uncaught errors in the page").toEqual([]);
	},
});

export { expect };
