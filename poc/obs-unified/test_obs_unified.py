"""Simulated tests for the unified observer + separate verdict (investigation #2 follow-up).
Pure, no CLI. Run: python3 test_obs_unified.py

Round-2 audit (owner B1–B5): false positives reproduced first, then fixed; adversarial B3–B5.
NEGATIVE cases prove insufficient capture / mixed / forged snapshots never produce a PASS/blocked.
"""
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import observer as O  # noqa: E402
import verdict as V  # noqa: E402
import smoke as S  # noqa: E402
import e2e_smoke as E  # noqa: E402

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
    def __init__(self, start=0.0):
        self.t = start

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


FIXTURE_DIGEST = "d34db33fcafef00d"


def n14_full_block(attributed=True, differential=True, digest=FIXTURE_DIGEST, diff_digest=FIXTURE_DIGEST,
                   clock_start=0.0):
    clk = ManualClock(clock_start)
    o = obs(attempt="N14", clock=clk).set_window(max_gap=0.3)   # t0 == clock_start
    o.from_debug(PROBE)
    o.from_probe_records(PROBE_RECORDS, start_inst=INST)
    o.fact("trust", "confirmed")
    if attributed:
        o.fixture_identity(digest)                      # this run's N14 fixture identity
        det = {"fixture": "st-b1-rogue-n14"}
        if differential:
            det["differential"] = {"control_run": "ctrl-run-1", "evidence": "skills-dir:loaded",
                                   "fixture_digest": diff_digest}
        o.fact("skills-dir", "block-attributable", source="control", detail=det)
    b = clock_start                                     # reads on offsets from the start; the window
    clk.t = b + 0.0;  o.from_pane(PROBE)                # is DERIVED [first read, last read] (F2)
    clk.t = b + 0.1;  o.from_pane(SKILLS_BLOCK)         # decision STRICTLY bracketed: read before AND
    clk.t = b + 0.2;  o.from_pane(PROBE)                # after it
    clk.t = b + 0.3;  o.from_pane(PROBE)
    return o


# ── B1/B2 (round 1) reproductions kept ──
class Round1Regressions(unittest.TestCase):
    def test_not_seated_is_not_a_valid_guard(self):
        facts = {(c, s) for c, s, _, _ in O.classify_debug(NOT_SEATED + PROBE.splitlines()[-1] + "\n")}
        self.assertNotIn(("control", "guard-seated"), facts)   # no positive seating
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
        self.assertIn("guard-seated", sigs)            # both present...
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
        self.assertIn("unauthorized", V.verdict(self.forged(concern="control", signal="guard-seated", source="pane", confidence="low"))[1])

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

    def test_c2_bare_assertion_not_a_validated_differential(self):
        v = V.verdict_n14(n14_full_block(attributed=True, differential=False).snapshot())
        self.assertEqual(v[0], "inconclusive")
        self.assertIn("not-a-validated-differential", v[1])

    def test_c2_digest_mismatch_not_credited(self):
        # fixture recorded as one digest, differential references another -> not the same fixture.
        v = V.verdict_n14(n14_full_block(digest="AAAA", diff_digest="BBBB").snapshot())
        self.assertEqual(v[0], "inconclusive")
        self.assertIn("digest-mismatch", v[1])

    def test_c2_validated_differential_is_blocked_low(self):
        self.assertEqual(V.verdict_n14(n14_full_block(attributed=True, differential=True).snapshot())[0], "blocked-low")

    def test_loaded_is_fail_even_degraded(self):
        o = obs(attempt="N14")
        o.from_debug(PROBE + N14_LOADED)
        o.from_probe_records(PROBE_RECORDS, start_inst=INST)
        o.fact("trust", "confirmed")
        o.from_pane("", ok=False)
        self.assertEqual(V.verdict_n14(o.snapshot())[0], "FAIL")


class B4Coverage(unittest.TestCase):
    """F2: the critical window is DERIVED from the reads (first→last); `full` needs continuous reads
    and every pane decision STRICTLY bracketed by a read before AND after it. No driver window."""

    def mk(self):
        clk = ManualClock()
        return clk, obs(clock=clk).set_window(max_gap=0.3)

    def test_no_reads_is_none(self):
        _, o = self.mk()
        self.assertEqual(o.coverage(), "none")

    def test_benign_reads_no_decision_is_full(self):
        clk, o = self.mk()
        for t in (0.0, 0.1, 0.2):
            clk.t = t
            o.from_pane(PROBE)                           # no decision to bracket -> full
        self.assertEqual(o.coverage(), "full")

    def test_gap_too_large_is_partial(self):
        clk, o = self.mk()
        for t in (0.0, 0.1, 0.9):                        # gap 0.8 > max_gap 0.3
            clk.t = t
            o.from_pane(PROBE)
        self.assertEqual(o.coverage(), "partial")

    def test_decision_at_first_read_is_partial(self):
        # F2: a decision on the VERY FIRST read means we never observed the system before it was
        # taken (we attached mid-stream) -> not strictly bracketed -> partial.
        clk, o = self.mk()
        for t, txt in [(0.0, SKILLS_BLOCK), (0.1, PROBE), (0.2, PROBE)]:
            clk.t = t
            o.from_pane(txt)
        self.assertEqual(o.coverage(), "partial")

    def test_decision_at_last_read_is_partial(self):
        clk, o = self.mk()
        for t, txt in [(0.0, PROBE), (0.1, PROBE), (0.2, SKILLS_BLOCK)]:   # decision == last read
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
        o.from_pane(SKILLS_BLOCK)                        # one read == the decision -> not bracketed -> partial
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

    def test_c1_classic_sessionstart_is_required(self):
        # session.start WITHOUT classic.SessionStart must never be baseline-ok (kit global control).
        o = obs(attempt="P0")
        o.from_debug(PROBE)
        o.from_probe_records([{"probe": "st-b1-probe", "inst": INST, "kind": "session.start"}], start_inst=INST)
        o.fact("trust", "confirmed")
        v = V.verdict_p0(o.snapshot())
        self.assertEqual(v[0], "baseline-invalid")
        self.assertIn("classic.SessionStart", v[1])


SEG_PROBE_ORG_SEATED = (P + "hooks module st-b1-probe@st-b1 loaded (worker, environment 2, tier prepend); events: x\n"
                        + P + "seated outermost: this machine has managed settings\n")
GUARD_LOADED_LINE = P + "hooks module cc-plugin-sec-default@builtin loaded (native, environment 1, tier builtin)\n"


class C3FragmentedGuard(unittest.TestCase):
    def base(self):
        o = obs(attempt="P0")
        o.from_probe_records(PROBE_RECORDS, start_inst=INST)
        o.fact("trust", "confirmed")
        return o

    def test_seated_without_loaded_is_invalid(self):
        o = self.base()
        o.from_debug(SEG_PROBE_ORG_SEATED)                 # seated + probe-org, NOT loaded yet
        self.assertEqual(V.verdict_p0(o.snapshot())[0], "baseline-invalid")

    def test_fragments_accumulate_to_valid(self):
        o = self.base()
        o.from_debug(SEG_PROBE_ORG_SEATED)                 # fragment 1
        o.from_debug(SEG_PROBE_ORG_SEATED + GUARD_LOADED_LINE)   # fragment 2 appends loaded
        self.assertEqual(V.verdict_p0(o.snapshot())[0], "baseline-ok")

    def test_later_not_seated_invalidates_accumulated(self):
        o = self.base()
        o.from_debug(SEG_PROBE_ORG_SEATED + GUARD_LOADED_LINE)
        self.assertEqual(V.verdict_p0(o.snapshot())[0], "baseline-ok")
        o.from_debug(SEG_PROBE_ORG_SEATED + GUARD_LOADED_LINE + NOT_SEATED)
        self.assertEqual(V.verdict_p0(o.snapshot())[0], "baseline-invalid")


class C4PreTrustDecision(unittest.TestCase):
    """C4 under F2: the skills-dir block may be notified BEFORE trust. We credit full coverage ONLY
    when a read strictly PRECEDES the decision (demonstrating we were already observing when it was
    taken) — a block already present on our very first poll is NOT demonstrable (partial)."""

    def test_decision_already_present_on_first_poll_is_partial(self):
        clk = ManualClock()
        o = obs(attempt="N14", clock=clk).set_window(max_gap=0.3)
        for t, txt in [(0.0, SKILLS_BLOCK), (0.1, PROBE), (0.2, PROBE), (0.3, PROBE)]:
            clk.t = t
            o.from_pane(txt)                               # block on the FIRST read — observed too late
        self.assertEqual(o.coverage(), "partial")

    def test_pre_trust_read_before_decision_is_full(self):
        clk = ManualClock()
        o = obs(attempt="N14", clock=clk).set_window(max_gap=0.3)
        for t, txt in [(0.0, PROBE), (0.1, SKILLS_BLOCK), (0.2, PROBE), (0.3, PROBE)]:
            clk.t = t
            o.from_pane(txt)                               # a pre-trust read (0.0) strictly before 0.1
        self.assertEqual(o.coverage(), "full")


