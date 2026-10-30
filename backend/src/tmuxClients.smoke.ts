/**
 * tmuxClients.smoke.ts — #444 against a REAL dockerd and the real session
 * image. Run by the Session Image workflow:
 *
 *   cd backend && npx tsx src/tmuxClients.smoke.ts <image>
 *
 * The unit suite can only pin the shapes (the wrapper's argv, the one-shot
 * the last detach fires). What only a real tmux can show, and is checked
 * here through the real DockerManager.attach()/detach():
 *   - one WS attach = one `tmux new-session -A` client inside the container,
 *     and that client EXITS when the last listener detaches (release);
 *   - a second browser tab and a read-only observer share that one client
 *     and their detach leaves it alone; the tmux session and its pane
 *     content survive every release;
 *   - N reconnects leave N−N = 0 clients and 0 lingering client processes;
 *   - a hijacked stream that dies from the host side (docker hiccup, or the
 *     backend process itself dying — a second DockerManager plays that
 *     role) leaves a client behind that the NEXT attach sweeps, so the tab
 *     ends with exactly one client again.
 *
 * Isolated: a fresh container from the image, a temp workspace, removed on
 * exit. No D1 (the SessionManager is a stub holding one row).
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import Dockerode from "dockerode";
import { DockerManager, TMUX_ATTACH_SCRIPT, TMUX_CLIENTS_SCRIPT } from "./dockerManager.js";
import type { SessionManager } from "./sessionManager.js";

const IMAGE = process.argv[2] ?? "shared-terminal-session";
const SID = randomUUID();
const TAB = "tab-smoke444";
const ROOT = path.join(os.tmpdir(), `st-tmux444-${process.pid}`);
process.env.WORKSPACE_ROOT = ROOT;
process.env.SESSION_IMAGE = IMAGE;
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "warn";

const docker = new Dockerode();
let failures = 0;
let containerId = "";

function check(what: string, ok: boolean, detail?: unknown): void {
	if (ok) console.log(`  ok: ${what}`);
	else {
		failures++;
		console.error(`  FAIL: ${what}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
	}
}
function phase(name: string): void {
	console.log(`\n── ${name} ──`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exit code and stdout of `bash -c cmd` inside the container (as developer). */
async function execOut(cmd: string): Promise<{ code: number; out: string }> {
	const e = await docker.getContainer(containerId).exec({
		Cmd: ["bash", "-c", cmd],
		AttachStdout: true,
		AttachStderr: true,
	});
	const s = await e.start({});
	const out: Buffer[] = [];
	await new Promise<void>((r) => {
		docker.modem.demuxStream(
			s,
			{ write: (c: Buffer) => out.push(c) } as unknown as NodeJS.WritableStream,
			{ write: () => true } as unknown as NodeJS.WritableStream,
		);
		s.on("end", () => r());
		s.on("close", () => r());
	});
	return { code: (await e.inspect()).ExitCode ?? -1, out: Buffer.concat(out).toString("utf8") };
}

/** Exit code and stdout of an argv exec inside the container. */
async function execArgv(cmd: string[]): Promise<{ code: number; out: string }> {
	const e = await docker
		.getContainer(containerId)
		.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
	const s = await e.start({});
	const out: Buffer[] = [];
	await new Promise<void>((r) => {
		docker.modem.demuxStream(
			s,
			{ write: (c: Buffer) => out.push(c) } as unknown as NodeJS.WritableStream,
			{ write: () => true } as unknown as NodeJS.WritableStream,
		);
		s.on("end", () => r());
		s.on("close", () => r());
	});
	return { code: (await e.inspect()).ExitCode ?? -1, out: Buffer.concat(out).toString("utf8") };
}

/** Run TMUX_CLIENTS_SCRIPT exactly as the backend does; `shim` prepends a dir whose `tmux` misbehaves. */
async function runScript(mode: "release" | "sweep", pid: number, shim?: string): Promise<string> {
	const cmd = shim
		? [
				"bash",
				"-c",
				`PATH="$1:$PATH" exec bash -c "$0" st-tmux-clients "$2" "$3" "$4"`,
				TMUX_CLIENTS_SCRIPT,
				shim,
				TAB,
				mode,
				String(pid),
			]
		: ["bash", "-c", TMUX_CLIENTS_SCRIPT, "st-tmux-clients", TAB, mode, String(pid)];
	return (await execArgv(cmd)).out.trim();
}

