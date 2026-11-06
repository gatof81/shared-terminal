/**
 * conversation/ingestOrigin.ts — network-origin check for the hook ingest
 * (docs/CONVERSATION.md §3.1.1, v1.8.6; flag INGEST_REQUIRE_SESSION_ORIGIN).
 *
 * Why it exists: `ST_INGEST_TOKEN` is a bearer secret in the environment of
 * every process of the session's container, and the ingest is mounted on
 * the main app, which the Tunnel exposes. A token printed by `env` or pasted
 * anywhere would otherwise work from the Internet or from any other
 * container on `sessions-net`. This binds each request to the container the
 * session has NOW: the TCP peer must be one of that container's addresses
 * on SESSIONS_NETWORK. The principal stays the session (its container) —
 * this is an authorization check, not a second factor.
 *
 * What makes the peer address trustworthy here: session containers run with
 * `CapDrop: ["ALL"]` + no-new-privileges (dockerManager.ts), so without
 * NET_RAW / NET_ADMIN they can neither forge a source address on the bridge
 * nor change their own.
 *
 * Load-bearing choices:
 *   - the expected addresses come from inspecting the session's CURRENT
 *     container_id BY ID (exists, Running, same Id) — never DNS, never an
 *     address cached without that id as its key;
 *   - only positive views are cached, keyed by (session, container_id), for
 *     ORIGIN_CACHE_TTL_MS; a negative answer is re-checked on the next
 *     request, so a container that just started is not locked out;
 *   - `invalidate` (called with the token-cache invalidation: teardown,
 *     purge, revocation, activation) bumps a per-session generation; an
 *     inspection that started under an older generation does not count
 *     (`identity_changed`) and caches nothing;
 *   - concurrent requests for the same (session, container_id, generation)
 *     share ONE inspection, which bounds the cost on the ingest path;
 *   - an inspection has a deadline (ORIGIN_INSPECT_TIMEOUT_MS): past it the
 *     answer is `inspect_timeout`, and the late answer, whenever it arrives,
 *     reaches no code that could accept or cache — it is simply dropped;
 *   - the deadline bounds the REQUEST, not Docker's call, so there is at most
 *     ONE unsettled Docker call per session: while a call that outlived its
 *     deadline is still pending, every new request for that session is
 *     refused at once (`inspect_pending`) instead of opening another one. A
 *     hung daemon therefore costs one pending call per session, however
 *     much traffic keeps arriving (observe mode included).
 * Anything that cannot be verified is a rejection. The caller keeps the
 * route's contract (always 204, empty body); causes go to counters only and
 * never carry an address.
 */

import { isIPv4, isIPv6 } from "node:net";
import { ORIGIN_CACHE_TTL_MS, ORIGIN_INSPECT_TIMEOUT_MS } from "./limits.js";

export type SessionNetworkView =
	| { exists: false }
	| {
			exists: true;
			/** Full container id as Docker reports it. */
			id: string;
			running: boolean;
			/** The container's addresses on SESSIONS_NETWORK (IPv4 and/or global IPv6). */
			addresses: string[];
	  };

export interface SessionNetworkPort {
	/** Throws on a daemon error; `{exists:false}` only for a 404. */
	inspectSessionNetwork(containerId: string): Promise<SessionNetworkView>;
}

export type OriginCause =
	| "no_remote"
	| "loopback"
	| "no_container"
	| "inspect_failed"
	| "inspect_timeout"
	| "inspect_pending"
	| "container_gone"
	| "not_running"
	| "container_replaced"
	| "no_address"
	| "identity_changed"
	| "mismatch";

export type OriginVerdict = { ok: true } | { ok: false; cause: OriginCause };

type Resolved = { ok: true; addresses: Set<string> } | { ok: false; cause: OriginCause };

const fail = (cause: OriginCause): { ok: false; cause: OriginCause } => ({ ok: false, cause });

