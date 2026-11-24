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
	type OpenQuestion,
} from "../acp/agents.js";
import {
	AcpConversations,
	ConversationError,
	type ConversationRow,
	conversationView,
	type Recipients,
} from "../acp/conversations.js";
import { type AcpWorks, WorkError, workDir, workView } from "../acp/works.js";
import { type AuthedRequest, requireAuth } from "../auth.js";
import { logger } from "../logger.js";

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** Recipients of one post (`to` as a list). */
const MAX_RECIPIENTS = 16;

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

export function buildAcpRouter(acp: AcpAgents, works: AcpWorks): Router {
	const router = Router();
	const conversations = new AcpConversations(acp);
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
	// gets (recomputed, never stored): the runner cannot mint one — and the
	// work it is (branch, directory, ports) for the prompt's header and the
	// session's environment.
	// Its conversation (id and title): the runner keys slot 1's ACP session by it.
	const withContext = async (agent: AgentRow, msg: MessageRow) => {
		const work = msg.context === null ? null : await works.get(agent.owner_user_id, msg.context);
		const conv = msg.conversation_id
			? await conversations.get(agent.owner_user_id, msg.conversation_id).catch(() => null)
			: null;
		return {
			...msg,
			conversation: msg.conversation_id
				? { id: msg.conversation_id, title: conv?.title ?? null }
				: null,
			project: msg.project_id
				? await acp.projectContext(agent.owner_user_id, msg.project_id).catch(() => null)
				: null,
			contextToken: msg.context === null ? null : acp.tokenFor(agent.agent_id, msg.context),
			work: work
				? { id: work.id, branch: work.branch, dir: workDir(work.id), portBase: work.port_base }
				: null,
		};
	};
	const refuse = (res: Response, err: unknown) => {
		if (err instanceof ConversationError)
			return void res.status(err.status).json({ error: err.code });
		if (!(err instanceof WorkError)) throw err;
		res.status(err.status).json({ error: err.code, ...err.detail });
	};
	const wrap =
		(fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) =>
			fn(req, res).catch((err) => {
				logger.error(`[acp] ${req.method} ${req.path}: ${(err as Error).message}`);
				if (!res.headersSent) res.status(500).json({ error: "internal" });
			});

	// The agent's state in the words of the UI (PROPUESTA §4), never slots:
	// what it runs and where, its queue, what it waits for, its open question.
	const agentView = (
		a: AgentRow,
		loads: Map<string, AgentLoad>,
		waiting?: Map<string, OpenQuestion[]>,
	) => ({
		waitingInput: waiting?.has(a.name) ?? false,
		question: waiting?.get(a.name)?.[0] ?? null,
		runningIn: loads.get(a.name)?.runningIn ?? [],
		queue: loads.get(a.name)?.queue ?? [],
		waitingFor: loads.get(a.name)?.waitingFor ?? [],
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
		running: loads.get(a.name)?.running ?? [],
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

	// POST /messages {to, body, conversationId?, team?, projectId?, clientId?, work?}
	// — persisted (D1 INSERT) before the 201. The sender is the credential.
	//
	// The person posts in a CONVERSATION (`conversationId`, v27): the project is
	// the conversation's, every recipient must take part in it, `to` may name
	// several agents and `team: true` sends to all of the project's agents
	// (resolved now: one row per agent under one `clientId`, each marked `team`).
	// Without a conversation: `projectId` posts in the old Project Chat and
	// nothing a direct message — the paths the current UI uses until it moves
	// to conversations; they leave `conversation_id` NULL (the Archive).
	//
	// An agent chooses nothing: its message takes the scope AND conversation of
	// the message it is working on when the recipient takes part in that
	// project, and is direct (no conversation) otherwise — so an exchange
	// started in a topic stays there and a private one stays private.
	router.post(
		"/messages",
		wrap(async (req, res) => {
			const c = caller(res);
			const {
				to,
				body,
				projectId,
				clientId,
				work,
				conversationId,
				team,
				context: freeContext,
			} = (req.body ?? {}) as Record<string, unknown>;
			// The free `context` is gone (v26): a caller still sending it meant an
			// isolated directory, and ignoring it would run the message in the
			// agent's main checkout.
			if (freeContext !== undefined && freeContext !== null)
				return void res.status(400).json({
					error: "context-removed",
					message:
						"el campo context ya no existe: usá work (un trabajo creado con POST /api/acp/works)",
				});
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
			const isTeam = team === true;
			if (team !== undefined && team !== null && typeof team !== "boolean")
				return void res.status(400).json({ error: "bad-team" });
			const hasConv = conversationId !== undefined && conversationId !== null;
			const many = Array.isArray(to) || isTeam;
			if (c.kind === "agent" && (hasConv || many))
				return void res.status(400).json({
					error: "conversation-inherited",
					message:
						"un agente escribe a un destinatario; la conversación es la del mensaje que está ejecutando",
				});
			if (many && !hasConv) return void res.status(400).json({ error: "conversation-required" });
			if (isTeam && to !== undefined && to !== null)
				return void res.status(400).json({ error: "team-and-to" });
			// Several rows under one id: a retry must find them, never add copies.
			if (many && typeof clientId !== "string")
				return void res.status(400).json({ error: "client-id-required" });

			let conv: ConversationRow | null = null;
			if (hasConv) {
				conv =
					typeof conversationId === "string"
						? await conversations.get(owner, conversationId)
						: null;
				if (!conv) return void res.status(404).json({ error: "conversation-not-found" });
				if (conv.archived_at) return void res.status(409).json({ error: "conversation-archived" });
				if (projectId !== undefined && projectId !== null && projectId !== conv.project_id)
					return void res.status(400).json({ error: "project-mismatch" });
			}

			// The recipients, all resolved before anything is written.
			const all = await acp.list(owner);
			let targets: AgentRow[];
			if (isTeam) {
				targets = all.filter((a) => a.project_id === conv?.project_id);
				if (!targets.length) return void res.status(400).json({ error: "no-recipients" });
			} else {
				const names = (Array.isArray(to) ? to : [to]).map((n) => String(n ?? "").replace(/^@/, ""));
				if (!names.length || names.length > MAX_RECIPIENTS)
					return void res.status(400).json({ error: "bad-recipients", max: MAX_RECIPIENTS });
				targets = [];
				for (const n of [...new Set(names)]) {
					const a = all.find((x) => x.name === n);
					if (!a)
						return void res
							.status(400)
							.json({ error: "unknown-recipient", name: n, agents: all.map((x) => x.name) });
					if (conv && a.project_id !== conv.project_id)
						return void res.status(400).json({ error: "not-in-project", agent: a.name });
					targets.push(a);
				}
			}
			const hasWork = work !== undefined && work !== null;
			if (hasWork && targets.length > 1)
				return void res.status(400).json({ error: "work-needs-one-recipient" });
			const target = targets[0];

			let scope: string | null = conv?.project_id ?? null;
			let convId: string | null = conv?.id ?? null;
			let depth = 0;
			let fromContext: string | null = null;
			let rootId: number | null = null;
			// `work`: the message runs in that work (its context, worktree and ports).
			// The work must be the recipient's and active; an agent delegates only
			// a work of its own project. Without it: the recipient's default context.
			let context: string | null = null;
			if (hasWork) {
				if (typeof work !== "string" || !CONTEXT_RE.test(work))
					return void res.status(400).json({ error: "bad-work-id" });
				const w = await works.get(owner, work);
				if (!w) return void res.status(404).json({ error: "work-not-found", work });
				if (w.agent_id !== target.agent_id)
					return void res.status(409).json({ error: "work-not-yours", work, agent: target.name });
				if (w.state !== "active")
					return void res.status(409).json({ error: "work-not-active", work, state: w.state });
				// The work's project, and the recipient still in it: an agent that moved
				// to another project no longer takes work delegated from the old one.
				if (
					c.kind === "agent" &&
					(w.project_id === null ||
						w.project_id !== c.agent.project_id ||
						w.project_id !== target.project_id)
				)
					return void res.status(403).json({ error: "work-other-project", work });
				// Named contexts run in slots ≥ 2 (the cap may have been lowered since).
				if (target.max_concurrency < 2)
					return void res.status(400).json({ error: "context-needs-slots", agent: target.name });
				context = work;
			}
			if (c.kind === "owner") {
				if (!conv && projectId !== undefined && projectId !== null) {
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
				// Scope and conversation go together: both, or neither.
				const inScope = Boolean(cur.project_id && target.project_id === cur.project_id);
				scope = inScope ? cur.project_id : null;
				convId = inScope ? cur.conversation_id : null;
			}
			const from = c.kind === "owner" ? "owner" : c.agent.name;
			const sent: Array<{ message: MessageRow; replayed: boolean }> = [];
			for (const t of targets) {
				const r = await acp
					.send({
						ownerUserId: owner,
						from,
						to: t.name,
						body,
						projectId: scope,
						depth,
						clientId: typeof clientId === "string" ? clientId : null,
						context,
						fromContext,
						rootId,
						conversationId: convId,
						team: isTeam,
					})
					.catch((err: unknown) => {
						if (err instanceof ClientIdConflictError) return err;
						throw err;
					});
				if (r instanceof ClientIdConflictError)
					return void res.status(409).json({ error: "client-id-reused", id: r.existingId });
				sent.push(r);
			}
			if (conv) {
				const recipients: Recipients = isTeam
					? { team: true }
					: { agents: targets.map((t) => t.name) };
				await conversations.setRecipients(owner, conv.id, recipients);
			}
			const replayed = sent.every((r) => r.replayed);
			if (!many) {
				const r = sent[0];
				return void res.status(r.replayed ? 200 : 201).json({ ...r.message, replayed: r.replayed });
			}
			res.status(replayed ? 200 : 201).json({ messages: sent.map((r) => r.message), replayed });
		}),
	);

	// POST /works {agent, id, base?, conversationId?} — creates work `id` for
	// `agent` (its worktree on branch work/<id>, made in the agent's container)
	// before its first message. The person, or an agent of the recipient's
	// project (a project there must be). Repeating the same POST returns the
	// work. Its conversation of origin (v27): the person names it; an agent's is
	// the conversation of the message it is running.
	router.post(
		"/works",
		wrap(async (req, res) => {
			const c = caller(res);
			const owner = ownerOf(c);
			const { agent, id, base, conversationId } = (req.body ?? {}) as Record<string, unknown>;
			const target = await acp.byName(owner, String(agent ?? "").replace(/^@/, ""));
			if (!target)
				return void res
					.status(400)
					.json({ error: "unknown-recipient", agents: (await acp.list(owner)).map((a) => a.name) });
			if (typeof id !== "string") return void res.status(400).json({ error: "bad-work-id" });
			if (base !== undefined && base !== null && typeof base !== "string")
				return void res.status(400).json({ error: "bad-base" });
			if (
				c.kind === "agent" &&
				(target.project_id === null || target.project_id !== c.agent.project_id)
			)
				return void res.status(403).json({ error: "work-other-project", agent: target.name });
			let origin: string | null = null;
			if (c.kind === "agent")
				origin = (await acp.runningIn(c.agent, c.context))?.conversation_id ?? null;
			else if (conversationId !== undefined && conversationId !== null) {
				const conv =
					typeof conversationId === "string"
						? await conversations.get(owner, conversationId)
						: null;
				if (!conv) return void res.status(404).json({ error: "conversation-not-found" });
				if (conv.project_id !== target.project_id)
					return void res.status(400).json({ error: "not-in-project", agent: target.name });
				origin = conv.id;
			}
			try {
				const r = await works.create({
					conversationId: origin,
					ownerUserId: owner,
					createdBy: c.kind === "owner" ? "owner" : c.agent.name,
					target,
					id,
					base: typeof base === "string" ? base : null,
				});
				res
					.status(r.created ? 201 : 200)
					.json({ ...workView({ ...r.work, agent: target.name }), base: r.base ?? null });
			} catch (err) {
				refuse(res, err);
			}
		}),
	);

	// POST /works/:id/close | /works/:id/clean — the person, or an agent of the
	// work's project (a project there must be).
	const ownWork = async (req: Request, res: Response) => {
		const c = caller(res);
		const w = await works.get(ownerOf(c), String(req.params.id));
		if (!w) {
			res.status(404).json({ error: "work-not-found" });
			return null;
		}
		const agent = (await acp.list(w.owner_user_id)).find((a) => a.agent_id === w.agent_id);
		if (!agent) {
			res.status(404).json({ error: "work-not-found" });
			return null;
		}
		if (
			c.kind === "agent" &&
			(w.project_id === null ||
				w.project_id !== c.agent.project_id ||
				w.project_id !== agent.project_id)
		) {
			res.status(403).json({ error: "work-other-project" });
			return null;
		}
		return { w, agent };
	};
	router.post(
		"/works/:id/close",
		wrap(async (req, res) => {
			const found = await ownWork(req, res);
			if (!found) return;
			try {
				res.json(workView({ ...(await works.close(found.w)), agent: found.agent.name }));
			} catch (err) {
				refuse(res, err);
			}
		}),
	);
	router.post(
		"/works/:id/clean",
		wrap(async (req, res) => {
			const found = await ownWork(req, res);
			if (!found) return;
			try {
				res.json(
					workView({ ...(await works.clean(found.w, found.agent)), agent: found.agent.name }),
				);
			} catch (err) {
				refuse(res, err);
			}
		}),
	);

	// GET /works — the person: all of theirs; an agent: its own and its project's.
	router.get(
		"/works",
		wrap(async (_req, res) => {
			const c = caller(res);
			res.json((await works.list(ownerOf(c), c.kind === "agent" ? c.agent : null)).map(workView));
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

	// The individual chat, now the Archive's: everything to or from the agent
	// outside any conversation (any scope), the agent's retained live activity.
	// Later changes arrive over /ws/acp.
	router.get(
		"/agents/:name/feed",
		wrap(async (req, res) => {
			const owner = ownerOnly(res);
			if (!owner) return;
			const agent = await acp.byName(owner, req.params.name);
			if (!agent) return void res.status(404).json({ error: "not-found" });
			const [messages, loads, waiting] = await Promise.all([
				acp.messages(owner, { agent: agent.name, archive: true, before: beforeOf(req) }),
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

	// The old Project Chat, now the Archive's: what was posted in the project
	// outside any conversation, its agents' state and activity. A direct
	// message never appears here.
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
				acp.messages(owner, { projectId: pid, archive: true, before: beforeOf(req) }),
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

	// POST /messages/:id/review — "Dar por revisada": the person reviewed an
	// interrupted (`uncertain`) run and does not requeue it. It leaves the
	// inbox; its state stays and nothing is sent.
	router.post(
		"/messages/:id/review",
		wrap(async (req, res) => {
			const owner = ownerOnly(res);
			if (!owner) return;
			const msg = await acp.review(owner, Number(req.params.id));
			if (msg) return void res.json(msg);
			const cur = await acp.message(owner, Number(req.params.id));
			cur
				? res.status(409).json({ error: "not-uncertain", state: cur.state })
				: res.status(404).json({ error: "not-found" });
		}),
	);

	// ── Conversations (v27, owner) ────────────────────────────────────────

	const conversationRoute = (fn: (owner: string, req: Request, res: Response) => Promise<void>) =>
		wrap(async (req, res) => {
			const owner = ownerOnly(res);
			if (!owner) return;
			res.setHeader("Cache-Control", "no-store");
			try {
				await fn(owner, req, res);
			} catch (err) {
				refuse(res, err);
			}
		});

	// POST /conversations {projectId, title, clientRequestId} — idempotent by
	// clientRequestId (a retry answers 200 with `replayed`).
	router.post(
		"/conversations",
		conversationRoute(async (owner, req, res) => {
			const r = await conversations.create(owner, req.body);
			res.status(r.replayed ? 200 : 201).json({ ...conversationView(r.row), replayed: r.replayed });
		}),
	);

	// GET /projects/:pid/conversations[?archived=1] — most recently active first,
	// each with `unread` and `needsAction`.
	router.get(
		"/projects/:pid/conversations",
		conversationRoute(async (owner, req, res) => {
			if (!(await acp.ownsProject(owner, req.params.pid)))
				return void res.status(404).json({ error: "project-not-found" });
			const rows = await conversations.list(owner, req.params.pid, req.query.archived === "1");
			res.json(rows.map(conversationView));
		}),
	);

	// PATCH /conversations/:id {title}
	router.patch(
		"/conversations/:id",
		conversationRoute(async (owner, req, res) => {
			res.json(conversationView(await conversations.rename(owner, req.params.id, req.body)));
		}),
	);

	// POST /conversations/:id/archive — idempotent; no new post from the person after it.
	router.post(
		"/conversations/:id/archive",
		conversationRoute(async (owner, req, res) => {
			res.json(conversationView(await conversations.archive(owner, req.params.id)));
		}),
	);

	// POST /conversations/:id/read {at} — the newest event time the client has
	// shown (conversations.ts); only advances.
	router.post(
		"/conversations/:id/read",
		conversationRoute(async (owner, req, res) => {
			const at = (req.body as { at?: unknown } | undefined)?.at;
			res.json(conversationView(await conversations.read(owner, req.params.id, at)));
		}),
	);

	// GET /conversations/:id/feed[?before=] — one topic: its messages (paged
	// like the other feeds), the questions asked while working on them, the
	// project's agents with their state and activity.
	router.get(
		"/conversations/:id/feed",
		conversationRoute(async (owner, req, res) => {
			const conv = await conversations.get(owner, req.params.id);
			if (!conv) return void res.status(404).json({ error: "conversation-not-found" });
			const [all, loads, messages, waiting, summary] = await Promise.all([
				acp.list(owner),
				acp.loads(owner),
				acp.messages(owner, { conversationId: conv.id, before: beforeOf(req) }),
				acp.waitingAgents(owner),
				conversations.summary(owner, conv.id),
			]);
			const agents = all.filter((a) => a.project_id === conv.project_id);
			res.json({
				conversation: conversationView(summary ?? conv),
				agents: agents.map((a) => agentView(a, loads, waiting)),
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

	// GET /inbox — every project's pending attention (conversations.ts `inbox`).
	router.get(
		"/inbox",
		conversationRoute(async (owner, _req, res) => {
			res.json(await conversations.inbox(owner));
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
			// `open`: the work whose ACP session this slot holds (sent now and then).
			// No longer active ⇒ told to close it — the runner does, idle and with no
			// open task (a process it left wins: the session stays).
			const open = (req.body as { open?: unknown } | undefined)?.open;
			if (typeof open === "string" && CONTEXT_RE.test(open)) {
				const w = await works.get(agent.owner_user_id, open);
				if (w?.state !== "active") res.setHeader("X-ST-Release", open);
			}
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
			const { body, context, recoveryOf } = (req.body ?? {}) as {
				body?: unknown;
				context?: unknown;
				recoveryOf?: unknown;
			};
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
				typeof recoveryOf === "number" && Number.isInteger(recoveryOf) ? recoveryOf : null,
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
