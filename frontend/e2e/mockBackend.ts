/**
 * mockBackend.ts — a deterministic stand-in for the Shared Terminal backend,
 * installed into a Playwright page with `page.route` (REST) and
 * `page.routeWebSocket` (terminal / conversation sockets).
 *
 * It answers the routes the frontend flows touch with fixed, seeded data
 * (three users with different roles, a running session with tabs,
 * conversations, a workspace tree and a git repo, a stopped and a
 * terminated session, a foreign session for the permission tests) and
 * records what the app asked for, so a test can assert on behaviour
 * ("no request to a foreign session", "no resize sent on a view switch")
 * rather than on pixels alone. Every test gets a fresh instance.
 *
 * Shapes mirror `src/api.ts`; keep them in step when the API changes.
 */

import { createHash } from "node:crypto";
import type { Page, Route, WebSocketRoute } from "@playwright/test";
import { normalizeTitle } from "../src/conversationTitle.js";

// ── Seed data ───────────────────────────────────────────────────────────────

export interface MockUser {
	userId: string;
	username: string;
	isAdmin: boolean;
	isLead: boolean;
}

export interface MockSession {
	sessionId: string;
	ownerUserId: string;
	name: string;
	status: "running" | "stopped" | "terminated" | "failed";
	tabs: Array<{ tabId: string; label: string; createdAt: number }>;
	createdAt: string;
}

interface FsDir {
	type: "dir";
	entries: Record<string, FsNode>;
	restricted?: boolean;
}
interface FsFile {
	type: "file";
	content: string;
	restricted?: boolean;
}
type FsNode = FsDir | FsFile;

export interface ConversationEvent {
	seq: number;
	ts: string;
	ev: string;
	prompt_id: string | null;
	turn_id: string | null;
	agent_id: string | null;
	pane: string | null;
	data: Record<string, unknown>;
}

interface Conversation {
	cid: string;
	title: string;
	kind: "interactive" | "headless";
	status: string;
	canSendInput: boolean;
	events: ConversationEvent[];
	startedAt: string;
	/** When the status was last evidenced; default: a minute before the fixed test clock. */
	statusAt?: string;
	statusEvidence?: string;
	/** null = the conversation has no pane (binding lost). */
	paneId?: string | null;
	/**
	 * v1.9 §8.1.12 (EXPERIMENTAL): a background session reachable through
	 * the CLI daemon. A send answers 202 `accepted`; `bgOutcome` then plays
	 * the send's own `composer_send` events (and the CLI's user_prompt for a
	 * delivery) over the socket.
	 */
	transport?: "background";
	bgOutcome?: "delivered" | "unconfirmed" | "duplicated" | "possible-duplicate";
	/** The tmux tab the conversation's pane lives in (default "tab-1"). */
	tabId?: string | null;
	/** Lost-event gaps reported in the list (default 0). */
	gapsCount?: number;
	/** `GET …/agents` (default none): the captured subagents of this conversation. */
	agents?: Array<{
		agentId: string;
		agentType: string;
		status: "running" | "done";
		startedSeq: number;
		endedSeq?: number;
		toolCount: number;
		hasResult: boolean;
	}>;
	/** v1.8 §6.2 owner metadata. */
	customTitle?: string | null;
	archivedAt?: string | null;
	/**
	 * The ST session the conversation belongs to. Untagged conversations are
	 * listed for every session with history (the default); a session in
	 * `scopedSessions` lists only the conversations tagged with it.
	 */
	sessionId?: string;
	/** A delivered send is answered: an assistant message + `turn_end` under the send's prompt id. */
	reply?: string;
	/** Every send to this conversation is refused with this answer (e.g. 409 busy). */
	sendError?: { status: number; error: string; detail?: string };
}

const T0 = Date.parse("2026-10-31T10:00:00Z");
const iso = (offsetSec: number) => new Date(T0 + offsetSec * 1000).toISOString();

export const USERS: Record<string, MockUser> = {
	alice: { userId: "u-alice", username: "alice", isAdmin: false, isLead: false },
	bob: { userId: "u-bob", username: "bob", isAdmin: false, isLead: false },
	lead: { userId: "u-lead", username: "lead", isAdmin: false, isLead: true },
	admin: { userId: "u-admin", username: "admin", isAdmin: true, isLead: false },
};

export const SESSION_IDS = {
	running: "aaaaaaaa-1111-4111-8111-111111111111",
	stopped: "bbbbbbbb-2222-4222-8222-222222222222",
	terminated: "cccccccc-3333-4333-8333-333333333333",
	bob: "dddddddd-4444-4444-8444-444444444444",
};

// ── Projects & Agents (P3a, docs/PROJECTS.md) ──────────────────────────────
// Off by default: with `projectChat` false the mock answers exactly as before
// (no `features`, no `binding`, the project routes 404) — the visual
// baselines and every other spec run against that. `enableProjects()` seeds
// the Educación HZ directory of design 16's fixture, re-stamped around this
// harness's clock and bound to alice's own sessions.

export const PROJECT_IDS = { hz: "6b1f2c3d-0000-4000-8000-000000000001" };

/** The seeded project-conversation threads (enableProjectConversation). */
export const PROJECT_MSG_IDS = {
	polling: "c1000000-0000-4000-8000-000000000001",
	notes: "c1000000-0000-4000-8000-000000000002",
	backup: "c1000000-0000-4000-8000-000000000003",
	old: "c1000000-0000-4000-8000-000000000000",
};

export const AGENT_IDS = {
	architect: "a0000000-0000-4000-8000-0000000000a1",
	developer: "a0000000-0000-4000-8000-0000000000a2",
	developer2: "a0000000-0000-4000-8000-0000000000a3",
	qa: "a0000000-0000-4000-8000-0000000000a4",
	designer: "a0000000-0000-4000-8000-0000000000a5",
	removed: "a0000000-0000-4000-8000-0000000000a9",
};

/** Sessions `enableProjects()` adds to alice's list. */
export const PROJECT_SESSION_IDS = {
	architect: "3f2a0000-0000-4000-8000-000000000001",
	developer2: "7e110000-0000-4000-8000-000000000003",
	designer: "d5e60000-0000-4000-8000-000000000005",
	scratch: "01d00000-0000-4000-8000-000000000099",
};

export interface MockPresence {
	value: string;
	detail?: string;
	source: string;
	at: string | null;
	verified?: boolean;
}

export interface MockBinding {
	bindingId: string;
	epoch: number;
	sessionId: string;
	state: "active" | "draining" | "retired";
	createdAt: string;
	retiredAt: string | null;
	retireReason: string | null;
}

export interface MockAgent {
	agentId: string;
	projectId: string;
	handle: string;
	role: string | null;
	createdAt: string;
	removedAt: string | null;
	bindings: MockBinding[];
	presence: MockPresence;
}

export interface MockProject {
	projectId: string;
	ownerUserId: string;
	name: string;
	createdAt: string;
}

function seedSessions(): MockSession[] {
	return [
		{
			sessionId: SESSION_IDS.running,
			ownerUserId: "u-alice",
			name: "my-project",
			status: "running",
			tabs: [
				{ tabId: "tab-1", label: "Tab 1", createdAt: T0 },
				{ tabId: "tab-2", label: "Tab 2", createdAt: T0 + 1000 },
			],
			createdAt: iso(-3600),
		},
		{
			sessionId: SESSION_IDS.stopped,
			ownerUserId: "u-alice",
			name: "docs",
			status: "stopped",
			tabs: [],
			createdAt: iso(-7200),
		},
		{
			sessionId: SESSION_IDS.terminated,
			ownerUserId: "u-alice",
			name: "old-poc",
			status: "terminated",
			tabs: [],
			createdAt: iso(-86400),
		},
		{
			sessionId: SESSION_IDS.bob,
			ownerUserId: "u-bob",
			name: "bob-api",
			status: "running",
			tabs: [{ tabId: "tab-b1", label: "Tab 1", createdAt: T0 }],
			createdAt: iso(-1800),
		},
	];
}

function seedFs(): FsDir {
	return {
		type: "dir",
		entries: {
			"README.md": {
				type: "file",
				content:
					"# my-project\n\nA sample workspace for the e2e harness.\n\n- [auth](src/auth.ts)\n",
			},
			"package.json": {
				type: "file",
				content: '{\n  "name": "my-project",\n  "private": true\n}\n',
			},
			".env": { type: "file", content: "SECRET=1\n", restricted: true },
			src: {
				type: "dir",
				entries: {
					"index.ts": { type: "file", content: 'export const hello = "world";\n' },
					"auth.ts": {
						type: "file",
						content: "export function login(user: string) {\n\treturn user.length > 0;\n}\n",
					},
				},
			},
		},
	};
}

