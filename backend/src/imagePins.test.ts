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
	ensurePinned,
	evaluate,
	ImagePinError,
	isSessionContainer,
	listPins,
	loadExceptions,
	type PinContainer,
	type PinDocker,
	type PinException,
	parseExceptions,
	pinRef,
	pinSessionImages,
	pinsEnabled,
	protectContainerImage,
	protectImage,
	pruneOrphanPins,
	verifyCreated,
} from "./imagePins.js";
import { runImagePinsCli } from "./imagePinsCli.js";

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

const gate = (d: PinDocker, exceptions: PinException[] = [], pins = true) =>
	evaluate(d, { pins, exceptions: async () => exceptions, repo: REPO });

describe("the incident: a tag rebuild removes the in-use image", () => {
	it("WITHOUT pins: building the session tag again deletes the image B/HA/HZ run on", async () => {
		const d = vm100();
		const g0 = await gate(d);
		expect(g0.gate).toBe("NO-GO"); // the preflight gate would have stopped here
		expect(g0.rows.filter((r) => r.result === "unpinned")).toHaveLength(4);
		d.build("shared-terminal-session:latest", id("c"));
		expect(await d.inspectImage(id("e"))).toBeNull();
		expect((await gate(d)).rows.filter((r) => r.result === "missing").length).toBeGreaterThan(0);
	});

	it("WITH the boot pass first: the same rebuild leaves every in-use image in place", async () => {
		const d = vm100();
		const r = await pinSessionImages(d, REPO);
		expect(r.pinned.sort()).toEqual([id("4"), id("e")].sort());
		d.build("shared-terminal-session:latest", id("c"));
		expect(await d.inspectImage(id("e"))).not.toBeNull();
		expect(await d.inspectImage(id("4"))).not.toBeNull();
		const g = await gate(d);
		expect(g.gate).toBe("GO");
		expect(g.rows.every((r) => r.result === "pinned")).toBe(true);
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
		expect(r.kept).toEqual([
			{ ref: pinRef(id("5"), REPO), why: "a container uses the image again" },
		]);
		expect(await d.inspectImage(id("5"))).not.toBeNull();
	});

	it("the tag is moved to another image between the listing and the removal ⇒ kept, neither image lost", async () => {
		const d = await withOrphan();
		d.addImage(id("8"), "other:tag");
		const realInspect = d.inspectImage.bind(d);
		let moved = false;
		d.inspectImage = async (ref) => {
			if (!moved && ref === pinRef(id("5"), REPO)) {
				moved = true;
				await d.tagImage(id("8"), REPO, "5".repeat(64)); // someone re-points the pin name
			}
			return realInspect(ref);
		};
		const removeSpy: string[] = [];
		const realRemove = d.removeTag.bind(d);
		d.removeTag = async (ref) => {
			removeSpy.push(ref);
			return realRemove(ref);
		};
		const r = await pruneOrphanPins(d, { write: true }, REPO);
		expect(removeSpy).toEqual([]);
		expect(r.kept).toEqual([{ ref: pinRef(id("5"), REPO), why: "tag now names another image" }]);
		expect(await d.inspectImage(id("8"))).not.toBeNull();
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

// ── Owner conditions P1–P3 (2026-11-04) ───────────────────────────────────

const ex = (
	containerId: string,
	imageId: string,
	extra: Partial<PinException> = {},
): PinException => ({
	containerId,
	imageId,
	name: "st-x",
	reason: "image deleted by the 2026-11-03 tag rebuild before pins existed",
	incident: "2026-11-03 containerd rebuild",
	approvedBy: "owner",
	approvedAt: "2026-11-04T20:00:00Z",
	...extra,
});
const fullId = (c: string) => c.repeat(64).slice(0, 64);

describe("P1/P2 — strict pin before a create", () => {
	it("resolves the tag to an id and pins THAT id (verified)", async () => {
		const d = vm100();
		const img = await ensurePinned(d, "shared-terminal-session:latest", REPO);
		expect(img).toBe(id("e"));
		expect((await d.inspectImage(pinRef(id("e"), REPO)))?.Id).toBe(id("e"));
	});
	it("a rebuild deletes the resolved image between resolve and pin ⇒ throws; never another id, never the moved tag", async () => {
		const d = vm100();
		d.containers = []; // nothing keeps e alive
		const realTag = d.tagImage.bind(d);
		d.tagImage = async (img, repo, tag) => {
			d.build("shared-terminal-session:latest", id("c")); // e loses its only tag ⇒ gone
			return realTag(img, repo, tag);
		};
		await expect(ensurePinned(d, "shared-terminal-session:latest", REPO)).rejects.toBeInstanceOf(
			ImagePinError,
		);
		expect(await d.inspectImage(pinRef(id("c"), REPO))).toBeNull(); // the new image was not pinned instead
	});
	it("the tag moves between resolve and pin but the old image survives (other tag) ⇒ the OLD id is pinned and returned", async () => {
		const d = vm100();
		d.images.get(id("e"))?.add("keep:me");
		const realInspect = d.inspectImage.bind(d);
		let first = true;
		d.inspectImage = async (ref) => {
			const r = await realInspect(ref);
			if (first && ref === "shared-terminal-session:latest") {
				first = false;
				d.build("shared-terminal-session:latest", id("c"));
			}
			return r;
		};
		expect(await ensurePinned(d, "shared-terminal-session:latest", REPO)).toBe(id("e"));
		expect((await d.inspectImage(pinRef(id("e"), REPO)))?.Id).toBe(id("e"));
	});
	it("a daemon error on the tag is an ImagePinError (never best-effort)", async () => {
		const d = vm100();
		d.tagImage = async () => {
			throw Object.assign(new Error("daemon busy"), { statusCode: 500 });
		};
		await expect(ensurePinned(d, id("e"), REPO)).rejects.toThrow(/pin of .* failed: daemon busy/);
	});
	it("a pin that does not land is an ImagePinError", async () => {
		const d = vm100();
		d.tagImage = async () => undefined;
		await expect(ensurePinned(d, id("e"), REPO)).rejects.toBeInstanceOf(ImagePinError);
	});
	it("an unknown ref is an ImagePinError", async () => {
		await expect(ensurePinned(vm100(), "nope:latest", REPO)).rejects.toThrow(/not found/);
	});
	it("verifyCreated: the container must run exactly the pinned id, and the pin must still name it", async () => {
		const d = vm100();
		await ensurePinned(d, id("e"), REPO);
		await expect(
			verifyCreated(d, "st-0665fa5a-3eb-id", id("e"), { pins: true, repo: REPO }),
		).resolves.toBeUndefined();
		await expect(
			verifyCreated(d, "st-0665fa5a-3eb-id", id("4"), { pins: true, repo: REPO }),
		).rejects.toThrow(/not the pinned/);
		await d.removeTag(pinRef(id("e"), REPO)).catch(() => undefined);
		d.images.get(id("e"))?.delete(pinRef(id("e"), REPO));
		await expect(
			verifyCreated(d, "st-0665fa5a-3eb-id", id("e"), { pins: true, repo: REPO }),
		).rejects.toThrow(/gone or moved/);
		await expect(verifyCreated(d, "missing", id("e"), { pins: true, repo: REPO })).rejects.toThrow(
			/not found/,
		);
	});
	it("a crash after the pin and before the create leaves only an orphan pin: harmless, gate GO, reported, prunable on request", async () => {
		const d = vm100();
		d.containers = [];
		d.addImage(id("5"), "shared-terminal-session:latest");
		await ensurePinned(d, "shared-terminal-session:latest", REPO); // …process dies here
		expect((await gate(d)).gate).toBe("GO");
		const pr = await pruneOrphanPins(d, { write: false }, REPO);
		expect(pr.orphans).toContain(pinRef(id("5"), REPO));
		expect(pr.removed).toEqual([]);
		// Recovery is idempotent: the next spawn pins the same id again.
		expect(await ensurePinned(d, "shared-terminal-session:latest", REPO)).toBe(id("5"));
	});
	it("a rebuild racing a create after the pin cannot take the image the container gets", async () => {
		const d = vm100();
		d.containers = [];
		d.addImage(id("5"), "shared-terminal-session:latest");
		const img = await ensurePinned(d, "shared-terminal-session:latest", REPO);
		d.build("shared-terminal-session:latest", id("6")); // between pin and create
		expect(await d.inspectImage(img)).not.toBeNull();
		d.containers.push(sessionC("st-55555555-555", img, "created"));
		const g = await gate(d);
		expect(g.rows.find((r) => r.container === "st-55555555-555")).toMatchObject({
			result: "pinned",
		});
	});
});

describe("fail closed on a session container whose image cannot be named (review of #521)", () => {
	it.each([[undefined], [""], ["not-an-id"]])("ImageID %j ⇒ NO-GO with a reason", async (bad) => {
		const d = vm100();
		await pinSessionImages(d, REPO);
		d.containers.push({
			...sessionC("st-99999999-999", id("e")),
			ImageID: bad as string | undefined,
		});
		const g = await gate(d);
		expect(g.gate).toBe("NO-GO");
		expect(g.reasons.join()).toMatch(/st-99999999-999: image id unknown/);
	});
});

describe("P1 — protection disabled", () => {
	it("SESSION_IMAGE_PINS=off ⇒ the gate is NO-GO, whatever else is true", async () => {
		const d = vm100();
		await pinSessionImages(d, REPO);
		const g = await gate(d, [], false);
		expect(g).toMatchObject({ gate: "NO-GO", protection: "disabled" });
		expect(g.reasons[0]).toMatch(/protection disabled/);
	});
});

describe("P3 — historical exceptions: exact pairs, strict, fail-closed", () => {
	/** After the incident: e and 4 are gone; B, HZ, HA-N run e, HA-O runs 4. */
	function afterIncident() {
		const d = vm100();
		d.containers = d.containers.map((c) => ({ ...c, Id: fullId(c.Id.slice(3, 4) || "a") }));
		d.containers.forEach((c, i) => {
			c.Id = fullId("abcd"[i] ?? "f");
		});
		d.images.delete(id("e"));
		d.images.delete(id("4"));
		return d;
	}
	const sessionOnes = (d: FakeDocker) => d.containers.filter((c) => isSessionContainer(c));

	it("the incident's pairs excepted + a NEW container on the current, pinned image ⇒ GO, each exception used is listed", async () => {
		const d = afterIncident();
		const exs = sessionOnes(d).map((c) => ex(c.Id, c.ImageID as string));
		d.addImage(id("c"), "shared-terminal-session:latest");
		d.containers.push({ ...sessionC("st-77777777-777", id("c")), Id: fullId("7") });
		await pinSessionImages(d, REPO);
		const g = await gate(d, exs);
		expect(g.gate).toBe("GO");
		expect(g.rows.filter((r) => r.result === "excepted")).toHaveLength(4);
		for (const r of g.rows.filter((x) => x.result === "excepted"))
			expect(r.exception).toMatchObject({
				incident: "2026-11-03 containerd rebuild",
				approvedBy: "owner",
			});
		expect(g.rows.find((r) => r.container === "st-77777777-777")).toMatchObject({
			result: "pinned",
		});
		expect(g.staleExceptions).toEqual([]);
	});
	it("a NEW missing image (not listed) ⇒ NO-GO naming it", async () => {
		const d = afterIncident();
		const exs = sessionOnes(d).map((c) => ex(c.Id, c.ImageID as string));
		d.containers.push({ ...sessionC("st-77777777-777", id("9")), Id: fullId("7") }); // id 9 does not exist
		const g = await gate(d, exs);
		expect(g.gate).toBe("NO-GO");
		expect(g.reasons.join("\n")).toMatch(/st-77777777-777: image .* is MISSING and no exception/);
	});
	it("a new container on an ALREADY excepted lost image ⇒ NO-GO (the pair is exact)", async () => {
		const d = afterIncident();
		const exs = sessionOnes(d).map((c) => ex(c.Id, c.ImageID as string));
		d.containers.push({ ...sessionC("st-88888888-888", id("e")), Id: fullId("8") });
		expect((await gate(d, exs)).gate).toBe("NO-GO");
	});
	it("an incomplete list (one pair missing) ⇒ NO-GO", async () => {
		const d = afterIncident();
		const exs = sessionOnes(d)
			.map((c) => ex(c.Id, c.ImageID as string))
			.slice(1);
		expect((await gate(d, exs)).gate).toBe("NO-GO");
	});
	it("an exception that matches nothing is reported (never removed)", async () => {
		const d = afterIncident();
		const exs = [
			...sessionOnes(d).map((c) => ex(c.Id, c.ImageID as string)),
			ex(fullId("9"), id("e")),
		];
		const g = await gate(d, exs);
		expect(g.gate).toBe("GO");
		expect(g.staleExceptions).toEqual([
			{ containerId: fullId("9"), imageId: id("e"), why: "container no longer exists" },
		]);
	});
	it("an unusable exceptions file ⇒ NO-GO (never 'no exceptions')", async () => {
		const d = afterIncident();
		const g = await evaluate(d, {
			pins: true,
			repo: REPO,
			exceptions: async () => {
				throw new Error("exceptions file: not JSON");
			},
		});
		expect(g.gate).toBe("NO-GO");
		expect(g.reasons.join()).toMatch(/exceptions unusable: exceptions file: not JSON/);
	});
	it("the backend restarts with historical images absent and new ones protected: the boot pass pins only what exists, the gate stays GO", async () => {
		const d = afterIncident();
		const exs = sessionOnes(d).map((c) => ex(c.Id, c.ImageID as string));
		d.addImage(id("c"), "shared-terminal-session:latest");
		d.containers.push({ ...sessionC("st-77777777-777", id("c")), Id: fullId("7") });
		const r1 = await pinSessionImages(d, REPO);
		expect(r1.pinned).toEqual([id("c")]);
		expect(r1.missing.map((m) => m.imageId).sort()).toEqual([id("4"), id("e")].sort());
		const r2 = await pinSessionImages(d, REPO); // "restart"
		expect(r2.pinned).toEqual([]);
		expect(r2.already).toEqual([id("c")]);
		expect((await gate(d, exs)).gate).toBe("GO");
	});
});

describe("P3 — the exceptions file", () => {
	const good = {
		version: 1,
		exceptions: [ex(fullId("a"), id("e"))],
	};
	it("parses the exact shape", () => {
		expect(parseExceptions(JSON.stringify(good))).toHaveLength(1);
		expect(parseExceptions(JSON.stringify({ version: 1, exceptions: [] }))).toEqual([]);
	});
	it.each([
		["not JSON", "{", /not JSON/],
		["array", "[]", /not an object/],
		["wrong version", JSON.stringify({ ...good, version: 2 }), /expected exactly/],
		["extra top key", JSON.stringify({ ...good, x: 1 }), /expected exactly/],
		[
			"extra entry key",
			JSON.stringify({ version: 1, exceptions: [{ ...good.exceptions[0], note: "x" }] }),
			/expected exactly the keys/,
		],
		[
			"missing entry key",
			JSON.stringify({ version: 1, exceptions: [{ ...good.exceptions[0], reason: undefined }] }),
			/expected exactly the keys/,
		],
		[
			"short container id",
			JSON.stringify({ version: 1, exceptions: [ex("abc", id("e"))] }),
			/full 64-hex/,
		],
		[
			"wildcard container id",
			JSON.stringify({ version: 1, exceptions: [ex("*", id("e"))] }),
			/full 64-hex/,
		],
		[
			"short image id",
			JSON.stringify({ version: 1, exceptions: [ex(fullId("a"), "sha256:eb4b")] }),
			/full sha256/,
		],
		[
			"image without sha256:",
			JSON.stringify({ version: 1, exceptions: [ex(fullId("a"), "e".repeat(64))] }),
			/full sha256/,
		],
		[
			"empty reason",
			JSON.stringify({ version: 1, exceptions: [ex(fullId("a"), id("e"), { reason: " " })] }),
			/reason must be/,
		],
		[
			"bad date",
			JSON.stringify({
				version: 1,
				exceptions: [ex(fullId("a"), id("e"), { approvedAt: "yesterday" })],
			}),
			/approvedAt/,
		],
		[
			"duplicate pair",
			JSON.stringify({
				version: 1,
				exceptions: [ex(fullId("a"), id("e")), ex(fullId("a"), id("e"))],
			}),
			/duplicate/,
		],
	])("%s ⇒ refused", (_n, text, err) => {
		expect(() => parseExceptions(text)).toThrow(err);
	});
	it("the file must be root-owned and not group/world-writable; absent = no exceptions", async () => {
		const text = JSON.stringify(good);
		await expect(loadExceptions({ read: async () => null })).resolves.toEqual([]);
		await expect(
			loadExceptions({ read: async () => ({ text, uid: 0, mode: 0o100644 }) }),
		).resolves.toHaveLength(1);
		await expect(
			loadExceptions({ read: async () => ({ text, uid: 1000, mode: 0o100644 }) }),
		).rejects.toThrow(/not owned by root/);
		await expect(
			loadExceptions({ read: async () => ({ text, uid: 0, mode: 0o100664 }) }),
		).rejects.toThrow(/writable/);
		await expect(
			loadExceptions({ read: async () => ({ text, uid: 0, mode: 0o100646 }) }),
		).rejects.toThrow(/writable/);
	});
	it("an altered file (an id changed by one character) no longer excepts the real pair", async () => {
		const d = vm100();
		d.images.delete(id("e"));
		d.containers = [{ ...sessionC("st-0665fa5a-3eb", id("e")), Id: fullId("a") }];
		const altered = ex(fullId("a").replace(/a$/, "b"), id("e"));
		expect((await gate(d, [altered])).gate).toBe("NO-GO");
		expect((await gate(d, [ex(fullId("a"), id("e"))])).gate).toBe("GO");
	});
});

describe("prune --write is disabled in the CLI (owner review of #521)", () => {
	const io = () => {
		const o: { out: unknown[]; err: string[] } = { out: [], err: [] };
		return { o, io: { out: (v: unknown) => o.out.push(v), err: (l: string) => o.err.push(l) } };
	};
	function spied(d: FakeDocker) {
		const removed: string[] = [];
		const real = d.removeTag.bind(d);
		d.removeTag = async (ref) => {
			removed.push(ref);
			return real(ref);
		};
		return removed;
	}

	it.each([
		[["prune", "--write"]],
		[["prune", "--write", "--backend-stopped"]],
		[["prune", "--force"]],
	])("%j ⇒ exit 2, nothing removed", async (argv) => {
		const d = vm100();
		d.containers = [];
		d.addImage(id("5"), "shared-terminal-session:latest");
		await protectImage(d, id("5"), "shared-terminal-session-pin");
		const removed = spied(d);
		const { o, io: cli } = io();
		expect(await runImagePinsCli(argv as string[], d, {}, cli)).toBe(2);
		expect(removed).toEqual([]);
		expect(o.err.join()).toMatch(/disabled in this version/);
	});

	it("backend active: a spawn's fresh pin (no container yet) shows as an orphan in the dry run, and nothing can remove it", async () => {
		const d = vm100();
		d.containers = [];
		d.addImage(id("5")); // only reachable through the pin: an untag would delete it
		await ensurePinned(d, id("5"), "shared-terminal-session-pin"); // the spawn pinned; its create is in flight
		const removed = spied(d);
		const { o, io: cli } = io();
		expect(await runImagePinsCli(["prune"], d, {}, cli)).toBe(0);
		expect((o.out[0] as { orphans: string[] }).orphans).toContain(
			pinRef(id("5"), "shared-terminal-session-pin"),
		);
		expect(await runImagePinsCli(["prune", "--write", "--backend-stopped"], d, {}, cli)).toBe(2);
		expect(removed).toEqual([]);
		expect(await d.inspectImage(id("5"))).not.toBeNull();
		d.containers.push(sessionC("st-55555555-555", id("5"), "created")); // the create lands
		expect(await d.inspectImage(id("5"))).not.toBeNull();
	});

	it("the dry run and status still work", async () => {
		const d = vm100();
		const { io: cli } = io();
		expect(await runImagePinsCli(["prune"], d, {}, cli)).toBe(0);
		expect(await runImagePinsCli(["bogus"], d, {}, cli)).toBe(2);
	});
});
