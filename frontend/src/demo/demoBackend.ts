/**
 * demoBackend.ts — DEMO ONLY (branch `preview/ux-iter3-demo`, never
 * merged): the app with no backend at all, to try the ACP chat on a real
 * phone from the branch's Cloudflare Pages preview.
 *
 * The e2e suite's MockBackend (e2e/mockBackend.ts, unchanged) answers every
 * `/api/*` request and `/ws/*` socket INSIDE the page: `fetch` and
 * `WebSocket` are replaced before any app module runs (main.ts imports this
 * first). Nothing leaves the browser: an `/api` or `/ws` address answers
 * from the mock whatever host it names (VITE_API_URL), and any other
 * off-origin fetch or socket is refused. No login: the mock starts with
 * alice signed in.
 *
 * The scenario: project "Educación HZ" with three agents (@arq, @dev
 * working, @dis asking a question with options), @solo outside it, long
 * histories with Markdown and wide code; a message sent to an agent is
 * answered a few seconds later.
 */

import { MockBackend, PROJECT_IDS, PROJECT_SESSION_IDS } from "../../e2e/mockBackend.js";

// ── Playwright Route / WebSocketRoute stand-ins (what MockBackend calls) ──

class DemoRequest {
	constructor(
		private readonly u: string,
		private readonly m: string,
		private readonly body: string | null,
	) {}
	url(): string {
		return this.u;
	}
	method(): string {
		return this.m;
	}
	postData(): string | null {
		return this.body;
	}
	postDataJSON(): unknown {
		return this.body ? JSON.parse(this.body) : null;
	}
	headers(): Record<string, string> {
		return {};
	}
}

class DemoRoute {
	readonly response: Promise<Response>;
	private resolve!: (r: Response) => void;
	private reject!: (e: unknown) => void;
	constructor(private readonly req: DemoRequest) {
		this.response = new Promise<Response>((res, rej) => {
			this.resolve = res;
			this.reject = rej;
		});
	}
	request(): DemoRequest {
		return this.req;
	}
	async fulfill(r: {
		status?: number;
		contentType?: string;
		body?: string;
		headers?: Record<string, string>;
	}): Promise<void> {
		const status = r.status ?? 200;
		const empty = status === 204 || status === 304;
		this.resolve(
			new Response(empty ? null : (r.body ?? ""), {
				status,
				headers: { "content-type": r.contentType ?? "application/json", ...r.headers },
			}),
		);
	}
	async abort(): Promise<void> {
		this.reject(new TypeError("Failed to fetch"));
	}
}

type Listener = (data: string) => void;

/** The server end of a fake socket, as MockBackend's handlers see it. */
class DemoWsRoute {
	readonly toServer: Listener[] = [];
	readonly onClosed: Array<() => void> = [];
	constructor(
		private readonly sock: DemoWebSocket,
		private readonly u: string,
	) {}
	url(): string {
		return this.u;
	}
	send(data: string): void {
		this.sock.deliver(String(data));
	}
	close(opts: { code?: number; reason?: string } = {}): void {
		this.sock.serverClose(opts.code ?? 1000, opts.reason ?? "");
	}
	onMessage(fn: Listener): void {
		this.toServer.push(fn);
	}
	onClose(fn: () => void): void {
		this.onClosed.push(fn);
	}
}

const backend = new MockBackend();

class DemoWebSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	readonly CONNECTING = 0;
	readonly OPEN = 1;
	readonly CLOSING = 2;
	readonly CLOSED = 3;
	readyState = 0;
	binaryType: BinaryType = "blob";
	bufferedAmount = 0;
	extensions = "";
	protocol = "";
	readonly url: string;
	onopen: ((e: Event) => void) | null = null;
	onmessage: ((e: MessageEvent) => void) | null = null;
	onclose: ((e: CloseEvent) => void) | null = null;
	onerror: ((e: Event) => void) | null = null;
	private route: DemoWsRoute | null = null;

	constructor(url: string | URL) {
		super();
		this.url = String(url);
		const u = new URL(this.url, location.href);
		// Delivered in order, after the caller attached its handlers.
		setTimeout(() => {
			if (!u.pathname.startsWith("/ws/")) {
				this.emit(new Event("error"));
				this.serverClose(1006, "demo: no network");
				return;
			}
			this.readyState = 1;
			this.emit(new Event("open"));
			this.route = new DemoWsRoute(this, u.href);
			(backend as unknown as { handleSocket(ws: DemoWsRoute): void }).handleSocket(this.route);
		}, 0);
	}

	private emit(e: Event): void {
		const handler = (this as unknown as Record<string, unknown>)[`on${e.type}`];
		if (typeof handler === "function") (handler as (e: Event) => void).call(this, e);
		this.dispatchEvent(e);
	}

	deliver(data: string): void {
		setTimeout(() => {
			if (this.readyState === 1) this.emit(new MessageEvent("message", { data }));
		}, 0);
	}

	serverClose(code: number, reason: string): void {
		setTimeout(() => {
			if (this.readyState === 3) return;
			this.readyState = 3;
			this.emit(new CloseEvent("close", { code, reason, wasClean: code === 1000 }));
		}, 0);
	}

	send(data: string): void {
		if (this.readyState !== 1) return;
		const route = this.route;
		setTimeout(() => {
			for (const fn of route?.toServer ?? []) fn(String(data));
		}, 0);
	}

	close(code = 1000, reason = ""): void {
		if (this.readyState >= 2) return;
		this.readyState = 2;
		for (const fn of this.route?.onClosed ?? []) fn();
		this.serverClose(code, reason);
	}
}

// ── The shims ───────────────────────────────────────────────────────────

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
	const req = input instanceof Request ? input : null;
	const url = new URL(req ? req.url : String(input), location.href);
	if (url.pathname.startsWith("/api/")) {
		const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
		const body =
			typeof init?.body === "string"
				? init.body
				: req && method !== "GET"
					? await req.text()
					: null;
		const route = new DemoRoute(new DemoRequest(url.href, method, body));
		await (backend as unknown as { handle(r: DemoRoute): Promise<void> }).handle(route);
		return route.response;
	}
	// The page's own static files (Pages): fine. Anything else: no network.
	if (url.origin !== location.origin) throw new TypeError("demo: no network");
	return realFetch(input, init);
};
window.WebSocket = DemoWebSocket as unknown as typeof WebSocket;

// ── The scenario ──────────────────────────────────────────────────────────

backend.loginAs("alice");
backend.enableAcp();
const nowIso = () => new Date().toISOString();
const proj = PROJECT_IDS.hz;
backend.projects[0]!.name = "Educación HZ";
// A third agent in the project.
backend.acpAgents.push({
	...backend.acpAgents[0]!,
	name: "dis",
	sessionId: PROJECT_SESSION_IDS.designer,
});
backend.acpMessages = [];
backend.acpQuestions = [];

const WIDE = [
	"```ts",
	"export async function migrateAgents(db: D1Database, agents: ReadonlyArray<{ name: string; projectId: string | null; model: string | null }>): Promise<number> {",
	'\tconst stmt = db.prepare("UPDATE acp_agents SET project_id = ?, model = COALESCE(?, model) WHERE name = ? AND project_id IS NOT ?");',
	"\tconst results = await db.batch(agents.map((a) => stmt.bind(a.projectId, a.model, a.name, a.projectId)));",
	"\treturn results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);",
	"}",
	"```",
].join("\n");
const TABLE = [
	"| Pantalla | Antes | Después |",
	"|---|---|---|",
	"| 390×844 | 3 filas de encabezado | 1 fila |",
	"| 320×568 | el campo tapaba el hilo | el hilo se ve |",
].join("\n");
const ANSWERS = [
	"Listo. Revisé el diseño y **no veo problemas** de fondo.\n\n- El encabezado ocupa una fila.\n- El campo crece hasta 6 líneas.",
	`Así quedaría la migración:\n\n${WIDE}\n\nCorre en un solo \`batch\`.`,
	`Comparación:\n\n${TABLE}`,
	"Corrí los tests: `npm test` → **541 passed**. Nada más que reportar.",
	"> Ojo: el teclado en iPhone achica la vista; el hilo tiene que quedar al final.\n\nLo verifico en el dispositivo.",
	`Te dejo el link al proyecto: [Educación HZ](#/projects/${proj}).`,
];
const ASKS = [
	"@arq revisá el diseño del encabezado",
	"@dev ¿cómo migramos los agentes?",
	"@dis compará antes y después",
	"@dev corré los tests",
	"@arq ¿qué pasa con el teclado en iPhone?",
	"@dis pasame el link del proyecto",
];

