/**
 * gitReadOnly.test.ts — parsers, validators and the argv the Git view
 * hands to git, against a scripted runner (no docker).
 */

import { describe, expect, it, vi } from "vitest";
import {
	attachNumstat,
	type CaptureResult,
	checkRepoLocation,
	classifyFailure,
	countPatchSections,
	GIT_DIFF_MAX_BYTES,
	GIT_MAX_STATUS_FILES,
	type GitRunner,
	getGitDiff,
	getGitLog,
	getGitStatus,
	gitArgv,
	isBinaryPatch,
	LOG_FORMAT,
	parseCandidates,
	parseLog,
	parseNumstat,
	parsePorcelainV2,
	parseRawZ,
	splitNulRecords,
	trimToLastLine,
	validateGitDir,
	validateGitPath,
} from "./gitReadOnly.js";

const ok = (stdout: string, extra: Partial<CaptureResult> = {}): CaptureResult => ({
	stdout: Buffer.from(stdout, "utf-8"),
	stderr: Buffer.alloc(0),
	exitCode: 0,
	truncated: false,
	timedOut: false,
	...extra,
});
const fail = (
	stderr: string,
	exitCode = 128,
	extra: Partial<CaptureResult> = {},
): CaptureResult => ({
	stdout: Buffer.alloc(0),
	stderr: Buffer.from(stderr, "utf-8"),
	exitCode,
	truncated: false,
	timedOut: false,
	...extra,
});

/** Runner that answers by git subcommand (first non-option arg after the `-c` pairs). */
function scripted(answers: Record<string, CaptureResult | ((argv: string[]) => CaptureResult)>) {
	const calls: string[][] = [];
	const runner: GitRunner = {
		run: vi.fn(async (argv: string[]) => {
			calls.push(argv);
			const key = keyOf(argv);
			const a = answers[key];
			if (a === undefined) throw new Error(`unscripted command: ${argv.join(" ")}`);
			return typeof a === "function" ? a(argv) : a;
		}),
		workspaceDir: WS,
	};
	return { runner, calls };
}

const WS = "/home/developer/workspace";
/** `rev-parse --show-toplevel --show-prefix` answer for a repo rooted at `dir`, cwd `prefix` below it. */
const at = (root: string, prefix = "") => ok(`${WS}${root === "" ? "" : `/${root}`}\n${prefix}\n`);
const rawM = (path: string) => `:100644 100644 abc def M${Z}${path}${Z}`;
const rawR = (oldPath: string, path: string) =>
	`:100644 100644 abc def R100${Z}${oldPath}${Z}${path}${Z}`;

function keyOf(argv: string[]): string {
	if (argv[0] === "find") return "find";
	// Skip `git`, `-C dir`, `-c k=v` pairs → subcommand (+ `--cached` / `--no-index` marker).
	let i = 1;
	while (argv[i] === "-C" || argv[i] === "-c") i += 2;
	const sub = argv[i] as string;
	if (sub === "diff") {
		const raw = argv.includes("--raw") ? " --raw" : "";
		if (argv.includes("--cached")) return `diff --cached${raw}`;
		if (argv.includes("--no-index")) return "diff --no-index";
		return `diff${raw}`;
	}
	return sub;
}

const Z = "\0";

