import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// WORKSPACE_ROOT and UPLOAD_QUOTA_BYTES are read into module-level consts
// when dockerManager.ts loads, so they have to be set BEFORE any import of
// that module. vi.hoisted runs before all imports — including the ones
// later in this file — making it the right place to mutate process.env.
//
// The quota is set tight (10 KB) so we can deterministically trigger
// UploadQuotaExceededError with a single ~15 KB tmp file.
const WORKSPACE_ROOT = vi.hoisted(() => {
	const dir = `/tmp/st-uploads-test-${process.pid}-${Date.now()}`;
	process.env.WORKSPACE_ROOT = dir;
	process.env.UPLOAD_QUOTA_BYTES = "10000";
	return dir;
});

// dockerode tries to lazy-connect on first call, not at construction —
// passing a bogus socket keeps the constructor happy and these tests
// never exercise any docker.* path.
const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({ results: [], meta: { changes: 0 } })),
}));
vi.mock("./db.js", () => dbStubs);

import { DockerManager, UploadQuotaExceededError } from "./dockerManager.js";
import type { SessionManager } from "./sessionManager.js";

function makeDocker(): DockerManager {
	const fakeSessions = {} as unknown as SessionManager;
	return new DockerManager(fakeSessions, { socketPath: "/dev/null" });
}

// Drop a file in the multer tmp dir as if multer's diskStorage had just
// streamed an upload there. Returns the shape writeUploads consumes.
async function makeTmpFile(
	dm: DockerManager,
	originalname: string,
	content: string | Buffer,
): Promise<{ originalname: string; path: string }> {
	const tmpDir = dm.getUploadTmpDir();
	await fs.mkdir(tmpDir, { recursive: true });
	const tmpPath = path.join(tmpDir, `tmp-${Math.random().toString(36).slice(2)}`);
	await fs.writeFile(tmpPath, content);
	return { originalname, path: tmpPath };
}

async function rmRf(p: string): Promise<void> {
	await fs.rm(p, { recursive: true, force: true });
}

beforeAll(async () => {
	await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
});

afterAll(async () => {
	await rmRf(WORKSPACE_ROOT);
});

