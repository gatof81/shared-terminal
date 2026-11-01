import { defineConfig, devices } from "@playwright/test";
import type { ShellOptions } from "./e2e/fixtures.js";

// End-to-end harness (docs/design/ui-unificada.md §8.2, PR 3). The app runs
// on the Vite dev server with VITE_API_URL pointing at ITSELF, so every
// /api and /ws request is same-origin and intercepted by the deterministic
// mock backend in e2e/mockBackend.ts (page.route / page.routeWebSocket):
// no real backend, no Docker, no network. Flows that need tmux or Docker
// stay in the Session Image workflow's smokes.
const PORT = 5174;

export default defineConfig<ShellOptions>({
	testDir: "./e2e",
	testMatch: /.*\.spec\.ts/,
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: process.env.CI ? 2 : undefined,
	reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
	// The router scenarios chain a dozen navigations and deliberately slow
	// answers; 30 s was too tight for them under a loaded box.
	timeout: 60_000,
	expect: {
		timeout: 7_000,
		toHaveScreenshot: {
			// Same Chromium build and the same vendored fonts everywhere (see
			// e2e/fixtures.ts), so only anti-aliasing noise is left.
			maxDiffPixelRatio: 0.02,
			// pixelmatch's default YIQ threshold (0.2) lets a dark-grey toast on
			// the near-black background pass as "same pixel"; 0.1 counts it —
			// and with it any stale baseline (`--update-snapshots` only rewrites
			// what fails, so a baseline that "matched" was never refreshed).
			threshold: 0.1,
			animations: "disabled",
			caret: "hide",
		},
	},
	snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{testFilePath}/{arg}{ext}",
	use: {
		baseURL: `http://localhost:${PORT}`,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		// The real service worker (push notifications) would sit between the
		// page and page.route; nothing here exercises push.
		serviceWorkers: "block",
		locale: "en-US",
		timezoneId: "UTC",
		colorScheme: "dark",
		// No WebGL: xterm then uses its DOM renderer, whose rows are real text
		// nodes the specs can read ("Welcome…", the echo of a keystroke). The
		// WebGL tier is covered by the Session Image smokes against a GPU-less
		// container anyway, and the screenshots mask the terminal.
		launchOptions: { args: ["--disable-gpu", "--disable-webgl", "--disable-webgl2"] },
	},
	projects: [
		{
			name: "desktop",
			use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
		},
		{
			name: "mobile",
			// A 390-px phone with touch: the app's mobile breakpoint (≤ 768 px)
			// and `pointer: coarse` (the key bar) both engage.
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 390, height: 844 },
				deviceScaleFactor: 1,
				isMobile: true,
				hasTouch: true,
			},
		},
		// The same suite under shell v2 (uiShell.ts): the per-browser
		// override is set before the app loads (e2e/fixtures.ts).
		{
			name: "desktop-v2",
			use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, shell: "v2" },
		},
		{
			name: "mobile-v2",
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 390, height: 844 },
				deviceScaleFactor: 1,
				isMobile: true,
				hasTouch: true,
				shell: "v2",
			},
		},
		// The stacked-bar alternative of v2 on a phone (uiShell.ts
		// `?bar=stacked`; the merged bar is the default that `mobile-v2`
		// runs): the navigation, the invariant, the shell spec and the
		// screenshots.
		{
			name: "mobile-v2-stacked",
			testMatch: /(navigation|terminal-invariant|shell-v2|visual)\.spec\.ts/,
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 390, height: 844 },
				deviceScaleFactor: 1,
				isMobile: true,
				hasTouch: true,
				shell: "v2",
				bar: "stacked",
			},
		},
	],
	webServer: {
		command: `npx vite --port ${PORT} --strictPort`,
		url: `http://localhost:${PORT}`,
		reuseExistingServer: !process.env.CI,
		env: { VITE_API_URL: `http://localhost:${PORT}` },
		timeout: 60_000,
	},
});
