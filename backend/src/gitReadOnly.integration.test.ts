/**
 * gitReadOnly.integration.test.ts — the EXACT argv + env the Git view
 * sends to the session container, run against a real `git` on a
 * throwaway repository. The unit tests pin what we parse; this pins that
 * git (2.43 in the session image's Ubuntu 24.04) really emits it:
 * porcelain v2 `-z` record shapes, numstat rename records, `:(top,literal)`
 * pathspecs, `--no-index` exit codes, `-z` log records.
 *
 * Docker isn't involved: the runner spawns git locally with the same
 * argv/env `makeGitRunner` would hand to execCapture. Skipped when no
 * `git` binary is on PATH.
 */

import { spawnSync } from "node:child_process";
import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type CaptureResult,
	countPatchSections,
	GIT_ENV,
	type GitRunner,
	getGitDiff,
	getGitLog,
	getGitStatus,
} from "./gitReadOnly.js";

const HAVE_GIT = spawnSync("git", ["--version"]).status === 0;
const d = HAVE_GIT ? describe : describe.skip;

let workspace: string;

// Mirrors execCapture: same env, cwd = the workspace, byte cap on stdout.
function localRunner(): GitRunner {
	return {
		workspaceDir: realpathSync(workspace),
		run: async (argv, maxBytes): Promise<CaptureResult> => {
			const r = spawnSync(argv[0] as string, argv.slice(1), {
				cwd: workspace,
				env: {
					...process.env,
					...GIT_ENV,
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_NOSYSTEM: "1",
				},
				maxBuffer: 64 * 1024 * 1024,
			});
			const stdout = r.stdout ?? Buffer.alloc(0);
			return {
				stdout: stdout.subarray(0, maxBytes),
				stderr: r.stderr ?? Buffer.alloc(0),
				exitCode: r.status,
				truncated: stdout.length > maxBytes,
				timedOut: false,
			};
		},
	};
}

function git(cwd: string, ...args: string[]): string {
	const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@x", ...args], {
		cwd,
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
	});
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString();
}

beforeAll(async () => {
	if (!HAVE_GIT) return;
	workspace = mkdtempSync(path.join(os.tmpdir(), "st-git-int-"));
	const w = (p: string, c: string | Buffer) => fs.writeFile(path.join(workspace, p), c);
	git(workspace, "init", "-q", "-b", "main");
	await fs.mkdir(path.join(workspace, "src"), { recursive: true });
	await w("src/app.ts", "a\nb\nc\n");
	await w("README.md", "# hi\n");
	await w("old name.md", "same\n");
	await w("img.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
	await w("-rf", "dash\n");
	await w("ünï cödé.txt", "u\n");
	await w(".env", "SECRET=1\n");
	git(workspace, "add", "-A");
	git(workspace, "commit", "-q", "-m", "init\x1fwith separator");
	git(workspace, "commit", "-q", "--allow-empty", "-m", "second");
	// Staged: rename + new file. Unstaged: modify app.ts (and stage part of
	// it so it's MM), modify binary, modify "-rf". Untracked: new.txt.
	git(workspace, "mv", "old name.md", "new name.md");
	await w("src/added.ts", "x\n");
	git(workspace, "add", "src/added.ts");
	await w("src/app.ts", "a\nB\nc\n");
	git(workspace, "add", "src/app.ts");
	await w("src/app.ts", "a\nB\nc\nd\n");
	await w("img.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9, 9]));
	await w("-rf", "dash\nmore\n");
	await w("new.txt", "hello\nworld\n");
	await w(".env", "SECRET=2\n");
	// A second repo one level down, for the candidates scan.
	await fs.mkdir(path.join(workspace, "sub"), { recursive: true });
	git(path.join(workspace, "sub"), "init", "-q");
	// Not a repo at all.
	await fs.mkdir(path.join(workspace, "plain"), { recursive: true });
	// G1 fixtures: a restricted directory reachable through a symlinked
	// parent, and an untracked symlink to a file outside the tree.
	await fs.mkdir(path.join(workspace, ".st"), { recursive: true });
	await w(".st/notes.txt", "token=abc\n");
	await fs.symlink(".st", path.join(workspace, "alias"));
	await fs.symlink("/etc/hostname", path.join(workspace, "linkfile"));
	// A nested repo with an unresolved merge conflict (G4), and one with a
	// staged rename away from a restricted name (G1).
	const conf = path.join(workspace, "conf");
	await fs.mkdir(conf, { recursive: true });
	git(conf, "init", "-q", "-b", "main");
	await fs.writeFile(path.join(conf, "f.txt"), "l1\nl2\nl3\n");
	git(conf, "add", "f.txt");
	git(conf, "commit", "-qm", "base");
	git(conf, "checkout", "-qb", "other");
	await fs.writeFile(path.join(conf, "f.txt"), "l1\nTHEIRS\nl3\n");
	git(conf, "commit", "-qam", "theirs");
	git(conf, "checkout", "-q", "main");
	await fs.writeFile(path.join(conf, "f.txt"), "l1\nOURS\nl3\nl4\n");
	git(conf, "commit", "-qam", "ours");
	// Exits 1 on the conflict — that's the fixture.
	spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@x", "merge", "other"], {
		cwd: conf,
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
	});
	const ren = path.join(workspace, "ren");
	await fs.mkdir(ren, { recursive: true });
	git(ren, "init", "-q", "-b", "main");
	await fs.writeFile(path.join(ren, ".env"), "TOKEN=hunter2\n");
	git(ren, "add", "-A");
	git(ren, "commit", "-qm", "init");
	git(ren, "mv", ".env", "settings.txt");
});

