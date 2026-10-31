import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToasts, MAX_VISIBLE, showCopySuccessToast, showToast, showToastEx } from "./toast.js";

beforeEach(() => {
	vi.useFakeTimers();
	document.body.innerHTML = `<div id="toast"></div>`;
});
afterEach(() => {
	clearToasts();
	vi.useRealTimers();
});

const items = () => [...document.querySelectorAll<HTMLElement>(".toast-item")];

describe("toast", () => {
	it("is a polite live region; an error is an alert, the rest are status", () => {
		showToast("hello");
		showToast("boom", true);
		const c = document.getElementById("toast")!;
		expect(c.getAttribute("aria-live")).toBe("polite");
		expect(items().map((i) => i.getAttribute("role"))).toEqual(["status", "alert"]);
		expect(items()[1]?.classList.contains("error")).toBe(true);
	});

	it("auto-dismisses by removing the node, so the text does not linger", () => {
		showToast("invite code: SECRET");
		expect(document.body.textContent).toContain("SECRET");
		vi.advanceTimersByTime(4000);
		expect(items()).toHaveLength(0);
		expect(document.body.textContent).not.toContain("SECRET");
	});

	it("repeats the same message once and restarts its timer", () => {
		showToast("Failed to list sessions", true);
		vi.advanceTimersByTime(3000);
		showToast("Failed to list sessions", true);
		expect(items()).toHaveLength(1);
		vi.advanceTimersByTime(3000);
		expect(items()).toHaveLength(1);
		vi.advanceTimersByTime(1000);
		expect(items()).toHaveLength(0);
	});

	it("keeps at most MAX_VISIBLE items, dropping the oldest", () => {
		for (let i = 0; i < MAX_VISIBLE + 2; i++) showToast(`m${i}`);
		expect(items().map((i) => i.textContent)).toEqual(
			Array.from({ length: MAX_VISIBLE }, (_, i) => `m${i + 2}`),
		);
	});

	it("copy success is short and green", () => {
		showCopySuccessToast();
		expect(items()[0]?.classList.contains("success")).toBe(true);
		vi.advanceTimersByTime(1200);
		expect(items()).toHaveLength(0);
	});

	it("an action button runs its handler and dismisses the item", () => {
		const run = vi.fn();
		showToastEx({ message: "Offline", kind: "error", action: { label: "Retry", run } });
		(document.querySelector(".toast-action") as HTMLButtonElement).click();
		expect(run).toHaveBeenCalledTimes(1);
		expect(items()).toHaveLength(0);
	});

	it("does nothing without a #toast container", () => {
		document.body.innerHTML = "";
		expect(() => showToast("x")).not.toThrow();
	});
});
