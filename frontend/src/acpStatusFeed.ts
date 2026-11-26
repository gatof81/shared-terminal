// acpStatusFeed.ts — keeps the agents registry (acpRegistry.ts) current
// without any topic open, for the sidebar. Each read of /api/acp/agents is
// three D1 queries, so the budget is:
//
// - The period: the registry is read when it is 30 s old — 15 s while a
//   project's rail or a thread is on screen (`watchAcpAgents`: runner
//   liveness and queue sizes are not pushed) — counting ANY read that
//   refreshed it, and only while the tab is visible. The rail and the
//   thread have no clock of their own: they read the list here
//   (`onAcpAgentsRead`) and ask for a read with `requestAcpAgentsRead`.
// - Live events patch the registry at once and, when the patch leaves it
//   right, cause no read: a message going `running` (the agent works on it)
//   or final (it no longer does), a question opening (it waits for you),
//   activity (runner liveness, login). The period confirms them.
// - A read (debounced 3 s: a burst costs one) follows only what a patch
//   cannot resolve: a question that is answered, withdrawn or orphaned (does
//   the agent still wait? another question of it may be open), an `agents`
//   frame (someone joined, left, changed model or login state), and a
//   (re)connect of the socket (events were missed). Such a request is met
//   only by a read that STARTED after the event — any reader's (the
//   registry's stale marks, acpRegistry.ts); a read already in flight when
//   it came, or one that failed, does not count: it is awaited or retried,
//   never dropped.
// - Tab hidden: nothing; what was due is read when it shows again.

import { subscribeAcp } from "./acpLive.js";
import { authFromActivity } from "./acpModel.js";
import {
	acpAgentsLoaded,
	acpAgentsReadAt,
	acpEntryByName,
	acpFreshThrough,
	acpReadTicket,
	markAcpStale,
	patchAcpAgent,
	setAcpAgents,
} from "./acpRegistry.js";
import { type AcpAgentInfo, acpListAgents, isLoggedIn } from "./api.js";

const PERIOD_MS = 30_000;
const WATCHED_PERIOD_MS = 15_000;
const DEBOUNCE_MS = 3_000;
const FINAL = new Set(["done", "failed", "uncertain"]);

let started = false;
/** The socket went down since the last open this feed saw: the next open covers an outage. */
let sawDown = false;
let unsubscribe: (() => void) | null = null;
let periodTimer: ReturnType<typeof setTimeout> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
/** A read was due while the tab was hidden: done when it shows. */
let dirty = false;
let inFlight: Promise<void> | null = null;
/** The registry ticket the read in flight was sent with (acpRegistry.ts). */
let inFlightTicket = 0;
/** When this module last asked (a failed read must not make the period retry at once). */
let lastAttempt = 0;
/** The list as last read here, whole (the registry keeps only its fields). */
let lastList: AcpAgentInfo[] | null = null;
const readListeners = new Set<(list: AcpAgentInfo[]) => void>();
/** Rails and threads on screen (`watchAcpAgents`). */
let watchers = 0;

function period(): number {
	return watchers > 0 ? WATCHED_PERIOD_MS : PERIOD_MS;
}

/** A read of the list is on its way. */
export function acpAgentsReading(): boolean {
	return inFlight !== null;
}

/** The list as last read through readAcpAgents (null: not yet). */
export function acpAgentsList(): AcpAgentInfo[] | null {
	return lastList;
}

/** Told after every read here that answered, in the order the reads were sent. */
export function onAcpAgentsRead(fn: (list: AcpAgentInfo[]) => void): () => void {
	readListeners.add(fn);
	return () => readListeners.delete(fn);
}

/** A rail or thread is on screen: the period is 15 s until it is released. */
export function watchAcpAgents(): () => void {
	watchers++;
	startAcpStatusFeed();
	armPeriod();
	let released = false;
	return () => {
		if (released) return;
		released = true;
		watchers--;
	};
}

/**
 * The one read of the agents list (shared by overlapping callers: the
 * project page, the first session-list load, this feed): it
 * writes the registry. While the list has never been read, a failure is
 * retried in the background (5 s, doubling, up to 60 s).
 */
