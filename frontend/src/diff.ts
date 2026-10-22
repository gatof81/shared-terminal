/**
 * diff.ts — unified-diff parser for the Git Changes view. Pure: text in,
 * rows out; rendering is gitView.ts's job (via textContent only).
 *
 * Linear in the input: one pass, one regex per line, no backtracking —
 * it runs on the UI thread and the input is whatever git produced for a
 * file the user (or a hostile repo) put in the tree.
 */

export type DiffRowKind = "meta" | "hunk" | "context" | "add" | "del" | "note";

export interface DiffRow {
	kind: DiffRowKind;
	/** Line number in the old file (context/del), else null. */
	oldNo: number | null;
	/** Line number in the new file (context/add), else null. */
	newNo: number | null;
	/** Line text without the leading marker character. */
	text: string;
}

export interface ParsedDiff {
	rows: DiffRow[];
	additions: number;
	deletions: number;
	/** True when at least one `@@` hunk was seen. */
	hasHunks: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedDiff(patch: string): ParsedDiff {
	const rows: DiffRow[] = [];
	let additions = 0;
	let deletions = 0;
	let hasHunks = false;
	let oldNo = 0;
	let newNo = 0;
	let inHunk = false;

	const lines = patch.endsWith("\n") ? patch.slice(0, -1).split("\n") : patch.split("\n");
	if (patch === "") return { rows, additions, deletions, hasHunks };
	for (const line of lines) {
		const hunk = HUNK_RE.exec(line);
		if (hunk) {
			hasHunks = true;
			inHunk = true;
			oldNo = Number.parseInt(hunk[1] as string, 10);
			newNo = Number.parseInt(hunk[2] as string, 10);
			rows.push({ kind: "hunk", oldNo: null, newNo: null, text: line });
			continue;
		}
		if (!inHunk) {
			// Everything before the first hunk (and between files): the
			// `diff --git`, `index`, `---`/`+++`, mode / rename / binary lines.
			rows.push({ kind: "meta", oldNo: null, newNo: null, text: line });
			continue;
		}
		const c = line[0];
		if (c === "+") {
			additions++;
			rows.push({ kind: "add", oldNo: null, newNo: newNo++, text: line.slice(1) });
		} else if (c === "-") {
			deletions++;
			rows.push({ kind: "del", oldNo: oldNo++, newNo: null, text: line.slice(1) });
		} else if (c === " ") {
			rows.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
		} else if (c === "\\") {
			// "\ No newline at end of file"
			rows.push({ kind: "note", oldNo: null, newNo: null, text: line.slice(2) });
		} else if (line.startsWith("diff ")) {
			// Next file in a multi-file patch (renames can produce one).
			inHunk = false;
			rows.push({ kind: "meta", oldNo: null, newNo: null, text: line });
		} else {
			// An empty context line git emitted without its leading space
			// (seen with some whitespace settings), or anything unexpected:
			// keep it visible as context so nothing is silently dropped.
			rows.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text: line });
		}
	}
	return { rows, additions, deletions, hasHunks };
}
