/**
 * actionMenu.ts — a menu of actions opened from a "⋯" button (UI
 * unification, PR 4). Built on the dialog component, so it inherits the
 * stack, the focus trap, Escape and the focus return to the button that
 * opened it; items are real buttons with `role="menuitem"`, a disabled
 * item keeps its reason visible underneath instead of vanishing.
 *
 * By default it renders as the same card the Insert (+) menu uses (centred
 * on desktop, a sheet on mobile). With `anchor` it opens as a dropdown under
 * that element instead (the project selector): the mention menu's surface,
 * a transparent backdrop that closes it, Tab out closes it too — same
 * dialog behaviour underneath (stack, trap, Escape, focus return).
 */

import { createDialog } from "./dialog.js";

export interface MenuItem {
	id: string;
	label: string;
	hint?: string;
	kind?: "primary" | "normal" | "danger";
	enabled?: boolean;
	reason?: string;
	/** A line above this item (a new group of the menu). */
	sepBefore?: boolean;
	/** A choice among the items marked `radio` (`menuitemradio`, ✓ when checked). */
	radio?: { checked: boolean };
	/** Shown before the label and at the row's end (the project selector's dot and pill). */
	leading?: Node;
	trailing?: Node;
	/** Anchored menus: the items that scroll (consecutive ones), the rest stay put. */
	scroll?: boolean;
	/** The item's accessible name when the row shows more than its label (it starts with it). */
	ariaLabel?: string;
}

