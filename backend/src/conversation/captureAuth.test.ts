/**
 * captureAuth.test.ts — 3.0d capture authorization (docs/CONVERSATION.md
 * §2.7.5, §2.7.6; §10 3.0d "Estado efectivo" and "Autorización y marcas"):
 * the pure rules condition by condition, the D7 probe (fresh, single-flight,
 * no positive cache), the write procedure and its rechecks, reconcile's
 * convergence, and disable racing enable. Real files in a temp dir, D1
 * mocked at the module boundary, Docker faked through the port.
 */

import * as nodeFs from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	sessions: new Map<string, Record<string, unknown>>(),
	fail: false,
	d1Query: vi.fn(async (sql: string, params: unknown[] = []) => {
		if (dbStubs.fail) throw new Error("D1 down");
		if (/^SELECT .* FROM sessions WHERE session_id/.test(sql)) {
			const row = dbStubs.sessions.get(String(params[0]));
			return { results: row ? [{ ...row }] : [], success: true, meta: {} };
		}
		if (/^UPDATE sessions SET/.test(sql) && !sql.includes("WHERE")) {
			// revokeAllIngestTokens (`--all`): every row, like the real statement.
			for (const row of dbStubs.sessions.values()) {
				row.ingest_token_hash = null;
				row.ingest_token_hash_suspended = null;
				row.conversation_requested = 0;
				row.revocation_seq = Number(row.revocation_seq ?? 0) + 1;
			}
			return { results: [], success: true, meta: { changes: dbStubs.sessions.size } };
		}
		if (/^UPDATE sessions SET/.test(sql)) {
			const row = dbStubs.sessions.get(String(params[params.length - 1]));
			// The `revocation_seq` guard of the enable writes (3.0d audit A1).
			if (
				row &&
				sql.includes("WHERE revocation_seq = ? AND") &&
				(row.revocation_seq ?? 0) !== params[0]
			) {
				return { results: [], success: true, meta: { changes: 0 } };
			}
			if (row && sql.includes("revocation_seq = revocation_seq + 1")) {
				row.revocation_seq = Number(row.revocation_seq ?? 0) + 1;
			}
			if (row) {
				if (sql.startsWith("UPDATE sessions SET conversation_requested = 1 WHERE")) {
					row.conversation_requested = 1;
				} else if (sql.includes("conversation_requested = ?"))
					row.conversation_requested = params[0];
				else if (sql.includes("ingest_token_hash_suspended = ingest_token_hash")) {
					row.ingest_token_hash_suspended = row.ingest_token_hash;
					row.ingest_token_hash = null;
					row.conversation_requested = 0;
				} else if (sql.includes("COALESCE(ingest_token_hash, ingest_token_hash_suspended)")) {
					row.ingest_token_hash = row.ingest_token_hash ?? row.ingest_token_hash_suspended;
					row.ingest_token_hash_suspended = null;
					row.conversation_requested = 1;
				} else if (sql.includes("ingest_token_hash = NULL, ingest_token_hash_suspended = NULL")) {
					row.ingest_token_hash = null;
					row.ingest_token_hash_suspended = null;
					row.conversation_requested = 0;
				}
			}
			return { results: [], success: true, meta: { changes: row ? 1 : 0 } };
		}
		return { results: [], success: true, meta: {} };
	}),
	getD1CallsSinceBoot: () => 0,
	__resetD1CallsForTests: () => undefined,
}));
vi.mock("../db.js", () => dbStubs);

import {
	disableAll,
	disableSession,
	enableSession,
	hooksFileExists,
	hooksFilePath,
	prepareSpawnCapture,
	RevokedMeanwhileError,
	removeHooksFile,
	writeHooksFile,
} from "./activation.js";
import {
	baseCapture,
	CaptureAuthority,
	type CaptureDockerPort,
	type CaptureFacts,
	type ContainerView,
	controlDir,
	ensureControlDir,
	relayEnabledPath,
	removeAllRelayMarkers,
	retainAuthorized,
	writeAuthorized,
	writeRelayEnabled,
} from "./captureAuth.js";
import { getSessionCapture, hashIngestToken } from "./registry.js";
import * as revocationModule from "./revocation.js";
import { checkRevocation, writeSessionRevocation } from "./revocation.js";

const TOKEN = "b".repeat(64);
const HASH = hashIngestToken(TOKEN);
let root: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-capauth-"));
	dbStubs.sessions.clear();
	dbStubs.fail = false;
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

const exists = (p: string) =>
	fs.lstat(p).then(
		() => true,
		() => false,
	);

function view(patch: Partial<Extract<ContainerView, { exists: true }>> = {}): ContainerView {
	return {
		exists: true,
		running: true,
		token: TOKEN,
		managedMount: true,
		controlMount: true,
		imageId: "sha256:i",
		imageRelay2: true,
		...patch,
	};
}

// ── Pure rules ──────────────────────────────────────────────────────────────

