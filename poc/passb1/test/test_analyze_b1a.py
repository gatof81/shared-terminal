"""Synthetic tests of analyze_b1a.py: one PASS fixture and mutations per criterion. The debug
lines use the exact 2.1.314 templates (04-poc.md §1.14.14). Run: python3 test/test_analyze_b1a.py"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import analyze_b1a as A  # noqa: E402

P = "2026-11-04T10:00:00.000Z [DEBUG] "
MK = "/opt/st-b1/marketplace/plugins/st-b1-probe/hooks/hooks.json"
PROBE_LINES = (P + f"Read hooks.json for plugin st-b1-probe (enabled=true): {MK}\n"
               + P + "seated outermost: this machine has managed settings\n"
               + P + "hooks module cc-plugin-sec-default@builtin loaded (native, environment 1, tier builtin); events: tool.call\n"
               + P + "hooks module st-b1-probe@st-b1 loaded (worker, environment 2, tier prepend); events: session.start,classic.SessionStart\n"
               + P + "plugin.register: st-b1-probe (prepend, st-b1-probe@st-b1), judged by core alone: admitted\n")
PROBE_RECS = [{"inst": "a1", "seq": 1, "kind": "session.start"}, {"inst": "a1", "seq": 2, "kind": "classic.SessionStart"}]
REFUSAL = "Error: --plugin-dir is disabled by your organization's managed settings (disableSideloadFlags). Plugins, custom agents, and MCP servers can only be loaded from sources your administrator has approved.\n"
MET_LINE = {
    "N6": "Marketplace \"st-b1-rogue-mk6\" is declared in settings (dir:/home/developer/b1/N6/rogue/n6)",
    "N7a": "Marketplace \"st-b1-rogue-mk7a\" is declared in settings", "N7b": "Marketplace \"st-b1-rogue-mk7b\" is declared in settings",
    "N8": "Marketplace \"st-b1-rogue-mk8\" is declared in settings", "N9": "Looking up plugin st-b1-rogue-n9@st-b1-rogue-mk9",
    "N12": "Synced 1 marketplace(s) from seed dir(s)", "N14": "[plugins] skills-dir scan blocked",
    "N16": ("clearPluginCache: invalidating loadAllPlugins cache (post-trust: re-discover project @skills-dir plugins)\n" + P
            + "Watching for changes in setting files /home/developer/b1/N16/home/.claude/settings.json, /home/developer/b1/N16/ws/.claude/settings.json, "
            "/home/developer/b1/N16/ws/.claude/settings.local.json, /etc/claude-code/managed-settings.json... and drop-in directory /etc/claude-code/managed-settings.d"),
    "N17": "MCP server \"st-b1-rogue-n17p\": Starting connection with timeout of 30000ms",
    "N19": "Marketplace \"st-b1-rogue-mk19\" is declared in settings",
}


def fixture():
    att = {"P0": {"result": {"id": "P0", "kind": "start", "rc": 130, "timed_out": False, "markers": [], "probe": PROBE_RECS},
                  "debug": PROBE_LINES, "stderr": "", "pre": "", "has_debug": True}}
    for aid in A.EXIT:
        att[aid] = {"result": {"id": aid, "kind": "exit", "rc": 1, "timed_out": False, "markers": [], "probe": []},
                    "debug": "", "stderr": REFUSAL, "pre": "", "has_debug": True}
    for aid in A.START:
        imp = f"/home/developer/b1/{aid}/home/.claude/plugins/cache/st-b1/st-b1-probe/0.0.1"
        extra = (P + f"Skipping duplicate hooks file for plugin st-b1-probe: {imp}/hooks/hooks.json (resolves to already-loaded file)\n"
                 if aid in A.IMPOSTOR else "" if aid == "N9" else P + MET_LINE[aid] + "\n")
        pre_rc = [{"alias": "marketplace-add", "rc": 1}, {"alias": "plugin-install", "rc": 1}] if aid == "N9" else []
        pt = {"plugin-install": 'Plugin "st-b1-rogue-n9" is blocked by your organization\'s policy and cannot be installed\n'} if aid == "N9" else {}
        att[aid] = {"result": {"id": aid, "kind": "start", "rc": 130, "timed_out": False, "markers": [], "probe": PROBE_RECS,
                               "impostor_paths": [imp] if aid in A.IMPOSTOR else [], "pre": pre_rc},
                    "debug": PROBE_LINES + extra, "stderr": "", "pre": "".join(pt.values()), "pre_text": pt, "has_debug": True}
    att["N18"] = {"result": {"id": "N18", "kind": "fact", "rc": 130, "markers": [], "probe": []}, "debug": "", "stderr": "", "pre": "", "has_debug": True}
    applied = {"managed_files": ["b1a.json"], "managed_sha256": A.tree_sha256(os.path.join(A.KIT, "managed")),
               "market_sha256": A.tree_sha256(os.path.join(A.KIT, "marketplace")),
               **{f"{t}_{op}": "EROFS" for t in ("managed", "market") for op in ("create", "rename", "unlink")}}
    v = {"version": "2.1.314"}
    return {"attempts": att, "applied": applied, "manifest": {"complete": True}, "preflight": {"cli_version": "2.1.314"},
            "cli_before": v, "cli_after": dict(v)}


def put(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def run(mutate):
    D = fixture()
    mutate(D)
    return A.analyze(D)


def a(D, aid):
    return D["attempts"][aid]


NEGATIVES = [
    # (name, mutation, verdict, reason)
    ("capture incomplete", lambda D: D["manifest"].update(complete=False), "INCONCLUSIVE", "capture-incomplete"),
    ("manifest missing", lambda D: D.update(manifest=None), "INCONCLUSIVE", "capture-manifest-missing"),
    ("CLI changed", lambda D: D["cli_after"].update(version="2.1.315"), "INCONCLUSIVE", "cli-version-mismatch:after"),
    ("CLI before missing", lambda D: D.update(cli_before=None), "INCONCLUSIVE", "cli-version-unverified:before"),
    ("policy writable", lambda D: D["applied"].update(managed_unlink="ok"), "FAIL", "policy-or-marketplace-writable"),
    ("marketplace writable", lambda D: D["applied"].update(market_create="ok"), "FAIL", "policy-or-marketplace-writable"),
    ("write check missing", lambda D: D["applied"].pop("market_rename"), "INCONCLUSIVE", "applied-config-incomplete"),
    ("applied missing", lambda D: D.update(applied=None), "INCONCLUSIVE", "applied-config-missing"),
    ("extra policy file", lambda D: D["applied"].update(managed_files=["b1a.json", "other.json"]), "INCONCLUSIVE", "managed-files-unexpected"),
    ("policy not the kit's", lambda D: D["applied"].update(managed_sha256="0" * 64), "INCONCLUSIVE", "applied-config-not-kit"),
    ("baseline missing", lambda D: D["attempts"].pop("P0"), "INCONCLUSIVE", "baseline-missing"),
    ("settings invalid", lambda D: a(D, "P0").update(debug=a(D, "P0")["debug"] + P + "\"allowManagedHooksOnly\" was present but invalid; treating it as true\n"),
     "INCONCLUSIVE", "settings-invalid"),
    ("probe in user tier", lambda D: a(D, "P0").update(debug=a(D, "P0")["debug"].replace("tier prepend", "tier user")), "FAIL", "probe-user-tier"),
    ("unknown tier label", lambda D: a(D, "P0").update(debug=a(D, "P0")["debug"].replace("tier prepend", "tier organization").replace("(prepend,", "(organization,")),
     "INCONCLUSIVE", "tier-label-unknown"),
    ("probe not loaded", lambda D: a(D, "P0").update(debug=""), "INCONCLUSIVE", "probe-not-org"),
    ("not-the-organization's warning", lambda D: a(D, "P0").update(debug=a(D, "P0")["debug"] + P + "st-b1-probe@st-b1 is enabled by managed settings, but it is not read in place from a local folder its marketplace is registered from: it loads from a copy (…), so it is not treated as the organization's\n"),
     "INCONCLUSIVE", "probe-not-org"),
    ("classic.SessionStart missing", lambda D: a(D, "P0")["result"].update(probe=PROBE_RECS[:1]), "INCONCLUSIVE", "classic-sessionstart-missing"),
    ("guard not seated", lambda D: a(D, "P0").update(debug=a(D, "P0")["debug"].replace("seated outermost: this machine has managed settings", "cc-plugin-sec-default@builtin not seated: no managed settings and not a Team or Enterprise organization (none)")),
     "FAIL", "guard-not-seated"),
    ("guard not loaded", lambda D: a(D, "P0").update(debug=a(D, "P0")["debug"].replace("hooks module cc-plugin-sec-default@builtin loaded", "x")), "INCONCLUSIVE", "guard-unverified"),
    ("rogue marker N6", lambda D: a(D, "N6")["result"].update(markers=["st-b1-rogue-n6.json"]), "FAIL", "loaded:N6"),
    ("rogue marker exit N1", lambda D: a(D, "N1")["result"].update(markers=["st-b1-rogue-n1.json"]), "FAIL", "loaded:N1"),
    ("hook marker N16", lambda D: a(D, "N16")["result"].update(markers=["hook-user"]), "FAIL", "loaded:N16"),
    ("impostor marker N10", lambda D: a(D, "N10")["result"].update(markers=["impostor.json"]), "FAIL", "loaded:N10"),
    ("exit attempt started", lambda D: a(D, "N2")["result"].update(rc=None, timed_out=True), "INCONCLUSIVE", "not-shown-blocked:N2"),
    ("exit rc 0", lambda D: a(D, "N3")["result"].update(rc=0), "INCONCLUSIVE", "not-shown-blocked:N3"),
    ("exit without refusal text", lambda D: a(D, "N4").update(stderr="Error: something else\n"), "INCONCLUSIVE", "not-shown-blocked:N4"),
    ("exit but the probe ran", lambda D: a(D, "N5a")["result"].update(probe=PROBE_RECS), "INCONCLUSIVE", "not-shown-blocked:N5a"),
    ("start without control", lambda D: a(D, "N7a")["result"].update(probe=[]), "INCONCLUSIVE", "not-shown-blocked:N7a"),
    ("start with probe in user tier", lambda D: a(D, "N8").update(debug=a(D, "N8")["debug"].replace("tier prepend", "tier user")), "INCONCLUSIVE", "not-shown-blocked:N8"),
    ("attack not met", lambda D: a(D, "N14").update(debug=PROBE_LINES), "INCONCLUSIVE", "not-shown-blocked:N14"),
    ("impostor with no read evidence", lambda D: a(D, "N11").update(debug=PROBE_LINES.replace(f"Read hooks.json for plugin st-b1-probe (enabled=true): {MK}\n", "")),
     "INCONCLUSIVE", "not-shown-blocked:N11"),
    ("attempt not run", lambda D: D["attempts"].pop("N14"), "INCONCLUSIVE", "not-shown-blocked:N14"),
    ("attempt without result", lambda D: a(D, "N17").update(result=None), "INCONCLUSIVE", "not-shown-blocked:N17"),
    ("a user hook ran", lambda D: a(D, "N16").update(debug=a(D, "N16")["debug"] + P + "Hooks: SessionStart:startup [mkdir -p /home/developer/b1/N16/marker]\n"),
     "FAIL", "loaded:N16"),
    ("hooks watched but folder not trusted", lambda D: a(D, "N16").update(debug=a(D, "N16")["debug"].replace("post-trust", "pre")), "INCONCLUSIVE", "not-shown-blocked:N16"),
    ("MCP name only in mcp-add output", lambda D: a(D, "N17").update(debug=PROBE_LINES, pre='MCP server "st-b1-rogue-n17u" added to user config\n'),
     "INCONCLUSIVE", "not-shown-blocked:N17"),
    ("N9 install succeeded (rc 0, no refusal)", lambda D: a(D, "N9")["result"].update(pre=[{"alias": "plugin-install", "rc": 0}]) or a(D, "N9").update(pre_text={"plugin-install": "Installed st-b1-rogue-n9\n"}),
     "FAIL", "loaded:N9"),
    ("N9 rc 0 but refusal text is from another command", lambda D: a(D, "N9")["result"].update(pre=[{"alias": "marketplace-add", "rc": 1}, {"alias": "plugin-install", "rc": 0}]) or a(D, "N9").update(pre_text={"marketplace-add": "blocked by your organization's policy\n", "plugin-install": "Installed st-b1-rogue-n9\n"}),
     "FAIL", "loaded:N9"),
    ("N9 install rc non-zero generic error", lambda D: a(D, "N9")["result"].update(pre=[{"alias": "plugin-install", "rc": 1}]) or a(D, "N9").update(pre_text={"plugin-install": "Error: network unreachable\n"}),
     "INCONCLUSIVE", "not-shown-blocked:N9"),
    ("N9 install outcome unknown (no rc)", lambda D: a(D, "N9")["result"].update(pre=[{"alias": "plugin-install", "rc": None}]) or a(D, "N9").update(pre_text={}),
     "INCONCLUSIVE", "not-shown-blocked:N9"),
    ("N12 control only in an earlier start", lambda D: a(D, "N12").update(probe_kinds=[], debug=PROBE_LINES + P + MET_LINE["N12"] + "\n"),
     "INCONCLUSIVE", "not-shown-blocked:N12"),
    ("impostor location never considered", lambda D: a(D, "N10").update(debug=PROBE_LINES), "INCONCLUSIVE", "not-shown-blocked:N10"),
    ("impostor path not recorded", lambda D: a(D, "N11")["result"].update(impostor_paths=[]), "INCONCLUSIVE", "not-shown-blocked:N11"),
    ("rogue hooks module loaded without a marker", lambda D: a(D, "N6").update(debug=a(D, "N6")["debug"] + P + "hooks module st-b1-rogue-n6@st-b1-rogue-mk6 loaded (worker, environment 3, tier user); events: session.start\n"),
     "FAIL", "loaded:N6"),
    ("rogue registered without a marker", lambda D: a(D, "N8").update(debug=a(D, "N8")["debug"] + P + "plugin.register: st-b1-rogue-n8 (user, st-b1-rogue-n8@st-b1-rogue-mk8), judged by core alone: admitted\n"),
     "FAIL", "loaded:N8"),
    ("settings invalid in a non-P0 attempt", lambda D: a(D, "N9").update(debug=a(D, "N9")["debug"] + P + '"allowManagedHooksOnly" was present but invalid; treating it as true\n'),
     "INCONCLUSIVE", "settings-invalid"),
    ("met only by another attempt's name", lambda D: a(D, "N19").update(debug=PROBE_LINES + P + MET_LINE["N6"] + "\n"), "INCONCLUSIVE", "not-shown-blocked:N19"),
]


class Pass(unittest.TestCase):
    def test_nominal(self):
        r = A.analyze(fixture())
        self.assertEqual(r["verdict"], "PASS", r["reasons"])
        self.assertTrue(all(v["outcome"] == "blocked" for v in r["facts"]["attempts"].values()))
        self.assertEqual(set(r["facts"]["attempts"]), set(A.EXIT + A.START))
        self.assertIn("N15", r["pending"])
        self.assertIn("@synced", r["pending"])

    def test_n9_install_success_without_marker_is_not_blocked(self):
        # The plugin did not run (no marker), but `plugin install` succeeded: a rogue was
        # installed from an unapproved marketplace. That is a FAIL, never "blocked".
        def m(D):
            a(D, "N9")["result"].update(pre=[{"alias": "plugin-install", "rc": 0}])
            a(D, "N9").update(pre_text={"plugin-install": "Installed st-b1-rogue-n9\n"})
        r = run(m)
        self.assertEqual(r["verdict"], "FAIL")
        self.assertEqual(r["facts"]["attempts"]["N9"], {"outcome": "loaded", "why": "installed:N9"})

    def test_n9_refusal_must_come_from_the_install_command_itself(self):
        # rc 0 and a refusal printed by `marketplace add` must NOT be read as the install being
        # refused: the install succeeded -> FAIL, never blocked.
        def m(D):
            a(D, "N9")["result"].update(pre=[{"alias": "marketplace-add", "rc": 1}, {"alias": "plugin-install", "rc": 0}])
            a(D, "N9").update(pre_text={"marketplace-add": "blocked by your organization's policy\n", "plugin-install": "Installed\n"})
        self.assertEqual(run(m)["facts"]["attempts"]["N9"], {"outcome": "loaded", "why": "installed:N9"})

    def test_n9_operational_error_is_inconclusive(self):
        def m(D):
            a(D, "N9")["result"].update(pre=[{"alias": "plugin-install", "rc": 1}])
            a(D, "N9").update(pre_text={"plugin-install": "Error: network unreachable\n"})
        self.assertEqual(run(m)["facts"]["attempts"]["N9"], {"outcome": "inconclusive", "why": "install-error"})

    def test_n12_needs_control_and_seed_in_the_same_start(self):
        # Two starts: the seed loads on the second. If the control (the org-tier probe) is only
        # in the first start and the second shows the seed, that is not a PASS.
        # Last start loaded the probe (tier lines present) but emitted no session.start of its
        # own (probe_kinds=[]); the accumulated result still lists session.start from start 1.
        r = run(lambda D: a(D, "N12").update(probe_kinds=[], debug=PROBE_LINES + P + MET_LINE["N12"] + "\n"))
        self.assertEqual(r["facts"]["attempts"]["N12"]["outcome"], "inconclusive")
        self.assertEqual(r["verdict"], "INCONCLUSIVE")
        # When the last start carries both the control and the seed, N12 is blocked.
        ok = run(lambda D: a(D, "N12").update(probe_kinds=["classic.SessionStart", "session.start"],
                                              debug=PROBE_LINES + P + MET_LINE["N12"] + "\n"))
        self.assertEqual(ok["facts"]["attempts"]["N12"], {"outcome": "blocked", "why": "met-not-run"})

    def test_impostor_without_an_in_place_read_cannot_be_tied_to_the_org_copy(self):
        imp = "/home/developer/b1/N11/cache/st-b1/st-b1-probe/0.0.1"
        # The probe loaded (org tier) and the impostor path is named in a skip line, but there is
        # no in-place Read hooks.json: the loaded module's origin is unproven -> INCONCLUSIVE.
        loaded_only = (P + "hooks module st-b1-probe@st-b1 loaded (worker, environment 2, tier prepend); events: session.start,classic.SessionStart\n"
                       + P + f"Skipping duplicate hooks file for plugin st-b1-probe: {imp}/hooks/hooks.json (resolves to already-loaded file)\n")
        r = run(lambda D: a(D, "N11").update(result={**a(D, "N11")["result"], "impostor_paths": [imp]}, debug=loaded_only))
        self.assertEqual(r["facts"]["attempts"]["N11"], {"outcome": "inconclusive", "why": "impostor-origin-unverified"})

    def test_impostor_blocked_only_when_the_planted_path_was_considered(self):
        r = A.analyze(fixture())
        for aid in A.IMPOSTOR:
            self.assertEqual(r["facts"]["attempts"][aid]["why"], "impostor-considered-ran-in-place")
        # SessionEnd is a fact, not required: absent here (the harness ends with C-c), PASS holds.
        self.assertFalse(r["facts"]["classic_session_end_seen"])
        self.assertEqual(r["verdict"], "PASS")

    def test_impostor_read_from_cache_that_could_have_loaded_is_not_blocked(self):
        # A Read hooks.json from the cache copy, with no "already-loaded" skip, means the CLI may
        # have loaded the impostor: it is NOT proof of rejection (owner finding #4) -> INCONCLUSIVE.
        imp = "/home/developer/b1/N10/home/.claude/plugins/cache/st-b1/st-b1-probe/0.0.1"
        def m(D):
            a(D, "N10").update(result={**a(D, "N10")["result"], "impostor_paths": [imp]},
                               debug=PROBE_LINES + P + f"Read hooks.json for plugin st-b1-probe (enabled=true): {imp}/hooks/hooks.json\n")
        self.assertEqual(run(m)["facts"]["attempts"]["N10"], {"outcome": "inconclusive", "why": "impostor-origin-unverified"})

    def test_n18_is_a_fact_not_an_outcome(self):
        r = A.analyze(fixture())
        self.assertNotIn("N18", r["facts"]["attempts"])
        self.assertEqual(r["facts"]["N18_disableAllHooks_in_user_settings"], {"probe_still_ran": False, "markers": []})


class Negatives(unittest.TestCase):
    def test_each_mutation(self):
        for name, mutate, verdict, reason in NEGATIVES:
            with self.subTest(name):
                r = run(mutate)
                self.assertEqual(r["verdict"], verdict, (name, r["reasons"]))
                self.assertIn(reason, r["reasons"], name)

    def test_a_marker_wins_over_everything(self):
        def m(D):
            a(D, "N12")["result"].update(markers=["st-b1-rogue-n12.json"])
            D.update(manifest=None)
        self.assertEqual(run(m)["verdict"], "FAIL")


class Load(unittest.TestCase):
    def test_n12_last_start_is_read_strictly_from_disk(self):
        # Two starts on disk: start 1 carries the full control + seed, start 2 is empty. load()
        # must read start 2 strictly (no fallback to start 1 or the concatenation), so N12 is
        # INCONCLUSIVE — start 1's control cannot stand in for start 2.
        D = fixture()
        d = tempfile.mkdtemp()
        for aid, x in D["attempts"].items():
            p = os.path.join(d, "attempts", aid)
            os.makedirs(p)
            res = dict(x["result"])
            if aid == "N12":
                # start 2 has the control events but an EMPTY debug; start 1 and the combined log
                # carry the probe-load lines and the seed. Strict reading of start 2 => no control.
                res["starts"] = [{"probe_kinds": ["classic.SessionStart", "session.start"]},
                                 {"probe_kinds": ["classic.SessionStart", "session.start"]}]
                put(os.path.join(p, "debug-1.log.filtered"), PROBE_LINES + P + MET_LINE["N12"] + "\n")
                put(os.path.join(p, "debug-2.log.filtered"), "")
                put(os.path.join(p, "debug.log.filtered"), PROBE_LINES + P + MET_LINE["N12"] + "\n")
            else:
                res.setdefault("starts", [{"probe_kinds": x.get("probe_kinds")}])
                put(os.path.join(p, "debug-1.log.filtered"), x["debug"])
                put(os.path.join(p, "debug.log.filtered"), x["debug"])
            put(os.path.join(p, "result.json"), json.dumps(res))
            put(os.path.join(p, "stderr-1.txt.filtered"), x["stderr"])
            put(os.path.join(p, "stderr.txt.filtered"), x["stderr"])
            for alias, txt in (x.get("pre_text") or {}).items():
                put(os.path.join(p, f"pre-{alias}.txt.filtered"), txt)
        for name, key in (("applied.json", "applied"), ("capture-manifest.json", "manifest"), ("preflight.json", "preflight"),
                          ("cli-version-before.json", "cli_before"), ("cli-version-after.json", "cli_after")):
            put(os.path.join(d, name), json.dumps(D[key]))
        r = A.analyze(A.load(d))
        self.assertEqual(r["verdict"], "INCONCLUSIVE")
        self.assertEqual(r["facts"]["attempts"]["N12"]["outcome"], "inconclusive")

    def test_round_trip_from_files(self):
        D = fixture()
        d = tempfile.mkdtemp()
        for aid, x in D["attempts"].items():
            p = os.path.join(d, "attempts", aid)
            os.makedirs(p)
            put(os.path.join(p, "result.json"), json.dumps(x["result"]))
            put(os.path.join(p, "debug.log.filtered"), x["debug"])
            put(os.path.join(p, "stderr.txt.filtered"), x["stderr"])
            for alias, txt in (x.get("pre_text") or {}).items():
                put(os.path.join(p, f"pre-{alias}.txt.filtered"), txt)
        for name, key in (("applied.json", "applied"), ("capture-manifest.json", "manifest"), ("preflight.json", "preflight"),
                          ("cli-version-before.json", "cli_before"), ("cli-version-after.json", "cli_after")):
            put(os.path.join(d, name), json.dumps(D[key]))
        self.assertEqual(A.analyze(A.load(d))["verdict"], "PASS")
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(A.main(["analyze_b1a.py", "report", d]), 0)
            self.assertEqual(A.main(["analyze_b1a.py", "report", tempfile.mkdtemp()]), 2)


if __name__ == "__main__":
    unittest.main()
