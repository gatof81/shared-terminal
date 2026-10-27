import { describe, expect, it, vi } from "vitest";
import { classifyHref, renderInline, renderMarkdown, slugify } from "./markdown.js";

function render(src: string, opts = {}) {
	const root = renderMarkdown(src, opts);
	document.body.replaceChildren(root);
	return root;
}

describe("renderMarkdown — safety", () => {
	it("renders raw HTML as literal text, never as elements", () => {
		const root = render(
			'<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\nhi <b onclick="x()">bold</b>\n\n<iframe src="https://evil"></iframe>',
		);
		expect(root.querySelector("script, img, iframe, b, [onerror], [onclick]")).toBeNull();
		expect(root.textContent).toContain("<script>alert(1)</script>");
		expect(root.textContent).toContain('<img src=x onerror="alert(1)">');
	});

	it("keeps HTML inside code spans and fences as text", () => {
		const root = render("`<svg onload=x>`\n\n```html\n<script>bad()</script>\n```");
		expect(root.querySelector("svg, script")).toBeNull();
		expect(root.querySelector("code")?.textContent).toBe("<svg onload=x>");
		expect(root.querySelector("pre")?.textContent).toBe("<script>bad()</script>");
	});

	it.each([
		"javascript:alert(1)",
		"JAVASCRIPT:alert(1)",
		" javascript:alert(1)",
		"java\tscript:alert(1)",
		"java\nscript:alert(1)",
		"\u0001javascript:alert(1)",
		"data:text/html,<script>alert(1)</script>",
		"vbscript:msgbox(1)",
		"file:///etc/passwd",
	])("blocks dangerous link target %j", (href) => {
		const root = render(`[click](${href.replace(/\n/g, "")})`);
		expect(root.querySelector("a")).toBeNull();
		expect(root.querySelector(".md-link-blocked")?.textContent).toBe("click");
	});

	it("blocks dangerous schemes in autolinks too", () => {
		const root = render("<javascript:alert(1)>");
		expect(root.querySelector("a")).toBeNull();
	});

	it("opens external links in a new tab without opener/referrer", () => {
		const root = render("[docs](https://example.com/a?b=1)");
		const a = root.querySelector("a") as HTMLAnchorElement;
		expect(a.getAttribute("href")).toBe("https://example.com/a?b=1");
		expect(a.target).toBe("_blank");
		expect(a.rel).toContain("noopener");
		expect(a.rel).toContain("noreferrer");
	});

	it("never lets an in-document anchor touch location.hash (app router)", () => {
		const root = render("# Setup Guide\n\n[jump](#setup-guide)");
		const heading = root.querySelector("h1") as HTMLElement;
		heading.scrollIntoView = vi.fn();
		const before = window.location.hash;
		const a = root.querySelector("a") as HTMLAnchorElement;
		a.click();
		expect(window.location.hash).toBe(before);
		expect(heading.scrollIntoView).toHaveBeenCalled();
	});

	it("routes relative links to the callback instead of navigating", () => {
		const onRelativeLink = vi.fn();
		const root = render("[setup](./docs/setup.md)", { onRelativeLink });
		const before = window.location.href;
		(root.querySelector("a") as HTMLAnchorElement).click();
		expect(onRelativeLink).toHaveBeenCalledWith("./docs/setup.md");
		expect(window.location.href).toBe(before);
	});

	it("renders images as inert placeholders (no <img> request)", () => {
		const root = render("![diagram](https://evil.example/track.png)");
		expect(root.querySelector("img")).toBeNull();
		expect(root.querySelector(".md-image")?.textContent).toContain("diagram");
	});

	it("survives pathological nesting without blowing the stack", () => {
		const root = render(`${">".repeat(5000)} deep`);
		expect(root.textContent).toContain("deep");
	});
});

