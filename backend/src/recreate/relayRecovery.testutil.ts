/**
 * How the audit smoke measures a relay's recovery after `kill -9`
 * (recreateAudit.smoke.ts S4; the shell twin is `recover_within` in
 * session-image/conversation-smoke.sh). Shared here so the measurement
 * itself has a deterministic regression (relayRecovery.test.ts).
 *
 * The limit is about what an operator observes, so everything between the
 * kill and the evidence counts: the clock starts as the kill is issued
 * (before it, so the kill's own duration counts), the deadline is absolute
 * on a monotonic clock, and every probe's duration and every wait between
 * probes is inside it. Evidence that arrives after the deadline does not
 * count, even from a probe that started before it.
 */

export interface RecoveryProbe {
	identified: boolean;
	/** ms after the kill was issued. */
	startMs: number;
	endMs: number;
}

export interface RecoveryResult {
	/** The first probe's answer (detection needs `false`); null if none ran. */
	firstProbeIdentified: boolean | null;
	/** ms from the kill to the end of the identifying probe; null if none identified. */
	recoveredAfterMs: number | null;
	withinLimit: boolean;
	probes: RecoveryProbe[];
}

export async function measureRelayRecovery(o: {
	kill: () => Promise<void>;
	probe: () => Promise<boolean>;
	limitMs: number;
	pollMs: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}): Promise<RecoveryResult> {
	const now = o.now ?? (() => performance.now());
	const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const t0 = now();
	const deadline = t0 + o.limitMs;
	await o.kill();
	const probes: RecoveryProbe[] = [];
	const first = () => (probes.length > 0 ? probes[0].identified : null);
	while (now() <= deadline) {
		const start = now();
		const identified = await o.probe();
		const end = now();
		probes.push({ identified, startMs: start - t0, endMs: end - t0 });
		if (identified) {
			return {
				firstProbeIdentified: first(),
				recoveredAfterMs: end - t0,
				withinLimit: end <= deadline,
				probes,
			};
		}
		const left = deadline - now();
		if (left <= 0) break;
		await sleep(Math.min(o.pollMs, left));
	}
	return { firstProbeIdentified: first(), recoveredAfterMs: null, withinLimit: false, probes };
}
