/**
 * acp/works.scripts.test.ts — the three container scripts of acp/works.ts run
 * for real (sh + git) against a throwaway repo standing in for the agent's
 * workspace: what they report, and that they never touch what is there.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CREATE, INSPECT, PREFLIGHT, WORKSPACE } from "./works.js";

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
function run(script: string, ...args: string[]) {
	const r = spawnSync("sh", ["-c", script.replaceAll(WORKSPACE, ws), "sh", ...args], { env });
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
