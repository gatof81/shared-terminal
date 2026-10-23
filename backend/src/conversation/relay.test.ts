/**
 * relay.test.ts — the session image's loopback relay
 * (`session-image/hooks/relay.py`, docs/CONVERSATION.md §2.6), run as the
 * real Python process against a stand-in backend.
 *
 * The relay's upstream is the fixed name `st-backend`; HOSTALIASES points it
 * at localhost on the test host (glibc resolves it for Python's
 * getaddrinfo), and `ST_BACKEND_PORT` at the stand-in. The listen port is
 * the test-only `ST_RELAY_LISTEN_PORT`, always on 127.0.0.1.
 *
 * Counters come from the relay's own debug line (`ST_HOOKS_DEBUG=1`), which
 * is also checked to never carry a body, a header value or the token. The
 * docker-level counterpart, with the real CLI, is
 * session-image/conversation-smoke.sh.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const RELAY = path.resolve(__dirname, "../../../session-image/hooks/relay.py");
const TOKEN = "b".repeat(64);
const ST_SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e";
const SID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const SID2 = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const PATH = "/ingest/claude/hook";

type Mode = "ok" | "status500" | "hang" | "redirect" | "decision" | { slowMs: number };

interface Received {
	url: string;
	headers: http.IncomingHttpHeaders;
	body: string;
}

let dir: string;
let upstream: http.Server | null;
let upstreamPort: number;
let received: Received[];
let relays: ChildProcess[];

async function freePort(): Promise<number> {
	const s = net.createServer();
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
	const port = (s.address() as AddressInfo).port;
	await new Promise<void>((r) => s.close(() => r()));
	return port;
}

async function startUpstream(mode: Mode, port = 0): Promise<number> {
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			received.push({
				url: req.url ?? "",
				headers: req.headers,
				body: Buffer.concat(chunks).toString(),
			});
			if (mode === "hang") return;
			if (typeof mode === "object") {
				setTimeout(() => res.writeHead(204).end(), mode.slowMs);
				return;
			}
			if (mode === "status500") return void res.writeHead(500).end("boom");
			if (mode === "redirect") return void res.writeHead(307, { location: "/elsewhere" }).end();
			if (mode === "decision") {
				res.writeHead(200, { "content-type": "application/json" });
				return void res.end(JSON.stringify({ decision: "block", continue: false }));
			}
			res.writeHead(204).end();
		});
	});
	await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
	upstream = server;
	upstreamPort = (server.address() as AddressInfo).port;
	return upstreamPort;
}

async function stopUpstream() {
	const s = upstream;
	upstream = null;
	if (!s) return;
	s.closeAllConnections();
	await new Promise<void>((r) => s.close(() => r()));
}

interface Relay {
	port: number;
	proc: ChildProcess;
	stderr: () => string;
	stats: () => Record<string, number>;
	exited: Promise<number | null>;
}

async function startRelay(env: Record<string, string> = {}): Promise<Relay> {
	const port = await freePort();
	const hosts = path.join(dir, "hosts");
	await fs.writeFile(hosts, "st-backend localhost\n");
	const proc = spawn("python3", ["-IS", RELAY], {
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOSTALIASES: hosts,
			ST_INGEST_TOKEN: TOKEN,
			SESSION_ID: ST_SESSION,
			ST_BACKEND_PORT: String(upstreamPort),
			ST_RELAY_LISTEN_PORT: String(port),
			ST_HOOKS_DEBUG: "1",
			ST_RELAY_STATS_INTERVAL: "0.05",
			// As entrypoint.sh starts it: large bodies in their own mappings,
			// so RSS shows what is live rather than what glibc cached.
			MALLOC_MMAP_THRESHOLD_: "131072",
			...env,
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	relays.push(proc);
	let err = "";
	proc.stderr?.on("data", (c) => {
		err += c;
	});
	const exited = new Promise<number | null>((r) => proc.on("exit", (code) => r(code)));
	await Promise.race([
		(async () => {
			while (!err.includes("listening")) await new Promise((r) => setTimeout(r, 10));
		})(),
		exited,
	]);
	return {
		port,
		proc,
		stderr: () => err,
		stats: () => {
			const lines = err.split("\n").filter((l) => l.startsWith("st-relay "));
			const last = lines.at(-1) ?? "";
			return Object.fromEntries(
				last
					.split(" ")
					.slice(1)
					.map((kv) => kv.split("="))
					.filter((kv) => kv.length === 2 && /^\d+$/.test(kv[1]))
					.map(([k, v]) => [k, Number(v)]),
			);
		},
		exited,
	};
}

function body(sid: string | null, event: string, extra: Record<string, unknown> = {}): string {
	const o = sid
		? { session_id: sid, hook_event_name: event, ...extra }
		: { hook_event_name: event, ...extra };
	return JSON.stringify(o);
}

interface Reply {
	status: number;
	headers: http.IncomingHttpHeaders;
	body: string;
	ms: number;
}

function post(
	port: number,
	payload: string | Buffer,
	headers: Record<string, string> = {},
	opts: { method?: string; path?: string } = {},
): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const t0 = performance.now();
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				method: opts.method ?? "POST",
				path: opts.path ?? PATH,
				agent: false,
				headers: { "content-type": "application/json", ...headers },
			},
			(res) => {
				let text = "";
				res.on("data", (c) => {
					text += c;
				});
				res.on("end", () =>
					resolve({
						status: res.statusCode ?? 0,
						headers: res.headers,
						body: text,
						ms: performance.now() - t0,
					}),
				);
			},
		);
		req.on("error", reject);
		req.end(payload);
	});
}

async function until(cond: () => boolean, ms = 5000) {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error("timed out waiting");
		await new Promise((r) => setTimeout(r, 10));
	}
}

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "st-relay-"));
	received = [];
	relays = [];
	upstream = null;
	upstreamPort = 0;
});
afterEach(async () => {
	for (const p of relays) p.kill("SIGKILL");
	await stopUpstream();
	await fs.rm(dir, { recursive: true, force: true });
});

describe("relay — activation and surface", () => {
	it("without the token or the session id it exits 0 and never listens", async () => {
		await startUpstream("ok");
		for (const env of [{ ST_INGEST_TOKEN: "" }, { SESSION_ID: "" }]) {
			const r = await startRelay(env);
			expect(await r.exited).toBe(0);
			expect(r.stderr()).not.toContain("listening");
		}
	});

	it("listens on 127.0.0.1 only", async () => {
		await startUpstream("ok");
		const r = await startRelay();
		const external = Object.values(os.networkInterfaces())
			.flat()
			.find((a) => a && a.family === "IPv4" && !a.internal)?.address;
		if (external) {
			await expect(
				new Promise((resolve, reject) => {
					const s = net.connect(r.port, external, () => resolve("connected"));
					s.on("error", reject);
				}),
			).rejects.toThrow(/ECONNREFUSED/);
		}
		expect((await post(r.port, body(SID, "Stop"))).status).toBe(204);
	});

	it("a busy port: exits 3 without serving", async () => {
		await startUpstream("ok");
		const blocker = net.createServer();
		await new Promise<void>((res) => blocker.listen(0, "127.0.0.1", res));
		const port = (blocker.address() as AddressInfo).port;
		const r = await startRelay({ ST_RELAY_LISTEN_PORT: String(port) });
		expect(await r.exited).toBe(3);
		blocker.close();
	});

	it("killed with connections open, a new relay binds the same port at once (TIME_WAIT)", async () => {
		await startUpstream("ok");
		const r = await startRelay();
		for (let i = 0; i < 5; i++) await post(r.port, body(SID, "Stop", { i }));
		await until(() => received.length === 5);
		r.proc.kill("SIGKILL");
		await r.exited;
		const again = await startRelay({
			ST_RELAY_LISTEN_PORT: String(r.port),
			ST_RELAY_GENERATION: "1",
		});
		expect(again.stderr()).toContain(`listening on 127.0.0.1:${r.port} generation=1`);
		expect((await post(r.port, body(SID, "Stop"))).status).toBe(204);
	});

	it("only POST to the exact path: anything else is an empty 404 and nothing is forwarded", async () => {
		await startUpstream("ok");
		const r = await startRelay();
		for (const [method, p] of [
			["GET", PATH],
			["PUT", PATH],
			["DELETE", PATH],
			["POST", `${PATH}?x=1`],
			["POST", `${PATH}/`],
			["POST", "/other"],
			["POST", "http://evil.example/ingest/claude/hook"],
		]) {
			const res = await post(r.port, body(SID, "Stop"), {}, { method, path: p });
			expect([res.status, res.body], `${method} ${p}`).toEqual([404, ""]);
		}
		await new Promise((res) => setTimeout(res, 200));
		expect(received).toHaveLength(0);
	});
});

describe("relay — forwarding", () => {
	it("forwards bodies byte-for-byte in order, with its own credentials and only the allowed headers", async () => {
		await startUpstream("ok");
		const r = await startRelay();
		const bodies = Array.from({ length: 50 }, (_, i) =>
			body(SID, "MessageDisplay", { index: i, delta: `línea ${i}\n` }),
		);
		for (const b of bodies) {
			const res = await post(r.port, b, {
				authorization: "Bearer forged",
				"x-st-session": "someone-else",
				"x-st-tmux-pane": "%7",
				"x-st-relay-dropped": "999",
				cookie: "a=b",
			});
			expect([res.status, res.body]).toEqual([204, ""]);
		}
		await until(() => received.length === 50);
		expect(received.map((x) => x.body)).toEqual(bodies);
		for (const x of received) {
			expect(x.url).toBe(PATH);
			expect(x.headers.authorization).toBe(`Bearer ${TOKEN}`);
			expect(x.headers["x-st-session"]).toBe(ST_SESSION);
			expect(x.headers["x-st-tmux-pane"]).toBe("%7");
			expect(x.headers["x-st-relay-dropped"]).toBeUndefined();
			expect(x.headers.cookie).toBeUndefined();
			expect(Object.keys(x.headers).sort()).toEqual(
				[
					"authorization",
					"content-length",
					"content-type",
					"host",
					"x-st-session",
					"x-st-tmux-pane",
				].sort(),
			);
		}
	});

	it("an invalid pane header is forwarded empty", async () => {
		await startUpstream("ok");
		const r = await startRelay();
		await post(r.port, body(SID, "Stop"), { "x-st-tmux-pane": "%3\r\nX-Evil: 1" }).catch(
			() => undefined,
		);
		await post(r.port, body(SID, "Stop"), { "x-st-tmux-pane": "pane-1" });
		await until(() => received.length >= 1);
		expect(received.at(-1)?.headers["x-st-tmux-pane"]).toBe("");
		expect(received.every((x) => x.headers["x-evil"] === undefined)).toBe(true);
	});

	it("ignores HTTP_PROXY/HTTPS_PROXY/ALL_PROXY: the upstream connection is always direct", async () => {
		await startUpstream("ok");
		const r = await startRelay({
			HTTP_PROXY: "http://127.0.0.1:9",
			http_proxy: "http://127.0.0.1:9",
			HTTPS_PROXY: "http://127.0.0.1:9",
			ALL_PROXY: "socks5://127.0.0.1:9",
			NO_PROXY: "",
		});
		await post(r.port, body(SID, "Stop"));
		await until(() => received.length === 1);
	});

	it("answers 204 within milliseconds whatever the backend does, and never relays its answer", async () => {
		for (const mode of ["status500", "hang", "redirect", "decision"] as const) {
			received = [];
			await startUpstream(mode);
			const r = await startRelay();
			const replies: Reply[] = [];
			for (let i = 0; i < 5; i++) replies.push(await post(r.port, body(SID, "PreToolUse", { i })));
			for (const x of replies) {
				expect([x.status, x.body], mode).toEqual([204, ""]);
				expect(x.ms, mode).toBeLessThan(100);
			}
			r.proc.kill("SIGKILL");
			await stopUpstream();
		}
	}, 20_000);

	it("does not follow a redirect", async () => {
		await startUpstream("redirect");
		const r = await startRelay();
		await post(r.port, body(SID, "Stop"));
		await until(() => r.stats().dropped_upstream === 1);
		expect(received.map((x) => x.url)).toEqual([PATH]);
	});
});

describe("relay — losses are counted and reported (§3.2.1)", () => {
	it("backend down, then back: the next delivered event of the conversation carries the exact count and bytes", async () => {
		const port = await freePort();
		upstreamPort = port; // nothing listens yet: connection refused
		const r = await startRelay();
		const lost = [
			body(SID, "UserPromptSubmit", { prompt: "uno" }),
			body(SID, "Stop", { x: "dos" }),
		];
		for (const b of lost) await post(r.port, b);
		await until(() => (r.stats().dropped ?? 0) === 2);
		await startUpstream("ok", port);
		await new Promise((res) => setTimeout(res, 1100)); // past the 1 s pause
		await post(r.port, body(SID2, "Stop")); // another conversation: no report
		await post(r.port, body(SID, "SessionEnd"));
		await until(() => received.length === 2);
		expect(received[0].headers["x-st-relay-dropped"]).toBeUndefined();
		expect(received[1].headers["x-st-relay-dropped"]).toBe("2");
		expect(received[1].headers["x-st-relay-dropped-bytes"]).toBe(
			String(lost.reduce((n, b) => n + Buffer.byteLength(b), 0)),
		);
		// Reported once: reset after the 2xx.
		await post(r.port, body(SID, "SessionEnd", { again: true }));
		await until(() => received.length === 3);
		expect(received[2].headers["x-st-relay-dropped"]).toBeUndefined();
	});

	it("the session id is read whether or not the serialiser puts spaces around the colon", async () => {
		await startUpstream("status500");
		const r = await startRelay();
		await post(r.port, `{ "session_id" : "${SID}", "hook_event_name": "Stop" }`);
		await until(() => r.stats().dropped === 1);
		await stopUpstream();
		await startUpstream("ok", upstreamPort);
		await new Promise((res) => setTimeout(res, 1100));
		await post(r.port, body(SID, "Stop"));
		await until(() => received.length >= 2);
		expect(received.at(-1)?.headers["x-st-relay-dropped"]).toBe("1");
		expect(received.at(-1)?.headers["x-st-relay-unattributed"]).toBeUndefined();
	});

	it("a failed report is kept for the next delivery", async () => {
		await startUpstream("status500");
		const r = await startRelay();
		await post(r.port, body(SID, "Stop", { n: 1 }));
		await until(() => r.stats().dropped === 1);
		await new Promise((res) => setTimeout(res, 1100));
		await post(r.port, body(SID, "Stop", { n: 2 })); // carries dropped=1, also fails
		await until(() => r.stats().dropped === 2);
		await stopUpstream();
		await startUpstream("ok", upstreamPort);
		await new Promise((res) => setTimeout(res, 1100));
		await post(r.port, body(SID, "Stop", { n: 3 }));
		await until(() => received.some((x) => x.headers["x-st-relay-dropped"] === "2"));
	}, 15_000);

	it("a body without a readable session id is attributed by pane; with neither, unattributed", async () => {
		await startUpstream("status500");
		const r = await startRelay();
		await post(r.port, body(null, "Stop"), { "x-st-tmux-pane": "%4" });
		await new Promise((res) => setTimeout(res, 1100));
		await post(r.port, body(null, "Stop"));
		await until(() => r.stats().dropped === 2);
		await stopUpstream();
		await startUpstream("ok", upstreamPort);
		await new Promise((res) => setTimeout(res, 1100));
		await post(r.port, body(SID, "Stop"), { "x-st-tmux-pane": "%4" });
		await until(() => received.some((x) => x.headers["x-st-relay-dropped"] !== undefined));
		const last = received.at(-1);
		expect(last?.headers["x-st-relay-dropped"]).toBe("1");
		expect(last?.headers["x-st-relay-unattributed"]).toBe("1");
	}, 15_000);

	it("a hung backend: 2 s timeout, then a 1 s pause that drops instead of queueing stale events", async () => {
		await startUpstream("hang");
		const r = await startRelay();
		const t0 = Date.now();
		await post(r.port, body(SID, "Stop", { n: 0 }));
		await new Promise((res) => setTimeout(res, 500));
		for (let i = 1; i <= 5; i++)
			expect((await post(r.port, body(SID, "Stop", { n: i }))).status).toBe(204);
		await until(() => r.stats().dropped === 6, 6000);
		const s = r.stats();
		expect(s.dropped_upstream).toBe(1);
		expect(s.dropped_paused).toBe(5);
		expect(Date.now() - t0).toBeLessThan(4000);
		expect(received).toHaveLength(1); // the hung one only
	}, 10_000);

	it("saturation: bounded queue, and received = forwarded + reported as lost", async () => {
		await startUpstream({ slowMs: 2 });
		const r = await startRelay();
		const N = 3000;
		const pending: Promise<Reply>[] = [];
		for (let i = 0; i < N; i++) {
			pending.push(
				post(
					r.port,
					body(i % 2 ? SID : SID2, "MessageDisplay", { index: i, delta: "x".repeat(200) }),
				),
			);
			if (pending.length >= 12) await Promise.all(pending.splice(0));
		}
		await Promise.all(pending);
		await until(() => (r.stats().forwarded ?? 0) + (r.stats().dropped ?? 0) === N, 30_000);
		const s = r.stats();
		expect(s.received).toBe(N);
		expect(s.queue_max).toBeLessThanOrEqual(1024);
		// Flush the reports with one more event per conversation.
		await new Promise((res) => setTimeout(res, 1100));
		await post(r.port, body(SID, "Stop"));
		await post(r.port, body(SID2, "Stop"));
		await until(() => r.stats().forwarded === s.forwarded + 2, 10_000);
		const sum = (h: string) => received.reduce((n, x) => n + Number(x.headers[h] ?? 0), 0);
		const reported = sum("x-st-relay-dropped");
		const forwardedEvents = received.length - 2;
		expect(s.dropped).toBeGreaterThan(0);
		expect(forwardedEvents + reported + sum("x-st-relay-unattributed")).toBe(N);
		// Refused without reading the body, yet attributed from the bytes that came with the headers.
		expect(reported).toBe(s.dropped);
	}, 60_000);

	it("L5-sized bodies: one copy per body — the peak stays within queue+reading (16 MiB) + the body in flight (L5)", async () => {
		const L5 = 8 * 1024 * 1024;
		await startUpstream({ slowMs: 300 });
		const r = await startRelay();
		const status = async (k: string) =>
			Number(
				(await fs.readFile(`/proc/${r.proc.pid}/status`, "utf8")).match(
					new RegExp(`^${k}:\\s+(\\d+)`, "m"),
				)?.[1],
			);
		const baseline = await status("VmRSS");
		const prefix = `{"session_id":"${SID}","hook_event_name":"Stop","x":"`;
		const big = Buffer.alloc(L5, "y");
		big.write(prefix, 0);
		big.write('"}', L5 - 2);
		const N = 12;
		const replies = await Promise.all(Array.from({ length: N }, () => post(r.port, big)));
		expect(replies.map((x) => x.status)).toEqual(Array(N).fill(204));
		await until(() => (r.stats().forwarded ?? 0) + (r.stats().dropped ?? 0) === N, 20_000);
		const peakKiB = (await status("VmHWM")) - baseline;
		const s = r.stats();
		expect(s.received).toBe(N);
		expect(s.dropped_queue_full).toBeGreaterThan(0);
		// Design bound for bodies: 16 MiB (queued + being read) + one L5 in
		// flight upstream. 8 MiB of slack for allocator and socket buffers.
		// Measured, not a universal ceiling: the interpreter's own growth and
		// the allocator vary by platform.
		expect(peakKiB).toBeLessThanOrEqual((16 + 8 + 8) * 1024);
		console.log(
			`relay L5 stress: ${N} × 8 MiB, peak above baseline ${Math.round(peakKiB / 1024)} MiB, stats ${JSON.stringify(s)}`,
		);
	}, 60_000);

	it("kept-alive connections don't retain delivered bodies; reused, they stay intact, ordered and 204", async () => {
		const L5 = 8 * 1024 * 1024;
		const K = 6;
		await startUpstream("ok");
		const r = await startRelay();
		const rss = async () =>
			Number(
				(await fs.readFile(`/proc/${r.proc.pid}/status`, "utf8")).match(/^VmRSS:\s+(\d+)/m)?.[1],
			);
		const baseline = await rss();
		const bigBody = (i: number) => {
			const prefix = `{"session_id":"${SID}","hook_event_name":"MessageDisplay","index":${i},"x":"`;
			const b = Buffer.alloc(L5 - 64, "y".charCodeAt(0) + (i % 20));
			b.write(prefix, 0);
			b.write('"}', b.length - 2);
			return b;
		};
		// One raw keep-alive socket per client, so nothing but the relay can
		// close them; a request is answered when its 204 head has arrived.
		const conns = await Promise.all(
			Array.from({ length: K }, async () => {
				const sock = net.connect(r.port, "127.0.0.1");
				await new Promise((res) => sock.once("connect", res));
				let data = "";
				sock.on("data", (c) => {
					data += c.toString("latin1");
				});
				return {
					sock,
					send: async (b: Buffer) => {
						const before = (data.match(/HTTP\/1\.1 /g) ?? []).length;
						sock.write(
							`POST ${PATH} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${b.length}\r\n\r\n`,
						);
						sock.write(b);
						await until(() => (data.match(/HTTP\/1\.1 /g) ?? []).length > before, 5000);
						return data.slice(data.lastIndexOf("HTTP/1.1 "));
					},
				};
			}),
		);
		const sent: Buffer[] = [];
		const round = async (offset: number) => {
			for (let i = 0; i < K; i++) {
				const b = bigBody(offset + i);
				sent.push(b);
				// Sequential and drained one at a time: the queue never refuses.
				expect(await conns[i].send(b)).toBe("HTTP/1.1 204 No Content\r\n\r\n");
				await until(() => received.length === sent.length, 5000);
			}
		};
		await round(0);
		// All delivered, queue empty, every connection still open and idle.
		await until(() => (r.stats().forwarded ?? 0) === K, 5000);
		const held = (await rss()) - baseline;
		expect(conns.every((c) => !c.sock.destroyed)).toBe(true);
		// Retained bodies would be K × ~8 MiB = 48 MiB here; the documented
		// budget allows none outside the queue once delivered. 8 MiB slack.
		expect(held).toBeLessThanOrEqual(8 * 1024);
		// Reuse every connection (within the 2 s idle window): same answers,
		// every body intact and in order.
		await round(K);
		await until(() => r.stats().forwarded === 2 * K, 5000);
		expect(r.stats()).toMatchObject({ received: 2 * K, forwarded: 2 * K });
		expect(r.stats().dropped ?? 0).toBe(0);
		expect(received.map((x) => x.body)).toEqual(sent.map((b) => b.toString()));
		for (const c of conns) c.sock.destroy();
		console.log(
			`relay keep-alive retention: ${K} × 8 MiB delivered, RSS above baseline with idle connections ${Math.round(held / 1024)} MiB`,
		);
	}, 60_000);

	it("more than 16 open connections: the 17th gets 204 without being read and is counted", async () => {
		await startUpstream("ok");
		const r = await startRelay();
		const idle: net.Socket[] = [];
		for (let i = 0; i < 16; i++) {
			const s = net.connect(r.port, "127.0.0.1");
			await new Promise((res) => s.on("connect", res));
			idle.push(s);
		}
		await new Promise((res) => setTimeout(res, 100));
		const res = await post(r.port, body(SID, "Stop"));
		expect([res.status, res.body]).toEqual([204, ""]);
		await until(() => r.stats().dropped_busy === 1);
		for (const s of idle) s.destroy();
	});

	it("Content-Length missing or over L5: 204 without reading, counted", async () => {
		await startUpstream("ok");
		const r = await startRelay();
		const res = await post(r.port, "{}", { "content-length": String(8 * 1024 * 1024 + 1) }).catch(
			(e: Error) => e,
		);
		// The relay answers and closes before the body: either outcome is fine for the client.
		if (!(res instanceof Error)) expect(res.status).toBe(204);
		const chunked = await new Promise<number>((resolve) => {
			const req = http.request(
				{ host: "127.0.0.1", port: r.port, method: "POST", path: PATH, agent: false },
				(rs) => resolve(rs.statusCode ?? 0),
			);
			req.write("{");
			req.end("}");
		});
		expect(chunked).toBe(204);
		await until(() => r.stats().dropped_too_large === 2);
		expect(received).toHaveLength(0);
	});

	it("after a restart (generation > 0) each conversation's first delivered event says so, once", async () => {
		await startUpstream("ok");
		const r = await startRelay({ ST_RELAY_GENERATION: "1" });
		await post(r.port, body(SID, "Stop"));
		await post(r.port, body(SID, "Stop", { n: 2 }));
		await post(r.port, body(SID2, "Stop"));
		await until(() => received.length === 3);
		expect(received.map((x) => x.headers["x-st-relay-restarted"] ?? null)).toEqual([
			"1",
			null,
			"1",
		]);
		const r0 = await startRelay();
		received = [];
		await post(r0.port, body(SID, "Stop"));
		await until(() => received.length === 1);
		expect(received[0].headers["x-st-relay-restarted"]).toBeUndefined();
	});
});

describe("relay — never logs content", () => {
	it("the debug log has counters only: no body, no header value, no token", async () => {
		await startUpstream("status500");
		const r = await startRelay();
		await post(r.port, body(SID, "UserPromptSubmit", { prompt: "SECRET-PROMPT-TEXT" }), {
			"x-st-tmux-pane": "%5",
		});
		await until(() => r.stats().dropped === 1);
		const log = r.stderr();
		for (const s of ["SECRET-PROMPT-TEXT", TOKEN, SID, ST_SESSION, "%5"])
			expect(log).not.toContain(s);
		for (const line of log.trim().split("\n")) {
			expect(line).toMatch(
				/^st-relay (listening on 127\.0\.0\.1:\d+ generation=\d+|([a-z_]+=\d+ ?)+)$/,
			);
		}
	});
});
