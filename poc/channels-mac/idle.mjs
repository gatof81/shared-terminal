// Observed-idle tracker for send.mjs. `--min-idle S` means S seconds of
// CONTINUOUS observation of the session at its prompt: a window opens at the
// first quiet observation and is valid only while every later observation is
// also quiet, no new hook line appears, and no two observations are further
// apart than maxGapMs (an unobserved gap is not idle time). A single quiet
// observation, or the age of the last hook line, never counts as idle time:
// the hooks file may be empty or missing.
export function createIdleTracker({ minIdleMs, maxGapMs = 10_000 }) {
	let start = null;
	let last = null;
	let n = 0;
	let lastHookCount = null;
	return {
		observe({ tMs, atPrompt, openTurn = false, hookCount = 0 }) {
			const quiet = atPrompt === true && !openTurn;
			const gapOk = last === null || tMs - last <= maxGapMs;
			const hookChanged = lastHookCount !== null && hookCount !== lastHookCount;
			if (!quiet) {
				start = null;
				n = 0;
			} else if (start === null || !gapOk || hookChanged) {
				start = tMs;
				n = 1;
			} else {
				n += 1;
			}
			last = tMs;
			lastHookCount = hookCount;
			const observedMs = start === null ? 0 : tMs - start;
			return { ready: start !== null && n >= 2 && observedMs >= minIdleMs, observedMs, observations: n };
		},
	};
}
