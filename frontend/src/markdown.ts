/**
 * markdown.ts — read-only Markdown preview for the Workspace Explorer.
 *
 * SAFETY MODEL: safe by construction, not by sanitising. The renderer
 * builds DOM nodes with createElement + textContent and never assigns
 * innerHTML/outerHTML or parses HTML, so nothing in the source can become
 * markup. Raw HTML in a .md file renders as literal text. The only
 * attribute carrying file-controlled data that the browser acts on is
 * `<a href>`, and that goes through `classifyHref`'s scheme allowlist.
 * Images are rendered as placeholders — the page CSP blocks remote
 * images anyway, and fetching workspace-relative ones is a follow-up.
 *
 * Why hand-rolled instead of marked/markdown-it + DOMPurify: the frontend
 * deliberately carries almost no dependencies (xterm only), and a
 * sanitiser-based pipeline is only as safe as the sanitiser's latest
 * bypass. The trade-off is coverage: this handles the CommonMark/GFM
 * subset READMEs and agent-written docs actually use (headings, lists
 * incl. nesting + task items, fences, quotes, tables, emphasis, links),
 * not every CommonMark edge case. Anything it doesn't understand degrades
 * to plain text, never to markup.
 */

import { highlightCode, languageForFence } from "./highlight.js";

export interface MarkdownOptions {
	/** Called for workspace-relative links (`./docs/setup.md`). */
	onRelativeLink?: (href: string) => void;
}

export type HrefKind =
	| { kind: "external"; href: string }
	| { kind: "anchor"; slug: string }
	| { kind: "relative"; href: string }
	| { kind: "blocked" };

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * Decide what a link target is allowed to become. Control characters and
 * whitespace are stripped BEFORE the scheme check because browsers ignore
 * them when parsing a URL — `java\tscript:` and ` javascript:` are both
 * live javascript: URLs to the browser.
 */
export function classifyHref(raw: string): HrefKind {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars IS the point
	const href = raw.replace(/[\u0000-\u0020\u007f]+/g, "");
	if (href === "") return { kind: "blocked" };
	if (href.startsWith("#")) return { kind: "anchor", slug: slugify(decodeSafe(href.slice(1))) };
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href);
	if (scheme) {
		return SAFE_SCHEMES.has(`${(scheme[1] as string).toLowerCase()}:`)
			? { kind: "external", href }
			: { kind: "blocked" };
	}
	// Protocol-relative `//host/x` would navigate off-site with whatever
	// scheme the app runs on — treat it as external only if it's http(s).
	if (href.startsWith("//")) return { kind: "external", href: `https:${href}` };
	return { kind: "relative", href };
}

