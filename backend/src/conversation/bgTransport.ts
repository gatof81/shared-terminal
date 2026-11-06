/**
 * conversation/bgTransport.ts — the in-container client of the CLI daemon's
 * control socket for the composer's background-session transport
 * (docs/CONVERSATION.md §8.1.12, v1.9 proposal, EXPERIMENTAL behind
 * `CONVERSATION_COMPOSER_BG_ENABLED`).
 *
 * The client is a FIXED Python program run by `docker exec` as the session
 * uid with a fixed argv — `/usr/bin/env -i /usr/bin/python3 -I -S -c <program>`
 * — so nothing of the workspace (its `claude`, its PATH, its site-packages,
 * its environment) takes part, and every request-derived value (pids, ids,
 * the text) travels on STDIN only: `docker exec inspect` keeps the argv, not
 * stdin. It prints ONE line from a fixed code enum and never the daemon's
 * error text (§8.1.12.7).
 *
 * Two modes, one program:
 *
 *   inspect — no effect. The daemon's identity (daemon.status.json, roster
 *     .json, the SO_PEERCRED pid of control.sock), the job's record from the
 *     no-key `list` op (only whitelisted fields: never `intent`, never an
 *     auth token), and the job process's own session file. The roster holds
 *     tokens in clear, so it is parsed INSIDE the container and only
 *     `supervisorPid` leaves.
 *
 *   reply — the one effect. Re-verifies, immediately before connecting
 *     (§8.1.12.4 step 5): the job process (starttime, exe, parent = the job's
 *     pty host from `list`), the daemon (both status files and the peer pid
 *     of the socket it is about to write to), the job's nonce, and the job's
 *     `sessions/<pid>.json` — `sessionId = cid`, `status = idle` with no
 *     `waitingFor`, the same `procStart`. Any difference aborts BEFORE a byte
 *     is written. Then it reads `control.key` (inside the container only: on
 *     the host, root would follow the user's links), writes exactly one JSON
 *     line ≤ 1 MiB with `nextTurn: true` as a literal of the program — there
 *     is no code path without it — and maps the one-line answer to a code.
 *
 * What it cannot close (declared in §8.1.12.3/§8.1.12.4): the tens of
 * milliseconds between the last re-read and the daemon handling the line. A
 * human Enter or a `/clear` in that window queues the text or routes it to
 * the job's next conversation; the ack decides (`accepted` / `misdelivered`).
 */

// ── The program ─────────────────────────────────────────────────────────────

/**
 * No `$` and no backtick anywhere in the Python source (it is a template
 * literal here). `-I` isolates from the environment and the script dir,
 * `-S` skips `site` (no user site-packages from the workspace HOME), and
 * `env -i` empties the environment. Every file under the config dir is
 * opened with O_NOFOLLOW (a planted link at the leaf is refused); the dirs
 * are the session user's own, and this runs as that user, so following a
 * link in a parent grants nothing the user does not already have.
 */
