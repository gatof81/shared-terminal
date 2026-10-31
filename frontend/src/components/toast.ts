/**
 * toast.ts — notifications (UI unification, PR 2).
 *
 * The single `#toast` element used to hold one message at a time: a
 * second message overwrote the first mid-read (the 5 s session poll could
 * do that on every tick during an outage), and nothing announced it to
 * assistive tech. Now `#toast` is a live region holding a short stack of
 * items; a repeated message refreshes its own timer instead of stacking,
 * an error is an alert, and a dismissed item is REMOVED — not just hidden
 * — so a one-time secret in a message (a freshly minted invite code, #49)
 * stays readable only for as long as it is visible.
 */

import "./toast.css";

export type ToastKind = "info" | "error" | "success";

export interface ToastOptions {
	message: string;
	kind?: ToastKind;
	/** Milliseconds before the item dismisses itself. */
	durationMs?: number;
	/** Optional action button (e.g. "Retry"); activating it dismisses the item. */
	action?: { label: string; run: () => void };
}

const DEFAULT_MS = 4000;
const COPY_MS = 1200;
/** Items visible at once; the oldest goes when a newer one would exceed it. */
export const MAX_VISIBLE = 4;

interface Item {
	el: HTMLElement;
	timer: ReturnType<typeof setTimeout>;
}

const items = new Map<string, Item>();

function container(): HTMLElement | null {
	const c = document.getElementById("toast");
	if (!c) return null;
	if (!c.hasAttribute("aria-live")) {
		c.setAttribute("aria-live", "polite");
		c.setAttribute("aria-relevant", "additions");
	}
	return c;
}

function keyOf(kind: ToastKind, message: string): string {
	return `${kind}\u0000${message}`;
}

function dismiss(key: string): void {
	const item = items.get(key);
	if (!item) return;
	clearTimeout(item.timer);
	items.delete(key);
	// Removal, not a hidden class: the text must not linger in the DOM.
	item.el.remove();
}

export function showToastEx(opts: ToastOptions): void {
	const c = container();
	if (!c) return;
	const kind = opts.kind ?? "info";
	const ms = opts.durationMs ?? DEFAULT_MS;
	const key = keyOf(kind, opts.message);
	const existing = items.get(key);
	if (existing) {
		// Same message again: keep the one item, restart its clock.
		clearTimeout(existing.timer);
		existing.timer = setTimeout(() => dismiss(key), ms);
		return;
	}
	const node = document.createElement("div");
	node.className = `toast-item ${kind}`;
	// An error interrupts (assertive); the rest ride the polite region.
	node.setAttribute("role", kind === "error" ? "alert" : "status");
	const text = document.createElement("span");
	text.className = "toast-text";
	text.textContent = opts.message;
	node.appendChild(text);
	if (opts.action) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "toast-action";
		btn.textContent = opts.action.label;
		const run = opts.action.run;
		btn.addEventListener("click", () => {
			dismiss(key);
			run();
		});
		node.appendChild(btn);
	}
	c.appendChild(node);
	items.set(key, { el: node, timer: setTimeout(() => dismiss(key), ms) });
	while (items.size > MAX_VISIBLE) {
		const oldest = items.keys().next().value;
		if (oldest === undefined) break;
		dismiss(oldest);
	}
}

/** The app-wide notification. `isError` keeps the historical call shape. */
export function showToast(message: string, isError = false): void {
	showToastEx({ message, kind: isError ? "error" : "info" });
}

/**
 * Brief success chip for the copy-on-select path. Short on purpose: the
 * auto-copy fires on every finalised selection, and a 4 s toast across
 * several selections would feel like spam; it also must not occlude a
 * real error that follows it.
 */
export function showCopySuccessToast(): void {
	showToastEx({ message: "✓ Copied", kind: "success", durationMs: COPY_MS });
}

/** Test seam: drop every item immediately. */
export function clearToasts(): void {
	for (const key of [...items.keys()]) dismiss(key);
}
