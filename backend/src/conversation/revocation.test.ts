/**
 * revocation.test.ts — docs/CONVERSATION.md §2.5, the two-process
 * regression: the receiver (this process) has its token cache populated
 * by an accepted event; the emergency command runs in a REAL child
 * process (`tsx`, executing `runCli` from cli.ts with an injected D1);
 * the event sent immediately after the command returns — no wait, no
 * cache expiry — must be rejected with `reason=revoked`. Repeated 100×
 * to cover the interleaving. Variants: D1 down (marker stays, file
 * stays, exit ≠ 0) and a populated queue (persisted + one gap revoked).
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileP = promisify(execFile);

const dbStubs = vi.hoisted(() => ({
	owners: new Map<string, string>(),
	row: {
		status: "running",
		conversation_requested: 1,
		ingest_token_hash: "",
		ingest_token_hash_suspended: null as string | null,
		user_id: "u1",
	},
	d1Query: vi.fn(async (sql: string, params: unknown[] = []) => {
		if (/^SELECT .* FROM sessions WHERE session_id/.test(sql) && params[0] === "s1") {
			return { results: [dbStubs.row], success: true, meta: {} };
		}
		if (/^INSERT OR IGNORE INTO claude_conversations/.test(sql)) {
			if (!dbStubs.owners.has(String(params[0])))
				dbStubs.owners.set(String(params[0]), String(params[1]));
			return { results: [], success: true, meta: {} };
		}
		if (/^SELECT st_session_id FROM claude_conversations/.test(sql)) {
			const owner = dbStubs.owners.get(String(params[0]));
			return { results: owner ? [{ st_session_id: owner }] : [], success: true, meta: {} };
		}
		return { results: [], success: true, meta: {} };
	}),
	getD1CallsSinceBoot: () => 0,
	__resetD1CallsForTests: () => undefined,
}));
vi.mock("../db.js", () => dbStubs);

import { hooksFilePath } from "./activation.js";
import { generateIngestToken, hashIngestToken } from "./registry.js";
import { checkRevocation, revokedPath } from "./revocation.js";
import { ConversationService } from "./service.js";
import { ConversationStore } from "./store.js";

let root: string;
let store: ConversationStore;
let service: ConversationService;
const TOKEN = generateIngestToken();
const H = { authorization: `Bearer ${TOKEN}`, stSession: "s1", tmuxPane: "%0" };
const hook = (name: string, body: Record<string, unknown> = {}) => ({
	hook_event_name: name,
	session_id: "c1",
	cwd: "/w",
	...body,
});

/**
 * Run the real `runCli` in a child process (`tsx child.mts` with a fetch
 * stub injected through NODE_OPTIONS=--import). The stub replaces `globalThis.fetch`, which is what
 * `db.ts` uses to reach D1, so the production `d1Query` path executes
 * end to end; `D1_STUB=ok|fail` selects a healthy or failing D1.
 */
async function runCliInChild(
	args: string[],
	d1: "ok" | "fail",
): Promise<{ code: number; stdout: string; stderr: string }> {
	const fetchStub = path.join(root, "fetch-stub.mjs");
	await fs.writeFile(
		fetchStub,
		`globalThis.fetch = async () => {
			const body = process.env.D1_STUB === "fail"
				? { success: false, errors: [{ message: "D1 down" }], result: [] }
				: { success: true, errors: [], result: [{ results: [], success: true, meta: {} }] };
			return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
		};`,
	);
	const child = path.join(root, "child.mts");
	await fs.writeFile(
		child,
		`const { runCli } = await import(${JSON.stringify(path.resolve(__dirname, "cli.ts"))});
		const code = await runCli(${JSON.stringify(args)}, {
			workspaceRoot: ${JSON.stringify(root)},
			enabled: true,
			port: 3001,
			stdout: (l) => console.log(l),
			stderr: (l) => console.error(l),
		});
		process.exit(code);`,
	);
	const tsxCli = require.resolve("tsx/cli");
	try {
		const { stdout, stderr } = await execFileP(process.execPath, [tsxCli, child], {
			cwd: path.resolve(__dirname, "../.."),
			env: {
				...process.env,
				// tsx re-spawns node for the script, so a plain `--import` on
				// the outer process would be dropped; NODE_OPTIONS is inherited.
				NODE_OPTIONS: `--import ${fetchStub}`,
				NODE_ENV: "test",
				D1_STUB: d1,
				CLOUDFLARE_ACCOUNT_ID: "acc",
				CLOUDFLARE_API_TOKEN: "tok",
				D1_DATABASE_ID: "db",
			},
			timeout: 60_000,
		});
		return { code: 0, stdout, stderr };
	} catch (err) {
		const e = err as { code?: number; stdout?: string; stderr?: string };
		return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
	}
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "st-revoke-"));
	dbStubs.row.ingest_token_hash = hashIngestToken(TOKEN);
	dbStubs.row.conversation_requested = 1;
	store = new ConversationStore({ workspaceRoot: root });
	service = new ConversationService({ workspaceRoot: root, enabled: true, port: 3001, store });
	await fs.mkdir(path.dirname(hooksFilePath(root, "s1")), { recursive: true });
	await fs.writeFile(hooksFilePath(root, "s1"), "x");
});
afterEach(async () => {
	await service.shutdown();
	await fs.rm(root, { recursive: true, force: true });
});

