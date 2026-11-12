/**
 * diffTable.ts — the unified-diff rows as DOM (textContent only), shared by
 * the Git Changes view and the project conversation's attached diffs.
 */

import { type DiffRow, lineNumberDigits } from "./diff.js";
import { el } from "./ui.js";

// Past this many rendered rows the diff pane stops: it's a browser pane,
// not an IDE, and the server already caps the patch bytes.
export const MAX_DIFF_ROWS = 5000;

/** The rows, capped at MAX_DIFF_ROWS on every path that renders them. */
export function appendDiffRows(scroller: HTMLElement, rows: readonly DiffRow[]): void {
	if (rows.length === 0) return;
	scroller.appendChild(diffTable(rows.slice(0, MAX_DIFF_ROWS)));
	if (rows.length > MAX_DIFF_ROWS) {
		scroller.appendChild(
			el("div", "files-tree-note", `Showing the first ${MAX_DIFF_ROWS} lines of this diff.`),
		);
	}
}

function diffTable(rows: readonly DiffRow[]): HTMLElement {
	const table = el("div", "git-diff-table");
	table.style.setProperty("--no-w", `${lineNumberDigits(rows)}ch`);
	const frag = document.createDocumentFragment();
	for (const r of rows) {
		const row = el("div", `git-diff-row kind-${r.kind}`);
		if (r.kind === "hunk" || r.kind === "meta" || r.kind === "note") {
			const cell = el("span", "git-diff-span", r.text);
			row.appendChild(cell);
		} else {
			row.appendChild(el("span", "git-diff-no", r.oldNo === null ? "" : String(r.oldNo)));
			row.appendChild(el("span", "git-diff-no", r.newNo === null ? "" : String(r.newNo)));
			row.appendChild(
				el("span", "git-diff-mark", r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "),
			);
			row.appendChild(el("span", "git-diff-text", r.text));
		}
		frag.appendChild(row);
	}
	table.appendChild(frag);
	return table;
}
