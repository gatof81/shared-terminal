/**
 * revocationRetire.test.ts — Work's review of #469 (3.0d audit A1.1, A1.2):
 *
 *   A1.1  retiring the per-session marker must never leave the session
 *         looking unrevoked to the receiver, not even for the instant a
 *         newer marker is moved aside to be compared, and not after an
 *         interrupted retirement;
 *   A1.2  re-applying an API disable keeps the suspended hash, so a later
 *         enable works without a recreation; after the emergency or
 *         `--all` both hashes stay NULL.
 *
 * The receiver is the real ConversationService and store, with its token
 * cache populated before the revocation. The emergency CLI is another
 * process: its `disableSession` runs here without the service's in-process
 * cache invalidation, exactly what that process can (not) do.
 */

import * as nodeFs from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	sessions: new Map<string, Record<string, unknown>>(),
	conversations: new Map<string, Record<string, unknown>>(),
	d1Query: vi.fn(async (sql: string, params: unknown[] = []) => {
		if (/^SELECT .* FROM sessions WHERE session_id/.test(sql)) {
			const row = dbStubs.sessions.get(String(params[0]));
			return { results: row ? [{ ...row }] : [], success: true, meta: {} };
		}
		if (/^INSERT OR IGNORE INTO claude_conversations/.test(sql)) {
			const cid = String(params[0]);
			if (!dbStubs.conversations.has(cid)) {
				dbStubs.conversations.set(cid, {
					session_id: cid,
					st_session_id: params[1],
					status: params[8],
				});
			}
			return { results: [], success: true, meta: {} };
		}
		if (/^SELECT st_session_id FROM claude_conversations/.test(sql)) {
			const row = dbStubs.conversations.get(String(params[0]));
			return {
				results: row ? [{ st_session_id: row.st_session_id }] : [],
				success: true,
				meta: {},
			};
		}
		if (/^UPDATE sessions SET/.test(sql)) {
			// The registry statements, with the `revocation_seq` guard and the
			// idempotent suspend (3.0d audit A1, A1.2).
			const targets = sql.includes("WHERE")
				? [dbStubs.sessions.get(String(params[params.length - 1]))].filter(Boolean)
				: [...dbStubs.sessions.values()];
			let changes = 0;
			for (const row of targets as Array<Record<string, unknown>>) {
				if (sql.includes("WHERE revocation_seq = ? AND") && (row.revocation_seq ?? 0) !== params[0])
					continue;
				if (sql.includes("revocation_seq = revocation_seq + 1")) {
					row.revocation_seq = Number(row.revocation_seq ?? 0) + 1;
				}
				if (
					sql.includes(
						"ingest_token_hash_suspended = COALESCE(ingest_token_hash, ingest_token_hash_suspended)",
					)
				) {
					row.ingest_token_hash_suspended =
						row.ingest_token_hash ?? row.ingest_token_hash_suspended;
					row.ingest_token_hash = null;
					row.conversation_requested = 0;
				} else if (sql.includes("COALESCE(ingest_token_hash, ingest_token_hash_suspended)")) {
					row.ingest_token_hash = row.ingest_token_hash ?? row.ingest_token_hash_suspended;
					row.ingest_token_hash_suspended = null;
					row.conversation_requested = 1;
				} else if (sql.includes("ingest_token_hash = NULL, ingest_token_hash_suspended = NULL")) {
					row.ingest_token_hash = null;
					row.ingest_token_hash_suspended = null;
					row.conversation_requested = 0;
				} else if (sql.startsWith("UPDATE sessions SET conversation_requested = 1 WHERE")) {
					row.conversation_requested = 1;
				}
				changes++;
			}
			return { results: [], success: true, meta: { changes } };
		}
		return { results: [], success: true, meta: {} };
	}),
	getD1CallsSinceBoot: () => 0,
	__resetD1CallsForTests: () => undefined,
}));
vi.mock("../db.js", () => dbStubs);

import { disableAll, disableSession, enableSession } from "./activation.js";
import { generateIngestToken, hashIngestToken } from "./registry.js";
import * as revocationModule from "./revocation.js";
import {
	checkRevocation,
	readSessionRevocation,
	retireSessionRevocation,
	revokedPath,
} from "./revocation.js";
import { ConversationService } from "./service.js";
import { ConversationStore } from "./store.js";

