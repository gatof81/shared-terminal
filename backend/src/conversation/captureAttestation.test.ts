/**
 * conversation/captureAttestation.test.ts — §2.7.5.1 (v1.8.1), the incident of
 * 2026-11-03 reproduced through the real reconcile path (`converge`): a
 * capturing container keeps running, its image is gone (a rebuild of the tag
 * on the containerd image store), the backend restarts.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReadResult } from "../recreateAttempt.js";
import { type AttestDeps, attestFromHistory } from "./attestCli.js";
import {
	type AttestationRead,
	attestationPath,
	type CaptureAttestation,
	classifyAttestation,
	parseAttestation,
	readAttestation,
	signAttestation,
	writeAttestation,
} from "./captureAttestation.js";
import {
	CaptureAuthority,
	type ContainerView,
	relayEnabledPath,
	writeRelayEnabled,
} from "./captureAuth.js";
import { hashIngestToken, type SessionCaptureRow } from "./registry.js";
import type { RevocationState } from "./revocation.js";

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const SID = "0665fa5a-3eb4-4b81-9f13-bdf6b4f0b3eb";
const CID = "d4ac5ecf74dbcbb9f21132d84f08911c7f88d8f8c407d6d2a9a073412a4ba93c";
const OLD_CID = "c2bf9a62b787b0a745e2bd34a8187dccfb70c6051dbf622ebdc27f2cf75185da";
const IMG = "sha256:eb4b427460abc77f49f8f70440ffeafeb2fc4b8847430b88c49cd25d4b67f0ff";
const ATTEMPT = "ce78671b-21ad-4abe-94d8-d9a9e27062af";
const TOKEN = "b".repeat(64);
const HASH = hashIngestToken(TOKEN);
const LABELS = {
	"io.shared-terminal.conversation-relay": "2",
	"io.shared-terminal.session": SID,
	"io.shared-terminal.recreate-attempt": ATTEMPT,
	"io.shared-terminal.recreate-of": OLD_CID,
};

let root: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-attest-"));
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});
const exists = (p: string) =>
	fs.lstat(p).then(
		() => true,
		() => false,
	);
const hooksPath = () => path.join(root, ".claude-managed", SID, "conversation.json");

/** The incident's container: running, both mounts, token matches, image GONE. */
function view(patch: Partial<Extract<ContainerView, { exists: true }>> = {}): ContainerView {
	return {
		exists: true,
		running: true,
		token: TOKEN,
		managedMount: true,
		controlMount: true,
		imageId: IMG,
		imageRelay2: false,
		id: CID,
		imageExists: false,
		labels: { ...LABELS },
		...patch,
	};
}
function row(patch: Partial<SessionCaptureRow> = {}): SessionCaptureRow {
	return {
		status: "running",
		conversation_requested: 1,
		ingest_token_hash: HASH,
		ingest_token_hash_suspended: null,
		user_id: "u1",
		container_id: CID,
		...patch,
	};
}
function attestation(patch: Partial<Parameters<typeof signAttestation>[0]> = {}, key = KEY) {
	return signAttestation(
		{
			sessionId: SID,
			containerId: CID,
			imageId: IMG,
			basis: "recreate",
			attemptId: ATTEMPT,
			...patch,
		},
		key,
	);
}

function authority(
	opts: {
		view?: ContainerView;
		row?: SessionCaptureRow;
		revocation?: RevocationState;
		unresolved?: boolean;
		probe?: boolean;
		wired?: boolean;
	} = {},
) {
	return new CaptureAuthority({
		workspaceRoot: root,
		enabled: true,
		docker: {
			inspectCapture: async () => opts.view ?? view(),
			currentImage: async () => ({ imageId: "sha256:new", relay2: true }),
			probeRelay: async () => opts.probe ?? true,
		},
		getRow: async () => opts.row ?? row(),
		checkRevocation: async () => opts.revocation ?? "none",
		isRecreateUnresolved: async () => opts.unresolved ?? false,
		writeHooksFile: async () => {
			await fs.mkdir(path.dirname(hooksPath()), { recursive: true });
			await fs.writeFile(hooksPath(), "{}");
		},
		removeHooksFile: async () => {
			await fs.rm(hooksPath(), { force: true });
		},
		hooksFileExists: () => exists(hooksPath()),
		readAttestation:
			opts.wired === false ? undefined : (sid, cid) => readAttestation(root, sid, cid),
		attestationKey: opts.wired === false ? undefined : () => KEY,
		sleep: async () => undefined,
		identifyWaitMs: 10,
	});
}
async function captureFilesPresent(): Promise<boolean> {
	return (await exists(relayEnabledPath(root, SID))) && (await exists(hooksPath()));
}
async function seedCaptureFiles() {
	await writeRelayEnabled(root, SID);
	await fs.mkdir(path.dirname(hooksPath()), { recursive: true });
	await fs.writeFile(hooksPath(), "{}");
}