class F2CriticalWindow(unittest.TestCase):
    """F2 regressions with a REAL advancing clock. The old code sampled window_open AFTER from_pane
    and window_close AFTER the last read, so an advancing clock left the last read before the close
    (=> partial) and only sub-ms rounding faked a full. Coverage is now derived from the actual read
    timestamps, so advancing time BETWEEN reads (incl. around the decision) changes nothing about the
    strict-bracket guarantee — and crucially cannot manufacture a `full` without a read after the
    decision. A monotonic-like start (far from 0) is used so no absolute/relative scale can coincide."""

    def mk(self):
        clk = ManualClock(1000.0)
        return clk, obs(attempt="N14", clock=clk).set_window(max_gap=0.3)

    def test_advancing_between_reads_full_when_bracketed(self):
        clk, o = self.mk()
        clk.t += 0.10; o.from_pane(PROBE)                  # strictly before
        clk.t += 0.10; o.from_pane(SKILLS_BLOCK)           # decision; clock advanced since the first read
        clk.t += 0.10; o.from_pane(PROBE)                  # strictly after
        self.assertEqual(o.coverage(), "full")

    def test_time_passes_after_decision_but_no_read_is_partial(self):
        # Advance time AFTER the decision yet take NO further read: the decision is the LAST read, so
        # it is not strictly bracketed -> partial. (The old window_close-after-last-read bug would
        # have rounded this to full and credited observation that never happened.)
        clk, o = self.mk()
        clk.t += 0.10; o.from_pane(PROBE)
        clk.t += 0.10; o.from_pane(SKILLS_BLOCK)
        clk.t += 0.50                                      # wall-clock advances, but we stop reading
        self.assertEqual(o.coverage(), "partial")

    def test_time_passes_before_first_read_decision_is_partial(self):
        # Spawn/init time passes (the clock advances) and the decision is already on our FIRST read:
        # we never demonstrated observation before it -> partial, regardless of how much time elapsed.
        clk, o = self.mk()
        clk.t += 0.80; o.from_pane(SKILLS_BLOCK)           # decision on the first read
        clk.t += 0.10; o.from_pane(PROBE)
        self.assertEqual(o.coverage(), "partial")

    def test_verdict_partial_window_is_inconclusive_not_blocked(self):
        # A decision caught only at the last read (not bracketed) must never reach blocked-low.
        clk = ManualClock(1000.0)
        o = obs(attempt="N14", clock=clk).set_window(max_gap=0.3)
        o.from_debug(PROBE)
        o.from_probe_records(PROBE_RECORDS, start_inst=INST)
        o.fact("trust", "confirmed")
        o.fixture_identity(FIXTURE_DIGEST)
        o.fact("skills-dir", "block-attributable", source="control",
               detail={"fixture": "st-b1-rogue-n14",
                       "differential": {"control_run": "ctrl-run-1", "evidence": "skills-dir:loaded",
                                        "fixture_digest": FIXTURE_DIGEST}})
        clk.t += 0.10; o.from_pane(PROBE)
        clk.t += 0.10; o.from_pane(SKILLS_BLOCK)           # decision is the LAST read -> partial
        self.assertEqual(o.coverage(), "partial")
        self.assertEqual(V.verdict_n14(o.snapshot())[0], "inconclusive")


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


def e2e_positive(digest=FIXTURE_DIGEST, loaded=True):
    o = obs(attempt="N14", start=1, instance="pos-1")
    o.from_debug(PROBE + (N14_LOADED if loaded else ""))
    o.from_probe_records(PROBE_RECORDS, start_inst=INST)
    o.fixture_identity(digest)
    return o.snapshot()


def e2e_negative(digest=FIXTURE_DIGEST):
    clk = ManualClock()
    o = obs(attempt="N14", start=1, instance="neg-1", clock=clk).set_window(max_gap=0.3)
    o.from_debug(PROBE)
    o.from_probe_records(PROBE_RECORDS, start_inst=INST)
    o.fact("trust", "confirmed")
    o.fixture_identity(digest)                       # same fixture digest as positive
    for t, txt in [(0.0, PROBE), (0.1, SKILLS_BLOCK), (0.2, PROBE), (0.3, PROBE)]:
        clk.t = t
        o.from_pane(txt)                             # decision 0.1 strictly bracketed by 0.0 and 0.3
    return o.snapshot()                              # NO block-attributable — orchestrator stamps it


def e2e_absent():
    clk = ManualClock()
    o = obs(attempt="N14", start=1, instance="abs-1", clock=clk).set_window(max_gap=0.3)
    o.from_debug(PROBE)
    o.from_probe_records(PROBE_RECORDS, start_inst=INST)
    o.fact("trust", "confirmed")
    for t in [0.0, 0.1, 0.2, 0.3]:
        clk.t = t
        o.from_pane(PROBE)                           # benign reads, no skills-dir signal (no decision)
    return o.snapshot()


def ok(snap, digest):
    return {"ok": True, "snapshot": snap, "digest": digest}


def runner_of(results):
    def run(kind):
        return results[kind]
    return run


class FakeSys:
    """Scripts the make_runner IO seam so every ERROR PATH is testable without a CLI."""

    def __init__(self, scratch, *, fail=None, isolation=True, pane_none=False, reaped=True,
                 trust="confirmed", loaded=True, pane_fail_after=None, reap_raises=False,
                 teardown_raises=False):
        self.scratch, self.fail, self.isolation, self.pane_none = scratch, fail, isolation, pane_none
        self.reaped, self.trust, self.loaded = reaped, trust, loaded
        self.pane_fail_after, self._pane_calls = pane_fail_after, 0
        self.reap_raises, self.teardown_raises = reap_raises, teardown_raises
        self.reap_calls, self.teardown_calls = [], []

    def setup(self, kind, home, ws):
        os.makedirs(ws, exist_ok=True)
        fixture = policy = None
        if kind in ("positive", "negative"):
            fixture = os.path.join(home, ".claude", "skills", "st-b1-rogue-n14")
            os.makedirs(os.path.join(fixture, "hooks"), exist_ok=True)
            with open(os.path.join(fixture, "hooks", "hooks.json"), "w") as fh:
                fh.write('{"modules":["./r.mjs"]}')
        if kind == "negative":
            policy = os.path.join(home, "m.json")
            with open(policy, "w") as fh:
                fh.write("{}")
        return fixture, policy

    def spawn(self, argv, sock):
        if self.fail == "spawn":                           # no child was created
            raise E.SpawnError("before-launch", cause=RuntimeError("spawn boom"))
        if self.fail == "spawn-after":                     # a child exists; partial handle returned
            raise E.SpawnError("after-launch", owner={"owner": True, "partial": True},
                               cause=RuntimeError("readiness timed out"))
        if self.fail == "spawn-unknown":                   # violates the contract: says nothing
            raise RuntimeError("spawn boom")
        return {"owner": True}                             # F1: held owner handle, acquired atomically

    def check_isolation(self, owner):
        return self.isolation

    def pane(self, sock):
        self._pane_calls += 1
        if self.pane_none or (self.pane_fail_after is not None and self._pane_calls > self.pane_fail_after):
            return None
        return PROBE

    def read_text(self, path):
        return PROBE + (N14_LOADED if self.loaded else "")

    def probe_records(self, ws):
        return PROBE_RECORDS

    def probe_inst(self, ws):
        return INST

    def reap(self, owner):
        self.reap_calls.append(owner)
        if self.reap_raises:
            raise RuntimeError("reap boom")
        return self.reaped

    def teardown(self, sock):
        self.teardown_calls.append(sock)
        if self.teardown_raises:
            raise RuntimeError("teardown boom")


def mk_runner(sysio):
    return E.make_runner(sysio, cli="/bin/claude", scratch=tempfile.mkdtemp(),
                         trust_gate=lambda s, sock, hp, on_poll: (on_poll(), {"state": sysio.trust})[1],
                         clock=ManualClock(), settle_polls=2)


