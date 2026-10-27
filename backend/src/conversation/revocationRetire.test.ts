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
	recoverRetiring,
	retireSessionRevocation,
	retiringPath,
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

/** Hold the retirement right after its `rename` of REVOKED → REVOKED.retiring. */
function pauseAfterRetiringRename() {
	const real = nodeFs.promises.rename.bind(nodeFs.promises);
	let release!: () => void;
	const paused = new Promise<void>((r) => {
		release = r;
	});
	let reached!: () => void;
	const atPause = new Promise<void>((r) => {
		reached = r;
	});
	vi.spyOn(nodeFs.promises, "rename").mockImplementation(async (from, to) => {
		await real(from, to);
		if (String(to).endsWith(revocationModule.RETIRING_FILE)) {
			reached();
			await paused;
		}
	});
	return { atPause, release };
}

describe("A1.1 — a marker being retired never leaves the session looking unrevoked", () => {
	it("cache populated, emergency done, retirement of an OLDER marker paused right after its rename ⇒ the receiver refuses, nothing persisted", async () => {
		// Capture is live and the receiver has the token cached.
		expect(await deliver()).toMatchObject({ accepted: true });
		const before = await persistedPrompts();
		// An older marker an enable started from (an API disable it read)…
		await disableSession({ ...service.activationDeps }, SID, "api");
		const older = await readSessionRevocation(root, SID);
		// …the D1 side re-authorized in the meantime (what the enable's CAS did)
		// and the cache repopulated with the live hash:
		Object.assign(dbStubs.sessions.get(SID) as object, {
			conversation_requested: 1,
			ingest_token_hash: HASH,
			ingest_token_hash_suspended: null,
		});
		service.invalidateToken(SID);
		expect(
			await service.authorize({ authorization: `Bearer ${TOKEN}`, stSession: SID }),
		).toMatchObject({
			ok: true,
		});
		// The emergency CLI completes in another process: newer marker + D1 revoked.
		await cli();
		const { atPause, release } = pauseAfterRetiringRename();
		const retiring = retireSessionRevocation(root, SID, older);
		await atPause;
		// The newer marker is aside: REVOKED is gone, REVOKED.retiring holds it.
		expect(await readSessionRevocation(root, SID)).toBeNull();
		expect(await checkRevocation(root, SID)).toBe("session");
		const during = await deliver();
		expect(during).toMatchObject({ accepted: false });
		release();
		expect(await retiring).toBe("newer");
		expect(await checkRevocation(root, SID)).toBe("session");
		expect(await deliver()).toMatchObject({ accepted: false });
		expect(await persistedPrompts()).toBe(before);
	});

	it("through the enable: the emergency lands between its D1 write and the retirement, the retirement is paused after the rename ⇒ refused throughout, enable refused, nothing persisted", async () => {
		expect(await deliver()).toMatchObject({ accepted: true });
		const before = await persistedPrompts();
		await disableSession({ ...service.activationDeps }, SID, "api");
		const realRetire = revocationModule.retireSessionRevocation;
		let atPause!: Promise<void>;
		let release!: () => void;
		vi.spyOn(revocationModule, "retireSessionRevocation").mockImplementation(async (r, s, e) => {
			await cli();
			({ atPause, release } = pauseAfterRetiringRename());
			return realRetire(r, s, e);
		});
		const enabling = enableSession(
			service.activationDeps,
			service.authority,
			SID,
			async () => false,
		);
		await vi.waitFor(() => expect(atPause).toBeDefined());
		await atPause;
		expect(await checkRevocation(root, SID)).toBe("session");
		expect(await deliver()).toMatchObject({ accepted: false });
		release();
		await expect(enabling).rejects.toThrow(/revoked/);
		expect(await deliver()).toMatchObject({ accepted: false });
		expect(await persistedPrompts()).toBe(before);
		expect(dbStubs.sessions.get(SID)).toMatchObject({
			conversation_requested: 0,
			ingest_token_hash: null,
		});
	});

	it("a retirement interrupted after its rename stays a revocation (fail-closed); the next enable puts the marker back first", async () => {
		expect(await deliver()).toMatchObject({ accepted: true });
		await disableSession({ ...service.activationDeps }, SID, "api");
		const older = await readSessionRevocation(root, SID);
		await cli(); // newer
		const newer = await readSessionRevocation(root, SID);
		// `link` fails after the rename (an I/O error, or the process dies there).
		vi.spyOn(nodeFs.promises, "link").mockRejectedValueOnce(
			Object.assign(new Error("EIO"), { code: "EIO" }),
		);
		await expect(retireSessionRevocation(root, SID, older)).rejects.toThrow("EIO");
		expect(await readSessionRevocation(root, SID)).toBeNull();
		await expect(fs.stat(retiringPath(root, SID))).resolves.toBeTruthy();
		expect(await checkRevocation(root, SID)).toBe("session");
		expect(await deliver()).toMatchObject({ accepted: false });
		// Recovery (the first thing the next enable does) restores the newer marker.
		await recoverRetiring(root, SID);
		expect(await readSessionRevocation(root, SID)).toBe(newer);
		await expect(fs.stat(retiringPath(root, SID))).rejects.toThrow();
		expect(await checkRevocation(root, SID)).toBe("session");
	});

	it("interrupted while retiring its OWN expected marker: still revoked until a later enable recovers and retires it properly", async () => {
		await disableSession({ ...service.activationDeps }, SID, "api");
		const own = await readSessionRevocation(root, SID);
		vi.spyOn(nodeFs.promises, "readFile").mockRejectedValueOnce(
			Object.assign(new Error("EIO"), { code: "EIO" }),
		);
		// readFile of the aside fails ⇒ treated as "not expected" ⇒ link back.
		expect(await retireSessionRevocation(root, SID, own)).toBe("newer");
		expect(await readSessionRevocation(root, SID)).toBe(own);
		vi.restoreAllMocks();
		// Leave a crash's leftover by hand: only the retiring name.
		await fs.rename(revokedPath(root, SID), retiringPath(root, SID));
		expect(await checkRevocation(root, SID)).toBe("session");
		// A plain enable later: recovers, then retires it and re-enables.
		const r = await enableSession(
			service.activationDeps,
			service.authority,
			SID,
			async () => false,
		);
		expect(r.capture.effective).toBe(true);
		expect(await checkRevocation(root, SID)).toBe("none");
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