function add(
	to: string,
	body: string,
	result: string | null,
	project: string | null,
	from = "owner",
) {
	return backend.addAcpMessage({
		to_id: to,
		from_id: from,
		body,
		state: result === null ? "pending" : "done",
		result_text: result,
		project_id: project,
	});
}

// Project Chat: a long history.
for (let i = 0; i < 36; i++) {
	const k = i % ASKS.length;
	const to = /^@(\w+)/.exec(ASKS[k]!)![1]!;
	add(to, `${ASKS[k]} (${i + 1})`, ANSWERS[k]!, proj);
}
// An agent consulting another, in the project.
add(
	"dev",
	"@dev ¿la tabla de agentes tiene índice por proyecto?",
	"Sí: `acp_agents(project_id)`.",
	proj,
	"arq",
);
// @dev working right now.
const working = add("dev", "@dev implementá el aviso de novedades", null, proj);
working.state = "running";
backend.acpAgents.find((a) => a.name === "dev")!.running = working.id;
backend.acpActivity[String(working.id)] = [
	{
		seq: 1,
		at: nowIso(),
		messageId: working.id,
		kind: "tool",
		title: "Read acpThread.ts",
		status: "completed",
	},
	{
		seq: 2,
		at: nowIso(),
		messageId: working.id,
		kind: "tool",
		title: "Edit acpThread.ts",
		status: "in_progress",
	},
];
// @dis asks a question with options.
const asking = add("dis", "@dis elegí la paleta del avatar", null, proj);
asking.state = "running";
backend.acpAgents.find((a) => a.name === "dis")!.running = asking.id;
// (`waitingInput`: a field of /api/acp/agents the mock's type does not list.)
Object.assign(backend.acpAgents.find((a) => a.name === "dis")!, { waitingInput: true });
backend.acpQuestions.push({
	id: 1,
	agent: "dis",
	message_id: asking.id,
	request: JSON.stringify({
		message: "¿Qué paleta usamos para los avatares?",
		requestedSchema: {
			type: "object",
			properties: {
				paleta: {
					type: "string",
					title: "Paleta",
					enum: ["Saturada", "Apagada", "Monocromo"],
				},
			},
			required: ["paleta"],
		},
	}),
	state: "open",
	answer: null,
	created_at: nowIso(),
	answered_at: null,
	delivered_at: null,
	note: null,
});
// @solo's individual chat (no project): long too.
for (let i = 0; i < 24; i++)
	add(
		"solo",
		`pregunta ${i + 1}: ${ASKS[i % ASKS.length]!.replace(/^@\w+ /, "")}`,
		ANSWERS[i % ANSWERS.length]!,
		null,
	);

// A second project: seven agents, long names (a ~40-character project, a
// 30-character agent), one waiting for an answer that falls in the
// header's "+N" (ordered after the first three only by its rank), one
// needing a login.
const proj2 = "6b1f2c3d-0000-4000-8000-000000000002";
backend.projects.push({
	projectId: proj2,
	ownerUserId: "u-alice",
	name: "Migración de la plataforma de evaluaciones",
	createdAt: nowIso(),
});
const SEVEN = [
	"coordinador",
	"backend",
	"frontend",
	"especialista-en-accesibilidad",
	"qa",
	"datos",
	"infra",
];
SEVEN.forEach((name, i) => {
	const sessionId = `5e7e0000-0000-4000-8000-0000000000${String(10 + i)}`;
	backend.sessions.push({
		sessionId,
		ownerUserId: "u-alice",
		name: `plat-${name}`,
		status: "running",
		tabs: [{ tabId: "tab-1", label: "Tab 1", createdAt: Date.now() }],
		createdAt: nowIso(),
	});
	backend.acpAgents.push({ ...backend.acpAgents[0]!, name, sessionId, projectId: proj2 });
});
// Waiting for you: the LAST of the seven (it is still shown first, by rank).
Object.assign(backend.acpAgents.find((a) => a.name === "infra")!, { waitingInput: true });
// Needs a login.
Object.assign(backend.acpAgents.find((a) => a.name === "datos")!, { authRequired: true });
for (let i = 0; i < 12; i++)
	add(
		SEVEN[i % SEVEN.length]!,
		`@${SEVEN[i % SEVEN.length]} ${ASKS[i % ASKS.length]!.replace(/^@\w+ /, "")}`,
		ANSWERS[i % ANSWERS.length]!,
		proj2,
	);