describe("the incident of 2026-11-03, through reconcile (converge)", () => {
	it("BEFORE the fix: image gone, no attestation ⇒ the boot reconcile withdraws a working session's capture", async () => {
		await seedCaptureFiles();
		const a = authority();
		expect(await a.converge(SID)).toBe("withdrawn");
		expect(await captureFilesPresent()).toBe(false);
		const block = await a.capture(SID);
		expect(block.effective).toBe(false);
		expect(block.pendingReasons).toEqual(["image-without-relay", "hooks-file-missing"]);
		expect(block.requiresRecreate).toBe(true);
	});

	it("WITH the attestation written at creation: the same restart keeps capture", async () => {
		await seedCaptureFiles();
		await writeAttestation(root, attestation());
		const a = authority();
		expect(await a.converge(SID)).toBe("kept");
		expect(await captureFilesPresent()).toBe(true);
		const block = await a.capture(SID);
		expect(block).toMatchObject({ effective: true, requiresRecreate: false, pendingReasons: [] });
	});

	it("recovery: files already withdrawn + a valid attestation ⇒ converge writes them back after the relay is identified", async () => {
		await writeAttestation(root, attestation({ basis: "history" }));
		const a = authority();
		expect(await captureFilesPresent()).toBe(false);
		expect(await a.converge(SID)).toBe("written");
		expect(await captureFilesPresent()).toBe(true);
		expect((await a.capture(SID)).effective).toBe(true);
	});

	it("recovery is not promised without the relay: a probe that fails writes nothing effective", async () => {
		await writeAttestation(root, attestation());
		const a = authority({ probe: false });
		expect(await a.converge(SID)).toBe("relay-unavailable");
		expect((await a.capture(SID)).effective).toBe(false);
	});
});

describe("negative cases: nothing but a verified attestation of THIS container replaces the image", () => {
	const denied = async (
		opts: Parameters<typeof authority>[0],
		att?: CaptureAttestation | "garbage",
	) => {
		await seedCaptureFiles();
		if (att === "garbage") {
			await fs.mkdir(path.dirname(attestationPath(root, SID, CID)), { recursive: true });
			await fs.writeFile(attestationPath(root, SID, CID), '{"v":1}');
		} else if (att) await writeAttestation(root, att);
		const a = authority(opts);
		const r = await a.converge(SID);
		expect(r === "withdrawn" || r === "skipped").toBe(true);
		return a;
	};

	it("a forged/inherited relay label alone (no attestation) is not enough", async () => {
		await denied({});
		expect(await captureFilesPresent()).toBe(false);
	});
	it("an attestation signed with another key is a contradiction", async () => {
		const a = await denied({}, attestation({}, OTHER_KEY));
		expect((await a.capture(SID)).pendingReasons).toContain("attestation-contradiction");
	});
	it("an unreadable / malformed attestation is a contradiction", async () => {
		const a = await denied({}, "garbage");
		expect((await a.capture(SID)).pendingReasons).toContain("attestation-contradiction");
	});
	it("an attestation of the PREVIOUS container (stale after a recreation) does not apply", async () => {
		await denied({}, attestation({ containerId: OLD_CID }));
	});
	it("an attestation naming this container with another image is a contradiction", async () => {
		await denied({}, attestation({ imageId: `sha256:${"f".repeat(64)}` }));
	});
	it("valid attestation but the container itself lacks the relay label", async () => {
		await denied({ view: view({ labels: { "io.shared-terminal.session": SID } }) }, attestation());
	});
	it("token mismatch", async () => {
		await denied(
			{ row: row({ ingest_token_hash: hashIngestToken("c".repeat(64)) }) },
			attestation(),
		);
	});
	it("a capture mount missing", async () => {
		await denied({ view: view({ controlMount: false }) }, attestation());
		await denied({ view: view({ managedMount: false }) }, attestation());
	});
	it("revoked (session or global)", async () => {
		await denied({ revocation: "session" }, attestation());
		await denied({ revocation: "global" }, attestation());
	});
	it("capture not requested", async () => {
		await denied({ row: row({ conversation_requested: 0 }) }, attestation());
	});
	it("an unresolved recreation: reconcile does not touch it at all", async () => {
		await seedCaptureFiles();
		await writeAttestation(root, attestation());
		expect(await authority({ unresolved: true }).converge(SID)).toBe("skipped");
	});
	it("D1 holds another container: the attestation does not apply to the inspected one", async () => {
		await denied({ view: view({ id: OLD_CID }) }, attestation());
	});
	it("the image still exists WITHOUT the label: the image rule decides, an attestation cannot override it", async () => {
		await denied({ view: view({ imageExists: true, imageRelay2: false }) }, attestation());
	});
	it("a contradiction denies even when the image exists and carries the label", async () => {
		const a = await denied(
			{ view: view({ imageExists: true, imageRelay2: true }) },
			attestation({}, OTHER_KEY),
		);
		expect((await a.capture(SID)).pendingReasons).toContain("attestation-contradiction");
	});
	it("not wired (no key): attestations are ignored, the image rule alone decides (behaviour of 1585512)", async () => {
		await denied({ wired: false }, attestation());
	});
	it("image present with the label and no attestation: unchanged, still authorized", async () => {
		await seedCaptureFiles();
		expect(
			await authority({ view: view({ imageExists: true, imageRelay2: true }) }).converge(SID),
		).toBe("kept");
	});
});

