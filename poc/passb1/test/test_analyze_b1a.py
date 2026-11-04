"""Synthetic tests of analyze_b1a.py: one PASS fixture and one mutation per criterion. Debug and
command lines use the real 2.1.314 / VM100 texts (04-poc.md §1.14.14–§1.14.18).
Run: python3 test/test_analyze_b1a.py"""
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
REFUSAL = "Error: --plugin-dir is disabled by your organization's managed settings (disableSideloadFlags).\n"
SKILLS_BLOCKED = P + "Plugins from /home/developer/b1/N14/home/.claude/skills/ are blocked by your organization's managed settings (strictKnownMarketplaces or blockedMarketplaces).\n"
MCP_DENIED = P + 'MCP server "st-b1-rogue-n17p": not allowed by your organization\n'
MET_LINE = {
    "N6": 'Marketplace "st-b1-rogue-mk6" is declared in settings (dir:/home/developer/b1/N6/rogue/n6)',
    "N7a": 'Marketplace "st-b1-rogue-mk7a" is declared in settings', "N7b": 'Marketplace "st-b1-rogue-mk7b" is declared in settings',
    "N8": 'Marketplace "st-b1-rogue-mk8" is declared in settings',
    "N12": "Synced 1 marketplace(s) from seed dir(s)",
    "N16": ("clearPluginCache: invalidating loadAllPlugins cache (post-trust: re-discover project @skills-dir plugins)\n" + P
            + "Watching for changes in setting files /home/developer/b1/N16/home/.claude/settings.json, /home/developer/b1/N16/ws/.claude/settings.json, "
            "/home/developer/b1/N16/ws/.claude/settings.local.json, /etc/claude-code/managed-settings.json... and drop-in directory /etc/claude-code/managed-settings.d"),
    "N19": 'Marketplace "st-b1-rogue-mk19" is declared in settings',
}
GENERIC = ("N6", "N7a", "N7b", "N8", "N12", "N16", "N19")
N9_ADD_REFUSED = "Marketplace source /home/developer/b1/N9/rogue/n9 is blocked by enterprise policy. Allowed sources: /opt/st-b1/marketplace\n"
N9_INSTALL_FAIL = 'Plugin "st-b1-rogue-n9" not found in marketplace "st-b1-rogue-mk9"\n'
MCP_USER_REFUSED = "Cannot add MCP server: your organization's managed settings allow only MCP servers that plugins provide.\n"


def start(aid, debug, **over):
    res = {"id": aid, "kind": "start", "rc": 130, "timed_out": False, "markers": [], "probe": PROBE_RECS}
    res.update(over.pop("result", {}))
    d = {"result": res, "debug": debug, "stderr": "", "pre": "", "pre_text": {}, "probe_kinds": None, "has_debug": True}
    d.update(over)
    return d


def fixture():
    att = {"P0": start("P0", PROBE_LINES)}
    for aid in A.EXIT:
        att[aid] = {"result": {"id": aid, "kind": "exit", "rc": 1, "timed_out": False, "markers": [], "probe": []},
                    "debug": "", "stderr": REFUSAL, "pre": "", "pre_text": {}, "probe_kinds": None, "has_debug": True}
    for aid in GENERIC:
        att[aid] = start(aid, PROBE_LINES + P + MET_LINE[aid] + "\n")
    att["N9"] = start("N9", PROBE_LINES,
                      result={"pre": [{"alias": "marketplace-add", "rc": 1}, {"alias": "plugin-install", "rc": 1}]},
                      pre_text={"marketplace-add": N9_ADD_REFUSED, "plugin-install": N9_INSTALL_FAIL})
    att["N14"] = start("N14", PROBE_LINES + SKILLS_BLOCKED, result={"startup": "ok"})
    att["N17-user"] = start("N17-user", PROBE_LINES,
                            result={"pre": [{"alias": "mcp-add", "rc": 1}]}, pre_text={"mcp-add": MCP_USER_REFUSED})
    att["N17-project"] = start("N17-project", PROBE_LINES + MCP_DENIED,
                               result={"mcp_approval": {"identified": True, "name_matches_fixture": True, "approved": "confirmed", "started": False}})
    att["N18"] = {"result": {"id": "N18", "kind": "fact", "rc": 130, "markers": [], "probe": []},
                  "debug": "", "stderr": "", "pre": "", "pre_text": {}, "probe_kinds": None, "has_debug": True}
    applied = {"managed_files": ["b1a.json"], "managed_sha256": A.tree_sha256(os.path.join(A.KIT, "managed")),
               "market_sha256": A.tree_sha256(os.path.join(A.KIT, "marketplace")),
               **{f"{t}_{op}": "EROFS" for t in ("managed", "market") for op in ("create", "rename", "unlink")}}
    v = {"version": "2.1.314"}
    return {"attempts": att, "applied": applied, "manifest": {"complete": True}, "preflight": {"cli_version": "2.1.314"},
            "cli_before": v, "cli_after": dict(v)}


