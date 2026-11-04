"""summary-b1a.py: combined run1+run2 summary with provenance, global validity and SHA256SUMS,
and the legacy-N17 adapter for run 1. Run: python3 test/test_summary.py"""
import contextlib, hashlib, importlib.util, io, json, os, sys, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__)); KIT = os.path.dirname(HERE)
sys.path.insert(0, KIT); sys.path.insert(0, HERE)
import test_analyze_b1a as T  # noqa: E402
spec = importlib.util.spec_from_file_location("summary_b1a", os.path.join(KIT, "summary-b1a.py"))
S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)

N9_ADD, N9_INST, MCP_USER = T.N9_ADD_REFUSED, T.N9_INSTALL_FAIL, T.MCP_USER_REFUSED
LEGACY_N17_PRE = {"pre": [{"alias": "mcp-add", "rc": 1}]}  # run 1's legacy single "N17"


def sha_tree(d):
    lines = []
    for root, _, fs in os.walk(d):
        for fn in sorted(fs):
            if fn == "SHA256SUMS":
                continue
            p = os.path.join(root, fn)
            rel = os.path.relpath(p, d)
            lines.append(f"{hashlib.sha256(open(p, 'rb').read()).hexdigest()}  {rel}")
    with open(os.path.join(d, "SHA256SUMS"), "w") as f:
        f.write("\n".join(sorted(lines)) + "\n")


def write_attempt(d, aid, x, extra_pre=None):
    p = os.path.join(d, "attempts", aid); os.makedirs(p)
    res = dict(x["result"]); res.setdefault("starts", [{"probe_kinds": x.get("probe_kinds")}])
    T.put(os.path.join(p, "result.json"), json.dumps(res))
    T.put(os.path.join(p, "debug-1.log.filtered"), x["debug"])
    T.put(os.path.join(p, "stderr-1.txt.filtered"), x["stderr"])
    for al, t in {**(x.get("pre_text") or {}), **(extra_pre or {})}.items():
        T.put(os.path.join(p, f"pre-{al}.txt.filtered"), t)


def write_globals(d, D):
    for name, key in (("applied.json", "applied"), ("capture-manifest.json", "manifest"), ("preflight.json", "preflight"),
                      ("cli-version-before.json", "cli_before"), ("cli-version-after.json", "cli_after")):
        T.put(os.path.join(d, name), json.dumps(D[key]))


def run1_dir(mut=None):
    """Run 1: the full set EXCEPT the split N17; instead a legacy 'N17' with the mcp-add refusal."""
    D = T.fixture()
    d = tempfile.mkdtemp()
    for aid, x in D["attempts"].items():
        if aid in ("N17-user", "N17-project"):
            continue
        write_attempt(d, aid, x)
    legacy = T.start("N17", T.PROBE_LINES, result=LEGACY_N17_PRE)
    write_attempt(d, "N17", legacy, extra_pre={"mcp-add": MCP_USER})
    write_globals(d, D)
    if callable(mut):
        mut(d, D)
    sha_tree(d)
    if mut == "tamper":  # corrupt a file AFTER writing SHA256SUMS
        T.put(os.path.join(d, "attempts", "N6", "debug-1.log.filtered"), "tampered\n")
    return d


def run2_dir(mut=None):
    D = T.fixture()
    d = tempfile.mkdtemp()
    for aid in ("P0", "N14", "N17-project"):
        write_attempt(d, aid, D["attempts"][aid])
    write_globals(d, D)
    if callable(mut):
        mut(d, D)
    sha_tree(d)
    return d


def summary(run1, run2=None):
    argv = ["--run1", run1, "--run1-sha", "e00ef29"]
    if run2:
        argv += ["--run2", run2, "--run2-sha", "RUN2SHA"]
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = S.main(argv)
    return code, json.loads(buf.getvalue())


class Summary(unittest.TestCase):
    def test_pass_reduced_with_provenance_and_legacy_n17(self):
        code, out = summary(run1_dir(), run2_dir())
        self.assertEqual((code, out["verdict"]), (0, "PASS (reduced scope)"), out)
        prov = {r["attempt"]: r["provenance"] for r in out["attempts"]}
        self.assertEqual(prov["N14"], "run2:RUN2SHA")
        self.assertEqual(prov["N17-project"], "run2:RUN2SHA")
        self.assertIn("legacy-N17", prov["N17-user"])
        self.assertEqual(prov["N9"], "run1:e00ef29")
        self.assertEqual(set(out["excluded"]), {"N10", "N11", "N13"})
        n17u = next(r for r in out["attempts"] if r["attempt"] == "N17-user")
        self.assertEqual(n17u["outcome"], "blocked")

    def test_run2_absent_is_inconclusive(self):
        code, out = summary(run1_dir())
        self.assertEqual((code, out["verdict"]), (2, "INCONCLUSIVE"))
        self.assertEqual(out["runs"]["run2"]["status"], "absent")

    def test_global_failures_block_pass(self):
        # B3: a contributing run with a global failure can never yield PASS.
        for who, mut in [("run2-manifest", lambda d, D: T.put(os.path.join(d, "capture-manifest.json"), json.dumps({"complete": False}))),
                         ("run2-cli", lambda d, D: T.put(os.path.join(d, "cli-version-after.json"), json.dumps({"version": "2.1.315"}))),
                         ("run2-applied", lambda d, D: T.put(os.path.join(d, "applied.json"), json.dumps({"managed_files": ["b1a.json"]})))]:
            with self.subTest(who):
                code, out = summary(run1_dir(), run2_dir(mut=mut))
                self.assertNotEqual(out["verdict"], "PASS (reduced scope)")
                self.assertEqual(out["runs"]["run2"]["status"], "invalid")

    def test_run1_baseline_failure_blocks_pass(self):
        def drop_baseline(d, D):
            import shutil
            shutil.rmtree(os.path.join(d, "attempts", "P0"))
        code, out = summary(run1_dir(mut=drop_baseline), run2_dir())
        self.assertNotEqual(out["verdict"], "PASS (reduced scope)")
        self.assertEqual(out["runs"]["run1"]["status"], "invalid")

    def test_tampered_sha256sums_block_pass(self):
        code, out = summary(run1_dir(mut="tamper"), run2_dir())
        self.assertNotEqual(out["verdict"], "PASS (reduced scope)")
        self.assertFalse(out["runs"]["run1"]["sha256sums"])

    def test_missing_sha256sums_block_pass(self):
        r2 = run2_dir()
        os.remove(os.path.join(r2, "SHA256SUMS"))
        code, out = summary(run1_dir(), r2)
        self.assertNotEqual(out["verdict"], "PASS (reduced scope)")


if __name__ == "__main__":
    unittest.main()
