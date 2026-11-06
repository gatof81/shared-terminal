/**
 * bgTransport.test.ts — the in-container client's fixed shape and the
 * parsers of its one-line output (CONVERSATION.md §8.1.12.7). The program's
 * behaviour against a real daemon is the bg-reply smoke's business
 * (composerBg.smoke.ts); here: argv, stdin, code mapping, strict parsing.
 */

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	ABORT_CODES,
	abortHttpCode,
	BG_CLIENT_ARGV,
	BG_CLIENT_PROGRAM,
	DAEMON_CODES,
	type InspectResult,
	inspectFault,
	inspectStdin,
	parseInspectOutput,
	parseReplyOutput,
	replyStdin,
} from "./bgTransport.js";

describe("the fixed client", () => {
	it("argv: env -i, absolute python3, isolated, no site, the program inline — nothing request-derived", () => {
		expect(BG_CLIENT_ARGV.slice(0, 6)).toEqual([
			"/usr/bin/env",
			"-i",
			"/usr/bin/python3",
			"-I",
			"-S",
			"-c",
		]);
		expect(BG_CLIENT_ARGV[6]).toBe(BG_CLIENT_PROGRAM);
		expect(BG_CLIENT_ARGV).toHaveLength(7);
	});
	it("nextTurn is a literal of the program; there is no request without it", () => {
		expect(BG_CLIENT_PROGRAM).toContain(
			'req = {"proto": 1, "op": "reply", "short": short, "text": text, "auth": key, "nextTurn": True}',
		);
		expect(BG_CLIENT_PROGRAM.match(/"op": "reply"/g)).toHaveLength(1);
		expect(BG_CLIENT_PROGRAM).not.toMatch(/nextTurn"?\s*:\s*(False|p\.get)/);
	});
	it("the program never prints the daemon's error text, only its code from a fixed set", () => {
		expect(BG_CLIENT_PROGRAM).toContain(
			'CODES = ("ENOJOB","ERESPAWNING","ENOREPLY","ESKEW","EAUTH","EUNVERIFIED")',
		);
		expect(BG_CLIENT_PROGRAM).not.toContain('a.get("error")');
		// A code is read only from an explicit refusal; anything else after the
		// write is unknown (S1): {"ok":true} without op, {"ok":false,"code":"ok"}…
		expect(BG_CLIENT_PROGRAM).toContain(
			'code = a.get("code") if isinstance(a, dict) and a.get("ok") is False else None',
		);
		expect(BG_CLIENT_PROGRAM).toContain('out(code if code in CODES else "unknown-answer")');
	});
	it("the request line is bounded at 1 MiB before connecting", () => {
		expect(BG_CLIENT_PROGRAM).toContain('need(len(line) <= 1048576, "too-large")');
	});
	it("re-reads the session file AFTER connecting and immediately before writing", () => {
		const iConnect = BG_CLIENT_PROGRAM.indexOf("s, _ = connect(path, dpid)");
		const iRead = BG_CLIENT_PROGRAM.indexOf("sf = session_file(cfg, pid)");
		const iWrite = BG_CLIENT_PROGRAM.indexOf("s.sendall(line)");
		expect(iConnect).toBeGreaterThan(0);
		expect(iRead).toBeGreaterThan(iConnect);
		expect(iWrite).toBeGreaterThan(iRead);
	});
	it("stdin carries the parameters; reply text only there", () => {
		const i = JSON.parse(
			replyStdin({
				pid: 9,
				short: "abcdef01",
				start: "1",
				exe: "/x",
				cid: "c",
				nonce: "n",
				ptyHostPid: 8,
				daemonPid: 7,
				daemonStart: "2",
				daemonExe: "/x",
				text: "hi",
			}).toString("utf8"),
		);
		expect(i).toMatchObject({ mode: "reply", text: "hi" });
		expect(i.nextTurn).toBeUndefined();
		expect(JSON.parse(inspectStdin({ pid: 9, short: "abcdef01" }).toString("utf8"))).toEqual({
			mode: "inspect",
			pid: 9,
			short: "abcdef01",
		});
	});
	const hasPython = spawnSync("/usr/bin/python3", ["-c", "1"]).status === 0;
	it.skipIf(!hasPython)("compiles, and refuses bad input without connecting anywhere", () => {
		const run = (stdin: string) =>
			spawnSync("/usr/bin/env", [...BG_CLIENT_ARGV.slice(1)], { input: stdin, encoding: "utf8" });
		expect(run("not json").stdout).toBe("ST-BG error\n");
		expect(run('{"mode":"reply","pid":1,"short":"zz"}').stdout).toBe("ST-BG bad-input\n");
		// A pid that does not exist: no environ ⇒ stale-process, before any socket.
		expect(run('{"mode":"reply","pid":2147483646,"short":"abcdef01"}').stdout).toBe(
			"ST-BG stale-process\n",
		);
		// Our own pid with a wrong start time: stale-process before the daemon is looked at.
		const own = run(
			JSON.stringify({
				mode: "reply",
				pid: process.pid,
				short: "abcdef01",
				start: "1",
				exe: "/nope",
				cid: "c",
				nonce: "n",
				ptyHostPid: 1,
				daemonPid: 1,
				daemonStart: "1",
				daemonExe: "/nope",
				text: "t",
			}),
		);
		expect(own.stdout).toBe("ST-BG stale-process\n");
		expect(own.status).toBe(0);
	});
});

describe("parseReplyOutput", () => {
	it("ok is accepted (not delivered)", () => {
		expect(parseReplyOutput(0, "ST-BG ok\n")).toEqual({ kind: "accepted" });
	});
	it.each([...DAEMON_CODES])("daemon code %s is rejected", (c) => {
		expect(parseReplyOutput(0, `ST-BG ${c}\n`)).toEqual({ kind: "rejected", code: c });
	});
	it.each([...ABORT_CODES])("abort %s is aborted", (c) => {
		expect(parseReplyOutput(0, `ST-BG ${c}\n`)).toEqual({ kind: "aborted", code: c });
	});
	it.each([
		[null, "ST-BG ok\n", "exit-unknown"],
		[1, "ST-BG ok\n", "exit-1"],
		[0, "ST-BG no-answer\n", "no-answer"],
		[0, "ST-BG unknown-answer\n", "unknown-answer"],
		[0, "ST-BG daemon-other\n", "output-invalid"],
		[0, "ST-BG what\n", "output-invalid"],
		[0, "ok\n", "output-invalid"],
		[0, "ST-BG ok\nmore", "output-invalid"],
		[0, `ST-BG ${"x".repeat(300)}`, "output-too-large"],
	])("(%s, %j) is unknown: %s — maybe written, never 'not sent'", (exit, out, why) => {
		expect(parseReplyOutput(exit, out)).toEqual({ kind: "unknown", why });
	});
});

const goodInspect = {
	configDir: "/home/developer/.claude",
	daemon: {
		statusPid: 8,
		statusStart: "40",
		rosterPid: 8,
		peerPid: 8,
		exe: "/x/claude.exe",
		start: "40",
	},
	job: {
		short: "abcdef01",
		nonce: "n1",
		pid: 7,
		cliVersion: "2.1.318",
		outcome: false,
		dying: false,
	},
	worker: { ppid: 7, start: "50", exe: "/x/claude.exe" },
	session: {
		sessionId: "cid",
		status: "idle",
		procStart: "50",
		jobId: "abcdef01",
		kind: "bg",
		waiting: false,
	},
};
const line = (o: unknown) => `ST-BG inspect ${JSON.stringify(o)}\n`;

describe("parseInspectOutput / inspectFault", () => {
	it("parses the whitelisted shape", () => {
		const r = parseInspectOutput(0, line(goodInspect)) as InspectResult;
		expect(r.daemon.statusPid).toBe(8);
		expect(r.job).toMatchObject({ nonce: "n1", pid: 7 });
		expect(
			inspectFault(r, { cid: "cid", short: "abcdef01", start: "50", exe: "/x/claude.exe" }),
		).toBeNull();
	});
	it("refuses anything else", () => {
		expect(parseInspectOutput(1, line(goodInspect))).toBeNull();
		expect(parseInspectOutput(0, "junk")).toBeNull();
		expect(parseInspectOutput(0, line({ ...goodInspect, configDir: "rel" }))).toBeNull();
		expect(parseInspectOutput(0, line({ ...goodInspect, job: "x" }))).toBeNull();
		expect(parseInspectOutput(0, `${line(goodInspect)}extra`)).toBeNull();
	});
	const q = { cid: "cid", short: "abcdef01", start: "50", exe: "/x/claude.exe" };
	const fault = (patch: (o: typeof goodInspect) => void) => {
		const o = structuredClone(goodInspect);
		patch(o);
		return inspectFault(parseInspectOutput(0, line(o)) as InspectResult, q);
	};
	it.each<[string, (o: typeof goodInspect) => void, string, string]>([
		["peer ≠ supervisor (fake socket)", (o) => (o.daemon.peerPid = 99), "binding-stale", "daemon"],
		[
			"no peer",
			(o) => ((o.daemon as Record<string, unknown>).peerPid = null),
			"binding-stale",
			"daemon",
		],
		["roster ≠ status", (o) => (o.daemon.rosterPid = 9), "binding-stale", "daemon"],
		["supervisor restarted", (o) => (o.daemon.start = "41"), "binding-stale", "daemon"],
		[
			"nonce missing",
			(o) => ((o.job as Record<string, unknown>).nonce = null),
			"binding-stale",
			"job",
		],
		["pty host ≠ parent", (o) => (o.job.pid = 6), "binding-stale", "job"],
		["outcome set", (o) => (o.job.outcome = true), "binding-stale", "job"],
		["worker start", (o) => (o.worker.start = "51"), "binding-stale", "process"],
		["worker exe", (o) => (o.worker.exe = "/y"), "binding-stale", "process"],
		[
			"sessionId",
			(o) => (o.session.sessionId = "other"),
			"binding-stale",
			"session-file:session-id",
		],
		["procStart", (o) => (o.session.procStart = "1"), "binding-stale", "session-file:start"],
		["jobId", (o) => (o.session.jobId = "ffffffff"), "binding-stale", "session-file:job"],
		["kind", (o) => (o.session.kind = "interactive"), "binding-stale", "session-file:kind"],
		["busy", (o) => (o.session.status = "busy"), "busy", "session-file"],
		["waiting", (o) => (o.session.waiting = true), "needs-terminal", "session-file"],
		["status odd", (o) => (o.session.status = "zz"), "needs-terminal", "status-unknown"],
	])("%s", (_l, patch, error, detail) => {
		expect(fault(patch)).toEqual({ error, detail });
	});
	it("identity faults win over state (a stale file's 'idle' means nothing)", () => {
		expect(
			fault((o) => {
				o.session.status = "busy";
				o.session.sessionId = "other";
			}),
		).toEqual({ error: "binding-stale", detail: "session-file:session-id" });
	});
});

describe("abortHttpCode", () => {
	it("maps re-read aborts to 409 binding-stale/busy/needs-terminal, the rest to 502", () => {
		expect(abortHttpCode("busy")).toEqual({ status: 409, error: "busy", detail: "reread" });
		expect(abortHttpCode("waiting")).toMatchObject({ status: 409, error: "needs-terminal" });
		for (const c of [
			"stale-process",
			"stale-session",
			"stale-daemon",
			"stale-job",
			"no-daemon",
		] as const)
			expect(abortHttpCode(c)).toMatchObject({ status: 409, error: "binding-stale", detail: c });
		for (const c of ["no-key", "too-large", "bad-input", "error"] as const)
			expect(abortHttpCode(c)).toMatchObject({ status: 502, error: "delivery-failed" });
	});
});
