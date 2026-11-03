#!/usr/bin/env python3
"""PASS-B0 measurement tools (04-poc.md §1.14.6). Standard library only, one file,
because `python3 -I` does not put the script's directory on sys.path.

    b0.py server  --scope container|host --sock PATH --out DIR --held PATH
                  [--expect-container ID] [--hold-ms N] [--deadline-s N] [--max-conns N]
    b0.py waitheld --held PATH [--after-ms T] [--wait-ms N]
    b0.py fdcheck --held PATH [--after-ms T] [--wait-ms N]
    b0.py client  --sock PATH --label base|control [--held PATH] [--out FILE]
    b0.py rocheck --dir DIR [--out FILE]
    b0.py cliinfo [--out FILE]
    b0.py stop    --identity FILE [--timeout-s N]
    b0.py imageversion            (reads `docker image history --no-trunc` text on stdin)
    b0.py checklimits INSPECT_JSON STAMP KIT RUN
    b0.py manifest RESULTS_DIR name=status...

Records hold facts only: pids, uids, inode numbers, booleans, hashes and error
classes. Nothing here reads a process's environment or command line, a prompt,
or a credential; the one config value read is the cached mods flag (cliinfo).
"""
import argparse
import errno
import hashlib
import json
import os
import re
import secrets
import select
import signal
import socket
import struct
import sys
import threading
import time

SO_PEERPIDFD = 77  # Linux >= 6.5; not in Python's socket module
O_CLOEXEC = 0o2000000
NETLINK_SOCK_DIAG = 4
SOCK_DIAG_BY_FAMILY = 20
NLM_F_REQUEST = 1
NLMSG_ERROR = 2
UDIAG_SHOW_PEER = 0x4
UNIX_DIAG_PEER = 2
TCP_ESTABLISHED = 1  # udiag_state of a connected stream socket
MAX_BODY = 4096
HEX = re.compile(r"^[0-9a-f]{1,32}$")
LABEL = re.compile(r"^[a-z0-9-]{1,16}$")
PATH = re.compile(r"^/[a-z0-9/_-]{0,31}$")


def errname(e):
    code = getattr(e, "errno", None)
    return errno.errorcode.get(code, type(e).__name__) if code else type(e).__name__


def write_json_atomic(path, obj, mode=None):
    tmp = f"{path}.tmp{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(json.dumps(obj) + "\n")
        f.flush()
        if mode is not None:
            os.fchmod(f.fileno(), mode)
        os.fsync(f.fileno())
    os.replace(tmp, path)


# ── /proc facts ───────────────────────────────────────────────────────────

def read_status(pid, proc="/proc"):
    """Tgid, PPid, NSpid, TracerPid and the real uid from /proc/<pid>/status."""
    out = {}
    with open(f"{proc}/{pid}/status", encoding="utf-8") as f:
        for line in f:
            k, _, v = line.partition(":")
            v = v.split()
            if k in ("Tgid", "PPid", "TracerPid") and v:
                out[k.lower()] = int(v[0])
            elif k == "NSpid":
                out["nspid"] = [int(x) for x in v]
            elif k == "Uid" and v:
                out["uid"] = int(v[0])
    return out


def read_starttime(pid, proc="/proc"):
    # Field 22; comm (field 2) may contain spaces or parentheses, so split after the last ')'.
    with open(f"{proc}/{pid}/stat", encoding="utf-8") as f:
        rest = f.read().rsplit(")", 1)[1].split()
    return int(rest[19])


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def boot_id():
    with open("/proc/sys/kernel/random/boot_id", encoding="utf-8") as f:
        return f.read().strip()