/** A raw second attach client (the real wrapper), kept open by its hijacked stream. */
async function rawClient(): Promise<{ destroy(): void }> {
	const e = await docker.getContainer(containerId).exec({
		Cmd: ["bash", "-c", TMUX_ATTACH_SCRIPT, "st-attach", TAB],
		AttachStdin: true,
		AttachStdout: true,
		AttachStderr: true,
		Tty: true,
	});
	const s = await e.start({ hijack: true, stdin: true, Tty: true });
	s.resume();
	return { destroy: () => s.destroy() };
}

/** `<pid> <tty>` per tmux client attached to the smoke tab. */
async function clients(): Promise<Array<{ pid: number; tty: string }>> {
	const { out } = await execOut(
		`tmux list-clients -t ${TAB} -F '#{client_pid} #{client_tty}' 2>/dev/null`,
	);
	return out
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			const [pid, tty] = l.split(" ");
			return { pid: Number(pid), tty: tty ?? "" };
		});
}

/**
 * Attach-client PROCESSES (tmux or still the bash wrapper), whether or not
 * tmux lists them. The tmux SERVER is forked by the first client and keeps
 * its argv, so it is excluded by pid.
 */
async function clientProcesses(): Promise<number> {
	const { out } = await execOut(
		`srv="$(tmux display -p '#{pid}' 2>/dev/null)"; for f in /proc/[0-9]*/cmdline; do p="\${f#/proc/}"; p="\${p%/cmdline}"; [ "$p" = "$srv" ] && continue; tr '\\0' ' ' < "$f" 2>/dev/null; echo; done | grep -c -E '^(tmux new-session -A -s ${TAB} |bash -c .* st-attach ${TAB} ?$)'`,
	);
	return Number(out.trim()) || 0;
}

async function waitFor(what: string, pred: () => Promise<boolean>, ms = 8000): Promise<boolean> {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		if (await pred()) return true;
		await sleep(150);
	}
	console.error(`  (timed out waiting for: ${what})`);
	return false;
}

async function waitReady(): Promise<void> {
	for (let i = 0; i < 120; i++) {
		if ((await execOut("test -f /tmp/.st-ready")).code === 0) return;
		await sleep(500);
	}
	throw new Error("container never became ready");
}

function makeDm(): DockerManager {
	const meta = {
		sessionId: SID,
		userId: "u1",
		name: "smoke",
		status: "running" as const,
		containerId,
		containerName: `st-${SID.slice(0, 12)}`,
		cols: 100,
		rows: 30,
		envVars: {},
		createdAt: new Date(),
		lastConnectedAt: null,
	};
	const sessions = {
		getOrThrow: async () => meta,
		get: async () => meta,
		updateConnected: async () => undefined,
	} as unknown as SessionManager;
	return new DockerManager(sessions);
}

async function attach(dm: DockerManager, id: string, observe = false): Promise<void> {
	const r = await dm.attach(SID, id, 100, 30, () => undefined, TAB, observe);
	r.flushTail();
}

async function cleanup(): Promise<void> {
	if (containerId)
		await docker
			.getContainer(containerId)
			.remove({ force: true })
			.catch(() => undefined);
	await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
}

