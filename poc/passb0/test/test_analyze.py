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

CLI, CHILD, BASE_C, BASE_H, OTHER, SRV_C = 87, 301, 402, 403, 999, 55
HOST = {CLI: 40087, BASE_C: 40402, BASE_H: 40403, OTHER: 40999}
SHA = "a" * 64
CTR = "f" * 64


def server(scope, label, conn, nonce, pid=CLI, peer_ino=None, local_ino=None):
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
    rec = {"scope": "container" if scope == "c" else "host", "cred": cred, "pidfd": pidfd, "proc": proc,
           "conn": conn, "nonce": nonce, "label": label, "status": 200, "local_ino": local_ino, "peer_ino": peer_ino}
    if scope == "h":
        # What VM100 run 2 showed: the host cannot resolve the peer (other network namespace).
        rec["peer_ino"], rec["peer_ino_error"] = None, "ENOENT"
    return rec


def fixture():
    mod = [{"inst": "i1", "seq": 1, "kind": "session.start"}]
    c, h = [], []
    for i, (label, target) in enumerate((("c1", "c"), ("h1", "h"), ("h2", "h"), ("hold-c", "c"), ("hold-h", "h"))):
        conn, nonce, ino = f"{i:016x}", f"n{i}", 7000 + i
        rec = {"inst": "i1", "seq": i + 2, "kind": "call", "label": label, "target": target, "nonce": nonce,
               "ok": True, "status": 200, "conn": conn}
        if label.startswith("hold"):
            rec["waitheld"] = {"waited": True, "conn": conn}
            rec["child"] = {"exit": 0, "self_pid": CHILD, "self_ppid": CLI, "waited": True, "held_conn": conn,
                            "local_ino": 8000 + i,
                            "diag": {"found": True, "error": None, "stream_established": True, "mutual": True,
                                     "server_agrees": True if target == "c" else None},
                            "peer_known": True, "peer_in_self": False, "own_socket_count": 0, "scan_denied": 0,
                            "holders": [{"pid": CLI, "fd": 31, "cloexec": True}],
                            # In the container the internal server holds hold-c's accepted end; nobody holds hold-h's.
                            "local_holder_pids": [SRV_C] if target == "c" else []}
        mod.append(rec)
        (c if target == "c" else h).append(server(target, label, conn, nonce, peer_ino=ino if label != "h2" else 7001, local_ino=8000 + i))
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
        "preflight": {"cli_version": "2.1.314", "kernel": "6.8.0", "ptrace_scope": "1", "image_id_prefix": "abababababab"},
        "cli_before": {"version": "2.1.314"},
        "cli_after": {"version": "2.1.314"},
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
        # Informative only, and the host cannot resolve a client end: absent, never guessed.
        self.assertNotIn("h2_reused_h1_connection", r["facts"])
        self.assertEqual(r["facts"]["hold-c_fd"]["holders"], ["CLI"])
        self.assertEqual(r["facts"]["hold-h_fd"]["holders"], ["CLI"])
        self.assertEqual(r["facts"]["hold-h_fd"]["accepted_end"], {"matches_server_record": True, "stream_established": True,
                                                                  "mutual": True, "server_agrees": None, "error": None})

    def test_report_leaks_no_identifier(self):
        out = json.dumps(analyze.analyze(fixture()))
        for v in (str(CLI), str(HOST[CLI]), "0000000000000003", SHA, "7003", "8004", str(SRV_C)):
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
        for name, key in (("capture-manifest.json", "manifest"), ("cliinfo.json", "cliinfo"), ("base-c.json", "base_c"), ("base-h.json", "base_h"), ("control-c.json", "control"), ("rocheck.json", "rocheck"), ("preflight.json", "preflight"), ("cli-version-before.json", "cli_before"), ("cli-version-after.json", "cli_after")):
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
    # The accepted end's inode, as it came through the held file, is never taken on trust.
    ("held inode is another connection's", lambda D: call(D, "hold-h")["child"].update(local_ino=8001), "INCONCLUSIVE", "held-socket-mismatch:hold-h"),
    ("held inode absent", lambda D: call(D, "hold-h")["child"].update(local_ino=None), "INCONCLUSIVE", "held-socket-mismatch:hold-h"),
    ("server recorded no inode", lambda D: srv(D, "hold-h").update(local_ino=None), "INCONCLUSIVE", "held-socket-mismatch:hold-h"),
    ("held inode bool", lambda D: call(D, "hold-h")["child"].update(local_ino=True), "INCONCLUSIVE", "held-socket-mismatch:hold-h"),
    ("accepted end held in the container", lambda D: call(D, "hold-h")["child"].update(local_holder_pids=[OTHER]), "INCONCLUSIVE", "held-socket-mismatch:hold-h"),
    ("accepted-end holders unknown", lambda D: call(D, "hold-h")["child"].update(local_holder_pids=None), "INCONCLUSIVE", "held-socket-mismatch:hold-h"),
    ("connection closed (peer not mutual)", lambda D: call(D, "hold-h")["child"]["diag"].update(mutual=False), "INCONCLUSIVE", "peer-inode-unknown:hold-h"),
    ("checker says known but not mutual", lambda D: call(D, "hold-c")["child"]["diag"].update(mutual=False), "INCONCLUSIVE", "peer-inode-unknown:hold-c"),
    ("accepted end not found", lambda D: call(D, "hold-h")["child"].update(peer_known=False, diag={"found": False, "error": "ENOENT", "stream_established": False, "mutual": False, "server_agrees": None}), "INCONCLUSIVE", "peer-inode-unknown:hold-h"),
    ("checker diag missing", lambda D: call(D, "hold-h")["child"].update(diag=None), "INCONCLUSIVE", "peer-inode-unknown:hold-h"),
    ("server and checker disagree (container)", lambda D: call(D, "hold-c")["child"]["diag"].update(server_agrees=False), "INCONCLUSIVE", "peer-inode-unknown:hold-c"),
    ("server and checker disagree (host)", lambda D: call(D, "hold-h")["child"]["diag"].update(server_agrees=False), "INCONCLUSIVE", "peer-inode-unknown:hold-h"),
    ("container server peer missing", lambda D: call(D, "hold-c")["child"]["diag"].update(server_agrees=None), "INCONCLUSIVE", "peer-inode-unknown:hold-c"),
    ("hold-h conn of another call", lambda D: srv(D, "hold-h").update(nonce="zz"), "FAIL", "connection-not-matched:hold-h"),
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
    ("CLI changed during the run", lambda D: D["cli_after"].update(version="2.1.315"), "INCONCLUSIVE", "cli-version-mismatch:after"),
    ("CLI version after not recorded", lambda D: D.update(cli_after=None), "INCONCLUSIVE", "cli-version-unverified:after"),
    ("CLI version after empty", lambda D: D["cli_after"].update(version=""), "INCONCLUSIVE", "cli-version-unverified:after"),
    ("CLI in container not 2.1.314", lambda D: D["cli_before"].update(version="2.1.308"), "INCONCLUSIVE", "cli-version-mismatch:before"),
    ("preflight version other", lambda D: D["preflight"].update(cli_version="2.1.308"), "INCONCLUSIVE", "cli-version-mismatch:preflight"),
    ("preflight missing", lambda D: D.update(preflight=None), "INCONCLUSIVE", "cli-version-unverified:preflight"),
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

    def test_unsynchronized_checker_says_which_step_and_why(self):
        def m(D):
            call(D, "hold-h").update(waitheld={"waited": False, "conn": None, "error": None, "exit": 0, "held_last_error": "EACCES"})
            call(D, "hold-h").pop("child")
        r = run(m)
        self.assertEqual(r["verdict"], "INCONCLUSIVE")
        self.assertIn("checker-not-synchronized:hold-h", r["reasons"])
        self.assertEqual(r["facts"]["hold-h_sync"], {"waitheld_waited": False, "waitheld_error": None, "waitheld_held_last_error": "EACCES",
                                                     "fdcheck_ran": False, "fdcheck_waited": False, "fdcheck_held_last_error": None,
                                                     "conn_matches": False})
        self.assertNotIn("hold-c_sync", r["facts"])

    def test_main_exit_code_on_non_pass(self):
        d = tempfile.mkdtemp()
        self.assertEqual(quiet_main(["analyze.py", "report", d]), 2)