describe("validateGitPath / validateGitDir", () => {
	it("accepts normalised repo-relative paths, including odd but legal names", () => {
		for (const p of ["a.ts", "src/x y/z.md", "-leading-dash", "*.ts", ":(top)x", "ünïcode/ñ.txt"]) {
			expect(validateGitPath(p)).toBe(p);
		}
	});
	it("rejects traversal, dot segments, absolute paths, NUL, trailing slash and empties", () => {
		for (const p of ["../x", "a/../b", "./a", "a/./b", "/etc/passwd", "a\0b", "a/", "", "a//b"]) {
			const r = validateGitPath(p);
			expect(typeof r).toBe("object");
			expect((r as { status: number }).status).toBe(400);
		}
		expect((validateGitPath(undefined) as { status: number }).status).toBe(400);
		expect((validateGitPath(["a", "b"]) as { status: number }).status).toBe(400);
	});
	it("dir: empty means workspace root, restricted dirs are 403, traversal 400", () => {
		expect(validateGitDir(undefined)).toBe("");
		expect(validateGitDir("")).toBe("");
		expect(validateGitDir("proj/")).toBe("proj");
		expect(validateGitDir("a/b")).toBe("a/b");
		expect((validateGitDir("../other") as { status: number }).status).toBe(400);
		expect((validateGitDir("/abs") as { status: number }).status).toBe(400);
		expect((validateGitDir(".git") as { status: number }).status).toBe(403);
		expect((validateGitDir("x/.ssh") as { status: number }).status).toBe(403);
	});
});

describe("gitArgv", () => {
	it("pins the config overrides and only adds -C for a sub-directory", () => {
		const root = gitArgv("", "status");
		expect(root[0]).toBe("git");
		expect(root).not.toContain("-C");
		expect(root).toContain("core.quotePath=false");
		expect(root).toContain("core.fsmonitor=false");
		expect(root).toContain("color.ui=never");
		expect(root[root.length - 1]).toBe("status");
		expect(gitArgv("proj", "status").slice(0, 3)).toEqual(["git", "-C", "proj"]);
	});
});

describe("splitNulRecords", () => {
	it("splits complete output and keeps an unterminated tail when not truncated", () => {
		expect(splitNulRecords(Buffer.from(`a${Z}b${Z}`), false)).toEqual(["a", "b"]);
		expect(splitNulRecords(Buffer.from(`a${Z}b`), false)).toEqual(["a", "b"]);
		expect(splitNulRecords(Buffer.alloc(0), false)).toEqual([]);
	});
	it("drops a partial trailing record when the output was cut", () => {
		expect(splitNulRecords(Buffer.from(`a${Z}b${Z}cut-mid-rec`), true)).toEqual(["a", "b"]);
	});
});

describe("parsePorcelainV2", () => {
	const headers = [
		"# branch.oid 0123456789abcdef0123456789abcdef01234567",
		"# branch.head feat/x",
		"# branch.upstream origin/feat/x",
		"# branch.ab +2 -1",
	];
	it("reads branch headers and tracked / renamed / untracked / conflict records", () => {
		const recs = [
			...headers,
			"1 .M N... 100644 100644 100644 abc def src/app.ts",
			"1 M. N... 100644 100644 100644 abc def staged only.ts",
			"1 MM N... 100644 100644 100644 abc def both.ts",
			"1 A. N... 000000 100644 100644 000 def added.ts",
			"1 .D N... 100644 100644 000000 abc 000 gone.ts",
			"2 R. N... 100644 100644 100644 abc def R100 new name.ts",
			"old name.ts",
			"u UU N... 100644 100644 100644 100644 a b c conflict.ts",
			"? untracked file.txt",
			"? .env",
		];
		const r = parsePorcelainV2(recs);
		expect(r).toMatchObject({
			branch: "feat/x",
			detached: false,
			head: "0123456789abcdef0123456789abcdef01234567",
			upstream: "origin/feat/x",
			ahead: 2,
			behind: 1,
		});
		const brief = r.changes.map(
			(c) => `${c.area}:${c.status}:${c.path}${c.oldPath ? `<${c.oldPath}` : ""}`,
		);
		expect(brief).toEqual([
			"unstaged:M:src/app.ts",
			"staged:M:staged only.ts",
			"staged:M:both.ts",
			"unstaged:M:both.ts",
			"staged:A:added.ts",
			"unstaged:D:gone.ts",
			"staged:R:new name.ts<old name.ts",
			"conflict:U:conflict.ts",
			"untracked:?:untracked file.txt",
			"untracked:?:.env",
		]);
		expect(r.changes.find((c) => c.path === "conflict.ts")?.xy).toBe("UU");
		// Credential-shaped paths are listed but flagged.
		expect(r.changes.find((c) => c.path === ".env")?.restricted).toBe(true);
		expect(r.changes.find((c) => c.path === "both.ts")?.restricted).toBe(false);
	});
	it("handles detached HEAD, an unborn branch and garbage records", () => {
		const r = parsePorcelainV2([
			"# branch.oid (initial)",
			"# branch.head (detached)",
			"1 .M",
			"2 R. N... 100644 100644 100644 abc def R100 only",
			"zzz",
		]);
		expect(r.head).toBeNull();
		expect(r.detached).toBe(true);
		expect(r.branch).toBeNull();
		expect(r.ahead).toBeNull();
		// Malformed `1` is skipped; the `2` without its orig record still lands.
		expect(r.changes.map((c) => c.path)).toEqual(["only"]);
	});
});