class E2ESmokePure(unittest.TestCase):
    def test_isolation_argv(self):
        argv = E.isolation_argv("/bin/claude", "/h", "/w", "/w/dbg", policy_path="/h/m.json")
        self.assertEqual(argv[0], "unshare")
        for flag in ("--map-root-user", "--net", "--pid", "--fork", "--mount-proc", "--kill-child"):
            self.assertIn(flag, argv)                       # F1: --kill-child makes unshare the ns owner
        self.assertIn("CLAUDE_CODE_MANAGED_SETTINGS_PATH=/h/m.json", argv[-1])

    def test_fixture_digest_independent_and_stable(self):
        d = tempfile.mkdtemp()
        os.makedirs(os.path.join(d, "hooks"))
        with open(os.path.join(d, "hooks", "r.mjs"), "w") as fh:
            fh.write("a")
        dig1 = E.fixture_digest(d)
        self.assertEqual(dig1, E.fixture_digest(d))                 # stable
        with open(os.path.join(d, "hooks", "r.mjs"), "w") as fh:
            fh.write("b")
        self.assertNotEqual(dig1, E.fixture_digest(d))              # content-sensitive

    def test_build_attribution_from_real_load(self):
        self.assertEqual(E.build_attribution(e2e_positive())["evidence"], "skills-dir:loaded")
        self.assertIsNone(E.build_attribution(e2e_positive(loaded=False)))

    def test_validate_positive_rejects_forged_snapshot(self):
        snap = e2e_positive()
        snap["events"].append({**snap["events"][0], "start": 99})   # foreign-ctx (unvalidatable)
        ok_, dig = E.validate_positive(snap)
        self.assertFalse(ok_)


class E2EOrchestrator(unittest.TestCase):
    def good(self, pos_dig=FIXTURE_DIGEST, neg_dig=FIXTURE_DIGEST, loaded=True):
        return runner_of({"positive": ok(e2e_positive(digest=pos_dig, loaded=loaded), pos_dig if loaded else None),
                          "negative": ok(e2e_negative(digest=neg_dig), neg_dig),
                          "absent": ok(e2e_absent(), None)})

    def test_three_controls_differentiated_and_blocked_low(self):
        r = E.run_three_controls(self.good())
        self.assertFalse(r["aborted"])
        self.assertIn("loaded", r["controls"]["positive"]["skills_dir"])
        self.assertIn("blocked", r["controls"]["negative"]["skills_dir"])
        self.assertEqual(r["controls"]["absent"]["skills_dir"], [])
        self.assertTrue(r["positive_validated"])
        self.assertTrue(r["differential_validated"])
        self.assertEqual(r["verdict"][0], "blocked-low")
        self.assertNotEqual(r["verdict"][0], "blocked")

    def test_no_real_positive_load_inconclusive(self):
        r = E.run_three_controls(self.good(loaded=False))
        self.assertFalse(r["differential_validated"])
        self.assertEqual(r["verdict"][0], "inconclusive")

    def test_digest_mismatch_between_controls_inconclusive(self):
        r = E.run_three_controls(self.good(pos_dig="AAAA", neg_dig="BBBB"))
        self.assertFalse(r["differential_validated"])
        self.assertEqual(r["verdict"][0], "inconclusive")

    def test_fail_closed_isolation(self):
        r = E.run_three_controls(runner_of({"positive": {"ok": False, "reason": "isolation-failed"}}))
        self.assertTrue(r["aborted"])
        self.assertEqual(r["controls"], {})
        self.assertIn("positive:isolation-failed", r["reason"])

    def test_fail_closed_capture(self):
        r = E.run_three_controls(runner_of({"positive": ok(e2e_positive(), FIXTURE_DIGEST),
                                            "negative": {"ok": False, "reason": "capture-failed"}}))
        self.assertTrue(r["aborted"])
        self.assertIn("negative:capture-failed", r["reason"])


class E2ERunnerErrorPaths(unittest.TestCase):
    def test_spawn_failure(self):
        r = mk_runner(FakeSys(None, fail="spawn"))("positive")
        self.assertEqual((r["ok"], r["reason"]), (False, "spawn-failed"))

    def test_isolation_failure(self):
        r = mk_runner(FakeSys(None, isolation=False))("positive")
        self.assertEqual((r["ok"], r["reason"]), (False, "isolation-failed"))

    def test_capture_failure(self):
        r = mk_runner(FakeSys(None, pane_none=True))("positive")
        self.assertEqual((r["ok"], r["reason"]), (False, "capture-failed"))

    def test_cleanup_not_reaped(self):
        r = mk_runner(FakeSys(None, reaped=False))("positive")
        self.assertEqual((r["ok"], r["reason"]), (False, "cleanup-not-reaped"))

    def test_trust_aborted_is_recorded_not_crash(self):
        r = mk_runner(FakeSys(None, trust="aborted"))("negative")
        self.assertTrue(r["ok"])
        trust = [e["signal"] for e in r["snapshot"]["events"] if e["concern"] == "trust"]
        self.assertEqual(trust, ["aborted"])

    def test_happy_runner_returns_snapshot_and_digest(self):
        r = mk_runner(FakeSys(None))("positive")
        self.assertTrue(r["ok"])
        self.assertTrue(r["digest"])                                # independent fixture hash
        self.assertEqual(r["snapshot"]["attempt"], "N14")

    def test_d3_capture_happens_before_trust_gate(self):
        order = []

        class FS(FakeSys):
            def pane(self, sock):
                order.append("pane")
                return super().pane(sock)

        def tg(sysio, sock, pg, on_poll):
            order.append("trust")
            on_poll()
            return {"state": "confirmed"}

        r = E.make_runner(FS(None), cli="/c", scratch=tempfile.mkdtemp(), trust_gate=tg,
                          clock=ManualClock(), settle_polls=1)("negative")
        self.assertTrue(r["ok"])
        self.assertEqual(order[0], "pane")                          # D3: capture BEFORE the gate
        self.assertLess(order.index("pane"), order.index("trust"))


class RealSysLogic(unittest.TestCase):
    """D1/D4/D5 real decision logic — verified by MOCKS, not by FakeSys returning True. (The reap
    logic moved from the pgid-based D2 `supervise_reap` to the handle-based F1 `cleanup_by_owner`;
    its mock-verified tests live in F1CleanupByOwner.)"""

    def test_d1_interpret_isolation(self):
        self.assertTrue(E.interpret_isolation(["lo"], True))        # only lo + outbound blocked
        self.assertFalse(E.interpret_isolation(["lo", "eth0"], True))   # extra interface
        self.assertFalse(E.interpret_isolation(["lo"], False))      # outbound SUCCEEDED
        self.assertFalse(E.interpret_isolation([], True))           # nothing captured

    def test_d4_verify_cli(self):
        self.assertTrue(E.verify_cli(get_version=lambda: "2.1.314", get_sha=lambda: "abc", want_sha="abc"))
        self.assertFalse(E.verify_cli(get_version=lambda: "2.1.308", get_sha=lambda: "abc", want_sha="abc"))
        self.assertFalse(E.verify_cli(get_version=lambda: "2.1.314", get_sha=lambda: "zzz", want_sha="abc"))

        def boom():
            raise RuntimeError

        self.assertFalse(E.verify_cli(get_version=boom, get_sha=lambda: "abc", want_sha="abc"))

    def _sum(self, pos, neg, ab):
        return {"positive": {"skills_dir": pos}, "negative": {"skills_dir": neg}, "absent": {"skills_dir": ab}}

    def test_d5_consistency(self):
        digs = {"positive": "d", "negative": "d", "absent": None}
        self.assertTrue(E.check_controls_consistency(self._sum(["loaded"], ["blocked"], []), digs)[0])
        self.assertFalse(E.check_controls_consistency(self._sum(["blocked"], ["blocked"], []), digs)[0])      # pos not loaded
        self.assertFalse(E.check_controls_consistency(self._sum(["loaded"], ["loaded", "blocked"], []), digs)[0])  # neg loaded
        self.assertFalse(E.check_controls_consistency(self._sum(["loaded"], ["blocked"], ["blocked"]), digs)[0])   # absent active


class E2EConsistency(unittest.TestCase):
    def test_contradicting_control_blocks_blocked_low(self):
        # absent shows a block (and a digest) -> inconsistent -> inconclusive, NOT blocked-low.
        r = E.run_three_controls(runner_of({"positive": ok(e2e_positive(), FIXTURE_DIGEST),
                                            "negative": ok(e2e_negative(), FIXTURE_DIGEST),
                                            "absent": ok(e2e_negative(), FIXTURE_DIGEST)}))
        self.assertFalse(r["controls_consistent"])
        self.assertEqual(r["verdict"][0], "inconclusive")