/** 8 × 16-bit groups of a syntactically valid IPv6 literal (no zone), or null. */
function expandIPv6(literal: string): number[] | null {
	let body = literal;
	const lastColon = body.lastIndexOf(":");
	const tail = body.slice(lastColon + 1);
	if (tail.includes(".")) {
		// Embedded IPv4 (`::ffff:1.2.3.4`): rewrite it as two hex groups.
		if (!isIPv4(tail)) return null;
		const [a, b, c, d] = tail.split(".").map(Number);
		body = `${body.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const halves = body.split("::");
	if (halves.length > 2) return null;
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
	if (fill < 0 || (halves.length === 1 && left.length !== 8)) return null;
	const groups = [...left, ...Array<string>(fill).fill("0"), ...right].map((h) =>
		/^[0-9a-f]{1,4}$/.test(h) ? Number.parseInt(h, 16) : Number.NaN,
	);
	if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
	return groups;
}

/**
 * Canonical comparison form of a peer/container address, or null when it is
 * not an IP literal. IPv4 stays dotted; an IPv4-mapped IPv6 address
 * (`::ffff:a.b.c.d`, also written in hex) becomes that IPv4; any other IPv6
 * becomes its fully expanded lowercase form. A zone (`%eth0`) and brackets
 * are dropped.
 */
export function normalizeAddress(raw: string | null | undefined): string | null {
	if (typeof raw !== "string") return null;
	let a = raw.trim().toLowerCase();
	if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
	const zone = a.indexOf("%");
	if (zone >= 0) a = a.slice(0, zone);
	if (isIPv4(a)) return a;
	if (!isIPv6(a)) return null;
	const g = expandIPv6(a);
	if (!g) return null;
	if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
		return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
	}
	return g.map((x) => x.toString(16)).join(":");
}

/** A normalized address on the host's loopback (127.0.0.0/8 or ::1). */
export function isLoopback(normalized: string): boolean {
	return normalized.startsWith("127.") || normalized === "0:0:0:0:0:0:0:1";
}

interface CacheEntry {
	containerId: string;
	addresses: Set<string>;
	expiresAt: number;
}

export class IngestOriginVerifier {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly generation = new Map<string, number>();
	private readonly inflight = new Map<string, Promise<Resolved>>();
	/** Per session: a Docker call that has not settled yet (see the header). */
	private readonly unsettled = new Map<string, Promise<void>>();
	private readonly now: () => number;
	private readonly ttlMs: number;
	private readonly inspectTimeoutMs: number;

	constructor(
		private readonly port: SessionNetworkPort,
		opts: { now?: () => number; ttlMs?: number; inspectTimeoutMs?: number } = {},
	) {
		this.now = opts.now ?? Date.now;
		this.ttlMs = opts.ttlMs ?? ORIGIN_CACHE_TTL_MS;
		this.inspectTimeoutMs = opts.inspectTimeoutMs ?? ORIGIN_INSPECT_TIMEOUT_MS;
	}

	/** Forget everything about the session's identity (see the header). */
	invalidate(stSessionId: string): void {
		this.generation.set(stSessionId, this.genOf(stSessionId) + 1);
		this.cache.delete(stSessionId);
	}

	/**
	 * Is `remoteAddress` (the request's TCP peer, as the socket reports it)
	 * an address of `containerId` — the session's CURRENT container per D1 —
	 * on SESSIONS_NETWORK?
	 */
	async verify(
		stSessionId: string,
		containerId: string | null,
		remoteAddress: string | null | undefined,
	): Promise<OriginVerdict> {
		const remote = normalizeAddress(remoteAddress);
		if (!remote) return fail("no_remote");
		if (isLoopback(remote)) return fail("loopback");
		if (!containerId) return fail("no_container");
		const hit = this.cache.get(stSessionId);
		let addresses: Set<string>;
		if (hit && hit.containerId === containerId && hit.expiresAt > this.now()) {
			addresses = hit.addresses;
		} else {
			const r = await this.resolve(stSessionId, containerId);
			if (!r.ok) return r;
			addresses = r.addresses;
		}
		return addresses.has(remote) ? { ok: true } : fail("mismatch");
	}

	private genOf(stSessionId: string): number {
		return this.generation.get(stSessionId) ?? 0;
	}

	private resolve(stSessionId: string, containerId: string): Promise<Resolved> {
		const gen = this.genOf(stSessionId);
		const key = `${stSessionId}\u0000${containerId}\u0000${gen}`;
		let p = this.inflight.get(key);
		if (!p) {
			p = this.inspect(stSessionId, containerId, gen).finally(() => this.inflight.delete(key));
			this.inflight.set(key, p);
		}
		return p;
	}

	private async inspect(stSessionId: string, containerId: string, gen: number): Promise<Resolved> {
		// One unsettled Docker call per session: a previous call that outlived
		// its deadline is still pending ⇒ refuse now, never pile up another.
		if (this.unsettled.has(stSessionId)) return fail("inspect_pending");
		let view: SessionNetworkView;
		const call = this.port.inspectSessionNetwork(containerId);
		// Frees the slot when Docker finally answers (or fails); swallowing the
		// rejection here also keeps a late one from surfacing as unhandled.
		const settled: Promise<void> = call.then(
			() => this.release(stSessionId, settled),
			() => this.release(stSessionId, settled),
		);
		this.unsettled.set(stSessionId, settled);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), this.inspectTimeoutMs);
		});
		try {
			const first = await Promise.race([call, deadline]);
			// Past the deadline: refuse. `call` may still settle later; nothing
			// awaits it any more, so its answer can neither accept nor cache.
			if (first === "timeout") return fail("inspect_timeout");
			view = first;
		} catch {
			this.release(stSessionId, settled); // settled (rejected) within the deadline
			return fail("inspect_failed");
		} finally {
			clearTimeout(timer);
		}
		// Answered within the deadline: the call has settled, free the slot now
		// rather than one microtask later.
		this.release(stSessionId, settled);
		// The identity was invalidated while Docker answered: this view may
		// describe a container the session no longer has.
		if (this.genOf(stSessionId) !== gen) return fail("identity_changed");
		if (!view.exists) return fail("container_gone");
		if (!view.running) return fail("not_running");
		if (view.id !== containerId) return fail("container_replaced");
		const addresses = new Set<string>();
		for (const a of view.addresses) {
			const n = normalizeAddress(a);
			if (n && !isLoopback(n)) addresses.add(n);
		}
		if (addresses.size === 0) return fail("no_address");
		this.cache.set(stSessionId, { containerId, addresses, expiresAt: this.now() + this.ttlMs });
		return { ok: true, addresses };
	}

	private release(stSessionId: string, call: Promise<void>): void {
		if (this.unsettled.get(stSessionId) === call) this.unsettled.delete(stSessionId);
	}
}
