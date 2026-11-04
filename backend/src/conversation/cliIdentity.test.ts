/**
 * cliIdentity.test.ts — the version of the process that will receive the
 * text (§8.1.9, v1.8.2): argv, parsers, fail-closed paths, cache.
 */

import { describe, expect, it } from "vitest";
import {
	exeLinkArgv,
	isNodeRuntime,
	LiveVersionCache,
	parseStarttime,
	parseUids,
	parseVersionOutput,
	readLiveCliVersion,
	statArgv,
	statusArgv,
	versionArgv,
} from "./cliIdentity.js";
import type { ComposerExecResult } from "./composer.js";

const NPM =
	"/home/developer/workspace/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe";
const NATIVE = "/home/developer/.local/share/claude/versions/2.1.317";
const stat = (pid: number, start: string) =>
	`${pid} (claude) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 ${start} 0 0\n`;
const status = (r: number, e: number) =>
	`Name:\tclaude\nUid:\t${r}\t${e}\t${e}\t${e}\nGid:\t1000\t1000\t1000\t1000\n`;

function fakeExec(o: {
	uid?: [number, number];
	statusExit?: number;
	version?: string;
	versionExit?: number | null;
	afterStart?: string;
	afterExe?: string;
	inodes?: string[];
	throwOn?: "status" | "version" | "stat";
}) {
	const inodes = [...(o.inodes ?? [])];
	const calls: Array<{ cmd: string[]; user?: string }> = [];
	const exec = async (cmd: string[], user?: string): Promise<ComposerExecResult> => {
		calls.push({ cmd, user });
		const j = cmd.join(" ");
		const r = (stdout: string, exitCode: number | null = 0) => ({ execId: "x", exitCode, stdout });
		if (j.endsWith("/status")) {
			if (o.throwOn === "status") throw new Error("docker down");
			return r(status(...(o.uid ?? [1000, 1000])), o.statusExit ?? 0);
		}
		if (j.endsWith("--version")) {
			if (o.throwOn === "version") throw new Error("docker down");
			return r(
				o.version ?? "2.1.316 (Claude Code)\n",
				o.versionExit === undefined ? 0 : o.versionExit,
			);
		}
		if (j.endsWith("/stat")) {
			if (o.throwOn === "stat") throw new Error("docker down");
			return r(stat(4242, o.afterStart ?? "777"));
		}
		if (j.includes("stat -L")) {
			const v = inodes.shift() ?? "64768:4242";
			return r(v === "" ? "" : `${v}\n`, v === "" ? 1 : 0);
		}
		if (j.includes("readlink")) return r(`${o.afterExe ?? NPM}\n`);
		throw new Error(`unexpected ${j}`);
	};
	return { exec, calls };
}
const before = { start: "777", exe: NPM };

describe("argv: fixed, no shell, the process's own binary, empty environment", () => {
	it("version query", () => {
		const a = versionArgv(4242);
		expect(a).toEqual([
			"/usr/bin/env",
			"-i",
			"PATH=/usr/bin:/bin",
			"HOME=/nonexistent",
			"DISABLE_AUTOUPDATER=1",
			"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
			"/usr/bin/timeout",
			"-k",
			"1",
			"3",
			"/proc/4242/exe",
			"--version",
		]);
		for (const argv of [a, statusArgv(1), statArgv(1), exeLinkArgv(1)]) {
			expect(argv).not.toContain("sh");
			expect(argv).not.toContain("bash");
			expect(argv).not.toContain("-c");
			expect(argv.join(" ")).not.toMatch(/\bclaude\b/); // never PATH's claude
		}
	});
	it("refuses anything but a positive integer pid", () => {
		for (const bad of [0, -1, 1.5, Number.NaN, 12345678901])
			expect(() => versionArgv(bad)).toThrow();
	});
});

describe("parsers", () => {
	it("starttime is field 22, whatever the comm contains", () => {
		expect(parseStarttime(stat(1, "123"))).toBe("123");
		expect(
			parseStarttime("1 (we) ird) name) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 99 0"),
		).toBe("99");
		expect(parseStarttime("garbage")).toBeNull();
		expect(parseStarttime("1 (x) S 1 2")).toBeNull();
	});
	it("uids", () => {
		expect(parseUids(status(1000, 1000))).toEqual({ real: 1000, effective: 1000 });
		expect(parseUids("Name:\tx\n")).toBeNull();
	});
	it.each([
		["2.1.316 (Claude Code)\n", "2.1.316"],
		["2.1.316 (Claude Code)", "2.1.316"],
		["2.1.316\n", null],
		["2.1.316 (Claude Code)\n\n", null],
		["v22.11.0\n", null],
		["2.1.316-rc.1 (Claude Code)\n", null],
		["02.1.316 (Claude Code)\n", null],
		["Update available\n2.1.316 (Claude Code)\n", null],
		["", null],
		[`2.1.316 (Claude Code)${" ".repeat(200)}`, null],
	])("version output %j ⇒ %j", (out, want) => {
		expect(parseVersionOutput(out)).toBe(want);
	});
	it("node runtimes (the old JS CLI) are recognised, deleted or versioned", () => {
		for (const e of ["/usr/bin/node", "/usr/local/bin/node22", "/opt/node/bin/node (deleted)"])
			expect(isNodeRuntime(e)).toBe(true);
		for (const e of [NPM, NATIVE, `${NATIVE} (deleted)`, "/usr/bin/nodejs-wrapper"])
			expect(isNodeRuntime(e)).toBe(false);
	});
});