function facts(patch: Partial<CaptureFacts> = {}, row: Record<string, unknown> = {}): CaptureFacts {
	return {
		flag: true,
		row: {
			status: "running",
			conversation_requested: 1,
			ingest_token_hash: HASH,
			ingest_token_hash_suspended: null,
			user_id: "u1",
			container_id: "cid",
			...row,
		} as CaptureFacts["row"],
		revocation: "none",
		unresolved: false,
		container: view(),
		currentImageRelay2: true,
		marker: true,
		hooksFile: true,
		...patch,
	};
}

describe("rules: effectiveAfterRestart, no-container branch (one test per false condition)", () => {
	const none = { container: null };
	it("all conditions true ⇒ true", () => {
		expect(baseCapture(facts(none)).effectiveAfterRestart).toBe(true);
		expect(baseCapture(facts({ container: { exists: false } })).effectiveAfterRestart).toBe(true);
	});
	for (const [label, f] of [
		["requested = 0", facts(none, { conversation_requested: 0 })],
		["flag off", facts({ ...none, flag: false })],
		["per-session revocation", facts({ ...none, revocation: "session" })],
		["global revocation", facts({ ...none, revocation: "global" })],
		["current image without the label", facts({ ...none, currentImageRelay2: false })],
		["unresolved recreation", facts({ ...none, unresolved: true })],
	] as const) {
		it(`${label} ⇒ false`, () => {
			expect(baseCapture(f).effectiveAfterRestart).toBe(false);
		});
	}
});

describe("rules: effectiveAfterRestart, stopped-container branch", () => {
	const stopped = (p: Partial<Extract<ContainerView, { exists: true }>> = {}) =>
		view({ running: false, ...p });
	it("all conditions true ⇒ true", () => {
		expect(baseCapture(facts({ container: stopped() })).effectiveAfterRestart).toBe(true);
	});
	for (const [label, f] of [
		["requested = 0", facts({ container: stopped() }, { conversation_requested: 0 })],
		["flag off", facts({ container: stopped(), flag: false })],
		["revocation", facts({ container: stopped(), revocation: "session" })],
		["no managed mount", facts({ container: stopped({ managedMount: false }) })],
		["no control mount", facts({ container: stopped({ controlMount: false }) })],
		["no token", facts({ container: stopped({ token: null }) })],
		["token ≠ hash", facts({ container: stopped() }, { ingest_token_hash: "other" })],
		[
			"only a suspended hash",
			facts(
				{ container: stopped() },
				{ ingest_token_hash: null, ingest_token_hash_suspended: HASH },
			),
		],
		["own image without the label", facts({ container: stopped({ imageRelay2: false }) })],
		["no relay.enabled", facts({ container: stopped(), marker: false })],
		["no hooks file", facts({ container: stopped(), hooksFile: false })],
	] as const) {
		it(`${label} ⇒ false`, () => {
			expect(baseCapture(f).effectiveAfterRestart).toBe(false);
		});
	}
	it("a running container never takes this branch", () => {
		expect(baseCapture(facts()).effectiveAfterRestart).toBe(false);
	});
});

describe("rules: requiresRecreate and reasons", () => {
	it("true only when a new container is the only way out", () => {
		expect(baseCapture(facts({ container: view({ token: null }) })).requiresRecreate).toBe(true);
		expect(baseCapture(facts({ container: view({ controlMount: false }) })).requiresRecreate).toBe(
			true,
		);
		expect(baseCapture(facts({ container: view({ managedMount: false }) })).requiresRecreate).toBe(
			true,
		);
		expect(baseCapture(facts({}, { ingest_token_hash: "other" })).requiresRecreate).toBe(true);
		// Correspondence with only the configuration missing: start + PATCH, no recreation.
		const missing = baseCapture(
			facts({ container: view({ running: false }), marker: false, hooksFile: false }),
		);
		expect(missing.requiresRecreate).toBe(false);
		expect(missing.pendingReasons).toEqual(["stopped", "hooks-file-missing"]);
		expect(baseCapture(facts({ container: null })).requiresRecreate).toBe(false);
	});
	it("write needs running; retain doesn't; both need correspondence and both mounts", () => {
		const stopped = facts({ container: view({ running: false }) });
		expect(writeAuthorized(stopped)).toBe(false);
		expect(retainAuthorized(stopped)).toBe(true);
		expect(writeAuthorized(facts())).toBe(true);
		for (const f of [
			facts({}, { ingest_token_hash: "other" }),
			facts({ container: view({ controlMount: false }) }),
			facts({ revocation: "global" }),
			facts({ unresolved: true }),
		]) {
			expect(writeAuthorized(f)).toBe(false);
			expect(retainAuthorized(f)).toBe(false);
		}
	});
});

// ── Authority ───────────────────────────────────────────────────────────────

