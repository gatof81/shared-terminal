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


FIXTURE_DIGEST = "d34db33fcafef00d"


def n14_full_block(attributed=True, differential=True, digest=FIXTURE_DIGEST, diff_digest=FIXTURE_DIGEST):
    clk = ManualClock()
    o = obs(attempt="N14", clock=clk).set_window(max_gap=0.3)
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


class C4WindowFromInit(unittest.TestCase):
    def test_early_pre_trust_decision_covered_when_window_opens_at_init(self):
        # C4: the skills-dir block may be notified BEFORE trust; a window opened at INIT covers it.
        clk = ManualClock()
        o = obs(attempt="N14", clock=clk).set_window(max_gap=0.3)
        o.window_open(0.0)                                 # initialization, not trust-confirmed
        o.window_close(0.3)
        for t, txt in [(0.0, SKILLS_BLOCK), (0.1, PROBE), (0.2, PROBE), (0.3, PROBE)]:
            clk.t = t
            o.from_pane(txt)                               # decision at init (t=0)
        self.assertEqual(o.coverage(), "full")             # early decision is inside [init, close]


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
    o.window_open(0.05)
    o.window_close(0.25)
    for t, txt in [(0.0, PROBE), (0.1, SKILLS_BLOCK), (0.2, PROBE), (0.3, PROBE)]:
        clk.t = t
        o.from_pane(txt)
    return o.snapshot()                              # NO block-attributable — orchestrator stamps it


def e2e_absent():
    clk = ManualClock()
    o = obs(attempt="N14", start=1, instance="abs-1", clock=clk).set_window(max_gap=0.3)
    o.from_debug(PROBE)
    o.from_probe_records(PROBE_RECORDS, start_inst=INST)
    o.fact("trust", "confirmed")
    o.window_open(0.05)
    o.window_close(0.25)
    for t in [0.0, 0.1, 0.2, 0.3]:
        clk.t = t
        o.from_pane(PROBE)                           # benign reads, no skills-dir signal
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
                 trust="confirmed", loaded=True):
        self.scratch, self.fail, self.isolation, self.pane_none = scratch, fail, isolation, pane_none
        self.reaped, self.trust, self.loaded = reaped, trust, loaded

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
        if self.fail == "spawn":
            raise RuntimeError("spawn boom")

    def check_isolation(self, sock):
        return self.isolation

    def pane(self, sock):
        return None if self.pane_none else PROBE

    def read_text(self, path):
        if path.endswith("pgid"):
            return "4321\n"
        return PROBE + (N14_LOADED if self.loaded else "")

    def probe_records(self, ws):
        return PROBE_RECORDS

    def probe_inst(self, ws):
        return INST

    def reap(self, sock, pgid):
        return self.reaped


def mk_runner(sysio):
    return E.make_runner(sysio, cli="/bin/claude", scratch=tempfile.mkdtemp(),
                         trust_gate=lambda s, sock, pg, on_poll: (on_poll(), {"state": sysio.trust})[1],
                         clock=ManualClock(), settle_polls=2)


class E2ESmokePure(unittest.TestCase):
    def test_isolation_argv(self):
        argv = E.isolation_argv("/bin/claude", "/h", "/w", "/w/dbg", "/w/pgid", policy_path="/h/m.json")
        self.assertEqual(argv[0], "unshare")
        for flag in ("--map-root-user", "--net", "--pid", "--fork", "--mount-proc"):
            self.assertIn(flag, argv)
        self.assertIn("echo $$ > /w/pgid", argv[-1])
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
    """D1/D2/D4/D5 real decision logic — verified by MOCKS, not by FakeSys returning True."""

    def test_d1_interpret_isolation(self):
        self.assertTrue(E.interpret_isolation(["lo"], True))        # only lo + outbound blocked
        self.assertFalse(E.interpret_isolation(["lo", "eth0"], True))   # extra interface
        self.assertFalse(E.interpret_isolation(["lo"], False))      # outbound SUCCEEDED
        self.assertFalse(E.interpret_isolation([], True))           # nothing captured

    def test_d2_supervise_reap_sigterm_enough(self):
        import signal
        sent, state = [], {"alive": True}

        def alive(p):
            return state["alive"]

        def sig(p, s):
            sent.append(s)
            state["alive"] = False                                  # dies on SIGTERM

        self.assertTrue(E.supervise_reap(123, signal_group=sig, group_alive=alive, sleep=lambda s: None))
        self.assertEqual(sent, [signal.SIGTERM])                    # no SIGKILL needed

    def test_d2_supervise_reap_escalates_to_sigkill(self):
        import signal
        sent = []

        def sig(p, s):
            sent.append(s)

        def alive(p):
            return signal.SIGKILL not in sent                       # dies only after SIGKILL

        self.assertTrue(E.supervise_reap(123, signal_group=sig, group_alive=alive, sleep=lambda s: None,
                                         term_grace=0.4, kill_grace=0.4, tick=0.2))
        self.assertIn(signal.SIGKILL, sent)

    def test_d2_supervise_reap_fails_if_never_dies(self):
        self.assertFalse(E.supervise_reap(123, signal_group=lambda p, s: None, group_alive=lambda p: True,
                                          sleep=lambda s: None, term_grace=0.4, kill_grace=0.4, tick=0.2))

    def test_d2_supervise_reap_none_pgid(self):
        self.assertFalse(E.supervise_reap(None, signal_group=lambda p, s: None, group_alive=lambda p: False, sleep=lambda s: None))

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


if __name__ == "__main__":
    unittest.main()