describe("parseNumstat / attachNumstat", () => {
	it("parses counts, binary markers and rename records", () => {
		const m = parseNumstat(["3\t1\ta.ts", "-\t-\timg.png", "0\t0\t", "old.ts", "new.ts", "junk"]);
		expect(m.get("a.ts")).toEqual({ additions: 3, deletions: 1, binary: false });
		expect(m.get("img.png")).toEqual({ additions: null, deletions: null, binary: true });
		expect(m.get("new.ts")).toEqual({ additions: 0, deletions: 0, binary: false });
		expect(m.has("old.ts")).toBe(false);
		expect(m.size).toBe(3);
	});
	it("attaches by area so a file modified in both index and worktree gets each side's counts", () => {
		const changes = parsePorcelainV2([
			"1 MM N... 100644 100644 100644 abc def both.ts",
			"? new.txt",
		]).changes;
		attachNumstat(
			changes,
			new Map([["both.ts", { additions: 5, deletions: 0, binary: false }]]),
			new Map([["both.ts", { additions: 1, deletions: 2, binary: false }]]),
		);
		expect(changes[0]).toMatchObject({ area: "staged", additions: 5, deletions: 0 });
		expect(changes[1]).toMatchObject({ area: "unstaged", additions: 1, deletions: 2 });
		expect(changes[2]).toMatchObject({ area: "untracked", additions: null, deletions: null });
	});
});

describe("parseLog", () => {
	const h = "a".repeat(40);
	it("parses records and keeps a subject with embedded separators intact-ish", () => {
		const recs = [
			`${h}\x1faaaaaaa\x1fAda\x1f2026-10-22T10:00:00+00:00\x1ffeat: thing`,
			`${h}\x1faaaaaaa\x1fEve <x>\x1f2026-10-22T10:00:00+00:00\x1fsub\x1fject\x1f`,
			"not a commit",
			`zzzz\x1fx\x1fy\x1fz\x1fw`,
		];
		const c = parseLog(recs);
		expect(c).toHaveLength(2);
		expect(c[0]).toEqual({
			hash: h,
			shortHash: "aaaaaaa",
			author: "Ada",
			date: "2026-10-22T10:00:00+00:00",
			subject: "feat: thing",
		});
		expect(c[1]?.subject).toBe("sub\x1fject\x1f");
	});
	it("LOG_FORMAT puts the subject last", () => {
		expect(LOG_FORMAT.endsWith("%s")).toBe(true);
	});
});

describe("patch helpers", () => {
	it("isBinaryPatch / trimToLastLine", () => {
		expect(isBinaryPatch("diff --git a/x b/x\nBinary files a/x and b/x differ\n")).toBe(true);
		expect(isBinaryPatch("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n")).toBe(
			false,
		);
		expect(trimToLastLine("a\nb\nc")).toBe("a\nb\n");
		expect(trimToLastLine("no newline")).toBe("");
	});
	it("parseCandidates maps find output to top-level dirs", () => {
		expect(parseCandidates(["./b/.git", "./a/.git", "./a/.git", "nope", "./x/y/.git"])).toEqual([
			"a",
			"b",
		]);
	});
});

