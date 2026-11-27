// projectSignals.ts — what a project's row says at a glance (the sidebar's
// Proyectos, the project selector): whether any of its agents is working,
// and ONE count by priority — what waits for the person (open questions +
// unreviewed interruptions, the same things #inbox-btn counts), else the
// results not seen yet. Only what is already in memory: the agents as
// acpRegistry last read them and Pendientes' copy (acpInboxStore). No
// request of its own; callers repaint on `st:acp-*` and onInbox.

import { inboxNow } from "./acpInboxStore.js";
import { acpAgentsIn, acpAgentsLoaded } from "./acpRegistry.js";

export interface ProjectSignals {
	/** Agents of the project running a message or with one queued. */
	working: number;
	/** Agents in the project; null until the agents were read. */
	agents: number | null;
	waits: number;
	results: number;
}

export function projectSignals(projectId: string): ProjectSignals {
	const team = acpAgentsLoaded() ? acpAgentsIn(projectId) : null;
	const inbox = inboxNow();
	const mine = (m: { project_id?: string | null }) => m.project_id === projectId;
	return {
		working: team?.filter((a) => a.running.length > 0 || a.pending > 0).length ?? 0,
		agents: team?.length ?? null,
		waits: inbox
			? inbox.action.questions.filter(mine).length + inbox.action.interrupted.filter(mine).length
			: 0,
		results: inbox?.results.filter(mine).length ?? 0,
	};
}

/**
 * The dot (always there, filled only with activity: names stay aligned) and
 * the one pill — or «sin agentes» — painted into `into`'s
 * `.psig-dot` / `.psig-end` (created the first time). Returns the words a
 * screen reader gets after the name: « — 2 agentes trabajando, 1 te espera».
 */
export function paintProjectSignals(into: HTMLElement, sig: ProjectSignals): string {
	let dot = into.querySelector<HTMLElement>(":scope > .psig-dot");
	if (!dot) {
		dot = document.createElement("span");
		dot.className = "psig-dot";
		dot.setAttribute("aria-hidden", "true");
		into.prepend(dot);
	}
	dot.classList.toggle("on", sig.working > 0);
	let end = into.querySelector<HTMLElement>(":scope > .psig-end");
	if (!end) {
		end = document.createElement("span");
		end.setAttribute("aria-hidden", "true");
		into.append(end);
	}
	const words: string[] = [];
	if (sig.working > 0)
		words.push(`${sig.working} ${sig.working === 1 ? "agente trabajando" : "agentes trabajando"}`);
	if (sig.agents === 0 && sig.waits === 0 && sig.results === 0) {
		end.className = "psig-end psig-none";
		end.textContent = "sin agentes";
		words.push("sin agentes");
	} else if (sig.waits > 0) {
		end.className = "psig-end psig-pill psig-waits";
		end.textContent = String(sig.waits);
		words.push(`${sig.waits} ${sig.waits === 1 ? "te espera" : "te esperan"}`);
	} else if (sig.results > 0) {
		end.className = "psig-end psig-pill psig-results";
		end.textContent = String(sig.results);
		words.push(`${sig.results} ${sig.results === 1 ? "resultado nuevo" : "resultados nuevos"}`);
	} else {
		end.className = "psig-end";
		end.textContent = "";
	}
	end.hidden = end.textContent === "";
	return words.length ? ` — ${words.join(", ")}` : "";
}
