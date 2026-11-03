/**
 * conversation/captureAttestation.ts — capture capability attestation
 * (docs/CONVERSATION.md §2.7.5.1, v1.8.1).
 *
 * Why it exists (incident 2026-11-03): capture authorization required the
 * container's OWN image to carry `conversation-relay="2"`, read as the image
 * exists NOW (#513). On Docker's containerd image store, re-building a tag
 * removes the previous image immediately even while containers still run on
 * it (reproduced on VM100); the next backend start then found "no label",
 * withdrew the hooks file and the marker of every capturing session, and
 * capture stopped although nothing about those containers had changed.
 *
 * The fix keeps the image rule wherever the image exists, and adds ONE way to
 * stay authorized without it: a record the backend signs when it creates the
 * container from an image it has just verified, bound to that container's
 * immutable id and image id. It is evidence written at the moment the fact
 * was observed — never a flag to set later, never trust inferred from a
 * label alone:
 *   - HMAC-SHA256 with a subkey of SECRETS_ENCRYPTION_KEY (a file written by
 *     anything without the key does not verify);
 *   - bound to sessionId, the full container id and the image id; a record
 *     for another container is simply not applicable;
 *   - any record that does not verify, or names this container with another
 *     image or session, is a CONTRADICTION and denies — also when the image
 *     still exists.
 * Everything else capture requires (flag, requested, revocation, unresolved
 * recreation, both mounts, token↔hash, the fresh relay probe) is unchanged.
 *
 * Existing containers created before this module can be attested only from
 * the backend's own recreation record (`attestFromHistory`): the record that
 * created that exact container, matched by id and by the labels the engine
 * put on it at creation. No record, no attestation — those need a recreation.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AttemptRecord, ReadResult } from "../recreateAttempt.js";
import { controlDir, ensureControlDir } from "./captureAuth.js";

export const ATTESTATION_FILE = "capture-attestation.json";
/** HKDF `info` for the attestation subkey (secrets.ts deriveSubkey). */
export const ATTESTATION_KEY_INFO = "st-capture-attestation/v1";

const RELAY_LABEL = "io.shared-terminal.conversation-relay";
const RELAY_VALUE = "2";
// Same values as recreate/ports.ts (not imported: that module pulls Docker types).
const LABEL_SESSION = "io.shared-terminal.session";
const LABEL_RECREATE_OF = "io.shared-terminal.recreate-of";
const LABEL_ATTEMPT = "io.shared-terminal.recreate-attempt";

export type AttestationBasis = "spawn" | "recreate" | "history";

export interface CaptureAttestation {
	v: 1;
	sessionId: string;
	/** Full 64-hex container id. */
	containerId: string;
	/** `sha256:<64 hex>`, the container's image as Docker reports it. */
	imageId: string;
	relay: "2";
	basis: AttestationBasis;
	/** The recreation attempt that created the container (recreate/history), else null. */
	attemptId: string | null;
	issuedAt: string;
	/** HMAC-SHA256 (hex) of the canonical fields. */
	mac: string;
}

export type AttestationRead =
	| { kind: "absent" }
	| { kind: "present"; record: CaptureAttestation }
	| { kind: "unreadable"; error: string };

/**
 * valid: this container, this image, this session, signed.
 * absent: no record, or a record for ANOTHER container (stale, not applicable).
 * contradiction: a record that does not verify or disagrees about this
 * container — evidence of tampering or corruption: deny.
 */
export type AttestationCheck = "valid" | "absent" | "contradiction";

const CONTAINER_ID_RE = /^[0-9a-f]{64}$/;
const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ATTEMPT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAC_RE = /^[0-9a-f]{64}$/;
const KEYS = [
	"v",
	"sessionId",
	"containerId",
	"imageId",
	"relay",
	"basis",
	"attemptId",
	"issuedAt",
	"mac",
] as const;