describe("classifyFailure", () => {
	it("maps git's diagnostics to codes and scrubs URL credentials", () => {
		expect(
			classifyFailure(fail("fatal: not a git repository (or any parent)"), "git status").code,
		).toBe("not-a-repo");
		expect(classifyFailure(fail("fatal: detected dubious ownership in repository"), "x").code).toBe(
			"unsafe-repository",
		);
		expect(classifyFailure(fail("", 124, { timedOut: true }), "git diff").code).toBe("timeout");
		const e = classifyFailure(fail("error: https://user:s3cret@host/x failed\nmore"), "git log");
		expect(e.code).toBe("git-failed");
		expect(e.message).toContain("https://***@host/x");
		expect(e.message).not.toContain("s3cret");
		expect(e.message).not.toContain("more");
	});
});

describe("getGitStatus", () => {
	const status = [
		"# branch.oid abc",
		"# branch.head main",
		"1 .M N... 100644 100644 100644 abc def a.ts",
		"? n.txt",
	].join(Z);
	it("runs the four reads in parallel at the repo root and folds numstat in", async () => {
		const { runner, calls } = scripted({
			status: ok(`${status}${Z}`),
			"diff --cached": ok(""),
			diff: ok(`2\t1\ta.ts${Z}`),
			"rev-parse": at(""),
		});
		const r = await getGitStatus(runner, "");
		expect(r.repo).toBe(true);
		if (!r.repo) throw new Error("unreachable");
		expect(r.root).toBe("");
		expect(r.branch).toBe("main");
		expect(r.changes).toHaveLength(2);
		expect(r.changes[0]).toMatchObject({
			path: "a.ts",
			area: "unstaged",
			additions: 2,
			deletions: 1,
		});
		expect(r.truncated).toBe(false);
		expect(calls).toHaveLength(4);
		const st = calls.find((c) => keyOf(c) === "status") as string[];
		expect(st).toContain("--porcelain=v2");
		expect(st).toContain("-z");
		expect(st).toContain("--untracked-files=all");
		for (const c of calls.filter((c) => keyOf(c).startsWith("diff"))) {
			expect(c).toContain("--no-ext-diff");
			expect(c).toContain("--no-textconv");
		}
	});
	it("reports the repo root when `dir` points inside a repository", async () => {
		const { runner, calls } = scripted({
			status: ok(`# branch.head main${Z}`),
			"diff --cached": ok(""),
			diff: ok(""),
			"rev-parse": at("proj", "src/lib/"),
		});
		const r = await getGitStatus(runner, "proj/src/lib");
		expect(r).toMatchObject({ repo: true, root: "proj" });
		for (const c of calls) expect(c.slice(0, 3)).toEqual(["git", "-C", "proj/src/lib"]);
	});
	it("answers repo:false with one-level candidates at the workspace root", async () => {
		const { runner, calls } = scripted({
			status: fail("fatal: not a git repository (or any of the parent directories): .git"),
			"diff --cached": fail("fatal: not a git repository"),
			diff: fail("fatal: not a git repository"),
			"rev-parse": fail("fatal: not a git repository"),
			find: ok(`./proj-b/.git${Z}./proj-a/.git${Z}`),
		});
		expect(await getGitStatus(runner, "")).toEqual({
			repo: false,
			candidates: ["proj-a", "proj-b"],
		});
		const find = calls.find((c) => c[0] === "find") as string[];
		expect(find).toEqual([
			"find",
			".",
			"-mindepth",
			"2",
			"-maxdepth",
			"2",
			"-name",
			".git",
			"-print0",
		]);
	});
	it("does not scan for candidates below the root", async () => {
		const { runner, calls } = scripted({
			status: fail("fatal: not a git repository"),
			"diff --cached": fail("x"),
			diff: fail("x"),
			"rev-parse": fail("x"),
		});
		expect(await getGitStatus(runner, "sub")).toEqual({ repo: false, candidates: [] });
		expect(calls.some((c) => c[0] === "find")).toBe(false);
	});
	it("surfaces timeouts and unsafe repositories as GitError", async () => {
		const t = scripted({
			status: fail("", 124, { timedOut: true }),
			"diff --cached": ok(""),
			diff: ok(""),
			"rev-parse": at(""),
		});
		await expect(getGitStatus(t.runner, "")).rejects.toMatchObject({ code: "timeout" });
		const u = scripted({
			status: fail("fatal: detected dubious ownership in repository at '/x'"),
			"diff --cached": ok(""),
			diff: ok(""),
			"rev-parse": at(""),
		});
		await expect(getGitStatus(u.runner, "")).rejects.toMatchObject({ code: "unsafe-repository" });
	});
	it("caps the change list and flags truncation", async () => {
		const many = Array.from({ length: GIT_MAX_STATUS_FILES + 5 }, (_, i) => `? f${i}`).join(Z);
		const { runner } = scripted({
			status: ok(`# branch.head main${Z}${many}${Z}`),
			"diff --cached": ok(""),
			diff: ok(""),
			"rev-parse": at(""),
		});
		const r = await getGitStatus(runner, "");
		if (!r.repo) throw new Error("unreachable");
		expect(r.changes).toHaveLength(GIT_MAX_STATUS_FILES);
		expect(r.truncated).toBe(true);
	});
});

