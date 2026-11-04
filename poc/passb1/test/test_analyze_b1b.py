"""Synthetic tests of analyze_b1b.py (H-ND): one PASS fixture and mutations per criterion.
Run: python3 test/test_analyze_b1b.py"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import analyze_b1b as B  # noqa: E402

DENY = {k: "EACCES" for k in B.READ_MODE} | {k: "EPERM" for k in B.ATTACH_MODE}


def stat(owner, reads, st=5000):
    # As the kernel reports it: fdinfo/ (a world r-x directory) keeps the task's euid.
    owners = {e: owner for e in ("environ", "auxv", "maps", "mem")} | {"fdinfo": 1000, "status": owner, "cmdline": owner}
    return {"starttime": st, "starttime_after": st, "owner_uid": owners, "reads": dict(reads)}


def fixture():
    ctl_reads = {k: "ok" for k in B.READ_MODE} | {"mem": "EACCES", "process_vm_readv": "EPERM", "ptrace_seize": "EPERM", "pidfd_getfd": "EPERM"}
    return {
        "setup": {"installed": True, "sha256_ok": True, "uid": 0, "gid": 0, "mode": "711", "size": 298229464},
        "sysinfo": {"kernel": "6.8.0-147-generic", "ptrace_scope": "1", "suid_dumpable": "2", "core_pattern_is_pipe": True, "protected_hardlinks": "1"},
        "immut": {"open_write": "EACCES", "chmod": "EPERM", "rename": "EACCES", "unlink": "EACCES", "hardlink_tmp": "EPERM",
                  "create_in_dir": "EACCES", "rename_dir": "EACCES", "file": {"uid": 0, "gid": 0, "mode": "0o711"}, "dir": {"uid": 0, "mode": "0o755"}},
        "inventory": {"copies": [{"path_class": "opt-st-hnd", "readable": False, "same_sha256": None},
                                 {"path_class": "npm-global", "readable": True, "same_sha256": True}]},
        "version": {"version": "2.1.314"},
        "after": {"sha256_unchanged": True, "owner_mode_unchanged": True, "update_rc": "1"},
        "stat-hnd-t0": stat(0, DENY), "stat-ctl-t0": stat(1000, ctl_reads, 6000), "stat-hnd-t1": stat(0, DENY),
        "anc_hnd": {"plain": {"alive": True, **stat(0, DENY)},
                    "traced_before_exec": {"stopped_at_exec": True, "peekdata": "EIO", "getregs": "ok", "owner_uid_environ": 0}},
        "anc_ctl": {"plain": {"alive": True, **stat(1000, {k: "ok" for k in B.READ_MODE + B.ATTACH_MODE})},
                    "traced_before_exec": {"stopped_at_exec": True, "peekdata": "ok", "getregs": "ok", "owner_uid_environ": 1000}},
        "probe": {"hnd": ["classic.SessionStart", "session.start"], "ctl": ["classic.SessionStart", "session.start"],
                  "hnd_reach": {"bun": "object", "set_dumpable": "undefined"}},
        "manifest": {"complete": True}, "preflight": {"cli_version": "2.1.314"},
        "cli_before": {"version": "2.1.314"}, "cli_after": {"version": "2.1.314"},
    }


def run(mutate):
    D = fixture()
    mutate(D)
    return B.analyze(D)


NEGATIVES = [
    ("setup failed", lambda D: D.update(setup={"installed": False}), "INCONCLUSIVE", "hnd-setup-failed"),
    ("wrong hash", lambda D: D["setup"].update(sha256_ok=False), "INCONCLUSIVE", "hnd-setup-failed"),
    ("readable mode", lambda D: D["setup"].update(mode="755"), "INCONCLUSIVE", "hnd-setup-failed"),
    ("not root", lambda D: D["setup"].update(uid=1000), "INCONCLUSIVE", "hnd-setup-failed"),
    ("capture incomplete", lambda D: D["manifest"].update(complete=False), "INCONCLUSIVE", "capture-incomplete"),
    ("CLI changed", lambda D: D["cli_after"].update(version="2.1.315"), "INCONCLUSIVE", "cli-version-mismatch:after"),
    ("ptrace scope", lambda D: D["sysinfo"].update(ptrace_scope="0"), "INCONCLUSIVE", "ptrace-scope-not-1"),
    ("root copy does not run", lambda D: D.update(version={"version": None}), "FAIL", "H1-root-copy-does-not-run"),
    ("mods do not run from root copy", lambda D: D["probe"].update(hnd=[]), "FAIL", "H1-mods-do-not-run-from-root-copy"),
    ("control did not start", lambda D: D["probe"].update(ctl=[]), "INCONCLUSIVE", "H1-control-did-not-start"),
    ("control environ unreadable", lambda D: D["stat-ctl-t0"]["reads"].update(environ="EACCES"), "INCONCLUSIVE", "control-read-mode-incomplete"),
    ("control owner root", lambda D: D["stat-ctl-t0"]["owner_uid"].update(environ=0), "INCONCLUSIVE", "control-not-readable"),
    ("dumpable at start", lambda D: D["stat-hnd-t0"]["owner_uid"].update(environ=1000), "FAIL", "H2-dumpable:stat-hnd-t0"),
    ("dumpable later", lambda D: D["stat-hnd-t1"]["owner_uid"].update(mem=1000), "FAIL", "H2-dumpable:stat-hnd-t1"),
    ("owner unreadable", lambda D: D["stat-hnd-t0"]["owner_uid"].update(maps="ENOENT"), "INCONCLUSIVE", "H2-owner-unknown:stat-hnd-t0"),
    ("environ readable", lambda D: D["stat-hnd-t0"]["reads"].update(environ="ok"), "FAIL", "H3-read-readable:stat-hnd-t0"),
    ("fd link readable", lambda D: D["stat-hnd-t1"]["reads"].update(fd_link="ok"), "FAIL", "H3-read-readable:stat-hnd-t1"),
    ("read not attempted", lambda D: D["stat-hnd-t0"]["reads"].pop("auxv"), "FAIL", "H3-read-readable:stat-hnd-t0"),
    ("later sample missing", lambda D: D.pop("stat-hnd-t1"), "INCONCLUSIVE", "stat-hnd-t1-missing"),
    ("process replaced", lambda D: D["stat-hnd-t1"].update(starttime=9999, starttime_after=9999), "INCONCLUSIVE", "H7-process-changed"),
    ("ancestor reads memory", lambda D: D["anc_hnd"]["plain"]["reads"].update(mem="ok"), "FAIL", "H4-ancestor-can-read"),
    ("ancestor can seize", lambda D: D["anc_hnd"]["plain"]["reads"].update(ptrace_seize="ok"), "FAIL", "H4-ancestor-can-read"),
    ("ancestor control cannot attach", lambda D: D["anc_ctl"]["plain"]["reads"].update(mem="EACCES"), "INCONCLUSIVE", "H4-control-incomplete"),
    ("ancestor missing", lambda D: D.update(anc_hnd=None), "INCONCLUSIVE", "H4-missing"),
    ("control READ incomplete blocks H-ND credit", lambda D: D["stat-ctl-t0"]["reads"].update(maps="EACCES"), "INCONCLUSIVE", "control-read-mode-incomplete"),
    ("H4 control cannot attach => no credit", lambda D: D["anc_ctl"]["plain"]["reads"].update(ptrace_seize="EPERM"), "INCONCLUSIVE", "H4-control-incomplete"),
    ("pid/starttime changed", lambda D: D["stat-hnd-t1"].update(starttime=7777, starttime_after=7777), "INCONCLUSIVE", "H7-process-changed"),
    ("user cores allowed", lambda D: D["sysinfo"].update(suid_dumpable="1"), "FAIL", "H5-suid-dumpable-allows-user-cores"),
    ("root copy writable", lambda D: D["immut"].update(open_write="ok"), "FAIL", "H6a-root-copy-changeable"),
    ("folder replaceable", lambda D: D["immut"].update(rename_dir="ok"), "FAIL", "H6a-root-copy-changeable"),
    ("root copy mode", lambda D: D["immut"]["file"].update(mode="0o755"), "FAIL", "H6a-root-copy-changeable"),
    ("immut missing", lambda D: D.update(immut=None), "INCONCLUSIVE", "H6a-missing"),
    ("root copy readable", lambda D: D["inventory"]["copies"][0].update(readable=True), "INCONCLUSIVE", "H6b-root-copy-not-found-unreadable"),
    ("root copy changed by update", lambda D: D["after"].update(sha256_unchanged=False), "FAIL", "H7-root-copy-changed"),
    ("after missing", lambda D: D.update(after=None), "INCONCLUSIVE", "H7-missing"),
]


class Pass(unittest.TestCase):
    def test_nominal(self):
        r = B.analyze(fixture())
        self.assertEqual(r["verdict"], "PASS", r["reasons"])
        self.assertEqual(r["facts"]["H5_core_precondition"]["disposition"], "root-only-host-context")
        self.assertFalse(r["facts"]["H5_core_precondition"]["demonstrated"])
        # Every H-ND denial has a matching per-op control success.
        self.assertEqual(set(r["facts"]["control"]["read_mode_ok"]), set(B.READ_MODE))
        self.assertEqual(set(r["facts"]["H4"]["control_ok"]), set(B.READ_MODE + B.ATTACH_MODE))
        self.assertTrue(r["facts"]["pid_starttime_stable"])
        self.assertIn("H6c", r["pending"])

    def test_residuals_are_reported_never_folded_in(self):
        def m(D):
            D["probe"]["hnd_reach"] = {"bun": "object", "set_dumpable": "function"}
        r = run(m)
        self.assertEqual(r["verdict"], "PASS")
        self.assertTrue(r["facts"]["H8_mod_can_reach_set_dumpable"])
        self.assertEqual(r["facts"]["H4b_residual_pre_exec_tracer"],
                         {"stopped_at_exec": True, "peekdata_denied": True, "getregs_kept": True, "control_peekdata_ok": True})


class Negatives(unittest.TestCase):
    def test_each_mutation(self):
        for name, mutate, verdict, reason in NEGATIVES:
            with self.subTest(name):
                r = run(mutate)
                self.assertEqual(r["verdict"], verdict, (name, r["reasons"]))
                self.assertIn(reason, r["reasons"], name)


class Load(unittest.TestCase):
    def test_round_trip_and_exit_code(self):
        D = fixture()
        d = tempfile.mkdtemp()
        h = os.path.join(d, "hnd")
        os.makedirs(h)
        for k in ("setup", "sysinfo", "immut", "inventory", "version", "after", "stat-hnd-t0", "stat-ctl-t0", "stat-hnd-t1"):
            with open(os.path.join(h, f"{k}.json"), "w") as f:
                json.dump(D[k], f)
        for s, key in (("anc-hnd", "anc_hnd"), ("anc-ctl", "anc_ctl")):
            os.makedirs(os.path.join(h, s))
            with open(os.path.join(h, s, "ancestor.json"), "w") as f:
                json.dump(D[key], f)
        for s in ("hnd", "ctl"):
            os.makedirs(os.path.join(h, f"probe-{s}"))
            for i, kind in enumerate(("session.start", "classic.SessionStart")):
                with open(os.path.join(h, f"probe-{s}", f"x-{i}.json"), "w") as f:
                    json.dump({"probe": "st-b1-probe", "kind": kind, **({"reach": D["probe"]["hnd_reach"]} if i == 0 else {})}, f)
        for name, key in (("capture-manifest.json", "manifest"), ("preflight.json", "preflight"), ("cli-version-before.json", "cli_before"),
                          ("cli-version-after.json", "cli_after")):
            with open(os.path.join(d, name), "w") as f:
                json.dump(D[key], f)
        self.assertEqual(B.analyze(B.load(d))["verdict"], "PASS", B.analyze(B.load(d))["reasons"])
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(B.main(["analyze_b1b.py", "report", d]), 0)
            self.assertEqual(B.main(["analyze_b1b.py", "report", tempfile.mkdtemp()]), 2)


if __name__ == "__main__":
    unittest.main()
