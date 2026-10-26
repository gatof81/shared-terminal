// ──────────────────────────────────────────────────────────────────────────────
// Hook-sequence comparator for conversation-smoke.sh phase 11 (3.0d): does a
// run of the real CLI with the control dir mounted emit the same hooks, in
// the same order, as the run without it?
//
//   - counts: every event type must appear as often as in the baseline,
//     except MessageDisplay, whose number of batches depends on stream timing
//     — it only has to be present iff the baseline has it;
//   - order: the sequence without MessageDisplay and without SessionStart must
//     be identical. SessionStart comes from the `async: true` command hook
//     (session-start.sh), so its position relative to the CLI's own http
//     hooks is not stable; its count still is (above).
//
// The caller snapshots the events BEFORE killing tmux, so the interactive
// session's SessionEnd (which races the kill) never enters the comparison.
//
// CLI: node hook-compare.mjs <baseline.jsonl> <run.jsonl>
//   prints {"ok":true} or {"ok":false,"reason":…}; exit 0 / 1.
// ──────────────────────────────────────────────────────────────────────────────
import { readFileSync } from "node:fs";

const BATCHED = "MessageDisplay";
const ASYNC = "SessionStart";

function counts(events) {
	const c = {};
	for (const e of events) c[e] = (c[e] ?? 0) + 1;
	return c;
}

/** @param {string[]} base @param {string[]} run */
export function compareHooks(base, run) {
	const cb = counts(base);
	const cr = counts(run);
	for (const type of new Set([...Object.keys(cb), ...Object.keys(cr)])) {
		if (type === BATCHED) {
			if (Boolean(cb[type]) !== Boolean(cr[type])) {
				return { ok: false, reason: `${type} ${cr[type] ? "unexpected" : "missing"}` };
			}
			continue;
		}
		if ((cb[type] ?? 0) !== (cr[type] ?? 0)) {
			return { ok: false, reason: `${type}: ${cr[type] ?? 0} instead of ${cb[type] ?? 0}` };
		}
	}
	const ordered = (xs) => xs.filter((e) => e !== BATCHED && e !== ASYNC);
	const ob = ordered(base);
	const or = ordered(run);
	for (let i = 0; i < ob.length; i++) {
		if (ob[i] !== or[i]) {
			return { ok: false, reason: `order differs at #${i}: ${or[i]} instead of ${ob[i]}` };
		}
	}
	return { ok: true };
}

function readEvents(file) {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l).event);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	const [base, run] = process.argv.slice(2);
	const r = compareHooks(readEvents(base), readEvents(run));
	process.stdout.write(`${JSON.stringify(r)}\n`);
	process.exit(r.ok ? 0 : 1);
}