describe("repository location (G1: `dir` through a symlink / redirected worktree)", () => {
	it("checkRepoLocation accepts the lexical location and rejects everything else", () => {
		expect(checkRepoLocation(WS, "", `${WS}\n\n`)).toBe("");
		expect(checkRepoLocation(WS, "proj", `${WS}/proj\n\n`)).toBe("");
		expect(checkRepoLocation(WS, "proj/src", `${WS}/proj\nsrc/\n`)).toBe("src/");
		const bad = (dir: string, out: string) =>
			expect(() => checkRepoLocation(WS, dir, out)).toThrow(
				expect.objectContaining({ code: "outside-workspace" }),
			);
		bad("alias", "/home/developer/.st\n\n"); // symlink out of the workspace
		bad("link", `${WS}/proj\n\n`); // symlink to a sibling inside it
		bad("proj/src", `${WS}/other\nsrc/\n`);
		bad("", "/\nhome/developer/workspace/\n"); // core.worktree=/
		bad("", "\n\n"); // nothing to verify
	});
	it("status refuses (and returns nothing) when the repo is not where dir says", async () => {
		const { runner } = scripted({
			status: ok(`# branch.head main${Z}1 .M N... 100644 100644 100644 a b notes.txt${Z}`),
			"diff --cached": ok(""),
			diff: ok(""),
			"rev-parse": ok("/home/developer/.st\n\n"),
		});
		await expect(getGitStatus(runner, "alias")).rejects.toMatchObject({
			code: "outside-workspace",
		});
	});
	it("status treats a failing rev-parse as an error, not as root=dir", async () => {
		const { runner } = scripted({
			status: ok(`# branch.head main${Z}`),
			"diff --cached": ok(""),
			diff: ok(""),
			"rev-parse": fail("fatal: this operation must be run in a work tree"),
		});
		await expect(getGitStatus(runner, "")).rejects.toMatchObject({ code: "git-failed" });
	});
	it("log and diff check the location before answering", async () => {
		const { runner, calls } = scripted({
			"rev-parse": ok("/home/developer/.st\n\n"),
			log: ok(""),
			"diff --raw": ok(rawM("a.ts")),
			diff: ok("x"),
		});
		await expect(getGitLog(runner, "alias")).rejects.toMatchObject({ code: "outside-workspace" });
		await expect(
			getGitDiff(runner, "alias", { path: "a.ts", oldPath: null, area: "unstaged" }),
		).rejects.toMatchObject({ code: "outside-workspace" });
		expect(calls.filter((c) => keyOf(c) === "rev-parse")).toHaveLength(2);
		// No patch was produced.
		expect(calls.some((c) => keyOf(c) === "diff")).toBe(false);
	});
});

