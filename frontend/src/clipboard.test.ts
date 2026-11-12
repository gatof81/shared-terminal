import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText, copyWithTextarea } from "./clipboard.js";

// Owner report 2026-11-12: "Copy report" lost the reader's place. The
// fallback copy focuses a hidden field — what browsers scroll for, and what
// pans iOS Safari's visual viewport. It must leave the reader where they were.

function scroller(top: number): HTMLElement {
	const sc = document.createElement("div");
	Object.defineProperty(sc, "scrollHeight", { value: 5000, configurable: true });
	Object.defineProperty(sc, "clientHeight", { value: 600, configurable: true });
	sc.scrollTop = top;
	document.body.append(sc);
	return sc;
}

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("copyWithTextarea", () => {
	it("puts back every scroll container the copy moved, and the focus, without scrolling", () => {
		const sc = scroller(1234);
		const btn = document.createElement("button");
		sc.append(btn);
		btn.focus();
		const focusSpy = vi.spyOn(btn, "focus");
		let seen: HTMLTextAreaElement | null = null;
		let focusOpts: FocusOptions | undefined;
		const origFocus = HTMLElement.prototype.focus;
		vi.spyOn(HTMLTextAreaElement.prototype, "focus").mockImplementation(function (
			this: HTMLTextAreaElement,
			o?: FocusOptions,
		) {
			focusOpts = o;
			origFocus.call(this, o);
		});
		document.execCommand = vi.fn(() => {
			seen = document.querySelector("textarea");
			sc.scrollTop = 0; // the browser scrolled to reveal the field
			return true;
		});
		expect(copyWithTextarea("the report")).toBe(true);
		expect(sc.scrollTop).toBe(1234);
		expect(focusOpts).toEqual({ preventScroll: true });
		expect(seen!.selectionStart).toBe(0);
		expect(seen!.selectionEnd).toBe("the report".length);
		expect(seen!.style.top).toBe("0px");
		expect(seen!.style.fontSize).toBe("16px");
		expect(document.querySelector("textarea")).toBeNull();
		expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
		expect(document.activeElement).toBe(btn);
	});

	it("a failing execCommand still cleans up and answers false", () => {
		const sc = scroller(50);
		const btn = document.createElement("button");
		sc.append(btn); // tapped, but not focused (iOS Safari)
		document.execCommand = vi.fn(() => {
			sc.scrollTop = 0;
			throw new Error("unsupported");
		});
		expect(copyWithTextarea("x", btn)).toBe(false);
		expect(sc.scrollTop).toBe(50);
		expect(document.querySelector("textarea")).toBeNull();
	});
});

describe("copyText", () => {
	it("uses the Clipboard API when it works; the fallback only when it refuses", async () => {
		const writeText = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("denied"));
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		document.execCommand = vi.fn(() => true);
		expect(await copyText("a")).toBe(true);
		expect(document.execCommand).not.toHaveBeenCalled();
		expect(await copyText("b")).toBe(true);
		expect(document.execCommand).toHaveBeenCalledWith("copy");
	});
});
