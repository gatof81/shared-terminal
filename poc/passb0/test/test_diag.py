"""Synthetic tests of diag.py (read-only diagnosis of a finished run).
Run: python3 test/test_diag.py"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import diag  # noqa: E402

CONN = {"hold-c": "1" * 16, "hold-h": "2" * 16}
PID, INO = 40087, 987654


def put(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(obj if isinstance(obj, str) else json.dumps(obj))


class Diag(unittest.TestCase):
    def setUp(self):
        self.base = tempfile.mkdtemp()
        res, run = os.path.join(self.base, "results"), os.path.join(self.base, "run")
        os.makedirs(run)
        put(os.path.join(self.base, "env"), f"RES={res}\nRUN={run}\nCOMMIT={'d' * 40}\n")
        put(os.path.join(self.base, "state", "server-h.identity.json"), {"pid": PID, "uid": os.getuid()})
        T = 1_793_719_200_000  # 2026-11-03T15:20:00Z, the debug log's first line
        recs = [{"seq": 1, "t": T + 1000, "kind": "session.start"},
                {"seq": 2, "t": T + 2000, "kind": "call", "label": "hold-c", "target": "c", "nonce": "aa", "ok": True, "conn": CONN["hold-c"],
                 "waitheld": {"waited": True, "conn": CONN["hold-c"]},
                 "child": {"waited": True, "held_conn": CONN["hold-c"], "exit": 0, "holders": [{"pid": PID, "fd": 31}]}},
                {"seq": 3, "t": T + 10100, "kind": "call", "label": "hold-h", "target": "h", "nonce": "bb", "ok": True, "conn": CONN["hold-h"],
                 "waitheld": {"waited": False, "conn": None}}]
        for r in recs:
            put(os.path.join(res, "mod", f"i-{r['seq']:04d}.json"), r)
        put(os.path.join(res, "c.jsonl"), json.dumps({"t_ms": T + 1050, "label": "hold-c", "nonce": "aa", "proc": {"exe_name": "claude"}, "peer_ino": INO}) + "\n")
        put(os.path.join(res, "h.jsonl"), json.dumps({"t_ms": T + 2040, "label": "hold-h", "nonce": "bb", "proc": {"exe_name": "claude"}, "peer_ino": INO}) + "\n")
        put(os.path.join(res, "held-h.json"), {"conn": CONN["hold-h"], "peer_ino": INO, "t_ms": T + 2900})
        os.chmod(os.path.join(res, "held-h.json"), 0o600)
        put(os.path.join(res, "report.json"), {"verdict": "INCONCLUSIVE", "reasons": ["checker-not-synchronized:hold-h"]})
        put(os.path.join(res, "claude-debug.log"),
            "2026-11-03T15:20:00.000Z [DEBUG] hooks module st-passb0-probe loaded\n"
            "2026-11-03T15:20:01.500Z [DEBUG] unrelated failed line\n"
            "2026-11-03T15:20:02.250Z [ERROR] st-passb0-probe: something failed for /home/developer/x 0123456789abcdef\n")
        self.res = res

    def test_hold_h_timing_permissions_and_flagged_line(self):
        d = diag.diagnose(self.base)
        h = d["calls"]["hold-h"]
        self.assertEqual(h["ms"], {"server_accept": 40, "mod_emit": 8100, "held_file_written": 900})
        self.assertEqual(h["waitheld"], {"waited": False, "conn_matches_call": False})
        self.assertFalse(h["fdcheck_ran"])
        self.assertTrue(h["held_file_conn_matches_call"])
        self.assertTrue(h["server_read_cli_exe"])
        self.assertEqual(d["held_h_file"]["results_copy"]["mode"], "0o600")
        self.assertFalse(d["held_h_file"]["results_copy"]["other_readable"])
        self.assertTrue(d["host_server"]["operator_is_server_uid"])
        self.assertTrue(d["calls"]["hold-c"]["fdcheck"]["conn_matches_call"])
        dbg = d["debug"]
        self.assertEqual(dbg["mod_lines"], 2)
        self.assertEqual(len(dbg["flagged"]), 1)
        self.assertEqual(dbg["flagged"][0]["matched"], ["error", "failed"])
        self.assertEqual(dbg["flagged"][0]["dt_ms"], 2250)
        self.assertEqual((dbg["flagged"][0]["during_call"], dbg["flagged"][0]["ms_into_call"]), ("hold-h", 250))
        self.assertIn("/home/<user>/x <hex>", dbg["flagged"][0]["text"])

    def test_nothing_identifying_leaves(self):
        out = json.dumps(diag.diagnose(self.base))
        for secret in (*CONN.values(), str(PID), str(INO), "0123456789abcdef", "developer", "aa\"", "bb\""):
            self.assertNotIn(secret, out)

    def test_full_log_context(self):
        full = os.path.join(self.base, "full.log")
        put(full, "a\nb\nc st-passb0-probe ok\nd st-passb0-probe refused x\ne\nf\n")
        ctx = diag.diagnose(self.base, full)["debug"]["full_log_context"]
        self.assertEqual(ctx, [{"line": 3, "context": ["a", "b", "c st-passb0-probe ok", "d st-passb0-probe refused x", "e", "f"]}])

    def test_writes_nothing(self):
        before = sorted((p, os.stat(p).st_mtime_ns) for p in (os.path.join(r, f) for r, _, fs in os.walk(self.base) for f in fs))
        with contextlib.redirect_stdout(io.StringIO()):
            diag.main(["diag.py", self.base])
        after = sorted((p, os.stat(p).st_mtime_ns) for p in (os.path.join(r, f) for r, _, fs in os.walk(self.base) for f in fs))
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