class Blocker1Identity(unittest.TestCase):
    def test_parse_ns_inode(self):
        self.assertEqual(E.parse_ns_inode("net:[4026531992]"), "4026531992")
        self.assertIsNone(E.parse_ns_inode(None))
        self.assertIsNone(E.parse_ns_inode("weird"))

    def test_verify_isolated(self):
        self.assertTrue(E.verify_isolated("hn", "hp", "tn", "tp"))
        self.assertFalse(E.verify_isolated("hn", "hp", "hn", "tp"))   # same netns as host
        self.assertFalse(E.verify_isolated("hn", "hp", "tn", "hp"))   # same pidns as host
        self.assertFalse(E.verify_isolated(None, "hp", "tn", "tp"))   # missing value

    def test_ns_is_empty(self):
        # F1: the disposable PID namespace is empty iff NO live process carries its inode. An unknown
        # target inode (None) is NOT verifiable ⇒ False (fail-closed — never credit emptiness blind).
        self.assertTrue(E.ns_is_empty("FRESH", ["HOST", "HOST", "OTHER"]))     # none in FRESH
        self.assertFalse(E.ns_is_empty("FRESH", ["HOST", "FRESH"]))            # one still in FRESH
        self.assertFalse(E.ns_is_empty(None, ["HOST"]))                        # unknown target
        self.assertFalse(E.ns_is_empty("FRESH", ["FRESH"]))


class Blocker2ClockScale(unittest.TestCase):
    def test_coverage_full_with_nonzero_clock_start(self):
        # Regression: the window + reads must share one scale even when the monotonic clock starts
        # far from 0 (not just ManualClock(0)).
        self.assertEqual(n14_full_block(clock_start=1000.0).coverage(), "full")
        self.assertEqual(V.verdict_n14(n14_full_block(clock_start=1000.0).snapshot())[0], "blocked-low")


SIGTERM = __import__("signal").SIGTERM
SIGKILL = __import__("signal").SIGKILL


class F1CleanupByOwner(unittest.TestCase):
    """F1: reap by a HELD OWNER HANDLE (a child we created), never a pgid and never a bare pid.
    `signal_owner`/`owner_exited` act on THAT child only (no pid arithmetic ⇒ immune to reuse), and
    cleanup is accredited ONLY when `namespace_empty` verifies the namespace emptied — owner exit is
    necessary, not sufficient (point 4)."""

    def test_none_owner_never_signals_and_is_not_reaped(self):
        sent = []
        self.assertFalse(E.cleanup_by_owner(None, signal_owner=lambda s: sent.append(s),
                                            owner_exited=lambda: True, namespace_empty=lambda: True,
                                            sleep=lambda s: None))
        self.assertEqual(sent, [])                       # no owned handle -> no signal, no claim

    def test_owner_dies_on_sigterm_ns_empty_no_sigkill(self):
        state, sent = {"alive": True}, []

        def sig(s):
            sent.append(s)
            state["alive"] = False

        self.assertTrue(E.cleanup_by_owner(object(), signal_owner=sig,
                                           owner_exited=lambda: not state["alive"],
                                           namespace_empty=lambda: True, sleep=lambda s: None))
        self.assertEqual(sent, [SIGTERM])                # held owner only; no SIGKILL needed

    def test_owner_exits_but_namespace_not_empty_is_not_reaped(self):
        # POINT 4: the owner exited but a process still lives in the namespace -> NOT accredited.
        self.assertFalse(E.cleanup_by_owner(object(), signal_owner=lambda s: None,
                                            owner_exited=lambda: True, namespace_empty=lambda: False,
                                            sleep=lambda s: None, verify_grace=0.2, tick=0.1))

    def test_owner_escalates_to_sigkill(self):
        sent = []
        self.assertTrue(E.cleanup_by_owner(object(), signal_owner=lambda s: sent.append(s),
                                           owner_exited=lambda: SIGKILL in sent,
                                           namespace_empty=lambda: True, sleep=lambda s: None,
                                           term_grace=0.4, kill_grace=0.4, tick=0.2))
        self.assertIn(SIGKILL, sent)

    def test_owner_never_dies_is_not_reaped(self):
        self.assertFalse(E.cleanup_by_owner(object(), signal_owner=lambda s: None,
                                            owner_exited=lambda: False, namespace_empty=lambda: True,
                                            sleep=lambda s: None, term_grace=0.4, kill_grace=0.4, tick=0.2))

    def test_owner_already_gone_still_verifies_namespace(self):
        # ProcessLookupError == the held child is already gone (never a reused pid); even so we MUST
        # verify the namespace emptied before accrediting.
        def gone(s):
            raise ProcessLookupError

        self.assertTrue(E.cleanup_by_owner(object(), signal_owner=gone, owner_exited=lambda: False,
                                           namespace_empty=lambda: True, sleep=lambda s: None))
        self.assertFalse(E.cleanup_by_owner(object(), signal_owner=gone, owner_exited=lambda: False,
                                            namespace_empty=lambda: False, sleep=lambda s: None,
                                            verify_grace=0.2, tick=0.1))

    def test_permission_error_is_not_read_as_exit(self):
        def denied(s):
            raise PermissionError                        # OSError subclass, NOT proof of exit

        self.assertFalse(E.cleanup_by_owner(object(), signal_owner=denied, owner_exited=lambda: False,
                                            namespace_empty=lambda: True, sleep=lambda s: None,
                                            term_grace=0.2, kill_grace=0.2, tick=0.1))

    def test_unverifiable_namespace_is_not_credited(self):
        # ns identity unknown ⇒ ns_is_empty/namespace_empty stays False ⇒ never accredited, even
        # though the owner exited cleanly.
        self.assertFalse(E.cleanup_by_owner(object(), signal_owner=lambda s: None,
                                            owner_exited=lambda: True,
                                            namespace_empty=lambda: E.ns_is_empty(None, ["HOST"]),
                                            sleep=lambda s: None, verify_grace=0.2, tick=0.1))

    def test_signals_only_the_held_owner_never_a_pid(self):
        # The function performs NO pid lookup; it signals the held owner via signal_owner, so a
        # stranger that reused the numeric pid is structurally unreachable.
        sent = []
        self.assertTrue(E.cleanup_by_owner(object(), signal_owner=lambda s: sent.append(s),
                                           owner_exited=lambda: True, namespace_empty=lambda: True,
                                           sleep=lambda s: None))
        self.assertEqual(sent, [SIGTERM])                # exactly one signal to the held owner


class F1RunnerCleanup(unittest.TestCase):
    """F1 in the runner: the owner is acquired atomically from spawn; cleanup runs on every post-spawn
    path, teardown runs even if reap raises, unexpected errors abort without losing cleanup info, and
    a clean run whose namespace cannot be reaped is NOT credited."""

    def test_owner_acquired_from_spawn_then_reaped(self):
        order = []

        class FS(FakeSys):
            def spawn(self, argv, sock):
                order.append("spawn")
                return super().spawn(argv, sock)

            def reap(self, owner):
                order.append("reap")
                return super().reap(owner)

        r = mk_runner(FS(None))("positive")
        self.assertTrue(r["ok"])
        self.assertEqual(order, ["spawn", "reap"])       # no post-launch pid lookup between them
        self.assertTrue(r["cleanup_accredited"])

    def test_reap_exception_still_tears_down_and_aborts(self):
        # Point 2: reap raising must NOT skip teardown. Point 1: the outcome is a safe, recorded
        # not-accredited cleanup, and the clean run becomes cleanup-not-reaped (never a silent pass).
        fs = FakeSys(None, reap_raises=True)
        r = mk_runner(fs)("positive")
        self.assertEqual((r["ok"], r["reason"]), (False, "cleanup-not-reaped"))
        self.assertFalse(r["cleanup_accredited"])
        self.assertEqual(len(fs.teardown_calls), 1)      # teardown ran despite the reap exception

    def test_teardown_exception_does_not_mask_result(self):
        fs = FakeSys(None, teardown_raises=True)
        r = mk_runner(fs)("positive")
        self.assertTrue(r["ok"])                          # teardown failure is swallowed, reap stood
        self.assertTrue(r["cleanup_accredited"])

    def test_unexpected_error_aborts_inconclusive_with_cleanup_info(self):
        # Point 3: an unexpected error mid-run ⇒ aborted/INCONCLUSIVE, and cleanup still runs + is
        # reported (no lost information).
        class FS(FakeSys):
            def check_isolation(self, owner):
                raise RuntimeError("kernel hiccup")

        fs = FS(None)
        r = mk_runner(fs)("positive")
        self.assertFalse(r["ok"])
        self.assertTrue(r["reason"].startswith("unexpected:"))
        self.assertIn("cleanup_accredited", r)            # cleanup outcome preserved
        self.assertEqual(len(fs.reap_calls), 1)           # owner was still reaped
        self.assertEqual(len(fs.teardown_calls), 1)

    def test_spawn_failure_leaves_nothing_to_clean(self):
        fs = FakeSys(None, fail="spawn")
        r = mk_runner(fs)("positive")
        self.assertEqual((r["ok"], r["reason"]), (False, "spawn-failed"))
        self.assertTrue(r["cleanup_accredited"])          # nothing was left running
        self.assertEqual(fs.reap_calls, [])               # no reap/teardown without an owner
        self.assertEqual(fs.teardown_calls, [])

    def test_clean_run_unverified_namespace_not_credited(self):
        r = mk_runner(FakeSys(None, reaped=False))("positive")
        self.assertEqual((r["ok"], r["reason"]), (False, "cleanup-not-reaped"))
        self.assertFalse(r["cleanup_accredited"])


