import { defineConfig, devices } from "@playwright/test";
export default defineConfig({ testDir: ".", timeout: 60000, workers: 2,
 use: { colorScheme: "dark", locale: "es-AR", launchOptions: { args: ["--disable-gpu"] } },
 projects: [
  { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  { name: "mobile", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
 ] });
