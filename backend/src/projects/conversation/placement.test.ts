/**
 * PROJECT_CONVERSATION.md §6.4 on the REAL filesystem: the races are real
 * renames and symlinks, injected at the two moments the agent could act
 * (after the inbox is proven, and between the temp's verification and its
 * link). The property every test checks: nothing is ever written outside
 * the opened `.st-inbox`, nothing existing is replaced, and "placed" means
 * the final name holds exactly the verified bytes.
 */

import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inboxName, sha256Hex } from "./artifacts.js";
import { INBOX_DIR, type PlacementInput, placeArtifacts } from "./placement.js";

const SID = "5a000000-0000-4000-8000-0000000000aa";
let root: string;
let ws: string;
let outside: string;
const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;

const art = (text: string, name = "fix.diff") => {
	const content = Buffer.from(text);
	return { sha256: sha256Hex(content), name, bytes: content.length, content };
};
const place = (artifacts: PlacementInput["artifacts"], o: Partial<PlacementInput> = {}) =>
	placeArtifacts({ workspaceRoot: root, sessionId: SID, artifacts, uid, gid, ...o });
const listOutside = async () => (await fs.readdir(outside)).sort();

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-place-"));
	ws = path.join(root, SID);
	outside = await fs.mkdtemp(path.join(os.tmpdir(), "st-outside-"));
	await fs.mkdir(ws);
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
	await fs.rm(outside, { recursive: true, force: true });
});