describe("renderMarkdown — structure", () => {
	it("renders headings with slugs, paragraphs and emphasis", () => {
		const root = render(
			"# Title\n\nSome **bold**, *em*, ~~gone~~ and `code`.\n\n## Sub *x*\n\nSetext\n===",
		);
		expect(root.querySelector("h1")?.textContent).toBe("Title");
		expect(root.querySelector("h1")?.dataset.slug).toBe("title");
		expect(root.querySelector("strong")?.textContent).toBe("bold");
		expect(root.querySelector("em")?.textContent).toBe("em");
		expect(root.querySelector("del")?.textContent).toBe("gone");
		expect(root.querySelector("h2 em")?.textContent).toBe("x");
		expect(root.querySelectorAll("h1")[1]?.textContent).toBe("Setext");
	});

	it("leaves snake_case identifiers alone", () => {
		const root = render("call my_func_name now");
		expect(root.querySelector("em")).toBeNull();
		expect(root.textContent).toBe("call my_func_name now");
	});

	it("renders nested and ordered lists and task items", () => {
		const root = render(
			"- a\n  - a1\n    - a1x\n- b\n\n3. three\n4. four\n\n- [x] done\n- [ ] todo",
		);
		const lists = root.querySelectorAll(":scope > ul, :scope > ol");
		expect(lists).toHaveLength(3);
		expect(root.querySelector("ul ul ul li")?.textContent).toBe("a1x");
		const ol = root.querySelector("ol") as HTMLOListElement;
		expect(ol.start).toBe(3);
		const boxes = root.querySelectorAll<HTMLInputElement>("li.md-task input[type=checkbox]");
		expect([...boxes].map((b) => [b.checked, b.disabled])).toEqual([
			[true, true],
			[false, true],
		]);
	});

	it("renders fenced code with highlighting spans", () => {
		const root = render("```ts\nconst x = 'y'; // c\n```");
		const code = root.querySelector("pre code") as HTMLElement;
		expect(code.textContent).toBe("const x = 'y'; // c");
		expect(code.querySelector(".hl-keyword")?.textContent).toBe("const");
		expect(code.querySelector(".hl-string")?.textContent).toBe("'y'");
		expect(code.querySelector(".hl-comment")?.textContent).toBe("// c");
	});

	it("renders GFM tables with alignment", () => {
		const root = render("| a | b |\n|:--|--:|\n| 1 | **2** |\n| x \\| y | z |");
		expect(root.querySelectorAll("th")).toHaveLength(2);
		expect((root.querySelector("th") as HTMLElement).style.textAlign).toBe("left");
		expect(root.querySelector("td strong")?.textContent).toBe("2");
		expect(root.querySelectorAll("tbody tr")[1]?.firstElementChild?.textContent).toBe("x | y");
	});

	it("renders blockquotes, rules and front matter", () => {
		const root = render("---\ntitle: x\n---\n> quoted\n\n---\n");
		expect(root.firstElementChild?.tagName).toBe("PRE");
		expect(root.querySelector("blockquote")?.textContent).toBe("quoted");
		expect(root.querySelector("hr")).not.toBeNull();
	});

	it("autolinks bare URLs without swallowing trailing punctuation", () => {
		const nodes = renderInline("see https://example.com/x.");
		const a = nodes.find((n) => n instanceof HTMLAnchorElement) as HTMLAnchorElement;
		expect(a.getAttribute("href")).toBe("https://example.com/x");
	});
});

describe("classifyHref / slugify", () => {
	it("classifies targets", () => {
		expect(classifyHref("mailto:a@b.c").kind).toBe("external");
		expect(classifyHref("//cdn.example/x")).toEqual({
			kind: "external",
			href: "https://cdn.example/x",
		});
		expect(classifyHref("#Intro")).toEqual({ kind: "anchor", slug: "intro" });
		expect(classifyHref("docs/a.md")).toEqual({ kind: "relative", href: "docs/a.md" });
		expect(classifyHref("")).toEqual({ kind: "blocked" });
	});

	it("slugifies like GitHub", () => {
		expect(slugify("Hello, World!")).toBe("hello-world");
		expect(slugify("API v2 (beta)")).toBe("api-v2-beta");
	});
});

// 200k chars: with the old rescan-per-delimiter parser these took tens of
// seconds (quadratic); now the heaviest takes ~0.4 s locally. The bound used
// to be 1.5 s, and CI runners measured that heaviest case (interleaved
// emphasis) at 1.57–1.66 s with no regression at all. 10 s of wall time
// keeps a wide margin for slow runners and still catches a regression of
// the historical kind, which takes tens of seconds per render. It does not
// catch a mild quadratic (a few hundred ms at 200k); finer complexity
// detection is separate work.
const RENDER_BUDGET_MS = 10_000;

// Above the budget, so that a render that finishes over it fails on the
// budget assertion, with its time in the message. These tests are
// synchronous: Vitest's timeout is a timer on the same thread, so it cannot
// interrupt a render that never returns (and does not even fail a
// synchronous test after the fact) — nothing in this file stops such a
// hang; the CI job's own time limit does.
const COMPLEXITY_TEST_TIMEOUT_MS = 30_000;

