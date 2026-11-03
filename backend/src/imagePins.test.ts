/**
 * imagePins.test.ts — the 2026-11-03 image loss and its protection.
 *
 * The fake reproduces what was measured on VM100's containerd image store:
 * moving a tag off an image that has no other tag removes that image AT ONCE,
 * whether or not containers use it; an image with another tag survives.
 * `docker rmi <tag>` of the last tag of an image a container uses is refused
 * (409), as Docker does.
 */

import { describe, expect, it } from "vitest";
import {
	isSessionContainer,
	listPins,
	type PinContainer,
	type PinDocker,
	pinRef,
	pinSessionImages,
	pinsEnabled,
	protectContainerImage,
	protectImage,
	pruneOrphanPins,
} from "./imagePins.js";
import { status } from "./imagePinsCli.js";

const REPO = "shared-terminal-session-pin";
const id = (c: string) => `sha256:${c.repeat(64)}`;

function notFound(): Error {
	return Object.assign(new Error("404"), { statusCode: 404 });
}

class FakeDocker implements PinDocker {
	images = new Map<string, Set<string>>();
	containers: PinContainer[] = [];
	onList?: (n: number) => void;
	private lists = 0;

	addImage(imageId: string, ...tags: string[]): void {
		this.images.set(imageId, new Set());
		for (const t of tags) this.moveTag(t, imageId);
	}
	/** What `docker build -t <tag>` does to the image the tag left. */
	build(tag: string, newId: string): void {
		this.images.set(newId, new Set());
		this.moveTag(tag, newId);
	}
	private moveTag(ref: string, to: string): void {
		for (const [img, tags] of this.images) {
			if (img !== to && tags.delete(ref) && tags.size === 0) this.images.delete(img);
		}
		this.images.get(to)?.add(ref);
	}
	private resolve(ref: string): string | null {
		if (ref.startsWith("sha256:")) return this.images.has(ref) ? ref : null;
		for (const [img, tags] of this.images) if (tags.has(ref)) return img;
		return null;
	}
	async listContainers(): Promise<PinContainer[]> {
		this.onList?.(this.lists++);
		return this.containers.map((c) => ({ ...c }));
	}
	async inspectImage(ref: string) {
		const img = this.resolve(ref);
		return img ? { Id: img, RepoTags: [...(this.images.get(img) ?? [])] } : null;
	}
	async tagImage(imageId: string, repo: string, tag: string): Promise<void> {
		if (!this.images.has(imageId)) throw notFound();
		this.moveTag(`${repo}:${tag}`, imageId);
	}
	async listImages() {
		return [...this.images].map(([Id, tags]) => ({ Id, RepoTags: [...tags] }));
	}
	async removeTag(ref: string): Promise<void> {
		const img = this.resolve(ref);
		if (!img) throw notFound();
		const tags = this.images.get(img) as Set<string>;
		if (tags.size === 1 && this.containers.some((c) => c.ImageID === img))
			throw Object.assign(new Error("conflict"), { statusCode: 409 });
		tags.delete(ref);
		if (tags.size === 0) this.images.delete(img);
	}
	async inspectContainer(cid: string) {
		const c = this.containers.find((x) => x.Id === cid);
		return c ? { Id: c.Id, Image: c.ImageID as string } : null;
	}
}

const sessionC = (name: string, image: string, state = "running", labels = {}): PinContainer => ({
	Id: `${name}-id`,
	Names: [`/${name}`],
	ImageID: image,
	State: state,
	Labels: labels,
});

/** VM100 before the rebuild: B, HZ running on eb4b; HA's N running and its O retained. */
function vm100(): FakeDocker {
	const d = new FakeDocker();
	d.addImage(id("e"), "shared-terminal-session:latest"); // eb4b427…
	d.addImage(id("4"), "some-old:tag"); // HA O's image keeps one stray tag in this fixture
	d.containers = [
		sessionC("st-0665fa5a-3eb", id("e")), // B
		sessionC("st-a7246fa7-5c1", id("e")), // HZ
		sessionC("st-8fb0a8ae-2d4", id("e")), // HA N
		sessionC("st-8fb0a8ae-2d4-old-1762190000000", id("4"), "exited", {
			"io.shared-terminal.session": "8fb0a8ae-…",
		}), // HA O, retained
		sessionC("st-backend", id("e")), // not a session container
	];
	return d;
}