function session(sid: string, patch: Record<string, unknown> = {}) {
	dbStubs.sessions.set(sid, {
		status: "running",
		conversation_requested: 1,
		ingest_token_hash: HASH,
		ingest_token_hash_suspended: null,
		user_id: "u1",
		container_id: `cid-${sid}`,
		...patch,
	});
	return dbStubs.sessions.get(sid) as Record<string, unknown>;
}

const deps = () => ({ workspaceRoot: root, enabled: true, port: 3001 });

function make(opts: {
	container?: ContainerView;
	probe?: CaptureDockerPort["probeRelay"];
	inspect?: CaptureDockerPort["inspectCapture"];
	unresolved?: boolean;
}) {
	const clock = { t: 0 };
	const probe = vi.fn(opts.probe ?? (async () => true));
	const inspect = vi.fn(opts.inspect ?? (async () => opts.container ?? view()));
	const authority = new CaptureAuthority({
		workspaceRoot: root,
		enabled: true,
		docker: {
			inspectCapture: inspect,
			currentImage: async () => ({ imageId: "sha256:i", relay2: true }),
			probeRelay: probe,
		},
		getRow: (sid) => getSessionCapture(sid),
		checkRevocation: (sid) => checkRevocation(root, sid),
		isRecreateUnresolved: async () => opts.unresolved ?? false,
		writeHooksFile: (sid) => writeHooksFile(deps(), sid),
		removeHooksFile: (sid) => removeHooksFile(root, sid),
		hooksFileExists: (sid) => hooksFileExists(root, sid),
		now: () => clock.t,
		sleep: async (ms) => {
			clock.t += ms;
		},
	});
	return { authority, probe, inspect, clock };
}

async function configured(sid: string) {
	await writeRelayEnabled(root, sid);
	await writeHooksFile(deps(), sid);
}

describe("capture(): D7 fresh probe", () => {
	it("positive probe ⇒ effective:true with checkedAt; a probe per request (no positive cache)", async () => {
		session("s1");
		await configured("s1");
		const { authority, probe } = make({});
		const a = await authority.capture("s1");
		expect(a).toMatchObject({
			requested: true,
			effective: true,
			pendingReasons: [],
			requiresRecreate: false,
		});
		expect(typeof a.checkedAt).toBe("string");
		await authority.capture("s1");
		expect(probe).toHaveBeenCalledTimes(2);
	});
	it("relay dies, the very next query ⇒ effective:false relay-unavailable, without waiting", async () => {
		session("s1");
		await configured("s1");
		let alive = true;
		const { authority } = make({ probe: async () => alive });
		expect((await authority.capture("s1")).effective).toBe(true);
		alive = false;
		const b = await authority.capture("s1");
		expect(b.effective).toBe(false);
		expect(b.pendingReasons).toContain("relay-unavailable");
	});
	it("port held by another process (answers, doesn't identify) and a probe that throws ⇒ false", async () => {
		session("s1");
		await configured("s1");
		expect((await make({ probe: async () => false }).authority.capture("s1")).effective).toBe(
			false,
		);
		const thrown = await make({
			probe: async () => {
				throw new Error("exec failed");
			},
		}).authority.capture("s1");
		expect(thrown.effective).toBe(false);
		expect(thrown.pendingReasons).toContain("relay-unavailable");
	});
	it("concurrent queries share one probe in flight; a later query probes again", async () => {
		session("s1");
		await configured("s1");
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const { authority, probe } = make({
			probe: async () => {
				await gate;
				return true;
			},
		});
		const p = Promise.all([
			authority.capture("s1"),
			authority.capture("s1"),
			authority.capture("s1"),
		]);
		await new Promise((r) => setTimeout(r, 20));
		release();
		const all = await p;
		expect(all.every((c) => c.effective)).toBe(true);
		expect(probe).toHaveBeenCalledTimes(1);
		await authority.capture("s1");
		expect(probe).toHaveBeenCalledTimes(2);
	});
	for (const [label, setup] of [
		["missing marker", async () => writeHooksFile(deps(), "s1")],
		["missing hooks file", async () => writeRelayEnabled(root, "s1")],
	] as const) {
		it(`${label} ⇒ effective:false hooks-file-missing, and no probe runs`, async () => {
			session("s1");
			await setup();
			const { authority, probe } = make({});
			const c = await authority.capture("s1");
			expect(c.effective).toBe(false);
			expect(c.pendingReasons).toContain("hooks-file-missing");
			expect(probe).not.toHaveBeenCalled();
		});
	}
	it("token ≠ hash ⇒ effective:false token-mismatch, no probe", async () => {
		session("s1", { ingest_token_hash: "old" });
		await configured("s1");
		const { authority, probe } = make({});
		const c = await authority.capture("s1");
		expect(c).toMatchObject({
			effective: false,
			effectiveAfterRestart: false,
			requiresRecreate: true,
		});
		expect(c.pendingReasons).toContain("token-mismatch");
		expect(probe).not.toHaveBeenCalled();
	});
	it("Docker or D1 failure ⇒ fail-closed: nothing effective, nothing promised", async () => {
		session("s1");
		await configured("s1");
		const docker = await make({
			inspect: async () => {
				throw new Error("daemon down");
			},
		}).authority.capture("s1");
		expect(docker).toMatchObject({ effective: false, effectiveAfterRestart: false });
		dbStubs.fail = true;
		expect(await make({}).authority.capture("s1")).toMatchObject({
			effective: false,
			effectiveAfterRestart: false,
		});
	});
});