# ── RealSys round-2 review: deterministic tests of RealSys's OWN behaviour (not FakeSys) ──
class P01KeyTranslation(unittest.TestCase):
    """P0-1: trust-gate key NAMES become real terminal byte sequences, never literal text."""

    def test_named_keys(self):
        self.assertEqual(E.key_to_bytes("Down"), b"\x1b[B")     # the two keys the gate actually sends
        self.assertEqual(E.key_to_bytes("Enter"), b"\r")
        self.assertEqual(E.key_to_bytes("Up"), b"\x1b[A")
        self.assertEqual(E.key_to_bytes("Escape"), b"\x1b")

    def test_single_printable_passthrough(self):
        self.assertEqual(E.key_to_bytes("y"), b"y")

    def test_unmapped_raises(self):
        with self.assertRaises(ValueError):
            E.key_to_bytes("Downn")                             # must NEVER be transmitted as text
        with self.assertRaises(ValueError):
            E.key_to_bytes("")


class P02ScreenState(unittest.TestCase):
    """P0-2: a bounded screen model yields the CURRENT frame — dismissed dialogs do not linger."""

    def test_cr_overwrites_in_place(self):
        s = E.ScreenState(rows=3, cols=10)
        s.feed("hello\rHELLO")
        self.assertEqual(s.render(), "HELLO")

    def test_cursor_home_overwrite(self):
        s = E.ScreenState(rows=3, cols=10)
        s.feed("aaa")
        s.feed("\x1b[Hb")                                       # CUP home + 'b'
        self.assertEqual(s.render(), "baa")

    def test_dismissed_dialog_does_not_persist(self):
        s = E.ScreenState(rows=6, cols=40)
        s.feed("❯ Yes, proceed\r\n  No, exit\r\n")
        self.assertIn("Yes, proceed", s.render())
        s.feed("\x1b[2J\x1b[H")                                 # clear + home (redraw)
        s.feed("All set. Working...")
        out = s.render()
        self.assertEqual(out, "All set. Working...")
        self.assertNotIn("Yes, proceed", out)                  # the old dialog is GONE (core of P0-2)

    def test_erase_to_end_of_line(self):
        s = E.ScreenState(rows=2, cols=10)
        s.feed("abcdef")
        s.feed("\x1b[1G\x1b[K")                                 # col 1 + erase-to-EOL
        self.assertEqual(s.render(), "")

    def test_incomplete_escape_held_across_feeds(self):
        s = E.ScreenState(rows=2, cols=10)
        s.feed("x\x1b[")                                        # CSI split mid-sequence
        s.feed("Hy")                                            # completes \x1b[H then 'y'
        self.assertEqual(s.render(), "y")

    def test_bounded_grid_does_not_grow(self):
        s = E.ScreenState(rows=2, cols=4)
        s.feed("A" * 1000 + "\n" * 1000)
        self.assertEqual(len(s.grid), 2)
        self.assertTrue(all(len(r) == 4 for r in s.grid))

    def test_pointer_option_reads_current_frame(self):
        # the trust-gate's OWN classifier must read the pointer off the current rendered frame.
        import importlib.util
        tg_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                               "inv1-trust", "trustgate.py")
        spec = importlib.util.spec_from_file_location("trustgate", tg_path)
        tg = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tg)
        s = E.ScreenState(rows=5, cols=60)
        s.feed("Do you trust the files in this folder?\r\n"
               "\x1b[32m❯ 1. Yes, I trust this folder\x1b[0m\r\n  2. No, exit\r\n")
        self.assertEqual(tg.pointer_option(s.render()), "yes")  # SGR stripped, pointer on the frame


class P03NamespaceReadiness(unittest.TestCase):
    """P0-3: bounded readiness poll (no arbitrary sleep), fail-closed on owner death / timeout."""

    def test_ready_immediately(self):
        self.assertEqual(E.poll_ns_ready(sample=lambda: ("hn", "hp", "tn", "tp"), alive=lambda: True,
                                         now=lambda: 0.0, sleep=lambda s: None),
                         ("hn", "hp", "tn", "tp"))

    def test_becomes_ready_after_polls(self):
        seq = [("hn", "hp", None, None), ("hn", "hp", "tn", None), ("hn", "hp", "tn", "tp")]
        st = {"i": 0, "slept": 0, "t": 0.0}

        def sample():
            s = seq[min(st["i"], len(seq) - 1)]
            st["i"] += 1
            return s

        def sleep(_):
            st["slept"] += 1
            st["t"] += 0.05

        s = E.poll_ns_ready(sample=sample, alive=lambda: True, now=lambda: st["t"], sleep=sleep,
                            timeout=10.0, interval=0.05)
        self.assertEqual(s, ("hn", "hp", "tn", "tp"))
        self.assertEqual(st["slept"], 2)                        # polled, no arbitrary one-shot sleep

    def test_owner_death_raises(self):
        with self.assertRaises(RuntimeError):
            E.poll_ns_ready(sample=lambda: ("hn", "hp", None, None), alive=lambda: False,
                            now=lambda: 0.0, sleep=lambda s: None)

    def test_timeout_raises(self):
        st = {"t": 0.0}

        def sleep(_):
            st["t"] += 0.05

        with self.assertRaises(RuntimeError):
            E.poll_ns_ready(sample=lambda: ("hn", "hp", "hn", "hp"),   # never fresh (tn==hn)
                            alive=lambda: True, now=lambda: st["t"], sleep=sleep,
                            timeout=0.2, interval=0.05)


class P14NamespaceEmptiness(unittest.TestCase):
    """P1-4: a process we could not inspect while it is still present must NOT yield a positive
    'empty' — only an exited process is safely skipped."""

    def test_ns_is_empty_unverifiable_blocks_credit(self):
        self.assertTrue(E.ns_is_empty("FRESH", ["HOST"], unverifiable=0))
        self.assertFalse(E.ns_is_empty("FRESH", ["HOST"], unverifiable=1))   # present-but-unreadable
        self.assertFalse(E.ns_is_empty("FRESH", ["HOST", "FRESH"], unverifiable=0))

    def test_scan_separates_unverifiable_from_exited(self):
        inode = {"1": "HOST", "2": None, "3": None}             # 2 unreadable+present, 3 exited
        inodes, unver = E.scan_proc_pidns(["1", "2", "3"], read_inode=lambda p: inode[p],
                                          still_present=lambda p: p != "3")
        self.assertEqual(sorted(inodes), ["HOST"])
        self.assertEqual(unver, 1)                              # only pid 2 (present + unreadable)

    def test_scan_all_unreadable_present_fails_closed(self):
        inodes, unver = E.scan_proc_pidns(["1", "2"], read_inode=lambda p: None,
                                          still_present=lambda p: True)
        self.assertEqual((inodes, unver), ([], 2))
        self.assertFalse(E.ns_is_empty("FRESH", inodes, unverifiable=unver))


