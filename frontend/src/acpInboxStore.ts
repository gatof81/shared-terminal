// acpInboxStore.ts — Pendientes' data (GET /api/acp/inbox, every project):
// one copy for the tab, read by the socket's first signal (acpLive.ts: its
// hello, or `down`), re-read (debounced) on every /ws/acp frame that can
// change it — a row written, a question — and polled slowly while the socket
// is down. Hidden, a re-read is only noted: one read when the tab shows. The rail's attention row, the header's counter
// and the inbox panel all read it here, so they never disagree.

import { acpLiveUp, subscribeAcp } from "./acpLive.js";
import { type AcpInbox, acpInbox } from "./api.js";

const DEBOUNCE_MS = 500;
const POLL_MS = 15_000;

let inbox: AcpInbox | null = null;
let gen = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let poll: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;
let loadedSinceSub = false;
/** A read fell due while the tab was hidden. */
let dueOnShow = false;
const listeners = new Set<() => void>();

export function inboxNow(): AcpInbox | null {
	return inbox;
}

/** Told after every read that answered. Returns the unsubscribe. */
export function onInbox(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/** The account is shown: read now and follow. */
export function startInbox(): void {
	if (unsubscribe) return;
	loadedSinceSub = false;
	unsubscribe = subscribeAcp((ev) => {
		if (ev.type === "open") refreshInbox(0);
		// Started during an outage (or the first connection failed): its first read.
		else if (ev.type === "down") {
			if (!loadedSinceSub) refreshInbox(0);
		}
		// A read mark arrives as a `conversation` frame: an answer just seen
		// leaves «Resultados sin ver» (and the rail's count) without waiting for a row.
		else if (ev.type === "message" || ev.type === "question" || ev.type === "conversation")
			refreshInbox();
	});
	poll = setInterval(() => {
		if (!document.hidden && !acpLiveUp()) refreshInbox(0);
	}, POLL_MS);
}

/** Logout: nothing of this account stays. */
export function resetInbox(): void {
	gen++;
	unsubscribe?.();
	unsubscribe = null;
	if (poll) clearInterval(poll);
	poll = null;
	if (timer) clearTimeout(timer);
	timer = null;
	dueOnShow = false;
	inbox = null;
	for (const l of listeners) l();
}

/** Read the inbox again (soon: several frames in a row make one read). */
export function refreshInbox(delay = DEBOUNCE_MS): void {
	if (timer) {
		if (delay > 0) return;
		clearTimeout(timer);
	}
	const g = gen;
	loadedSinceSub = true;
	timer = setTimeout(() => {
		timer = null;
		if (g !== gen) return;
		// Nothing on screen to keep current (the push notifications are the
		// server's, sw.js): one read when the tab shows.
		if (document.hidden) {
			dueOnShow = true;
			return;
		}
		void Promise.resolve()
			.then(() => acpInbox())
			.then((box) => {
				if (g !== gen) return;
				inbox = box;
				for (const l of listeners) l();
			})
			.catch(() => {
				/* keep what was read; the next frame or poll tries again */
			});
	}, delay);
}

if (typeof document !== "undefined")
	document.addEventListener("visibilitychange", () => {
		if (document.hidden || !dueOnShow) return;
		dueOnShow = false;
		if (unsubscribe) refreshInbox(0);
	});
