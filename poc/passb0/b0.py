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
MAX_BODY = 4096
HEX = re.compile(r"^[0-9a-f]{1,32}$")
LABEL = re.compile(r"^[a-z0-9-]{1,16}$")
PATH = re.compile(r"^/[a-z0-9/_-]{0,31}$")


def errname(e):
    code = getattr(e, "errno", None)
    return errno.errorcode.get(code, type(e).__name__) if code else type(e).__name__


def write_json_atomic(path, obj):
    tmp = f"{path}.tmp{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(json.dumps(obj) + "\n")
        f.flush()
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


def peer_inode(local_ino):
    """Inode of the other end of a connected Unix socket, by sock_diag (UNIX_DIAG_PEER)."""
    req = struct.pack("=BBHIII2I", socket.AF_UNIX, 0, 0, 0xFFFFFFFF, local_ino, UDIAG_SHOW_PEER, 0xFFFFFFFF, 0xFFFFFFFF)
    hdr = struct.pack("=IHHII", 16 + len(req), SOCK_DIAG_BY_FAMILY, NLM_F_REQUEST, 1, 0)
    with socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, NETLINK_SOCK_DIAG) as s:
        s.settimeout(2)
        s.sendto(hdr + req, (0, 0))
        data = s.recv(8192)
    length, mtype = struct.unpack_from("=IH", data, 0)
    if mtype == NLMSG_ERROR:
        raise OSError(-struct.unpack_from("=i", data, 16)[0], "sock_diag")
    off = 16 + 16  # nlmsghdr + unix_diag_msg
    while off + 4 <= length:
        rta_len, rta_type = struct.unpack_from("=HH", data, off)
        if rta_len < 4:
            break
        if rta_type == UNIX_DIAG_PEER:
            return struct.unpack_from("=I", data, off + 4)[0]
        off += (rta_len + 3) & ~3
    return None


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
                write_json_atomic(self.held, {"scope": self.scope, "conn": rec["conn"], "peer_ino": rec.get("peer_ino"), "t_ms": int(time.time() * 1000)})
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

def wait_held(held, after_ms=0, wait_ms=8000):
    deadline = time.monotonic() + wait_ms / 1000
    while time.monotonic() < deadline:
        try:
            with open(held, encoding="utf-8") as f:
                h = json.loads(f.read())
            if isinstance(h, dict) and isinstance(h.get("t_ms"), int) and h["t_ms"] >= after_ms:
                return h
        except (OSError, json.JSONDecodeError):
            pass
        time.sleep(0.05)
    return None


def fdcheck(held, after_ms=0, wait_ms=8000):
    # Read our own fds before anything else: an inherited fd is open at exec, and
    # this process opens no socket of its own before this line.
    own = set(socket_inodes_of("self").values())
    out = {"self_pid": os.getpid(), "self_ppid": os.getppid(), "own_socket_count": len(own)}
    h = wait_held(held, after_ms, wait_ms)
    out["waited"] = h is not None
    if h is None:
        return out
    out["held_conn"] = h.get("conn")
    peer = h.get("peer_ino")
    out["peer_known"] = isinstance(peer, int)
    if not out["peer_known"]:
        return out
    # Inherited fds are already open at exec, so "own" read at start is the inheritance result.
    out["peer_in_self"] = peer in own
    holders, denied = [], 0
    for d in os.listdir("/proc"):
        if not d.isdigit() or int(d) == os.getpid():
            continue
        try:
            for fd, ino in socket_inodes_of(d).items():
                if ino == peer:
                    holders.append({"pid": int(d), "fd": fd, "cloexec": fd_cloexec(d, fd)})
        except PermissionError:
            denied += 1
        except (FileNotFoundError, ProcessLookupError):
            pass
    out["holders"] = holders
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
        print(json.dumps({"listening": True, "scope": a.scope, "pid": os.getpid()}), flush=True)
        srv.serve(a.deadline_s)
    elif a.cmd == "waitheld":
        h = wait_held(a.held, a.after_ms, a.wait_ms)
        print(json.dumps({"waited": h is not None, "held_conn": (h or {}).get("conn")}))
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


if __name__ == "__main__":
    main()