class RealSysIO(unittest.TestCase):
    """Deterministic tests of RealSys's OWN fd/wiring behaviour using real OS pipes and injected
    /proc — NO CLI, NO unshare, NO Docker (the real smoke stays unrun)."""

    def _rs(self):
        return E.RealSys("/bin/claude", "sha", "/mk")

    def test_send_translates_key_to_pty_bytes(self):
        rfd, wfd = os.pipe()
        try:
            rs = self._rs()
            rs._inst["s"] = {"master": wfd, "screen": E.ScreenState()}
            rs._send("s", "Down")
            rs._send("s", "Enter")
            self.assertEqual(os.read(rfd, 64), b"\x1b[B\r")     # real key events, not "DownEnter"
        finally:
            os.close(rfd)
            os.close(wfd)

    def test_pane_returns_current_frame_from_pty(self):
        rfd, wfd = os.pipe()
        try:
            rs = self._rs()
            rs._inst["s"] = {"master": rfd, "screen": E.ScreenState(rows=5, cols=40)}
            os.write(wfd, "❯ Yes, proceed\r\n  No, exit\r\n".encode())
            self.assertIn("Yes, proceed", rs.pane("s"))
            os.write(wfd, b"\x1b[2J\x1b[Hdone")                 # redraw: clear + new content
            out = rs.pane("s")
            self.assertEqual(out, "done")
            self.assertNotIn("Yes, proceed", out)               # old dialog gone through the PTY (P0-2)
        finally:
            os.close(rfd)
            os.close(wfd)

    def test_pane_read_error_is_none(self):
        rs = self._rs()
        rfd, wfd = os.pipe()
        os.close(rfd)                                           # a closed fd -> select/read raises
        rs._inst["s"] = {"master": rfd, "screen": E.ScreenState()}
        self.assertIsNone(rs.pane("s"))                         # fail closed
        os.close(wfd)

    def test_namespace_empty_wiring_fail_closed(self):
        rs = self._rs()
        owner = {"ns_pid": "FRESH"}
        with mock.patch("e2e_smoke.os.listdir", return_value=["1", "2"]), \
             mock.patch("e2e_smoke.os.path.exists", return_value=True):
            rs._readlink = lambda pid, ns: "pid:[HOST]"         # none in FRESH, all readable
            self.assertTrue(rs._namespace_empty(owner))
            rs._readlink = lambda pid, ns: "pid:[FRESH]" if pid == 2 else "pid:[HOST]"
            self.assertFalse(rs._namespace_empty(owner))        # a process still in FRESH
            rs._readlink = lambda pid, ns: None                 # unreadable + present
            self.assertFalse(rs._namespace_empty(owner))        # P1-4: unverifiable ⇒ not credited


class E2WindowSequencing(unittest.TestCase):
    """With a clock that ADVANCES during spawn/isolation/ticks, coverage (derived from the real read
    timestamps, F2) is full for continuous benign reads, and is NOT relaxed on a failed read."""

    class AdvancingFS(FakeSys):
        def __init__(self, clk, **kw):
            super().__init__(None, **kw)
            self.clk = clk

        def spawn(self, argv, sock):
            self.clk.t += 0.5
            return super().spawn(argv, sock)

        def check_isolation(self, owner):
            self.clk.t += 0.2
            return super().check_isolation(owner)

        def pane(self, sock):
            self.clk.t += 0.3
            return super().pane(sock)

    def _run(self, **kw):
        clk = ManualClock(1000.0)
        fs = self.AdvancingFS(clk, **kw)
        runner = E.make_runner(fs, cli="/c", scratch=tempfile.mkdtemp(),
                               trust_gate=lambda s, sock, hp, on_poll: (on_poll(), {"state": "confirmed"})[1],
                               clock=clk, settle_polls=3)
        return runner("positive")

    def test_advancing_clock_still_full(self):
        r = self._run()
        self.assertTrue(r["ok"])
        self.assertEqual(r["snapshot"]["coverage"], "full")        # window derived from reads; no decision

    def test_failed_read_still_partial(self):
        r = self._run(pane_fail_after=2)                           # a later read fails
        self.assertIn(r.get("reason"), ("capture-failed", "capture-failed-during-trust"))


class Blocker3FixtureWorkspace(unittest.TestCase):
    def test_isolation_argv_cds_and_verifies_cwd(self):
        inner = E.isolation_argv("/c", "/h", "/w/ws", "/w/ws/dbg")[-1]
        self.assertIn("cd ", inner)
        self.assertIn("pwd -P", inner)
        self.assertIn("exit 97", inner)
        self.assertNotIn("echo $$", inner)               # Blocker 1: no PID-ns-local pgid write

    def test_fixture_reproduces_the_attack(self):
        rs = E.RealSys("/c", "sha", "/mk")
        d = tempfile.mkdtemp()
        rs._plant_fixture(os.path.join(d, "fx"))
        with open(os.path.join(d, "fx", "hooks", "register.mjs")) as fh:   # E3: register.mjs, not r.mjs
            reg = fh.read()
        self.assertIn("session.start", reg)              # registers a real hook
        self.assertIn("st-b1-rogue-n14.json", reg)       # E3: kit's marker, not impostor.json
        self.assertNotIn("register(on){}", reg.replace(" ", ""))   # not the empty stub
        with open(os.path.join(d, "fx", "hooks", "hooks.json")) as fh:
            self.assertIn("./register.mjs", fh.read())

    def test_e3_fixture_equivalent_to_kit_without_touching_8eafe1a(self):
        # Render the kit's own ROGUE_REGISTER for st-b1-rogue-n14 and compare to the disposable copy.
        import importlib.util
        kit_b1 = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "passb1", "b1.py")
        spec = importlib.util.spec_from_file_location("kit_b1", kit_b1)
        b1 = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(b1)
        import re
        expected = b1.ROGUE_REGISTER % {"name": re.sub(r"[^a-z0-9-]", "", "st-b1-rogue-n14")}
        self.assertEqual(E.ROGUE_REGISTER, expected)     # byte-for-byte equivalence


class Blocker4SilentFailures(unittest.TestCase):
    def test_capture_failure_during_trust_invalidates(self):
        # pane ok for the pre-trust tick, then fails on the gate's poll -> run invalidated.
        r = mk_runner(FakeSys(None, pane_fail_after=1))("negative")
        self.assertEqual((r["ok"], r["reason"]), (False, "capture-failed-during-trust"))

    def test_spawn_result_failure_is_spawn_failed(self):
        r = mk_runner(FakeSys(None, fail="spawn"))("positive")
        self.assertEqual((r["ok"], r["reason"]), (False, "spawn-failed"))



# ── RealSys round-3 review (R3-1…R3-4): deterministic, no Claude, no unshare, no Docker ──
def _trustgate():
    import importlib.util
    tg_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           "inv1-trust", "trustgate.py")
    spec = importlib.util.spec_from_file_location("trustgate_r3", tg_path)
    tg = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tg)
    return tg


TRUST_DIALOG = ("Do you trust the files in this folder?\r\n"
                "❯ 1. Yes, I trust this folder\r\n  2. No, exit\r\n")


class R31AlternateScreen(unittest.TestCase):
    """R3-1: a dialog drawn on one buffer must never be readable from the other, and any sequence
    with a visual effect we don't model must invalidate the frame instead of leaving a stale one."""

    def test_dialog_on_alt_screen_disappears_on_leave_without_2J(self):
        tg = _trustgate()
        s = E.ScreenState(rows=10, cols=60)
        s.feed("$ claude\r\n")
        s.feed("\x1b[?1049h" + TRUST_DIALOG)                 # TUI draws the dialog on the ALT screen
        self.assertEqual(tg.pointer_option(s.frame()), "yes")
        s.feed("\x1b[?1049l")                                 # leaves the alt screen — NO CSI 2J
        out = s.frame()
        self.assertEqual(out, "$ claude")                     # the primary buffer, exactly as it was
        self.assertIsNone(tg.pointer_option(out))             # the dialog is NOT readable any more

    def test_primary_dialog_hidden_while_alt_screen_shown(self):
        tg = _trustgate()
        s = E.ScreenState(rows=10, cols=60)
        s.feed(TRUST_DIALOG)
        s.feed("\x1b[?1049hloading...")
        self.assertEqual(s.frame(), "loading...")
        self.assertIsNone(tg.pointer_option(s.frame()))       # hidden dialog is not "yes"
        s.feed("\x1b[?1049l")
        self.assertEqual(tg.pointer_option(s.frame()), "yes")  # visible again → correctly readable

    def test_other_alt_modes(self):
        for mode in ("47", "1047"):
            s = E.ScreenState(rows=4, cols=20)
            s.feed("primary")
            s.feed(f"\x1b[?{mode}halt")
            self.assertEqual(s.frame(), "alt")
            s.feed(f"\x1b[?{mode}l")
            self.assertEqual(s.frame(), "primary")

    def test_unsupported_visual_sequences_invalidate(self):
        for seq in ("\x1b[2L", "\x1b[3M", "\x1b[4P", "\x1b[2@", "\x1b[5X", "\x1b[1;10r", "\x1b[2S",
                    "\x1b[4h", "\x1b[?6h", "\x1bZ"):
            s = E.ScreenState(rows=4, cols=20)
            s.feed("hello" + seq)
            self.assertIsNone(s.frame(), repr(seq))           # never a frame we cannot vouch for

    def test_recovery_needs_full_clear_AND_absolute_cursor(self):
        s = E.ScreenState(rows=4, cols=20)
        s.feed("old\x1b[2L")
        self.assertIsNone(s.frame())
        s.feed("\x1b[2J")                                     # cells known, cursor not yet
        self.assertIsNone(s.frame())
        s.feed("\x1b[1;1Hfresh")                              # absolute position → valid again
        self.assertEqual(s.frame(), "fresh")

    def test_nonvisual_sequences_keep_frame_valid(self):
        s = E.ScreenState(rows=4, cols=30)
        s.feed("\x1b[?25l\x1b[?2004h\x1b[?2026h\x1b[>1u\x1b[?u\x1b[?6n\x1b[2 q\x1b[32mok\x1b[0m"
               "\x1b[?2026l\x1b[?25h")
        self.assertEqual(s.frame(), "ok")

    def test_osc_title_is_consumed_not_painted_even_split(self):
        s = E.ScreenState(rows=4, cols=30)
        s.feed("\x1b]0;my ti")                                # OSC split across reads
        s.feed("tle\x07hello\x1b]2;x\x1b\\!")                 # BEL- and ST-terminated
        self.assertEqual(s.frame(), "hello!")

    def test_save_restore_cursor(self):
        s = E.ScreenState(rows=4, cols=30)
        s.feed("ab\x1b7\r\nzz\x1b8c")
        self.assertEqual(s.frame(), "abc\nzz")

    def test_realsys_pane_is_none_on_invalid_frame(self):
        rfd, wfd = os.pipe()
        try:
            rs = E.RealSys("/c", "sha", "/mk")
            rs._inst["s"] = {"master": rfd, "screen": E.ScreenState(rows=4, cols=20)}
            os.write(wfd, b"ok")
            self.assertEqual(rs.pane("s"), "ok")
            os.write(wfd, b"\x1b[3L")                         # unmodelled visual effect
            self.assertIsNone(rs.pane("s"))                   # ⇒ the runner fails closed
        finally:
            os.close(rfd)
            os.close(wfd)


