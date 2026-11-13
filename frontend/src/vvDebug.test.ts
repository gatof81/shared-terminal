import { afterEach, describe, expect, it, vi } from "vitest";
import { sample, vvDebugEnabled } from "./vvDebug.js";

function store(init: Record<string, string> = {}) {
	const m = new Map(Object.entries(init));
	return {
		getItem: (k: string) => m.get(k) ?? null,
		setItem: (k: string, v: string) => void m.set(k, v),
		removeItem: (k: string) => void m.delete(k),
		m,
	};
}

describe("vvDebugEnabled", () => {
	it("is off unless asked; ?vvdebug=1 turns it on and is remembered; ?vvdebug=0 turns it off", () => {
		const s = store();
		expect(vvDebugEnabled("", s)).toBe(false);
		expect(vvDebugEnabled("?vvdebug=1", s)).toBe(true);
		expect(vvDebugEnabled("", s)).toBe(true);
		expect(vvDebugEnabled("?vvdebug=0", s)).toBe(false);
		expect(vvDebugEnabled("", s)).toBe(false);
	});

	it("works without storage (private mode): only the address decides", () => {
		const broken = {
			getItem: () => {
				throw new Error("denied");
			},
			setItem: () => {
				throw new Error("denied");
			},
			removeItem: () => {},
		};
		expect(vvDebugEnabled("?vvdebug=1", broken)).toBe(true);
		expect(vvDebugEnabled("", null)).toBe(false);
	});
});

describe("sample", () => {
	afterEach(() => {
		document.body.replaceChildren();
		document.documentElement.removeAttribute("style");
		vi.restoreAllMocks();
	});

	it("records the viewport, the page scroll, the app variables and the focused field, changing nothing", () => {
		document.documentElement.style.setProperty("--app-vh", "380px");
		document.documentElement.style.setProperty("--app-top", "120px");
		const ta = document.createElement("textarea");
		ta.className = "tw-text";
		document.body.append(ta);
		ta.focus();
		const before = document.documentElement.getAttribute("style");
		const s = sample("focusin", performance.now());
		expect(s.ev).toBe("focusin");
		expect(s.appVh).toBe("380px");
		expect(s.appTop).toBe("120px");
		expect(s.focus).toBe("textarea.tw-text");
		expect(Array.isArray(s.focusBox)).toBe(true);
		expect(s).toHaveProperty("sy");
		expect(s).toHaveProperty("project");
		expect(s).toHaveProperty("chat");
		expect(document.documentElement.getAttribute("style")).toBe(before);
	});
});