export interface ActionMenuOptions {
	title: string;
	items: MenuItem[];
	opener?: Element | null;
	/**
	 * Open as a dropdown under this element (a header the opener sits in),
	 * as wide as it minus 16 px (240–320 px); on a phone, under the app's
	 * header across the screen. The opener gets `aria-expanded` meanwhile.
	 */
	anchor?: HTMLElement;
	/** Anchored menus: a small caption above the items (the menu's name for a screen reader). */
	caption?: string;
	/** Runs after the menu closed with the chosen item (never for a dismissal). */
	onPick: (id: string) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

let seq = 0;

export function openActionMenu(opts: ActionMenuOptions): void {
	const id = `action-menu-${++seq}`;
	const anchored = opts.anchor !== undefined;
	const root = el("div", `modal${anchored ? " modal-anchored" : ""}`);
	root.setAttribute("aria-hidden", "true");
	const backdrop = el("div", "modal-backdrop");
	backdrop.setAttribute("data-close-modal", "");
	root.appendChild(backdrop);
	const card = el(
		"div",
		anchored
			? "modal-card action-menu action-menu-anchored"
			: "modal-card actions-menu-card action-menu",
	);
	card.setAttribute("role", "menu");
	card.setAttribute("aria-labelledby", `${id}-title`);
	if (anchored) {
		// No × and no heading bar: a dropdown. Its caption names it.
		const cap = el("div", "action-menu-caption", opts.caption ?? opts.title);
		cap.id = `${id}-title`;
		card.appendChild(cap);
	} else {
		const header = el("div", "modal-header");
		const h2 = el("h2", undefined, opts.title);
		h2.id = `${id}-title`;
		header.appendChild(h2);
		const close = el("button", "modal-close", "×");
		close.type = "button";
		close.setAttribute("aria-label", "Close");
		close.setAttribute("data-close-modal", "");
		header.appendChild(close);
		card.appendChild(header);
	}

	let picked: string | null = null;
	let scroller: HTMLElement | null = null;
	for (const item of opts.items) {
		if (item.sepBefore) {
			const sep = el("div", "action-menu-sep");
			sep.setAttribute("role", "separator");
			card.appendChild(sep);
		}
		const b = el("button", `actions-menu-item kind-${item.kind ?? "normal"}`);
		b.type = "button";
		b.setAttribute("role", item.radio ? "menuitemradio" : "menuitem");
		if (item.radio) b.setAttribute("aria-checked", String(item.radio.checked));
		b.dataset.action = item.id;
		if (item.ariaLabel) b.setAttribute("aria-label", item.ariaLabel);
		if (item.radio) {
			const mark = el("span", "action-menu-check", item.radio.checked ? "✓" : "");
			mark.setAttribute("aria-hidden", "true");
			b.appendChild(mark);
		}
		if (item.leading) b.appendChild(item.leading);
		b.appendChild(el("span", "actions-menu-item-title", item.label));
		const enabled = item.enabled !== false;
		if (!enabled) {
			b.disabled = true;
			b.setAttribute("aria-disabled", "true");
		}
		const hint = !enabled && item.reason ? item.reason : item.hint;
		if (hint) b.appendChild(el("span", "actions-menu-item-hint", hint));
		if (item.trailing) b.appendChild(item.trailing);
		b.addEventListener("click", () => {
			if (!enabled) return;
			picked = item.id;
			dialog.close();
		});
		if (anchored && item.scroll) {
			if (!scroller) {
				scroller = el("div", "action-menu-scroll");
				// A group of the menu, for the separators' and arrows' sake.
				scroller.setAttribute("role", "none");
				card.appendChild(scroller);
			}
			scroller.appendChild(b);
		} else {
			scroller = null;
			card.appendChild(b);
		}
	}
	root.appendChild(card);
	document.body.appendChild(root);

	const ITEMS = "[role=menuitem]:not(:disabled), [role=menuitemradio]:not(:disabled)";
	// ↑ / ↓ between items, as a menu does; Tab out of a dropdown closes it.
	card.addEventListener("keydown", (e) => {
		if (anchored && e.key === "Tab") {
			e.preventDefault();
			dialog.close();
			return;
		}
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		const items = [...card.querySelectorAll<HTMLButtonElement>(ITEMS)];
		if (items.length === 0) return;
		const i = items.indexOf(document.activeElement as HTMLButtonElement);
		const next =
			e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
		items[next]?.focus();
		e.preventDefault();
	});

	const anchor = opts.anchor;
	const expands = opts.opener instanceof HTMLElement ? opts.opener : null;
	const place = (): void => {
		if (anchor) placeAnchored(card, anchor);
	};
	const vv = typeof window !== "undefined" ? window.visualViewport : null;
	const dialog = createDialog(root, {
		initialFocus: () =>
			card.querySelector<HTMLElement>('[role=menuitemradio][aria-checked="true"]:not(:disabled)') ??
			card.querySelector<HTMLElement>(ITEMS),
		onClose: () => {
			window.removeEventListener("resize", place);
			vv?.removeEventListener("resize", place);
			if (anchor) expands?.setAttribute("aria-expanded", "false");
			root.remove();
			if (picked !== null) opts.onPick(picked);
		},
	});
	if (anchor) {
		place();
		window.addEventListener("resize", place);
		vv?.addEventListener("resize", place);
		expands?.setAttribute("aria-expanded", "true");
	}
	dialog.open(opts.opener ?? document.activeElement);
}

const PHONE = "(max-width: 768px)";

/**
 * Wide: 4 px under the anchor's box, from its left edge, its width minus
 * 16 px within 240–320 px, at most min(60vh, 420px) tall. Phone: right
 * under the app's header, 8 px from each side, as tall as the visual
 * viewport leaves (the soft keyboard included) minus 16 px.
 */
function placeAnchored(card: HTMLElement, anchor: HTMLElement): void {
	const s = card.style;
	if (window.matchMedia?.(PHONE).matches) {
		const header = document.querySelector("header")?.getBoundingClientRect();
		const top = header ? header.bottom : anchor.getBoundingClientRect().bottom;
		const vh = window.visualViewport?.height ?? window.innerHeight;
		s.top = `${Math.round(top)}px`;
		s.left = "8px";
		s.right = "8px";
		s.width = "auto";
		s.maxHeight = `${Math.max(120, Math.round(vh - top - 16))}px`;
		return;
	}
	const box = anchor.getBoundingClientRect();
	s.top = `${Math.round(box.bottom + 4)}px`;
	s.left = `${Math.round(box.left + 8)}px`;
	s.width = `${Math.round(Math.min(320, Math.max(240, box.width - 16)))}px`;
	s.maxHeight = "min(60vh, 420px)";
}
