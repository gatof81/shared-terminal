/**
 * routes/acp.ts — ACP agents API, mounted at
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
import {
	type AcpAgents,
	type AgentLoad,
	type AgentRow,
	ClientIdConflictError,
	CONTEXT_RE,
	effortOf,
	MAX_SLOTS,
	type MessageRow,
} from "../acp/agents.js";
import { type AuthedRequest, requireAuth } from "../auth.js";
import { logger } from "../logger.js";

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// An agent's credential names its context (NULL = default); `runner` = the
// runner's own token (also the default context's), the only one that reaches
// the runner routes.
type Caller =
	| { kind: "owner"; userId: string }
	| { kind: "agent"; agent: AgentRow; context: string | null; runner: boolean };

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
			const v = await acp.verifyToken(auth.slice(7)).catch(() => null);
			if (!v) return void res.status(401).json({ error: "bad-agent-token" });
			res.locals.acpCaller = { kind: "agent", ...v };
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
		if (c.kind !== "agent" || !c.runner) {
			res.status(403).json({ error: c.kind === "agent" ? "runner-only" : "agent-only" });
			return null;
		}
		return c.agent;
	};
	// The runner's slot, from `?slot=` or the body's `slot` (1 when absent: a
	// one-slot agent's runner never sends it).
	const slotOf = (req: Request): number | null => {
		const raw = req.query.slot ?? (req.body as { slot?: unknown } | undefined)?.slot ?? 1;
		const n = Number(raw);
		return Number.isInteger(n) && n >= 1 && n <= MAX_SLOTS ? n : null;
	};
	// What the runner puts in the prompt's header: where the message was
	// posted and who else is there (names only).
	// A named context's message also carries the credential its ACP session
	// gets (recomputed, never stored): the runner cannot mint one.
	const withContext = async (agent: AgentRow, msg: MessageRow) => ({
		...msg,
		project: msg.project_id
			? await acp.projectContext(agent.owner_user_id, msg.project_id).catch(() => null)
			: null,
		contextToken: msg.context === null ? null : acp.tokenFor(agent.agent_id, msg.context),
	});
	const wrap =
		(fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) =>
			fn(req, res).catch((err) => {
				logger.error(`[acp] ${req.method} ${req.path}: ${(err as Error).message}`);
				if (!res.headersSent) res.status(500).json({ error: "internal" });
			});

	const agentView = (a: AgentRow, loads: Map<string, AgentLoad>, waiting?: Set<string>) => ({
		waitingInput: waiting?.has(a.name) ?? false,
		name: a.name,
		sessionId: a.session_id,
		runtime: a.runtime,
		model: a.model,
		modelApplied: acp.modelAppliedOf(a.agent_id),
		effort: a.effort ?? null,
		effortApplied: acp.effortAppliedOf(a.agent_id),
		maxConcurrency: a.max_concurrency,
		projectId: a.project_id ?? null,
		runnerSeenAt: acp.runnerSeenAt(a.agent_id),
		running: loads.get(a.name)?.running ?? null,
		pending: loads.get(a.name)?.pending ?? 0,
		authRequired: acp.authRequired(a.agent_id),
		loginMethods: acp
			.loginMethodsOf(a.agent_id)
			.map((m) => ({ id: m.id, name: m.name, description: m.description })),
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
			const [rows, loads, waiting] = await Promise.all([
				acp.list(owner),
				acp.loads(owner),
				acp.waitingAgents(owner),
			]);
			res.json(rows.map((a) => agentView(a, loads, waiting)));
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
			const { to, body, projectId, clientId, context } = (req.body ?? {}) as Record<
				string,
				unknown
			>;
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
			let fromContext: string | null = null;
			let rootId: number | null = null;
			if (context !== undefined && context !== null) {
				// Only the person places a message in a context; an agent's request
				// always goes to the recipient's default one.
				if (c.kind !== "owner") return void res.status(403).json({ error: "context-owner-only" });
				if (typeof context !== "string" || !CONTEXT_RE.test(context))
					return void res.status(400).json({ error: "bad-context" });
				// Named contexts run in slots ≥ 2: a one-slot agent would never take it.
				if (target.max_concurrency < 2)
					return void res.status(400).json({ error: "context-needs-slots", agent: target.name });
			}
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
				// The sender is the execution the credential names: the message
				// running in its context. None ⇒ that execution ended (a process
				// that outlived its message): refused, never re-attributed.
				const cur = await acp.runningIn(c.agent, c.context);
				if (!cur)
					return void res.status(409).json({
						error: "execution-ended",
						message:
							"the message this process was started for is no longer running: nothing was sent",
					});
				fromContext = c.context;
				depth = cur.depth + 1;
				// The chain's root: the person's message it started from (a root
				// itself, or a system message, has none and is its own).
				rootId = cur.root_id ?? cur.id;
				if ((await acp.chainRequests(owner, rootId)) >= acp.config.maxChain)
					return void res.status(409).json({
						error: "chain-budget",
						message: `ya hay ${acp.config.maxChain} pedidos entre agentes para un mismo mensaje de la persona: no se envió nada. Informá el estado y esperá a la persona.`,
					});
				if (depth > acp.config.maxDepth)
					return void res.status(409).json({
						error: "depth-limit",
						message: `chain of agent requests longer than ${acp.config.maxDepth}: answer with what you have instead of asking further`,
					});
				if (cur?.project_id && target.project_id === cur.project_id) scope = cur.project_id;
			}
			const from = c.kind === "owner" ? "owner" : c.agent.name;
			const r = await acp
				.send({
					ownerUserId: owner,
					from,
					to: target.name,
					body,
					projectId: scope,
					depth,
					clientId: typeof clientId === "string" ? clientId : null,
					context: typeof context === "string" ? context : null,
					fromContext,
					rootId,
				})
				.catch((err: unknown) => {
					if (err instanceof ClientIdConflictError) return err;
					throw err;
				});
			if (r instanceof ClientIdConflictError)
				return void res.status(409).json({ error: "client-id-reused", id: r.existingId });
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

	// PATCH /agents/:name {projectId?: string | null, model?: string,
	// effort?: string | null, maxConcurrency?: 1..MAX_SLOTS} — join / leave a
	// project; change the model or the reasoning effort (both applied by the
	// runner when idle); change how many messages it runs at once (slots).
	router.patch(
		"/agents/:name",
		wrap(async (req, res) => {
			const owner = ownerOnly(res);
			if (!owner) return;
			const body = (req.body ?? {}) as {
				projectId?: unknown;
				model?: unknown;
				effort?: unknown;
				maxConcurrency?: unknown;
			};
			const hasProject = "projectId" in body;
			const hasModel = "model" in body;
			const hasEffort = "effort" in body;
			const hasSlots = "maxConcurrency" in body;
			if (!hasProject && !hasModel && !hasEffort && !hasSlots)
				return void res
					.status(400)
					.json({ error: "projectId, model, effort or maxConcurrency is required" });
			const slots = body.maxConcurrency;
			if (
				hasSlots &&
				!(typeof slots === "number" && Number.isInteger(slots) && slots >= 1 && slots <= MAX_SLOTS)
			)
				return void res
					.status(400)
					.json({ error: `maxConcurrency must be an integer 1..${MAX_SLOTS}` });
			const { projectId, model } = body;
			const effort = effortOf(body.effort);
			if (hasEffort && effort === undefined)
				return void res.status(400).json({ error: "effort must be an effort level" });
			if (hasProject && projectId !== null && typeof projectId !== "string")
				return void res.status(400).json({ error: "projectId must be a project id or null" });
			// Same rule as acpAgent.model at create (routes/sessions.ts).
			if (hasModel && (typeof model !== "string" || !/^[a-z0-9.\-[\]]{1,64}$/.test(model)))
				return void res.status(400).json({ error: "model must be a model id" });
			if (hasProject && projectId !== null && !(await acp.ownsProject(owner, projectId as string)))
				return void res.status(404).json({ error: "project-not-found" });
			let row = hasProject
				? await acp.setProject(owner, req.params.name, projectId as string | null)
				: null;
			if (hasModel) row = await acp.setModel(owner, req.params.name, model as string);
			if (hasEffort) row = await acp.setEffort(owner, req.params.name, effort ?? null);
			if (hasSlots) row = await acp.setMaxConcurrency(owner, req.params.name, slots as number);
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
			const [messages, loads, waiting] = await Promise.all([
				acp.messages(owner, { agent: agent.name, before: beforeOf(req) }),
				acp.loads(owner),
				acp.waitingAgents(owner),
			]);
			res.json({
				agent: agentView(agent, loads, waiting),
				questions: await acp.questionsFor(
					owner,
					messages.map((m) => m.id),
					[agent.name],
				),
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
			const [all, loads, messages, waiting] = await Promise.all([
				acp.list(owner),
				acp.loads(owner),
				acp.messages(owner, { projectId: pid, before: beforeOf(req) }),
				acp.waitingAgents(owner),
			]);
			const agents = all.filter((a) => a.project_id === pid);
			res.json({
				project: { id: pid, name: project.name },
				agents: agents.map((a) => agentView(a, loads, waiting)),
				// Only questions asked while working on a message of this project.
				questions: await acp.questionsFor(
					owner,
					messages.map((m) => m.id),
					[],
				),
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

	// POST /agents/:name/login {methodId} — "Conectar cuenta": opens a terminal
	// tab in the agent's session running the adapter's own login command. The
	// person completes the official flow there; the runner notices the new
	// credentials and restarts its adapter by itself.
	router.post(
		"/agents/:name/login",
		wrap(async (req, res) => {
			const owner = ownerOnly(res);
			if (!owner) return;
			const agent = await acp.byName(owner, req.params.name);
			if (!agent) return void res.status(404).json({ error: "not-found" });
			const methodId = String((req.body as { methodId?: unknown })?.methodId ?? "");
			const r = await acp.startLogin(agent, methodId).catch((err: Error) => {
				logger.warn(`[acp] login tab for @${agent.name}: ${err.message}`);
				return "failed" as const;
			});
			if (r === "failed") return void res.status(409).json({ error: "session-not-running" });
			r
				? res.status(201).json({ sessionId: agent.session_id, ...r })
				: res.status(404).json({ error: "unknown-method" });
		}),
	);

	// POST /questions/:id/answer {action: accept|decline|cancel, content?} — the
	// person only (an agent's token is refused: a question to the person is never
	// answered by another agent). A second answer finds nothing open: 409.
	router.post(
		"/questions/:id/answer",
		wrap(async (req, res) => {
			const owner = ownerOnly(res);
			if (!owner) return;
			const { action, content } = (req.body ?? {}) as { action?: unknown; content?: unknown };
			if (action !== "accept" && action !== "decline" && action !== "cancel")
				return void res.status(400).json({ error: "bad-action" });
			if (
				action === "accept" &&
				(typeof content !== "object" || content === null || Array.isArray(content))
			)
				return void res.status(400).json({ error: "content must be an object" });
			const q = await acp.answerQuestion(
				owner,
				Number(req.params.id),
				action === "accept" ? { action, content } : { action },
			);
			if (q) return void res.json(q);
			const cur = await acp.question(owner, Number(req.params.id));
			cur
				? res.status(409).json({ error: "not-open", state: cur.state })
				: res.status(404).json({ error: "not-found" });
		}),
	);

	// ── Runner (agent token) ──────────────────────────────────────────────

	router.get(
		"/runner/running",
		wrap(async (req, res) => {
			const agent = agentOnly(res);
			if (!agent) return;
			const slot = slotOf(req);
			if (slot === null) return void res.status(400).json({ error: "bad-slot" });
			const msg = await acp.runningInSlot(agent, slot);
			msg ? res.json(await withContext(agent, msg)) : res.status(204).end();
		}),
	);

	router.post(
		"/runner/claim",
		wrap(async (req, res) => {
			const agent = agentOnly(res);
			if (!agent) return;
			// The model this agent should run, with every claim: the runner switches
			// to it while idle, before it starts the next message.
			res.setHeader("X-ST-Model", agent.model ?? acp.config.defaultModel);
			res.setHeader("X-ST-Effort", agent.effort ?? "default");
			const slot = slotOf(req);
			if (slot === null) return void res.status(400).json({ error: "bad-slot" });
			// `context`: the slot holds that context's session open (processes the
			// agent left running there) and can take only its messages.
			const only = (req.body as { context?: unknown } | undefined)?.context;
			if (
				only !== undefined &&
				only !== null &&
				(typeof only !== "string" || !CONTEXT_RE.test(only))
			)
				return void res.status(400).json({ error: "bad-context" });
			const msg = await acp.claim(agent, slot, typeof only === "string" ? only : null);
			if (msg) return void res.json(await withContext(agent, msg));
			const running = await acp.runningInSlot(agent, slot);
			running ? res.status(409).json({ error: "running", id: running.id }) : res.status(204).end();
		}),
	);

	router.post(
		"/runner/system-message",
		wrap(async (req, res) => {
			const agent = agentOnly(res);
			if (!agent) return;
			const slot = slotOf(req);
			const { body, context } = (req.body ?? {}) as { body?: unknown; context?: unknown };
			if (slot === null) return void res.status(400).json({ error: "bad-slot" });
			if (
				context !== undefined &&
				context !== null &&
				(typeof context !== "string" || !CONTEXT_RE.test(context))
			)
				return void res.status(400).json({ error: "bad-context" });
			const msg = await acp.startSystemMessage(
				agent,
				String(body ?? ""),
				slot,
				typeof context === "string" ? context : null,
			);
			msg ? res.json(await withContext(agent, msg)) : res.status(409).json({ error: "running" });
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

	// Questions from the runner's side: register one, wait for its answer, close it.
	// What the adapter reported after the runner asked it for a model.
	router.post(
		"/runner/model",
		wrap(async (req, res) => {
			const agent = agentOnly(res);
			if (!agent) return;
			acp.setModelApplied(agent, req.body);
			res.status(204).end();
		}),
	);

	// What the adapter reported after the runner applied the effort.
	router.post(
		"/runner/effort",
		wrap(async (req, res) => {
			const agent = agentOnly(res);
			if (!agent) return;
			acp.setEffortApplied(agent, req.body);
			res.status(204).end();
		}),
	);

	router.post(
		"/runner/auth-methods",
		wrap(async (req, res) => {
			const agent = agentOnly(res);
			if (!agent) return;
			acp.setLoginMethods(agent, (req.body as { methods?: unknown })?.methods);
			res.status(204).end();
		}),
	);

	router.post(
		"/runner/questions",
		wrap(async (req, res) => {
			const agent = agentOnly(res);
			if (!agent) return;
			const { messageId, request } = (req.body ?? {}) as { messageId?: unknown; request?: unknown };
			if (typeof request !== "object" || request === null)
				return void res.status(400).json({ error: "request must be an object" });
			res
				.status(201)
				.json(
					await acp.openQuestion(agent, typeof messageId === "number" ? messageId : null, request),
				);
		}),
	);

	router.get(
		"/runner/questions/:id",
		wrap(async (req, res) => {
			const agent = agentOnly(res);
			if (!agent) return;
			const q = await acp.runnerQuestion(agent, Number(req.params.id));
			q ? res.json(q) : res.status(404).json({ error: "not-found" });
		}),
	);

	router.post(
		"/runner/questions/:id/:to(delivered|withdrawn)",
		wrap(async (req, res) => {
			const agent = agentOnly(res);
			if (!agent) return;
			const q = await acp.closeQuestion(
				agent,
				Number(req.params.id),
				req.params.to as "delivered" | "withdrawn",
			);
			q ? res.json(q) : res.status(409).json({ error: "not-closable" });
		}),
	);

	router.post(
		"/runner/questions-orphan",
		wrap(async (req, res) => {
			const agent = agentOnly(res);
			if (!agent) return;
			const note = String((req.body as { note?: unknown })?.note ?? "the agent restarted");
			const slot = slotOf(req);
			if (slot === null) return void res.status(400).json({ error: "bad-slot" });
			res.json(await acp.orphanQuestions(agent, note, slot));
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