def proc_facts(pid, expect_container=None, hash_exe=True):
    facts = {}
    try:
        facts.update(read_status(pid))
        facts["starttime"] = read_starttime(pid)
        with open(f"/proc/{pid}/comm", encoding="utf-8") as f:
            facts["comm"] = re.sub(r"[^A-Za-z0-9._-]", "?", f.read().strip())[:16]
    except OSError as e:
        facts["status_error"] = errname(e)
    try:
        exe = os.readlink(f"/proc/{pid}/exe")
        facts["exe_name"] = os.path.basename(exe.removesuffix(" (deleted)"))[:32]
        facts["exe_deleted"] = exe.endswith(" (deleted)")
        if hash_exe:
            # Hash through /proc/<pid>/exe: the inode the process runs, even if the path was replaced.
            facts["exe_sha256"] = sha256_file(f"/proc/{pid}/exe")
    except OSError as e:
        facts["exe_error"] = errname(e)  # another uid without CAP_SYS_PTRACE: expected on the host
    if expect_container is not None:
        try:
            with open(f"/proc/{pid}/cgroup", encoding="utf-8") as f:
                facts["cgroup_match"] = expect_container in f.read()
        except OSError as e:
            facts["cgroup_error"] = errname(e)
    return facts


def pidfd_info(fd):
    """Pid and NSpid of the process a pidfd refers to, as this reader's namespace sees it."""
    out = {}
    with open(f"/proc/self/fdinfo/{fd}", encoding="utf-8") as f:
        for line in f:
            k, _, v = line.partition(":")
            if k == "Pid":
                out["pid"] = int(v.split()[0])
            elif k == "NSpid":
                out["nspid"] = [int(x) for x in v.split()]
    return out


def unix_diag(ino):
    """sock_diag's answer for one Unix socket inode: {ino, type, state, peer}.

    The kernel looks the inode up only among the sockets of the CALLER's network namespace
    (unix_diag_get_exact → unix_lookup_by_ino(sock_net(in_skb->sk), …)), and the socket
    accept() returns is created in the CONNECTING process's namespace (unix_stream_connect →
    unix_create1(sock_net(sk), …)). So the host server cannot see its own accepted end of a
    connection from the container (ENOENT; VM100 run 2), while a process in the container can.
    """
    req = struct.pack("=BBHIII2I", socket.AF_UNIX, 0, 0, 0xFFFFFFFF, ino, UDIAG_SHOW_PEER, 0xFFFFFFFF, 0xFFFFFFFF)
    hdr = struct.pack("=IHHII", 16 + len(req), SOCK_DIAG_BY_FAMILY, NLM_F_REQUEST, 1, 0)
    with socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, NETLINK_SOCK_DIAG) as s:
        s.settimeout(2)
        s.sendto(hdr + req, (0, 0))
        data = s.recv(8192)
    length, mtype = struct.unpack_from("=IH", data, 0)
    if mtype == NLMSG_ERROR:
        raise OSError(-struct.unpack_from("=i", data, 16)[0], "sock_diag")
    if mtype != SOCK_DIAG_BY_FAMILY or length < 32:
        raise OSError(errno.EPROTO, "sock_diag")
    family, stype, state, _, got = struct.unpack_from("=BBBBI", data, 16)
    if family != socket.AF_UNIX or got != ino:
        raise OSError(errno.EPROTO, "sock_diag")
    out = {"ino": got, "type": stype, "state": state, "peer": None}
    off = 16 + 16  # nlmsghdr + unix_diag_msg
    while off + 4 <= length:
        rta_len, rta_type = struct.unpack_from("=HH", data, off)
        if rta_len < 4:
            break
        if rta_type == UNIX_DIAG_PEER:
            out["peer"] = struct.unpack_from("=I", data, off + 4)[0]
        off += (rta_len + 3) & ~3
    return out


def peer_inode(local_ino):
    """Inode of the other end of a connected Unix socket, by sock_diag (UNIX_DIAG_PEER)."""
    return unix_diag(local_ino)["peer"]