describe("readLiveCliVersion", () => {
	it("npm binary: queried as the process's uid, before/after identity checked", async () => {
		const f = fakeExec({});
		expect(await readLiveCliVersion(f.exec, 4242, before)).toEqual({
			ok: true,
			version: "2.1.316",
			inode: "64768:4242",
		});
		const v = f.calls.find((c) => c.cmd.at(-1) === "--version");
		expect(v?.user).toBe("1000");
		expect(f.calls.map((c) => c.cmd.at(-1))).toEqual([
			"/proc/4242/status",
			"/proc/4242/exe", // device:inode before
			"--version",
			"/proc/4242/stat",
			"/proc/4242/exe", // readlink after
			"/proc/4242/exe", // device:inode after
		]);
		// Every program by absolute path (the container's PATH starts in the workspace).
		for (const c of f.calls) expect(c.cmd[0]).toMatch(/^\/usr\/bin\//);
		// Reads run as the image's USER (no explicit user); only the binary run is pinned.
		expect(f.calls.filter((c) => c.user !== undefined)).toHaveLength(1);
	});
	it("a binary replaced on disk (' (deleted)') is still that process's binary", async () => {
		const exe = `${NATIVE} (deleted)`;
		const f = fakeExec({ version: "2.1.317 (Claude Code)\n", afterExe: exe });
		expect(await readLiveCliVersion(f.exec, 4242, { start: "777", exe })).toEqual({
			ok: true,
			version: "2.1.317",
			inode: "64768:4242",
		});
	});
	it.each([
		["node runtime", { exe: "/usr/bin/node" }, {}, "node-runtime", 0],
		["status unreadable", {}, { statusExit: 1 }, "uid-unreadable", 1],
		["root", {}, { uid: [0, 0] as [number, number] }, "uid-root-or-mixed", 1],
		[
			"setuid-like (real ≠ effective)",
			{},
			{ uid: [1000, 0] as [number, number] },
			"uid-root-or-mixed",
			1,
		],
		["exe inode unreadable", {}, { inodes: [""] }, "identity-changed", 2],
		["timeout (exit 124)", {}, { versionExit: 124 }, "version-exec-failed", 3],
		["exit unknown", {}, { versionExit: null }, "version-exec-failed", 3],
		["invalid output", {}, { version: "Claude Code\n" }, "version-output-invalid", 3],
		["pre-release", {}, { version: "2.1.320-beta.1 (Claude Code)\n" }, "version-output-invalid", 3],
		[
			"process replaced during the query (starttime)",
			{},
			{ afterStart: "778" },
			"identity-changed",
			6,
		],
		["exec replaced the binary (exe path)", {}, { afterExe: NATIVE }, "identity-changed", 6],
		[
			"another file at the same path (reinstall / execve of a new file)",
			{},
			{ inodes: ["64768:4242", "64768:9999"] },
			"identity-changed",
			6,
		],
		["docker error", {}, { throwOn: "version" as const }, "exec-error", 3],
	])("%s ⇒ %s (fail closed)", async (_n, b, o, why, nCalls) => {
		const f = fakeExec(o);
		expect(await readLiveCliVersion(f.exec, 4242, { ...before, ...b })).toEqual({ ok: false, why });
		expect(f.calls).toHaveLength(nCalls);
		// Never as root.
		expect(f.calls.some((c) => c.user === "0")).toBe(false);
	});
});

describe("LiveVersionCache", () => {
	it("keys on container, pid, starttime and exe; bounded", () => {
		const c = new LiveVersionCache(2);
		c.set("c1", 1, "10", NPM, { version: "2.1.316", inode: "1:2" });
		expect(c.get("c1", 1, "10", NPM)).toEqual({ version: "2.1.316", inode: "1:2" });
		expect(c.get("c1", 1, "11", NPM)).toBeUndefined(); // pid reused by another process
		expect(c.get("c2", 1, "10", NPM)).toBeUndefined();
		expect(c.get("c1", 1, "10", NATIVE)).toBeUndefined();
		c.set("c1", 2, "10", NPM, { version: "a", inode: "1:2" });
		c.set("c1", 3, "10", NPM, { version: "b", inode: "1:2" });
		expect(c.size).toBe(2);
		expect(c.get("c1", 1, "10", NPM)).toBeUndefined();
	});
});
