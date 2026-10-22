import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./diff.js";

const PATCH = [
	"diff --git a/src/app.ts b/src/app.ts",
	"index 1111111..2222222 100644",
	"--- a/src/app.ts",
	"+++ b/src/app.ts",
	"@@ -1,4 +1,5 @@",
	" const a = 1;",
	"-const b = 2;",
	"+const b = 3;",
	"+const c = 4;",
	" export {};",
	"@@ -10,2 +11,2 @@ function f() {",
	"-old",
	"+new",
	"\\ No newline at end of file",
	"",
].join("\n");

describe("parseUnifiedDiff", () => {
	it("numbers context/add/del lines per hunk and counts changes", () => {
		const d = parseUnifiedDiff(PATCH);
		expect(d.hasHunks).toBe(true);
		expect(d.additions).toBe(3);
		expect(d.deletions).toBe(2);
		const brief = d.rows.map((r) => `${r.kind}:${r.oldNo ?? "-"}:${r.newNo ?? "-"}:${r.text}`);
		expect(brief).toEqual([
			"meta:-:-:diff --git a/src/app.ts b/src/app.ts",
			"meta:-:-:index 1111111..2222222 100644",
			"meta:-:-:--- a/src/app.ts",
			"meta:-:-:+++ b/src/app.ts",
			"hunk:-:-:@@ -1,4 +1,5 @@",
			"context:1:1:const a = 1;",
			"del:2:-:const b = 2;",
			"add:-:2:const b = 3;",
			"add:-:3:const c = 4;",
			"context:3:4:export {};",
			"hunk:-:-:@@ -10,2 +11,2 @@ function f() {",
			"del:10:-:old",
			"add:-:11:new",
			"note:-:-:No newline at end of file",
		]);
	});

	it("handles an empty patch, a header-only patch and a trailing newline", () => {
		expect(parseUnifiedDiff("")).toEqual({ rows: [], additions: 0, deletions: 0, hasHunks: false });
		const headerOnly = parseUnifiedDiff(
			"diff --git a/x b/x\nsimilarity index 100%\nrename from x\nrename to y\n",
		);
		expect(headerOnly.hasHunks).toBe(false);
		expect(headerOnly.rows).toHaveLength(4);
		expect(headerOnly.rows.every((r) => r.kind === "meta")).toBe(true);
	});

	it("treats a second `diff --git` as a new file header and keeps odd lines visible", () => {
		const d = parseUnifiedDiff("@@ -1 +1 @@\n-a\n+b\ndiff --git a/y b/y\n@@ -1 +1 @@\n+c\nweird\n");
		expect(d.rows.map((r) => r.kind)).toEqual([
			"hunk",
			"del",
			"add",
			"meta",
			"hunk",
			"add",
			"context",
		]);
		expect(d.rows[6]?.text).toBe("weird");
	});

	it("parses git's combined diff for a conflicted file (@@@ hunks, one marker column per parent)", () => {
		const combined = [
			"diff --cc f.txt",
			"index c529826,e9ffce5..0000000",
			"--- a/f.txt",
			"+++ b/f.txt",
			"@@@ -1,4 -1,3 +1,8 @@@",
			"  l1",
			"++<<<<<<< HEAD",
			" +OURS",
			"++=======",
			"+ THEIRS",
			"++>>>>>>> other",
			"  l3",
			" +l4",
			"- gone",
			"",
		].join("\n");
		const d = parseUnifiedDiff(combined);
		expect(d.hasHunks).toBe(true);
		const brief = d.rows.map((r) => `${r.kind}:${r.oldNo ?? "-"}:${r.newNo ?? "-"}:${r.text}`);
		expect(brief).toEqual([
			"meta:-:-:diff --cc f.txt",
			"meta:-:-:index c529826,e9ffce5..0000000",
			"meta:-:-:--- a/f.txt",
			"meta:-:-:+++ b/f.txt",
			"hunk:-:-:@@@ -1,4 -1,3 +1,8 @@@",
			"context:1:1:l1",
			"add:-:2:<<<<<<< HEAD",
			// In HEAD (first column blank) and in the result: numbered on both sides.
			"add:2:3:OURS",
			"add:-:4:=======",
			"add:-:5:THEIRS",
			"add:-:6:>>>>>>> other",
			"context:3:7:l3",
			"add:4:8:l4",
			"del:5:-:gone",
		]);
		expect(d.additions).toBe(6);
		expect(d.deletions).toBe(1);
	});

	it("is linear on adversarial input (long lines, many hunks)", () => {
		const big = `@@ -1 +1 @@\n${"+".repeat(1)}${"x".repeat(100_000)}\n`.repeat(50);
		const t0 = performance.now();
		const d = parseUnifiedDiff(big);
		expect(performance.now() - t0).toBeLessThan(500);
		expect(d.additions).toBe(50);
	});
});