function decodeSafe(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/** GitHub-style heading slug, used for in-document `#anchor` links. */
export function slugify(text: string): string {
	return text
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.replace(/\s/g, "-");
}

// ── Inline ──────────────────────────────────────────────────────────────────

// Every element the renderer creates goes through `el`, which is what
// makes this cap complete: block structures (table rows/cells, list
// items, quotes) count exactly like inline ones, so no construct can
// multiply small input into unbounded DOM without hitting it. A real
// 256 KiB document creates ~5k elements; past the cap the document falls
// back to plain text.
const MAX_ELEMENTS = 50_000;
let docElements = 0;

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	if (docBudget !== null && ++docElements > MAX_ELEMENTS) {
		throw new MarkdownBudgetError("too many elements");
	}
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

/**
 * `parent.append(...nodes)` passes every node as a call argument, which
 * throws RangeError (stack overflow) past ~100k nodes — reachable with a
 * few hundred KB of adversarial emphasis. Append one at a time.
 */
function appendAll(parent: Node, nodes: Node[]): void {
	for (const n of nodes) parent.appendChild(n);
}

const ESCAPABLE = "\\`*_{}[]()#+-.!|~<>\"'";

// ── Complexity budget ───────────────────────────────────────────────────────
// The preview renders synchronously on the UI thread that also drives the
// terminal, so the renderer must be (near-)linear in its input whatever the
// input is. The inline parser is built for that (one indexing pre-pass per
// inline run, no rescans per delimiter); this budget is the backstop for
// anything that still misbehaves: every unit of parsing work spends from
// it, and exhausting it aborts the render — renderMarkdown then shows the
// file as plain text. Generous enough that real documents never hit it.
class MarkdownBudgetError extends Error {}

interface Budget {
	left: number;
}

function spend(budget: Budget, n: number): void {
	budget.left -= n;
	if (budget.left < 0) throw new MarkdownBudgetError("markdown too complex");
}

// Link text and emphasis recurse; past this depth the remaining source
// renders as literal text. Bounds both stack depth and the re-indexing
// cost of nested runs (each level indexes its own slice once).
const MAX_INLINE_DEPTH = 8;

interface InlineCtx {
	opts: MarkdownOptions;
	budget: Budget;
	depth: number;
}

/**
 * Everything renderInline needs to find a closing delimiter, computed in
 * linear passes up front so no opener ever rescans the rest of the text
 * (which made unmatched `[`, `*`, `_` quadratic).
 */
interface InlineIndex {
	/** For a `[` at i: index of its matching `]`, else -1. */
	bracketClose: Int32Array;
	/** For a `(` at i: index of its matching `)`, else -1. */
	parenClose: Int32Array;
	/** For the first backtick of a run at i: index just past the closing
	 *  run of the same length (CommonMark), else -1. */
	codeEnd: Int32Array;
	/** Candidate closer positions per delimiter, ascending. */
	closers: Map<string, number[]>;
}

function isEscapeAt(src: string, i: number): boolean {
	return src[i] === "\\" && i + 1 < src.length && ESCAPABLE.includes(src[i + 1] as string);
}

function buildIndex(src: string, budget: Budget): InlineIndex {
	const n = src.length;
	spend(budget, n * 3);
	const bracketClose = new Int32Array(n).fill(-1);
	const parenClose = new Int32Array(n).fill(-1);
	const codeEnd = new Int32Array(n).fill(-1);

	// Pass 1: backtick runs, then pair each with the next run of the same
	// length (binary search per run → O(n log n)). Spans don't nest.
	const runs: { start: number; len: number }[] = [];
	for (let i = 0; i < n; i++) {
		if (isEscapeAt(src, i)) {
			i++;
			continue;
		}
		if (src[i] === "`") {
			let len = 1;
			while (src[i + len] === "`") len++;
			runs.push({ start: i, len });
			i += len - 1;
		}
	}
	const runsByLen = new Map<number, number[]>();
	runs.forEach((r, k) => {
		const list = runsByLen.get(r.len);
		if (list) list.push(k);
		else runsByLen.set(r.len, [k]);
	});
	const inCode = new Uint8Array(n);
	for (let k = 0; k < runs.length; ) {
		const r = runs[k] as { start: number; len: number };
		const list = runsByLen.get(r.len) as number[];
		const m = firstGreater(list, k);
		if (m === -1) {
			k++;
			continue;
		}
		const close = runs[m] as { start: number; len: number };
		const end = close.start + close.len;
		codeEnd[r.start] = end;
		inCode.fill(1, r.start, end);
		k = m + 1;
	}

	// Pass 2: brackets / parens (stack-matched) and emphasis-closer
	// candidates, skipping escapes and code spans.
	const bracketStack: number[] = [];
	const parenStack: number[] = [];
	const closers = new Map<string, number[]>([
		["*", []],
		["**", []],
		["_", []],
		["__", []],
		["~~", []],
	]);
	const add = (key: string, pos: number) => (closers.get(key) as number[]).push(pos);
	for (let i = 0; i < n; i++) {
		if (inCode[i]) continue;
		if (isEscapeAt(src, i)) {
			i++;
			continue;
		}
		const c = src[i] as string;
		if (c === "[") bracketStack.push(i);
		else if (c === "]") {
			const open = bracketStack.pop();
			if (open !== undefined) bracketClose[open] = i;
		} else if (c === "(") parenStack.push(i);
		else if (c === ")") {
			const open = parenStack.pop();
			if (open !== undefined) parenClose[open] = i;
		} else if (c === "*" || c === "_" || c === "~") {
			let len = 1;
			while (src[i + len] === c) len++;
			const prev = src[i - 1];
			// A closer must follow non-whitespace (a "right-flanking" run).
			if (prev !== undefined && !/\s/.test(prev)) {
				const nextAfter = src[i + len] ?? "";
				// `_` doesn't close intraword (snake_case_names).
				const intraword = c === "_" && /[\p{L}\p{N}]/u.test(nextAfter);
				if (!intraword) {
					if (c === "~") {
						if (len >= 2) add("~~", i);
					} else {
						if (len === 1) add(c, i);
						if (len >= 2) add(c + c, i);
						// `***x***`: the trailing `*` of a triple can close `*`.
						if (len >= 3) add(c, i + 2);
					}
				}
			}
			i += len - 1;
		}
	}
	return { bracketClose, parenClose, codeEnd, closers };
}

/** First element of ascending `list` strictly greater than `x`, or -1. */
function firstGreater(list: number[], x: number): number {
	let lo = 0;
	let hi = list.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if ((list[mid] as number) > x) hi = mid;
		else lo = mid + 1;
	}
	return lo < list.length ? (list[lo] as number) : -1;
}

