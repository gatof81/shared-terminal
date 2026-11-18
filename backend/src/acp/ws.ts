/**
 * acp/ws.ts — `/ws/acp`, the live channel of the ACP chats (experimental,
 * ACP_AGENTS_ENABLED). One socket per browser tab, per owner: every message
 * row written (INSERT or state change, the trigger's replies included) and
 * every activity batch of the owner's agents is pushed as it happens. The
 * client loads a page over REST, then applies these rows by id; after a
 * reconnect it reloads the page — nothing here is replayed, so nothing here
 * has to be durable.
 *
 * Every write goes through AcpAgents in this process (the runners and `st`
 * call the REST API), so its in-process events are complete. Visibility is
 * the client's filter over the owner's own rows; a socket never receives
 * another owner's events.
 */

import { WebSocket } from "ws";
import { logger } from "../logger.js";
import type { AcpAgents, AcpEvent } from "./agents.js";

export const ACP_WS_PREFIX = "/ws/acp";
/** A browser that cannot keep up is closed (it reloads on reconnect) rather than buffered without bound. */
const MAX_BUFFERED = 4 * 1024 * 1024;

export class AcpWsHub {
	private readonly byOwner = new Map<string, Set<WebSocket>>();

	constructor(acp: AcpAgents) {
		acp.onEvent((owner, ev) => this.push(owner, ev));
	}

	serve(ws: WebSocket, ownerUserId: string): void {
		let set = this.byOwner.get(ownerUserId);
		if (!set) {
			set = new Set();
			this.byOwner.set(ownerUserId, set);
		}
		set.add(ws);
		ws.on("close", () => {
			set.delete(ws);
			if (set.size === 0) this.byOwner.delete(ownerUserId);
		});
		// Inbound frames carry nothing; reading them keeps the socket flowing.
		ws.on("message", () => {});
		ws.send(JSON.stringify({ type: "hello" }));
	}

	private push(ownerUserId: string, ev: AcpEvent): void {
		const set = this.byOwner.get(ownerUserId);
		if (!set) return;
		const frame = JSON.stringify(ev);
		for (const ws of set) {
			if (ws.readyState !== WebSocket.OPEN) continue;
			if (ws.bufferedAmount > MAX_BUFFERED) {
				logger.warn("[acp] live socket too slow; closing it (the client reloads)");
				ws.close(1013, "too slow");
				continue;
			}
			ws.send(frame);
		}
	}

	get connections(): number {
		let n = 0;
		for (const s of this.byOwner.values()) n += s.size;
		return n;
	}
}
