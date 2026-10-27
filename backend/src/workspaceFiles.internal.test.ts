/**
 * The two backend-internal options of `openWorkspaceFile` (3.0d managed
 * skills check): `allowRestricted` and the `absent` flag. Neither changes
 * what a route answers: without the option `.st/` stays 403, and every 404
 * keeps the same status and `error` text.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const WORKSPACE_ROOT = vi.hoisted(() => {
	const dir = `/tmp/st-wsf-internal-${process.pid}-${Date.now()}`;
	process.env.WORKSPACE_ROOT = dir;
	return dir;
});

import { openWorkspaceFile } from "./workspaceFiles.js";

const SID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const WS = path.join(WORKSPACE_ROOT, SID);

beforeAll(async () => {
	await fs.mkdir(path.join(WS, ".st/claude-state/skills/a"), { recursive: true });
	await fs.writeFile(path.join(WS, ".st/claude-state/skills/a/SKILL.md"), "x");
	await fs.writeFile(path.join(WS, "plain.txt"), "p");
	await fs.symlink(path.join(WS, "plain.txt"), path.join(WS, "link.txt"));
});
afterAll(async () => {
	await fs.rm(WORKSPACE_ROOT, { recursive: true, force: true });
});

describe("openWorkspaceFile internal options", () => {
	it("`.st/` is still restricted by default; allowRestricted opens it with the same containment", async () => {
		expect(await openWorkspaceFile(SID, ".st/claude-state/skills/a/SKILL.md")).toMatchObject({
			ok: false,
			status: 403,
		});
		const r = await openWorkspaceFile(SID, ".st/claude-state/skills/a/SKILL.md", {
			allowRestricted: true,
		});
		expect(r.ok).toBe(true);
		if (r.ok) await r.handle.close();
		// Containment still applies with the option.
		expect(await openWorkspaceFile(SID, "../other/x", { allowRestricted: true })).toMatchObject({
			ok: false,
		});
	});

	it("`absent` marks ENOENT only; a symlink leaf is a plain no-disclosure 404", async () => {
		expect(await openWorkspaceFile(SID, "missing/file")).toEqual({
			ok: false,
			status: 404,
			error: "File not found",
			absent: true,
		});
		expect(await openWorkspaceFile(SID, "missing.txt")).toMatchObject({ absent: true });
		expect(await openWorkspaceFile(SID, "link.txt")).toEqual({
			ok: false,
			status: 404,
			error: "File not found",
		});
		expect(await openWorkspaceFile(SID, "plain.txt/below")).toEqual({
			ok: false,
			status: 404,
			error: "File not found",
		});
	});
});