async function acceptOne(prompt = "warm") {
	const auth = await service.authorize(H);
	expect(auth).toEqual({ ok: true, stSessionId: "s1" });
	const r = await service.ingest(
		"s1",
		"%0",
		hook("UserPromptSubmit", { prompt, prompt_id: `p-${prompt}` }),
	);
	expect(r).toMatchObject({ accepted: true });
}

describe("§2.5 two-process revocation", () => {
	it("D1 healthy: the event sent immediately after the command returns is rejected (×100, no waiting)", async () => {
		await acceptOne();
		const r = await runCliInChild(["disable", "s1"], "ok");
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("revoked s1");
		for (let i = 0; i < 100; i++) {
			// Authorisation from the (still populated) token cache, then the
			// marker stat as the last step: must reject every single time.
			const auth = await service.authorize(H);
			expect(auth).toEqual({ ok: true, stSessionId: "s1" });
			const out = await service.ingest(
				"s1",
				"%0",
				hook("Stop", {
					prompt_id: "p-warm",
					stop_hook_active: false,
					last_assistant_message: `r${i}`,
				}),
			);
			expect(out).toEqual({ accepted: false, reason: "revoked" });
		}
		expect(await checkRevocation(root, "s1")).toBe("session");
		await expect(fs.stat(hooksFilePath(root, "s1"))).rejects.toThrow();
	}, 90_000);

	it("D1 down: command exits ≠ 0, marker stays, file stays until the receiver converges", async () => {
		await acceptOne();
		const r = await runCliInChild(["disable", "s1"], "fail");
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain("D1 down");
		expect(r.stderr).toContain("marker left in place");
		await fs.stat(revokedPath(root, "s1"));
		await fs.stat(hooksFilePath(root, "s1"));
		const out = await service.ingest(
			"s1",
			"%0",
			hook("Stop", { prompt_id: "p-warm", stop_hook_active: false }),
		);
		expect(out).toEqual({ accepted: false, reason: "revoked" });
		// The receiver removed the orphaned hooks file on its own.
		await expect(fs.stat(hooksFilePath(root, "s1"))).rejects.toThrow();
	}, 90_000);

	it("populated queue: events authorised before the rename persist, followed by exactly one gap revoked", async () => {
		await acceptOne("one");
		await service.ingest(
			"s1",
			"%0",
			hook("UserPromptSubmit", { prompt: "two", prompt_id: "p-two" }),
		);
		const r = await runCliInChild(["disable", "s1"], "ok");
		expect(r.code).toBe(0);
		await service.ingest(
			"s1",
			"%0",
			hook("UserPromptSubmit", { prompt: "three", prompt_id: "p-three" }),
		);
		await service.ingest(
			"s1",
			"%0",
			hook("UserPromptSubmit", { prompt: "four", prompt_id: "p-four" }),
		);
		await store.flush("s1", "c1");
		const lines = (await fs.readFile(store.eventsPath("s1", "c1"), "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		expect(lines.map((l) => l.ev)).toEqual(["user_prompt", "user_prompt", "gap"]);
		expect(lines[2].data).toEqual({ reason: "revoked" });
	}, 90_000);

	it("the global marker is written by --all and removed only by enable-all", async () => {
		await acceptOne();
		const r = await runCliInChild(["disable", "--all"], "ok");
		expect(r.code).toBe(0);
		expect(await checkRevocation(root, "s1")).toBe("global");
		expect(await service.ingest("s1", "%0", hook("Stop", { stop_hook_active: false }))).toEqual({
			accepted: false,
			reason: "revoked",
		});
		const r2 = await runCliInChild(["enable-all"], "ok");
		expect(r2.code).toBe(0);
		expect(await checkRevocation(root, "s1")).toBe("none");
	}, 90_000);
});