describe("applyWrite(): §2.7.5 procedure and rechecks", () => {
	it("authorized ⇒ marker, relay identified, hooks file", async () => {
		session("s1");
		const { authority } = make({});
		expect(await authority.applyWrite("s1")).toBe("written");
		expect(await exists(relayEnabledPath(root, "s1"))).toBe(true);
		expect(await exists(hooksFilePath(root, "s1"))).toBe(true);
	});
	it("a relay that identifies only after a few polls is waited for (≤ 5 s)", async () => {
		session("s1");
		let n = 0;
		const { authority } = make({ probe: async () => ++n >= 4 });
		expect(await authority.applyWrite("s1")).toBe("written");
	});
	it("revocation lands between the marker and the probe ⇒ withdrawn: no file, no marker", async () => {
		session("s1");
		const { authority } = make({
			probe: async () => {
				await writeSessionRevocation(root, "s1", { at: "t", by: "cli" });
				return true;
			},
		});
		// The recheck right after the marker runs before the probe, so the
		// revocation is seen by the recheck after the hooks file.
		expect(await authority.applyWrite("s1")).toBe("revoked-meanwhile");
		expect(await exists(hooksFilePath(root, "s1"))).toBe(false);
		expect(await exists(relayEnabledPath(root, "s1"))).toBe(false);
	});
	it("requested flips to 0 before the marker recheck ⇒ withdrawn before any hooks file", async () => {
		const row = session("s1");
		const realWrite = writeRelayEnabled;
		const { authority } = make({});
		const spy = vi.spyOn(fs, "rename").mockImplementation(async (a, b) => {
			row.conversation_requested = 0;
			spy.mockRestore();
			return fs.rename(a, b);
		});
		expect(await authority.applyWrite("s1")).toBe("revoked-meanwhile");
		expect(await exists(hooksFilePath(root, "s1"))).toBe(false);
		expect(await exists(relayEnabledPath(root, "s1"))).toBe(false);
		void realWrite;
	});
	it("the hooks-file write throws ⇒ the error propagates and no marker is left behind", async () => {
		session("s1");
		const realRename = fs.rename.bind(fs);
		const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (String(to).endsWith("conversation.json"))
				throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
			return realRename(from, to);
		});
		try {
			await expect(make({}).authority.applyWrite("s1")).rejects.toThrow("ENOSPC");
		} finally {
			spy.mockRestore();
		}
		expect(await exists(relayEnabledPath(root, "s1"))).toBe(false);
		expect(await exists(hooksFilePath(root, "s1"))).toBe(false);
	});
	it("not authorized (stopped, mismatch, no control mount) ⇒ nothing written", async () => {
		session("s1");
		for (const container of [
			view({ running: false }),
			view({ token: "c".repeat(64) }),
			view({ controlMount: false }),
		]) {
			expect(await make({ container }).authority.applyWrite("s1")).toBe("not-authorized");
			expect(await exists(relayEnabledPath(root, "s1"))).toBe(false);
			expect(await exists(hooksFilePath(root, "s1"))).toBe(false);
		}
	});
});