export const BG_CLIENT_PROGRAM = `import hashlib, json, os, socket, struct, sys
CODES = ("ENOJOB","ERESPAWNING","ENOREPLY","ESKEW","EAUTH","EUNVERIFIED")
state = {"written": False}
def out(code, extra=None):
    line = "ST-BG " + code
    if extra is not None:
        line += " " + json.dumps(extra, separators=(",", ":"), sort_keys=True)
    sys.stdout.write(line + "\\n")
    sys.stdout.flush()
    sys.exit(0)
class Abort(Exception):
    pass
def need(cond, code):
    if not cond:
        raise Abort(code)
def readf(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        data = os.read(fd, limit + 1)
    finally:
        os.close(fd)
    need(len(data) <= limit, "too-large-file")
    return data
def jsonf(path, limit=1048576):
    try:
        v = json.loads(readf(path, limit).decode("utf-8"))
    except Abort:
        raise
    except Exception:
        return None
    return v if isinstance(v, dict) else None
def stat_of(pid):
    try:
        raw = readf("/proc/%d/stat" % pid, 4096).decode("utf-8", "replace")
    except Exception:
        return None
    i = raw.rfind(") ")
    if i < 0:
        return None
    f = raw[i + 2:].split(" ")
    if len(f) < 20:
        return None
    return {"ppid": int(f[1]), "start": f[19]}
def exe_of(pid):
    try:
        return os.readlink("/proc/%d/exe" % pid)
    except Exception:
        return None
def config_dir(pid):
    try:
        env = readf("/proc/%d/environ" % pid, 1048576).split(b"\\0")
    except Exception:
        return None
    d = {}
    for kv in env:
        k, sep, v = kv.partition(b"=")
        if sep:
            d[k] = v
    if d.get(b"CLAUDE_CONFIG_DIR"):
        return d[b"CLAUDE_CONFIG_DIR"].decode("utf-8", "strict")
    if d.get(b"HOME"):
        return os.path.join(d[b"HOME"].decode("utf-8", "strict"), ".claude")
    return None
def sock_path(cfg):
    h = hashlib.sha256(cfg.encode("utf-8")).hexdigest()[:8]
    return "/tmp/cc-daemon-%d/%s/control.sock" % (os.getuid(), h)
def connect(path, daemon_pid):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(3.0)
    s.connect(path)
    pid, uid, gid = struct.unpack("3i", s.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
    if daemon_pid is not None and (pid != daemon_pid or uid != os.getuid()):
        s.close()
        raise Abort("stale-daemon")
    return s, pid
def read_line(s, limit, timeout):
    s.settimeout(timeout)
    buf = b""
    while b"\\n" not in buf:
        chunk = s.recv(65536)
        if not chunk:
            return None
        buf += chunk
        if len(buf) > limit:
            return None
    return buf.split(b"\\n", 1)[0]
def daemon_ids(cfg):
    st = jsonf(os.path.join(cfg, "daemon.status.json")) or {}
    ro = jsonf(os.path.join(cfg, "daemon", "roster.json"), 8388608) or {}
    sp = st.get("supervisorPid")
    ss = st.get("supervisorProcStart")
    rp = ro.get("supervisorPid")
    return {
        "statusPid": sp if isinstance(sp, int) else None,
        "statusStart": ss if isinstance(ss, str) else None,
        "rosterPid": rp if isinstance(rp, int) else None,
    }
def list_job(path, daemon_pid, short):
    s, peer = connect(path, daemon_pid)
    try:
        s.sendall(b'{"proto":1,"op":"list"}\\n')
        line = read_line(s, 8388608, 5.0)
    finally:
        s.close()
    if line is None:
        return peer, None
    a = json.loads(line.decode("utf-8"))
    jobs = a.get("jobs") if isinstance(a, dict) and a.get("ok") is True else None
    if not isinstance(jobs, list):
        return peer, None
    for j in jobs:
        if isinstance(j, dict) and j.get("short") == short:
            keep = {}
            for k in ("short", "nonce", "pid", "cliVersion", "state", "tempo"):
                v = j.get(k)
                if isinstance(v, (str, int)) and not isinstance(v, bool):
                    keep[k] = v
            keep["outcome"] = j.get("outcome") is not None
            keep["dying"] = j.get("dying") is True
            return peer, keep
    return peer, {"absent": True}
def session_file(cfg, pid):
    j = jsonf(os.path.join(cfg, "sessions", "%d.json" % pid))
    if j is None:
        return None
    keep = {}
    for k in ("sessionId", "status", "procStart", "jobId", "kind", "version"):
        v = j.get(k)
        if isinstance(v, str):
            keep[k] = v
    keep["waiting"] = j.get("waitingFor") is not None
    return keep
def main():
    raw = sys.stdin.buffer.read(1572865)
    need(len(raw) <= 1572864, "bad-input")
    p = json.loads(raw.decode("utf-8"))
    need(isinstance(p, dict), "bad-input")
    mode = p.get("mode")
    pid = p.get("pid")
    short = p.get("short")
    need(isinstance(pid, int) and pid > 1, "bad-input")
    need(isinstance(short, str) and len(short) == 8 and all(c in "0123456789abcdef" for c in short), "bad-input")
    cfg = config_dir(pid)
    if cfg is None and mode == "inspect":
        alt = p.get("configDir")
        if isinstance(alt, str) and alt.startswith("/"):
            cfg = alt
    need(cfg is not None and cfg.startswith("/"), "stale-process")
    path = sock_path(cfg)
    if mode == "inspect":
        ids = daemon_ids(cfg)
        try:
            peer, job = list_job(path, None, short)
        except Abort:
            raise
        except Exception:
            peer, job = None, None
        ps = stat_of(pid)
        dp = ids["statusPid"]
        out("inspect", {
            "configDir": cfg,
            "daemon": dict(ids, peerPid=peer, exe=exe_of(dp) if dp else None, start=(stat_of(dp) or {}).get("start") if dp else None),
            "job": job,
            "worker": {"ppid": ps["ppid"] if ps else None, "start": ps["start"] if ps else None, "exe": exe_of(pid)},
            "session": session_file(cfg, pid),
        })
    need(mode == "reply", "bad-input")
    start = p.get("start"); exe = p.get("exe"); cid = p.get("cid"); nonce = p.get("nonce")
    host = p.get("ptyHostPid"); dpid = p.get("daemonPid"); dstart = p.get("daemonStart"); text = p.get("text")
    dexe = p.get("daemonExe")
    need(all(isinstance(x, str) and x for x in (start, exe, cid, nonce, dstart, dexe)), "bad-input")
    need(isinstance(host, int) and isinstance(dpid, int) and isinstance(text, str) and text, "bad-input")
    def process_ok():
        ps = stat_of(pid)
        need(ps is not None and ps["start"] == start and ps["ppid"] == host, "stale-process")
        need(exe_of(pid) == exe, "stale-process")
    process_ok()
    ids = daemon_ids(cfg)
    need(ids["statusPid"] == dpid and ids["rosterPid"] == dpid and ids["statusStart"] == dstart, "stale-daemon")
    dps = stat_of(dpid)
    need(dps is not None and dps["start"] == dstart and exe_of(dpid) == dexe, "stale-daemon")
    try:
        peer, job = list_job(path, dpid, short)
    except Abort:
        raise
    except Exception:
        raise Abort("no-daemon")
    need(job is not None and not job.get("absent"), "stale-job")
    need(job.get("nonce") == nonce and job.get("pid") == host and not job["outcome"] and not job["dying"], "stale-job")
    try:
        key = readf(os.path.join(cfg, "daemon", "control.key"), 4096).decode("utf-8").strip()
    except Abort:
        raise
    except Exception:
        key = ""
    need(key != "", "no-key")
    req = {"proto": 1, "op": "reply", "short": short, "text": text, "auth": key, "nextTurn": True}
    line = (json.dumps(req, ensure_ascii=False, separators=(",", ":")) + "\\n").encode("utf-8")
    need(len(line) <= 1048576, "too-large")
    s, _ = connect(path, dpid)
    try:
        process_ok()
        sf = session_file(cfg, pid)
        need(sf is not None and sf.get("sessionId") == cid and sf.get("procStart") == start and sf.get("jobId") == short and sf.get("kind") == "bg", "stale-session")
        need(not sf["waiting"] and sf.get("status") != "waiting", "waiting")
        need(sf.get("status") == "idle", "busy")
        state["written"] = True
        s.sendall(line)
        try:
            ans = read_line(s, 65536, 10.0)
        except Exception:
            ans = None
    finally:
        s.close()
    if ans is None:
        out("no-answer")
    try:
        a = json.loads(ans.decode("utf-8"))
    except Exception:
        out("no-answer")
    if isinstance(a, dict) and a.get("ok") is True and a.get("op") == "reply":
        out("ok")
    code = a.get("code") if isinstance(a, dict) and a.get("ok") is False else None
    out(code if code in CODES else "unknown-answer")
try:
    main()
except Abort as e:
    out(("no-answer" if state["written"] else str(e.args[0])))
except SystemExit:
    raise
except BaseException:
    out("no-answer" if state["written"] else "error")
`;

