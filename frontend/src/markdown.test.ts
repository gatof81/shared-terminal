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

// ── Complexity: growth, not wall-clock ──────────────────────────────────────
//
// These used to assert one render of 200k chars under 1.5 s of wall
// time. That bound was close to what a slow CI runner takes for the
// heaviest case (interleaved emphasis: ~0.4 s locally, 1.6 s seen on CI),
// so it failed with no regression at all. What the tests are for is
// catching a parser that went quadratic (the old rescan-per-delimiter one
// took tens of seconds), and that shows in how the cost GROWS with the
// input, which a slow machine does not change:
//   - the cost is this process's CPU time (`process.cpuUsage`), not wall
//     time: on a loaded runner wall time includes waiting for a core — a
//     10 ms render measured ~100 ms, one scheduler slice, on every
//     repetition — and no repetition removes that. Vitest runs each test
//     file in its own process (the `forks` pool), so nothing else counts;
//   - each input is rendered at 50k, 100k and 200k chars, after a warmup,
//     keeping the best of 3 at each size: what noise remains (a GC burst,
//     cache contention) only ever adds time, so the minimum is the estimate;
//   - the growth exponent is the least-squares slope of log(time) over
//     log(n); linear ≈ 1, quadratic ≈ 2, and the bound is 1.5. With these
//     geometric sizes the middle point cancels out of that slope — it is
//     exactly log(t200k / t50k) / log 4 — so the verdict rests on the two
//     ends of a 4× span, each a best-of-3. The middle time is only
//     reported in the failure message;
//   - below a noise floor at 200k the slope is not judged (a few ms is
//     all jitter). No quadratic pass over 200k chars fits under it, and
//     the viewer never renders more than 256 KiB as Markdown, so whatever
//     hides there costs < 50 ms in the worst case;
//   - one render over a generous absolute ceiling fails without running
//     the remaining repetitions. It is checked once a render RETURNS: a
//     synchronous render cannot be interrupted from its own thread, so a
//     render that never returns is stopped by the test timeout instead.

const GROWTH_SIZES: readonly number[] = [50_000, 100_000, 200_000];
const LARGEST = GROWTH_SIZES[GROWTH_SIZES.length - 1] as number;
const GROWTH_REPS = 3;
const MAX_GROWTH_EXPONENT = 1.5;
const NOISE_FLOOR_MS = 25;
const CEILING_MS = 10_000;

/** Least-squares slope of log(t) over log(n). */
function growthExponent(sizes: readonly number[], times: readonly number[]): number {
	const xs = sizes.map(Math.log);
	// A 0 ms reading (timer resolution) would be -Infinity.
	const ys = times.map((t) => Math.log(Math.max(t, 0.01)));
	const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
	const my = ys.reduce((a, b) => a + b, 0) / ys.length;
	let num = 0;
	let den = 0;
	for (let i = 0; i < xs.length; i++) {
		num += ((xs[i] as number) - mx) * ((ys[i] as number) - my);
		den += ((xs[i] as number) - mx) ** 2;
	}
	return num / den;
}

/** The verdict on best-of times per size; null when it passes. */
function growthProblem(sizes: readonly number[], times: readonly number[]): string | null {
	const largest = times[times.length - 1] as number;
	if (largest >= CEILING_MS) return `over the ${CEILING_MS} ms ceiling`;
	if (largest < NOISE_FLOOR_MS) return null;
	const k = growthExponent(sizes, times);
	return k < MAX_GROWTH_EXPONENT ? null : `grows as n^${k.toFixed(2)}`;
}

// Vitest runs under Node; the frontend's tsconfig has no Node types (the
// app never touches `process`), so only what this file reads is declared.
declare const process: { cpuUsage(): { user: number; system: number } };

function cpuMs(): number {
	const u = process.cpuUsage();
	return (u.user + u.system) / 1000;
}

/** Best-of CPU times of `run(n)` at each size; stops at the first render over the ceiling. */
function measureGrowth(run: (n: number) => void): number[] {
	run(GROWTH_SIZES[0] as number); // warmup: JIT and first-use costs out of the first size
	const times: number[] = [];
	for (const n of GROWTH_SIZES) {
		let best = Number.POSITIVE_INFINITY;
		for (let r = 0; r < GROWTH_REPS; r++) {
			const t = cpuMs();
			run(n);
			const dt = cpuMs() - t;
			best = Math.min(best, dt);
			if (dt >= CEILING_MS) return [...times, dt];
		}
		times.push(best);
	}
	return times;
}

function expectNearLinear(run: (n: number) => void): void {
	const times = measureGrowth(run);
	const problem = growthProblem(GROWTH_SIZES.slice(0, times.length), times);
	expect(problem, `times ${times.map((t) => t.toFixed(1)).join(" / ")} ms`).toBeNull();
}

// Worst case per test: a warmup plus 3 × 3 renders of the heaviest input
// on a slow runner, well inside this. A render that never returns is cut
// here, not by the ceiling (which only sees renders that finished).
const GROWTH_TIMEOUT_MS = 120_000;

