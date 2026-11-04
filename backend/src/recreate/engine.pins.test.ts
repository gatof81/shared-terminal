/**
 * engine.pins.test.ts — the recreation's image pin steps (imagePins.ts):
 * "pin image" is its own request BEFORE "create N" (a failure, a daemon error
 * or a closed epoch stops the attempt before N exists), "create N" stays ONE
 * Docker call, and "pin N" verifies N runs exactly the pinned image (else the
 * ordinary rollback removes N).
 */

import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttemptRecord } from "../recreateAttempt.js";
import { deferred, harness, httpError, IMG_N, O_ID, SID, stateOf } from "./engine.testutil.js";

type H = Awaited<ReturnType<typeof harness>>;
const roots: string[] = [];
async function setup(config?: NonNullable<Parameters<typeof harness>[0]>["config"]): Promise<H> {
	const h = await harness({ config });
	roots.push(h.root);
	return h;
}
afterEach(async () => {
	for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});
const recordOf = async (h: H) => {
	const r = await h.attempts.read(SID);
	return r.kind === "ok" ? (r.record as AttemptRecord) : null;
};
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function wirePins(
	h: H,
	opts: {
		pin?: (imageId: string, mayAct: () => boolean) => Promise<void>;
		verify?: (containerId: string, imageId: string) => Promise<void>;
	} = {},
) {
	const seen: string[] = [];
	(h.docker as unknown as { pinImage: unknown }).pinImage = async (
		imageId: string,
		mayAct: () => boolean,
	) => {
		seen.push(`pin:${imageId}:open=${mayAct()}:logAt=${h.docker.log.length}`);
		await opts.pin?.(imageId, mayAct);
	};
	(h.docker as unknown as { verifyPinned: unknown }).verifyPinned = async (
		containerId: string,
		imageId: string,
	) => {
		seen.push(`verify:${containerId.slice(0, 2)}:${imageId}`);
		await opts.verify?.(containerId, imageId);
	};
	return seen;
}

describe("recreation image pins (owner conditions P1/P2)", () => {
	it("pin image (the checked id, epoch open) BEFORE create N; create N is one call; pin N verified after", async () => {
		const h = await setup();
		const seen = wirePins(h);
		const r = await h.engine.recreate(SID, IMG_N);
		expect(r).toMatchObject({ ok: true, outcome: "committed" });
		expect(seen[0]).toMatch(new RegExp(`^pin:${IMG_N}:open=true:logAt=`));
		const logAt = Number(seen[0]!.split("logAt=")[1]);
		expect(h.docker.log.slice(0, logAt).some((l) => l.startsWith("create:"))).toBe(false);
		expect(h.docker.log.filter((l) => l.startsWith("create:"))).toHaveLength(1);
		expect(seen[1]).toBe(`verify:n1:${IMG_N}`);
	});

	it("the pin fails (Docker WOULD create) ⇒ no create, rolled back, previous state exactly", async () => {
		const h = await setup();
		wirePins(h, {
			pin: async () => Promise.reject(new Error("image gone before it could be pinned")),
		});
		const before = stateOf(h);
		const r = await h.engine.recreate(SID, IMG_N);
		expect(r).toMatchObject({ ok: false, status: 500, code: "recreate-failed" });
		expect(h.docker.log.some((l) => l.startsWith("create:"))).toBe(false);
		expect(stateOf(h)).toEqual(before);
		expect(await recordOf(h)).toMatchObject({
			state: "resolved",
			outcome: { kind: "rolled-back" },
		});
	});

	it("a daemon error on the pin (500) is a failure too, never best-effort", async () => {
		const h = await setup();
		wirePins(h, { pin: async () => Promise.reject(httpError(500)) });
		expect(await h.engine.recreate(SID, IMG_N)).toMatchObject({
			ok: false,
			code: "recreate-failed",
		});
		expect(h.docker.log.some((l) => l.startsWith("create:"))).toBe(false);
	});

	it("the epoch closes DURING the pin step ⇒ no create, even when the pin answers late", async () => {
		const h = await setup({ tRecMs: 100, tRbMs: 100 });
		const gate = deferred();
		let lateMayAct: boolean | null = null;
		wirePins(h, {
			pin: async (_img, mayAct) => {
				await gate.promise;
				lateMayAct = mayAct();
			},
		});
		const r = await h.engine.recreate(SID, IMG_N);
		expect(r).toMatchObject({ ok: false });
		gate.resolve();
		await vi.waitFor(async () => expect(await recordOf(h)).toMatchObject({ state: "resolved" }), {
			timeout: 2000,
		});
		await tick(50);
		expect(lateMayAct).toBe(false);
		expect(h.docker.log.some((l) => l.startsWith("create:"))).toBe(false);
		expect([...h.docker.containers.keys()]).toEqual([O_ID]);
	});

	it("N does not run the pinned image (or its pin is gone) ⇒ rollback removes N; D1 never moves", async () => {
		const h = await setup();
		wirePins(h, {
			verify: async () => Promise.reject(new Error("pin of the image is gone or moved")),
		});
		const before = stateOf(h);
		const r = await h.engine.recreate(SID, IMG_N);
		expect(r).toMatchObject({ ok: false, status: 500, code: "recreate-failed" });
		expect(h.d1.writes).not.toContain("cas");
		expect([...h.docker.containers.keys()]).toEqual([O_ID]);
		expect(stateOf(h)).toEqual(before);
	});

	it("without the port's pin methods (pins not wired) the engine behaves exactly as before", async () => {
		const h = await setup();
		expect(await h.engine.recreate(SID, IMG_N)).toMatchObject({ ok: true, outcome: "committed" });
	});
});
