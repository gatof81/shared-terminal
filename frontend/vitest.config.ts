import { defineConfig } from "vitest/config";

// jsdom for DOM globals (window, localStorage, CustomEvent) used by api.ts.
// We don't pull in vite.config.ts here — the production build's CSP plugin
// and proxy aren't needed under test, and pulling them would force every
// test run to re-derive VITE_API_URL through loadEnv.
export default defineConfig({
	test: {
		environment: "jsdom",
		include: ["src/**/*.test.ts"],
		globals: false,
	},
});