/** Parses `(url "title")` at `start` using the precomputed paren match;
 *  returns url + end index (exclusive). */
function parseLinkTarget(
	src: string,
	start: number,
	index: InlineIndex,
): { url: string; end: number } | null {
	if (src[start] !== "(") return null;
	const close = index.parenClose[start] ?? -1;
	if (close === -1) return null;
	const inner = src.slice(start + 1, close).trim();
	// Drop an optional "title" / 'title'; strip <angle> wrapping.
	const m = /^(<[^>]*>|\S+)(?:\s+(?:"[^"]*"|'[^']*'))?$/.exec(inner);
	let url = m ? (m[1] as string) : inner;
	if (url.startsWith("<") && url.endsWith(">")) url = url.slice(1, -1);
	return { url, end: close + 1 };
}

function renderLink(text: Node[], rawHref: string, opts: MarkdownOptions): Node {
	const target = classifyHref(rawHref);
	if (target.kind === "blocked") {
		// Keep the visible text; drop the dangerous target entirely.
		const span = el("span", "md-link-blocked");
		span.title = "Link blocked (unsupported URL scheme)";
		appendAll(span, text);
		return span;
	}
	const a = el("a");
	appendAll(a, text);
	if (target.kind === "external") {
		a.href = target.href;
		a.target = "_blank";
		// noopener: no window.opener handle back into the app.
		// noreferrer: don't leak the app URL (which carries a session id).
		a.rel = "noopener noreferrer nofollow";
	} else if (target.kind === "anchor") {
		// Never let a fragment reach location.hash — the app's deep-link
		// router (#/sessions/<id>) owns it. Scroll within the preview.
		a.href = "#";
		a.addEventListener("click", (e) => {
			e.preventDefault();
			const root = a.closest(".md-root");
			const heading = [...(root?.querySelectorAll<HTMLElement>("[data-slug]") ?? [])].find(
				(h) => h.dataset.slug === target.slug,
			);
			heading?.scrollIntoView({ block: "start" });
		});
	} else {
		a.href = "#";
		a.title = target.href;
		a.addEventListener("click", (e) => {
			e.preventDefault();
			opts.onRelativeLink?.(target.href);
		});
	}
	return a;
}

const BARE_URL = /https?:\/\/[^\s<>]*[^\s<>.,:;"')\]!?*_~]/y;
const AUTOLINK = /<((?:https?:\/\/|mailto:)[^\s<>]+)>/y;

/** Inline Markdown → DOM nodes. Exported for tests. */
export function renderInline(src: string, opts: MarkdownOptions = {}): Node[] {
	return withDocBudget(src, () => inline(src, opts));
}

// Work budget + element count for the render in progress (null / 0
// outside one). Module-level because rendering is synchronous and every
// block function would otherwise need them threaded through.
let docBudget: Budget | null = null;

/** Run `fn` with a fresh document budget unless one is already active. */
function withDocBudget<T>(src: string, fn: () => T): T {
	if (docBudget !== null) return fn();
	docBudget = { left: inlineBudgetFor(src) };
	docElements = 0;
	try {
		return fn();
	} finally {
		docBudget = null;
		docElements = 0;
	}
}

/** Inline render from block context: spends from the document budget. */
function inline(src: string, opts: MarkdownOptions): Node[] {
	return renderInlineCtx(src, {
		opts,
		budget: docBudget ?? { left: inlineBudgetFor(src) },
		depth: 0,
	});
}

function inlineBudgetFor(src: string): number {
	return 100 * src.length + 200_000;
}

function renderInlineCtx(src: string, ctx: InlineCtx): Node[] {
	if (ctx.depth > MAX_INLINE_DEPTH) return [document.createTextNode(src)];
	// Fast path: nothing that could start inline markup → one text node,
	// no index. Most link texts / emphasis bodies / table cells hit this.
	if (!/[\\`*_~[<\n]/.test(src) && !src.includes("http")) {
		spend(ctx.budget, src.length);
		return src ? [document.createTextNode(src)] : [];
	}
	const { opts } = ctx;
	const index = buildIndex(src, ctx.budget);
	const nested = (slice: string) => renderInlineCtx(slice, { ...ctx, depth: ctx.depth + 1 });
	const out: Node[] = [];
	let text = "";
	const flush = () => {
		if (text) out.push(document.createTextNode(text));
		text = "";
	};
	const push = (node: Node) => {
		flush();
		out.push(node);
	};

	let i = 0;
	while (i < src.length) {
		spend(ctx.budget, 1);
		const c = src[i] as string;
		const prev = i > 0 ? (src[i - 1] as string) : "";

		if (c === "\\" && i + 1 < src.length) {
			const next = src[i + 1] as string;
			if (next === "\n") {
				push(el("br"));
				i += 2;
				continue;
			}
			if (ESCAPABLE.includes(next)) {
				text += next;
				i += 2;
				continue;
			}
		}

		if (c === "\n") {
			// Two trailing spaces before a newline = hard break.
			if (text.endsWith("  ")) {
				text = text.replace(/ +$/, "");
				push(el("br"));
			} else {
				text += " ";
			}
			i++;
			continue;
		}

		if (c === "`") {
			let run = 1;
			while (src[i + run] === "`") run++;
			const end = index.codeEnd[i] ?? -1;
			if (end !== -1) {
				const code = src.slice(i + run, end - run).replace(/\n/g, " ");
				const trimmed =
					code.length > 2 && code.startsWith(" ") && code.endsWith(" ") ? code.slice(1, -1) : code;
				push(el("code", "md-code", trimmed));
				i = end;
				continue;
			}
			text += "`".repeat(run);
			i += run;
			continue;
		}

		if (c === "!" && src[i + 1] === "[") {
			const close = index.bracketClose[i + 1] ?? -1;
			const target = close !== -1 ? parseLinkTarget(src, close + 1, index) : null;
			if (target) {
				const alt = src.slice(i + 2, close);
				const ph = el("span", "md-image", `🖼 ${alt || "image"}`);
				ph.title = target.url;
				push(ph);
				i = target.end;
				continue;
			}
		}

		if (c === "[") {
			const close = index.bracketClose[i] ?? -1;
			const target = close !== -1 ? parseLinkTarget(src, close + 1, index) : null;
			if (target) {
				push(renderLink(nested(src.slice(i + 1, close)), target.url, opts));
				i = target.end;
				continue;
			}
		}

		if (c === "<") {
			AUTOLINK.lastIndex = i;
			const m = AUTOLINK.exec(src);
			if (m) {
				const url = m[1] as string;
				push(renderLink([document.createTextNode(url)], url, opts));
				i += m[0].length;
				continue;
			}
		}

		if (c === "h" && !/[\p{L}\p{N}]/u.test(prev)) {
			BARE_URL.lastIndex = i;
			const m = BARE_URL.exec(src);
			if (m) {
				spend(ctx.budget, m[0].length);
				push(renderLink([document.createTextNode(m[0])], m[0], opts));
				i += m[0].length;
				continue;
			}
		}

		if (c === "*" || c === "_" || c === "~") {
			// `_` only opens emphasis at a word boundary so snake_case_names
			// stay intact (GFM's intraword rule); `~` only as `~~`.
			const double = src[i + 1] === c;
			const opens =
				(c !== "_" || !/[\p{L}\p{N}]/u.test(prev)) &&
				(c !== "~" || double) &&
				// An opener must be followed by non-whitespace.
				!/\s/.test(src[i + (double ? 2 : 1)] ?? " ");
			if (opens) {
				const delim = double ? c + c : c;
				const contentStart = i + delim.length;
				// First candidate strictly after contentStart → non-empty.
				const close = firstGreater(index.closers.get(delim) as number[], contentStart);
				if (close !== -1) {
					const node = el(c === "~" ? "del" : double ? "strong" : "em");
					appendAll(node, nested(src.slice(contentStart, close)));
					push(node);
					i = close + delim.length;
					continue;
				}
			}
		}

		text += c;
		i++;
	}
	flush();
	return out;
}

// ── Blocks ──────────────────────────────────────────────────────────────────

const BULLET = /^( *)([-*+])[ \t]+(.*)$/;
const ORDERED = /^( *)(\d{1,9})([.)])[ \t]+(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const SETEXT = /^ {0,3}(=+|-+)\s*$/;

// Fence / heading / rule / table-separator detection is hand-written
// rather than regex: the obvious regexes for these (`\s*([^`\s]*)[^`]*$`,
// `\s*:?-+:?\s*(\|…)*\|?\s*$`) backtrack quadratically on a long line of
// spaces, which a 1 MiB file can contain. These are single linear scans.

/** Up to 3 leading spaces (CommonMark block indentation). */
function blockIndent(line: string): number {
	let p = 0;
	while (p < 3 && line[p] === " ") p++;
	return p;
}

function parseFenceOpen(
	line: string,
): { indent: number; ch: string; len: number; info: string } | null {
	const p = blockIndent(line);
	const ch = line[p];
	if (ch !== "`" && ch !== "~") return null;
	let len = 0;
	while (line[p + len] === ch) len++;
	if (len < 3) return null;
	const info = line.slice(p + len);
	// A backtick fence's info string can't contain backticks (else it's
	// an inline code span, not a fence).
	if (ch === "`" && info.includes("`")) return null;
	return { indent: p, ch, len, info: info.trim() };
}

function isFenceClose(line: string, ch: string, minLen: number): boolean {
	const p = blockIndent(line);
	let len = 0;
	while (line[p + len] === ch) len++;
	return len >= minLen && line.slice(p + len).trim() === "";
}

function parseHeading(line: string): { level: number; text: string } | null {
	const p = blockIndent(line);
	let level = 0;
	while (line[p + level] === "#") level++;
	if (level < 1 || level > 6) return null;
	const after = line[p + level];
	if (after !== undefined && after !== " " && after !== "\t") return null;
	let text = line.slice(p + level).trim();
	// Optional closing `#`s, only when preceded by whitespace (`# C#` keeps its #).
	let e = text.length;
	while (e > 0 && text[e - 1] === "#") e--;
	if (e === 0) text = "";
	else if (e < text.length && (text[e - 1] === " " || text[e - 1] === "\t"))
		text = text.slice(0, e).trimEnd();
	return { level, text };
}

function isHr(line: string): boolean {
	const p = blockIndent(line);
	const ch = line[p];
	if (ch !== "-" && ch !== "*" && ch !== "_") return false;
	let count = 0;
	for (let i = p; i < line.length; i++) {
		const c = line[i];
		if (c === ch) count++;
		else if (c !== " " && c !== "\t") return false;
	}
	return count >= 3;
}

function isTableSep(line: string): boolean {
	let t = line.trim();
	if (!t.includes("-")) return false;
	if (t.startsWith("|")) t = t.slice(1);
	if (t.endsWith("|")) t = t.slice(0, -1);
	return t.split("|").every((cell) => /^:?-+:?$/.test(cell.trim()));
}

function isBlank(line: string): boolean {
	return line.trim() === "";
}

function splitTableRow(line: string): string[] {
	let s = line.trim();
	if (s.startsWith("|")) s = s.slice(1);
	if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
	const cells: string[] = [];
	let cur = "";
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === "\\" && s[i + 1] === "|") {
			cur += "|";
			i++;
		} else if (c === "|") {
			cells.push(cur.trim());
			cur = "";
		} else {
			cur += c;
		}
	}
	cells.push(cur.trim());
	return cells;
}

