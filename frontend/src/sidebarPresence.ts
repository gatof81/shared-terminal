/**
 * sidebarPresence.ts — Claude's state on the sidebar's session rows (owner
 * decision 2026-11-14). A leaf: the project page (projectsView.ts) owns the
 * requests and feeds every agents list it receives in here; the tree
 * (sessionCore.ts) says which projects are expanded and reads a row's state.
 *
 * The owner's conditions, and where each one lives:
 *  - existing model and reads: the answers are `GET …/projects/:id/agents`
 *    (the project page's own read) and the wording is `presentPresence`;
 *  - every 30 s, only expanded projects, only while the page is visible (and
 *    the sidebar on screen — a closed phone drawer asks nothing): `kick`;
 *  - no duplicate concurrent requests, answers reused: the loader is the
 *    page's `loadAgents` (one request in flight per project), a list the
 *    page polled itself counts as this module's answer, and the projects of
 *    a round are read one after another, never as a burst;
 *  - unknown when the evidence is stale or unreliable: `presentPresence`
 *    ages the evidence on the server's clock, and an ANSWER this module
 *    could not refresh (`ANSWER_MAX_AGE_MS`) proves nothing either.
 *
 * There is no timer here: the tree calls `watchSidebarPresence` on every
 * render (the 5 s session poll re-renders it), which is the heartbeat; the
 * 30 s is enforced per project by `due`.
 */

import type { AgentsResponse } from "./api.js";
import { type PresenceView, presentPresence } from "./projectModel.js";

export const SIDEBAR_PRESENCE_POLL_MS = 30_000;
/**
 * An answer older than this is not shown as a state: two polls were missed
 * (requests failing, or the page was hidden) and the row would be repeating
 * what was true then.
 */
export const ANSWER_MAX_AGE_MS = 75_000;
// The heartbeat is the 5 s session poll: without slack a project due at
// 30.0 s would be read at 35 s.
const DUE_SLACK_MS = 2_500;

interface Entry {
	data: AgentsResponse;
	receivedAt: number;
	/** What the rows show of it: a re-render is asked only when this changes. */
	signature: string;
}

// Keyed by projectId in Maps (server strings: never `obj[id]`).
let answers = new Map<string, Entry>();
/** When each project was last ASKED (answered or not): a failing read is retried at the same pace. */
let askedAt = new Map<string, number>();
let wanted: string[] = [];
let loader: ((projectId: string) => Promise<void>) | null = null;
let onChange: (() => void) | null = null;
let running = false;
let again = false;
// Bumped by every clear (logout): a round started before it stops.
let gen = 0;

let clock: () => number = () => Date.now();
let pageVisible: () => boolean = () => document.visibilityState === "visible";

function signatureOf(data: AgentsResponse): string {
	return data.agents
		.map((a) =>
			[
				a.agentId,
				a.binding?.sessionId ?? "",
				a.presence.value,
				a.presence.detail ?? "",
				a.presence.source,
				a.presence.at ?? "",
				a.presence.verified === true ? "v" : "",
			].join("\u0001"),
		)
		.join("\u0002");
}

function due(projectId: string, now: number): boolean {
	const last = Math.max(answers.get(projectId)?.receivedAt ?? 0, askedAt.get(projectId) ?? 0);
	const elapsed = now - last;
	// A clock that went backwards counts as due (never a frozen row).
	return !(elapsed >= 0) || elapsed >= SIDEBAR_PRESENCE_POLL_MS - DUE_SLACK_MS;
}

async function round(): Promise<void> {
	if (running) {
		again = true;
		return;
	}
	running = true;
	const myGen = gen;
	try {
		do {
			again = false;
			for (const pid of [...wanted]) {
				if (myGen !== gen || loader === null || !pageVisible()) return;
				if (!wanted.includes(pid) || !due(pid, clock())) continue;
				askedAt.set(pid, clock());
				// One at a time: a round over many expanded projects is a
				// trickle on `projectIp` (120/min), not a burst.
				await loader(pid).catch(() => {});
				// A read that failed leaves no answer: the rows say so now.
				if (myGen === gen && !answers.has(pid)) onChange?.();
			}
		} while (again && myGen === gen);
	} finally {
		running = false;
	}
}

