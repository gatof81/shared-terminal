/**
 * PROJECT_CONVERSATION.md §3.3 steps b–b'–S2b and §6.3–§6.4 through the real
 * fan-out, store and placement (real filesystem): `placing` is durable
 * before any file is touched, a failed placement ends the delivery with no
 * Composer call, every not-sent after a placing says files may be in the
 * inbox, and the artifacts are part of the idempotent body.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HttpResult } from "../../conversation/composer.js";
import { type ArtifactRef, ArtifactStoreCorrupt, artifactLine, sha256Hex } from "./artifacts.js";
import { type FanoutDeps, type ProjectBindings, ProjectFanout, parseBody } from "./fanout.js";
import type { LogLine } from "./log.js";
import { INBOX_DIR, type PlacementResult, placeArtifacts } from "./placement.js";
import { ProjectConversationStore } from "./store.js";
import type { WriterLock } from "./writerLock.js";

const PID = "6b1f0c4e-1d2a-4b3c-8d4e-5f6a7b8c9d0e";
const OWNER = "u-owner";
const A = "a0000000-0000-4000-8000-00000000000a";
const B = "b0000000-0000-4000-8000-00000000000b";
const SA = "5a000000-0000-4000-8000-0000000000aa";
const SB = "5b000000-0000-4000-8000-0000000000bb";
const lock = (): WriterLock => ({ held: () => true, onLost: () => {}, release: () => {} });
const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;

let root: string;
let store: ProjectConversationStore;
let registered: Map<string, ArtifactRef & { content: Buffer }>;
let calls: Array<{ sid: string; text: string }>;
let place: (
	sid: string,
	list: ReadonlyArray<ArtifactRef & { content: Buffer }>,
) => Promise<PlacementResult>;
let bindingsQueue: ProjectBindings[];
let tamper: Set<string>;

const bindingsOf = (epochB = 1): ProjectBindings =>
	new Map([
		[A, { removed: false, binding: { bindingId: "ba", epoch: 1, sessionId: SA } }],
		[B, { removed: false, binding: { bindingId: "bb", epoch: epochB, sessionId: SB } }],
	]);

function reg(text: string, name: string): ArtifactRef {
	const content = Buffer.from(text);
	const a = { sha256: sha256Hex(content), name, bytes: content.length, content };
	registered.set(a.sha256, a);
	return { sha256: a.sha256, name, bytes: a.bytes };
}

function deps(over: Partial<FanoutDeps> = {}): FanoutDeps {
	return {
		store,
		bindings: async () => bindingsQueue.shift() ?? bindingsOf(),
		target: async (sid) => ({ kind: "ok", cid: `c-${sid.slice(0, 2)}` }),
		sessionMeta: async () => ({ userId: OWNER }),
		composerSend: async (input): Promise<HttpResult> => {
			calls.push({ sid: input.stSessionId, text: input.body.text });
			return { status: 202, body: { result: "delivered", promptId: `p-${calls.length}`, seq: 3 } };
		},
		onDelivered: () => {},
		onUncertain: () => {},
		tHttpMs: 2_000,
		artifacts: {
			lookup: async (_pid, shas) => {
				const refs: ArtifactRef[] = [];
				for (const s of shas) {
					const a = registered.get(s);
					if (!a) return { ok: false, unknown: s };
					refs.push({ sha256: a.sha256, name: a.name, bytes: a.bytes });
				}
				return { ok: true, refs };
			},
			readContent: async (_pid, sha) => {
				if (tamper.has(sha)) throw new ArtifactStoreCorrupt(`${sha}: content does not match`);
				return registered.get(sha)?.content ?? null;
			},
			place: (sid, list) => place(sid, list),
		},
		...over,
	};
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-fanout-art-"));
	for (const s of [SA, SB]) await fs.mkdir(path.join(root, s));
	store = await ProjectConversationStore.start({
		workspaceRoot: root,
		bootId: "boot",
		acquire: async () => ({ ok: true, lock: lock() }),
	});
	registered = new Map();
	calls = [];
	bindingsQueue = [];
	tamper = new Set();
	place = (sid, list) =>
		placeArtifacts({ workspaceRoot: root, sessionId: sid, artifacts: list, uid, gid });
});
afterEach(async () => {
	await store.close();
	await fs.rm(root, { recursive: true, force: true });
});

const log = async (): Promise<LogLine[]> => (await store.view(PID)).lines.slice();
const send = (f: ProjectFanout, body: Record<string, unknown>) =>
	f.send(OWNER, PID, {
		clientMessageId: crypto.randomUUID(),
		text: "aplicá esto",
		to: [A, B],
		...body,
	});
const states = (ls: LogLine[], agent: string) =>
	ls.filter((l) => l.ev === "delivery" && l.agent_id === agent).map((l) => l.state);

describe("body (§3.4 rule 2, §6.1)", () => {
	it("artifacts only with D2 on; ≤ 4 distinct sha256, lowercased; part of the canonical body", () => {
		const sha = "a".repeat(64);
		const base = { clientMessageId: crypto.randomUUID(), text: "x", to: [A] };
		expect(parseBody({ ...base, artifacts: [sha] })).toMatchObject({ status: 409 });
		expect(parseBody({ ...base, artifacts: [sha.toUpperCase()] }, true)).toMatchObject({
			artifacts: [sha],
		});
		expect(parseBody({ ...base, artifacts: [sha, sha] }, true)).toMatchObject({ status: 400 });
		expect(
			parseBody(
				{
					...base,
					artifacts: ["b".repeat(64), "c".repeat(64), "d".repeat(64), "e".repeat(64), sha],
				},
				true,
			),
		).toMatchObject({ status: 400 });
		expect(parseBody({ ...base, artifacts: ["nope"] }, true)).toMatchObject({ status: 400 });
	});
});

describe("delivery with artifacts (§3.3 b–S2b, §6.4)", () => {
	it("two recipients: placing is on disk before the first file, sending carries artifacts_placed, the agent gets one line per artifact", async () => {
		const r1 = reg("--- a\n+++ b\n", "fix.diff");
		const r2 = reg("informe", "qa.md");
		const realPlace = place;
		const onDiskAtPlacement: string[][] = [];
		place = async (sid, list) => {
			onDiskAtPlacement.push(states(await log(), sid === SA ? A : B));
			return realPlace(sid, list);
		};
		const f = new ProjectFanout(deps());
		const r = await send(f, { artifacts: [r1.sha256, r2.sha256] });
		expect(r.status).toBe(202);
		expect(onDiskAtPlacement).toEqual([
			["planned", "placing"],
			["planned", "placing"],
		]);
		const ls = await log();
		expect(states(ls, A)).toEqual(["planned", "placing", "sending", "delivered"]);
		const msg = ls.find((l) => l.ev === "message");
		expect(msg?.artifacts).toEqual([r1, r2]);
		expect(msg?.text).toBe("aplicá esto");
		const sending = ls.find((l) => l.state === "sending" && l.agent_id === B);
		expect(sending?.artifacts_placed).toEqual([
			{ sha256: r1.sha256, path: `${INBOX_DIR}/${r1.sha256.slice(0, 12)}-fix.diff` },
			{ sha256: r2.sha256, path: `${INBOX_DIR}/${r2.sha256.slice(0, 12)}-qa.md` },
		]);
		expect(calls.map((c) => c.text)).toEqual([
			`aplicá esto\n${artifactLine(r1)}\n${artifactLine(r2)}`,
			`aplicá esto\n${artifactLine(r1)}\n${artifactLine(r2)}`,
		]);
		for (const s of [SA, SB]) {
			expect(
				await fs.readFile(
					path.join(root, s, INBOX_DIR, `${r1.sha256.slice(0, 12)}-fix.diff`),
					"utf8",
				),
			).toBe("--- a\n+++ b\n");
		}
	});

	it("an unknown artifact, or lines past the paste limit, are refused before anything is written", async () => {
		const f = new ProjectFanout(deps());
		expect(await send(f, { artifacts: ["f".repeat(64)] })).toMatchObject({
			status: 400,
			body: { error: "artifact-unknown", detail: "f".repeat(64) },
		});
		const r1 = reg("x", "x.txt");
		const text = Array.from({ length: 48 }, (_, i) => `línea ${i}`).join("\n");
		expect(await send(f, { text, artifacts: [r1.sha256] })).toMatchObject({
			status: 400,
			body: { error: "too-many-segments" },
		});
		expect((await store.view(PID)).lines).toEqual([]);
		expect(calls).toEqual([]);
	});

	it("T5c: the same id with other or reordered artifacts is a conflict; the same body replays with no effect", async () => {
		const r1 = reg("1", "a.txt");
		const r2 = reg("2", "b.txt");
		const f = new ProjectFanout(deps());
		const id = crypto.randomUUID();
		expect((await send(f, { clientMessageId: id, artifacts: [r1.sha256, r2.sha256] })).status).toBe(
			202,
		);
		expect(await send(f, { clientMessageId: id, artifacts: [r2.sha256, r1.sha256] })).toMatchObject(
			{
				status: 409,
			},
		);
		expect(await send(f, { clientMessageId: id, artifacts: [r1.sha256] })).toMatchObject({
			status: 409,
		});
		expect(await send(f, { clientMessageId: id })).toMatchObject({ status: 409 });
		expect(await send(f, { clientMessageId: id, artifacts: [r1.sha256, r2.sha256] })).toMatchObject(
			{
				status: 202,
				body: { replayed: true },
			},
		);
		expect(calls).toHaveLength(2);
	});

	it("T13b: both placements fail at once ⇒ two not-sent{artifact-failed} written in S2b, whole lines, 0 calls", async () => {
		const r1 = reg("contenido", "a.txt");
		for (const s of [SA, SB]) await fs.symlink("/etc", path.join(root, s, INBOX_DIR));
		const f = new ProjectFanout(deps());
		const id = crypto.randomUUID();
		const r = await send(f, { clientMessageId: id, artifacts: [r1.sha256] });
		const expected = [
			{ agentId: A, state: "not-sent", reason: "artifact-failed", filesPossiblyPlaced: true },
			{ agentId: B, state: "not-sent", reason: "artifact-failed", filesPossiblyPlaced: true },
		];
		expect((r.body as { deliveries: unknown[] }).deliveries).toEqual(expected);
		// A replay is the same answer, the inbox warning included (review NIT).
		expect(await send(f, { clientMessageId: id, artifacts: [r1.sha256] })).toMatchObject({
			status: 202,
			body: { replayed: true, deliveries: expected },
		});
		const failed = (await log()).filter((l) => l.state === "not-sent");
		expect(failed).toHaveLength(2);
		for (const l of failed) {
			expect(l).toMatchObject({
				reason: "artifact-failed",
				artifact_error: "inbox-not-dir",
				files_possibly_placed: true,
			});
		}
		expect(calls).toEqual([]);
		// The log reopens readable.
		await store.close();
		store = await ProjectConversationStore.start({
			workspaceRoot: root,
			bootId: "boot-2",
			acquire: async () => ({ ok: true, lock: lock() }),
		});
		expect((await store.view(PID)).lines.length).toBeGreaterThan(failed.length);
	});

	it("T13: the project's copy fails its hash ⇒ artifact-failed{hash-mismatch}, nothing placed, no call", async () => {
		const r1 = reg("bueno", "a.txt");
		tamper.add(r1.sha256);
		const f = new ProjectFanout(deps());
		await send(f, { to: [A], artifacts: [r1.sha256] });
		expect((await log()).find((l) => l.state === "not-sent")).toMatchObject({
			reason: "artifact-failed",
			artifact_error: "hash-mismatch",
			files_possibly_placed: true,
		});
		await expect(fs.readdir(path.join(root, SA, INBOX_DIR))).rejects.toThrow();
		expect(calls).toEqual([]);
	});

	it("the binding changes after placing (c0) ⇒ not-sent{binding-changed} still says files may be placed", async () => {
		const r1 = reg("x", "a.txt");
		// a (ok), c0 (B moved to epoch 2)
		bindingsQueue = [bindingsOf(), bindingsOf(), bindingsOf(2), bindingsOf(2)];
		const f = new ProjectFanout(deps());
		await send(f, { to: [B], artifacts: [r1.sha256] });
		expect(
			(await log())
				.filter((l) => l.agent_id === B)
				.map((l) => [l.state, l.reason ?? null, l.files_possibly_placed ?? null]),
		).toEqual([
			["planned", null, null],
			["placing", null, null],
			["not-sent", "binding-changed", true],
		]);
		expect(calls).toEqual([]);
	});

	it("T12b: death between placing and sending ⇒ on reopen not-sent{persist-failed, files_possibly_placed}, 0 calls, no partial final name", async () => {
		const r1 = reg("contenido", "a.txt");
		// The process "dies" inside the real placement: temp written and
		// verified, link never reached.
		place = (sid, list) =>
			placeArtifacts({
				workspaceRoot: root,
				sessionId: sid,
				artifacts: list,
				uid,
				gid,
				beforeLink: () => new Promise(() => {}),
			});
		const f = new ProjectFanout(deps({ tHttpMs: 200 }));
		const r = await send(f, { to: [A], artifacts: [r1.sha256] });
		expect((r.body as { deliveries: unknown[] }).deliveries).toEqual([
			{ agentId: A, state: "placing" },
		]);
		await store.close();
		store = await ProjectConversationStore.start({
			workspaceRoot: root,
			bootId: "after-crash",
			acquire: async () => ({ ok: true, lock: lock() }),
		});
		const ls = (await store.view(PID)).lines;
		expect(ls.filter((l) => l.ev === "delivery").map((l) => l.state)).toEqual([
			"planned",
			"placing",
			"not-sent",
		]);
		expect(ls.find((l) => l.state === "not-sent")).toMatchObject({
			reason: "persist-failed",
			files_possibly_placed: true,
		});
		expect(calls).toEqual([]);
		// Only our hidden temp: never a partial file under a final name.
		const inbox = await fs.readdir(path.join(root, SA, INBOX_DIR));
		expect(inbox).toHaveLength(1);
		expect(inbox[0]).toMatch(/^\.[0-9a-f]{16}\.tmp$/);
	});

	it("§2.1 point 3: a writer loss known after placing stops the placement too (no file touched)", async () => {
		const r1 = reg("contenido", "a.txt");
		await store.close();
		let lost = false;
		store = await ProjectConversationStore.start({
			workspaceRoot: root,
			bootId: "boot-lost",
			acquire: async () => ({
				ok: true,
				lock: { held: () => !lost, onLost: () => {}, release: () => {} },
			}),
		});
		store.onAppend((_p, lines) => {
			if (lines.some((l) => l.state === "placing")) lost = true;
		});
		let placed = 0;
		place = async () => {
			placed++;
			return { ok: true, placed: [] };
		};
		const f = new ProjectFanout(deps());
		const r = await send(f, { to: [A], artifacts: [r1.sha256] });
		expect((r.body as { deliveries: unknown[] }).deliveries).toEqual([
			{ agentId: A, state: "not-sent", reason: "persist-failed", filesPossiblyPlaced: true },
		]);
		expect(placed).toBe(0);
		expect(calls).toEqual([]);
		await expect(fs.readdir(path.join(root, SA, INBOX_DIR))).rejects.toThrow();
		lost = false;
		await store.close();
		store = await ProjectConversationStore.start({
			workspaceRoot: root,
			bootId: "after-loss",
			acquire: async () => ({ ok: true, lock: lock() }),
		});
		expect((await store.view(PID)).lines.find((l) => l.state === "not-sent")).toMatchObject({
			reason: "persist-failed",
			files_possibly_placed: true,
		});
	});

	it("without D2 (no artifacts dep) a message with artifacts is 409 artifacts-off and nothing is read", async () => {
		const f = new ProjectFanout(deps({ artifacts: undefined }));
		expect(await send(f, { artifacts: ["a".repeat(64)] })).toMatchObject({
			status: 409,
			body: { error: "artifacts-off" },
		});
		expect((await store.view(PID)).lines).toEqual([]);
	});
});
