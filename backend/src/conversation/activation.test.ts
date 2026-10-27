/**
 * activation.test.ts — docs/CONVERSATION.md §2.2 (byte-exact hooks file),
 * §2.4 (the requested/effective transition table) and the spawn-time
 * preparation. D1 is mocked at the module boundary; the files are real
 * (temp dir) because the contract is about what lands on disk.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbStubs = vi.hoisted(() => ({
	rows: { sessions: new Map<string, Record<string, unknown>>() },
	calls: [] as Array<{ sql: string; params: unknown[] }>,
	fail: false,
	d1Query: vi.fn(async (sql: string, params: unknown[] = []) => {
		dbStubs.calls.push({ sql, params });
		if (dbStubs.fail) throw new Error("D1 down");
		if (/^SELECT .* FROM sessions WHERE session_id/.test(sql)) {
			const row = dbStubs.rows.sessions.get(String(params[0]));
			return { results: row ? [row] : [], success: true, meta: {} };
		}
		if (/^UPDATE sessions SET/.test(sql)) {
			const sid = String(params[params.length - 1]);
			const row = dbStubs.rows.sessions.get(sid);
			if (!sql.includes("WHERE")) {
				// revokeAllIngestTokens: every row.
				for (const r of dbStubs.rows.sessions.values()) applyUpdate(r, sql, params);
				return { results: [], success: true, meta: { changes: dbStubs.rows.sessions.size } };
			}
			const changes = row ? applyUpdate(row, sql, params) : 0;
			return { results: [], success: true, meta: { changes } };
		}
		return { results: [], success: true, meta: {} };
	}),
	getD1CallsSinceBoot: () => 0,
	__resetD1CallsForTests: () => undefined,
}));
/** The real statements' semantics, incl. the `revocation_seq` guard (3.0d audit A1). Returns changes. */
function applyUpdate(row: Record<string, unknown>, sql: string, params: unknown[]): number {
	if (sql.includes("WHERE revocation_seq = ? AND") && (row.revocation_seq ?? 0) !== params[0]) {
		return 0;
	}
	if (sql.includes("revocation_seq = revocation_seq + 1")) {
		row.revocation_seq = Number(row.revocation_seq ?? 0) + 1;
	}
	if (sql.startsWith("UPDATE sessions SET conversation_requested = 1 WHERE")) {
		row.conversation_requested = 1;
	} else if (sql.includes("conversation_requested = ?")) row.conversation_requested = params[0];
	else if (sql.startsWith("UPDATE sessions SET ingest_token_hash = ? WHERE"))
		row.ingest_token_hash = params[0];
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
	return 1;
}
vi.mock("../db.js", () => dbStubs);

import { RecreateUnresolvedError } from "../recreateAttempt.js";
import {
	buildHooksSettings,
	ConversationDisabledError,
	disableAll,
	disableSession,
	enableAll,
	enableSession,
	hooksFileExists,
	hooksFilePath,
	MANAGED_MOUNT_TARGET,
	prepareSpawnCapture,
	purgeManagedDir,
	RevokedGloballyError,
	removeHooksFile,
	writeHooksFile,
} from "./activation.js";
import {
	CaptureAuthority,
	CONTROL_MOUNT_TARGET,
	type ContainerView,
	controlDir,
	relayEnabledPath,
} from "./captureAuth.js";
import { getSessionCapture, hashIngestToken } from "./registry.js";
import { checkRevocation, revokedAllPath, revokedPath } from "./revocation.js";

let root: string;
const deps = () => ({ workspaceRoot: root, enabled: true, port: 3001 });
function session(sid: string, patch: Record<string, unknown> = {}) {
	dbStubs.rows.sessions.set(sid, {
		status: "running",
		conversation_requested: 0,
		ingest_token_hash: null,
		ingest_token_hash_suspended: null,
		user_id: "u1",
		container_id: "cid1",
		...patch,
	});
	return dbStubs.rows.sessions.get(sid) as Record<string, unknown>;
}
const exists = (p: string) =>
	fs.stat(p).then(
		() => true,
		() => false,
	);

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-act-"));
	dbStubs.rows.sessions.clear();
	dbStubs.calls.length = 0;
	dbStubs.fail = false;
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

const IMG2 = { imageId: "sha256:img2", relay2: true };
const TOKEN = "a".repeat(64);