const SID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const TOKEN = generateIngestToken();
const HASH = hashIngestToken(TOKEN);
let root: string;
let store: ConversationStore;
let service: ConversationService;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-retire-"));
	dbStubs.sessions.clear();
	dbStubs.conversations.clear();
	store = new ConversationStore({ workspaceRoot: root });
	service = new ConversationService({
		workspaceRoot: root,
		enabled: true,
		port: 3001,
		store,
		captureDocker: {
			inspectCapture: async () => ({
				exists: true,
				running: true,
				token: TOKEN,
				managedMount: true,
				controlMount: true,
				imageId: "sha256:i",
				imageRelay2: true,
			}),
			currentImage: async () => ({ imageId: "sha256:i", relay2: true }),
			probeRelay: async () => true,
		},
	});
	dbStubs.sessions.set(SID, {
		status: "running",
		conversation_requested: 1,
		ingest_token_hash: HASH,
		ingest_token_hash_suspended: null,
		user_id: "u1",
		container_id: "cid-1",
		revocation_seq: 0,
	});
});
afterEach(async () => {
	vi.restoreAllMocks();
	await service.shutdown();
	await fs.rm(root, { recursive: true, force: true });
});

/** The other process: same function, but it cannot touch this receiver's cache. */
const otherProcess = { workspaceRoot: "", enabled: true, port: 3001 };
const cli = () => disableSession({ ...otherProcess, workspaceRoot: root }, SID, "cli");

let n = 0;
const prompt = () => ({
	hook_event_name: "UserPromptSubmit",
	session_id: "c1",
	cwd: "/w",
	prompt: `p${n++}`,
});

/** The ingest route's two steps, as the receiver runs them. */
async function deliver() {
	const auth = await service.authorize({ authorization: `Bearer ${TOKEN}`, stSession: SID });
	if (!("ok" in auth) || auth.ok !== true) return auth;
	return service.ingest(SID, "%0", prompt());
}

