// PASS-B0 probe (04-poc.md §1.14.6). Pure: every host call comes in through `io`,
// so the tests drive it with fakes. Records hold facts only (labels, statuses,
// error classes, connection tokens, booleans), never a prompt or a header value.

export const KIT = "/opt/passb0-kit";
export const TARGETS = {
	c: { sock: "/tmp/passb0/c.sock", held: "/tmp/passb0/held-c.json" },
	h: { sock: "/run/st-attest/h.sock", held: "/run/st-attest/held-h.json" },
};
// Order matters: c1/h1/h2 are plain calls, h2 right after h1 shows whether the
// host reuses a connection; the two holds measure the descriptor while it is open.
export const PLAN = [
	{ label: "c1", target: "c", hold: false },
	{ label: "h1", target: "h", hold: false },
	{ label: "h2", target: "h", hold: false },
	{ label: "hold-c", target: "c", hold: true },
	{ label: "hold-h", target: "h", hold: true },
];

const HEX16 = /^[0-9a-f]{16}$/;
// errno names and the checker's own reasons ("stale", "not-json", "none").
const REASON = /^[A-Za-z-]{1,16}$/;
const reason = (v) => (typeof v === "string" && REASON.test(v) ? v : null);

// Error classes from the CLI's own refusal texts (2.1.314/2.1.317): only the class
// is kept, so a message never carries a path or a host into the record.
export function classify(err) {
	const m = String(err?.message ?? err ?? "");
	if (/no Unix socket transport/.test(m)) return "no-unix-transport";
	if (/Network access from plugins/.test(m)) return "network-policy";
	if (/nonessential network traffic is disabled/.test(m)) return "nonessential-disabled";
	if (/socketPath .* refused/.test(m)) return "socketpath-refused";
	if (/aborted: no complete answer/.test(m)) return "timeout";
	if (/refused/.test(m)) return "refused-other";
	if (/ENOENT|ECONNREFUSED|EACCES|failed/.test(m)) return "connect-failed";
	return "other";
}

function connOf(res) {
	try {
		const c = JSON.parse(res?.text ?? "").conn;
		return typeof c === "string" && HEX16.test(c) ? c : null;
	} catch {
		return null;
	}
}

function parseRun(r) {
	if (!r || typeof r.stdout !== "string") return { error: "no-output" };
	try {
		const o = JSON.parse(r.stdout);
		return o && typeof o === "object" && !Array.isArray(o) ? { exit: r.exitCode, ...o } : { error: "not-object" };
	} catch {
		return { exit: r.exitCode, error: "unparsable" };
	}
}

const py = (cmd, held, after) => ["/usr/bin/python3", "-I", `${KIT}/b0.py`, cmd, "--held", held, "--after-ms", String(after), "--wait-ms", "6000"];

export function createProbe({ inst, now, rand }) {
	let seq = 0;
	const emit = async (io, rec) => {
		seq += 1;
		try {
			await io.write(seq, { inst, seq, t: now(), ...rec });
		} catch {
			// A failed write leaves a seq gap; the analyzer reads it as incomplete.
		}
	};

	async function call(io, step) {
		const t = TARGETS[step.target];
		const nonce = rand();
		const init = {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ label: step.label, nonce }),
			socketPath: t.sock,
		};
		const rec = { kind: "call", label: step.label, target: step.target, nonce };
		const after = now();
		// The promise is settled into a value at once, so a rejection is never unhandled
		// while the child processes run.
		const pending = Promise.resolve()
			.then(() => io.fetch(`http://passb0${step.hold ? "/hold" : `/${step.label}`}`, init))
			.then((res) => ({ res }), (err) => ({ err }));
		if (step.hold) {
			// Fork only after the server holds the connection open: a child forked before
			// connect() could not inherit it, and would prove nothing.
			const w = await Promise.resolve()
				.then(() => io.run(py("waitheld", t.held, after), { timeoutMs: 15000 }))
				.then(parseRun, (err) => ({ error: classify(err) }));
			rec.waitheld = {
				waited: w.waited === true,
				conn: typeof w.held_conn === "string" && HEX16.test(w.held_conn) ? w.held_conn : null,
				// Why it did not synchronize: the run itself failed (`error`, an error class), or the
				// checker ran and never read a fresh held file (`held_last_error`, e.g. EACCES).
				error: typeof w.error === "string" ? w.error.slice(0, 40) : null,
				exit: Number.isInteger(w.exit) ? w.exit : null,
				held_last_error: reason(w.held_last_error),
				ms: now() - after,
			};
			if (w.waited === true) {
				const c = await Promise.resolve()
					.then(() => io.run(py("fdcheck", t.held, after), { timeoutMs: 15000 }))
					.then(parseRun, (err) => ({ error: classify(err) }));
				rec.child = pickChild(c);
			}
		}
		const { res, err } = await pending;
		if (err !== undefined) {
			rec.ok = false;
			rec.error = classify(err);
		} else {
			rec.ok = res?.ok === true;
			rec.status = typeof res?.status === "number" ? res.status : null;
			rec.conn = connOf(res);
		}
		return rec;
	}

	return {
		seqNow: () => seq,
		async sessionStart(e, next, io) {
			const out = await next(e);
			await emit(io, { kind: "session.start" });
			// Not awaited: measuring takes ~20 s and must not hold the session's start.
			void (async () => {
				for (const step of PLAN) {
					let rec;
					try {
						rec = await call(io, step);
					} catch (err) {
						rec = { kind: "call", label: step.label, target: step.target, ok: false, error: classify(err) };
					}
					await emit(io, rec);
				}
				await emit(io, { kind: "done", calls: PLAN.length });
			})();
			return out;
		},
	};
}

// Only the fields the analyzer reads, each type-checked: the child's stdout is data.
export function pickChild(c) {
	const int = (v) => (Number.isInteger(v) ? v : null);
	const out = {
		error: typeof c?.error === "string" ? c.error.slice(0, 40) : undefined,
		exit: int(c?.exit),
		self_pid: int(c?.self_pid),
		self_ppid: int(c?.self_ppid),
		waited: c?.waited === true,
		held_conn: typeof c?.held_conn === "string" && HEX16.test(c.held_conn) ? c.held_conn : null,
		held_last_error: reason(c?.held_last_error),
		peer_known: c?.peer_known === true,
		peer_in_self: typeof c?.peer_in_self === "boolean" ? c.peer_in_self : null,
		own_socket_count: int(c?.own_socket_count),
		scan_denied: int(c?.scan_denied),
		holders: Array.isArray(c?.holders)
			? c.holders.slice(0, 16).map((h) => ({ pid: int(h?.pid), fd: int(h?.fd), cloexec: typeof h?.cloexec === "boolean" ? h.cloexec : null }))
			: null,
	};
	if (out.error === undefined) delete out.error;
	return out;
}
