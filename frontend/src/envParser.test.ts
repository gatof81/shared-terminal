import { describe, expect, it } from "vitest";
import { parseDotEnv } from "./envParser.js";

describe("parseDotEnv", () => {
	it("parses simple KEY=value lines", () => {
		const r = parseDotEnv("FOO=bar\nBAZ=qux\n");
		expect(r.parsed).toEqual([
			{ name: "FOO", value: "bar" },
			{ name: "BAZ", value: "qux" },
		]);
		expect(r.skipped).toEqual([]);
	});

	it("ignores blank lines and full-line comments", () => {
		const r = parseDotEnv(`
# top comment

FOO=bar
   # indented comment
BAZ=qux
`);
		expect(r.parsed).toEqual([
			{ name: "FOO", value: "bar" },
			{ name: "BAZ", value: "qux" },
		]);
		expect(r.skipped).toEqual([]);
	});

	it("strips matching double quotes", () => {
		const r = parseDotEnv(`FOO="hello world"\n`);
		expect(r.parsed).toEqual([{ name: "FOO", value: "hello world" }]);
	});

	it("strips matching single quotes", () => {
		const r = parseDotEnv(`FOO='hello world'\n`);
		expect(r.parsed).toEqual([{ name: "FOO", value: "hello world" }]);
	});

	it("preserves embedded `=` characters in unquoted values", () => {
		// e.g. base64 / URL-encoded values often contain literal `=`.
		// Only the FIRST `=` is the separator.
		const r = parseDotEnv("DATABASE_URL=postgres://u:p@h/db?a=1&b=2\n");
		expect(r.parsed).toEqual([{ name: "DATABASE_URL", value: "postgres://u:p@h/db?a=1&b=2" }]);
	});

	it("accepts the `export FOO=bar` shell-import idiom", () => {
		// Common when copy-pasting from a `~/.bashrc` or a heroku
		// config dump. We strip the `export ` prefix.
		const r = parseDotEnv("export FOO=bar\n");
		expect(r.parsed).toEqual([{ name: "FOO", value: "bar" }]);
	});

	it("trims surrounding whitespace on unquoted values", () => {
		const r = parseDotEnv("FOO=  bar  \n");
		expect(r.parsed).toEqual([{ name: "FOO", value: "bar" }]);
	});

	it("preserves whitespace inside quoted values", () => {
		const r = parseDotEnv(`FOO="  bar  "\n`);
		expect(r.parsed).toEqual([{ name: "FOO", value: "  bar  " }]);
	});

	it("accepts an empty value", () => {
		const r = parseDotEnv("FOO=\n");
		expect(r.parsed).toEqual([{ name: "FOO", value: "" }]);
	});

	it("skips lines with no `=` separator and records the line number", () => {
		const r = parseDotEnv("FOO=bar\njust a sentence\nBAZ=qux\n");
		expect(r.parsed).toEqual([
			{ name: "FOO", value: "bar" },
			{ name: "BAZ", value: "qux" },
		]);
		expect(r.skipped).toEqual([{ line: 2, reason: "missing '=' separator (or empty name)" }]);
	});

	it("skips lines with `=` at position 0 (no name)", () => {
		const r = parseDotEnv("=value\n");
		expect(r.parsed).toEqual([]);
		expect(r.skipped).toEqual([{ line: 1, reason: "missing '=' separator (or empty name)" }]);
	});

	it("rejects names that fail the POSIX regex", () => {
		const r = parseDotEnv("foo=lower\nFOO-BAR=dash\n0NUM=numstart\n");
		expect(r.parsed).toEqual([]);
		// All three skip with the regex-rejection reason.
		expect(r.skipped).toHaveLength(3);
		for (const s of r.skipped) {
			expect(s.reason).toMatch(/must match/);
		}
	});

	it("skips lines with an unterminated quote (multi-line out of scope)", () => {
		const r = parseDotEnv(`FOO="hello\nBAR=ok\n`);
		expect(r.parsed).toEqual([{ name: "BAR", value: "ok" }]);
		expect(r.skipped).toEqual([
			{ line: 1, reason: "unterminated double-quote (multi-line values not supported)" },
		]);
	});

	it("tolerates a trailing comment after a quoted value", () => {
		// The closing quote ends the value; everything after it is
		// dropped. A literal `#` inside the quotes is preserved.
		const r = parseDotEnv(`FOO="bar"   # description\nBAZ="x#y"\n`);
		expect(r.parsed).toEqual([
			{ name: "FOO", value: "bar" },
			{ name: "BAZ", value: "x#y" },
		]);
	});

	it("preserves a literal `#` in an unquoted value (trailing comments are ambiguous, kept verbatim)", () => {
		// URL fragments, shell-shifted tokens, etc. We don't second-
		// guess the user; the line was unquoted so we treat it as
		// "value is everything after `=`".
		const r = parseDotEnv("ANCHOR=https://example.com/page#section\n");
		expect(r.parsed).toEqual([{ name: "ANCHOR", value: "https://example.com/page#section" }]);
	});

	it("handles CRLF line endings (Windows .env files)", () => {
		const r = parseDotEnv("FOO=bar\r\nBAZ=qux\r\n");
		expect(r.parsed).toEqual([
			{ name: "FOO", value: "bar" },
			{ name: "BAZ", value: "qux" },
		]);
	});

	it("returns counts of parsed + skipped so the modal can summarise", () => {
		// "Imported 2, skipped 1 (line 2: missing =)" UX shape.
		const r = parseDotEnv("FOO=bar\ngarbage\nBAZ=qux\n");
		expect(r.parsed).toHaveLength(2);
		expect(r.skipped).toHaveLength(1);
	});
});
