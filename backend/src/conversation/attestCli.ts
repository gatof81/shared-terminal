/**
 * conversation/attestCli.ts — attest an EXISTING capture container from the
 * backend's own history (docs/CONVERSATION.md §2.7.5.1, v1.8.1).
 *
 *   npm run conversation:attest -- <sessionId>            dry run: prints the verdict
 *   npm run conversation:attest -- <sessionId> --write    writes the attestation
 *
 * Runs inside the backend container like backup.ts. It never writes the
 * marker or the hooks file and never touches the container: restoring
 * capture stays the official write procedure (admin `PATCH …/conversation
 * {enabled:true}`), which re-checks everything and identifies the relay
 * with a fresh probe. All this tool may add is the attestation, and only
 * when every check below holds — evidence recorded at the container's
 * creation by the backend itself, never inferred from a label alone:
 *   - capture allowed for the session (flag, requested, no revocation, no
 *     unresolved recreation);
 *   - the D1 container exists, has both capture mounts and its token
 *     corresponds to the authorized hash;
 *   - the recreation record is resolved + committed and names exactly this
 *     container, whose creation labels (session, attempt, recreate-of) match
 *     that record, and the container carries the relay label;
 *   - its image, if it still exists, carries the label;
 *   - no attestation contradicts it (one that does is never overwritten).
 */

import Dockerode from "dockerode";
import type { ReadResult } from "../recreateAttempt.js";
import {
	type AttestationRead,
	type CaptureAttestation,
	classifyAttestation,
	historicalEvidence,
	signAttestation,
} from "./captureAttestation.js";
import { type ContainerView, correspondenceOf } from "./captureAuth.js";
import type { SessionCaptureRow } from "./registry.js";
import type { RevocationState } from "./revocation.js";

export interface AttestDeps {
	flag: boolean;
	getRow: (sessionId: string) => Promise<SessionCaptureRow | null>;
	inspect: (containerId: string) => Promise<ContainerView>;
	readAttempt: (sessionId: string) => Promise<ReadResult>;
	checkRevocation: (sessionId: string) => Promise<RevocationState>;
	isRecreateUnresolved: (sessionId: string) => Promise<boolean>;
	readAttestation: (sessionId: string, containerId: string) => Promise<AttestationRead>;
	/** Publishes without replacing (link(2)); false when the name already exists. */
	writeAttestation: (record: CaptureAttestation) => Promise<boolean>;
	key: () => Buffer;
}

export interface AttestResult {
	ok: boolean;
	written: boolean;
	/** Why not, or "already-attested" / "image-missing (creation-label evidence)". */
	notes: string[];
	attemptId?: string;
	containerId?: string;
	imageId?: string;
}

export async function attestFromHistory(
	deps: AttestDeps,
	sessionId: string,
	opts: { write: boolean },
): Promise<AttestResult> {
	const notes: string[] = [];
	const row = await deps.getRow(sessionId);
	if (!row) return { ok: false, written: false, notes: ["session-not-found"] };
	if (!deps.flag) notes.push("flag-off");
	if (row.conversation_requested !== 1) notes.push("not-requested");
	if ((await deps.checkRevocation(sessionId)) !== "none") notes.push("revoked");
	if (await deps.isRecreateUnresolved(sessionId).catch(() => true))
		notes.push("recreate-unresolved");
	if (!row.container_id) return { ok: false, written: false, notes: [...notes, "no-container"] };
	const view = await deps.inspect(row.container_id);
	if (!view.exists || !view.id)
		return { ok: false, written: false, notes: [...notes, "container-missing"] };
	if (!view.managedMount || !view.controlMount) notes.push("container-without-capture-mounts");
	const corr = correspondenceOf({
		flag: deps.flag,
		row,
		revocation: "none",
		unresolved: false,
		container: view,
		currentImageRelay2: false,
		marker: false,
		hooksFile: false,
	});
	if (corr !== "match") notes.push(`token-${corr}`);
	const attempt = await deps.readAttempt(sessionId);
	const verdict = historicalEvidence({
		sessionId,
		d1ContainerId: row.container_id,
		attempt,
		container: { id: view.id, imageId: view.imageId, labels: view.labels ?? {} },
		image: { exists: view.imageExists !== false, relay2: view.imageRelay2 },
	});
	if (!verdict.ok) notes.push(...verdict.reasons);
	const current = classifyAttestation(
		await deps.readAttestation(sessionId, view.id),
		{ sessionId, containerId: view.id, imageId: view.imageId },
		deps.key(),
	);
	if (current === "contradiction") notes.push("attestation-contradiction (left untouched)");
	const ids = { containerId: view.id, imageId: view.imageId };
	if (notes.length > 0 || !verdict.ok) return { ok: false, written: false, notes, ...ids };
	if (current === "valid")
		return {
			ok: true,
			written: false,
			notes: ["already-attested"],
			attemptId: verdict.attemptId,
			...ids,
		};
	const why = verdict.imageMissing ? ["image-missing (creation-label evidence)"] : [];
	if (!opts.write)
		return {
			ok: true,
			written: false,
			notes: ["dry-run", ...why],
			attemptId: verdict.attemptId,
			...ids,
		};
	// This tool runs in its own process, outside the backend's lifecycle lock:
	// a recreation, a disable or a revocation may land while it ran. Re-read
	// what the verdict rests on immediately before publishing and refuse on
	// any change (the record, D1's container, revocation, an open attempt).
	const again = await recheck(deps, sessionId, row.container_id, attempt);
	if (again.length > 0)
		return { ok: false, written: false, notes: ["changed-during-check", ...again], ...ids };
	const written = await deps.writeAttestation(
		signAttestation(
			{
				sessionId,
				containerId: view.id,
				imageId: view.imageId,
				basis: "history",
				attemptId: verdict.attemptId,
			},
			deps.key(),
		),
	);
	if (!written)
		return { ok: false, written: false, notes: ["attestation-appeared (left untouched)"], ...ids };
	return { ok: true, written: true, notes: why, attemptId: verdict.attemptId, ...ids };
}

