// acpModel.ts — pure helpers of the ACP chats (individual and Project Chat):
// mentions, grouping a post sent to several agents, activity rows, agent
// status words. No DOM, no network: unit-tested in acpModel.test.ts.

import type { AcpActivity, AcpAgentInfo, AcpMessage } from "./api.js";

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

/** Who a Project Chat post goes to: its mentions, or the only agent when there is one. */
export function recipientsOf(
	text: string,
	names: readonly string[],
): { to: string[]; error: string | null } {
	const to = parseMentions(text, names);
	if (to.length) return { to, error: null };
	if (names.length === 1) return { to: [names[0]!], error: null };
	if (names.length === 0)
		return { to: [], error: "Este proyecto no tiene agentes todavía: agregá uno." };
	return {
		to: [],
		error: `Mencioná al menos un agente: ${names.map((n) => `@${n}`).join(", ")}`,
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
