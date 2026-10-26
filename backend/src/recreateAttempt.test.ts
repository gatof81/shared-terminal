import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AttemptIdentity,
	AttemptTransitionError,
	HISTORY_MAX,
	RECORD_FILE,
	RecreateAttemptStore,
	RecreateUnresolvedError,
} from "./recreateAttempt.js";

const SID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
let root: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-recreate-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await fs.chmod(path.join(root, ".st-control", SID), 0o700).catch(() => {});
	await fs.rm(root, { recursive: true, force: true });
});

function identity(n = 1): AttemptIdentity {
	return {
		attemptId: `att-${n}`,
		oContainerId: `cid-o-${n}`,
		oCanonicalName: "st-7c9e66797425",
		oOldName: `st-7c9e66797425-old-${n}`,
		nTempName: `st-7c9e66797425-new-${n}`,
	};
}

const recordFile = () => path.join(root, ".st-control", SID, RECORD_FILE);

async function gateError(store: RecreateAttemptStore): Promise<RecreateUnresolvedError | null> {
	return store.assertResolved(SID).then(
		() => null,
		(e) => e as RecreateUnresolvedError,
	);
}

describe("RecreateAttemptStore — persistence", () => {
	it("no record ⇒ the gate lets operations through", async () => {
		const store = new RecreateAttemptStore(root);
		expect(await store.read(SID)).toEqual({ kind: "none" });
		expect(await gateError(store)).toBeNull();
	});

	it("begin writes the open record atomically, 0600 in a 0700 dir, with no secret and no temp left", async () => {
		const store = new RecreateAttemptStore(root);
		await store.begin(SID, identity());
		const dir = path.dirname(recordFile());
		expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
		expect((await fs.stat(recordFile())).mode & 0o777).toBe(0o600);
		const raw = await fs.readFile(recordFile(), "utf8");
		const rec = JSON.parse(raw);
		expect(rec).toMatchObject({
			version: 1,
			sessionId: SID,
			attemptId: "att-1",
			state: "open",
			history: [],
		});
		expect(raw).not.toMatch(/token|hash/i);
		expect(await fs.readdir(dir)).toEqual([RECORD_FILE]);
	});

	it("a failed rename leaves the previous record intact and removes the temp file", async () => {
		const store = new RecreateAttemptStore(root);
		await store.begin(SID, identity());
		const before = await fs.readFile(recordFile(), "utf8");
		vi.spyOn(fs, "rename").mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
		await expect(store.markUncertain(SID, "att-1", "x")).rejects.toThrow("EIO");
		expect(await fs.readFile(recordFile(), "utf8")).toBe(before);
		expect(await fs.readdir(path.dirname(recordFile()))).toEqual([RECORD_FILE]);
	});

	it("a failed transition write keeps the attempt owned by the live process (no false orphan)", async () => {
		const store = new RecreateAttemptStore(root);
		await store.begin(SID, identity());
		const fail = () =>
			vi
				.spyOn(fs, "rename")
				.mockRejectedValueOnce(Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }));
		fail();
		await expect(store.resolve(SID, "att-1", { kind: "rolled-back" }, "x")).rejects.toThrow(
			"ENOSPC",
		);
		// Still this process's attempt, still open on disk.
		expect((await gateError(store))?.detail).toBe("attempt in progress");
		fail();
		await expect(store.markUncertain(SID, "att-1", "x")).rejects.toThrow("ENOSPC");
		expect((await gateError(store))?.detail).toBe("attempt in progress");
		// Once the disk recovers, the live process can still resolve it.
		await expect(
			store.resolve(SID, "att-1", { kind: "rolled-back" }, "answered"),
		).resolves.toMatchObject({
			state: "resolved",
		});
	});

	it("a crash between temp write and rename: the stray temp file is never read", async () => {
		const store = new RecreateAttemptStore(root);
		const dir = path.dirname(recordFile());
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(`${recordFile()}.tmp.1.abc`, "{garbage");
		expect(await store.read(SID)).toEqual({ kind: "none" });
		await store.begin(SID, identity());
		await fs.writeFile(`${recordFile()}.tmp.2.def`, JSON.stringify({ state: "resolved" }));
		const r = await store.read(SID);
		expect(r.kind === "ok" && r.record.state).toBe("open");
	});

	it("refuses to build a path from an unsafe session id", async () => {
		const store = new RecreateAttemptStore(root);
		for (const bad of ["../x", "a/b", "", "7C9E6679-7425-40DE-944B-E07FC1F90AE7"]) {
			expect(() => store.recordPath(bad)).toThrow(/unsafe session id/);
		}
	});
});

