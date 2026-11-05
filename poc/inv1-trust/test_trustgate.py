"""Tests for the disposable trust-gate instrumentation (investigation #1). Deterministic, no real
CLI. Run: python3 test_trustgate.py

Scenarios (owner priority 5): screen-not-ready, lost Down, correct selection, unexpected exit —
plus the key safety property that a non-`yes` selection NEVER sends Enter.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import trustgate as T  # noqa: E402

TRUST_NO = ("Accessing workspace\n\n  Security guide\n\n"
            "  ❯ No, exit\n    Yes, I trust this folder\n\n Enter to confirm\n")
TRUST_YES = ("Accessing workspace\n\n  Security guide\n\n"
             "    No, exit\n  ❯ Yes, I trust this folder\n\n Enter to confirm\n")
BLANK = "\n\n (loading)\n"
PROMPT = "\n> \n"  # trust gone (CLI at its prompt)


class FakeIO(T.IO):
    """A small state machine. The pane is a function of internal state; keys mutate it.
      sel           'no' | 'yes'          which option the pointer is on
      present       trust dialog on screen
      loading       panes still 'loading' before trust renders (counts down per pane read)
      flap          toggle sel on every pane read (models an unstable screen)
      down_works    a Down moves no->yes (False models a LOST Down)
      enter_gone    Enter dismisses the dialog
      exit_after    exited() becomes True once this many pane reads have happened
      exit_on_enter exited() becomes True the moment Enter is sent
    """

    def __init__(self, *, sel="no", present=True, loading=0, flap=False, down_works=True,
                 enter_gone=True, exit_after=None, exit_on_enter=False):
        self.sel, self.present, self.loading, self.flap = sel, present, loading, flap
        self.down_works, self.enter_gone = down_works, enter_gone
        self.exit_after, self.exit_on_enter = exit_after, exit_on_enter
        self.keys, self.t, self.reads, self._exited = [], 0.0, 0, False

    def pane(self):
        self.reads += 1
        if self.exit_after is not None and self.reads >= self.exit_after:
            self._exited = True
        if self.loading > 0:
            self.loading -= 1
            return BLANK
        if not self.present:
            return PROMPT
        if self.flap:
            self.sel = "yes" if self.sel == "no" else "no"
        return TRUST_YES if self.sel == "yes" else TRUST_NO

    def send(self, key):
        self.keys.append(key)
        if key == "Down" and self.down_works and self.present:
            self.sel = "yes"
        if key == "Enter":
            if self.enter_gone and self.present:
                self.present = False
            if self.exit_on_enter:
                self._exited = True

    def exited(self):
        return self._exited

    def now(self):
        self.t += 0.05
        return self.t

    def sleep(self, s):
        self.t += s


class TrustGate(unittest.TestCase):
    def test_pointer_option_enum(self):
        self.assertEqual(T.pointer_option(TRUST_NO), "no")
        self.assertEqual(T.pointer_option(TRUST_YES), "yes")
        self.assertIsNone(T.pointer_option(PROMPT))        # trust not present
        self.assertIsNone(T.pointer_option(BLANK))

    def test_screen_not_ready_never_sends_enter(self):
        io = FakeIO(loading=10 ** 6)                       # trust never renders
        r = T.drive_trust(io, ready_timeout=2.0, poll=0.05)
        self.assertEqual(r["state"], "screen-not-ready")
        self.assertFalse(r["enter_sent"])
        self.assertEqual(io.keys, [])

    def test_not_ready_when_pointer_flaps(self):
        io = FakeIO(flap=True)                             # pointer line changes every poll
        r = T.drive_trust(io, ready_timeout=2.0, poll=0.05, stable_polls=2)
        self.assertEqual(r["state"], "screen-not-ready")
        self.assertFalse(r["enter_sent"])

    def test_lost_down_aborts_without_confirming_no(self):
        io = FakeIO(sel="no", down_works=False)            # Down is LOST, stays on No
        r = T.drive_trust(io, poll=0.02, stable_polls=2, max_nav=3)
        self.assertEqual(r["state"], "not-yes-aborted")
        self.assertEqual(r["selection_before_enter"], "no")
        self.assertFalse(r["enter_sent"])
        self.assertNotIn("Enter", io.keys)                 # never confirms "No, exit"
        self.assertEqual(io.keys.count("Down"), 3)         # bounded retries

    def test_correct_selection_confirms(self):
        io = FakeIO(sel="no", down_works=True, enter_gone=True)
        r = T.drive_trust(io, poll=0.02, stable_polls=2, settle=0.1)
        self.assertEqual(r["state"], "confirmed")
        self.assertEqual(r["selection_before_enter"], "yes")
        self.assertTrue(r["enter_sent"])
        self.assertEqual(r["dismissed"], "running")
        self.assertEqual(io.keys[-1], "Enter")
        self.assertIn("Down", io.keys)

    def test_already_yes_confirms_without_navigating(self):
        io = FakeIO(sel="yes")
        r = T.drive_trust(io, poll=0.02, stable_polls=2, settle=0.1)
        self.assertEqual(r["state"], "confirmed")
        self.assertEqual(r["nav_sends"], 0)
        self.assertEqual(io.keys, ["Enter"])

    def test_unexpected_exit_is_not_confirmed(self):
        io = FakeIO(sel="no", exit_after=2)
        r = T.drive_trust(io, poll=0.02, stable_polls=2)
        self.assertIn(r["state"], ("exited-before-ready", "exited-before-confirm"))
        self.assertFalse(r["enter_sent"])

    def test_enter_then_process_exits_is_flagged_not_a_clean_confirm(self):
        io = FakeIO(sel="yes", enter_gone=True, exit_on_enter=True)
        r = T.drive_trust(io, poll=0.02, stable_polls=2, settle=0.1)
        self.assertTrue(r["enter_sent"])
        self.assertEqual(r["state"], "confirmed-then-exited")
        self.assertEqual(r["dismissed"], "exit")

    def test_result_is_enums_and_states_only_no_raw_pane(self):
        io = FakeIO(sel="yes")
        r = T.drive_trust(io, poll=0.02, stable_polls=2, settle=0.1)
        self.assertEqual(set(r), {"state", "selection_before_enter", "enter_sent", "dismissed",
                                  "ready", "ready_polls", "nav_sends", "t"})
        self.assertEqual(set(r["t"]), {"first_seen", "ready", "enter", "settled"})
        # No field carries raw pane text.
        for v in list(r.values()) + list(r["t"].values()):
            self.assertNotIn(v, (TRUST_YES, TRUST_NO, BLANK, PROMPT))


class ScriptIO(T.IO):
    """Exact per-read control: pane() returns panes[i] then advances; exited() flips True once
    `exit_at_read` pane reads have happened. Used to place a change precisely at the pre-Enter read.
    For sel-stable input with stable_polls=2 the driver's read order is: readiness (1,2),
    stable_option (3,4), **pre-Enter re-validation (5)**, then Phase D's gone-check (6)."""

    def __init__(self, panes, exit_at_read=None):
        self.panes, self.exit_at_read = list(panes), exit_at_read
        self.i, self.keys, self.t = 0, [], 0.0

    def pane(self):
        f = self.panes[min(self.i, len(self.panes) - 1)]
        self.i += 1
        return f

    def send(self, key):
        self.keys.append(key)

    def exited(self):
        return self.exit_at_read is not None and self.i >= self.exit_at_read

    def now(self):
        self.t += 0.05
        return self.t

    def sleep(self, s):
        self.t += s