function seedConversations(): Conversation[] {
	const c1: ConversationEvent[] = [
		{
			seq: 1,
			ts: iso(0),
			ev: "user_prompt",
			prompt_id: "p1",
			turn_id: "t1",
			agent_id: null,
			pane: "%1",
			data: { prompt: "Refactor the auth flow to use the new session cookie.", source: "user" },
		},
		{
			seq: 2,
			ts: iso(5),
			ev: "tool_start",
			prompt_id: "p1",
			turn_id: "t1",
			agent_id: null,
			pane: "%1",
			data: { tool_use_id: "tu1", tool_name: "Edit", summary: { path: "src/auth.ts" } },
		},
		{
			seq: 3,
			ts: iso(7),
			ev: "tool_end",
			prompt_id: "p1",
			turn_id: "t1",
			agent_id: null,
			pane: "%1",
			data: { tool_use_id: "tu1", tool_name: "Edit", duration_ms: 1800 },
		},
		{
			seq: 4,
			ts: iso(9),
			ev: "assistant_delta",
			prompt_id: "p1",
			turn_id: "t1",
			agent_id: null,
			pane: "%1",
			data: {
				message_id: "m1",
				index: 0,
				delta: "Done. I moved the cookie check into `login()` and added a test.",
				final: true,
			},
		},
		{
			seq: 5,
			ts: iso(10),
			ev: "turn_end",
			prompt_id: "p1",
			turn_id: "t1",
			agent_id: null,
			pane: "%1",
			data: {
				last_assistant_message: "Done. I moved the cookie check into `login()` and added a test.",
			},
		},
	];
	const c2: ConversationEvent[] = [
		{
			seq: 1,
			ts: iso(-3000),
			ev: "user_prompt",
			prompt_id: "p9",
			turn_id: "t9",
			agent_id: null,
			pane: "%2",
			data: { prompt: "Fix the failing tests in packages/core.", source: "user" },
		},
		{
			seq: 2,
			ts: iso(-2990),
			ev: "assistant_delta",
			prompt_id: "p9",
			turn_id: "t9",
			agent_id: null,
			pane: "%2",
			data: { message_id: "m9", index: 0, delta: "All green now.", final: true },
		},
	];
	return [
		{
			cid: "conv-1",
			title: "Refactor auth flow",
			kind: "interactive",
			status: "waiting_input",
			canSendInput: true,
			events: c1,
			startedAt: iso(-10),
		},
		{
			cid: "conv-2",
			title: "Fix tests",
			kind: "interactive",
			status: "ended",
			canSendInput: false,
			events: c2,
			startedAt: iso(-3100),
		},
	];
}

const GIT_PATCH = `diff --git a/src/auth.ts b/src/auth.ts
index 1111111..2222222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,5 @@
-export function login(user: string) {
-\treturn user.length > 0;
+export function login(user: string, cookie: string | null) {
+\tif (cookie === null) return false;
+\treturn user.length > 0;
 }
+export const VERSION = 2;
`;

// ── Recorded traffic ────────────────────────────────────────────────────────

export type DelayKey =
	| "tabs"
	| "fsList"
	| "fsPreview"
	| "gitStatus"
	| "gitLog"
	| "gitDiff"
	| "conversations"
	| "events"
	| "projects";

function delayKeyOf(path: string): DelayKey | null {
	if (/\/tabs$/.test(path)) return "tabs";
	if (/\/fs\/list$/.test(path)) return "fsList";
	if (/\/fs\/preview$/.test(path)) return "fsPreview";
	if (/\/git\/status$/.test(path)) return "gitStatus";
	if (/\/git\/log$/.test(path)) return "gitLog";
	if (/\/git\/diff$/.test(path)) return "gitDiff";
	if (/\/conversations$/.test(path)) return "conversations";
	if (/\/events$/.test(path)) return "events";
	if (path === "/projects") return "projects";
	return null;
}

export interface TerminalSocket {
	sessionId: string;
	tabId: string | null;
	observe: boolean;
	/** Every frame the app sent, parsed. */
	sent: Array<Record<string, unknown>>;
	route: WebSocketRoute;
	closed: boolean;
}

export interface ConversationSocket {
	sessionId: string;
	following: { cid: string; after: number } | null;
	route: WebSocketRoute;
}

// ── The backend ─────────────────────────────────────────────────────────────

export class MockBackend {
	current: MockUser | null = null;
	sessions: MockSession[] = seedSessions();
	fs: FsDir = seedFs();
	conversations: Conversation[] = seedConversations();
	/** Which sessions have captured history (the list answers [] for the others). */
	historySessions = new Set<string>([SESSION_IDS.running, SESSION_IDS.stopped]);
	/** Sessions whose conversation list is only their own tagged conversations. */
	scopedSessions = new Set<string>();
	/** Capture state reported for the running session. */
	capture = { requested: true, effective: true, effectiveAfterRestart: true };
	/** Which push/notification shape the server reports. */
	pushEnabled = false;
	/** The operator's shell (UI_SHELL) as /auth/status reports it. */
	uiShell: "v1" | "v2" = "v1";
	requests: Array<{ method: string; path: string }> = [];
	terminalSockets: TerminalSocket[] = [];
	conversationSockets: ConversationSocket[] = [];
	/** v1.8 §6.2: the list says the owner metadata could not be read. */
	metaUnavailable = false;
	/**
	 * The next rename/archive PATCH answers this instead (then clears). `afterWrite`: the change is
	 * applied first — the real backend writes before it builds its answer, so a 5xx can follow a write.
	 */
	failNextMetaPatch: { status: number; error: string; afterWrite?: boolean } | null = null;
	/** Hold every rename/archive answer this long (ms). */
	metaPatchDelayMs = 0;
	/** Set by a test to answer any route itself before the built-ins. */
	override: ((method: string, path: string, route: Route) => Promise<boolean>) | null = null;
	/**
	 * Deterministic latency per endpoint family, in ms (a test sets it):
	 * the answer is held that long before it is sent. For the races a
	 * fast mock would never show (a route applied while a listing or the
	 * git status is still on its way).
	 */
	delays: Partial<Record<DelayKey, number>> = {};

	// ── Projects & Agents (P3a) ──
	/** PROJECT_CHAT_ENABLED: `features.projectChat` + `binding` on rows + the routes. */
	projectChat = false;
	/** The directory read failed: `/sessions` rows carry NO `binding` key (unknown). */
	bindingReadFails = false;
	/**
	 * A hard delete of a bound session is refused at the server's SECOND
	 * check (PROJECTS.md §6): the soft delete has already happened (the row
	 * is `terminated`, kept) when the 409 `agent-active` answers.
	 */
	hardDeleteRefusedAfterSoftDelete = false;
	projects: MockProject[] = [];
	agents: MockAgent[] = [];
	// ── Project conversation (Projects v3, PROJECT_CONVERSATION.md D1) ──
	/** PROJECT_CONVERSATION_ENABLED: `features.projectConversation` + the §5 routes. */
	projectConversation = false;
	/** The project log, persisted lines in seq order (§2.2 shape). */
	projectLog: Array<Record<string, unknown>> = [];
	/** The events page never holds more than this (a test lowers it to exercise paging). */
	projectPageCap = 500;
	/** What a send to each agent ends as (default: delivered). */
	projectSendOutcome = new Map<string, { state: string; reason?: string }>();
	/** clientMessageId → msg_id (idempotency, §3.4 rule 2). */
	private projectSends = new Map<string, { msgId: string; hash: string }>();
	/** Agent text in the captures, by `${sid}\n${cid}\n${seq}` (what a reply_ref points at). */
	projectCaptures = new Map<string, Record<string, unknown>>();
	/** Every POST body the conversation route received. */
	projectMessagePosts: Array<Record<string, unknown>> = [];
	/** Every ack POST body received. */
	projectAckPosts: Array<Record<string, unknown>> = [];
	/** The next message POST is written, then its answer is lost (the connection resets). */
	loseNextMessageAnswer = false;
	/** Idempotency records, by `${owner}\n${clientRequestId}`. */
	private creations = new Map<string, { hash: string; kind: "project" | "agent"; id: string }>();
	/**
	 * The next project write (POST /projects, POST …/agents, DELETE …/agents/:aid)
	 * answers this instead. `apply`: the write lands first (a lost answer).
	 */
	failNextProjectWrite: { status: number; error: string; apply: boolean } | null = null;
	/** Every project-directory write, with its JSON body, in arrival order. */
	projectWrites: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
	private seq = 100;

	/** Start every test logged in as `username` (skips the login form). */
	loginAs(username: keyof typeof USERS): void {
		this.current = USERS[username]!;
	}

	session(id: string): MockSession | undefined {
		return this.sessions.find((s) => s.sessionId === id);
	}