describe("attestation records", () => {
	it("one file per container: attesting N never replaces O's (a rollback onto O keeps its attestation)", async () => {
		await writeAttestation(root, attestation()); // O = CID
		await writeAttestation(root, attestation({ containerId: OLD_CID, basis: "recreate" })); // N
		const o = await readAttestation(root, SID, CID);
		expect(classifyAttestation(o, { sessionId: SID, containerId: CID, imageId: IMG }, KEY)).toBe(
			"valid",
		);
		await seedCaptureFiles();
		expect(await authority().converge(SID)).toBe("kept");
	});
	it("a file whose content names another container is a contradiction (never another container's grant)", async () => {
		await writeAttestation(root, attestation({ containerId: OLD_CID }));
		await fs.copyFile(attestationPath(root, SID, OLD_CID), attestationPath(root, SID, CID));
		expect((await readAttestation(root, SID, CID)).kind).toBe("unreadable");
		await seedCaptureFiles();
		const a = authority();
		expect(await a.converge(SID)).toBe("withdrawn");
		expect((await a.capture(SID)).pendingReasons).toContain("attestation-contradiction");
	});
	it("sign → parse round-trips; the parser is strict", () => {
		const r = attestation();
		expect(parseAttestation(JSON.stringify(r))).toEqual(r);
		expect(() => parseAttestation(JSON.stringify({ ...r, extra: 1 }))).toThrow();
		expect(() => parseAttestation(JSON.stringify({ ...r, relay: "1" }))).toThrow();
		expect(() => parseAttestation(JSON.stringify({ ...r, containerId: "abc" }))).toThrow();
		expect(() => parseAttestation("[]")).toThrow();
	});
	it("any field changed after signing breaks the MAC", () => {
		const r = attestation();
		for (const patch of [
			{ basis: "spawn" as const },
			{ issuedAt: "2020-01-01T00:00:00.000Z" },
			{ attemptId: null },
		]) {
			const read: AttestationRead = { kind: "present", record: { ...r, ...patch } };
			expect(
				classifyAttestation(read, { sessionId: SID, containerId: CID, imageId: IMG }, KEY),
			).toBe("contradiction");
		}
	});
	it("written durable and world-readable (0644), read back identical", async () => {
		const r = attestation();
		await writeAttestation(root, r);
		expect((await fs.stat(attestationPath(root, SID, CID))).mode & 0o777).toBe(0o644);
		expect(await readAttestation(root, SID, CID)).toEqual({ kind: "present", record: r });
	});
});