def peer_from_accepted(local_ino, server_peer=None):
    """The client's end of the connection whose ACCEPTED end is local_ino, proved from this
    process's network namespace, or None. `diag` says what was established.

    The inode comes from the held file, so nothing about it is taken on trust: the socket must
    be a connected stream socket, its peer must name it back (a closed client leaves a peer
    that no longer resolves), and when the server could read the peer itself the two must agree.
    """
    diag = {"found": False, "error": None, "stream_established": False, "mutual": False, "server_agrees": None}
    if type(local_ino) is not int or not 0 < local_ino < 2 ** 32:
        diag["error"] = "no-local-ino"
        return None, diag
    try:
        a = unix_diag(local_ino)
        diag["found"] = True
        diag["stream_established"] = a["type"] == socket.SOCK_STREAM and a["state"] == TCP_ESTABLISHED
        peer = a["peer"]
        if not diag["stream_established"] or not peer:
            return None, diag
        b = unix_diag(peer)
        diag["mutual"] = b["peer"] == local_ino and b["type"] == socket.SOCK_STREAM and b["state"] == TCP_ESTABLISHED
    except OSError as e:
        diag["error"] = errname(e)
        return None, diag
    if server_peer is not None:
        diag["server_agrees"] = server_peer == peer
    if not diag["mutual"] or diag["server_agrees"] is False:
        return None, diag
    return peer, diag


def socket_inodes_of(pid):
    """{fd: inode} of every socket fd of pid. Raises PermissionError when not readable."""
    out = {}
    for fd in os.listdir(f"/proc/{pid}/fd"):
        try:
            m = re.match(r"^socket:\[(\d+)\]$", os.readlink(f"/proc/{pid}/fd/{fd}"))
        except FileNotFoundError:
            continue
        if m:
            out[int(fd)] = int(m.group(1))
    return out


def fd_cloexec(pid, fd):
    with open(f"/proc/{pid}/fdinfo/{fd}", encoding="utf-8") as f:
        for line in f:
            if line.startswith("flags:"):
                return bool(int(line.split()[1], 8) & O_CLOEXEC)
    return None


# ── server ────────────────────────────────────────────────────────────────

def read_request(conn):
    conn.settimeout(10)
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = conn.recv(1024)
        if not chunk:
            raise ValueError("eof-in-headers")
        buf += chunk
        if len(buf) > 8192:
            raise ValueError("headers-too-large")
    head, _, body = buf.partition(b"\r\n\r\n")
    lines = head.decode("latin-1").split("\r\n")
    parts = lines[0].split(" ")
    if len(parts) != 3:
        raise ValueError("bad-request-line")
    method, path = parts[0], parts[1]
    clen = 0
    for h in lines[1:]:
        k, _, v = h.partition(":")
        if k.strip().lower() == "content-length":
            clen = int(v.strip())
    if clen < 0 or clen > MAX_BODY:
        raise ValueError("body-too-large")
    while len(body) < clen:
        chunk = conn.recv(clen - len(body))
        if not chunk:
            raise ValueError("eof-in-body")
        body += chunk
    return method, path, body[:clen]


def parse_body(raw):
    try:
        b = json.loads(raw.decode("utf-8")) if raw else {}
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {"body_error": "not-json"}
    if not isinstance(b, dict):
        return {"body_error": "not-object"}
    out = {}
    if isinstance(b.get("label"), str) and LABEL.match(b["label"]):
        out["label"] = b["label"]
    if isinstance(b.get("nonce"), str) and HEX.match(b["nonce"]):
        out["nonce"] = b["nonce"]
    if isinstance(b.get("self_pid"), int) and not isinstance(b["self_pid"], bool):
        out["self_pid"] = b["self_pid"]
    return out


