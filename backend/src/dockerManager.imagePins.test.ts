/**
 * dockerManager.imagePins.test.ts — spawn pins the image before the create
 * and the container's actual image after it (imagePins.ts), and a pin that
 * fails never blocks the spawn.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	d1Query: vi.fn(async () => ({ results: [] as unknown[], success: true as const, meta: {} })),
}));
vi.mock("./db.js", () => dbStubs);

const osStubs = vi.hoisted(() => ({ cpuCount: 64 }));
vi.mock("node:os", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:os")>();
	const cpus = () => new Array(osStubs.cpuCount).fill(real.cpus()[0] ?? {});
	return { ...real, cpus, default: { ...real, cpus } };
});

vi.mock("node:fs", () => ({
	promises: {
		mkdir: vi.fn(async () => undefined),
		chown: vi.fn(async () => undefined),
		readdir: vi.fn(async () => []),
		stat: vi.fn(async () => ({ size: 0 })),
		lstat: vi.fn(async () => ({ size: 0, isFile: () => false })),
		chmod: vi.fn(async () => undefined),
		rename: vi.fn(async () => undefined),
		unlink: vi.fn(async () => undefined),
		rm: vi.fn(async () => undefined),
	},
}));

import { DockerManager } from "./dockerManager.js";
import { logger } from "./logger.js";
import type { SessionManager } from "./sessionManager.js";

function fakeSessions(
	envVars: Record<string, string> = { ST_INGEST_TOKEN: "user-tries-to-shadow" },
) {
	const meta = {
		sessionId: "sess-1",
		userId: "u1",
		name: "test",
		status: "running" as const,
		containerId: "cid-1",
		containerName: "st-test",
		cols: 80,
		rows: 24,
		envVars,
		createdAt: new Date(),
		lastConnectedAt: null,
		externalRef: null,
	};
	return {
		getOrThrow: vi.fn(async () => meta),
		get: vi.fn(async () => meta),
		setContainerId: vi.fn(async () => undefined),
		updateStatus: vi.fn(async () => undefined),
	} as unknown as SessionManager;
}

const IMG = `sha256:${"e".repeat(64)}`;
const NEW = `sha256:${"f".repeat(64)}`;

/**
 * A Docker stand-in with the containerd semantics that matter here: the
 * session tag resolves to IMG; `rebuildOnResolve` moves the tag to NEW and
 * deletes IMG (its only tag) right after the tag is resolved — the P2 race.
 */
function makeDm(
	opts: { tagFails?: boolean; rebuildOnResolve?: boolean; createdImage?: string } = {},
) {
	const order: string[] = [];
	const sessions = fakeSessions();
	(sessions.setContainerId as ReturnType<typeof vi.fn>).mockImplementation(async () => {
		order.push("persist");
	});
	const dm = new DockerManager(sessions);
	const images = new Map<string, Set<string>>([[IMG, new Set(["shared-terminal-session"])]]);
	let createdFrom: string | null = null;
	const fakeContainer = {
		id: "c".repeat(64),
		start: vi.fn(async () => {
			order.push("start");
		}),
		remove: vi.fn(async () => {
			order.push("remove");
		}),
		inspect: vi.fn(async () => {
			order.push("inspect container");
			return {
				Id: "c".repeat(64),
				Image: opts.createdImage ?? createdFrom,
				NetworkSettings: { Ports: {} },
			};
		}),
	};
	const resolve = (ref: string): string | null => {
		if (images.has(ref)) return ref;
		for (const [id, tags] of images) if (tags.has(ref)) return id;
		return null;
	};
	const docker = {
		createContainer: vi.fn(async (o: { Image: string }) => {
			order.push(`create from ${o.Image === IMG ? "IMG" : o.Image === NEW ? "NEW" : o.Image}`);
			createdFrom = o.Image;
			return fakeContainer;
		}),
		getContainer: vi.fn(() => fakeContainer),
		getImage: vi.fn((ref: string) => ({
			inspect: async () => {
				const id = resolve(ref);
				if (!id) throw Object.assign(new Error("404"), { statusCode: 404 });
				if (opts.rebuildOnResolve && ref === "shared-terminal-session") {
					// The race: the tag moves to NEW and IMG (no other tag) is deleted.
					images.set(NEW, new Set(["shared-terminal-session"]));
					images.delete(IMG);
				}
				return { Id: id, RepoTags: [...(images.get(id) ?? [])] };
			},
			tag: async ({ repo, tag }: { repo: string; tag: string }) => {
				order.push(`tag ${ref === IMG ? "IMG" : ref}`);
				if (opts.tagFails) throw Object.assign(new Error("daemon busy"), { statusCode: 500 });
				const id = resolve(ref);
				if (!id) throw Object.assign(new Error("404"), { statusCode: 404 });
				images.get(id)?.add(`${repo}:${tag}`);
			},
		})),
	};
	(dm as unknown as { docker: unknown }).docker = docker;
	return { dm, order, docker, images };
}

