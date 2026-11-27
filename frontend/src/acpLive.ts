// acpLive.ts — the one `/ws/acp` socket of this tab, shared by the ACP chats.
// Open while at least one chat listens; reconnects with backoff. Every
// (re)connect is announced as `{type: "open"}` so a listener reloads its page
// over REST: the socket carries only what happens AFTER it opened, and
// nothing is replayed. While it is down, listeners fall back to a slow poll.
// A new listener gets one first signal: `open` (`initial` when the socket was
// already up), or `down` during an outage, or — while the first connection is
// on its way — nothing until its hello, for up to FIRST_LOAD_WAIT_MS since the
// connection started. That
// signal is the listener's first load: a load made before the hello could miss
// what happens until it. Past the wait it gets `slow` and loads over REST at
// once; the hello that follows is an `open` like any other and reads again.

import type { AcpActivity, AcpConversation, AcpMessage, AcpQuestion } from "./api.js";
import { openAcpSocket } from "./api.js";

export type AcpLiveEvent =
	/**
	 * `initial`: the socket was already up when the listener subscribed —
	 * nothing it could miss happened between its subscription and this
	 * (a load it makes now is complete). Without it, a hello: a first
	 * connection or a reconnect, after which everything is read again.
	 */
	| { type: "open"; initial?: true }
	| { type: "down" }
	/**
	 * The first connection has not said hello FIRST_LOAD_WAIT_MS after it
	 * started: load now (its `open` will follow and read again).
	 */
	| { type: "slow" }
	| { type: "message"; message: AcpMessage }
	| { type: "question"; question: AcpQuestion }
	| { type: "activity"; agent: string; events: AcpActivity[] }
	| { type: "agents" }
	| { type: "conversation"; conversation: AcpConversation };

type Listener = (ev: AcpLiveEvent) => void;

// Waiting for the hello saves one REST read per listener when the socket opens
// fast; on a phone whose WebSocket over the Tunnel is slow or never opens
// (no hello, no close), waiting longer would leave the screen empty until the
// fallback poll. A slow connection pays the double read instead.
const FIRST_LOAD_WAIT_MS = 1_000;

const listeners = new Set<Listener>();
let sock: WebSocket | null = null;
let up = false;
/** "down" was announced for the current outage (once per outage, also before the first hello). */
let downSaid = false;
/** When the connection on its way started (`Date.now()`). */
let connectingSince = 0;
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
	connectingSince = Date.now();
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
	if (up) queueMicrotask(() => listeners.has(fn) && fn({ type: "open", initial: true }));
	// A listener joining during an outage polls too.
	else if (downSaid) queueMicrotask(() => listeners.has(fn) && fn({ type: "down" }));
	// Connecting: the hello (or a close) is its first signal, unless it takes
	// too long — counted from the connection's start, so a listener joining a
	// connection already on its way waits only for what is left.
	const slowTimer =
		up || downSaid
			? null
			: setTimeout(
					() => {
						if (listeners.has(fn) && !up && !downSaid) fn({ type: "slow" });
					},
					Math.max(0, connectingSince + FIRST_LOAD_WAIT_MS - Date.now()),
				);
	return () => {
		if (slowTimer) clearTimeout(slowTimer);
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