class R34IncrementalUtf8(unittest.TestCase):
    """R3-4: a multibyte character split across reads is reassembled, never turned into U+FFFD."""

    def test_pointer_glyph_split_across_three_feeds(self):
        tg = _trustgate()
        s = E.ScreenState(rows=6, cols=60)
        s.feed(b"Do you trust the files in this folder?\r\n")
        for chunk in (b"\xe2", b"\x9d", b"\xaf 1. Yes, I trust this folder\r\n"):
            s.feed(chunk)
        out = s.frame()
        self.assertIn("❯ 1. Yes", out)
        self.assertNotIn("�", out)
        self.assertEqual(tg.pointer_option(out), "yes")

    def test_split_glyph_through_realsys_pane(self):
        rfd, wfd = os.pipe()
        try:
            rs = E.RealSys("/c", "sha", "/mk")
            rs._inst["s"] = {"master": rfd, "screen": E.ScreenState(rows=4, cols=40)}
            os.write(wfd, b"\xe2\x9d")                        # first two bytes of U+276F
            self.assertNotIn("�", rs.pane("s"))
            os.write(wfd, b"\xaf done")
            self.assertEqual(rs.pane("s"), "❯ done")
        finally:
            os.close(rfd)
            os.close(wfd)


@unittest.skipUnless(sys.platform.startswith("linux"), "PTY/ctty semantics checked on Linux")
class R32PtyInitialisation(unittest.TestCase):
    """R3-2: the PTY has the ScreenState geometry and is the child's controlling TTY, and the Popen is
    still our own child. Exercised with a throwaway Python child — never Claude."""

    CHILD = ("import os\n"
             "s = os.get_terminal_size(0)\n"
             "open('/dev/tty', 'rb').close()\n"
             "print('R', s.lines, s.columns, os.getsid(0) == os.getpid(),"
             " os.tcgetpgrp(0) == os.getpgrp(), flush=True)\n")

    def _run(self, **kw):
        proc, master = E.open_owned_pty_child([sys.executable, "-I", "-c", self.CHILD], **kw)
        out = b""
        try:
            import select
            while select.select([master], [], [], 5)[0]:
                try:
                    chunk = os.read(master, 4096)
                except OSError:                               # EIO once the child closed the slave
                    break
                if not chunk:
                    break
                out += chunk
            self.assertEqual(proc.wait(timeout=10), 0, out)   # waitable ⇒ it is OUR child
        finally:
            os.close(master)
        return out.decode()

    def test_default_geometry_matches_screenstate_and_ctty(self):
        out = self._run()
        self.assertIn(f"R {E.PTY_ROWS} {E.PTY_COLS} True True", out)
        st = E.ScreenState()
        self.assertEqual((st.rows, st.cols), (E.PTY_ROWS, E.PTY_COLS))

    def test_explicit_geometry(self):
        self.assertIn("R 24 80 True True", self._run(rows=24, cols=80))

    def test_winsize_failure_is_before_launch_and_closes_fds(self):
        fds = os.pipe()                                       # not a tty ⇒ TIOCSWINSZ fails
        launched = []
        with self.assertRaises(E.SpawnError) as cm:
            E.open_owned_pty_child(["/bin/true"], openpty=lambda: fds,
                                   popen=lambda *a, **k: launched.append(1))
        self.assertEqual(cm.exception.stage, "before-launch")
        self.assertIsNone(cm.exception.owner)
        self.assertEqual(launched, [])                        # no process was started
        for fd in fds:
            with self.assertRaises(OSError):
                os.fstat(fd)                                  # both descriptors were closed

    def test_popen_failure_is_before_launch_and_closes_fds(self):
        import pty
        opened = []

        def openpty():
            m, sl = pty.openpty()
            opened.extend([m, sl])
            return m, sl

        def popen(*a, **k):
            raise FileNotFoundError("no such binary")

        with self.assertRaises(E.SpawnError) as cm:
            E.open_owned_pty_child(["/nonexistent"], openpty=openpty, popen=popen)
        self.assertEqual(cm.exception.stage, "before-launch")
        for fd in opened:
            with self.assertRaises(OSError):
                os.fstat(fd)


class R33SpawnCleanupAccreditation(unittest.TestCase):
    """R3-3: spawn failures say whether a process exists; only "no process was ever created" is
    reported clean; after launch the held handle is reaped and accreditation needs verification."""

    def test_runner_before_launch_is_clean_without_reap(self):
        fs = FakeSys(None, fail="spawn")
        r = mk_runner(fs)("positive")
        self.assertEqual((r["ok"], r["reason"], r["stage"]), (False, "spawn-failed", "before-launch"))
        self.assertTrue(r["cleanup_accredited"])
        self.assertEqual((fs.reap_calls, fs.teardown_calls), ([], []))

    def test_runner_after_launch_reaps_partial_handle(self):
        for reaped in (True, False):
            fs = FakeSys(None, fail="spawn-after", reaped=reaped)
            r = mk_runner(fs)("positive")
            self.assertEqual((r["ok"], r["reason"], r["stage"]), (False, "spawn-failed", "after-launch"))
            self.assertEqual(fs.reap_calls, [{"owner": True, "partial": True}])   # by the held handle
            self.assertEqual(len(fs.teardown_calls), 1)
            self.assertIs(r["cleanup_accredited"], reaped)    # exactly what reap could verify

    def test_runner_unknown_spawn_failure_not_accredited(self):
        fs = FakeSys(None, fail="spawn-unknown")
        r = mk_runner(fs)("positive")
        self.assertEqual((r["reason"], r["stage"]), ("spawn-failed", "unknown"))
        self.assertFalse(r["cleanup_accredited"])

    class FakeProc:
        pid = 999999

        def __init__(self):
            self.killed = self.waited = False

        def poll(self):
            return None

        def kill(self):
            self.killed = True

        def wait(self, timeout=None):
            self.waited = True
            return 0

    def test_realsys_readiness_failure_raises_after_launch_with_handle(self):
        rfd, wfd = os.pipe()
        proc = self.FakeProc()
        rs = E.RealSys("/c", "sha", "/mk")
        try:
            with mock.patch("e2e_smoke.open_owned_pty_child", return_value=(proc, rfd)), \
                 mock.patch("e2e_smoke.poll_ns_ready", side_effect=RuntimeError("readiness timed out")):
                with self.assertRaises(E.SpawnError) as cm:
                    rs.spawn(["unshare"], "s")
            e = cm.exception
            self.assertEqual(e.stage, "after-launch")
            self.assertIs(e.owner["proc"], proc)              # the held handle survives the failure
            self.assertIsNone(e.owner["ns_pid"])              # namespace identity NOT acquired
            self.assertFalse(proc.killed or proc.waited)      # spawn did not kill+swallow on its own
            self.assertNotIn("s", rs._inst)
            # …so cleanup of this handle can never be accredited without a verified namespace:
            self.assertFalse(rs._namespace_empty(e.owner))
            self.assertFalse(E.cleanup_by_owner(e.owner, signal_owner=lambda sig: None,
                                                owner_exited=lambda: True,
                                                namespace_empty=lambda: rs._namespace_empty(e.owner),
                                                sleep=lambda t: None, verify_grace=0.2, tick=0.1))
        finally:
            os.close(rfd)
            os.close(wfd)

    def test_realsys_before_launch_propagates(self):
        rs = E.RealSys("/c", "sha", "/mk")
        with mock.patch("e2e_smoke.open_owned_pty_child",
                        side_effect=E.SpawnError("before-launch", cause=OSError("openpty"))):
            with self.assertRaises(E.SpawnError) as cm:
                rs.spawn(["unshare"], "s")
        self.assertEqual(cm.exception.stage, "before-launch")
        self.assertIsNone(cm.exception.owner)



