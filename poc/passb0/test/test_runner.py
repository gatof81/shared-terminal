"""Synthetic tests of run-b0.sh against a fake docker (test/fakebin/docker); the host
server and `stop` are real processes. Run: python3 test/test_runner.py"""
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.dirname(HERE)
RUNNER = os.path.join(KIT, "run-b0.sh")
IMAGE_ID = "sha256:" + "ab" * 32
HIST_OK = 'RUN |1 CLAUDE_CODE_VERSION=2.1.314 /bin/sh -c npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" # buildkit\nUSER developer'
HIST_308 = HIST_OK.replace("2.1.314", "2.1.308")


def boot_id():
    with open("/proc/sys/kernel/random/boot_id") as f:
        return f.read().strip()


def put(path, text):
    with open(path, "w") as f:
        f.write(text)


class Runner(unittest.TestCase):
    def setUp(self):
        self.base = tempfile.mkdtemp(prefix="b0run-")
        self.stamp = "20261104-120000"
        self.run_dir = os.path.join(self.base, "run")
        self.res = os.path.join(self.base, "results")
        os.makedirs(self.run_dir)
        os.makedirs(self.res)
        env = {"STAMP": self.stamp, "KIT": KIT, "RUN": self.run_dir, "RES": self.res,
               "EXP": f"passb0-exp-{self.stamp}", "IMAGE": "shared-terminal-session", "COMMIT": "0" * 40}
        with open(os.path.join(self.base, "env"), "w") as f:
            f.writelines(f"{k}={v}\n" for k, v in env.items())
        self.cfs = os.path.join(self.base, "cfs")
        self.state_path = os.path.join(self.base, "fake-docker.json")
        self.write_state({"image": "shared-terminal-session", "image_id": IMAGE_ID, "history": HIST_OK, "cfs": self.cfs})

    def tearDown(self):
        # Never leave a real host server behind.
        ident = os.path.join(self.base, "state", "server-h.identity.json")
        if os.path.exists(ident):
            subprocess.run(["python3", "-I", os.path.join(KIT, "b0.py"), "stop", "--identity", ident], capture_output=True)
        shutil.rmtree(self.base, ignore_errors=True)

    def write_state(self, s):
        with open(self.state_path, "w") as f:
            json.dump(s, f)

    def state(self):
        with open(self.state_path) as f:
            return json.load(f)

    def patch(self, **kw):
        s = self.state()
        s.update(kw)
        self.write_state(s)

    def phase(self, name):
        env = dict(os.environ, PATH=os.path.join(HERE, "fakebin") + ":" + os.environ["PATH"], FAKE_DOCKER_STATE=self.state_path)
        return subprocess.run(["bash", RUNNER, self.base, name], capture_output=True, text=True, env=env, timeout=120)

    def marker(self, name):
        return os.path.exists(os.path.join(self.base, "state", name))

    def assertOk(self, r, name):
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip().splitlines()[-1], f"OK: {name}")

    def assertFailedClosed(self, r, code=None):
        self.assertNotEqual(r.returncode, 0)
        if code is not None:
            self.assertEqual(r.returncode, code, r.stderr)
        self.assertNotIn("OK:", r.stdout)

    # ── preflight ──
    def test_preflight_ok_is_read_only(self):
        r = self.phase("preflight")
        self.assertOk(r, "preflight")
        self.assertTrue(self.marker("preflight.ok"))
        verbs = {c[0] for c in self.state()["calls"]}
        self.assertTrue(verbs <= {"info", "image", "ps"}, verbs)
        with open(os.path.join(self.res, "preflight.json")) as f:
            self.assertEqual(json.load(f)["cli_version"], "2.1.314")

    def test_preflight_stops_on_2_1_308(self):
        self.patch(history=HIST_308)
        r = self.phase("preflight")
        self.assertFailedClosed(r, 3)
        self.assertIn("2.1.308", r.stderr)
        self.assertFalse(self.marker("preflight.ok"))

    def test_preflight_stops_on_unknown_version(self):
        self.patch(history=HIST_OK + "\n" + HIST_308)
        self.assertFailedClosed(self.phase("preflight"), 3)

    def test_preflight_stops_on_userns(self):
        self.patch(info='["name=userns"]')
        self.assertFailedClosed(self.phase("preflight"))

    def test_preflight_stops_on_leftover_experiment(self):
        self.patch(containers=[{"id": "c" * 64, "name": "passb0-exp-old", "labels": {"passb0.experiment": "old"}}])
        self.assertFailedClosed(self.phase("preflight"))

    # ── ordering ──
    def test_each_phase_needs_the_previous_marker(self):
        for name in ("setup", "servers", "measure", "capture"):
            with self.subTest(name):
                self.assertFailedClosed(self.phase(name), 65)
        self.assertEqual([c for c in self.state().get("calls", []) if c[0] == "run"], [])

    # ── setup ──
    def test_setup_creates_exactly_the_limited_container(self):
        self.assertOk(self.phase("preflight"), "preflight")
        self.assertOk(self.phase("setup"), "setup")
        run = [c for c in self.state()["calls"] if c[0] == "run"]
        self.assertEqual(len(run), 1)
        a = run[0]
        for flag, val in (("--user", "developer"), ("--cap-drop", "ALL"), ("--security-opt", "no-new-privileges:true"), ("--pids-limit", "256"),
                          ("--memory", "2g"), ("--memory-swap", "2g"), ("--cpus", "1"), ("--network", "bridge"), ("--restart", "no")):
            self.assertEqual(a[a.index(flag) + 1], val, flag)
        mounts = [a[i + 1] for i, x in enumerate(a) if x == "--mount"]
        self.assertEqual(len(mounts), 2)
        self.assertTrue(all(m.endswith(",readonly") for m in mounts))
        self.assertFalse(any("docker.sock" in x or "sessions-net" in x or "--privileged" == x for x in a))

    def test_setup_stops_on_cli_mismatch_inside(self):
        self.phase("preflight")
        self.patch(cli_version="2.1.308")
        self.assertFailedClosed(self.phase("setup"))
        self.assertFalse(self.marker("setup.ok"))

    def test_setup_stops_when_docker_applied_other_limits(self):
        self.phase("preflight")
        self.patch(override_hostconfig={"Memory": 4 * 1024 ** 3})
        r = self.phase("setup")
        self.assertFailedClosed(r)
        self.assertIn("límites", r.stderr)

    def test_setup_stops_on_an_extra_mount(self):
        self.phase("preflight")
        self.patch(extra_mounts=[{"Type": "bind", "Source": "/var/run/docker.sock", "Destination": "/var/run/docker.sock", "RW": True}])
        self.assertFailedClosed(self.phase("setup"))

    def test_unchecked_command_failure_stops_the_phase(self):
        # mkdir has no explicit check: only errexit stops here. This is the case the
        # `( set -e ...) && echo OK || echo FALLÓ` pattern got wrong.
        self.phase("preflight")
        self.patch(fail_mkdir=True)
        self.assertFailedClosed(self.phase("setup"))
        self.assertFalse(self.marker("setup.ok"))

    def test_docker_failure_mid_phase_never_prints_ok(self):
        self.phase("preflight")
        self.patch(fail_run=True)
        self.assertFailedClosed(self.phase("setup"))

    # ── servers + cleanup with the real host server ──
    def test_servers_then_cleanup_stops_the_host_server_by_identity(self):
        self.phase("preflight")
        self.phase("setup")
        r = self.phase("servers")
        self.assertOk(r, "servers")
        with open(os.path.join(self.base, "state", "server-h.identity.json")) as f:
            ident = json.load(f)
        os.kill(ident["pid"], 0)  # alive
        self.mkcfs(complete=True)
        self.phase("capture")
        r = self.phase("cleanup")
        self.assertOk(r, "cleanup")
        self.assertIn('"stopped"', r.stdout)
        with self.assertRaises(ProcessLookupError):
            os.kill(ident["pid"], 0)
        self.assertFalse(os.path.exists(self.run_dir))
        self.assertEqual(self.state()["containers"], [])
        self.assertOk(self.phase("cleanup"), "cleanup")  # idempotent

    def test_cleanup_refuses_to_signal_a_mismatched_identity(self):
        p = subprocess.Popen(["sleep", "60"])
        try:
            os.makedirs(os.path.join(self.base, "state"), exist_ok=True)
            with open(os.path.join(self.base, "state", "server-h.identity.json"), "w") as f:
                json.dump({"pid": p.pid, "starttime": 1, "boot_id": boot_id(),
                           "uid": os.getuid(), "argv_sha256": "0" * 64, "sock": os.path.join(self.run_dir, "h.sock")}, f)
            r = self.phase("cleanup")
            self.assertFailedClosed(r, 67)
            self.assertIn("identity-mismatch", r.stdout)
            self.assertIsNone(p.poll(), "the process must not have been signalled")
        finally:
            p.kill()
            p.wait()

    # ── capture / cleanup ──
    def mkcfs(self, complete):
        out = os.path.join(self.cfs, "tmp/passb0/out")
        os.makedirs(out, exist_ok=True)
        for f in ("c.jsonl", "cliinfo.json", "base-c.json", "base-h.json", "control-c.json", "rocheck.json"):
            put(os.path.join(out, f), "{}\n")
        if complete:
            mod = os.path.join(self.cfs, "home/developer/passb0-ws/.passb0/out/mod")
            os.makedirs(mod, exist_ok=True)
            put(os.path.join(mod, "i-0001.json"), "{}")
            put(os.path.join(out, "claude-debug.log"), "")
        put(os.path.join(self.res, "h.jsonl"), "{}\n")
        put(os.path.join(self.res, "measure.json"), "{}")
        put(os.path.join(self.run_dir, "held-h.json"), "{}")

    def test_capture_incomplete_keeps_evidence_and_is_inconclusive(self):
        self.phase("preflight")
        self.phase("setup")
        self.mkcfs(complete=False)
        r = self.phase("capture")
        self.assertFailedClosed(r, 4)
        with open(os.path.join(self.res, "capture-manifest.json")) as f:
            m = json.load(f)
        self.assertFalse(m["complete"])
        self.assertTrue(m["items"]["mod"].startswith("failed"))
        self.assertEqual(m["items"]["container-out"], "ok")
        self.assertTrue(os.path.exists(os.path.join(self.res, "c.jsonl")))
        self.assertTrue(os.path.exists(os.path.join(self.res, "SHA256SUMS")))
        v = self.phase("validate")
        self.assertFailedClosed(v)
        with open(os.path.join(self.res, "report.json")) as f:
            self.assertIn("capture-incomplete", f.read())

    def test_capture_after_a_failed_setup(self):
        self.phase("preflight")
        self.patch(cli_version="2.1.308")
        self.phase("setup")  # container exists, setup.ok does not
        self.assertFailedClosed(self.phase("capture"), 4)
        self.assertTrue(self.marker("capture.attempted"))
        self.assertOk(self.phase("cleanup"), "cleanup")

    def container_id(self):
        with open(os.path.join(self.base, "state", "container_id")) as f:
            return f.read().strip()

    def cleanup(self, **env):
        old = dict(os.environ)
        os.environ.update(env)
        try:
            return self.phase("cleanup")
        finally:
            os.environ.clear()
            os.environ.update(old)

    def removal(self):
        with open(os.path.join(self.res, "removal.json")) as f:
            return json.load(f)["basis"]

    def test_cleanup_refuses_before_capture_when_the_container_holds_evidence(self):
        self.phase("preflight")
        self.phase("setup")
        self.mkcfs(complete=True)
        self.assertFailedClosed(self.cleanup(), 66)
        self.assertEqual(len(self.state()["containers"]), 1)

    def test_cleanup_removes_an_empty_container_on_proven_absence(self):
        self.phase("preflight")
        self.phase("setup")
        self.assertOk(self.cleanup(), "cleanup")
        self.assertEqual(self.removal(), "no-evidence")
        self.assertEqual(self.state()["containers"], [])

    def test_cleanup_refuses_after_a_partial_capture(self):
        self.phase("preflight")
        self.phase("setup")
        self.mkcfs(complete=False)
        self.assertFailedClosed(self.phase("capture"), 4)
        self.assertFalse(self.marker("capture.ok"))
        r = self.cleanup()
        self.assertFailedClosed(r, 66)
        self.assertIn("B0_DISCARD_EVIDENCE", r.stderr)
        self.assertEqual(len(self.state()["containers"]), 1)
        self.assertFalse(os.path.exists(os.path.join(self.res, "removal.json")))

    def test_cleanup_refuses_a_stopped_container_it_cannot_look_into(self):
        self.phase("preflight")
        self.phase("setup")
        s = self.state()
        s["containers"][0]["stopped"] = True
        self.write_state(s)
        self.assertFailedClosed(self.cleanup(), 66)
        self.assertEqual(len(self.state()["containers"]), 1)

    def test_discard_authorization_must_name_this_container(self):
        self.phase("preflight")
        self.phase("setup")
        self.mkcfs(complete=False)
        self.phase("capture")
        self.assertFailedClosed(self.cleanup(B0_DISCARD_EVIDENCE="e" * 64), 66)
        self.assertFailedClosed(self.cleanup(B0_DISCARD_EVIDENCE="1"), 66)
        self.assertEqual(len(self.state()["containers"]), 1)
        cid = self.container_id()
        self.assertOk(self.cleanup(B0_DISCARD_EVIDENCE=cid), "cleanup")
        self.assertEqual(self.state()["containers"], [])
        self.assertEqual(self.removal(), "discard-authorized")

    def test_capture_ok_alone_is_not_enough_when_results_changed(self):
        self.phase("preflight")
        self.phase("setup")
        self.mkcfs(complete=True)
        self.assertOk(self.phase("capture"), "capture")
        self.assertTrue(self.marker("capture.ok"))
        with open(os.path.join(self.res, "c.jsonl"), "a") as f:
            f.write("tampered\n")
        self.assertFailedClosed(self.cleanup(), 66)
        self.assertEqual(len(self.state()["containers"]), 1)

    def test_a_failed_capture_rerun_withdraws_capture_ok(self):
        self.phase("preflight")
        self.phase("setup")
        self.mkcfs(complete=True)
        self.assertOk(self.phase("capture"), "capture")
        self.patch(cli_version="2.1.315")
        self.assertFailedClosed(self.phase("capture"), 4)
        self.assertFalse(self.marker("capture.ok"))

    def test_capture_requires_the_exact_cli_version_after_the_run(self):
        self.phase("preflight")
        self.phase("setup")
        self.mkcfs(complete=True)
        self.patch(cli_version="2.1.315")
        self.assertFailedClosed(self.phase("capture"), 4)
        with open(os.path.join(self.res, "cli-version-after.json")) as f:
            self.assertEqual(json.load(f), {"version": "2.1.315", "expected": "2.1.314", "match": False})
        with open(os.path.join(self.res, "capture-manifest.json")) as f:
            self.assertTrue(json.load(f)["items"]["cli-version-after"].startswith("failed"))
        self.assertFailedClosed(self.phase("validate"))
        with open(os.path.join(self.res, "report.json")) as f:
            self.assertIn("cli-version-mismatch:after", f.read())

    def test_setup_persists_the_version_it_checked(self):
        self.phase("preflight")
        self.assertOk(self.phase("setup"), "setup")
        with open(os.path.join(self.res, "cli-version-before.json")) as f:
            self.assertEqual(json.load(f)["match"], True)

    def test_cleanup_never_removes_a_container_other_than_the_recorded_id(self):
        self.phase("preflight")
        self.phase("setup")
        put(os.path.join(self.base, "state", "container_id"), "e" * 64 + "\n")
        self.assertFailedClosed(self.cleanup(), 67)
        self.assertEqual(len(self.state()["containers"]), 1)

    def test_cleanup_never_removes_a_container_without_a_recorded_id(self):
        self.phase("preflight")
        self.phase("setup")
        os.unlink(os.path.join(self.base, "state", "container_id"))
        self.assertFailedClosed(self.cleanup(), 67)
        self.assertEqual(len(self.state()["containers"]), 1)

    def test_setup_stops_when_the_name_points_elsewhere(self):
        self.phase("preflight")
        s = self.state()
        s["run_id_override"] = "e" * 64
        self.write_state(s)
        self.assertFailedClosed(self.phase("setup"))
        self.assertFalse(self.marker("setup.ok"))

    def test_cleanup_does_not_touch_a_container_with_a_foreign_name(self):
        self.phase("preflight")
        s = self.state()
        s["containers"] = [{"id": "d" * 64, "name": "someone-else", "labels": {"passb0.experiment": self.stamp}}]
        self.write_state(s)
        put(os.path.join(self.base, "state", "capture.attempted"), "")
        self.assertFailedClosed(self.phase("cleanup"), 67)
        self.assertEqual(len(self.state()["containers"]), 1)

    def test_cleanup_keeps_held_file_without_a_copy(self):
        self.phase("preflight")
        put(os.path.join(self.run_dir, "held-h.json"), "{}")
        self.assertFailedClosed(self.phase("cleanup"), 67)
        self.assertTrue(os.path.exists(os.path.join(self.run_dir, "held-h.json")))


if __name__ == "__main__":
    unittest.main()