describe("the incident: a tag rebuild removes the in-use image", () => {
	it("WITHOUT pins: building the session tag again deletes the image B/HA/HZ run on", async () => {
		const d = vm100();
		expect((await status(d)).unpinned).toBe(4); // the preflight gate would have stopped here
		d.build("shared-terminal-session:latest", id("c"));
		expect(await d.inspectImage(id("e"))).toBeNull();
		const s = await status(d);
		expect(s.missing).toBeGreaterThan(0);
	});

	it("WITH the boot pass first: the same rebuild leaves every in-use image in place", async () => {
		const d = vm100();
		const r = await pinSessionImages(d, REPO);
		expect(r.pinned.sort()).toEqual([id("4"), id("e")].sort());
		d.build("shared-terminal-session:latest", id("c"));
		expect(await d.inspectImage(id("e"))).not.toBeNull();
		expect(await d.inspectImage(id("4"))).not.toBeNull();
		const s = await status(d);
		expect(s.missing).toBe(0);
		expect(s.unpinned).toBe(0);
		expect(s.rows.every((r) => r.pinned)).toBe(true);
	});

	it("the retained O's image is protected even when its stray tag is moved too", async () => {
		const d = vm100();
		await pinSessionImages(d, REPO);
		d.build("some-old:tag", id("9"));
		expect(await d.inspectImage(id("4"))).not.toBeNull();
	});
});

describe("pinSessionImages (boot pass)", () => {
	it("covers canonical, retained -old-/-new- and session-labelled containers in any state; ignores others", () => {
		expect(isSessionContainer(sessionC("st-0665fa5a-3eb", id("e")))).toBe(true);
		expect(isSessionContainer(sessionC("st-0665fa5a-3eb-old-17", id("e"), "exited"))).toBe(true);
		expect(isSessionContainer(sessionC("st-0665fa5a-3eb-new-17", id("e"), "created"))).toBe(true);
		expect(
			isSessionContainer(
				sessionC("anything", id("e"), "exited", { "io.shared-terminal.session": "x" }),
			),
		).toBe(true);
		for (const n of ["st-backend", "passb0-runner", "st-0665fa5a-3ebX", "xst-0665fa5a-3eb"])
			expect(isSessionContainer(sessionC(n, id("e")))).toBe(false);
	});

	it("is idempotent: a second pass changes nothing", async () => {
		const d = vm100();
		await pinSessionImages(d, REPO);
		const tags = JSON.stringify(await d.listImages());
		const r = await pinSessionImages(d, REPO);
		expect(r.pinned).toEqual([]);
		expect(r.already.sort()).toEqual([id("4"), id("e")].sort());
		expect(JSON.stringify(await d.listImages())).toBe(tags);
	});

	it("an image already gone is reported with its containers (the state of B/HA/HZ today)", async () => {
		const d = vm100();
		d.build("shared-terminal-session:latest", id("c"));
		const r = await pinSessionImages(d, REPO);
		expect(r.missing).toEqual([
			{ imageId: id("e"), containers: ["st-0665fa5a-3eb", "st-a7246fa7-5c1", "st-8fb0a8ae-2d4"] },
		]);
	});

	it("a container on a non-image id is skipped, and one failing image does not stop the others", async () => {
		const d = vm100();
		d.containers.push(sessionC("st-11111111-222", "not-an-id"));
		const real = d.tagImage.bind(d);
		d.tagImage = async (img, repo, tag) => {
			if (img === id("4")) throw new Error("daemon busy");
			return real(img, repo, tag);
		};
		const r = await pinSessionImages(d, REPO);
		expect(r.pinned).toEqual([id("e")]);
		expect(r.failed).toEqual([{ imageId: id("4"), error: "daemon busy" }]);
	});
});

