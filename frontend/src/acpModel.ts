// acpModel.ts — pure helpers of the ACP chats (individual and Project Chat):
// mentions, grouping a post sent to several agents, activity rows, agent
// status words. No DOM, no network: unit-tested in acpModel.test.ts.

import type { AcpActivity, AcpAgentInfo, AcpMessage } from "./api.js";

/** The models offered for an ACP agent; the first is the default. */
export const ACP_MODELS: ReadonlyArray<{ id: string; label: string }> = [
	{ id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
	{ id: "claude-opus-5-5", label: "Claude Opus 5.5" },
	{ id: "claude-fable-5-2", label: "Claude Fable 5.2" },
];

/** A model id as people read it (an id the list does not know is shown as is). */
export function modelLabel(id: string | null | undefined): string {
	if (!id) return "modelo por defecto";
	return ACP_MODELS.find((m) => m.id === id)?.label ?? id;
}

/**
 * Where an agent's model change stands. `pending`: the runner has not applied
 * the stored model yet (it switches while idle, before its next message).
 */
export function modelState(a: {
	model: string | null;
	modelApplied?: { requested: string; current: string | null; error: string | null } | null;
}): "applied" | "pending" | "failed" | "unknown" {
	const ap = a.modelApplied;
	if (!a.model) return "unknown";
	// Nothing reported since the runner started (or since the change): it
	// reports right after its next idle claim.
	if (!ap) return "pending";
	if (ap.requested !== a.model) return "pending";
	return ap.error ? "failed" : "applied";
}

/**
 * Where an agent's effort stands. `unknown`: nothing chosen and nothing
 * reported (the report lives in the backend's memory, so a backend restart
 * loses it while the runner, which already reported, says nothing more) —
 * not flagged, like a model never chosen. A report made for another model
 * than the stored one is stale: pending until the runner re-reports.
 */
export function effortState(a: {
	model?: string | null;
	effort?: string | null;
	effortApplied?: { model?: string | null; requested: string; error: string | null } | null;
}): "applied" | "pending" | "failed" | "unknown" {
	const ap = a.effortApplied;
	if (!ap) return a.effort ? "pending" : "unknown";
	if (ap.requested !== (a.effort ?? "default")) return "pending";
	if (a.model && ap.model !== a.model) return "pending";
	return ap.error ? "failed" : "applied";
}

/** An effort level as people read it: `default` → "Default", `extra_high` → "Extra High". */
export function effortLabel(level: string | null | undefined): string {
	if (!level || level === "default") return "Default";
	return level
		.split(/[_-]+/)
		.filter(Boolean)
		.map((w) => w[0]!.toUpperCase() + w.slice(1))
		.join(" ");
}

export const STATE_LABEL: Record<string, string> = {
	pending: "en cola",
	running: "trabajando",
	done: "hecho",
	failed: "falló",
	uncertain: "incierto",
};

const MENTION_RE = /(^|[^A-Za-z0-9_@.-])@([a-z][a-z0-9-]{1,31})(?![a-z0-9-])/g;

/** Agents named with `@name` in `text`, in order of first appearance, only among `names`. */
export function parseMentions(text: string, names: readonly string[]): string[] {
	const known = new Set(names);
	const out: string[] = [];
	for (const m of text.matchAll(MENTION_RE)) {
		const n = m[2]!;
		if (known.has(n) && !out.includes(n)) out.push(n);
	}
	return out;
}

/**
 * Who a Project Chat post goes to. The agents named at the START of the
 * message (`@a @b, haced X`) are its recipients; a mention inside the text is
 * part of the instruction ("@arq consultá a @dev: …" goes to @arq only).
 * Every leading mention must be an agent of the project: one that is not
 * (a typo, an agent of another project) refuses the whole post — never a
 * partial send, and never a fallback to a name found later in the text
 * ("@devv revisá con @qa" must not reach @qa). Without leading mentions: the
 * one agent mentioned anywhere, or the only agent of the project; otherwise
 * the person is asked to start with one.
 */
export function recipientsOf(
	text: string,
	names: readonly string[],
): { to: string[]; error: string | null } {
	const known = new Set(names);
	const valid = names.map((n) => `@${n}`).join(", ");
	const lead = /^\s*((?:@[A-Za-z0-9_-]+[\s,;:.!?]*)+)/.exec(text);
	if (lead) {
		const to = [...new Set([...lead[1]!.matchAll(/@([A-Za-z0-9_-]+)/g)].map((m) => m[1]!))];
		const unknown = to.filter((n) => !known.has(n));
		if (unknown.length === 0) return { to, error: null };
		return {
			to: [],
			error: `${unknown.map((n) => `@${n}`).join(", ")} no ${unknown.length === 1 ? "es un agente" : "son agentes"} de este proyecto${names.length ? ` (agentes: ${valid})` : ""}. No se envió nada.`,
		};
	}
	const any = parseMentions(text, names);
	if (any.length === 1) return { to: any, error: null };
	if (names.length === 1 && any.length === 0) return { to: [names[0]!], error: null };
	if (names.length === 0)
		return { to: [], error: "Este proyecto no tiene agentes todavía: agregá uno." };
	return {
		to: [],
		error: `Empezá el mensaje con el agente al que va dirigido: ${valid}`,
	};
}

// ── Recipients picked from a menu (Project Chat's "+") ─────────────────────
//
// The recipients ARE the leading mentions of the text (recipientsOf): the
// menu only edits that leading group, so what is sent is exactly what the
// person could have typed, and drafts, the unsent message and retries carry
// the recipients with the text. Every edit is a list of splices, so the
// field's caret and selection can be carried across them (mapThroughEdits).

/** Replace `text[start, end)` with `insert`. */
export interface TextEdit {
	start: number;
	end: number;
	insert: string;
}

const LEAD_RE = /^\s*((?:@[A-Za-z0-9_-]+[\s,;:.!?]*)+)/;
const LEAD_TOKEN_RE = /@([A-Za-z0-9_-]+)([\s,;:.!?]*)/g;

/** The leading mentions: each `@name` with where it and its separators end. */
function leadTokens(
	text: string,
): Array<{ name: string; start: number; end: number; sepEnd: number }> {
	const m = LEAD_RE.exec(text);
	if (!m) return [];
	const from = m[0].length - m[1]!.length;
	const out = [];
	for (const t of m[1]!.matchAll(LEAD_TOKEN_RE)) {
		const start = from + t.index!;
		const end = start + 1 + t[1]!.length;
		out.push({ name: t[1]!, start, end, sepEnd: end + t[2]!.length });
	}
	return out;
}

export function applyEdits(text: string, edits: readonly TextEdit[]): string {
	let out = text;
	for (const e of edits) out = out.slice(0, e.start) + e.insert + out.slice(e.end);
	return out;
}

/** Where a caret at `pos` is after the edits (inside a removed span: at its end). */
export function mapThroughEdits(pos: number, edits: readonly TextEdit[]): number {
	let p = pos;
	for (const e of edits) {
		if (p >= e.end) p += e.insert.length - (e.end - e.start);
		else if (p > e.start) p = e.start + e.insert.length;
	}
	return p;
}

/**
 * The menu's row for agent `name`: checked iff it is a recipient of the
 * text as it is (recipientsOf — never another source); `implicit` when it
 * is one only because the text mentions it once inside (no leading group),
 * which unchecking cannot change without editing the message's body.
 */
export function recipientRow(
	text: string,
	names: readonly string[],
	name: string,
): { checked: boolean; implicit: boolean } {
	const checked = recipientsOf(text, names).to.includes(name);
	return { checked, implicit: checked && leadTokens(text).length === 0 };
}

/**
 * The edits that make `name` a recipient (`on`) or not, touching only the
 * leading group. On: added after the last leading mention (`@a, @b: x` →
 * `@a, @b @c: x`); without a leading group, the recipients the text already
 * has (an implicit one) are written out with it, so checking someone never
 * takes the message from whoever was getting it. A leading mention that is
 * not an agent stays (its error too). Off: every leading `@name` goes, with
 * its separator (the last one keeps the group's closing separator); an
 * implicit recipient cannot be unchecked: no edit.
 */
export function setRecipient(
	text: string,
	names: readonly string[],
	name: string,
	on: boolean,
): TextEdit[] {
	const lead = leadTokens(text);
	if (on) {
		if (lead.some((t) => t.name === name)) return [];
		if (lead.length > 0) {
			const last = lead[lead.length - 1]!;
			return [{ start: last.end, end: last.end, insert: ` @${name}` }];
		}
		const now = recipientsOf(text, names).to.filter((n) => n !== name);
		const at = text.length - text.trimStart().length;
		const group = [...now, name].map((n) => `@${n}`).join(" ");
		return [{ start: at, end: at, insert: `${group} ` }];
	}
	const edits: TextEdit[] = [];
	// Right to left: each splice leaves the earlier offsets valid.
	for (let i = lead.length - 1; i >= 0; i--) {
		const t = lead[i]!;
		if (t.name !== name) continue;
		const isLast = i === lead.length - 1 || lead.slice(i + 1).every((x) => x.name === name);
		const prev = lead[i - 1];
		if (isLast && prev && prev.name !== name)
			// `@a, @b: x` without @b → `@a: x` (the group's closing separator kept).
			edits.push({ start: prev.end, end: t.end, insert: "" });
		else edits.push({ start: t.start, end: t.sepEnd, insert: "" });
	}
	return edits;
}

/** The work a message runs in, as its chat tag; null for the agent's default context. */
export function workTag(m: Pick<AcpMessage, "context">): string | null {
	return m.context ? `trabajo ${m.context}` : null;
}

/** Insert or replace by id, keeping id order. */
export function upsert(list: AcpMessage[], m: AcpMessage): AcpMessage[] {
	const i = list.findIndex((x) => x.id === m.id);
	if (i >= 0) {
		const next = list.slice();
		next[i] = m;
		return next;
	}
	if (list.length === 0 || list[list.length - 1]!.id < m.id) return [...list, m];
	return [...list, m].sort((a, b) => a.id - b.id);
}

export type ThreadItem =
	| { kind: "single"; message: AcpMessage }
	/** One post of the person to several agents (same client id): one bubble, one row per recipient. */
	| { kind: "post"; body: string; messages: AcpMessage[] };

export function groupThread(messages: readonly AcpMessage[]): ThreadItem[] {
	const out: ThreadItem[] = [];
	const posts = new Map<string, Extract<ThreadItem, { kind: "post" }>>();
	for (const m of messages) {
		if (m.from_id === "owner" && m.client_id) {
			const p = posts.get(m.client_id);
			if (p && p.body === m.body) {
				p.messages.push(m);
				continue;
			}
			const item = { kind: "post" as const, body: m.body, messages: [m] };
			posts.set(m.client_id, item);
			out.push(item);
			continue;
		}
		out.push({ kind: "single", message: m });
	}
	// A post that reached one agent reads like any message.
	return out.map((it) =>
		it.kind === "post" && it.messages.length === 1
			? { kind: "single", message: it.messages[0]! }
			: it,
	);
}

export interface ActivityRow {
	key: string;
	label: string;
	state: string;
	detail: string;
}

/** One row per tool call / background task with its latest state (events are deltas). */
export function activityRows(events: readonly AcpActivity[], max = 12): ActivityRow[] {
	const rows = new Map<string, ActivityRow>();
	for (const a of events) {
		if (a.kind !== "tool" && a.kind !== "task") continue;
		const key = `${a.kind}:${String(a.kind === "task" ? a.taskId : a.toolCallId)}`;
		const row = rows.get(key) ?? { key, label: "", state: "", detail: "" };
		if (a.kind === "task")
			row.label ||= `segundo plano · ${String(a.name ?? a.taskType ?? a.taskId)}`;
		else if (a.title) row.label = String(a.title);
		if (a.kind === "tool" && typeof a.detail === "string") row.detail = a.detail;
		const st = a.kind === "task" ? a.state : a.status;
		if (st) row.state = String(st);
		rows.set(key, row);
	}
	return [...rows.values()].slice(-max);
}

export const ACTIVITY_STATE: Record<string, string> = {
	pending: "…",
	in_progress: "en curso",
	running: "en curso",
	completed: "ok",
	failed: "falló",
	stopped: "detenida",
};

export interface AgentStatus {
	label: string;
	tone: "ok" | "busy" | "warn" | "off";
}

/** A runner polls for work every ~2 s while idle and reports activity while busy. */
const RUNNER_FRESH_MS = 20_000;

/** The fields agentStatus reads (a full /api/acp/agents row, or the registry's entry). */
export type AgentStatusInput = Pick<AcpAgentInfo, "runnerSeenAt"> & Partial<AcpAgentInfo>;

export function agentStatus(a: AgentStatusInput, now: number, authRequired = false): AgentStatus {
	if (authRequired || a.authRequired) return { label: "esperando login", tone: "warn" };
	if (a.waitingInput) return { label: "esperando tu respuesta", tone: "warn" };
	const seen = a.runnerSeenAt ? now - Date.parse(a.runnerSeenAt) : Number.POSITIVE_INFINITY;
	const queued = a.pending ? ` · ${a.pending} en cola` : "";
	if (a.running?.length) {
		const ids = a.running.map((id) => `#${id}`);
		const list =
			ids.length > 1 ? `${ids.slice(0, -1).join(", ")} y ${ids[ids.length - 1]}` : ids[0];
		return { label: `trabajando en ${list}${queued}`, tone: "busy" };
	}
	if (seen > RUNNER_FRESH_MS)
		return {
			label: a.runnerSeenAt ? `runner sin señal${queued}` : `runner sin conectar${queued}`,
			tone: "off",
		};
	return { label: a.pending ? `${a.pending} en cola` : "disponible", tone: "ok" };
}

/**
 * The sidebar's short form of agentStatus: one word next to a coloured mark,
 * the full label for the tooltip and the accessible name, and whether it
 * asks something of the person (a question, a login) — those two stand out,
 * up to the project's heading.
 */
export interface SidebarAgentStatus extends AgentStatus {
	word: string;
	asks: boolean;
}

/**
 * How long a started session's runner may take to show up before "iniciando"
 * turns into "sin señal". The runner is launched only after the session's
 * creation bootstrap (clone, dotfiles, postCreate: typically a minute or two)
 * and then starts the adapter; three minutes covers that without hiding a
 * runner that really failed to come up for long.
 */
export const RUNNER_START_GRACE_MS = 180_000;

/**
 * `startedAt`: when (client clock) the session was seen to (re)start, if this
 * page saw it — its creation, or a status turning `running`. A runner that has
 * not reported SINCE that start is starting, not lost, for the grace period:
 * never reported (runnerSeenAt null), or last seen before the start — the
 * backend keeps the previous run's `runnerSeenAt` across a restart. A restart
 * this page did not see has no start, so it gets no grace ("sin señal" until
 * the runner reports).
 */
export function sidebarAgentStatus(
	a: AgentStatusInput,
	now: number,
	startedAt?: number,
): SidebarAgentStatus {
	const st = agentStatus(a, now);
	const seen = a.runnerSeenAt ? Date.parse(a.runnerSeenAt) : Number.NaN;
	if (
		st.tone === "off" &&
		startedAt !== undefined &&
		now - startedAt < RUNNER_START_GRACE_MS &&
		(Number.isNaN(seen) || seen < startedAt)
	)
		return {
			label: "iniciando (el runner todavía no se conectó)",
			tone: "off",
			word: "iniciando",
			asks: false,
		};
	const word =
		st.label === "esperando login"
			? "login"
			: st.label === "esperando tu respuesta"
				? "te espera"
				: st.tone === "busy"
					? "trabajando"
					: st.tone === "off"
						? "sin señal"
						: "disponible";
	return { ...st, word, asks: st.tone === "warn" };
}

/** Login state of an agent from its activity: the last `auth` or answered turn wins. */
export function authFromActivity(events: readonly AcpActivity[], initial: boolean): boolean {
	let v = initial;
	for (const e of events) {
		if (e.kind === "auth") v = e.state === "required";
		if (e.kind === "turn" && e.phase === "answered") v = false;
	}
	return v;
}

export function who(id: string): string {
	return id === "owner" ? "Vos" : id === "system" ? "Shared Terminal" : `@${id}`;
}

// ── Questions (ACP form elicitation) ─────────────────────────────────────

export interface QuestionField {
	key: string;
	label: string;
	kind: "single" | "multi" | "text" | "boolean" | "number";
	options: Array<{ value: string; label: string; description?: string }>;
	/** `<key>_custom` companion of a choice: the free-text "other" answer. */
	custom?: string;
}

export interface QuestionForm {
	message: string;
	fields: QuestionField[];
}

type Schema = { type?: string; title?: string; description?: string; [k: string]: unknown };
type EnumOpt = { const?: unknown; title?: string; description?: string };

/**
 * The form of an elicitation request, as far as Shared Terminal renders it:
 * single choice (`oneOf` / `enum`), multiple choice (array of `anyOf`/`enum`),
 * text, boolean, number. Claude's AskUserQuestion pairs each choice
 * `question_<n>` with a free-text `question_<n>_custom` ("Other"): that pair
 * becomes one field. Anything unreadable degrades to a text field.
 */
export function questionForm(requestJson: string): QuestionForm {
	let req: { message?: unknown; requestedSchema?: { properties?: Record<string, Schema> } } = {};
	try {
		req = JSON.parse(requestJson) as typeof req;
	} catch {
		/* empty form */
	}
	const props = req.requestedSchema?.properties ?? {};
	const fields: QuestionField[] = [];
	const keys = Object.keys(props);
	for (const key of keys) {
		const p = props[key] ?? {};
		if (key.endsWith("_custom") && keys.includes(key.slice(0, -7))) continue;
		const label = String(p.description ?? p.title ?? "");
		const opts = (list: unknown): QuestionField["options"] =>
			Array.isArray(list)
				? list.map((o: EnumOpt | string) =>
						typeof o === "string"
							? { value: o, label: o }
							: {
									value: String(o.const ?? o.title ?? ""),
									label: String(o.title ?? o.const ?? ""),
									...(o.description ? { description: String(o.description) } : {}),
								},
					)
				: [];
		const items = (p.items ?? {}) as Schema;
		let field: QuestionField;
		if (p.type === "array")
			field = {
				key,
				label,
				kind: "multi",
				options: opts(items.anyOf ?? items.oneOf ?? items.enum),
			};
		else if (Array.isArray(p.oneOf) || Array.isArray(p.enum))
			field = { key, label, kind: "single", options: opts(p.oneOf ?? p.enum) };
		else if (p.type === "boolean") field = { key, label, kind: "boolean", options: [] };
		else if (p.type === "number" || p.type === "integer")
			field = { key, label, kind: "number", options: [] };
		else field = { key, label, kind: "text", options: [] };
		if (keys.includes(`${key}_custom`)) field.custom = `${key}_custom`;
		fields.push(field);
	}
	return { message: String(req.message ?? ""), fields };
}

/** The answer in words, for the thread and for "send as a message". */
export function answerText(form: QuestionForm, answerJson: string | null): string {
	if (!answerJson) return "";
	let a: { action?: string; content?: Record<string, unknown> } = {};
	try {
		a = JSON.parse(answerJson) as typeof a;
	} catch {
		return "";
	}
	if (a.action !== "accept") return a.action === "decline" ? "(omitida)" : "(cancelada)";
	const c = a.content ?? {};
	const parts: string[] = [];
	for (const f of form.fields) {
		const v = c[f.key];
		const custom = f.custom ? String(c[f.custom] ?? "").trim() : "";
		const shown = [
			Array.isArray(v) ? v.join(", ") : v === undefined || v === "" ? "" : String(v),
			custom,
		]
			.filter(Boolean)
			.join(" — ");
		if (shown) parts.push(f.label && form.fields.length > 1 ? `${f.label}: ${shown}` : shown);
	}
	return parts.join("\n") || "(sin respuesta)";
}

/**
 * A stable hue per agent name, so each agent keeps its colour wherever it
 * shows (its chats, the Project Chat header, the sidebar): `--acp-hue`.
 */
export function agentHue(name: string): number {
	let h = 0;
	for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
	return h;
}

/**
 * Where message `id` stands for a thread showing `shownIds` (its loaded
 * page or pages): on screen; on an earlier page not loaded yet (older than
 * the oldest shown, with earlier pages left — ids grow with time); or not
 * in this chat at all (another scope, or gone).
 */
export function messagePlace(
	id: number,
	shownIds: readonly number[],
	hasEarlier: boolean,
): "shown" | "earlier" | "elsewhere" {
	if (shownIds.includes(id)) return "shown";
	const oldest = shownIds.length > 0 ? Math.min(...shownIds) : null;
	if (hasEarlier && oldest !== null && id < oldest) return "earlier";
	return "elsewhere";
}

// ── Project rail (3B F1) ────────────────────────────────────────────────────

/**
 * An agent's state in the seven words fixed for 3B (PROPUESTA §4, #757):
 * «disponible» · «trabajando aquí» · «ocupado en «X»» · «N en cola» ·
 * «esperando a @x» · «espera tu decisión» · «ejecución interrumpida»
 * (busy and a queue combine: «ocupado en «X» · N en cola»). Never slots.
 *
 * What the person must act on comes first (a question, an interruption not
 * reviewed); then what the agent is doing; then what it waits for.
 * `here`: the topic on screen («trabajando aquí»); `titleOf`: a topic's
 * title in this project (another project's, or the Archive's, is unknown:
 * plain «ocupado»).
 */
export interface TeamState {
	label: string;
	tone: "ok" | "busy" | "warn" | "err" | "idle";
	/** The whole sentence where the short label leaves something out (a tooltip). */
	full?: string;
}

export function teamState(
	a: Pick<
		AcpAgentInfo,
		| "runningIn"
		| "running"
		| "queue"
		| "pending"
		| "waitingFor"
		| "question"
		| "waitingInput"
		| "heldBy"
	>,
	ctx: { here: string | null; titleOf: (id: string) => string | null; interrupted: boolean },
): TeamState {
	if (a.question || a.waitingInput) return { label: "espera tu decisión", tone: "warn" };
	if (ctx.interrupted) return { label: "ejecución interrumpida", tone: "err" };
	const queued = a.queue?.length ?? a.pending ?? 0;
	const inQueue = queued ? ` · ${queued} en cola` : "";
	const running = a.runningIn ?? (a.running ?? []).map((id) => ({ id, conversationId: null }));
	if (running.length) {
		if (ctx.here !== null && running.some((r) => r.conversationId === ctx.here))
			return { label: `trabajando aquí${inQueue}`, tone: "busy" };
		const titled = running
			.map((r) => (r.conversationId ? ctx.titleOf(r.conversationId) : null))
			.find((t): t is string => t !== null);
		return { label: `${titled ? `ocupado en «${titled}»` : "ocupado"}${inQueue}`, tone: "busy" };
	}
	// Kept in a topic by a process it left running there (#757 b): on the
	// rail «ocupado»; the whole sentence where there is room.
	const held = a.heldBy?.[0];
	if (held) {
		const t = held.conversationId ? ctx.titleOf(held.conversationId) : null;
		return {
			label: `ocupado${inQueue}`,
			tone: "busy",
			full: `${t ? `ocupado en «${t}»` : "ocupado"} · proceso en curso${inQueue}`,
		};
	}
	const waiting = a.waitingFor?.[0];
	if (waiting) return { label: `esperando a @${waiting.agent}`, tone: "idle" };
	if (queued) return { label: `${queued} en cola`, tone: "busy" };
	return { label: "disponible", tone: "ok" };
}

/**
 * A row's event time for the read mark (§4b Read state): when a person's
 * message got its result, the time it finished; anything else, when it was
 * written.
 */
export function eventTime(m: AcpMessage): string {
	return m.from_id === "owner" && m.state === "done" && m.result_text && m.finished_at
		? m.finished_at
		: m.created_at;
}

/** A row is news for a reader whose mark is `readAt` (null: never read). */
export function isUnread(m: AcpMessage, readAt: string | null): boolean {
	if (m.from_id === "owner" && !(m.state === "done" && m.result_text)) return false;
	return readAt === null || Date.parse(eventTime(m)) > Date.parse(readAt);
}

// ── A topic's thread (3B F2) ────────────────────────────────────────────────
//
// A topic reads as a timeline: the person's post (one logical message, one
// state row per recipient), an agent's consult with its answer nested, the
// Shared Terminal notes, and each RESULT as its own item when it arrived —
// an answer is news at the time it lands, not at the time it was asked.

export type TopicItem =
	/** The person's message: one row per recipient (one client id). */
	| { kind: "post"; key: string; at: number; messages: AcpMessage[] }
	/** An agent asks another: the answer goes nested in it. */
	| { kind: "consult"; key: string; at: number; message: AcpMessage }
	| { kind: "system"; key: string; at: number; message: AcpMessage }
	/**
	 * The answer to a consult, delivered to the agent that asked. Its text is
	 * already nested in the consult: shown only as a reference when it came
	 * late (something else between them), or in full when the consult is not
	 * in the thread (an earlier page).
	 */
	| { kind: "reply"; key: string; at: number; message: AcpMessage; consult: AcpMessage | null }
	/** What an agent answered (a post's, a delivered reply's, a note's), when it answered. */
	| { kind: "result"; key: string; at: number; message: AcpMessage };

function timeOf(iso: string | null | undefined): number {
	const t = iso ? Date.parse(iso) : Number.NaN;
	return Number.isNaN(t) ? 0 : t;
}

export function topicTimeline(messages: readonly AcpMessage[]): TopicItem[] {
	const byId = new Map(messages.map((m) => [m.id, m]));
	const out: TopicItem[] = [];
	for (const it of groupThread(messages)) {
		const ms = it.kind === "post" ? it.messages : [it.message];
		const m = ms[0]!;
		const at = timeOf(m.created_at);
		if (m.from_id === "owner") out.push({ kind: "post", key: `post:${m.id}`, at, messages: ms });
		else if (m.kind === "reply")
			out.push({
				kind: "reply",
				key: `reply:${m.id}`,
				at,
				message: m,
				consult: m.reply_to !== null ? (byId.get(m.reply_to) ?? null) : null,
			});
		else if (m.from_id === "system")
			out.push({ kind: "system", key: `system:${m.id}`, at, message: m });
		else out.push({ kind: "consult", key: `consult:${m.id}`, at, message: m });
		// A consult's answer is nested in it; every other answer is its own item.
		for (const r of ms)
			if (
				r.result_text &&
				!(r.kind === "request" && r.from_id !== "owner" && r.from_id !== "system")
			)
				out.push({
					kind: "result",
					key: `result:${r.id}`,
					at: timeOf(r.finished_at ?? r.created_at),
					message: r,
				});
	}
	// Stable: items written at the same instant keep the order they were made in.
	const sorted = out
		.map((item, i) => ({ item, i }))
		.sort((a, b) => a.item.at - b.item.at || a.i - b.i)
		.map((x) => x.item);
	// A reply right after its consult says nothing the consult does not.
	return sorted.filter((item, i) => {
		if (item.kind !== "reply" || !item.consult) return true;
		const prev = sorted[i - 1];
		return !(prev && prev.kind === "consult" && prev.message.id === item.consult.id);
	});
}

/** The messages an item shows (the anchor's ids). */
export function itemMessages(item: TopicItem): AcpMessage[] {
	return item.kind === "post" ? item.messages : [item.message];
}

/** What the agents' facts say about one of them, as far as a message to it in `here` goes. */
type BusyInput = Pick<AcpAgentInfo, "runningIn" | "heldBy" | "question">;

/**
 * Why a message to `a` in topic `here` would wait for something else, in
 * the fixed words: busy in another topic («ocupado en «X»», «… · proceso
 * en curso» when a process it left there holds it) or waiting for the
 * person there. Only the topic slot counts: a work runs elsewhere and does
 * not hold a topic's message back. Null: nothing elsewhere holds it.
 */
export function busyElsewhere(
	a: BusyInput | undefined,
	here: string | null,
	titleOf: (id: string) => string | null,
): string | null {
	if (!a) return null;
	const named = (id: string | null) => {
		const t = id ? titleOf(id) : null;
		return t ? ` en «${t}»` : "";
	};
	const run = a.runningIn?.find((r) => r.work === null && r.conversationId !== here);
	if (run) return `ocupado${named(run.conversationId)}`;
	const held = a.heldBy?.find((h) => h.work === null && h.conversationId !== here);
	if (held) return `ocupado${named(held.conversationId)} · proceso en curso`;
	const q = a.question;
	if (q && q.conversationId !== here) return `espera tu decisión${named(q.conversationId)}`;
	return null;
}

export type RecipientKind =
	| "running"
	| "pending"
	| "waiting"
	| "login"
	| "done"
	| "failed"
	| "interrupted"
	| "reviewed";

/**
 * One recipient's row under the person's message (PROPUESTA §3): each
 * advances on its own, from the backend's states — never a timer, never an
 * aggregate progress of the message.
 */
export function recipientState(
	m: AcpMessage,
	ctx: {
		agent?: BusyInput;
		titleOf: (id: string) => string | null;
		/** An open question of this message. */
		asking: boolean;
		/** The agent waits for a login. */
		login: boolean;
		/** Its latest activity, if any (a tool, a task). */
		activity: string | null;
	},
): { kind: RecipientKind; label: string } {
	if (m.state === "running" && ctx.asking) return { kind: "waiting", label: "espera tu decisión" };
	if (ctx.login && (m.state === "pending" || m.state === "running"))
		return { kind: "login", label: "esperando login" };
	if (m.state === "running")
		return {
			kind: "running",
			label: ctx.activity ? `trabajando · ${ctx.activity}` : "trabajando",
		};
	if (m.state === "pending") {
		const why = m.context ? null : busyElsewhere(ctx.agent, m.conversation_id ?? null, ctx.titleOf);
		return { kind: "pending", label: `en cola — ${why ?? "lo toma en cuanto se libere"}` };
	}
	if (m.state === "done") return { kind: "done", label: m.result_text ? "respondió" : "terminó" };
	if (m.state === "failed") return { kind: "failed", label: "falló" };
	return m.reviewed_at
		? { kind: "reviewed", label: "interrumpida · revisada, no reencolada" }
		: { kind: "interrupted", label: "interrumpida" };
}

/** «→ Todo el equipo (N)»: every row of the post went to the whole team. */
export function isTeamPost(ms: readonly AcpMessage[]): boolean {
	return ms.length > 0 && ms.every((m) => m.team === 1);
}

/** The recipients a topic's composer starts with: the topic's own, as the server keeps them. */
export interface Chips {
	team: boolean;
	agents: string[];
}

export function chipsOf(
	recipients: { agents: string[] } | { team: true } | null | undefined,
): Chips {
	if (!recipients) return { team: false, agents: [] };
	if ("team" in recipients) return { team: true, agents: [] };
	return { team: false, agents: [...recipients.agents] };
}

/** The `@query` being typed right before the caret, if any (the mention menu's filter). */
export function mentionQuery(text: string, caret: number): { query: string; start: number } | null {
	const m = /(^|[\s(,;:])@([A-Za-z0-9_-]*)$/.exec(text.slice(0, caret));
	if (!m) return null;
	return { query: m[2]!, start: caret - m[2]!.length - 1 };
}
