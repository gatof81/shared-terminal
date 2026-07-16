/**
 * portReadiness.ts — advisory per-port HTTP readiness probes (#198).
 *
 * After every blocking bootstrap stage has succeeded, ports declared
 * with a `readiness: { path, timeoutSec }` block are polled with
 * `GET http://<containerName>:<containerPort><path>` over the shared
 * sessions network (the same Docker-embedded-DNS route the port
 * dispatcher uses — the issue predates the #190 direct-proxy switch
 * and talked about host ports; those no longer exist). Any 2xx counts
 * as ready; everything else — non-2xx, connection refused, DNS not
 * yet resolvable, per-request timeout — keeps polling until the
 * port's own `timeoutSec` budget runs out.
 *
 * ADVISORY BY CONTRACT: this module never throws and a probe timeout
 * never fails the session. The value is the streamed `[readiness]`
 * lines in the create modal ("your dev server is actually up"), not a
 * gate — a user whose postStart daemon takes longer than the budget
 * gets a WARN line and a working session, not a failed one.
 */

import { logger } from "../logger.js";
import type { PortEntry } from "../sessionConfig.js";

/** Poll cadence. Overridable via `pollIntervalMs` so the unit tests
 *  don't spend wall-clock seconds waiting between fake fetches. */
export const READINESS_POLL_INTERVAL_MS = 1000;
/** Per-request cap. A container that accepts the TCP connection but
 *  never answers (listening socket, wedged app) would otherwise pin
 *  the probe for the whole `timeoutSec` budget on one request. */
export const READINESS_REQUEST_TIMEOUT_MS = 2000;

interface RunPortReadinessProbesArgs {
	containerName: string;
	ports: PortEntry[];
	onOutput: (chunk: string) => void;
	signal: AbortSignal;
	/** Test seam — production callers use global fetch (Node 22). */
	fetchImpl?: typeof fetch;
	pollIntervalMs?: number;
}

/**
 * Probe every readiness-annotated port in `ports`, in parallel.
 * Ports without a `readiness` block are ignored; if none carry one,
 * this resolves immediately. Never rejects — per-port outcomes
 * (ready / budget exhausted / outer abort) are reported only through
 * `onOutput` lines, and anything unexpected is swallowed with a
 * logger.warn so a probe bug can never fail an otherwise-successful
 * bootstrap.
 */
export async function runPortReadinessProbes(args: RunPortReadinessProbesArgs): Promise<void> {
	const withReadiness = args.ports.filter((p) => p.readiness !== undefined);
	if (withReadiness.length === 0) return;
	// Parallel on purpose: budgets are per-port wall-clock promises to
	// the user ("up to 30s"), and a sequential walk would stack them —
	// three 60 s budgets against a dead container would take 3 minutes
	// instead of 1.
	await Promise.all(
		withReadiness.map(async (port) => {
			try {
				await probePort(port, args);
			} catch (err) {
				// probePort catches per-request errors itself; this is the
				// never-throws backstop for anything unexpected (a hostile
				// fetchImpl, a throwing onOutput).
				logger.warn(
					`[portReadiness] probe for port ${port.container} threw unexpectedly: ${(err as Error).message}`,
				);
			}
		}),
	);
}

async function probePort(port: PortEntry, args: RunPortReadinessProbesArgs): Promise<void> {
	// Non-null by the caller's filter; destructure once so the loop
	// body reads cleanly.
	const { path, timeoutSec } = port.readiness!;
	const fetchImpl = args.fetchImpl ?? fetch;
	const pollIntervalMs = args.pollIntervalMs ?? READINESS_POLL_INTERVAL_MS;
	const startedAt = Date.now();
	const deadline = startedAt + timeoutSec * 1000;
	const url = `http://${args.containerName}:${port.container}${path}`;
	args.onOutput(
		`[readiness] waiting on port ${port.container} (GET ${path}, up to ${timeoutSec}s)…\n`,
	);
	for (;;) {
		if (args.signal.aborted) {
			args.onOutput(
				`[readiness] aborted while waiting on port ${port.container} — continuing (readiness is advisory)\n`,
			);
			return;
		}
		try {
			// The request rides BOTH the outer signal (shutdown drain must
			// not be held open by an in-flight probe) and a fresh per-
			// request timeout. `redirect: "manual"`: a 3xx from the app is
			// "answering but not ready at this path" — following it would
			// probe a URL the user didn't declare, and could step outside
			// the container from the backend's network position.
			const res = await fetchImpl(url, {
				signal: AbortSignal.any([args.signal, AbortSignal.timeout(READINESS_REQUEST_TIMEOUT_MS)]),
				redirect: "manual",
			});
			// Discard the body so undici returns the socket to its pool —
			// without this every 1 s poll against a body-bearing endpoint
			// leaks a connection until GC. `catch` because a body already
			// disturbed (or a bodiless test stub) must not kill the loop.
			await res.body?.cancel().catch(() => undefined);
			if (res.status >= 200 && res.status < 300) {
				args.onOutput(
					`[readiness] port ${port.container} ready after ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`,
				);
				return;
			}
		} catch {
			// Connection refused / DNS miss / per-request timeout / outer
			// abort — all the same disposition: not ready yet. The outer
			// abort is picked up by the loop-top check on the next pass.
		}
		if (Date.now() >= deadline) {
			// Actual elapsed, not the stated budget: the deadline check
			// fires after a request completes, so a slow target can
			// overshoot timeoutSec by up to the per-request cap — mirror
			// the success line's accounting.
			args.onOutput(
				`[readiness] WARN: port ${port.container} not ready after ${((Date.now() - startedAt) / 1000).toFixed(1)}s — continuing (readiness is advisory)\n`,
			);
			return;
		}
		await new Promise((r) => setTimeout(r, pollIntervalMs));
	}
}
