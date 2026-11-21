import { defineConfig, devices } from "@playwright/test";
const PORT = 5181;
const vp = (w: number, h: number, mobile: boolean, shell: string) => ({ ...devices["Desktop Chrome"], viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, shell });
const sizes: Array<[string, number, number, boolean]> = [["se-safari", 375, 548, true], ["13-safari", 390, 664, true], ["13-pwa", 390, 844, true], ["13-land", 844, 358, true], ["320", 320, 568, true], ["ipad", 820, 1100, true], ["1280", 1280, 800, false], ["1440", 1440, 900, false]];
export default defineConfig({
	testDir: ".", testMatch: /audit-.*\.spec\.ts/, timeout: 180_000, workers: 4, reporter: [["line"]],
	use: { baseURL: `http://localhost:${PORT}`, serviceWorkers: "block", locale: "en-US", timezoneId: "UTC", colorScheme: "dark", launchOptions: { args: ["--disable-gpu", "--disable-webgl", "--disable-webgl2", "--disable-dev-shm-usage"] } },
	projects: sizes.flatMap(([n, w, h, m]) => ["v1", "v2"].map((s) => ({ name: `${n}-${s}`, use: vp(w, h, m, s) }))),
	webServer: { command: `npx vite --port ${PORT} --strictPort`, cwd: "..", url: `http://localhost:${PORT}`, reuseExistingServer: true, env: { VITE_API_URL: `http://localhost:${PORT}` }, timeout: 120_000 },
});
