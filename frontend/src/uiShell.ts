/**
 * uiShell.ts — the interface is fixed (`data-shell="v2"` in index.html);
 * these readers go away with the v1 code that still branches on them.
 */

export type UiShell = "v1" | "v2";

export function currentShell(): UiShell {
	return document.documentElement.dataset.shell === "v1" ? "v1" : "v2";
}