describe("parseRawZ / countPatchSections", () => {
	it("parses M / A / D, renames with two paths, and combined (conflict) records", () => {
		const recs = splitNulRecords(
			Buffer.from(
				`${rawM("a b.ts")}:000000 100644 0 1 A${Z}new${Z}${rawR("old", "new name")}::100644 100644 100644 1 2 0 MM${Z}conf.txt${Z}`,
			),
			false,
		);
		expect(parseRawZ(recs)).toEqual([
			{ status: "M", path: "a b.ts", oldPath: null },
			{ status: "A", path: "new", oldPath: null },
			{ status: "R", path: "new name", oldPath: "old" },
			{ status: "M", path: "conf.txt", oldPath: null },
		]);
		expect(parseRawZ([])).toEqual([]);
		// A cut record (header without its path) ends the parse.
		expect(parseRawZ([":100644 100644 a b M"])).toEqual([]);
	});
	it("counts file sections only from header lines, never from content", () => {
		expect(countPatchSections("")).toBe(0);
		expect(countPatchSections("diff --git a/x b/x\n@@ -1 +1 @@\n-diff --git a/y b/y\n+x\n")).toBe(
			1,
		);
		expect(countPatchSections("diff --cc f\n@@@ -1 -1 +1 @@@\n++x\n")).toBe(1);
		expect(countPatchSections("diff --git a/x b/x\n+a\ndiff --git a/y b/y\n+b\n")).toBe(2);
	});
});

