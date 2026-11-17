/**
 * routes/acp.ts — ACP agents API (experimental, ACP_AGENTS_ENABLED), mounted at
 * /api/acp. Two callers, one API:
 *
 * - the person (cookie, `requireAuth`): lists their agents, reads a feed,
 *   sends messages, requeues an `uncertain` one;
 * - an agent's runner and the `st` CLI inside its container
 *   (`Authorization: Bearer acp1.…`): claims, results, activity, and the same
 *   `POST /messages` the person uses — the sender is always the credential,
 *   never the body.
 *
 * The body parser is this router's own: a message is limited by
 * ACP_MESSAGE_MAX_BYTES (provider-neutral, larger content goes as an
 * attachment), not by the global 100 KB JSON default.
 */

import express, { type NextFunction, type Request, type Response, Router } from "express";
import type { AcpAgents, AgentRow } from "../acp/agents.js";
import { type AuthedRequest, requireAuth } from "../auth.js";
import { logger } from "../logger.js";
import type { SessionManager } from "../sessionManager.js";

type Caller = { kind: "owner"; userId: string } | { kind: "agent"; agent: AgentRow };

declare module "express-serve-static-core" {
	interface Locals {
		acpCaller?: Caller;
	}
}

export function buildAcpRouter(acp: AcpAgents, sessions: SessionManager): Router {
	const router = Router();
	router.use(express.json({ limit: acp.config.maxMessageBytes + 64 * 1024 }));

	// Bearer acp1.* ⇒ agent; anything else ⇒ the cookie session.
	const identify = async (req: Request, res: Response, next: NextFunction) => {
		const auth = req.headers.authorization ?? "";
		if (auth.startsWith("Bearer acp1.")) {
			const agent = await acp.verifyToken(auth.slice(7)).catch(() => null);
			if (!agent) return void res.status(401).json({ error: "bad-agent-token" });
			res.locals.acpCaller = { kind: "agent", agent };
			return next();
		}
		requireAuth(req, res, () => {
			res.locals.acpCaller = { kind: "owner", userId: (req as AuthedRequest).userId };
			next();
		});
	};
	router.use(identify);

	const caller = (res: Response) => res.locals.acpCaller as Caller;
	const ownerOf = (c: Caller) => (c.kind === "owner" ? c.userId : c.agent.owner_user_id);
	const agentOnly = (res: Response): AgentRow | null => {
		const c = caller(res);
		if (c.kind !== "agent") {
			res.status(403).json({ error: "agent-only" });
			return null;
		}
		return c.agent;
	};
	const wrap =
		(fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) =>
			fn(req, res).catch((err) => {
				logger.error(`[acp] ${req.method} ${req.path}: ${(err as Error).message}`);
				if (!res.headersSent) res.status(500).json({ error: "internal" });
			});

	// ── Both callers ──────────────────────────────────────────────────────

	router.get(
		"/agents",
		wrap(async (_req, res) => {
			const rows = await acp.list(ownerOf(caller(res)));
			res.json(
				rows.map((a) => ({
					name: a.name,
					sessionId: a.session_id,
					runtime: a.runtime,
					model: a.model,
					runnerSeenAt: acp.runnerSeenAt(a.agent_id),
				})),
			);
		}),
	);

	// POST /messages {to, body} — persisted (D1 INSERT) before the 201.
	router.post(
		"/messages",
		wrap(async (req, res) => {
			const c = caller(res);
			const { to, body } = (req.body ?? {}) as { to?: unknown; body?: unknown };
			const name = String(to ?? "").replace(/^@/, "");
			const owner = ownerOf(c);
			if (typeof body !== "string" || body.trim() === "")
				return void res.status(400).json({ error: "empty-body" });
			const bytes = Buffer.byteLength(body, "utf8");
			if (bytes > acp.config.maxMessageBytes)
				return void res
					.status(413)
					.json({ error: "too-large", maxBytes: acp.config.maxMessageBytes, bytes });
			const target = await acp.byName(owner, name);
			if (!target)
				return void res
					.status(400)
					.json({ error: "unknown-recipient", agents: (await acp.list(owner)).map((a) => a.name) });
			const from = c.kind === "owner" ? "owner" : c.agent.name;
			const msg = await acp.send(owner, from, target.name, body);
			res.status(201).json(msg);
		}),
	);

	router.get(
		"/messages",
		wrap(async (req, res) => {
			const c = caller(res);
			const agent =
				c.kind === "agent"
					? c.agent.name
					: typeof req.query.agent === "string"
						? req.query.agent
						: null;
			res.json(await acp.messages(ownerOf(c), agent));
		}),
	);

	router.get(
		"/messages/:id",
		wrap(async (req, res) => {
			const c = caller(res);
			const msg = await acp.message(ownerOf(c), Number(req.params.id));
			if (
				!msg ||
				(c.kind === "agent" && msg.to_id !== c.agent.name && msg.from_id !== c.agent.name)
			)
				return void res.status(404).json({ error: "not-found" });
			res.json(msg);
		}),
	);

	// ── Owner ─────────────────────────────────────────────────────────────

	// One poll for the chat: the agent's messages (history, D1) + live activity (memory).
	router.get(
		"/agents/:name/feed",
		wrap(async (req, res) => {
			const c = caller(res);
			if (c.kind !== "owner") return void res.status(403).json({ error: "owner-only" });
			const agent = await acp.byName(c.userId, req.params.name);
			if (!agent) return void res.status(404).json({ error: "not-found" });
			void sessions
				.get(agent.session_id)
				.then((meta) => acp.relaunchIfSilent(agent, meta))
				.catch((err) =>
					logger.warn(`[acp] relaunch check for @${agent.name}: ${(err as Error).message}`),
				);
			const after = Number(req.query.after ?? 0) || 0;
			const activity = acp.activitySince(agent.agent_id, after);
			res.json({
				agent: {
					name: agent.name,
					sessionId: agent.session_id,
					runtime: agent.runtime,
					model: agent.model,
					runnerSeenAt: acp.runnerSeenAt(agent.agent_id),
				},
				maxMessageBytes: acp.config.maxMessageBytes,
				messages: await acp.messages(c.userId, agent.name),
				activity: activity.events,
				seq: activity.seq,
			});
		}),
	);

	router.post(
		"/messages/:id/requeue",
		wrap(async (req, res) => {
			const c = caller(res);
			if (c.kind !== "owner") return void res.status(403).json({ error: "owner-only" });
			const msg = await acp.requeue(c.userId, Number(req.params.id));
			msg ? res.json(msg) : res.status(409).json({ error: "not-uncertain" });
		}),
	);

	// ── Runner (agent token) ──────────────────────────────────────────────

	router.get(
		"/runner/running",
		wrap(async (_req, res) => {
			const agent = agentOnly(res);
			if (!agent) return;
			const msg = await acp.running(agent);
			msg ? res.json(msg) : res.status(204).end();
		}),
	);

	router.post(
		"/runner/claim",
		wrap(async (_req, res) => {
			const agent = agentOnly(res);
			if (!agent) return;
			const msg = await acp.claim(agent);
			if (msg) return void res.json(msg);
			const running = await acp.running(agent);
			running ? res.status(409).json({ error: "running", id: running.id }) : res.status(204).end();
		}),
	);

	router.post(
		"/runner/system-message",
		wrap(async (req, res) => {
			const agent = agentOnly(res);
			if (!agent) return;
			const msg = await acp.startSystemMessage(
				agent,
				String((req.body as { body?: unknown })?.body ?? ""),
			);
			msg ? res.json(msg) : res.status(409).json({ error: "running" });
		}),
	);

	router.post(
		"/runner/messages/:id/result",
		wrap(async (req, res) => {
			const agent = agentOnly(res);
			if (!agent) return;
			const s = (req.body ?? {}) as {
				state?: string;
				text?: string | null;
				stopReason?: string | null;
				note?: string | null;
			};
			if (s.state !== "done" && s.state !== "failed" && s.state !== "uncertain")
				return void res.status(400).json({ error: "bad-state" });
			const msg = await acp.settle(agent, Number(req.params.id), { ...s, state: s.state });
			msg ? res.json(msg) : res.status(409).json({ error: "not-running" });
		}),
	);

	router.post(
		"/runner/messages/:id/release",
		wrap(async (req, res) => {
			const agent = agentOnly(res);
			if (!agent) return;
			const msg = await acp.release(
				agent,
				Number(req.params.id),
				String((req.body as { note?: unknown })?.note ?? "released"),
			);
			msg ? res.json(msg) : res.status(409).json({ error: "not-running" });
		}),
	);

	router.post(
		"/runner/activity",
		wrap(async (req, res) => {
			const agent = agentOnly(res);
			if (!agent) return;
			const events = (req.body as { events?: unknown })?.events;
			if (!Array.isArray(events))
				return void res.status(400).json({ error: "events must be an array" });
			acp.pushActivity(
				agent,
				events.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null),
			);
			res.status(204).end();
		}),
	);

	return router;
}
