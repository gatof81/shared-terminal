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

export const STATE_LABEL: Record<string, string> = {
	pending: "pendiente",
	running: "en curso",
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
export const RUNNER_FRESH_MS = 20_000;

export function agentStatus(a: AcpAgentInfo, now: number, authRequired = false): AgentStatus {
	if (authRequired || a.authRequired) return { label: "esperando login", tone: "warn" };
	if (a.waitingInput) return { label: "esperando tu respuesta", tone: "warn" };
	const seen = a.runnerSeenAt ? now - Date.parse(a.runnerSeenAt) : Number.POSITIVE_INFINITY;
	const queued = a.pending ? ` · ${a.pending} en espera` : "";
	if (a.running) return { label: `trabajando en #${a.running}${queued}`, tone: "busy" };
	if (seen > RUNNER_FRESH_MS)
		return {
			label: a.runnerSeenAt ? `runner sin señal${queued}` : `runner sin conectar${queued}`,
			tone: "off",
		};
	return { label: a.pending ? `${a.pending} en espera` : "libre", tone: "ok" };
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