describe("RecreateAttemptStore — states and the gate", () => {
	it("open (this process) and uncertain are unresolved; resolved lets operations through", async () => {
		const store = new RecreateAttemptStore(root);
		await store.begin(SID, identity());
		expect((await gateError(store))?.detail).toBe("attempt in progress");
		await store.markUncertain(SID, "att-1", "docker request unanswered");
		expect((await gateError(store))?.detail).toBe("attempt uncertain");
		await store.resolve(SID, "att-1", { kind: "rolled-back" }, "all requests answered");
		expect(await gateError(store)).toBeNull();
	});

	it("open → resolved directly (normal completion) with the committed outcome", async () => {
		const store = new RecreateAttemptStore(root);
		await store.begin(SID, identity());
		const rec = await store.resolve(
			SID,
			"att-1",
			{ kind: "committed", nContainerId: "cid-n-1" },
			"done",
		);
		expect(rec).toMatchObject({
			state: "resolved",
			outcome: { kind: "committed", nContainerId: "cid-n-1" },
		});
		expect(await gateError(store)).toBeNull();
	});

	it("invalid transitions are refused and change nothing", async () => {
		const store = new RecreateAttemptStore(root);
		await store.begin(SID, identity());
		await expect(
			store.resolve(SID, "att-other", { kind: "rolled-back" }, "x"),
		).rejects.toBeInstanceOf(AttemptTransitionError);
		await store.resolve(SID, "att-1", { kind: "rolled-back" }, "x");
		await expect(store.markUncertain(SID, "att-1", "x")).rejects.toBeInstanceOf(
			AttemptTransitionError,
		);
		await expect(store.resolve(SID, "att-1", { kind: "rolled-back" }, "x")).rejects.toBeInstanceOf(
			AttemptTransitionError,
		);
		await expect(
			store.resolve(SID, "att-1", { kind: "committed" } as never, "x"),
		).rejects.toBeInstanceOf(AttemptTransitionError);
	});

	it("a new attempt is refused while the previous one is open or uncertain", async () => {
		const store = new RecreateAttemptStore(root);
		await store.begin(SID, identity(1));
		await expect(store.begin(SID, identity(2))).rejects.toBeInstanceOf(RecreateUnresolvedError);
		await store.markUncertain(SID, "att-1", "x");
		await expect(store.begin(SID, identity(2))).rejects.toBeInstanceOf(RecreateUnresolvedError);
		const r = await store.read(SID);
		expect(r.kind === "ok" && r.record.attemptId).toBe("att-1");
	});

	it("resolved attempts move into a bounded history that still names them all for leftover checks", async () => {
		const store = new RecreateAttemptStore(root);
		for (let i = 1; i <= HISTORY_MAX + 3; i++) {
			await store.begin(SID, identity(i));
			await store.resolve(SID, `att-${i}`, { kind: "committed", nContainerId: `cid-n-${i}` }, "ok");
		}
		const r = await store.read(SID);
		expect(r.kind === "ok" && r.record.history.length).toBe(HISTORY_MAX);
		const resolved = await store.resolvedAttempts(SID);
		expect(resolved.get(`att-${HISTORY_MAX + 3}`)).toEqual({
			kind: "committed",
			nContainerId: `cid-n-${HISTORY_MAX + 3}`,
		});
		expect(resolved.size).toBe(HISTORY_MAX + 1);
	});
});

