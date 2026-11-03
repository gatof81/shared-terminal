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