describe("placement (§6.4)", () => {
	it("creates .st-inbox (0755) and publishes each artifact 0644, verified, with no temp left", async () => {
		const a = art("--- a\n+++ b\n");
		const r = await place([a]);
		expect(r).toEqual({
			ok: true,
			placed: [{ sha256: a.sha256, path: `${INBOX_DIR}/${inboxName(a)}` }],
		});
		const inbox = path.join(ws, INBOX_DIR);
		expect((await fs.stat(inbox)).mode & 0o777).toBe(0o755);
		const st = await fs.stat(path.join(inbox, inboxName(a)));
		expect(st.mode & 0o777).toBe(0o644);
		expect(st.uid).toBe(uid);
		expect(await fs.readFile(path.join(inbox, inboxName(a)), "utf8")).toBe("--- a\n+++ b\n");
		expect(await fs.readdir(inbox)).toEqual([inboxName(a)]);
	});

	it("an identical file already there counts as placed; a second placement is idempotent", async () => {
		const a = art("same");
		expect((await place([a])).ok).toBe(true);
		expect((await place([a])).ok).toBe(true);
		expect(await fs.readdir(path.join(ws, INBOX_DIR))).toEqual([inboxName(a)]);
	});

	it("T10: .st-inbox is a symlink to a directory outside ⇒ inbox-not-dir, nothing written there", async () => {
		await fs.symlink(outside, path.join(ws, INBOX_DIR));
		expect(await place([art("x")])).toMatchObject({ ok: false, error: "inbox-not-dir" });
		expect(await listOutside()).toEqual([]);
		expect((await fs.lstat(path.join(ws, INBOX_DIR))).isSymbolicLink()).toBe(true);
	});

	it("T10: .st-inbox is a regular file ⇒ inbox-not-dir, the file untouched", async () => {
		await fs.writeFile(path.join(ws, INBOX_DIR), "mine");
		expect(await place([art("x")])).toMatchObject({ ok: false, error: "inbox-not-dir" });
		expect(await fs.readFile(path.join(ws, INBOX_DIR), "utf8")).toBe("mine");
	});

	it("T11: the inbox path is swapped for a symlink after it was opened ⇒ the file lands in the OPENED directory, never outside", async () => {
		const a = art("payload");
		const moved = path.join(ws, "moved-inbox");
		const r = await place([a], {
			afterInboxOpen: async () => {
				await fs.rename(path.join(ws, INBOX_DIR), moved);
				await fs.symlink(outside, path.join(ws, INBOX_DIR));
			},
		});
		expect(r.ok).toBe(true);
		expect(await listOutside()).toEqual([]);
		expect(await fs.readFile(path.join(moved, inboxName(a)), "utf8")).toBe("payload");
	});

	it("T12: an existing final name with other content, a FIFO, a symlink or > 1 MiB ⇒ exists-different, untouched, no hang", async () => {
		const a = art("expected");
		const inbox = path.join(ws, INBOX_DIR);
		await fs.mkdir(inbox);
		const final = path.join(inbox, inboxName(a));

		await fs.writeFile(final, "other");
		expect(await place([a])).toMatchObject({ ok: false, error: "exists-different" });
		expect(await fs.readFile(final, "utf8")).toBe("other");

		await fs.rm(final);
		execFileSync("mkfifo", [final]);
		expect(await place([a])).toMatchObject({ ok: false, error: "exists-different" });
		expect((await fs.lstat(final)).isFIFO()).toBe(true);

		await fs.rm(final);
		await fs.writeFile(path.join(outside, "target"), "expected");
		await fs.symlink(path.join(outside, "target"), final);
		expect(await place([a])).toMatchObject({ ok: false, error: "exists-different" });
		expect((await fs.lstat(final)).isSymbolicLink()).toBe(true);

		await fs.rm(final);
		await fs.writeFile(final, Buffer.alloc(1024 * 1024 + 1, 0x61));
		expect(await place([a])).toMatchObject({ ok: false, error: "exists-different" });
		expect((await fs.readdir(inbox)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
	});

	it("the temp is swapped between verification and link ⇒ not placed (the final name is not our inode)", async () => {
		const a = art("verified bytes");
		const r = await place([a], {
			beforeLink: async (tmpAt) => {
				await fs.rename(tmpAt, path.join(outside, "stolen"));
				await fs.writeFile(tmpAt, "agent bytes");
			},
		});
		expect(r).toMatchObject({ ok: false, error: "exists-different" });
		// The agent's own file stays where it put it: never deleted by us.
		const inbox = path.join(ws, INBOX_DIR);
		const tmps = (await fs.readdir(inbox)).filter((n) => n.endsWith(".tmp"));
		expect(tmps).toHaveLength(1);
	});

	it("T13: content whose hash is not the expected one is never placed", async () => {
		const a = { ...art("good"), content: Buffer.from("evil") };
		expect(await place([a])).toMatchObject({ ok: false, error: "hash-mismatch" });
		expect(await fs.readdir(ws)).toEqual([]);
	});

	it("T14: a name or hash that sanitizeName could not have produced is refused before the target is opened", async () => {
		const evil = { ...art("x"), name: "x/../../../ESCAPED" };
		await fs.mkdir(path.join(ws, INBOX_DIR, `${evil.sha256.slice(0, 12)}-x`), { recursive: true });
		expect(await place([evil])).toMatchObject({ ok: false, error: "io" });
		expect(await place([{ ...art("y"), name: ".bashrc" }])).toMatchObject({
			ok: false,
			error: "io",
		});
		expect(await place([{ ...art("z"), sha256: "../x" }])).toMatchObject({
			ok: false,
			error: "io",
		});
		expect(await fs.readdir(root)).toEqual([SID]);
	});

	it("T14: names come prefixed by the hash and never leave the inbox", async () => {
		const a = art("n", "x");
		const r = await place([a]);
		expect(r.ok && r.placed[0]?.path).toBe(`${INBOX_DIR}/${a.sha256.slice(0, 12)}-x`);
	});

	it("a missing workspace or an invalid session id ⇒ workspace-unavailable, nothing created", async () => {
		await fs.rm(ws, { recursive: true });
		expect(await place([art("x")])).toMatchObject({ ok: false, error: "workspace-unavailable" });
		expect(await fs.readdir(root)).toEqual([]);
		expect(await place([art("x")], { sessionId: "../etc" })).toMatchObject({
			ok: false,
			error: "workspace-unavailable",
		});
	});

	it("the workspace itself replaced by a symlink ⇒ workspace-unavailable", async () => {
		await fs.rm(ws, { recursive: true });
		await fs.symlink(outside, ws);
		expect(await place([art("x")])).toMatchObject({ ok: false, error: "workspace-unavailable" });
		expect(await listOutside()).toEqual([]);
	});
});
