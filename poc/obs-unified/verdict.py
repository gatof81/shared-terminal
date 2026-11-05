#!/usr/bin/env python3
"""SEPARATE verdict layer for the unified observer (owner req 1). Consumes an Observer snapshot and
applies the per-control criteria. It is deliberately NOT part of the observer.

Hard rules:
- Insufficient capture (coverage != "full" where a pane signal is required) => INCONCLUSIVE, NEVER
  PASS/blocked (req 9).
- A pane-derived "blocked" is LOW confidence (attacker-writable); it is credited only when the same
  start shows NO attacker load (if the rogue had run it would be FAIL; not having run, it could not
  have forged the block text) and it is attributable to .claude/skills (req 4/6).
- Trust confirmed is necessary, NOT sufficient for P0 (req 3).
- `selected-no-signal` is NEVER upgraded to blocked (req 5).
- Everything is judged within ONE (attempt, start, instance) snapshot, so a signal from another
  start can never validate a block (req 2).
"""


# B2 — AUTHORITY MATRIX. Which (source, confidence) may legitimately carry each (concern, signal).
# A pane event can therefore NEVER demonstrate session.start, a valid guard, trust, or N14
# attribution — those require their proper high-integrity source. Anything not listed is rejected.
AUTHORITY = {
    ("control", "session.start"): {("probe", "high")},
    ("control", "classic.SessionStart"): {("probe", "high")},
    ("control", "probe-org-tier"): {("debug", "high")},
    ("control", "guard-seated"): {("debug", "high")},
    ("control", "guard-loaded"): {("debug", "high")},
    ("control", "guard-not-seated"): {("debug", "high")},
    ("trust", "confirmed"): {("gate", "high")},
    ("trust", "aborted"): {("gate", "high")},
    ("skills-dir", "loaded"): {("debug", "high")},
    ("skills-dir", "blocked"): {("pane", "low")},
    ("skills-dir", "block-attributable"): {("control", "high")},
    ("skills-dir", "fixture"): {("control", "high")},
}


def authorized(concern, signal, source, confidence):
    """True iff (source, confidence) may legitimately carry (concern, signal) — the authority matrix
    (B2). mcp-project has variable signal suffixes, handled explicitly."""
    key = (concern, signal)
    if key in AUTHORITY:
        return (source, confidence) in AUTHORITY[key]
    if concern == "mcp-project":
        if signal == "refusal":
            return (source, confidence) == ("pane", "low")
        if signal in {"identified", "accept-signal", "started"} or signal.startswith(("selection=", "dismissed=")):
            return (source, confidence) == ("gate", "high")
    return False


def validate_snapshot(snap):
    """Reject a snapshot whose events don't all match its (attempt, start, instance) (B5/correlation),
    or that carry an UNAUTHORIZED concern+signal+source+confidence combination (B2) — intentional or
    accidental mixing / forging. Fail-closed."""
    ctx = (snap.get("attempt"), snap.get("start"), snap.get("instance"))
    for e in snap.get("events", []):
        if (e.get("attempt"), e.get("start"), e.get("instance")) != ctx:
            return False, "correlation-violation:foreign-attempt/start/instance"
        if not e.get("signal"):
            return False, "invalid-signal:empty"
        if not authorized(e.get("concern"), e.get("signal"), e.get("source"), e.get("confidence")):
            return False, f"unauthorized:{e.get('concern')}/{e.get('signal')}/{e.get('source')}/{e.get('confidence')}"
    return True, "ok"


def _sig(events, concern, pred=None):
    return [e for e in events if e["concern"] == concern and (pred is None or pred(e["signal"]))]


def verdict_p0(snap):
    ev = snap["events"]
    # B1: ANY guard-not-seated in this start invalidates the baseline, even if a guard-seated-loaded
    # appeared earlier (incremental, contradictory reads) — the negative state wins.
    if any(e["concern"] == "control" and e["signal"] == "guard-not-seated" for e in ev):
        return "baseline-invalid", "guard-not-seated(negative-precedence)"
    if not snap.get("debug_continuity", True):
        return "inconclusive", "debug-continuity-lost"     # B5: cannot trust debug-derived controls
    controls = {e["signal"] for e in ev if e["concern"] == "control"}
    trust_ok = any(e["concern"] == "trust" and e["signal"] == "confirmed" for e in ev)
    if not trust_ok:
        return "inconclusive", "trust-not-confirmed"
    # C1: classic.SessionStart is a GLOBAL control in analyze_b1a@8eafe1a (classic-sessionstart-
    # missing) — do not relax it. C3: guard validity = seated AND loaded (sub-facts may arrive in
    # different fragments); a later not-seated already invalidated above (B1).
    guard_ok = "guard-seated" in controls and "guard-loaded" in controls
    need = {"session.start", "classic.SessionStart", "probe-org-tier"}
    missing = sorted(need - controls) + ([] if guard_ok else ["guard-seated+loaded"])
    if missing:
        return "baseline-invalid", "missing-controls:" + ",".join(missing)
    return "baseline-ok", "trust+session.start+classic.SessionStart+probe-org+guard(same-start)"


