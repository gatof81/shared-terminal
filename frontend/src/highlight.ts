/**
 * highlight.ts — lightweight syntax highlighting for the Workspace
 * Explorer's code preview and Markdown fences.
 *
 * Deliberately a small lexical tokenizer (comments, strings, numbers,
 * keywords, literals, JSON/YAML keys), not a grammar engine: it covers the
 * "make code readable" bar without a highlight.js-sized dependency. Same
 * safety model as markdown.ts — output is text nodes inside <span>s built
 * with createElement/textContent, never an HTML string, so file content
 * can't become markup however the tokenizer mis-lexes it.
 */

export type Language =
	| "c-like"
	| "python"
	| "shell"
	| "ruby"
	| "json"
	| "yaml"
	| "toml"
	| "css"
	| "markup"
	| "sql"
	| "markdown"
	| "plain";

interface Spec {
	lineComments: string[];
	blockComments: [string, string][];
	/** Quote chars that open a string. Backtick strings may span lines. */
	quotes: string[];
	keywords: Set<string>;
	literals: Set<string>;
	caseInsensitive?: boolean;
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const C_LIKE_KEYWORDS = words(`
	abstract as async await break case catch class const continue crate debugger declare def default
	defer delete do dyn else enum export extends extern final finally fn for from func go goto if impl
	implements import in instanceof interface internal is let loop match mod module mut namespace new
	of override package private protected pub public readonly record return sealed select static
	struct super switch synchronized this throw throws trait try type typeof unsafe use using var
	virtual void volatile when where while with yield chan map range fallthrough val fun object
	companion inline suspend lateinit init`);
const C_LIKE_LITERALS = words(
	"true false null undefined nil NaN Infinity None Some Ok Err self Self",
);

const SPECS: Record<Exclude<Language, "plain" | "markup" | "markdown">, Spec> = {
	"c-like": {
		lineComments: ["//"],
		blockComments: [["/*", "*/"]],
		quotes: ['"', "'", "`"],
		keywords: C_LIKE_KEYWORDS,
		literals: C_LIKE_LITERALS,
	},
	python: {
		lineComments: ["#"],
		blockComments: [
			['"""', '"""'],
			["'''", "'''"],
		],
		quotes: ['"', "'"],
		keywords: words(`and as assert async await break class continue def del elif else except finally
			for from global if import in is lambda nonlocal not or pass raise return try while with yield match case`),
		literals: words("True False None self cls"),
	},
	shell: {
		lineComments: ["#"],
		blockComments: [],
		quotes: ['"', "'"],
		keywords: words(`if then else elif fi for while until do done case esac in function return local
			export readonly declare set unset shift exit source alias echo cd`),
		literals: words("true false"),
	},
	ruby: {
		lineComments: ["#"],
		blockComments: [["=begin", "=end"]],
		quotes: ['"', "'"],
		keywords:
			words(`alias and begin break case class def defined? do else elsif end ensure for if in
			module next not or redo rescue retry return super then undef unless until when while yield require`),
		literals: words("true false nil self"),
	},
	json: {
		lineComments: [],
		blockComments: [],
		quotes: ['"'],
		keywords: new Set(),
		literals: words("true false null"),
	},
	yaml: {
		lineComments: ["#"],
		blockComments: [],
		quotes: ['"', "'"],
		keywords: new Set(),
		literals: words("true false null yes no on off ~"),
	},
	toml: {
		lineComments: ["#"],
		blockComments: [],
		quotes: ['"', "'"],
		keywords: new Set(),
		literals: words("true false"),
	},
	css: {
		lineComments: [],
		blockComments: [["/*", "*/"]],
		quotes: ['"', "'"],
		keywords: words("important media import supports keyframes font-face from to"),
		literals: new Set(),
	},
	sql: {
		lineComments: ["--"],
		blockComments: [["/*", "*/"]],
		quotes: ["'", '"'],
		keywords: words(`select from where and or not insert into values update set delete create table
			alter drop index on join left right inner outer group by order having limit offset as distinct
			union all primary key foreign references default exists case when then else end begin commit
			rollback transaction if is in like between returning with`),
		literals: words("null true false"),
		caseInsensitive: true,
	},
};

const EXT_LANG: Record<string, Language> = {
	ts: "c-like",
	tsx: "c-like",
	mts: "c-like",
	cts: "c-like",
	js: "c-like",
	jsx: "c-like",
	mjs: "c-like",
	cjs: "c-like",
	java: "c-like",
	kt: "c-like",
	kts: "c-like",
	scala: "c-like",
	go: "c-like",
	rs: "c-like",
	c: "c-like",
	h: "c-like",
	cc: "c-like",
	cpp: "c-like",
	hpp: "c-like",
	cs: "c-like",
	swift: "c-like",
	dart: "c-like",
	php: "c-like",
	proto: "c-like",
	gradle: "c-like",
	py: "python",
	pyi: "python",
	sh: "shell",
	bash: "shell",
	zsh: "shell",
	fish: "shell",
	rb: "ruby",
	json: "json",
	jsonc: "c-like",
	json5: "c-like",
	ipynb: "json",
	lock: "plain",
	yml: "yaml",
	yaml: "yaml",
	toml: "toml",
	ini: "toml",
	cfg: "toml",
	conf: "shell",
	css: "css",
	scss: "css",
	less: "css",
	html: "markup",
	htm: "markup",
	xml: "markup",
	svg: "markup",
	vue: "markup",
	svelte: "markup",
	sql: "sql",
	md: "markdown",
	markdown: "markdown",
	mdx: "markdown",
};

const NAME_LANG: Record<string, Language> = {
	dockerfile: "shell",
	makefile: "shell",
	gemfile: "ruby",
	rakefile: "ruby",
	".bashrc": "shell",
	".zshrc": "shell",
	".profile": "shell",
	".gitignore": "shell",
	".dockerignore": "shell",
	".editorconfig": "toml",
	".env.example": "shell",
	".env.sample": "shell",
	".env.template": "shell",
};

/** Language for a file name (extension, then well-known names). */
export function languageForFile(name: string): Language {
	const lower = name.toLowerCase();
	const byName = NAME_LANG[lower];
	if (byName) return byName;
	if (lower.startsWith("dockerfile")) return "shell";
	const dot = lower.lastIndexOf(".");
	if (dot === -1) return "plain";
	return EXT_LANG[lower.slice(dot + 1)] ?? "plain";
}

const FENCE_ALIASES: Record<string, Language> = {
	typescript: "c-like",
	javascript: "c-like",
	rust: "c-like",
	golang: "c-like",
	kotlin: "c-like",
	csharp: "c-like",
	"c++": "c-like",
	python: "python",
	console: "shell",
	shell: "shell",
	sh: "shell",
	ruby: "ruby",
	html: "markup",
	xml: "markup",
	diff: "plain",
	text: "plain",
};

/** Language for a Markdown fence info string (```ts, ```bash …). */
export function languageForFence(info: string): Language {
	const tag = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
	if (tag === "") return "plain";
	return FENCE_ALIASES[tag] ?? EXT_LANG[tag] ?? "plain";
}

function span(cls: string, text: string): HTMLSpanElement {
	const s = document.createElement("span");
	s.className = `hl-${cls}`;
	s.textContent = text;
	return s;
}

const IDENT = /[A-Za-z_$][\w$-]*\??/y;
const IDENT_STRICT = /[A-Za-z_$][\w$]*/y;
const NUMBER =
	/(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z]*/y;

/** Index just past the string opened by `quote` at `start`. */
function scanString(src: string, start: number, quote: string): number {
	let i = start + quote.length;
	while (i < src.length) {
		const c = src[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (src.startsWith(quote, i)) return i + quote.length;
		// Only backtick (template) strings span lines.
		if (c === "\n" && quote !== "`") return i;
		i++;
	}
	return src.length;
}

function highlightWithSpec(src: string, spec: Spec, lang: Language): DocumentFragment {
	const frag = document.createDocumentFragment();
	let plain = "";
	const flush = () => {
		if (plain) frag.appendChild(document.createTextNode(plain));
		plain = "";
	};
	const emit = (cls: string, text: string) => {
		flush();
		frag.appendChild(span(cls, text));
	};
	// YAML/TOML: a key is an identifier at line start followed by `:`/`=`.
	let atLineStart = true;

	let i = 0;
	while (i < src.length) {
		const c = src[i] as string;

		const block = spec.blockComments.find(([open]) => src.startsWith(open, i));
		if (block) {
			const end = src.indexOf(block[1], i + block[0].length);
			const stop = end === -1 ? src.length : end + block[1].length;
			emit(lang === "python" ? "string" : "comment", src.slice(i, stop));
			i = stop;
			atLineStart = false;
			continue;
		}
		if (spec.lineComments.some((lc) => src.startsWith(lc, i))) {
			// `#` inside shell words like `$#` / `a#b` isn't a comment.
			const prev = src[i - 1];
			if (!(c === "#" && prev !== undefined && !/\s/.test(prev))) {
				const end = src.indexOf("\n", i);
				const stop = end === -1 ? src.length : end;
				emit("comment", src.slice(i, stop));
				i = stop;
				continue;
			}
		}
		const quote = spec.quotes.find((q) => src.startsWith(q, i));
		if (quote) {
			// YAML values are often prose: an apostrophe inside a word
			// (`it's`) isn't a string opener there.
			const prev = src[i - 1];
			const apostrophe = lang === "yaml" && quote === "'" && prev !== undefined && /\w/.test(prev);
			if (!apostrophe) {
				const stop = scanString(src, i, quote);
				const text = src.slice(i, stop);
				const isKey =
					(lang === "json" || lang === "yaml") && /^\s*:/.test(src.slice(stop, stop + 8));
				emit(isKey ? "key" : "string", text);
				i = stop;
				atLineStart = false;
				continue;
			}
		}
		if (/\d/.test(c) && !/[\w$]/.test(src[i - 1] ?? "")) {
			NUMBER.lastIndex = i;
			const m = NUMBER.exec(src);
			if (m) {
				emit("number", m[0]);
				i += m[0].length;
				atLineStart = false;
				continue;
			}
		}
		if (/[A-Za-z_$]/.test(c)) {
			const re =
				lang === "yaml" || lang === "toml" || lang === "css" || lang === "ruby"
					? IDENT
					: IDENT_STRICT;
			re.lastIndex = i;
			const m = re.exec(src);
			if (m) {
				const word = m[0];
				const lookup = spec.caseInsensitive ? word.toLowerCase() : word;
				const after = src.slice(i + word.length, i + word.length + 4);
				if (
					(lang === "yaml" && atLineStart && /^\s*:/.test(after)) ||
					(lang === "toml" && atLineStart && /^\s*=/.test(after))
				) {
					emit("key", word);
				} else if (spec.keywords.has(lookup)) {
					emit("keyword", word);
				} else if (spec.literals.has(lookup)) {
					emit("literal", word);
				} else {
					plain += word;
				}
				i += word.length;
				atLineStart = false;
				continue;
			}
		}
		if (c === "\n") atLineStart = true;
		else if (c !== " " && c !== "\t" && !(lang === "yaml" && c === "-")) atLineStart = false;
		plain += c;
		i++;
	}
	flush();
	return frag;
}

/** HTML/XML: tags, attribute names, attribute values, comments. */
function highlightMarkup(src: string): DocumentFragment {
	const frag = document.createDocumentFragment();
	const re =
		/<!--[\s\S]*?(?:-->|$)|<\/?[A-Za-z][^\s/>]*|\s[A-Za-z_:][\w:.-]*(?==)|"[^"]*"|'[^']*'|\/?>/g;
	let last = 0;
	let inTag = false;
	for (const m of src.matchAll(re)) {
		const idx = m.index ?? 0;
		const tok = m[0];
		if (idx > last) frag.appendChild(document.createTextNode(src.slice(last, idx)));
		if (tok.startsWith("<!--")) frag.appendChild(span("comment", tok));
		else if (tok.startsWith("<")) {
			frag.appendChild(span("keyword", tok));
			inTag = true;
		} else if (tok.endsWith(">")) {
			frag.appendChild(span("keyword", tok));
			inTag = false;
		} else if (inTag && (tok.startsWith('"') || tok.startsWith("'")))
			frag.appendChild(span("string", tok));
		else if (inTag) frag.appendChild(span("key", tok));
		else frag.appendChild(document.createTextNode(tok));
		last = idx + tok.length;
	}
	if (last < src.length) frag.appendChild(document.createTextNode(src.slice(last)));
	return frag;
}

/** Markdown source view: headings, fences, and list/quote markers. */
function highlightMarkdownSource(src: string): DocumentFragment {
	const frag = document.createDocumentFragment();
	let inFence = false;
	for (const line of src.split(/(?<=\n)/)) {
		if (/^ {0,3}(```|~~~)/.test(line)) {
			inFence = !inFence;
			frag.appendChild(span("comment", line));
		} else if (inFence) frag.appendChild(span("string", line));
		else if (/^ {0,3}#{1,6}\s/.test(line)) frag.appendChild(span("keyword", line));
		else if (/^ {0,3}>/.test(line)) frag.appendChild(span("comment", line));
		else frag.appendChild(document.createTextNode(line));
	}
	return frag;
}

// Past this size the per-token <span>s cost more (DOM nodes, layout) than
// the colour is worth — show plain text. 256 KiB ≈ 6k lines of code.
export const HIGHLIGHT_MAX_CHARS = 256 * 1024;

/** Highlight `src` as `lang`, returning detached DOM. */
export function highlightCode(src: string, lang: Language): DocumentFragment {
	if (lang === "plain" || src.length > HIGHLIGHT_MAX_CHARS) {
		const frag = document.createDocumentFragment();
		frag.appendChild(document.createTextNode(src));
		return frag;
	}
	if (lang === "markup") return highlightMarkup(src);
	if (lang === "markdown") return highlightMarkdownSource(src);
	return highlightWithSpec(src, SPECS[lang], lang);
}