/** True when `line` would start a block that interrupts a paragraph. */
function startsBlock(line: string): boolean {
	return (
		parseFenceOpen(line) !== null ||
		parseHeading(line) !== null ||
		isHr(line) ||
		QUOTE.test(line) ||
		BULLET.test(line) ||
		/^ {0,3}1[.)][ \t]+/.test(line)
	);
}

// Bounded so a pathological file (thousands of nested `>`) can't blow the
// stack; past this depth content renders as plain paragraphs.
const MAX_NESTING = 12;

// Wider "tables" render as paragraphs: nothing real has 65+ columns, and
// the header width multiplies into every row's layout.
const MAX_TABLE_COLUMNS = 64;

function renderBlocks(lines: string[], opts: MarkdownOptions, depth: number, into: Node): void {
	let i = 0;
	while (i < lines.length) {
		if (docBudget) spend(docBudget, 1);
		const line = lines[i] as string;
		if (isBlank(line)) {
			i++;
			continue;
		}

		const fence = parseFenceOpen(line);
		if (fence) {
			const body: string[] = [];
			i++;
			while (i < lines.length) {
				const l = lines[i] as string;
				if (isFenceClose(l, fence.ch, fence.len)) {
					i++;
					break;
				}
				// Strip up to the fence's own indentation from content lines.
				let strip = 0;
				while (strip < fence.indent && l[strip] === " ") strip++;
				body.push(l.slice(strip));
				i++;
			}
			into.appendChild(renderCodeBlock(body.join("\n"), fence.info));
			continue;
		}

		const heading = parseHeading(line);
		if (heading) {
			into.appendChild(renderHeading(heading.level, heading.text, opts));
			i++;
			continue;
		}

		if (isHr(line)) {
			into.appendChild(el("hr"));
			i++;
			continue;
		}

		if (QUOTE.test(line) && depth < MAX_NESTING) {
			const inner: string[] = [];
			while (i < lines.length && !isBlank(lines[i] as string)) {
				const m = QUOTE.exec(lines[i] as string);
				// Lazy continuation: a non-`>` line continues the quote's paragraph.
				inner.push(m ? (m[1] as string) : (lines[i] as string));
				i++;
			}
			const bq = el("blockquote");
			renderBlocks(inner, opts, depth + 1, bq);
			into.appendChild(bq);
			continue;
		}

		if ((BULLET.test(line) || ORDERED.test(line)) && depth < MAX_NESTING) {
			i = renderList(lines, i, opts, depth, into);
			continue;
		}

		if (/^( {4}|\t)/.test(line)) {
			const body: string[] = [];
			while (
				i < lines.length &&
				(/^( {4}|\t)/.test(lines[i] as string) || isBlank(lines[i] as string))
			) {
				body.push((lines[i] as string).replace(/^( {4}|\t)/, ""));
				i++;
			}
			while (body.length > 0 && isBlank(body[body.length - 1] as string)) body.pop();
			into.appendChild(renderCodeBlock(body.join("\n"), ""));
			continue;
		}

		const next = lines[i + 1];
		if (
			line.includes("|") &&
			next !== undefined &&
			isTableSep(next) &&
			splitTableRow(line).length <= MAX_TABLE_COLUMNS
		) {
			i = renderTable(lines, i, opts, into);
			continue;
		}

		// Paragraph (possibly a setext heading).
		const para: string[] = [line.trim()];
		i++;
		let setextLevel = 0;
		while (i < lines.length) {
			const l = lines[i] as string;
			if (isBlank(l)) break;
			const setext = SETEXT.exec(l);
			if (setext) {
				setextLevel = (setext[1] as string).startsWith("=") ? 1 : 2;
				i++;
				break;
			}
			if (startsBlock(l)) break;
			para.push(l.replace(/^\s+/, ""));
			i++;
		}
		if (setextLevel > 0) {
			into.appendChild(renderHeading(setextLevel, para.join(" "), opts));
		} else {
			const p = el("p");
			appendAll(p, inline(para.join("\n"), opts));
			into.appendChild(p);
		}
	}
}

