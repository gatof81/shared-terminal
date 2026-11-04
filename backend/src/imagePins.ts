/**
 * imagePins.ts — keep the image of every session container in Docker.
 *
 * Incident 2026-11-03: on Docker's containerd image store (Docker 29,
 * `driver-type: io.containerd.snapshotter.v1`), re-building a tag removes the
 * image it pointed to IMMEDIATELY, even while containers are running on it —
 * no `rmi`, no `prune` (reproduced twice on VM100). A `docker build -t
 * shared-terminal-session` therefore deleted the image of every capturing
 * session, of session A and of Home Automation's retained O. What the same
 * experiment showed keeps an image: another tag pointing at it.
 *
 * So every image a session container uses gets its own tag,
 * `<PIN_REPO>:<64-hex image id>` ("pin"). The name is derived from the image
 * id, so a pin can only ever mean "this exact image", and pinning is
 * idempotent: the same image always gets the same tag.
 *
 * When:
 *   - spawn / recreation: the image a container is about to be created from
 *     is resolved to its immutable id, pinned and read back BEFORE the create
 *     — or the create does not happen (ensurePinned / ImagePinError); the
 *     create uses that id, never the tag; AFTER it, the container is checked
 *     to run exactly that id with its pin intact (verifyCreated), else it is
 *     removed before it is recorded or started;
 *   - backend boot (reconcile): every container that is a session container
 *     — running, stopped, retained `-old-`/`-new-` ones included — gets its
 *     image pinned. Pins are ordinary tags: they persist across daemon and
 *     host restarts; the boot pass repairs anything a crash left unpinned.
 *
 * Never automatic: removing a pin. A pin whose image no container uses any
 * more ("orphan") is only reported (`npm run images:pins -- prune`, dry run).
 * Removal (`--write`) is DISABLED in the CLI: a spawn pins before it creates,
 * so a fresh pin has no container yet, and a separate process cannot prove
 * the backend is not creating (owner review of #521: postpone cleanup rather
 * than open a path to image loss). Best-effort ONLY where nothing is being created:
 * the boot pass and an adopted (already existing) container.
 *
 * Not covered: `docker image rm -f` / `docker rmi` of a pin by hand, or
 * `docker image prune -a` of an image NO container uses (a retained
 * container, stopped, still uses its image). An image that is already gone
 * (B, HA, HZ after the incident) cannot be brought back by a pin — it is
 * reported as `missing`.
 *
 * `SESSION_IMAGE_PINS=off` disables every write here (kill switch).
 */

import type Dockerode from "dockerode";
import { RESERVED_NAME_RE } from "./recreate/ports.js";

export const PIN_REPO = process.env.SESSION_IMAGE_PIN_REPO ?? "shared-terminal-session-pin";
export const LABEL_SESSION = "io.shared-terminal.session";

export function pinsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.SESSION_IMAGE_PINS !== "off";
}

const IMAGE_ID_RE = /^sha256:([0-9a-f]{64})$/;
// `st-<sid[:12]>` — the session id is a UUID, so its first 12 chars keep the dash.
const CANONICAL_NAME_RE = /^st-[0-9a-f]{8}-[0-9a-f]{3}$/;

export interface PinContainer {
	Id: string;
	Names?: string[];
	ImageID?: string;
	State?: string;
	Labels?: Record<string, string>;
}

/** The narrow Docker surface this module needs (tests fake it). */
export interface PinDocker {
	listContainers(): Promise<PinContainer[]>;
	/** null when Docker answers 404. */
	inspectImage(ref: string): Promise<{ Id: string; RepoTags: string[] } | null>;
	tagImage(imageId: string, repo: string, tag: string): Promise<void>;
	listImages(): Promise<Array<{ Id: string; RepoTags: string[] }>>;
	removeTag(ref: string): Promise<void>;
	inspectContainer(id: string): Promise<{ Id: string; Image: string } | null>;
}

function isNotFound(err: unknown): boolean {
	return (err as { statusCode?: number })?.statusCode === 404;
}

