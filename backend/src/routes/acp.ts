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
import type { AcpAgents, AgentLoad, AgentRow, MessageRow } from "../acp/agents.js";
import { type AuthedRequest, requireAuth } from "../auth.js";
import { logger } from "../logger.js";

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

type Caller = { kind: "owner"; userId: string } | { kind: "agent"; agent: AgentRow };

declare module "express-serve-static-core" {
	interface Locals {
		acpCaller?: Caller;
	}
}

export function buildAcpRouter(acp: AcpAgents): Router {
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
	// What the runner puts in the prompt's header: where the message was
	// posted and who else is there (names only).
	const withContext = async (agent: AgentRow, msg: MessageRow) => ({
		...msg,
		project: msg.project_id
			? await acp.projectContext(agent.owner_user_id, msg.project_id).catch(() => null)
			: null,
	});
	const wrap =
		(fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) =>
			fn(req, res).catch((err) => {
				logger.error(`[acp] ${req.method} ${req.path}: ${(err as Error).message}`);
				if (!res.headersSent) res.status(500).json({ error: "internal" });
			});

	const agentView = (a: AgentRow, loads: Map<string, AgentLoad>) => ({
		name: a.name,
		sessionId: a.session_id,
		runtime: a.runtime,
		model: a.model,
		projectId: a.project_id ?? null,
		runnerSeenAt: acp.runnerSeenAt(a.agent_id),
		running: loads.get(a.name)?.running ?? null,
		pending: loads.get(a.name)?.pending ?? 0,
		authRequired: acp.authRequired(a.agent_id),
	});
	const beforeOf = (req: Request) => {
		const n = Number(req.query.before);
		return Number.isInteger(n) && n > 0 ? n : null;
	};

	// ── Both callers ──────────────────────────────────────────────────────

	router.get(
		"/agents",
		wrap(async (_req, res) => {
			const owner = ownerOf(caller(res));
			const [rows, loads] = await Promise.all([acp.list(owner), acp.loads(owner)]);
			res.json(rows.map((a) => agentView(a, loads)));
		}),
	);

	// POST /messages {to, body, projectId?, clientId?} — persisted (D1 INSERT)
	// before the 201. The sender is the credential. A person chooses the scope
	// (`projectId`: Project Chat; absent: a direct message). An agent does not:
	// its message takes the scope of the message it is working on when the
	// recipient takes part in that project, and is direct otherwise — so an
	// exchange started in Project Chat stays there and a private one stays
	// private, whatever the agent writes.
	router.post(
		"/messages",
		wrap(async (req, res) => {
			const c = caller(res);
			const { to, body, projectId, clientId } = (req.body ?? {}) as Record<string, unknown>;
			const name = String(to ?? "").replace(/^@/, "");
			const owner = ownerOf(c);
			if (typeof body !== "string" || body.trim() === "")
				return void res.status(400).json({ error: "empty-body" });
			const bytes = Buffer.byteLength(body, "utf8");
			if (bytes > acp.config.maxMessageBytes)
				return void res
					.status(413)
					.json({ error: "too-large", maxBytes: acp.config.maxMessageBytes, bytes });
			if (clientId !== undefined && (typeof clientId !== "string" || !CLIENT_ID_RE.test(clientId)))
				return void res.status(400).json({ error: "bad-client-id" });
			const target = await acp.byName(owner, name);
			if (!target)
				return void res
					.status(400)
					.json({ error: "unknown-recipient", agents: (await acp.list(owner)).map((a) => a.name) });
			let scope: string | null = null;
			let depth = 0;
			if (c.kind === "owner") {
				if (projectId !== undefined && projectId !== null) {
					if (typeof projectId !== "string" || !(await acp.ownsProject(owner, projectId)))
						return void res.status(404).json({ error: "project-not-found" });
					if (target.project_id !== projectId)
						return void res.status(400).json({ error: "not-in-project", agent: target.name });
					scope = projectId;
				}
			} else {
				if (target.name === c.agent.name) return void res.status(400).json({ error: "self" });
				const cur = await acp.running(c.agent);
				depth = (cur?.depth ?? 0) + 1;
				if (depth > acp.config.maxDepth)
					return void res.status(409).json({
						error: "depth-limit",
						message: `chain of agent requests longer than ${acp.config.maxDepth}: answer with what you have instead of asking further`,
					});
				if (cur?.project_id && target.project_id === cur.project_id) scope = cur.project_id;
			}
			const from = c.kind === "owner" ? "owner" : c.agent.name;
			const r = await acp.send({
				ownerUserId: owner,
				from,
				to: target.name,
				body,
				projectId: scope,
				depth,
				clientId: typeof clientId === "string" ? clientId : null,
			});
			res.status(r.replayed ? 200 : 201).json({ ...r.message, replayed: r.replayed });
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
			res.json(await acp.messages(ownerOf(c), { agent, before: beforeOf(req) }));
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

	const ownerOnly = (res: Response): string | null => {
		const c = caller(res);
		if (c.kind !== "owner") {
			res.status(403).json({ error: "owner-only" });
			return null;
		}
		return c.userId;
	};

	router.get(
		"/runtimes",
		wrap(async (_req, res) => {
			if (!ownerOnly(res)) return;
			res.json({ default: acp.config.defaultRuntime, available: await acp.runtimes() });
		}),
	);

	// PATCH /agents/:name {projectId: string | null} — join / leave a project.
	router.patch(
		"/agents/:name",
		wrap(async (req, res) => {
			const owner = ownerOnly(res);
			if (!owner) return;
			const { projectId } = (req.body ?? {}) as { projectId?: unknown };
			if (projectId !== null && typeof projectId !== "string")
				return void res.status(400).json({ error: "projectId must be a project id or null" });
			if (projectId !== null && !(await acp.ownsProject(owner, projectId)))
				return void res.status(404).json({ error: "project-not-found" });
			const row = await acp.setProject(owner, req.params.name, projectId);
			if (!row) return void res.status(404).json({ error: "not-found" });
			res.json(agentView(row, await acp.loads(owner)));
		}),
	);

	// The individual chat: everything to or from the agent (any scope), the
	// agent's retained live activity. Later changes arrive over /ws/acp.
	router.get(
		"/agents/:name/feed",
		wrap(async (req, res) => {
			const owner = ownerOnly(res);
			if (!owner) return;
			const agent = await acp.byName(owner, req.params.name);
			if (!agent) return void res.status(404).json({ error: "not-found" });
			const [messages, loads] = await Promise.all([
				acp.messages(owner, { agent: agent.name, before: beforeOf(req) }),
				acp.loads(owner),
			]);
			res.json({
				agent: agentView(agent, loads),
				maxMessageBytes: acp.config.maxMessageBytes,
				messages,
				activity: { [agent.name]: acp.activitySince(agent.agent_id) },
				activitySeq: acp.currentActivitySeq,
			});
		}),
	);

	// Project Chat: only what was posted in the project, its agents' state and
	// activity. A direct message never appears here.
	router.get(
		"/projects/:pid/feed",
		wrap(async (req, res) => {
			const owner = ownerOnly(res);
			if (!owner) return;
			const pid = req.params.pid;
			const project = await acp.projectContext(owner, pid);
			if (!project) return void res.status(404).json({ error: "project-not-found" });
			const [all, loads, messages] = await Promise.all([
				acp.list(owner),
				acp.loads(owner),
				acp.messages(owner, { projectId: pid, before: beforeOf(req) }),
			]);
			const agents = all.filter((a) => a.project_id === pid);
			res.json({
				project: { id: pid, name: project.name },
				agents: agents.map((a) => agentView(a, loads)),
				maxMessageBytes: acp.config.maxMessageBytes,
				messages,
				activity: Object.fromEntries(agents.map((a) => [a.name, acp.activitySince(a.agent_id)])),
				activitySeq: acp.currentActivitySeq,
			});
		}),
	);

	router.post(
		"/messages/:id/requeue",
		wrap(async (req, res) => {
			const owner = ownerOnly(res);
			if (!owner) return;
			const msg = await acp.requeue(owner, Number(req.params.id));
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
			msg ? res.json(await withContext(agent, msg)) : res.status(204).end();
		}),
	);

	router.post(
		"/runner/claim",
		wrap(async (_req, res) => {
			const agent = agentOnly(res);
			if (!agent) return;
			const msg = await acp.claim(agent);
			if (msg) return void res.json(await withContext(agent, msg));
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
