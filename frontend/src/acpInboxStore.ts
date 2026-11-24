// acpInboxStore.ts — Pendientes' data (GET /api/acp/inbox, every project):
// one copy for the tab, read on start, re-read (debounced) on every /ws/acp
// frame that can change it — a row written, a question — and polled slowly
// while the socket is down. The rail's attention row, the header's counter
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
	unsubscribe = subscribeAcp((ev) => {
		if (ev.type === "open") refreshInbox(0);
		else if (ev.type === "message" || ev.type === "question") refreshInbox();
	});
	poll = setInterval(() => {
		if (!document.hidden && !acpLiveUp()) refreshInbox(0);
	}, POLL_MS);
	refreshInbox(0);
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
	timer = setTimeout(() => {
		timer = null;
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
