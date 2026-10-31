import { afterEach, describe, expect, it } from "vitest";
import { readXtermTheme } from "./theme.js";

describe("readXtermTheme", () => {
	afterEach(() => {
		document.documentElement.removeAttribute("style");
	});

	it("falls back to the historical palette when no token is defined (jsdom, no stylesheet)", () => {
		expect(readXtermTheme()).toEqual({
			background: "#0d1117",
			foreground: "#e6edf3",
			cursor: "#58a6ff",
			selectionBackground: "#264f78",
		});
	});

	it("reads the tokens from :root when they are defined", () => {
		const root = document.documentElement;
		root.style.setProperty("--c-bg", "#000000");
		root.style.setProperty("--c-text", " #ffffff ");
		root.style.setProperty("--c-accent", "#ff0000");
		root.style.setProperty("--c-selection", "#00ff00");
		expect(readXtermTheme()).toEqual({
			background: "#000000",
			foreground: "#ffffff",
			cursor: "#ff0000",
			selectionBackground: "#00ff00",
		});
	});

	it("falls back per token, not all-or-nothing", () => {
		document.documentElement.style.setProperty("--c-bg", "#111111");
		const t = readXtermTheme();
		expect(t.background).toBe("#111111");
		expect(t.foreground).toBe("#e6edf3");
	});
});
