/**
 * d1Limits.ts — the limits Cloudflare D1 applies to a statement that the
 * SQLite the tests run on does not (https://developers.cloudflare.com/d1/platform/limits/):
 *
 *   - terms in one compound SELECT (UNION / UNION ALL / INTERSECT / EXCEPT): 5
 *     (SQLite's default is 500 — migration 29 once had 10 and D1 refused it
 *     with `too many terms in compound SELECT`, code 7500, at boot);
 *   - bound parameters per statement: 100;
 *   - arguments of one SQL function call: 32;
 *   - statement size: 100 KB.
 *
 * `d1LimitViolations` reads the SQL text the way the D1 API receives it. The
 * SQLite harnesses of the tests answer a statement that breaks one of these
 * limits with D1's own error, so every statement the suites send (migrations,
 * routes) is held to D1's limits, not SQLite's. It is a lexical check, not a
 * parser: strings, quoted identifiers and comments are skipped, and each
 * parenthesised group (and each `;`-separated statement of a trigger body)
 * counts its own compound terms and its own arguments.
 */

export const D1_MAX_COMPOUND_TERMS = 5;
export const D1_MAX_BOUND_PARAMS = 100;
export const D1_MAX_FUNCTION_ARGS = 32;
export const D1_MAX_STATEMENT_BYTES = 100_000;

// A `(` right after one of these opens a list, not a function call.
const NOT_CALLS = new Set([
	"VALUES",
	"IN",
	"EXISTS",
	"AS",
	"ON",
	"USING",
	"KEY",
	"CHECK",
	"OVER",
	"FILTER",
]);

interface Group {
	call: string | null;
	terms: number;
	args: number;
	empty: boolean;
}

export function d1LimitViolations(sql: string, paramCount = 0): string[] {
	const out: string[] = [];
	const bytes = Buffer.byteLength(sql, "utf8");
	if (bytes > D1_MAX_STATEMENT_BYTES)
		out.push(`statement is ${bytes} bytes (> ${D1_MAX_STATEMENT_BYTES})`);
	let params = paramCount;
	let numbered = 0;
	const stack: Group[] = [{ call: null, terms: 1, args: 0, empty: true }];
	const close = (g: Group) => {
		if (g.terms > D1_MAX_COMPOUND_TERMS)
			out.push(`compound SELECT with ${g.terms} terms (> ${D1_MAX_COMPOUND_TERMS})`);
		const args = g.empty ? 0 : g.args + 1;
		if (g.call && args > D1_MAX_FUNCTION_ARGS)
			out.push(`${g.call}() with ${args} arguments (> ${D1_MAX_FUNCTION_ARGS})`);
	};
	let i = 0;
	let bare = 0;
	while (i < sql.length) {
		const c = sql[i];
		const top = stack[stack.length - 1];
		if (c === "'" || c === '"' || c === "`") {
			const end = sql.indexOf(c, i + 1);
			i = end < 0 ? sql.length : end + 1;
			// A doubled quote is an escaped one: the scan resumes in the same literal.
			while (sql[i] === c) {
				const next = sql.indexOf(c, i + 1);
				i = next < 0 ? sql.length : next + 1;
			}
			top.empty = false;
			continue;
		}
		if (c === "-" && sql[i + 1] === "-") {
			const end = sql.indexOf("\n", i);
			i = end < 0 ? sql.length : end + 1;
			continue;
		}
		if (c === "/" && sql[i + 1] === "*") {
			const end = sql.indexOf("*/", i + 2);
			i = end < 0 ? sql.length : end + 2;
			continue;
		}
		if (/[A-Za-z_]/.test(c)) {
			let j = i + 1;
			while (j < sql.length && /\w/.test(sql[j])) j++;
			const word = sql.slice(i, j);
			const up = word.toUpperCase();
			if (up === "UNION" || up === "INTERSECT" || up === "EXCEPT") top.terms++;
			top.empty = false;
			i = j;
			// A call is a name written against its `(`, as the codebase writes them.
			if (sql[i] === "(" && !NOT_CALLS.has(up)) {
				stack.push({ call: word, terms: 1, args: 0, empty: true });
				i++;
			}
			continue;
		}
		if (c === "?") {
			let j = i + 1;
			while (j < sql.length && /\d/.test(sql[j])) j++;
			if (j > i + 1) numbered = Math.max(numbered, Number(sql.slice(i + 1, j)));
			else bare++;
			top.empty = false;
			i = j;
			continue;
		}
		if (c === "(") stack.push({ call: null, terms: 1, args: 0, empty: true });
		else if (c === ")") {
			if (stack.length > 1) close(stack.pop() as Group);
			stack[stack.length - 1].empty = false;
		} else if (c === ",") top.args++;
		else if (c === ";") {
			// The next statement of a trigger body counts on its own.
			close(top);
			top.terms = 1;
			top.args = 0;
			top.empty = true;
		} else if (!/\s/.test(c)) top.empty = false;
		i++;
	}
	while (stack.length) close(stack.pop() as Group);
	params = Math.max(params, numbered, bare);
	if (params > D1_MAX_BOUND_PARAMS)
		out.push(`${params} bound parameters (> ${D1_MAX_BOUND_PARAMS})`);
	return out;
}
