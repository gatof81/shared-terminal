import { defineConfig, devices } from "@playwright/test";

// End-to-end harness (docs/design/ui-unificada.md §8.2, PR 3). The app runs
// on the Vite dev server with VITE_API_URL pointing at ITSELF, so every
// /api and /ws request is same-origin and intercepted by the deterministic
// mock backend in e2e/mockBackend.ts (page.route / page.routeWebSocket):
// no real backend, no Docker, no network. Flows that need tmux or Docker
// stay in the Session Image workflow's smokes.
// E2E_PORT: a run that must not take 5174 (another worktree, a parallel job).
const PORT = Number(process.env.E2E_PORT ?? 5174);

export default defineConfig({
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
	// QA one-off (NOT for merge): this branch runs the suite on WebKit — Safari's
	// engine on a desktop and an iPhone 13 profile (iOS UA, touch). Baselines are
	// Chromium's, so the visual spec is left out.
	projects: true // this branch only: always WebKit (the token cannot edit ci.yml)
		? [
				{
					name: "webkit-desktop",
					testIgnore: /visual\.spec\.ts/,
					use: {
						...devices["Desktop Safari"],
						viewport: { width: 1280, height: 800 },
						launchOptions: {},
					},
				},
				{
					name: "webkit-mobile",
					grepInvert: /@any-viewport/,
					testIgnore: /visual\.spec\.ts/,
					use: {
						...devices["iPhone 13"],
						viewport: { width: 390, height: 844 },
						launchOptions: {},
					},
				},
			]
		: [
				{
					name: "desktop",
					use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
				},
				{
					name: "mobile",
					// A 390-px phone with touch: the app's mobile breakpoint (≤ 768 px)
					// and `pointer: coarse` (the key bar) both engage.
					// `@any-viewport`: timing, network and cookie logic with nothing on
					// screen that depends on the width (the read budget, the landing's
					// waits, the auth transitions). One run on desktop proves it; the
					// phone repeated it for ~45 s of worker time per CI run.
					grepInvert: /@any-viewport/,
					use: {
						...devices["Desktop Chrome"],
						viewport: { width: 390, height: 844 },
						deviceScaleFactor: 1,
						isMobile: true,
						hasTouch: true,
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
