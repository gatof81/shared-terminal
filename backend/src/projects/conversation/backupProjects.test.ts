/**
 * projects/conversation/backupProjects.ts — PROJECT_CONVERSATION.md §8:
 * the backup tars a staging copy (no temp files, no torn tail, no artifact
 * whose content is not its name); the restore is refused before any write
 * unless the flag is off, the lock is free and every member is allowlisted;
 * a death at any step never exposes a restored log without its restore
 * condition, and a rerun finishes it.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupProjects, preflightProjectsRestore, restoreProjects } from "./backupProjects.js";
import { LOG_FILE } from "./log.js";
import { projectDir, projectsRoot, restoreJournalPath } from "./paths.js";
import { ProjectConversationStore } from "./store.js";
import type { acquireWriterLock, WriterLock } from "./writerLock.js";

const execFileP = promisify(execFile);
const PID = "6b1f0c4e-1d2a-4b3c-8d4e-5f6a7b8c9d0e";
const quiet = { info: () => {}, warn: () => {} };
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

let src: string;
let dst: string;
let out: string;
beforeEach(async () => {
	src = await fs.mkdtemp(path.join(os.tmpdir(), "st-pbk-src-"));
	dst = await fs.mkdtemp(path.join(os.tmpdir(), "st-pbk-dst-"));
	out = await fs.mkdtemp(path.join(os.tmpdir(), "st-pbk-out-"));
});
afterEach(async () => {
	for (const d of [src, dst, out]) await fs.rm(d, { recursive: true, force: true });
});

const lock = (): WriterLock => {
	let held = true;
	return { held: () => held, onLost: () => {}, release: () => (held = false) };
};
const acquireOk: typeof acquireWriterLock = async () => ({ ok: true, lock: lock() });
const offEnv = {} as NodeJS.ProcessEnv;

async function seedSource(): Promise<void> {
	const store = await ProjectConversationStore.start({
		workspaceRoot: src,
		bootId: "b1",
		acquire: acquireOk,
	});
	await store.critical(PID, async (tx) => {
		await tx.append([
			{ ev: "message", msg_id: "m1", client_message_id: "c1", kind: "owner", to: ["a", "b"] },
			{ ev: "delivery", msg_id: "m1", agent_id: "a", state: "planned" },
			{ ev: "delivery", msg_id: "m1", agent_id: "b", state: "planned" },
		]);
		await tx.append([{ ev: "delivery", msg_id: "m1", agent_id: "b", state: "sending" }]);
	});
	await store.close();
	const dir = projectDir(src, PID);
	// a torn tail, a snapshot temp file, a good and a bad artifact
	await fs.appendFile(path.join(dir, LOG_FILE), '{"seq":5,"ev":"deliv');
	await fs.writeFile(path.join(dir, "conversation.index.json.123.tmp"), "junk");
	await fs.mkdir(path.join(dir, "artifacts"));
	await fs.writeFile(path.join(dir, "artifacts", sha("diff")), "diff");
	await fs.writeFile(path.join(dir, "artifacts", `${sha("diff")}.json`), "{}");
	await fs.writeFile(path.join(dir, "artifacts", sha("other")), "tampered");
	await fs.writeFile(path.join(dir, "artifacts", ".x.tmp"), "partial");
}

async function backup() {
	const projects = await backupProjects(src, out, async () => {}, quiet);
	return { createdAt: "2026-11-12T00:00:00.000Z", projects };
}

async function openLines(root: string) {
	const store = await ProjectConversationStore.start({
		workspaceRoot: root,
		bootId: "boot-dst",
		acquire: acquireOk,
	});
	try {
		return await store.critical(PID, async (tx) => tx.state);
	} finally {
		await store.close();
	}
}

describe("backupProjects", () => {
	it("tars a staging copy: acknowledged log only, verified artifacts only, no temp files", async () => {
		await seedSource();
		const m = await backup();
		expect(m.projects[PID]).toMatchObject({ lastSeq: 4, artifacts: 1, skipped: [sha("other")] });
		const { stdout } = await execFileP("tar", [
			"-tzf",
			path.join(out, "projects", `${PID}.tar.gz`),
		]);
		expect(stdout.split("\n").filter(Boolean).sort()).toEqual(
			[
				`.projects/${PID}/${LOG_FILE}`,
				`.projects/${PID}/artifacts/${sha("diff")}`,
				`.projects/${PID}/artifacts/${sha("diff")}.json`,
			].sort(),
		);
		expect((await fs.readdir(out)).filter((n) => n.startsWith(".projects-staging"))).toEqual([]);
	});
});

describe("restore preflight (before any write)", () => {
	it("refuses with the flag on, with the lock held, or with a tarball member outside the allowlist", async () => {
		await seedSource();
		const m = await backup();
		await expect(
			preflightProjectsRestore(out, m.projects, dst, {
				env: { PROJECT_CONVERSATION_ENABLED: "true" },
			}),
		).rejects.toThrow(/PROJECT_CONVERSATION_ENABLED/);
		await expect(
			preflightProjectsRestore(out, m.projects, dst, {
				env: offEnv,
				acquire: async () => ({ ok: false, reason: "busy" }),
			}),
		).rejects.toThrow(/writer lock is not free/);

		// a symlink member, re-signed so only the allowlist can catch it
		const evil = await fs.mkdtemp(path.join(os.tmpdir(), "st-pbk-evil-"));
		try {
			await fs.mkdir(path.join(evil, ".projects", PID), { recursive: true });
			await fs.symlink("/etc/passwd", path.join(evil, ".projects", PID, LOG_FILE));
			const tarPath = path.join(out, "projects", `${PID}.tar.gz`);
			await execFileP("tar", ["-czf", tarPath, "-C", evil, `.projects/${PID}/${LOG_FILE}`]);
			const tarSha256 = sha(await fs.readFile(tarPath));
			const projects = { [PID]: { ...m.projects[PID], tarSha256 } } as typeof m.projects;
			await expect(
				preflightProjectsRestore(out, projects, dst, { env: offEnv, acquire: acquireOk }),
			).rejects.toThrow(/not allowed/);
		} finally {
			await fs.rm(evil, { recursive: true, force: true });
		}
		// at most the empty `.projects/` the lock file lives in; no project, no journal
		const left = await fs.readdir(projectsRoot(dst)).catch(() => []);
		expect(left.filter((n) => n !== ".writer.lock")).toEqual([]);
	});
});

describe("restoreProjects — staged publication", () => {
	it("publishes with RESTORED inside; the store applies the restore rules (T15)", async () => {
		await seedSource();
		const m = await backup();
		const plan = await preflightProjectsRestore(out, m.projects, dst, {
			env: offEnv,
			acquire: acquireOk,
		});
		expect(plan).not.toBeNull();
		if (!plan) return;
		await restoreProjects(out, m.createdAt, plan, dst, {}, quiet);
		const st = await openLines(dst);
		expect(st.deliveries.get("m1/a")?.state).toBe("uncertain");
		expect(st.deliveries.get("m1/b")?.state).toBe("uncertain");
		expect(await fs.readdir(path.join(projectDir(dst, PID), "artifacts"))).toEqual(
			[sha("diff"), `${sha("diff")}.json`].sort(),
		);
	});

	for (const step of [0, 1, 2, 3, 4]) {
		it(`T15c/T15d: death after step ${step} ⇒ restore-incomplete, never an empty log; a rerun finishes`, async () => {
			await seedSource();
			const m = await backup();
			// step 3 (aside) only happens with --force over an existing project
			const force = step === 3;
			if (force) {
				const store = await ProjectConversationStore.start({
					workspaceRoot: dst,
					bootId: "old",
					acquire: acquireOk,
				});
				await store.critical(PID, (tx) =>
					tx.append([{ ev: "message", msg_id: "old", client_message_id: "old" }]),
				);
				await store.close();
			}
			const plan = await preflightProjectsRestore(out, m.projects, dst, {
				env: offEnv,
				acquire: acquireOk,
			});
			if (!plan) throw new Error("no plan");
			await expect(
				restoreProjects(out, m.createdAt, plan, dst, { force }, quiet, {
					afterStep: async (_pid, s) => {
						if (s === step) throw new Error("crash");
					},
				}),
			).rejects.toThrow("crash");

			const store = await ProjectConversationStore.start({
				workspaceRoot: dst,
				bootId: "mid",
				acquire: acquireOk,
			});
			await expect(store.critical(PID, async () => {})).rejects.toMatchObject({
				message: "restore-incomplete",
			});
			await store.close();
			await expect(fs.lstat(restoreJournalPath(dst, PID))).resolves.toBeTruthy();

			const plan2 = await preflightProjectsRestore(out, m.projects, dst, {
				env: offEnv,
				acquire: acquireOk,
			});
			if (!plan2) throw new Error("no plan");
			await restoreProjects(out, m.createdAt, plan2, dst, { force }, quiet);
			const st = await openLines(dst);
			expect(st.messages.has("m1")).toBe(true);
			expect(st.messages.has("old")).toBe(false);
			expect(st.deliveries.get("m1/b")?.state).toBe("uncertain");
			if (force) {
				const replaced = await fs.readdir(path.join(projectsRoot(dst), ".restore-replaced"));
				expect(replaced).toHaveLength(1);
			}
		});
	}

	it("restored files are 0600 and dirs 0700 whatever the tarball says", async () => {
		await seedSource();
		const m = await backup();
		// re-pack the same members with loose modes, re-signed
		const loose = await fs.mkdtemp(path.join(os.tmpdir(), "st-pbk-loose-"));
		try {
			await execFileP("tar", ["-xzf", path.join(out, "projects", `${PID}.tar.gz`), "-C", loose]);
			for (const f of [
				`.projects/${PID}/${LOG_FILE}`,
				`.projects/${PID}/artifacts/${sha("diff")}`,
			]) {
				await fs.chmod(path.join(loose, f), 0o666);
			}
			const tarPath = path.join(out, "projects", `${PID}.tar.gz`);
			const { stdout } = await execFileP("tar", ["-tzf", tarPath]);
			await execFileP("tar", ["-czf", tarPath, "-C", loose, ...stdout.split("\n").filter(Boolean)]);
			const projects = {
				[PID]: { ...m.projects[PID], tarSha256: sha(await fs.readFile(tarPath)) },
			} as typeof m.projects;
			const plan = await preflightProjectsRestore(out, projects, dst, {
				env: offEnv,
				acquire: acquireOk,
			});
			if (!plan) throw new Error("no plan");
			await restoreProjects(out, m.createdAt, plan, dst, {}, quiet);
			const dir = projectDir(dst, PID);
			expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
			expect((await fs.stat(path.join(dir, LOG_FILE))).mode & 0o777).toBe(0o600);
			expect((await fs.stat(path.join(dir, "artifacts", sha("diff")))).mode & 0o777).toBe(0o600);
		} finally {
			await fs.rm(loose, { recursive: true, force: true });
		}
	});

	it("without --force an existing project is kept and nothing is journaled", async () => {
		await seedSource();
		const m = await backup();
		await fs.mkdir(projectDir(dst, PID), { recursive: true });
		const plan = await preflightProjectsRestore(out, m.projects, dst, {
			env: offEnv,
			acquire: acquireOk,
		});
		if (!plan) throw new Error("no plan");
		await restoreProjects(out, m.createdAt, plan, dst, {}, quiet);
		await expect(fs.lstat(restoreJournalPath(dst, PID))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await fs.readdir(projectDir(dst, PID))).toEqual([]);
	});
});
