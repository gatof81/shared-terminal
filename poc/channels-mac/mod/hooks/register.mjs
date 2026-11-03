// XB-1 observational mod (loaded only with `claude --plugin-dir .poc0/mod`).
// The logic is in bind.mjs; this file wires the events and the one write call.
// `claude plugin validate` reads hooks and calls from the source, so each hook
// is a function literal at its `on` call and the write is spelled out in full.
//
// Records go to <test folder>/.poc0/out/mod/, OUTSIDE the plugin folder: a
// write inside it would make --plugin-dir reload the module mid-test.
import { createProbe } from "./bind.mjs";

export function register(on) {
	const inst = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
	const probe = createProbe({ inst, now: () => Date.now() });
	const file = (seq) => `.poc0/out/mod/${inst}-${String(seq).padStart(6, "0")}.json`;
	on("session.start", async ($, e, next) => probe.sessionStart(e, next, (seq, rec) => $.fs.write(file(seq), `${JSON.stringify(rec)}\n`)));
	on("prompt.submit", async ($, e, next) => probe.promptSubmit(e, next, (seq, rec) => $.fs.write(file(seq), `${JSON.stringify(rec)}\n`)));
	on("classic.UserPromptSubmit", async ($, e, next) => probe.classicUserPromptSubmit(e, next, (seq, rec) => $.fs.write(file(seq), `${JSON.stringify(rec)}\n`)));
	on("classic.Stop", async ($, e, next) => probe.classicStop(e, next, (seq, rec) => $.fs.write(file(seq), `${JSON.stringify(rec)}\n`)));
	on("session.append", { door: "prompt" }, async ($, e, next) => probe.sessionAppendPrompt(e, next, (seq, rec) => $.fs.write(file(seq), `${JSON.stringify(rec)}\n`)));
}