export function pinDockerOf(docker: Dockerode): PinDocker {
	return {
		listContainers: async () => (await docker.listContainers({ all: true })) as PinContainer[],
		inspectImage: async (ref) => {
			try {
				const i = await docker.getImage(ref).inspect();
				return { Id: i.Id, RepoTags: i.RepoTags ?? [] };
			} catch (err) {
				if (isNotFound(err)) return null;
				throw err;
			}
		},
		tagImage: async (imageId, repo, tag) => {
			await docker.getImage(imageId).tag({ repo, tag });
		},
		listImages: async () =>
			(await docker.listImages()).map((i) => ({ Id: i.Id, RepoTags: i.RepoTags ?? [] })),
		// A tag reference: Docker untags; the image goes only with its last
		// reference and only when no container uses it.
		removeTag: async (ref) => {
			await docker.getImage(ref).remove({ noprune: true });
		},
		inspectContainer: async (id) => {
			try {
				const c = await docker.getContainer(id).inspect();
				return { Id: c.Id, Image: c.Image };
			} catch (err) {
				if (isNotFound(err)) return null;
				throw err;
			}
		},
	};
}

export function pinTag(imageId: string): string {
	const m = IMAGE_ID_RE.exec(imageId);
	if (!m) throw new Error(`not an image id: ${imageId}`);
	return m[1] as string;
}

export function pinRef(imageId: string, repo = PIN_REPO): string {
	return `${repo}:${pinTag(imageId)}`;
}

export function isSessionContainer(c: PinContainer): boolean {
	if (c.Labels?.[LABEL_SESSION]) return true;
	return (c.Names ?? []).some((n) => {
		const name = n.replace(/^\//, "");
		return CANONICAL_NAME_RE.test(name) || RESERVED_NAME_RE.test(name);
	});
}

export type PinOutcome = "pinned" | "already" | "image-missing";

/**
 * Pin the image `ref` resolves to NOW (a tag or an id). Verified: the pin is
 * read back and must name that exact image.
 */
export async function protectImage(
	d: PinDocker,
	ref: string,
	repo = PIN_REPO,
): Promise<PinOutcome> {
	const image = await d.inspectImage(ref);
	if (!image) return "image-missing";
	const target = pinRef(image.Id, repo);
	const current = await d.inspectImage(target);
	if (current?.Id === image.Id) return "already";
	// Moved by hand to another image: moving it back untags that image, and
	// on this store an image losing a tag can go at once, in use or not (the
	// incident's mechanism). Give that image its own pin first.
	if (current && current.Id !== image.Id && IMAGE_ID_RE.test(current.Id)) {
		const own = await d.inspectImage(pinRef(current.Id, repo));
		if (own?.Id !== current.Id) await d.tagImage(current.Id, repo, pinTag(current.Id));
	}
	try {
		await d.tagImage(image.Id, repo, pinTag(image.Id));
	} catch (err) {
		// Removed between the inspect and the tag (a racing rebuild).
		if (isNotFound(err)) return "image-missing";
		throw err;
	}
	const after = await d.inspectImage(target);
	if (after?.Id !== image.Id) throw new Error(`pin ${target} did not land on ${image.Id}`);
	return "pinned";
}

/** Pin the image a container actually runs. null when the container is gone. */
export async function protectContainerImage(
	d: PinDocker,
	containerId: string,
	repo = PIN_REPO,
): Promise<PinOutcome | null> {
	const c = await d.inspectContainer(containerId);
	if (!c) return null;
	return protectImage(d, c.Image, repo);
}

export interface SweepResult {
	pinned: string[];
	already: string[];
	/** The image is already gone: nothing can pin it (the incident's state). */
	missing: Array<{ imageId: string; containers: string[] }>;
	failed: Array<{ imageId: string; error: string }>;
}

function nameOf(c: PinContainer): string {
	return (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, "");
}

/** The boot pass: pin the image of every session container, in any state. */
export async function pinSessionImages(d: PinDocker, repo = PIN_REPO): Promise<SweepResult> {
	const byImage = new Map<string, string[]>();
	for (const c of await d.listContainers()) {
		if (!isSessionContainer(c) || !c.ImageID || !IMAGE_ID_RE.test(c.ImageID)) continue;
		const list = byImage.get(c.ImageID) ?? [];
		list.push(nameOf(c));
		byImage.set(c.ImageID, list);
	}
	const out: SweepResult = { pinned: [], already: [], missing: [], failed: [] };
	for (const [imageId, containers] of [...byImage].sort(([a], [b]) => a.localeCompare(b))) {
		try {
			const r = await protectImage(d, imageId, repo);
			if (r === "image-missing") out.missing.push({ imageId, containers });
			else out[r].push(imageId);
		} catch (err) {
			out.failed.push({ imageId, error: (err as Error).message });
		}
	}
	return out;
}

export interface PinEntry {
	ref: string;
	imageId: string;
	/** Every container (any kind, any state) on that image. */
	usedBy: string[];
	/** The tag does not name its own image (moved by hand): never removed. */
	mismatched: boolean;
}

export async function listPins(d: PinDocker, repo = PIN_REPO): Promise<PinEntry[]> {
	const containers = await d.listContainers();
	const out: PinEntry[] = [];
	for (const img of await d.listImages()) {
		for (const tag of img.RepoTags) {
			if (!tag.startsWith(`${repo}:`)) continue;
			out.push({
				ref: tag,
				imageId: img.Id,
				usedBy: containers.filter((c) => c.ImageID === img.Id).map(nameOf),
				mismatched: tag !== `${repo}:${IMAGE_ID_RE.exec(img.Id)?.[1] ?? ""}`,
			});
		}
	}
	return out.sort((a, b) => a.ref.localeCompare(b.ref));
}

/**
 * Orphan pins: no container at all uses their image. Dry run unless `write`;
 * with `write`, the containers are listed AGAIN right before each removal
 * and a pin whose image gained a container meanwhile is kept. A mismatched
 * pin is never removed (someone moved it by hand — look first).
 */
export async function pruneOrphanPins(
	d: PinDocker,
	opts: { write: boolean },
	repo = PIN_REPO,
): Promise<{ orphans: string[]; removed: string[]; kept: Array<{ ref: string; why: string }> }> {
	const pins = await listPins(d, repo);
	const orphans = pins.filter((p) => p.usedBy.length === 0 && !p.mismatched).map((p) => p.ref);
	const removed: string[] = [];
	const kept: Array<{ ref: string; why: string }> = [];
	if (!opts.write) return { orphans, removed, kept };
	for (const ref of orphans) {
		const pin = pins.find((p) => p.ref === ref) as PinEntry;
		// Immediately before each untag, everything the decision rested on is
		// read again (owner review of #521): the tag still names the SAME
		// image it named in the listing, and no container (any state) uses
		// that image. Either changed ⇒ the pin is kept.
		const target = await d.inspectImage(ref);
		if (target?.Id !== pin.imageId) {
			kept.push({ ref, why: target ? "tag now names another image" : "tag gone" });
			continue;
		}
		const now = await d.listContainers();
		if (now.some((c) => c.ImageID === pin.imageId)) {
			kept.push({ ref, why: "a container uses the image again" });
			continue;
		}
		await d.removeTag(ref);
		removed.push(ref);
	}
	return { orphans, removed, kept };
}

// ── Strict protection for creates (owner condition P1/P2, 2026-11-04) ─────

/** A create that cannot be protected must not happen. */
export class ImagePinError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ImagePinError";
	}
}

