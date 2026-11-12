/**
 * clipboard.ts — copying text for the Chat and Files views.
 */

/**
 * Clipboard API, falling back to a hidden textarea (older or non-secure
 * contexts, or a browser that refuses the API).
 *
 * The fallback must never move the reader (owner report 2026-11-12:
 * "Copy report" lost the place in the conversation). Focusing a field is
 * what browsers scroll for — and on iOS Safari what pans the visual
 * viewport, which main.ts's --app-top then follows with the whole app. So
 * the textarea sits pinned inside the visible area (top-left, 1 px,
 * 16 px font: no zoom-on-focus), is focused with `preventScroll`, selected
 * with setSelectionRange (iOS ignores select() on a readonly field), and
 * focus goes back to where it was, again without scrolling. As a last
 * guard, every scroll container that moved anyway is put back.
 */
export async function copyText(text: string, origin?: Element | null): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return copyWithTextarea(text, origin);
	}
}

/** The scroll positions of every scrollable ancestor of `from` (and the page). */
function scrollPositions(from: Element | null): Array<[Element, number, number]> {
	const out: Array<[Element, number, number]> = [];
	for (let n = from; n; n = n.parentElement)
		if (n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth)
			out.push([n, n.scrollTop, n.scrollLeft]);
	const doc = document.scrollingElement;
	if (doc && !out.some(([e]) => e === doc)) out.push([doc, doc.scrollTop, doc.scrollLeft]);
	return out;
}

/**
 * `origin`: the control that asked for the copy. Its scroll containers are
 * the ones to keep — iOS Safari doesn't focus a tapped button, so the
 * focused element alone can't say where the reader is.
 */
export function copyWithTextarea(text: string, origin?: Element | null): boolean {
	const active =
		document.activeElement instanceof HTMLElement && document.activeElement !== document.body
			? document.activeElement
			: null;
	const positions = scrollPositions(origin ?? active ?? document.body);
	const ta = document.createElement("textarea");
	ta.value = text;
	ta.setAttribute("readonly", "");
	ta.setAttribute("aria-hidden", "true");
	ta.tabIndex = -1;
	Object.assign(ta.style, {
		position: "fixed",
		top: "0",
		left: "0",
		width: "1px",
		height: "1px",
		padding: "0",
		border: "0",
		opacity: "0",
		fontSize: "16px",
		pointerEvents: "none",
	});
	document.body.appendChild(ta);
	let ok = false;
	try {
		ta.focus({ preventScroll: true });
		ta.setSelectionRange(0, text.length);
		ok = document.execCommand("copy");
	} catch {
		ok = false;
	} finally {
		ta.remove();
		active?.focus({ preventScroll: true });
		for (const [el, top, left] of positions)
			if (el.scrollTop !== top || el.scrollLeft !== left) {
				el.scrollTop = top;
				el.scrollLeft = left;
			}
	}
	return ok;
}