def verdict_n14(snap):
    ev = snap["events"]
    if _sig(ev, "skills-dir", lambda s: s == "loaded"):
        return "FAIL", "skills-dir-loaded(high)"          # attacker executed; decisive, any coverage
    if snap["coverage"] != "full":
        return "inconclusive", "insufficient-capture"     # never PASS/blocked on bad capture
    if verdict_p0(snap)[0] != "baseline-ok":
        return "inconclusive", "baseline-not-ok"
    observed = _sig(ev, "skills-dir", lambda s: s == "blocked")
    if not observed:
        return "inconclusive", "no-load-and-no-observable-rejection"   # req 4: absence != blocked
    if (observed[0].get("detail") or {}).get("path_kind") != "claude-skills":
        return "inconclusive", "block-observed-not-claude-skills"
    # B3/B4: a .claude/skills warning on the pane is `block-observed-low` — NOT `blocked`. Crediting
    # it needs a SEPARATE attribution control that is NOT a bare declared event: it must name the
    # verified N14 fixture AND carry a differential (proof the SAME fixture LOADS without policy, so
    # the block is attributable to THIS fixture, not an unrelated skills warning). Pane text alone,
    # or an attribution event without that evidence, stays INCONCLUSIVE.
    attrib = _sig(ev, "skills-dir", lambda s: s == "block-attributable")
    if not attrib:
        return "inconclusive", "block-observed-low-not-attributable"
    d = attrib[0].get("detail") or {}
    # C2: the differential must be a VERIFIABLE reference to a positive control, bound to THIS run's
    # fixture by content digest — not a driver assertion. Require: named N14 fixture; a differential
    # object naming the control run and asserting it loaded; AND a fixture_digest equal to the digest
    # THIS run independently recorded (observer.fixture_identity). A bare flag is never credited.
    diff = d.get("differential")
    fixture = next((e.get("detail") or {} for e in _sig(ev, "skills-dir", lambda s: s == "fixture")), {})
    if d.get("fixture") != "st-b1-rogue-n14":
        return "inconclusive", "attribution-wrong-or-missing-fixture"
    # C2: the differential must reference a positive control whose REAL evidence was a skills-dir
    # LOAD of the SAME-digest fixture — not a `control_loaded: true` flag. The smoke's orchestrator
    # derives `evidence` from the positive control's own `skills-dir:loaded` event
    # (e2e_smoke.validate_differential); a driver cannot legitimately mint it.
    if not isinstance(diff, dict) or not diff.get("control_run") or diff.get("evidence") != "skills-dir:loaded":
        return "inconclusive", "attribution-not-a-validated-differential"
    if not fixture.get("digest") or diff.get("fixture_digest") != fixture.get("digest"):
        return "inconclusive", "attribution-fixture-digest-mismatch"
    return "blocked-low", "skills-dir-blocked(attributed-differential;pane-low;no-load,same-start)"


def verdict_n17_project(snap):
    ev = snap["events"]
    if _sig(ev, "mcp-project", lambda s: s == "started"):
        return "FAIL", "mcp-project-started(high)"
    selection = next((e["signal"] for e in _sig(ev, "mcp-project", lambda s: s.startswith("selection="))), None)
    dismissed = next((e["signal"] for e in _sig(ev, "mcp-project", lambda s: s.startswith("dismissed="))), None)
    accept = bool(_sig(ev, "mcp-project", lambda s: s == "accept-signal"))
    # Option A: approve selected + dialog closed while running + NO independent accept signal
    # => selected-no-signal => INCONCLUSIVE. NEVER blocked (req 5). 2.1.314 emits no accept signal.
    if selection == "selection=approve" and dismissed == "dismissed=running" and not accept:
        return "inconclusive", "selected-no-signal(option-A)"
    return "inconclusive", "no-confirmed-approval"


def verdict(snap):
    """Validate (B5) then dispatch by attempt. A mixed/malformed snapshot or an unknown attempt =>
    inconclusive (never PASS)."""
    ok, why = validate_snapshot(snap)
    if not ok:
        return "inconclusive", why
    a = snap.get("attempt")
    fn = {"P0": verdict_p0, "N14": verdict_n14, "N17-project": verdict_n17_project}.get(a)
    if fn is None:
        return "inconclusive", f"no-verdict-for:{a}"
    return fn(snap)