function renderHeading(level: number, text: string, opts: MarkdownOptions): HTMLElement {
	const h = document.createElement(`h${level}`);
	appendAll(h, inline(text, opts));
	h.dataset.slug = slugify(h.textContent ?? "");
	return h;
}

function renderCodeBlock(code: string, fenceInfo: string): HTMLElement {
	const pre = el("pre", "md-pre");
	const codeEl = el("code");
	codeEl.appendChild(highlightCode(code, languageForFence(fenceInfo)));
	pre.appendChild(codeEl);
	return pre;
}

function renderList(
	lines: string[],
	start: number,
	opts: MarkdownOptions,
	depth: number,
	into: Node,
): number {
	const first = lines[start] as string;
	const ordered = ORDERED.exec(first);
	const baseIndent = (
		ordered ? (ordered[1] as string) : ((BULLET.exec(first) as RegExpExecArray)[1] as string)
	).length;
	const list = ordered ? el("ol") : el("ul");
	if (ordered && ordered[2] !== "1") (list as HTMLOListElement).start = Number(ordered[2]);
	let i = start;
	let sawBlankBetweenItems = false;
	// `offset` = column where the item's content starts (`- ` → 2,
	// `10. ` → 4); continuation lines are dedented by it so a nested
	// list keeps its indentation RELATIVE to its parent item.
	const items: { li: HTMLLIElement; body: string[]; offset: number }[] = [];

	while (i < lines.length) {
		const line = lines[i] as string;
		const m = ordered ? ORDERED.exec(line) : BULLET.exec(line);
		const indent = m ? (m[1] as string).length : -1;
		if (m && indent === baseIndent) {
			const content = (ordered ? m[4] : m[3]) as string;
			const li = el("li");
			items.push({ li, body: [content], offset: m[0].length - content.length });
			i++;
			continue;
		}
		if (items.length === 0) break;
		const cur = items[items.length - 1] as (typeof items)[number];
		if (isBlank(line)) {
			// A blank line only continues the list if more indented content
			// or another sibling item follows.
			const after = lines[i + 1];
			if (after === undefined) break;
			const sibling = ordered ? ORDERED.exec(after) : BULLET.exec(after);
			const contIndent = /^ */.exec(after)?.[0].length ?? 0;
			if ((sibling && (sibling[1] as string).length === baseIndent) || contIndent > baseIndent) {
				cur.body.push("");
				sawBlankBetweenItems = true;
				i++;
				continue;
			}
			break;
		}
		const lineIndent = /^ */.exec(line)?.[0].length ?? 0;
		if (lineIndent > baseIndent) {
			cur.body.push(line.slice(Math.min(lineIndent, cur.offset)));
			i++;
			continue;
		}
		if (!startsBlock(line) && cur.body[cur.body.length - 1] !== "") {
			// Lazy paragraph continuation.
			cur.body.push(line.trim());
			i++;
			continue;
		}
		break;
	}

	for (const { li, body } of items) {
		const task = /^\[([ xX])\][ \t]+/.exec(body[0] as string);
		if (task) {
			body[0] = (body[0] as string).slice(task[0].length);
			const box = el("input");
			box.type = "checkbox";
			box.disabled = true;
			box.checked = task[1] !== " ";
			li.classList.add("md-task");
			li.appendChild(box);
		}
		const tight = !sawBlankBetweenItems && !body.includes("");
		if (tight) {
			// Tight list: first line(s) inline, nested blocks after.
			let j = 0;
			const inlineLines: string[] = [];
			while (j < body.length && !startsBlock(body[j] as string)) {
				inlineLines.push(body[j] as string);
				j++;
			}
			appendAll(li, inline(inlineLines.join("\n"), opts));
			renderBlocks(body.slice(j), opts, depth + 1, li);
		} else {
			renderBlocks(body, opts, depth + 1, li);
		}
		list.appendChild(li);
	}
	into.appendChild(list);
	return i;
}