function canonical(r: Omit<CaptureAttestation, "mac">): string {
	// A fixed array, not an object: key order can never change what is signed.
	return JSON.stringify([
		r.v,
		r.sessionId,
		r.containerId,
		r.imageId,
		r.relay,
		r.basis,
		r.attemptId,
		r.issuedAt,
	]);
}

function macOf(r: Omit<CaptureAttestation, "mac">, key: Buffer): string {
	return createHmac("sha256", key).update(canonical(r)).digest("hex");
}

export function signAttestation(
	fields: {
		sessionId: string;
		containerId: string;
		imageId: string;
		basis: AttestationBasis;
		attemptId: string | null;
		issuedAt?: string;
	},
	key: Buffer,
): CaptureAttestation {
	const base: Omit<CaptureAttestation, "mac"> = {
		v: 1,
		sessionId: fields.sessionId,
		containerId: fields.containerId,
		imageId: fields.imageId,
		relay: "2",
		basis: fields.basis,
		attemptId: fields.attemptId,
		issuedAt: fields.issuedAt ?? new Date().toISOString(),
	};
	assertShape({ ...base, mac: "0".repeat(64) });
	return { ...base, mac: macOf(base, key) };
}

function assertShape(r: CaptureAttestation): void {
	const ok =
		r.v === 1 &&
		typeof r.sessionId === "string" &&
		SESSION_ID_RE.test(r.sessionId) &&
		typeof r.containerId === "string" &&
		CONTAINER_ID_RE.test(r.containerId) &&
		typeof r.imageId === "string" &&
		IMAGE_ID_RE.test(r.imageId) &&
		r.relay === "2" &&
		(r.basis === "spawn" || r.basis === "recreate" || r.basis === "history") &&
		(r.attemptId === null ||
			(typeof r.attemptId === "string" && ATTEMPT_ID_RE.test(r.attemptId))) &&
		typeof r.issuedAt === "string" &&
		!Number.isNaN(Date.parse(r.issuedAt)) &&
		typeof r.mac === "string" &&
		MAC_RE.test(r.mac);
	if (!ok) throw new Error("capture attestation: malformed");
}

/** Strict: exactly the known keys, each well-formed. Throws otherwise. */
export function parseAttestation(text: string): CaptureAttestation {
	const raw: unknown = JSON.parse(text);
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		throw new Error("capture attestation: not an object");
	const keys = Object.keys(raw).sort();
	if (keys.join(",") !== [...KEYS].sort().join(","))
		throw new Error("capture attestation: unexpected keys");
	const r = raw as CaptureAttestation;
	assertShape(r);
	return r;
}

export function attestationPath(workspaceRoot: string, sessionId: string): string {
	return path.join(controlDir(workspaceRoot, sessionId), ATTESTATION_FILE);
}