beforeEach(() => {
	dbStubs.d1Query.mockReset();
	dbStubs.d1Query.mockResolvedValue({ results: [], success: true, meta: {} });
	delete process.env.SESSION_IMAGE_PINS;
});

describe("spawn: pinned before the create, from the immutable id (owner P1/P2)", () => {
	it("resolve → pin (verified) → create FROM THE ID → verify → persist → start", async () => {
		const { dm, order, images } = makeDm();
		await dm.spawn("sess-1");
		expect(order).toEqual(["tag IMG", "create from IMG", "inspect container", "persist", "start"]);
		expect(images.get(IMG)?.has(`shared-terminal-session-pin:${"e".repeat(64)}`)).toBe(true);
	});

	it("the pin fails (Docker WOULD create) ⇒ the spawn fails and NOTHING is created", async () => {
		const { dm, order, docker } = makeDm({ tagFails: true });
		await expect(dm.spawn("sess-1")).rejects.toThrow(/pin of .* failed/);
		expect(docker.createContainer).not.toHaveBeenCalled();
		expect(order).not.toContain("persist");
	});

	it("a rebuild deletes the resolved image before it is pinned ⇒ fails; never creates from NEW or from the tag", async () => {
		const { dm, docker } = makeDm({ rebuildOnResolve: true });
		await expect(dm.spawn("sess-1")).rejects.toThrow(
			/disappeared before it could be pinned|not found/,
		);
		expect(docker.createContainer).not.toHaveBeenCalled();
	});

	it("the created container runs another image ⇒ removed by its id before it is recorded or started", async () => {
		const { dm, order } = makeDm({ createdImage: NEW });
		await expect(dm.spawn("sess-1")).rejects.toThrow(/not the pinned/);
		expect(order).toContain("remove");
		expect(order).not.toContain("persist");
		expect(order).not.toContain("start");
	});

	it("SESSION_IMAGE_PINS=off: created from the resolved ID (never the tag), no tag call, an UNPROTECTED warning", async () => {
		process.env.SESSION_IMAGE_PINS = "off";
		const warn = vi.spyOn(logger, "warn");
		const { dm, order } = makeDm();
		await dm.spawn("sess-1");
		expect(order.filter((o) => o.startsWith("tag"))).toEqual([]);
		expect(order).toContain("create from IMG");
		expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
			/image pins DISABLED: spawn sess-1 creates from .* UNPROTECTED/,
		);
		warn.mockRestore();
	});
});

describe("boot", () => {
	it("reconcile runs the pin pass (recovery after a restart or a crash between pin and create)", async () => {
		const { dm } = makeDm();
		const pass = vi.spyOn(dm, "pinAllSessionImages").mockResolvedValue(undefined);
		await dm.reconcile();
		expect(pass).toHaveBeenCalledTimes(1);
	});
});