/**
 * Resolve `ref` (a tag or an id) to the immutable image id a create will use
 * and pin THAT id, verified — or throw. The resolve and the pin are not one
 * atomic step: if a rebuild removes the resolved image in between, the pin
 * fails (404) and so does this call; it never falls back to another id or to
 * the moved tag. The caller then creates from the returned id, never from a
 * tag, so the created container's image is exactly the pinned one.
 */
export async function ensurePinned(d: PinDocker, ref: string, repo = PIN_REPO): Promise<string> {
	const image = await d.inspectImage(ref).catch((err: unknown) => {
		throw new ImagePinError(`cannot resolve ${ref}: ${(err as Error).message}`);
	});
	if (!image || !IMAGE_ID_RE.test(image.Id)) throw new ImagePinError(`image ${ref} not found`);
	let outcome: PinOutcome;
	try {
		outcome = await protectImage(d, image.Id, repo);
	} catch (err) {
		throw new ImagePinError(`pin of ${image.Id} failed: ${(err as Error).message}`);
	}
	if (outcome === "image-missing")
		throw new ImagePinError(
			`image ${image.Id} (from ${ref}) disappeared before it could be pinned`,
		);
	return image.Id;
}

/** After a create from `imageId`: the container runs exactly it, and (pins on) its pin still names it. */
export async function verifyCreated(
	d: PinDocker,
	containerId: string,
	imageId: string,
	opts: { pins: boolean; repo?: string },
): Promise<void> {
	const c = await d.inspectContainer(containerId);
	if (!c) throw new ImagePinError(`created container ${containerId.slice(0, 12)} not found`);
	if (c.Image !== imageId)
		throw new ImagePinError(
			`container ${containerId.slice(0, 12)} runs ${c.Image}, not the pinned ${imageId}`,
		);
	if (!opts.pins) return;
	const pin = await d.inspectImage(pinRef(imageId, opts.repo ?? PIN_REPO));
	if (pin?.Id !== imageId) throw new ImagePinError(`pin of ${imageId} is gone or moved`);
}

