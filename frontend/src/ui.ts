/**
 * ui.ts — tiny DOM builders shared by the overlay views (Files, Git).
 * Everything goes through textContent — no innerHTML anywhere downstream.
 */

export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

export function button(
	label: string,
	className: string,
	onClick: () => void,
	title?: string,
): HTMLButtonElement {
	const b = el("button", className, label);
	b.type = "button";
	if (title) {
		b.title = title;
		b.setAttribute("aria-label", title);
	}
	b.addEventListener("click", onClick);
	return b;
}

/** A centred status panel: loading spinner, empty hint, error or info. */
export function stateBox(
	kind: "loading" | "empty" | "error" | "info",
	message: string,
	...actions: HTMLElement[]
): HTMLElement {
	const box = el("div", `files-state files-state-${kind}`);
	box.setAttribute("role", kind === "error" ? "alert" : "status");
	box.appendChild(el("p", undefined, message));
	for (const a of actions) box.appendChild(a);
	return box;
}