const infraAsk = add("infra", "@infra ¿subimos la réplica hoy?", null, proj2);
infraAsk.state = "running";
backend.acpAgents.find((a) => a.name === "infra")!.running = infraAsk.id;
backend.acpQuestions.push({
	id: 2,
	agent: "infra",
	message_id: infraAsk.id,
	request: JSON.stringify({
		message: "¿Cuándo subimos la réplica de lectura?",
		requestedSchema: {
			type: "object",
			properties: {
				cuando: { type: "string", title: "Cuándo", enum: ["Hoy", "Mañana", "La semana que viene"] },
			},
			required: ["cuando"],
		},
	}),
	state: "open",
	answer: null,
	created_at: nowIso(),
	answered_at: null,
	delivered_at: null,
	note: null,
});

// Recent timestamps, oldest first, a couple of minutes apart.
const n = backend.acpMessages.length;
backend.acpMessages.forEach((m, i) => {
	m.created_at = new Date(Date.now() - (n - i) * 120_000).toISOString();
});
// Runners alive: reported "now", kept fresh.
const touch = () => {
	for (const a of backend.acpAgents) a.runnerSeenAt = nowIso();
};
touch();
setInterval(touch, 10_000);

// ── Live behaviour the mock does not have ─────────────────────────────

// Rows written from now on carry the real time (the mock's are seeded).
const addRow = backend.addAcpMessage.bind(backend);
backend.addAcpMessage = (m) => {
	const row = addRow(m);
	row.created_at = nowIso();
	return row;
};

let replies = 0;
backend.override = async (method, path, route) => {
	const req = (route as unknown as DemoRoute).request();
	const json = (status: number, body: unknown) =>
		(route as unknown as DemoRoute).fulfill({ status, body: JSON.stringify(body) });
	// A message sent: the mock stores and pushes it; the agent answers shortly.
	if (path === "/acp/messages" && method === "POST") {
		const b = JSON.parse(req.postData() ?? "{}") as { to?: string; clientId?: string };
		const to = b.to ?? "";
		setTimeout(() => {
			const row = [...backend.acpMessages]
				.reverse()
				.find((m) => m.to_id === to && m.state === "pending");
			if (!row) return;
			backend.updateAcpMessage(row.id, { state: "running" });
			const agent = backend.acpAgents.find((a) => a.name === to);
			if (agent) agent.running = row.id;
			backend.pushAcp({
				type: "activity",
				agent: to,
				events: [
					{ seq: 100 + row.id, at: nowIso(), messageId: row.id, kind: "turn", phase: "started" },
				],
			});
			setTimeout(() => {
				backend.updateAcpMessage(row.id, {
					state: "done",
					result_text: ANSWERS[replies++ % ANSWERS.length]!,
				});
				if (agent && agent.running === row.id) agent.running = null;
				backend.pushAcp({ type: "agents" });
			}, 3_000);
		}, 1_200);
		return false;
	}
	// Answering a question (@dis's, @infra's).
	const ans = /^\/acp\/questions\/(\d+)\/answer$/.exec(path);
	if (ans && method === "POST") {
		const q = backend.acpQuestions.find((x) => x.id === Number(ans[1]));
		if (!q || q.state !== "open") {
			await json(409, { error: "question-not-open" });
			return true;
		}
		Object.assign(q, { state: "answered", answer: req.postData(), answered_at: nowIso() });
		backend.pushAcp({ type: "question", question: q });
		const who = backend.acpAgents.find((a) => a.name === q.agent)!;
		Object.assign(who, { waitingInput: false });
		setTimeout(() => {
			if (typeof q.message_id === "number")
				backend.updateAcpMessage(q.message_id, {
					state: "done",
					result_text: "Gracias, sigo con esa decisión.",
				});
			who.running = null;
			backend.pushAcp({ type: "agents" });
		}, 2_000);
		await json(200, q);
		return true;
	}
	return false;
};

// Straight to Project Chat when the address names nothing.
if (!location.hash) history.replaceState(null, "", `#/projects/${proj}`);
document.title = `DEMO · ${document.title}`;