describe("getGitDiff", () => {
	const located = { "rev-parse": at("") };
	it("staged / unstaged use literal top-level pathspecs after --, after identifying the file", async () => {
		const { runner, calls } = scripted({
			...located,
			"rev-parse": (argv) => (argv[1] === "-C" ? at("p") : at("")),
			diff: ok("patch\n"),
			"diff --cached": ok("cached\n"),
			"diff --raw": ok(rawM("-rf")),
			"diff --cached --raw": ok(rawR("old.ts", "new.ts")),
		});
		await getGitDiff(runner, "", { path: "-rf", oldPath: null, area: "unstaged" });
		await getGitDiff(runner, "p", { path: "new.ts", oldPath: "old.ts", area: "staged" });
		const unstaged = calls.find((c) => keyOf(c) === "diff") as string[];
		expect(unstaged.slice(-2)).toEqual(["--", ":(top,literal)-rf"]);
		expect(unstaged).not.toContain("--cached");
		const identify = calls.find((c) => keyOf(c) === "diff --raw") as string[];
		expect(identify).toContain("-z");
		expect(identify.slice(-2)).toEqual(["--", ":(top,literal)-rf"]);
		const staged = calls.find((c) => keyOf(c) === "diff --cached") as string[];
		expect(staged.slice(0, 3)).toEqual(["git", "-C", "p"]);
		expect(staged).toContain("--cached");
		expect(staged.slice(-3)).toEqual(["--", ":(top,literal)old.ts", ":(top,literal)new.ts"]);
		// Nothing client-supplied appears before the `--`.
		const dd = staged.indexOf("--");
		expect(staged.slice(0, dd)).not.toContain("new.ts");
	});
	it("an unmerged path (reported twice by --raw, U then M) still counts as one file", async () => {
		const { runner, calls } = scripted({
			...located,
			"diff --raw": ok(`:000000 100644 0 0 U${Z}f.txt${Z}${rawM("f.txt")}`),
			diff: ok("diff --cc f.txt\n@@@ -1,2 -1,2 +1,6 @@@\n++<<<<<<< HEAD\n"),
		});
		const r = await getGitDiff(runner, "", { path: "f.txt", oldPath: null, area: "conflict" });
		expect(r.patch).toContain("diff --cc f.txt");
		expect((calls.find((c) => keyOf(c) === "diff") as string[]).slice(-2)).toEqual([
			"--",
			":(top,literal)f.txt",
		]);
	});
	it("the patch pathspecs are the names GIT reported, not the client's hint", async () => {
		// Client says "renamed from old.ts"; git says it's a plain addition.
		const { runner, calls } = scripted({
			...located,
			"diff --cached": ok(""),
			"diff --cached --raw": ok(":000000 100644 0 1 A\0new.ts\0"),
		});
		await getGitDiff(runner, "", { path: "new.ts", oldPath: "old.ts", area: "staged" });
		const patch = calls.find((c) => keyOf(c) === "diff --cached") as string[];
		expect(patch.slice(-2)).toEqual(["--", ":(top,literal)new.ts"]);
	});
	it("refuses a pathspec that is not exactly one file (a directory, several entries, the wrong one)", async () => {
		const cases = [rawM("src/.env") + rawM("src/app.ts"), rawM("src/.env"), ""];
		const expected = ["not-a-single-file", "not-a-single-file", null];
		for (let i = 0; i < cases.length; i++) {
			const { runner, calls } = scripted({
				...located,
				"diff --raw": ok(cases[i] as string),
				diff: ok("must not run"),
			});
			const p = getGitDiff(runner, "", { path: "src", oldPath: null, area: "unstaged" });
			if (expected[i] === null) {
				expect(await p).toMatchObject({ patch: "", truncated: false, binary: false });
			} else {
				await expect(p).rejects.toMatchObject({ code: expected[i] });
			}
			expect(calls.some((c) => keyOf(c) === "diff")).toBe(false);
		}
		// Identification output cut by the cap = certainly many files.
		const { runner } = scripted({
			...located,
			"diff --raw": ok(rawM("src"), { truncated: true }),
		});
		await expect(
			getGitDiff(runner, "", { path: "src", oldPath: null, area: "unstaged" }),
		).rejects.toMatchObject({ code: "not-a-single-file" });
	});
	it("applies the denylist to the old side of a rename git reports", async () => {
		const { runner, calls } = scripted({
			...located,
			"diff --cached --raw": ok(rawR(".env", "settings.txt")),
			"diff --cached": ok("must not run"),
		});
		await expect(
			getGitDiff(runner, "", { path: "settings.txt", oldPath: null, area: "staged" }),
		).rejects.toMatchObject({ code: "restricted" });
		expect(calls.some((c) => keyOf(c) === "diff --cached")).toBe(false);
	});
	it("refuses a patch that spans more than one file", async () => {
		const { runner } = scripted({
			...located,
			"diff --raw": ok(rawM("src")),
			diff: ok("diff --git a/src b/src\n+a\ndiff --git a/src/.env b/src/.env\n+S=1\n"),
		});
		await expect(
			getGitDiff(runner, "", { path: "src", oldPath: null, area: "unstaged" }),
		).rejects.toMatchObject({ code: "not-a-single-file" });
	});
	it("untracked diffs against /dev/null with --no-index and accepts exit 1 — after ls-files lists it", async () => {
		const { runner, calls } = scripted({
			...located,
			"ls-files": ok(`n.txt${Z}`),
			"diff --no-index": ok("diff --git a/n b/n\n+x\n", { exitCode: 1 }),
		});
		const r = await getGitDiff(runner, "", { path: "n.txt", oldPath: null, area: "untracked" });
		expect(r.patch).toContain("+x");
		const ls = calls.find((c) => keyOf(c) === "ls-files") as string[];
		expect(ls).toEqual(
			expect.arrayContaining(["--others", "--exclude-standard", "-z", "--", ":(top,literal)n.txt"]),
		);
		expect((calls.find((c) => keyOf(c) === "diff --no-index") as string[]).slice(-3)).toEqual([
			"--",
			"/dev/null",
			"n.txt",
		]);
	});
	it("untracked: not listed by git → empty, listed as a directory → refused, never read", async () => {
		const hidden = scripted({ ...located, "ls-files": ok(""), "diff --no-index": ok("leak") });
		expect(
			await getGitDiff(hidden.runner, "", { path: "alias/x", oldPath: null, area: "untracked" }),
		).toMatchObject({ patch: "" });
		const dir = scripted({
			...located,
			"ls-files": ok(`d/a${Z}d/b${Z}`),
			"diff --no-index": ok("leak"),
		});
		await expect(
			getGitDiff(dir.runner, "", { path: "d", oldPath: null, area: "untracked" }),
		).rejects.toMatchObject({ code: "not-a-single-file" });
		for (const s of [hidden, dir]) {
			expect(s.calls.some((c) => keyOf(c) === "diff --no-index")).toBe(false);
		}
	});
	it("flags binary patches and trims a truncated patch to whole lines", async () => {
		const { runner } = scripted({
			...located,
			"diff --raw": (argv) => ok(rawM((argv[argv.length - 1] as string).slice(14))),
			diff: (argv) =>
				argv.some((a) => a.endsWith("img.png"))
					? ok("diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n")
					: ok("@@ -1 +1 @@\n-a\n+b\n+cut-mid", { truncated: true, exitCode: null }),
		});
		const b = await getGitDiff(runner, "", { path: "img.png", oldPath: null, area: "unstaged" });
		expect(b.binary).toBe(true);
		const t = await getGitDiff(runner, "", { path: "big.ts", oldPath: null, area: "unstaged" });
		expect(t.truncated).toBe(true);
		expect(t.patch).toBe("@@ -1 +1 @@\n-a\n+b\n");
		expect(GIT_DIFF_MAX_BYTES).toBeGreaterThan(0);
	});
	it("a truncated patch is the answer even when git was later killed by timeout", async () => {
		const { runner } = scripted({
			"rev-parse": at(""),
			"diff --raw": ok(rawM("x")),
			diff: ok("@@ -1 +1 @@\n+a\n+b", { truncated: true, timedOut: true, exitCode: 124 }),
		});
		const r = await getGitDiff(runner, "", { path: "x", oldPath: null, area: "unstaged" });
		expect(r).toMatchObject({ truncated: true, patch: "@@ -1 +1 @@\n+a\n" });
	});
	it("maps a failing diff to GitError", async () => {
		const { runner } = scripted({
			"rev-parse": at(""),
			"diff --raw": ok(rawM("x")),
			diff: fail("fatal: bad revision"),
		});
		await expect(
			getGitDiff(runner, "", { path: "x", oldPath: null, area: "unstaged" }),
		).rejects.toMatchObject({ code: "git-failed" });
	});
});

