import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	alertDialog,
	closeTopDialog,
	confirmDialog,
	createDialog,
	escapeHandledByDialog,
	isAnyDialogOpen,
	promptDialog,
} from "./dialog.js";

function modal(id: string, ...controls: string[]): HTMLElement {
	const root = document.createElement("div");
	root.id = id;
	root.className = "modal";
	root.setAttribute("aria-hidden", "true");
	const backdrop = document.createElement("div");
	backdrop.className = "modal-backdrop";
	backdrop.setAttribute("data-close-modal", "");
	root.appendChild(backdrop);
	const card = document.createElement("div");
	card.className = "modal-card";
	card.setAttribute("role", "dialog");
	for (const c of controls) {
		const b = document.createElement("button");
		b.type = "button";
		b.id = c;
		b.textContent = c;
		card.appendChild(b);
	}
	const x = document.createElement("button");
	x.className = "modal-close";
	x.setAttribute("data-close-modal", "");
	x.id = `${id}-x`;
	card.appendChild(x);
	root.appendChild(card);
	document.body.appendChild(root);
	return root;
}

function key(k: string, init: KeyboardEventInit = {}): void {
	document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init }));
}

beforeEach(() => {
	while (closeTopDialog()) {
		/* drain */
	}
	document.body.innerHTML = `
		<div id="auth-view"></div>
		<div id="app-view"><button id="opener">open</button><button id="other">other</button></div>
		<div id="toast"></div>`;
});

describe("createDialog", () => {
	it("opens: .open + aria-hidden, app roots inert, focus inside; closes: restores all", () => {
		const root = modal("m1", "a", "b");
		const d = createDialog(root);
		const opener = document.getElementById("opener") as HTMLButtonElement;
		opener.focus();
		d.open(opener);
		expect(d.isOpen()).toBe(true);
		expect(isAnyDialogOpen()).toBe(true);
		expect(root.classList.contains("open")).toBe(true);
		expect(root.getAttribute("aria-hidden")).toBe("false");
		expect(document.getElementById("app-view")?.hasAttribute("inert")).toBe(true);
		expect(document.getElementById("auth-view")?.hasAttribute("inert")).toBe(true);
		expect(document.activeElement?.id).toBe("a");
		d.close();
		expect(d.isOpen()).toBe(false);
		expect(root.classList.contains("open")).toBe(false);
		expect(root.getAttribute("aria-hidden")).toBe("true");
		expect(document.getElementById("app-view")?.hasAttribute("inert")).toBe(false);
		expect(document.activeElement).toBe(opener);
	});

	it("open twice is a no-op; close when closed is a no-op", () => {
		const d = createDialog(modal("m1", "a"));
		const onClose = vi.fn();
		const d2 = createDialog(modal("m2", "z"), { onClose });
		d.open();
		d.open();
		d2.close();
		expect(onClose).not.toHaveBeenCalled();
		d.close();
		d.close();
		expect(isAnyDialogOpen()).toBe(false);
	});

	it("initialFocus wins over the first control", () => {
		const root = modal("m1", "a", "b");
		const d = createDialog(root, { initialFocus: () => document.getElementById("b") });
		d.open();
		expect(document.activeElement?.id).toBe("b");
		d.close();
	});

	it("falls back to the previously focused element when the opener is hidden on close", () => {
		const root = modal("m1", "a");
		const d = createDialog(root);
		const other = document.getElementById("other") as HTMLButtonElement;
		const opener = document.getElementById("opener") as HTMLButtonElement;
		other.focus();
		d.open(opener);
		opener.hidden = true;
		d.close();
		expect(document.activeElement).toBe(other);
	});

	it("Escape closes the topmost dialog only; onClose runs on every path", () => {
		const onClose1 = vi.fn();
		const onClose2 = vi.fn();
		const d1 = createDialog(modal("m1", "a"), { onClose: onClose1 });
		const d2 = createDialog(modal("m2", "b"), { onClose: onClose2 });
		d1.open();
		d2.open();
		expect(document.getElementById("m1")?.hasAttribute("inert")).toBe(true);
		key("Escape");
		expect(d2.isOpen()).toBe(false);
		expect(d1.isOpen()).toBe(true);
		expect(onClose2).toHaveBeenCalledTimes(1);
		expect(onClose1).not.toHaveBeenCalled();
		expect(document.getElementById("m1")?.hasAttribute("inert")).toBe(false);
		expect(document.activeElement?.id).toBe("a");
		key("Escape");
		expect(d1.isOpen()).toBe(false);
		expect(onClose1).toHaveBeenCalledTimes(1);
	});

	it("closeOnEscape: false keeps the dialog open on Escape", () => {
		const d = createDialog(modal("m1", "a"), { closeOnEscape: false });
		d.open();
		key("Escape");
		expect(d.isOpen()).toBe(true);
		d.close();
	});

	it("closing a nested dialog returns focus to its opener inside the parent", () => {
		const d1 = createDialog(modal("m1", "a", "b"));
		const d2 = createDialog(modal("m2", "c"));
		d1.open();
		const b = document.getElementById("b") as HTMLButtonElement;
		b.focus();
		d2.open(b);
		expect(document.activeElement?.id).toBe("c");
		d2.close();
		expect(document.activeElement).toBe(b);
		d1.close();
	});

	it("closing a parent cascades to the dialogs opened above it", () => {
		const order: string[] = [];
		const d1 = createDialog(modal("m1", "a"), { onClose: () => order.push("1") });
		const d2 = createDialog(modal("m2", "b"), { onClose: () => order.push("2") });
		const d3 = createDialog(modal("m3", "c"), { onClose: () => order.push("3") });
		d1.open();
		d2.open();
		d3.open();
		d1.close();
		expect(order).toEqual(["3", "2", "1"]);
		expect(isAnyDialogOpen()).toBe(false);
	});

	it("[data-close-modal] (backdrop, ×) closes; clicks elsewhere don't", () => {
		const root = modal("m1", "a");
		const d = createDialog(root);
		d.open();
		(document.getElementById("a") as HTMLElement).click();
		expect(d.isOpen()).toBe(true);
		(root.querySelector(".modal-backdrop") as HTMLElement).click();
		expect(d.isOpen()).toBe(false);
		d.open();
		(document.getElementById("m1-x") as HTMLElement).click();
		expect(d.isOpen()).toBe(false);
	});

	it("Tab wraps inside the topmost dialog", () => {
		const d = createDialog(modal("m1", "a", "b"));
		d.open();
		(document.getElementById("m1-x") as HTMLElement).focus();
		key("Tab");
		expect(document.activeElement?.id).toBe("a");
		key("Tab", { shiftKey: true });
		expect(document.activeElement?.id).toBe("m1-x");
		d.close();
	});

	it("focus landing outside is pulled back into the dialog", () => {
		const d = createDialog(modal("m1", "a"));
		d.open();
		const other = document.getElementById("other") as HTMLButtonElement;
		other.focus();
		other.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		expect(document.activeElement?.id).toBe("a");
		d.close();
	});
});

