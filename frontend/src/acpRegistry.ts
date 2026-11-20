// acpRegistry.ts — the ACP agents as last read from /api/acp/agents, by
// session: who is an agent, in which project, and its state (running,
// queue, login, a question waiting, runner liveness). The one store every
// view reads agents from (the sidebar's rows and group headings); every
// read of the list writes it (the ACP chats, the project page, the session
// form, and acpStatusFeed.ts, which keeps it current on a budget). A leaf
// module (no imports), so the sidebar (sessionCore.ts) can use it without
// importing the chat modules.
//
// Announced changes: `st:acp-agents` when who is an agent or their project
// changed (the sidebar regroups), `st:acp-status` when only a state changed
// (the sidebar repaints its rows in place).

export interface AcpSessionEntry {
	name: string;
	projectId: string | null;
	runnerSeenAt: string | null;
	running: number | null;
	pending: number;
	authRequired: boolean;
	waitingInput: boolean;
}

/** The fields of an /api/acp/agents row the registry keeps (structural: no import). */
export interface AcpAgentRowLike {
	sessionId: string;
	name: string;
	projectId?: string | null;
	runnerSeenAt?: string | null;
	running?: number | null;
	pending?: number;
	authRequired?: boolean;
	waitingInput?: boolean;
}

let bySession = new Map<string, AcpSessionEntry>();
/** The list was read at least once (before that, "not an agent" is unknown). */
let loaded = false;
/** When (client clock) the list was last read: runner liveness is judged as of then. */
let readAt = 0;

function entry(a: AcpAgentRowLike): AcpSessionEntry {
	return {
		name: a.name,
		projectId: a.projectId ?? null,
		runnerSeenAt: a.runnerSeenAt ?? null,
		running: a.running ?? null,
		pending: a.pending ?? 0,
		authRequired: a.authRequired === true,
		waitingInput: a.waitingInput === true,
	};
}

function announce(type: "st:acp-agents" | "st:acp-status"): void {
	if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(type));
}

export function setAcpAgents(list: ReadonlyArray<AcpAgentRowLike>): void {
	const next = new Map(list.map((a) => [a.sessionId, entry(a)]));
	const sameMembers =
		next.size === bySession.size &&
		[...next].every(
			([k, v]) => bySession.get(k)?.projectId === v.projectId && bySession.get(k)?.name === v.name,
		);
	bySession = next;
	loaded = true;
	readAt = Date.now();
	// Every read is announced: a state judged against the clock ("iniciando"
	// turning into "sin señal") is repainted even when no field changed.
	if (!sameMembers) announce("st:acp-agents");
	else announce("st:acp-status");
}

/** A live event's effect on one agent (by name) before the next read confirms it. */
export function patchAcpAgent(name: string, patch: Partial<AcpSessionEntry>): void {
	for (const [sid, e] of bySession) {
		if (e.name !== name) continue;
		const next = { ...e, ...patch };
		if (JSON.stringify(next) === JSON.stringify(e)) return;
		bySession.set(sid, next);
		announce("st:acp-status");
		return;
	}
}

/** The list was read at least once (with this page). */
export function acpAgentsLoaded(): boolean {
	return loaded;
}

/** Is the session an ACP agent's? null while the list has not been read yet. */
export function isAcpAgentSession(sessionId: string): boolean | null {
	return loaded ? bySession.has(sessionId) : null;
}

export function acpEntry(sessionId: string): AcpSessionEntry | null {
	return bySession.get(sessionId) ?? null;
}

export function acpEntryByName(name: string): AcpSessionEntry | null {
	for (const e of bySession.values()) if (e.name === name) return e;
	return null;
}

/** The client time of the last read (0: never). */
export function acpAgentsReadAt(): number {
	return readAt;
}

/** Logout: nothing of the previous account's agents survives. */
export function resetAcpAgents(): void {
	bySession = new Map();
	loaded = false;
	readAt = 0;
}
