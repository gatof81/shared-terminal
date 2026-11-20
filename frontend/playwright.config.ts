import { defineConfig, devices } from "@playwright/test";
import type { ShellOptions } from "./e2e/fixtures.js";

// End-to-end harness (docs/design/ui-unificada.md §8.2, PR 3). The app runs
// on the Vite dev server with VITE_API_URL pointing at ITSELF, so every
// /api and /ws request is same-origin and intercepted by the deterministic
// mock backend in e2e/mockBackend.ts (page.route / page.routeWebSocket):
// no real backend, no Docker, no network. Flows that need tmux or Docker
// stay in the Session Image workflow's smokes.
const PORT = 5174;

// CI profile. Pull requests run `E2E_PROFILE=pr`; pushes to main and local
// runs keep the whole matrix (the default). The primary shell is v1: VM100
// runs with UI_SHELL unset, so /api/auth/status answers `uiShell: "v1"`
// (checked 2026-11-18) and that is what every browser without a `?ui=`
// override mounts — so `desktop` and `mobile` (v1) run the whole suite on
// every PR. The v2 projects keep, on a PR, the specs whose behaviour depends
// on the shell or the bar (view tabs, Chat-first landing, the terminal
// invariant, history/back, the session bar, the phone keyboard and their
// screenshots); every other spec drives the same views through the same
// mock and runs under v2 on main. If the primary shell changes, swap these.
const PR_PROFILE = process.env.E2E_PROFILE === "pr";
const V2_SPECIFIC =
	/(shell-v2|chat-first|terminal-invariant|navigation|router|session-bar|keyboard|visual)\.spec\.ts/;
// TEMPORARY (PR #714, reverted before review): the stacked bar's screenshots
// on this PR, so its new baselines are the CI's own render.
const STACKED_BAR = /(navigation|terminal-invariant|shell-v2|visual)\.spec\.ts/;
const v2Match = PR_PROFILE ? { testMatch: V2_SPECIFIC } : {};

export default defineConfig<ShellOptions>({
	testDir: "./e2e",
	testMatch: /.*\.spec\.ts/,
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	// The CI runner has 4 vCPUs. Against the production build (below) four
	// workers kept every test green with no retries in the measurements of
	// #681 (2026-11-18); against the dev server they saturated the CPU.
	workers: process.env.CI ? 4 : undefined,
	reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
	// The router scenarios chain a dozen navigations and deliberately slow
	// answers; 30 s was too tight for them under a loaded box.
	timeout: 60_000,
	expect: {
		timeout: 7_000,
		toHaveScreenshot: {
			// Same Chromium build and the same vendored fonts everywhere (see
			// e2e/fixtures.ts). Measured 2026-11-05: independent CI runs of the
			// same code render byte-identical screenshots (0 differing pixels),
			// while the old 2% ratio let a real layout regression through — the
			// Git diff's code column moved half a pane (0.78% of pixels, #526)
			// and stale baselines kept passing (#525). An absolute margin keeps
			// a little slack for noise without hiding a moved column or a
			// restyled button.
			maxDiffPixels: 100,
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
			...v2Match,
			use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, shell: "v2" },
		},
		{
			name: "mobile-v2",
			...v2Match,
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
		// screenshots (on a PR, the bar's own specs without the screenshots).
		{
			name: "mobile-v2-stacked",
			testMatch: STACKED_BAR,
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
		// CI serves the production build (`E2E_SERVER=preview`): the shipped
		// bundle, and one script per page load instead of ~100 modules the
		// dev server transforms on every test's fresh page (−25 % wall time
		// at equal workers). Locally the dev server stays the default.
		command:
			process.env.E2E_SERVER === "preview"
				? `npx vite build && npx vite preview --port ${PORT} --strictPort`
				: `npx vite --port ${PORT} --strictPort`,
		url: `http://localhost:${PORT}`,
		reuseExistingServer: !process.env.CI,
		env: { VITE_API_URL: `http://localhost:${PORT}` },
		timeout: 120_000,
	},
});
