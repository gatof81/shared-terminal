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

import { readWorkspaceCliVersion, WORKSPACE_CLI_PACKAGE } from "./cliCompat.js";

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
