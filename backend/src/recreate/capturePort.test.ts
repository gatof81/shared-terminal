/**
 * recreate/capturePort.ts — step 1's capture prep and step 5's write
 * procedure on N, bound to the attempt's epoch (CONVERSATION.md §2.7.2,
 * §2.7.4 "a late positive probe writes no conversation.json").
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	sessions: new Map<string, Record<string, unknown>>(),
	writes: [] as string[],
	d1Query: vi.fn(async (sql: string, params: unknown[] = []) => {
		if (/^SELECT .* FROM sessions WHERE session_id/.test(sql)) {
			const row = dbStubs.sessions.get(String(params[0]));
			return { results: row ? [{ ...row }] : [], success: true, meta: {} };
		}
		dbStubs.writes.push(sql);
		return { results: [], success: true, meta: { changes: 0 } };
	}),
	D1StatementError: class extends Error {},
	getD1CallsSinceBoot: () => 0,
	__resetD1CallsForTests: () => undefined,
}));
vi.mock("../db.js", () => dbStubs);

import { hooksFileExists, hooksFilePath, writeHooksFile } from "../conversation/activation.js";
import {
	type ContainerView,
	deferSeedExists,
	relayEnabledExists,
	writeRelayEnabled,
} from "../conversation/captureAuth.js";
import { hashIngestToken } from "../conversation/registry.js";
import { writeSessionRevocation } from "../conversation/revocation.js";
import type { ConversationService } from "../conversation/service.js";
import { conversationRecreatePort } from "./capturePort.js";
import { AttemptRun } from "./run.js";

const SID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const N = "n".repeat(64);
let root: string;
let token: string;

function port(probe: () => Promise<boolean>) {
	const converge = vi.fn(async () => "kept");
	const view = (): ContainerView => ({
		exists: true,
		running: true,
		token,
		managedMount: true,
		controlMount: true,
		imageId: "sha256:n",
		imageRelay2: true,
	});
	const probeRelay = vi.fn(probe);
	const service = {
		activationDeps: { workspaceRoot: root, enabled: true, port: 3001 },
		captureDocker: {
			inspectCapture: async () => view(),
			currentImage: async () => ({ imageId: "sha256:n", relay2: true }),
			probeRelay,
		},
		authority: { converge },
	} as unknown as ConversationService;
	return { p: conversationRecreatePort(service), probeRelay, converge };
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-rcap-"));
	dbStubs.sessions.clear();
	dbStubs.writes.length = 0;
	token = "t".repeat(64);
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

/** D1 after the commit: N with H. */
function committedRow() {
	dbStubs.sessions.set(SID, {
		status: "stopped",
		conversation_requested: 1,
		ingest_token_hash: hashIngestToken(token),
		ingest_token_hash_suspended: null,
		user_id: "u1",
		container_id: N,
	});
}

describe("prepare (step 1)", () => {
	it("defer-skill-seed written, leftover marker and hooks file removed, N's token and H, nothing to D1", async () => {
		const { p } = port(async () => true);
		await writeRelayEnabled(root, SID);
		await writeHooksFile({ workspaceRoot: root, enabled: true, port: 3001 }, SID);
		const prep = await p.prepare(SID);
		expect(await deferSeedExists(root, SID)).toBe(true);
		expect(await relayEnabledExists(root, SID)).toBe(false);
		expect(await hooksFileExists(root, SID)).toBe(false);
		const t = prep.env.find((e) => e.startsWith("ST_INGEST_TOKEN="))?.split("=")[1] as string;
		expect(prep.hash).toBe(hashIngestToken(t));
		expect(prep.binds).toEqual([
			expect.stringMatching(/:\/etc\/claude-code\/managed-settings\.d:ro$/),
			expect.stringMatching(/:\/etc\/st-control:ro$/),
		]);
		expect(dbStubs.writes).toEqual([]);
	});
});

describe("authorize (step 5) inside the attempt's epoch", () => {
	it("open epoch: marker → identified → hooks file, effective:true, every Docker read an attempt request", async () => {
		committedRow();
		const { p } = port(async () => true);
		const run = new AttemptRun(Date.now() + 10_000);
		const c = await p.authorize(SID, run);
		expect(c).toMatchObject({ effective: true, pendingReasons: [] });
		expect(await relayEnabledExists(root, SID)).toBe(true);
		expect(await hooksFileExists(root, SID)).toBe(true);
		expect(run.evidence.map((e) => e.label)).toEqual(
			expect.arrayContaining(["inspect N (capture)", "probe N relay"]),
		);
	});

	it("the gate is not consulted: the attempt itself is the actor (no circular block)", async () => {
		committedRow();
		const { p } = port(async () => true);
		expect(await p.authorize(SID, new AttemptRun(Date.now() + 10_000))).toMatchObject({
			effective: true,
		});
	});

	it("closed epoch: nothing written, effective:false", async () => {
		committedRow();
		const { p } = port(async () => true);
		const run = new AttemptRun(Date.now() + 10_000);
		run.close("T_rec");
		const c = await p.authorize(SID, run);
		expect(c?.effective).toBe(false);
		expect(await relayEnabledExists(root, SID)).toBe(false);
		expect(await hooksFileExists(root, SID)).toBe(false);
	});

	it("a positive probe after T_rec: no conversation.json, and the marker is retired", async () => {
		committedRow();
		let release!: () => void;
		const late = new Promise<boolean>((r) => {
			release = () => r(true);
		});
		const { p } = port(() => late);
		const run = new AttemptRun(Date.now() + 120);
		const pending = p.authorize(SID, run);
		await new Promise((r) => setTimeout(r, 200));
		release();
		const c = await pending;
		await run.settled();
		expect(c?.effective).toBe(false);
		expect(await hooksFileExists(root, SID)).toBe(false);
		expect(await relayEnabledExists(root, SID)).toBe(false);
	});
});

describe("restore (rollback of an O created by 3.0d)", () => {
	it("puts back exactly what the snapshot saw, unless a disable happened meanwhile", async () => {
		committedRow();
		const { p } = port(async () => true);
		await p.restore(SID, { marker: true, hooksFile: true });
		expect(await relayEnabledExists(root, SID)).toBe(true);
		expect(await fs.readFile(hooksFilePath(root, SID), "utf8")).toContain("hooks");

		await fs.rm(path.join(root, ".st-control"), { recursive: true, force: true });
		await fs.rm(hooksFilePath(root, SID), { force: true });
		await writeSessionRevocation(root, SID, { at: "t", by: "cli" });
		await p.restore(SID, { marker: true, hooksFile: true });
		expect(await relayEnabledExists(root, SID)).toBe(false);
		expect(await hooksFileExists(root, SID)).toBe(false);
	});
});
