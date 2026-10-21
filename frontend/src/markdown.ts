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

const ESCAPABLE = "\\`*_{}[]()#+-.!|~<>\"'";

/** Index of the `]` matching the `[` at `open`, honouring nesting/escapes. */
function findClosingBracket(s: string, open: number): number {
	let depth = 0;
	for (let i = open; i < s.length; i++) {
		const c = s[i];
		if (c === "\\") {
			i++;
			continue;
		}
		if (c === "[") depth++;
		else if (c === "]") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** Parses `(url "title")` at `start`; returns url + end index (exclusive). */
function parseLinkTarget(s: string, start: number): { url: string; end: number } | null {
	if (s[start] !== "(") return null;
	let depth = 0;
	for (let i = start; i < s.length; i++) {
		const c = s[i];
		if (c === "\\") {
			i++;
			continue;
		}
		if (c === "(") depth++;
		else if (c === ")") {
			depth--;
			if (depth === 0) {
				const inner = s.slice(start + 1, i).trim();
				// Drop an optional "title" / 'title'; strip <angle> wrapping.
				const m = /^(<[^>]*>|\S+)(?:\s+(?:"[^"]*"|'[^']*'))?$/.exec(inner);
				let url = m ? (m[1] as string) : inner;
				if (url.startsWith("<") && url.endsWith(">")) url = url.slice(1, -1);
				return { url, end: i + 1 };
			}
		}
	}
	return null;
}

function renderLink(text: Node[], rawHref: string, opts: MarkdownOptions): Node {
	const target = classifyHref(rawHref);
	if (target.kind === "blocked") {
		// Keep the visible text; drop the dangerous target entirely.
		const span = el("span", "md-link-blocked");
		span.title = "Link blocked (unsupported URL scheme)";
		span.append(...text);
		return span;
	}
	const a = el("a");
	a.append(...text);
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
	const out: Node[] = [];
	let text = "";
	const flush = () => {
		if (text) out.push(document.createTextNode(text));
		text = "";
	};
	const push = (n: Node) => {
		flush();
		out.push(n);
	};

	let i = 0;
	while (i < src.length) {
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
			let run = 0;
			while (src[i + run] === "`") run++;
			const fence = "`".repeat(run);
			const close = src.indexOf(fence, i + run);
			if (close !== -1) {
				const code = src.slice(i + run, close).replace(/\n/g, " ");
				push(
					el(
						"code",
						"md-code",
						code.length > 2 && code.startsWith(" ") && code.endsWith(" ")
							? code.slice(1, -1)
							: code,
					),
				);
				i = close + run;
				continue;
			}
			text += fence;
			i += run;
			continue;
		}

		if (c === "!" && src[i + 1] === "[") {
			const close = findClosingBracket(src, i + 1);
			const target = close !== -1 ? parseLinkTarget(src, close + 1) : null;
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
			const close = findClosingBracket(src, i);
			const target = close !== -1 ? parseLinkTarget(src, close + 1) : null;
			if (target) {
				push(renderLink(renderInline(src.slice(i + 1, close), opts), target.url, opts));
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
				push(renderLink([document.createTextNode(m[0])], m[0], opts));
				i += m[0].length;
				continue;
			}
		}

		if (c === "~" && src[i + 1] === "~") {
			const close = src.indexOf("~~", i + 2);
			if (close > i + 2) {
				const del = el("del");
				del.append(...renderInline(src.slice(i + 2, close), opts));
				push(del);
				i = close + 2;
				continue;
			}
		}

		if (c === "*" || c === "_") {
			// `_` only opens emphasis at a word boundary so snake_case_names
			// stay intact (GFM's intraword rule).
			const intraword = c === "_" && /[\p{L}\p{N}]/u.test(prev);
			if (!intraword) {
				const double = src[i + 1] === c;
				const delim = double ? c + c : c;
				const contentStart = i + delim.length;
				const close = findEmphasisClose(src, contentStart, delim);
				if (close !== -1) {
					const node = el(double ? "strong" : "em");
					node.append(...renderInline(src.slice(contentStart, close), opts));
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

function findEmphasisClose(src: string, from: number, delim: string): number {
	// Opening delimiter must be followed by non-whitespace.
	if (from >= src.length || /\s/.test(src[from] as string)) return -1;
	let i = from;
	while (i < src.length) {
		const c = src[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === "`") {
			// Don't close emphasis inside a code span.
			let run = 0;
			while (src[i + run] === "`") run++;
			const end = src.indexOf("`".repeat(run), i + run);
			i = end === -1 ? i + run : end + run;
			continue;
		}
		if (src.startsWith(delim, i) && i > from && !/\s/.test(src[i - 1] as string)) {
			// For single `*`, skip a `**` (that's a nested strong).
			if (delim.length === 1 && src[i + 1] === delim) {
				i += 2;
				continue;
			}
			if (delim === "_" && /[\p{L}\p{N}]/u.test(src[i + 1] ?? "")) {
				i++;
				continue;
			}
			return i;
		}
		i++;
	}
	return -1;
}

// ── Blocks ──────────────────────────────────────────────────────────────────

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BULLET = /^( *)([-*+])[ \t]+(.*)$/;
const ORDERED = /^( *)(\d{1,9})([.)])[ \t]+(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const SETEXT = /^ {0,3}(=+|-+)\s*$/;

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
		FENCE_OPEN.test(line) ||
		HEADING.test(line) ||
		HR.test(line) ||
		QUOTE.test(line) ||
		BULLET.test(line) ||
		/^ {0,3}1[.)][ \t]+/.test(line)
	);
}

// Bounded so a pathological file (thousands of nested `>`) can't blow the
// stack; past this depth content renders as plain paragraphs.
const MAX_NESTING = 12;

function renderBlocks(lines: string[], opts: MarkdownOptions, depth: number, into: Node): void {
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] as string;
		if (isBlank(line)) {
			i++;
			continue;
		}

		const fence = FENCE_OPEN.exec(line);
		if (fence) {
			const indent = (fence[1] as string).length;
			const marker = fence[2] as string;
			const body: string[] = [];
			i++;
			while (i < lines.length) {
				const l = lines[i] as string;
				if (new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`).test(l)) {
					i++;
					break;
				}
				body.push(indent > 0 ? l.replace(new RegExp(`^ {0,${indent}}`), "") : l);
				i++;
			}
			into.appendChild(renderCodeBlock(body.join("\n"), fence[3] as string));
			continue;
		}

		const heading = HEADING.exec(line);
		if (heading) {
			const level = (heading[1] as string).length;
			into.appendChild(renderHeading(level, heading[2] ?? "", opts));
			i++;
			continue;
		}

		if (HR.test(line)) {
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
		if (line.includes("|") && next !== undefined && TABLE_SEP.test(next) && next.includes("-")) {
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
			p.append(...renderInline(para.join("\n"), opts));
			into.appendChild(p);
		}
	}
}

function renderHeading(level: number, text: string, opts: MarkdownOptions): HTMLElement {
	const h = document.createElement(`h${level}`);
	h.append(...renderInline(text, opts));
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
			li.append(...renderInline(inlineLines.join("\n"), opts));
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
		th.append(...renderInline(cell, opts));
		hr.appendChild(th);
	});
	thead.appendChild(hr);
	table.appendChild(thead);
	const tbody = el("tbody");
	let i = start + 2;
	while (i < lines.length && !isBlank(lines[i] as string) && (lines[i] as string).includes("|")) {
		const cells = splitTableRow(lines[i] as string);
		const tr = el("tr");
		for (let idx = 0; idx < header.length; idx++) {
			const td = el("td");
			if (aligns[idx]) td.style.textAlign = aligns[idx] as string;
			td.append(...renderInline(cells[idx] ?? "", opts));
			tr.appendChild(td);
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
	renderBlocks(body.split("\n"), opts, 0, root);
	return root;
}
