import { execFileSync } from "node:child_process";
import { promises as fs, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backupPerms, hardenBackups, parseHardenArgs, secure } from "./backupPerms.js";

const gid = process.getgid?.() ?? 0;
let root: string;
const mode = async (p: string) => (await fs.lstat(p)).mode & 0o7777;

beforeEach(() => {
	root = mkdtempSync(path.join(os.tmpdir(), "st-backup-perms-"));
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("backupPerms", () => {
	it("is root-only without BACKUP_GROUP_GID", () => {
		expect(backupPerms({})).toEqual({ dirMode: 0o700, fileMode: 0o600, gid: null });
		expect(backupPerms({ BACKUP_GROUP_GID: "  " })).toEqual({
			dirMode: 0o700,
			fileMode: 0o600,
			gid: null,
		});
	});

	it("opens to one group with a numeric BACKUP_GROUP_GID, never to others", () => {
		expect(backupPerms({ BACKUP_GROUP_GID: "1001" })).toEqual({
			dirMode: 0o750,
			fileMode: 0o640,
			gid: 1001,
		});
		for (const p of [backupPerms({}), backupPerms({ BACKUP_GROUP_GID: "0" })]) {
			expect(p.dirMode & 0o007).toBe(0);
			expect(p.fileMode & 0o007).toBe(0);
		}
	});

	it.each([
		"backup",
		"-1",
		"1.5",
		"0x10",
		"99999999999",
		"1001 1002",
	])("refuses BACKUP_GROUP_GID=%j", (v) => {
		expect(() => backupPerms({ BACKUP_GROUP_GID: v })).toThrow(/numeric group id/);
	});
});

describe("secure", () => {
	it("sets the mode (and group) on a file and a directory", async () => {
		const f = path.join(root, "f");
		await fs.writeFile(f, "x", { mode: 0o644 });
		await fs.chmod(f, 0o644);
		await secure(f, "file", { dirMode: 0o750, fileMode: 0o640, gid });
		expect(await mode(f)).toBe(0o640);
		expect((await fs.stat(f)).gid).toBe(gid);
		await fs.chmod(root, 0o755);
		await secure(root, "dir", backupPerms({}));
		expect(await mode(root)).toBe(0o700);
	});

	it("refuses a symlink and leaves its target alone", async () => {
		const target = path.join(root, "target");
		await fs.writeFile(target, "x");
		await fs.chmod(target, 0o644);
		const link = path.join(root, "link");
		await fs.symlink(target, link);
		await expect(secure(link, "file", backupPerms({}))).rejects.toThrow(/symlink/);
		expect(await mode(target)).toBe(0o644);
	});

	it("refuses when the entry is not the one the caller examined (dev/ino), and changes nothing", async () => {
		const f = path.join(root, "f");
		await fs.writeFile(f, "x");
		await fs.chmod(f, 0o644);
		const st = await fs.lstat(f);
		await expect(
			secure(f, "file", backupPerms({}), { dev: st.dev, ino: st.ino + 1 }),
		).rejects.toThrow(/changed since/);
		expect(await mode(f)).toBe(0o644);
		await secure(f, "file", backupPerms({}), { dev: st.dev, ino: st.ino });
		expect(await mode(f)).toBe(0o600);
	});

	// Not covered: the other-filesystem skip in hardenBackups (st.dev !== root's)
	// needs a second mount, which the test runner does not have.

	it("refuses an entry of the wrong kind (a FIFO does not hang it)", async () => {
		const fifo = path.join(root, "fifo");
		execFileSync("mkfifo", [fifo]);
		await expect(secure(fifo, "file", backupPerms({}))).rejects.toThrow(/not a regular file/);
		await expect(secure(root, "file", backupPerms({}))).rejects.toThrow(/not a regular file/);
	});
});

describe("hardenBackups (existing backups)", () => {
	async function legacyTree(): Promise<void> {
		// What every backup before #562 looks like: umask modes.
		for (const d of ["", "2026-11-01", "2026-11-01/workspaces", "pre-abc"]) {
			await fs.mkdir(path.join(root, d), { recursive: true });
			await fs.chmod(path.join(root, d), 0o755);
		}
		for (const f of [
			"2026-11-01/users.jsonl",
			"2026-11-01/manifest.json",
			"2026-11-01/workspaces/s1.tar.gz",
			"pre-abc/manifest.json",
		]) {
			await fs.writeFile(path.join(root, f), "x");
			await fs.chmod(path.join(root, f), 0o644);
		}
	}

	it("dry run reports every entry and changes nothing", async () => {
		await legacyTree();
		const r = await hardenBackups(root, backupPerms({}), { write: false });
		expect(r.written).toBe(false);
		expect(r.changes).toHaveLength(8);
		expect(await mode(path.join(root, "2026-11-01/users.jsonl"))).toBe(0o644);
		expect(await mode(root)).toBe(0o755);
	});

	it("--write: the dailies to the group mode, a pre-* to root-only; a second pass finds nothing", async () => {
		await legacyTree();
		const perms = { dirMode: 0o750, fileMode: 0o640, gid };
		const r = await hardenBackups(root, perms, { write: true });
		expect(r.groupUnreadable).toEqual([]);
		expect(await mode(root)).toBe(0o750);
		expect(await mode(path.join(root, "2026-11-01/workspaces"))).toBe(0o750);
		expect(await mode(path.join(root, "2026-11-01/workspaces/s1.tar.gz"))).toBe(0o640);
		expect(await mode(path.join(root, "pre-abc"))).toBe(0o700);
		expect(await mode(path.join(root, "pre-abc/manifest.json"))).toBe(0o600);
		expect(
			r.changes.filter((c) => c.class === "private").map((c) => path.relative(root, c.path)),
		).toEqual(["pre-abc", "pre-abc/manifest.json"]);
		expect((await hardenBackups(root, perms, { write: false })).changes).toHaveLength(0);
	});

	it("never widens: private backups stay private, a stricter daily stays stricter and is reported", async () => {
		const mk = async (rel: string, m: number, file = false) => {
			const p = path.join(root, rel);
			if (file) await fs.writeFile(p, "x");
			else await fs.mkdir(p);
			await fs.chmod(p, m);
		};
		await fs.chmod(root, 0o755);
		await mk("pre-x", 0o700);
		await mk("pre-x/users.jsonl", 0o600, true);
		await mk("st-control-y", 0o700);
		await mk("st-control-y/REVOKED", 0o600, true);
		await mk("quarantine-z", 0o700);
		await mk("quarantine-z/old.jsonl", 0o644, true); // inside a private dir: narrowed, not opened
		await mk("2026-11-02", 0o700); // a daily someone closed by hand
		await mk("2026-11-02/manifest.json", 0o604, true);
		await mk("notes.txt", 0o644, true); // a loose file at the top is private
		const perms = { dirMode: 0o750, fileMode: 0o640, gid };
		const r = await hardenBackups(root, perms, { write: true });
		for (const [rel, m] of [
			["pre-x", 0o700],
			["pre-x/users.jsonl", 0o600],
			["st-control-y", 0o700],
			["st-control-y/REVOKED", 0o600],
			["quarantine-z/old.jsonl", 0o600],
			["2026-11-02", 0o700],
			["2026-11-02/manifest.json", 0o600],
			["notes.txt", 0o600],
		] as const) {
			expect([rel, await mode(path.join(root, rel))]).toEqual([rel, m]);
		}
		// Nothing already private is even touched (no chmod, no chgrp).
		const touched = r.changes.map((c) => path.relative(root, c.path)).sort();
		expect(touched).not.toContain("pre-x");
		expect(touched).not.toContain("pre-x/users.jsonl");
		expect(touched).not.toContain("st-control-y/REVOKED");
		expect(r.groupUnreadable.map((p) => path.relative(root, p)).sort()).toEqual([
			"2026-11-02",
			"2026-11-02/manifest.json",
		]);
		for (const c of r.changes) {
			expect(c.to.mode & ~c.from.mode, path.relative(root, c.path)).toBe(0); // no bit added
		}
	});

	it("narrowing is taken on the opened entry: a mode tightened after the walk's lstat stays tight", async () => {
		const f = path.join(root, "f");
		await fs.writeFile(f, "x");
		await fs.chmod(f, 0o600);
		await secure(f, "file", { dirMode: 0o750, fileMode: 0o640, gid }, undefined, {
			narrowOnly: true,
		});
		expect(await mode(f)).toBe(0o600);
	});

	it("never follows a symlink: reported, target untouched", async () => {
		await legacyTree();
		const outside = mkdtempSync(path.join(os.tmpdir(), "st-outside-"));
		try {
			await fs.chmod(outside, 0o755);
			await fs.writeFile(path.join(outside, "secret"), "x");
			await fs.chmod(path.join(outside, "secret"), 0o644);
			await fs.symlink(outside, path.join(root, "2026-11-01", "evil-dir"));
			await fs.symlink(path.join(outside, "secret"), path.join(root, "evil-file"));
			const r = await hardenBackups(root, backupPerms({}), { write: true });
			expect(r.skipped.map((k) => path.basename(k.path)).sort()).toEqual(["evil-dir", "evil-file"]);
			expect(await mode(path.join(outside, "secret"))).toBe(0o644);
			expect(await mode(outside)).toBe(0o755);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	it("never enters a directory others can write to (a swap there could redirect the walk)", async () => {
		await legacyTree();
		const open = path.join(root, "2026-11-01", "workspaces");
		await fs.chmod(open, 0o777);
		const r = await hardenBackups(root, backupPerms({}), { write: true });
		expect(r.skipped.map((k) => [path.relative(root, k.path), k.reason])).toEqual([
			["2026-11-01/workspaces", expect.stringMatching(/writable by group or others/)],
		]);
		expect(await mode(open)).toBe(0o777);
		expect(await mode(path.join(open, "s1.tar.gz"))).toBe(0o644);
		expect(await mode(path.join(root, "2026-11-01/users.jsonl"))).toBe(0o600);
	});

	it("refuses a root writable by others or owned by someone else", async () => {
		await legacyTree();
		await fs.chmod(root, 0o757);
		await expect(hardenBackups(root, backupPerms({}), { write: true })).rejects.toThrow(
			/writable by nobody else/,
		);
		await fs.chmod(root, 0o755);
		const me = process.getuid?.() ?? 0;
		const spy = vi.spyOn(process, "getuid").mockReturnValue(me + 1);
		try {
			await expect(hardenBackups(root, backupPerms({}), { write: false })).rejects.toThrow(
				/owned by uid/,
			);
		} finally {
			spy.mockRestore();
		}
	});

	it("refuses a root that is a symlink", async () => {
		const link = `${root}-link`;
		await fs.symlink(root, link);
		try {
			await expect(hardenBackups(link, backupPerms({}), { write: true })).rejects.toThrow(
				/not a real directory/,
			);
		} finally {
			await fs.rm(link);
		}
	});
});

describe("parseHardenArgs", () => {
	it.each([
		[[], { root: "/d", write: false }],
		[["--write"], { root: "/d", write: true }],
		[["/x"], { root: "/x", write: false }],
		[["/x", "--write"], { root: "/x", write: true }],
		[["--write", "/x"], { root: "/x", write: true }],
	])("%j", (args, want) => {
		expect(parseHardenArgs(args, "/d")).toEqual(want);
	});
	it.each([[["--force"]], [["/x", "/y"]], [["--write", "--dry"]]])("refuses %j", (args) => {
		expect(parseHardenArgs(args, "/d")).toBeNull();
	});
});