def put(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def a(D, aid):
    return D["attempts"][aid]


def run(mutate):
    D = fixture()
    mutate(D)
    return A.analyze(D)


NEGATIVES = [
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
    ("settings invalid (any attempt)", lambda D: a(D, "N8").update(debug=a(D, "N8")["debug"] + P + '"allowManagedHooksOnly" was present but invalid; treating it as true\n'),
     "INCONCLUSIVE", "settings-invalid"),
    ("probe in user tier", lambda D: a(D, "P0").update(debug=a(D, "P0")["debug"].replace("tier prepend", "tier user")), "FAIL", "probe-user-tier"),
    ("unknown tier label", lambda D: a(D, "P0").update(debug=a(D, "P0")["debug"].replace("tier prepend", "tier organization").replace("(prepend,", "(organization,")), "INCONCLUSIVE", "tier-label-unknown"),
    ("probe not loaded", lambda D: a(D, "P0").update(debug=""), "INCONCLUSIVE", "probe-not-org"),
    ("classic.SessionStart missing", lambda D: a(D, "P0")["result"].update(probe=PROBE_RECS[:1]), "INCONCLUSIVE", "classic-sessionstart-missing"),
    ("guard not seated", lambda D: a(D, "P0").update(debug=a(D, "P0")["debug"].replace("seated outermost: this machine has managed settings", "cc-plugin-sec-default@builtin not seated: no managed settings and not a Team or Enterprise organization (none)")), "FAIL", "guard-not-seated"),
    ("guard not loaded", lambda D: a(D, "P0").update(debug=a(D, "P0")["debug"].replace("hooks module cc-plugin-sec-default@builtin loaded", "x")), "INCONCLUSIVE", "guard-unverified"),
    ("rogue marker N6", lambda D: a(D, "N6")["result"].update(markers=["st-b1-rogue-n6.json"]), "FAIL", "loaded:N6"),
    ("rogue marker exit N1", lambda D: a(D, "N1")["result"].update(markers=["st-b1-rogue-n1.json"]), "FAIL", "loaded:N1"),
    ("rogue hooks module loaded without a marker", lambda D: a(D, "N6").update(debug=a(D, "N6")["debug"] + P + "hooks module st-b1-rogue-n6@st-b1-rogue-mk6 loaded (worker, environment 3, tier user); events: session.start\n"), "FAIL", "loaded:N6"),
    ("exit started", lambda D: a(D, "N2")["result"].update(rc=None, timed_out=True), "INCONCLUSIVE", "not-shown-blocked:N2"),
    ("exit without refusal", lambda D: a(D, "N4").update(stderr="Error: other\n"), "INCONCLUSIVE", "not-shown-blocked:N4"),
    ("attack not met", lambda D: a(D, "N6").update(debug=PROBE_LINES), "INCONCLUSIVE", "not-shown-blocked:N6"),
    ("start without control", lambda D: a(D, "N7a")["result"].update(probe=[]), "INCONCLUSIVE", "not-shown-blocked:N7a"),
    ("hook ran (N16)", lambda D: a(D, "N16").update(debug=a(D, "N16")["debug"] + P + "Hooks: SessionStart:startup [mkdir -p /home/developer/b1/N16/marker]\n"), "FAIL", "loaded:N16"),
    ("N9 install succeeded", lambda D: a(D, "N9")["result"].update(pre=[{"alias": "plugin-install", "rc": 0}]) or a(D, "N9").update(pre_text={"plugin-install": "Installed\n"}), "FAIL", "loaded:N9"),
    ("N9 install rc0 even with refusal text is FAIL", lambda D: a(D, "N9")["result"].update(pre=[{"alias": "marketplace-add", "rc": 1}, {"alias": "plugin-install", "rc": 0}]) or a(D, "N9").update(pre_text={"marketplace-add": N9_ADD_REFUSED, "plugin-install": N9_ADD_REFUSED}), "FAIL", "loaded:N9"),
    ("N9 correlation needs plugin and marketplace named", lambda D: a(D, "N9").update(pre_text={"marketplace-add": N9_ADD_REFUSED, "plugin-install": "Error: not found in any marketplace\n"}), "INCONCLUSIVE", "not-shown-blocked:N9"),
    ("N9 add refused + unrelated install error", lambda D: a(D, "N9").update(pre_text={"marketplace-add": N9_ADD_REFUSED, "plugin-install": "Error: network unreachable\n"}), "INCONCLUSIVE", "not-shown-blocked:N9"),
    ("N9 operational add error (no policy text)", lambda D: a(D, "N9").update(pre_text={"marketplace-add": "Error: not a git repository\n", "plugin-install": "Error: not a git repository\n"}), "INCONCLUSIVE", "not-shown-blocked:N9"),
    ("N14 trust unconfirmed", lambda D: a(D, "N14")["result"].update(startup="trust-unconfirmed"), "INCONCLUSIVE", "not-shown-blocked:N14"),
    ("N14 no probe (no control)", lambda D: a(D, "N14")["result"].update(probe=[]), "INCONCLUSIVE", "not-shown-blocked:N14"),
    ("N14 rogue skill loaded", lambda D: a(D, "N14").update(debug=a(D, "N14")["debug"] + P + "hooks module st-b1-rogue-n14@skills-dir loaded (worker, environment 3, tier user); events: session.start\n"), "FAIL", "loaded:N14"),
    ("N14 no skills-dir block line", lambda D: a(D, "N14").update(debug=PROBE_LINES), "INCONCLUSIVE", "not-shown-blocked:N14"),
    ("N14 generic policy phrase without skills path", lambda D: a(D, "N14").update(debug=PROBE_LINES + P + "something is blocked by your organization's managed settings\n"), "INCONCLUSIVE", "not-shown-blocked:N14"),
    ("N17-user started", lambda D: a(D, "N17-user")["result"].update(markers=["mcp-user"]), "FAIL", "loaded:N17-user"),
    ("N17-user generic error", lambda D: a(D, "N17-user").update(pre_text={"mcp-add": "Error: connection refused\n"}), "INCONCLUSIVE", "not-shown-blocked:N17-user"),
    ("N17-project started", lambda D: a(D, "N17-project")["result"].update(markers=["mcp-project"]), "FAIL", "loaded:N17-project"),
    ("N17-project not identified", lambda D: a(D, "N17-project")["result"].update(mcp_approval={"identified": False, "name_matches_fixture": False, "approved": "none", "started": False}), "INCONCLUSIVE", "not-shown-blocked:N17-project"),
    ("N17-project wrong identity", lambda D: a(D, "N17-project")["result"]["mcp_approval"].update(name_matches_fixture=False), "INCONCLUSIVE", "not-shown-blocked:N17-project"),
    ("N17-project approval only screen not confirmed", lambda D: a(D, "N17-project")["result"]["mcp_approval"].update(approved="screen-only"), "INCONCLUSIVE", "not-shown-blocked:N17-project"),
    ("N17-project no same-start control", lambda D: a(D, "N17-project")["result"].update(probe=[]), "INCONCLUSIVE", "not-shown-blocked:N17-project"),
    ("N17-project approved no attributable refusal", lambda D: a(D, "N17-project").update(debug=PROBE_LINES), "INCONCLUSIVE", "not-shown-blocked:N17-project"),
    ("N17-project refusal names n17u not n17p", lambda D: a(D, "N17-project").update(debug=PROBE_LINES + P + 'MCP server "st-b1-rogue-n17u": not allowed by your organization\n'), "INCONCLUSIVE", "not-shown-blocked:N17-project"),
    ("N17-project generic message not proof", lambda D: a(D, "N17-project").update(debug=PROBE_LINES + P + "some generic error about marketplace\n"), "INCONCLUSIVE", "not-shown-blocked:N17-project"),
    ("probe in a non-org known tier", lambda D: a(D, "P0").update(debug=a(D, "P0")["debug"].replace("tier prepend", "tier builtin").replace("(prepend,", "(builtin,")), "INCONCLUSIVE", "probe-not-org"),
    ("N9 add rc nonzero no refusal, correlated install", lambda D: a(D, "N9").update(pre_text={"marketplace-add": "Error: not a git repository\n", "plugin-install": N9_INSTALL_FAIL}), "INCONCLUSIVE", "not-shown-blocked:N9"),
    ("N12 last-start probe_kinds empty", lambda D: a(D, "N12").update(probe_kinds=[]), "INCONCLUSIVE", "not-shown-blocked:N12"),
    ("N16 MET only in pre (debug-only)", lambda D: a(D, "N16").update(debug=PROBE_LINES, pre=MET_LINE["N16"]), "INCONCLUSIVE", "not-shown-blocked:N16"),
    ("attempt not run", lambda D: D["attempts"].pop("N19"), "INCONCLUSIVE", "not-shown-blocked:N19"),
]


class Pass(unittest.TestCase):
    def test_nominal(self):
        r = A.analyze(fixture())
        self.assertEqual(r["verdict"], "PASS", r["reasons"])
        self.assertTrue(all(v["outcome"] == "blocked" for v in r["facts"]["attempts"].values()), r["facts"]["attempts"])
        self.assertEqual(set(r["facts"]["attempts"]), set(A.EXIT + A.START))

    def test_excluded_are_reported_not_blocked_not_counted(self):
        r = A.analyze(fixture())
        self.assertEqual(set(r["facts"]["excluded"]), {"N10", "N11", "N13"})
        for aid in ("N10", "N11", "N13"):
            self.assertNotIn(aid, r["facts"]["attempts"])
            self.assertNotIn(f"loaded:{aid}", r["reasons"])
            self.assertNotIn(f"not-shown-blocked:{aid}", r["reasons"])
        self.assertIn("EXCLU", r["note"].upper())

    def test_reasons_per_special_case(self):
        f = A.analyze(fixture())["facts"]["attempts"]
        self.assertEqual(f["N9"]["why"], "marketplace-add-refused")
        self.assertEqual(f["N14"]["why"], "skills-dir-scan-blocked")
        self.assertEqual(f["N17-user"]["why"], "mcp-user-refused")
        self.assertEqual(f["N17-project"]["why"], "mcp-project-denied-after-approval")

    def test_n18_is_a_fact(self):
        r = A.analyze(fixture())
        self.assertNotIn("N18", r["facts"]["attempts"])
        self.assertEqual(r["facts"]["N18_disableAllHooks_in_user_settings"], {"probe_still_ran": False, "markers": []})


class Negatives(unittest.TestCase):
    def test_each_mutation(self):
        for name, mutate, verdict, reason in NEGATIVES:
            with self.subTest(name):
                r = run(mutate)
                self.assertEqual(r["verdict"], verdict, (name, r["reasons"]))
                self.assertIn(reason, r["reasons"], (name, r["reasons"]))

    def test_a_marker_wins_over_everything(self):
        def m(D):
            a(D, "N12")["result"].update(markers=["st-b1-rogue-n12.json"])
            D.update(manifest=None)
        self.assertEqual(run(m)["verdict"], "FAIL")


class Scope(unittest.TestCase):
    """C4: a focused run judges only its subset, but every global control is still checked."""

    def test_focused_scope_judges_only_the_subset(self):
        r = A.analyze(fixture(), scope={"N14", "N17-project"})
        self.assertEqual(r["verdict"], "PASS", r["reasons"])
        self.assertEqual(set(r["facts"]["attempts"]), {"N14", "N17-project"})

    def test_scope_cannot_hide_a_global_failure(self):
        D = fixture()
        D["cli_after"].update(version="2.1.315")
        r = A.analyze(D, scope={"N14", "N17-project"})
        self.assertEqual(r["verdict"], "INCONCLUSIVE")
        self.assertIn("cli-version-mismatch:after", r["reasons"])

    def test_empty_scope_never_passes(self):
        # D5: a focused run that judges zero attacks is INCONCLUSIVE, never a general PASS.
        for sc in ((), {"P0"}):
            with self.subTest(sc):
                r = A.analyze(fixture(), scope=sc)
                self.assertEqual(r["verdict"], "INCONCLUSIVE")
                self.assertIn("scope-empty", r["reasons"])


class ScopeParser(unittest.TestCase):
    """D5: the CLI --scope parser rejects empty / unknown / incomplete scopes."""

    def ok(self, tail, expect):
        scope, err = A.parse_scope(["analyze_b1a.py", "report", "D"] + tail)
        self.assertIsNone(err, err)
        self.assertEqual(scope, expect)

    def bad(self, tail):
        scope, err = A.parse_scope(["analyze_b1a.py", "report", "D"] + tail)
        self.assertIsNotNone(err)
        self.assertIsNone(scope)

    def test_no_scope_is_full_run(self):
        self.ok([], None)

    def test_canonical_run2_scope_ok(self):
        self.ok(["--scope", "P0,N14,N17-project"], ("P0", "N14", "N17-project"))

    def test_scope_without_a_value_refused(self):
        self.bad(["--scope"])

    def test_empty_scope_refused(self):
        self.bad(["--scope", ""])
        self.bad(["--scope", "P0"])

    def test_unknown_id_refused(self):
        self.bad(["--scope", "N14,N99"])

    def test_incomplete_run2_scope_refused(self):
        self.bad(["--scope", "N14"])
        self.bad(["--scope", "N17-project"])

    def test_extra_attack_refused(self):
        self.bad(["--scope", "N14,N17-project,N6"])

    def test_main_refuses_a_bad_scope_with_usage_code(self):
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(A.main(["analyze_b1a.py", "report", tempfile.mkdtemp(), "--scope", "N14"]), 64)


class Load(unittest.TestCase):
    def test_round_trip_and_exit_code(self):
        D = fixture()
        d = tempfile.mkdtemp()
        for aid, x in D["attempts"].items():
            p = os.path.join(d, "attempts", aid)
            os.makedirs(p)
            res = dict(x["result"])
            res.setdefault("starts", [{"probe_kinds": x.get("probe_kinds")}])
            put(os.path.join(p, "result.json"), json.dumps(res))
            put(os.path.join(p, "debug-1.log.filtered"), x["debug"])
            put(os.path.join(p, "stderr-1.txt.filtered"), x["stderr"])
            for alias, txt in (x.get("pre_text") or {}).items():
                put(os.path.join(p, f"pre-{alias}.txt.filtered"), txt)
        for name, key in (("applied.json", "applied"), ("capture-manifest.json", "manifest"), ("preflight.json", "preflight"),
                          ("cli-version-before.json", "cli_before"), ("cli-version-after.json", "cli_after")):
            put(os.path.join(d, name), json.dumps(D[key]))
        self.assertEqual(A.analyze(A.load(d))["verdict"], "PASS", A.analyze(A.load(d))["reasons"])
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(A.main(["analyze_b1a.py", "report", d]), 0)
            self.assertEqual(A.main(["analyze_b1a.py", "report", tempfile.mkdtemp()]), 2)


if __name__ == "__main__":
    unittest.main()