/** Read what is due, if the page can be seen. Safe to call at any rate. */
function kick(): void {
	if (loader === null || wanted.length === 0 || !pageVisible()) return;
	const now = clock();
	if (!wanted.some((pid) => due(pid, now))) return;
	void round();
}

/**
 * The tree's expanded projects that have a row to show a state on, on every
 * render. `onScreen`: the sidebar itself can be seen (false behind a closed
 * phone drawer — nothing is asked then).
 */
export function watchSidebarPresence(projectIds: readonly string[], onScreen: boolean): void {
	wanted = onScreen ? [...new Set(projectIds)] : [];
	kick();
}

/**
 * An agents list arrived (the page's own poll or this module's round):
 * `receivedAt` on the browser's clock, as the page records it.
 */
export function noteProjectAgents(
	projectId: string,
	data: AgentsResponse,
	receivedAt: number,
): void {
	const signature = signatureOf(data);
	const prev = answers.get(projectId);
	answers.set(projectId, { data, receivedAt, signature });
	// Also when a too-old answer is replaced by an identical one: the rows
	// were showing "unknown" for its age.
	const wasShown = prev !== undefined && clock() - prev.receivedAt < ANSWER_MAX_AGE_MS;
	if (wanted.includes(projectId) && (!wasShown || prev.signature !== signature)) onChange?.();
}

/**
 * Claude's state for the row of `sessionId`, bound to `agentId` of
 * `projectId`. null = nothing to say yet (the project was never asked: it
 * is collapsed, or its first read is on its way). Never a live state on
 * evidence that can't carry it.
 */
export function sidebarPresenceOf(
	projectId: string,
	agentId: string,
	sessionId: string,
	now: number = clock(),
): PresenceView | null {
	const entry = answers.get(projectId);
	if (!entry) {
		if (!askedAt.has(projectId) || running) return null;
		return {
			label: "State unknown",
			tone: "unknown",
			reason: "the project's agents could not be read",
			evidence: "no evidence",
		};
	}
	const age = now - entry.receivedAt;
	if (!(age >= 0) || age >= ANSWER_MAX_AGE_MS) {
		return {
			label: "State unknown",
			tone: "unknown",
			reason: "not refreshed for over a minute",
			evidence: "no recent answer",
		};
	}
	const agent = entry.data.agents.find((a) => a.agentId === agentId);
	// The list and the session row disagree on the binding (one of the two
	// reads is older than a re-bind): this agent's state is not this row's.
	if (!agent || agent.binding?.sessionId !== sessionId) {
		return {
			label: "State unknown",
			tone: "unknown",
			reason: "the agent's binding is being re-read",
			evidence: "no evidence",
		};
	}
	return presentPresence(
		agent.presence,
		{ generatedAt: entry.data.generatedAt, receivedAt: entry.receivedAt },
		now,
	);
}

/** projectsView: the loader (its single-flight agents read) and the re-render to ask for. */
export function startSidebarPresence(
	load: (projectId: string) => Promise<void>,
	changed: () => void,
): void {
	loader = load;
	onChange = changed;
	kick();
}

/** The tab came back: what went stale while it was hidden is re-read now. */
export function sidebarPresenceVisible(): void {
	kick();
}

/** Logout / expiry: nothing of this account stays in memory, nothing more is asked. */
export function clearSidebarPresence(): void {
	gen++;
	answers = new Map();
	askedAt = new Map();
	wanted = [];
	loader = null;
	onChange = null;
	again = false;
}

/** Tests only: the clock and the visibility this module reads. */
export function __setSidebarPresenceEnv(env: {
	now?: () => number;
	visible?: () => boolean;
}): void {
	if (env.now) clock = env.now;
	if (env.visible) pageVisible = env.visible;
}
