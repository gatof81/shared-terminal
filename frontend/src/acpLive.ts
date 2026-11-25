// acpLive.ts — the one `/ws/acp` socket of this tab, shared by the ACP chats.
// Open while at least one chat listens; reconnects with backoff. Every
// (re)connect is announced as `{type: "open"}` so a listener reloads its page
// over REST: the socket carries only what happens AFTER it opened, and
// nothing is replayed. While it is down, listeners fall back to a slow poll.

import type { AcpActivity, AcpConversation, AcpMessage, AcpQuestion } from "./api.js";
import { openAcpSocket } from "./api.js";

export type AcpLiveEvent =
	| { type: "open" }
	| { type: "down" }
	| { type: "message"; message: AcpMessage }
	| { type: "question"; question: AcpQuestion }
	| { type: "activity"; agent: string; events: AcpActivity[] }
	| { type: "agents" }
	| { type: "conversation"; conversation: AcpConversation };

type Listener = (ev: AcpLiveEvent) => void;

const listeners = new Set<Listener>();
let sock: WebSocket | null = null;
let up = false;
/** "down" was announced for the current outage (once per outage, also before the first hello). */
let downSaid = false;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function emit(ev: AcpLiveEvent): void {
	for (const fn of [...listeners]) {
		try {
			fn(ev);
		} catch (err) {
			console.error("[acp-live]", err);
		}
	}
}

function connect(): void {
	if (sock || listeners.size === 0) return;
	let s: WebSocket;
	try {
		s = openAcpSocket();
	} catch {
		announceDown();
		schedule();
		return;
	}
	sock = s;
	s.onmessage = (e) => {
		let ev: { type?: string } & Record<string, unknown>;
		try {
			ev = JSON.parse(String(e.data));
		} catch {
			return;
		}
		if (ev.type === "hello") {
			up = true;
			downSaid = false;
			retry = 0;
			emit({ type: "open" });
		} else if (
			ev.type === "message" ||
			ev.type === "question" ||
			ev.type === "activity" ||
			ev.type === "agents" ||
			ev.type === "conversation"
		)
			emit(ev as AcpLiveEvent);
	};
	s.onclose = () => {
		if (sock !== s) return;
		sock = null;
		up = false;
		// Also when it never opened: a first connection refused before its hello
		// must still start the listeners' REST poll until a socket works.
		announceDown();
		schedule();
	};
	s.onerror = () => s.close();
}

function announceDown(): void {
	if (downSaid) return;
	downSaid = true;
	emit({ type: "down" });
}

function schedule(): void {
	if (retryTimer || listeners.size === 0) return;
	const delay = Math.min(30_000, 1_000 * 2 ** retry++);
	retryTimer = setTimeout(() => {
		retryTimer = null;
		connect();
	}, delay);
}

/** True while the socket is open and delivering. */
export function acpLiveUp(): boolean {
	return up;
}

export function subscribeAcp(fn: Listener): () => void {
	listeners.add(fn);
	if (idleTimer) clearTimeout(idleTimer);
	idleTimer = null;
	connect();
	if (up) queueMicrotask(() => listeners.has(fn) && fn({ type: "open" }));
	// A listener joining during an outage polls too.
	else if (downSaid) queueMicrotask(() => listeners.has(fn) && fn({ type: "down" }));
	return () => {
		listeners.delete(fn);
		if (listeners.size === 0 && !idleTimer)
			// Closed a little later: switching between two chats keeps the socket.
			idleTimer = setTimeout(() => {
				idleTimer = null;
				if (listeners.size > 0) return;
				const s = sock;
				sock = null;
				up = false;
				s?.close();
			}, 5_000);
	};
}

// A tab coming back from the background (mobile) re-checks the socket at once.
if (typeof document !== "undefined")
	document.addEventListener("visibilitychange", () => {
		if (!document.hidden && listeners.size > 0 && !sock) {
			if (retryTimer) clearTimeout(retryTimer);
			retryTimer = null;
			retry = 0;
			connect();
		}
	});
