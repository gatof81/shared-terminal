import { defineConfig, devices } from "@playwright/test";
const PORT = 5174;
const vp = (w: number, h: number, mobile = false) => ({ ...devices["Desktop Chrome"], viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
export default defineConfig({
	testDir: ".", testMatch: /.*\.spec\.ts/, timeout: 120_000, workers: 4, reporter: [["line"]],
	use: { baseURL: `http://localhost:${PORT}`, serviceWorkers: "block", locale: "en-US", timezoneId: "UTC", colorScheme: "dark", launchOptions: { args: ["--disable-gpu", "--disable-webgl", "--disable-webgl2", "--disable-dev-shm-usage"] } },
	projects: [
		{ name: "desk-v1", use: { ...vp(1280, 800), shell: "v1" } },
		{ name: "desk-v2", use: { ...vp(1280, 800), shell: "v2" } },
		{ name: "wide-v1", use: { ...vp(1920, 1080), shell: "v1" } },
		{ name: "wide-v2", use: { ...vp(1920, 1080), shell: "v2" } },
		{ name: "tab-v1", use: { ...vp(820, 1180, true), shell: "v1" } },
		{ name: "tab-v2", use: { ...vp(820, 1180, true), shell: "v2" } },
		{ name: "mob-v1", use: { ...vp(390, 844, true), shell: "v1" } },
		{ name: "mob-v2", use: { ...vp(390, 844, true), shell: "v2" } },
	],
	webServer: { command: `npx vite --port ${PORT} --strictPort`, cwd: "..", url: `http://localhost:${PORT}`, reuseExistingServer: true, env: { VITE_API_URL: `http://localhost:${PORT}` }, timeout: 120_000 },
});
