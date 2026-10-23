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
			if (row) applyUpdate(row, sql, params);
			return { results: [], success: true, meta: {} };
		}
		return { results: [], success: true, meta: {} };
	}),
	getD1CallsSinceBoot: () => 0,
	__resetD1CallsForTests: () => undefined,
}));
function applyUpdate(row: Record<string, unknown>, sql: string, params: unknown[]) {
	if (sql.includes("conversation_requested = ?")) row.conversation_requested = params[0];
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
}
vi.mock("../db.js", () => dbStubs);

import {
	buildHooksSettings,
	ConversationDisabledError,
	captureStatus,
	disableAll,
	disableSession,
	enableAll,
	enableSession,
	hooksFilePath,
	MANAGED_MOUNT_TARGET,
	prepareSpawnCapture,
	purgeManagedDir,
	RevokedGloballyError,
} from "./activation.js";
import { hashIngestToken } from "./registry.js";
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

describe("prepareSpawnCapture (§2.4 spawn row)", () => {
	it("flag off: no dir, no bind, no env, no D1 call", async () => {
		session("s1", { conversation_requested: 1 });
		const r = await prepareSpawnCapture({ ...deps(), enabled: false }, "s1");
		expect(r).toEqual({ env: [], binds: [], effective: false });
		expect(await exists(path.join(root, ".claude-managed"))).toBe(false);
		expect(dbStubs.calls).toHaveLength(0);
	});
	it("flag on, not requested: empty managed dir mounted ro, no file, no token", async () => {
		session("s1");
		const r = await prepareSpawnCapture(deps(), "s1");
		expect(r.env).toEqual([]);
		expect(r.effective).toBe(false);
		expect(r.binds).toEqual([
			`${path.join(root, ".claude-managed", "s1")}:${MANAGED_MOUNT_TARGET}:ro`,
		]);
		expect(await fs.readdir(path.join(root, ".claude-managed", "s1"))).toEqual([]);
	});
	it("flag on, requested: 64-hex token + backend port in env, hash in D1 (written before the file), byte-exact file", async () => {
		const row = session("s1", { conversation_requested: 1 });
		const r = await prepareSpawnCapture(deps(), "s1");
		expect(r.effective).toBe(true);
		expect(r.env).toHaveLength(2);
		expect(r.env[1]).toBe("ST_BACKEND_PORT=3001");
		const token = r.env[0].replace("ST_INGEST_TOKEN=", "");
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		expect(row.ingest_token_hash).toBe(hashIngestToken(token));
		expect(await fs.readFile(hooksFilePath(root, "s1"), "utf8")).toBe(buildHooksSettings());
		const hashCall = dbStubs.calls.findIndex((c) =>
			c.sql.startsWith("UPDATE sessions SET ingest_token_hash = ?"),
		);
		expect(hashCall).toBeGreaterThanOrEqual(0);
	});
	it("flag on, requested but revoked: no file, tokens cleared", async () => {
		const row = session("s1", { conversation_requested: 1, ingest_token_hash: "old" });
		await disableSession(deps(), "s1", "cli");
		const r = await prepareSpawnCapture(deps(), "s1");
		expect(r.effective).toBe(false);
		expect(r.env).toEqual([]);
		expect(await exists(hooksFilePath(root, "s1"))).toBe(false);
		expect(row.ingest_token_hash).toBeNull();
	});
});

