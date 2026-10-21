/**
 * workspaceFiles.test.ts — pure-policy unit tests for the restricted-path
 * denylist and the `?path=` param validator. Filesystem behaviour
 * (containment, symlinks, FIFOs) is covered end-to-end through the routes
 * in routes.files.test.ts and routes.download.test.ts.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	isRestrictedPath,
	readHead,
	validateRelPathParam,
	WORKSPACE_PATH_MAX_LEN,
} from "./workspaceFiles.js";

describe("isRestrictedPath", () => {
	it.each([
		".env",
		".env.local",
		".env.production",
		"apps/web/.env",
		"prod.env",
		".ENV",
		".st",
		".st/claude-state/.credentials.json",
		".st/ssh/id_ed25519",
		".ssh/config",
		"nested/.ssh/known_hosts",
		".git",
		".git/config",
		"vendor/lib/.git/config",
		".config/gh",
		".config/gh/hosts.yml",
		".config/gcloud/credentials.db",
		".vscode-cli/token.json",
		".aws/credentials",
		".docker/config.json",
		".netrc",
		".git-credentials",
		".npmrc",
		".claude.json",
		".credentials.json",
		"credentials.json",
		"id_rsa",
		"keys/ID_ED25519",
		"certs/server.pem",
		"tls.key",
		"store.p12",
		"infra/terraform.tfstate",
		"infra/terraform.tfstate.backup",
	])("restricts %s", (p) => {
		expect(isRestrictedPath(p)).toBe(true);
	});

	it.each([
		"",
		"README.md",
		"src/index.ts",
		".env.example",
		".env.sample",
		".env.template",
		"docs/.env.example",
		".config",
		".config/nvim/init.lua",
		"id_ed25519.pub",
		".gitignore",
		".github/workflows/ci.yml",
		".claude/settings.json",
		"CLAUDE.md",
		"environment.ts",
		"keyboard.ts",
		"src/credentials/index.ts",
	])("allows %s", (p) => {
		expect(isRestrictedPath(p)).toBe(false);
	});

	it("applies file-name rules only to a file leaf", () => {
		// A directory named like a secret file is browsable; files in it
		// are judged on their own names.
		expect(isRestrictedPath("src/credentials", "dir")).toBe(false);
		expect(isRestrictedPath(".env", "dir")).toBe(false);
		expect(isRestrictedPath("src/credentials", "file")).toBe(true);
		// Directory rules don't depend on the kind.
		expect(isRestrictedPath(".ssh", "dir")).toBe(true);
		expect(isRestrictedPath("a/.config/gh", "dir")).toBe(true);
	});
});

describe("validateRelPathParam", () => {
	it("defaults a missing path to the root only when allowed", () => {
		expect(validateRelPathParam(undefined, { allowEmpty: true })).toBe("");
		expect(validateRelPathParam("", { allowEmpty: true })).toBe("");
		expect(validateRelPathParam(undefined, { allowEmpty: false })).toMatchObject({ status: 400 });
		expect(validateRelPathParam("", { allowEmpty: false })).toMatchObject({ status: 400 });
	});

	it.each([
		["array", ["a", "b"]],
		["object", { a: "b" }],
		["absolute", "/etc/passwd"],
		["NUL", "a\0b"],
		["too long", "x".repeat(WORKSPACE_PATH_MAX_LEN + 1)],
	])("rejects %s", (_label, value) => {
		expect(validateRelPathParam(value, { allowEmpty: true })).toMatchObject({
			ok: false,
			status: 400,
		});
	});

	it("does not decode percent sequences a second time", () => {
		expect(validateRelPathParam("%2e%2e%2fx", { allowEmpty: false })).toBe("%2e%2e%2fx");
	});
});

describe("readHead", () => {
	async function withFile(content: string, fn: (h: fs.FileHandle) => Promise<void>) {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "st-readhead-"));
		const file = path.join(dir, "f");
		await fs.writeFile(file, content);
		const h = await fs.open(file, "r");
		try {
			await fn(h);
		} finally {
			await h.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	}

	it("returns the whole file when it fits under the limit", async () => {
		await withFile("hello", async (h) => {
			const { bytes, truncated } = await readHead(h, 1024, 5);
			expect(bytes.toString()).toBe("hello");
			expect(truncated).toBe(false);
		});
	});

	it("caps at the limit and flags truncation", async () => {
		await withFile("hello world", async (h) => {
			const { bytes, truncated } = await readHead(h, 5, 11);
			expect(bytes.toString()).toBe("hello");
			expect(truncated).toBe(true);
		});
	});

	it("flags a file that grew past its fstat size as truncated", async () => {
		await withFile("hello world", async (h) => {
			// Caller's fstat said 5 bytes; the file now holds more.
			const { bytes, truncated } = await readHead(h, 1024, 5);
			expect(bytes.toString()).toBe("hello");
			expect(truncated).toBe(true);
		});
	});

	it("handles empty files", async () => {
		await withFile("", async (h) => {
			expect(await readHead(h, 1024, 0)).toEqual({ bytes: Buffer.alloc(0), truncated: false });
		});
	});
});