// ── Historical exceptions (owner condition P3) ──────────────────────────────

/**
 * An image that was already lost when this protection arrived (incident
 * 2026-11-03) cannot be pinned. Each such case is listed by the operator as
 * an EXACT (containerId, imageId) pair; nothing else can make a missing image
 * pass. The file lives outside every session's mounts and must be root-owned
 * and not group/world-writable; anything unexpected about it is an error
 * (fail closed: the gate is NO-GO, never "no exceptions").
 */
export interface PinException {
	containerId: string;
	imageId: string;
	name: string;
	reason: string;
	incident: string;
	approvedBy: string;
	approvedAt: string;
}
const EXC_KEYS = [
	"approvedAt",
	"approvedBy",
	"containerId",
	"imageId",
	"incident",
	"name",
	"reason",
];
const CONTAINER_ID_RE = /^[0-9a-f]{64}$/;

export function defaultExceptionsPath(workspaceRoot: string): string {
	return `${workspaceRoot.replace(/\/+$/, "")}/.st-image-pins/exceptions.json`;
}

export function parseExceptions(text: string): PinException[] {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error("exceptions file: not JSON");
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		throw new Error("exceptions file: not an object");
	const top = raw as Record<string, unknown>;
	if (Object.keys(top).sort().join(",") !== "exceptions,version" || top.version !== 1)
		throw new Error('exceptions file: expected exactly {"version": 1, "exceptions": [...]}');
	if (!Array.isArray(top.exceptions)) throw new Error("exceptions file: exceptions is not a list");
	const seen = new Set<string>();
	return top.exceptions.map((e, i) => {
		if (typeof e !== "object" || e === null || Array.isArray(e))
			throw new Error(`exception #${i}: not an object`);
		const o = e as Record<string, unknown>;
		if (Object.keys(o).sort().join(",") !== EXC_KEYS.join(","))
			throw new Error(`exception #${i}: expected exactly the keys ${EXC_KEYS.join(", ")}`);
		for (const k of EXC_KEYS)
			if (typeof o[k] !== "string" || (o[k] as string).trim() === "")
				throw new Error(`exception #${i}: ${k} must be a non-empty string`);
		if (!CONTAINER_ID_RE.test(o.containerId as string))
			throw new Error(`exception #${i}: containerId must be the full 64-hex id`);
		if (!IMAGE_ID_RE.test(o.imageId as string))
			throw new Error(`exception #${i}: imageId must be the full sha256:<64 hex> id`);
		if (Number.isNaN(Date.parse(o.approvedAt as string)))
			throw new Error(`exception #${i}: approvedAt is not a date`);
		const key = `${o.containerId}/${o.imageId}`;
		if (seen.has(key)) throw new Error(`exception #${i}: duplicate pair`);
		seen.add(key);
		return o as unknown as PinException;
	});
}

export interface ExceptionsSource {
	/** null = no file (no exceptions); throws on anything else unexpected. */
	read(): Promise<{ text: string; uid: number; mode: number } | null>;
	expectUid?: number;
}

export async function loadExceptions(src: ExceptionsSource): Promise<PinException[]> {
	const f = await src.read();
	if (!f) return [];
	if (f.uid !== (src.expectUid ?? 0)) throw new Error("exceptions file: not owned by root");
	if ((f.mode & 0o022) !== 0) throw new Error("exceptions file: group/world-writable");
	return parseExceptions(f.text);
}

