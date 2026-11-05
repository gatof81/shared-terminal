"""Simulated tests for the unified observer + separate verdict (investigation #2 follow-up).
Pure, no CLI. Run: python3 test_obs_unified.py

Covers owner req 6/9: transient screens, lost polls, UI changes, capture failures, multiple
messages, false positives, attacker text simulating a warning, contradictory signals, and NEGATIVE
cases proving that insufficient capture never produces a PASS/blocked."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import observer as O  # noqa: E402
import verdict as V  # noqa: E402
import smoke as S  # noqa: E402
import tempfile  # noqa: E402

P = "2026-11-05T10:00:00.000Z [DEBUG] "
PROBE = (P + "hooks module st-b1-probe@st-b1 loaded (worker, environment 2, tier prepend); events: session.start,classic.SessionStart\n"
         + P + "seated outermost: this machine has managed settings\n"
         + P + "hooks module cc-plugin-sec-default@builtin loaded (native, environment 1, tier builtin)\n")
SESSION = P + "st-b1-probe session.start recorded\n"
N14_LOADED = P + "hooks module st-b1-rogue-n14@skills-dir loaded (worker, environment 3, tier user); events: session.start\n"
SKILLS_BLOCK = ("✗ Plugins from /home/u/.claude/skills/ are blocked by your organization's managed "
                "settings (strictKnownMarketplaces or blockedMarketplaces). Ask your administrator to add "
                "{\"source\":\"skills-dir\"} to strictKnownMarketplaces, or remove it from blockedMarketplaces.")
GENERIC_BLOCK = ("✗ Marketplace \"x\" is blocked by your organization's managed settings "
                 "(strictKnownMarketplaces or blockedMarketplaces).")


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        self.t += 0.1
        return self.t


def obs(attempt="N14", start=1, instance="i1"):
    return O.Observer(attempt, start, instance, Clock())


class Classify(unittest.TestCase):
    def test_debug_controls_and_load(self):
        facts = O.classify_debug(PROBE + SESSION + N14_LOADED)
        sigs = {(c, s) for c, s, _, _ in facts}
        self.assertIn(("control", "probe-org-tier"), sigs)
        self.assertIn(("control", "session.start"), sigs)
        self.assertIn(("control", "guard-seated-loaded"), sigs)
        self.assertIn(("skills-dir", "loaded"), sigs)

    def test_pane_block_has_path_kind_and_is_low(self):
        facts = O.classify_pane(SKILLS_BLOCK)
        self.assertEqual(len(facts), 1)
        c, s, conf, d = facts[0]
        self.assertEqual((c, s, conf), ("skills-dir", "blocked", "low"))
        self.assertEqual(d["path_kind"], "claude-skills")

    def test_generic_marketplace_block_is_not_skills_dir(self):
        self.assertEqual(O.classify_pane(GENERIC_BLOCK), [])

    def test_no_raw_text_in_events(self):
        o = obs()
        o.from_pane(SKILLS_BLOCK)
        for e in o.events:
            self.assertNotIn("Plugins from", str(e))     # path/content never persisted
            self.assertNotIn("/home/u/", str(e))


class Coverage(unittest.TestCase):
    def test_pane_fail_degrades_coverage(self):
        o = obs()
        o.from_pane("", ok=True)                           # empty read
        self.assertEqual(o.coverage(), "none")             # no successful read yet...
        o.from_pane(SKILLS_BLOCK, ok=True)
        self.assertEqual(o.coverage(), "partial")          # one fail + one ok

    def test_capture_failure_flag(self):
        o = obs()
        o.from_pane("whatever", ok=False)                  # capture itself failed
        self.assertEqual(o.pane_fails, 1)

    def test_events_carry_correlation(self):
        o = obs(attempt="N14", start=2, instance="iX")
        o.from_debug(PROBE)
        for e in o.events:
            self.assertEqual((e["attempt"], e["start"], e["instance"]), ("N14", 2, "iX"))


class P0(unittest.TestCase):
    def good(self):
        o = obs(attempt="P0")
        o.from_debug(PROBE + SESSION)
        o.fact("trust", "confirmed")
        return o

    def test_full_controls_ok(self):
        self.assertEqual(V.verdict_p0(self.good().snapshot())[0], "baseline-ok")

    def test_trust_alone_is_not_enough(self):
        o = obs(attempt="P0")
        o.fact("trust", "confirmed")                        # no session.start/probe/guard
        self.assertEqual(V.verdict_p0(o.snapshot())[0], "baseline-invalid")

    def test_controls_without_trust_inconclusive(self):
        o = obs(attempt="P0")
        o.from_debug(PROBE + SESSION)
        self.assertEqual(V.verdict_p0(o.snapshot())[0], "inconclusive")


class N14(unittest.TestCase):
    def _base(self, attempt="N14"):
        o = obs(attempt=attempt)
        o.from_debug(PROBE + SESSION)
        o.fact("trust", "confirmed")
        return o

    def test_loaded_is_fail_even_with_partial_capture(self):
        o = self._base()
        o.from_debug(N14_LOADED)
        o.from_pane("", ok=False)                           # capture degraded, but a load is a load
        self.assertEqual(V.verdict_n14(o.snapshot())[0], "FAIL")

    def test_blocked_low_requires_full_capture_and_baseline(self):
        o = self._base()
        o.from_pane(SKILLS_BLOCK)
        self.assertEqual(V.verdict_n14(o.snapshot())[0], "blocked-low")

    def test_insufficient_capture_never_passes(self):
        o = self._base()
        o.from_pane(SKILLS_BLOCK, ok=True)                  # ok
        o.from_pane("", ok=False)                           # a later failed read -> partial
        self.assertEqual(o.coverage(), "partial")
        self.assertEqual(V.verdict_n14(o.snapshot())[0], "inconclusive")

    def test_no_signal_is_inconclusive_not_blocked(self):
        o = self._base()
        o.from_pane(PROBE)                                  # a real read, but no block/load
        self.assertEqual(V.verdict_n14(o.snapshot())[0], "inconclusive")

    def test_attacker_forged_block_but_rogue_also_loaded_is_fail(self):
        # Attacker text simulates the block AND the rogue actually loaded -> FAIL wins (load is
        # high-confidence; a forged pane "blocked" can never downgrade a real load).
        o = self._base()
        o.from_debug(N14_LOADED)
        o.from_pane(SKILLS_BLOCK)
        self.assertEqual(V.verdict_n14(o.snapshot())[0], "FAIL")

    def test_block_not_attributable_without_baseline(self):
        o = obs(attempt="N14")                              # no trust/controls
        o.from_pane(SKILLS_BLOCK)
        self.assertEqual(V.verdict_n14(o.snapshot())[0], "inconclusive")


class N17(unittest.TestCase):
    def test_selected_no_signal_is_inconclusive_not_blocked(self):
        o = obs(attempt="N17-project")
        o.fact("mcp-project", "identified")
        o.fact("mcp-project", "selection=approve")
        o.fact("mcp-project", "dismissed=running")
        # no accept-signal, no started
        v = V.verdict_n17_project(o.snapshot())
        self.assertEqual(v[0], "inconclusive")
        self.assertIn("selected-no-signal", v[1])

    def test_started_is_fail(self):
        o = obs(attempt="N17-project")
        o.fact("mcp-project", "started")
        self.assertEqual(V.verdict_n17_project(o.snapshot())[0], "FAIL")

    def test_decline_is_not_approval(self):
        o = obs(attempt="N17-project")
        o.fact("mcp-project", "selection=decline")
        o.fact("mcp-project", "dismissed=running")
        self.assertEqual(V.verdict_n17_project(o.snapshot())[0], "inconclusive")


class SmokeCleanup(unittest.TestCase):
    """Owner #8: cleanup targets ONLY the CLI's real process group (from the pgid file), never a
    guess — so a missing/garbage pgid yields None (no broad kill)."""

    def test_read_pgid(self):
        d = tempfile.mkdtemp()
        good = os.path.join(d, "pgid")
        with open(good, "w") as f:
            f.write("4321\n")
        self.assertEqual(S._read_pgid(good), 4321)
        for bad in ("", "0", "1", "notanumber", "-5"):
            p = os.path.join(d, "b")
            with open(p, "w") as f:
                f.write(bad)
            self.assertIsNone(S._read_pgid(p), bad)
        self.assertIsNone(S._read_pgid(os.path.join(d, "missing")))


class Dispatch(unittest.TestCase):
    def test_unknown_attempt_never_passes(self):
        o = obs(attempt="something-else")
        self.assertEqual(V.verdict(o.snapshot())[0], "inconclusive")

    def test_cross_start_cannot_leak(self):
        # Two starts: a block observed in start 1 must not appear in start 2's snapshot.
        o1 = obs(attempt="N14", start=1, instance="i1")
        o1.from_pane(SKILLS_BLOCK)
        o2 = obs(attempt="N14", start=2, instance="i2")
        o2.from_debug(PROBE + SESSION)
        o2.fact("trust", "confirmed")
        self.assertNotIn("blocked", [e["signal"] for e in o2.snapshot()["events"]])
        self.assertEqual(V.verdict_n14(o2.snapshot())[0], "inconclusive")  # no block in THIS start


if __name__ == "__main__":
    unittest.main()