	/**
	 * Pilot 1 (doc 18): after `enableProjects()`, give three agents' sessions
	 * their own conversation — the architect's and developer-2's answer a
	 * delivered send, the designer's refuses every send with 409 `busy`.
	 */
	seedPilot(): void {
		const conv = (
			cid: string,
			sessionId: string,
			title: string,
			extra: Partial<Conversation>,
		): Conversation => ({
			cid,
			title,
			kind: "interactive",
			status: "waiting_input",
			statusEvidence: "probe:idle",
			canSendInput: true,
			startedAt: iso(-600),
			sessionId,
			events: [
				{
					seq: 1,
					ts: iso(-600),
					ev: "session_start",
					prompt_id: null,
					turn_id: null,
					agent_id: null,
					pane: "%1",
					data: {},
				},
			],
			...extra,
		});
		for (const sid of [
			PROJECT_SESSION_IDS.architect,
			PROJECT_SESSION_IDS.developer2,
			PROJECT_SESSION_IDS.designer,
		]) {
			this.historySessions.add(sid);
			this.scopedSessions.add(sid);
		}
		this.conversations.push(
			conv("c-pilot-arch", PROJECT_SESSION_IDS.architect, "Architecture", {
				reply: "Plan: split the import into two steps.",
			}),
			conv("c-pilot-dev2", PROJECT_SESSION_IDS.developer2, "Implementation", {
				reply: "Review: step two needs a rollback.",
			}),
			conv("c-pilot-design", PROJECT_SESSION_IDS.designer, "Design", {
				sendError: { status: 409, error: "busy" },
			}),
		);
	}

	/** Turn the P3a directory on, seeded (design 16 fixture, bound to alice's sessions). */
	enableProjects(): void {
		this.projectChat = true;
		const at = (sec: number) => iso(30 * 60 - sec); // `sec` before the page's clock
		const extra = (sessionId: string, name: string, status: MockSession["status"]) =>
			this.sessions.push({
				sessionId,
				ownerUserId: "u-alice",
				name,
				status,
				tabs: status === "running" ? [{ tabId: "tab-1", label: "Tab 1", createdAt: T0 }] : [],
				createdAt: iso(-1200),
			});
		extra(PROJECT_SESSION_IDS.architect, "hz-architect", "running");
		extra(PROJECT_SESSION_IDS.developer2, "hz-dev-2", "running");
		extra(PROJECT_SESSION_IDS.designer, "hz-design", "running");
		extra(PROJECT_SESSION_IDS.scratch, "scratch", "running");
		const pid = PROJECT_IDS.hz;
		this.projects = [
			{ projectId: pid, ownerUserId: "u-alice", name: "Educación HZ", createdAt: iso(-7200) },
		];
		const bind = (id: string, sessionId: string, createdAt: string): MockBinding => ({
			bindingId: `b0000000-0000-4000-8000-0000000000${id}`,
			epoch: 1,
			sessionId,
			state: "active",
			createdAt,
			retiredAt: null,
			retireReason: null,
		});
		const agent = (
			agentId: string,
			handle: string,
			role: string,
			binding: MockBinding,
			presence: MockPresence,
		): MockAgent => ({
			agentId,
			projectId: pid,
			handle,
			role,
			createdAt: binding.createdAt,
			removedAt: null,
			bindings: [binding],
			presence,
		});
		this.agents = [
			agent(
				AGENT_IDS.architect,
				"architect-hz",
				"Architect",
				bind("b1", PROJECT_SESSION_IDS.architect, iso(-3600)),
				{ value: "waiting_input", source: "probe", at: at(34), verified: true },
			),
			agent(
				AGENT_IDS.developer,
				"developer-hz",
				"Developer",
				bind("b2", SESSION_IDS.running, iso(-3300)),
				{ value: "working", source: "hook", at: at(5) },
			),
			agent(
				AGENT_IDS.developer2,
				"developer-hz-2",
				"Developer",
				bind("b5", PROJECT_SESSION_IDS.developer2, iso(-2400)),
				{ value: "unknown", detail: "stale", source: "hook", at: at(31 * 60) },
			),
			agent(AGENT_IDS.qa, "qa-hz", "QA & Release", bind("b3", SESSION_IDS.stopped, iso(-3000)), {
				value: "disconnected",
				detail: "session-stopped",
				source: "session",
				at: at(80 * 60),
			}),
			agent(
				AGENT_IDS.designer,
				"designer-hz",
				"Designer",
				bind("b4", PROJECT_SESSION_IDS.designer, iso(-2700)),
				{ value: "needs_attention", detail: "waiting_permission", source: "hook", at: at(47) },
			),
			{
				agentId: AGENT_IDS.removed,
				projectId: pid,
				handle: "designer-old",
				role: "Designer",
				createdAt: iso(-90000),
				removedAt: iso(-5000),
				bindings: [
					{
						...bind("b9", "d5e60000-0000-4000-8000-000000000004", iso(-90000)),
						state: "retired",
						retiredAt: iso(-5000),
						retireReason: "agent-removed",
					},
				],
				presence: {
					value: "disconnected",
					detail: "agent-removed",
					source: "directory",
					at: iso(-5000),
				},
			},
		];
	}

	// ── Project conversation (Projects v3) ──

	private projectSeq = 0;

	/** Append a line to the project log (seq assigned here, like the writer). */
	appendProjectEvent(line: Record<string, unknown>): Record<string, unknown> {
		// Appendix A: `at` (ISO UTC) and the writer's identity on every line.
		const e = {
			seq: ++this.projectSeq,
			at: line.at ?? iso(30 * 60 - 60 + this.projectSeq),
			w: "b-mock",
			bn: 0,
			...line,
		};
		this.projectLog.push(e);
		return e;
	}

	/** An owner message plus its deliveries, as the server would write them. */
	projectTask(
		msgId: string,
		to: string[],
		text: string,
		extra: Record<string, unknown> = {},
		outcome: (agentId: string) => { state: string; reason?: string } = (a) =>
			this.projectSendOutcome.get(a) ?? { state: "delivered" },
	): void {
		this.appendProjectEvent({
			ev: "message",
			msg_id: msgId,
			client_message_id: `cm-${msgId}`,
			by: "u-alice",
			kind: "owner",
			to,
			text,
			artifacts: [],
			...extra,
		});
		for (const a of to) {
			const o = outcome(a);
			const base = { ev: "delivery", msg_id: msgId, agent_id: a, authorized_by: "owner" };
			this.appendProjectEvent({ ...base, state: "planned" });
			if (o.state !== "not-sent") this.appendProjectEvent({ ...base, state: "sending" });
			this.appendProjectEvent({ ...base, state: o.state, ...(o.reason ? { reason: o.reason } : {}) });
		}
	}

	/** The agent's turn ends: its text lands in its capture and the log gets a reply_ref. */
	async projectReply(
		msgId: string,
		agentId: string,
		text: string,
		attribution = "exact",
		opts: { settleOnly?: boolean } = {},
	): Promise<void> {
		const a = this.agent(agentId);
		const sid = a.bindings[0]!.sessionId;
		const cid = `conv-${agentId.slice(-4)}`;
		const turnEndSeq = 1000 + this.projectCaptures.size;
		this.projectCaptures.set(`${sid}\n${cid}\n${turnEndSeq}`, {
			seq: turnEndSeq,
			ts: iso(30 * 60 - 30),
			ev: "turn_end",
			prompt_id: `p-${msgId}-${agentId.slice(-4)}`,
			turn_id: null,
			agent_id: null,
			pane: null,
			data: { last_assistant_message: text },
		});
		const digest = createHash("sha256").update(text, "utf8").digest("hex");
		const fields = {
			msg_id: msgId,
			agent_id: agentId,
			sid,
			cid,
			prompt_id: `p-${msgId}-${agentId.slice(-4)}`,
			seq_from: turnEndSeq - 3,
			seq_to: turnEndSeq,
			turn_end_seq: turnEndSeq,
			report_sha256: digest,
			report_bytes: Buffer.byteLength(text),
			truncated: false,
		};
		// §4.1: the settle window opens, then (10 s later on the real server) the reply_ref.
		this.appendProjectEvent({ ev: "reply_settling", ...fields, settle_until: iso(30 * 60 - 20) });
		if (opts.settleOnly) return;
		this.appendProjectEvent({ ev: "reply_ref", ...fields, attribution });
	}

