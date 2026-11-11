/**
 * projects/conversation/store.ts — PROJECT_CONVERSATION.md §2.1, §3.4, §8:
 * one writer, recovery that never sends, the restore marker and journal.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LogLine } from "./log.js";
import { LOG_FILE } from "./log.js";
import { projectDir, RESTORED_MARKER, restoreJournalPath } from "./paths.js";
import { ProjectConversationStore, projectConversationFlagEnabled } from "./store.js";
import type { acquireWriterLock, WriterLock } from "./writerLock.js";

const PID = "6b1f0c4e-1d2a-4b3c-8d4e-5f6a7b8c9d0e";
let root: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-pstore-"));
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

function fakeLock(): { lock: WriterLock; lose: () => void } {
	let held = true;
	let cb: (() => void) | null = null;
	return {
		lock: { held: () => held, onLost: (c) => (cb = c), release: () => (held = false) },
		lose: () => {
			held = false;
			cb?.();
		},
	};
}
const acquireOk =
	(l: WriterLock): typeof acquireWriterLock =>
	async () => ({ ok: true, lock: l });

async function start(bootId: string, l = fakeLock()) {
	const store = await ProjectConversationStore.start({
		workspaceRoot: root,
		bootId,
		acquire: acquireOk(l.lock),
	});
	return { store, ...l };
}

async function readLines(): Promise<LogLine[]> {
	const raw = await fs.readFile(path.join(projectDir(root, PID), LOG_FILE), "utf8");
	return raw
		.split("\n")
		.filter((x) => x !== "")
		.map((x) => JSON.parse(x) as LogLine);
}

describe("flag", () => {
	it("only true/1", () => {
		expect(projectConversationFlagEnabled("true")).toBe(true);
		expect(projectConversationFlagEnabled("1")).toBe(true);
		for (const v of [undefined, "", "yes", "on", "false"])
			expect(projectConversationFlagEnabled(v)).toBe(false);
	});
});

describe("recovery on open (§3.4 rule 4): never a Composer call, never a resend", () => {
	async function seed() {
		const { store } = await start("boot-1");
		await store.critical(PID, async (tx) => {
			await tx.append([
				{
					ev: "message",
					msg_id: "m1",
					client_message_id: "c1",
					kind: "owner",
					to: ["a", "b", "c", "d"],
				},
				{ ev: "delivery", msg_id: "m1", agent_id: "a", state: "planned" },
				{ ev: "delivery", msg_id: "m1", agent_id: "b", state: "planned" },
				{ ev: "delivery", msg_id: "m1", agent_id: "c", state: "planned" },
				{ ev: "delivery", msg_id: "m1", agent_id: "d", state: "planned" },
			]);
			await tx.append([{ ev: "delivery", msg_id: "m1", agent_id: "b", state: "placing" }]);
			await tx.append([{ ev: "delivery", msg_id: "m1", agent_id: "c", state: "sending" }]);
			await tx.append([{ ev: "delivery", msg_id: "m1", agent_id: "d", state: "sending" }]);
			await tx.append([
				{
					ev: "delivery",
					msg_id: "m1",
					agent_id: "d",
					state: "delivered",
					http: { promptId: "p1" },
				},
			]);
			await tx.append([
				{
					ev: "reply_settling",
					msg_id: "m1",
					agent_id: "d",
					sid: "s",
					cid: "c",
					prompt_id: "p1",
					turn_end_seq: 9,
					settle_until: "x",
				},
			]);
		});
		await store.close();
	}

	it("T2/T4/T20d: boot rules", async () => {
		await seed();
		const { store } = await start("boot-2");
		const st = await store.critical(PID, async (tx) => tx.state);
		const by = (a: string) => st.deliveries.get(`m1/${a}`);
		expect(by("a")?.state).toBe("not-sent");
		expect(by("b")).toMatchObject({ state: "not-sent" });
		expect(by("c")?.state).toBe("uncertain");
		expect(by("d")?.state).toBe("delivered");
		const lines = await readLines();
		const rec = lines.filter((l) => l.ev !== "message");
		expect(rec.find((l) => l.agent_id === "a" && l.state === "not-sent")?.reason).toBe(
			"persist-failed",
		);
		expect(
			rec.find((l) => l.agent_id === "b" && l.state === "not-sent")?.files_possibly_placed,
		).toBe(true);
		expect(rec.find((l) => l.agent_id === "c" && l.state === "uncertain")?.reason).toBe("orphaned");
		expect(rec.find((l) => l.ev === "reply_ref")?.attribution).toBe("ambiguous{settle-unobserved}");
		expect(lines[lines.length - 1]).toMatchObject({
			ev: "recovery",
			source: "boot",
			boot_id: "boot-2",
		});
		await store.close();
		// a second boot finds nothing to do and writes nothing
		const n = lines.length;
		const s3 = await start("boot-3");
		await s3.store.critical(PID, async () => {});
		expect((await readLines()).length).toBe(n);
		await s3.store.close();
	});

	it("T15/T15e: restore rules — every unfinished delivery uncertain{restored}; idempotent by restore_id", async () => {
		await seed();
		const dir = projectDir(root, PID);
		await fs.writeFile(
			path.join(dir, RESTORED_MARKER),
			JSON.stringify({ restore_id: "r1", manifest_at: "M" }),
		);
		const { store } = await start("boot-2");
		const st = await store.critical(PID, async (tx) => tx.state);
		for (const a of ["a", "b", "c"]) expect(st.deliveries.get(`m1/${a}`)?.state).toBe("uncertain");
		const lines = await readLines();
		expect(lines.filter((l) => l.state === "uncertain").every((l) => l.reason === "restored")).toBe(
			true,
		);
		expect(lines[lines.length - 1]).toMatchObject({
			ev: "recovery",
			source: "restore",
			restore_id: "r1",
		});
		await store.close();
		expect(await fs.readdir(dir)).toContain(`${RESTORED_MARKER}.consumed-boot-2`);

		// death before the marker's rename: the rules run again and change nothing
		await fs.rename(
			path.join(dir, `${RESTORED_MARKER}.consumed-boot-2`),
			path.join(dir, RESTORED_MARKER),
		);
		const n = lines.length;
		const s3 = await start("boot-3");
		await s3.store.critical(PID, async () => {});
		expect((await readLines()).length).toBe(n);
		await s3.store.close();
	});

	it("an unreadable RESTORED never falls back to the boot rules", async () => {
		await seed();
		await fs.writeFile(path.join(projectDir(root, PID), RESTORED_MARKER), "{");
		const { store } = await start("boot-2");
		await expect(store.critical(PID, async () => {})).rejects.toMatchObject({
			code: "project-log-unverifiable",
		});
		await store.close();
	});
});

describe("restore journal (§8)", () => {
	it("T15c: an open journal makes the project restore-incomplete and no empty log is created", async () => {
		await fs.mkdir(path.dirname(restoreJournalPath(root, PID)), { recursive: true });
		await fs.writeFile(
			restoreJournalPath(root, PID),
			JSON.stringify({ restore_id: "r1", phase: "staging" }),
		);
		const { store } = await start("b");
		await expect(store.critical(PID, async () => {})).rejects.toMatchObject({
			code: "project-log-unverifiable",
			message: "restore-incomplete",
		});
		await expect(fs.lstat(projectDir(root, PID))).rejects.toMatchObject({ code: "ENOENT" });
		await store.close();
	});
});

describe("single writer (§2.1)", () => {
	it("T22b: without the lock every operation is project-writer-unavailable and nothing is written", async () => {
		const store = await ProjectConversationStore.start({
			workspaceRoot: root,
			bootId: "b",
			acquire: async () => ({ ok: false, reason: "busy" }),
		});
		expect(store.unavailable).toBe("busy");
		await expect(store.critical(PID, async () => {})).rejects.toMatchObject({
			code: "project-writer-unavailable",
		});
		await expect(fs.lstat(projectDir(root, PID))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("T22c: losing the lock poisons open logs at once", async () => {
		const { store, lose } = await start("b");
		await store.critical(PID, (tx) =>
			tx.append([{ ev: "message", msg_id: "m1", client_message_id: "c1" }]),
		);
		lose();
		await expect(store.critical(PID, async () => {})).rejects.toMatchObject({
			code: "project-writer-unavailable",
		});
		await store.close();
	});

	it("T5b: critical sections are serial — two writers of the same client id produce one message", async () => {
		const { store } = await start("b");
		const send = () =>
			store.critical(PID, async (tx) => {
				if (tx.state.byClientMessageId.has("c1")) return "replayed";
				await new Promise((r) => setTimeout(r, 5));
				await tx.append([{ ev: "message", msg_id: `m-${Math.random()}`, client_message_id: "c1" }]);
				return "written";
			});
		const r = await Promise.all([send(), send(), send()]);
		expect(r.sort()).toEqual(["replayed", "replayed", "written"]);
		expect((await readLines()).filter((l) => l.ev === "message")).toHaveLength(1);
		await store.close();
	});

	it("after close() nothing reopens or writes, even before the helper has exited", async () => {
		const { store } = await start("b");
		await store.critical(PID, (tx) =>
			tx.append([{ ev: "message", msg_id: "m1", client_message_id: "c1" }]),
		);
		await store.close();
		await expect(store.critical(PID, async () => {})).rejects.toMatchObject({
			code: "project-writer-unavailable",
		});
		expect((await readLines()).length).toBe(1);
	});

	it("a filesystem error at start leaves the subsystem unavailable instead of failing the boot", async () => {
		await fs.writeFile(path.join(root, ".projects"), "not a dir");
		const store = await ProjectConversationStore.start({
			workspaceRoot: root,
			bootId: "b",
			acquire: acquireOk(fakeLock().lock),
		});
		expect(store.unavailable).toBe("error");
	});

	it("a failed critical section does not wedge the next one", async () => {
		const { store } = await start("b");
		await expect(
			store.critical(PID, async () => Promise.reject(new Error("boom"))),
		).rejects.toThrow("boom");
		await expect(store.critical(PID, async () => "ok")).resolves.toBe("ok");
		await store.close();
	});

	it("interleaved writers are reported in recovery", async () => {
		const dir = projectDir(root, PID);
		await fs.mkdir(dir, { recursive: true });
		const l = (seq: number, w: string) =>
			`${JSON.stringify({ seq, ev: "x", at: "t", w, bn: 0 })}\n`;
		await fs.writeFile(path.join(dir, LOG_FILE), l(1, "A") + l(2, "B") + l(3, "A"));
		const { store } = await start("C");
		await store.critical(PID, async () => {});
		const last = (await readLines()).pop();
		expect(last).toMatchObject({ ev: "recovery", foreign_writer: ["A"] });
		await store.close();
	});
});