describe("the growth check itself", () => {
	const S = GROWTH_SIZES;
	it("reads linear, sublinear (a cap or budget) and quadratic growth from best-of times", () => {
		expect(growthExponent(S, [10, 20, 40])).toBeCloseTo(1, 5);
		expect(growthExponent(S, [10, 40, 160])).toBeCloseTo(2, 5);
		expect(growthProblem(S, [100, 200, 400])).toBeNull();
		expect(growthProblem(S, [150, 280, 380])).toBeNull(); // interleaved emphasis, locally
		expect(growthProblem(S, [150, 600, 2400])).toMatch(/grows as n\^2\.00/);
		// Under 1.5 s at 200k, which the old absolute bound let through.
		expect(growthProblem(S, [60, 240, 960])).toMatch(/grows as n\^2/);
		// Only the ends of the span decide: the middle point cancels out of
		// the least-squares slope for geometric sizes.
		expect(growthExponent(S, [40, 41, 120])).toBeCloseTo(growthExponent(S, [40, 4000, 120]), 9);
	});

	it("does not judge jitter below the floor, and fails anything over the ceiling", () => {
		expect(growthProblem(S, [1, 6, 18])).toBeNull();
		expect(growthProblem(S, [100, 800, CEILING_MS])).toMatch(/ceiling/);
		expect(growthProblem([S[0] as number], [CEILING_MS + 1])).toMatch(/ceiling/);
	});

	it(
		"fails a real quadratic workload whose single runs are short",
		() => {
			// Nested loops over n/16: ~10 ms at 50k, ~150 ms at 200k locally —
			// each run far under the old 1.5 s bound, which would have passed it.
			let sink = 0;
			const quadratic = (n: number) => {
				const m = n / 16;
				for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) sink += (i ^ j) & 1;
			};
			const times = measureGrowth(quadratic);
			expect(sink).toBeGreaterThan(0);
			expect(times[times.length - 1]).toBeGreaterThanOrEqual(NOISE_FLOOR_MS);
			expect(growthProblem(GROWTH_SIZES, times)).toMatch(/grows as n\^/);
		},
		GROWTH_TIMEOUT_MS,
	);
});

describe("renderMarkdown — complexity", () => {
	it.each<[string, (n: number) => string]>([
		["unclosed brackets", (n) => "[".repeat(n)],
		["unclosed brackets with text", (n) => "[a ".repeat(n / 3)],
		["unclosed stars", (n) => "*a ".repeat(n / 3)],
		["unclosed underscores", (n) => " _a".repeat(n / 3)],
		["unclosed tildes", (n) => "~~a ".repeat(n / 4)],
		["unclosed parens after links", (n) => "[a](".repeat(n / 4)],
		[
			"mixed backtick runs",
			(n) => Array.from({ length: n / 10 }, (_, i) => `${"`".repeat((i % 7) + 1)}x `).join(""),
		],
		["deeply nested brackets", (n) => `${"[".repeat(n / 2)}${"]".repeat(n / 2)}`],
		["interleaved emphasis", (n) => `${"*_".repeat(n / 4)}x${"_*".repeat(n / 4)}`],
		["heading padded with spaces", (n) => `# ${" ".repeat(n)}x`],
		["fence padded with spaces", (n) => `\`\`\`${" ".repeat(n)}\``],
		["table separator padded with spaces", (n) => `a|b\n-${" ".repeat(n)}x`],
	])(
		"%s grows near-linearly and loses no text",
		(_label, make) => {
			const inputs = new Map(GROWTH_SIZES.map((n) => [n, make(n)]));
			expectNearLinear((n) => renderMarkdown(inputs.get(n) as string));
			// Whatever the rendering, the visible text never drops content
			// characters (markup delimiters aside) — spot-check via length.
			const root = renderMarkdown(inputs.get(LARGEST) as string);
			expect((root.textContent ?? "").length).toBeGreaterThan(0);
		},
		GROWTH_TIMEOUT_MS,
	);

	it(
		"doesn't let a wide header × bare rows multiply into a DOM bomb (review repro)",
		() => {
			// At 200k: 10k columns × 10k bare rows, 30 KB that used to expand
			// to ~100M cells.
			const make = (n: number) => `${"|".repeat(n / 20)}\n-\n${"|\n".repeat(n / 20)}`;
			expectNearLinear((n) => renderMarkdown(make(n)));
			const root = renderMarkdown(make(LARGEST));
			expect(root.querySelectorAll("*").length).toBeLessThan(60_000);
			// 10k columns is over MAX_TABLE_COLUMNS: not rendered as a table.
			expect(root.querySelector("table")).toBeNull();
		},
		GROWTH_TIMEOUT_MS,
	);

	it(
		"bounds rows of missing cells at the column cap too",
		() => {
			const header = `|${"h|".repeat(64)}`;
			const sep = `|${"-|".repeat(64)}`;
			// At 200k: 40k bare rows under a 64-column header.
			const make = (n: number) => `${header}\n${sep}\n${"|\n".repeat(n / 5)}`;
			expectNearLinear((n) => renderMarkdown(make(n)));
			const root = renderMarkdown(make(LARGEST));
			expect(root.querySelectorAll("*").length).toBeLessThan(60_000);
		},
		GROWTH_TIMEOUT_MS,
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