# The CLI's own templates (2.1.314), with the debug log's line prefix.
P = "2026-11-03T15:20:00.000Z [DEBUG] "
HELD = P + "hooks modules not loaded until workspace trust is accepted: st-passb0-probe, sec-default\n"
LOADED = P + "hooks module st-passb0-probe@inline loaded (worker, environment e1, tier user); events: session.start\n"
TYPE_ROOT_EROFS = P + "type root of st-passb0-probe not laid: EROFS: read-only file system, mkdir '/x/types'\n"


class DebugLog(unittest.TestCase):
    """The trust-held line is exempt only when a load of the probe follows it."""

    def verdict(self, text):
        D = fixture()
        D["debug"] = analyze.debug_scan(text.splitlines(keepends=True))
        return analyze.analyze(D)

    def test_held_until_trust_then_loaded_is_not_a_problem(self):
        r = self.verdict(HELD + TYPE_ROOT_EROFS + LOADED)
        self.assertEqual(r["verdict"], "PASS", r["reasons"])
        self.assertEqual((r["facts"]["debug_mod_bad_lines"], r["facts"]["debug_mod_trust_held_then_loaded"],
                          r["facts"]["debug_mod_trust_held_never_loaded"]), (0, 1, 0))

    def test_held_and_never_loaded_is_a_problem(self):
        r = self.verdict(HELD + TYPE_ROOT_EROFS)
        self.assertEqual(r["verdict"], "INCONCLUSIVE")
        self.assertIn("debug-log-mod-problem", r["reasons"])
        self.assertEqual(r["facts"]["debug_mod_trust_held_never_loaded"], 1)

    def test_held_then_definitive_load_failure_is_a_problem(self):
        fail = P + "hooks module st-passb0-probe@inline failed to load: SyntaxError\n"
        for text in (HELD + fail, HELD + fail + LOADED, HELD + LOADED + fail):
            with self.subTest(text=text):
                self.assertIn("debug-log-mod-problem", self.verdict(text)["reasons"])

    def test_load_before_the_held_line_does_not_resolve_it(self):
        self.assertIn("debug-log-mod-problem", self.verdict(LOADED + HELD)["reasons"])

    def test_other_not_loaded_messages_still_count(self):
        for line in (P + "hooks module st-passb0-probe@inline not loaded: policy\n",
                     P + "hooks module st-passb0-probe@inline update skipped: re-entry (x)\n",
                     P + "hooks modules not loaded until workspace trust is accepted: st-passb0-probe-x\n",
                     P + "plugin hooks after workspace trust: st-passb0-probe failed\n"):
            with self.subTest(line=line):
                self.assertIn("debug-log-mod-problem", self.verdict(line + LOADED)["reasons"])

    def test_load_of_another_module_does_not_resolve_it(self):
        other = P + "hooks module st-passb0-probe2@inline loaded (worker, environment e1, tier user); events: x\n"
        self.assertIn("debug-log-mod-problem", self.verdict(HELD + other)["reasons"])

    def test_a_load_line_that_itself_reports_a_problem_does_not_resolve_it(self):
        odd = P + "hooks module st-passb0-probe@inline loaded (worker, environment e1, tier user); events: error\n"
        self.assertEqual(analyze.debug_scan([HELD, odd])["trust_held_never_loaded"], 1)

    def test_read_only_type_root_is_not_flagged(self):
        self.assertEqual(analyze.debug_scan([TYPE_ROOT_EROFS])["mod_bad_lines"], 0)

    def test_load_reads_the_file_the_same_way(self):
        d = tempfile.mkdtemp()
        with open(f"{d}/claude-debug.log", "w") as f:
            f.write(HELD + LOADED)
        self.assertEqual(analyze.load(d)["debug"], {"mod_lines": 2, "mod_bad_lines": 0,
                                                    "trust_held_then_loaded": 1, "trust_held_never_loaded": 0})


if __name__ == "__main__":
    unittest.main()
