// PASS-B1a managed probe (04-poc.md §1.14.14.4). Loaded only through managed settings from a
// read-only local marketplace. Each event it sees becomes one record: the event name, the
// instance and a sequence number. No text, no paths, no ids from the event.
// `claude plugin validate` reads hooks and calls from the source, so each hook is a function
// literal at its `on` call and every `$` call is spelled out in full.
const inst = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
let seq = 0;
// B1b H8: whether code in a mod can reach the call that would make the CLI dumpable again
// (prctl(PR_SET_DUMPABLE, 1) is open to the process itself). Only `typeof`; nothing is called.
const reach = () => ({ bun: typeof globalThis.Bun, set_dumpable: typeof globalThis.Bun?.ant?.setDumpable });
const rec = ($, kind, extra = {}) => {
	seq += 1;
	const n = String(seq).padStart(4, "0");
	return $.fs.write(`.passb1/out/probe/${inst}-${n}.json`, `${JSON.stringify({ probe: "st-b1-probe", inst, seq, kind, t: Date.now(), ...extra })}\n`);
};

export function register(on) {
	on("session.start", async ($, e, next) => {
		await rec($, "session.start", { reach: reach() });
		return next(e);
	});
	on("classic.SessionStart", async ($, e, next) => {
		await rec($, "classic.SessionStart");
		return next(e);
	});
	on("classic.SessionEnd", async ($, e, next) => {
		await rec($, "classic.SessionEnd");
		return next(e);
	});
}
