/**
 * tmuxClientsScript.test.ts — TMUX_CLIENTS_SCRIPT (#444) executed by bash
 * against REAL tmux clients: a private tmux server (own socket dir) holds
 * the tab, and each client is the real attach wrapper run inside a pane of
 * a second, helper server — so its argv after the exec is exactly the
 * attach shape and its start time is real. Only the script's OWN queries
 * (`display`, `list-clients`, `detach-client`) go to a stub `tmux` first on
 * PATH, which answers from the test and records what it was asked, so the
 * processes stay alive across assertions and failures can be injected.
 * Linux + tmux only. Work's two P2s on PR #486 are reproduced here:
 *   T1 — a sweep for client A executed late, after a newer client B joined
 *        the tab, must never detach B (and is `stale` once A is gone);
 *   T2 — a failing `display` or `list-clients` must fail closed: no
 *        signal, no detach, for a pid whose identity is not proven.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, promises as fs, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TMUX_ATTACH_SCRIPT, TMUX_CLIENTS_SCRIPT } from "./dockerManager.js";

const TAB = "tab-script444";
const HOST = "st444h";
const hasTmux = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
const supported = process.platform === "linux" && hasTmux && existsSync("/proc/self/stat");

let dir: string; // short: a tmux socket path is limited to ~100 bytes
let stubBin: string;
let logFile: string;
let realEnv: NodeJS.ProcessEnv;
let hostPanes = 0;
const children: ChildProcess[] = [];

const STUB = `#!/bin/bash
echo "$*" >> "$FAKE_LOG"
case "$1" in
display) [ -n "\${FAKE_DISPLAY_FAIL:-}" ] && exit 1; printf '%s\\n' "\${FAKE_SERVER_PID:-}" ;;
list-clients) [ -n "\${FAKE_LIST_FAIL:-}" ] && exit 1; printf '%s' "\${FAKE_CLIENTS:-}" ;;
detach-client) exit 0 ;;
*) exit 2 ;;
esac
`;

beforeAll(async () => {
	if (!supported) return;
	dir = await fs.mkdtemp("/tmp/st444-");
	stubBin = path.join(dir, "stub");
	logFile = path.join(dir, "tmux.log");
	await fs.mkdir(stubBin);
	await fs.writeFile(path.join(stubBin, "tmux"), STUB, { mode: 0o755 });
	// The real servers live under `dir`; the test itself may run inside tmux.
	const { TMUX: _inner, ...rest } = process.env;
	realEnv = { ...rest, TMUX_TMPDIR: dir };
});
afterEach(() => {
	for (const c of children) {
		if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
	}
	children.length = 0;
});
afterAll(async () => {
	if (!supported) return;
	spawnSync("tmux", ["kill-server"], { env: realEnv });
	spawnSync("tmux", ["-L", HOST, "kill-server"], { env: realEnv });
	await fs.rm(dir, { recursive: true, force: true });
});

function tmux(args: string[]): string {
	const r = spawnSync("tmux", args, { env: realEnv, encoding: "utf8" });
	return r.status === 0 ? r.stdout : "";
}
function listedPids(): number[] {
	return tmux(["list-clients", "-t", TAB, "-F", "#{client_pid}"])
		.split("\n")
		.filter(Boolean)
		.map(Number);
}
/** The REAL attach wrapper in a pane of the helper server: after its exec, a real tmux client of TAB. */
async function attachClient(): Promise<number> {
	const before = new Set(listedPids());
	hostPanes++;
	const r = spawnSync(
		"tmux",
		[
			"-L",
			HOST,
			"new-session",
			"-d",
			"-s",
			`h${hostPanes}`,
			"-x",
			"80",
			"-y",
			"24",
			`exec env -u TMUX bash -c '${TMUX_ATTACH_SCRIPT.replaceAll("'", "'\\''")}' st-attach ${TAB}`,
		],
		{ env: realEnv, encoding: "utf8" },
	);
	if (r.status !== 0) throw new Error(`helper pane failed: ${r.stderr}`);
	let pid = -1;
	await waitFor(() => {
		const fresh = listedPids().filter((p) => !before.has(p));
		if (fresh.length === 1) pid = fresh[0]!;
		return pid !== -1;
	});
	await waitFor(() => argv(pid).startsWith("tmux\n"));
	return pid;
}
function serverPid(): number {
	return Number(tmux(["display", "-p", "#{pid}"]).trim());
}
/** A process that is still the bash wrapper (before its exec). */
function wrapperStage(): ChildProcess {
	const c = spawn("bash", ["-c", "sleep 30; true", "st-attach", TAB], { stdio: "ignore" });
	children.push(c);
	return c;
}
function foreign(): ChildProcess {
	const c = spawn("sleep", ["30"], { stdio: "ignore" });
	children.push(c);
	return c;
}
function argv(pid: number): string {
	try {
		return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", "\n");
	} catch {
		return "";
	}
}
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return argv(pid) !== "";
	} catch {
		return false;
	}
}
function startTicks(pid: number): number {
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	const rest = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
	return Number(rest[19]);
}
async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
	const until = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > until) throw new Error("condition not met in time");
		await new Promise((r) => setTimeout(r, 10));
	}
}
/** Resolves true if the child exits within `ms`. */
function exits(c: ChildProcess, ms = 1500): Promise<boolean> {
	if (c.exitCode !== null || c.signalCode !== null) return Promise.resolve(true);
	return new Promise((r) => {
		const t = setTimeout(() => r(false), ms);
		c.once("exit", () => {
			clearTimeout(t);
			r(true);
		});
	});
}

