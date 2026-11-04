"""Synthetic tests of run-b1.sh against a fake docker (test/fakebin/docker).
Run: python3 test/test_runner.py"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.dirname(HERE)
RUNNER = os.path.join(KIT, "run-b1.sh")
IMAGE_ID = "sha256:" + "ab" * 32
HIST_OK = 'RUN |1 CLAUDE_CODE_VERSION=2.1.314 /bin/sh -c npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" # buildkit'


class Runner(unittest.TestCase):
    kind = "b1a"

    def setUp(self):
        self.base = tempfile.mkdtemp(prefix="b1run-")
        self.stamp = "20261104-120000"
        self.res = os.path.join(self.base, "results")
        os.makedirs(self.res)
        env = {"KIND": self.kind, "STAMP": self.stamp, "KIT": KIT, "RES": self.res, "EXP": f"pass{self.kind}-exp-{self.stamp}",
               "IMAGE": "shared-terminal-session", "COMMIT": "0" * 40}
        if self.kind == "b1a":
            self.man, self.mkt = os.path.join(self.base, "managed"), os.path.join(self.base, "marketplace")
            os.makedirs(self.man)
            shutil.copy(os.path.join(KIT, "managed", "b1a.json"), self.man)
            shutil.copytree(os.path.join(KIT, "marketplace"), self.mkt)
            env.update(MAN=self.man, MKT=self.mkt)
        with open(os.path.join(self.base, "env"), "w") as f:
            f.writelines(f"{k}={v}\n" for k, v in env.items())
        self.cfs = os.path.join(self.base, "cfs")
        self.state_path = os.path.join(self.base, "fake-docker.json")
        self.write_state({"image": "shared-terminal-session", "image_id": IMAGE_ID, "history": HIST_OK, "cfs": self.cfs})

    def tearDown(self):
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

    def phase(self, name, **extra):
        env = dict(os.environ, PATH=os.path.join(HERE, "fakebin") + ":" + os.environ["PATH"], FAKE_DOCKER_STATE=self.state_path,
                   B1B_OBSERVE_S="0", B1B_SETTLE_S="0", B1B_ANC_WAIT_S="1", **extra)
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

    def through(self, last):
        for p in ("preflight", "setup", "measure", "capture"):
            r = self.phase(p)
            self.assertOk(r, p)
            if p == last:
                return


class B1a(Runner):
    kind = "b1a"

    def test_phases_need_their_predecessor(self):
        for p in ("setup", "measure"):
            self.assertFailedClosed(self.phase(p), 65)
        self.assertFailedClosed(self.phase("validate"), 65)

    def test_preflight_stops_on_another_cli_version(self):
        self.patch(history=HIST_OK.replace("2.1.314", "2.1.308"))
        self.assertFailedClosed(self.phase("preflight"), 3)
        self.assertFalse(self.marker("preflight.ok"))

    def test_preflight_refuses_a_policy_that_is_not_the_kits(self):
        with open(os.path.join(self.man, "b1a.json"), "a") as f:
            f.write(" ")
        self.assertFailedClosed(self.phase("preflight"))

    def test_preflight_refuses_an_extra_policy_file(self):
        with open(os.path.join(self.man, "extra.json"), "w") as f:
            f.write("{}")
        self.assertFailedClosed(self.phase("preflight"))

    def test_preflight_refuses_a_marketplace_that_is_not_the_kits(self):
        with open(os.path.join(self.mkt, "plugins", "st-b1-probe", "hooks", "register.mjs"), "a") as f:
            f.write("// changed\n")
        self.assertFailedClosed(self.phase("preflight"))

    def test_preflight_refuses_leftover_experiment_containers(self):
        self.patch(containers=[{"id": "c" * 64, "name": "x", "labels": {"passb0.experiment": "old"}, "user": "developer", "hc": {}, "mounts": []}])
        self.assertFailedClosed(self.phase("preflight"))

    def test_env_values_are_data(self):
        with open(os.path.join(self.base, "env"), "a") as f:
            f.write("X=$(touch /tmp/pwned)\n")
        self.assertFailedClosed(self.phase("preflight"), 64)

    def test_setup_mounts_exactly_kit_policy_and_marketplace_read_only(self):
        self.through("setup")
        run = next(c for c in self.state()["calls"] if c[:1] == ["run"])
        self.assertEqual(run[run.index("--network") + 1], "none")
        mounts = [run[i + 1] for i, x in enumerate(run) if x == "--mount"]
        self.assertEqual(sorted(mounts), sorted([f"type=bind,src={KIT},dst=/opt/passb1-kit,readonly",
                                                 f"type=bind,src={self.man},dst=/etc/claude-code/managed-settings.d,readonly",
                                                 f"type=bind,src={self.mkt},dst=/opt/st-b1/marketplace,readonly"]))
        for flag in ("--cap-drop", "--security-opt"):
            self.assertIn(flag, run)
        self.assertEqual(run[run.index("--cap-drop") + 1], "ALL")
        self.assertEqual(run[run.index("--security-opt") + 1], "no-new-privileges:true")

    def test_setup_fails_closed_when_docker_applied_something_else(self):
        self.assertOk(self.phase("preflight"), "preflight")
        self.patch(override_hostconfig={"CapAdd": ["SYS_PTRACE"]})
        self.assertFailedClosed(self.phase("setup"))
        self.assertFalse(self.marker("setup.ok"))

    def test_setup_fails_closed_when_docker_gives_a_network(self):
        self.assertOk(self.phase("preflight"), "preflight")
        self.patch(override_hostconfig={"NetworkMode": "bridge"})
        self.assertFailedClosed(self.phase("setup"))
        self.assertFalse(self.marker("setup.ok"))

    def test_measure_runs_every_attempt_in_order(self):
        self.through("measure")
        ids = [c[c.index("--id") + 1] for c in self.state()["calls"] if "attempt" in c]
        self.assertEqual(ids, ["P0", "N1", "N2", "N3", "N4", "N5a", "N5b", "N6", "N7a", "N7b", "N8", "N9", "N10", "N11", "N12", "N13",
                               "N14", "N16", "N17", "N18", "N19"])

    def test_capture_verifies_and_cleanup_removes_on_captured(self):
        self.through("capture")
        self.assertTrue(self.marker("capture.ok"))
        r = subprocess.run(["sha256sum", "-c", "--quiet", "SHA256SUMS"], cwd=self.res, capture_output=True)
        self.assertEqual(r.returncode, 0)
        self.assertOk(self.phase("cleanup"), "cleanup")
        with open(os.path.join(self.res, "removal.json")) as f:
            self.assertEqual(json.load(f)["basis"], "captured")
        self.assertEqual(self.state()["containers"], [])

    def test_validate_reports_and_fails_without_pass(self):
        self.through("capture")
        r = self.phase("validate")
        self.assertFailedClosed(r, 2)
        with open(os.path.join(self.res, "report.json")) as f:
            self.assertEqual(json.load(f)["verdict"], "INCONCLUSIVE")

    def test_cleanup_refuses_evidence_without_capture(self):
        self.through("measure")
        os.makedirs(os.path.join(self.cfs, "home/developer/b1/P0"), exist_ok=True)
        with open(os.path.join(self.cfs, "home/developer/b1/P0/result.json"), "w") as f:
            f.write("{}")
        self.assertFailedClosed(self.phase("cleanup"), 66)
        self.assertEqual(len(self.state()["containers"]), 1)

    def test_cleanup_discard_needs_the_exact_id(self):
        self.through("measure")
        os.makedirs(os.path.join(self.cfs, "tmp/passb1/out"), exist_ok=True)
        with open(os.path.join(self.cfs, "tmp/passb1/out/x"), "w") as f:
            f.write("x")
        self.assertFailedClosed(self.phase("cleanup", B1_DISCARD_EVIDENCE="0" * 64), 66)
        cid = open(os.path.join(self.base, "state", "container_id")).read().strip()
        self.assertOk(self.phase("cleanup", B1_DISCARD_EVIDENCE=cid), "cleanup")
        with open(os.path.join(self.res, "removal.json")) as f:
            self.assertEqual(json.load(f)["basis"], "discard-authorized")

    def test_cleanup_never_touches_a_container_that_is_not_ours(self):
        self.through("setup")
        s = self.state()
        s["containers"].append({"id": "d" * 64, "name": f"passb1a-exp-{self.stamp}-x", "labels": {"passb1.experiment": self.stamp},
                                "user": "developer", "hc": {}, "mounts": []})
        self.write_state(s)
        self.assertFailedClosed(self.phase("cleanup"), 66)
        self.assertIn("d" * 64, [c["id"] for c in self.state()["containers"]])

    def test_cleanup_stopped_container_is_never_no_evidence(self):
        self.through("measure")
        s = self.state()
        s["containers"][0]["stopped"] = True
        self.write_state(s)
        self.assertFailedClosed(self.phase("cleanup"), 66)


class B1b(Runner):
    kind = "b1b"

    def test_setup_installs_root_copy_as_root_without_relaxing_the_container(self):
        self.through("setup")
        run = next(c for c in self.state()["calls"] if c[:1] == ["run"])
        self.assertEqual(run[run.index("--network") + 1], "none")
        self.assertEqual(run[run.index("--cap-drop") + 1], "ALL")
        self.assertEqual([m for i, m in enumerate(run) if run[i - 1] == "--mount"], [f"type=bind,src={KIT},dst=/opt/passb1-kit,readonly"])
        self.assertTrue(self.state()["installed"])
        with open(os.path.join(self.base, "state", "hnd-setup.json")) as f:
            self.assertEqual(json.load(f), {"installed": True, "sha256_ok": True, "uid": 0, "gid": 0, "mode": "711", "size": 298229464})

    def test_setup_failure_is_recorded_and_fails_closed(self):
        self.assertOk(self.phase("preflight"), "preflight")
        self.patch(fail_install=True)
        self.assertFailedClosed(self.phase("setup"))
        self.assertFalse(self.marker("setup.ok"))
        with open(os.path.join(self.base, "state", "hnd-setup.json")) as f:
            self.assertEqual(json.load(f), {"installed": False})

    def test_wrong_hash_or_mode_fails_closed(self):
        for kw in ({"hnd_sha": "0" * 64}, {"hnd_mode": "755"}):
            with self.subTest(kw):
                self.setUp()
                self.assertOk(self.phase("preflight"), "preflight")
                self.patch(**kw)
                self.assertFailedClosed(self.phase("setup"))
                self.assertFalse(self.marker("setup.ok"))

    def test_root_copy_that_does_not_start_is_evidence_not_a_harness_error(self):
        self.through("setup")
        self.patch(fail_hnd_start=True)
        r = self.phase("measure")
        self.assertOk(r, "measure")
        self.assertIn("la copia de root no arrancó", r.stderr)
        stats = [c for c in self.state()["calls"] if "hnd-stat" in c]
        self.assertEqual(len(stats), 1, "only the control is measured")

    def test_control_that_does_not_start_fails_closed(self):
        self.through("setup")
        self.patch(fail_ctl_start=True)
        self.assertFailedClosed(self.phase("measure"))
        self.assertFalse(self.marker("measure.ok"))
        self.assertFalse([c for c in self.state()["calls"] if "hnd-stat" in c])

    def test_measure_capture_validate(self):
        self.through("capture")
        names = {c[7] for c in self.state()["calls"] if c[:1] == ["exec"] and c[4:7] == ["python3", "-I", "/opt/passb1-kit/b1.py"]}
        self.assertTrue({"sysinfo", "immut", "inventory", "hnd-stat"} <= names, names)
        self.assertFalse(any("hostexe" in " ".join(c) for c in self.state()["calls"]), "H6c is not part of the procedure")
        r = self.phase("validate")
        self.assertFailedClosed(r, 2)


if __name__ == "__main__":
    unittest.main()
