// acpStatusFeed.ts — keeps the agents registry (acpRegistry.ts) current
// without any chat open, for the sidebar. Budget (each read of
// /api/acp/agents is three D1 queries): a re-read every 30 s while the tab is
// visible; after a live event that changes an agent's state (a message, a
// question, the agents list), one more read, debounced to ≥ 3 s; none while
// the tab is hidden (a missed change is read when it shows again). Live
// events also patch the registry at once, so a row moves without waiting
// for the read that confirms it; activity batches (frequent while an agent
// works) only patch — they never cause a read.

import { subscribeAcp } from "./acpLive.js";
import { authFromActivity } from "./acpModel.js";
import { acpAgentsLoaded, acpEntryByName, patchAcpAgent, setAcpAgents } from "./acpRegistry.js";
import { acpAgentsEnabled, acpListAgents, isLoggedIn } from "./api.js";

const PERIOD_MS = 30_000;
const DEBOUNCE_MS = 3_000;
const FINAL = new Set(["done", "failed", "uncertain"]);

let started = false;
let unsubscribe: (() => void) | null = null;
let periodTimer: ReturnType<typeof setInterval> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
/** A read was due while the tab was hidden: done when it shows. */
let dirty = false;
let lastRead = 0;
let inFlight: Promise<void> | null = null;

/**
 * The one read of the agents list (shared by overlapping callers: the
 * landing of a selected session, the first session-list load, this feed): it
 * writes the registry. While the list has never been read, a failure is
 * retried in the background (5 s, doubling, up to 60 s).
 */
export function readAcpAgents(): Promise<void> {
	inFlight ??= acpListAgents()
		.then(setAcpAgents, () => retryLater())
		.finally(() => {
			lastRead = Date.now();
			inFlight = null;
		});
	return inFlight;
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryMs = 5_000;
function retryLater(): void {
	if (retryTimer || acpAgentsLoaded()) return;
	retryTimer = setTimeout(() => {
		retryTimer = null;
		if (isLoggedIn() && acpAgentsEnabled() && !acpAgentsLoaded()) void readAcpAgents();
	}, retryMs);
	retryMs = Math.min(60_000, retryMs * 2);
}

function readIfVisible(): void {
	if (!isLoggedIn() || !acpAgentsEnabled()) {
		stopAcpStatusFeed();
		return;
	}
	if (document.hidden) {
		dirty = true;
		return;
	}
	dirty = false;
	void readAcpAgents();
}

function readSoon(): void {
	if (debounceTimer) return;
	debounceTimer = setTimeout(() => {
		debounceTimer = null;
		readIfVisible();
	}, DEBOUNCE_MS);
}

/** Started by the sidebar once it lists sessions with the ACP feature on; idempotent. */
export function startAcpStatusFeed(): void {
	if (started || !acpAgentsEnabled() || typeof document === "undefined") return;
	started = true;
	periodTimer = setInterval(() => {
		if (!document.hidden) readIfVisible();
	}, PERIOD_MS);
	unsubscribe = subscribeAcp((ev) => {
		switch (ev.type) {
			case "open":
				// A (re)connect: what happened while it was down is read once.
				readSoon();
				return;
			case "message": {
				const m = ev.message;
				if (m.state === "running") patchAcpAgent(m.to_id, { running: m.id });
				// Finished: no longer working on it (the read tells what it took next).
				else if (FINAL.has(m.state) && acpEntryByName(m.to_id)?.running === m.id)
					patchAcpAgent(m.to_id, { running: null });
				readSoon();
				return;
			}
			case "question":
				if (ev.question.state === "open") patchAcpAgent(ev.question.agent, { waitingInput: true });
				readSoon();
				return;
			case "agents":
				readSoon();
				return;
			case "activity": {
				const last = ev.events.at(-1);
				const patch: { runnerSeenAt?: string; authRequired?: boolean } = {};
				if (last) patch.runnerSeenAt = last.at;
				patch.authRequired = authFromActivity(
					ev.events,
					acpEntryByName(ev.agent)?.authRequired === true,
				);
				patchAcpAgent(ev.agent, patch);
				return;
			}
		}
	});
}

export function stopAcpStatusFeed(): void {
	if (!started) return;
	started = false;
	unsubscribe?.();
	unsubscribe = null;
	if (periodTimer) clearInterval(periodTimer);
	periodTimer = null;
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = null;
	dirty = false;
}

if (typeof document !== "undefined")
	document.addEventListener("visibilitychange", () => {
		if (!started || document.hidden) return;
		if (dirty || Date.now() - lastRead >= PERIOD_MS) readIfVisible();
	});