export function readAcpAgents(): Promise<void> {
	if (inFlight) return inFlight;
	lastAttempt = Date.now();
	const ticket = acpReadTicket();
	inFlightTicket = ticket;
	// One read at a time: answers land in the order they were sent, so an
	// older list never lands over a newer one.
	inFlight = acpListAgents()
		.then(
			(list) => {
				setAcpAgents(list, ticket);
				lastList = list;
				for (const fn of [...readListeners]) {
					try {
						fn(list);
					} catch (err) {
						console.error("[acp-agents]", err);
					}
				}
			},
			() => retryLater(),
		)
		.finally(() => {
			inFlight = null;
		});
	return inFlight;
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryMs = 5_000;
function retryLater(): void {
	if (retryTimer || retryOnShow || acpAgentsLoaded()) return;
	retryTimer = setTimeout(() => {
		retryTimer = null;
		if (!isLoggedIn() || acpAgentsLoaded()) return;
		// A hidden tab reads nothing: one read when it shows again.
		if (document.hidden) retryOnShow = true;
		else void readAcpAgents();
	}, retryMs);
	retryMs = Math.min(60_000, retryMs * 2);
}
/** A retry fell due while the tab was hidden. */
let retryOnShow = false;

/** How long ago the registry was last refreshed by any reader (or last asked for, here). */
function age(): number {
	return Date.now() - Math.max(acpAgentsReadAt(), lastAttempt);
}

function readIfVisible(): void {
	if (!isLoggedIn()) {
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

/** Re-armed after every check: due when the registry turns 30 s old, whoever read it last. */
function armPeriod(): void {
	if (!started) return;
	if (periodTimer) clearTimeout(periodTimer);
	periodTimer = setTimeout(
		() => {
			periodTimer = null;
			if (age() >= period() && !document.hidden) {
				readIfVisible();
				// Re-armed from the read's own time once it lands.
				void (inFlight ?? Promise.resolve()).finally(armPeriod);
				return;
			}
			if (document.hidden) dirty = true;
			armPeriod();
		},
		Math.max(1_000, period() - age()),
	);
}

/** The stale mark the pending re-read must cover (0: none pending). */
let wanted = 0;
let staleRetryMs = DEBOUNCE_MS;
/** When (performance.now) the pending debounce fires. */
let staleDue = 0;

/**
 * Something happened that only a new read can show: a read that STARTS
 * after now follows within `ms` (sooner if another asker wants it sooner;
 * every ask until it starts shares it).
 */
export function requestAcpAgentsRead(ms = DEBOUNCE_MS): void {
	wanted = markAcpStale();
	armStale(ms);
}

function readSoon(): void {
	requestAcpAgentsRead(DEBOUNCE_MS);
}

function armStale(ms: number): void {
	const due = performance.now() + ms;
	if (debounceTimer) {
		if (due >= staleDue) return;
		clearTimeout(debounceTimer);
	}
	staleDue = due;
	debounceTimer = setTimeout(() => {
		debounceTimer = null;
		readStale();
	}, ms);
}

function readStale(): void {
	if (!started || wanted === 0) return;
	// A read that began after the event already answered (this feed's or a
	// chat's): it says what the event changed.
	if (acpFreshThrough() >= wanted) {
		wanted = 0;
		staleRetryMs = DEBOUNCE_MS;
		return;
	}
	// One in flight: begun after the event, it is the read wanted (judged
	// when it lands, a failure backs off); begun before, one more follows it.
	if (inFlight) {
		const covers = inFlightTicket >= wanted;
		void inFlight.finally(covers ? afterStaleRead : readStale);
		return;
	}
	if (!isLoggedIn()) {
		stopAcpStatusFeed();
		return;
	}
	if (document.hidden) {
		// Read when the tab shows (that read starts after the event).
		dirty = true;
		return;
	}
	void readAcpAgents().then(afterStaleRead);
}

function afterStaleRead(): void {
	if (wanted === 0 || acpFreshThrough() >= wanted) {
		wanted = 0;
		staleRetryMs = DEBOUNCE_MS;
		return;
	}
	if (!started) return;
	// It failed: tried again, backing off up to the period.
	staleRetryMs = Math.min(period(), staleRetryMs * 2);
	armStale(staleRetryMs);
}

/** Started by the sidebar once it lists sessions; idempotent. */
export function startAcpStatusFeed(): void {
	if (started || typeof document === "undefined") return;
	started = true;
	armPeriod();
	unsubscribe = subscribeAcp((ev) => {
		switch (ev.type) {
			case "open":
				// A reconnect: what happened while it was down is read once. A
				// first hello (or subscribed with the socket up) covers no outage:
				// the start's own read (and the period) say the rest.
				if (sawDown || !(acpAgentsLoaded() || inFlight)) readSoon();
				sawDown = false;
				return;
			case "down":
				sawDown = true;
				return;
			case "message": {
				// Patched only: the period confirms (and fills the queue count).
				const m = ev.message;
				// An agent with slots runs several at once: the list gains or loses this one only.
				const cur = acpEntryByName(m.to_id)?.running ?? [];
				if (m.state === "running" && !cur.includes(m.id))
					patchAcpAgent(m.to_id, { running: [...cur, m.id].sort((a, b) => a - b) });
				else if (FINAL.has(m.state) && cur.includes(m.id))
					patchAcpAgent(m.to_id, { running: cur.filter((id) => id !== m.id) });
				return;
			}
			case "question":
				if (ev.question.state === "open") patchAcpAgent(ev.question.agent, { waitingInput: true });
				// Closed: whether the agent still waits depends on its other questions.
				else readSoon();
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
	if (periodTimer) clearTimeout(periodTimer);
	periodTimer = null;
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = null;
	wanted = 0;
	staleRetryMs = DEBOUNCE_MS;
	dirty = false;
	sawDown = false;
	lastList = null;
}

if (typeof document !== "undefined")
	document.addEventListener("visibilitychange", () => {
		if (document.hidden) return;
		if (retryOnShow) {
			retryOnShow = false;
			if (isLoggedIn() && !acpAgentsLoaded()) void readAcpAgents();
		}
		if (!started) return;
		// A pending re-read (awaited or retried until met) covers a due period too.
		if (wanted !== 0 && acpFreshThrough() < wanted) {
			dirty = false;
			readStale();
		} else if (dirty || age() >= period()) readIfVisible();
		armPeriod();
	});
