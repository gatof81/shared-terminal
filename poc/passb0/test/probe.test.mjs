// Synthetic tests of the PASS-B0 mod logic with fake host calls. Run: node --test test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, createProbe, PLAN, pickChild, TARGETS } from "../mod/hooks/probe.mjs";

const conn = (i) => i.toString(16).padStart(16, "0");

function fakeIo({ fetchImpl, runImpl, writeFails = false } = {}) {
	const log = [];
	const recs = [];
	let n = 0;
	const io = {
		fetch: async (url, init) => {
			log.push(["fetch", url, init.socketPath]);
			if (fetchImpl) return fetchImpl(url, init);
			n += 1;
			return { status: 200, ok: true, headers: {}, text: JSON.stringify({ conn: conn(n), scope: "x" }) };
		},
		run: async (argv, init) => {
			log.push(["run", argv[3], argv[5]]);
			if (runImpl) return runImpl(argv, init);
			if (argv[3] === "waitheld") return { exitCode: 0, stdout: JSON.stringify({ waited: true, held_conn: conn(n) }), stderr: "" };
			return {
				exitCode: 0,
				stdout: JSON.stringify({ self_pid: 9, self_ppid: 8, waited: true, held_conn: conn(n), peer_known: true, peer_in_self: false, own_socket_count: 0, scan_denied: 0, holders: [{ pid: 8, fd: 30, cloexec: true, extra: "x" }], environ: "SECRET=1" }),
				stderr: "",
			};
		},
		write: async (seq, rec) => {
			if (writeFails && seq === 2) throw new Error("disk");
			recs.push(rec);
		},
	};
	return { io, log, recs };
}

async function runProbe(opts) {
	const f = fakeIo(opts);
	let i = 0;
	const probe = createProbe({ inst: "abcd1234", now: () => 1000, rand: () => `${(i++).toString(16).padStart(16, "0")}` });
	const nexts = [];
	const out = await probe.sessionStart({ ev: 1 }, async (e) => {
		nexts.push(e);
		return { answered: true };
	}, f.io);
	// The measurement runs after the hook returned; wait for its last record.
	for (let k = 0; k < 200 && !f.recs.some((r) => r.kind === "done"); k++) await new Promise((r) => setTimeout(r, 1));
	return { ...f, out, nexts };
}

test("session.start: next once with the same event, its answer returned, measurement after", async () => {
	const { out, nexts, recs } = await runProbe();
	assert.deepEqual(nexts, [{ ev: 1 }]);
	assert.deepEqual(out, { answered: true });
	assert.deepEqual(recs.map((r) => r.kind), ["session.start", "call", "call", "call", "call", "call", "done"]);
	assert.deepEqual(recs.map((r) => r.seq), [1, 2, 3, 4, 5, 6, 7]);
	assert.ok(recs.every((r) => r.inst === "abcd1234"));
});

test("plan: targets, socket paths and hold order (fetch, then waitheld, then fdcheck)", async () => {
	const { log, recs } = await runProbe();
	assert.deepEqual(
		recs.filter((r) => r.kind === "call").map((r) => [r.label, r.target]),
		PLAN.map((p) => [p.label, p.target]),
	);
	const holdC = log.findIndex((l) => l[0] === "fetch" && l[1] === "http://passb0/hold" && l[2] === TARGETS.c.sock);
	assert.ok(holdC >= 0);
	assert.deepEqual(log.slice(holdC, holdC + 3).map((l) => l[0] === "run" ? l[1] : "fetch"), ["fetch", "waitheld", "fdcheck"]);
	assert.equal(log[holdC + 1][2], TARGETS.c.held);
	assert.equal(log.filter((l) => l[0] === "fetch" && l[2] === TARGETS.h.sock).length, 3);
});

