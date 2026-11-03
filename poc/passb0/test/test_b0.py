"""Synthetic tests of b0.py on real local Unix sockets (no CLI, no Docker).
Run: python3 -m unittest discover -s test -t ."""
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import b0  # noqa: E402

B0 = os.path.join(os.path.dirname(HERE), "b0.py")


def pidfd_supported():
    a, b = socket.socketpair()
    try:
        os.close(a.getsockopt(socket.SOL_SOCKET, b0.SO_PEERPIDFD))
        return True
    except OSError:
        return False
    finally:
        a.close()
        b.close()


class ServerCase(unittest.TestCase):
    scope = "container"
    expect = None

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="passb0-")
        self.sock = os.path.join(self.dir, "s.sock")
        self.held = os.path.join(self.dir, "held.json")
        self.srv = b0.Server(self.scope, self.sock, os.path.join(self.dir, "out"), self.held, self.expect, hold_ms=1500)
        self.srv.open()
        self.t = threading.Thread(target=self.srv.serve, args=(60,), daemon=True)
        self.t.start()

    def tearDown(self):
        self.srv.stop.set()
        self.t.join(timeout=20)

    def records(self, n, timeout=10):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            try:
                with open(self.srv.out) as f:
                    rows = [json.loads(l) for l in f if l.strip()]
                if len(rows) >= n:
                    return rows
            except FileNotFoundError:
                pass
            time.sleep(0.05)
        self.fail(f"expected {n} records")

    def request(self, s, path="/c1", body=None):
        body = json.dumps(body if body is not None else {"label": "c1", "nonce": "ab12"}).encode()
        s.sendall(f"POST {path} HTTP/1.1\r\nHost: x\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body)

    def read_all(self, s):
        data = b""
        while True:
            c = s.recv(4096)
            if not c:
                return data
            data += c


class ContainerScope(ServerCase):
    def test_peer_credentials_are_this_process(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(self.sock)
        my_ino = os.fstat(s.fileno()).st_ino
        self.request(s)
        resp = self.read_all(s)
        s.close()
        r = self.records(1)[0]
        self.assertTrue(resp.startswith(b"HTTP/1.1 200"))
        self.assertEqual(r["cred"]["pid"], os.getpid())
        self.assertEqual(r["cred"]["uid"], os.getuid())
        self.assertEqual(r["proc"]["tgid"], os.getpid())
        self.assertTrue(r["proc"]["stable"])
        self.assertEqual(r["peer_ino"], my_ino, "sock_diag must name the client's end")
        self.assertEqual(r["label"], "c1")
        self.assertEqual(r["nonce"], "ab12")
        self.assertRegex(r["conn"], r"^[0-9a-f]{16}$")
        self.assertIn(json.loads(resp.partition(b"\r\n\r\n")[2])["conn"], r["conn"])
        self.assertEqual(len(r["proc"]["exe_sha256"]), 64)
        self.assertNotIn("environ", json.dumps(r))

    @unittest.skipUnless(pidfd_supported(), "SO_PEERPIDFD needs Linux >= 6.5")
    def test_pidfd_names_the_same_process(self):
        b0.client(self.sock, "base")
        r = self.records(1)[0]
        self.assertTrue(r["pidfd"]["ok"])
        self.assertEqual(r["pidfd"]["pid"], os.getpid())
        self.assertTrue(r["pidfd"]["alive_after"])

    def test_threads_report_the_process_not_the_thread(self):
        # A Worker is a thread: SO_PEERCRED must give the tgid, never a thread id.
        out = {}
        th = threading.Thread(target=lambda: out.setdefault("r", b0.client(self.sock, "base")))
        th.start()
        th.join()
        r = self.records(1)[0]
        self.assertEqual(r["cred"]["pid"], os.getpid())

    def test_baseline_client_in_another_process_is_seen_as_itself(self):
        out = subprocess.run([sys.executable, "-I", B0, "client", "--sock", self.sock, "--label", "base"], capture_output=True, text=True, timeout=30)
        c = json.loads(out.stdout)
        r = self.records(1)[0]
        self.assertEqual(c["status"], 200)
        self.assertEqual(r["cred"]["pid"], c["self_pid"])
        self.assertNotEqual(r["cred"]["pid"], os.getpid())
        self.assertEqual(r["self_pid"], c["self_pid"])

    def hold_then_check(self, inheritable, pass_fd):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(self.sock)
        if inheritable:
            os.set_inheritable(s.fileno(), True)
        after = int(time.time() * 1000)
        self.request(s, "/hold", {"label": "hold-c", "nonce": "cd34"})
        w = json.loads(subprocess.run([sys.executable, "-I", B0, "waitheld", "--held", self.held, "--after-ms", str(after)], capture_output=True, text=True, timeout=30).stdout)
        self.assertTrue(w["waited"])
        kw = {"pass_fds": (s.fileno(),)} if pass_fd else {}
        ch = json.loads(subprocess.run([sys.executable, "-I", B0, "fdcheck", "--held", self.held, "--after-ms", str(after)], capture_output=True, text=True, timeout=30, **kw).stdout)
        self.read_all(s)
        s.close()
        return ch

    def test_cloexec_descriptor_is_not_inherited(self):
        ch = self.hold_then_check(inheritable=False, pass_fd=False)
        self.assertTrue(ch["peer_known"])
        self.assertEqual(ch["diag"], {"found": True, "error": None, "stream_established": True, "mutual": True, "server_agrees": True})
        self.assertFalse(ch["peer_in_self"])
        self.assertEqual(ch["self_ppid"], os.getpid())
        self.assertEqual([(h["pid"], h["cloexec"]) for h in ch["holders"]], [(os.getpid(), True)])
        self.assertEqual(ch["scan_denied"], 0)

    def test_inherited_descriptor_is_detected(self):
        ch = self.hold_then_check(inheritable=True, pass_fd=True)
        self.assertTrue(ch["peer_in_self"])
        # The parent's copy is still there and now lacks O_CLOEXEC.
        self.assertIn((os.getpid(), False), [(h["pid"], h["cloexec"]) for h in ch["holders"]])

    def test_flag_and_consequence_are_measured_separately(self):
        # Not O_CLOEXEC, yet not inherited: the spawner closed it. The flag alone would mislead.
        ch = self.hold_then_check(inheritable=True, pass_fd=False)
        self.assertFalse(ch["peer_in_self"])
        self.assertEqual([(h["pid"], h["cloexec"]) for h in ch["holders"]], [(os.getpid(), False)])

    def test_positive_control_client(self):
        c = b0.client(self.sock, "control", self.held)
        self.assertEqual(c["status"], 200)
        self.assertTrue(c["child"]["waited"])
        self.assertTrue(c["child"]["peer_in_self"])
        self.assertEqual(c["child"]["held_conn"], c["conn"])

    def test_oversized_and_malformed_requests_are_recorded_not_fatal(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(self.sock)
        s.sendall(b"POST /c1 HTTP/1.1\r\nContent-Length: 999999\r\n\r\n")
        self.assertTrue(self.read_all(s).startswith(b"HTTP/1.1 400"))
        s.close()
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(self.sock)
        s.sendall(b"garbage\r\n\r\n")
        self.read_all(s)
        s.close()
        b0.client(self.sock, "base")
        rows = self.records(3)
        self.assertEqual(sorted(r["status"] for r in rows), [200, 400, 400])

    def test_untrusted_body_fields_are_filtered(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(self.sock)
        self.request(s, "/../etc", {"label": "X; rm", "nonce": "zz", "self_pid": True, "secret": "tok"})
        self.read_all(s)
        s.close()
        r = self.records(1)[0]
        self.assertEqual(r["path"], "invalid")
        for k in ("label", "nonce", "self_pid", "secret"):
            self.assertNotIn(k, r)

    def test_refuses_an_existing_socket_path(self):
        with self.assertRaises(SystemExit):
            b0.Server("container", self.sock, self.dir, self.held).open()


class HostScope(ServerCase):
    scope = "host"
    expect = "0123456789abcdef" * 4

    def test_cgroup_mismatch_is_reported(self):
        b0.client(self.sock, "base")
        r = self.records(1)[0]
        self.assertFalse(r["proc"]["cgroup_match"])
        self.assertTrue(os.path.basename(self.srv.out) == "h.jsonl")


class HostNamespaceView(ServerCase):
    """VM100 run 2: the host server's sock_diag cannot see the accepted end (it lives in the
    client's network namespace), so the held file carries no peer. One namespace here, so the
    server's lookup is made to fail the way the kernel fails it there; the checker's is real."""
    scope = "host"
    expect = "0123456789abcdef" * 4

    def setUp(self):
        real = b0.peer_inode

        def enoent(_ino):
            raise FileNotFoundError(2, "sock_diag")
        b0.peer_inode = enoent
        self.addCleanup(setattr, b0, "peer_inode", real)
        super().setUp()

    def test_checker_resolves_the_peer_from_the_accepted_end(self):
        ch = ContainerScope.hold_then_check(self, inheritable=False, pass_fd=False)
        r = self.records(1)[0]
        self.assertNotIn("peer_ino", r)
        self.assertEqual(r["peer_ino_error"], "ENOENT")
        self.assertEqual(ch["local_ino"], r["local_ino"])
        self.assertTrue(ch["peer_known"])
        self.assertEqual(ch["diag"], {"found": True, "error": None, "stream_established": True, "mutual": True, "server_agrees": None})
        self.assertEqual([(h["pid"], h["cloexec"]) for h in ch["holders"]], [(os.getpid(), True)])
        self.assertFalse(ch["peer_in_self"])
        # Artifact of one namespace: the server thread lives in this process. On VM100 the
        # host server is outside the container's pid namespace and this list is empty.
        self.assertEqual(ch["local_holder_pids"], [os.getpid()])


class AcceptedEnd(unittest.TestCase):
    """peer_from_accepted takes nothing from the held file on trust."""

    def ino(self, s):
        return os.fstat(s.fileno()).st_ino

    def pair(self, kind=socket.SOCK_STREAM):
        a, b = socket.socketpair(socket.AF_UNIX, kind)
        self.addCleanup(a.close)
        self.addCleanup(b.close)
        return a, b

    def test_a_live_connection_resolves_both_ways(self):
        a, b = self.pair()
        self.assertEqual(b0.peer_from_accepted(self.ino(a)),
                         (self.ino(b), {"found": True, "error": None, "stream_established": True, "mutual": True, "server_agrees": None}))
        self.assertEqual(b0.peer_from_accepted(self.ino(a), self.ino(b))[1]["server_agrees"], True)

    def test_invalid_inode_values_are_not_queried(self):
        for v in (None, "123", True, 0, -1, 2 ** 32, 1.5):
            with self.subTest(v=v):
                self.assertEqual(b0.peer_from_accepted(v), (None, {"found": False, "error": "no-local-ino", "stream_established": False,
                                                                   "mutual": False, "server_agrees": None}))

    def test_a_closed_connection_is_not_found(self):
        a, b = socket.socketpair()
        ino = self.ino(a)
        a.close()
        b.close()
        peer, d = b0.peer_from_accepted(ino)
        self.assertIsNone(peer)
        self.assertEqual((d["found"], d["error"]), (False, "ENOENT"))

    def test_client_gone_while_accepted_end_open(self):
        a, b = socket.socketpair()
        self.addCleanup(a.close)
        b.close()
        peer, d = b0.peer_from_accepted(self.ino(a))
        self.assertIsNone(peer)
        self.assertFalse(d["mutual"])

    def test_listener_and_datagram_are_refused(self):
        d = tempfile.mkdtemp()
        lst = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(lst.close)
        lst.bind(os.path.join(d, "l.sock"))
        lst.listen(1)
        a, _ = self.pair(socket.SOCK_DGRAM)
        for s in (lst, a):
            with self.subTest(s=s):
                peer, dg = b0.peer_from_accepted(self.ino(s))
                self.assertIsNone(peer)
                self.assertTrue(dg["found"])
                self.assertFalse(dg["stream_established"])

    def test_disagreement_with_the_server_is_refused(self):
        a, b = self.pair()
        peer, d = b0.peer_from_accepted(self.ino(a), self.ino(b) + 1)
        self.assertIsNone(peer)
        self.assertIs(d["server_agrees"], False)

    def with_answers(self, answers):
        real = b0.unix_diag
        b0.unix_diag = lambda ino: dict(answers[ino])
        self.addCleanup(setattr, b0, "unix_diag", real)

    def test_a_peer_that_does_not_name_the_accepted_end_back_is_refused(self):
        st = {"type": socket.SOCK_STREAM, "state": b0.TCP_ESTABLISHED}
        self.with_answers({10: {"ino": 10, "peer": 20, **st}, 20: {"ino": 20, "peer": 30, **st}})
        peer, d = b0.peer_from_accepted(10)
        self.assertIsNone(peer)
        self.assertEqual((d["stream_established"], d["mutual"]), (True, False))

    def test_an_accepted_end_not_established_is_refused(self):
        self.with_answers({10: {"ino": 10, "peer": 20, "type": socket.SOCK_STREAM, "state": 7},
                           20: {"ino": 20, "peer": 10, "type": socket.SOCK_STREAM, "state": b0.TCP_ESTABLISHED}})
        self.assertEqual(b0.peer_from_accepted(10)[0], None)

    def test_a_peer_end_not_established_is_refused(self):
        self.with_answers({10: {"ino": 10, "peer": 20, "type": socket.SOCK_STREAM, "state": b0.TCP_ESTABLISHED},
                           20: {"ino": 20, "peer": 10, "type": socket.SOCK_STREAM, "state": 7}})
        self.assertEqual(b0.peer_from_accepted(10)[0], None)

    def run_fdcheck(self, held_obj):
        d = tempfile.mkdtemp()
        held = os.path.join(d, "held.json")
        b0.write_json_atomic(held, {"scope": "host", "conn": "0" * 16, "t_ms": int(time.time() * 1000), **held_obj})
        return json.loads(subprocess.run([sys.executable, "-I", B0, "fdcheck", "--held", held, "--wait-ms", "500"],
                                         capture_output=True, text=True, timeout=30).stdout)

    def test_fdcheck_without_local_ino_knows_no_peer(self):
        ch = self.run_fdcheck({"peer_ino": None})
        self.assertFalse(ch["peer_known"])
        self.assertEqual(ch["diag"]["error"], "no-local-ino")

    def test_fdcheck_on_a_closed_connection_knows_no_peer(self):
        a, b = socket.socketpair()
        ino = self.ino(a)
        a.close()
        b.close()
        ch = self.run_fdcheck({"local_ino": ino})
        self.assertFalse(ch["peer_known"])
        self.assertEqual(ch["diag"]["error"], "ENOENT")

    def test_fdcheck_on_another_live_connection_says_who_holds_its_accepted_end(self):
        # A wrong but valid inode resolves; what exposes it is the accepted end's holder here
        # (and, in analyze.py, the server's own record of the connection).
        a, b = self.pair()
        ch = self.run_fdcheck({"local_ino": self.ino(a)})
        self.assertTrue(ch["peer_known"])
        self.assertEqual(ch["local_ino"], self.ino(a))
        self.assertEqual(ch["local_holder_pids"], [os.getpid()])


class ProcParsing(unittest.TestCase):
    def setUp(self):
        self.proc = tempfile.mkdtemp()
        os.makedirs(f"{self.proc}/42")

    def test_status_and_nspid(self):
        with open(f"{self.proc}/42/status", "w") as f:
            f.write("Name:\tclaude\nTgid:\t4242\nPPid:\t7\nTracerPid:\t0\nUid:\t1000\t1000\t1000\t1000\nNSpid:\t4242\t87\n")
        self.assertEqual(b0.read_status(42, self.proc), {"tgid": 4242, "ppid": 7, "tracerpid": 0, "uid": 1000, "nspid": [4242, 87]})

    def test_starttime_with_hostile_comm(self):
        fields = " ".join(str(i) for i in range(3, 53))  # fields 3..52
        with open(f"{self.proc}/42/stat", "w") as f:
            f.write(f"42 (a) b) (c) {fields}\n")
        self.assertEqual(b0.read_starttime(42, self.proc), 22)


class RoCheck(unittest.TestCase):
    def test_writable_dir_reports_success(self):
        d = tempfile.mkdtemp()
        open(os.path.join(d, "h.sock"), "w").close()
        r = b0.rocheck(d)
        self.assertEqual(r, {"create": "succeeded", "mkdir": "succeeded", "rename": "succeeded", "unlink": "succeeded"})

    @unittest.skipIf(os.geteuid() == 0, "root ignores mode bits")
    def test_unwritable_dir_reports_errno(self):
        d = tempfile.mkdtemp()
        open(os.path.join(d, "h.sock"), "w").close()
        os.chmod(d, 0o555)
        try:
            r = b0.rocheck(d)
        finally:
            os.chmod(d, 0o755)
        self.assertEqual(set(r.values()), {"EACCES"})


class HeldFile(unittest.TestCase):
    """VM100 run 1 (2026-11-03): hold-h never synchronized. The host server inherits the
    runner's umask 077, so without an explicit mode the held file is 0600 and a checker
    running as another uid cannot read it."""

    def test_held_file_is_readable_by_others_even_under_umask_077(self):
        d = tempfile.mkdtemp()
        sock, held = os.path.join(d, "h.sock"), os.path.join(d, "held-h.json")
        p = subprocess.Popen([sys.executable, "-I", B0, "server", "--scope", "host", "--sock", sock, "--out", d,
                              "--held", held, "--expect-container", "x" * 64, "--hold-ms", "300", "--deadline-s", "20"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=lambda: os.umask(0o077))
        try:
            for _ in range(100):
                if os.path.exists(sock):
                    break
                time.sleep(0.05)
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.connect(sock)
            body = b'{"label":"hold-h","nonce":"ab"}'
            s.sendall(b"POST /hold HTTP/1.1\r\nHost: x\r\nContent-Length: %d\r\n\r\n" % len(body) + body)
            while s.recv(4096):
                pass
            s.close()
            self.assertEqual(os.stat(held).st_mode & 0o777, 0o644)
            # The results the same server writes stay private: only the held file is widened.
            self.assertEqual(os.stat(os.path.join(d, "h.jsonl")).st_mode & 0o077, 0)
        finally:
            p.terminate()
            p.wait(10)

    def run_waitheld(self, held, after_ms=0):
        r = subprocess.run([sys.executable, "-I", B0, "waitheld", "--held", held, "--after-ms", str(after_ms), "--wait-ms", "300"],
                           capture_output=True, text=True, timeout=10)
        return json.loads(r.stdout)

    def test_waitheld_says_why_it_did_not_synchronize(self):
        d = tempfile.mkdtemp()
        held = os.path.join(d, "held.json")
        self.assertEqual(self.run_waitheld(held), {"waited": False, "held_conn": None, "held_last_error": "ENOENT"})
        b0.write_json_atomic(held, {"conn": "0" * 16, "t_ms": 5})
        self.assertEqual(self.run_waitheld(held, after_ms=10)["held_last_error"], "stale")
        os.chmod(held, 0)
        try:
            self.assertEqual(self.run_waitheld(held)["held_last_error"], "EACCES")
        finally:
            os.chmod(held, 0o600)
        r = self.run_waitheld(held)
        self.assertEqual((r["waited"], r["held_conn"]), (True, "0" * 16))
        self.assertNotIn("held_last_error", r)

    def test_fdcheck_reports_the_same_reason(self):
        d = tempfile.mkdtemp()
        out = b0.fdcheck(os.path.join(d, "absent.json"), 0, 200)
        self.assertEqual((out["waited"], out["held_last_error"]), (False, "ENOENT"))


class Stop(unittest.TestCase):
    def start_server(self):
        d = tempfile.mkdtemp()
        sock, ident = os.path.join(d, "h.sock"), os.path.join(d, "id.json")
        p = subprocess.Popen([sys.executable, "-I", B0, "server", "--scope", "host", "--sock", sock, "--out", d,
                              "--held", os.path.join(d, "held"), "--expect-container", "x" * 64, "--identity", ident],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            if os.path.exists(ident) and os.path.exists(sock):
                break
            time.sleep(0.05)
        return p, sock, ident

    def test_stops_the_verified_process_and_its_socket_goes(self):
        p, sock, ident = self.start_server()
        self.assertEqual(b0.stop(ident), {"result": "stopped", "sock_removed": True})
        self.assertEqual(p.wait(5), 0)
        self.assertFalse(os.path.exists(sock))
        self.assertEqual(b0.stop(ident), {"result": "already-exited"})  # idempotent

    def test_refuses_when_starttime_or_cmdline_differ(self):
        p, sock, ident = self.start_server()
        try:
            for key, val in (("starttime", 1), ("argv_sha256", "0" * 64), ("uid", 4242)):
                with open(ident) as f:
                    good = json.load(f)
                bad = dict(good, **{key: val})
                with open(ident + key, "w") as f:
                    json.dump(bad, f)
                with self.subTest(key):
                    self.assertEqual(b0.stop(ident + key)["result"], "refused")
                    self.assertIsNone(p.poll())
        finally:
            b0.stop(ident)
            p.wait(5)

    def test_dead_pid_and_other_boot_are_already_exited(self):
        p = subprocess.Popen(["true"])
        p.wait()
        d = tempfile.mkdtemp()
        ident = os.path.join(d, "id.json")
        with open(ident, "w") as f:
            json.dump({"pid": p.pid, "starttime": 1, "boot_id": b0.boot_id(), "uid": os.getuid(), "argv_sha256": "", "sock": ""}, f)
        self.assertIn(b0.stop(ident)["result"], ("already-exited", "refused"))
        with open(ident, "w") as f:
            json.dump({"pid": os.getpid(), "boot_id": "other"}, f)
        self.assertEqual(b0.stop(ident), {"result": "already-exited", "why": "rebooted"})


class ImageVersion(unittest.TestCase):
    L = 'RUN |1 CLAUDE_CODE_VERSION={v} /bin/sh -c npm install -g "@anthropic-ai/claude-code@${{CLAUDE_CODE_VERSION}}" # buildkit'

    def test_cases(self):
        one = self.L.format(v="2.1.314")
        self.assertEqual(b0.image_version("USER developer\n" + one)["version"], "2.1.314")
        self.assertEqual(b0.image_version(self.L.format(v="2.1.308"))["version"], "2.1.308")
        self.assertIsNone(b0.image_version("USER developer")["version"])
        self.assertIsNone(b0.image_version(one + "\n" + self.L.format(v="2.1.316"))["version"])
        self.assertIsNone(b0.image_version('RUN /bin/sh -c npm install -g "@anthropic-ai/claude-code@latest"')["version"])
        self.assertEqual(b0.image_version('RUN /bin/sh -c npm install -g @anthropic-ai/claude-code@2.1.314')["version"], "2.1.314")


class CheckLimits(unittest.TestCase):
    def good(self):
        hc = {"Memory": b0.GIB2, "MemorySwap": b0.GIB2, "NanoCpus": 10 ** 9, "PidsLimit": 256, "CapDrop": ["ALL"], "CapAdd": None,
              "SecurityOpt": ["no-new-privileges:true"], "Privileged": False, "NetworkMode": "bridge", "RestartPolicy": {"Name": "no"},
              "PidMode": "", "IpcMode": "private", "UTSMode": "", "Binds": None, "Devices": [], "VolumesFrom": None}
        mounts = [{"Type": "bind", "Source": "/k", "Destination": "/opt/passb0-kit", "RW": False},
                  {"Type": "bind", "Source": "/r", "Destination": "/run/st-attest", "RW": False}]
        return [{"Config": {"Labels": {"passb0.experiment": "S"}, "User": "developer"}, "HostConfig": hc, "Mounts": mounts}]

    def test_good_and_each_deviation(self):
        self.assertEqual(b0.check_limits(self.good(), "S", "/k", "/r"), [])
        cases = {
            "label": lambda c: c["Config"]["Labels"].update({"passb0.experiment": "T"}),
            "memory": lambda c: c["HostConfig"].update(Memory=0),
            "cpus": lambda c: c["HostConfig"].update(NanoCpus=2 * 10 ** 9),
            "pids": lambda c: c["HostConfig"].update(PidsLimit=None),
            "capabilities": lambda c: c["HostConfig"].update(CapAdd=["SYS_PTRACE"]),
            "no-new-privileges": lambda c: c["HostConfig"].update(SecurityOpt=[]),
            "privileged": lambda c: c["HostConfig"].update(Privileged=True),
            "network": lambda c: c["HostConfig"].update(NetworkMode="sessions-net"),
            "namespaces": lambda c: c["HostConfig"].update(PidMode="host"),
            "mounts": lambda c: c["Mounts"][0].update(RW=True),
            "docker-sock": lambda c: c["Mounts"].append({"Type": "bind", "Source": "/var/run/docker.sock", "Destination": "/var/run/docker.sock", "RW": True}),
        }
        for why, mutate in cases.items():
            with self.subTest(why):
                c = self.good()
                mutate(c[0])
                self.assertIn(why, b0.check_limits(c, "S", "/k", "/r"))


class CliInfo(unittest.TestCase):
    def test_shape_only(self):
        r = b0.cliinfo()
        self.assertIsInstance(r["cli"], list)
        for p in r["cli"]:
            self.assertEqual(set(p), {"pid", "tgid", "ppid", "starttime", "uid", "tracerpid", "exe_name", "exe_sha256", "exe_deleted"})
        self.assertIn(r["mods_flag_cached"], (True, False, "absent", "other", "unreadable"))


if __name__ == "__main__":
    unittest.main()