/** The exec's argv: no shell, absolute paths only, an empty environment. */
export const BG_CLIENT_ARGV: readonly string[] = [
	"/usr/bin/env",
	"-i",
	"/usr/bin/python3",
	"-I",
	"-S",
	"-c",
	BG_CLIENT_PROGRAM,
];

/** A request line the daemon accepts at most (one JSON line ≤ 1 MiB). */
export const REPLY_LINE_MAX = 1024 * 1024;

export const SHORT_RE = /^[0-9a-f]{8}$/;

// ── Inputs ──────────────────────────────────────────────────────────────────

export interface InspectInput {
	pid: number;
	short: string;
	/** Used only when the worker's environ is unreadable (the worker is gone). */
	configDir?: string;
}

export interface ReplyInput {
	pid: number;
	short: string;
	/** `/proc/<pid>/stat` field 22 the preconditions read. */
	start: string;
	/** `readlink /proc/<pid>/exe` the preconditions read. */
	exe: string;
	cid: string;
	nonce: string;
	/** The job's pty host: the `pid` of its `list` record, the worker's parent. */
	ptyHostPid: number;
	daemonPid: number;
	daemonStart: string;
	/** `readlink /proc/<daemonPid>/exe` the preconditions read (an execve keeps pid + starttime). */
	daemonExe: string;
	/** Already `normalizeText`-ed and `validateText`-ed. */
	text: string;
}