test("records keep the server's conn and nonce, and only type-checked child fields", async () => {
	const { recs } = await runProbe();
	const c1 = recs.find((r) => r.label === "c1");
	assert.equal(c1.ok, true);
	assert.equal(c1.status, 200);
	assert.equal(c1.conn, conn(1));
	assert.match(c1.nonce, /^[0-9a-f]{16}$/);
	const h = recs.find((r) => r.label === "hold-c");
	assert.deepEqual(h.waitheld, { waited: true, conn: conn(4) });
	assert.deepEqual(h.child.holders, [{ pid: 8, fd: 30, cloexec: true }]);
	assert.equal(JSON.stringify(recs).includes("SECRET"), false);
	assert.equal(JSON.stringify(recs).includes("extra"), false);
});

test("a fetch rejection is recorded by class and never escapes", async () => {
	const { recs } = await runProbe({
		fetchImpl: async () => {
			throw new Error("st-passb0-probe: $.http.fetch: socketPath /x refused: no Unix socket transport in this build");
		},
	});
	const calls = recs.filter((r) => r.kind === "call");
	assert.equal(calls.length, 5);
	assert.ok(calls.every((r) => r.ok === false && r.error === "no-unix-transport"));
	assert.ok(recs.some((r) => r.kind === "done"));
});

test("hold: no fdcheck when waitheld did not see the connection", async () => {
	const { log, recs } = await runProbe({ runImpl: async () => ({ exitCode: 0, stdout: JSON.stringify({ waited: false }), stderr: "" }) });
	assert.equal(log.filter((l) => l[0] === "run" && l[1] === "fdcheck").length, 0);
	const h = recs.find((r) => r.label === "hold-h");
	assert.deepEqual(h.waitheld, { waited: false, conn: null });
	assert.equal(h.child, undefined);
});

test("hold: unparsable or failing child output is an error field, not a crash", async () => {
	let k = 0;
	const { recs } = await runProbe({
		runImpl: async (argv) => {
			if (argv[3] === "waitheld") return { exitCode: 0, stdout: JSON.stringify({ waited: true, held_conn: "0".repeat(16) }), stderr: "" };
			k += 1;
			if (k === 1) return { exitCode: 1, stdout: "Traceback", stderr: "" };
			throw new Error("spawn failed");
		},
	});
	assert.equal(recs.find((r) => r.label === "hold-c").child.error, "unparsable");
	assert.equal(recs.find((r) => r.label === "hold-h").child.error, "connect-failed");
});

test("a failed write leaves a seq gap and the rest goes on", async () => {
	const { recs } = await runProbe({ writeFails: true });
	assert.deepEqual(recs.map((r) => r.seq), [1, 3, 4, 5, 6, 7]);
});

test("a non-hex conn in the response is dropped", async () => {
	const { recs } = await runProbe({ fetchImpl: async () => ({ status: 200, ok: true, headers: {}, text: '{"conn":"../../x"}' }) });
	assert.ok(recs.filter((r) => r.kind === "call").every((r) => r.conn === null));
});

test("classify: the CLI's refusal texts map to classes without carrying the text", () => {
	assert.equal(classify(new Error("p: $.http.fetch: refused: Network access from plugins is disabled")), "network-policy");
	assert.equal(classify(new Error("p: $.http.fetch: refused: nonessential network traffic is disabled for this session")), "nonessential-disabled");
	assert.equal(classify(new Error("p: $.http.fetch: socketPath /a refused: takes an absolute path")), "socketpath-refused");
	assert.equal(classify(new Error("p: $.http.fetch(http://x) over /a aborted: no complete answer within 30000ms")), "timeout");
	assert.equal(classify(new Error("p: $.http.fetch(http://x) over /a failed: ENOENT: no such file")), "connect-failed");
	assert.equal(classify("weird"), "other");
});

test("pickChild: only known fields, bounded holders, wrong types nulled", () => {
	const c = pickChild({ self_pid: "9", waited: 1, holders: Array.from({ length: 40 }, () => ({ pid: 1, fd: 2, cloexec: "yes" })), token: "t" });
	assert.equal(c.self_pid, null);
	assert.equal(c.waited, false);
	assert.equal(c.holders.length, 16);
	assert.equal(c.holders[0].cloexec, null);
	assert.equal("token" in c, false);
});