async function persistedPrompts(): Promise<number> {
	await store.flush(SID, "c1").catch(() => undefined);
	const content = await fs.readFile(store.eventsPath(SID, "c1"), "utf8").catch(() => "");
	return content.split("\n").filter((l) => l.includes('"user_prompt"')).length;
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** The live state of the marker files (raw bytes), for the A1.1b checks. */
async function markerBytes() {
	return fs.readFile(revokedPath(root, SID), "utf8").catch(() => null);
}

/** Capture live, cache populated; then an API disable the enable will start from. */
async function liveThenApiDisabled() {
	expect(await deliver()).toMatchObject({ accepted: true });
	await disableSession({ ...service.activationDeps }, SID, "api");
	return readSessionRevocation(root, SID);
}

/**
 * Deterministic interleaving with real file operations: while `during` runs,
 * every fs call it makes is followed — before it may go on — by a real
 * delivery (cached authorization + ingest) whose outcome is recorded. No
 * timers: each probe is awaited inside the hook.
 */
async function probeAfterEveryFsStep(during: () => Promise<unknown>) {
	const outcomes: Array<{ step: string; accepted: boolean }> = [];
	let active = true;
	let probing = false;
	const ops = ["open", "rename", "readFile", "link", "rm"] as const;
	for (const op of ops) {
		const real = (nodeFs.promises[op] as (...a: unknown[]) => Promise<unknown>).bind(
			nodeFs.promises,
		);
		vi.spyOn(nodeFs.promises, op).mockImplementation((async (...a: unknown[]) => {
			const r = await real(...a);
			if (active && !probing) {
				probing = true;
				try {
					const out = (await deliver()) as { accepted?: boolean };
					outcomes.push({
						step: `${op} ${path.basename(String(a[a.length > 1 && op === "rename" ? 1 : 0]))}`,
						accepted: !!out.accepted,
					});
				} finally {
					probing = false;
				}
			}
			return r;
		}) as never);
	}
	let result: unknown;
	let error: unknown;
	try {
		result = await during();
	} catch (err) {
		error = err;
	} finally {
		active = false;
		vi.restoreAllMocks();
	}
	return { outcomes, result, error };
}

describe("A1.1a — a revocation in effect is never read as absent", () => {
	it("retirement (lift) of an OLDER marker while a newer emergency is in effect: refused after every fs step, nothing persisted", async () => {
		const older = await liveThenApiDisabled();
		// The enable's D1 side re-authorized meanwhile, and the cache holds the hash.
		Object.assign(dbStubs.sessions.get(SID) as object, {
			conversation_requested: 1,
			ingest_token_hash: HASH,
			ingest_token_hash_suspended: null,
		});
		service.invalidateToken(SID);
		await service.authorize({ authorization: `Bearer ${TOKEN}`, stSession: SID });
		const before = await persistedPrompts();
		await cli(); // newer marker; the other process can't touch this cache
		const { outcomes, result } = await probeAfterEveryFsStep(() =>
			retireSessionRevocation(root, SID, older),
		);
		expect(result).toBe("newer");
		expect(outcomes.length).toBeGreaterThan(3); // open, rename, reads…
		expect(outcomes.filter((o) => o.accepted)).toEqual([]);
		expect(await checkRevocation(root, SID)).toBe("session");
		expect(await persistedPrompts()).toBe(before);
	});

	for (const [direction, between] of [
		[
			"a newer emergency written between the reader's LIFTED read and its REVOKED read",
			async () => cli(),
		],
		[
			"a lift of the older marker published between the reader's two reads (newer emergency already in effect)",
			async (older: string | null) => {
				await cli();
				await retireSessionRevocation(root, SID, older);
			},
		],
	] as const) {
		it(`reader race — ${direction}: ingest refused, nothing persisted`, async () => {
			const older = await liveThenApiDisabled();
			if (direction.startsWith("a newer emergency")) {
				// The older marker was lifted before: capture is live again, cached.
				await retireSessionRevocation(root, SID, older);
				Object.assign(dbStubs.sessions.get(SID) as object, {
					conversation_requested: 1,
					ingest_token_hash: HASH,
					ingest_token_hash_suspended: null,
				});
				service.invalidateToken(SID);
				expect(await deliver()).toMatchObject({ accepted: true });
			} else {
				Object.assign(dbStubs.sessions.get(SID) as object, {
					conversation_requested: 1,
					ingest_token_hash: HASH,
					ingest_token_hash_suspended: null,
				});
				service.invalidateToken(SID);
				await service.authorize({ authorization: `Bearer ${TOKEN}`, stSession: SID });
			}
			const before = await persistedPrompts();
			// Pause the ingest's reader right after its first marker read.
			const liftedRead = deferred();
			const resume = deferred();
			const realRead = nodeFs.promises.readFile.bind(nodeFs.promises);
			let reading = false;
			let paused = false;
			vi.spyOn(nodeFs.promises, "readFile").mockImplementation((async (p: unknown, o: unknown) => {
				// Pause after the read whatever it answered (no LIFTED yet = ENOENT).
				const r = await realRead(p as never, o as never).then(
					(v) => ({ v }),
					(e: unknown) => ({ e }),
				);
				// Between the reader's two reads, whichever it makes first.
				const name = path.basename(String(p));
				if (reading && !paused && (name === revocationModule.LIFTED_FILE || name === "REVOKED")) {
					paused = true;
					liftedRead.resolve();
					await resume.promise;
				}
				if ("e" in r) throw r.e;
				return r.v;
			}) as never);
			reading = true; // before the call: its first reads are issued synchronously
			const ingesting = service.ingest(SID, "%0", prompt());
			await liftedRead.promise;
			reading = false;
			await between(older);
			resume.resolve();
			expect(await ingesting).toMatchObject({ accepted: false, reason: "revoked" });
			vi.restoreAllMocks();
			expect(await persistedPrompts()).toBe(before);
			expect(await checkRevocation(root, SID)).toBe("session");
		});
	}

	it("a lift that cannot be published leaves the revocation in effect and D1 revoked again; a torn temp file counts for nothing", async () => {
		await liveThenApiDisabled();
		const realRename = nodeFs.promises.rename.bind(nodeFs.promises);
		vi.spyOn(nodeFs.promises, "rename").mockImplementation((async (from: unknown, to: unknown) => {
			if (String(to).endsWith(`/${revocationModule.LIFTED_FILE}`)) {
				throw Object.assign(new Error("EIO"), { code: "EIO" });
			}
			return realRename(from as never, to as never);
		}) as never);
		await expect(
			enableSession(service.activationDeps, service.authority, SID, async () => false),
		).rejects.toThrow("EIO");
		vi.restoreAllMocks();
		expect(await checkRevocation(root, SID)).toBe("session");
		expect(dbStubs.sessions.get(SID)).toMatchObject({
			conversation_requested: 0,
			ingest_token_hash: null,
		});
		expect(await deliver()).toMatchObject({ accepted: false });
		// The publish's temp file (a crash before its rename) lifts nothing.
		const dir = path.dirname(revokedPath(root, SID));
		expect(
			(await fs.readdir(dir)).some((f) => f.startsWith(`${revocationModule.LIFTED_FILE}.tmp`)),
		).toBe(true);
		expect(await checkRevocation(root, SID)).toBe("session");
		// No recovery step exists or is needed: a plain enable later works.
		const r = await enableSession(
			service.activationDeps,
			service.authority,
			SID,
			async () => false,
		);
		expect(r.capture.effective).toBe(true);
		expect(await checkRevocation(root, SID)).toBe("none");
	});

	it("an unreadable LIFTED or REVOKED is fail-closed: absence that cannot be established is not absence", async () => {
		await liveThenApiDisabled();
		const realRead = nodeFs.promises.readFile.bind(nodeFs.promises);
		for (const name of [revocationModule.LIFTED_FILE, "REVOKED"]) {
			vi.spyOn(nodeFs.promises, "readFile").mockImplementation((async (p: unknown, o: unknown) => {
				if (String(p).endsWith(`/${name}`))
					throw Object.assign(new Error("EACCES"), { code: "EACCES" });
				return realRead(p as never, o as never);
			}) as never);
			expect([name, await checkRevocation(root, SID)]).toEqual([name, "session"]);
			vi.restoreAllMocks();
		}
	});
});

describe("A1.1b — the emergency's marker always prevails over a concurrent enable", () => {
	for (const [where, hookFile] of [
		["before the lift is published", "open"],
		["right after the lift is published, before the enable re-reads", "rename"],
	] as const) {
		it(`emergency ${where}: its marker (content and id) stays in effect; D1, seq, enable result, next spawn, no reopening`, async () => {
			await liveThenApiDisabled();
			const seqBefore = Number(dbStubs.sessions.get(SID)?.revocation_seq ?? 0);
			let emergencyBytes: string | null = null;
			const real = (nodeFs.promises[hookFile] as (...a: unknown[]) => Promise<unknown>).bind(
				nodeFs.promises,
			);
			let armed = true;
			vi.spyOn(nodeFs.promises, hookFile).mockImplementation((async (...a: unknown[]) => {
				const isLift =
					hookFile === "rename"
						? String(a[1]).endsWith(`/${revocationModule.LIFTED_FILE}`)
						: String(a[0]).includes(`${revocationModule.LIFTED_FILE}.tmp`);
				if (armed && isLift && hookFile === "open") {
					armed = false;
					vi.restoreAllMocks();
					await cli();
					emergencyBytes = await markerBytes();
					return real(...a);
				}
				const r = await real(...a);
				if (armed && isLift) {
					armed = false;
					vi.restoreAllMocks();
					await cli();
					emergencyBytes = await markerBytes();
				}
				return r;
			}) as never);
			const outcome = await enableSession(
				service.activationDeps,
				service.authority,
				SID,
				async () => false,
			).then(
				(r) => (r.capture.effective ? "effective" : "not effective"),
				(e: Error) => e.name,
			);
			vi.restoreAllMocks();
			expect(emergencyBytes).not.toBeNull();
			// The emergency's own marker, byte for byte (its id included), in effect.
			expect(await markerBytes()).toBe(emergencyBytes);
			expect(await readSessionRevocation(root, SID)).toBe(emergencyBytes);
			expect(JSON.parse(emergencyBytes as unknown as string)).toMatchObject({
				by: "cli",
				id: expect.any(String),
			});
			expect(outcome).toBe("RevokedMeanwhileError");
			const row = dbStubs.sessions.get(SID) as Record<string, unknown>;
			expect(row).toMatchObject({
				conversation_requested: 0,
				ingest_token_hash: null,
				ingest_token_hash_suspended: null,
			});
			// Each revocation statement bumped it: the CLI's and the re-application.
			expect(Number(row.revocation_seq)).toBeGreaterThanOrEqual(seqBefore + 1);
			expect(await deliver()).toMatchObject({ accepted: false });
			const spawn = await import("./activation.js").then((m) =>
				m.prepareSpawnCapture(service.activationDeps, SID, { imageId: "sha256:i", relay2: true }),
			);
			expect(spawn.env.some((e) => e.startsWith("ST_INGEST_TOKEN="))).toBe(false);
		});
	}

	it("the whole enable racing a completed emergency: refused after every fs step of the enable, the emergency's marker kept", async () => {
		await liveThenApiDisabled();
		let emergencyBytes: string | null = null;
		const realRetire = revocationModule.retireSessionRevocation;
		vi.spyOn(revocationModule, "retireSessionRevocation").mockImplementationOnce(
			async (r, s, e) => {
				await cli();
				emergencyBytes = await markerBytes();
				return realRetire(r, s, e);
			},
		);
		// Re-authorize the cache the enable's D1 write would make valid.
		const { outcomes, error } = await probeAfterEveryFsStep(() =>
			enableSession(service.activationDeps, service.authority, SID, async () => false),
		);
		expect((error as Error).name).toBe("RevokedMeanwhileError");
		expect(outcomes.filter((o) => o.accepted)).toEqual([]);
		expect(await markerBytes()).toBe(emergencyBytes);
		expect(await checkRevocation(root, SID)).toBe("session");
	});
});

describe("A1.2 — re-applying an API disable keeps the suspended hash", () => {
	it("re-enable → API disable before the retirement → re-application ⇒ the suspended hash survives and a later enable works without recreation", async () => {
		await disableSession({ ...service.activationDeps }, SID, "api");
		expect(dbStubs.sessions.get(SID)).toMatchObject({
			ingest_token_hash: null,
			ingest_token_hash_suspended: HASH,
		});
		const realRetire = revocationModule.retireSessionRevocation;
		vi.spyOn(revocationModule, "retireSessionRevocation").mockImplementationOnce(
			async (r, s, e) => {
				await disableSession({ ...otherProcess, workspaceRoot: root }, SID, "api");
				return realRetire(r, s, e);
			},
		);
		await expect(
			enableSession(service.activationDeps, service.authority, SID, async () => false),
		).rejects.toThrow(/revoked/);
		expect(dbStubs.sessions.get(SID)).toMatchObject({
			conversation_requested: 0,
			ingest_token_hash: null,
			ingest_token_hash_suspended: HASH,
		});
		vi.restoreAllMocks();
		// No concurrency now: the suspended hash is restored, no recreation needed.
		const r = await enableSession(
			service.activationDeps,
			service.authority,
			SID,
			async () => false,
		);
		expect(r.capture).toMatchObject({
			effective: true,
			requiresRecreate: false,
			pendingReasons: [],
		});
		expect(dbStubs.sessions.get(SID)).toMatchObject({
			ingest_token_hash: HASH,
			ingest_token_hash_suspended: null,
		});
	});

	it("the suspend statement applied twice keeps the hash; after the emergency or --all both stay NULL", async () => {
		await disableSession({ ...otherProcess, workspaceRoot: root }, SID, "api");
		await disableSession({ ...otherProcess, workspaceRoot: root }, SID, "api");
		expect(dbStubs.sessions.get(SID)).toMatchObject({
			ingest_token_hash: null,
			ingest_token_hash_suspended: HASH,
		});
		await cli();
		await disableSession({ ...otherProcess, workspaceRoot: root }, SID, "api");
		expect(dbStubs.sessions.get(SID)).toMatchObject({
			ingest_token_hash: null,
			ingest_token_hash_suspended: null,
		});
		Object.assign(dbStubs.sessions.get(SID) as object, {
			ingest_token_hash: HASH,
			conversation_requested: 1,
		});
		await disableAll({ ...otherProcess, workspaceRoot: root });
		await disableSession({ ...otherProcess, workspaceRoot: root }, SID, "api");
		expect(dbStubs.sessions.get(SID)).toMatchObject({
			ingest_token_hash: null,
			ingest_token_hash_suspended: null,
		});
	});
});