interface Fake {
	serverPid?: number;
	clients?: Array<[number, string]>;
	displayFail?: boolean;
	listFail?: boolean;
}
/** The script, byte for byte as the backend runs it, with the stub answering tmux. */
function run(mode: "release" | "sweep", pid: number, fake: Fake = {}): string {
	writeFileSync(logFile, "");
	const r = spawnSync(
		"bash",
		["-c", TMUX_CLIENTS_SCRIPT, "st-tmux-clients", TAB, mode, String(pid)],
		{
			encoding: "utf8",
			env: {
				...realEnv,
				PATH: `${stubBin}:${process.env.PATH ?? ""}`,
				FAKE_LOG: logFile,
				FAKE_SERVER_PID: fake.serverPid === undefined ? "" : String(fake.serverPid),
				FAKE_CLIENTS: (fake.clients ?? []).map(([p, t]) => `${p} ${t}\n`).join(""),
				FAKE_DISPLAY_FAIL: fake.displayFail ? "1" : "",
				FAKE_LIST_FAIL: fake.listFail ? "1" : "",
			},
		},
	);
	return r.stdout.trim();
}
const detaches = () =>
	readFileSync(logFile, "utf8")
		.split("\n")
		.filter((l) => l.startsWith("detach-client"));

describe.skipIf(!supported)("TMUX_CLIENTS_SCRIPT against real tmux clients (#444)", () => {
	let S = -1; // the real server: forked by the first client, same argv
	let A = -1;
	let B = -1;
	beforeAll(async () => {
		if (!supported) return;
		A = await attachClient();
		S = serverPid();
		// The fence's clock ticks every 10 ms; B must start on a later tick.
		await new Promise((r) => setTimeout(r, 30));
		B = await attachClient();
	});
	const listed = () =>
		[
			[A, "/dev/pts/1"],
			[B, "/dev/pts/2"],
		] as Array<[number, string]>;

	it("fixture: real clients with the exact attach argv, the server with the same argv, B started after A", () => {
		const shape = `tmux\nnew-session\n-A\n-s\n${TAB}\n-c\n/home/developer/workspace\n`;
		expect(argv(A)).toBe(shape);
		expect(argv(B)).toBe(shape);
		expect(argv(S)).toBe(shape);
		expect(S).not.toBe(A);
		expect(startTicks(B)).toBeGreaterThan(startTicks(A));
		expect(listedPids().sort()).toEqual([A, B].sort());
	});

	// ── Work T1 ────────────────────────────────────────────────────────────
	describe("T1: the fence by start time", () => {
		it("Work's interleaving: A's sweep executed after the newer B attached leaves B alone", () => {
			expect(run("sweep", A, { serverPid: S, clients: listed() })).toBe("swept 0");
			expect(detaches()).toEqual([]);
		});
		it("B's sweep detaches the older A — never the server, however old, nor a non-client pid", () => {
			const withOthers: Array<[number, string]> = [
				...listed(),
				[S, "/dev/pts/0"],
				[process.pid, "/dev/pts/9"],
			];
			expect(run("sweep", B, { serverPid: S, clients: withOthers })).toBe("swept 1");
			expect(detaches()).toEqual(["detach-client -t /dev/pts/1"]);
		});
		it("a sweep fails closed when display or list-clients fail", () => {
			expect(run("sweep", B, { displayFail: true, clients: listed() })).toBe("swept 0 unverified");
			expect(detaches()).toEqual([]);
			expect(run("sweep", B, { serverPid: S, listFail: true })).toBe("swept 0 unverified");
			expect(detaches()).toEqual([]);
		});
		it("a sweep whose own client is gone (released before the exec ran) is stale and does nothing", async () => {
			process.kill(A, "SIGKILL");
			await waitFor(() => !alive(A));
			expect(run("sweep", A, { serverPid: S, clients: listed() })).toBe("swept 0 stale");
			expect(detaches()).toEqual([]);
			expect(alive(B)).toBe(true);
		});
	});

	// ── Work T2 ────────────────────────────────────────────────────────────
	describe("T2: release fails closed", () => {
		it("display failing ⇒ unverified, nothing signalled", () => {
			expect(run("release", B, { displayFail: true, clients: listed() })).toBe("unverified");
			expect(detaches()).toEqual([]);
			expect(alive(B)).toBe(true);
		});
		it("list-clients failing ⇒ unverified, nothing signalled (Work's kill -TERM path is gone)", () => {
			expect(run("release", B, { serverPid: S, listFail: true })).toBe("unverified");
			expect(detaches()).toEqual([]);
			expect(alive(B)).toBe(true);
		});
		it("a tmux-argv pid that a healthy listing does not know is left alone (not-listed)", () => {
			expect(run("release", B, { serverPid: S, clients: [[B + 100000, "/dev/pts/7"]] })).toBe(
				"not-listed",
			);
			expect(detaches()).toEqual([]);
			expect(alive(B)).toBe(true);
		});
		it("the server pid is never a target, even when listed as a client", () => {
			expect(run("release", S, { serverPid: S, clients: [[S, "/dev/pts/0"]] })).toBe("not-ours");
			expect(detaches()).toEqual([]);
			expect(alive(S)).toBe(true);
		});
		it("a foreign process, PID 1 and a dead pid: not-ours / already-exited, nothing signalled", async () => {
			const f = foreign();
			await waitFor(() => argv(f.pid!) !== "");
			expect(run("release", f.pid!, { serverPid: S })).toBe("not-ours");
			expect(await exits(f, 150)).toBe(false);
			expect(run("release", 1, { serverPid: S })).toBe("not-ours");
			expect(run("release", 999999, { serverPid: S })).toBe("already-exited");
			expect(detaches()).toEqual([]);
		});
		it("the wrapper stage (bash before its exec) is terminated even when display fails — no tmux process has that argv", async () => {
			const w = wrapperStage();
			await waitFor(() => argv(w.pid!).startsWith("bash\n-c\n"));
			expect(run("release", w.pid!, { displayFail: true })).toBe("terminated");
			expect(await exits(w)).toBe(true);
			expect(w.signalCode).toBe("SIGTERM");
		});
		it("a healthy query detaches exactly the listed client", () => {
			expect(run("release", B, { serverPid: S, clients: listed() })).toBe("detached");
			expect(detaches()).toEqual(["detach-client -t /dev/pts/2"]);
		});
	});
});