function renderTable(lines: string[], start: number, opts: MarkdownOptions, into: Node): number {
	const header = splitTableRow(lines[start] as string);
	const aligns = splitTableRow(lines[start + 1] as string).map((c) =>
		c.startsWith(":") && c.endsWith(":")
			? "center"
			: c.endsWith(":")
				? "right"
				: c.startsWith(":")
					? "left"
					: "",
	);
	const wrap = el("div", "md-table-wrap");
	const table = el("table");
	const thead = el("thead");
	const hr = el("tr");
	header.forEach((cell, idx) => {
		const th = el("th");
		if (aligns[idx]) th.style.textAlign = aligns[idx] as string;
		appendAll(th, inline(cell, opts));
		hr.appendChild(th);
	});
	thead.appendChild(hr);
	table.appendChild(thead);
	const tbody = el("tbody");
	let i = start + 2;
	while (i < lines.length && !isBlank(lines[i] as string) && (lines[i] as string).includes("|")) {
		const cells = splitTableRow(lines[i] as string);
		const tr = el("tr");
		// Only cells the row actually has; the missing tail is ONE cell
		// spanning it. Padding each row out to the header width made a
		// wide header × many bare `|` lines a multiplicative DOM bomb
		// (10k columns × 10k rows from 30 KB of input).
		const present = Math.min(cells.length, header.length);
		for (let idx = 0; idx < present; idx++) {
			const td = el("td");
			if (aligns[idx]) td.style.textAlign = aligns[idx] as string;
			appendAll(td, inline(cells[idx] as string, opts));
			tr.appendChild(td);
		}
		if (present < header.length) {
			const filler = el("td");
			filler.colSpan = header.length - present;
			tr.appendChild(filler);
		}
		tbody.appendChild(tr);
		i++;
	}
	table.appendChild(tbody);
	wrap.appendChild(table);
	into.appendChild(wrap);
	return i;
}