describe("bounds and single reads (review bot on c9bee6f)", () => {
	it("identification never counts evidence past 5 s: a positive that arrives late writes no hooks file (V2)", async () => {
		session("s1");
		const box: { clock?: { t: number } } = {};
		let calls = 0;
		const m = make({
			probe: async () => {
				// each probe takes 2.5 s; the second one is positive, at 5.25 s
				if (box.clock) box.clock.t += 2500;
				return ++calls === 2;
			},
		});
		box.clock = m.clock;
		expect(await m.authority.applyWrite("s1")).toBe("relay-unavailable");
		expect(m.probe).toHaveBeenCalledTimes(2);
		expect(await exists(hooksFilePath(root, "s1"))).toBe(false);
		expect(await exists(relayEnabledPath(root, "s1"))).toBe(false);
		// Fast failing probes: polled every 250 ms, none taken at or after 5 s.
		const fast = make({ probe: async () => false });
		expect(await fast.authority.applyWrite("s1")).toBe("relay-unavailable");
		expect(fast.clock.t).toBeLessThan(5000);
	});
	it("a positive capture() probe that settles after its own budget is not effective (V2)", async () => {
		session("s1");
		await configured("s1");
		const box: { clock?: { t: number } } = {};
		const m = make({
			probe: async () => {
				if (box.clock) box.clock.t += 2600;
				return true;
			},
		});
		box.clock = m.clock;
		const c = await m.authority.capture("s1");
		expect(c.effective).toBe(false);
		expect(c.pendingReasons).toContain("relay-unavailable");
	});
	it("checkedAt is when the probe settled (a joined probe reports the evidence's time)", async () => {
		session("s1");
		await configured("s1");
		const box: { clock?: { t: number } } = {};
		const m = make({
			probe: async () => {
				if (box.clock) box.clock.t += 1500;
				return true;
			},
		});
		box.clock = m.clock;
		const c = await m.authority.capture("s1");
		expect(c.checkedAt).toBe(new Date(1500).toISOString());
	});
	it("converge reads the facts once when it writes (one inspect, not two)", async () => {
		session("s1");
		const m = make({});
		expect(await m.authority.converge("s1")).toBe("written");
		expect(m.inspect).toHaveBeenCalledTimes(1);
	});
	it("enable's happy path probes once and reports that probe as this request's", async () => {
		session("s1", { conversation_requested: 0 });
		const m = make({});
		const r = await enableSession(deps(), m.authority, "s1", async () => false);
		expect(r.capture.effective).toBe(true);
		expect(typeof r.capture.checkedAt).toBe("string");
		expect(m.probe).toHaveBeenCalledTimes(1);
	});
});

describe("capture(): state re-validated after the probe (V3)", () => {
	function gated() {
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const inProbe = new Promise<void>((r) => {
			entered = r;
		});
		const probe = async () => {
			entered();
			await gate;
			return true;
		};
		return { probe, release, inProbe };
	}
	for (const by of ["cli", "api"] as const) {
		it(`probe pending → ${by} disable completes → positive: effective:false, no second probe`, async () => {
			session("s1");
			await configured("s1");
			const g = gated();
			const m = make({ probe: g.probe });
			const pending = m.authority.capture("s1");
			await g.inProbe;
			await disableSession(deps(), "s1", by);
			g.release();
			const c = await pending;
			expect(c.effective).toBe(false);
			expect(c.requested).toBe(false);
			expect(c.pendingReasons).not.toContain("relay-unavailable");
			expect(m.probe).toHaveBeenCalledTimes(1);
		});
	}
	it("container_id changes while the probe is pending ⇒ effective:false (the identified container is not the session's)", async () => {
		const row = session("s1");
		await configured("s1");
		const g = gated();
		const m = make({ probe: g.probe });
		const pending = m.authority.capture("s1");
		await g.inProbe;
		row.container_id = "cid-other";
		g.release();
		const c = await pending;
		expect(c.effective).toBe(false);
		expect(m.probe).toHaveBeenCalledTimes(1);
	});
	it("applyWrite: container_id changes during identification ⇒ revoked-meanwhile, nothing left", async () => {
		const row = session("s1");
		const m = make({
			probe: async () => {
				row.container_id = "cid-other";
				return true;
			},
		});
		expect(await m.authority.applyWrite("s1")).toBe("revoked-meanwhile");
		expect(await exists(hooksFilePath(root, "s1"))).toBe(false);
		expect(await exists(relayEnabledPath(root, "s1"))).toBe(false);
	});
});

describe("enable: the write procedure's evidence is bound to the container it identified (V3)", () => {
	it("A identified, D1 switched to B (own valid correspondence) before the final capture ⇒ effective:false, no second probe", async () => {
		const row = session("s1", { conversation_requested: 0, container_id: "cid-A" });
		const m = make({});
		const realCapture = m.authority.capture.bind(m.authority);
		const capture = vi.spyOn(m.authority, "capture").mockImplementation(async (sid, opts) => {
			// The write procedure (on A) has finished; D1 now names B before
			// capture()'s final read of the facts.
			row.container_id = "cid-B";
			return realCapture(sid, opts);
		});
		const r = await enableSession(deps(), m.authority, "s1", async () => false);
		expect(capture).toHaveBeenCalledTimes(1);
		expect(capture.mock.calls[0]?.[1]?.identified?.containerId).toBe("cid-A");
		expect(m.probe).toHaveBeenCalledTimes(1);
		expect(m.probe.mock.calls[0]?.[1]).toBe("cid-A");
		expect(m.inspect).toHaveBeenLastCalledWith("cid-B");
		expect(r.capture.effective).toBe(false);
		expect(r.capture.pendingReasons).toContain("relay-unavailable");
	});
	it("the same evidence through capture() directly: A's evidence never makes B effective", async () => {
		const row = session("s1", { container_id: "cid-A" });
		const m = make({});
		const w = await m.authority.applyWriteDetailed("s1");
		expect(w.outcome).toBe("written");
		expect(w.identified?.containerId).toBe("cid-A");
		row.container_id = "cid-B";
		const c = await m.authority.capture("s1", { identified: w.identified });
		expect(c.effective).toBe(false);
		expect(m.probe).toHaveBeenCalledTimes(1);
	});
	it("A unchanged ⇒ one probe and effective:true", async () => {
		session("s1", { conversation_requested: 0, container_id: "cid-A" });
		const m = make({});
		const r = await enableSession(deps(), m.authority, "s1", async () => false);
		expect(r.capture.effective).toBe(true);
		expect(m.probe).toHaveBeenCalledTimes(1);
	});
});