export function fileExceptionsSource(path: string): ExceptionsSource {
	return {
		read: async () => {
			const fs = await import("node:fs/promises");
			let st: import("node:fs").Stats;
			try {
				st = await fs.lstat(path);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw err;
			}
			if (!st.isFile()) throw new Error("exceptions file: not a regular file");
			const dir = await fs.lstat(path.slice(0, path.lastIndexOf("/")));
			if (!dir.isDirectory() || dir.uid !== 0 || (dir.mode & 0o022) !== 0)
				throw new Error("exceptions dir: must be a root-owned directory not group/world-writable");
			return { text: await fs.readFile(path, "utf8"), uid: st.uid, mode: st.mode };
		},
	};
}

// ── The gate ────────────────────────────────────────────────────────────────

export type RowState = "pinned" | "unpinned" | "excepted" | "missing";
export interface GateRow {
	container: string;
	containerId: string;
	state: string;
	imageId: string;
	result: RowState;
	exception?: { incident: string; reason: string; approvedBy: string; approvedAt: string };
}
export interface GateReport {
	gate: "GO" | "NO-GO";
	reasons: string[];
	protection: "enabled" | "disabled";
	rows: GateRow[];
	/** Listed pairs that matched nothing (container gone, image back): shown, never removed. */
	staleExceptions: Array<{ containerId: string; imageId: string; why: string }>;
}

/**
 * GO only when protection is on, the exceptions file is valid, and every
 * session container's image is pinned or excepted by its exact pair. A
 * missing image without its exact pair (a NEW loss, or a new container on an
 * old lost image) is NO-GO. Nothing is ever removed.
 */
export async function evaluate(
	d: PinDocker,
	opts: { pins: boolean; exceptions: () => Promise<PinException[]>; repo?: string },
): Promise<GateReport> {
	const reasons: string[] = [];
	if (!opts.pins)
		reasons.push("protection disabled (SESSION_IMAGE_PINS=off): images in use are NOT protected");
	let exceptions: PinException[] = [];
	try {
		exceptions = await opts.exceptions();
	} catch (err) {
		reasons.push(`exceptions unusable: ${(err as Error).message}`);
	}
	const byPair = new Map(exceptions.map((e) => [`${e.containerId}/${e.imageId}`, e]));
	const used = new Set<string>();
	const rows: GateRow[] = [];
	const containers = await d.listContainers();
	for (const c of containers) {
		if (!isSessionContainer(c)) continue;
		if (!c.ImageID || !IMAGE_ID_RE.test(c.ImageID)) {
			// Fail closed: a session container whose image cannot even be named
			// is not "fine" (review of #521).
			reasons.push(`${nameOf(c)}: image id unknown (${JSON.stringify(c.ImageID ?? null)})`);
			continue;
		}
		const image = await d.inspectImage(c.ImageID);
		const name = nameOf(c);
		const base = { container: name, containerId: c.Id, state: c.State ?? "?", imageId: c.ImageID };
		if (image) {
			const pin = await d.inspectImage(pinRef(c.ImageID, opts.repo ?? PIN_REPO));
			const pinned = pin?.Id === c.ImageID;
			rows.push({ ...base, result: pinned ? "pinned" : "unpinned" });
			if (!pinned)
				reasons.push(`${name}: image ${c.ImageID.slice(7, 19)} exists but is NOT pinned`);
			continue;
		}
		const e = byPair.get(`${c.Id}/${c.ImageID}`);
		if (e) {
			used.add(`${c.Id}/${c.ImageID}`);
			rows.push({
				...base,
				result: "excepted",
				exception: {
					incident: e.incident,
					reason: e.reason,
					approvedBy: e.approvedBy,
					approvedAt: e.approvedAt,
				},
			});
		} else {
			rows.push({ ...base, result: "missing" });
			reasons.push(
				`${name}: image ${c.ImageID.slice(7, 19)} is MISSING and no exception names this exact container`,
			);
		}
	}
	const staleExceptions: GateReport["staleExceptions"] = [];
	for (const e of exceptions) {
		if (used.has(`${e.containerId}/${e.imageId}`)) continue;
		const c = containers.find((x) => x.Id === e.containerId);
		staleExceptions.push({
			containerId: e.containerId,
			imageId: e.imageId,
			why: !c
				? "container no longer exists"
				: c.ImageID !== e.imageId
					? "container runs another image"
					: "image exists again",
		});
	}
	rows.sort((a, b) => a.container.localeCompare(b.container));
	return {
		gate: reasons.length === 0 ? "GO" : "NO-GO",
		reasons,
		protection: opts.pins ? "enabled" : "disabled",
		rows,
		staleExceptions,
	};
}
