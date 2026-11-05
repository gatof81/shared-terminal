"""Simulated tests for the unified observer + separate verdict (investigation #2 follow-up).
Pure, no CLI. Run: python3 test_obs_unified.py

Round-2 audit (owner B1–B5): false positives reproduced first, then fixed; adversarial B3–B5.
NEGATIVE cases prove insufficient capture / mixed / forged snapshots never produce a PASS/blocked.
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import observer as O  # noqa: E402
import verdict as V  # noqa: E402
import smoke as S  # noqa: E402

P = "2026-11-05T10:00:00.000Z [DEBUG] "
PROBE = (P + "hooks module st-b1-probe@st-b1 loaded (worker, environment 2, tier prepend); events: session.start,classic.SessionStart\n"
         + P + "seated outermost: this machine has managed settings\n"
         + P + "hooks module cc-plugin-sec-default@builtin loaded (native, environment 1, tier builtin)\n")
NOT_SEATED = P + "cc-plugin-sec-default@builtin not seated: no managed settings and not a Team or Enterprise organization (none)\n"
PROBE_RECORDS = [{"probe": "st-b1-probe", "inst": "a1", "seq": 1, "kind": "session.start"},
                 {"probe": "st-b1-probe", "inst": "a1", "seq": 2, "kind": "classic.SessionStart"}]
INST = "a1"
N14_LOADED = P + "hooks module st-b1-rogue-n14@skills-dir loaded (worker, environment 3, tier user); events: session.start\n"
EVENTS_DECL = P + "hooks module st-b1-probe@st-b1 loaded (worker, environment 2, tier prepend); events: session.start,classic.SessionStart\n"
SKILLS_BLOCK = ("✗ Plugins from /home/u/.claude/skills/ are blocked by your organization's managed "
                "settings (strictKnownMarketplaces or blockedMarketplaces). Ask your administrator to add "
                "{\"source\":\"skills-dir\"} to strictKnownMarketplaces, or remove it from blockedMarketplaces.")
GENERIC_BLOCK = ("✗ Marketplace \"x\" is blocked by your organization's managed settings "
                 "(strictKnownMarketplaces or blockedMarketplaces).")
ATTRIB = {"fixture": "st-b1-rogue-n14", "differential": "loaded-without-policy@ctrl-run-1"}


class ManualClock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def obs(attempt="N14", start=1, instance="i1", clock=None):
    return O.Observer(attempt, start, instance, clock or ManualClock())


def p0_ok():
    o = obs(attempt="P0")
    o.from_debug(PROBE)
    o.from_probe_records(PROBE_RECORDS, start_inst=INST)
    o.fact("trust", "confirmed")
    return o


def n14_full_block(attributed=True, differential=True):
    clk = ManualClock()
    o = obs(attempt="N14", clock=clk).set_window(max_gap=0.3)
    o.from_debug(PROBE)
    o.from_probe_records(PROBE_RECORDS, start_inst=INST)
    o.fact("trust", "confirmed")
    if attributed:
        det = {"fixture": "st-b1-rogue-n14"}
        if differential:
            det["differential"] = ATTRIB["differential"]
        o.fact("skills-dir", "block-attributable", source="control", detail=det)
    o.window_open(0.05)
    o.window_close(0.25)
    for t, txt in [(0.0, PROBE), (0.1, SKILLS_BLOCK), (0.2, PROBE), (0.3, PROBE)]:
        clk.t = t
        o.from_pane(txt)
    return o


# ── B1/B2 (round 1) reproductions kept ──
class Round1Regressions(unittest.TestCase):
    def test_not_seated_is_not_a_valid_guard(self):
        facts = {(c, s) for c, s, _, _ in O.classify_debug(NOT_SEATED + PROBE.splitlines()[-1] + "\n")}
        self.assertNotIn(("control", "guard-seated-loaded"), facts)
        self.assertIn(("control", "guard-not-seated"), facts)

    def test_events_declaration_is_not_session_start(self):
        facts = {(c, s) for c, s, _, _ in O.classify_debug(EVENTS_DECL)}
        self.assertNotIn(("control", "session.start"), facts)


# ── B1 (round 2): negative guard posterior, incremental contradictory reads ──
class B1GuardPrecedence(unittest.TestCase):
    def test_incremental_not_seated_after_seated_invalidates(self):
        o = p0_ok()                                    # PROBE seated first
        self.assertEqual(V.verdict_p0(o.snapshot())[0], "baseline-ok")
        o.from_debug(PROBE + NOT_SEATED)               # a LATER chunk says not seated
        sigs = {e["signal"] for e in o.events if e["concern"] == "control"}
        self.assertIn("guard-seated-loaded", sigs)     # both present...
        self.assertIn("guard-not-seated", sigs)
        self.assertEqual(V.verdict_p0(o.snapshot())[0], "baseline-invalid")   # ...negative wins


# ── B2 (round 2): provenance + authority matrix ──
class B2Authority(unittest.TestCase):
    def forged(self, **over):
        o = obs(attempt="P0")
        base = {"schema": "obs/1", "attempt": "P0", "start": 1, "instance": "i1",
                "concern": "control", "signal": "session.start", "source": "pane",
                "confidence": "low", "detail": None, "t": 0.0, "coverage": "full"}
        base.update(over)
        snap = o.snapshot()
        snap["events"].append(base)
        return snap

    def test_pane_cannot_prove_session_start(self):
        self.assertIn("unauthorized", V.verdict(self.forged())[1])

    def test_pane_cannot_prove_trust(self):
        self.assertIn("unauthorized", V.verdict(self.forged(concern="trust", signal="confirmed", source="pane", confidence="low"))[1])

    def test_pane_cannot_prove_guard(self):
        self.assertIn("unauthorized", V.verdict(self.forged(concern="control", signal="guard-seated-loaded", source="pane", confidence="low"))[1])

    def test_pane_cannot_attribute_n14(self):
        self.assertIn("unauthorized", V.verdict(self.forged(concern="skills-dir", signal="block-attributable", source="pane", confidence="low"))[1])

    def test_unknown_signal_rejected(self):
        self.assertIn("unauthorized", V.verdict(self.forged(concern="control", signal="made-up", source="debug", confidence="high"))[1])

    def test_foreign_ctx_rejected(self):
        self.assertIn("correlation-violation", V.verdict(self.forged(start=2))[1])

    def test_legitimate_combos_pass_authority(self):
        ok, why = V.validate_snapshot(p0_ok().snapshot())
        self.assertTrue(ok, why)


# ── B3 (round 2): real probe identity ──
class B3ProbeIdentity(unittest.TestCase):
    def kinds(self, o):
        return {(e["concern"], e["signal"]) for e in o.events}

    def test_arbitrary_record_rejected(self):
        o = obs(attempt="P0")
        o.from_probe_records([{"kind": "session.start"}], start_inst=INST)   # no probe/inst
        self.assertNotIn(("control", "session.start"), self.kinds(o))

    def test_wrong_probe_rejected(self):
        o = obs(attempt="P0")
        o.from_probe_records([{"probe": "evil", "inst": INST, "kind": "session.start"}], start_inst=INST)
        self.assertNotIn(("control", "session.start"), self.kinds(o))

    def test_wrong_inst_rejected(self):
        o = obs(attempt="P0")
        o.from_probe_records([{"probe": "st-b1-probe", "inst": "b2", "kind": "session.start"}], start_inst=INST)
        self.assertNotIn(("control", "session.start"), self.kinds(o))

    def test_missing_start_inst_rejected(self):
        o = obs(attempt="P0")
        o.from_probe_records(PROBE_RECORDS)             # start_inst=None
        self.assertNotIn(("control", "session.start"), self.kinds(o))

    def test_correct_probe_and_inst_accepted(self):
        o = obs(attempt="P0")
        o.from_probe_records(PROBE_RECORDS, start_inst=INST)
        self.assertIn(("control", "session.start"), self.kinds(o))


# ── B4 (round 2): N14 attribution + critical-window coverage ──
class B4N14(unittest.TestCase):
    def test_block_without_attribution_inconclusive(self):
        self.assertEqual(V.verdict_n14(n14_full_block(attributed=False).snapshot())[0], "inconclusive")

    def test_attribution_needs_differential_not_bare(self):
        v = V.verdict_n14(n14_full_block(attributed=True, differential=False).snapshot())
        self.assertEqual(v[0], "inconclusive")
        self.assertIn("attribution-unverified", v[1])

    def test_attributed_with_differential_is_blocked_low(self):
        self.assertEqual(V.verdict_n14(n14_full_block(attributed=True, differential=True).snapshot())[0], "blocked-low")

    def test_loaded_is_fail_even_degraded(self):
        o = obs(attempt="N14")
        o.from_debug(PROBE + N14_LOADED)
        o.from_probe_records(PROBE_RECORDS, start_inst=INST)
        o.fact("trust", "confirmed")
        o.from_pane("", ok=False)
        self.assertEqual(V.verdict_n14(o.snapshot())[0], "FAIL")


class B4Coverage(unittest.TestCase):
    def mk(self):
        clk = ManualClock()
        return clk, obs(clock=clk).set_window(max_gap=0.3)

    def test_window_not_delimited_is_partial(self):
        clk, o = self.mk()
        for t in (0.0, 0.1, 0.2):
            clk.t = t
            o.from_pane(PROBE)                           # no window_open/close
        self.assertEqual(o.coverage(), "partial")

    def test_not_observed_before_open_is_partial(self):
        clk, o = self.mk()
        o.window_open(0.0)
        o.window_close(0.2)
        for t in (0.1, 0.2, 0.3):                        # first read 0.1 > open 0.0
            clk.t = t
            o.from_pane(PROBE)
        self.assertEqual(o.coverage(), "partial")

    def test_gap_too_large_is_partial(self):
        clk, o = self.mk()
        o.window_open(0.05)
        o.window_close(0.9)
        for t in (0.0, 0.1, 0.9):                        # gap 0.8 > max_gap 0.3
            clk.t = t
            o.from_pane(PROBE)
        self.assertEqual(o.coverage(), "partial")

    def test_decision_outside_window_is_partial(self):
        clk, o = self.mk()
        o.window_open(0.05)
        o.window_close(0.15)
        for t, txt in [(0.0, PROBE), (0.1, PROBE), (0.2, SKILLS_BLOCK), (0.3, PROBE)]:  # decision 0.2 > close 0.15
            clk.t = t
            o.from_pane(txt)
        self.assertEqual(o.coverage(), "partial")

    def test_failed_read_is_partial(self):
        o = n14_full_block()
        o.reads.append((0.4, False))                    # a later failed read
        self.assertEqual(o.coverage(), "partial")

    def test_full_window_observed_through_decision(self):
        self.assertEqual(n14_full_block().coverage(), "full")

    def test_insufficient_capture_never_blocks(self):
        clk = ManualClock()
        o = obs(attempt="N14", clock=clk).set_window(max_gap=0.3)
        o.from_debug(PROBE)
        o.from_probe_records(PROBE_RECORDS, start_inst=INST)
        o.fact("trust", "confirmed")
        o.fact("skills-dir", "block-attributable", source="control", detail=ATTRIB)
        clk.t = 0.0
        o.from_pane(SKILLS_BLOCK)                        # one read, no window -> partial
        self.assertEqual(V.verdict_n14(o.snapshot())[0], "inconclusive")


# ── B5 (round 2): debug truncation / replacement / rotation ──
class B5Discontinuity(unittest.TestCase):
    def test_truncation_degrades(self):
        o = obs(attempt="P0")
        o.from_debug(PROBE)
        self.assertTrue(o.snapshot()["debug_continuity"])
        o.from_debug("short\n")                          # shorter than the cursor
        self.assertFalse(o.snapshot()["debug_continuity"])

    def test_replacement_degrades(self):
        o = obs(attempt="P0")
        o.from_debug(PROBE)
        replaced = ("Z" * (len(PROBE) - 1)) + "\n"       # same length, different consumed prefix
        o.from_debug(replaced)
        self.assertFalse(o.snapshot()["debug_continuity"])

    def test_append_keeps_continuity(self):
        o = obs(attempt="P0")
        o.from_debug(PROBE)
        o.from_debug(PROBE + N14_LOADED)                 # pure append
        self.assertTrue(o.snapshot()["debug_continuity"])

    def test_discontinuity_makes_p0_inconclusive(self):
        o = p0_ok()
        self.assertEqual(V.verdict_p0(o.snapshot())[0], "baseline-ok")
        o.from_debug("truncated\n")                      # rotation/truncation
        self.assertEqual(V.verdict_p0(o.snapshot())[0], "inconclusive")


# ── B6 (round 1) incremental dedup kept ──
class B6Incremental(unittest.TestCase):
    def test_reread_does_not_reemit(self):
        clk = ManualClock()
        o = obs(attempt="P0", clock=clk)
        clk.t = 1.0
        o.from_debug(PROBE)
        n1, t1 = len(o.events), o.events[0]["t"]
        clk.t = 5.0
        o.from_debug(PROBE)
        self.assertEqual(len(o.events), n1)
        self.assertEqual(o.events[0]["t"], t1)

    def test_append_emits_once(self):
        o = obs(attempt="N14")
        o.from_debug(PROBE)
        before = len(o.events)
        o.from_debug(PROBE + N14_LOADED)
        self.assertEqual(len(o.events), before + 1)
        self.assertEqual(o.events[-1]["signal"], "loaded")


class Classify(unittest.TestCase):
    def test_pane_block_path_kind_low(self):
        c, s, conf, d = O.classify_pane(SKILLS_BLOCK)[0]
        self.assertEqual((c, s, conf), ("skills-dir", "blocked", "low"))
        self.assertEqual(d["path_kind"], "claude-skills")

    def test_generic_block_not_skills_dir(self):
        self.assertEqual(O.classify_pane(GENERIC_BLOCK), [])

    def test_no_raw_text_in_events(self):
        o = obs()
        o.from_pane(SKILLS_BLOCK)
        for e in o.events:
            self.assertNotIn("Plugins from", str(e))
            self.assertNotIn("/home/u/", str(e))


class P0(unittest.TestCase):
    def test_full_ok(self):
        self.assertEqual(V.verdict_p0(p0_ok().snapshot())[0], "baseline-ok")

    def test_trust_alone_invalid(self):
        o = obs(attempt="P0")
        o.fact("trust", "confirmed")
        self.assertEqual(V.verdict_p0(o.snapshot())[0], "baseline-invalid")


class N17(unittest.TestCase):
    def test_selected_no_signal_inconclusive(self):
        o = obs(attempt="N17-project")
        o.fact("mcp-project", "selection=approve")
        o.fact("mcp-project", "dismissed=running")
        v = V.verdict_n17_project(o.snapshot())
        self.assertEqual(v[0], "inconclusive")
        self.assertIn("selected-no-signal", v[1])

    def test_started_is_fail(self):
        o = obs(attempt="N17-project")
        o.fact("mcp-project", "started")
        self.assertEqual(V.verdict_n17_project(o.snapshot())[0], "FAIL")


class Dispatch(unittest.TestCase):
    def test_cross_start_cannot_leak(self):
        o2 = obs(attempt="N14", start=2, instance="i2")
        o2.from_debug(PROBE)
        self.assertEqual(V.verdict(o2.snapshot())[0], "inconclusive")

    def test_unknown_attempt(self):
        self.assertEqual(V.verdict(obs(attempt="zzz").snapshot())[0], "inconclusive")


class SmokeCleanup(unittest.TestCase):
    def test_read_pgid(self):
        d = tempfile.mkdtemp()
        with open(os.path.join(d, "pgid"), "w") as f:
            f.write("4321\n")
        self.assertEqual(S._read_pgid(os.path.join(d, "pgid")), 4321)
        for bad in ("", "0", "1", "x", "-5"):
            p = os.path.join(d, "b")
            with open(p, "w") as f:
                f.write(bad)
            self.assertIsNone(S._read_pgid(p), bad)
        self.assertIsNone(S._read_pgid(os.path.join(d, "missing")))

    def test_group_is_ours(self):
        root = tempfile.mkdtemp()
        os.makedirs(os.path.join(root, "4321"))
        with open(os.path.join(root, "4321", "comm"), "w") as f:
            f.write("claude\n")
        self.assertTrue(S._group_is_ours(4321, proc_root=root))
        os.makedirs(os.path.join(root, "9999"))
        with open(os.path.join(root, "9999", "comm"), "w") as f:
            f.write("python3\n")
        self.assertFalse(S._group_is_ours(9999, proc_root=root))
        self.assertFalse(S._group_is_ours(1234, proc_root=root))

    def test_cleanup_only_signals_our_live_group(self):
        orig = S.tmux
        S.tmux = lambda *a: None
        try:
            base = tempfile.mkdtemp()
            pgf = os.path.join(base, "pgid")
            with open(pgf, "w") as f:
                f.write("4321\n")
            calls = []

            def rec(pgid, sig):
                calls.append((pgid, sig))
                raise ProcessLookupError

            S._cleanup(pgf, tempfile.mkdtemp(), killpg=rec, group_is_ours=lambda p: True)
            self.assertEqual(calls, [(4321, __import__("signal").SIGTERM)])
            calls.clear()
            S._cleanup(pgf, tempfile.mkdtemp(), killpg=rec, group_is_ours=lambda p: False)
            self.assertEqual(calls, [])
            calls.clear()
            S._cleanup(os.path.join(base, "none"), tempfile.mkdtemp(), killpg=rec, group_is_ours=lambda p: True)
            self.assertEqual(calls, [])
        finally:
            S.tmux = orig


if __name__ == "__main__":
    unittest.main()
