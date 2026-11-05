/**
 * agentsSummary.ts — what a conversation's subagents look like at a glance
 * (pure; shared by the conversation switcher and, later, Project Chat).
 *
 * Input is the backend's per-conversation agent list (`GET …/agents`): each
 * agent's start and end come from captured hooks (SubagentStart /
 * SubagentStop), so "working" means "started, no end reported yet". Callers
 * show it only next to a conversation whose own evidence is fresh — an agent
 * of a stale conversation is not presented as working.
 */

export interface AgentEntry {
	agentId: string;
	agentType: string;
	status: "running" | "done";
	startedSeq: number;
	endedSeq?: number;
	toolCount: number;
	hasResult: boolean;
}

export interface AgentsAtAGlance {
	working: AgentEntry[];
	done: number;
	total: number;
}

/** Working agents newest first (by start), plus how many finished. */
export function atAGlance(agents: readonly AgentEntry[]): AgentsAtAGlance {
	const working = agents
		.filter((a) => a.status === "running")
		.sort((a, b) => b.startedSeq - a.startedSeq);
	return { working, done: agents.length - working.length, total: agents.length };
}

/** "2 agents working · 1 done", "1 agent done", "" when there are none. */
export function agentsLine(g: AgentsAtAGlance): string {
	const parts: string[] = [];
	if (g.working.length > 0)
		parts.push(`${g.working.length} agent${g.working.length === 1 ? "" : "s"} working`);
	if (g.done > 0)
		parts.push(
			g.working.length > 0 ? `${g.done} done` : `${g.done} agent${g.done === 1 ? "" : "s"} done`,
		);
	return parts.join(" · ");
}

/** A readable name for an agent (its type, else a short id). */
export function agentName(a: Pick<AgentEntry, "agentType" | "agentId">): string {
	const t = a.agentType.trim();
	return t.length > 0 ? t : `agent ${a.agentId.slice(0, 8)}`;
}