afterAll(async () => {
	if (workspace) await fs.rm(workspace, { recursive: true, force: true });
});

d("against real git", () => {
	it("status: branch, areas, renames, binary, untracked, restricted, odd names", async () => {
		const r = await getGitStatus(localRunner(), "");
		expect(r.repo).toBe(true);
		if (!r.repo) return;
		expect(r.root).toBe("");
		expect(r.branch).toBe("main");
		expect(r.detached).toBe(false);
		expect(r.head).toMatch(/^[0-9a-f]{40}$/);
		const by = (area: string, p: string) => r.changes.find((c) => c.area === area && c.path === p);
		expect(by("staged", "new name.md")).toMatchObject({
			status: "R",
			oldPath: "old name.md",
			additions: 0,
			deletions: 0,
		});
		expect(by("staged", "src/added.ts")).toMatchObject({ status: "A", additions: 1, deletions: 0 });
		expect(by("staged", "src/app.ts")).toMatchObject({ status: "M", additions: 1, deletions: 1 });
		expect(by("unstaged", "src/app.ts")).toMatchObject({ status: "M", additions: 1, deletions: 0 });
		expect(by("unstaged", "img.png")).toMatchObject({ status: "M", binary: true, additions: null });
		expect(by("unstaged", "-rf")).toMatchObject({ status: "M", additions: 1 });
		expect(by("unstaged", ".env")).toMatchObject({ status: "M", restricted: true });
		expect(by("untracked", "new.txt")).toMatchObject({ status: "?", additions: null });
		// A nested repository shows as one untracked directory entry, not
		// its contents; an unchanged file with a non-ASCII name is absent
		// (and would arrive unquoted — core.quotePath=false + -z).
		expect(by("untracked", "sub/")).toMatchObject({ status: "?" });
		expect(r.changes.some((c) => c.path.includes("cödé"))).toBe(false);
		expect(r.changes.some((c) => c.path.includes("\\"))).toBe(false);
	});

	it("status inside a sub-directory of the repo reports the real root", async () => {
		const r = await getGitStatus(localRunner(), "src");
		expect(r).toMatchObject({ repo: true, root: "" });
	});

	it("not a repo: a plain dir answers repo:false; the workspace root lists candidates", async () => {
		const noRepo = mkdtempSync(path.join(os.tmpdir(), "st-git-norepo-"));
		const saved = workspace;
		try {
			workspace = noRepo;
			await fs.mkdir(path.join(noRepo, "proj"), { recursive: true });
			git(path.join(noRepo, "proj"), "init", "-q");
			await fs.mkdir(path.join(noRepo, "plain"), { recursive: true });
			// A symlink to a repo elsewhere must not be followed by the scan.
			await fs.symlink(saved, path.join(noRepo, "linked"));
			expect(await getGitStatus(localRunner(), "")).toEqual({ repo: false, candidates: ["proj"] });
			expect(await getGitStatus(localRunner(), "plain")).toEqual({ repo: false, candidates: [] });
			expect(await getGitStatus(localRunner(), "proj")).toMatchObject({ repo: true, root: "proj" });
			// G1: `-C linked` lands git in the OTHER workspace's repository;
			// its real toplevel isn't <workspace>/linked, so nothing is served.
			const outside = { code: "outside-workspace" };
			await expect(getGitStatus(localRunner(), "linked")).rejects.toMatchObject(outside);
			await expect(getGitLog(localRunner(), "linked")).rejects.toMatchObject(outside);
			await expect(
				getGitDiff(localRunner(), "linked", {
					path: "src/app.ts",
					oldPath: null,
					area: "unstaged",
				}),
			).rejects.toMatchObject(outside);
		} finally {
			workspace = saved;
			await fs.rm(noRepo, { recursive: true, force: true });
		}
	});

	it("diff: staged, unstaged, rename, dash-named file, untracked (--no-index), binary", async () => {
		const run = localRunner();
		const staged = await getGitDiff(run, "", { path: "src/app.ts", oldPath: null, area: "staged" });
		expect(staged.patch).toContain("-b\n+B\n");
		expect(staged.patch).not.toContain("+d\n");
		const unstaged = await getGitDiff(run, "", {
			path: "src/app.ts",
			oldPath: null,
			area: "unstaged",
		});
		expect(unstaged.patch).toContain("+d\n");
		expect(unstaged.patch).not.toContain("+B\n");
		const rename = await getGitDiff(run, "", {
			path: "new name.md",
			oldPath: "old name.md",
			area: "staged",
		});
		expect(rename.patch).toMatch(/rename from old name.md\nrename to new name.md/);
		const dash = await getGitDiff(run, "", { path: "-rf", oldPath: null, area: "unstaged" });
		expect(dash.patch).toContain("+more\n");
		const untracked = await getGitDiff(run, "", {
			path: "new.txt",
			oldPath: null,
			area: "untracked",
		});
		expect(untracked.patch).toContain("+hello\n+world\n");
		expect(untracked.binary).toBe(false);
		const bin = await getGitDiff(run, "", { path: "img.png", oldPath: null, area: "unstaged" });
		expect(bin.binary).toBe(true);
		// A glob-looking name is literal: no file is called `*.ts`, so the
		// diff is empty rather than matching src/*.ts.
		const glob = await getGitDiff(run, "", { path: "*.ts", oldPath: null, area: "unstaged" });
		expect(glob.patch).toBe("");
	});

	it("G1: a directory pathspec is refused, so src/.env is never diffed through `src`", async () => {
		const run = localRunner();
		// Unstaged: src/app.ts and src/.env are both modified under src/.
		await expect(
			getGitDiff(run, "", { path: "src", oldPath: null, area: "unstaged" }),
		).rejects.toMatchObject({ code: "not-a-single-file" });
		// Staged: src/added.ts and src/app.ts.
		await expect(
			getGitDiff(run, "", { path: "src", oldPath: null, area: "staged" }),
		).rejects.toMatchObject({ code: "not-a-single-file" });
		// An oldPath hint naming another changed file is not honoured.
		await expect(
			getGitDiff(run, "", { path: "src/app.ts", oldPath: "new name.md", area: "staged" }),
		).rejects.toMatchObject({ code: "not-a-single-file" });
		// Untracked directory: `newdir` holds files → refused as well.
		await fs.mkdir(path.join(workspace, "newdir"), { recursive: true });
		await fs.writeFile(path.join(workspace, "newdir", "f.txt"), "hi\n");
		await expect(
			getGitDiff(run, "", { path: "newdir", oldPath: null, area: "untracked" }),
		).rejects.toMatchObject({ code: "not-a-single-file" });
		// A deliberately-named restricted file under it is listed as such.
		const st = await getGitStatus(run, "");
		if (!st.repo) throw new Error("unreachable");
		expect(st.changes.find((c) => c.path === "newdir/f.txt")).toMatchObject({ area: "untracked" });
	});

	it("G1: a path behind a symlinked directory is not read, and a symlink shows its target", async () => {
		const run = localRunner();
		// `git diff --no-index` alone WOULD follow alias → .st and print
		// the token; the identification step (ls-files --others, which
		// never descends into a symlink) sees no such untracked file.
		const r = await getGitDiff(run, "", {
			path: "alias/notes.txt",
			oldPath: null,
			area: "untracked",
		});
		expect(r.patch).toBe("");
		// .st/notes.txt by its real name is listed but restricted.
		const st = await getGitStatus(run, "");
		if (!st.repo) throw new Error("unreachable");
		expect(st.changes.find((c) => c.path === ".st/notes.txt")).toMatchObject({ restricted: true });
		expect(st.changes.find((c) => c.path === "alias")).toMatchObject({ area: "untracked" });
		// An untracked symlink's "content" is its target path, not the file.
		const link = await getGitDiff(run, "", { path: "linkfile", oldPath: null, area: "untracked" });
		expect(link.patch).toContain("new file mode 120000");
		expect(link.patch).toContain("+/etc/hostname");
	});

	it("G1: a staged rename away from a restricted name is refused, and listed as restricted", async () => {
		const run = localRunner();
		const st = await getGitStatus(run, "ren");
		if (!st.repo) throw new Error("unreachable");
		expect(st.changes.find((c) => c.path === "settings.txt")).toMatchObject({
			area: "staged",
			status: "R",
			oldPath: ".env",
			restricted: true,
		});
		// With the hint git sees the rename, and its old side fails the
		// denylist before any content is read.
		await expect(
			getGitDiff(run, "ren", { path: "settings.txt", oldPath: ".env", area: "staged" }),
		).rejects.toMatchObject({ code: "restricted" });
		// Without it, rename detection has only the new path to look at
		// and reports an ADDITION under the new, non-restricted name — the
		// same bytes the Files view would preview as `settings.txt`. The
		// denylist is about names; the status entry (restricted: true) is
		// what keeps the UI from asking.
		const r = await getGitDiff(run, "ren", { path: "settings.txt", oldPath: null, area: "staged" });
		expect(r.patch).toContain("new file mode");
		expect(countPatchSections(r.patch)).toBe(1);
	});

	it("G4: an unresolved conflict yields git's combined diff with the markers", async () => {
		const run = localRunner();
		const st = await getGitStatus(run, "conf");
		if (!st.repo) throw new Error("unreachable");
		expect(st.changes.find((c) => c.area === "conflict")).toMatchObject({
			path: "f.txt",
			xy: "UU",
		});
		const d = await getGitDiff(run, "conf", { path: "f.txt", oldPath: null, area: "conflict" });
		expect(d.patch).toMatch(/^diff --cc f\.txt\n/);
		expect(d.patch).toMatch(/^@@@ -1,4 -1,3 \+1,8 @@@$/m);
		expect(d.patch).toContain("++<<<<<<< HEAD\n");
		expect(d.patch).toContain("++=======\n");
		expect(d.patch).toContain("++>>>>>>> other\n");
		expect(d.binary).toBe(false);
	});

	it("diff from a sub-directory cwd still resolves repo-root-relative paths", async () => {
		const r = await getGitDiff(localRunner(), "src", {
			path: "src/app.ts",
			oldPath: null,
			area: "unstaged",
		});
		expect(r.patch).toContain("+d\n");
	});

	it("log: -z records with the separator-bearing subject intact", async () => {
		const commits = await getGitLog(localRunner(), "");
		expect(commits).toHaveLength(2);
		expect(commits[0]?.subject).toBe("second");
		expect(commits[1]?.subject).toBe("init\x1fwith separator");
		expect(commits[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
		expect(commits[0]?.shortHash.length).toBeGreaterThanOrEqual(7);
		expect(new Date(commits[0]?.date ?? "").getTime()).not.toBeNaN();
		expect(commits[0]?.author).toBe("T");
	});

	it("log on a repo without commits is empty", async () => {
		expect(await getGitLog(localRunner(), "sub")).toEqual([]);
	});

	it("leaves the index content and the lock alone", async () => {
		// `git status` takes no lock at all (GIT_OPTIONAL_LOCKS=0). `git
		// diff` may refresh the index's STAT CACHE in place — same tracked
		// content, written through the normal index.lock protocol and
		// skipped when the user's own git holds the lock — so the
		// observable contract is: identical `ls-files --stage`, no lock left.
		const before = git(workspace, "ls-files", "--stage");
		await fs.utimes(path.join(workspace, "README.md"), new Date(), new Date());
		await getGitStatus(localRunner(), "");
		await getGitDiff(localRunner(), "", { path: "README.md", oldPath: null, area: "unstaged" });
		await getGitLog(localRunner(), "");
		expect(git(workspace, "ls-files", "--stage")).toBe(before);
		await expect(fs.stat(path.join(workspace, ".git", "index.lock"))).rejects.toThrow();
	});

	it("backs off when the user's git holds the index lock", async () => {
		const lock = path.join(workspace, ".git", "index.lock");
		await fs.writeFile(lock, "");
		try {
			// status/diff/log all still answer (no "Unable to create
			// index.lock" failure), and the lock is untouched.
			const r = await getGitStatus(localRunner(), "");
			expect(r.repo).toBe(true);
			const d = await getGitDiff(localRunner(), "", {
				path: "src/app.ts",
				oldPath: null,
				area: "unstaged",
			});
			expect(d.patch).toContain("+d\n");
			expect((await fs.stat(lock)).isFile()).toBe(true);
		} finally {
			await fs.rm(lock, { force: true });
		}
	});
});