describe("converge(): reconcile (§2.4 row, K2)", () => {
	it("running + full authorization + something missing ⇒ written; complete ⇒ kept", async () => {
		session("s1");
		const { authority } = make({});
		expect(await authority.converge("s1")).toBe("written");
		expect(await authority.converge("s1")).toBe("kept");
	});
	it("stop → reconcile → start: the retained config survives, the start needs no PATCH", async () => {
		session("s1", { status: "stopped" });
		await configured("s1");
		const stopped = make({ container: view({ running: false }) });
		expect(await stopped.authority.converge("s1")).toBe("kept");
		expect(await exists(hooksFilePath(root, "s1"))).toBe(true);
		expect(await exists(relayEnabledPath(root, "s1"))).toBe(true);
		const before = await stopped.authority.capture("s1");
		expect(before.effectiveAfterRestart).toBe(true);
		// start: same container, now running; nothing was written by start.
		const started = make({ container: view() });
		expect((await started.authority.capture("s1")).effective).toBe(true);
	});
	for (const [label, row, container] of [
		[
			"stopped with token ≠ hash",
			{ status: "stopped", ingest_token_hash: "old" },
			view({ running: false }),
		],
		[
			"stopped 3.0c container (no control mount)",
			{ status: "stopped" },
			view({ running: false, controlMount: false }),
		],
		["no container any more (kill)", { container_id: null }, undefined],
		["flag-side: requested = 0", { conversation_requested: 0 }, view()],
	] as const) {
		it(`${label} ⇒ withdrawn (file then marker)`, async () => {
			session("s1", row);
			await configured("s1");
			expect(await make({ container }).authority.converge("s1")).toBe("withdrawn");
			expect(await exists(hooksFilePath(root, "s1"))).toBe(false);
			expect(await exists(relayEnabledPath(root, "s1"))).toBe(false);
		});
	}
	it("stopped with retain authorization keeps only a complete pair; a half is retired", async () => {
		session("s1", { status: "stopped" });
		const stopped = { container: view({ running: false }) };
		await writeRelayEnabled(root, "s1"); // marker without hooks file
		expect(await make(stopped).authority.converge("s1")).toBe("withdrawn");
		expect(await exists(relayEnabledPath(root, "s1"))).toBe(false);
		await writeHooksFile(deps(), "s1"); // hooks file without marker
		expect(await make(stopped).authority.converge("s1")).toBe("withdrawn");
		expect(await exists(hooksFilePath(root, "s1"))).toBe(false);
		expect(await make(stopped).authority.converge("s1")).toBe("nothing");
		await configured("s1");
		expect(await make(stopped).authority.converge("s1")).toBe("kept");
	});
	it('nothing on disk and nothing to keep ⇒ "nothing" (not reported as a withdrawal)', async () => {
		session("s1", { conversation_requested: 0 });
		expect(await make({}).authority.converge("s1")).toBe("nothing");
	});
	it("unresolved recreation ⇒ skipped: nothing written or removed", async () => {
		session("s1", { conversation_requested: 0 });
		await configured("s1");
		expect(await make({ unresolved: true }).authority.converge("s1")).toBe("skipped");
		expect(await exists(hooksFilePath(root, "s1"))).toBe(true);
		expect(await exists(relayEnabledPath(root, "s1"))).toBe(true);
	});
});

describe("disable racing enable (§10 3.0d, 100 repetitions)", () => {
	it("after both settle there is never a hooks file or marker, and never effective:true", async () => {
		for (let i = 0; i < 100; i++) {
			const sid = `race${i}`;
			session(sid);
			const { authority } = make({
				probe: async () => {
					await new Promise((r) => setTimeout(r, i % 3));
					return true;
				},
			});
			const enable = enableSession(deps(), authority, sid, async () => false);
			await new Promise((r) => setTimeout(r, i % 4));
			const disable = disableSession(deps(), sid, "cli");
			await Promise.allSettled([enable, disable]);
			expect(await exists(hooksFilePath(root, sid)), `run ${i} file`).toBe(false);
			expect(await exists(relayEnabledPath(root, sid)), `run ${i} marker`).toBe(false);
			expect((await authority.capture(sid)).effective, `run ${i} effective`).toBe(false);
		}
	});
});

