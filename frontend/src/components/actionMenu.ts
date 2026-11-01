/**
 * actionMenu.ts — a menu of actions opened from a "⋯" button (UI
 * unification, PR 4). Built on the dialog component, so it inherits the
 * stack, the focus trap, Escape and the focus return to the button that
 * opened it; items are real buttons with `role="menuitem"`, a disabled
 * item keeps its reason visible underneath instead of vanishing.
 *
 * Today it renders as the same card the Insert (+) menu uses (centred on
 * desktop, a sheet on mobile); anchoring it next to its button is a
 * later polish and changes nothing here.
 */

import { createDialog } from "./dialog.js";

export interface MenuItem {
	id: string;
	label: string;
	hint?: string;
	kind?: "primary" | "normal" | "danger";
	enabled?: boolean;
	reason?: string;
}

export interface ActionMenuOptions {
	title: string;
	items: MenuItem[];
	opener?: Element | null;
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
	const root = el("div", "modal");
	root.setAttribute("aria-hidden", "true");
	const backdrop = el("div", "modal-backdrop");
	backdrop.setAttribute("data-close-modal", "");
	root.appendChild(backdrop);
	const card = el("div", "modal-card actions-menu-card action-menu");
	card.setAttribute("role", "menu");
	card.setAttribute("aria-labelledby", `${id}-title`);
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

	let picked: string | null = null;
	for (const item of opts.items) {
		const b = el("button", `actions-menu-item kind-${item.kind ?? "normal"}`);
		b.type = "button";
		b.setAttribute("role", "menuitem");
		b.dataset.action = item.id;
		b.appendChild(el("span", "actions-menu-item-title", item.label));
		const enabled = item.enabled !== false;
		if (!enabled) {
			b.disabled = true;
			b.setAttribute("aria-disabled", "true");
		}
		const hint = !enabled && item.reason ? item.reason : item.hint;
		if (hint) b.appendChild(el("span", "actions-menu-item-hint", hint));
		b.addEventListener("click", () => {
			if (!enabled) return;
			picked = item.id;
			dialog.close();
		});
		card.appendChild(b);
	}
	root.appendChild(card);
	document.body.appendChild(root);

	// ↑ / ↓ between items, as a menu does.
	card.addEventListener("keydown", (e) => {
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		const items = [...card.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)")];
		if (items.length === 0) return;
		const i = items.indexOf(document.activeElement as HTMLButtonElement);
		const next =
			e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
		items[next]?.focus();
		e.preventDefault();
	});

	const dialog = createDialog(root, {
		initialFocus: () => card.querySelector<HTMLElement>("[role=menuitem]:not(:disabled)"),
		onClose: () => {
			root.remove();
			if (picked !== null) opts.onPick(picked);
		},
	});
	dialog.open(opts.opener ?? document.activeElement);
}