	/** Projects on, plus the conversation log, seeded with three concurrent threads. */
	async enableProjectConversation(): Promise<void> {
		this.enableProjects();
		this.projectConversation = true;
		const dev = AGENT_IDS.developer;
		const arch = AGENT_IDS.architect;
		const dev2 = AGENT_IDS.developer2;
		this.projectTask(PROJECT_MSG_IDS.polling, [dev], "Make the project page poll adaptively\n5 s while an agent works, 15 s at rest.");
		this.projectTask(PROJECT_MSG_IDS.notes, [arch], "Write the release notes", {}, () => ({
			state: "refused",
			reason: "busy",
		}));
		this.projectTask(PROJECT_MSG_IDS.backup, [arch, dev2], "Check the VM backups", {}, (a) =>
			a === dev2 ? { state: "unconfirmed" } : { state: "delivered" },
		);
		await this.projectReply(PROJECT_MSG_IDS.polling, dev, "Done: adaptive cadence, timer stopped on logout. 628 tests pass.");
		await this.projectReply(PROJECT_MSG_IDS.backup, arch, "Backups verified: 3 of 3 manifests are fresh.");
	}

	private async projectConversationRoute(
		method: string,
		kind: string,
		id: string | undefined,
		req: ReturnType<Route["request"]>,
		body: Record<string, unknown> | null,
		json: (status: number, body: unknown) => Promise<void>,
		route: Route,
	): Promise<void> {
		if (kind === "events" && method === "GET" && id === undefined) {
			const url = new URL(req.url());
			const before = Number(url.searchParams.get("before") ?? Number.POSITIVE_INFINITY);
			const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), this.projectPageCap);
			const older = this.projectLog.filter((e) => (e.seq as number) < before);
			const page = older.slice(Math.max(0, older.length - limit));
			await json(200, {
				events: page,
				oldestSeq: (page[0]?.seq as number | undefined) ?? null,
				hasMore: page.length < older.length,
			});
			return;
		}
		if (kind === "messages" && method === "GET" && id !== undefined) {
			const msgId = decodeURIComponent(id);
			const message = this.projectLog.find((e) => e.ev === "message" && e.msg_id === msgId);
			if (!message) return json(404, { error: "message-not-found" });
			// Appendix A: the message with its lines grouped, as #590 answers.
			const deliveries = new Map<string, Array<Record<string, unknown>>>();
			const replies = new Map<string, { settling: unknown; ref: unknown; lateCloses: unknown[] }>();
			const acks: unknown[] = [];
			for (const l of this.projectLog) {
				if (l.ev === "owner_ack") {
					if ((l.target as { msg_id?: string }).msg_id === msgId) acks.push(l);
					continue;
				}
				if (l.msg_id !== msgId) continue;
				const agent = l.agent_id as string;
				if (l.ev === "delivery") deliveries.set(agent, [...(deliveries.get(agent) ?? []), l]);
				else if (l.ev === "reply_settling" || l.ev === "reply_ref" || l.ev === "reply_late_close") {
					const r = replies.get(agent) ?? { settling: null, ref: null, lateCloses: [] };
					if (l.ev === "reply_settling") r.settling = l;
					else if (l.ev === "reply_ref") r.ref = l;
					else r.lateCloses.push(l);
					replies.set(agent, r);
				}
			}
			return json(200, {
				message,
				deliveries: [...deliveries].map(([agentId, events]) => ({
					agentId,
					state: events[events.length - 1]!.state,
					events,
				})),
				replies: [...replies].map(([agentId, r]) => ({ agentId, ...r })),
				acks,
			});
		}
		if (kind === "messages" && method === "POST" && id === undefined) {
			this.projectMessagePosts.push(body ?? {});
			const cmid = body?.clientMessageId;
			const to = Array.isArray(body?.to) ? (body.to as string[]) : [];
			const text = typeof body?.text === "string" ? body.text : "";
			if (typeof cmid !== "string" || to.length < 1 || to.length > 8 || text.trim() === "")
				return json(400, { error: "invalid-body" });
			const hash = JSON.stringify({ text, to: [...to].sort(), q: body?.quoteRef ?? null, r: body?.inReplyTo ?? null });
			const prev = this.projectSends.get(cmid);
			const deliveriesOf = (msgId: string) =>
				to.map((agentId) => {
					const last = [...this.projectLog]
						.reverse()
						.find((e) => e.ev === "delivery" && e.msg_id === msgId && e.agent_id === agentId);
					return { agentId, state: last?.state, ...(last?.reason ? { reason: last.reason } : {}) };
				});
			if (prev) {
				if (prev.hash !== hash) return json(409, { error: "idempotency-conflict" });
				return json(202, { msgId: prev.msgId, replayed: true, deliveries: deliveriesOf(prev.msgId) });
			}
			const msgId = `c0000000-0000-4000-8000-${String(this.projectLog.length).padStart(12, "0")}`;
			const q = body?.quoteRef as Record<string, unknown> | undefined;
			this.projectTask(msgId, to, text, {
				client_message_id: cmid,
				...(typeof body?.inReplyTo === "string" ? { in_reply_to: body.inReplyTo } : {}),
				...(q
					? {
							quote_ref: {
								msg_id: q.msgId,
								agent_id: q.agentId,
								prompt_id: q.promptId,
								report_sha256: q.reportSha256,
							},
						}
					: {}),
			});
			this.projectSends.set(cmid, { msgId, hash });
			if (this.loseNextMessageAnswer) {
				// Written, but the client never hears back.
				this.loseNextMessageAnswer = false;
				return route.abort("connectionreset");
			}
			return json(202, { msgId, replayed: false, deliveries: deliveriesOf(msgId) });
		}
		if (kind === "acks" && method === "POST" && id === undefined) {
			this.projectAckPosts.push(body ?? {});
			const cak = body?.clientAckId;
			const t = body?.target as Record<string, unknown> | undefined;
			if (typeof cak !== "string" || !t || typeof t.msgId !== "string")
				return json(400, { error: "invalid-body" });
			const target: Record<string, string> = { msg_id: t.msgId };
			if (typeof t.agentId === "string") target.agent_id = t.agentId;
			if (typeof t.reportSha256 === "string") target.report_sha256 = t.reportSha256;
			const known = this.projectLog.find((e) => e.ev === "owner_ack" && e.client_ack_id === cak);
			if (known) {
				return JSON.stringify(known.target) === JSON.stringify(target)
					? json(200, { ackId: known.ack_id, seq: known.seq, replayed: true })
					: json(409, { error: "idempotency-conflict" });
			}
			if (!this.projectLog.some((e) => e.ev === "message" && e.msg_id === t.msgId))
				return json(404, { error: "message-not-found" });
			const line = this.appendProjectEvent({
				ev: "owner_ack",
				ack_id: `ack-${this.projectLog.length}`,
				client_ack_id: cak,
				by: "u-alice",
				target,
			});
			return json(201, { ackId: line.ack_id, seq: line.seq, replayed: false });
		}
		return json(404, { error: `No mock for ${method} conversation/${kind}` });
	}

	agent(agentId: string): MockAgent {
		const a = this.agents.find((x) => x.agentId === agentId);
		if (!a) throw new Error(`no agent ${agentId}`);
		return a;
	}

	private liveBinding(a: MockAgent): MockBinding | null {
		return a.bindings.find((b) => b.state === "active" || b.state === "draining") ?? null;
	}

	/** The live binding holding a session, in any project. */
	private bindingOf(sessionId: string): { agent: MockAgent; binding: MockBinding } | null {
		for (const agent of this.agents) {
			const b = this.liveBinding(agent);
			if (b?.sessionId === sessionId) return { agent, binding: b };
		}
		return null;
	}

	/** Bind a session to a fresh agent behind the app's back (another tab took it). */
	takeSession(sessionId: string, handle = "someone-else"): void {
		const id = String(++this.seq).padStart(3, "0");
		this.agents.push({
			agentId: `a0000000-0000-4000-8000-000000000${id}`,
			projectId: PROJECT_IDS.hz,
			handle,
			role: null,
			createdAt: iso(1700),
			removedAt: null,
			bindings: [
				{
					bindingId: `b0000000-0000-4000-8000-000000000${id}`,
					epoch: 1,
					sessionId,
					state: "active",
					createdAt: iso(1700),
					retiredAt: null,
					retireReason: null,
				},
			],
			presence: { value: "unknown", source: "capture", at: null },
		});
	}

	private sessionBinding(sessionId: string) {
		const hit = this.bindingOf(sessionId);
		if (!hit) return null;
		return {
			projectId: hit.agent.projectId,
			agentId: hit.agent.agentId,
			handle: hit.agent.handle,
			bindingId: hit.binding.bindingId,
			epoch: hit.binding.epoch,
		};
	}

	private presenceOf(a: MockAgent): MockPresence {
		if (a.removedAt)
			return {
				value: "disconnected",
				detail: "agent-removed",
				source: "directory",
				at: a.removedAt,
			};
		return a.presence;
	}

	private agentEntry(a: MockAgent) {
		const b = this.liveBinding(a);
		return {
			agentId: a.agentId,
			handle: a.handle,
			role: a.role,
			provider: "claude-code",
			template: null,
			binding: b
				? {
						bindingId: b.bindingId,
						epoch: b.epoch,
						sessionId: b.sessionId,
						state: b.state,
						createdAt: b.createdAt,
					}
				: null,
			presence: this.presenceOf(a),
		};
	}

	private agentDetail(a: MockAgent) {
		return {
			...this.agentEntry(a),
			projectId: a.projectId,
			createdAt: a.createdAt,
			removedAt: a.removedAt,
			capabilities: { capture: true, channels: false, directControl: true },
			bindings: a.bindings.map((b) => ({ ...b })),
			can: {
				remove: a.removedAt ? { allowed: false, reason: "agent-removed" } : { allowed: true },
			},
		};
	}

	private liveAgents(pid: string): MockAgent[] {
		return this.agents
			.filter((a) => a.projectId === pid && a.removedAt === null)
			.sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.handle.localeCompare(y.handle));
	}

	private projectSummary(p: MockProject) {
		return {
			projectId: p.projectId,
			name: p.name,
			createdAt: p.createdAt,
			agentCount: this.liveAgents(p.projectId).length,
		};
	}

	/** The project routes (P3a). Null: not a project path. */
	private async handleProjects(
		method: string,
		path: string,
		req: ReturnType<Route["request"]>,
		me: MockUser,
		json: (status: number, body: unknown) => Promise<void>,
		route: Route,
	): Promise<boolean> {
		if (!/^\/projects(\/|$)/.test(path)) return false;
		// Flag off: the paths do not exist (the same 404 as any unknown route).
		if (!this.projectChat) {
			await json(404, { error: `No mock for ${method} ${path}` });
			return true;
		}
		const body =
			method === "POST" ? ((req.postDataJSON() ?? null) as Record<string, unknown> | null) : null;
		if (method !== "GET") this.projectWrites.push({ method, path, body });
		const fail = method !== "GET" ? this.failNextProjectWrite : null;
		if (fail) this.failNextProjectWrite = null;
		// The write's own answer, or the injected one (after applying it when `apply`).
		// A lost answer (`apply`): the write lands, the client hears only the failure.
		const answer = async (status: number, payload: unknown) => {
			if (fail) return json(fail.status, { error: fail.error, message: fail.error });
			if (status === 204) return route.fulfill({ status: 204 });
			return json(status, payload);
		};
		// Refused before any write (`apply: false`).
		if (fail && !fail.apply) {
			await json(fail.status, { error: fail.error, message: fail.error });
			return true;
		}
		const own = (pid: string) =>
			this.projects.find((p) => p.projectId === pid && p.ownerUserId === me.userId);
		type Idem =
			| { kind: "new"; key: string }
			| { kind: "bad" }
			| { kind: "conflict" }
			| { kind: "replay"; id: string };
		const idem = (crid: unknown, kind: "project" | "agent", hash: string): Idem => {
			if (typeof crid !== "string" || !/^[0-9a-f-]{36}$/i.test(crid)) return { kind: "bad" };
			const key = `${me.userId}\n${crid}`;
			const rec = this.creations.get(key);
			if (!rec) return { kind: "new", key };
			if (rec.kind !== kind || rec.hash !== hash) return { kind: "conflict" };
			return { kind: "replay", id: rec.id };
		};

		if (path === "/projects" && method === "GET") {
			const mine = this.projects.filter((p) => p.ownerUserId === me.userId);
			await json(200, {
				projects: mine.map((p) => this.projectSummary(p)),
				can: {
					createProject:
						mine.length < 50 ? { allowed: true } : { allowed: false, reason: "project-limit" },
				},
			});
			return true;
		}
		if (path === "/projects" && method === "POST") {
			const name = typeof body?.name === "string" ? body.name.trim() : "";
			if (name === "" || name.length > 80) {
				await answer(400, { error: "invalid-name", message: "invalid-name" });
				return true;
			}
			const r = idem(body?.clientRequestId, "project", JSON.stringify({ name }));
			if (r.kind === "bad") {
				await answer(400, { error: "invalid-client-request-id" });
				return true;
			}
			if (r.kind === "conflict") {
				await answer(409, { error: "idempotency-conflict" });
				return true;
			}
			if (r.kind === "replay") {
				const p = this.projects.find((x) => x.projectId === r.id)!;
				await answer(201, { ...this.projectSummary(p), replayed: true });
				return true;
			}
			const id = String(++this.seq).padStart(3, "0");
			const p: MockProject = {
				projectId: `6b1f2c3d-0000-4000-8000-000000000${id}`,
				ownerUserId: me.userId,
				name,
				createdAt: iso(1700),
			};
			this.projects.push(p);
			this.creations.set(r.key, {
				kind: "project",
				hash: JSON.stringify({ name }),
				id: p.projectId,
			});
			await answer(201, { ...this.projectSummary(p), replayed: false });
			return true;
		}
		const cv = /^\/projects\/([^/]+)\/conversation\/(events|messages|acks)(?:\/([^/]+))?$/.exec(path);
		if (cv) {
			const project = own(decodeURIComponent(cv[1]!));
			if (!project || !this.projectConversation) {
				await json(404, { error: "not-found" });
				return true;
			}
			await this.projectConversationRoute(method, cv[2]!, cv[3], req, body, json, route);
			return true;
		}
		const m = /^\/projects\/([^/]+)\/agents(?:\/([^/]+))?$/.exec(path);
		if (!m) {
			await json(404, { error: `No mock for ${method} ${path}` });
			return true;
		}
		const pid = decodeURIComponent(m[1]!);
		const aid = m[2] === undefined ? null : decodeURIComponent(m[2]);
		const project = own(pid);
		if (aid === null && method === "GET") {
			if (!project) {
				await json(404, { error: "project-not-found", message: "project-not-found" });
				return true;
			}
			const live = this.liveAgents(pid);
			await json(200, {
				projectId: pid,
				generatedAt: new Date(T0 + 30 * 60 * 1000).toISOString(),
				agents: live.map((a) => this.agentEntry(a)),
				can: {
					createAgent:
						live.length < 32 ? { allowed: true } : { allowed: false, reason: "agent-limit" },
				},
			});
			return true;
		}
		if (aid === null && method === "POST") {
			if (!project) {
				await answer(404, { error: "project-not-found" });
				return true;
			}
			const handle = typeof body?.handle === "string" ? body.handle : "";
			const role = typeof body?.role === "string" ? body.role : null;
			const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
			if (!/^[a-z][a-z0-9-]{1,31}$/.test(handle)) {
				await answer(400, { error: "invalid-handle" });
				return true;
			}
			const hash = JSON.stringify({ pid, handle, role, sessionId });
			const r = idem(body?.clientRequestId, "agent", hash);
			if (r.kind === "bad") {
				await answer(400, { error: "invalid-client-request-id" });
				return true;
			}
			if (r.kind === "conflict") {
				await answer(409, { error: "idempotency-conflict" });
				return true;
			}
			if (r.kind === "replay") {
				const a = this.agent(r.id);
				await answer(201, {
					...this.agentEntry(a),
					projectId: pid,
					createdAt: a.createdAt,
					removedAt: a.removedAt,
					replayed: true,
				});
				return true;
			}
			const s = this.session(sessionId);
			if (!s || s.ownerUserId !== me.userId || s.status === "terminated") {
				await answer(404, { error: "session-not-found" });
				return true;
			}
			if (this.agents.some((a) => a.projectId === pid && a.handle === handle)) {
				await answer(409, { error: "handle-taken" });
				return true;
			}
			if (this.bindingOf(sessionId)) {
				await answer(409, { error: "session-taken" });
				return true;
			}
			if (this.liveAgents(pid).length >= 32) {
				await answer(409, { error: "agent-limit" });
				return true;
			}
			const id = String(++this.seq).padStart(3, "0");
			const a: MockAgent = {
				agentId: `a0000000-0000-4000-8000-000000000${id}`,
				projectId: pid,
				handle,
				role,
				createdAt: iso(1700),
				removedAt: null,
				bindings: [
					{
						bindingId: `b0000000-0000-4000-8000-000000000${id}`,
						epoch: 1,
						sessionId,
						state: "active",
						createdAt: iso(1700),
						retiredAt: null,
						retireReason: null,
					},
				],
				presence:
					s.status === "running"
						? { value: "unknown", source: "capture", at: null }
						: { value: "disconnected", detail: `session-${s.status}`, source: "session", at: null },
			};
			this.agents.push(a);
			this.creations.set(r.key, { kind: "agent", hash, id: a.agentId });
			await answer(201, {
				...this.agentEntry(a),
				projectId: pid,
				createdAt: a.createdAt,
				removedAt: null,
				replayed: false,
			});
			return true;
		}
		const a =
			aid === null ? undefined : this.agents.find((x) => x.agentId === aid && x.projectId === pid);
		if (!project || !a) {
			if (method === "DELETE") await answer(404, { error: "agent-not-found" });
			else await json(404, { error: "agent-not-found", message: "agent-not-found" });
			return true;
		}
		if (method === "GET") {
			await json(200, this.agentDetail(a));
			return true;
		}
		if (method === "DELETE") {
			if (a.removedAt === null) {
				a.removedAt = iso(1700);
				const live = this.liveBinding(a);
				if (live) {
					live.state = "retired";
					live.retiredAt = a.removedAt;
					live.retireReason = "agent-removed";
				}
			}
			await answer(204, null);
			return true;
		}
		await json(404, { error: `No mock for ${method} ${path}` });
		return true;
	}

	async install(page: Page): Promise<void> {
		await page.route(
			(url) => url.pathname.startsWith("/api/"),
			(route) => this.handle(route),
		);
		await page.routeWebSocket(
			(url) => url.pathname.startsWith("/ws/"),
			(ws) => this.handleSocket(ws),
		);
	}

	// ── Live pushes (from a test) ───────────────────────────────────────────

	/** Append an event to a conversation and deliver it to the socket following it. */
	pushConversationEvent(cid: string, ev: Omit<ConversationEvent, "seq">): ConversationEvent {
		const conv = this.conversations.find((c) => c.cid === cid);
		if (!conv) throw new Error(`no conversation ${cid}`);
		const seq = (conv.events[conv.events.length - 1]?.seq ?? 0) + 1;
		const event: ConversationEvent = { ...ev, seq };
		conv.events.push(event);
		for (const s of this.conversationSockets) {
			if (s.following?.cid === cid) {
				s.route.send(JSON.stringify({ type: "event", conv: cid, event }));
			}
		}
		return event;
	}

	/**
	 * Close every open terminal socket of a session with a FINAL code (1008:
	 * the app does not retry), as the backend does for a terminated or
	 * foreign session — the terminal lands on its "disconnected" state.
	 */
	dropTerminalSockets(sessionId: string, code = 1008, reason = "Session gone"): void {
		for (const s of this.terminalSockets) {
			if (s.sessionId === sessionId && !s.closed) {
				s.closed = true;
				s.route.close({ code, reason });
			}
		}
	}

	/** Write bytes to every open terminal socket of a session (as tmux would). */
	pushTerminalOutput(sessionId: string, data: string): void {
		for (const s of this.terminalSockets) {
			if (s.sessionId === sessionId && !s.closed) {
				s.route.send(JSON.stringify({ type: "output", data }));
			}
		}
	}

	// ── WebSockets ──────────────────────────────────────────────────────────

	private handleSocket(ws: WebSocketRoute): void {
		const url = new URL(ws.url());
		const parts = url.pathname.split("/").filter(Boolean); // ws, sessions|conversation|bootstrap, id
		const kind = parts[1];
		const sessionId = decodeURIComponent(parts[2] ?? "");
		if (!this.current) {
			ws.close({ code: 1008, reason: "Unauthorized" });
			return;
		}
		if (kind === "sessions") {
			const session = this.session(sessionId);
			const observe = url.searchParams.get("observe") === "true";
			const own = session?.ownerUserId === this.current.userId;
			const allowed =
				session?.status === "running" && (own || this.current.isAdmin || this.current.isLead);
			if (!allowed) {
				ws.close({ code: 1008, reason: "Forbidden" });
				return;
			}
			const sock: TerminalSocket = {
				sessionId,
				tabId: url.searchParams.get("tab"),
				observe,
				sent: [],
				route: ws,
				closed: false,
			};
			this.terminalSockets.push(sock);
			ws.onMessage((raw) => {
				try {
					const msg = JSON.parse(String(raw)) as Record<string, unknown>;
					sock.sent.push(msg);
					// A shell echo: what the person types comes back as output.
					if (msg.type === "input" && typeof msg.data === "string" && !observe) {
						ws.send(JSON.stringify({ type: "output", data: msg.data }));
					}
				} catch {
					/* ignore non-JSON */
				}
			});
			ws.onClose(() => {
				sock.closed = true;
			});
			ws.send(JSON.stringify({ type: "status", status: "running" }));
			ws.send(
				JSON.stringify({
					type: "output",
					data: `Welcome to ${session!.name} (${sock.tabId ?? "?"})\r\n$ `,
				}),
			);
			return;
		}
		if (kind === "conversation") {
			const sock: ConversationSocket = { sessionId, following: null, route: ws };
			this.conversationSockets.push(sock);
			ws.onMessage((raw) => {
				const msg = JSON.parse(String(raw)) as { type: string; conv?: string; after?: number };
				if (msg.type === "subscribe" && msg.conv !== undefined) {
					const after = msg.after ?? 0;
					sock.following = { cid: msg.conv, after };
					const conv = this.conversations.find((c) => c.cid === msg.conv);
					if (!conv) {
						ws.send(JSON.stringify({ type: "error", code: "not-found", conv: msg.conv }));
						return;
					}
					for (const event of conv.events) {
						if (event.seq > after) {
							ws.send(JSON.stringify({ type: "event", conv: conv.cid, event }));
						}
					}
				}
			});
			ws.send(
				JSON.stringify({
					type: "hello",
					conversations: this.conversations.map((c) => ({
						cid: c.cid,
						lastSeq: c.events[c.events.length - 1]?.seq ?? 0,
						firstRetainedSeq: 1,
						status: c.status,
					})),
				}),
			);
			return;
		}
		ws.close({ code: 1008, reason: "Unknown route" });
	}

	// ── REST ────────────────────────────────────────────────────────────────

	private async handle(route: Route): Promise<void> {
		const req = route.request();
		const url = new URL(req.url());
		const path = url.pathname.replace(/^\/api/, "");
		const method = req.method();
		this.requests.push({ method, path: path + url.search });
		if (this.override && (await this.override(method, path + url.search, route))) return;
		const key = delayKeyOf(path);
		const held = key === null ? 0 : (this.delays[key] ?? 0);
		if (held > 0) await new Promise((r) => setTimeout(r, held));
		const json = (status: number, body: unknown) =>
			route.fulfill({
				status,
				contentType: "application/json",
				body: JSON.stringify(body),
			});

		// ── auth ──
		if (path === "/auth/status") {
			return json(200, {
				needsSetup: false,
				authenticated: this.current !== null,
				isAdmin: this.current?.isAdmin ?? false,
				isLead: this.current?.isLead ?? false,
				resourceCaps: { cpuMaxCores: 8, memMaxMiB: 16384 },
				uiShell: this.uiShell,
				// P3a: present only with the flag on (byte-identical answer otherwise).
				...(this.projectChat
					? {
							features: this.projectConversation
								? { projectChat: true, projectConversation: true }
								: { projectChat: true },
						}
					: {}),
			});
		}
		if (path === "/auth/login" && method === "POST") {
			const body = req.postDataJSON() as { username?: string; password?: string };
			const user = USERS[body.username ?? ""];
			if (!user || body.password !== "pw") return json(401, { error: "Invalid credentials" });
			this.current = user;
			return json(200, { userId: user.userId, isAdmin: user.isAdmin, isLead: user.isLead });
		}
		if (path === "/auth/logout") {
			this.current = null;
			return route.fulfill({ status: 204 });
		}
		if (!this.current) return json(401, { error: "Unauthorized" });
		const me = this.current;

		// ── misc shell endpoints ──
		if (path === "/push/status") return json(200, { enabled: this.pushEnabled, subscribed: false });
		if (path === "/quotas") {
			return json(200, {
				effective: { maxSessions: 5, maxTotalCpu: null, maxTotalMem: null },
				usage: { activeSessions: 2, runningSessions: 1, cpuNanos: 0, memBytes: 0 },
			});
		}
		if (path === "/templates") return json(200, []);
		if (path === "/invites") return json(200, me.isAdmin ? [] : { error: "Forbidden" });

		// ── groups (lead) ──
		if (path === "/groups/mine") {
			return json(
				200,
				me.isLead
					? [
							{
								id: "g1",
								name: "Platform",
								description: "Backend crew",
								leadUserId: me.userId,
								createdAt: iso(-90000),
								updatedAt: iso(-90000),
								members: [{ userId: "u-bob", username: "bob", addedAt: iso(-80000) }],
							},
						]
					: [],
			);
		}
		if (path === "/groups/mine/sessions") {
			return json(200, me.isLead ? [this.observable(this.session(SESSION_IDS.bob)!)] : []);
		}

		// ── admin ──
		if (path.startsWith("/admin/")) {
			if (!me.isAdmin) return json(403, { error: "Forbidden" });
			if (path === "/admin/stats") return json(200, this.adminStats());
			if (path === "/admin/sessions") {
				return json(
					200,
					this.sessions.map((s) => ({
						...this.serialize(s),
						userId: s.ownerUserId,
						ownerUsername: this.ownerName(s),
					})),
				);
			}
			if (path === "/admin/users") {
				return json(
					200,
					Object.values(USERS).map((u) => ({
						userId: u.userId,
						username: u.username,
						isAdmin: u.isAdmin,
						createdAt: iso(-100000),
						quotas: { maxSessions: null, maxTotalCpu: null, maxTotalMem: null },
						effective: { maxSessions: 5, maxTotalCpu: null, maxTotalMem: null },
						usage: { activeSessions: 1, runningSessions: 1, cpuNanos: 0, memBytes: 0 },
					})),
				);
			}
			if (path === "/admin/groups") return json(200, []);
			if (path === "/admin/observe-log") return json(200, []);
			return json(404, { error: "Not found" });
		}

		// ── projects & agents (P3a) ──
		if (await this.handleProjects(method, path, req, me, json, route)) return;

		// ── sessions ──
		if (path === "/sessions" && method === "GET") {
			const all = url.searchParams.get("all") === "true";
			return json(
				200,
				this.sessions
					.filter((s) => s.ownerUserId === me.userId && (all || s.status !== "terminated"))
					.map((s) =>
						// P3a: `binding` only with the flag on, and the key ABSENT when the directory
						// read failed — the frontend must tell that apart from null.
						this.projectChat && !this.bindingReadFails
							? { ...this.serialize(s), binding: this.sessionBinding(s.sessionId) }
							: this.serialize(s),
					),
			);
		}
		const m = /^\/sessions\/([^/]+)(\/.*)?$/.exec(path);
		if (m) {
			const id = decodeURIComponent(m[1]!);
			const rest = m[2] ?? "";
			const s = this.session(id);
			if (!s) return json(404, { error: "Session not found" });
			const own = s.ownerUserId === me.userId;
			// Read surfaces (files, git, conversations) are owner-only: a
			// foreign session answers 404 exactly like a missing one.
			if (!own && !me.isAdmin && !me.isLead) return json(404, { error: "Session not found" });
			if (rest === "" && method === "GET") return json(200, this.serialize(s));
			if (rest === "/start" && method === "POST") {
				s.status = "running";
				return json(200, this.serialize(s));
			}
			if (rest === "/stop" && method === "POST") {
				s.status = "stopped";
				return json(200, this.serialize(s));
			}
			if (rest === "" && method === "DELETE") {
				if (url.searchParams.get("hard") === "true") {
					// PROJECTS.md §6: a live binding refuses the hard delete.
					if (this.projectChat && this.bindingOf(id)) {
						if (this.hardDeleteRefusedAfterSoftDelete) s.status = "terminated";
						return json(409, { error: "agent-active" });
					}
					this.sessions = this.sessions.filter((x) => x.sessionId !== id);
				} else {
					s.status = "terminated";
				}
				return route.fulfill({ status: 204 });
			}
			if (rest === "/tabs" && method === "GET") return json(200, s.tabs);
			if (rest === "/tabs" && method === "POST") {
				const body = (req.postDataJSON() ?? {}) as { label?: string };
				const tab = {
					tabId: `tab-${s.tabs.length + 1}-${Date.now()}`,
					label: body.label ?? `Tab ${s.tabs.length + 1}`,
					createdAt: Date.now(),
				};
				s.tabs.push(tab);
				return json(201, tab);
			}
			const tabDel = /^\/tabs\/([^/]+)$/.exec(rest);
			if (tabDel && method === "DELETE") {
				s.tabs = s.tabs.filter((t) => t.tabId !== decodeURIComponent(tabDel[1]!));
				return route.fulfill({ status: 204 });
			}
			if (rest === "/ports" && method === "GET") {
				return json(200, {
					ports: [{ container: 3000, public: false }],
					allowPrivilegedPorts: false,
				});
			}
			if (rest === "/observe-log") return json(200, []);
			if (rest === "/bootstrap-log") return json(200, { log: null });
			if (!own) return json(404, { error: "Session not found" });

			// ── files ──
			const fs = /^\/fs\/(list|preview|raw)$/.exec(rest);
			if (fs) {
				const rel = url.searchParams.get("path") ?? "";
				const node = this.resolve(rel);
				if (!node) return json(404, { error: "Not found" });
				if (node.restricted) return json(403, { error: "Restricted path" });
				if (fs[1] === "list") {
					if (node.type !== "dir") return json(400, { error: "Not a directory" });
					return json(200, {
						path: rel,
						truncated: false,
						entries: Object.entries(node.entries)
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([name, n]) => ({
								name,
								type: n.type,
								size: n.type === "file" ? n.content.length : null,
								mtime: iso(-60),
								restricted: n.restricted === true,
							})),
					});
				}
				if (node.type !== "file") return json(400, { error: "Not a file" });
				return json(200, {
					path: rel,
					name: rel.split("/").pop(),
					size: node.content.length,
					mtime: iso(-60),
					kind: "text",
					content: node.content,
					truncated: false,
				});
			}

			// ── git ──
			if (rest.startsWith("/git/")) {
				if (s.status !== "running") {
					return json(409, { error: "Session is not running", code: "session-not-running" });
				}
				if (rest === "/git/status") {
					return json(200, {
						repo: true,
						root: "",
						truncated: false,
						branch: "main",
						detached: false,
						head: "abc1234def",
						upstream: "origin/main",
						ahead: 1,
						behind: 0,
						changes: [
							{
								area: "unstaged",
								status: "M",
								xy: " M",
								path: "src/auth.ts",
								oldPath: null,
								additions: 3,
								deletions: 2,
								binary: false,
								restricted: false,
							},
							{
								area: "untracked",
								status: "?",
								xy: "??",
								path: "src/new.ts",
								oldPath: null,
								additions: 4,
								deletions: 0,
								binary: false,
								restricted: false,
							},
						],
					});
				}
				if (rest === "/git/log") {
					return json(200, {
						commits: [
							{
								hash: "abc1234def5678",
								shortHash: "abc1234",
								author: "alice",
								date: iso(-3600),
								subject: "feat: session cookie",
							},
							{
								hash: "9876543210abcd",
								shortHash: "9876543",
								author: "bob",
								date: iso(-86400),
								subject: "chore: scaffold",
							},
						],
					});
				}
				if (rest === "/git/diff") {
					const p = url.searchParams.get("path") ?? "";
					return json(200, {
						path: p,
						area: url.searchParams.get("area") ?? "unstaged",
						patch: p === "src/auth.ts" ? GIT_PATCH : "",
						truncated: false,
						binary: false,
					});
				}
			}

			// ── conversations ──
			if (rest === "/conversations") {
				const withCapture = url.searchParams.get("capture") !== "0";
				return json(200, {
					capture: withCapture ? this.capture : null,
					conversations:
						s.status === "failed" || !this.historySessions.has(s.sessionId)
							? []
							: this.conversations
									.filter((c) =>
										this.scopedSessions.has(s.sessionId)
											? c.sessionId === s.sessionId
											: c.sessionId === undefined,
									)
									.map((c) => this.summary(c)),
					meta: this.metaUnavailable ? "unavailable" : "ok",
				});
			}
			const agentsOf = /^\/conversations\/([^/]+)\/agents$/.exec(rest);
			if (agentsOf && method === "GET") {
				const c = this.conversations.find((x) => x.cid === decodeURIComponent(agentsOf[1]!));
				if (!c) return json(404, { error: "Conversation not found" });
				return json(200, { agents: c.agents ?? [] });
			}
			// v1.8 §6.2 — rename / archive (owner-only, per field, same title rules as the server).
			const metaPatch = /^\/conversations\/([^/]+)$/.exec(rest);
			if (metaPatch && method === "PATCH") {
				if (!own) return json(404, { error: "Session not found" });
				const conv = this.conversations.find((c) => c.cid === decodeURIComponent(metaPatch[1]!));
				if (!conv) return json(404, { error: "conversation-not-found" });
				if (this.metaPatchDelayMs > 0)
					await new Promise((r) => setTimeout(r, this.metaPatchDelayMs));
				const fail = this.failNextMetaPatch;
				this.failNextMetaPatch = null;
				if (fail && !fail.afterWrite) return json(fail.status, { error: fail.error });
				const body = req.postDataJSON() as Record<string, unknown> | null;
				const keys = body && typeof body === "object" ? Object.keys(body) : [];
				if (
					keys.length === 0 ||
					keys.some((k) => k !== "title" && k !== "archived") ||
					("archived" in (body ?? {}) && typeof body?.archived !== "boolean")
				)
					return json(400, { error: "invalid-body" });
				if (body && "title" in body) {
					const t = normalizeTitle(body.title);
					if (!t.ok) return json(400, { error: t.code });
					conv.customTitle = t.value;
				}
				if (body && typeof body.archived === "boolean") {
					conv.archivedAt = body.archived ? (conv.archivedAt ?? iso(30 * 60)) : null;
				}
				if (fail) return json(fail.status, { error: fail.error });
				return json(200, this.summary(conv));
			}
			const one = /^\/conversations\/([^/]+)\/events\/(\d+)$/.exec(rest);
			if (one && method === "GET") {
				const cid = decodeURIComponent(one[1]!);
				const seq = Number(one[2]);
				const cap = this.projectCaptures.get(`${id}\n${cid}\n${seq}`);
				if (cap) return json(200, cap);
				const e = this.conversations.find((c) => c.cid === cid)?.events.find((x) => x.seq === seq);
				return e ? json(200, e) : json(404, { error: "Event not found" });
			}
			const ev = /^\/conversations\/([^/]+)\/events$/.exec(rest);
			if (ev) {
				const conv = this.conversations.find((c) => c.cid === decodeURIComponent(ev[1]!));
				if (!conv) return json(404, { error: "Conversation not found" });
				const before = Number(url.searchParams.get("before") ?? Number.POSITIVE_INFINITY);
				const limit = Number(url.searchParams.get("limit") ?? 200);
				const older = conv.events.filter((e) => e.seq < before);
				const page = older.slice(Math.max(0, older.length - limit));
				return json(200, {
					events: page,
					hasMore: page.length < older.length,
					firstRetainedSeq: 1,
				});
			}
			const msg = /^\/conversations\/([^/]+)\/messages$/.exec(rest);
			if (msg && method === "POST") {
				const conv = this.conversations.find((c) => c.cid === decodeURIComponent(msg[1]!));
				const body = req.postDataJSON() as { text: string; clientMessageId: string };
				if (!conv || !conv.canSendInput) return json(409, { error: "needs-terminal" });
				if (conv.sendError) {
					const { status, ...err } = conv.sendError;
					return json(status, err);
				}
				if (conv.transport === "background") {
					const id = body.clientMessageId;
					const cs = (state: string, extra: Record<string, unknown> = {}) =>
						this.pushConversationEvent(conv.cid, {
							ts: new Date().toISOString(),
							ev: "composer_send",
							prompt_id: null,
							turn_id: null,
							agent_id: null,
							pane: null,
							data: { state, client_message_id: id, transport: "background", ...extra },
						});
					setTimeout(() => cs("accepted"), 30);
					setTimeout(() => {
						if (conv.bgOutcome === "unconfirmed") {
							cs("unconfirmed", { detail: "t-ack-bg" });
							return;
						}
						cs("delivered", { prompt_id: `p-${id}` });
						this.pushConversationEvent(conv.cid, {
							ts: new Date().toISOString(),
							ev: "user_prompt",
							prompt_id: `p-${id}`,
							turn_id: null,
							agent_id: null,
							pane: null,
							data: { prompt: body.text },
						});
						if (conv.bgOutcome === "duplicated" || conv.bgOutcome === "possible-duplicate")
							setTimeout(
								() =>
									cs(conv.bgOutcome as string, {
										prompt_id: `p2-${id}`,
										first_prompt_id: `p-${id}`,
									}),
								200,
							);
					}, 1500);
					return json(202, { result: "accepted", clientMessageId: id });
				}
				// Delivered: the CLI's own user_prompt follows over the socket, and
				// the answer carries its prompt id and seq as the real server's does
				// (§8.1.5: the ack names the user_prompt it matched).
				const promptId = `p-${body.clientMessageId}`;
				const promptSeq = (conv.events[conv.events.length - 1]?.seq ?? 0) + 1;
				const reply = conv.reply;
				setTimeout(() => {
					const base = { turn_id: null, agent_id: null, pane: "%1" };
					this.pushConversationEvent(conv.cid, {
						...base,
						ts: new Date().toISOString(),
						ev: "user_prompt",
						prompt_id: promptId,
						data: { prompt: body.text, source: "user" },
					});
					if (reply === undefined) return;
					setTimeout(() => {
						this.pushConversationEvent(conv.cid, {
							...base,
							ts: new Date().toISOString(),
							ev: "assistant_delta",
							prompt_id: promptId,
							data: { message_id: `m-${promptId}`, index: 0, delta: reply, final: true },
						});
						this.pushConversationEvent(conv.cid, {
							...base,
							ts: new Date().toISOString(),
							ev: "turn_end",
							prompt_id: promptId,
							data: { last_assistant_message: reply },
						});
					}, 150);
				}, 50);
				return json(202, {
					result: "delivered",
					clientMessageId: body.clientMessageId,
					promptId,
					seq: promptSeq,
				});
			}
		}
		return json(404, { error: `No mock for ${method} ${path}` });
	}

	// ── Serializers ─────────────────────────────────────────────────────────

	private ownerName(s: MockSession): string {
		return Object.values(USERS).find((u) => u.userId === s.ownerUserId)?.username ?? "?";
	}

	serialize(s: MockSession) {
		return {
			sessionId: s.sessionId,
			name: s.name,
			status: s.status,
			containerId: s.status === "running" ? `ctr-${s.sessionId.slice(0, 8)}` : null,
			containerName: `st-${s.sessionId.slice(0, 12)}`,
			createdAt: s.createdAt,
			lastConnectedAt: s.status === "running" ? iso(-30) : null,
			cols: 120,
			rows: 40,
			envVars: {},
			cpuLimit: null,
			memLimit: null,
			usage:
				s.status === "running"
					? {
							cpuPercent: 12.5,
							memBytes: 268_435_456,
							memLimitBytes: 2_147_483_648,
							memPercent: 12.5,
						}
					: null,
		};
	}

	private observable(s: MockSession) {
		return {
			sessionId: s.sessionId,
			ownerUserId: s.ownerUserId,
			ownerUsername: this.ownerName(s),
			name: s.name,
			status: s.status,
			containerId: s.status === "running" ? "ctr" : null,
			containerName: `st-${s.sessionId.slice(0, 12)}`,
			cols: 120,
			rows: 40,
			createdAt: s.createdAt,
			lastConnectedAt: null,
		};
	}

	private summary(c: Conversation) {
		const last = c.events[c.events.length - 1];
		return {
			sessionId: c.cid,
			kind: c.kind,
			title: c.title,
			status: c.status,
			statusEvidence: c.statusEvidence ?? "hook",
			// Fresh by default (the fixed test clock is T0 + 30 min): the list's
			// "Active" section only shows live claims with recent evidence.
			statusAt: c.statusAt ?? iso(29 * 60),
			tabId: c.tabId === undefined ? "tab-1" : c.tabId,
			paneId: c.paneId === undefined ? "%1" : c.paneId,
			startedAt: c.startedAt,
			endedAt: c.status === "ended" ? last?.ts : null,
			lastEventAt: last?.ts ?? c.startedAt,
			lastSeq: last?.seq ?? 0,
			firstRetainedSeq: 1,
			eventsCount: c.events.length,
			gapsCount: c.gapsCount ?? 0,
			claudeVersion: "2.1.314",
			canSendInput: c.canSendInput,
			...(c.transport ? { transport: c.transport } : {}),
			customTitle: this.metaUnavailable ? null : (c.customTitle ?? null),
			archivedAt: this.metaUnavailable ? null : (c.archivedAt ?? null),
		};
	}

	private adminStats() {
		const by = { running: 0, stopped: 0, terminated: 0, failed: 0 };
		for (const s of this.sessions) by[s.status]++;
		return {
			bootedAt: iso(-100000),
			uptimeSeconds: 100000,
			sessions: { byStatus: by },
			idleSweeper: { lastSweepAt: T0, sweptSinceBoot: 0, currentMapSize: 2 },
			reconcile: { lastRunAt: T0, sessionsCheckedSinceBoot: 4, errorsSinceBoot: 0 },
			dispatcher: {
				requestsSinceBoot: 0,
				responses2xxSinceBoot: 0,
				responses3xxSinceBoot: 0,
				responses4xxSinceBoot: 0,
				responses5xxSinceBoot: 0,
			},
			d1: { callsSinceBoot: 42 },
			resources: {
				runningCount: by.running,
				statsAvailable: by.running,
				totalCpuPercent: 25,
				totalMemBytes: 536_870_912,
				totalCpuLimitNanos: 4e9,
				totalMemLimitBytes: 4_294_967_296,
				limits: {
					minCpuNanos: 250_000_000,
					maxCpuNanos: 8e9,
					minMemBytes: 268_435_456,
					maxMemBytes: 17_179_869_184,
					defaultCpuNanos: 2e9,
					defaultMemBytes: 2_147_483_648,
				},
			},
		};
	}

	private resolve(rel: string): FsNode | null {
		let node: FsNode = this.fs;
		for (const part of rel.split("/").filter(Boolean)) {
			if (node.type !== "dir") return null;
			const next: FsNode | undefined = node.entries[part];
			if (!next) return null;
			node = next;
		}
		return node;
	}
}