describe("control dir helpers", () => {
	it("0755 dir (even if it existed 0700), 0644 marker; removeAllRelayMarkers clears every session", async () => {
		await fs.mkdir(controlDir(root, "a"), { recursive: true, mode: 0o700 });
		await fs.chmod(controlDir(root, "a"), 0o700);
		await ensureControlDir(root, "a");
		expect((await fs.stat(controlDir(root, "a"))).mode & 0o777).toBe(0o755);
		await writeRelayEnabled(root, "a");
		await writeRelayEnabled(root, "b");
		expect((await fs.stat(relayEnabledPath(root, "a"))).mode & 0o777).toBe(0o644);
		expect((await removeAllRelayMarkers(root)).sort()).toEqual(["a", "b"]);
		expect(await exists(relayEnabledPath(root, "a"))).toBe(false);
	});
	it("removeAllRelayMarkers ignores directory entries that aren't safe session ids", async () => {
		const odd = path.join(root, ".st-control", ".hidden");
		await fs.mkdir(odd, { recursive: true });
		await fs.writeFile(path.join(odd, "relay.enabled"), "");
		expect(await removeAllRelayMarkers(root)).toEqual([]);
		expect(await exists(path.join(odd, "relay.enabled"))).toBe(true);
	});
	it("concurrent writers of one session never collide on the temp file (marker and hooks file)", async () => {
		const writes = [];
		for (let i = 0; i < 20; i++) {
			writes.push(writeRelayEnabled(root, "s1"), writeHooksFile(deps(), "s1"));
		}
		await expect(Promise.all(writes)).resolves.toBeDefined();
		expect(await exists(relayEnabledPath(root, "s1"))).toBe(true);
		expect(await exists(hooksFilePath(root, "s1"))).toBe(true);
		const left = [
			...(await fs.readdir(controlDir(root, "s1"))),
			...(await fs.readdir(path.dirname(hooksFilePath(root, "s1")))),
		];
		expect(left.filter((n) => n.includes(".tmp."))).toEqual([]);
	});
	it("refuses unsafe session ids", () => {
		for (const bad of ["../x", "a/b", ""]) expect(() => controlDir(root, bad)).toThrow();
	});
});

// ── 3.0d audit A1: a revocation during an enable stays persistent ──────────

/**
 * The emergency CLI runs `disableSession(…, "cli")` / `disableAll` in ANOTHER
 * process, with no lock. What makes these interleavings representative of
 * that: everything the two sides share is a single D1 statement or a single
 * `rename` / `link` / `stat` — atomic across processes — and the enable's
 * reads and writes happen in the order the windows below cut between.
 */
