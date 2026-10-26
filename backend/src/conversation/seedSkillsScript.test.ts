/**
 * seedSkillsScript.test.ts — session-image/hooks/seed-skills.sh is
 * fail-closed on the deferral marker (CONVERSATION.md §2.7.3): it seeds
 * only when it can positively establish that /etc/st-control/defer-skill-seed
 * is absent. Runs the real script through bash, as a non-root user, with
 * its three fixed paths rewritten to a temp tree (the shipped script takes
 * no path overrides on purpose: a session env var must never be able to
 * point it elsewhere). The root:root 0700 mount itself is covered by the
 * Docker smoke (phase 11).
 */
import { spawnSync } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "../../../session-image/hooks/seed-skills.sh");
const isRoot = process.getuid?.() === 0;

let root: string;
let control: string;
let src: string;
let dst: string;
let script: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-seed-"));
	control = path.join(root, "st-control");
	src = path.join(root, "session-skills");
	dst = path.join(root, "workspace/.st/claude-state/skills");
	await fs.mkdir(path.join(src, "delegate-task"), { recursive: true });
	await fs.writeFile(path.join(src, "delegate-task/SKILL.md"), "image version\n");
	await fs.mkdir(path.join(dst, "delegate-task"), { recursive: true });
	await fs.mkdir(path.join(dst, "my-own"), { recursive: true });
	await fs.writeFile(path.join(dst, "delegate-task/SKILL.md"), "customised by the user\n");
	await fs.writeFile(path.join(dst, "my-own/SKILL.md"), "my own skill\n");
	await fs.mkdir(control, { recursive: true, mode: 0o755 });
	const text = readFileSync(SCRIPT, "utf8")
		.replace("CONTROL_DIR=/etc/st-control", `CONTROL_DIR=${control}`)
		.replace("SKILLS_SRC=/opt/session-skills", `SKILLS_SRC=${src}`)
		.replace("SKILLS_DST=/home/developer/workspace/.st/claude-state/skills", `SKILLS_DST=${dst}`);
	expect(text).toContain(`CONTROL_DIR=${control}`);
	expect(text).toContain(`SKILLS_DST=${dst}`);
	expect(text).toContain(`SKILLS_SRC=${src}`);
	script = path.join(root, "seed-skills.sh");
	await fs.writeFile(script, text, { mode: 0o755 });
});

afterEach(async () => {
	await fs.chmod(control, 0o755).catch(() => {});
	await fs.rm(root, { recursive: true, force: true });
});

function run(): number | null {
	return spawnSync("bash", [script], {
		stdio: "ignore",
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
	}).status;
}

async function skills(): Promise<[string, string]> {
	return [
		await fs.readFile(path.join(dst, "delegate-task/SKILL.md"), "utf8"),
		await fs.readFile(path.join(dst, "my-own/SKILL.md"), "utf8"),
	];
}
const UNTOUCHED: [string, string] = ["customised by the user\n", "my own skill\n"];

describe.skipIf(isRoot)("seed-skills.sh — fail-closed deferral (§2.7.3)", () => {
	it("marker inside a control dir the user can't search: exit 4, nothing written — every time", async () => {
		await fs.writeFile(path.join(control, "defer-skill-seed"), "");
		await fs.chmod(control, 0o000);
		for (let i = 0; i < 3; i++) {
			// boot, exec, second boot: same script, same answer
			expect(run()).toBe(4);
			expect(await skills()).toEqual(UNTOUCHED);
		}
	});

	it("unsearchable control dir WITHOUT a marker is still not seeded (can't prove absence)", async () => {
		await fs.chmod(control, 0o600); // readable bits, no search bit
		expect(run()).toBe(4);
		expect(await skills()).toEqual(UNTOUCHED);
	});

	it("missing control dir: exit 4, nothing written", async () => {
		await fs.rm(control, { recursive: true });
		expect(run()).toBe(4);
		expect(await skills()).toEqual(UNTOUCHED);
	});

	it("searchable dir with the marker: exit 3, nothing written (a dangling-symlink marker too)", async () => {
		await fs.writeFile(path.join(control, "defer-skill-seed"), "");
		expect(run()).toBe(3);
		expect(await skills()).toEqual(UNTOUCHED);
		await fs.rm(path.join(control, "defer-skill-seed"));
		await fs.symlink("/nonexistent", path.join(control, "defer-skill-seed"));
		expect(run()).toBe(3);
		expect(await skills()).toEqual(UNTOUCHED);
	});

	it("searchable dir without the marker: exit 0, managed skill refreshed, the user's own untouched (existing seeding)", async () => {
		expect(run()).toBe(0);
		expect(await skills()).toEqual(["image version\n", "my own skill\n"]);
	});

	it("search-only control dir (0111) without the marker: absence is provable, seeds", async () => {
		await fs.chmod(control, 0o111);
		expect(run()).toBe(0);
		expect((await skills())[0]).toBe("image version\n");
	});
});