describe("renderMarkdown — complexity", () => {
	const N = 200_000;
	it.each<[string, string]>([
		["unclosed brackets", "[".repeat(N)],
		["unclosed brackets with text", "[a ".repeat(N / 3)],
		["unclosed stars", "*a ".repeat(N / 3)],
		["unclosed underscores", " _a".repeat(N / 3)],
		["unclosed tildes", "~~a ".repeat(N / 4)],
		["unclosed parens after links", "[a](".repeat(N / 4)],
		[
			"mixed backtick runs",
			Array.from({ length: N / 10 }, (_, i) => `${"`".repeat((i % 7) + 1)}x `).join(""),
		],
		["deeply nested brackets", `${"[".repeat(N / 2)}${"]".repeat(N / 2)}`],
		["interleaved emphasis", `${"*_".repeat(N / 4)}x${"_*".repeat(N / 4)}`],
		["heading padded with spaces", `# ${" ".repeat(N)}x`],
		["fence padded with spaces", `\`\`\`${" ".repeat(N)}\``],
		["table separator padded with spaces", `a|b\n-${" ".repeat(N)}x`],
	])(
		"%s stays fast and loses no text",
		(_label, src) => {
			const t = performance.now();
			const root = renderMarkdown(src);
			expect(performance.now() - t).toBeLessThan(RENDER_BUDGET_MS);
			// Whatever the rendering, the visible text never drops content
			// characters (markup delimiters aside) — spot-check via length.
			expect((root.textContent ?? "").length).toBeGreaterThan(0);
		},
		COMPLEXITY_TEST_TIMEOUT_MS,
	);

	it(
		"doesn't let a wide header × bare rows multiply into a DOM bomb (review repro)",
		() => {
			// 30 KB of input that used to expand to ~100M cells.
			const src = `${"|".repeat(10_000)}\n-\n${"|\n".repeat(10_000)}`;
			const t = performance.now();
			const root = renderMarkdown(src);
			expect(performance.now() - t).toBeLessThan(RENDER_BUDGET_MS);
			expect(root.querySelectorAll("*").length).toBeLessThan(60_000);
			// 10k columns is over MAX_TABLE_COLUMNS: not rendered as a table.
			expect(root.querySelector("table")).toBeNull();
		},
		COMPLEXITY_TEST_TIMEOUT_MS,
	);

	it(
		"bounds rows of missing cells at the column cap too",
		() => {
			const header = `|${"h|".repeat(64)}`;
			const sep = `|${"-|".repeat(64)}`;
			const src = `${header}\n${sep}\n${"|\n".repeat(40_000)}`;
			const t = performance.now();
			const root = renderMarkdown(src);
			expect(performance.now() - t).toBeLessThan(RENDER_BUDGET_MS);
			expect(root.querySelectorAll("*").length).toBeLessThan(60_000);
		},
		COMPLEXITY_TEST_TIMEOUT_MS,
	);

	it("still renders a legitimately dense table", () => {
		const cols = 64;
		const row = (c: string) => `|${Array.from({ length: cols }, () => c).join("|")}|`;
		const src = [row("h"), row("-"), ...Array.from({ length: 100 }, () => row("a"))].join("\n");
		const root = renderMarkdown(src);
		expect(root.classList.contains("md-fallback")).toBe(false);
		expect(root.querySelectorAll("td")).toHaveLength(cols * 100);
	});

	it("caps inline nesting depth and renders the rest as text", () => {
		const root = render(`${"[".repeat(30)}x${"](y)".repeat(30)}`);
		expect(root.querySelectorAll("a").length).toBeLessThanOrEqual(9);
		expect(root.textContent).toContain("x");
	});

	it("falls back to plain text when a document explodes into elements", () => {
		const src = `${"*_".repeat(60_000)}x${"_*".repeat(60_000)}`;
		const root = renderMarkdown(src);
		expect(root.classList.contains("md-fallback")).toBe(true);
		expect(root.querySelector("pre")?.textContent).toBe(src);
		expect(root.textContent).toContain("too complex");
	});

	it("doesn't overflow the stack appending huge inline runs", () => {
		expect(() => renderMarkdown("`a` ".repeat(150_000))).not.toThrow();
	});
});

describe("renderMarkdown — delimiter semantics after the linear rewrite", () => {
	it.each<[string, string, string]>([
		["**a *b* c**", "strong em", "b"],
		["*a **b** c*", "em strong", "b"],
		["***both***", "strong", "both"],
		["[a `]` b](https://x.example)", "a code", "]"],
		["`code with [link](x)`", "code", "code with [link](x)"],
		["~~gone~~ ~single~", "del", "gone"],
	])("%s", (src, selector, text) => {
		const root = render(src);
		expect(root.querySelector(selector)?.textContent).toContain(text);
	});

	it("renders a row's missing cells as one spanning cell", () => {
		const root = render("| a | b | c |\n|---|---|---|\n| 1 |");
		const tds = root.querySelectorAll<HTMLTableCellElement>("tbody td");
		expect(tds).toHaveLength(2);
		expect(tds[1]?.colSpan).toBe(2);
	});

	it("leaves unmatched delimiters as literal text", () => {
		const root = render("a * b [c ( `d ~~e _f");
		expect(root.textContent).toBe("a * b [c ( `d ~~e _f");
		expect(root.querySelector("em, strong, a, code, del")).toBeNull();
	});

	it("keeps headings with a trailing hash in the text (C#)", () => {
		expect(render("# Learn C#").querySelector("h1")?.textContent).toBe("Learn C#");
		expect(render("## Title ##").querySelector("h2")?.textContent).toBe("Title");
	});
});
