/**
 * PROJECT_CONVERSATION.md §6.1–§6.2 against the real Files opener, the real
 * store and a real WORKSPACE_ROOT: what may become an artifact (T9), how it
 * is stored (content-addressed, never replaced, verified on every read),
 * the per-project quota decided under the lock, and the name rule (T14).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Before any import reads it (workspaceFiles.ts takes WORKSPACE_ROOT at load).
const ROOT = vi.hoisted(() => {
	const dir = `/tmp/st-artifacts-ws-${process.pid}-${Date.now()}`;
	process.env.WORKSPACE_ROOT = dir;
	return dir;
});

import { logger } from "../../logger.js";
import { openWorkspaceFile } from "../../workspaceFiles.js";
import {
	ARTIFACT_MAX_BYTES,
	artifactLine,
	composeText,
	isText,
	metaBuffer,
	ProjectArtifacts,
	sanitizeName,
	sha256Hex,
} from "./artifacts.js";
import type { ProjectBindings } from "./fanout.js";
import { type LogLine, ProjectLogError } from "./log.js";
import { projectDir } from "./paths.js";
import { ProjectConversationStore } from "./store.js";
import type { WriterLock } from "./writerLock.js";

const PID = "6b1f0c4e-1d2a-4b3c-8d4e-5f6a7b8c9d0e";
const OWNER = "u-owner";
const DEV = "a0000000-0000-4000-8000-00000000000a";
const GONE = "c0000000-0000-4000-8000-00000000000c";
const SID = "5a000000-0000-4000-8000-0000000000aa";
const WS = path.join(ROOT, SID);
const lock = (): WriterLock => ({ held: () => true, onLost: () => {}, release: () => {} });

let store: ProjectConversationStore;
let art: ProjectArtifacts;
let projectMax: number;
let foreign: Set<string>;

const bindings = (): ProjectBindings =>
	new Map([
		[DEV, { removed: false, binding: { bindingId: "b", epoch: 1, sessionId: SID } }],
		[GONE, { removed: true, binding: null }],
	]);

beforeEach(async () => {
	await fs.mkdir(WS, { recursive: true });
	store = await ProjectConversationStore.start({
		workspaceRoot: ROOT,
		bootId: "b",
		acquire: async () => ({ ok: true, lock: lock() }),
	});
	projectMax = 256 * 1024 * 1024;
	foreign = new Set();
	art = new ProjectArtifacts({
		store,
		workspaceRoot: ROOT,
		bindings: async (o, p) => (o === OWNER && p === PID ? bindings() : null),
		openSource: (sid, rel, o) => openWorkspaceFile(sid, rel, o),
		assertOwner: async (sid, ownerId) => {
			if (foreign.has(sid) || ownerId !== OWNER) throw new Error("forbidden");
		},
		isForbidden: (e) => (e as Error).message === "forbidden",
		get projectMaxBytes() {
			return projectMax;
		},
	});
});
afterEach(async () => {
	await store.close();
	await fs.rm(ROOT, { recursive: true, force: true });
});
afterAll(async () => {
	await fs.rm(ROOT, { recursive: true, force: true });
});

const put = async (rel: string, content: string | Buffer) => {
	await fs.mkdir(path.dirname(path.join(WS, rel)), { recursive: true });
	await fs.writeFile(path.join(WS, rel), content);
};
const reg = (p: string, agentId = DEV) => art.register(OWNER, PID, { agentId, path: p });
const artifactEvents = async (): Promise<LogLine[]> =>
	(await store.view(PID)).lines.filter((l) => l.ev === "artifact");

describe("pure rules", () => {
	it("T14: names are cut to the safe set, never start with a dot, never carry a path", () => {
		expect(sanitizeName("a/b/fix.diff")).toBe("fix.diff");
		expect(sanitizeName("../x")).toBe("x");
		expect(sanitizeName(".bashrc")).toBe("_bashrc");
		expect(sanitizeName("..")).toBe("__");
		expect(sanitizeName("informe ñandú 🚀.md")).toBe("informe__and___.md");
		expect(sanitizeName("x".repeat(200))).toHaveLength(96);
		expect(sanitizeName("")).toBe("artifact");
	});

	it("text is UTF-8 without NUL", () => {
		expect(isText(Buffer.from("hola ñ\n"))).toBe(true);
		expect(isText(Buffer.from([0x68, 0x00]))).toBe(false);
		expect(isText(Buffer.from([0xff, 0xfe, 0x41]))).toBe(false);
	});

	it("§6.3: one line per artifact after the text, pointing into .st-inbox by its hash prefix", () => {
		const a = { sha256: "a".repeat(64), name: "fix.diff", bytes: 12 };
		expect(artifactLine(a)).toBe(
			`[artefacto] fix.diff · 12 B · sha256 ${"a".repeat(64)} · ~/workspace/.st-inbox/aaaaaaaaaaaa-fix.diff`,
		);
		expect(composeText("hola", [a])).toBe(`hola\n${artifactLine(a)}`);
		expect(composeText("hola", [])).toBe("hola");
	});
});

describe("register (§6.1, §6.2)", () => {
	it("stores the content content-addressed (0600, final name only after verification) and logs one event", async () => {
		await put("out/fix.diff", "--- a\n+++ b\n");
		const r = await reg("out/fix.diff");
		const sha = sha256Hex("--- a\n+++ b\n");
		expect(r).toEqual({
			status: 201,
			body: { sha256: sha, name: "fix.diff", bytes: 12, replayed: false },
		});
		const dir = path.join(projectDir(ROOT, PID), "artifacts");
		expect(await fs.readFile(path.join(dir, sha), "utf8")).toBe("--- a\n+++ b\n");
		expect((await fs.stat(path.join(dir, sha))).mode & 0o777).toBe(0o600);
		expect(JSON.parse(await fs.readFile(path.join(dir, `${sha}.json`), "utf8"))).toMatchObject({
			sha256: sha,
			name: "fix.diff",
			source: { kind: "owner", sid: SID, path: "out/fix.diff", agent_id: DEV },
		});
		expect((await fs.readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
		const ev = await artifactEvents();
		expect(ev).toHaveLength(1);
		expect(ev[0]).toMatchObject({
			sha256: sha,
			bytes: 12,
			by: OWNER,
			source: { sid: SID, path: "out/fix.diff" },
		});
	});

	it("the same content from the same source is a replay; from another path, a second event counted once", async () => {
		await put("a.txt", "same");
		await put("b.txt", "same");
		expect((await reg("a.txt")).status).toBe(201);
		expect(await reg("a.txt")).toMatchObject({ status: 200, body: { replayed: true } });
		expect(await reg("b.txt")).toMatchObject({ status: 201, body: { name: "a.txt" } });
		expect(await artifactEvents()).toHaveLength(2);
		expect((await store.view(PID)).state.artifactBytes).toBe(4);
	});

	it("T9: credentials, links, directories, too large and binary are refused, with no event", async () => {
		await put(".env", "SECRET=1");
		await put(".git/config", "[core]");
		await put(".ssh/id_ed25519", "k");
		await put("real.txt", "ok");
		await fs.symlink(path.join(WS, "real.txt"), path.join(WS, "link.txt"));
		await fs.symlink("/etc", path.join(WS, "etc"));
		await fs.mkdir(path.join(WS, "dir"));
		await put("big.txt", Buffer.alloc(ARTIFACT_MAX_BYTES + 1, 0x61));
		await put("bin.dat", Buffer.from([0x00, 0x01, 0x02]));
		await put("latin1.txt", Buffer.from([0xe9, 0x74, 0xe9]));
		await put("empty.txt", "");
		expect(await reg(".env")).toMatchObject({
			status: 403,
			body: { error: "artifact-restricted" },
		});
		expect(await reg(".git/config")).toMatchObject({ status: 403 });
		expect(await reg(".ssh/id_ed25519")).toMatchObject({ status: 403 });
		expect(await reg("link.txt")).toMatchObject({
			status: 404,
			body: { error: "artifact-not-found" },
		});
		expect(await reg("etc/passwd")).toMatchObject({ status: 404 });
		expect(await reg("../../etc/passwd")).toMatchObject({ status: 404 });
		expect(await reg("/etc/passwd")).toMatchObject({ status: 400 });
		expect(await reg("dir")).toMatchObject({ status: 400 });
		expect(await reg("missing.txt")).toMatchObject({ status: 404 });
		expect(await reg("big.txt")).toMatchObject({
			status: 413,
			body: { error: "artifact-too-large" },
		});
		expect(await reg("bin.dat")).toMatchObject({
			status: 415,
			body: { error: "artifact-not-text" },
		});
		expect(await reg("latin1.txt")).toMatchObject({ status: 415 });
		expect(await reg("empty.txt")).toMatchObject({ status: 415 });
		expect(await artifactEvents()).toEqual([]);
	});

	it("only a bound agent of the project is a source; a foreign project is 404", async () => {
		await put("a.txt", "x");
		expect(await reg("a.txt", GONE)).toMatchObject({
			status: 409,
			body: { error: "agent-not-bound" },
		});
		expect(await reg("a.txt", "d0000000-0000-4000-8000-00000000000d")).toMatchObject({
			status: 400,
		});
		expect(await art.register("someone-else", PID, { agentId: DEV, path: "a.txt" })).toMatchObject({
			status: 404,
		});
		expect(await art.register(OWNER, PID, { agentId: DEV })).toMatchObject({ status: 400 });
		// A binding to a session the owner does not own never becomes a read of it.
		foreign.add(SID);
		expect(await reg("a.txt")).toMatchObject({ status: 409, body: { error: "foreign-session" } });
		expect(await artifactEvents()).toEqual([]);
	});

	it("the project quota counts distinct registered bytes and refuses past it, deleting nothing", async () => {
		projectMax = 10;
		await put("a.txt", "123456");
		await put("b.txt", "abcdef");
		expect((await reg("a.txt")).status).toBe(201);
		expect(await reg("b.txt")).toMatchObject({ status: 409, body: { error: "artifacts-full" } });
		expect(await artifactEvents()).toHaveLength(1);
		// Concurrent registrations near the cap: the lock decides, never over it.
		projectMax = 13;
		await put("c.txt", "zzzz");
		await put("d.txt", "yyyy");
		const rs = await Promise.all([reg("c.txt"), reg("d.txt")]);
		expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
		expect((await store.view(PID)).state.artifactBytes).toBeLessThanOrEqual(13);
	});
});

describe("content (GET …/artifacts/:sha)", () => {
	it("serves only an artifact this log registered, re-verified on every read", async () => {
		await put("a.txt", "contenido");
		const sha = sha256Hex("contenido");
		expect(await art.content(PID, sha)).toMatchObject({ status: 404 });
		await reg("a.txt");
		const ok = await art.content(PID, sha);
		expect("ok" in ok && ok.content.toString()).toBe("contenido");
		await fs.chmod(path.join(projectDir(ROOT, PID), "artifacts", sha), 0o600);
		await fs.writeFile(path.join(projectDir(ROOT, PID), "artifacts", sha), "tampered");
		expect(await art.content(PID, sha)).toMatchObject({
			status: 409,
			body: { error: "artifact-corrupt" },
		});
		expect(await art.content(PID, "../../etc/passwd")).toMatchObject({ status: 404 });
	});

	it("a content file already present with other bytes is never replaced: registration fails", async () => {
		await put("a.txt", "real");
		const sha = sha256Hex("real");
		const dir = path.join(projectDir(ROOT, PID), "artifacts");
		await store.view(PID);
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, sha), "not real");
		expect(await reg("a.txt")).toMatchObject({ status: 409, body: { error: "artifact-corrupt" } });
		expect(await fs.readFile(path.join(dir, sha), "utf8")).toBe("not real");
		expect(await artifactEvents()).toEqual([]);
	});
});

// ── A registration the log cannot hold (F4) ─────────────────────────────────
//
// The copy is durable and the quota only counts what the log references, so a
// copy whose event the log then refuses is disk outside every bound. The log's
// refusal is decided before copying; what can still slip between the
// pre-check and the append is never deleted (§9) but bounded by the
// unreferenced-bytes budget.
describe("a log that cannot take the event (§6.2)", () => {
	const dir = () => path.join(projectDir(ROOT, PID), "artifacts");
	let unreferencedMax: number | undefined;

	/** Re-opens the project with a log cap of `logMax` bytes (taken at open). */
	const restart = async (logMax: number) => {
		await store.close();
		store = await ProjectConversationStore.start({
			workspaceRoot: ROOT,
			bootId: "b",
			maxBytes: logMax,
			acquire: async () => ({ ok: true, lock: lock() }),
		});
		art = new ProjectArtifacts({
			store,
			workspaceRoot: ROOT,
			bindings: async (o, p) => (o === OWNER && p === PID ? bindings() : null),
			openSource: (sid, rel, o) => openWorkspaceFile(sid, rel, o),
			assertOwner: async () => {},
			get projectMaxBytes() {
				return projectMax;
			},
			get unreferencedMaxBytes() {
				return unreferencedMax;
			},
		});
	};
	const diskBytes = async (): Promise<number> => {
		let names: string[];
		try {
			names = await fs.readdir(dir());
		} catch {
			return 0;
		}
		let n = 0;
		for (const f of names) n += (await fs.lstat(path.join(dir(), f))).size;
		return n;
	};
	/**
	 * Barrier: the NEXT critical section after the pre-check (the one that
	 * appends the event) first lets another writer append `filler` — the log
	 * fills between the pre-check and the append.
	 */
	const fillBeforeAppend = (filler: string) => {
		const orig = store.critical.bind(store);
		let calls = 0;
		store.critical = (async (pid: string, fn: Parameters<typeof orig>[1]) => {
			calls += 1;
			if (calls === 2) await orig(pid, (tx) => tx.append([{ ev: "filler", pad: filler }]));
			return orig(pid, fn);
		}) as typeof store.critical;
	};

	beforeEach(() => {
		unreferencedMax = undefined;
	});

	it("4 distinct 96-B files on a full log: each 409 project-log-full, nothing copied", async () => {
		await restart(128);
		for (const n of [1, 2, 3, 4]) await put(`f${n}.txt`, String(n).repeat(96));
		for (const n of [1, 2, 3, 4]) {
			expect(await reg(`f${n}.txt`)).toMatchObject({
				status: 409,
				body: { error: "project-log-full" },
			});
		}
		expect(await diskBytes()).toBe(0);
		expect(await artifactEvents()).toEqual([]);
		expect((await store.view(PID)).state.artifactBytes).toBe(0);
	});

	it("replay and quota answers are unchanged on a full log; existing identical content is kept", async () => {
		await restart(450);
		await put("a.txt", "a".repeat(96));
		await put("a2.txt", "a".repeat(96));
		await put("b.txt", "b".repeat(96));
		expect((await reg("a.txt")).status).toBe(201);
		const sha = sha256Hex("a".repeat(96));
		const before = await fs.readFile(path.join(dir(), sha), "utf8");
		// Replay needs no write: still 200, whatever room the log has.
		expect(await reg("a.txt")).toMatchObject({ status: 200, body: { replayed: true } });
		// Same bytes from another source: the event does not fit ⇒ refused,
		// and the content file (referenced) is untouched.
		expect(await reg("a2.txt")).toMatchObject({
			status: 409,
			body: { error: "project-log-full" },
		});
		expect(await fs.readFile(path.join(dir(), sha), "utf8")).toBe(before);
		const served = await art.content(PID, sha);
		expect("ok" in served && served.content.toString()).toBe(before);
		// The quota still answers first when it is the binding limit.
		projectMax = 100;
		expect(await reg("b.txt")).toMatchObject({ status: 409, body: { error: "artifacts-full" } });
		expect(await fs.readdir(dir())).not.toContain(sha256Hex("b".repeat(96)));
		expect(await artifactEvents()).toHaveLength(1);
	});

	it("race: the log fills between pre-check and append — the orphan stays, is reused, and bounds new copies", async () => {
		await restart(450);
		await put("a.txt", "a".repeat(96));
		const shaA = sha256Hex("a".repeat(96));
		fillBeforeAppend("x".repeat(200));
		expect(await reg("a.txt")).toMatchObject({ status: 409, body: { error: "project-log-full" } });
		// Kept (never deleted, §9) and unreferenced: no event, not in the quota.
		expect(await fs.readFile(path.join(dir(), shaA), "utf8")).toBe("a".repeat(96));
		expect(await artifactEvents()).toEqual([]);
		expect((await store.view(PID)).state.artifactBytes).toBe(0);
		const orphan = await diskBytes();
		expect(orphan).toBeGreaterThan(96);

		// A bigger log, a budget that holds exactly that orphan.
		await restart(64 * 1024);
		unreferencedMax = orphan + 50;
		await put("b.txt", "b".repeat(96));
		expect(await reg("b.txt")).toMatchObject({
			status: 409,
			body: { error: "artifacts-full", detail: "unreferenced" },
		});
		expect(await fs.readdir(dir())).not.toContain(sha256Hex("b".repeat(96)));
		expect(await diskBytes()).toBe(orphan);
		// The orphan's own bytes add nothing: reused, and now referenced…
		expect((await reg("a.txt")).status).toBe(201);
		expect(await fs.readFile(path.join(dir(), shaA), "utf8")).toBe("a".repeat(96));
		// …so it no longer counts against the budget.
		expect((await reg("b.txt")).status).toBe(201);
		expect((await store.view(PID)).state.artifactBytes).toBe(192);
	});

	it("race on content that is already registered: the referenced file is never removed", async () => {
		await restart(800);
		await put("a.txt", "a".repeat(96));
		await put("a2.txt", "a".repeat(96));
		const sha = sha256Hex("a".repeat(96));
		expect((await reg("a.txt")).status).toBe(201);
		fillBeforeAppend("x".repeat(250));
		expect(await reg("a2.txt")).toMatchObject({
			status: 409,
			body: { error: "project-log-full" },
		});
		const served = await art.content(PID, sha);
		expect("ok" in served && served.content.toString()).toBe("a".repeat(96));
		expect(await artifactEvents()).toHaveLength(1);
	});

	it("a failed write (EIO on fsync) removes its own temp: nothing left to eat the budget", async () => {
		unreferencedMax = 400;
		await restart(64 * 1024);
		await put("a.txt", "a".repeat(150));
		const realOpen = fs.open.bind(fs);
		const spy = vi.spyOn(fs, "open").mockImplementation((async (
			...args: Parameters<typeof fs.open>
		) => {
			const fh = await realOpen(...args);
			if (String(args[0]).endsWith(".tmp")) {
				fh.sync = async () => {
					throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
				};
			}
			return fh;
		}) as typeof fs.open);
		try {
			await expect(reg("a.txt")).rejects.toThrow(/EIO/);
		} finally {
			spy.mockRestore();
		}
		expect(await diskBytes()).toBe(0);
		expect(await artifactEvents()).toEqual([]);
		// The episode over, the same registration goes through (nothing blocks it).
		for (let i = 0; i < 3; i++) {
			await put(`n${i}.txt`, String(i).repeat(100));
			expect((await reg(`n${i}.txt`)).status).toBe(201);
		}
		expect((await reg("a.txt")).status).toBe(201);
	});

	it("the artifacts directory is listed only when the content would be new bytes", async () => {
		await restart(64 * 1024);
		await put("a.txt", "a".repeat(50));
		await put("a2.txt", "a".repeat(50));
		expect((await reg("a.txt")).status).toBe(201);
		const spy = vi.spyOn(fs, "readdir");
		try {
			expect(await reg("a.txt")).toMatchObject({ status: 200, body: { replayed: true } });
			expect((await reg("a2.txt")).status).toBe(201); // known bytes, another source
			expect(spy.mock.calls.filter((c) => String(c[0]) === dir())).toEqual([]);
		} finally {
			spy.mockRestore();
		}
	});

	/** What a registration of `rel` with `body` adds: content + its exact metadata file. */
	const needOf = (rel: string, body: string) =>
		body.length +
		metaBuffer(sha256Hex(body), {
			name: sanitizeName(rel),
			bytes: body.length,
			source: { kind: "owner", sid: SID, path: rel, agent_id: DEV },
		}).length;
	/** Every append of an `artifact` event is refused: each admitted copy becomes an orphan. */
	const refuseArtifactAppends = () => {
		const orig = store.critical.bind(store);
		store.critical = (async (pid: string, fn: Parameters<typeof orig>[1]) =>
			orig(pid, (tx) =>
				fn({
					state: tx.state,
					assertAppendable: (e, o) => tx.assertAppendable(e, o),
					append: async (e, o) => {
						if (e.some((x) => x.ev === "artifact"))
							throw new ProjectLogError("project-log-full", "injected");
						return tx.append(e, o);
					},
				}),
			)) as typeof store.critical;
	};

	it("(a) crash leftovers on disk after a restart — content, .json and temp — all count, exactly", async () => {
		await restart(64 * 1024);
		await store.view(PID);
		await fs.mkdir(dir(), { recursive: true });
		const orphan = "o".repeat(100);
		const osha = sha256Hex(orphan);
		await fs.writeFile(path.join(dir(), osha), orphan);
		await fs.writeFile(path.join(dir(), `${osha}.json`), `${JSON.stringify({ sha256: osha })}\n`);
		await fs.writeFile(path.join(dir(), ".0123456789abcdef.tmp"), "t".repeat(70));
		// A referenced artifact next to them is not counted (the quota counts it).
		await put("r.txt", "r".repeat(300));
		expect((await reg("r.txt")).status).toBe(201);
		const leftovers = 100 + (await fs.stat(path.join(dir(), `${osha}.json`))).size + 70;
		// A new process: no reservation survives, only the disk.
		await restart(64 * 1024);
		await put("b.txt", "b".repeat(60));
		const need = needOf("b.txt", "b".repeat(60));
		unreferencedMax = leftovers + need - 1; // one byte short: any part uncounted would pass
		expect(await reg("b.txt")).toMatchObject({
			status: 409,
			body: { error: "artifacts-full", detail: "unreferenced" },
		});
		expect(await fs.readdir(dir())).not.toContain(sha256Hex("b".repeat(60)));
		unreferencedMax = leftovers + need;
		expect((await reg("b.txt")).status).toBe(201);
		// Nothing was cleaned up.
		expect(await fs.readdir(dir())).toEqual(
			expect.arrayContaining([osha, `${osha}.json`, ".0123456789abcdef.tmp"]),
		);
	});

	it("(b) N parallel distinct registrations near the budget: the overshoot is bounded by the budget, not by N", async () => {
		await restart(64 * 1024);
		refuseArtifactAppends();
		const N = 8;
		const bodies = Array.from({ length: N }, (_, i) => String.fromCharCode(97 + i).repeat(100));
		for (let i = 0; i < N; i++) await put(`p${i}.txt`, bodies[i] as string);
		const need = needOf("p0.txt", bodies[0] as string);
		unreferencedMax = 3 * need + need / 2; // room for 3, not 4
		const rs = await Promise.all(bodies.map((_, i) => reg(`p${i}.txt`)));
		const codes = rs.map(
			(r) =>
				(r.body as { error?: string; detail?: string }).detail ??
				(r.body as { error?: string }).error,
		);
		expect(codes.filter((c) => c === "project-log-full")).toHaveLength(3);
		expect(codes.filter((c) => c === "unreferenced")).toHaveLength(N - 3);
		expect(await diskBytes()).toBe(3 * need);
		expect(await diskBytes()).toBeLessThanOrEqual(unreferencedMax);
		expect((await fs.readdir(dir())).filter((n) => n.endsWith(".tmp"))).toEqual([]);
		// Order-independent: whichever K got in, the disk holds exactly theirs.
		const admitted = codes.flatMap((c, i) => (c === "project-log-full" ? [i] : []));
		expect((await fs.readdir(dir())).sort()).toEqual(
			admitted
				.flatMap((i) => [sha256Hex(bodies[i] as string), `${sha256Hex(bodies[i] as string)}.json`])
				.sort(),
		);
		// A second wave of exactly the refused ones (which 3 got in is up to
		// scheduling) measures the disk the first left: nothing more is admitted.
		const refused = codes.flatMap((c, i) => (c === "unreferenced" ? [i] : []));
		expect(refused).toHaveLength(N - 3);
		const again = await Promise.all(refused.map((i) => reg(`p${i}.txt`)));
		expect(again.every((r) => (r.body as { detail?: string }).detail === "unreferenced")).toBe(
			true,
		);
		expect(await diskBytes()).toBe(3 * need);
	});

	it("(d) reusing existing content — replays, other sources, in parallel — writes no metadata or temp", async () => {
		await restart(64 * 1024);
		await put("a.txt", "a".repeat(80));
		expect((await reg("a.txt")).status).toBe(201);
		const sha = sha256Hex("a".repeat(80));
		const before = await diskBytes();
		for (let i = 0; i < 6; i++) await put(`c${i}.txt`, "a".repeat(80));
		const rs = await Promise.all([
			reg("a.txt"),
			reg("a.txt"),
			...Array.from({ length: 6 }, (_, i) => reg(`c${i}.txt`)),
		]);
		expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 201, 201, 201, 201, 201, 201]);
		expect((await fs.readdir(dir())).sort()).toEqual([sha, `${sha}.json`].sort());
		expect(await diskBytes()).toBe(before);
		// An orphan of the same bytes is reused the same way: its existing
		// .json is never rewritten, no second file appears.
		await restart(64 * 1024);
		refuseArtifactAppends();
		await put("o.txt", "o".repeat(80));
		expect(await reg("o.txt")).toMatchObject({ status: 409 });
		const withOrphan = await diskBytes();
		const n = (await fs.readdir(dir())).length;
		for (let i = 0; i < 4; i++) expect(await reg("o.txt")).toMatchObject({ status: 409 });
		expect(await diskBytes()).toBe(withOrphan);
		expect((await fs.readdir(dir())).length).toBe(n);
	});

	it("(d') reuse of known or on-disk content opens no temp at all; only reserved bytes are ever written", async () => {
		await restart(64 * 1024);
		await put("a.txt", "a".repeat(500));
		expect((await reg("a.txt")).status).toBe(201);
		for (let i = 0; i < 4; i++) await put(`k${i}.txt`, "a".repeat(500));
		// An orphan (content + metadata, no event) of other bytes.
		await put("o.txt", "o".repeat(500));
		const realOpen = fs.open.bind(fs);
		const temps: string[] = [];
		const spy = vi.spyOn(fs, "open").mockImplementation((async (
			...args: Parameters<typeof fs.open>
		) => {
			if (String(args[0]).endsWith(".tmp")) temps.push(String(args[0]));
			return realOpen(...args);
		}) as typeof fs.open);
		try {
			// New bytes: exactly two temps (content + metadata), both reserved.
			refuseArtifactAppends();
			expect(await reg("o.txt")).toMatchObject({ status: 409 });
			expect(temps).toHaveLength(2);
			temps.length = 0;
			await restart(64 * 1024);
			// Known content from 4 new sources, a replay, and the orphan again
			// (a crash loop re-registering it would hit exactly this path).
			const rs = await Promise.all([
				...[0, 1, 2, 3].map((i) => reg(`k${i}.txt`)),
				reg("a.txt"),
				reg("o.txt"),
				reg("o.txt"),
			]);
			expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 201, 201, 201, 201, 201]);
			expect(temps).toEqual([]);
		} finally {
			spy.mockRestore();
		}
	});

	it("(d) across restarts: a crash mid-reuse leaves nothing; crash leftovers + repeated reuse = zero growth", async () => {
		await restart(64 * 1024);
		await put("a.txt", "a".repeat(400));
		expect((await reg("a.txt")).status).toBe(201); // known content
		await put("o.txt", "o".repeat(400));
		refuseArtifactAppends();
		expect(await reg("o.txt")).toMatchObject({ status: 409 }); // orphan on disk, unreferenced
		// What a crash of a RESERVED new-bytes write leaves (the only kind of
		// write that opens a temp): one partial temp. It is on disk, budget-counted.
		await fs.writeFile(path.join(dir(), ".c0ffeec0ffeec0ff.tmp"), "p".repeat(123));

		// "Crash mid-reuse": a reuse registration is cut at its first filesystem
		// open, whatever it is, and the process restarts. Had reuse opened a
		// temp, that is where it would be left.
		for (let round = 0; round < 3; round++) {
			await restart(64 * 1024);
			await put(`k${round}.txt`, "a".repeat(400));
			const realOpen = fs.open.bind(fs);
			const opened: string[] = [];
			const cut = vi.spyOn(fs, "open").mockImplementation((async (
				...args: Parameters<typeof fs.open>
			) => {
				opened.push(String(args[0]));
				if (String(args[0]).endsWith(".tmp")) throw new Error("crash");
				return realOpen(...args);
			}) as typeof fs.open);
			try {
				// Reuse of known content from a new source, a replay, and the orphan.
				const rs = await Promise.all([reg(`k${round}.txt`), reg("a.txt"), reg("o.txt")]);
				expect(rs.every((r) => r.status === 200 || r.status === 201)).toBe(true);
			} finally {
				cut.mockRestore();
			}
			expect(opened.filter((p) => p.endsWith(".tmp"))).toEqual([]);
		}
		const after = await diskBytes();
		const names = (await fs.readdir(dir())).sort();
		// Many more reuse rounds, each in a fresh process: nothing grows.
		for (let round = 0; round < 5; round++) {
			await restart(64 * 1024);
			for (const r of ["a.txt", "o.txt", "k0.txt", "k1.txt", "k2.txt"])
				expect([200, 201]).toContain((await reg(r)).status);
		}
		expect(await diskBytes()).toBe(after);
		expect((await fs.readdir(dir())).sort()).toEqual(names);
		expect(names.filter((n) => n.endsWith(".tmp"))).toEqual([".c0ffeec0ffeec0ff.tmp"]);
	});

	it("a referenced sha whose file is ABSENT is repaired by the same bytes, reserved within the budget", async () => {
		await restart(64 * 1024);
		const body = "a".repeat(50);
		await put("a.txt", body);
		await put("a2.txt", body);
		const sha = sha256Hex(body);
		expect((await reg("a.txt")).status).toBe(201);
		const served = async () => {
			const r = await art.content(PID, sha);
			return "ok" in r ? r.content.toString() : r;
		};
		// The file is moved aside (a restore's evidence, disk damage): GET fails.
		await fs.rename(path.join(dir(), sha), path.join(ROOT, "moved-aside"));
		expect(await served()).toMatchObject({ status: 409, body: { error: "artifact-corrupt" } });
		// The repair is reserved like new content: one byte short of its
		// content (the .json is still there) ⇒ refused, nothing written.
		unreferencedMax = body.length - 1;
		expect(await reg("a.txt")).toMatchObject({
			status: 409,
			body: { error: "artifacts-full", detail: "unreferenced" },
		});
		expect(await fs.readdir(dir())).not.toContain(sha);
		// Within budget: a replay repairs it (200, no new event) and GET serves it.
		unreferencedMax = body.length;
		expect(await reg("a.txt")).toMatchObject({ status: 200, body: { replayed: true } });
		expect(await served()).toBe(body);
		expect(await artifactEvents()).toHaveLength(1);
		// Once linked it is referenced and no longer counts, so the same budget
		// admits another repair of the same size (another source: 201).
		await fs.unlink(path.join(dir(), sha));
		expect(await reg("a2.txt")).toMatchObject({ status: 201 });
		expect(await served()).toBe(body);
		expect(await artifactEvents()).toHaveLength(2);
		expect((await fs.readdir(dir())).filter((n) => n.endsWith(".tmp"))).toEqual([]);
		expect((await store.view(PID)).state.artifactBytes).toBe(50);
	});

	it("a referenced sha whose file is PRESENT but does not match its name is 409 artifact-corrupt, untouched", async () => {
		await restart(64 * 1024);
		await put("a.txt", "a".repeat(50));
		await put("a2.txt", "a".repeat(50));
		const sha = sha256Hex("a".repeat(50));
		expect((await reg("a.txt")).status).toBe(201);
		await fs.writeFile(path.join(dir(), sha), "tampered");
		expect(await reg("a2.txt")).toMatchObject({ status: 409, body: { error: "artifact-corrupt" } });
		// A replay of a present file reads nothing (unchanged since v0.3.2):
		// still 200, and GET refuses to serve the mismatched bytes.
		expect(await reg("a.txt")).toMatchObject({ status: 200, body: { replayed: true } });
		expect(await art.content(PID, sha)).toMatchObject({
			status: 409,
			body: { error: "artifact-corrupt" },
		});
		expect(await fs.readFile(path.join(dir(), sha), "utf8")).toBe("tampered");
		expect(await artifactEvents()).toHaveLength(1);
	});

	it("a temp that cannot be removed after a failed write is logged, not stranded silently", async () => {
		await restart(64 * 1024);
		await put("a.txt", "a".repeat(50));
		const realOpen = fs.open.bind(fs);
		const op = vi.spyOn(fs, "open").mockImplementation((async (
			...args: Parameters<typeof fs.open>
		) => {
			const fh = await realOpen(...args);
			if (String(args[0]).endsWith(".tmp")) {
				fh.sync = async () => {
					throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
				};
			}
			return fh;
		}) as typeof fs.open);
		const realUnlink = fs.unlink.bind(fs);
		const ul = vi.spyOn(fs, "unlink").mockImplementation((async (
			p: Parameters<typeof fs.unlink>[0],
		) => {
			if (String(p).endsWith(".tmp"))
				throw Object.assign(new Error("EROFS: injected"), { code: "EROFS" });
			return realUnlink(p);
		}) as typeof fs.unlink);
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			await expect(reg("a.txt")).rejects.toThrow(/EIO/);
			expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not be removed.*EROFS/));
		} finally {
			op.mockRestore();
			ul.mockRestore();
			warn.mockRestore();
		}
		// It stays and is measured (counted) from here on.
		expect((await fs.readdir(dir())).filter((n) => n.endsWith(".tmp"))).toHaveLength(1);
	});

	it("(e) usage that cannot be measured refuses new bytes (503), copying nothing", async () => {
		await restart(64 * 1024);
		await put("a.txt", "a".repeat(40));
		expect((await reg("a.txt")).status).toBe(201);
		await put("a2.txt", "a".repeat(40));
		await put("b.txt", "b".repeat(40));
		const shaB = sha256Hex("b".repeat(40));
		const unverifiable = { status: 503, body: { error: "artifact-store-unverifiable" } };

		// readdir fails.
		const rd = vi
			.spyOn(fs, "readdir")
			.mockRejectedValue(Object.assign(new Error("EACCES: injected"), { code: "EACCES" }));
		try {
			expect(await reg("b.txt")).toMatchObject(unverifiable);
			// Known bytes need no measurement: unaffected.
			expect((await reg("a2.txt")).status).toBe(201);
		} finally {
			rd.mockRestore();
		}
		// An entry that cannot be stat'ed.
		await fs.writeFile(path.join(dir(), ".feedfacefeedface.tmp"), "x");
		const realLstat = fs.lstat.bind(fs);
		const ls = vi.spyOn(fs, "lstat").mockImplementation((async (
			p: Parameters<typeof fs.lstat>[0],
		) => {
			if (String(p).endsWith(".feedfacefeedface.tmp"))
				throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
			return realLstat(p);
		}) as typeof fs.lstat);
		try {
			expect(await reg("b.txt")).toMatchObject(unverifiable);
		} finally {
			ls.mockRestore();
		}
		// An entry that is not a regular file: its size says nothing.
		await fs.mkdir(path.join(dir(), "stray"));
		expect(await reg("b.txt")).toMatchObject(unverifiable);
		expect(await fs.readdir(dir())).not.toContain(shaB);
		expect(await artifactEvents()).toHaveLength(2);
	});
});