describe("3.0d audit A1: a revocation landing during an enable wins, in D1, the marker and the next spawn", () => {
	type Revoke = (sid: string) => Promise<unknown>;
	const cli: Revoke = (sid) => disableSession(deps(), sid, "cli");
	const api: Revoke = (sid) => disableSession(deps(), sid, "api");
	const all: Revoke = () => disableAll(deps());

	/** Where the revocation runs, relative to the enable's steps. */
	const windows: Array<[string, (sid: string, revoke: Revoke) => () => void]> = [
		[
			"after the enable read the marker, before it read revocation_seq",
			(_sid, revoke) => {
				const real = revocationModule.readSessionRevocation;
				let armed = true;
				const spy = vi
					.spyOn(revocationModule, "readSessionRevocation")
					.mockImplementation(async (r, s) => {
						const out = await real(r, s);
						if (armed) {
							armed = false;
							await revoke(s);
						}
						return out;
					});
				return () => spy.mockRestore();
			},
		],
		[
			"between the read of revocation_seq and the D1 write",
			() => () => undefined, // installed on the authority below
		],
		[
			"between the D1 write and the marker's retirement",
			(_sid, revoke) => {
				const real = revocationModule.retireSessionRevocation;
				const spy = vi
					.spyOn(revocationModule, "retireSessionRevocation")
					.mockImplementation(async (r, s, e) => {
						await revoke(s);
						return real(r, s, e);
					});
				return () => spy.mockRestore();
			},
		],
		[
			"during the retirement, right after the marker was moved aside",
			(sid, revoke) => {
				const real = nodeFs.promises.rename.bind(nodeFs.promises);
				let armed = true;
				const spy = vi.spyOn(nodeFs.promises, "rename").mockImplementation(async (from, to) => {
					await real(from, to);
					if (armed && String(to).includes(".retiring.")) {
						armed = false;
						await revoke(sid);
					}
				});
				return () => spy.mockRestore();
			},
		],
		[
			"after the retirement, before the write procedure",
			(_sid, revoke) => {
				const real = revocationModule.retireSessionRevocation;
				const spy = vi
					.spyOn(revocationModule, "retireSessionRevocation")
					.mockImplementation(async (r, s, e) => {
						const out = await real(r, s, e);
						await revoke(s);
						return out;
					});
				return () => spy.mockRestore();
			},
		],
	];

	async function final(sid: string) {
		const row = dbStubs.sessions.get(sid) as Record<string, unknown>;
		const spawn = await prepareSpawnCapture(deps(), sid, { imageId: "sha256:i", relay2: true });
		return {
			requested: row.conversation_requested,
			hash: row.ingest_token_hash,
			suspended: row.ingest_token_hash_suspended,
			revocation: await checkRevocation(root, sid),
			nextSpawnHasToken: spawn.env.some((e) => e.startsWith("ST_INGEST_TOKEN=")),
			hooksFile: await exists(hooksFilePath(root, sid)),
			marker: await exists(relayEnabledPath(root, sid)),
		};
	}

	const starts: Array<[string, (sid: string) => Promise<void>]> = [
		[
			"re-enable after an API disable",
			async (sid) => {
				session(sid);
				await disableSession(deps(), sid, "api");
			},
		],
		[
			"first enable of a session never requested",
			async (sid) => {
				session(sid, { conversation_requested: 0, ingest_token_hash: null });
			},
		],
	];

	let n = 0;
	for (const [startLabel, start] of starts) {
		for (const [by, revoke] of [
			["emergency CLI", cli],
			["API disable", api],
			["emergency --all", all],
		] as const) {
			for (const [where, install] of windows) {
				// Without a marker at the start there is nothing to retire, so
				// that window does not exist (the enable never renames).
				if (where.startsWith("during the retirement") && startLabel.startsWith("first enable"))
					continue;
				it(`${startLabel}; ${by} ${where}`, async () => {
					const sid = `a1-${n++}`;
					await start(sid);
					const { authority } = make({});
					let restore = install(sid, revoke);
					if (where.startsWith("between the read of revocation_seq")) {
						const realFacts = authority.facts.bind(authority);
						let armed = true;
						authority.facts = async (s: string) => {
							const f = await realFacts(s);
							if (armed) {
								armed = false;
								await revoke(s);
							}
							return f;
						};
						restore = () => undefined;
					}
					let outcome: string;
					try {
						const r = await enableSession(deps(), authority, sid, async () => false);
						outcome = r.capture.effective ? "enabled, effective" : "enabled, not effective";
					} catch (err) {
						outcome = (err as Error).name;
					} finally {
						restore();
					}
					const f = await final(sid);
					// Whatever the enable answered, the revocation is what holds.
					expect([outcome, f.requested]).toEqual([outcome, 0]);
					expect([outcome, f.hash]).toEqual([outcome, null]);
					expect([outcome, f.revocation]).toEqual([
						outcome,
						by === "emergency --all" ? "global" : "session",
					]);
					expect([outcome, f.nextSpawnHasToken]).toEqual([outcome, false]);
					expect([outcome, f.hooksFile, f.marker]).toEqual([outcome, false, false]);
					if (by === "emergency CLI" || by === "emergency --all") {
						// The emergency nulls both: nothing a later enable could restore.
						expect([outcome, f.suspended]).toEqual([outcome, null]);
					}
					expect(outcome).not.toBe("enabled, effective");
				});
			}
		}
	}

	it("the enable is refused with RevokedMeanwhileError when it lost the D1 race", async () => {
		const sid = "a1-refused";
		session(sid, { conversation_requested: 0, ingest_token_hash: null });
		const { authority } = make({});
		const realFacts = authority.facts.bind(authority);
		let armed = true;
		authority.facts = async (s: string) => {
			const f = await realFacts(s);
			if (armed) {
				armed = false;
				await cli(s);
			}
			return f;
		};
		await expect(enableSession(deps(), authority, sid, async () => false)).rejects.toBeInstanceOf(
			RevokedMeanwhileError,
		);
	});

	it("without any concurrent revocation an enable still clears the marker it started from", async () => {
		const sid = "a1-plain";
		session(sid);
		await disableSession(deps(), sid, "api");
		const { authority } = make({});
		const r = await enableSession(deps(), authority, sid, async () => false);
		expect(r.capture.effective).toBe(true);
		expect(await checkRevocation(root, sid)).toBe("none");
		expect(dbStubs.sessions.get(sid)).toMatchObject({
			conversation_requested: 1,
			ingest_token_hash: HASH,
		});
	});

	it("disable racing enable ×100 (random timing, enable first): after both settle the revocation holds in D1, the marker and the next spawn", async () => {
		for (let i = 0; i < 100; i++) {
			const sid = `a1-race${i}`;
			session(sid, { conversation_requested: 0, ingest_token_hash: null });
			const { authority } = make({
				probe: async () => {
					await new Promise((r) => setTimeout(r, i % 3));
					return true;
				},
			});
			const enable = enableSession(deps(), authority, sid, async () => false);
			await new Promise((r) => setTimeout(r, i % 4));
			const disable = cli(sid);
			await Promise.allSettled([enable, disable]);
			const f = await final(sid);
			expect([i, f.requested, f.hash, f.revocation, f.nextSpawnHasToken]).toEqual([
				i,
				0,
				null,
				"session",
				false,
			]);
		}
	});
});