describe("getGitLog", () => {
	it("parses -z records and treats an unborn HEAD as no commits", async () => {
		const h = "b".repeat(40);
		const { runner, calls } = scripted({
			"rev-parse": at(""),
			log: ok(`${h}\x1fbbbbbbb\x1fAda\x1f2026-01-01T00:00:00+00:00\x1fmsg${Z}`),
		});
		const commits = await getGitLog(runner, "");
		expect(commits).toEqual([
			{
				hash: h,
				shortHash: "bbbbbbb",
				author: "Ada",
				date: "2026-01-01T00:00:00+00:00",
				subject: "msg",
			},
		]);
		expect(calls.find((c) => keyOf(c) === "log")).toContain("--no-show-signature");
		const empty = scripted({
			"rev-parse": at(""),
			log: fail("fatal: your current branch 'main' does not have any commits yet"),
		});
		expect(await getGitLog(empty.runner, "")).toEqual([]);
		const broken = scripted({ "rev-parse": at(""), log: fail("fatal: something else") });
		await expect(getGitLog(broken.runner, "")).rejects.toMatchObject({ code: "git-failed" });
		// Not a repository at all: rev-parse and log both say so → not-a-repo.
		const none = scripted({
			"rev-parse": fail("fatal: not a git repository"),
			log: fail("fatal: not a git repository (or any of the parent directories): .git"),
		});
		await expect(getGitLog(none.runner, "")).rejects.toMatchObject({ code: "not-a-repo" });
	});
});
