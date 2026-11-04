"""summary-b1a.py: combined run1+run2 summary with provenance. Run: python3 test/test_summary.py"""
import io, json, os, sys, contextlib, importlib.util, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__)); KIT = os.path.dirname(HERE)
sys.path.insert(0, KIT)
import test_analyze_b1a as T  # noqa: E402  (reuse the fixture writer)
spec = importlib.util.spec_from_file_location("summary_b1a", os.path.join(KIT, "summary-b1a.py"))
S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)


def write_res(D, ids=None):
    d = tempfile.mkdtemp()
    for aid, x in D["attempts"].items():
        if ids is not None and aid not in ids:
            continue
        p = os.path.join(d, "attempts", aid); os.makedirs(p)
        res = dict(x["result"]); res.setdefault("starts", [{"probe_kinds": x.get("probe_kinds")}])
        T.put(os.path.join(p, "result.json"), json.dumps(res))
        T.put(os.path.join(p, "debug-1.log.filtered"), x["debug"])
        T.put(os.path.join(p, "stderr-1.txt.filtered"), x["stderr"])
        for al, t in (x.get("pre_text") or {}).items():
            T.put(os.path.join(p, f"pre-{al}.txt.filtered"), t)
    for name, key in (("applied.json", "applied"), ("capture-manifest.json", "manifest"), ("preflight.json", "preflight"),
                      ("cli-version-before.json", "cli_before"), ("cli-version-after.json", "cli_after")):
        T.put(os.path.join(d, name), json.dumps(D[key]))
    return d


class Summary(unittest.TestCase):
    def test_provenance_and_excluded(self):
        res1 = write_res(T.fixture())
        res2 = write_res(T.fixture(), ids={"P0", "N14", "N17-project"})
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = S.main(["--run1", res1, "--run1-sha", "e00ef29", "--run2", res2, "--run2-sha", "RUN2SHA"])
        out = json.loads(buf.getvalue())
        self.assertEqual(code, 0)
        self.assertTrue(out["verdict"].startswith("PASS (reduced scope)"))
        prov = {r["attempt"]: r["provenance"] for r in out["attempts"]}
        self.assertEqual(prov["N14"], "run2:RUN2SHA")
        self.assertEqual(prov["N17-project"], "run2:RUN2SHA")
        self.assertEqual(prov["N9"], "run1:e00ef29")
        self.assertEqual(prov["N17-user"], "run1:e00ef29")
        self.assertEqual(set(out["excluded"]), {"N10", "N11", "N13"})
        self.assertIn("NO es la seguridad general de Channels", out["caveat"])

    def test_run2_regression_in_run1_is_inconclusive_until_rerun(self):
        # Run 1 alone: N14/N17-project were inconclusive; without run 2 the summary is INCONCLUSIVE.
        D = T.fixture()
        D["attempts"]["N14"]["result"]["startup"] = "trust-unconfirmed"
        D["attempts"]["N17-project"]["result"]["mcp_approval"] = {"identified": False, "approved": False, "started": False}
        res1 = write_res(D)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = S.main(["--run1", res1, "--run1-sha", "e00ef29"])
        out = json.loads(buf.getvalue())
        self.assertEqual(code, 2)
        self.assertEqual(out["verdict"], "INCONCLUSIVE")


if __name__ == "__main__":
    unittest.main()
