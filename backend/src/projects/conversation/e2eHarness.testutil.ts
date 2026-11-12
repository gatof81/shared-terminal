/**
 * e2eHarness.testutil.ts — the REAL project-conversation backend (D1,
 * PROJECT_CONVERSATION.md §3–§5) on a local port, for the frontend's
 * integration e2e (frontend/e2e/workspace-real.spec.ts). Test-only: never
 * built (`*.testutil.ts` is excluded from tsc), never imported by the app.
 *
 * Real: ProjectConversationStore (on a temp WORKSPACE_ROOT, with its
 * writer lock), ProjectFanout, ReplyWatcher, ProjectConversationApi and the
 * Express routes of routes/projectConversation.ts behind the real
 * requireAuth (JWT cookie). Faked, because they are other subsystems: the
 * D1 directory (bindings, ownership), each agent's capture (events in
 * memory, served at the same capture route the Chat view uses) and the
 * Composer (a scripted answer per session; a delivered send writes the
 * user_prompt into that capture, like the CLI would).
 *
 * Control endpoints under /__harness/ let the spec end an agent's turn
 * (turn_end with its text) and script the Composer's next answers.
 *
 * Run: `npx tsx src/projects/conversation/e2eHarness.testutil.ts` with
 * HARNESS_CONFIG='{"projectId", "ownerUserId", "username", "agents":
 * [{"agentId","sessionId"}]}'. It prints one JSON line {port, token}.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { signCliToken, validateJwtSecret } from "../../auth.js";
import type { HttpResult } from "../../conversation/composer.js";
import type { PersistedEvent } from "../../conversation/store.js";
import { registerProjectConversationRoutes } from "../../routes/projectConversation.js";
import type { RouteContext } from "../../routes/shared.js";
import { ProjectConversationApi } from "./api.js";
import { type ProjectBindings, ProjectFanout } from "./fanout.js";
import { ReplyWatcher } from "./replies.js";
import { ProjectConversationStore } from "./store.js";

interface Config {
	projectId: string;
	ownerUserId: string;
	username: string;
	agents: Array<{ agentId: string; sessionId: string }>;
	/** The settle window (§4.1); production is 10 s, the spec shortens it. */
	settleMs?: number;
}

const cfg = JSON.parse(process.env.HARNESS_CONFIG ?? "{}") as Config;
const cidOf = (sid: string) => `c-${sid.slice(0, 8)}`;

async function main(): Promise<void> {
	process.env.JWT_SECRET ??= "e2e-harness-secret-not-for-production";
	validateJwtSecret();
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "st-e2e-project-"));
	const store = await ProjectConversationStore.start({ workspaceRoot: root, bootId: "e2e" });
	if (store.unavailable) throw new Error("store unavailable (writer lock?)");

	// ── Captures (per session's single conversation) ──
	const captures = new Map<string, PersistedEvent[]>();
	const listeners = new Set<(sid: string, cid: string, ev: PersistedEvent) => void>();
	const capture = (sid: string) => {
		let c = captures.get(sid);
		if (!c) {
			c = [];
			captures.set(sid, c);
		}
		return c;
	};
	const emit = (sid: string, ev: string, o: Partial<PersistedEvent> = {}): PersistedEvent => {
		const c = capture(sid);
		const e = {
			seq: c.length + 1,
			ts: new Date().toISOString(),
			ev,
			prompt_id: null,
			turn_id: null,
			agent_id: null,
			pane: "%1",
			data: {},
			...o,
		} as PersistedEvent;
		c.push(e);
		for (const l of listeners) l(sid, cidOf(sid), e);
		return e;
	};

	// ── Composer: scripted per session ──
	const script = new Map<string, Array<{ status: number; error?: string }>>();
	let prompts = 0;
	const lastPrompt = new Map<string, string>();

	const replies = new ReplyWatcher({
		store,
		onCaptureEvent: (l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		readCapture: async (sid, _cid, after) => capture(sid).filter((e) => e.seq > after),
		bootAt: Date.now() - 1000,
		settleMs: cfg.settleMs ?? 300,
	});
	const bindings = (): ProjectBindings =>
		new Map(
			cfg.agents.map((a) => [
				a.agentId,
				{
					removed: false,
					binding: { bindingId: `bind-${a.agentId}`, epoch: 1, sessionId: a.sessionId },
				},
			]),
		);
	const fanout = new ProjectFanout({
		store,
		bindings: async (owner, pid) =>
			owner === cfg.ownerUserId && pid === cfg.projectId ? bindings() : null,
		target: async (sid) => ({ kind: "ok", cid: cidOf(sid) }),
		sessionMeta: async () => ({ userId: cfg.ownerUserId }),
		composerSend: async (input): Promise<HttpResult> => {
			const next = script.get(input.stSessionId)?.shift();
			if (next && next.status !== 202) return { status: next.status, body: { error: next.error } };
			const promptId = `p-${++prompts}`;
			lastPrompt.set(input.stSessionId, promptId);
			const up = emit(input.stSessionId, "user_prompt", {
				prompt_id: promptId,
				data: { prompt: input.body.text },
			});
			return { status: 202, body: { result: "delivered", promptId, seq: up.seq } };
		},
		onDelivered: (d) => replies.watch(d),
		onUncertain: (d) => replies.watchUncertain(d),
	});
	const api = new ProjectConversationApi({
		store,
		fanout,
		ownsProject: async (owner, pid) => owner === cfg.ownerUserId && pid === cfg.projectId,
	});
	const noLimit: express.RequestHandler = (_q, _s, next) => next();
	const ctx = {
		projects: {} as RouteContext["projects"],
		projectConversation: { api },
		limiters: new Proxy({}, { get: () => noLimit }),
	} as unknown as RouteContext;

	const app = express();
	app.use(express.json({ limit: "1mb" }));
	const router = express.Router();
	registerProjectConversationRoutes(router, ctx);
	// The capture route the Chat view also reads (a reply's text, §4.1).
	router.get("/sessions/:sid/conversations/:cid/events/:seq", (req, res) => {
		const e = capture(req.params.sid).find((x) => x.seq === Number(req.params.seq));
		if (!e || req.params.cid !== cidOf(req.params.sid))
			return void res.status(404).json({ error: "not-found" });
		res.json(e);
	});
	app.use("/api", router);

	// ── Control ──
	app.post("/__harness/turn_end", (req, res) => {
		const { sessionId, text } = req.body as { sessionId: string; text: string };
		const p = lastPrompt.get(sessionId);
		if (!p) return void res.status(409).json({ error: "no prompt" });
		emit(sessionId, "turn_end", { prompt_id: p, data: { last_assistant_message: text } });
		res.json({ ok: true });
	});
	app.post("/__harness/composer", (req, res) => {
		const { sessionId, answers } = req.body as {
			sessionId: string;
			answers: Array<{ status: number; error?: string }>;
		};
		script.set(sessionId, answers);
		res.json({ ok: true });
	});
	app.get("/__harness/log", async (_req, res) => {
		res.json((await store.view(cfg.projectId)).lines);
	});

	const server = app.listen(0, "127.0.0.1", () => {
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		process.stdout.write(
			`${JSON.stringify({ port, token: signCliToken(cfg.ownerUserId, cfg.username) })}\n`,
		);
	});
	const stop = async () => {
		replies.stop();
		server.close();
		await store.close();
		await fs.rm(root, { recursive: true, force: true });
		process.exit(0);
	};
	process.on("SIGTERM", () => void stop());
	process.on("SIGINT", () => void stop());
}

main().catch((err) => {
	process.stderr.write(`harness failed: ${(err as Error).stack}\n`);
	process.exit(1);
});