describe("writeUploads", () => {
	let dm: DockerManager;

	beforeEach(async () => {
		// Wipe per-test state — the prior test's session dirs and any
		// stragglers in the tmp dir would otherwise pollute the next
		// test's expectations.
		const entries = await fs.readdir(WORKSPACE_ROOT).catch(() => [] as string[]);
		for (const e of entries) await rmRf(path.join(WORKSPACE_ROOT, e));
		dm = makeDocker();
	});

	// Helper: per-session uploads dir on host, where writeUploads
	// actually moves files to. Lives at <WORKSPACE_ROOT>/.uploads/
	// <sessionId>/ — out-of-workspace by design (TOCTOU isolation,
	// see writeUploadsImpl). spawn() bind-mounts this dir read-only
	// into the container at /home/developer/uploads/ (#188 PR 188a
	// moved it out of /home/developer/workspace/ so the workspace
	// stays clean for #188's repo-clone replace-workspace mode), but
	// these tests never construct containers — they only exercise
	// host-side state.
	const uploadsHostDir = (sid: string) => path.join(WORKSPACE_ROOT, ".uploads", sid);

	it("writes each file under .uploads/<session>/ and returns the in-container path", async () => {
		// Two small files, well under the 10 KB quota.
		const a = await makeTmpFile(dm, "alpha.png", "alpha-bytes");
		const b = await makeTmpFile(dm, "beta.txt", "beta-bytes");

		const result = await dm.writeUploads("session-happy", [a, b]);

		expect(result).toHaveLength(2);
		for (const p of result) {
			expect(p.startsWith("/home/developer/uploads/")).toBe(true);
		}
		// The container paths' filenames map directly onto the
		// host-side basenames — useful guarantee for tests that want
		// to spot-check on-disk state.
		const onDisk = await fs.readdir(uploadsHostDir("session-happy"));
		expect(onDisk).toHaveLength(2);
		for (const p of result) {
			expect(onDisk).toContain(path.basename(p));
		}

		// Tmp dir should be empty — every file got renamed (moved),
		// not copied; orphans here would leak under the rate limiter.
		const tmpEntries = await fs.readdir(dm.getUploadTmpDir());
		expect(tmpEntries).toHaveLength(0);
	});

	it("preserves file content across the rename(2) move", async () => {
		const payload = Buffer.from("the quick brown fox jumps over the lazy dog");
		const f = await makeTmpFile(dm, "phrase.txt", payload);

		const [containerPath] = await dm.writeUploads("session-content", [f]);
		expect(containerPath).toBeDefined();
		const hostPath = path.join(
			uploadsHostDir("session-content"),
			path.basename(containerPath as string),
		);
		const written = await fs.readFile(hostPath);
		expect(written.equals(payload)).toBe(true);
	});

	it("throws UploadQuotaExceededError and cleans tmp files when batch exceeds quota", async () => {
		// 15 KB > 10 KB cap, in a single file.
		const big = await makeTmpFile(dm, "log.txt", "x".repeat(15000));

		await expect(dm.writeUploads("session-quota", [big])).rejects.toBeInstanceOf(
			UploadQuotaExceededError,
		);

		// Tmp file unlinked on the bail-out path.
		const tmpEntries = await fs.readdir(dm.getUploadTmpDir());
		expect(tmpEntries).toHaveLength(0);

		// Nothing landed in the session's uploads dir.
		const onDisk = await fs.readdir(uploadsHostDir("session-quota")).catch(() => [] as string[]);
		expect(onDisk).toHaveLength(0);
	});

	it("counts pre-existing uploads against the quota across requests", async () => {
		// First request: 6 KB succeeds.
		const first = await makeTmpFile(dm, "a.txt", "x".repeat(6000));
		await dm.writeUploads("session-cumulative", [first]);

		// Second request: 5 KB would push total to 11 KB > 10 KB cap.
		const second = await makeTmpFile(dm, "b.txt", "x".repeat(5000));
		await expect(dm.writeUploads("session-cumulative", [second])).rejects.toBeInstanceOf(
			UploadQuotaExceededError,
		);

		// First file is still in place; only the second was rejected.
		const onDisk = await fs.readdir(uploadsHostDir("session-cumulative"));
		expect(onDisk).toHaveLength(1);
	});

	it("serialises concurrent writeUploads for the same session so two batches can't both pass the quota check", async () => {
		// Each batch is 6 KB on its own; either alone fits under the
		// 10 KB cap. Together they would push to 12 KB and break the
		// cap — but only if the two reads of usedBytes both saw
		// zero. The per-session lock guarantees the second batch
		// reads the first's bytes, so exactly one wins.
		const a = await makeTmpFile(dm, "a.txt", "x".repeat(6000));
		const b = await makeTmpFile(dm, "b.txt", "x".repeat(6000));

		const results = await Promise.allSettled([
			dm.writeUploads("session-concurrent", [a]),
			dm.writeUploads("session-concurrent", [b]),
		]);

		const fulfilled = results.filter((r) => r.status === "fulfilled");
		const rejected = results.filter((r) => r.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(UploadQuotaExceededError);

		// Exactly one file on disk under uploads/.
		const onDisk = await fs.readdir(uploadsHostDir("session-concurrent"));
		expect(onDisk).toHaveLength(1);
		// Both tmp files cleaned up — winner via rename, loser via cleanupTmp.
		const tmpEntries = await fs.readdir(dm.getUploadTmpDir());
		expect(tmpEntries).toHaveLength(0);
	});

	it("rejects when the resolved session path escapes the .uploads/ namespace", async () => {
		// sessionId "../escape" makes path.join collapse one level —
		// path.join(WORKSPACE_ROOT, ".uploads", "../escape") is
		// <WORKSPACE_ROOT>/escape, still under WORKSPACE_ROOT but
		// outside .uploads/. The containment check below is scoped to
		// .uploads/ specifically (NOT just WORKSPACE_ROOT) so the
		// traversal is caught before any fs op runs.
		const f = await makeTmpFile(dm, "evil.txt", "payload");
		await expect(dm.writeUploads("../escape", [f])).rejects.toThrow(/unsafe session path/);
		// Tmp file cleaned up on the bail-out.
		const tmpEntries = await fs.readdir(dm.getUploadTmpDir());
		expect(tmpEntries).toHaveLength(0);
	});

	it("returns an empty array (and writes nothing) for an empty file list", async () => {
		const result = await dm.writeUploads("session-empty", []);
		expect(result).toEqual([]);
		// Should not even mkdir the uploads dir for an empty batch.
		const sessionDir = uploadsHostDir("session-empty");
		const exists = await fs.stat(sessionDir).then(
			() => true,
			() => false,
		);
		expect(exists).toBe(false);
	});
});

describe("sweepUploadTmp", () => {
	let dm: DockerManager;
	beforeEach(() => {
		dm = makeDocker();
	});

	it("removes every file in the tmp dir", async () => {
		const tmpDir = dm.getUploadTmpDir();
		await fs.mkdir(tmpDir, { recursive: true });
		await fs.writeFile(path.join(tmpDir, "stale1"), "x");
		await fs.writeFile(path.join(tmpDir, "stale2"), "y");

		await dm.sweepUploadTmp();

		const remaining = await fs.readdir(tmpDir);
		expect(remaining).toEqual([]);
	});

	it("no-ops when the tmp dir doesn't exist (fresh deployment)", async () => {
		await rmRf(dm.getUploadTmpDir());
		await expect(dm.sweepUploadTmp()).resolves.toBeUndefined();
	});
});
