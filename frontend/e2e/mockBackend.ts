/**
 * mockBackend.ts — a deterministic stand-in for the Shared Terminal backend,
 * installed into a Playwright page with `page.route` (REST) and
 * `page.routeWebSocket` (terminal / ACP sockets).
 *
 * It answers the routes the frontend flows touch with fixed, seeded data
 * (three users with different roles, a running session with tabs,
 * a workspace tree and a git repo, a stopped and a
 * terminated session, a foreign session for the permission tests) and
 * records what the app asked for, so a test can assert on behaviour
 * ("no request to a foreign session", "no resize sent on a view switch")
 * rather than on pixels alone. Every test gets a fresh instance.
 *
 * Shapes mirror `src/api.ts`; keep them in step when the API changes.
 */

import type { Page, Route, WebSocketRoute } from "@playwright/test";

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
	/** Reported memory use of a running session, in % (default 12.5). */
	memPercent?: number;
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

// ── Projects ──────────────────────────────
// On by default, as in production (the constructor calls `enableAcp()`): one
// project and a few more sessions of alice's, @arq and @dev in it, @solo
// without one.

export const PROJECT_IDS = { hz: "6b1f2c3d-0000-4000-8000-000000000001" };

/** Sessions `enableProjects()` adds to alice's list. */
export const PROJECT_SESSION_IDS = {
	architect: "3f2a0000-0000-4000-8000-000000000001",
	developer2: "7e110000-0000-4000-8000-000000000003",
	designer: "d5e60000-0000-4000-8000-000000000005",
	scratch: "01d00000-0000-4000-8000-000000000099",
};

// ── ACP agents ──────────────────────────────
// `enableAcp()` (implies projects): three agents on alice's sessions — @arq and
// @dev in "Educación HZ", @solo without a project — a few finished messages,
// and `/ws/acp` (hello on connect; `pushAcp` delivers a live event).

export interface MockAcpAgent {
	name: string;
	sessionId: string;
	runtime: string;
	model: string | null;
	projectId: string | null;
	runnerSeenAt: string | null;
	running: number[];
	pending: number;
	authRequired?: boolean;
	loginMethods?: Array<{ id: string; name: string; description: string }>;
	waitingInput?: boolean;
	/** v27: what it runs / has queued / waits for, with each message's topic (never slots). */
	runningIn?: Array<{ id: number; conversationId: string | null; work: string | null }>;
	queue?: Array<{ id: number; conversationId: string | null; work: string | null }>;
	waitingFor?: Array<{
		id: number;
		agent: string;
		conversationId: string | null;
		work: string | null;
	}>;
	question?: { id: number; messageId: number | null; conversationId: string | null } | null;
	heldBy?: Array<{ conversationId: string | null; work: string | null; since: string }>;
	modelApplied?: { requested: string; current: string | null; error: string | null } | null;
	effort?: string | null;
	effortApplied?: {
		model: string | null;
		requested: string;
		current: string | null;
		levels: string[];
		error: string | null;
	} | null;
}

export interface MockAcpMessage {
	id: number;
	from_id: string;
	to_id: string;
	kind: "request" | "reply";
	reply_to: number | null;
	body: string;
	state: "pending" | "running" | "done" | "failed" | "uncertain";
	attempts: number;
	created_at: string;
	started_at: string | null;
	finished_at: string | null;
	result_text: string | null;
	stop_reason: string | null;
	note: string | null;
	project_id: string | null;
	depth: number;
	client_id: string | null;
	/** v27: the topic (null: the Archive). */
	conversation_id: string | null;
	/** The work it runs in (`st send --work`), if any. */
	context?: string | null;
	team?: number | null;
	reviewed_at?: string | null;
	recovery_of?: number | null;
}

/** A topic of a project (v27, docs/ACP_AGENTS.md §4b). */
export interface MockConversation {
	id: string;
	projectId: string;
	title: string;
	createdAt: string;
	archivedAt: string | null;
	readAt: string | null;
	recipients: { agents: string[] } | { team: true } | null;
}

/** The topics `enableConversations()` seeds in "Educación HZ". */
export const CONV_IDS = {
	ci: "c0000000-0000-4000-8000-0000000000c1",
	ui: "c0000000-0000-4000-8000-0000000000c2",
	backend: "c0000000-0000-4000-8000-0000000000c3",
};

