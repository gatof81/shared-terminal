"""Simulated tests for the unified observer + separate verdict (investigation #2 follow-up).
Pure, no CLI. Run: python3 test_obs_unified.py

Covers owner B1–B6 (false positives reproduced first, then fixed; adversarial B3–B6) and the smoke
cleanup (mocked). NEGATIVE cases prove insufficient capture / mixed snapshots never produce a PASS.
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
PROBE_RECORDS = [{"inst": "a1", "seq": 1, "kind": "session.start"}, {"inst": "a1", "seq": 2, "kind": "classic.SessionStart"}]
N14_LOADED = P + "hooks module st-b1-rogue-n14@skills-dir loaded (worker, environment 3, tier user); events: session.start\n"
GUARD_NOT_SEATED = (P + "cc-plugin-sec-default@builtin not seated: no managed settings and not a Team or Enterprise organization (none)\n"
                    + P + "hooks module cc-plugin-sec-default@builtin loaded (native, environment 1, tier builtin)\n")
EVENTS_DECL = P + "hooks module st-b1-probe@st-b1 loaded (worker, environment 2, tier prepend); events: session.start,classic.SessionStart\n"
SKILLS_BLOCK = ("✗ Plugins from /home/u/.claude/skills/ are blocked by your organization's managed "
                "settings (strictKnownMarketplaces or blockedMarketplaces). Ask your administrator to add "
                "{\"source\":\"skills-dir\"} to strictKnownMarketplaces, or remove it from blockedMarketplaces.")
GENERIC_BLOCK = ("✗ Marketplace \"x\" is blocked by your organization's managed settings "
                 "(strictKnownMarketplaces or blockedMarketplaces).")


class ManualClock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def obs(attempt="N14", start=1, instance="i1", clock=None):
    return O.Observer(attempt, start, instance, clock or ManualClock())


# ── B1/B2: reproduce the false positives, then they must stay fixed ──
class Regressions(unittest.TestCase):
    def test_b1_not_seated_is_not_a_valid_guard(self):
        facts = {(c, s) for c, s, _, _ in O.classify_debug(GUARD_NOT_SEATED)}
        self.assertNotIn(("control", "guard-seated-loaded"), facts)
        self.assertIn(("control", "guard-not-seated"), facts)

    def test_b2_events_declaration_is_not_session_start(self):
        facts = {(c, s) for c, s, _, _ in O.classify_debug(EVENTS_DECL)}
        self.assertNotIn(("control", "session.start"), facts)

    def test_b2_session_start_needs_execution_record(self):
        o = obs(attempt="P0")
        o.from_probe_records(PROBE_RECORDS)
        self.assertIn(("control", "session.start"), {(e["concern"], e["signal"]) for e in o.events})


class Classify(unittest.TestCase):
    def test_debug_controls_and_load_no_session_start(self):
        sigs = {(c, s) for c, s, _, _ in O.classify_debug(PROBE + N14_LOADED)}
        self.assertIn(("control", "probe-org-tier"), sigs)
        self.assertIn(("control", "guard-seated-loaded"), sigs)
        self.assertIn(("skills-dir", "loaded"), sigs)
        self.assertNotIn(("control", "session.start"), sigs)   # never from debug

    def test_pane_block_path_kind_low(self):
        facts = O.classify_pane(SKILLS_BLOCK)
        self.assertEqual(facts[0][:3], ("skills-dir", "blocked", "low"))
        self.assertEqual(facts[0][3]["path_kind"], "claude-skills")

    def test_generic_marketplace_block_is_not_skills_dir(self):
        self.assertEqual(O.classify_pane(GENERIC_BLOCK), [])

    def test_no_raw_text_in_events(self):
        o = obs()
        o.from_pane(SKILLS_BLOCK)
        for e in o.events:
            self.assertNotIn("Plugins from", str(e))
            self.assertNotIn("/home/u/", str(e))


# ── B4: temporal coverage ──
class Coverage(unittest.TestCase):
    def mk(self):
        clk = ManualClock()
        o = obs(clock=clk).set_window(expected=0.1, min_reads=3, min_window=0.3, max_gap=0.3)
        return clk, o

    def reads(self, clk, o, times, text=PROBE):
        for t in times:
            clk.t = t
            o.from_pane(text)

    def test_single_read_is_not_full(self):
        clk, o = self.mk()
        self.reads(clk, o, [0.0])
        self.assertEqual(o.coverage(), "partial")

    def test_too_few_reads_is_partial(self):
        clk, o = self.mk()
        self.reads(clk, o, [0.0, 0.1])
        self.assertEqual(o.coverage(), "partial")

    def test_window_too_short_is_partial(self):
        clk, o = self.mk()
        self.reads(clk, o, [0.0, 0.05, 0.1])        # window 0.1 < min_window 0.3
        self.assertEqual(o.coverage(), "partial")

    def test_gap_too_large_is_partial(self):
        clk, o = self.mk()
        self.reads(clk, o, [0.0, 0.1, 0.9])         # gap 0.8 > max_gap 0.3
        self.assertEqual(o.coverage(), "partial")

    def test_failed_read_is_partial(self):
        clk, o = self.mk()
        self.reads(clk, o, [0.0, 0.1, 0.2])
        clk.t = 0.3
        o.from_pane("", ok=False)
        self.assertEqual(o.coverage(), "partial")

    def test_all_failed_is_none(self):
        clk, o = self.mk()
        clk.t = 0.0
        o.from_pane("", ok=False)
        self.assertEqual(o.coverage(), "none")

    def test_decision_must_be_observed_through(self):
        # last read AT the decision (not after) => partial (we did not observe settle).
        clk, o = self.mk()
        clk.t = 0.0
        o.from_pane(PROBE)
        clk.t = 0.1
        o.from_pane(PROBE)
        clk.t = 0.2
        o.from_pane(SKILLS_BLOCK)                    # decision is the LAST read
        self.assertEqual(o.coverage(), "partial")

    def test_full_window_with_observation_through_decision(self):
        clk, o = self.mk()
        clk.t = 0.0
        o.from_pane(PROBE)
        clk.t = 0.1
        o.from_pane(SKILLS_BLOCK)                    # decision
        clk.t = 0.2
        o.from_pane(PROBE)
        clk.t = 0.3
        o.from_pane(PROBE)                           # observed after
        self.assertEqual(o.coverage(), "full")


class P0(unittest.TestCase):
    def good(self):
        o = obs(attempt="P0")
        o.from_debug(PROBE)
        o.from_probe_records(PROBE_RECORDS)
        o.fact("trust", "confirmed")
        return o

    def test_full_controls_ok(self):
        self.assertEqual(V.verdict_p0(self.good().snapshot())[0], "baseline-ok")

    def test_trust_alone_is_not_enough(self):
        o = obs(attempt="P0")
        o.fact("trust", "confirmed")
        self.assertEqual(V.verdict_p0(o.snapshot())[0], "baseline-invalid")

    def test_controls_without_trust_inconclusive(self):
        o = obs(attempt="P0")
        o.from_debug(PROBE)
        o.from_probe_records(PROBE_RECORDS)
        self.assertEqual(V.verdict_p0(o.snapshot())[0], "inconclusive")

    def test_guard_not_seated_invalidates_baseline(self):
        o = obs(attempt="P0")
        o.from_debug(PROBE.replace("seated outermost: this machine has managed settings",
                                   "cc-plugin-sec-default@builtin not seated: none"))
        o.from_probe_records(PROBE_RECORDS)
        o.fact("trust", "confirmed")
        self.assertEqual(V.verdict_p0(o.snapshot())[0], "baseline-invalid")


# ── B3: N14 attribution ──
class N14(unittest.TestCase):
    def full_block(self, attributed):
        clk = ManualClock()
        o = obs(attempt="N14", clock=clk).set_window(expected=0.1, min_reads=3, min_window=0.3, max_gap=0.3)
        o.from_debug(PROBE)
        o.from_probe_records(PROBE_RECORDS)
        o.fact("trust", "confirmed")
        if attributed:
            o.fact("skills-dir", "block-attributable", source="control", detail={"fixture": "st-b1-rogue-n14"})
        for t, txt in [(0.0, PROBE), (0.1, SKILLS_BLOCK), (0.2, PROBE), (0.3, PROBE)]:
            clk.t = t
            o.from_pane(txt)
        return o

    def test_loaded_is_fail_even_with_degraded_capture(self):
        o = obs(attempt="N14")
        o.from_debug(PROBE + N14_LOADED)
        o.from_probe_records(PROBE_RECORDS)
        o.fact("trust", "confirmed")
        o.from_pane("", ok=False)
        self.assertEqual(V.verdict_n14(o.snapshot())[0], "FAIL")

    def test_block_without_attribution_is_inconclusive(self):
        v = V.verdict_n14(self.full_block(attributed=False).snapshot())
        self.assertEqual(v[0], "inconclusive")
        self.assertIn("not-attributable", v[1])

    def test_block_attributed_is_blocked_low(self):
        v = V.verdict_n14(self.full_block(attributed=True).snapshot())
        self.assertEqual(v[0], "blocked-low")

    def test_insufficient_capture_never_blocks(self):
        clk = ManualClock()
        o = obs(attempt="N14", clock=clk).set_window(expected=0.1, min_reads=3, min_window=0.3, max_gap=0.3)
        o.from_debug(PROBE)
        o.from_probe_records(PROBE_RECORDS)
        o.fact("trust", "confirmed")
        o.fact("skills-dir", "block-attributable", source="control", detail={"fixture": "st-b1-rogue-n14"})
        clk.t = 0.0
        o.from_pane(SKILLS_BLOCK)                     # one read only -> partial
        self.assertEqual(V.verdict_n14(o.snapshot())[0], "inconclusive")

    def test_forged_block_plus_real_load_is_fail(self):
        o = self.full_block(attributed=True)
        o.from_debug(PROBE + N14_LOADED)              # the rogue actually loaded
        self.assertEqual(V.verdict_n14(o.snapshot())[0], "FAIL")

    def test_no_signal_is_inconclusive(self):
        clk = ManualClock()
        o = obs(attempt="N14", clock=clk).set_window(expected=0.1, min_reads=3, min_window=0.3, max_gap=0.3)
        o.from_debug(PROBE)
        o.from_probe_records(PROBE_RECORDS)
        o.fact("trust", "confirmed")
        for t in [0.0, 0.1, 0.2, 0.3]:
            clk.t = t
            o.from_pane(PROBE)
        self.assertEqual(V.verdict_n14(o.snapshot())[0], "inconclusive")


class N17(unittest.TestCase):
    def test_selected_no_signal_inconclusive(self):
        o = obs(attempt="N17-project")
        o.fact("mcp-project", "identified")
        o.fact("mcp-project", "selection=approve")
        o.fact("mcp-project", "dismissed=running")
        v = V.verdict_n17_project(o.snapshot())
        self.assertEqual(v[0], "inconclusive")
        self.assertIn("selected-no-signal", v[1])

    def test_started_is_fail(self):
        o = obs(attempt="N17-project")
        o.fact("mcp-project", "started")
        self.assertEqual(V.verdict_n17_project(o.snapshot())[0], "FAIL")


# ── B5: correlation validation ──
class Correlation(unittest.TestCase):
    def test_foreign_event_rejected(self):
        o = obs(attempt="N14", start=1, instance="i1")
        o.from_debug(PROBE)
        snap = o.snapshot()
        snap["events"].append({**snap["events"][0], "start": 2})   # mixed-in foreign start
        self.assertEqual(V.verdict(snap)[0], "inconclusive")
        self.assertIn("correlation-violation", V.verdict(snap)[1])

    def test_unknown_source_rejected(self):
        o = obs(attempt="N14")
        o.from_debug(PROBE)
        snap = o.snapshot()
        snap["events"][0]["source"] = "forged"
        self.assertIn("invalid-source", V.verdict(snap)[1])

    def test_unknown_concern_rejected(self):
        o = obs(attempt="N14")
        o.from_debug(PROBE)
        snap = o.snapshot()
        snap["events"][0]["concern"] = "weird"
        self.assertIn("invalid-concern", V.verdict(snap)[1])

    def test_cross_start_cannot_leak(self):
        o2 = obs(attempt="N14", start=2, instance="i2")
        o2.from_debug(PROBE)
        self.assertNotIn("blocked", [e["signal"] for e in o2.snapshot()["events"]])
        self.assertEqual(V.verdict(o2.snapshot())[0], "inconclusive")


# ── B6: incremental debug reads ──
class Incremental(unittest.TestCase):
    def test_from_debug_does_not_reemit(self):
        clk = ManualClock()
        o = obs(attempt="P0", clock=clk)
        clk.t = 1.0
        o.from_debug(PROBE)
        n1 = len(o.events)
        t_first = o.events[0]["t"]
        clk.t = 5.0
        o.from_debug(PROBE)                 # same whole file re-read -> no new events
        self.assertEqual(len(o.events), n1)
        self.assertEqual(o.events[0]["t"], t_first)   # original time preserved

    def test_from_debug_appended_tail_emits_once(self):
        o = obs(attempt="N14")
        o.from_debug(PROBE)
        before = len(o.events)
        o.from_debug(PROBE + N14_LOADED)    # appended line -> exactly one new event
        self.assertEqual(len(o.events), before + 1)
        self.assertEqual(o.events[-1]["signal"], "loaded")


# ── Smoke cleanup (B / owner #8), mocked ──
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
        self.assertFalse(S._group_is_ours(9999, proc_root=root))     # reused by a foreign proc
        self.assertFalse(S._group_is_ours(1234, proc_root=root))     # missing

    def test_cleanup_only_signals_our_live_group(self):
        orig_tmux = S.tmux
        S.tmux = lambda *a: None
        try:
            base = tempfile.mkdtemp()
            pgf = os.path.join(base, "pgid")
            with open(pgf, "w") as f:
                f.write("4321\n")
            calls = []

            def rec(pgid, sig):
                calls.append((pgid, sig))
                raise ProcessLookupError   # stop after first signal

            # group is ours -> killpg attempted
            S._cleanup(pgf, tempfile.mkdtemp(), killpg=rec, group_is_ours=lambda p: True)
            self.assertEqual(calls, [(4321, __import__("signal").SIGTERM)])
            # group NOT ours -> no signal
            calls.clear()
            S._cleanup(pgf, tempfile.mkdtemp(), killpg=rec, group_is_ours=lambda p: False)
            self.assertEqual(calls, [])
            # pgid missing -> no signal
            calls.clear()
            S._cleanup(os.path.join(base, "none"), tempfile.mkdtemp(), killpg=rec, group_is_ours=lambda p: True)
            self.assertEqual(calls, [])
        finally:
            S.tmux = orig_tmux


if __name__ == "__main__":
    unittest.main()
