/**
 * portMappings.ts — runtime container_port → host_port table for #190.
 *
 * The dispatcher (190c) parses an inbound `Host: p<container>-<sessionId>.<base>`
 * header and looks the host port up here to decide where to reverse-proxy.
 * Distinct from the *declarative* `session_configs.ports_json` (the user's
 * configured list of ports to expose) — this table holds what Docker
 * actually bound on the host after `container.start()` resolved the
 * `-p 0:<container>` request to a concrete kernel-assigned ephemeral port.
 *
 * Lifecycle:
 *   - Written by `DockerManager.spawn()` after `container.start()` (and
 *     by `reconcile()` on backend restart — the running container's
 *     bindings are still live; we just re-discover them).
 *   - Cleared by `DockerManager.kill()` and `stopContainer()` so a
 *     stopped/dead session doesn't leave the dispatcher pointing at
 *     a host port the kernel is about to recycle.
 *   - The FK ON DELETE CASCADE in `db.ts` cleans up automatically when
 *     a hard-delete drops the session row.
 */

import { d1Query } from "./db.js";

export interface PortMapping {
	containerPort: number;
	hostPort: number;
}

/**
 * Replace all mappings for `sessionId` with `mappings`. D1 has no
 * multi-statement transaction primitive on the HTTP API, so this
 * sequences DELETE then per-row INSERT — emphatically NOT atomic. A
 * backend crash mid-sequence can leave the table empty (DELETE
 * succeeded, INSERTs didn't); the next spawn / reconcile rewrites it
 * cleanly, and the dispatcher's "session must be running" gate stops
 * a torn read from proxying to a stale host port in the meantime.
 */
export async function setPortMappings(sessionId: string, mappings: PortMapping[]): Promise<void> {
	await d1Query("DELETE FROM sessions_port_mappings WHERE session_id = ?", [sessionId]);
	for (const m of mappings) {
		await d1Query(
			"INSERT INTO sessions_port_mappings (session_id, container_port, host_port) VALUES (?, ?, ?)",
			[sessionId, m.containerPort, m.hostPort],
		);
	}
}

/** Read all mappings for `sessionId`. Empty array when no row exists. */
export async function getPortMappings(sessionId: string): Promise<PortMapping[]> {
	const result = await d1Query<{ container_port: number; host_port: number }>(
		"SELECT container_port, host_port FROM sessions_port_mappings WHERE session_id = ? ORDER BY container_port",
		[sessionId],
	);
	return result.results.map((r) => ({ containerPort: r.container_port, hostPort: r.host_port }));
}

/** Drop all mappings for `sessionId`. Idempotent — no-op if none exist. */
export async function clearPortMappings(sessionId: string): Promise<void> {
	await d1Query("DELETE FROM sessions_port_mappings WHERE session_id = ?", [sessionId]);
}

/**
 * Parse Docker's `NetworkSettings.Ports` shape (as returned by
 * `container.inspect()`) into the PortMapping[] this module persists.
 *
 * Docker shape (only the bits we care about):
 *
 *     {
 *       "3000/tcp": [{ "HostIp": "0.0.0.0", "HostPort": "32768" }, ...],
 *       "5500/tcp": null   // exposed but not bound (--publish-all=false)
 *     }
 *
 * We take the FIRST non-null binding per container port — Docker can list
 * multiple host bindings (IPv4 + IPv6 entries are common), and they
 * always share the same kernel-assigned port number, so taking [0] is
 * sufficient. `null` and empty arrays are filtered out (those container
 * ports are exposed but unpublished, which would only happen if a
 * future code path sets `ExposedPorts` without `PortBindings` — not the
 * spawn path here, but the parser stays robust against it).
 *
 * The container-port half is `"<num>/<proto>"`; we only emit the int.
 * v1 publishes TCP only (the dispatcher in 190c is HTTP/WS); a future
 * UDP feature would extend this parser, not break it.
 *
 * Exported for the test suite.
 */
export function parseInspectPorts(
	ports: Record<string, Array<{ HostPort: string; HostIp?: string }> | null> | undefined | null,
): PortMapping[] {
	if (!ports) return [];
	const out: PortMapping[] = [];
	for (const [key, bindings] of Object.entries(ports)) {
		if (!bindings || bindings.length === 0) continue;
		// Match `<port>` or `<port>/<proto>`. The proto half is informational
		// only at this stage; we assume tcp.
		const m = key.match(/^(\d+)(?:\/[a-z]+)?$/);
		if (!m) continue;
		const containerPort = Number(m[1]);
		const hostPort = Number(bindings[0]!.HostPort);
		// Defensive against a malformed inspect response: Docker's
		// HostPort is always a stringified positive int, but a future
		// API change shouldn't crash the spawn path.
		if (
			!Number.isInteger(containerPort) ||
			containerPort <= 0 ||
			!Number.isInteger(hostPort) ||
			hostPort <= 0
		) {
			continue;
		}
		out.push({ containerPort, hostPort });
	}
	return out;
}
