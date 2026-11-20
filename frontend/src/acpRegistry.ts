// acpRegistry.ts — which sessions are ACP agents and in which project, as last
// read by the ACP chats. A leaf module (no imports) so the sidebar
// (sessionCore.ts) can group agent sessions under their project without
// importing the chat modules. A change is announced as `st:acp-agents`.

export interface AcpSessionEntry {
	name: string;
	projectId: string | null;
}

let bySession = new Map<string, AcpSessionEntry>();
/** The list was read at least once (before that, "not an agent" is unknown). */
let loaded = false;

export function setAcpAgents(
	list: ReadonlyArray<{ sessionId: string; name: string; projectId?: string | null }>,
): void {
	const next = new Map(
		list.map((a) => [a.sessionId, { name: a.name, projectId: a.projectId ?? null }]),
	);
	const same =
		next.size === bySession.size &&
		[...next].every(
			([k, v]) => bySession.get(k)?.projectId === v.projectId && bySession.get(k)?.name === v.name,
		);
	bySession = next;
	loaded = true;
	if (!same && typeof window !== "undefined")
		window.dispatchEvent(new CustomEvent("st:acp-agents"));
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