describe("confirmDialog", () => {
	it("resolves true on confirm and removes itself", async () => {
		const p = confirmDialog({ title: "Sure?", message: "Really.", confirmLabel: "Yes" });
		const btn = document.querySelector<HTMLButtonElement>(".modal-primary-action")!;
		expect(btn.textContent).toBe("Yes");
		expect(document.activeElement).toBe(btn);
		btn.closest("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
		await expect(p).resolves.toBe(true);
		expect(document.querySelector(".dialog-card")).toBeNull();
	});

	it("resolves false on Escape; danger starts on Cancel and is an alertdialog", async () => {
		const p = confirmDialog({ title: "Delete?", danger: true });
		expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
		expect(document.activeElement?.className).toBe("dialog-cancel");
		key("Escape");
		await expect(p).resolves.toBe(false);
	});

	it("requireText gates the confirm button on the exact name", async () => {
		const p = confirmDialog({ title: "Wipe", requireText: { expected: "my-project" } });
		const input = document.querySelector<HTMLInputElement>(".dialog-require input")!;
		const btn = document.querySelector<HTMLButtonElement>(".modal-danger-action")!;
		expect(document.activeElement).toBe(input);
		expect(btn.disabled).toBe(true);
		input.value = "my-proj";
		input.dispatchEvent(new Event("input"));
		expect(btn.disabled).toBe(true);
		const form = btn.closest("form")!;
		form.dispatchEvent(new Event("submit", { cancelable: true }));
		expect(isAnyDialogOpen()).toBe(true);
		input.value = " my-project ";
		input.dispatchEvent(new Event("input"));
		expect(btn.disabled).toBe(false);
		form.dispatchEvent(new Event("submit", { cancelable: true }));
		await expect(p).resolves.toBe(true);
	});
});

describe("promptDialog", () => {
	it("resolves the trimmed value, validates inline, null on cancel", async () => {
		const p = promptDialog({
			title: "Path",
			validate: (v) => (v.startsWith("/") ? "Relative paths only" : null),
		});
		const input = document.querySelector<HTMLInputElement>(".dialog-card input")!;
		expect(document.activeElement).toBe(input);
		const form = input.closest("form")!;
		input.value = "/abs";
		form.dispatchEvent(new Event("submit", { cancelable: true }));
		expect(document.querySelector<HTMLElement>(".modal-field-error")?.hidden).toBe(false);
		expect(isAnyDialogOpen()).toBe(true);
		input.value = "  dist/report.pdf ";
		input.dispatchEvent(new Event("input"));
		form.dispatchEvent(new Event("submit", { cancelable: true }));
		await expect(p).resolves.toBe("dist/report.pdf");

		const p2 = promptDialog({ title: "Path" });
		(document.querySelector(".dialog-cancel") as HTMLElement).click();
		await expect(p2).resolves.toBeNull();
	});
});

describe("alertDialog", () => {
	it("has no Cancel, resolves on OK, and keeps multi-line text as paragraphs", async () => {
		const p = alertDialog({ title: "Invite code", message: "Copy now:\n\nABC-123" });
		expect(document.querySelector(".dialog-cancel")).toBeNull();
		expect(
			[...document.querySelectorAll(".dialog-body .modal-hint")].map((x) => x.textContent),
		).toEqual(["Copy now:", "ABC-123"]);
		const btn = document.querySelector<HTMLButtonElement>(".modal-primary-action")!;
		btn.closest("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
		await expect(p).resolves.toBeUndefined();
	});
});

// Regression (PR #496 review): one Escape must close exactly one layer.
// The drawer below stands in for main.ts's mobile sidebar handler: the
// same guard, registered on document AFTER the dialog's listener, as in
// the app (main.ts imports dialog.ts before adding its own handler).
describe("Escape closes one layer at a time", () => {
	function mobileDrawer(): { open: boolean; dispose: () => void } {
		const drawer = { open: true, dispose: () => {} };
		const handler = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			if (escapeHandledByDialog(e)) return;
			if (drawer.open) drawer.open = false;
		};
		document.addEventListener("keydown", handler);
		drawer.dispose = () => document.removeEventListener("keydown", handler);
		return drawer;
	}

	it("dialog + mobile drawer open: first Escape closes the dialog only, second the drawer", () => {
		const drawer = mobileDrawer();
		try {
			const d = createDialog(modal("m1", "a"));
			d.open();
			key("Escape");
			expect(d.isOpen()).toBe(false);
			expect(drawer.open).toBe(true);
			key("Escape");
			expect(drawer.open).toBe(false);
		} finally {
			drawer.dispose();
		}
	});

	it("nested dialogs over the drawer close one per Escape, then the drawer", () => {
		const drawer = mobileDrawer();
		try {
			const d1 = createDialog(modal("m1", "a"));
			const d2 = createDialog(modal("m2", "b"));
			d1.open();
			d2.open();
			key("Escape");
			expect([d2.isOpen(), d1.isOpen(), drawer.open]).toEqual([false, true, true]);
			key("Escape");
			expect([d2.isOpen(), d1.isOpen(), drawer.open]).toEqual([false, false, true]);
			key("Escape");
			expect(drawer.open).toBe(false);
		} finally {
			drawer.dispose();
		}
	});

	it("the guard holds whichever order the listeners were registered in", () => {
		// A listener registered BEFORE dialog.ts's (runs first, sees the
		// dialog still open) and one registered AFTER (runs after the
		// close, sees the consumed event): neither may act.
		const seen: string[] = [];
		const before = (e: KeyboardEvent) => {
			if (e.key === "Escape" && !escapeHandledByDialog(e)) seen.push("before");
		};
		// Capture phase runs before every bubble listener on document.
		document.addEventListener("keydown", before, true);
		const drawer = mobileDrawer();
		try {
			const d = createDialog(modal("m1", "a"));
			d.open();
			key("Escape");
			expect(d.isOpen()).toBe(false);
			expect(seen).toEqual([]);
			expect(drawer.open).toBe(true);
		} finally {
			document.removeEventListener("keydown", before, true);
			drawer.dispose();
		}
	});

	it("with no dialog open, Escape and other keys reach the page untouched", () => {
		const drawer = mobileDrawer();
		const received: string[] = [];
		const page = (e: KeyboardEvent) => received.push(`${e.key}:${e.defaultPrevented}`);
		document.addEventListener("keydown", page);
		try {
			key("a");
			key("Tab");
			expect(received).toEqual(["a:false", "Tab:false"]);
			key("Escape");
			expect(received[2]).toBe("Escape:false");
			expect(drawer.open).toBe(false);
		} finally {
			document.removeEventListener("keydown", page);
			drawer.dispose();
		}
	});

	it("the actions-style menu (a dialog) behaves the same: Escape closes only the menu", () => {
		const drawer = mobileDrawer();
		try {
			const opener = document.getElementById("opener") as HTMLButtonElement;
			const menu = createDialog(modal("actions-menu", "paste", "attach"), {
				initialFocus: () => document.getElementById("paste"),
				onClose: () => opener.setAttribute("aria-expanded", "false"),
			});
			opener.setAttribute("aria-expanded", "true");
			menu.open(opener);
			expect(document.activeElement?.id).toBe("paste");
			key("Escape");
			expect(menu.isOpen()).toBe(false);
			expect(opener.getAttribute("aria-expanded")).toBe("false");
			expect(document.activeElement).toBe(opener);
			expect(drawer.open).toBe(true);
		} finally {
			drawer.dispose();
		}
	});
});
