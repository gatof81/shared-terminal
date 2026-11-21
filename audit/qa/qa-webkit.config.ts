import base from "./playwright.config";
import { devices } from "@playwright/test";
const wk = { launchOptions: { executablePath: "/tmp/wk-iso/webkit-2158/pw_run.sh", args: [] as string[] } };
export default {
	...base,
	projects: [
		{ name: "wk-mobile", use: { ...devices["iPhone 13"], ...wk, viewport: { width: 390, height: 844 } } },
		{ name: "wk-mobile-v2", use: { ...devices["iPhone 13"], ...wk, viewport: { width: 390, height: 844 }, shell: "v2" } },
	],
};