describe("RecreateAttemptStore — fail-closed on unreadable records", () => {
	for (const [label, content] of [
		["not JSON", "{oops"],
		["unknown key", JSON.stringify({ version: 1, sessionId: SID, extra: 1 })],
		[
			"outcome on an open record",
			JSON.stringify({
				version: 1,
				sessionId: SID,
				...identity(),
				startedAt: "t",
				state: "open",
				stateAt: "t",
				outcome: { kind: "rolled-back" },
				history: [],
			}),
		],
		[
			"resolved without outcome",
			JSON.stringify({
				version: 1,
				sessionId: SID,
				...identity(),
				startedAt: "t",
				state: "resolved",
				stateAt: "t",
				history: [],
			}),
		],
		[
			"another session's record",
			JSON.stringify({
				version: 1,
				sessionId: "00000000-0000-4000-8000-000000000000",
				...identity(),
				startedAt: "t",
				state: "resolved",
				stateAt: "t",
				outcome: { kind: "rolled-back" },
				history: [],
			}),
		],
	] as const) {
		it(`${label} ⇒ unresolved, and no new attempt can start`, async () => {
			const store = new RecreateAttemptStore(root);
			await fs.mkdir(path.dirname(recordFile()), { recursive: true });
			await fs.writeFile(recordFile(), content);
			expect((await store.read(SID)).kind).toBe("unreadable");
			expect(await gateError(store)).toBeInstanceOf(RecreateUnresolvedError);
			await expect(store.begin(SID, identity())).rejects.toBeInstanceOf(RecreateUnresolvedError);
		});
	}

	it("a directory where the record should be ⇒ unresolved", async () => {
		const store = new RecreateAttemptStore(root);
		await fs.mkdir(recordFile(), { recursive: true });
		expect(await gateError(store)).toBeInstanceOf(RecreateUnresolvedError);
	});

	it.skipIf(process.getuid?.() === 0)("an unreadable file (EACCES) ⇒ unresolved", async () => {
		const store = new RecreateAttemptStore(root);
		await store.begin(SID, identity());
		await store.resolve(SID, "att-1", { kind: "rolled-back" }, "x");
		await fs.chmod(recordFile(), 0o000);
		expect((await gateError(store))?.detail).toMatch(/EACCES/);
	});
});