/** A container view as DockerManager.inspectCapture would report it. */
function view(patch: Partial<Extract<ContainerView, { exists: true }>> = {}): ContainerView {
	return {
		exists: true,
		running: true,
		token: TOKEN,
		managedMount: true,
		controlMount: true,
		imageId: "sha256:img2",
		imageRelay2: true,
		...patch,
	};
}

/** The real authority over a fake Docker; real files, mocked D1. */
function authority(opts: {
	container?: ContainerView;
	probe?: boolean;
	current?: { imageId: string; relay2: boolean } | null;
	unresolved?: boolean;
}) {
	const probe = vi.fn(async () => opts.probe ?? true);
	let clock = 0;
	const a = new CaptureAuthority({
		workspaceRoot: root,
		enabled: true,
		docker: {
			inspectCapture: async () => opts.container ?? { exists: false },
			currentImage: async () => (opts.current === undefined ? IMG2 : opts.current),
			probeRelay: probe,
		},
		getRow: (sid) => getSessionCapture(sid),
		checkRevocation: (sid) => checkRevocation(root, sid),
		isRecreateUnresolved: async () => opts.unresolved ?? false,
		writeHooksFile: (sid) => writeHooksFile(deps(), sid),
		removeHooksFile: (sid) => removeHooksFile(root, sid),
		hooksFileExists: (sid) => hooksFileExists(root, sid),
		now: () => clock,
		sleep: async (ms) => {
			clock += ms;
		},
	});
	const enable = (sid: string) =>
		enableSession(deps(), a, sid, async () => opts.unresolved ?? false);
	return { a, probe, enable };
}

async function plant(sid: string) {
	await fs.mkdir(path.dirname(hooksFilePath(root, sid)), { recursive: true });
	await fs.writeFile(hooksFilePath(root, sid), "x");
	await fs.mkdir(controlDir(root, sid), { recursive: true });
	await fs.writeFile(relayEnabledPath(root, sid), "");
}

describe("§2.2 hooks file", () => {
	it("is byte-exact: the contract's shape, order and HTTP block (relay on loopback, no token)", () => {
		const http = {
			type: "http",
			url: "http://127.0.0.1:47613/ingest/claude/hook",
			timeout: 1,
			headers: { "X-ST-Tmux-Pane": "$TMUX_PANE" },
			allowedEnvVars: ["TMUX_PANE"],
		};
		const plain = [{ hooks: [http] }];
		const matched = [{ matcher: "*", hooks: [http] }];
		const expected = `${JSON.stringify(
			{
				hooks: {
					SessionStart: [
						{
							hooks: [{ type: "command", command: "/opt/st/hooks/session-start.sh", async: true }],
						},
					],
					UserPromptSubmit: plain,
					MessageDisplay: plain,
					PreToolUse: matched,
					PostToolUse: matched,
					PostToolUseFailure: matched,
					Stop: plain,
					StopFailure: plain,
					SubagentStart: plain,
					SubagentStop: plain,
					Notification: plain,
					PermissionRequest: plain,
					PreCompact: plain,
					PostCompact: plain,
					TaskCreated: plain,
					TaskCompleted: plain,
					TeammateIdle: plain,
					SessionEnd: plain,
				},
			},
			null,
			2,
		)}\n`;
		expect(buildHooksSettings()).toBe(expected);
		// No hook may carry a decision field, and the async hook has no timeout.
		expect(expected).not.toMatch(/decision|continue|additionalContext/);
		// The credential never reaches the CLI's hook client (§2.2).
		expect(expected).not.toMatch(/ST_INGEST_TOKEN|Authorization|SESSION_ID/);
		expect(JSON.parse(expected).hooks.SessionStart[0].hooks[0]).not.toHaveProperty("timeout");
	});
});