async function main(): Promise<void> {
	const ws = path.join(ROOT, SID);
	await fs.mkdir(ws, { recursive: true });
	await fs.chmod(ws, 0o777);
	const c = await docker.createContainer({
		Image: IMAGE,
		name: `st-${SID.slice(0, 12)}`,
		Env: [`SESSION_ID=${SID}`],
		HostConfig: {
			Binds: [`${ws}:/home/developer/workspace`],
			Init: true,
			CapDrop: ["ALL"],
			SecurityOpt: ["no-new-privileges:true"],
		},
		OpenStdin: true,
		Tty: true,
	});
	containerId = c.id;
	await c.start();
	await waitReady();

	// ── 1. one attach = one client; the last detach releases it ──────────
	phase("release on last detach");
	const dm = makeDm();
	await attach(dm, "a1");
	check(
		"one attach ⇒ one tmux client",
		await waitFor("1 client", async () => (await clients()).length === 1),
	);
	const first = (await clients())[0];
	if (first) {
		const argv = (await execOut(`tr '\\0' ' ' < /proc/${first.pid}/cmdline`)).out;
		check(
			"the client's argv is the plain tmux attach (bash exec'd, pid kept)",
			argv === `tmux new-session -A -s ${TAB} -c /home/developer/workspace `,
			argv,
		);
	}
	await execOut(`tmux send-keys -t ${TAB} 'echo marker-444-$((40+4))' Enter`);
	await sleep(400);

	await attach(dm, "a2");
	await attach(dm, "obs", true);
	await sleep(500);
	check("a second tab and an observer share the one client", (await clients()).length === 1);
	dm.detach("a1");
	dm.detach("obs");
	await sleep(1000);
	check("detaching non-last listeners keeps the client", (await clients()).length === 1);
	dm.detach("a2");
	check(
		"the last detach ends the client (tmux lists none)",
		await waitFor("0 clients", async () => (await clients()).length === 0),
	);
	check(
		"…and no client process lingers",
		await waitFor("0 processes", async () => (await clientProcesses()) === 0),
	);
	check("the tmux session survives", (await execOut(`tmux has-session -t ${TAB}`)).code === 0);
	check(
		"the pane content survives",
		(await execOut(`tmux capture-pane -p -t ${TAB}`)).out.includes("marker-444-44"),
	);

	// ── 2. reconnects: N attach/detach cycles leave nothing behind ──────
	phase("reconnect cycles");
	for (let i = 0; i < 8; i++) {
		await attach(dm, `r${i}`);
		if (!(await waitFor(`cycle ${i} client`, async () => (await clients()).length === 1))) break;
		dm.detach(`r${i}`);
		if (!(await waitFor(`cycle ${i} release`, async () => (await clients()).length === 0))) break;
	}
	check("8 reconnects ⇒ 0 clients", (await clients()).length === 0);
	check("8 reconnects ⇒ 0 client processes", (await clientProcesses()) === 0);
	check(
		"pane content still there",
		(await execOut(`tmux capture-pane -p -t ${TAB}`)).out.includes("marker-444-44"),
	);

	// ── 3. abrupt host-side death + a NEW backend process: the sweep ─────
	phase("orphan from a dead stream / dead backend is swept by the next attach");
	await attach(dm, "a3");
	check("client attached", await waitFor("1 client", async () => (await clients()).length === 1));
	const orphanPid = (await clients())[0]?.pid ?? -1;
	// The hijacked stream dies on the host side without a detach() — what a
	// docker hiccup or a backend crash looks like from the container.
	const shared = (
		dm as unknown as { shared: Map<string, Promise<{ stream: { destroy(): void } }>> }
	).shared;
	const s = await shared.get(`${SID}:${TAB}`);
	s?.stream.destroy();
	await sleep(1000);
	check(
		"the client survives the host-side death (this IS #444)",
		(await clients()).some((x) => x.pid === orphanPid),
	);

	const dm2 = makeDm(); // a freshly started backend: no memory of pid orphanPid
	await attach(dm2, "b1");
	check(
		"the next attach sweeps the orphan and keeps its own client",
		await waitFor("sweep", async () => {
			const cs = await clients();
			return cs.length === 1 && !cs.some((x) => x.pid === orphanPid);
		}),
		await clients(),
	);
	check(
		"the orphan process is gone",
		await waitFor("orphan gone", async () => (await clientProcesses()) === 1),
	);
	dm2.detach("b1");
	check(
		"release after the sweep",
		await waitFor("0 clients", async () => (await clients()).length === 0),
	);

	// ── 4. three observers at once ──────────────────────────────────────
	phase("several listeners, arbitrary detach order");
	const dm3 = makeDm();
	await attach(dm3, "o1");
	await attach(dm3, "o2", true);
	await attach(dm3, "o3", true);
	check(
		"three listeners, one client",
		await waitFor("1 client", async () => (await clients()).length === 1),
	);
	dm3.detach("o2");
	await sleep(700);
	check("middle detach keeps the client", (await clients()).length === 1);
	dm3.detach("o1");
	await sleep(700);
	check(
		"first-attacher detach keeps the client while an observer remains",
		(await clients()).length === 1,
	);
	dm3.detach("o3");
	check(
		"last observer detach releases",
		await waitFor("0 clients", async () => (await clients()).length === 0),
	);

	// ── 5. Work T1: a late sweep never detaches a newer client ──────────
	phase("Work T1: the sweep is fenced by start time");
	const dm4 = makeDm();
	await attach(dm4, "t1a");
	check("A attached", await waitFor("A", async () => (await clients()).length === 1));
	const pidA = (await clients())[0]?.pid ?? -1;
	const rawB = await rawClient(); // a newer generation on the same tab
	check("B attached (2 clients)", await waitFor("B", async () => (await clients()).length === 2));
	const pidB = (await clients()).map((c) => c.pid).find((p) => p !== pidA) ?? -1;
	const lateSweepA = await runScript("sweep", pidA);
	check(
		"A's sweep, run after B joined, leaves B alone",
		lateSweepA === "swept 0" && (await clients()).length === 2,
		lateSweepA,
	);
	const sweepB = await runScript("sweep", pidB);
	check(
		"B's sweep detaches the older A only",
		sweepB === "swept 1" &&
			(await waitFor(
				"A gone",
				async () => (await clients()).map((c) => c.pid).join() === String(pidB),
			)),
		sweepB,
	);
	const staleSweep = await runScript("sweep", pidA);
	check(
		"a sweep for the released A is stale and does nothing",
		staleSweep === "swept 0 stale" && (await clients()).length === 1,
		staleSweep,
	);
	dm4.detach("t1a"); // A is already gone: its release finds nothing to do
	const releaseB = await runScript("release", pidB);
	check(
		"B released by pid",
		releaseB === "detached" && (await waitFor("0", async () => (await clients()).length === 0)),
		releaseB,
	);
	rawB.destroy();

	// ── 6. Work T2: query failures fail closed ──────────────────────────
	phase("Work T2: display / list-clients failures never signal");
	const realTmux = (await execOut("command -v tmux")).out.trim();
	check("real tmux located", realTmux.length > 0, realTmux);
	const shim = async (dir: string, failing: string) =>
		execOut(
			`mkdir -p ${dir} && printf '%s\n' '#!/bin/bash' '[ "$1" = ${failing} ] && exit 1' 'exec ${realTmux} "$@"' > ${dir}/tmux && chmod +x ${dir}/tmux`,
		);
	await shim("/tmp/shim-display", "display");
	await shim("/tmp/shim-list", "list-clients");
	const dm5 = makeDm();
	await attach(dm5, "t2a");
	check("C attached", await waitFor("C", async () => (await clients()).length === 1));
	const pidC = (await clients())[0]?.pid ?? -1;
	const r1 = await runScript("release", pidC, "/tmp/shim-display");
	check(
		"display failing ⇒ unverified, client kept",
		r1 === "unverified" && (await clients()).length === 1,
		r1,
	);
	const r2 = await runScript("release", pidC, "/tmp/shim-list");
	check(
		"list-clients failing ⇒ unverified, client kept",
		r2 === "unverified" && (await clients()).length === 1,
		r2,
	);
	const r3 = await runScript("sweep", pidC, "/tmp/shim-display");
	check(
		"sweep with display failing ⇒ unverified",
		r3 === "swept 0 unverified" && (await clients()).length === 1,
		r3,
	);
	const r4 = await runScript("release", 999999);
	check("a dead pid ⇒ already-exited", r4 === "already-exited", r4);
	const srvPid = Number((await execOut("tmux display -p '#{pid}'")).out.trim());
	const r5 = await runScript("release", srvPid);
	check(
		"the tmux server pid ⇒ not-ours, server alive",
		r5 === "not-ours" && (await execOut(`tmux has-session -t ${TAB}`)).code === 0,
		r5,
	);
	dm5.detach("t2a");
	check(
		"the normal release still works after the failed ones",
		await waitFor("0", async () => (await clients()).length === 0),
	);

	phase("final state");
	check("tmux list-clients is empty", (await clients()).length === 0);
	check("no attach-client processes remain", (await clientProcesses()) === 0);
	check(
		"the tab's tmux session still exists",
		(await execOut(`tmux has-session -t ${TAB}`)).code === 0,
	);
}

main()
	.catch((err) => {
		failures++;
		console.error("smoke crashed:", err);
	})
	.then(async () => {
		if (failures > 0 && containerId) {
			const { out } = await execOut(
				"tmux list-clients 2>&1; echo \"server pid: $(tmux display -p '#{pid}' 2>&1)\"; ps -o pid,args -u developer 2>/dev/null",
			).catch(() => ({
				out: "(no diagnostics)",
			}));
			console.error(`\n── container diagnostics ──\n${out}`);
		}
		await cleanup();
		console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURE(S)`);
		process.exit(failures === 0 ? 0 : 1);
	});