export interface MockProject {
	projectId: string;
	ownerUserId: string;
	name: string;
	createdAt: string;
	/** Archived like the backend: out of the list, its feed still answers. */
	archivedAt?: string | null;
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

/** A work's worktree: the workspace's files plus what the work changed. */
function seedWorkFs(id: string): FsDir {
	const root = seedFs();
	root.entries[".github"] = {
		type: "dir",
		entries: {
			workflows: {
				type: "dir",
				entries: {
					"ci.yml": {
						type: "file",
						content: `# ${id}\nname: ci\njobs:\n  e2e:\n    steps:\n      - uses: actions/cache@v4\n`,
					},
				},
			},
		},
	};
	return root;
}

/** The work «ci-cache»'s change: the «+12 −3» its status lists. */
const WORK_PATCH = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
index 3bda155..9c41e2d 100644
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1,9 +1,18 @@
 name: ci
 jobs:
   e2e:
-    runs-on: ubuntu-latest
-    steps:
-      - run: npm ci
+    runs-on: ubuntu-24.04
+    steps:
+      - uses: actions/checkout@v4
+      - uses: actions/cache@v4
+        with:
+          path: |
+            ~/.npm
+            ~/.cache/ms-playwright
+          key: e2e-\${{ hashFiles('frontend/package-lock.json') }}
+          restore-keys: e2e-
+      - run: npm ci --prefer-offline
+      - run: npx playwright install chromium
       - run: npm run build
       - run: npm run test:e2e
   lint:
`;

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
	| "projects";

function delayKeyOf(path: string): DelayKey | null {
	if (/\/tabs$/.test(path)) return "tabs";
	if (/\/fs\/list$/.test(path)) return "fsList";
	if (/\/fs\/preview$/.test(path)) return "fsPreview";
	if (/\/git\/status$/.test(path)) return "gitStatus";
	if (/\/git\/log$/.test(path)) return "gitLog";
	if (/\/git\/diff$/.test(path)) return "gitDiff";
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

// ── The backend ─────────────────────────────────────────────────────────────

export class MockBackend {
	current: MockUser | null = null;
	sessions: MockSession[] = seedSessions();
	fs: FsDir = seedFs();
	/** Which push/notification shape the server reports. */
	pushEnabled = false;
	requests: Array<{ method: string; path: string }> = [];
	terminalSockets: TerminalSocket[] = [];
	/** Set by a test to answer any route itself before the built-ins. */
	override: ((method: string, path: string, route: Route) => Promise<boolean>) | null = null;
	/**
	 * Deterministic latency per endpoint family, in ms (a test sets it):
	 * the answer is held that long before it is sent. For the races a
	 * fast mock would never show (a route applied while a listing or the
	 * git status is still on its way).
	 */
	delays: Partial<Record<DelayKey, number>> = {};

	// ── Projects ──
	/** The project fixtures were seeded (`enableProjects`, idempotent). */
	projectChat = false;
	projects: MockProject[] = [];
	/** A status (e.g. 500) the project feed answers instead of the feed (0: normal). */
	projectFeedFailure = 0;
	/** Idempotency records, by `${owner}\n${clientRequestId}`. */
	private creations = new Map<string, { hash: string; id: string }>();
	private seq = 100;

	// ── ACP ──
	/** The ACP fixtures were seeded (`enableAcp`, called by the constructor). */
	acp = false;
	acpAgents: MockAcpAgent[] = [];
	/** GET /acp/agents: an optional delay before each answer. */
	acpAgentsDelayMs = 0;
	acpMessages: MockAcpMessage[] = [];
	/** Open/answered questions the feeds return (AcpQuestion rows). */
	acpQuestions: Array<Record<string, unknown>> = [];
	/** Activity events per message id the feeds return. */
	acpActivity: Record<string, Array<Record<string, unknown>>> = {};
	acpSockets: WebSocketRoute[] = [];
	private acpSeq = 0;
	/** v27 topics (none until `enableConversations()`). */
	acpConversations: MockConversation[] = [];
	/** Every review / requeue the app posted, in order. */
	reviewCalls: Array<{ id: number; verb: "review" | "requeue" }> = [];
	/** Every `POST /acp/conversations/:id/read` body's `at`, by topic, in order. */
	readMarks: Record<string, string[]> = {};
	acpWorks: Array<Record<string, unknown>> = [];
	/** Every Files / Git request that named a work (`<rest>?work=<id>`), in order. */
	workReads: string[] = [];
	private convCreations = new Map<string, string>();
	private convSeq = 10;

	constructor() {
		this.enableAcp();
	}

	/** Start every test logged in as `username` (skips the login form). */
	loginAs(username: keyof typeof USERS): void {
		this.current = USERS[username]!;
	}

	session(id: string): MockSession | undefined {
		return this.sessions.find((s) => s.sessionId === id);
	}

	/** Turn ACP agents on (and projects): @arq and @dev in the project, @solo without one. */
	enableAcp(): void {
		if (!this.projectChat) this.enableProjects();
		this.acp = true;
		const agent = (name: string, sessionId: string, projectId: string | null): MockAcpAgent => ({
			name,
			sessionId,
			runtime: "claude-acp-0.108.0",
			model: null,
			projectId,
			// Just before the page clock (FIXED_NOW): the status reads "disponible", not "sin señal".
			runnerSeenAt: iso(1790),
			running: [],
			pending: 0,
			// As its runner reports after the first claim: the CLI's default effort.
			effort: null,
			effortApplied: {
				model: null,
				requested: "default",
				current: "default",
				levels: ["default", "low", "medium", "high"],
				error: null,
			},
		});
		this.acpAgents = [
			agent("arq", PROJECT_SESSION_IDS.architect, PROJECT_IDS.hz),
			agent("dev", PROJECT_SESSION_IDS.developer2, PROJECT_IDS.hz),
			agent("solo", PROJECT_SESSION_IDS.scratch, null),
		];
		this.acpMessages = [];
		this.acpSeq = 0;
		this.addAcpMessage({
			to_id: "solo",
			body: "Resumí el README",
			state: "done",
			result_text:
				"## Resumen\n\nEl proyecto expone **dos** servicios:\n\n- `api`: REST\n- `ws`: tiempo real\n\n```ts\nconst x = 1;\n```",
		});
		this.addAcpMessage({
			to_id: "arq",
			body: "@arq revisá el diseño",
			state: "done",
			result_text: "Listo: el diseño está bien.",
			project_id: PROJECT_IDS.hz,
		});
	}

	addAcpMessage(m: Partial<MockAcpMessage> & { to_id: string; body: string }): MockAcpMessage {
		const row: MockAcpMessage = {
			id: ++this.acpSeq,
			from_id: "owner",
			kind: "request",
			reply_to: null,
			state: "pending",
			attempts: 0,
			created_at: iso(this.acpSeq * 10),
			started_at: null,
			finished_at: null,
			result_text: null,
			stop_reason: null,
			note: null,
			project_id: null,
			depth: 0,
			client_id: null,
			conversation_id: null,
			...m,
		};
		this.acpMessages.push(row);
		return row;
	}

	/** Close every open `/ws/acp` socket (the client reconnects and re-reads its page). */
	dropAcpSockets(): void {
		for (const s of this.acpSockets) void s.close();
	}

	/** Deliver one live `/ws/acp` frame (a message row, activity, agents) to every open socket. */
	pushAcp(frame: Record<string, unknown>): void {
		for (const s of this.acpSockets) s.send(JSON.stringify(frame));
	}

	/** Update a message row and push it live (as the backend does on every write). */
	updateAcpMessage(id: number, patch: Partial<MockAcpMessage>): MockAcpMessage {
		const m = this.acpMessages.find((x) => x.id === id);
		if (!m) throw new Error(`no acp message ${id}`);
		Object.assign(m, patch);
		this.pushAcp({ type: "message", message: m });
		return m;
	}

	/**
	 * Three topics in "Educación HZ" (3B): «Optimización de CI», where @dev is
	 * working now; «Rediseño de UI/UX», with an answer of @arq the person has
	 * not seen (1 unread); «Mejoras del backend», empty. @dev also has a
	 * message queued in «Rediseño de UI/UX» (busy in another topic).
	 */
	enableConversations(): void {
		const conv = (id: string, title: string, readAt: string | null): MockConversation => ({
			id,
			projectId: PROJECT_IDS.hz,
			title,
			createdAt: iso(400),
			archivedAt: null,
			readAt,
			recipients: null,
		});
		this.acpConversations = [
			conv(CONV_IDS.ci, "Optimización de CI", iso(2000)),
			conv(CONV_IDS.ui, "Rediseño de UI/UX", iso(600)),
			conv(CONV_IDS.backend, "Mejoras del backend", null),
		];
		const ci = this.addAcpMessage({
			to_id: "dev",
			body: "@dev el job de e2e tarda 14 minutos: bajalo sin perder cobertura.",
			state: "done",
			result_text: "Medí 5 corridas: 6 min son instalación de navegadores. Propongo caché.",
			project_id: PROJECT_IDS.hz,
			conversation_id: CONV_IDS.ci,
			finished_at: iso(500),
		});
		const run = this.addAcpMessage({
			to_id: "dev",
			body: "@dev implementalo en un trabajo aparte.",
			state: "running",
			project_id: PROJECT_IDS.hz,
			conversation_id: CONV_IDS.ci,
			started_at: iso(700),
		});
		this.addAcpMessage({
			to_id: "arq",
			body: "@arq ¿qué falta del prototipo?",
			state: "done",
			result_text: "Faltan los estados del equipo y el divisor de no leídos.",
			project_id: PROJECT_IDS.hz,
			conversation_id: CONV_IDS.ui,
			finished_at: iso(900),
		});
		const queued = this.addAcpMessage({
			to_id: "dev",
			body: "@dev cuando puedas, revisá los tokens.",
			state: "pending",
			project_id: PROJECT_IDS.hz,
			conversation_id: CONV_IDS.ui,
		});
		const dev = this.acpAgents.find((a) => a.name === "dev")!;
		dev.running = [run.id];
		dev.runningIn = [{ id: run.id, conversationId: CONV_IDS.ci, work: null }];
		dev.pending = 1;
		dev.queue = [{ id: queued.id, conversationId: CONV_IDS.ui, work: null }];
		void ci;
	}

	/**
	 * The Archive (3B F5): what was written before topics. The previous
	 * Project Chat already has enableAcp's «@arq revisá el diseño»; this adds
	 * @arq's previous direct messages (no project, no topic). @dev has none:
	 * its Archive entry is not listed. @solo's are not in any project's.
	 */
	enableArchive(): void {
		this.addAcpMessage({
			to_id: "arq",
			body: "¿Tenés un minuto para el login?",
			state: "done",
			result_text: "Sí: **OAuth con PKCE**, y el refresh en una cookie httpOnly.",
			created_at: iso(300),
			finished_at: iso(320),
		});
		this.addAcpMessage({
			to_id: "arq",
			body: "Revisá la migración de sesiones",
			state: "failed",
			note: "Error del adaptador.",
			created_at: iso(340),
			finished_at: iso(350),
		});
	}

	/**
	 * Works (3B F4): @dev's «ci-cache», active, from «Optimización de CI» (it
	 * works there now), and «old-try», cleaned (its worktree is gone: Files and
	 * Git answer 404 for it).
	 */
	enableWorks(): void {
		const work = (id: string, state: string, extra: Record<string, unknown> = {}) => ({
			id,
			agent: "dev",
			projectId: PROJECT_IDS.hz,
			conversationId: null,
			branch: `work/${id}`,
			dir: `/home/developer/workspace/.st/ctx/${id}`,
			baseSha: "3bda155e0c1d2a4b",
			portBase: 20000,
			state,
			note: null,
			createdBy: "dev",
			createdAt: iso(700),
			closedAt: null,
			cleanedAt: null,
			...extra,
		});
		this.acpWorks = [
			work("ci-cache", "active", { conversationId: CONV_IDS.ci }),
			work("old-try", "cleaned", {
				portBase: 20100,
				closedAt: iso(300),
				cleanedAt: iso(350),
			}),
		];
		const dev = this.acpAgents.find((a) => a.name === "dev")!;
		dev.runningIn = (dev.runningIn ?? []).map((r) =>
			r.conversationId === CONV_IDS.ci ? { ...r, work: "ci-cache" } : r,
		);
		for (const m of this.acpMessages)
			if (m.conversation_id === CONV_IDS.ci && m.state === "running") m.context = "ci-cache";
	}

	private convView(c: MockConversation) {
		const rows = this.acpMessages.filter((m) => m.conversation_id === c.id);
		const times = [c.createdAt, ...rows.flatMap((m) => [m.created_at, m.finished_at ?? ""])];
		const after = (t: string | null) =>
			c.readAt === null || (t !== null && Date.parse(t) > Date.parse(c.readAt));
		const unread =
			rows.filter((m) => m.from_id !== "owner" && after(m.created_at)).length +
			rows.filter(
				(m) => m.from_id === "owner" && m.state === "done" && m.result_text && after(m.finished_at),
			).length;
		return {
			...c,
			lastActivityAt: times.filter(Boolean).sort().at(-1)!,
			unread,
			needsAction: false,
		};
	}

	/** Push a topic's view live (as the backend does on create / rename / archive / read / post). */
	pushConversation(id: string): void {
		const c = this.acpConversations.find((x) => x.id === id);
		if (c) this.pushAcp({ type: "conversation", conversation: this.convView(c) });
	}

	private async handleConversations(
		method: string,
		path: string,
		req: ReturnType<Route["request"]>,
		json: (status: number, body: unknown) => Promise<void>,
		page: (msgs: MockAcpMessage[]) => MockAcpMessage[],
	): Promise<boolean> {
		const list = /^\/acp\/projects\/([^/]+)\/conversations$/.exec(path);
		if (list && method === "GET") {
			const pid = decodeURIComponent(list[1]!);
			const archived = new URL(req.url()).searchParams.get("archived") === "1";
			await json(
				200,
				this.acpConversations
					.filter((c) => c.projectId === pid && Boolean(c.archivedAt) === archived)
					.map((c) => this.convView(c))
					.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
			);
			return true;
		}
		if (path === "/acp/conversations" && method === "POST") {
			const b = JSON.parse(req.postData() ?? "{}") as {
				projectId?: string;
				title?: string;
				clientRequestId?: string;
			};
			const title = (b.title ?? "").trim();
			if (!title || [...title].length > 120) {
				await json(400, { error: "invalid-title" });
				return true;
			}
			const prior = this.convCreations.get(String(b.clientRequestId));
			if (prior) {
				const c = this.acpConversations.find((x) => x.id === prior)!;
				await json(200, { ...this.convView(c), replayed: true });
				return true;
			}
			const c: MockConversation = {
				id: `c0000000-0000-4000-8000-0000000000${String(++this.convSeq).padStart(2, "0")}`,
				projectId: String(b.projectId),
				title,
				createdAt: iso(1750 + this.convSeq),
				archivedAt: null,
				readAt: null,
				recipients: null,
			};
			this.acpConversations.push(c);
			this.convCreations.set(String(b.clientRequestId), c.id);
			this.pushConversation(c.id);
			await json(201, { ...this.convView(c), replayed: false });
			return true;
		}
		const one = /^\/acp\/conversations\/([^/]+)(?:\/(archive|read|feed))?$/.exec(path);
		if (!one) return false;
		const c = this.acpConversations.find((x) => x.id === decodeURIComponent(one[1]!));
		if (!c) {
			await json(404, { error: "conversation-not-found" });
			return true;
		}
		if (one[2] === undefined && method === "PATCH") {
			const title = String(
				(JSON.parse(req.postData() ?? "{}") as { title?: string }).title ?? "",
			).trim();
			if (!title || [...title].length > 120) {
				await json(400, { error: "invalid-title" });
				return true;
			}
			c.title = title;
		} else if (one[2] === "archive" && method === "POST") {
			c.archivedAt ??= iso(1795);
		} else if (one[2] === "read" && method === "POST") {
			const at = String((JSON.parse(req.postData() ?? "{}") as { at?: string }).at ?? "");
			this.readMarks[c.id] = [...(this.readMarks[c.id] ?? []), at];
			if (c.readAt === null || Date.parse(at) > Date.parse(c.readAt)) c.readAt = at;
		} else if (one[2] === "feed" && method === "GET") {
			await json(200, {
				conversation: this.convView(c),
				agents: this.acpAgents.filter((a) => a.projectId === c.projectId),
				maxMessageBytes: 262144,
				messages: page(this.acpMessages.filter((m) => m.conversation_id === c.id)),
				questions: this.acpQuestions,
				activity: this.acpActivity,
				activitySeq: 0,
			});
			return true;
		} else return false;
		this.pushConversation(c.id);
		await json(200, this.convView(c));
		return true;
	}

	/** Turn projects on: one project and a few more sessions of alice's. */
	enableProjects(): void {
		if (this.projectChat) return;
		this.projectChat = true;
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
		this.projects = [
			{
				projectId: PROJECT_IDS.hz,
				ownerUserId: "u-alice",
				name: "Educación HZ",
				createdAt: iso(-7200),
			},
		];
	}

	private projectSummary(p: MockProject) {
		return {
			projectId: p.projectId,
			name: p.name,
			createdAt: p.createdAt,
			agentCount: 0,
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
		const mine = () => this.projects.filter((p) => p.ownerUserId === me.userId && !p.archivedAt);
		if (path === "/projects" && method === "GET") {
			await json(200, {
				projects: mine().map((p) => this.projectSummary(p)),
				can: { createProject: { allowed: true } },
			});
			return true;
		}
		if (path === "/projects" && method === "POST") {
			const body = (req.postDataJSON() ?? {}) as { name?: unknown; clientRequestId?: unknown };
			const name = typeof body.name === "string" ? body.name.trim() : "";
			if (name === "") {
				await json(400, { error: "invalid-name" });
				return true;
			}
			const key = `${me.userId}\n${String(body.clientRequestId)}`;
			const prior = this.creations.get(key);
			if (prior) {
				const p = this.projects.find((x) => x.projectId === prior.id)!;
				await json(201, { ...this.projectSummary(p), replayed: true });
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
			this.creations.set(key, { hash: name, id: p.projectId });
			await json(201, { ...this.projectSummary(p), replayed: false });
			return true;
		}
		const one = /^\/projects\/([^/]+)$/.exec(path);
		const live = one ? mine().find((p) => p.projectId === decodeURIComponent(one[1]!)) : undefined;
		if (one && method === "DELETE") {
			// Archive (backend: archived_at set, the row stays, its agents leave it).
			if (!live) await json(404, { error: "project-not-found" });
			else {
				live.archivedAt = iso(0);
				for (const a of this.acpAgents) if (a.projectId === live.projectId) a.projectId = null;
				await route.fulfill({ status: 204 });
			}
			return true;
		}
		if (one && method === "PATCH") {
			const body = (req.postDataJSON() ?? {}) as { name?: unknown };
			const name = typeof body.name === "string" ? body.name.trim() : "";
			if (name === "" || [...name].length > 80) {
				await json(400, { error: "invalid-name" });
				return true;
			}
			if (!live) {
				await json(404, { error: "project-not-found" });
				return true;
			}
			live.name = name;
			await json(200, this.projectSummary(live));
			return true;
		}
		await json(404, { error: `No mock for ${method} ${path}` });
		return true;
	}

	private async handleAcp(
		method: string,
		path: string,
		req: ReturnType<Route["request"]>,
		json: (status: number, body: unknown) => Promise<void>,
	): Promise<boolean> {
		// The newest 100 (the real page), older than `?before=` when asked.
		const before = Number(new URL(req.url()).searchParams.get("before") ?? 0);
		const page = (msgs: MockAcpMessage[]) =>
			(before > 0 ? msgs.filter((m) => m.id < before) : msgs).slice(-100);
		if (path === "/acp/agents" && method === "GET") {
			if (this.acpAgentsDelayMs) await new Promise((r) => setTimeout(r, this.acpAgentsDelayMs));
			await json(200, this.acpAgents);
			return true;
		}
		if (path === "/acp/runtimes" && method === "GET") {
			await json(200, { default: "claude-acp-0.108.0", available: ["claude-acp-0.108.0"] });
			return true;
		}
		if (await this.handleConversations(method, path, req, json, page)) return true;
		if (path === "/acp/inbox" && method === "GET") {
			// Like the backend: a question carries its message's topic and project.
			const questions = this.acpQuestions
				.filter((q) => q.state === "open")
				.map((q) => {
					const m = this.acpMessages.find((x) => x.id === q.message_id);
					return {
						...q,
						conversation_id: m?.conversation_id ?? null,
						project_id: m?.project_id ?? null,
					};
				});
			const interrupted = this.acpMessages.filter((m) => m.state === "uncertain" && !m.reviewed_at);
			// The person's messages answered after their topic's read mark (live topics only).
			const results = this.acpMessages.filter((m) => {
				if (m.from_id !== "owner" || m.state !== "done" || !m.result_text) return false;
				const c = this.acpConversations.find((x) => x.id === m.conversation_id);
				if (!c || c.archivedAt) return false;
				return c.readAt === null || Date.parse(m.finished_at ?? "") > Date.parse(c.readAt);
			});
			const ids = new Set(interrupted.map((m) => m.id));
			await json(200, {
				count: questions.length + interrupted.length,
				action: { questions, interrupted },
				results,
				reports: this.acpMessages.filter((m) => m.recovery_of && ids.has(m.recovery_of)),
			});
			return true;
		}
		const verb = /^\/acp\/messages\/(\d+)\/(review|requeue)$/.exec(path);
		if (verb && method === "POST") {
			const m = this.acpMessages.find((x) => x.id === Number(verb[1]));
			if (!m) {
				await json(404, { error: "not-found" });
				return true;
			}
			if (m.state !== "uncertain") {
				await json(409, { error: "not-uncertain", state: m.state });
				return true;
			}
			this.reviewCalls.push({ id: m.id, verb: verb[2] as "review" | "requeue" });
			if (verb[2] === "review") m.reviewed_at ??= iso(1798);
			else Object.assign(m, { state: "pending", reviewed_at: null, finished_at: null });
			this.pushAcp({ type: "message", message: m });
			await json(200, m);
			return true;
		}
		const answer = /^\/acp\/questions\/(\d+)\/answer$/.exec(path);
		if (answer && method === "POST") {
			const q = this.acpQuestions.find((x) => x.id === Number(answer[1]));
			if (!q || q.state !== "open") {
				await json(409, { error: "not-open" });
				return true;
			}
			Object.assign(q, { state: "answered", answer: req.postData(), answered_at: iso(1798) });
			this.pushAcp({ type: "question", question: q });
			await json(200, q);
			return true;
		}
		if (path === "/acp/works" && method === "GET") {
			await json(200, this.acpWorks);
			return true;
		}
		const feed = /^\/acp\/agents\/([^/]+)\/feed$/.exec(path);
		if (feed && method === "GET") {
			const a = this.acpAgents.find((x) => x.name === decodeURIComponent(feed[1]!));
			if (!a) {
				await json(404, { error: "agent-not-found" });
				return true;
			}
			await json(200, {
				agent: a,
				maxMessageBytes: 262144,
				// The Archive's (backend `archive: true`): everything to or from the
				// agent outside any topic, in any scope.
				messages: page(
					this.acpMessages.filter(
						(m) => !m.conversation_id && (m.to_id === a.name || m.from_id === a.name),
					),
				),
				questions: this.acpQuestions.filter((q) => q.agent === a.name),
				activity: this.acpActivity,
				activitySeq: 0,
			});
			return true;
		}
		const pfeed = /^\/acp\/projects\/([^/]+)\/feed$/.exec(path);
		if (pfeed && method === "GET") {
			const pid = decodeURIComponent(pfeed[1]!);
			if (this.projectFeedFailure) {
				await json(this.projectFeedFailure, { error: "internal" });
				return true;
			}
			const p = this.projects.find((x) => x.projectId === pid);
			if (!p) {
				await json(404, { error: "project-not-found" });
				return true;
			}
			await json(200, {
				project: { id: p.projectId, name: p.name },
				agents: this.acpAgents.filter((a) => a.projectId === pid),
				maxMessageBytes: 262144,
				// The previous Project Chat: the project's scope, outside any topic.
				messages: page(this.acpMessages.filter((m) => m.project_id === pid && !m.conversation_id)),
				questions: this.acpQuestions,
				activity: this.acpActivity,
				activitySeq: 0,
			});
			return true;
		}
		if (path === "/acp/messages" && method === "POST") {
			const b = JSON.parse(req.postData() ?? "{}") as {
				to?: string | string[];
				team?: boolean;
				body: string;
				projectId?: string;
				clientId?: string;
				conversationId?: string;
			};
			if (b.conversationId) {
				const c = this.acpConversations.find((x) => x.id === b.conversationId);
				if (!c) {
					await json(404, { error: "conversation-not-found" });
					return true;
				}
				if (c.archivedAt) {
					await json(409, { error: "conversation-archived" });
					return true;
				}
				// «Todo el equipo»: the project's agents now, one row each, marked `team`.
				const names = b.team
					? this.acpAgents.filter((a) => a.projectId === c.projectId).map((a) => a.name)
					: (Array.isArray(b.to) ? b.to : [b.to ?? ""]).map((n) => n.replace(/^@/, ""));
				const bad = names.find(
					(n) => this.acpAgents.find((a) => a.name === n)?.projectId !== c.projectId,
				);
				if (bad) {
					await json(400, { error: "not-in-project", agent: bad });
					return true;
				}
				const rows = names.map((n) =>
					this.addAcpMessage({
						to_id: n,
						body: b.body,
						project_id: c.projectId,
						conversation_id: c.id,
						client_id: b.clientId ?? null,
						created_at: iso(1780 + this.acpSeq),
						team: b.team ? 1 : null,
					}),
				);
				c.recipients = b.team ? { team: true } : { agents: names };
				for (const row of rows) this.pushAcp({ type: "message", message: row });
				this.pushConversation(c.id);
				await json(
					201,
					Array.isArray(b.to) || b.team ? { messages: rows, replayed: false } : rows[0],
				);
				return true;
			}
			if (typeof b.to !== "string" || !this.acpAgents.some((a) => a.name === b.to)) {
				await json(404, { error: "agent-not-found" });
				return true;
			}
			const row = this.addAcpMessage({
				to_id: b.to as string,
				body: b.body,
				project_id: b.projectId ?? null,
				client_id: b.clientId ?? null,
			});
			this.pushAcp({ type: "message", message: row });
			await json(201, row);
			return true;
		}
		// «Conectar cuenta»: the login runs in a new terminal tab of the agent's session.
		const login = /^\/acp\/agents\/([^/]+)\/login$/.exec(path);
		if (login && method === "POST") {
			const a = this.acpAgents.find((x) => x.name === decodeURIComponent(login[1]!));
			await json(a ? 200 : 404, a ? { sessionId: a.sessionId, tabId: "tab-1" } : {});
			return true;
		}
		const agentPatch = /^\/acp\/agents\/([^/]+)$/.exec(path);
		if (agentPatch && method === "PATCH") {
			const a = this.acpAgents.find((x) => x.name === decodeURIComponent(agentPatch[1]!));
			if (!a) {
				await json(404, { error: "agent-not-found" });
				return true;
			}
			const b = JSON.parse(req.postData() ?? "{}") as {
				projectId?: string | null;
				model?: string;
				effort?: string | null;
			};
			if ("projectId" in b) a.projectId = b.projectId ?? null;
			if (typeof b.model === "string") a.model = b.model;
			if ("effort" in b) a.effort = b.effort === "default" ? null : (b.effort ?? null);
			await json(200, a);
			return true;
		}
		return false;
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
		const parts = url.pathname.split("/").filter(Boolean); // ws, sessions|acp|bootstrap, id
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
		if (kind === "acp") {
			this.acpSockets.push(ws);
			ws.onClose(() => {
				this.acpSockets = this.acpSockets.filter((x) => x !== ws);
			});
			ws.send(JSON.stringify({ type: "hello" }));
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

		// ── projects ──
		if (await this.handleProjects(method, path, req, me, json, route)) return;
		// ── ACP ──
		if (await this.handleAcp(method, path, req, json)) return;

		// ── sessions ──
		if (path === "/sessions" && method === "GET") {
			const all = url.searchParams.get("all") === "true";
			return json(
				200,
				this.sessions
					.filter((s) => s.ownerUserId === me.userId && (all || s.status !== "terminated"))
					.map((s) => this.serialize(s)),
			);
		}
		const m = /^\/sessions\/([^/]+)(\/.*)?$/.exec(path);
		if (m) {
			const id = decodeURIComponent(m[1]!);
			const rest = m[2] ?? "";
			const s = this.session(id);
			if (!s) return json(404, { error: "Session not found" });
			const own = s.ownerUserId === me.userId;
			// Read surfaces (files, git) are owner-only: a
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

			// ── a work (`work=<id>`, 3B F4): its worktree is the root, and only
			// for a work of THIS session's agent that is not cleaned — else the
			// same 404 as a missing session (the real backend's workRoot.ts).
			const workId = url.searchParams.get("work");
			let workRoot: FsDir | null = null;
			let workRow: Record<string, unknown> | null = null;
			if (workId !== null && (rest.startsWith("/fs/") || rest.startsWith("/git/"))) {
				const agent = this.acpAgents.find((a) => a.sessionId === id);
				workRow =
					this.acpWorks.find(
						(w) => w.id === workId && w.agent === agent?.name && w.state !== "cleaned",
					) ?? null;
				this.workReads.push(`${rest}?work=${workId}`);
				if (!workRow) return json(404, { error: "Session not found" });
				workRoot = seedWorkFs(workId);
			}

			// ── files ──
			const fs = /^\/fs\/(list|preview|raw)$/.exec(rest);
			if (fs) {
				const rel = url.searchParams.get("path") ?? "";
				const node = this.resolve(rel, workRoot ?? undefined);
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
				if (rest === "/git/status" && workRow) {
					return json(200, {
						repo: true,
						root: "",
						truncated: false,
						branch: workRow.branch,
						detached: false,
						head: "9c41e2d000",
						upstream: null,
						ahead: null,
						behind: null,
						changes: [
							{
								area: "unstaged",
								status: "M",
								xy: " M",
								path: ".github/workflows/ci.yml",
								oldPath: null,
								additions: 12,
								deletions: 3,
								binary: false,
								restricted: false,
							},
						],
						work: workRow,
					});
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
						patch: workRow
							? p === ".github/workflows/ci.yml"
								? WORK_PATCH
								: ""
							: p === "src/auth.ts"
								? GIT_PATCH
								: "",
						truncated: false,
						binary: false,
					});
				}
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
							memPercent: s.memPercent ?? 12.5,
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

	private resolve(rel: string, root: FsDir = this.fs): FsNode | null {
		let node: FsNode = root;
		for (const part of rel.split("/").filter(Boolean)) {
			if (node.type !== "dir") return null;
			const next: FsNode | undefined = node.entries[part];
			if (!next) return null;
			node = next;
		}
		return node;
	}
}
