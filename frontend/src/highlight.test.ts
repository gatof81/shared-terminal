import { describe, expect, it } from "vitest";
import {
	HIGHLIGHT_MAX_CHARS,
	highlightCode,
	languageForFence,
	languageForFile,
} from "./highlight.js";

function tokens(src: string, lang: Parameters<typeof highlightCode>[1]) {
	const host = document.createElement("div");
	host.appendChild(highlightCode(src, lang));
	return {
		host,
		of: (cls: string) => [...host.querySelectorAll(`.hl-${cls}`)].map((n) => n.textContent),
	};
}

describe("highlightCode", () => {
	it("preserves the source text exactly", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a JS template literal IS the test input
		const src = "const a = `x ${y}`; /* c */\nlet b = 0x1F; // done\n";
		expect(tokens(src, "c-like").host.textContent).toBe(src);
	});

	it("never turns content into markup", () => {
		const { host } = tokens('const s = "<img src=x onerror=alert(1)>"; // <script>', "c-like");
		expect(host.querySelector("img, script")).toBeNull();
		expect(host.querySelectorAll("*").length).toBe(host.querySelectorAll("span").length);
	});

	it("tokenizes C-like code", () => {
		const t = tokens('import { x } from "y";\nif (a === 42) return null;', "c-like");
		expect(t.of("keyword")).toEqual(["import", "from", "if", "return"]);
		expect(t.of("string")).toEqual(['"y"']);
		expect(t.of("number")).toEqual(["42"]);
		expect(t.of("literal")).toEqual(["null"]);
	});

	it("distinguishes JSON keys from string values", () => {
		const t = tokens('{"name": "x", "n": 1, "ok": true}', "json");
		expect(t.of("key")).toEqual(['"name"', '"n"', '"ok"']);
		expect(t.of("string")).toEqual(['"x"']);
		expect(t.of("literal")).toEqual(["true"]);
	});

	it("highlights YAML keys and comments", () => {
		const t = tokens("name: app # the name\nitems:\n  - foo: bar\n", "yaml");
		expect(t.of("key")).toEqual(["name", "items", "foo"]);
		expect(t.of("comment")).toEqual(["# the name"]);
	});

	it("treats shell `$#` as a variable, not a comment", () => {
		const t = tokens('echo $# "args" # count', "shell");
		expect(t.of("comment")).toEqual(["# count"]);
	});

	it("falls back to plain text for huge inputs", () => {
		const { host } = tokens(`const x = 1;\n`.repeat(HIGHLIGHT_MAX_CHARS / 10), "c-like");
		expect(host.querySelector("span")).toBeNull();
	});
});

describe("language detection", () => {
	it.each([
		["index.ts", "c-like"],
		["main.go", "c-like"],
		["app.py", "python"],
		["deploy.sh", "shell"],
		["Dockerfile", "shell"],
		["Dockerfile.dev", "shell"],
		["package.json", "json"],
		["ci.yml", "yaml"],
		["README.md", "markdown"],
		["notes", "plain"],
		["LICENSE", "plain"],
	])("%s → %s", (name, lang) => {
		expect(languageForFile(name)).toBe(lang);
	});

	it("maps fence info strings", () => {
		expect(languageForFence("typescript")).toBe("c-like");
		expect(languageForFence("bash title=x")).toBe("shell");
		expect(languageForFence("")).toBe("plain");
		expect(languageForFence("unknownlang")).toBe("plain");
	});
});
