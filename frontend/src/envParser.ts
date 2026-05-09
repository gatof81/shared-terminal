/**
 * envParser.ts — bulk-paste `.env` parser for #186's Env tab.
 *
 * Scope (per the issue spec):
 * - `KEY=value` — literal value to end of line.
 * - `KEY="value"` / `KEY='value'` — quoted value, both quote chars.
 * - `# comments` — full-line comments (any leading whitespace).
 * - blank lines — ignored.
 *
 * Out of scope:
 * - **Multi-line values.** A line whose value opens a quote but
 *   doesn't close on the same line is logged as a parse failure;
 *   continuation lines are not concatenated. Multi-line values would
 *   surface ambiguous newline handling that no `.env` consumer agrees
 *   on, and the issue spec explicitly defers them.
 * - **Variable interpolation** (`KEY=$OTHER` / `${OTHER}`). The user
 *   pastes raw values; the modal stores them as-is.
 * - **Escape sequences inside quoted values** (e.g. `\n`, `\t`).
 *   We treat the contents of a quoted value as opaque — Docker's
 *   `Env` field doesn't process escapes either.
 *
 * Returns parsed entries plus a per-line skip log so the modal can
 * surface "Imported 14 lines, skipped 2 (line 7: missing closing
 * quote, line 12: invalid name)". Skipped lines never silently drop
 * — the user gets a visible count and a reason for each.
 */

export interface ParsedEnvLine {
	name: string;
	value: string;
}

export interface EnvParseResult {
	parsed: ParsedEnvLine[];
	skipped: Array<{ line: number; reason: string }>;
}

// Same POSIX-name regex the backend's Zod schema enforces. Catching
// it client-side too means the user gets immediate feedback for an
// obviously-bad name in the paste rather than a 400 on submit.
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export function parseDotEnv(text: string): EnvParseResult {
	const parsed: ParsedEnvLine[] = [];
	const skipped: EnvParseResult["skipped"] = [];

	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const lineNo = i + 1;
		const raw = lines[i] ?? "";
		const trimmed = raw.trim();

		// Blank or comment — silently skip, not an error.
		if (trimmed === "" || trimmed.startsWith("#")) continue;

		// Optional leading `export ` so `export FOO=bar` (a common
		// `.env` shell-import idiom) parses the same as `FOO=bar`.
		const stripped = trimmed.startsWith("export ") ? trimmed.slice("export ".length) : trimmed;

		const eqIdx = stripped.indexOf("=");
		if (eqIdx <= 0) {
			// No `=` at all, or `=` at position 0 (no name). Either is
			// malformed; record + skip.
			skipped.push({
				line: lineNo,
				reason: "missing '=' separator (or empty name)",
			});
			continue;
		}

		const name = stripped.slice(0, eqIdx).trim();
		const rawValue = stripped.slice(eqIdx + 1);

		if (!ENV_NAME_PATTERN.test(name)) {
			// Truncate the name in the skip-reason so a 50 KB
			// "garbage paste" line doesn't blow out the modal's
			// status bar with one unreadable string. textContent
			// is the rendering path so there's no injection risk;
			// this is purely visual hygiene (#211 round 2).
			const displayName = name.length > 40 ? `${name.slice(0, 40)}…` : name;
			skipped.push({
				line: lineNo,
				reason: `name '${displayName}' must match ${ENV_NAME_PATTERN.source}`,
			});
			continue;
		}

		// Strip surrounding `"..."` or `'...'` if both quotes are
		// present on the same line. A leading quote with no matching
		// trailing quote is a multi-line value attempt — out of scope.
		const value = stripQuotes(rawValue, lineNo, skipped);
		if (value === null) continue;

		parsed.push({ name, value });
	}

	return { parsed, skipped };
}

/**
 * Returns the dequoted value, or `null` if the line is malformed
 * (logged into `skipped`). Trailing comments after a quoted value
 * (`KEY="x" # comment`) are tolerated; trailing comments after an
 * unquoted value would be ambiguous (the literal `#` could be part
 * of a URL fragment or shell-shifted token), so we DON'T strip them
 * — the user pasted something with a literal `#` and we believe
 * them.
 */
function stripQuotes(
	rawValue: string,
	lineNo: number,
	skipped: EnvParseResult["skipped"],
): string | null {
	const trimmed = rawValue.trim();
	if (trimmed.length === 0) return "";
	const firstCh = trimmed[0];
	if (firstCh !== '"' && firstCh !== "'") {
		// Unquoted — return verbatim (with leading/trailing whitespace
		// trimmed, matching Docker's own Env handling).
		return trimmed;
	}
	// Quoted: find the closing quote of the same kind. Scan ONE
	// character at a time; a line-internal escape sequence is opaque
	// to us (we treat the bytes as literal). The matching close must
	// be on the same line — otherwise it's a multi-line value attempt.
	const closeIdx = trimmed.indexOf(firstCh, 1);
	if (closeIdx === -1) {
		skipped.push({
			line: lineNo,
			reason: `unterminated ${firstCh === '"' ? "double" : "single"}-quote (multi-line values not supported)`,
		});
		return null;
	}
	// Validate the tail after `closeIdx`: anything that's whitespace
	// (often before a `# trailing comment`) or a `#` directly is fine
	// — those are tolerated as comment-or-whitespace tails. Anything
	// else implies the `closeIdx` we found was actually an embedded
	// quote in the middle of the value (e.g. `MSG='it's alive'`),
	// which `indexOf` greedily matches before the real close. The
	// module's "no silent drops" guarantee says we must skip + log,
	// not return a truncated value (#211 round 1).
	const tail = trimmed.slice(closeIdx + 1).trimStart();
	if (tail !== "" && !tail.startsWith("#")) {
		skipped.push({
			line: lineNo,
			reason: `embedded ${firstCh === '"' ? "double" : "single"}-quote in value (use the other quote char or remove the quote)`,
		});
		return null;
	}
	return trimmed.slice(1, closeIdx);
}
