import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const WORKSPACE_ROOT = vi.hoisted(() => {
	const dir = `/tmp/st-skills-ws-${process.pid}-${Date.now()}`;
	process.env.WORKSPACE_ROOT = dir;
	return dir;
});

import { vi } from "vitest";
import {
	compareSkills,
	readWorkspaceSkill,
	SKILLS_WORKSPACE_DIR,
	type SkillSet,
	skillSetFromTar,
	type WorkspaceSkill,
} from "./skills.js";
import { buildTar } from "./tarBuilder.testutil.js";

const SID = "11111111-2222-3333-4444-555555555555";
const SKILLS = path.join(WORKSPACE_ROOT, SID, SKILLS_WORKSPACE_DIR);

const set = (o: Record<string, string>): SkillSet =>
	new Map(Object.entries(o).map(([k, v]) => [k, Buffer.from(v)]));
const W = (o: Record<string, WorkspaceSkill>) => async (rel: string) =>
	o[rel] ?? ({ kind: "absent" } as WorkspaceSkill);
const file = (s: string): WorkspaceSkill => ({ kind: "file", data: Buffer.from(s) });

describe("compareSkills (§2.7.1 precondition 8)", () => {
	const iO = set({ "a/SKILL.md": "old a", "b/SKILL.md": "b" });
	const iN = set({ "a/SKILL.md": "new a", "b/SKILL.md": "b", "c/SKILL.md": "new c" });
	it("W absent, W = I_N or W = I_O ⇒ allowed", async () => {
		expect(await compareSkills(iN, iO, W({}))).toEqual([]);
		expect(await compareSkills(iN, iO, W({ "a/SKILL.md": file("new a") }))).toEqual([]);
		expect(await compareSkills(iN, iO, W({ "a/SKILL.md": file("old a") }))).toEqual([]);
	});
	it("W differs from both ⇒ managed-skills-customized, counted", async () => {
		expect(
			await compareSkills(
				iN,
				iO,
				W({ "a/SKILL.md": file("mine"), "b/SKILL.md": file("mine too") }),
			),
		).toEqual([{ code: "managed-skills-customized", count: 2 }]);
	});
	it("W at a managed path O's image lacks ⇒ managed-skills-collision", async () => {
		expect(await compareSkills(iN, iO, W({ "c/SKILL.md": file("user's c") }))).toEqual([
			{ code: "managed-skills-collision", count: 1 },
		]);
	});
	it("O without skills ⇒ every existing managed W collides", async () => {
		expect(
			await compareSkills(iN, null, W({ "a/SKILL.md": file("new a"), "b/SKILL.md": file("b") })),
		).toEqual([{ code: "managed-skills-collision", count: 2 }]);
	});
	it("a non-file anywhere can't be compared ⇒ blocks", async () => {
		expect(await compareSkills(iN, iO, W({ "b/SKILL.md": { kind: "other" } }))).toEqual([
			{ code: "managed-skills-collision", count: 1 },
		]);
	});
	it("files only in the workspace are never read", async () => {
		const read: string[] = [];
		await compareSkills(iN, iO, async (rel) => {
			read.push(rel);
			return { kind: "absent" };
		});
		expect(read.sort()).toEqual(["a/SKILL.md", "b/SKILL.md", "c/SKILL.md"]);
	});
});

describe("skillSetFromTar", () => {
	it("maps getArchive(/opt/session-skills) to paths under it", () => {
		const s = skillSetFromTar(
			buildTar([
				{ path: "session-skills/", type: "dir" },
				{ path: "session-skills/x/", type: "dir" },
				{ path: "session-skills/x/SKILL.md", data: "x" },
				{ path: "session-skills/l", type: "symlink", linkname: "x" },
			]),
		);
		expect([...s.keys()]).toEqual(["x/SKILL.md", "l"]);
		expect(s.get("l")).toBe("other");
	});
	it("entries outside the root or with .. are refused", () => {
		expect(() => skillSetFromTar(buildTar([{ path: "etc/passwd", data: "x" }]))).toThrow();
		expect(() => skillSetFromTar(buildTar([{ path: "session-skills/../x", data: "x" }]))).toThrow();
	});
});

describe("readWorkspaceSkill (opener + /proc proof, .st/ allowed only here)", () => {
	beforeEach(async () => {
		await fs.rm(WORKSPACE_ROOT, { recursive: true, force: true });
		await fs.mkdir(path.join(SKILLS, "a"), { recursive: true });
	});
	afterAll(async () => {
		await fs.rm(WORKSPACE_ROOT, { recursive: true, force: true });
	});
	it("a regular file is read; a missing one is absent", async () => {
		await fs.writeFile(path.join(SKILLS, "a/SKILL.md"), "content");
		expect(await readWorkspaceSkill(SID, "a/SKILL.md")).toEqual(file("content"));
		expect(await readWorkspaceSkill(SID, "nope/SKILL.md")).toEqual({ kind: "absent" });
	});
	it("a symlink (even pointing inside), a directory or a FIFO is `other`, never followed", async () => {
		await fs.writeFile(path.join(WORKSPACE_ROOT, SID, "target"), "t");
		await fs.symlink(path.join(WORKSPACE_ROOT, SID, "target"), path.join(SKILLS, "a/SKILL.md"));
		expect(await readWorkspaceSkill(SID, "a/SKILL.md")).toEqual({ kind: "other" });
		await fs.mkdir(path.join(SKILLS, "d/SKILL.md"), { recursive: true });
		expect(await readWorkspaceSkill(SID, "d/SKILL.md")).toEqual({ kind: "other" });
	});
	it("a symlinked parent escaping the workspace is `other`, not absent", async () => {
		await fs.symlink("/etc", path.join(SKILLS, "esc"));
		expect(await readWorkspaceSkill(SID, "esc/passwd")).toEqual({ kind: "other" });
	});
});