/** Render a Markdown document into a detached `.md-root` element. */
export function renderMarkdown(src: string, opts: MarkdownOptions = {}): HTMLElement {
	const root = el("div", "md-root");
	// Front matter (--- yaml ---) is metadata, not prose: show it as code.
	let body = src.replace(/\r\n?/g, "\n");
	const fm = /^---\n([\s\S]*?)\n---\n/.exec(body);
	if (fm) {
		root.appendChild(renderCodeBlock(fm[1] as string, "yaml"));
		body = body.slice(fm[0].length);
	}
	try {
		withDocBudget(body, () => renderBlocks(body.split("\n"), opts, 0, root));
	} catch (err) {
		// RangeError = engine stack/size limit: same "too complex" answer.
		if (!(err instanceof MarkdownBudgetError) && !(err instanceof RangeError)) throw err;
		// Pathological input: show it as plain text instead of freezing
		// the UI thread (and the terminal with it). withDocBudget has
		// already cleared the budget, so these few elements aren't capped.
		const fallback = el("div", "md-root md-fallback");
		fallback.appendChild(
			el("p", "md-fallback-note", "This document is too complex to render — showing plain text."),
		);
		const pre = el("pre", "md-pre");
		pre.textContent = src;
		fallback.appendChild(pre);
		return fallback;
	}
	return root;
}
