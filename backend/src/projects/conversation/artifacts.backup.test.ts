/**
 * D2 through backup and restore (PROJECT_CONVERSATION.md §6, §8; T15, T17):
 * an artifact registered for real survives a backup + restore — content
 * and `artifact` event — an unfinished placement comes back
 * `uncertain{restored}` with `files_possibly_placed` (never re-placed, never
 * sent), and a tarball whose artifact bytes do not match their name never
 * publishes them: the bytes go to `.restore-evidence/`, and the API then
 * answers `artifact-corrupt` instead of serving anything.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SRC = vi.hoisted(() => {
	const dir = `/tmp/st-art-bk-src-${process.pid}-${Date.now()}`;
	process.env.WORKSPACE_ROOT = dir;
	return dir;
});

import { openWorkspaceFile } from "../../workspaceFiles.js";
import { ProjectArtifacts, sha256Hex } from "./artifacts.js";
import { backupProjects, preflightProjectsRestore, restoreProjects } from "./backupProjects.js";
import type { ProjectBindings } from "./fanout.js";
import { projectDir } from "./paths.js";
import { ProjectConversationStore } from "./store.js";
import type { acquireWriterLock } from "./writerLock.js";

const execFileP = promisify(execFile);
const PID = "6b1f0c4e-1d2a-4b3c-8d4e-5f6a7b8c9d0e";
const OWNER = "u-owner";
const DEV = "a0000000-0000-4000-8000-00000000000a";
const QA = "b0000000-0000-4000-8000-00000000000b";
const SID = "5a000000-0000-4000-8000-0000000000aa";
const quiet = { info: () => {}, warn: () => {} };
const acquireOk: typeof acquireWriterLock = async () => ({
	ok: true,
	lock: { held: () => true, onLost: () => {}, release: () => {} },
});

let dst: string;
let out: string;
beforeEach(async () => {
	await fs.mkdir(path.join(SRC, SID), { recursive: true });
	dst = await fs.mkdtemp(path.join(os.tmpdir(), "st-art-bk-dst-"));
	out = await fs.mkdtemp(path.join(os.tmpdir(), "st-art-bk-out-"));
});
afterEach(async () => {
	for (const d of [SRC, dst, out]) await fs.rm(d, { recursive: true, force: true });
});
afterAll(async () => {
	await fs.rm(SRC, { recursive: true, force: true });
});

const artifactsOn = (store: ProjectConversationStore, root: string) =>
	new ProjectArtifacts({
		store,
		workspaceRoot: root,
		bindings: async (): Promise<ProjectBindings> =>
			new Map([[DEV, { removed: false, binding: { bindingId: "b", epoch: 1, sessionId: SID } }]]),
		openSource: (sid, rel, o) => openWorkspaceFile(sid, rel, o),
		assertOwner: async () => {},
	});

/** A registered artifact and a message whose delivery to QA died while placing it. */
async function seed(): Promise<string> {
	await fs.writeFile(path.join(SRC, SID, "fix.diff"), "--- a\n+++ b\n");
	const store = await ProjectConversationStore.start({
		workspaceRoot: SRC,
		bootId: "src",
		acquire: acquireOk,
	});
	const r = await artifactsOn(store, SRC).register(OWNER, PID, { agentId: DEV, path: "fix.diff" });
	expect(r.status).toBe(201);
	const sha = (r.body as { sha256: string }).sha256;
	const ref = { sha256: sha, name: "fix.diff", bytes: 12 };
	await store.critical(PID, (tx) =>
		tx.append([
			{
				ev: "message",
				msg_id: "m1",
				client_message_id: "c1",
				kind: "owner",
				to: [QA],
				artifacts: [ref],
			},
			{ ev: "delivery", msg_id: "m1", agent_id: QA, state: "planned" },
		]),
	);
	await store.critical(PID, (tx) =>
		tx.append([{ ev: "delivery", msg_id: "m1", agent_id: QA, state: "placing", artifacts: [ref] }]),
	);
	await store.close();
	return sha;
}

async function backupAndRestore(
	tamper?: (loose: string, sha: string) => Promise<void>,
	sha?: string,
) {
	const projects = await backupProjects(SRC, out, async () => {}, quiet);
	const tarPath = path.join(out, "projects", `${PID}.tar.gz`);
	if (tamper && sha) {
		const loose = await fs.mkdtemp(path.join(os.tmpdir(), "st-art-bk-loose-"));
		try {
			const { stdout } = await execFileP("tar", ["-tzf", tarPath]);
			await execFileP("tar", ["-xzf", tarPath, "-C", loose]);
			await tamper(loose, sha);
			await execFileP("tar", ["-czf", tarPath, "-C", loose, ...stdout.split("\n").filter(Boolean)]);
			const entry = projects[PID];
			if (entry) entry.tarSha256 = sha256Hex(await fs.readFile(tarPath));
		} finally {
			await fs.rm(loose, { recursive: true, force: true });
		}
	}
	const plan = await preflightProjectsRestore(out, projects, dst, { env: {}, acquire: acquireOk });
	if (!plan) throw new Error("no restore plan");
	await restoreProjects(out, "2026-11-12T00:00:00.000Z", plan, dst, {}, quiet);
	return ProjectConversationStore.start({ workspaceRoot: dst, bootId: "dst", acquire: acquireOk });
}

describe("D2 artifacts through backup and restore (§8)", () => {
	it("T15: content, event and identity survive; an unfinished placement is uncertain{restored} with files_possibly_placed", async () => {
		const sha = await seed();
		const store = await backupAndRestore();
		try {
			const { state, lines } = await store.view(PID);
			expect(state.artifacts.get(sha)).toMatchObject({ name: "fix.diff", bytes: 12 });
			expect(lines.filter((l) => l.agent_id === QA).map((l) => l.state)).toEqual([
				"planned",
				"placing",
				"uncertain",
			]);
			expect(lines.find((l) => l.state === "uncertain")).toMatchObject({
				reason: "restored",
				files_possibly_placed: true,
			});
			const art = artifactsOn(store, dst);
			const c = await art.content(PID, sha);
			expect("ok" in c && c.content.toString()).toBe("--- a\n+++ b\n");
		} finally {
			await store.close();
		}
	});

	it("T17: an artifact whose bytes no longer match its name is kept as evidence, never published or served", async () => {
		const sha = await seed();
		const store = await backupAndRestore(async (loose, s) => {
			const f = path.join(loose, ".projects", PID, "artifacts", s);
			await fs.chmod(f, 0o600);
			await fs.writeFile(f, "--- a\n+++ EVIL\n");
		}, sha);
		try {
			expect(await fs.readdir(path.join(projectDir(dst, PID), "artifacts"))).not.toContain(sha);
			expect(
				await fs.readFile(path.join(dst, ".restore-evidence", "projects", PID, sha), "utf8"),
			).toBe("--- a\n+++ EVIL\n");
			// The log still names it; the API refuses rather than serve other bytes.
			expect(await artifactsOn(store, dst).content(PID, sha)).toMatchObject({
				status: 409,
				body: { error: "artifact-corrupt" },
			});
		} finally {
			await store.close();
		}
	});
});
