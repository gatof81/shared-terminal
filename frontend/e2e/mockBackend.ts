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
	| "events";

function delayKeyOf(path: string): DelayKey | null {
	if (/\/tabs$/.test(path)) return "tabs";
	if (/\/fs\/list$/.test(path)) return "fsList";
	if (/\/fs\/preview$/.test(path)) return "fsPreview";
	if (/\/git\/status$/.test(path)) return "gitStatus";
	if (/\/git\/log$/.test(path)) return "gitLog";
	if (/\/git\/diff$/.test(path)) return "gitDiff";
	if (/\/conversations$/.test(path)) return "conversations";
	if (/\/events$/.test(path)) return "events";
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
	/** Capture state reported for the running session. */
	capture = { requested: true, effective: true, effectiveAfterRestart: true };
	/** Which push/notification shape the server reports. */
	pushEnabled = false;
	/** The operator's shell (UI_SHELL) as /auth/status reports it. */
	uiShell: "v1" | "v2" = "v1";
	requests: Array<{ method: string; path: string }> = [];
	terminalSockets: TerminalSocket[] = [];
	conversationSockets: ConversationSocket[] = [];
	/** Set by a test to answer any route itself before the built-ins. */
	override: ((method: string, path: string, route: Route) => Promise<boolean>) | null = null;
	/**
	 * Deterministic latency per endpoint family, in ms (a test sets it):
	 * the answer is held that long before it is sent. For the races a
	 * fast mock would never show (a route applied while a listing or the
	 * git status is still on its way).
	 */
	delays: Partial<Record<DelayKey, number>> = {};

	/** Start every test logged in as `username` (skips the login form). */
	loginAs(username: keyof typeof USERS): void {
		this.current = USERS[username]!;
	}

	session(id: string): MockSession | undefined {
		return this.sessions.find((s) => s.sessionId === id);
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
						s.status === "failed" ? [] : this.conversations.map((c) => this.summary(c)),
				});
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
				// Delivered: the CLI's own user_prompt follows over the socket.
				setTimeout(() => {
					this.pushConversationEvent(conv.cid, {
						ts: new Date().toISOString(),
						ev: "user_prompt",
						prompt_id: `p-${body.clientMessageId}`,
						turn_id: null,
						agent_id: null,
						pane: "%1",
						data: { prompt: body.text, source: "user" },
					});
				}, 50);
				return json(202, { result: "delivered", clientMessageId: body.clientMessageId });
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
			statusEvidence: "hook",
			statusAt: last?.ts ?? c.startedAt,
			tabId: "tab-1",
			startedAt: c.startedAt,
			endedAt: c.status === "ended" ? last?.ts : null,
			lastEventAt: last?.ts ?? c.startedAt,
			lastSeq: last?.seq ?? 0,
			firstRetainedSeq: 1,
			eventsCount: c.events.length,
			gapsCount: 0,
			claudeVersion: "2.1.314",
			canSendInput: c.canSendInput,
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
