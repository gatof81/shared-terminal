/**
 * engine.preflight.test.ts — the GET preflight stops before the expensive
 * checks (layer, workspace skills archive, CLI) when a terminal blocker is
 * already known: running, flag-off, no-container, or D8 unresolved. On a
 * running container those checks are one Docker call per changed layer
 * path, which made the endpoint time out on a live session. A candidate
 * still gets every check.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { harness, O_ID, SID, stateOf } from "./engine.testutil.js";

type H = Awaited<ReturnType<typeof harness>>;
const roots: string[] = [];
async function setup(): Promise<H> {
	const h = await harness({});
	roots.push(h.root);
	return h;
}
afterEach(async () => {
	for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});

const EXPENSIVE = ["changes", "statPath", "readArchive"] as const;
const SLOW_MS = 2000;

/** Every expensive Docker read takes `ms` and is recorded. */
function instrument(h: H, ms: number): string[] {
	const seen: string[] = [];
	for (const op of EXPENSIVE) {
		h.docker.hooks.set(op, async () => {
			seen.push(op);
			await new Promise((r) => setTimeout(r, ms));
		});
	}
	return seen;
}

async function timed<T>(f: () => Promise<T>): Promise<{ r: T; ms: number }> {
	const t0 = Date.now();
	const r = await f();
	return { r, ms: Date.now() - t0 };
}

async function noEffects(h: H, before: ReturnType<typeof stateOf>): Promise<void> {
	expect(h.docker.mutations()).toEqual([]);
	expect(h.capture.calls).toEqual([]);
	expect(await h.attempts.read(SID)).toMatchObject({ kind: "none" });
	expect(stateOf(h)).toEqual(before);
}

describe("preflight: terminal blockers end it before the expensive checks", () => {
	it("running + flag-off ⇒ fast, both cheap blockers, no layer/skills reads, no effects", async () => {
		const h = await setup();
		h.docker.containers.get(O_ID)!.running = true;
		h.capture.enabled = false;
		const seen = instrument(h, SLOW_MS);
		const before = stateOf(h);

		const { r, ms } = await timed(() => h.engine.preflight(SID));

		expect(r).toEqual({
			recreatable: false,
			blockers: [{ code: "running" }, { code: "flag-off" }],
			imageId: "sha256:imageO",
			currentImageId: "sha256:imageN",
			captureAfter: false,
		});
		expect(seen).toEqual([]);
		expect(ms).toBeLessThan(SLOW_MS / 4);
		await noEffects(h, before);
	});

	it("running with the flag on ⇒ still terminal: fast, no layer reads", async () => {
		const h = await setup();
		h.docker.containers.get(O_ID)!.running = true;
		const seen = instrument(h, SLOW_MS);
		const { r, ms } = await timed(() => h.engine.preflight(SID));
		expect(r).toMatchObject({ recreatable: false, blockers: [{ code: "running" }] });
		expect(seen).toEqual([]);
		expect(ms).toBeLessThan(SLOW_MS / 4);
	});

	it("stopped + flag-off ⇒ fast, not recreatable", async () => {
		const h = await setup();
		h.capture.enabled = false;
		const seen = instrument(h, SLOW_MS);
		const before = stateOf(h);
		const { r, ms } = await timed(() => h.engine.preflight(SID));
		expect(r).toMatchObject({ recreatable: false, blockers: [{ code: "flag-off" }] });
		expect(seen).toEqual([]);
		expect(ms).toBeLessThan(SLOW_MS / 4);
		await noEffects(h, before);
	});

	it("D8 unresolved (unreadable record) ⇒ recreate-unresolved kept, fast, record untouched", async () => {
		const h = await setup();
		const rec = path.join(h.root, ".st-control", SID, "recreate-attempt.json");
		await fs.mkdir(path.dirname(rec), { recursive: true });
		await fs.writeFile(rec, "{not json");
		const seen = instrument(h, SLOW_MS);
		const { r, ms } = await timed(() => h.engine.preflight(SID));
		expect(r).toMatchObject({ recreatable: false, blockers: [{ code: "recreate-unresolved" }] });
		expect(seen).toEqual([]);
		expect(ms).toBeLessThan(SLOW_MS / 4);
		expect(await fs.readFile(rec, "utf-8")).toBe("{not json");
		expect(h.docker.mutations()).toEqual([]);
	});

	it("eligible candidate (stopped, flag on, requested) ⇒ full preflight: layer, skills and CLI all checked", async () => {
		const h = await setup();
		const seen = instrument(h, 20);
		const before = stateOf(h);
		expect(await h.engine.preflight(SID)).toMatchObject({ recreatable: true, blockers: [] });
		expect(seen).toContain("changes");
		expect(seen).toContain("readArchive");
		await noEffects(h, before);

		// Each expensive check still blocks a candidate.
		h.docker.changesOf.set(O_ID, [{ Path: "/home/developer/.bash_history", Kind: 1 }]);
		expect(await h.engine.preflight(SID)).toMatchObject({
			recreatable: false,
			blockers: [{ code: "layer-home", count: 1 }],
		});
		h.docker.changesOf.delete(O_ID);
		h.cli.version = "2.1.309";
		expect(await h.engine.preflight(SID)).toMatchObject({
			recreatable: false,
			blockers: [{ code: "control-marker-incompatible" }],
		});
	});

	it("a fixable blocker (not-requested) is not terminal: the full list is still reported", async () => {
		const h = await setup();
		h.d1.row.conversation_requested = 0;
		const seen = instrument(h, 1);
		h.docker.changesOf.set(O_ID, [{ Path: "/home/developer/.bash_history", Kind: 1 }]);
		expect(await h.engine.preflight(SID)).toMatchObject({
			blockers: [{ code: "not-requested" }, { code: "layer-home", count: 1 }],
		});
		expect(seen).toContain("changes");
	});

	it("the POST is unchanged: running ⇒ 409 running, no effects", async () => {
		const h = await setup();
		h.docker.containers.get(O_ID)!.running = true;
		const before = stateOf(h);
		expect(await h.engine.recreate(SID, "sha256:imageN")).toMatchObject({
			ok: false,
			status: 409,
			code: "running",
		});
		await noEffects(h, before);
	});
});