describe("prepareSpawnCapture (§2.4 spawn row, §2.7.5 spawn preparation)", () => {
	it("flag off: no dir, no bind, no env, no D1 call", async () => {
		session("s1", { conversation_requested: 1 });
		const r = await prepareSpawnCapture({ ...deps(), enabled: false }, "s1", IMG2);
		expect(r).toEqual({ env: [], binds: [], effective: false });
		expect(await exists(path.join(root, ".claude-managed"))).toBe(false);
		expect(dbStubs.calls).toHaveLength(0);
	});
	it("flag on, not requested: empty managed dir mounted ro, no file, no marker, no token, no control mount", async () => {
		session("s1");
		const r = await prepareSpawnCapture(deps(), "s1", IMG2);
		expect(r.env).toEqual([]);
		expect(r.effective).toBe(false);
		expect(r.binds).toEqual([
			`${path.join(root, ".claude-managed", "s1")}:${MANAGED_MOUNT_TARGET}:ro`,
		]);
		expect(await fs.readdir(path.join(root, ".claude-managed", "s1"))).toEqual([]);
		expect(await exists(relayEnabledPath(root, "s1"))).toBe(false);
	});
	it("flag on, requested, image with the label: token + port in env, hash → marker → file, both mounts, image ID pinned", async () => {
		const row = session("s1", { conversation_requested: 1 });
		const r = await prepareSpawnCapture(deps(), "s1", IMG2);
		expect(r.effective).toBe(true);
		expect(r.imageId).toBe("sha256:img2");
		expect(r.env).toHaveLength(2);
		expect(r.env[1]).toBe("ST_BACKEND_PORT=3001");
		const token = r.env[0].replace("ST_INGEST_TOKEN=", "");
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		expect(row.ingest_token_hash).toBe(hashIngestToken(token));
		expect(await fs.readFile(hooksFilePath(root, "s1"), "utf8")).toBe(buildHooksSettings());
		expect(await exists(relayEnabledPath(root, "s1"))).toBe(true);
		expect((await fs.stat(controlDir(root, "s1"))).mode & 0o777).toBe(0o755);
		expect((await fs.stat(relayEnabledPath(root, "s1"))).mode & 0o777).toBe(0o644);
		expect(r.binds).toEqual([
			`${path.join(root, ".claude-managed", "s1")}:${MANAGED_MOUNT_TARGET}:ro`,
			`${controlDir(root, "s1")}:${CONTROL_MOUNT_TARGET}:ro`,
		]);
	});
	for (const [label, image] of [
		["without the relay label", { imageId: "sha256:old", relay2: false }],
		["that cannot be found", null],
	] as const) {
		it(`flag on, requested, current image ${label}: no capture at all (image-without-relay), old tokens cleared`, async () => {
			const row = session("s1", { conversation_requested: 1, ingest_token_hash: "old" });
			await plant("s1");
			const r = await prepareSpawnCapture(deps(), "s1", image);
			expect(r).toMatchObject({ env: [], effective: false });
			expect(r.imageId).toBeUndefined();
			expect(await exists(hooksFilePath(root, "s1"))).toBe(false);
			expect(await exists(relayEnabledPath(root, "s1"))).toBe(false);
			expect(row.ingest_token_hash).toBeNull();
		});
	}
	it("flag on, requested but revoked: no file, no marker, tokens cleared", async () => {
		const row = session("s1", { conversation_requested: 1, ingest_token_hash: "old" });
		await disableSession(deps(), "s1", "cli");
		const r = await prepareSpawnCapture(deps(), "s1", IMG2);
		expect(r.effective).toBe(false);
		expect(r.env).toEqual([]);
		expect(await exists(hooksFilePath(root, "s1"))).toBe(false);
		expect(await exists(relayEnabledPath(root, "s1"))).toBe(false);
		expect(row.ingest_token_hash).toBeNull();
	});
	it("the hooks-file write fails: no marker, no file, no hash left; the error propagates (spawn goes on without capture)", async () => {
		const row = session("s1", { conversation_requested: 1 });
		await fs.mkdir(hooksFilePath(root, "s1"), { recursive: true }); // rename target is a dir
		await expect(prepareSpawnCapture(deps(), "s1", IMG2)).rejects.toThrow();
		expect(await exists(relayEnabledPath(root, "s1"))).toBe(false);
		expect(row.ingest_token_hash).toBeNull();
	});
	for (const by of ["cli", "api"] as const) {
		it(`V1: a ${by} disable completing while the hooks file is being written leaves no emitter and no token`, async () => {
			session("s1", { conversation_requested: 1 });
			const realRename = fs.rename.bind(fs);
			let entered!: () => void;
			const inRename = new Promise<void>((r) => {
				entered = r;
			});
			let release!: () => void;
			const gate = new Promise<void>((r) => {
				release = r;
			});
			const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
				if (String(to).endsWith("conversation.json")) {
					entered();
					await gate;
				}
				return realRename(from, to);
			});
			try {
				const spawn = prepareSpawnCapture(deps(), "s1", IMG2);
				await inRename;
				// The marker is already on disk; the disable runs to completion
				// while the hooks-file rename is held.
				expect(await exists(relayEnabledPath(root, "s1"))).toBe(true);
				await disableSession(deps(), "s1", by);
				expect(await exists(relayEnabledPath(root, "s1"))).toBe(false);
				release();
				const r = await spawn;
				expect(r.effective).toBe(false);
				expect(r.env).toEqual([]);
				expect(r.imageId).toBeUndefined();
				expect(r.binds).toEqual([
					`${path.join(root, ".claude-managed", "s1")}:${MANAGED_MOUNT_TARGET}:ro`,
				]);
			} finally {
				spy.mockRestore();
			}
			expect(await exists(hooksFilePath(root, "s1"))).toBe(false);
			expect(await exists(relayEnabledPath(root, "s1"))).toBe(false);
		});
	}
	it("V1: a disable completing while the marker is being written: no marker, no hooks file, no token", async () => {
		session("s1", { conversation_requested: 1 });
		const realRename = fs.rename.bind(fs);
		const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (String(to).endsWith("relay.enabled")) {
				spy.mockImplementation((f, t) => realRename(f, t));
				await disableSession(deps(), "s1", "cli");
			}
			return realRename(from, to);
		});
		try {
			const r = await prepareSpawnCapture(deps(), "s1", IMG2);
			expect(r).toMatchObject({ env: [], effective: false });
		} finally {
			spy.mockRestore();
		}
		expect(await exists(hooksFilePath(root, "s1"))).toBe(false);
		expect(await exists(relayEnabledPath(root, "s1"))).toBe(false);
	});
	it("an existing 0700 control dir is brought to 0755 (explicit chmod, §2.1)", async () => {
		session("s1", { conversation_requested: 1 });
		await fs.mkdir(controlDir(root, "s1"), { recursive: true, mode: 0o700 });
		await fs.chmod(controlDir(root, "s1"), 0o700);
		await prepareSpawnCapture(deps(), "s1", IMG2);
		expect((await fs.stat(controlDir(root, "s1"))).mode & 0o777).toBe(0o755);
	});
});