# ── closing review of e34845a: ?2026 synchronized output, ED 3, per-control cleanup ──
class R5SynchronizedOutput(unittest.TestCase):
    """?2026h…?2026l: between h and l the update is NOT presented; no frame (and so no Enter) from it."""

    YES = ("Do you trust the files in this folder?\r\n"
           "❯ 1. Yes, I trust this folder\r\n  2. No, exit\r\n")

    def test_frame_none_while_update_open(self):
        s = E.ScreenState(rows=6, cols=60)
        s.feed("\x1b[?2026h" + self.YES)
        self.assertIsNone(s.frame())                          # intermediate, never presented
        s.feed("\x1b[?2026l")
        self.assertIn("Yes, I trust this folder", s.frame())  # presented now

    def test_intermediate_yes_never_visible_when_final_differs(self):
        tg = _trustgate()
        s = E.ScreenState(rows=6, cols=60)
        s.feed("\x1b[?2026h" + self.YES)                     # mid-update the grid says "yes"…
        self.assertIsNone(tg.pointer_option(s.frame() or ""))
        s.feed("\x1b[2J\x1b[HWorking\x1b[?2026l")             # …but the presented frame never did
        self.assertEqual(s.frame(), "Working")
        self.assertIsNone(tg.pointer_option(s.frame()))

    def test_realsys_pane_refuses_open_update_and_gate_will_not_enter(self):
        tg = _trustgate()
        rfd, wfd = os.pipe()
        try:
            rs = E.RealSys("/c", "sha", "/mk")
            rs.sync_wait = 0                                  # deterministic: no waiting
            rs._inst["s"] = {"master": rfd, "screen": E.ScreenState(rows=6, cols=60)}
            os.write(wfd, ("\x1b[?2026h" + self.YES).encode())
            frame = rs.pane("s")
            self.assertIsNone(frame)
            # exactly what real_trust_gate passes to the gate (`pane() or ""`): Enter is NOT authorised
            self.assertNotEqual(tg.revalidate_before_enter(frame or "", False)[0], "ok")
            os.write(wfd, b"\x1b[?2026l")                     # the update completes
            self.assertEqual(tg.pointer_option(rs.pane("s")), "yes")
        finally:
            os.close(rfd)
            os.close(wfd)

    def test_reset_clears_open_update(self):
        s = E.ScreenState(rows=4, cols=20)
        s.feed("\x1b[?2026hx\x1bcok")
        self.assertEqual(s.frame(), "ok")


class R5EraseScrollback(unittest.TestCase):
    """ED 3 erases scrollback only (xterm): the visible grid is untouched and nothing becomes known."""

    def test_3J_keeps_visible_grid(self):
        s = E.ScreenState(rows=4, cols=20)
        s.feed("keep\x1b[3J")
        self.assertEqual(s.frame(), "keep")

    def test_3J_does_not_restore_an_invalid_frame(self):
        s = E.ScreenState(rows=4, cols=20)
        s.feed("old\x1b[2L")                                  # invalid
        s.feed("\x1b[3J\x1b[1;1H")                            # scrollback erase + CUP: cells NOT known
        self.assertIsNone(s.frame())
        s.feed("\x1b[2J")                                     # a real full clear does
        self.assertIsNotNone(s.frame())


class R5CleanupPerControl(unittest.TestCase):
    """run_three_controls keeps each control's cleanup outcome, aborts included — booleans only."""

    def test_abort_keeps_cleanup_of_controls_run_so_far(self):
        r = E.run_three_controls(runner_of({
            "positive": {**ok(e2e_positive(), FIXTURE_DIGEST), "cleanup_accredited": True},
            "negative": {"ok": False, "reason": "cleanup-not-reaped", "cleanup_accredited": False,
                         "instance": "negative-abc"}}))
        self.assertTrue(r["aborted"])
        self.assertEqual(r["cleanup_accredited"], {"positive": True, "negative": False})

    def test_success_reports_all_three(self):
        res = {"positive": ok(e2e_positive(), FIXTURE_DIGEST), "negative": ok(e2e_negative(), FIXTURE_DIGEST),
               "absent": ok(e2e_absent(), None)}
        for k in res:
            res[k]["cleanup_accredited"] = True
        r = E.run_three_controls(runner_of(res))
        self.assertFalse(r["aborted"])
        self.assertEqual(r["cleanup_accredited"], {"positive": True, "negative": True, "absent": True})

    def test_missing_or_non_boolean_is_none_not_true(self):
        r = E.run_three_controls(runner_of({
            "positive": {"ok": False, "reason": "spawn-failed", "cleanup_accredited": "yes",
                         "instance": "p"}}))
        self.assertEqual(r["cleanup_accredited"], {"positive": None})
        r = E.run_three_controls(runner_of({"positive": {"ok": False, "reason": "x"}}))
        self.assertEqual(r["cleanup_accredited"], {"positive": None})



class PreflightInfra(unittest.TestCase):
    """The no-Claude infrastructure preflight: refuses inside Shared Terminal sessions / containers,
    and reports cleanup per spawn stage — exercised with a fake RealSys, nothing is spawned."""

    def setUp(self):
        import preflight_infra as PF
        self.PF = PF

    def test_refuses_inside_shared_terminal_session(self):
        self.assertEqual(self.PF.refusal({"SESSION_ID": "x"}, dockerenv="/nonexistent"),
                         "shared-terminal-session:SESSION_ID")
        self.assertEqual(self.PF.refusal({"ST_INGEST_TOKEN": "t"}, dockerenv="/nonexistent"),
                         "shared-terminal-session:ST_INGEST_TOKEN")

    def test_refuses_inside_container(self):
        f = tempfile.NamedTemporaryFile(delete=False)
        f.close()
        try:
            self.assertEqual(self.PF.refusal({}, dockerenv=f.name), "inside-container")
        finally:
            os.unlink(f.name)
        self.assertIsNone(self.PF.refusal({}, dockerenv="/nonexistent"))

    class FakeRS:
        def __init__(self, exc=None, frames=("", "x\nPREFLIGHT-READY"), iso=True, reaped=True):
            self.exc, self.frames, self.iso, self.reaped = exc, list(frames), iso, reaped
            self.reaps, self.teardowns = [], []

        def spawn(self, argv, sock):
            assert "claude" not in " ".join(argv)               # never Claude
            assert argv[0] == "unshare" and "--kill-child" in argv
            if self.exc:
                raise self.exc
            return {"proc": object(), "ns_pid": "P", "ns_net": "N"}

        def check_isolation(self, owner):
            return self.iso

        def pane(self, sock):
            return self.frames.pop(0) if self.frames else None

        def reap(self, owner):
            self.reaps.append(owner)
            return self.reaped

        def teardown(self, sock):
            self.teardowns.append(sock)

    def test_success_report(self):
        rs = self.FakeRS()
        r = self.PF.run(rs, ready_timeout=2)
        self.assertEqual(r, {"spawned": True, "stage": None, "ns_identity": True, "isolation": True,
                             "pty_frame_ok": True, "cleanup_accredited": True})
        self.assertEqual((len(rs.reaps), rs.teardowns), (1, ["preflight"]))

    def test_after_launch_failure_reaps_by_handle(self):
        rs = self.FakeRS(exc=E.SpawnError("after-launch", owner={"proc": "p"}), reaped=False)
        r = self.PF.run(rs)
        self.assertEqual((r["stage"], r["cleanup_accredited"]), ("after-launch", False))
        self.assertEqual(rs.reaps, [{"proc": "p"}])

    def test_before_launch_failure_is_clean_without_reap(self):
        rs = self.FakeRS(exc=E.SpawnError("before-launch"))
        r = self.PF.run(rs)
        self.assertEqual((r["stage"], r["cleanup_accredited"], rs.reaps), ("before-launch", True, []))

    def test_isolation_failure_still_reaps(self):
        rs = self.FakeRS(iso=False)
        r = self.PF.run(rs, ready_timeout=2)
        self.assertFalse(r["isolation"])
        self.assertEqual(len(rs.reaps), 1)


if __name__ == "__main__":
    unittest.main()
