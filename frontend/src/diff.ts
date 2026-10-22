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

// `@@ -1,4 +1,5 @@` (one parent) or, for a conflicted file, git's
// combined format `@@@ -1,4 -1,3 +1,8 @@@` (one `-range` per parent; the
// number of `@` is parents + 1). Group 1 = the `@` run, 2 = first old
// start, 3 = any further old ranges, 4 = new start.
const HUNK_RE = /^(@@+) -(\d+)(?:,\d+)?((?: -\d+(?:,\d+)?)*) \+(\d+)(?:,\d+)? @@+/;

export function parseUnifiedDiff(patch: string): ParsedDiff {
	const rows: DiffRow[] = [];
	let additions = 0;
	let deletions = 0;
	let hasHunks = false;
	let oldNo = 0;
	let newNo = 0;
	let inHunk = false;
	let parents = 1;

	const lines = patch.endsWith("\n") ? patch.slice(0, -1).split("\n") : patch.split("\n");
	if (patch === "") return { rows, additions, deletions, hasHunks };
	for (const line of lines) {
		const hunk = HUNK_RE.exec(line);
		if (hunk) {
			hasHunks = true;
			inHunk = true;
			parents = Math.max(1, (hunk[1] as string).length - 1);
			oldNo = Number.parseInt(hunk[2] as string, 10);
			newNo = Number.parseInt(hunk[4] as string, 10);
			rows.push({ kind: "hunk", oldNo: null, newNo: null, text: line });
			continue;
		}
		if (!inHunk) {
			// Everything before the first hunk (and between files): the
			// `diff --git`, `index`, `---`/`+++`, mode / rename / binary lines.
			rows.push({ kind: "meta", oldNo: null, newNo: null, text: line });
			continue;
		}
		if (parents > 1 && !line.startsWith("\\") && !line.startsWith("diff ")) {
			// Combined diff: one marker column per parent. A `-` in any
			// column means the line is not in the result (removed from
			// that parent); otherwise `+` means it is in the result but
			// not in that parent. Line numbers follow the FIRST parent
			// (HEAD, "ours") and the result (the working tree).
			const marks = line.slice(0, parents);
			if (marks.length === parents && /^[ +-]+$/.test(marks)) {
				const removed = marks.includes("-");
				const added = !removed && marks.includes("+");
				const inOld = removed ? marks[0] === "-" : marks[0] === " ";
				if (removed) deletions++;
				else if (added) additions++;
				rows.push({
					kind: removed ? "del" : added ? "add" : "context",
					oldNo: inOld ? oldNo++ : null,
					newNo: removed ? null : newNo++,
					text: line.slice(parents),
				});
			} else {
				rows.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text: line });
			}
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