describe("attestFromHistory (existing containers, evidence from the recreation record)", () => {
	const record = (patch: Record<string, unknown> = {}): ReadResult => ({
		kind: "ok",
		record: {
			version: 1,
			sessionId: SID,
			attemptId: ATTEMPT,
			oContainerId: OLD_CID,
			oCanonicalName: "st-0665fa5a-3eb",
			oOldName: "st-0665fa5a-3eb-old-1",
			nTempName: "st-0665fa5a-3eb-new-1",
			startedAt: "2026-10-31T20:41:47.845Z",
			state: "resolved",
			stateAt: "2026-10-31T20:41:51.752Z",
			outcome: { kind: "committed", nContainerId: CID },
			history: [],
			...patch,
		} as never,
	});
	function deps(patch: Partial<AttestDeps> = {}): AttestDeps & { written: CaptureAttestation[] } {
		const written: CaptureAttestation[] = [];
		return {
			written,
			flag: true,
			getRow: async () => row(),
			inspect: async () => view(),
			readAttempt: async () => record(),
			checkRevocation: async () => "none",
			isRecreateUnresolved: async () => false,
			readAttestation: async () => ({ kind: "absent" }),
			writeAttestation: async (r) => {
				written.push(r);
			},
			key: () => KEY,
			...patch,
		};
	}

	it("the incident's B: committed record naming this container, creation labels match, image gone ⇒ attested (basis history)", async () => {
		const d = deps();
		const r = await attestFromHistory(d, SID, { write: true });
		expect(r).toMatchObject({ ok: true, written: true, attemptId: ATTEMPT });
		expect(r.notes).toContain("image-missing (creation-label evidence)");
		expect(d.written).toHaveLength(1);
		expect(d.written[0]).toMatchObject({
			basis: "history",
			containerId: CID,
			imageId: IMG,
			attemptId: ATTEMPT,
		});
		expect(
			classifyAttestation(
				{ kind: "present", record: d.written[0]! },
				{ sessionId: SID, containerId: CID, imageId: IMG },
				KEY,
			),
		).toBe("valid");
	});
	it("dry run writes nothing", async () => {
		const d = deps();
		expect(await attestFromHistory(d, SID, { write: false })).toMatchObject({
			ok: true,
			written: false,
		});
		expect(d.written).toHaveLength(0);
	});
	it.each([
		[
			"no recreation record (a container from a plain spawn before this fix)",
			{ readAttempt: async () => ({ kind: "none" }) as ReadResult },
			"no-recreation-record",
		],
		[
			"record unreadable",
			{ readAttempt: async () => ({ kind: "unreadable", error: "x" }) as ReadResult },
			"recreation-record-unreadable",
		],
		[
			"record names another container",
			{
				readAttempt: async () => record({ outcome: { kind: "committed", nContainerId: OLD_CID } }),
			},
			"record-names-another-container",
		],
		[
			"record rolled back",
			{ readAttempt: async () => record({ outcome: { kind: "rolled-back" } }) },
			"record-not-committed",
		],
		[
			"record is a rollback (reverse)",
			{ readAttempt: async () => record({ reverse: true }) },
			"record-is-a-rollback",
		],
		[
			"record not resolved",
			{ readAttempt: async () => record({ state: "uncertain" }) },
			"record-not-resolved",
		],
		[
			"attempt label differs",
			{
				inspect: async () =>
					view({ labels: { ...LABELS, "io.shared-terminal.recreate-attempt": "other" } }),
			},
			"label-attempt-mismatch",
		],
		[
			"recreate-of label differs",
			{
				inspect: async () => view({ labels: { ...LABELS, "io.shared-terminal.recreate-of": "x" } }),
			},
			"label-recreate-of-mismatch",
		],
		[
			"no relay label on the container",
			{
				inspect: async () =>
					view({ labels: { ...LABELS, "io.shared-terminal.conversation-relay": "1" } }),
			},
			"container-without-relay-label",
		],
		[
			"image exists but unlabelled",
			{ inspect: async () => view({ imageExists: true, imageRelay2: false }) },
			"image-without-relay",
		],
		[
			"D1 points elsewhere",
			{ getRow: async () => row({ container_id: OLD_CID }) },
			"container-not-d1-container",
		],
		[
			"token mismatch",
			{ getRow: async () => row({ ingest_token_hash: hashIngestToken("c".repeat(64)) }) },
			"token-mismatch",
		],
		[
			"mount missing",
			{ inspect: async () => view({ controlMount: false }) },
			"container-without-capture-mounts",
		],
		["revoked", { checkRevocation: async () => "session" as RevocationState }, "revoked"],
		["unresolved recreation", { isRecreateUnresolved: async () => true }, "recreate-unresolved"],
		[
			"capture not requested",
			{ getRow: async () => row({ conversation_requested: 0 }) },
			"not-requested",
		],
		["flag off", { flag: false }, "flag-off"],
	] as Array<[string, Partial<AttestDeps>, string]>)("refuses: %s", async (_n, patch, note) => {
		const d = deps(patch);
		const r = await attestFromHistory(d, SID, { write: true });
		expect(r.ok).toBe(false);
		expect(r.notes.join(" ")).toContain(note);
		expect(d.written).toHaveLength(0);
	});
	it("an existing contradicting attestation is never overwritten", async () => {
		const d = deps({
			readAttestation: async () => ({ kind: "present", record: attestation({}, OTHER_KEY) }),
		});
		const r = await attestFromHistory(d, SID, { write: true });
		expect(r.ok).toBe(false);
		expect(r.notes.join(" ")).toContain("attestation-contradiction");
		expect(d.written).toHaveLength(0);
	});
	it("already validly attested: nothing to do", async () => {
		const d = deps({ readAttestation: async () => ({ kind: "present", record: attestation() }) });
		expect(await attestFromHistory(d, SID, { write: true })).toMatchObject({
			ok: true,
			written: false,
			notes: ["already-attested"],
		});
	});
});