describe("enable / disable (§2.4 table, §2.7.5)", () => {
	it("no container: requested=1, nothing written; effectiveAfterRestart only with the current image's label", async () => {
		const row = session("s1", { status: "stopped", container_id: null });
		const { enable } = authority({});
		const r = await enable("s1");
		expect(row.conversation_requested).toBe(1);
		expect(r.capture).toMatchObject({
			effective: false,
			effectiveAfterRestart: true,
			requiresRecreate: false,
		});
		expect(await exists(hooksFilePath(root, "s1"))).toBe(false);
		expect(await exists(relayEnabledPath(root, "s1"))).toBe(false);
		const r2 = await authority({ current: { imageId: "x", relay2: false } }).enable("s1");
		expect(r2.capture.effectiveAfterRestart).toBe(false);
		expect(r2.capture.pendingReasons).toContain("image-without-relay");
	});
	it("no container: residuals of a previous container are retired (the next spawn prepares from scratch)", async () => {
		session("s1", { status: "stopped", container_id: null });
		await plant("s1");
		await authority({}).enable("s1");
		expect(await exists(hooksFilePath(root, "s1"))).toBe(false);
		expect(await exists(relayEnabledPath(root, "s1"))).toBe(false);
	});
	it("running container WITHOUT a token: nothing written, residuals removed, requiresRecreate", async () => {
		session("s1");
		await plant("s1");
		const { enable, probe } = authority({ container: view({ token: null }) });
		const r = await enable("s1");
		expect(r.capture).toMatchObject({
			effective: false,
			effectiveAfterRestart: false,
			requiresRecreate: true,
		});
		expect(r.capture.pendingReasons).toContain("container-without-capture");
		expect(await exists(hooksFilePath(root, "s1"))).toBe(false);
		expect(await exists(relayEnabledPath(root, "s1"))).toBe(false);
		expect(probe).not.toHaveBeenCalled();
	});
	it("3.0c-created container (token, managed mount, NO control mount): no repair in place, residual file removed (K3)", async () => {
		session("s1", { conversation_requested: 1, ingest_token_hash: hashIngestToken(TOKEN) });
		await plant("s1");
		for (const running of [true, false]) {
			const { enable } = authority({ container: view({ controlMount: false, running }) });
			const r = await enable("s1");
			expect(r.capture).toMatchObject({
				effective: false,
				effectiveAfterRestart: false,
				requiresRecreate: true,
			});
			expect(await exists(hooksFilePath(root, "s1"))).toBe(false);
			expect(await exists(relayEnabledPath(root, "s1"))).toBe(false);
		}
	});
	it("token-mismatch (old hash in D1, new token in the container): nothing written, the fingerprint is NOT copied (A3)", async () => {
		const row = session("s1", { conversation_requested: 1, ingest_token_hash: "old-hash" });
		for (const running of [true, false]) {
			const { enable, probe } = authority({ container: view({ running }) });
			const r = await enable("s1");
			expect(r.capture).toMatchObject({
				effective: false,
				effectiveAfterRestart: false,
				requiresRecreate: true,
			});
			expect(r.capture.pendingReasons).toContain("token-mismatch");
			expect(row.ingest_token_hash).toBe("old-hash");
			expect(await exists(hooksFilePath(root, "s1"))).toBe(false);
			expect(await exists(relayEnabledPath(root, "s1"))).toBe(false);
			expect(probe).not.toHaveBeenCalled();
		}
	});
	it("disable on a running container: revocation marker → D1 (hash suspended) → hooks file → relay.enabled removed", async () => {
		const row = session("s1", { conversation_requested: 1, ingest_token_hash: "h1" });
		await plant("s1");
		const r = await disableSession(deps(), "s1", "api");
		expect(r).toEqual({ enabled: false, emissionStopsAfterRestart: true });
		expect(row.ingest_token_hash).toBeNull();
		expect(row.ingest_token_hash_suspended).toBe("h1");
		expect(row.conversation_requested).toBe(0);
		expect(await exists(hooksFilePath(root, "s1"))).toBe(false);
		expect(await exists(relayEnabledPath(root, "s1"))).toBe(false);
		expect(await checkRevocation(root, "s1")).toBe("session");
	});
	it("re-enable on the running container: suspended hash restored, marker → relay identified → file; effective with checkedAt", async () => {
		const row = session("s1", {
			conversation_requested: 1,
			ingest_token_hash: hashIngestToken(TOKEN),
		});
		await disableSession(deps(), "s1", "api");
		const { enable, probe } = authority({ container: view() });
		const r = await enable("s1");
		expect(row.ingest_token_hash).toBe(hashIngestToken(TOKEN));
		expect(row.ingest_token_hash_suspended).toBeNull();
		expect(await checkRevocation(root, "s1")).toBe("none");
		expect(await fs.readFile(hooksFilePath(root, "s1"), "utf8")).toBe(buildHooksSettings());
		expect(await exists(relayEnabledPath(root, "s1"))).toBe(true);
		expect(r.capture).toMatchObject({
			requested: true,
			effective: true,
			requiresRecreate: false,
			pendingReasons: [],
		});
		expect(typeof r.capture.checkedAt).toBe("string");
		expect(probe).toHaveBeenCalled();
	});
	it("relay that never identifies: marker removed, NO hooks file, relay-unavailable (no hooks against a closed port)", async () => {
		session("s1", { conversation_requested: 1, ingest_token_hash: hashIngestToken(TOKEN) });
		const { enable, probe } = authority({ container: view(), probe: false });
		const r = await enable("s1");
		expect(await exists(hooksFilePath(root, "s1"))).toBe(false);
		expect(await exists(relayEnabledPath(root, "s1"))).toBe(false);
		expect(r.capture.effective).toBe(false);
		expect(r.capture.pendingReasons).toContain("hooks-file-missing");
		// Polled until the 5 s deadline (fake clock), then gave up.
		expect(probe.mock.calls.length).toBeGreaterThan(5);
	});
	it("stopped container with correspondence: nothing written; retained config kept; effectiveAfterRestart follows it", async () => {
		session("s1", { conversation_requested: 1, ingest_token_hash: hashIngestToken(TOKEN) });
		const { enable } = authority({ container: view({ running: false }) });
		const r = await enable("s1");
		expect(await exists(hooksFilePath(root, "s1"))).toBe(false);
		expect(r.capture).toMatchObject({ effectiveAfterRestart: false, requiresRecreate: false });
		expect(r.capture.pendingReasons).toEqual(
			expect.arrayContaining(["stopped", "hooks-file-missing"]),
		);
		await plant("s1");
		const r2 = await enable("s1");
		expect(await exists(hooksFilePath(root, "s1"))).toBe(true);
		expect(r2.capture).toMatchObject({ effective: false, effectiveAfterRestart: true });
	});
	it("an unresolved recreation refuses enable", async () => {
		session("s1");
		await expect(authority({ unresolved: true }).enable("s1")).rejects.toBeInstanceOf(
			RecreateUnresolvedError,
		);
	});
	it("emergency CLI disable with D1 down: marker stays, files stay, error propagates", async () => {
		session("s1", { conversation_requested: 1, ingest_token_hash: "h1" });
		await plant("s1");
		dbStubs.fail = true;
		await expect(disableSession(deps(), "s1", "cli")).rejects.toThrow("D1 down");
		expect(await exists(revokedPath(root, "s1"))).toBe(true);
		expect(await exists(hooksFilePath(root, "s1"))).toBe(true);
		expect(await exists(relayEnabledPath(root, "s1"))).toBe(true);
	});
	it("emergency CLI disable (healthy) revokes both hashes, requested=0, removes file and marker", async () => {
		const row = session("s1", {
			conversation_requested: 1,
			ingest_token_hash: "h1",
			ingest_token_hash_suspended: "h0",
		});
		await plant("s1");
		await disableSession(deps(), "s1", "cli", "incident");
		expect(row).toMatchObject({
			conversation_requested: 0,
			ingest_token_hash: null,
			ingest_token_hash_suspended: null,
		});
		const marker = JSON.parse(await fs.readFile(revokedPath(root, "s1"), "utf8"));
		expect(marker).toMatchObject({ by: "cli", reason: "incident" });
		expect(await exists(relayEnabledPath(root, "s1"))).toBe(false);
	});
	it("disable --all writes the global marker and removes every hooks file and relay marker; enable-all removes only the global marker", async () => {
		for (const sid of ["a", "b"]) await plant(sid);
		// "c" has only a marker left (crash between marker and hooks file).
		await fs.mkdir(controlDir(root, "c"), { recursive: true });
		await fs.writeFile(relayEnabledPath(root, "c"), "");
		const removed = await disableAll(deps());
		expect(removed.sort()).toEqual(["a", "b", "c"]);
		for (const sid of ["a", "b"]) expect(await exists(relayEnabledPath(root, sid))).toBe(false);
		expect(await exists(revokedAllPath(root))).toBe(true);
		expect(
			dbStubs.calls.some(
				(c) =>
					c.sql.startsWith(
						"UPDATE sessions SET ingest_token_hash = NULL, ingest_token_hash_suspended = NULL, conversation_requested = 0",
					) && c.params.length === 0,
			),
		).toBe(true);
		session("a", { container_id: null });
		await expect(authority({}).enable("a")).rejects.toBeInstanceOf(RevokedGloballyError);
		await enableAll(deps());
		expect(await exists(revokedAllPath(root))).toBe(false);
		await expect(authority({}).enable("a")).resolves.toMatchObject({ enabled: true });
	});
	it("enable with the flag off is refused", async () => {
		session("s1");
		const a = authority({}).a;
		await expect(
			enableSession({ ...deps(), enabled: false }, a, "s1", async () => false),
		).rejects.toBeInstanceOf(ConversationDisabledError);
	});
});

describe("purge", () => {
	it("purgeManagedDir refuses anything outside .claude-managed", async () => {
		session("s1", { conversation_requested: 1 });
		await prepareSpawnCapture(deps(), "s1", IMG2);
		await purgeManagedDir(root, "s1");
		expect(await exists(path.join(root, ".claude-managed", "s1"))).toBe(false);
		await expect(purgeManagedDir(root, "../etc")).rejects.toThrow(/refusing/);
		await expect(purgeManagedDir(root, "a/b")).rejects.toThrow(/refusing/);
	});
});