export function inspectStdin(i: InspectInput): Buffer {
	return Buffer.from(
		JSON.stringify({
			mode: "inspect",
			pid: i.pid,
			short: i.short,
			...(i.configDir ? { configDir: i.configDir } : {}),
		}),
		"utf8",
	);
}

export function replyStdin(i: ReplyInput): Buffer {
	return Buffer.from(JSON.stringify({ mode: "reply", ...i }), "utf8");
}

// ── Outputs ─────────────────────────────────────────────────────────────────

/**
 * The six refusals the daemon documents in its reply handler: the line was
 * written and the daemon said it did NOT take it. Only these are `failed`.
 * Any other answer after the write — `{"ok":true}` without `op`, an unknown
 * code, a non-object — is `unknown-answer`: the text may have been taken, so
 * it is `uncertain` (audit round 1, S1), never "nothing was delivered".
 */
export const DAEMON_CODES = [
	"ENOJOB",
	"ERESPAWNING",
	"ENOREPLY",
	"ESKEW",
	"EAUTH",
	"EUNVERIFIED",
] as const;
/** Aborts BEFORE any byte of the reply was written: no effect. */
export const ABORT_CODES = [
	"stale-process",
	"stale-session",
	"stale-daemon",
	"stale-job",
	"busy",
	"waiting",
	"no-daemon",
	"no-key",
	"too-large",
	"too-large-file",
	"bad-input",
	"error",
] as const;

export type DaemonCode = (typeof DAEMON_CODES)[number];
export type AbortCode = (typeof ABORT_CODES)[number];

/**
 * What one reply exec told us. `accepted` = the daemon handed the text to
 * the worker (NOT delivered). `rejected` = the daemon refused it. `aborted`
 * = nothing was written. `unknown` = the line may have been written and no
 * answer is known (connection lost after writing, unparseable output, a
 * non-zero or unknown exit) — never treated as "not sent".
 */
export type ReplyOutcome =
	| { kind: "accepted" }
	| { kind: "rejected"; code: DaemonCode }
	| { kind: "aborted"; code: AbortCode }
	| { kind: "unknown"; why: string };

const LINE_RE = /^ST-BG ([A-Za-z-]+)\n?$/;

/** Parse a reply exec's stdout + its own inspect's exit code. */
export function parseReplyOutput(exitCode: number | null, stdout: string): ReplyOutcome {
	if (exitCode === null) return { kind: "unknown", why: "exit-unknown" };
	if (exitCode !== 0) return { kind: "unknown", why: `exit-${exitCode}` };
	if (Buffer.byteLength(stdout) > 256) return { kind: "unknown", why: "output-too-large" };
	const m = stdout.match(LINE_RE);
	if (!m) return { kind: "unknown", why: "output-invalid" };
	const code = m[1] as string;
	if (code === "ok") return { kind: "accepted" };
	if (code === "no-answer" || code === "unknown-answer") return { kind: "unknown", why: code };
	if ((DAEMON_CODES as readonly string[]).includes(code))
		return { kind: "rejected", code: code as DaemonCode };
	if ((ABORT_CODES as readonly string[]).includes(code))
		return { kind: "aborted", code: code as AbortCode };
	return { kind: "unknown", why: "output-invalid" };
}

export interface InspectResult {
	configDir: string;
	daemon: {
		statusPid: number | null;
		statusStart: string | null;
		rosterPid: number | null;
		peerPid: number | null;
		exe: string | null;
		start: string | null;
	};
	/** null = `list` unanswered; `absent` = no job with that short. */
	job:
		| null
		| { absent: true }
		| {
				absent?: undefined;
				short: string;
				nonce: string | null;
				pid: number | null;
				cliVersion: string | null;
				outcome: boolean;
				dying: boolean;
		  };
	worker: { ppid: number | null; start: string | null; exe: string | null };
	session: null | {
		sessionId: string | null;
		status: string | null;
		procStart: string | null;
		jobId: string | null;
		kind: string | null;
		waiting: boolean;
	};
}

const int = (v: unknown): number | null =>
	typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
	v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Strict parse of an inspect exec's stdout; null = no usable evidence. */