export async function readAttestation(
	workspaceRoot: string,
	sessionId: string,
): Promise<AttestationRead> {
	let text: string;
	try {
		text = await fs.readFile(attestationPath(workspaceRoot, sessionId), "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
		return { kind: "unreadable", error: (err as Error).message };
	}
	try {
		return { kind: "present", record: parseAttestation(text) };
	} catch (err) {
		return { kind: "unreadable", error: (err as Error).message };
	}
}

/**
 * Durable, atomic: temp + fsync + rename + fsync of the dir. root:root 0644
 * (the session can read it through the read-only control mount; it holds no
 * secret, and without the key it cannot be forged).
 */
export async function writeAttestation(
	workspaceRoot: string,
	record: CaptureAttestation,
): Promise<void> {
	assertShape(record);
	const dir = await ensureControlDir(workspaceRoot, record.sessionId);
	const file = path.join(dir, ATTESTATION_FILE);
	const tmp = `${file}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
	const fh = await fs.open(tmp, "wx", 0o644);
	try {
		await fh.writeFile(`${JSON.stringify(record)}\n`);
		await fh.sync();
	} finally {
		await fh.close();
	}
	await fs.chmod(tmp, 0o644);
	await fs.rename(tmp, file);
	const d = await fs.open(dir, "r");
	try {
		await d.sync();
	} finally {
		await d.close();
	}
}

/** The decision rule (pure). `container` is what Docker reports NOW. */
export function classifyAttestation(
	read: AttestationRead,
	container: { sessionId: string; containerId: string | undefined; imageId: string },
	key: Buffer,
): AttestationCheck {
	if (read.kind === "absent") return "absent";
	if (read.kind === "unreadable") return "contradiction";
	const r = read.record;
	const expected = macOf(
		{
			v: r.v,
			sessionId: r.sessionId,
			containerId: r.containerId,
			imageId: r.imageId,
			relay: r.relay,
			basis: r.basis,
			attemptId: r.attemptId,
			issuedAt: r.issuedAt,
		},
		key,
	);
	const a = Buffer.from(expected, "hex");
	const b = Buffer.from(r.mac, "hex");
	if (a.length !== b.length || !timingSafeEqual(a, b)) return "contradiction";
	// Unknown id for the inspected container: nothing to bind to.
	if (!container.containerId) return "absent";
	// A previous container's record (the session was recreated since): not applicable.
	if (r.containerId !== container.containerId) return "absent";
	if (r.sessionId !== container.sessionId || r.imageId !== container.imageId)
		return "contradiction";
	return "valid";
}

// ── Existing containers: evidence from the backend's own recreation record ──

export interface HistoryInput {
	sessionId: string;
	/** sessions.container_id in D1. */
	d1ContainerId: string | null;
	attempt: ReadResult;
	container: { id: string; imageId: string; labels: Record<string, string> } | null;
	image: { exists: boolean; relay2: boolean };
}

export type HistoryVerdict =
	| { ok: true; attemptId: string; imageMissing: boolean }
	| { ok: false; reasons: string[] };

/**
 * May an EXISTING container be attested from history? Only when the
 * backend's recreation record says it created exactly this container
 * (committed, by id) and the container carries, from its creation, the
 * labels the engine set and the relay label its image had. The image
 * itself may be gone; if it still exists it must carry the label.
 */
export function historicalEvidence(input: HistoryInput): HistoryVerdict {
	const reasons: string[] = [];
	const { attempt, container, sessionId } = input;
	if (!container) return { ok: false, reasons: ["container-missing"] };
	if (!input.d1ContainerId || input.d1ContainerId !== container.id)
		reasons.push("container-not-d1-container");
	let record: AttemptRecord | null = null;
	if (attempt.kind === "ok") record = attempt.record;
	else
		reasons.push(attempt.kind === "none" ? "no-recreation-record" : "recreation-record-unreadable");
	if (record) {
		if (record.sessionId !== sessionId) reasons.push("record-other-session");
		if (record.state !== "resolved") reasons.push("record-not-resolved");
		if (record.reverse) reasons.push("record-is-a-rollback");
		if (record.outcome?.kind !== "committed") reasons.push("record-not-committed");
		else if (record.outcome.nContainerId !== container.id)
			reasons.push("record-names-another-container");
		if (container.labels[LABEL_ATTEMPT] !== record.attemptId)
			reasons.push("label-attempt-mismatch");
		if (container.labels[LABEL_RECREATE_OF] !== record.oContainerId)
			reasons.push("label-recreate-of-mismatch");
	}
	if (container.labels[LABEL_SESSION] !== sessionId) reasons.push("label-session-mismatch");
	if (container.labels[RELAY_LABEL] !== RELAY_VALUE) reasons.push("container-without-relay-label");
	if (input.image.exists && !input.image.relay2) reasons.push("image-without-relay");
	if (!IMAGE_ID_RE.test(container.imageId)) reasons.push("image-id-malformed");
	if (reasons.length > 0 || !record) return { ok: false, reasons };
	return { ok: true, attemptId: record.attemptId, imageMissing: !input.image.exists };
}
