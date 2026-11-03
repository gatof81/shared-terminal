// PASS-B0 measurement mod (loaded only with `claude --plugin-dir /opt/passb0-kit/mod`).
// The logic is in probe.mjs; this file wires session.start and the three host calls.
// `claude plugin validate` reads hooks and calls from the source, so the hook is a
// function literal at its `on` call and every `$` call is spelled out in full.
import { createProbe } from "./probe.mjs";

export function register(on) {
	const inst = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
	const rand = () => `${Math.random().toString(16).slice(2, 10).padEnd(8, "0")}${Math.random().toString(16).slice(2, 10).padEnd(8, "0")}`;
	const probe = createProbe({ inst, now: () => Date.now(), rand });
	const file = (seq) => `.passb0/out/mod/${inst}-${String(seq).padStart(4, "0")}.json`;
	on("session.start", async ($, e, next) =>
		probe.sessionStart(e, next, {
			fetch: (url, init) => $.http.fetch(url, init),
			run: (argv, init) => $.process.run(argv, init),
			write: (seq, rec) => $.fs.write(file(seq), `${JSON.stringify(rec)}\n`),
		}),
	);
}
