import { defineConfig, devices } from "@playwright/test";
const PORT = 5194;
const vp = (w: number, h: number, mobile: boolean) => ({ ...devices["Desktop Chrome"], viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
const sizes: Array<[string, number, number, boolean]> = [["320", 320, 568, true], ["390", 390, 844, true], ["390x450", 390, 450, true], ["ipad", 820, 1100, true], ["1280", 1280, 800, false], ["1440", 1440, 900, false]];
export default defineConfig({
	testDir: ".", testMatch: /rb\.spec\.ts/, timeout: 120_000, workers: 4, reporter: [["line"]], outputDir: "/home/developer/audit/simp-b/results",
	use: { baseURL: `http://localhost:${PORT}`, serviceWorkers: "block", locale: "en-US", timezoneId: "UTC", colorScheme: "dark", launchOptions: { args: ["--disable-gpu", "--disable-webgl", "--disable-webgl2", "--disable-dev-shm-usage"] } },
	projects: sizes.map(([n, w, h, m]) => ({ name: n, use: vp(w, h, m) })),
	webServer: { command: `npx vite --port ${PORT} --strictPort`, cwd: "..", url: `http://localhost:${PORT}`, reuseExistingServer: false, env: { VITE_API_URL: `http://localhost:${PORT}` }, timeout: 120_000 },
});