describe("enable / disable (§2.4 table)", () => {
	it("enable on a stopped session: requested=1, nothing effective until start", async () => {
		const row = session("s1", { status: "stopped" });
		const r = await enableSession(deps(), "s1", false);
		expect(r).toEqual({ enabled: true, effective: false, effectiveAfterRestart: true });
		expect(row.conversation_requested).toBe(1);
		expect(await exists(hooksFilePath(root, "s1"))).toBe(false);
	});
	it("enable on a running container WITHOUT a token: no file is written", async () => {
		session("s1");
		const r = await enableSession(deps(), "s1", true);
		expect(r.effective).toBe(false);
		expect(r.effectiveAfterRestart).toBe(true);
		expect(await exists(hooksFilePath(root, "s1"))).toBe(false);
	});
	it("disable on a running container with a token: marker → D1 (hash suspended) → file removed; ingest cut immediately", async () => {
		const row = session("s1", { conversation_requested: 1, ingest_token_hash: "h1" });
		await fs.mkdir(path.dirname(hooksFilePath(root, "s1")), { recursive: true });
		await fs.writeFile(hooksFilePath(root, "s1"), "x");
		const r = await disableSession(deps(), "s1", "api");
		expect(r.enabled).toBe(false);
		expect(row.ingest_token_hash).toBeNull();
		expect(row.ingest_token_hash_suspended).toBe("h1");
		expect(row.conversation_requested).toBe(0);
		expect(await exists(hooksFilePath(root, "s1"))).toBe(false);
		expect(await checkRevocation(root, "s1")).toBe("session");
	});
	it("re-enable on the running container restores the suspended hash, removes the marker and rewrites the file", async () => {
		const row = session("s1", { conversation_requested: 1, ingest_token_hash: "h1" });
		await disableSession(deps(), "s1", "api");
		const r = await enableSession(deps(), "s1", true);
		expect(r).toEqual({ enabled: true, effective: true, effectiveAfterRestart: false });
		expect(row.ingest_token_hash).toBe("h1");
		expect(row.ingest_token_hash_suspended).toBeNull();
		expect(await checkRevocation(root, "s1")).toBe("none");
		expect(await fs.readFile(hooksFilePath(root, "s1"), "utf8")).toBe(buildHooksSettings());
	});
	it("emergency CLI disable with D1 down: marker stays, file stays, error propagates", async () => {
		session("s1", { conversation_requested: 1, ingest_token_hash: "h1" });
		await fs.mkdir(path.dirname(hooksFilePath(root, "s1")), { recursive: true });
		await fs.writeFile(hooksFilePath(root, "s1"), "x");
		dbStubs.fail = true;
		await expect(disableSession(deps(), "s1", "cli")).rejects.toThrow("D1 down");
		expect(await exists(revokedPath(root, "s1"))).toBe(true);
		expect(await exists(hooksFilePath(root, "s1"))).toBe(true);
	});
	it("emergency CLI disable (healthy) revokes both hashes and requested=0 persistently", async () => {
		const row = session("s1", {
			conversation_requested: 1,
			ingest_token_hash: "h1",
			ingest_token_hash_suspended: "h0",
		});
		await disableSession(deps(), "s1", "cli", "incident");
		expect(row).toMatchObject({
			conversation_requested: 0,
			ingest_token_hash: null,
			ingest_token_hash_suspended: null,
		});
		const marker = JSON.parse(await fs.readFile(revokedPath(root, "s1"), "utf8"));
		expect(marker).toMatchObject({ by: "cli", reason: "incident" });
	});
	it("disable --all writes the global marker and removes every hooks file; enable-all removes only the marker", async () => {
		for (const sid of ["a", "b"]) {
			await fs.mkdir(path.dirname(hooksFilePath(root, sid)), { recursive: true });
			await fs.writeFile(hooksFilePath(root, sid), "x");
		}
		const removed = await disableAll(deps());
		expect(removed.sort()).toEqual(["a", "b"]);
		expect(await exists(revokedAllPath(root))).toBe(true);
		expect(
			dbStubs.calls.some(
				(c) =>
					c.sql.startsWith(
						"UPDATE sessions SET ingest_token_hash = NULL, ingest_token_hash_suspended = NULL, conversation_requested = 0",
					) && c.params.length === 0,
			),
		).toBe(true);
		session("a");
		await expect(enableSession(deps(), "a", false)).rejects.toBeInstanceOf(RevokedGloballyError);
		await enableAll(deps());
		expect(await exists(revokedAllPath(root))).toBe(false);
		await expect(enableSession(deps(), "a", false)).resolves.toMatchObject({ enabled: true });
	});
	it("enable with the flag off is refused", async () => {
		session("s1");
		await expect(enableSession({ ...deps(), enabled: false }, "s1", false)).rejects.toBeInstanceOf(
			ConversationDisabledError,
		);
	});
});

describe("captureStatus / purge", () => {
	it("reports requested vs effective honestly", async () => {
		session("s1", { conversation_requested: 1, ingest_token_hash: "h" });
		expect(await captureStatus(deps(), "s1")).toEqual({
			requested: true,
			effective: false,
			effectiveAfterRestart: true,
		});
		await prepareSpawnCapture(deps(), "s1");
		expect(await captureStatus(deps(), "s1")).toEqual({
			requested: true,
			effective: true,
			effectiveAfterRestart: false,
		});
		expect(await captureStatus({ ...deps(), enabled: false }, "s1")).toEqual({
			requested: false,
			effective: false,
			effectiveAfterRestart: false,
		});
	});
	it("purgeManagedDir refuses anything outside .claude-managed", async () => {
		session("s1", { conversation_requested: 1 });
		await prepareSpawnCapture(deps(), "s1");
		await purgeManagedDir(root, "s1");
		expect(await exists(path.join(root, ".claude-managed", "s1"))).toBe(false);
		await expect(purgeManagedDir(root, "../etc")).rejects.toThrow(/refusing/);
		await expect(purgeManagedDir(root, "a/b")).rejects.toThrow(/refusing/);
	});
});
