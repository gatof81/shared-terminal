/**
 * acp/works.scripts.test.ts — the three container scripts of acp/works.ts run
 * for real (sh + git) against a throwaway repo standing in for the agent's
 * workspace: what they report, and that they never touch what is there.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLEAN, CREATE, INSPECT, PREFLIGHT, WORKSPACE } from "./works.js";

let root: string;
let ws: string;
const env = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
};
const git = (...a: string[]) => execFileSync("git", a, { env }).toString().trim();
// In a session container every process is the agent user's and readable; a CI
// host has others' (and non-dumpable ones of this user): the sweep looks only at
// the readable ones of this user, as there.
const OWN_PROCS =
	'for p in $(for q in /proc/[0-9]*; do [ -O "$q" ] && readlink "$q/cwd" >/dev/null 2>&1 && [ -r "$q/environ" ] && echo "$q"; done); do';
function run(script: string, ...args: string[]) {
	const text = script.replaceAll(WORKSPACE, ws).replace("for p in /proc/[0-9]*; do", OWN_PROCS);
	const r = spawnSync("sh", ["-c", text, "sh", ...args], { env });
	const lines = r.stdout.toString().trim().split("\n").filter(Boolean);
	return { code: r.status, lines: lines.filter((l) => !l.startsWith("free_kb=")), all: lines };
}

beforeAll(() => {
	root = mkdtempSync(path.join(tmpdir(), "works-"));
	ws = path.join(root, "ws");
	git("init", "-q", "--bare", "-b", "main", path.join(root, "remote.git"));
	git("clone", "-q", path.join(root, "remote.git"), path.join(root, "seed"));
	git("-C", path.join(root, "seed"), "commit", "-q", "--allow-empty", "-m", "init");
	git("-C", path.join(root, "seed"), "push", "-q", "origin", "HEAD:main");
	git("clone", "-q", path.join(root, "remote.git"), ws);
	mkdirSync(path.join(ws, ".st/acp/ctx"), { recursive: true });
	writeFileSync(path.join(ws, ".st/.gitignore"), "*\n");
	writeFileSync(path.join(ws, ".st/acp/ctx/viejo.json"), "{}");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("works: container scripts", () => {
	it("preflight: free space, the remote's default branch, what is in the way, a bad base", () => {
		const head = git("-C", ws, "rev-parse", "origin/main");
		const ok = run(PREFLIGHT, "st-1", "");
		expect(ok.all[0]).toMatch(/^free_kb=\d+$/);
		expect(ok.lines).toEqual(["base=origin/main", `sha=${head}`]);
		expect(run(PREFLIGHT, "viejo", "").lines).toContain("exists=session");
		expect(run(PREFLIGHT, "x", "no-such-ref").lines).toEqual(["bad-base=no-such-ref"]);
	});

	it("create makes the worktree on work/<id> once; inspect tells ok / none / branch-only / other", () => {
		const sha = git("-C", ws, "rev-parse", "origin/main");
		expect(run(CREATE, "st-1", sha)).toMatchObject({ code: 0, lines: ["created"] });
		expect(git("-C", path.join(ws, ".st/ctx/st-1"), "symbolic-ref", "--short", "HEAD")).toBe(
			"work/st-1",
		);
		expect(run(CREATE, "st-1", sha)).toMatchObject({ code: 5, lines: ["exists"] });
		expect(run(PREFLIGHT, "st-1", "").lines).toEqual(
			expect.arrayContaining(["exists=directory", "exists=branch"]),
		);
		expect(run(INSPECT, "st-1").lines).toEqual(["state=ok", `sha=${sha}`]);
		expect(run(INSPECT, "st-2").lines).toEqual(["state=none"]);
		git("-C", ws, "branch", "work/st-3");
		expect(run(INSPECT, "st-3").lines).toEqual(["state=branch-only"]);
		mkdirSync(path.join(ws, ".st/ctx/st-4"));
		expect(run(INSPECT, "st-4").lines).toEqual(["state=other"]);
		// The main checkout never sees any of it.
		expect(git("-C", ws, "status", "--porcelain")).toBe("");
	});
});

describe("works: the cleaning's checks", () => {
	let sha = "";
	const wt = (id: string) => path.join(ws, ".st/ctx", id);
	const clean = (id: string, mode = "remove") => run(CLEAN, id, sha, mode).lines;
	const reasons = (id: string) => clean(id, "check").filter((l) => l.startsWith("reason="));
	beforeAll(() => {
		sha = git("-C", ws, "rev-parse", "origin/main");
	});

	it("an untouched work is removed without --force; the branch stays; a second run finds it absent", () => {
		run(CREATE, "limpio", sha);
		expect(clean("limpio")).toEqual(["removed"]);
		expect(git("-C", ws, "rev-parse", "work/limpio")).toBe(sha);
		expect(clean("limpio")).toEqual(["absent"]);
	});

	it("uncommitted changes, unpublished commits and ignored files other than node_modules/ and dist/ hold it", () => {
		run(CREATE, "sucio", sha);
		writeFileSync(path.join(wt("sucio"), "nuevo.txt"), "x");
		expect(reasons("sucio")).toEqual([
			expect.stringMatching(/^reason=cambios sin commitear: \?\? nuevo\.txt/),
		]);
		git("-C", wt("sucio"), "add", "nuevo.txt");
		git("-C", wt("sucio"), "commit", "-q", "-m", "trabajo");
		expect(reasons("sucio")).toEqual([expect.stringMatching(/^reason=commits sin publicar/)]);
		// Published (any remote ref — here a PR-style one, no branch): preserved.
		git("-C", wt("sucio"), "push", "-q", "origin", "HEAD:refs/pull/1/head");
		expect(reasons("sucio")).toEqual([]);
		writeFileSync(path.join(wt("sucio"), ".gitignore"), "node_modules/\ndist/\n.env\n");
		git("-C", wt("sucio"), "add", ".gitignore");
		git("-C", wt("sucio"), "commit", "-q", "-m", "ignores");
		git("-C", wt("sucio"), "push", "-q", "origin", "HEAD:refs/pull/1/head");
		for (const d of ["node_modules/a", "web/dist", "web/node_modules/b"])
			mkdirSync(path.join(wt("sucio"), d), { recursive: true });
		writeFileSync(path.join(wt("sucio"), "web/dist/x.js"), "x");
		writeFileSync(path.join(wt("sucio"), "node_modules/a/i.js"), "x");
		expect(reasons("sucio")).toEqual([]);
		writeFileSync(path.join(wt("sucio"), ".env"), "SECRET=1");
		expect(reasons("sucio")).toEqual([
			expect.stringMatching(/^reason=archivos ignorados que se perderían: \.env/),
		]);
		// With a reason, "remove" removes nothing.
		expect(clean("sucio")).not.toContain("removed");
		expect(execFileSync("ls", ["-a", wt("sucio")]).toString()).toContain(".env");
	});

	it("a process with its cwd in the worktree, or ST_WORK=<id> in its environment, holds it", async () => {
		run(CREATE, "vivo", sha);
		const inside = spawn("sleep", ["30"], { cwd: wt("vivo") });
		const tagged = spawn("sleep", ["30"], { cwd: root, env: { ...process.env, ST_WORK: "vivo" } });
		try {
			await new Promise((ok) => setTimeout(ok, 200));
			const r = reasons("vivo");
			expect(r).toEqual(
				expect.arrayContaining([
					`reason=proceso ${inside.pid} (sleep 30 ) con cwd en el trabajo`,
					`reason=proceso ${tagged.pid} (sleep 30 ) del trabajo (ST_WORK)`,
				]),
			);
		} finally {
			inside.kill();
			tagged.kill();
		}
		await new Promise((ok) => setTimeout(ok, 200));
		expect(clean("vivo")).toEqual(["removed"]);
	});
});