export function parseInspectOutput(exitCode: number | null, stdout: string): InspectResult | null {
	if (exitCode !== 0) return null;
	if (Buffer.byteLength(stdout) > 16 * 1024) return null;
	const m = stdout.match(/^ST-BG inspect (\{.*\})\n?$/);
	if (!m) return null;
	let j: Record<string, unknown> | null;
	try {
		j = obj(JSON.parse(m[1] as string));
	} catch {
		return null;
	}
	const d = obj(j?.daemon);
	const w = obj(j?.worker);
	const configDir = str(j?.configDir);
	if (!j || !d || !w || !configDir?.startsWith("/")) return null;
	const rawJob = j.job === null ? null : obj(j.job);
	if (j.job !== null && !rawJob) return null;
	let job: InspectResult["job"] = null;
	if (rawJob?.absent === true) job = { absent: true };
	else if (rawJob) {
		const short = str(rawJob.short);
		if (!short) return null;
		job = {
			short,
			nonce: str(rawJob.nonce),
			pid: int(rawJob.pid),
			cliVersion: str(rawJob.cliVersion),
			outcome: rawJob.outcome === true,
			dying: rawJob.dying === true,
		};
	}
	const s = j.session === null ? null : obj(j.session);
	if (j.session !== null && !s) return null;
	return {
		configDir,
		daemon: {
			statusPid: int(d.statusPid),
			statusStart: str(d.statusStart),
			rosterPid: int(d.rosterPid),
			peerPid: int(d.peerPid),
			exe: str(d.exe),
			start: str(d.start),
		},
		job,
		worker: { ppid: int(w.ppid), start: str(w.start), exe: str(w.exe) },
		session: s
			? {
					sessionId: str(s.sessionId),
					status: str(s.status),
					procStart: str(s.procStart),
					jobId: str(s.jobId),
					kind: str(s.kind),
					waiting: s.waiting === true,
				}
			: null,
	};
}

/**
 * The HTTP code an abort maps to (§8.1.12.4 step 5: "binding-stale o busy"),
 * the waiting form being `needs-terminal` as in §8.1.12.3; the rest are a
 * failure of our own transport with no effect.
 */
export function abortHttpCode(code: AbortCode): {
	status: number;
	error: string;
	detail?: string;
} {
	switch (code) {
		case "busy":
			return { status: 409, error: "busy", detail: "reread" };
		case "waiting":
			return { status: 409, error: "needs-terminal", detail: "reread" };
		case "stale-process":
		case "stale-session":
		case "stale-daemon":
		case "stale-job":
		case "no-daemon":
			return { status: 409, error: "binding-stale", detail: code };
		default:
			return { status: 502, error: "delivery-failed", detail: code };
	}
}

/**
 * Every identity the inspect read must agree with what the preconditions
 * verified (§8.1.12.4 steps 3–5). null = consistent; otherwise the refusal
 * (409, no effect). The session file is the job's own view of itself:
 * `sessionId = cid`, the same `procStart`, `jobId = short`, `kind: bg`.
 */
export function inspectFault(
	ins: InspectResult,
	q: { cid: string; short: string; start: string; exe: string },
): { error: "binding-stale" | "busy" | "needs-terminal"; detail: string } | null {
	const stale = (detail: string) => ({ error: "binding-stale" as const, detail });
	const s = ins.session;
	if (!s) return stale("session-file");
	if (s.sessionId !== q.cid) return stale("session-file:session-id");
	if (s.procStart !== q.start) return stale("session-file:start");
	if (s.jobId !== q.short) return stale("session-file:job");
	if (s.kind !== "bg") return stale("session-file:kind");
	const w = ins.worker;
	if (w.start !== q.start || w.exe !== q.exe || w.ppid === null) return stale("process");
	const d = ins.daemon;
	if (
		d.statusPid === null ||
		d.rosterPid !== d.statusPid ||
		d.peerPid !== d.statusPid ||
		d.statusStart === null ||
		d.start !== d.statusStart ||
		d.exe === null
	)
		return stale("daemon");
	const j = ins.job;
	if (!j || j.absent === true) return stale("job");
	if (!j.nonce || j.pid !== w.ppid || j.outcome || j.dying) return stale("job");
	if (s.waiting || s.status === "waiting")
		return { error: "needs-terminal", detail: "session-file" };
	if (s.status === "busy") return { error: "busy", detail: "session-file" };
	if (s.status !== "idle") return { error: "needs-terminal", detail: "status-unknown" };
	return null;
}
