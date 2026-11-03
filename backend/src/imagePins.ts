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
 *     is pinned BEFORE the create (a rebuild racing the create can then no
 *     longer take it), and the image the created container actually runs
 *     is pinned right AFTER (covers a tag that moved in between);
 *   - backend boot (reconcile): every container that is a session container
 *     — running, stopped, retained `-old-`/`-new-` ones included — gets its
 *     image pinned. Pins are ordinary tags: they persist across daemon and
 *     host restarts; the boot pass repairs anything a crash left unpinned.
 *
 * Never automatic: removing a pin. A pin whose image no container uses any
 * more ("orphan") is only reported; `npm run images:pins -- prune --write`
 * removes those tags (the image itself goes with its last tag, which is the
 * point — nothing uses it). Pinning is protective only and best-effort: a
 * failure is logged and changes nothing else (the spawn proceeds as before).
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
): Promise<{ orphans: string[]; removed: string[]; kept: string[] }> {
	const pins = await listPins(d, repo);
	const orphans = pins.filter((p) => p.usedBy.length === 0 && !p.mismatched).map((p) => p.ref);
	const removed: string[] = [];
	const kept: string[] = [];
	if (!opts.write) return { orphans, removed, kept };
	for (const ref of orphans) {
		const pin = pins.find((p) => p.ref === ref) as PinEntry;
		const now = await d.listContainers();
		if (now.some((c) => c.ImageID === pin.imageId)) {
			kept.push(ref);
			continue;
		}
		await d.removeTag(ref);
		removed.push(ref);
	}
	return { orphans, removed, kept };
}