describe("RecreateAttemptStore — backend restart", () => {
	it("an open record from a dead process is unresolved at once, and boot recovery persists it as uncertain", async () => {
		const before = new RecreateAttemptStore(root);
		await before.begin(SID, identity());
		// The process dies here. A fresh store has no ownership of att-1.
		const after = new RecreateAttemptStore(root);
		expect((await gateError(after))?.detail).toBe("open attempt from a previous backend process");
		const recovered = await after.recoverOnBoot();
		expect(recovered).toEqual({ uncertain: [SID], unreadable: [] });
		const r = await after.read(SID);
		expect(r.kind === "ok" && r.record.state).toBe("uncertain");
		expect((await gateError(after))?.detail).toBe("attempt uncertain");
	});

	it("recovery never resolves anything (D8): repeated boots keep the session unresolved", async () => {
		const a = new RecreateAttemptStore(root);
		await a.begin(SID, identity());
		for (let i = 0; i < 3; i++) {
			const b = new RecreateAttemptStore(root);
			await b.recoverOnBoot();
			expect(await gateError(b)).toBeInstanceOf(RecreateUnresolvedError);
		}
		// A dead process's attempt cannot be resolved as "its own" by the
		// new process either: only the explicit resolve() with evidence.
		const c = new RecreateAttemptStore(root);
		await expect(c.markUncertain(SID, "att-1", "x")).rejects.toBeInstanceOf(AttemptTransitionError);
	});

	it("an attempt orphaned by a restart can never be resolved by this code (D8), whether it was open or uncertain", async () => {
		const OTHER = "11111111-1111-4111-8111-111111111111";
		const a = new RecreateAttemptStore(root);
		await a.begin(SID, identity(1));
		await a.begin(OTHER, identity(2));
		await a.markUncertain(OTHER, "att-2", "docker request unanswered");
		const b = new RecreateAttemptStore(root);
		await b.recoverOnBoot();
		for (const [sid, att] of [
			[SID, "att-1"],
			[OTHER, "att-2"],
		] as const) {
			const r = await b.read(sid);
			expect(r.kind === "ok" && r.record.state).toBe("uncertain");
			expect(r.kind === "ok" && typeof r.record.orphanedAt).toBe("string");
			await expect(b.resolve(sid, att, { kind: "rolled-back" }, "x")).rejects.toThrow(/orphaned/);
			await expect(
				b.resolve(sid, att, { kind: "committed", nContainerId: "n" }, "x"),
			).rejects.toThrow(/orphaned/);
		}
		// Recovery is idempotent: orphanedAt is set once and kept.
		const first = await b.read(SID);
		await new RecreateAttemptStore(root).recoverOnBoot();
		const second = await b.read(SID);
		expect(first.kind === "ok" && second.kind === "ok").toBe(true);
		if (first.kind === "ok" && second.kind === "ok") {
			expect(second.record.orphanedAt).toBe(first.record.orphanedAt);
		}
	});

	it("an uncertain attempt of the live process (not orphaned) can still be resolved with evidence", async () => {
		const s = new RecreateAttemptStore(root);
		await s.begin(SID, identity());
		await s.markUncertain(SID, "att-1", "probe unanswered");
		await expect(
			s.resolve(SID, "att-1", { kind: "committed", nContainerId: "n" }, "answered"),
		).resolves.toMatchObject({
			state: "resolved",
		});
	});

	it("recovery leaves resolved records alone, reports unreadable ones and ignores foreign directory names", async () => {
		const OTHER = "11111111-1111-4111-8111-111111111111";
		const s = new RecreateAttemptStore(root);
		await s.begin(SID, identity());
		await s.resolve(SID, "att-1", { kind: "rolled-back" }, "x");
		await fs.mkdir(path.join(root, ".st-control", OTHER), { recursive: true });
		await fs.writeFile(path.join(root, ".st-control", OTHER, RECORD_FILE), "{bad");
		await fs.mkdir(path.join(root, ".st-control", "not-a-session"), { recursive: true });
		const fresh = new RecreateAttemptStore(root);
		expect(await fresh.recoverOnBoot()).toEqual({ uncertain: [], unreadable: [OTHER] });
		expect(await gateError(fresh)).toBeNull();
	});

	it("a write failure on one session does not stop recovery of the others; the failed one stays gated", async () => {
		const OTHER = "11111111-1111-4111-8111-111111111111";
		const a = new RecreateAttemptStore(root);
		await a.begin(SID, identity(1));
		await a.begin(OTHER, identity(2));
		const b = new RecreateAttemptStore(root);
		vi.spyOn(fs, "rename").mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
		const out = await b.recoverOnBoot();
		expect(out.uncertain.sort()).toEqual([SID, OTHER].sort());
		const states = await Promise.all([SID, OTHER].map((sid) => b.read(sid)));
		// Exactly one got its marker; the other is still `open` on disk —
		// and refused by the gate either way.
		const marked = states.filter((r) => r.kind === "ok" && r.record.orphanedAt).length;
		expect(marked).toBe(1);
		for (const sid of [SID, OTHER]) {
			expect(
				await b.assertResolved(sid).then(
					() => null,
					(e) => e,
				),
			).toBeInstanceOf(RecreateUnresolvedError);
		}
	});

	it("no control dir at all ⇒ nothing to recover", async () => {
		expect(await new RecreateAttemptStore(root).recoverOnBoot()).toEqual({
			uncertain: [],
			unreadable: [],
		});
	});
});