describe("protectImage / protectContainerImage", () => {
	it("pins by tag or by id, verified by reading the pin back", async () => {
		const d = vm100();
		expect(await protectImage(d, "shared-terminal-session:latest", REPO)).toBe("pinned");
		expect((await d.inspectImage(pinRef(id("e"), REPO)))?.Id).toBe(id("e"));
		expect(await protectImage(d, id("e"), REPO)).toBe("already");
	});

	it("an image removed between the inspect and the tag (racing rebuild) is image-missing, not an error", async () => {
		const d = vm100();
		const realTag = d.tagImage.bind(d);
		d.tagImage = async (img, repo, tag) => {
			d.build("shared-terminal-session:latest", id("c"));
			return realTag(img, repo, tag);
		};
		expect(await protectImage(d, "shared-terminal-session:latest", REPO)).toBe("image-missing");
	});

	it("a pin that does not land on the image is an error (never reported as protected)", async () => {
		const d = vm100();
		d.tagImage = async () => undefined;
		await expect(protectImage(d, id("e"), REPO)).rejects.toThrow(/did not land/);
	});

	it("a pin moved by hand is pointed back WITHOUT removing the image it was moved to", async () => {
		const d = vm100();
		d.addImage(id("7"), `${REPO}:${"e".repeat(64)}`); // pin of e moved onto 7, its only tag
		expect(await protectImage(d, id("e"), REPO)).toBe("pinned");
		expect((await d.inspectImage(pinRef(id("e"), REPO)))?.Id).toBe(id("e"));
		expect(await d.inspectImage(id("7"))).not.toBeNull();
		expect((await d.inspectImage(pinRef(id("7"), REPO)))?.Id).toBe(id("7"));
	});

	it("the image a container actually runs; a gone container is null", async () => {
		const d = vm100();
		expect(await protectContainerImage(d, "st-0665fa5a-3eb-id", REPO)).toBe("pinned");
		expect(await protectContainerImage(d, "nope", REPO)).toBeNull();
	});
});

describe("cleanup is never automatic and never takes an image in use", () => {
	async function withOrphan(): Promise<FakeDocker> {
		const d = vm100();
		await pinSessionImages(d, REPO);
		d.addImage(id("5"));
		await protectImage(d, id("5"), REPO); // pin of an image no container uses
		return d;
	}

	it("dry run lists orphans and removes nothing", async () => {
		const d = await withOrphan();
		const before = JSON.stringify(await d.listImages());
		const r = await pruneOrphanPins(d, { write: false }, REPO);
		expect(r.orphans).toEqual([pinRef(id("5"), REPO)]);
		expect(r.removed).toEqual([]);
		expect(JSON.stringify(await d.listImages())).toBe(before);
	});

	it("--write removes only the orphan; pins of used images (the retained O's too) stay", async () => {
		const d = await withOrphan();
		const r = await pruneOrphanPins(d, { write: true }, REPO);
		expect(r.removed).toEqual([pinRef(id("5"), REPO)]);
		expect(await d.inspectImage(id("5"))).toBeNull();
		expect((await d.inspectImage(pinRef(id("e"), REPO)))?.Id).toBe(id("e"));
		expect((await d.inspectImage(pinRef(id("4"), REPO)))?.Id).toBe(id("4"));
	});

	it("a container that appears between the listing and the removal keeps the pin", async () => {
		const d = await withOrphan();
		d.onList = (n) => {
			// 0 = listPins; 1 = the re-check right before the removal.
			if (n === 1) d.containers.push(sessionC("st-55555555-555", id("5"), "created"));
		};
		const r = await pruneOrphanPins(d, { write: true }, REPO);
		expect(r.removed).toEqual([]);
		expect(r.kept).toEqual([pinRef(id("5"), REPO)]);
		expect(await d.inspectImage(id("5"))).not.toBeNull();
	});

	it("a mismatched pin (tag not naming its image) is never removed", async () => {
		const d = vm100();
		d.addImage(id("6"), `${REPO}:${"0".repeat(64)}`);
		const pins = await listPins(d, REPO);
		expect(pins.find((p) => p.imageId === id("6"))?.mismatched).toBe(true);
		const r = await pruneOrphanPins(d, { write: true }, REPO);
		expect(r.orphans).toEqual([]);
		expect(await d.inspectImage(id("6"))).not.toBeNull();
	});

	it("an orphan pin on the current session image only untags it", async () => {
		const d = vm100();
		d.containers = [];
		await protectImage(d, id("e"), REPO);
		await pruneOrphanPins(d, { write: true }, REPO);
		expect((await d.inspectImage("shared-terminal-session:latest"))?.Id).toBe(id("e"));
	});
});

describe("kill switch", () => {
	it("SESSION_IMAGE_PINS=off disables; anything else (unset included) enables", () => {
		expect(pinsEnabled({ SESSION_IMAGE_PINS: "off" })).toBe(false);
		expect(pinsEnabled({})).toBe(true);
		expect(pinsEnabled({ SESSION_IMAGE_PINS: "on" })).toBe(true);
	});
});