class Revalidate(unittest.TestCase):
    """Owner #1: the pre-Enter re-validation narrows (not eliminates) the TOCTOU window."""

    def test_verdicts(self):
        self.assertEqual(T.revalidate_before_enter(TRUST_YES, False), ("ok", "yes"))
        self.assertEqual(T.revalidate_before_enter(TRUST_NO, False), ("changed", "no"))
        self.assertEqual(T.revalidate_before_enter(PROMPT, False), ("gone", None))
        self.assertEqual(T.revalidate_before_enter(TRUST_YES, True), ("exited", None))  # exit wins
        self.assertEqual(T.revalidate_before_enter(BLANK, False), ("gone", None))


class TOCTOU(unittest.TestCase):
    """Driver aborts without Enter if the screen/selection/process changes between the stable read
    and the confirm. The change is placed at the pre-Enter re-validation read (#5)."""

    def drive(self, panes, exit_at_read=None):
        io = ScriptIO(panes, exit_at_read=exit_at_read)
        r = T.drive_trust(io, poll=0.01, stable_polls=2, settle=0.05)
        return r, io

    def test_selection_changed_before_enter_aborts(self):
        r, io = self.drive([TRUST_YES, TRUST_YES, TRUST_YES, TRUST_YES, TRUST_NO])
        self.assertEqual(r["state"], "selection-changed-before-enter")
        self.assertFalse(r["enter_sent"])
        self.assertNotIn("Enter", io.keys)
        self.assertEqual(r["selection_before_enter"], "no")

    def test_screen_gone_before_enter_aborts(self):
        r, io = self.drive([TRUST_YES, TRUST_YES, TRUST_YES, TRUST_YES, PROMPT])
        self.assertEqual(r["state"], "screen-gone-before-enter")
        self.assertFalse(r["enter_sent"])
        self.assertNotIn("Enter", io.keys)

    def test_process_exited_before_enter_aborts(self):
        r, io = self.drive([TRUST_YES] * 6, exit_at_read=5)
        self.assertEqual(r["state"], "exited-before-enter")
        self.assertFalse(r["enter_sent"])
        self.assertNotIn("Enter", io.keys)

    def test_stable_through_revalidation_confirms(self):
        # Control: nothing changes at the pre-Enter read -> Enter sent, screen gone after -> confirmed.
        r, io = self.drive([TRUST_YES, TRUST_YES, TRUST_YES, TRUST_YES, TRUST_YES, PROMPT, PROMPT])
        self.assertEqual(r["state"], "confirmed")
        self.assertTrue(r["enter_sent"])
        self.assertEqual(io.keys, ["Enter"])


if __name__ == "__main__":
    unittest.main()
