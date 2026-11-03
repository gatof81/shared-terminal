"""Synthetic tests of analyze.py: one PASS fixture and one mutation per criterion.
Run: python3 test/test_analyze.py"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import analyze  # noqa: E402

CLI, CHILD, BASE_C, BASE_H, OTHER = 87, 301, 402, 403, 999
HOST = {CLI: 40087, BASE_C: 40402, BASE_H: 40403, OTHER: 40999}
SHA = "a" * 64
CTR = "f" * 64


def server(scope, label, conn, nonce, pid=CLI, peer_ino=None):
    hp = HOST[pid]
    proc = {"tgid": pid, "starttime": 5000 if pid == CLI else 6000, "stable": True, "uid": 1000}
    if scope == "c":
        proc["exe_sha256"] = SHA if pid == CLI else "b" * 64
        cred = {"pid": pid, "uid": 1000, "gid": 1000}
        pidfd = {"ok": True, "pid": pid, "nspid": [pid], "alive_after": True}
    else:
        proc.update({"tgid": hp, "nspid": [hp, pid], "cgroup_match": True})
        cred = {"pid": hp, "uid": 1000, "gid": 1000}
        pidfd = {"ok": True, "pid": hp, "nspid": [hp, pid], "alive_after": True}
    return {"scope": "container" if scope == "c" else "host", "cred": cred, "pidfd": pidfd, "proc": proc,
            "conn": conn, "nonce": nonce, "label": label, "status": 200, "peer_ino": peer_ino}


def fixture():
    mod = [{"inst": "i1", "seq": 1, "kind": "session.start"}]
    c, h = [], []
    for i, (label, target) in enumerate((("c1", "c"), ("h1", "h"), ("h2", "h"), ("hold-c", "c"), ("hold-h", "h"))):
        conn, nonce, ino = f"{i:016x}", f"n{i}", 7000 + i
        rec = {"inst": "i1", "seq": i + 2, "kind": "call", "label": label, "target": target, "nonce": nonce,
               "ok": True, "status": 200, "conn": conn}
        if label.startswith("hold"):
            rec["waitheld"] = {"waited": True, "conn": conn}
            rec["child"] = {"exit": 0, "self_pid": CHILD, "self_ppid": CLI, "waited": True, "held_conn": conn, "peer_known": True,
                            "peer_in_self": False, "own_socket_count": 0, "scan_denied": 0,
                            "holders": [{"pid": CLI, "fd": 31, "cloexec": True}]}
        mod.append(rec)
        (c if target == "c" else h).append(server(target, label, conn, nonce, peer_ino=ino if label != "h2" else 7001))
    mod.append({"inst": "i1", "seq": 7, "kind": "done", "calls": 5})
    c.append(server("c", "base", "b" * 16, "bc", pid=BASE_C))
    h.append(server("h", "base", "c" * 16, "bh", pid=BASE_H))
    return {
        "mod": mod, "mod_bad": 0, "c": c, "h": h, "server_bad": 0,
        "cliinfo": {"cli": [{"pid": CLI, "tgid": CLI, "ppid": 1, "starttime": 5000, "uid": 1000, "tracerpid": 0,
                             "exe_name": "claude.exe", "exe_sha256": SHA, "exe_deleted": False}], "mods_flag_cached": True},
        "base_c": {"label": "base", "self_pid": BASE_C, "nonce": "bc", "status": 200, "conn": "b" * 16},
        "base_h": {"label": "base", "self_pid": BASE_H, "nonce": "bh", "status": 200, "conn": "c" * 16},
        "control": {"label": "control", "status": 200, "conn": "d" * 16,
                    "child": {"waited": True, "peer_known": True, "peer_in_self": True}},
        "rocheck": {"create": "EROFS", "mkdir": "EROFS", "rename": "EROFS", "unlink": "EROFS"},
        "debug": {"mod_lines": 2, "mod_bad_lines": 0},
        "preflight": None,
        "manifest": {"items": {"mod": "ok"}, "files": {"c.jsonl": True}, "mod_files": 7, "complete": True},
    }


def dump(path, obj):
    with open(path, "w") as f:
        json.dump(obj, f)


def quiet_main(argv):
    with contextlib.redirect_stdout(io.StringIO()):
        return analyze.main(argv)


def call(D, label):
    return next(r for r in D["mod"] if r.get("label") == label)


def srv(D, label):
    return next(r for r in D["c"] + D["h"] if r.get("label") == label)


def run(mutate):
    D = fixture()
    mutate(D)
    return analyze.analyze(D)


class Pass(unittest.TestCase):
    def test_nominal(self):
        r = analyze.analyze(fixture())
        self.assertEqual(r["verdict"], "PASS", r["reasons"])
        self.assertEqual(r["reasons"], [])
        self.assertTrue(r["facts"]["h2_reused_h1_connection"])
        self.assertEqual(r["facts"]["hold-c_fd"]["holders"], ["CLI"])

    def test_report_leaks_no_identifier(self):
        out = json.dumps(analyze.analyze(fixture()))
        for v in (str(CLI), str(HOST[CLI]), "0000000000000003", SHA, "7003"):
            self.assertNotIn(v, out)

    def test_load_round_trip(self):
        D = fixture()
        d = tempfile.mkdtemp()
        os.makedirs(f"{d}/mod")
        for r in D["mod"]:
            dump(f"{d}/mod/i1-{r['seq']:04d}.json", r)
        for name, rows in (("c.jsonl", D["c"]), ("h.jsonl", D["h"])):
            with open(f"{d}/{name}", "w") as f:
                f.writelines(json.dumps(x) + "\n" for x in rows)
        for name, key in (("capture-manifest.json", "manifest"), ("cliinfo.json", "cliinfo"), ("base-c.json", "base_c"), ("base-h.json", "base_h"), ("control-c.json", "control"), ("rocheck.json", "rocheck")):
            dump(f"{d}/{name}", D[key])
        with open(f"{d}/claude-debug.log", "w") as f:
            f.write("x st-passb0-probe loaded\ny unrelated failed\n")
        self.assertEqual(analyze.analyze(analyze.load(d))["verdict"], "PASS")
        self.assertEqual(quiet_main(["analyze.py", "report", d]), 0)


NEGATIVES = [
    # (name, mutation, verdict, reason)
    ("mod not loaded", lambda D: D.update(mod=[]), "INCONCLUSIVE", "mod-not-loaded"),
    ("seq gap", lambda D: D["mod"].pop(3), "INCONCLUSIVE", "mod-records-incomplete"),
    ("two instances", lambda D: D["mod"][2].update(inst="i2"), "INCONCLUSIVE", "mod-records-incomplete"),
    ("no done", lambda D: D["mod"].pop(), "INCONCLUSIVE", "mod-not-done"),
    ("debug log problem", lambda D: D["debug"].update(mod_bad_lines=1), "INCONCLUSIVE", "debug-log-mod-problem"),
    ("two CLI processes", lambda D: D["cliinfo"]["cli"].append(dict(D["cliinfo"]["cli"][0], pid=88)), "INCONCLUSIVE", "cli-process-ambiguous"),
    ("plugin network policy", lambda D: call(D, "c1").update(ok=False, error="network-policy"), "INCONCLUSIVE", "plugin-network-policy:c1"),
    ("no unix transport", lambda D: call(D, "h1").update(ok=False, error="no-unix-transport"), "FAIL", "socketpath-refused:h1"),
    ("call not delivered", lambda D: call(D, "c1").update(ok=False, error="connect-failed"), "FAIL", "call-not-delivered:c1"),
    ("status not 200", lambda D: call(D, "c1").update(status=500), "FAIL", "status:c1"),
    ("conn not matched", lambda D: call(D, "h1").update(conn="e" * 16), "FAIL", "connection-not-matched:h1"),
    ("nonce mismatch", lambda D: srv(D, "c1").update(nonce="zz"), "FAIL", "connection-not-matched:c1"),
    ("broker pid (container)", lambda D: srv(D, "c1").update(cred={"pid": OTHER, "uid": 1000, "gid": 1000}), "FAIL", "peer-not-cli:c1"),
    ("thread id not tgid", lambda D: srv(D, "c1")["proc"].update(tgid=CLI + 1), "FAIL", "peer-not-cli:c1"),
    ("pid reused (starttime)", lambda D: srv(D, "hold-c")["proc"].update(starttime=1), "FAIL", "peer-not-cli:hold-c"),
    ("other binary", lambda D: srv(D, "c1")["proc"].update(exe_sha256="c" * 64), "FAIL", "peer-not-cli:c1"),
    ("pidfd names another process", lambda D: srv(D, "c1")["pidfd"].update(pid=OTHER), "FAIL", "peer-not-cli:c1"),
    ("unstable /proc read", lambda D: srv(D, "c1")["proc"].update(stable=False), "FAIL", "peer-not-cli:c1"),
    ("host nspid other process", lambda D: srv(D, "h1")["proc"].update(nspid=[HOST[OTHER], OTHER]), "FAIL", "peer-not-cli:h1"),
    ("host nspid unmapped", lambda D: srv(D, "h1")["proc"].update(nspid=[HOST[CLI]]), "FAIL", "peer-not-cli:h1"),
    ("host cgroup other container", lambda D: srv(D, "h2")["proc"].update(cgroup_match=False), "FAIL", "peer-not-cli:h2"),
    ("host pidfd nspid differs", lambda D: srv(D, "h1")["pidfd"].update(nspid=[HOST[OTHER], OTHER]), "FAIL", "peer-not-cli:h1"),
    ("pidfd unavailable", lambda D: [r["pidfd"].update(ok=False, error="ENOPROTOOPT") for r in D["c"] + D["h"]], "INCONCLUSIVE", "pidfd-unavailable"),
    ("baseline seen as CLI", lambda D: srv(D, "base").update(cred={"pid": CLI, "uid": 1000, "gid": 1000}), "FAIL", "baseline-misattributed:c"),
    ("baseline missing", lambda D: D.update(base_h=None), "INCONCLUSIVE", "baseline-missing:h"),
    ("control failed", lambda D: D["control"]["child"].update(peer_in_self=False), "INCONCLUSIVE", "control-failed"),
    ("checker not synchronized", lambda D: call(D, "hold-c")["child"].update(held_conn="9" * 16), "INCONCLUSIVE", "checker-not-synchronized:hold-c"),
    ("peer inode unknown", lambda D: call(D, "hold-h")["child"].update(peer_known=False), "INCONCLUSIVE", "peer-inode-unknown:hold-h"),
    ("fd not cloexec", lambda D: call(D, "hold-c")["child"]["holders"][0].update(cloexec=False), "FAIL", "fd-not-cloexec:hold-c"),
    ("inherited by child", lambda D: call(D, "hold-h")["child"].update(peer_in_self=True), "FAIL", "inherited-by-child:hold-h"),
    ("held by another process", lambda D: call(D, "hold-c")["child"]["holders"].append({"pid": OTHER, "fd": 3, "cloexec": True}), "FAIL", "connection-held-by-other:hold-c"),
    ("holder not found", lambda D: call(D, "hold-c")["child"].update(holders=[]), "INCONCLUSIVE", "holder-not-found:hold-c"),
    ("holder scan denied", lambda D: call(D, "hold-c")["child"].update(scan_denied=2), "INCONCLUSIVE", "holder-scan-denied:hold-c"),
    ("socket dir writable", lambda D: D["rocheck"].update(unlink="succeeded"), "FAIL", "socket-dir-writable"),
    ("rocheck other errno", lambda D: D["rocheck"].update(mkdir="EACCES"), "INCONCLUSIVE", "rocheck-unexpected-errno"),
    ("rocheck missing", lambda D: D.update(rocheck=None), "INCONCLUSIVE", "rocheck-missing"),
    ("server log missing", lambda D: D.update(h=None), "INCONCLUSIVE", "server-log-missing"),
    ("call missing", lambda D: D["mod"].pop(5), "INCONCLUSIVE", "mod-calls-missing"),
    ("capture incomplete", lambda D: D["manifest"].update(complete=False, items={"mod": "failed:1"}), "INCONCLUSIVE", "capture-incomplete"),
    ("capture manifest missing", lambda D: D.update(manifest=None), "INCONCLUSIVE", "capture-manifest-missing"),
]


class Negatives(unittest.TestCase):
    def test_each_mutation(self):
        for name, mutate, verdict, reason in NEGATIVES:
            with self.subTest(name):
                r = run(mutate)
                self.assertEqual(r["verdict"], verdict, (name, r["reasons"]))
                self.assertIn(reason, r["reasons"], name)

    def test_fail_wins_over_inconclusive(self):
        def m(D):
            D["rocheck"].update(unlink="succeeded")
            D.update(base_h=None)
        self.assertEqual(run(m)["verdict"], "FAIL")

    def test_main_exit_code_on_non_pass(self):
        d = tempfile.mkdtemp()
        self.assertEqual(quiet_main(["analyze.py", "report", d]), 2)


if __name__ == "__main__":
    unittest.main()