def respond(conn, status, obj):
    body = json.dumps(obj).encode()
    reason = {200: "OK", 400: "Bad Request", 404: "Not Found"}.get(status, "Error")
    conn.sendall(f"HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body)


class Server:
    def __init__(self, scope, sock, out, held, expect_container=None, hold_ms=8000, max_conns=64, hash_exe=True):
        self.scope, self.sock, self.held = scope, sock, held
        self.expect_container, self.hold_ms, self.max_conns, self.hash_exe = expect_container, hold_ms, max_conns, hash_exe
        os.makedirs(out, exist_ok=True)
        self.out = os.path.join(out, f"{'c' if scope == 'container' else 'h'}.jsonl")
        self.lock = threading.Lock()
        self.count = 0
        self.stop = threading.Event()
        self.listener = None

    def identity(self):
        """What `stop` must find before it signals this process: pid alone can be reused."""
        with open("/proc/self/cmdline", "rb") as f:
            argv_sha = hashlib.sha256(f.read()).hexdigest()
        return {"pid": os.getpid(), "starttime": read_starttime(os.getpid()), "boot_id": boot_id(),
                "uid": os.getuid(), "argv_sha256": argv_sha, "sock": self.sock}

    def open(self):
        if os.path.lexists(self.sock):
            raise SystemExit(f"refusing: {self.sock} already exists")
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(self.sock)
        # Connecting needs write permission on the socket inode; the CLI runs as another uid on the host side.
        os.chmod(self.sock, 0o666)
        self.listener.listen(16)
        self.listener.settimeout(0.5)

    def record(self, rec):
        with self.lock:
            with open(self.out, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec) + "\n")
                f.flush()
                os.fsync(f.fileno())

    def handle(self, conn, n):
        rec = {"t_ms": int(time.time() * 1000), "scope": self.scope, "n": n}
        try:
            # Credentials first: SO_PEERCRED is fixed at connect(); the pidfd pins that process.
            pid, uid, gid = struct.unpack("3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
            rec["cred"] = {"pid": pid, "uid": uid, "gid": gid}
            pidfd = None
            try:
                pidfd = conn.getsockopt(socket.SOL_SOCKET, SO_PEERPIDFD)
                rec["pidfd"] = {"ok": True, **pidfd_info(pidfd)}
            except OSError as e:
                rec["pidfd"] = {"ok": False, "error": errname(e)}
            rec["local_ino"] = os.fstat(conn.fileno()).st_ino
            try:
                rec["peer_ino"] = peer_inode(rec["local_ino"])
            except OSError as e:
                rec["peer_ino_error"] = errname(e)
            rec["proc"] = proc_facts(pid, self.expect_container, self.hash_exe) if pid > 0 else {"status_error": "pid-not-visible"}
            try:
                rec["proc"]["stable"] = read_starttime(pid) == rec["proc"].get("starttime")
            except OSError:
                rec["proc"]["stable"] = False
            if pidfd is not None:
                rec["pidfd"]["alive_after"] = pidfd_info(pidfd).get("pid", -1) > 0
                os.close(pidfd)
            method, path, raw = read_request(conn)
            rec["method"] = method if method in ("GET", "POST") else "other"
            rec["path"] = path if PATH.match(path) else "invalid"
            rec.update(parse_body(raw))
            rec["conn"] = secrets.token_hex(8)
            if rec["path"] == "/hold":
                # The reader is the checker in the container, uid 1000, which need not be this
                # process's uid, and the runner's umask 077 would make the file 0600: set the
                # mode explicitly, as open() did for the socket. It holds no secret.
                # local_ino: the checker resolves the peer from it in its own namespace
                # (unix_diag), since this server cannot when the client is in another one.
                write_json_atomic(self.held, {"scope": self.scope, "conn": rec["conn"], "local_ino": rec["local_ino"],
                                              "peer_ino": rec.get("peer_ino"), "t_ms": int(time.time() * 1000)}, mode=0o644)
                self.stop.wait(self.hold_ms / 1000)
            respond(conn, 200, {"conn": rec["conn"], "scope": self.scope})
            rec["status"] = 200
        except (ValueError, UnicodeDecodeError) as e:
            rec["status"] = 400
            rec["error"] = str(e)[:40] if isinstance(e, ValueError) else "decode"
            try:
                respond(conn, 400, {"error": rec["error"]})
            except OSError:
                pass
        except OSError as e:
            rec["error"] = errname(e)
        finally:
            conn.close()
            self.record(rec)

    def serve(self, deadline_s=1800):
        end = time.monotonic() + deadline_s
        threads = []
        try:
            while not self.stop.is_set() and time.monotonic() < end and self.count < self.max_conns:
                try:
                    conn, _ = self.listener.accept()
                except TimeoutError:
                    continue
                self.count += 1
                t = threading.Thread(target=self.handle, args=(conn, self.count), daemon=True)
                t.start()
                threads.append(t)
        finally:
            self.listener.close()
            for t in threads:
                t.join(timeout=self.hold_ms / 1000 + 15)
            # The socket file is ours: remove it so a stale path never answers as if we listened.
            try:
                os.unlink(self.sock)
            except FileNotFoundError:
                pass


# ── fdcheck: what a child of the caller actually holds ────────────────────

def wait_held(held, after_ms=0, wait_ms=8000, why=None):
    """The held file written after after_ms, or None. `why` (a dict) receives the reason
    of the last failed read, so a checker that never synchronized says why."""
    deadline = time.monotonic() + wait_ms / 1000
    last = "none"
    while time.monotonic() < deadline:
        try:
            with open(held, encoding="utf-8") as f:
                h = json.loads(f.read())
            if isinstance(h, dict) and isinstance(h.get("t_ms"), int) and h["t_ms"] >= after_ms:
                return h
            last = "stale" if isinstance(h, dict) else "not-object"
        except OSError as e:
            last = errname(e)
        except json.JSONDecodeError:
            last = "not-json"
        time.sleep(0.05)
    if why is not None:
        why["held_last_error"] = last
    return None


def fdcheck(held, after_ms=0, wait_ms=8000):
    # Read our own fds before anything else: an inherited fd is open at exec, and
    # this process opens no socket of its own before this line.
    own = set(socket_inodes_of("self").values())
    out = {"self_pid": os.getpid(), "self_ppid": os.getppid(), "own_socket_count": len(own)}
    h = wait_held(held, after_ms, wait_ms, out)
    out["waited"] = h is not None
    if h is None:
        return out
    out["held_conn"] = h.get("conn")
    local = h.get("local_ino")
    out["local_ino"] = local if type(local) is int else None
    server_peer = h.get("peer_ino") if type(h.get("peer_ino")) is int else None
    peer, out["diag"] = peer_from_accepted(local, server_peer)
    out["peer_known"] = peer is not None
    if not out["peer_known"]:
        return out
    # Inherited fds are already open at exec, so "own" read at start is the inheritance result.
    out["peer_in_self"] = peer in own
    holders, local_holders, denied = [], [], 0
    for d in os.listdir("/proc"):
        if not d.isdigit() or int(d) == os.getpid():
            continue
        try:
            for fd, ino in socket_inodes_of(d).items():
                if ino == peer:
                    holders.append({"pid": int(d), "fd": fd, "cloexec": fd_cloexec(d, fd)})
                elif ino == local:
                    # Who holds the ACCEPTED end in this pid namespace: nobody for the host
                    # server's connection, so anyone here means the inode is not that connection.
                    local_holders.append(int(d))
        except PermissionError:
            denied += 1
        except (FileNotFoundError, ProcessLookupError):
            pass
    out["holders"] = holders
    out["local_holder_pids"] = sorted(set(local_holders))
    out["scan_denied"] = denied
    return out


# ── client: baseline and inheritance control ──────────────────────────────

def client(sock_path, label, held=None):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect(sock_path)
    out = {"label": label, "self_pid": os.getpid(), "nonce": secrets.token_hex(8)}
    body = json.dumps({"label": label, "nonce": out["nonce"], "self_pid": out["self_pid"]}).encode()
    path = "/hold" if label == "control" else f"/{label}"
    t0 = int(time.time() * 1000)
    s.sendall(f"POST {path} HTTP/1.1\r\nHost: passb0\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body)
    if label == "control":
        # Positive control: hand the connection to a child ON PURPOSE. If fdcheck does
        # not report it as inherited, fdcheck cannot be trusted to report the CLI's case.
        import subprocess
        os.set_inheritable(s.fileno(), True)
        r = subprocess.run([sys.executable, "-I", os.path.abspath(__file__), "fdcheck", "--held", held, "--after-ms", str(t0)],
                           pass_fds=(s.fileno(),), capture_output=True, timeout=30)
        try:
            out["child"] = json.loads(r.stdout)
        except json.JSONDecodeError:
            out["child"] = {"error": "unparsable"}
    data = b""
    s.settimeout(30)
    while True:
        chunk = s.recv(4096)
        if not chunk:
            break
        data += chunk
    s.close()
    head, _, body = data.partition(b"\r\n\r\n")
    out["status"] = int(head.split(b" ")[1]) if head.startswith(b"HTTP/1.1 ") else None
    try:
        conn = json.loads(body).get("conn")
        out["conn"] = conn if isinstance(conn, str) and HEX.match(conn) else None
    except json.JSONDecodeError:
        out["conn"] = None
    return out


# ── rocheck: can the experiment's uid change the socket directory? ────────

def rocheck(d):
    res = {}
    probe = os.path.join(d, "rocheck-probe")

    def attempt(name, fn, undo=None):
        try:
            fn()
            res[name] = "succeeded"
            if undo:
                try:
                    undo()
                except OSError:
                    pass
        except OSError as e:
            res[name] = errname(e)

    attempt("create", lambda: os.close(os.open(probe, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)), lambda: os.unlink(probe))
    attempt("mkdir", lambda: os.mkdir(probe + "-d"), lambda: os.rmdir(probe + "-d"))
    sock = os.path.join(d, "h.sock")
    attempt("rename", lambda: os.rename(sock, sock + ".x"), lambda: os.rename(sock + ".x", sock))
    attempt("unlink", lambda: os.unlink(sock))  # last: if it succeeds nothing can undo it, and that is a FAIL
    return res


# ── cliinfo: the CLI processes of this container ──────────────────────────

def cliinfo():
    procs = []
    for d in os.listdir("/proc"):
        if not d.isdigit():
            continue
        try:
            exe = os.readlink(f"/proc/{d}/exe")
        except OSError:
            continue
        base = os.path.basename(exe.removesuffix(" (deleted)"))
        if base in ("claude", "claude.exe") or "/@anthropic-ai/claude-code" in exe:
            f = proc_facts(int(d))
            procs.append({"pid": int(d), **{k: f.get(k) for k in ("tgid", "ppid", "starttime", "uid", "tracerpid", "exe_name", "exe_sha256", "exe_deleted")}})
    flag = "absent"
    try:
        with open(os.path.expanduser("~/.claude.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        feats = cfg.get("cachedGrowthBookFeatures") if isinstance(cfg, dict) else None
        if isinstance(feats, dict) and "tengu_plugin_hooks_modules" in feats:
            v = feats["tengu_plugin_hooks_modules"]
            flag = v if isinstance(v, bool) else "other"
    except (OSError, json.JSONDecodeError):
        flag = "unreadable"
    return {"cli": procs, "mods_flag_cached": flag}


# ── stop: signal the host server only if it is provably the same process ──

def stop(identity_path, timeout_s=10):
    """SIGTERM the server named by its identity file, through a pidfd.

    The pidfd is opened FIRST and the identity is checked AFTER: if the pid had been
    reused before the open, the starttime (or cmdline) differs and nothing is sent;
    if it is reused after the open, the pidfd still names the original process, which
    the kernel never confuses with the new one. Idempotent: a server already gone is
    `already-exited`, never an error and never a signal.
    """
    with open(identity_path, encoding="utf-8") as f:
        ident = json.load(f)
    pid = ident.get("pid")
    if not isinstance(pid, int) or pid <= 1:
        return {"result": "refused", "why": "bad-identity"}
    if ident.get("boot_id") != boot_id():
        return {"result": "already-exited", "why": "rebooted"}
    try:
        pidfd = os.pidfd_open(pid)
    except ProcessLookupError:
        return {"result": "already-exited"}
    try:
        try:
            same = read_starttime(pid) == ident.get("starttime")
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                same = same and hashlib.sha256(f.read()).hexdigest() == ident.get("argv_sha256")
            same = same and read_status(pid).get("uid") == ident.get("uid") == os.getuid()
        except (FileNotFoundError, ProcessLookupError):
            return {"result": "already-exited"}
        if not same:
            return {"result": "refused", "why": "identity-mismatch"}
        try:
            signal.pidfd_send_signal(pidfd, signal.SIGTERM)
        except ProcessLookupError:
            return {"result": "already-exited"}
        # A pidfd becomes readable when its process exits.
        exited = bool(select.select([pidfd], [], [], timeout_s)[0])
        return {"result": "stopped" if exited else "still-running", "sock_removed": not os.path.lexists(ident.get("sock", ""))}
    finally:
        os.close(pidfd)


# ── imageversion: the CLI version an image was built with, read-only ──────

def image_version(history_text):
    """From `docker image history --no-trunc --format '{{.CreatedBy}}'`: the build-arg value
    of the ONE layer that npm-installs @anthropic-ai/claude-code. Anything else (no such
    layer, two of them, a version not spelled in the layer) is `null`: unknown stops B0."""
    layers = [l for l in history_text.splitlines() if "npm install -g" in l and "@anthropic-ai/claude-code" in l]
    found = set()
    for l in layers:
        m = re.search(r"CLAUDE_CODE_VERSION=(\d+\.\d+\.\d+)\b", l) or re.search(r"@anthropic-ai/claude-code@(\d+\.\d+\.\d+)\b", l)
        found.add(m.group(1) if m else None)
    version = next(iter(found)) if len(layers) == 1 and len(found) == 1 else None
    return {"version": version, "install_layers": len(layers)}


# ── checklimits: what Docker applied to the experiment container ──────────

GIB2 = 2 * 1024 ** 3


def check_limits(inspect, stamp, kit, run):
    """Every reason the container differs from the procedure; [] means exactly as asked."""
    c = inspect[0] if isinstance(inspect, list) and len(inspect) == 1 else {}
    cfg, hc = c.get("Config") or {}, c.get("HostConfig") or {}
    bad = []

    def want(cond, why):
        if not cond:
            bad.append(why)

    want((cfg.get("Labels") or {}).get("passb0.experiment") == stamp, "label")
    want(cfg.get("User") == "developer", "user")
    want(hc.get("Memory") == GIB2 and hc.get("MemorySwap") == GIB2, "memory")
    want(hc.get("NanoCpus") == 10 ** 9, "cpus")
    want(hc.get("PidsLimit") == 256, "pids")
    want("ALL" in (hc.get("CapDrop") or []) and not hc.get("CapAdd"), "capabilities")
    want("no-new-privileges:true" in (hc.get("SecurityOpt") or []), "no-new-privileges")
    want(hc.get("Privileged") is False, "privileged")
    want(hc.get("NetworkMode") == "bridge", "network")
    want((hc.get("RestartPolicy") or {}).get("Name") in ("no", ""), "restart")
    want(hc.get("PidMode", "") == "" and hc.get("IpcMode", "private") in ("private", "shareable", "") and hc.get("UTSMode", "") == "", "namespaces")
    want(not hc.get("Binds") and not hc.get("Devices") and not hc.get("VolumesFrom"), "binds-devices")
    mounts = sorted((m.get("Type"), m.get("Source"), m.get("Destination"), m.get("RW")) for m in c.get("Mounts") or [])
    want(mounts == sorted([("bind", kit, "/opt/passb0-kit", False), ("bind", run, "/run/st-attest", False)]), "mounts")
    want(not any("docker.sock" in str(m) for m in c.get("Mounts") or []), "docker-sock")
    return bad


# ── manifest: what capture actually brought back ──────────────────────────

EXPECTED_FILES = ("c.jsonl", "h.jsonl", "cliinfo.json", "base-c.json", "base-h.json", "control-c.json",
                  "rocheck.json", "claude-debug.log", "measure.json", "preflight.json", "held-h.json",
                  "cli-version-before.json", "cli-version-after.json")


def manifest(res, items):
    parsed = {}
    for it in items:
        name, _, status = it.partition("=")
        parsed[name] = status
    files = {f: os.path.isfile(os.path.join(res, f)) for f in EXPECTED_FILES}
    mod_dir = os.path.join(res, "mod")
    mod_files = len([f for f in os.listdir(mod_dir) if f.endswith(".json")]) if os.path.isdir(mod_dir) else 0
    complete = all(s == "ok" for s in parsed.values()) and all(files.values()) and mod_files > 0
    m = {"items": parsed, "files": files, "mod_files": mod_files, "complete": complete}
    write_json_atomic(os.path.join(res, "capture-manifest.json"), m)
    return m


def emit(obj, out):
    if out:
        write_json_atomic(out, obj)
    print(json.dumps(obj))


def main(argv=None):
    p = argparse.ArgumentParser(prog="b0.py")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("server")
    s.add_argument("--scope", choices=("container", "host"), required=True)
    s.add_argument("--sock", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--held", required=True)
    s.add_argument("--expect-container")
    s.add_argument("--hold-ms", type=int, default=8000)
    s.add_argument("--deadline-s", type=int, default=1800)
    s.add_argument("--max-conns", type=int, default=64)
    s.add_argument("--no-hash-exe", action="store_true")
    s.add_argument("--identity")
    st = sub.add_parser("stop")
    st.add_argument("--identity", required=True)
    st.add_argument("--timeout-s", type=int, default=10)
    sub.add_parser("imageversion")
    cl = sub.add_parser("checklimits")
    cl.add_argument("inspect")
    cl.add_argument("stamp")
    cl.add_argument("kit")
    cl.add_argument("run")
    mf = sub.add_parser("manifest")
    mf.add_argument("res")
    mf.add_argument("items", nargs="*")
    w = sub.add_parser("waitheld")
    w.add_argument("--held", required=True)
    w.add_argument("--after-ms", type=int, default=0)
    w.add_argument("--wait-ms", type=int, default=8000)
    f = sub.add_parser("fdcheck")
    f.add_argument("--held", required=True)
    f.add_argument("--after-ms", type=int, default=0)
    f.add_argument("--wait-ms", type=int, default=8000)
    c = sub.add_parser("client")
    c.add_argument("--sock", required=True)
    c.add_argument("--label", choices=("base", "control"), required=True)
    c.add_argument("--held")
    c.add_argument("--out")
    r = sub.add_parser("rocheck")
    r.add_argument("--dir", required=True)
    r.add_argument("--out")
    i = sub.add_parser("cliinfo")
    i.add_argument("--out")
    a = p.parse_args(argv)
    if a.cmd == "server":
        if a.scope == "host" and not a.expect_container:
            p.error("--scope host needs --expect-container")
        srv = Server(a.scope, a.sock, a.out, a.held, a.expect_container, a.hold_ms, a.max_conns, not a.no_hash_exe)
        srv.open()
        # SIGTERM ends the accept loop, so serve()'s finally removes the socket file.
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, lambda *_: srv.stop.set())
        if a.identity:
            write_json_atomic(a.identity, srv.identity())
        print(json.dumps({"listening": True, "scope": a.scope, "pid": os.getpid()}), flush=True)
        srv.serve(a.deadline_s)
    elif a.cmd == "waitheld":
        why = {}
        h = wait_held(a.held, a.after_ms, a.wait_ms, why)
        print(json.dumps({"waited": h is not None, "held_conn": (h or {}).get("conn"), **why}))
    elif a.cmd == "fdcheck":
        print(json.dumps(fdcheck(a.held, a.after_ms, a.wait_ms)))
    elif a.cmd == "client":
        if a.label == "control" and not a.held:
            p.error("--label control needs --held")
        emit(client(a.sock, a.label, a.held), a.out)
    elif a.cmd == "rocheck":
        emit(rocheck(a.dir), a.out)
    elif a.cmd == "cliinfo":
        emit(cliinfo(), a.out)
    elif a.cmd == "stop":
        r = stop(a.identity, a.timeout_s)
        print(json.dumps(r))
        sys.exit(0 if r["result"] in ("stopped", "already-exited") else 1)
    elif a.cmd == "checklimits":
        with open(a.inspect, encoding="utf-8") as f:
            bad = check_limits(json.load(f), a.stamp, a.kit, a.run)
        print(json.dumps({"ok": not bad, "differs": bad}))
        sys.exit(0 if not bad else 1)
    elif a.cmd == "manifest":
        print(json.dumps(manifest(a.res, a.items)))
    elif a.cmd == "imageversion":
        r = image_version(sys.stdin.read())
        print(json.dumps(r))
        sys.exit(0 if r["version"] else 1)


if __name__ == "__main__":
    main()
