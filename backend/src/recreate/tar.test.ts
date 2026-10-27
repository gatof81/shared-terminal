import { describe, expect, it } from "vitest";
import { parseTar, TarFormatError } from "./tar.js";
import { buildTar } from "./tarBuilder.testutil.js";

const LIMITS = { maxEntries: 100, maxFileBytes: 1024 };

describe("parseTar", () => {
	it("files, dirs and symlinks as dockerd emits them", () => {
		const tar = buildTar([
			{ path: "session-skills/", type: "dir" },
			{ path: "session-skills/a/SKILL.md", data: "hello\n" },
			{ path: "session-skills/link", type: "symlink", linkname: "a/SKILL.md" },
		]);
		expect(parseTar(tar, LIMITS)).toEqual([
			{ path: "session-skills", type: "dir" },
			{ path: "session-skills/a/SKILL.md", type: "file", data: Buffer.from("hello\n") },
			{ path: "session-skills/link", type: "symlink", linkname: "a/SKILL.md" },
		]);
	});
	it("long names through pax records and GNU long names", () => {
		const long = `session-skills/${"x".repeat(150)}/SKILL.md`;
		const [pax] = parseTar(buildTar([{ path: long, data: "p" }]), LIMITS);
		expect(pax?.path).toBe(long);
		const [gnu] = parseTar(buildTar([{ path: long, data: "g", gnuLong: true }]), LIMITS);
		expect(gnu?.path).toBe(long);
	});
	it("other entry types are reported as `other`, without data", () => {
		const [e] = parseTar(buildTar([{ path: "p", type: "fifo" }]), LIMITS);
		expect(e).toEqual({ path: "p", type: "other" });
	});
	it("fail-closed: bad checksum, truncation, no terminator, limits", () => {
		const good = buildTar([{ path: "f", data: "abc" }]);
		const bad = Buffer.from(good);
		bad[0] = "g".charCodeAt(0);
		expect(() => parseTar(bad, LIMITS)).toThrow(TarFormatError);
		expect(() => parseTar(good.subarray(0, 600), LIMITS)).toThrow(TarFormatError);
		expect(() => parseTar(good.subarray(0, 1024), LIMITS)).toThrow(/not terminated/);
		expect(() => parseTar(buildTar([{ path: "f", data: "x".repeat(2000) }]), LIMITS)).toThrow(
			/too large/,
		);
		expect(() =>
			parseTar(buildTar([{ path: "a" }, { path: "b" }]), { maxEntries: 1, maxFileBytes: 10 }),
		).toThrow(/too many/);
	});
	it("a path that escapes the archive root is malformed", () => {
		for (const bad of ["../x", "a/../../x", "a/..", "/etc/passwd"]) {
			expect(() => parseTar(buildTar([{ path: bad, data: "x" }]), LIMITS)).toThrow(
				/escapes the archive root/,
			);
		}
	});
	it("end of archive needs two zero blocks", () => {
		const good = buildTar([{ path: "f", data: "abc" }]);
		const end = good.length - 1024;
		// One zero block, then a stray non-zero block.
		const stray = Buffer.concat([good.subarray(0, end + 512), Buffer.alloc(512, 1)]);
		expect(() => parseTar(stray, LIMITS)).toThrow(/not terminated/);
		// One zero block and nothing after it.
		expect(() => parseTar(good.subarray(0, end + 512), LIMITS)).toThrow(/not terminated/);
		expect(parseTar(good, LIMITS)).toHaveLength(1);
	});
});
