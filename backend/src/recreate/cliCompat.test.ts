/**
 * recreate/cliCompat.ts — the workspace CLI's version, read on the host
 * without following symlinks; anything unreadable is null (blocks).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const WORKSPACE_ROOT = vi.hoisted(() => {
	const dir = `/tmp/st-clicompat-${process.pid}-${Date.now()}`;
	process.env.WORKSPACE_ROOT = dir;
	return dir;
});

import {
	CONTROL_MARKER_VALIDATED_CLI,
	decideRecreateCli,
	parseRecreateCliPolicy,
	readWorkspaceCliVersion,
	WORKSPACE_CLI_PACKAGE,
} from "./cliCompat.js";

const SID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const PKG = path.join(WORKSPACE_ROOT, SID, WORKSPACE_CLI_PACKAGE);

beforeEach(async () => {
	await fs.rm(WORKSPACE_ROOT, { recursive: true, force: true });
	await fs.mkdir(path.dirname(PKG), { recursive: true });
});
afterAll(async () => {
	await fs.rm(WORKSPACE_ROOT, { recursive: true, force: true });
});

describe("readWorkspaceCliVersion", () => {
	it("the package's version", async () => {
		await fs.writeFile(
			PKG,
			JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.1.308" }),
		);
		expect(await readWorkspaceCliVersion(SID)).toBe("2.1.308");
	});

	it("missing, symlinked, unparseable or without a version ⇒ null", async () => {
		expect(await readWorkspaceCliVersion(SID)).toBeNull();
		const elsewhere = path.join(WORKSPACE_ROOT, "elsewhere.json");
		await fs.writeFile(elsewhere, JSON.stringify({ version: "2.1.308" }));
		await fs.symlink(elsewhere, PKG);
		expect(await readWorkspaceCliVersion(SID)).toBeNull();
		await fs.rm(PKG);
		await fs.writeFile(PKG, "{not json");
		expect(await readWorkspaceCliVersion(SID)).toBeNull();
		await fs.writeFile(PKG, JSON.stringify({ version: 2 }));
		expect(await readWorkspaceCliVersion(SID)).toBeNull();
	});
});

describe("recreation CLI policy: minimum + deny list (owner, 2026-11-10)", () => {
	const def = parseRecreateCliPolicy({});
	it("default floor = the lowest validated version; validated ones pass as such", () => {
		expect(def.min).toBe("2.1.308");
		for (const v of CONTROL_MARKER_VALIDATED_CLI) {
			expect(decideRecreateCli(def, v)).toEqual({ ok: true, by: "validated" });
		}
	});
	it("any later stable release passes without validation — patch, minor, major", () => {
		for (const v of ["2.1.330", "2.1.999", "2.2.0", "3.0.0"]) {
			expect(decideRecreateCli(def, v), v).toEqual({ ok: true, by: "min" });
		}
	});
	it("still blocks: unreadable, below the floor, not a plain stable release", () => {
		expect(decideRecreateCli(def, null)).toEqual({ ok: false, detail: "unreadable" });
		expect(decideRecreateCli(def, "2.1.307")).toEqual({ ok: false, detail: "below-min:2.1.307" });
		for (const v of ["2.1.322-rc.1", "2.1.322+build", "latest", "02.1.322", ""]) {
			expect(decideRecreateCli(def, v), v).toMatchObject({
				ok: false,
				detail: expect.stringMatching(/^not-a-stable-release:/),
			});
		}
	});
	it("the deny list wins, over the floor and over the validated set", () => {
		const p = parseRecreateCliPolicy({ RECREATE_CLI_DENY: "2.1.330, 2.1.316" });
		expect(decideRecreateCli(p, "2.1.330")).toEqual({ ok: false, detail: "denied:2.1.330" });
		expect(decideRecreateCli(p, "2.1.316")).toEqual({ ok: false, detail: "denied:2.1.316" });
		expect(decideRecreateCli(p, "2.1.331")).toEqual({ ok: true, by: "min" });
	});
	it("off ⇒ the validated set only (the previous rule)", () => {
		const p = parseRecreateCliPolicy({ RECREATE_CLI_MIN_VERSION: "off" });
		expect(p.min).toBeNull();
		expect(decideRecreateCli(p, "2.1.316")).toEqual({ ok: true, by: "validated" });
		expect(decideRecreateCli(p, "2.1.322")).toEqual({ ok: true, by: "validated" });
		expect(decideRecreateCli(p, "2.1.330")).toEqual({ ok: false, detail: "not-validated:2.1.330" });
	});
	it("a raised floor retires the validated versions below it too", () => {
		const p = parseRecreateCliPolicy({ RECREATE_CLI_MIN_VERSION: "2.1.316" });
		expect(decideRecreateCli(p, "2.1.308")).toEqual({ ok: false, detail: "below-min:2.1.308" });
		expect(decideRecreateCli(p, "2.1.314")).toEqual({ ok: false, detail: "below-min:2.1.314" });
		expect(decideRecreateCli(p, "2.1.316")).toEqual({ ok: true, by: "validated" });
		expect(decideRecreateCli(p, "2.1.322")).toEqual({ ok: true, by: "validated" });
		expect(decideRecreateCli(p, "2.1.330")).toEqual({ ok: true, by: "min" });
	});

	it("a chosen floor must be validated; malformed settings refuse to start", () => {
		expect(parseRecreateCliPolicy({ RECREATE_CLI_MIN_VERSION: "2.1.314" }).min).toBe("2.1.314");
		expect(() => parseRecreateCliPolicy({ RECREATE_CLI_MIN_VERSION: "2.1.320" })).toThrow(
			/must be a validated version/,
		);
		for (const bad of ["latest", ">=2.1.308", "2.1"]) {
			expect(() => parseRecreateCliPolicy({ RECREATE_CLI_MIN_VERSION: bad }), bad).toThrow(
				/not a version/,
			);
		}
		expect(() => parseRecreateCliPolicy({ RECREATE_CLI_DENY: "2.1.330,next" })).toThrow(
			/RECREATE_CLI_DENY: not a version: next/,
		);
	});
});
