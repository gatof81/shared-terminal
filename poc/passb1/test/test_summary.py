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

    def test_loaded_in_run1_is_never_erased_by_run2(self):
        # C2: N14 LOADED in run 1, N14 blocked in run 2 => consolidated FAIL, attributed to run 1.
        def n14_loaded(d, D):
            p = os.path.join(d, "attempts", "N14", "debug-1.log.filtered")
            with open(p, encoding="utf-8") as f:
                prev = f.read()
            T.put(p, prev + T.P + "hooks module st-b1-rogue-n14@skills-dir loaded (worker, environment 3, tier user); events: session.start\n")
        code, out = summary(run1_dir(mut=n14_loaded), run2_dir())
        self.assertEqual((code, out["verdict"]), (2, "FAIL"), out)
        n14 = next(r for r in out["attempts"] if r["attempt"] == "N14")
        self.assertEqual(n14["outcome"], "loaded")
        self.assertTrue(n14["provenance"].startswith("run1:"), n14)
        self.assertIn("not-erasable", n14.get("note", ""))

    def test_run_sha_is_declared_not_a_verified_identity(self):
        code, out = summary(run1_dir(), run2_dir())
        self.assertEqual(out["runs"]["run1"]["sha_source"], "operator-declared")
        self.assertEqual(out["runs"]["run2"]["sha_source"], "operator-declared")
        self.assertIn("declaradas por el operador", out["provenance_note"])

    def test_retired_attack_executed_in_run1_fails_with_provenance(self):
        # D2: N10 is OUT of the PASS criteria, but a demonstrated execution in run 1 is a breach.
        def n10_executed(d, D):
            p = os.path.join(d, "attempts", "N10")
            os.makedirs(p)
            T.put(os.path.join(p, "result.json"), json.dumps({"id": "N10", "markers": ["st-b1-rogue-n10.json"]}))
        code, out = summary(run1_dir(mut=n10_executed), run2_dir())
        self.assertEqual((code, out["verdict"]), (2, "FAIL"), out)
        self.assertIn("observed_execution", out["excluded"]["N10"])
        self.assertTrue(out["excluded"]["N10"]["observed_execution"]["provenance"].startswith("run1:"))
        # Not re-counted as blocked and not in the per-attempt rows.
        self.assertNotIn("N10", [r["attempt"] for r in out["attempts"]])


class VerifySums(unittest.TestCase):
    """C1: SHA256SUMS must be complete and cover every file; an empty or partial list cannot pass."""

    def sums(self, d):
        with open(os.path.join(d, "SHA256SUMS")) as f:
            return f.read().splitlines()

    def write_sums(self, d, lines):
        with open(os.path.join(d, "SHA256SUMS"), "w") as f:
            f.write("\n".join(lines) + "\n")

    def test_valid_dir_passes(self):
        self.assertTrue(S.verify_sums(run2_dir()))

    def test_missing_file_rejected(self):
        d = run2_dir(); os.remove(os.path.join(d, "SHA256SUMS"))
        self.assertFalse(S.verify_sums(d))

    def test_empty_or_blank_only_rejected(self):
        for body in ("", "\n  \n\n"):
            with self.subTest(repr(body)):
                d = run2_dir()
                with open(os.path.join(d, "SHA256SUMS"), "w") as f:
                    f.write(body)
                self.assertFalse(S.verify_sums(d))

    def test_partial_list_missing_an_entry_rejected(self):
        # Drop applied.json's line but leave the file: it is now uncovered AND mandatory-omitted.
        d = run2_dir()
        self.write_sums(d, [ln for ln in self.sums(d) if not ln.endswith("  applied.json")])
        self.assertFalse(S.verify_sums(d))

    def test_mandatory_file_omitted_rejected(self):
        d = run2_dir()
        os.remove(os.path.join(d, "applied.json"))
        self.write_sums(d, [ln for ln in self.sums(d) if not ln.endswith("  applied.json")])
        self.assertFalse(S.verify_sums(d))

    def test_duplicate_entry_rejected(self):
        d = run2_dir(); lines = self.sums(d)
        self.write_sums(d, lines + [lines[0]])
        self.assertFalse(S.verify_sums(d))

    def test_invalid_path_rejected(self):
        # A traversal entry pointing at a REAL file OUTSIDE the capture, with its correct hash: only
        # the path guard can reject this (the file opens and matches), so it proves the guard works.
        d = run2_dir()
        outside = os.path.join(os.path.dirname(d), f"outside-{os.getpid()}.bin")
        payload = b"a secret that lives outside the capture"
        with open(outside, "wb") as f:
            f.write(payload)
        try:
            digest = hashlib.sha256(payload).hexdigest()
            self.write_sums(d, self.sums(d) + [f"{digest}  ../{os.path.basename(outside)}"])
            self.assertFalse(S.verify_sums(d))
        finally:
            os.remove(outside)
        for rel in ("/abs/path", "a/../../b"):
            with self.subTest(rel):
                d2 = run2_dir()
                self.write_sums(d2, self.sums(d2) + [f"{'a' * 64}  {rel}"])
                self.assertFalse(S.verify_sums(d2))

    def test_malformed_line_or_bad_digest_rejected(self):
        for bad in ("zz" + "a" * 62 + "  applied.json", "deadbeef applied.json"):
            with self.subTest(bad):
                d = run2_dir()
                self.write_sums(d, self.sums(d) + [bad])
                self.assertFalse(S.verify_sums(d))

    def test_uncovered_present_file_rejected(self):
        d = run2_dir()
        with open(os.path.join(d, "surprise.bin"), "w") as f:
            f.write("not in the sums")
        self.assertFalse(S.verify_sums(d))

    def test_post_capture_report_json_is_allowed_uncovered(self):
        d = run2_dir()
        with open(os.path.join(d, "report.json"), "w") as f:  # written AFTER capture's SHA256SUMS
            f.write('{"verdict": "PASS"}')
        self.assertTrue(S.verify_sums(d))

    def test_hash_mismatch_rejected(self):
        d = run2_dir()
        with open(os.path.join(d, "applied.json"), "a") as f:
            f.write(" ")   # change a covered file after the sums were written
        self.assertFalse(S.verify_sums(d))

    def test_symlink_entry_pointing_outside_rejected(self):
        # D5: a symlink INSIDE the capture that redirects a read OUTSIDE it must be refused, even
        # with a correct hash — the lexical ".." check alone would miss this.
        d = run2_dir()
        outside = os.path.join(os.path.dirname(d), f"sym-target-{os.getpid()}.bin")
        payload = b"a secret reached through a symlink"
        with open(outside, "wb") as f:
            f.write(payload)
        try:
            os.symlink(outside, os.path.join(d, "sneaky"))
        except (OSError, NotImplementedError):
            os.remove(outside)
            self.skipTest("no symlink support")
        try:
            digest = hashlib.sha256(payload).hexdigest()
            self.write_sums(d, self.sums(d) + [f"{digest}  sneaky"])
            self.assertFalse(S.verify_sums(d))
        finally:
            os.remove(outside)


if __name__ == "__main__":
    unittest.main()
