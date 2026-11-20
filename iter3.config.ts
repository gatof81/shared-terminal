import { defineConfig, devices } from "@playwright/test";
const PORT = Number(process.env.CAP_PORT ?? 5190);
const vp = (w: number, h: number, mobile: boolean, shell: string) => ({ ...devices["Desktop Chrome"], viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, shell });
const sizes: Array<[string, number, number, boolean]> = [["320", 320, 568, true], ["390", 390, 844, true], ["390x450", 390, 450, true], ["1280", 1280, 800, false], ["1440", 1440, 900, false], ["1920", 1920, 1080, false]];
export default defineConfig({
	testDir: "./e2e-capture", timeout: 120_000, workers: 4, reporter: [["line"]],
	use: { baseURL: `http://localhost:${PORT}`, serviceWorkers: "block", locale: "en-US", timezoneId: "UTC", colorScheme: "dark", launchOptions: { args: ["--disable-gpu", "--disable-webgl", "--disable-webgl2", "--disable-dev-shm-usage"] } },
	projects: sizes.flatMap(([n, w, h, m]) => ["v1", "v2"].map((s) => ({ name: `${n}-${s}`, use: vp(w, h, m, s) }))),
	webServer: { command: `npx vite --port ${PORT} --strictPort`, url: `http://localhost:${PORT}`, reuseExistingServer: false, env: { VITE_API_URL: `http://localhost:${PORT}` }, timeout: 120_000 },
});