async function recheck(
	deps: AttestDeps,
	sessionId: string,
	containerId: string,
	attempt: ReadResult,
): Promise<string[]> {
	const out: string[] = [];
	const row = await deps.getRow(sessionId);
	if (!row || row.container_id !== containerId) out.push("d1-container-changed");
	if (!row || row.conversation_requested !== 1) out.push("not-requested");
	if ((await deps.checkRevocation(sessionId)) !== "none") out.push("revoked");
	if (await deps.isRecreateUnresolved(sessionId).catch(() => true)) out.push("recreate-unresolved");
	// Byte-for-byte the record the verdict was computed from (any new history
	// entry, retained container or state change counts as a change).
	if (JSON.stringify(await deps.readAttempt(sessionId)) !== JSON.stringify(attempt))
		out.push("recreate-record-changed");
	return out;
}

// ── Entry point (inside the backend container) ─────────────────────────────

async function main(argv: string[]): Promise<number> {
	const [cmd, sid, flag] = argv;
	if (
		cmd !== "attest" ||
		!sid ||
		!/^[A-Za-z0-9_-]{1,128}$/.test(sid) ||
		(flag && flag !== "--write")
	) {
		process.stderr.write("usage: conversation:attest -- <sessionId> [--write]\n");
		return 2;
	}
	const WR = process.env.WORKSPACE_ROOT ?? "/var/shared-terminal/workspaces";
	const { getSessionCapture } = await import("./registry.js");
	const { checkRevocation } = await import("./revocation.js");
	const { RecreateAttemptStore } = await import("../recreateAttempt.js");
	const { inspectCaptureWith } = await import("../dockerManager.js");
	const { readAttestation, writeAttestation, ATTESTATION_KEY_INFO } = await import(
		"./captureAttestation.js"
	);
	const { deriveSubkey, validateSecretsKey } = await import("../secrets.js");
	validateSecretsKey();
	const docker = new Dockerode({ socketPath: "/var/run/docker.sock" });
	const store = new RecreateAttemptStore(WR);
	const r = await attestFromHistory(
		{
			flag: process.env.CONVERSATION_ENABLED === "true",
			getRow: getSessionCapture,
			inspect: (cid) => inspectCaptureWith(docker, cid),
			readAttempt: (s) => store.read(s),
			checkRevocation: (s) => checkRevocation(WR, s),
			isRecreateUnresolved: (s) =>
				store.assertResolved(s).then(
					() => false,
					() => true,
				),
			readAttestation: (s, cid) => readAttestation(WR, s, cid),
			writeAttestation: (rec) => writeAttestation(WR, rec, () => true, { noClobber: true }),
			key: () => deriveSubkey(ATTESTATION_KEY_INFO),
		},
		sid,
		{ write: flag === "--write" },
	);
	process.stdout.write(`${JSON.stringify({ sessionId: sid, ...r })}\n`);
	return r.ok ? 0 : 1;
}

if (typeof require !== "undefined" && require.main === module) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err) => {
			process.stderr.write(`${(err as Error).message}\n`);
			process.exit(1);
		},
	);
}
